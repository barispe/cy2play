// ============================================================================
// Cy2Play — Hybrid Orchestrator Tests
// ============================================================================

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { orchestrate, OrchestratorOptions } from '../src/hybrid';
import { SnippetCache } from '../src/ai/cache';
import { LLMClient, ConversionOptions } from '../src/types';

const FIXTURES = join(__dirname, 'fixtures');

function readFixture(relativePath: string): string {
  return readFileSync(join(FIXTURES, relativePath), 'utf-8');
}

function makeOptions(overrides: Partial<ConversionOptions> = {}): ConversionOptions {
  return {
    mode: 'hybrid',
    inputPath: '/test',
    outputDir: '/out',
    dryRun: false,
    debug: false,
    ...overrides,
  };
}

function createMockClient(response: string): LLMClient {
  return {
    complete: vi.fn().mockResolvedValue(response),
  };
}

// ---------------------------------------------------------------------------
// Strict Mode (no LLM)
// ---------------------------------------------------------------------------

describe('orchestrate — strict mode', () => {
  it('should convert without AI when mode is strict', async () => {
    const input = readFixture('input/login.cy.ts');
    const options = makeOptions({ mode: 'strict' });

    const result = await orchestrate(input, 'login.cy.ts', { options });

    expect(result.code).toContain("import { test, expect } from '@playwright/test'");
    expect(result.code).toContain("test.describe('Login',");
    expect(result.code).toContain("await page.goto('/login')");
    expect(result.stats.rulesApplied).toBeGreaterThan(5);
    expect(result.stats.aiResolved).toBe(0);
  });

  it('should have no unresolved nodes for clean files', async () => {
    const input = readFixture('input/login.cy.ts');
    const options = makeOptions({ mode: 'strict' });

    const result = await orchestrate(input, 'login.cy.ts', { options });

    expect(result.unresolvedNodes).toHaveLength(0);
    expect(result.stats.manualReview).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Pure-AI Mode
// ---------------------------------------------------------------------------

describe('orchestrate — pure-ai mode', () => {
  it('should send the entire file to LLM', async () => {
    const mockResponse = "```typescript\nimport { test, expect } from '@playwright/test';\n\ntest('ai generated', async ({ page }) => {\n  await page.goto('/');\n});\n```";
    const client = createMockClient(mockResponse);
    const options = makeOptions({
      mode: 'pure-ai',
      llm: { provider: 'openai', model: 'gpt-4o', apiKey: 'test' },
    });

    const result = await orchestrate("cy.visit('/');", 'test.cy.ts', { options, client });

    expect(result.code).toContain("import { test, expect } from '@playwright/test'");
    expect(result.code).toContain('ai generated');
    expect(result.stats.aiResolved).toBe(1);
    expect(result.stats.rulesApplied).toBe(0);
    expect((client.complete as any)).toHaveBeenCalledOnce();
  });

  it('should throw when LLM config is missing', async () => {
    const options = makeOptions({ mode: 'pure-ai' });

    await expect(
      orchestrate("cy.visit('/');", 'test.cy.ts', { options }),
    ).rejects.toThrow('LLM configuration is required');
  });
});

// ---------------------------------------------------------------------------
// Hybrid Mode — the main event
// ---------------------------------------------------------------------------

describe('orchestrate — hybrid mode', () => {
  it('should skip AI for files with no unresolved nodes', async () => {
    const input = readFixture('input/login.cy.ts');
    const client = createMockClient('should not be called');
    const options = makeOptions({
      mode: 'hybrid',
      llm: { provider: 'openai', model: 'gpt-4o', apiKey: 'test' },
    });

    const result = await orchestrate(input, 'login.cy.ts', { options, client });

    // Login fixture has no complex commands → no AI needed
    expect(result.code).toContain("test.describe('Login',");
    expect(result.stats.aiResolved).toBe(0);
    expect((client.complete as any)).not.toHaveBeenCalled();
  });

  it('should send unresolved nodes to LLM for resolution', async () => {
    const input = readFixture('input/navigation.cy.ts');
    // Navigation fixture has cy.intercept → will be unresolved

    const mockLLMResponse = "```typescript\nconst getUsersPromise = page.waitForResponse('**/api/users');\n```";
    const client = createMockClient(mockLLMResponse);
    const options = makeOptions({
      mode: 'hybrid',
      llm: { provider: 'openai', model: 'gpt-4o', apiKey: 'test' },
    });

    const result = await orchestrate(input, 'navigation.cy.ts', { options, client });

    // Should have called the LLM for the intercept snippet
    expect((client.complete as any)).toHaveBeenCalled();
    expect(result.stats.aiResolved).toBeGreaterThan(0);
    // The resolved code should be in the output
    expect(result.code).toContain('waitForResponse');
  });

  it('should keep TODO comments when LLM returns no code block', async () => {
    const input = `describe('Test', () => {\n  it('test', () => {\n    cy.intercept('GET', '/api').as('req');\n  });\n});`;
    const client = createMockClient('Sorry, I cannot convert this snippet.');
    const options = makeOptions({
      mode: 'hybrid',
      llm: { provider: 'openai', model: 'gpt-4o', apiKey: 'test' },
    });

    const result = await orchestrate(input, 'test.cy.ts', { options, client });

    expect(result.code).toContain('TODO');
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('should handle LLM errors gracefully', async () => {
    const input = `describe('Test', () => {\n  it('test', () => {\n    cy.intercept('GET', '/api').as('req');\n  });\n});`;
    const client: LLMClient = {
      complete: vi.fn().mockRejectedValue(new Error('Rate limit exceeded')),
    };
    const options = makeOptions({
      mode: 'hybrid',
      llm: { provider: 'openai', model: 'gpt-4o', apiKey: 'test' },
    });

    const result = await orchestrate(input, 'test.cy.ts', { options, client });

    // Should not throw — graceful degradation
    expect(result.code).toContain('TODO');
    expect(result.code).toContain('Rate limit exceeded');
    expect(result.warnings.some(w => w.severity === 'error')).toBe(true);
  });

  it('should use cache for repeated snippets', async () => {
    const input = `describe('Test', () => {\n  it('test', () => {\n    cy.intercept('GET', '/api').as('req');\n  });\n});`;
    const mockResponse = "```typescript\nconst p = page.waitForResponse('**/api');\n```";
    const client = createMockClient(mockResponse);
    const cache = new SnippetCache();
    const options = makeOptions({
      mode: 'hybrid',
      llm: { provider: 'openai', model: 'gpt-4o', apiKey: 'test' },
    });

    // First call — cache miss
    await orchestrate(input, 'test1.cy.ts', { options, client, cache });
    const callCount1 = (client.complete as any).mock.calls.length;

    // Second call with same input — cache hit
    await orchestrate(input, 'test2.cy.ts', { options, client, cache });
    const callCount2 = (client.complete as any).mock.calls.length;

    // Should NOT have called the LLM again
    expect(callCount2).toBe(callCount1);
    expect(cache.getStats().hits).toBeGreaterThan(0);
  });

  it('should format output with Prettier', async () => {
    const input = readFixture('input/login.cy.ts');
    const options = makeOptions({
      mode: 'hybrid',
      llm: { provider: 'openai', model: 'gpt-4o', apiKey: 'test' },
    });

    const result = await orchestrate(input, 'login.cy.ts', { options });

    // Prettier should have formatted the code
    // Check for consistent formatting — single quotes, semicolons
    expect(result.code).toContain("'@playwright/test'");
    // Ensure it's valid TypeScript-ish (has the import)
    expect(result.code).toContain('import');
  });

  it('should preserve rule-based stats alongside AI stats', async () => {
    const input = readFixture('input/navigation.cy.ts');
    const mockResponse = "```typescript\nconst p = page.waitForResponse('**/api/users');\n```";
    const client = createMockClient(mockResponse);
    const options = makeOptions({
      mode: 'hybrid',
      llm: { provider: 'openai', model: 'gpt-4o', apiKey: 'test' },
    });

    const result = await orchestrate(input, 'navigation.cy.ts', { options, client });

    // Should have both rule-based AND AI stats
    expect(result.stats.rulesApplied).toBeGreaterThan(0);
    expect(result.stats.aiResolved).toBeGreaterThan(0);
    expect(result.stats.durationMs).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// Edge Cases
// ---------------------------------------------------------------------------

describe('orchestrate — edge cases', () => {
  it('should throw for unknown mode', async () => {
    const options = makeOptions({ mode: 'invalid' as any });

    await expect(
      orchestrate("cy.visit('/');", 'test.cy.ts', { options }),
    ).rejects.toThrow('Unknown conversion mode');
  });

  it('should handle empty files in all modes', async () => {
    for (const mode of ['strict', 'hybrid', 'pure-ai'] as const) {
      if (mode === 'pure-ai') {
        const client = createMockClient("```typescript\nimport { test, expect } from '@playwright/test';\n```");
        const options = makeOptions({
          mode,
          llm: { provider: 'openai', model: 'gpt-4o', apiKey: 'test' },
        });
        const result = await orchestrate('', 'empty.cy.ts', { options, client });
        expect(result.code).toBeTruthy();
      } else {
        const options = makeOptions({ mode });
        const result = await orchestrate('', 'empty.cy.ts', { options });
        expect(result.code).toContain("import { test, expect } from '@playwright/test'");
      }
    }
  });

  it('should accept a pre-created client', async () => {
    const mockResponse = "```typescript\nimport { test, expect } from '@playwright/test';\ntest('x', async ({page}) => {});\n```";
    const client = createMockClient(mockResponse);
    const options = makeOptions({
      mode: 'pure-ai',
      // No llm config — using pre-created client instead
    });

    const result = await orchestrate("cy.visit('/');", 'test.cy.ts', { options, client });

    expect(result.code).toContain("import { test, expect } from '@playwright/test'");
    expect((client.complete as any)).toHaveBeenCalled();
  });
});
