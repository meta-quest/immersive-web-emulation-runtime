import { expect, test } from '@playwright/test';

import { analyze, checkBudgets } from '../tools/understanding-checks.js';
import { listEnvironments, understand } from '../tools/understanding-runner.js';

// Runs SEM's environments through tools/understanding.html: a WebXR AR
// session with plane detection, mesh detection, hit test, anchors and depth
// sensing, checked as an app would rely on them. One test per environment,
// so one failure does not hide the others.

const base = 'http://localhost:5180';
const rooms = [
  'bedroom',
  'conference_room',
  'home_office',
  'kitchen',
  'music_studio',
  'open_office',
  'open_studio',
  'sunlit_living_room',
];
const scans = [
  'living_room',
  'meeting_room',
  'music_room',
  'office_large',
  'office_small',
];

test('the lists cover every SEM environment', async ({ browser }) => {
  const all = await listEnvironments(browser, base);
  const ids = (kind) =>
    all
      .filter((e) => e.kind === kind)
      .map(({ id }) => id)
      .sort();
  expect(ids('room')).toEqual(rooms);
  expect(ids('legacy-scan')).toEqual(scans);
});

for (const id of rooms) {
  test(`room ${id} passes room understanding within budget`, async ({
    browser,
  }) => {
    const report = await understand(browser, base, id);
    expect.soft(analyze(report), 'room understanding').toEqual([]);
    expect.soft(checkBudgets(report), 'budgets').toEqual([]);
    const planeLabels = (report.planes ?? []).map((p) => p.label);
    const count = (label) => planeLabels.filter((l) => l === label).length;
    expect
      .soft([count('floor'), count('ceiling')], 'floor and ceiling')
      .toEqual([1, 1]);
    expect.soft(count('wall'), 'walls').toBeGreaterThanOrEqual(4);
    expect.soft(count('window'), 'windows').toBeGreaterThanOrEqual(1);
    expect.soft(count('door'), 'doors').toBeGreaterThanOrEqual(1);
  });
}

for (const id of scans) {
  test(`legacy scan ${id} keeps its room understanding`, async ({
    browser,
  }) => {
    // Captured rooms are irregular, so only floor and ceiling facing is checked.
    expect(
      analyze(await understand(browser, base, id), { convex: false }),
    ).toEqual([]);
  });
}
