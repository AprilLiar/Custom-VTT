import { test, expect } from '@playwright/test';
import { chooseGm } from './helpers.js';

test.describe('Compendium: mobile Discipline drawer', () => {
  test.beforeEach(async ({ page }) => {
    test.skip((page.viewportSize()?.width ?? 0) >= 768, 'desktop sidebar layout applies at this width');
    await chooseGm(page);
    await page.locator('nav a', { hasText: 'Compendium' }).first().click();
    await expect(page).toHaveURL(/\/compendium/);
  });

  test('Discipline drawer opens and a style-filter button meets the 44px touch target', async ({ page }) => {
    const trigger = page.getByRole('button', { name: /Change…/ });
    await expect(trigger).toBeVisible();
    await trigger.click();

    const dialog = page.getByRole('dialog', { name: 'Disciplines' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('All Moves')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();

    // Style filter icon buttons bump to 44px on coarse pointers (§8.3 audit,
    // task #217) — this is the concrete regression check for that.
    const styleButton = page.locator('button[title^="Filter by"]').first();
    const box = await styleButton.boundingBox();
    expect(box.height).toBeGreaterThanOrEqual(44);
  });
});
