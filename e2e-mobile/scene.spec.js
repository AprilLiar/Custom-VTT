import { test, expect } from '@playwright/test';
import { chooseGm, choosePlayer } from './helpers.js';

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
  // Already there? Skip the click entirely — this suite's projects share
  // one live dev server, and `stage:updated` is a global `io.emit`
  // (decision #3): a DIFFERENT test's Scene activation, running
  // concurrently, can force-navigate THIS page to /scene before this
  // function's own click ever runs. At that point the header/nav are
  // already gone (the chromeless route mounts neither), so waiting to
  // click a link that will never reappear just hangs to the test timeout.
  // Proceeding from "already on /scene" is correct, not a workaround —
  // it's the exact state this function exists to reach.
  if (/\/scene(?:$|[/?#])/.test(new URL(page.url()).pathname)) return;
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

test.describe('Scene tab: cinematic hide-UI toggle', () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test('GM: hiding the interface clears every overlay control; tapping the stage restores them', async ({ page }) => {
    await chooseGm(page);
    await goToScene(page);
    await expect(page.getByText('Characters', { exact: true })).toBeVisible();
    await expect(page.getByText('Scenes', { exact: true })).toBeVisible();
    await expect(page.locator('a[title="Back to the Arena"]')).toBeVisible();

    await page.locator('button[title^="Hide interface"]').click();
    // Only what cinematic mode is FOR — the backdrop and the figures —
    // stays; every drawer and corner control, GM's own hide toggle
    // included, is gone rather than merely covered.
    await expect(page.getByText('Characters', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Scenes', { exact: true })).toHaveCount(0);
    await expect(page.locator('a[title="Back to the Arena"]')).toHaveCount(0);
    await expect(page.locator('button[title^="Hide interface"]')).toHaveCount(0);

    // "Tapping anything brings them back" — no dedicated "show" control,
    // just a plain click anywhere on the now-bare stage.
    await page.mouse.click(640, 450);
    await expect(page.getByText('Characters', { exact: true })).toBeVisible();
    await expect(page.locator('a[title="Back to the Arena"]')).toBeVisible();
  });
});

test.describe('Scene tab: orientation gate — phone-width portrait is asked to rotate', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('the rotate prompt shows, chrome stays absent, and the corner link still gets you out', async ({ page }) => {
    await chooseGm(page);
    await goToScene(page);
    await expect(page.getByText('Flip your device to landscape')).toBeVisible();
    // Chrome stays absent even while gated — the gate is inside the same
    // chromeless route, not a fallback to the normal Shell.
    await expect(page.locator('header')).toHaveCount(0);
    // Regression: the gate used to render with no way off the route at
    // all — a phone-width Player stuck in portrait had to rotate the
    // device just to reach the corner link, which only rendered in the
    // canvas branch below this one.
    await page.locator('a[title="Back to the Arena"]').click();
    await expect(page).toHaveURL(/\/combat/);
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

  test('every character gets the tab, PC or NPC, empty until a picture is uploaded', async ({ page }) => {
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
    // The GM can edit this character, so the empty state is the "+ Add
    // picture" tile, not the read-only "No Scene Pictures yet." message —
    // that one only shows to a viewer who cannot upload (see the Player
    // gate test below).
    await expect(page.getByText('+ Add picture', { exact: true })).toBeVisible();
    await expect(page.getByText('No Scene Pictures yet.')).toHaveCount(0);
  });

  test('a GM can upload, rename, and delete a Scene Picture (Phase 3)', async ({ page }) => {
    await page.request.post('/api/characters', {
      data: { name: `Scene Upload Spec PC ${Date.now()}`, characterType: 'pc' },
    });
    await chooseGm(page);
    await page.locator('[class*="cursor-pointer"]').first().click();
    await page.getByRole('button', { name: 'Scene Pictures' }).click();

    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.getByText('+ Add picture', { exact: true }).click(),
    ]);
    await chooser.setFiles({
      name: 'tiny.png',
      mimeType: 'image/png',
      // A 1x1 transparent PNG — the pipeline (fileToScenePicture) only
      // cares that this decodes as an image, not what it shows.
      buffer: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        'base64'
      ),
    });
    await expect(page.getByText('tiny', { exact: true })).toBeVisible();

    page.once('dialog', (dialog) => dialog.accept('Renamed'));
    await page.locator('button[title="Rename"]').click();
    await expect(page.getByText('Renamed', { exact: true })).toBeVisible();

    page.once('dialog', (dialog) => dialog.accept());
    await page.getByText('Delete', { exact: true }).click();
    await expect(page.getByText('Renamed', { exact: true })).toHaveCount(0);
    await expect(page.getByText('+ Add picture', { exact: true })).toBeVisible();
  });

  test('a Player can upload a Scene Picture to their own character', async ({ page }) => {
    const name = `Scene Player Upload PC ${Date.now()}`;
    const created = await page.request
      .post('/api/characters', { data: { name, characterType: 'pc' } })
      .then((r) => r.json());
    await choosePlayer(page, name);
    await page.getByRole('button', { name: 'Scene Pictures' }).click();

    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.getByText('+ Add picture', { exact: true }).click(),
    ]);
    await chooser.setFiles({
      name: 'tiny.png',
      mimeType: 'image/png',
      buffer: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        'base64'
      ),
    });
    await expect(page.getByText('tiny', { exact: true })).toBeVisible();

    // Confirm it landed server-side as a real scene_pictures row, owned by
    // this character — not just a client-side optimistic render.
    const rows = await page.request
      .get(`/api/scene-pictures?ownerType=character&ownerId=${created.id}`)
      .then((r) => r.json());
    expect(rows).toHaveLength(1);
  });
});

test.describe('Scene tab: the Temp NPC roster drawer (Phase 2)', () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test('GM: create, rename, and delete a Temp NPC folder and a Temp NPC', async ({ page }) => {
    const stamp = Date.now();
    const renamedFolder = `Renamed Folder ${stamp}`;
    page.on('dialog', (dialog) => dialog.accept(dialog.type() === 'prompt' ? renamedFolder : undefined));

    await chooseGm(page);
    await goToScene(page);
    // exact: true, since the section labels render CSS-uppercased ("TEMP
    // NPCS") but the DOM text itself is title case, and a case-insensitive
    // substring match also catches the "🏠 All Temp NPCs" button below it.
    await expect(page.getByText('Temp NPCs', { exact: true })).toBeVisible();
    await expect(page.getByText('Characters', { exact: true })).toBeVisible();

    // Create a folder, then a Temp NPC filed inside it. Both names are
    // stamped — this suite's projects share one live dev server
    // (playwright.config.js's reuseExistingServer), so a literal "Bandits"
    // from two projects running this same test in an overlapping window
    // would collide in that shared temp_npc_folders table, not just in
    // this page's own DOM.
    const folderName = `Bandits ${stamp}`;
    await page.getByPlaceholder('New Temp NPC folder').fill(folderName);
    await page.locator('form:has(input[placeholder="New Temp NPC folder"]) button[type="submit"]').click();
    await expect(page.getByText(`📁 ${folderName}`, { exact: true })).toBeVisible();
    await page.getByText(`📁 ${folderName}`, { exact: true }).click();

    const grunt = `Bandit Grunt ${stamp}`;
    const captain = `Bandit Captain ${stamp}`;
    await page.getByPlaceholder('New Temp NPC', { exact: true }).fill(grunt);
    await page.locator('form:has(input[placeholder="New Temp NPC"]) button[type="submit"]').click();
    await expect(page.getByText(grunt, { exact: true })).toBeVisible();

    // The "✎" button opens the picture editor straight away (decision #9)
    // — rename through it, which is also this dialog's only write besides
    // delete, so it doubles as the tab's rename coverage. Not the card's
    // own click any more (Phase 5): that one is the summon trigger now, so
    // editing had to move onto a button of its own — see SceneCastDrawer's
    // own comment on why overloading one element with both broke down.
    await page.locator(`button[title="Edit ${grunt}"]`).click();
    // GM-editable (TempNpcEditor always passes canEdit), so the empty
    // state is the "+ Add picture" tile — see the Scene Pictures tab's
    // own describe block above for the read-only wording's own coverage.
    await expect(page.getByText('+ Add picture', { exact: true })).toBeVisible();
    await page.locator(`input[value="${grunt}"]`).fill(captain);
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('heading', { name: captain })).toBeVisible();
    await page.getByRole('button', { name: 'Close' }).click();
    await expect(page.getByText(captain, { exact: true })).toBeVisible();

    // Delete the Temp NPC, then the folder it was in.
    await page.locator(`button[title="Edit ${captain}"]`).click();
    await page.getByRole('button', { name: 'Delete Temp NPC' }).click();
    await expect(page.getByText(captain, { exact: true })).toHaveCount(0);

    await page.locator('button[title="Rename"]').first().click();
    await expect(page.getByText(`📁 ${renamedFolder}`, { exact: true })).toBeVisible();
    await page.locator('button[title="Delete"]').first().click();
    await expect(page.getByText(`📁 ${renamedFolder}`, { exact: true })).toHaveCount(0);
  });

  test('GM: the Characters section lists PCs, not just NPCs', async ({ page }) => {
    // Regression: this section used to filter to `character_type === 'npc'`
    // only, so a GM had no way to summon a PC at all — decision #5 is "one
    // place to summon anyone the GM controls," which a PC is included in.
    const pcName = `Scene Cast PC ${Date.now()}`;
    await page.request.post('/api/characters', { data: { name: pcName, characterType: 'pc' } });
    await chooseGm(page);
    await goToScene(page);
    // The attribute, not the computed accessible name — CharacterCard's
    // button nests a Thumb (its own `alt`) alongside the name text, so the
    // accessible name doubles the name up rather than reading as plain
    // "Summon <name>" (the same gotcha noted on the Temp NPC cards above).
    await expect(page.locator(`button[title="Summon ${pcName}"]`)).toBeVisible();
  });

  test('a Player never sees the Temp NPC drawer', async ({ page }) => {
    const name = `Scene Cast Spec PC ${Date.now()}`;
    await page.request.post('/api/characters', { data: { name, characterType: 'pc' } });
    await choosePlayer(page, name);
    await goToScene(page);
    await expect(page.getByText('Temp NPCs', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Characters', { exact: true })).toHaveCount(0);
  });
});

test.describe('Scene tab: Scenes, activation, and the force-navigate cut (Phase 4)', () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  // Two independent browser contexts standing in for a GM and a Player at
  // the same table — this suite's first genuinely two-viewer test, because
  // the thing being pinned (decision #3's force-navigate) only exists as an
  // effect ONE role's action has on the OTHER role's browser. A single
  // `page` fixture can't observe that.
  //
  // Deliberately cleans up (deactivates) the Scene it activates before
  // returning, below — `scene_state` is a real singleton this whole suite
  // shares across every project's own worker, all pointed at one dev
  // server (playwright.config.js's `reuseExistingServer`). `stage:updated`
  // is `io.emit`, by design (decision #3 again) — so while this test's
  // Scene is active, ANY other Scene-tab test running concurrently in
  // another project would also get force-navigated, mid-assertion. That is
  // the feature working correctly, not a bug; if a *different* test flakes
  // with a stray navigation while this one is mid-run, look here first.
  test('activating a Scene force-navigates a Player from any page; a second activation re-cuts them in place; a same-Scene stage update does not re-navigate', async ({
    browser,
  }) => {
    const gmContext = await browser.newContext();
    const gmPage = await gmContext.newPage();
    gmPage.on('dialog', (dialog) => dialog.accept());
    const playerContext = await browser.newContext();
    const playerPage = await playerContext.newPage();

    const stamp = Date.now();
    const name = `Scene Activate Spec PC ${stamp}`;
    await gmPage.request.post('/api/characters', { data: { name, characterType: 'pc' } });

    await chooseGm(gmPage);
    await goToScene(gmPage);
    await gmPage.getByPlaceholder('New Scene', { exact: true }).fill(`Tavern ${stamp}`);
    await gmPage.locator('form:has(input[placeholder="New Scene"]) button[type="submit"]').click();
    await gmPage.getByPlaceholder('New Scene', { exact: true }).fill(`Forest ${stamp}`);
    await gmPage.locator('form:has(input[placeholder="New Scene"]) button[type="submit"]').click();
    await expect(gmPage.getByRole('button', { name: new RegExp(`Tavern ${stamp}`) })).toBeVisible();

    // The Player starts on their own sheet — anywhere but /scene.
    await choosePlayer(playerPage, name);
    await expect(playerPage).toHaveURL(/\/character\/\d+/);

    // First activation: force-navigated, including this being the very
    // first Scene ever activated (decision #3's own wording).
    await gmPage.getByRole('button', { name: new RegExp(`Tavern ${stamp}`) }).click();
    await expect(playerPage).toHaveURL(/\/scene/, { timeout: 5000 });

    // Second activation: the Player, already on /scene, is re-cut in place
    // — never bounced to another page and back.
    await gmPage.getByRole('button', { name: new RegExp(`Forest ${stamp}`) }).click();
    await playerPage.waitForTimeout(300);
    await expect(playerPage).toHaveURL(/\/scene/);

    // The Player leaves on their own. A stage:updated for the SAME active
    // Scene (Phase 5's own summon/un-summon shape, simulated here by
    // renaming the still-active Scene) must not re-navigate them — Risk #1
    // in the Scene tab plan, diffing activeScene?.id and nothing else.
    await playerPage.locator('a[title="Back to the Arena"]').click();
    await expect(playerPage).toHaveURL(/\/combat/);

    await gmPage.getByRole('button', { name: new RegExp(`Forest ${stamp}`) }).dblclick();
    await gmPage.locator(`input[value="Forest ${stamp}"]`).fill(`Forest Renamed ${stamp}`);
    await gmPage.getByRole('button', { name: 'Save' }).click();
    await playerPage.waitForTimeout(500);
    await expect(playerPage).toHaveURL(/\/combat/);

    // Cleanup: deleting the still-active Scene resets scene_state to null
    // (server-side, ON DELETE SET NULL plus this handler's own explicit
    // reset — see server/index.js's scene:delete). scene_state is a
    // singleton shared by the whole suite, so leaving a Scene active here
    // would fail every other test's "No Scene active yet." assertion,
    // depending only on run order.
    await gmPage.getByRole('button', { name: 'Delete Scene' }).click();
    await expect(gmPage.getByRole('button', { name: new RegExp(`Forest Renamed ${stamp}`) })).toHaveCount(0);
    await gmPage.getByRole('button', { name: new RegExp(`Tavern ${stamp}`) }).dblclick();
    await gmPage.getByRole('button', { name: 'Delete Scene' }).click();

    await gmContext.close();
    await playerContext.close();
  });

  test('a Player never sees the Scenes drawer', async ({ page }) => {
    const name = `Scene List Gate PC ${Date.now()}`;
    await page.request.post('/api/characters', { data: { name, characterType: 'pc' } });
    await choosePlayer(page, name);
    await goToScene(page);
    await expect(page.getByText('Scenes', { exact: true })).toHaveCount(0);
  });
});

const TINY_PNG_BUFFER = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
);

test.describe('Scene tab: summoning and the stage roster (Phase 5)', () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test('GM: summon a Temp NPC, swap which picture shows, and un-summon by re-selecting it', async ({ page }) => {
    const stamp = Date.now();
    await chooseGm(page);
    await goToScene(page);

    await page.getByPlaceholder('New Temp NPC', { exact: true }).fill(`Summon Grunt ${stamp}`);
    await page.locator('form:has(input[placeholder="New Temp NPC"]) button[type="submit"]').click();
    await expect(page.getByText(`Summon Grunt ${stamp}`, { exact: true })).toBeVisible();

    // Give it two pictures via its editor (the "✎" button — the card's own
    // click is the summon trigger now, see SceneCastDrawer's own comment
    // on why those two actions had to split onto separate elements).
    await page.locator(`button[title="Edit Summon Grunt ${stamp}"]`).click();
    for (const name of ['Pose A', 'Pose B']) {
      const [chooser] = await Promise.all([
        page.waitForEvent('filechooser'),
        page.getByText('+ Add picture', { exact: true }).click(),
      ]);
      await chooser.setFiles({ name: `${name}.png`, mimeType: 'image/png', buffer: TINY_PNG_BUFFER });
      await expect(page.getByText(name, { exact: true })).toBeVisible();
    }
    await page.getByRole('button', { name: 'Close' }).click();

    // Scoped to this card specifically, not a bare page-wide "Live" —
    // this suite's projects share one live dev server, so another
    // project's own summoned Temp NPC (or an active Scene, which gets the
    // same badge text in SceneListDrawer) can legitimately show a "Live"
    // badge of its own at the same time.
    const liveBadge = page
      .locator('button', { has: page.getByText(`Summon Grunt ${stamp}`, { exact: true }) })
      .getByText('Live', { exact: true });

    // Single click opens the summon picker; picking a picture summons.
    await page.getByText(`Summon Grunt ${stamp}`, { exact: true }).click();
    await page.getByText('Pose A', { exact: true }).click();
    await expect(liveBadge).toBeVisible();

    // Regression: a GM's summon (always side 'right') is anchored by CSS
    // `right`, not an absolute `left` computed from `stageWidth -
    // SLOT_WIDTH` — that formula only actually landed flush against the
    // screen's true right edge when a figure rendered at exactly
    // SLOT_WIDTH wide, and this app's own real art routinely doesn't (see
    // sceneLayout.js's own comment). Pin the wrapper's actual right edge
    // against the true viewport edge directly, which is what CSS `right:
    // 0` guarantees regardless of the image's own rendered width.
    const wrapperRight = await page.evaluate((n) => {
      const img = Array.from(document.querySelectorAll('img')).find((i) => i.alt === n);
      return img?.closest('.absolute.bottom-0')?.getBoundingClientRect().right;
    }, `Summon Grunt ${stamp}`);
    expect(Math.abs(wrapperRight - 1280)).toBeLessThan(2); // the viewport's own true right edge

    // Regression: height is a fixed `h-[70dvh]`, not a box `object-fit:
    // contain` fits an image inside of — constraining only height, with
    // width left `auto`, is what actually standardizes every character's
    // top regardless of their own PNG's own aspect ratio (a fixed W×H box
    // only aligns tops for art narrower than the box itself; plenty of
    // real art isn't). 70, not 100: mobile Safari's `vh` is pinned to the
    // browser chrome-collapsed viewport, not the currently-visible one, so
    // `dvh` plus a safety margin below 100 keeps every figure's top inside
    // the space that's actually visible (this headless run has no dynamic
    // browser chrome, so `dvh` here just equals the plain viewport height).
    const imgHeight = await page.evaluate((n) => {
      const img = Array.from(document.querySelectorAll('img')).find((i) => i.alt === n);
      return img?.getBoundingClientRect().height;
    }, `Summon Grunt ${stamp}`);
    expect(Math.abs(imgHeight - 900 * 0.7)).toBeLessThan(2);

    // A different picture swaps in place, not a fresh summon.
    await page.getByText(`Summon Grunt ${stamp}`, { exact: true }).click();
    await expect(page.getByText('On stage', { exact: true })).toBeVisible();
    await page.getByText('Pose B', { exact: true }).click();
    await expect(liveBadge).toBeVisible();

    // Re-picking the now-showing picture un-summons — the only clear path
    // there is (decision #6): no separate "remove from stage" control.
    await page.getByText(`Summon Grunt ${stamp}`, { exact: true }).click();
    await page.getByText('On stage', { exact: true }).locator('xpath=ancestor::button').click();
    await expect(liveBadge).toHaveCount(0);

    // Cleanup — leaves scene_summons/scene_pictures/temp_npcs empty for
    // whatever test runs next. The "✎" button, not the card's own click —
    // that one opens the summon picker, not the editor.
    await page.locator(`button[title="Edit Summon Grunt ${stamp}"]`).click();
    await page.getByRole('button', { name: 'Delete Temp NPC' }).click();
  });

  test('a Player summons themselves from their own docked control, at the stage\'s left edge', async ({ page }) => {
    const name = `Summon Player ${Date.now()}`;
    const created = await page.request
      .post('/api/characters', { data: { name, characterType: 'pc' } })
      .then((r) => r.json());

    // Upload their own Scene Picture first — SummonPicker only ever lists
    // existing pictures, it has no upload affordance of its own.
    await choosePlayer(page, name);
    await page.getByRole('button', { name: 'Scene Pictures' }).click();
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.getByText('+ Add picture', { exact: true }).click(),
    ]);
    await chooser.setFiles({ name: 'me.png', mimeType: 'image/png', buffer: TINY_PNG_BUFFER });
    await expect(page.getByText('me', { exact: true })).toBeVisible();

    await page.locator('header a[href="/scene"]').click();
    await page.waitForURL(/\/scene/);
    // No drawers for a Player (SceneCastDrawer/SceneListDrawer are GM-only)
    // — and a GM's own summons now use the same full-width layout with no
    // inset either, so this is really pinning `layoutStage`'s own rank-0
    // edge case, not anything Player-specific: a self-summon lands flush
    // at x=0.
    await page.getByText('Summon yourself', { exact: true }).click();
    await page.getByText('me', { exact: true }).click();
    await expect(page.getByText('On stage', { exact: true })).toBeVisible();

    const left = await page.evaluate(() => {
      const wrapper = document.querySelector('.absolute.inset-0.z-\\[1\\]');
      return wrapper?.firstElementChild?.getBoundingClientRect().left;
    });
    expect(left).toBe(0);

    // Cleanup.
    await page.getByText('On stage', { exact: true }).click();
    await page.getByText('me', { exact: true }).click();
  });
});

// Finds a summoned figure's own positioned wrapper by matching its <img
// alt> to the owner's name — StageRoster sets alt={entry.name}, and this
// is more robust than indexing into the roster's children, whose DOM order
// changes as summons come and go (rank 0, the newest, is always first).
// Reads whichever of `left`/`right` StageRoster actually set (never both —
// see that file's own comment on why a right-side figure is anchored by
// `right`, not `left`), so this works for a summon on either side.
async function stageFigureOffset(page, name) {
  return page.evaluate((n) => {
    const img = Array.from(document.querySelectorAll('img')).find((i) => i.alt === n);
    const style = img?.closest('.absolute.bottom-0')?.style;
    return style && (style.left || style.right);
  }, name);
}

test.describe('Scene tab: the stage\'s motion pass (Phase 6)', () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test('summoning a second character repositions an existing one, with no snap-to-origin error', async ({ page }) => {
    const stamp = Date.now();
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));
    page.on('dialog', (dialog) => dialog.accept());

    await chooseGm(page);
    await goToScene(page);

    for (const label of ['A', 'B']) {
      await page.getByPlaceholder('New Temp NPC', { exact: true }).fill(`Reflow${label} ${stamp}`);
      await page.locator('form:has(input[placeholder="New Temp NPC"]) button[type="submit"]').click();
    }
    for (const label of ['A', 'B']) {
      await page.locator(`button[title="Edit Reflow${label} ${stamp}"]`).click();
      const [chooser] = await Promise.all([
        page.waitForEvent('filechooser'),
        page.getByText('+ Add picture', { exact: true }).click(),
      ]);
      await chooser.setFiles({ name: 'pose.png', mimeType: 'image/png', buffer: TINY_PNG_BUFFER });
      await expect(page.getByText('pose', { exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Close' }).click();
    }

    await page.getByText(`ReflowA ${stamp}`, { exact: true }).click();
    await page.getByText('pose', { exact: true }).click();
    // Both are GM summons — same side ('right') — so A is alone on stage
    // first, flush against its edge.
    await expect.poll(() => stageFigureOffset(page, `ReflowA ${stamp}`)).not.toBe(undefined);
    const offsetBefore = await stageFigureOffset(page, `ReflowA ${stamp}`);

    await page.getByText(`ReflowB ${stamp}`, { exact: true }).click();
    await page.getByText('pose', { exact: true }).click();
    // B lands at rank 0 (the edge); A gets pushed one natural step inward.
    // The position/entrance split (see StageRoster's own comment) is what
    // makes this a clean reposition rather than A snapping back to its own
    // slide-in origin and replaying the entrance.
    await expect.poll(() => stageFigureOffset(page, `ReflowA ${stamp}`)).not.toBe(offsetBefore);

    expect(errors).toEqual([]);

    // Cleanup.
    await page.getByText(`ReflowA ${stamp}`, { exact: true }).click();
    await page.getByText('On stage', { exact: true }).locator('xpath=ancestor::button').click();
    await page.getByText(`ReflowB ${stamp}`, { exact: true }).click();
    await page.getByText('On stage', { exact: true }).locator('xpath=ancestor::button').click();
    for (const label of ['A', 'B']) {
      await page.locator(`button[title="Edit Reflow${label} ${stamp}"]`).click();
      await page.getByRole('button', { name: 'Delete Temp NPC' }).click();
    }
  });
});

test.describe('Scene tab: the stage\'s motion pass, reduced motion (Phase 6)', () => {
  test.use({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });

  test('a summon still lands correctly with prefers-reduced-motion, no hang or error', async ({ page }) => {
    const stamp = Date.now();
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));
    page.on('dialog', (dialog) => dialog.accept());

    await chooseGm(page);
    await goToScene(page);

    await page.getByPlaceholder('New Temp NPC', { exact: true }).fill(`ReducedMotion ${stamp}`);
    await page.locator('form:has(input[placeholder="New Temp NPC"]) button[type="submit"]').click();
    await page.locator(`button[title="Edit ReducedMotion ${stamp}"]`).click();
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.getByText('+ Add picture', { exact: true }).click(),
    ]);
    await chooser.setFiles({ name: 'pose.png', mimeType: 'image/png', buffer: TINY_PNG_BUFFER });
    await expect(page.getByText('pose', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Close' }).click();

    await page.getByText(`ReducedMotion ${stamp}`, { exact: true }).click();
    await page.getByText('pose', { exact: true }).click();
    // `transition: { duration: 0 }` under reduced motion (StageRoster's own
    // gate) — the figure is expected to be at its resting position almost
    // immediately, not mid-slide, so a short wait is enough here where the
    // full-motion test above needs expect.poll instead.
    await page.waitForTimeout(200);
    await expect(page.locator(`img[alt="ReducedMotion ${stamp}"]`)).toBeVisible();
    expect(errors).toEqual([]);

    // Cleanup.
    await page.getByText(`ReducedMotion ${stamp}`, { exact: true }).click();
    await page.getByText('On stage', { exact: true }).locator('xpath=ancestor::button').click();
    await page.locator(`button[title="Edit ReducedMotion ${stamp}"]`).click();
    await page.getByRole('button', { name: 'Delete Temp NPC' }).click();
  });
});
