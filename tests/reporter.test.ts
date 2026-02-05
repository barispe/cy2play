// ============================================================================
// Tests — MigrationReporter & Safe-Write Validation
// ============================================================================
import { describe, it, expect, beforeEach } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import {
  MigrationReporter,
  FileRecord,
  validateSafeWrite,
  validateOutputFile,
} from '../src/reporter';
import { TransformResult, TransformStats, Warning } from '../src/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStats(overrides: Partial<TransformStats> = {}): TransformStats {
  return {
    rulesApplied: 5,
    aiResolved: 0,
    manualReview: 0,
    totalCommands: 8,
    durationMs: 100,
    ...overrides,
  };
}

function makeResult(overrides: Partial<TransformResult> = {}): TransformResult {
  return {
    code: 'import { test, expect } from "@playwright/test";\n\ntest("example", async ({ page }) => {\n  await page.goto("/");\n});',
    warnings: [],
    unresolvedNodes: [],
    stats: makeStats(),
    ...overrides,
  };
}

function makeRecord(overrides: Partial<FileRecord> = {}): FileRecord {
  return {
    inputPath: '/project/cypress/login.cy.ts',
    outputPath: '/project/playwright-tests/login.spec.ts',
    relativeInput: 'login.cy.ts',
    relativeOutput: 'login.spec.ts',
    result: makeResult(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// MigrationReporter — Core
// ---------------------------------------------------------------------------

describe('MigrationReporter', () => {
  let reporter: MigrationReporter;

  beforeEach(() => {
    reporter = new MigrationReporter();
  });

  it('starts with no files recorded', () => {
    expect(reporter.getFiles()).toHaveLength(0);
  });

  it('records file results via addFile()', () => {
    reporter.addFile(makeRecord());
    reporter.addFile(makeRecord({ relativeInput: 'nav.cy.ts' }));
    expect(reporter.getFiles()).toHaveLength(2);
  });

  // ── Stats Aggregation ──────────────────────────────────────────────────

  describe('aggregateStats()', () => {
    it('aggregates stats across multiple files', () => {
      reporter.addFile(
        makeRecord({
          result: makeResult({
            stats: makeStats({ rulesApplied: 10, aiResolved: 2, totalCommands: 15, manualReview: 1 }),
          }),
        }),
      );
      reporter.addFile(
        makeRecord({
          result: makeResult({
            stats: makeStats({ rulesApplied: 8, aiResolved: 3, totalCommands: 12, manualReview: 0 }),
          }),
        }),
      );

      const agg = reporter.aggregateStats();
      expect(agg.rulesApplied).toBe(18);
      expect(agg.aiResolved).toBe(5);
      expect(agg.totalCommands).toBe(27);
      expect(agg.manualReview).toBe(1);
    });

    it('returns zero stats when no files are recorded', () => {
      const agg = reporter.aggregateStats();
      expect(agg.rulesApplied).toBe(0);
      expect(agg.totalCommands).toBe(0);
    });

    it('omits tokensUsed when no AI was used', () => {
      reporter.addFile(makeRecord());
      const agg = reporter.aggregateStats();
      expect(agg.tokensUsed).toBeUndefined();
    });

    it('aggregates tokensUsed when AI was used', () => {
      reporter.addFile(
        makeRecord({
          result: makeResult({ stats: makeStats({ tokensUsed: 500 }) }),
        }),
      );
      reporter.addFile(
        makeRecord({
          result: makeResult({ stats: makeStats({ tokensUsed: 300 }) }),
        }),
      );

      const agg = reporter.aggregateStats();
      expect(agg.tokensUsed).toBe(800);
    });
  });

  // ── Warning Collection ─────────────────────────────────────────────────

  describe('collectAllWarnings()', () => {
    it('collects warnings from all files', () => {
      const w1: Warning = {
        severity: 'warning',
        message: 'Static wait',
        filePath: 'a.cy.ts',
        line: 5,
      };
      const w2: Warning = {
        severity: 'info',
        message: 'Info msg',
        filePath: 'b.cy.ts',
        line: 10,
      };
      reporter.addFile(
        makeRecord({ result: makeResult({ warnings: [w1] }) }),
      );
      reporter.addFile(
        makeRecord({ result: makeResult({ warnings: [w2] }) }),
      );

      const all = reporter.collectAllWarnings();
      expect(all).toHaveLength(2);
      expect(all[0].message).toBe('Static wait');
      expect(all[1].message).toBe('Info msg');
    });

    it('returns empty array when no warnings', () => {
      reporter.addFile(makeRecord());
      expect(reporter.collectAllWarnings()).toHaveLength(0);
    });
  });

  // ── TODO/FIXME Inventory ───────────────────────────────────────────────

  describe('collectTodoInventory()', () => {
    it('finds TODO comments in generated code', () => {
      const codeWithTodos = `import { test } from '@playwright/test';

test('example', async ({ page }) => {
  // TODO: [cy2play] Manual review required — complex command(s) detected
  // cy.intercept('GET', '/api').as('api');
  await page.goto('/');
});`;

      reporter.addFile(
        makeRecord({
          result: makeResult({ code: codeWithTodos }),
        }),
      );

      const inventory = reporter.collectTodoInventory();
      expect(inventory).toHaveLength(1);
      expect(inventory[0].items).toHaveLength(1);
      expect(inventory[0].items[0].type).toBe('TODO');
      expect(inventory[0].items[0].line).toBe(4);
      expect(inventory[0].items[0].text).toContain('[cy2play]');
    });

    it('finds FIXME comments in generated code', () => {
      const codeWithFixme = `// FIXME: [cy2play] Lossy conversion — cy.wait('@alias')\nawait page.goto('/');`;

      reporter.addFile(
        makeRecord({
          result: makeResult({ code: codeWithFixme }),
        }),
      );

      const inventory = reporter.collectTodoInventory();
      expect(inventory).toHaveLength(1);
      expect(inventory[0].items[0].type).toBe('FIXME');
    });

    it('returns empty when no TODOs or FIXMEs', () => {
      reporter.addFile(makeRecord());
      expect(reporter.collectTodoInventory()).toHaveLength(0);
    });

    it('groups TODOs by file', () => {
      const codeA = `// TODO: first\n// TODO: second`;
      const codeB = `// FIXME: third`;

      reporter.addFile(
        makeRecord({
          relativeOutput: 'a.spec.ts',
          result: makeResult({ code: codeA }),
        }),
      );
      reporter.addFile(
        makeRecord({
          relativeOutput: 'b.spec.ts',
          result: makeResult({ code: codeB }),
        }),
      );

      const inventory = reporter.collectTodoInventory();
      expect(inventory).toHaveLength(2);
      expect(inventory[0].file).toBe('a.spec.ts');
      expect(inventory[0].items).toHaveLength(2);
      expect(inventory[1].file).toBe('b.spec.ts');
      expect(inventory[1].items).toHaveLength(1);
    });
  });

  // ── Build Report ───────────────────────────────────────────────────────

  describe('buildReport()', () => {
    it('builds a complete MigrationReport', () => {
      reporter.addFile(makeRecord());
      reporter.addFile(
        makeRecord({
          relativeInput: 'nav.cy.ts',
          relativeOutput: 'nav.spec.ts',
        }),
      );

      const report = reporter.buildReport();
      expect(report.totalFiles).toBe(2);
      expect(report.convertedFiles).toBe(2);
      expect(report.failedFiles).toBe(0);
      expect(report.files).toHaveLength(2);
      expect(report.timestamp).toBeTruthy();
    });

    it('counts failed files (files with error-severity warnings)', () => {
      const errorWarning: Warning = {
        severity: 'error',
        message: 'LLM error',
        filePath: 'fail.cy.ts',
        line: 1,
      };

      reporter.addFile(
        makeRecord({
          result: makeResult({ warnings: [errorWarning] }),
        }),
      );
      reporter.addFile(makeRecord());

      const report = reporter.buildReport();
      expect(report.failedFiles).toBe(1);
      expect(report.convertedFiles).toBe(1);
    });
  });

  // ── Markdown Generation ────────────────────────────────────────────────

  describe('generateMarkdown()', () => {
    it('produces valid markdown with all sections', () => {
      reporter.addFile(makeRecord());
      const md = reporter.generateMarkdown('strict');

      expect(md).toContain('# 📊 Cy2Play Migration Summary');
      expect(md).toContain('Mode: **strict**');
      expect(md).toContain('## Overview');
      expect(md).toContain('## Per-File Results');
      expect(md).toContain('## 🚀 Next Steps');
      expect(md).toContain('npx playwright test');
    });

    it('includes coverage percentage and progress bar', () => {
      reporter.addFile(
        makeRecord({
          result: makeResult({
            stats: makeStats({ rulesApplied: 8, totalCommands: 10 }),
          }),
        }),
      );
      const md = reporter.generateMarkdown('strict');
      expect(md).toContain('Conversion Coverage: 80%');
      expect(md).toContain('█');
    });

    it('includes TODO/FIXME section when items exist', () => {
      const codeWithTodo = `// TODO: [cy2play] Manual review\nawait page.goto('/');`;
      reporter.addFile(
        makeRecord({
          result: makeResult({ code: codeWithTodo }),
        }),
      );
      const md = reporter.generateMarkdown('hybrid');

      expect(md).toContain('## 📝 TODO / FIXME Items');
      expect(md).toContain('TODO');
    });

    it('includes warnings section when warnings exist', () => {
      const w: Warning = {
        severity: 'warning',
        message: 'Static wait detected',
        filePath: 'login.cy.ts',
        line: 10,
      };
      reporter.addFile(
        makeRecord({ result: makeResult({ warnings: [w] }) }),
      );
      const md = reporter.generateMarkdown('strict');

      expect(md).toContain('## ⚠️ Warnings');
      expect(md).toContain('Static wait detected');
    });

    it('includes AI stats when AI was used', () => {
      reporter.addFile(
        makeRecord({
          result: makeResult({
            stats: makeStats({ aiResolved: 3, tokensUsed: 1500 }),
          }),
        }),
      );
      const md = reporter.generateMarkdown('hybrid');

      expect(md).toContain('AI resolved');
      expect(md).toContain('AI tokens used');
      expect(md).toContain('~1500');
    });

    it('shows per-file status correctly', () => {
      // File with manual review
      reporter.addFile(
        makeRecord({
          relativeInput: 'complex.cy.ts',
          relativeOutput: 'complex.spec.ts',
          result: makeResult({ stats: makeStats({ manualReview: 2 }) }),
        }),
      );
      // File fully converted
      reporter.addFile(
        makeRecord({
          relativeInput: 'simple.cy.ts',
          relativeOutput: 'simple.spec.ts',
        }),
      );

      const md = reporter.generateMarkdown('strict');
      expect(md).toContain('⚠️ Review');
      expect(md).toContain('✅ Done');
    });
  });

  // ── Write Summary ──────────────────────────────────────────────────────

  describe('writeSummary()', () => {
    it('writes MIGRATION_SUMMARY.md to the output directory', () => {
      const tmpDir = path.join(os.tmpdir(), `cy2play-test-${Date.now()}`);
      try {
        reporter.addFile(makeRecord());
        const summaryPath = reporter.writeSummary(tmpDir, 'strict');

        expect(fs.existsSync(summaryPath)).toBe(true);
        const content = fs.readFileSync(summaryPath, 'utf-8');
        expect(content).toContain('# 📊 Cy2Play Migration Summary');
        expect(content).toContain('Mode: **strict**');
      } finally {
        // Cleanup
        if (fs.existsSync(tmpDir)) {
          fs.rmSync(tmpDir, { recursive: true });
        }
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Safe-Write Validation
// ---------------------------------------------------------------------------

describe('validateSafeWrite()', () => {
  it('throws when output dir equals input path', () => {
    expect(() =>
      validateSafeWrite('/project/cypress/e2e', '/project/cypress/e2e'),
    ).toThrow('same as the input');
  });

  it('throws when output dir is a parent of input path', () => {
    expect(() =>
      validateSafeWrite('/project/cypress/e2e/tests', '/project/cypress/e2e'),
    ).toThrow('parent of the input');
  });

  it('does not throw when output and input are different', () => {
    expect(() =>
      validateSafeWrite('/project/cypress/e2e', '/project/playwright-tests'),
    ).not.toThrow();
  });

  it('does not throw when output is inside input (valid subdir)', () => {
    // e.g. input = /project, output = /project/playwright-tests
    expect(() =>
      validateSafeWrite('/project', '/project/playwright-tests'),
    ).not.toThrow();
  });
});

describe('validateOutputFile()', () => {
  it('throws when output file would overwrite source file', () => {
    expect(() =>
      validateOutputFile('/project/login.cy.ts', '/project/login.cy.ts'),
    ).toThrow('overwrite the source');
  });

  it('does not throw when files are different', () => {
    expect(() =>
      validateOutputFile('/project/login.cy.ts', '/project/out/login.spec.ts'),
    ).not.toThrow();
  });
});
