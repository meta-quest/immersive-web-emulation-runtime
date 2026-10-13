import { expect, test } from '@playwright/test';

const state = (page) => page.evaluate(() => window.xrState);

test('living_room.glts provides planes, meshes, hit-test and motion in AR', async ({
  page,
}) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error));
  await page.goto('http://localhost:5180/');
  await page.getByRole('button', { name: 'Enter AR' }).click();
  await expect.poll(async () => (await state(page)).frames).toBeGreaterThan(5);

  const first = await state(page);
  const count = (entities, label) =>
    entities.filter((e) => e.label === label).length;
  expect(count(first.planes, 'floor')).toBe(1);
  expect(count(first.planes, 'ceiling')).toBe(1);
  expect(count(first.planes, 'wall')).toBe(4);
  expect(count(first.planes, 'window')).toBe(1);
  expect(count(first.planes, 'door')).toBe(1);
  expect(count(first.planes, 'table')).toBe(2);
  expect(count(first.meshes, 'couch')).toBe(2);
  expect(count(first.meshes, 'shelf')).toBe(2);
  expect(count(first.meshes, 'plant')).toBe(1);

  // Planes report spec-conformant poses: plane space +Y is the normal.
  const up = (plane) => plane.normal.map((n) => Math.abs(Math.round(n)));
  const floor = first.planes.find((p) => p.label === 'floor');
  expect(floor.position[1]).toBeCloseTo(0, 3);
  expect(up(floor)).toEqual([0, 1, 0]);
  for (const table of first.planes.filter((p) => p.label === 'table')) {
    expect(up(table)).toEqual([0, 1, 0]);
  }
  const walls = first.planes.filter((p) => p.label === 'wall').map(up);
  expect(walls.sort()).toEqual([
    [0, 0, 1],
    [0, 0, 1],
    [1, 0, 0],
    [1, 0, 0],
  ]);

  // Looking ahead from 1.6 m, the hit test lands on the room.
  await expect.poll(async () => (await state(page)).hit).not.toBeNull();

  // The robot vacuum is driven by the GLTS onFrame callback. It is part of
  // the emulated world but, like on real devices, not a tracked mesh (the
  // room's global mesh is the static geometry, posed at the origin).
  expect(count(first.meshes, 'global mesh')).toBe(1);
  expect(
    first.meshes.some((m) => m.label !== 'global mesh' && m.position[1] < 0.2),
  ).toBe(false);
  const robotPosition = () =>
    page.evaluate(() => {
      const robot =
        window.xrDevice.sem.sceneEnvironment.root.getObjectByName('robot');
      return [robot.position.x, robot.position.z];
    });
  const start = await robotPosition();
  await expect
    .poll(async () => {
      const [x, z] = await robotPosition();
      return Math.hypot(x - start[0], z - start[1]);
    })
    .toBeGreaterThan(0.05);

  // Static planes and meshes keep their identity: lastChangedTime is stable.
  const later = await state(page);
  expect(later.planes.map((p) => p.lastChangedTime)).toEqual(
    first.planes.map((p) => p.lastChangedTime),
  );

  await page.screenshot({ path: 'test-results/ar.png' });
  expect(errors).toEqual([]);
});
