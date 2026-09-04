import { test, expect } from '@playwright/test';
import { chooseGm } from './helpers.js';

// The Scene tab's route (client/src/App.jsx's `Shell()`) is deliberately
// chrome-free — no header, no bottom nav — because a still-mounted bottom
// nav under a force-navigated Player would let them tap their way back out
// (see the Scene tab plan's own Phase 1 notes). What's worth pinning here is
// that the chrome is genuinely ABSENT from the DOM, not merely covered —
// this app's only other "fullscreen" precedent (the Relationships board)
// paints over still-mounted chrome with a portal, and that is exactly the
// shape this route must NOT take.
//
// Deliberate per-describe viewport overrides (`test.use`, only valid at
// describe/file scope, not inside a test body) rather than relying on the
// shared project matrix (playwright.config.js): none of its 5 projects land
// on "narrower than the desktop breakpoint AND landscape" at once, which is
// the one combination the orientation gate has to get right (mobile width,
// landscape orientation → show the canvas, not the rotate prompt).
async function goToScene(page) {
  const isDesktopWidth = (page.viewportSize()?.width ?? 0) >= 768;
  if (isDesktopWidth) {
    await page.locator('header a[href="/scene"]').click();
  } else {
    await page.locator('button[title="Search / Rules / Settings"]').click();
    await page.locator('a[href="/scene"]:visible').click();
  }
}

test.describe('Scene tab: the chromeless route', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('no header and no bottom nav are mounted on /scene', async ({ page }) => {
    await chooseGm(page);
    await goToScene(page);
    await expect(page).toHaveURL(/\/scene/);
    await expect(page.locator('header')).toHaveCount(0);
    await expect(page.locator('nav')).toHaveCount(0);
  });

  test('the corner link is the only way back', async ({ page }) => {
    await chooseGm(page);
    await goToScene(page);
    await page.locator('a[title="Back to the Arena"]').click();
    await expect(page).toHaveURL(/\/combat/);
  });
});

test.describe('Scene tab: orientation gate — phone-width portrait is asked to rotate', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('the rotate prompt shows, chrome stays absent', async ({ page }) => {
    await chooseGm(page);
    await goToScene(page);
    await expect(page.getByText('Flip your device to landscape')).toBeVisible();
    // Chrome stays absent even while gated — the gate is inside the same
    // chromeless route, not a fallback to the normal Shell.
    await expect(page.locator('header')).toHaveCount(0);
  });
});

test.describe('Scene tab: orientation gate — phone-width landscape is not gated', () => {
  test.use({ viewport: { width: 690, height: 390 } });

  test('the canvas shows, not the rotate prompt', async ({ page }) => {
    await chooseGm(page);
    await goToScene(page);
    await expect(page.getByText('Flip your device to landscape')).toHaveCount(0);
    await expect(page.getByText('No Scene active yet.')).toBeVisible();
  });
});

test.describe('Scene tab: orientation gate — desktop width is never gated', () => {
  // Taller than it is wide, but well past the desktop breakpoint — the gate
  // must not fire just because the window happens to be portrait.
  test.use({ viewport: { width: 900, height: 1000 } });

  test('the canvas shows regardless of aspect ratio', async ({ page }) => {
    await chooseGm(page);
    await goToScene(page);
    await expect(page.getByText('Flip your device to landscape')).toHaveCount(0);
    await expect(page.getByText('No Scene active yet.')).toBeVisible();
  });
});

test.describe('Character Sheet: the Scene Pictures tab', () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test('every character gets the tab, PC or NPC, empty until Phase 3', async ({ page }) => {
    await page.request.post('/api/characters', {
      data: { name: `Scene Spec PC ${Date.now()}`, characterType: 'pc' },
    });
    // Role does not survive a page load (roleContext.jsx is deliberately not
    // persisted), so chooseGm's own goto('/') has to run AFTER the character
    // exists, not before — a fresh load is what re-fetches the roster.
    await chooseGm(page);
    await page.locator('[class*="cursor-pointer"]').first().click();
    await expect(page.getByRole('button', { name: 'Scene Pictures' })).toBeVisible();
    await page.getByRole('button', { name: 'Scene Pictures' }).click();
    await expect(page.getByText('No Scene Pictures yet.')).toBeVisible();
  });
});
