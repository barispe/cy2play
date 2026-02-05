// ============================================================================
// Cy2Play — Migration Reporter
// ============================================================================
//
// Tracks per-file conversion results, aggregates statistics, and generates
// a human-readable MIGRATION_SUMMARY.md report after a conversion run.
// ============================================================================

import * as fs from 'fs';
import * as path from 'path';
import {
  MigrationReport,
  TransformResult,
  TransformStats,
  Warning,
} from './types';

// ---------------------------------------------------------------------------
// Per-file record — captured during conversion
// ---------------------------------------------------------------------------

export interface FileRecord {
  /** Absolute path to the original Cypress file */
  inputPath: string;
  /** Absolute path to the generated Playwright file */
  outputPath: string;
  /** Relative display path for the input file */
  relativeInput: string;
  /** Relative display path for the output file */
  relativeOutput: string;
  /** The transform result (code, stats, warnings, unresolved) */
  result: TransformResult;
}

// ---------------------------------------------------------------------------
// MigrationReporter
// ---------------------------------------------------------------------------

export class MigrationReporter {
  private files: FileRecord[] = [];
  private startTime: number;

  constructor() {
    this.startTime = Date.now();
  }

  // ── Recording ───────────────────────────────────────────────────────────

  /**
   * Record the result of a single file conversion.
   */
  addFile(record: FileRecord): void {
    this.files.push(record);
  }

  /**
   * Get all recorded file results.
   */
  getFiles(): ReadonlyArray<FileRecord> {
    return this.files;
  }

  // ── Aggregation ─────────────────────────────────────────────────────────

  /**
   * Build the full MigrationReport with aggregated stats.
   */
  buildReport(): MigrationReport {
    const totalStats = this.aggregateStats();
    const allWarnings = this.collectAllWarnings();
    const failedFiles = this.files.filter(
      f => f.result.warnings.some(w => w.severity === 'error'),
    ).length;

    return {
      timestamp: new Date().toISOString(),
      totalFiles: this.files.length,
      convertedFiles: this.files.length - failedFiles,
      failedFiles,
      totalStats,
      warnings: allWarnings,
      files: this.files.map(f => ({
        inputPath: f.relativeInput,
        outputPath: f.relativeOutput,
        stats: f.result.stats,
        warnings: f.result.warnings,
      })),
    };
  }

  /**
   * Aggregate TransformStats across all recorded files.
   */
  aggregateStats(): TransformStats {
    const stats: TransformStats = {
      rulesApplied: 0,
      aiResolved: 0,
      manualReview: 0,
      totalCommands: 0,
      durationMs: Date.now() - this.startTime,
      tokensUsed: 0,
    };

    for (const f of this.files) {
      stats.rulesApplied += f.result.stats.rulesApplied;
      stats.aiResolved += f.result.stats.aiResolved;
      stats.manualReview += f.result.stats.manualReview;
      stats.totalCommands += f.result.stats.totalCommands;
      stats.tokensUsed! += f.result.stats.tokensUsed ?? 0;
    }

    // Drop tokensUsed if it remained 0
    if (stats.tokensUsed === 0) {
      delete stats.tokensUsed;
    }

    return stats;
  }

  /**
   * Collect all warnings from every file.
   */
  collectAllWarnings(): Warning[] {
    return this.files.flatMap(f => f.result.warnings);
  }

  // ── TODO / FIXME Inventory ──────────────────────────────────────────────

  /**
   * Scan the generated code for all TODO and FIXME comments and return
   * an inventory grouped by file.
   */
  collectTodoInventory(): Array<{
    file: string;
    items: Array<{ line: number; type: 'TODO' | 'FIXME'; text: string }>;
  }> {
    const inventory: Array<{
      file: string;
      items: Array<{ line: number; type: 'TODO' | 'FIXME'; text: string }>;
    }> = [];

    for (const f of this.files) {
      const items: Array<{ line: number; type: 'TODO' | 'FIXME'; text: string }> = [];
      const lines = f.result.code.split('\n');

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const todoMatch = line.match(/\/\/\s*(TODO|FIXME):\s*(.*)/i);
        if (todoMatch) {
          items.push({
            line: i + 1,
            type: todoMatch[1].toUpperCase() as 'TODO' | 'FIXME',
            text: todoMatch[2].trim(),
          });
        }
      }

      if (items.length > 0) {
        inventory.push({ file: f.relativeOutput, items });
      }
    }

    return inventory;
  }

  // ── Markdown Generation ─────────────────────────────────────────────────

  /**
   * Generate the full MIGRATION_SUMMARY.md content.
   */
  generateMarkdown(mode: string): string {
    const report = this.buildReport();
    const todoInventory = this.collectTodoInventory();
    const lines: string[] = [];

    // ── Header ──
    lines.push('# 📊 Cy2Play Migration Summary');
    lines.push('');
    lines.push(`> Generated on ${new Date().toLocaleString()}`);
    lines.push(`> Mode: **${mode}**`);
    lines.push('');

    // ── Overview Stats ──
    lines.push('## Overview');
    lines.push('');
    lines.push(`| Metric | Value |`);
    lines.push(`|--------|-------|`);
    lines.push(`| Total files | ${report.totalFiles} |`);
    lines.push(`| Converted | ${report.convertedFiles} |`);
    if (report.failedFiles > 0) {
      lines.push(`| Failed | ${report.failedFiles} |`);
    }
    lines.push(`| Total commands | ${report.totalStats.totalCommands} |`);
    lines.push(`| Rules applied | ${report.totalStats.rulesApplied} |`);
    if (report.totalStats.aiResolved > 0) {
      lines.push(`| AI resolved | ${report.totalStats.aiResolved} |`);
    }
    if (report.totalStats.manualReview > 0) {
      lines.push(`| Manual review needed | ${report.totalStats.manualReview} |`);
    }
    if (report.totalStats.tokensUsed) {
      lines.push(`| AI tokens used | ~${report.totalStats.tokensUsed} |`);
    }
    lines.push(`| Duration | ${formatDuration(report.totalStats.durationMs)} |`);
    lines.push('');

    // ── Coverage ──
    const coverage = report.totalStats.totalCommands > 0
      ? Math.min(
          100,
          Math.round(
            ((report.totalStats.rulesApplied + report.totalStats.aiResolved) /
              report.totalStats.totalCommands) *
              100,
          ),
        )
      : 100;
    lines.push(`### Conversion Coverage: ${coverage}%`);
    lines.push('');
    lines.push(generateProgressBar(coverage));
    lines.push('');

    // ── Per-file Breakdown ──
    lines.push('## Per-File Results');
    lines.push('');
    lines.push('| Input | Output | Commands | Rules | AI | Review | Status |');
    lines.push('|-------|--------|----------|-------|----|--------|--------|');

    for (const f of report.files) {
      const hasErrors = f.warnings.some(w => w.severity === 'error');
      const status = hasErrors
        ? '❌ Error'
        : f.stats.manualReview > 0
          ? '⚠️ Review'
          : '✅ Done';

      lines.push(
        `| ${f.inputPath} | ${f.outputPath} | ${f.stats.totalCommands} | ${f.stats.rulesApplied} | ${f.stats.aiResolved} | ${f.stats.manualReview} | ${status} |`,
      );
    }
    lines.push('');

    // ── TODO / FIXME Inventory ──
    if (todoInventory.length > 0) {
      lines.push('## 📝 TODO / FIXME Items');
      lines.push('');
      lines.push('The following items in the generated code need manual attention:');
      lines.push('');

      let totalTodos = 0;
      let totalFixmes = 0;

      for (const file of todoInventory) {
        lines.push(`### ${file.file}`);
        lines.push('');

        for (const item of file.items) {
          const icon = item.type === 'FIXME' ? '🔴' : '🟡';
          lines.push(`- ${icon} **L${item.line}** \`${item.type}\`: ${item.text}`);
          if (item.type === 'TODO') totalTodos++;
          else totalFixmes++;
        }
        lines.push('');
      }

      lines.push(`> **Total**: ${totalTodos} TODO(s), ${totalFixmes} FIXME(s)`);
      lines.push('');
    }

    // ── Warnings ──
    if (report.warnings.length > 0) {
      lines.push('## ⚠️ Warnings');
      lines.push('');

      const grouped = groupWarningsBySeverity(report.warnings);

      if (grouped.error.length > 0) {
        lines.push(`### ❌ Errors (${grouped.error.length})`);
        lines.push('');
        for (const w of grouped.error) {
          lines.push(`- **${w.filePath}:${w.line}** — ${w.message}`);
        }
        lines.push('');
      }

      if (grouped.warning.length > 0) {
        lines.push(`### ⚠️ Warnings (${grouped.warning.length})`);
        lines.push('');
        for (const w of grouped.warning) {
          lines.push(`- **${w.filePath}:${w.line}** — ${w.message}`);
        }
        lines.push('');
      }

      if (grouped.info.length > 0) {
        lines.push(`### ℹ️ Info (${grouped.info.length})`);
        lines.push('');
        for (const w of grouped.info) {
          lines.push(`- **${w.filePath}:${w.line}** — ${w.message}`);
        }
        lines.push('');
      }
    }

    // ── Next Steps ──
    lines.push('## 🚀 Next Steps');
    lines.push('');
    lines.push('1. Review any files marked with ⚠️ or ❌ above.');
    if (todoInventory.length > 0) {
      lines.push('2. Search for `TODO: [cy2play]` and `FIXME: [cy2play]` comments in the generated files.');
    }
    lines.push(`${todoInventory.length > 0 ? '3' : '2'}. Run the generated Playwright tests:`);
    lines.push('   ```bash');
    lines.push('   npx playwright test');
    lines.push('   ```');
    lines.push(`${todoInventory.length > 0 ? '4' : '3'}. Fix any remaining failures and remove TODO/FIXME comments.`);
    lines.push('');
    lines.push('---');
    lines.push('*Generated by [Cy2Play](https://github.com/cy2play/cy2play)*');
    lines.push('');

    return lines.join('\n');
  }

  /**
   * Write MIGRATION_SUMMARY.md to the output directory.
   */
  writeSummary(outputDir: string, mode: string): string {
    const markdown = this.generateMarkdown(mode);
    const summaryPath = path.join(outputDir, 'MIGRATION_SUMMARY.md');

    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(summaryPath, markdown, 'utf-8');

    return summaryPath;
  }
}

// ---------------------------------------------------------------------------
// Safe-Write Validation
// ---------------------------------------------------------------------------

/**
 * Validate that the output directory is not the same as (or a parent of) the
 * input path. This prevents accidental overwriting of source files.
 *
 * @throws Error if the output would overwrite source files
 */
export function validateSafeWrite(
  inputPath: string,
  outputDir: string,
): void {
  const resolvedInput = path.resolve(inputPath);
  const resolvedOutput = path.resolve(outputDir);

  // Exact match
  if (resolvedInput === resolvedOutput) {
    throw new Error(
      `Output directory "${outputDir}" is the same as the input path. ` +
      `Cy2Play never overwrites source files. Use a different --output directory.`,
    );
  }

  // Output is a parent of input (writing files into the source tree)
  if (resolvedInput.startsWith(resolvedOutput + path.sep)) {
    throw new Error(
      `Output directory "${outputDir}" is a parent of the input path. ` +
      `This would overwrite source files. Use a different --output directory.`,
    );
  }

  // Input is a parent of output (output is inside the input dir)
  // This is allowed — the output is a subdirectory. But warn if patterns overlap.
  // We don't block this since playwright-tests/ inside cypress/e2e/ is valid.
}

/**
 * Validate that a specific output file won't overwrite its source file.
 *
 * @throws Error if the output file is the same as the input file
 */
export function validateOutputFile(
  inputFile: string,
  outputFile: string,
): void {
  const resolvedInput = path.resolve(inputFile);
  const resolvedOutput = path.resolve(outputFile);

  if (resolvedInput === resolvedOutput) {
    throw new Error(
      `Output file "${outputFile}" would overwrite the source file "${inputFile}". ` +
      `Cy2Play never overwrites source files.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Format a duration in ms to a human-readable string.
 */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = ((ms % 60_000) / 1000).toFixed(0);
  return `${minutes}m ${seconds}s`;
}

/**
 * Generate a text-based progress bar for markdown.
 */
function generateProgressBar(pct: number): string {
  const clamped = Math.min(100, Math.max(0, pct));
  const filled = Math.round(clamped / 5);
  const empty = 20 - filled;
  return `\`[${'█'.repeat(filled)}${'░'.repeat(empty)}]\` ${pct}%`;
}

/**
 * Group warnings by severity.
 */
function groupWarningsBySeverity(warnings: Warning[]): Record<'error' | 'warning' | 'info', Warning[]> {
  return {
    error: warnings.filter(w => w.severity === 'error'),
    warning: warnings.filter(w => w.severity === 'warning'),
    info: warnings.filter(w => w.severity === 'info'),
  };
}
