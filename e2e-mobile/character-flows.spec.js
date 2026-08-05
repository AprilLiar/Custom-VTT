import { test, expect } from '@playwright/test';
import { chooseGm, goToNavLabel } from './helpers.js';

// §9.2A / task #225: the folder sidebar collapses into a drawer below md,
// and re-filing a character (previously drag-only) gets a tap alternative.
// These flows only exist below the app's md: breakpoint, so this spec skips
// itself on wide (tablet-landscape) projects rather than asserting on UI
// that legitimately isn't there at that width.
test.describe('Characters: mobile folder drawer + tap-to-move', () => {
  test.beforeEach(async ({ page }) => {
    test.skip((page.viewportSize()?.width ?? 0) >= 768, 'desktop sidebar layout applies at this width');
    await chooseGm(page);
    await page.locator('nav a', { hasText: 'Characters' }).first().click();
  });

  test('folder drawer opens and closes', async ({ page }) => {
    const trigger = page.getByRole('button', { name: /Change…/ });
    await expect(trigger).toBeVisible();
    await trigger.click();

    const dialog = page.getByRole('dialog', { name: 'Folders' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('All Characters')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
  });

  test('move-to-folder dialog opens from a character card', async ({ page }) => {
    const moveButton = page.locator('button[title="Move to folder"]').first();
    await expect(moveButton).toBeVisible();
    await moveButton.click();

    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText(/^Move .+ to…$/)).toBeVisible();
    await expect(dialog.getByText('All Characters')).toBeVisible();

    await dialog.getByRole('button', { name: /close/i }).click().catch(() => {});
  });
});

test.describe('Character Sheet: tab strip', () => {
  test.beforeEach(async ({ page }) => {
    await chooseGm(page);
    await goToNavLabel(page, 'Characters');
  });

  test('tapping a tab switches the visible panel', async ({ page }) => {
    // Open whichever character card renders first — this spec only cares
    // about tab-switching behavior, not which character it is.
    await page.locator('[class*="cursor-pointer"]').first().click();
    await expect(page).toHaveURL(/\/character\/\d+/);

    const movesTab = page.getByRole('button', { name: 'Moves' });
    await expect(movesTab).toBeVisible();
    await movesTab.click();

    const perksTab = page.getByRole('button', { name: 'Perks' });
    await perksTab.click();
    // The active tab's underline is a motion.span sibling — cheaper and
    // less brittle than asserting on animation state is just confirming
    // the tab click actually navigated to a different panel.
    await expect(perksTab).toHaveClass(/text-zinc-100/);
  });
});
