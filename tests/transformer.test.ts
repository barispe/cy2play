// ============================================================================
// Cy2Play — Transformer Tests
// ============================================================================

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { transformFile } from '../src/transformer';

const FIXTURES = join(__dirname, 'fixtures');

function readFixture(relativePath: string): string {
  return readFileSync(join(FIXTURES, relativePath), 'utf-8');
}

// ---------------------------------------------------------------------------
// Login fixture — straightforward selectors + actions + assertions
// ---------------------------------------------------------------------------

describe('Transformer — login.cy.ts', () => {
  const input = readFixture('input/login.cy.ts');
  const expected = readFixture('expected/login.spec.ts');
  let result: ReturnType<typeof transformFile>;

  // Run the transformer once for all tests in this describe
  result = transformFile(input, 'login.cy.ts');

  it('should produce valid Playwright code', () => {
    expect(result.code).toBeTruthy();
    expect(result.code.length).toBeGreaterThan(0);
  });

  it('should include the Playwright import', () => {
    expect(result.code).toContain("import { test, expect } from '@playwright/test';");
  });

  it('should convert describe → test.describe', () => {
    expect(result.code).toContain("test.describe('Login',");
  });

  it('should convert beforeEach with async ({ page })', () => {
    expect(result.code).toContain('test.beforeEach(async ({ page }) => {');
  });

  it('should convert it → test with async ({ page })', () => {
    expect(result.code).toContain("test('should log in successfully', async ({ page }) => {");
  });

  it('should convert cy.visit → await page.goto', () => {
    expect(result.code).toContain("await page.goto('/login');");
  });

  it('should convert cy.get().type() → await page.locator().fill()', () => {
    expect(result.code).toContain("await page.locator('[data-cy=email]').fill('user@test.com');");
  });

  it('should convert cy.get().click() → await page.locator().click()', () => {
    expect(result.code).toContain("await page.locator('[data-cy=submit]').click();");
  });

  it('should convert cy.url().should("include",...) → await expect(page).toHaveURL(regex)', () => {
    expect(result.code).toContain('await expect(page).toHaveURL(/dashboard/);');
  });

  it('should convert .should("be.visible") → await expect().toBeVisible()', () => {
    expect(result.code).toContain("await expect(page.locator('.error-message')).toBeVisible();");
  });

  it('should convert .should("have.text",...) → await expect().toHaveText()', () => {
    expect(result.code).toContain("await expect(page.locator('.error-message')).toHaveText('Invalid credentials');");
  });

  it('should report zero unresolved nodes for login fixture', () => {
    expect(result.unresolvedNodes).toHaveLength(0);
  });

  it('should report zero manual-review items for login fixture', () => {
    expect(result.stats.manualReview).toBe(0);
  });

  it('should have applied multiple rules', () => {
    expect(result.stats.rulesApplied).toBeGreaterThan(5);
  });
});

// ---------------------------------------------------------------------------
// Navigation fixture — complex commands, check/select, assertions
// ---------------------------------------------------------------------------

describe('Transformer — navigation.cy.ts', () => {
  const input = readFixture('input/navigation.cy.ts');
  let result: ReturnType<typeof transformFile>;

  result = transformFile(input, 'navigation.cy.ts');

  it('should produce valid Playwright code', () => {
    expect(result.code).toBeTruthy();
  });

  it('should convert describe → test.describe', () => {
    expect(result.code).toContain("test.describe('Navigation',");
  });

  it('should convert cy.get(...).click()', () => {
    expect(result.code).toContain('await page.locator(\'a[href="/about"]\').click();');
  });

  it('should convert cy.url().should("include", "/about")', () => {
    expect(result.code).toMatch(/await expect\(page\)\.toHaveURL\(\/.*about.*\/\)/);
  });

  it('should convert cy.get("h1").should("have.text", "About Us")', () => {
    expect(result.code).toContain("await expect(page.locator('h1')).toHaveText('About Us');");
  });

  it('should mark cy.intercept as unresolved / TODO', () => {
    expect(result.code).toContain('TODO');
    expect(result.code).toMatch(/intercept/i);
  });

  it('should have unresolved nodes for the intercept test', () => {
    expect(result.unresolvedNodes.length).toBeGreaterThan(0);
  });

  it('should convert cy.get("#notifications").check()', () => {
    expect(result.code).toContain("await page.locator('#notifications').check();");
  });

  it('should convert .should("be.checked") → toBeChecked()', () => {
    expect(result.code).toContain("await expect(page.locator('#notifications')).toBeChecked();");
  });

  it('should convert cy.get("#theme").select("dark") → .selectOption("dark")', () => {
    expect(result.code).toContain("await page.locator('#theme').selectOption('dark');");
  });

  it('should convert .should("have.value", "dark") → toHaveValue("dark")', () => {
    expect(result.code).toContain("await expect(page.locator('#theme')).toHaveValue('dark');");
  });

  it('should report some manual-review items (intercept/wait)', () => {
    expect(result.stats.manualReview).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('Transformer — edge cases', () => {
  it('should handle an empty file', () => {
    const result = transformFile('', 'empty.cy.ts');
    expect(result.code).toContain("import { test, expect } from '@playwright/test';");
    expect(result.warnings).toHaveLength(0);
  });

  it('should handle a file with only comments', () => {
    const result = transformFile('// just a comment\n/* block */\n', 'comments.cy.ts');
    expect(result.code).toContain('// just a comment');
    expect(result.warnings).toHaveLength(0);
  });

  it('should convert describe.only → test.describe.only', () => {
    const input = `describe.only('Focus', () => {\n  it('test', () => {\n    cy.visit('/');\n  });\n});`;
    const result = transformFile(input, 'focus.cy.ts');
    expect(result.code).toContain("test.describe.only('Focus',");
  });

  it('should convert it.skip → test.skip', () => {
    const input = `describe('Suite', () => {\n  it.skip('skipped', () => {\n    cy.visit('/');\n  });\n});`;
    const result = transformFile(input, 'skip.cy.ts');
    expect(result.code).toContain("test.skip('skipped', async ({ page }) => {");
  });

  it('should convert cy.get().first().click()', () => {
    const input = `cy.get('.item').first().click();`;
    const result = transformFile(input, 'first.cy.ts');
    expect(result.code).toContain("await page.locator('.item').first().click();");
  });

  it('should convert cy.get().last().click()', () => {
    const input = `cy.get('.item').last().click();`;
    const result = transformFile(input, 'last.cy.ts');
    expect(result.code).toContain("await page.locator('.item').last().click();");
  });

  it('should convert cy.get().eq(2).click()', () => {
    const input = `cy.get('.item').eq(2).click();`;
    const result = transformFile(input, 'eq.cy.ts');
    expect(result.code).toContain("await page.locator('.item').nth(2).click();");
  });

  it('should convert cy.get().find(selector)', () => {
    const input = `cy.get('.parent').find('.child').click();`;
    const result = transformFile(input, 'find.cy.ts');
    expect(result.code).toContain("await page.locator('.parent').locator('.child').click();");
  });

  it('should convert negated assertions (.should("not.be.visible"))', () => {
    const input = `cy.get('.modal').should('not.be.visible');`;
    const result = transformFile(input, 'negated.cy.ts');
    expect(result.code).toContain("await expect(page.locator('.modal')).not.toBeVisible();");
  });

  it('should convert cy.contains(text).click()', () => {
    const input = `cy.contains('Submit').click();`;
    const result = transformFile(input, 'contains.cy.ts');
    expect(result.code).toContain("await page.getByText('Submit').click();");
  });

  it('should return stats with duration', () => {
    const result = transformFile(`cy.visit('/');`, 'timing.cy.ts');
    expect(result.stats.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.stats.totalCommands).toBeGreaterThan(0);
  });

  it('should mark cy.then as complex / TODO', () => {
    const input = `cy.get('.el').then(($el) => { console.log($el); });`;
    const result = transformFile(input, 'then.cy.ts');
    expect(result.code).toContain('TODO');
    expect(result.unresolvedNodes.length).toBeGreaterThan(0);
  });

  it('should handle static cy.wait(ms) with warning', () => {
    const input = `cy.wait(2000);`;
    const result = transformFile(input, 'wait.cy.ts');
    expect(result.code).toContain('await page.waitForTimeout(2000);');
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});
