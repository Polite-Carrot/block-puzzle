import { test, expect, type Page } from '@playwright/test';

async function dropPiece(page: Page, nudge: 'ArrowLeft' | 'ArrowRight', placedAfter: number) {
  await page.keyboard.press(nudge);
  await page.keyboard.down('ArrowDown');
  await expect(page.locator('#stat-placed')).toHaveText(String(placedAfter));
  await page.keyboard.up('ArrowDown');
}

test('a new player can open the app and clear level 1', async ({ page }) => {
  await page.goto('/');

  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('button', { name: /Campaign/ }).click();
  await page.getByRole('button', { name: '1', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Level 1', exact: true })).toBeVisible();

  await dropPiece(page, 'ArrowLeft', 1);
  await dropPiece(page, 'ArrowRight', 2);

  await expect(page.getByRole('heading', { name: 'Perfect fit!' })).toBeVisible();
  await expect(page.locator('#win-stars')).toHaveAttribute('aria-label', '3 stars');
});
