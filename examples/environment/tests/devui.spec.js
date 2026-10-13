import { expect, test } from '@playwright/test';

// Renders the environment canvas at a fixed time (the frame loop's SEM
// rendering is paused, so the moving robot stays put) and returns a cheap
// pixel fingerprint.
const snapshot = (page) =>
  page.evaluate(() => {
    const sem = window.xrDevice.sem;
    if (!sem.pausedRender) {
      sem.pausedRender = sem.render.bind(sem);
      sem.render = () => {};
    }
    sem.pausedRender(1000);
    const canvas = sem.environmentCanvas;
    const gl = sem.renderer.getContext();
    const pixels = new Uint8Array(canvas.width * canvas.height * 4);
    gl.readPixels(
      0,
      0,
      canvas.width,
      canvas.height,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      pixels,
    );
    let sum = 0;
    for (let i = 0; i < pixels.length; i += 97)
      sum = (sum * 31 + pixels[i]) >>> 0;
    return sum;
  });

const counts = (page) =>
  page.evaluate(() => ({
    planes: window.xrState.planes?.length ?? 0,
    meshes: window.xrState.meshes?.length ?? 0,
  }));

test('DevUI visibility toggles affect the scene environment', async ({
  page,
}) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error));
  await page.goto('http://localhost:5180/?outlines=0');
  await page.getByRole('button', { name: 'Enter AR' }).click();
  await expect.poll(async () => (await counts(page)).planes).toBeGreaterThan(0);

  for (const title of [
    'Toggle plane visibility',
    'Toggle bounding-box visibility',
    'Toggle mesh visibility',
  ]) {
    const before = await snapshot(page);
    await page.getByTitle(title).click();
    const toggled = await snapshot(page);
    await page.getByTitle(title).click();
    const restored = await snapshot(page);
    expect(toggled, `${title} changes the rendered environment`).not.toBe(
      before,
    );
    expect(restored, `${title} toggles back`).toBe(before);
  }
  expect(errors).toEqual([]);
});

test('the DevUI menu lists the built-in rooms, then the legacy scans', async ({
  page,
}) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error));
  await page.goto('http://localhost:5180/?outlines=0');
  await page.getByRole('button', { name: 'Enter AR' }).click();
  await expect.poll(async () => (await counts(page)).planes).toBeGreaterThan(0);
  const living = await counts(page);
  const menu = page.getByRole('button', { name: /environment/i }).first();

  // Rooms come first; the captures follow in a "Legacy scans" group, and
  // "None" comes last, outside the groups.
  await menu.click();
  const buttons = await page
    .locator('#iwer-environment-menu')
    .getByRole('button')
    .allTextContents();
  expect(buttons.indexOf('Home Office')).toBeGreaterThanOrEqual(0);
  expect(buttons.indexOf('Home Office')).toBeLessThan(
    buttons.indexOf('Office Small'),
  );
  expect(buttons.at(-1)).toBe('None');
  const legacy = page.getByRole('group', { name: 'Legacy scans' });
  await expect(legacy.getByRole('button')).toHaveText([
    'Living Room',
    'Meeting Room',
    'Music Room',
    'Office Large',
    'Office Small',
  ]);

  // Load a legacy scan through the DevUI environment menu.

  await page.getByRole('button', { name: 'Office Small' }).click();
  await expect
    .poll(async () => (await counts(page)).planes)
    .not.toBe(living.planes);
  // The app's outlines follow what is detected; nothing piles up.
  await expect
    .poll(() =>
      page.evaluate(() => {
        const s = window.xrState;
        return s.outlines === s.planes.length + s.meshes.length;
      }),
    )
    .toBe(true);
  const office = await page.evaluate(() => ({
    toneMapping: window.xrDevice.sem.renderer.toneMapping,
    shadows: window.xrDevice.sem.renderer.shadowMap.enabled,
    scene: window.xrDevice.sem.sceneEnvironment,
  }));
  expect(office).toEqual({ toneMapping: 0, shadows: false, scene: null });

  // And back to a built-in room, listed in the same menu.
  await menu.click();
  await page.getByRole('button', { name: 'Sunlit Living Room' }).click();
  await expect.poll(async () => counts(page)).toEqual(living);
  expect(errors).toEqual([]);
});
