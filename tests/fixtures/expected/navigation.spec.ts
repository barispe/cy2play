import { test, expect } from '@playwright/test';

test.describe('Navigation', () => {
  test('should navigate to about page', async ({ page }) => {
    await page.goto('/');
    await page.locator('a[href="/about"]').click();
    await expect(page).toHaveURL(/about/);
    await expect(page.locator('h1')).toHaveText('About Us');
  });

  test('should wait for API response', async ({ page }) => {
    // TODO: Manual review required — cy.intercept + cy.wait pattern needs refactoring
    const getUsersPromise = page.waitForResponse('**/api/users');
    await page.goto('/users');
    await getUsersPromise;
    await expect(page.locator('.user-list li')).not.toHaveCount(0);
  });

  test('should handle checkbox and select', async ({ page }) => {
    await page.goto('/settings');
    await page.locator('#notifications').check();
    await expect(page.locator('#notifications')).toBeChecked();
    await page.locator('#theme').selectOption('dark');
    await expect(page.locator('#theme')).toHaveValue('dark');
  });
});
