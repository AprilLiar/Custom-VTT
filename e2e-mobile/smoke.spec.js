import { test, expect } from '@playwright/test';
import { chooseGm, expectNoHorizontalOverflow, goToArena, goToNavLabel } from './helpers.js';

// §15.2: every top-level page must render without horizontal scroll at
// whatever viewport this project runs at (320px up through tablet
// landscape), and the primary navigation for that viewport must be usable.
// Below the app's own md: breakpoint (768px) that's the bottom nav
// (App.jsx's BottomNav, `md:hidden`); at or above it, the desktop header
// links (`hidden md:inline-block`) take over — both are exercised here
// rather than hardcoding one nav pattern, since this same spec runs against
// both a 320px phone and an 863px-wide landscape project.
test.describe('mobile smoke: every page loads without horizontal overflow', () => {
  test('role picker itself has no overflow', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByText('Who are you this session?')).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });

  test('Arena, Characters, Compendium reachable and overflow-free', async ({ page }, testInfo) => {
    await chooseGm(page);
    await expectNoHorizontalOverflow(page);

    const isMobileNav = (page.viewportSize()?.width ?? 0) < 768;

    await goToNavLabel(page, 'Characters');
    await expect(page).toHaveURL(/\/$/);
    await expectNoHorizontalOverflow(page);

    await goToNavLabel(page, 'Compendium');
    await expect(page).toHaveURL(/\/compendium/);
    await expectNoHorizontalOverflow(page);

    await goToArena(page);
    await expect(page).toHaveURL(/\/combat/);
    await expectNoHorizontalOverflow(page);

    testInfo.annotations.push({ type: 'nav-mode', description: isMobileNav ? 'bottom-nav' : 'desktop-header' });
  });

  test('min-width 320px viewport does not collapse the layout', async ({ page }) => {
    // Only meaningful on the 320-fallback project, but harmless elsewhere —
    // index.css's `min-width: 320px` on html/body/#root (§14.3) is the
    // thing under test, so this asserts it held rather than skipping.
    await chooseGm(page);
    const width = await page.evaluate(() => document.documentElement.clientWidth);
    expect(width).toBeGreaterThanOrEqual(320);
    await expectNoHorizontalOverflow(page);
  });
});
