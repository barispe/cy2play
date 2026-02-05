// ============================================================================
// Cy2Play — LLM Prompt Templates
// ============================================================================
//
// All prompts used by the AI layer — system prompts, user prompts, and
// few-shot examples for complex Cypress→Playwright patterns.
// ============================================================================

// ---------------------------------------------------------------------------
// System Prompt
// ---------------------------------------------------------------------------

export const SYSTEM_PROMPT = `You are an expert test automation engineer specializing in migrating Cypress tests to Playwright.

Your task is to convert Cypress test code into idiomatic, working Playwright (TypeScript) test code.

## Rules

1. **Imports**: Always include \`import { test, expect } from '@playwright/test';\` at the top.
2. **Structure**:
   - \`describe()\` → \`test.describe()\`
   - \`it()\` → \`test()\`
   - \`beforeEach()\` → \`test.beforeEach()\`
   - \`afterEach()\` → \`test.afterEach()\`
   - \`before()\` → \`test.beforeAll()\`
   - \`after()\` → \`test.afterAll()\`
3. **Async/Await**: All test callbacks must be \`async ({ page }) => { ... }\`. All Playwright actions need \`await\`.
4. **Selectors**:
   - \`cy.get(sel)\` → \`page.locator(sel)\`
   - \`cy.contains(text)\` → \`page.getByText(text)\`
   - \`.find(sel)\` → \`.locator(sel)\`
   - \`.first()\` → \`.first()\`
   - \`.last()\` → \`.last()\`
   - \`.eq(n)\` → \`.nth(n)\`
5. **Actions**:
   - \`.click()\` → \`.click()\`
   - \`.type(text)\` → \`.fill(text)\`
   - \`.clear()\` → \`.clear()\`
   - \`.check()\` / \`.uncheck()\` → \`.check()\` / \`.uncheck()\`
   - \`.select(val)\` → \`.selectOption(val)\`
6. **Assertions**:
   - \`.should('be.visible')\` → \`await expect(loc).toBeVisible()\`
   - \`.should('have.text', x)\` → \`await expect(loc).toHaveText(x)\`
   - \`.should('have.length', n)\` → \`await expect(loc).toHaveCount(n)\`
   - \`.should('have.value', v)\` → \`await expect(loc).toHaveValue(v)\`
   - \`.should('be.checked')\` → \`await expect(loc).toBeChecked()\`
   - \`cy.url().should('include', x)\` → \`await expect(page).toHaveURL(/x/)\`
7. **Navigation**:
   - \`cy.visit(url)\` → \`await page.goto(url)\`
   - \`cy.reload()\` → \`await page.reload()\`
8. **Complex patterns**:
   - \`cy.intercept()\` + \`cy.wait()\` → \`page.waitForResponse()\` or \`page.route()\`
   - \`cy.then(cb)\` → inline the callback, use \`await\` instead
   - \`cy.wrap(val)\` → direct variable usage
   - \`cy.fixture(name)\` → \`JSON.parse(fs.readFileSync(...))\` or inline data
   - \`cy.request()\` → \`page.request.get/post/...()\` (Playwright API request context)
9. **Waits**: Prefer Playwright's auto-waiting. Only use \`page.waitForTimeout()\` as a last resort and add a comment explaining why.
10. **Output**: Return ONLY the converted Playwright code inside a single TypeScript code block. No explanations outside the code block.

## Important
- Produce clean, idiomatic Playwright TypeScript.
- Preserve the original test intent and structure.
- If something cannot be directly converted, add a \`// TODO: Manual review\` comment.
- Do NOT invent tests or add assertions that weren't in the original.`;

// ---------------------------------------------------------------------------
// Few-Shot Examples
// ---------------------------------------------------------------------------

export interface FewShotExample {
  label: string;
  cypress: string;
  playwright: string;
}

export const FEW_SHOT_EXAMPLES: FewShotExample[] = [
  {
    label: 'cy.intercept + cy.wait pattern',
    cypress: `cy.intercept('GET', '/api/users').as('getUsers');
cy.visit('/users');
cy.wait('@getUsers');
cy.get('.user-list li').should('have.length.greaterThan', 0);`,
    playwright: `const getUsersPromise = page.waitForResponse('**/api/users');
await page.goto('/users');
await getUsersPromise;
await expect(page.locator('.user-list li')).not.toHaveCount(0);`,
  },
  {
    label: 'cy.intercept with response stub',
    cypress: `cy.intercept('POST', '/api/login', {
  statusCode: 200,
  body: { token: 'fake-jwt' },
}).as('login');
cy.get('#submit').click();
cy.wait('@login');`,
    playwright: `await page.route('**/api/login', async (route) => {
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ token: 'fake-jwt' }),
  });
});
await page.locator('#submit').click();`,
  },
  {
    label: 'cy.then callback',
    cypress: `cy.get('.item-count').then(($el) => {
  const count = parseInt($el.text(), 10);
  expect(count).to.be.greaterThan(0);
});`,
    playwright: `const countText = await page.locator('.item-count').textContent();
const count = parseInt(countText ?? '0', 10);
expect(count).toBeGreaterThan(0);`,
  },
  {
    label: 'cy.fixture + cy.request',
    cypress: `cy.fixture('user.json').then((userData) => {
  cy.request('POST', '/api/users', userData).then((resp) => {
    expect(resp.status).to.eq(201);
  });
});`,
    playwright: `import userData from '../fixtures/user.json';

const response = await page.request.post('/api/users', { data: userData });
expect(response.status()).toBe(201);`,
  },
  {
    label: 'cy.within scoped context',
    cypress: `cy.get('.modal').within(() => {
  cy.get('input[name="email"]').type('test@test.com');
  cy.get('button[type="submit"]').click();
});`,
    playwright: `const modal = page.locator('.modal');
await modal.locator('input[name="email"]').fill('test@test.com');
await modal.locator('button[type="submit"]').click();`,
  },
  {
    label: 'cy.wrap with alias',
    cypress: `cy.wrap({ name: 'Alice', age: 30 }).as('user');
cy.get('@user').then((user) => {
  cy.get('#name').type(user.name);
});`,
    playwright: `const user = { name: 'Alice', age: 30 };
await page.locator('#name').fill(user.name);`,
  },
];

// ---------------------------------------------------------------------------
// User Prompt Builders
// ---------------------------------------------------------------------------

/**
 * Build the user prompt for full-file AI conversion (pure-ai mode).
 * Includes few-shot examples for complex patterns.
 */
export function buildFullFilePrompt(cypressCode: string, filePath?: string): string {
  const fewShots = FEW_SHOT_EXAMPLES.map(
    (ex) =>
      `### Example: ${ex.label}\n\n**Cypress:**\n\`\`\`typescript\n${ex.cypress}\n\`\`\`\n\n**Playwright:**\n\`\`\`typescript\n${ex.playwright}\n\`\`\``,
  ).join('\n\n');

  return `Convert the following Cypress test file to Playwright.${filePath ? ` Source: ${filePath}` : ''}

## Reference Examples

${fewShots}

## Cypress Code to Convert

\`\`\`typescript
${cypressCode}
\`\`\`

Return ONLY the complete converted Playwright test file inside a single \`\`\`typescript code block.`;
}

/**
 * Build the user prompt for converting a single unresolved code snippet
 * (used in hybrid mode for placeholder resolution).
 */
export function buildSnippetPrompt(
  snippet: string,
  surroundingContext: string,
): string {
  const relevantExamples = FEW_SHOT_EXAMPLES.filter((ex) => {
    // Only include examples that are relevant to the snippet
    const snippetLower = snippet.toLowerCase();
    return (
      (snippetLower.includes('intercept') && ex.label.includes('intercept')) ||
      (snippetLower.includes('then') && ex.label.includes('then')) ||
      (snippetLower.includes('fixture') && ex.label.includes('fixture')) ||
      (snippetLower.includes('within') && ex.label.includes('within')) ||
      (snippetLower.includes('wrap') && ex.label.includes('wrap')) ||
      (snippetLower.includes('request') && ex.label.includes('request'))
    );
  });

  const examplesBlock =
    relevantExamples.length > 0
      ? `\n## Relevant Examples\n\n${relevantExamples
          .map(
            (ex) =>
              `### ${ex.label}\n**Cypress:**\n\`\`\`typescript\n${ex.cypress}\n\`\`\`\n**Playwright:**\n\`\`\`typescript\n${ex.playwright}\n\`\`\``,
          )
          .join('\n\n')}\n`
      : '';

  return `Convert this Cypress code snippet to Playwright.
${examplesBlock}
## Surrounding Context

\`\`\`typescript
${surroundingContext}
\`\`\`

## Snippet to Convert

\`\`\`typescript
${snippet}
\`\`\`

Return ONLY the converted Playwright code inside a single \`\`\`typescript code block. No explanations.`;
}

/**
 * Extract code from the first TypeScript/JavaScript code block in an LLM response.
 * Returns the raw code string, or null if no code block is found.
 */
export function extractCodeBlock(response: string): string | null {
  // Match ```typescript ... ``` or ```ts ... ``` or ```javascript ... ``` or plain ``` ... ```
  const codeBlockRegex = /```(?:typescript|ts|javascript|js)?\s*\n([\s\S]*?)```/;
  const match = response.match(codeBlockRegex);
  return match ? match[1].trim() : null;
}
