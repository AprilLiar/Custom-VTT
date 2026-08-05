import { test, expect } from '@playwright/test';
import { chooseGm } from './helpers.js';

// DialogShell (client/src/components/DialogShell.jsx) centralizes focus
// trap / scroll-lock / Escape / backdrop-click for every dialog in the app
// (task #218) — exercised once here against the Characters folder drawer as
// a representative instance, rather than duplicating the same three
// assertions per call site.
test.describe('DialogShell: shared dismiss behavior', () => {
  test.beforeEach(async ({ page }) => {
    test.skip((page.viewportSize()?.width ?? 0) >= 768, 'drawer trigger only renders below md');
    await chooseGm(page);
    await page.locator('nav a', { hasText: 'Characters' }).first().click();
    await page.getByRole('button', { name: /Change…/ }).click();
  });

  test('backdrop click closes the dialog', async ({ page }) => {
    const dialog = page.getByRole('dialog', { name: 'Folders' });
    await expect(dialog).toBeVisible();
    // Click the backdrop itself, not the panel — top-left corner is
    // guaranteed outside the bottom-sheet panel on every project's viewport.
    await page.mouse.click(2, 2);
    await expect(dialog).not.toBeVisible();
  });

  test('close (✕) button is a 44px touch target', async ({ page }) => {
    const dialog = page.getByRole('dialog', { name: 'Folders' });
    const closeButton = dialog.getByRole('button', { name: 'Close' });
    const box = await closeButton.boundingBox();
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
  });
});
