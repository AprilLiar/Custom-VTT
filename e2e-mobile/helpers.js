// Shared helpers for the mobile device-matrix specs. RoleModal asks "who
// are you" on every fresh load (roleContext.jsx: "deliberately not
// persisted"), and it's a real navigation gate — every spec needs to clear
// it before the app underneath is reachable.

export async function chooseGm(page) {
  await page.goto('/');
  await page.getByText('GM', { exact: true }).click();
}

export async function choosePlayer(page, characterName) {
  await page.goto('/');
  await page.getByRole('button', { name: new RegExp(characterName, 'i') }).click();
}

// The bottom nav (App.jsx's BottomNav) is the only mobile-visible way to
// switch pages — the desktop header links are `hidden md:inline-block`, so
// which locator finds a visible link depends on the current viewport.
export async function goToNavLabel(page, label) {
  const isMobileNav = (page.viewportSize()?.width ?? 0) < 768;
  const scope = isMobileNav ? 'nav a' : 'header a';
  await page.locator(scope, { hasText: label }).first().click();
}

// The "Custom VTT" logo (App.jsx) always links to the Arena and is never
// `hidden` at any breakpoint — unlike Characters/Compendium, Arena has no
// separate text link in the desktop header, so this is the one reliable way
// to get there regardless of viewport.
export async function goToArena(page) {
  await page.locator('[title="Combat Arena"]').click();
}

// Fails the assertion if any element makes the document wider than its own
// viewport — the concrete, measurable form of "no horizontal scroll on a
// narrow phone" from §14.3.
export async function expectNoHorizontalOverflow(page) {
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  if (scrollWidth > clientWidth) {
    throw new Error(`horizontal overflow: scrollWidth ${scrollWidth} > clientWidth ${clientWidth}`);
  }
}
