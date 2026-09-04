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
    page.on('dialog', (dialog) => dialog.accept(dialog.type() === 'prompt' ? 'Renamed Folder' : undefined));

    await chooseGm(page);
    await goToScene(page);
    // exact: true, since the section labels render CSS-uppercased ("TEMP
    // NPCS") but the DOM text itself is title case, and a case-insensitive
    // substring match also catches the "🏠 All Temp NPCs" button below it.
    await expect(page.getByText('Temp NPCs', { exact: true })).toBeVisible();
    await expect(page.getByText('Characters (NPCs)', { exact: true })).toBeVisible();

    // Create a folder, then a Temp NPC filed inside it.
    await page.getByPlaceholder('New folder').fill('Bandits');
    await page.locator('form:has(input[placeholder="New folder"]) button[type="submit"]').click();
    await expect(page.getByText('📁 Bandits')).toBeVisible();
    await page.getByText('📁 Bandits').click();

    await page.getByPlaceholder('New Temp NPC').fill('Bandit Grunt');
    await page.locator('form:has(input[placeholder="New Temp NPC"]) button[type="submit"]').click();
    await expect(page.getByText('Bandit Grunt')).toBeVisible();

    // Double-click opens the picture editor straight away (decision #9) —
    // rename through it, which is also this dialog's only write besides
    // delete, so it doubles as the tab's rename coverage.
    await page.getByText('Bandit Grunt').dblclick();
    // GM-editable (TempNpcEditor always passes canEdit), so the empty
    // state is the "+ Add picture" tile — see the Scene Pictures tab's
    // own describe block above for the read-only wording's own coverage.
    await expect(page.getByText('+ Add picture', { exact: true })).toBeVisible();
    await page.locator('input[value="Bandit Grunt"]').fill('Bandit Captain');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('heading', { name: 'Bandit Captain' })).toBeVisible();
    await page.getByRole('button', { name: 'Close' }).click();
    await expect(page.getByText('Bandit Captain')).toBeVisible();

    // Delete the Temp NPC, then the folder it was in.
    await page.getByText('Bandit Captain').dblclick();
    await page.getByRole('button', { name: 'Delete Temp NPC' }).click();
    await expect(page.getByText('Bandit Captain')).toHaveCount(0);

    await page.locator('button[title="Rename"]').first().click();
    await expect(page.getByText('📁 Renamed Folder')).toBeVisible();
    await page.locator('button[title="Delete"]').first().click();
    await expect(page.getByText('📁 Renamed Folder')).toHaveCount(0);
  });

  test('a Player never sees the Temp NPC drawer', async ({ page }) => {
    const name = `Scene Cast Spec PC ${Date.now()}`;
    await page.request.post('/api/characters', { data: { name, characterType: 'pc' } });
    await choosePlayer(page, name);
    await goToScene(page);
    await expect(page.getByText('Temp NPCs', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Characters (NPCs)', { exact: true })).toHaveCount(0);
  });
});
