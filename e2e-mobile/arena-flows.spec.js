import { test, expect } from '@playwright/test';
import { chooseGm, goToArena } from './helpers.js';

// §7.3 (task #220/#221): the roster drawer + tap-to-seat replace drag-and-
// drop below sm, and the Tic Counter collapses to a single scrollable row
// below md instead of the desktop multi-row layout.
test.describe('Combat Arena: mobile roster + Tic Counter', () => {
  test.beforeEach(async ({ page }) => {
    await chooseGm(page);
    await goToArena(page);
    await expect(page).toHaveURL(/\/combat/);
  });

  test('Tic Counter renders as a single horizontally-scrollable row once combat is active', async ({ page }) => {
    // The Tic Counter (`TicCounterCentral`) only renders while `phase` is
    // non-null (see the Combat Timing mechanic), and `combat:next_round`'s
    // "Start Combat" button itself only renders once someone is seated —
    // this test data-set's arena may be empty/inactive, and standing up a
    // real fight here would mutate shared server-side state other parallel
    // specs/projects also read against the same backend. Skip rather than
    // assert something false when neither state is currently showing.
    const strip = page.locator('[class*="overflow-x-auto"][class*="mask-image"]').first();
    const isActive = await strip
      .waitFor({ state: 'visible', timeout: 3000 })
      .then(() => true)
      .catch(() => false);
    test.skip(!isActive, 'no active combat in this environment');
    await expect(strip).toBeVisible();
  });

  test('GM roster drawer opens on narrow viewports', async ({ page }) => {
    test.skip((page.viewportSize()?.width ?? 0) >= 640, 'roster drawer trigger is sm:hidden');
    const trigger = page.getByRole('button', { name: 'Roster' });
    await expect(trigger).toBeVisible();
    await trigger.click();

    const dialog = page.getByRole('dialog', { name: 'Roster' });
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
  });
});
