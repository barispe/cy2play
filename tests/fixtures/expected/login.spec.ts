import { test, expect } from '@playwright/test';

test.describe('Login', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/login');
  });

  test('should log in successfully', async ({ page }) => {
    await page.locator('[data-cy=email]').fill('user@test.com');
    await page.locator('[data-cy=password]').fill('password123');
    await page.locator('[data-cy=submit]').click();
    await expect(page).toHaveURL(/dashboard/);
  });

  test('should show error for invalid credentials', async ({ page }) => {
    await page.locator('[data-cy=email]').fill('bad@test.com');
    await page.locator('[data-cy=password]').fill('wrong');
    await page.locator('[data-cy=submit]').click();
    await expect(page.locator('.error-message')).toBeVisible();
    await expect(page.locator('.error-message')).toHaveText('Invalid credentials');
  });
});
