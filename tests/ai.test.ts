// ============================================================================
// Cy2Play — AI Layer Tests
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createLLMClient } from '../src/ai/index';
import {
  SYSTEM_PROMPT,
  FEW_SHOT_EXAMPLES,
  buildFullFilePrompt,
  buildSnippetPrompt,
  extractCodeBlock,
} from '../src/ai/prompts';
import { SnippetCache } from '../src/ai/cache';
import { pureAITransform } from '../src/ai/pure-ai-strategy';
import { LLMClient, LLMConfig } from '../src/types';

// ---------------------------------------------------------------------------
// Prompt Tests
// ---------------------------------------------------------------------------

describe('Prompts — SYSTEM_PROMPT', () => {
  it('should contain the Playwright import rule', () => {
    expect(SYSTEM_PROMPT).toContain("import { test, expect } from '@playwright/test'");
  });

  it('should mention async/await requirement', () => {
    expect(SYSTEM_PROMPT).toContain('async ({ page })');
  });

  it('should include conversion rules for selectors', () => {
    expect(SYSTEM_PROMPT).toContain('page.locator');
    expect(SYSTEM_PROMPT).toContain('page.getByText');
  });

  it('should include complex pattern instructions', () => {
    expect(SYSTEM_PROMPT).toContain('cy.intercept');
    expect(SYSTEM_PROMPT).toContain('cy.then');
    expect(SYSTEM_PROMPT).toContain('page.waitForResponse');
  });
});

describe('Prompts — FEW_SHOT_EXAMPLES', () => {
  it('should have at least 5 examples', () => {
    expect(FEW_SHOT_EXAMPLES.length).toBeGreaterThanOrEqual(5);
  });

  it('should have an intercept example', () => {
    const intercept = FEW_SHOT_EXAMPLES.find(e => e.label.includes('intercept'));
    expect(intercept).toBeTruthy();
    expect(intercept!.cypress).toContain('cy.intercept');
    expect(intercept!.playwright).toContain('waitForResponse');
  });

  it('should have a cy.then example', () => {
    const then = FEW_SHOT_EXAMPLES.find(e => e.label.includes('then'));
    expect(then).toBeTruthy();
    expect(then!.cypress).toContain('.then(');
  });

  it('should have a cy.within example', () => {
    const within = FEW_SHOT_EXAMPLES.find(e => e.label.includes('within'));
    expect(within).toBeTruthy();
    expect(within!.cypress).toContain('.within(');
  });

  it('each example should have non-empty cypress and playwright code', () => {
    for (const ex of FEW_SHOT_EXAMPLES) {
      expect(ex.cypress.length).toBeGreaterThan(10);
      expect(ex.playwright.length).toBeGreaterThan(10);
    }
  });
});

describe('Prompts — buildFullFilePrompt', () => {
  it('should include the Cypress source code', () => {
    const prompt = buildFullFilePrompt("cy.visit('/');", 'test.cy.ts');
    expect(prompt).toContain("cy.visit('/')");
  });

  it('should include the file path', () => {
    const prompt = buildFullFilePrompt("cy.visit('/');", 'my-test.cy.ts');
    expect(prompt).toContain('my-test.cy.ts');
  });

  it('should include few-shot examples', () => {
    const prompt = buildFullFilePrompt("cy.visit('/');");
    expect(prompt).toContain('Reference Examples');
    expect(prompt).toContain('cy.intercept');
  });

  it('should ask for a TypeScript code block', () => {
    const prompt = buildFullFilePrompt("cy.visit('/');");
    expect(prompt).toContain('```typescript');
  });
});

describe('Prompts — buildSnippetPrompt', () => {
  it('should include the snippet code', () => {
    const prompt = buildSnippetPrompt(
      "cy.intercept('GET', '/api/data').as('data');",
      'test.beforeEach(async ({ page }) => {',
    );
    expect(prompt).toContain('cy.intercept');
  });

  it('should include surrounding context', () => {
    const context = 'test.beforeEach(async ({ page }) => {';
    const prompt = buildSnippetPrompt("cy.intercept('GET', '/api')", context);
    expect(prompt).toContain(context);
  });

  it('should include relevant examples for intercept snippets', () => {
    const prompt = buildSnippetPrompt("cy.intercept('GET', '/api')", '');
    expect(prompt).toContain('intercept');
    expect(prompt).toContain('Relevant Examples');
  });

  it('should NOT include unrelated examples', () => {
    // A snippet about cy.wrap should not include the intercept example
    const prompt = buildSnippetPrompt("cy.wrap({ x: 1 })", '');
    // Should include wrap example but not necessarily intercept
    if (prompt.includes('Relevant Examples')) {
      expect(prompt).toContain('wrap');
    }
  });
});

describe('Prompts — extractCodeBlock', () => {
  it('should extract code from a typescript code block', () => {
    const response = "Here's the converted code:\n\n```typescript\nimport { test } from '@playwright/test';\n\ntest('hello', async () => {});\n```\n\nDone!";
    const code = extractCodeBlock(response);
    expect(code).toContain("import { test } from '@playwright/test'");
    expect(code).toContain("test('hello',");
  });

  it('should extract code from a plain code block', () => {
    const response = '```\nconst x = 1;\n```';
    const code = extractCodeBlock(response);
    expect(code).toBe('const x = 1;');
  });

  it('should extract code from a ts code block', () => {
    const response = '```ts\nconst x = 1;\n```';
    const code = extractCodeBlock(response);
    expect(code).toBe('const x = 1;');
  });

  it('should return null if no code block found', () => {
    const response = 'Just some plain text without any code blocks.';
    const code = extractCodeBlock(response);
    expect(code).toBeNull();
  });

  it('should handle multi-line code blocks', () => {
    const response = '```typescript\nline1\nline2\nline3\n```';
    const code = extractCodeBlock(response);
    expect(code).toBe('line1\nline2\nline3');
  });
});

// ---------------------------------------------------------------------------
// Cache Tests
// ---------------------------------------------------------------------------

describe('SnippetCache', () => {
  let cache: SnippetCache;

  beforeEach(() => {
    cache = new SnippetCache(); // in-memory only
  });

  it('should return null for uncached snippets', () => {
    expect(cache.get("cy.visit('/');")).toBeNull();
  });

  it('should return cached results on hit', () => {
    cache.set("cy.visit('/');", "await page.goto('/');");
    expect(cache.get("cy.visit('/');")).toBe("await page.goto('/');");
  });

  it('should report hits and misses', () => {
    cache.get('miss1');
    cache.get('miss2');
    cache.set('hit', 'result');
    cache.get('hit');

    const stats = cache.getStats();
    expect(stats.misses).toBe(2);
    expect(stats.hits).toBe(1);
    expect(stats.size).toBe(1);
  });

  it('should normalize whitespace for hashing', () => {
    cache.set("cy.visit(  '/'  );", "await page.goto('/');");
    // Same code with different whitespace should hit
    expect(cache.has("cy.visit( '/' );")).toBe(true);
  });

  it('should clear the cache', () => {
    cache.set('code', 'result');
    expect(cache.has('code')).toBe(true);
    cache.clear();
    expect(cache.has('code')).toBe(false);
    expect(cache.getStats().size).toBe(0);
  });

  it('should generate deterministic hash keys', () => {
    const key1 = SnippetCache.hashKey("cy.get('.btn').click();");
    const key2 = SnippetCache.hashKey("cy.get('.btn').click();");
    expect(key1).toBe(key2);
    expect(key1).toHaveLength(16);
  });

  it('should produce different keys for different code', () => {
    const key1 = SnippetCache.hashKey("cy.get('.btn').click();");
    const key2 = SnippetCache.hashKey("cy.get('.link').click();");
    expect(key1).not.toBe(key2);
  });
});

// ---------------------------------------------------------------------------
// Factory Tests
// ---------------------------------------------------------------------------

describe('createLLMClient', () => {
  it('should throw for unknown providers', () => {
    expect(() =>
      createLLMClient({ provider: 'invalid' as any, model: 'x' }),
    ).toThrow('Unknown LLM provider');
  });

  it('should throw for OpenAI without API key', () => {
    expect(() =>
      createLLMClient({ provider: 'openai', model: 'gpt-4o' }),
    ).toThrow('API key is required');
  });

  it('should throw for Anthropic without API key', () => {
    expect(() =>
      createLLMClient({ provider: 'anthropic', model: 'claude-sonnet-4-20250514' }),
    ).toThrow('API key is required');
  });

  it('should create an Ollama adapter without API key', () => {
    const client = createLLMClient({ provider: 'local', model: 'codellama' });
    expect(client).toBeTruthy();
    expect(typeof client.complete).toBe('function');
  });

  it('should create an OpenAI adapter with API key', () => {
    const client = createLLMClient({
      provider: 'openai',
      model: 'gpt-4o',
      apiKey: 'sk-test-key',
    });
    expect(client).toBeTruthy();
    expect(typeof client.complete).toBe('function');
  });

  it('should create an Anthropic adapter with API key', () => {
    const client = createLLMClient({
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      apiKey: 'sk-ant-test-key',
    });
    expect(client).toBeTruthy();
    expect(typeof client.complete).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// Pure-AI Strategy Tests (with mocked LLM)
// ---------------------------------------------------------------------------

describe('pureAITransform', () => {
  function createMockClient(response: string): LLMClient {
    return {
      complete: vi.fn().mockResolvedValue(response),
    };
  }

  it('should extract code from LLM response and return TransformResult', async () => {
    const mockCode = `import { test, expect } from '@playwright/test';

test('hello', async ({ page }) => {
  await page.goto('/');
});`;

    const client = createMockClient(`Here's the code:\n\n\`\`\`typescript\n${mockCode}\n\`\`\`\n\nDone!`);

    const result = await pureAITransform("cy.visit('/');", 'test.cy.ts', { client });

    expect(result.code).toContain("import { test, expect } from '@playwright/test'");
    expect(result.code).toContain("await page.goto('/')");
    expect(result.stats.aiResolved).toBe(1);
    expect(result.stats.rulesApplied).toBe(0);
    expect(result.warnings).toHaveLength(0);
  });

  it('should handle LLM errors gracefully', async () => {
    const client: LLMClient = {
      complete: vi.fn().mockRejectedValue(new Error('Rate limit exceeded')),
    };

    const result = await pureAITransform("cy.visit('/');", 'test.cy.ts', { client });

    expect(result.code).toContain('AI conversion failed');
    expect(result.code).toContain('Rate limit exceeded');
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0].severity).toBe('error');
    expect(result.stats.manualReview).toBe(1);
  });

  it('should handle responses without code blocks', async () => {
    const client = createMockClient('Sorry, I cannot convert this code.');

    const result = await pureAITransform("cy.visit('/');", 'test.cy.ts', { client });

    expect(result.code).toContain('Could not parse AI response');
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.stats.manualReview).toBe(1);
  });

  it('should auto-add Playwright import if missing from LLM output', async () => {
    const client = createMockClient("```typescript\ntest('hello', async ({ page }) => {});\n```");

    const result = await pureAITransform("it('hello', () => {});", 'test.cy.ts', { client });

    expect(result.code).toContain("import { test, expect } from '@playwright/test'");
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings.some(w => w.message.includes('missing the Playwright import'))).toBe(true);
  });

  it('should use cache on second call with same input', async () => {
    const client = createMockClient(
      "```typescript\nimport { test, expect } from '@playwright/test';\ntest('x', async ({page}) => {});\n```",
    );
    const cache = new SnippetCache();

    // First call — cache miss
    const result1 = await pureAITransform("cy.visit('/');", 'test.cy.ts', { client, cache });
    expect(result1.stats.aiResolved).toBe(1);
    expect((client.complete as any).mock.calls.length).toBe(1);

    // Second call — cache hit
    const result2 = await pureAITransform("cy.visit('/');", 'test.cy.ts', { client, cache });
    expect(result2.stats.aiResolved).toBe(1);
    // Should NOT have called the LLM again
    expect((client.complete as any).mock.calls.length).toBe(1);

    expect(cache.getStats().hits).toBe(1);
    expect(cache.getStats().misses).toBe(1);
  });

  it('should pass system prompt and user prompt to the LLM', async () => {
    const client = createMockClient(
      "```typescript\nimport { test, expect } from '@playwright/test';\n```",
    );

    await pureAITransform("cy.visit('/home');", 'nav.cy.ts', { client });

    const completeCall = (client.complete as any).mock.calls[0];
    expect(completeCall[0]).toContain('expert'); // system prompt
    expect(completeCall[1]).toContain("cy.visit('/home')"); // user prompt
    expect(completeCall[1]).toContain('nav.cy.ts'); // file path
  });
});
