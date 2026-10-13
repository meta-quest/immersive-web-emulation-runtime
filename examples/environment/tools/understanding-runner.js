// Drives tools/understanding.html with Playwright. Shared by
// understanding.mjs and tests/rooms.spec.js.

// SEM's environments as [{ id, kind }].
export async function listEnvironments(browser, base) {
  const page = await browser.newPage();
  try {
    await page.goto(`${base}/tools/understanding.html`);
    await page.waitForFunction(() => window.environments, null, {
      timeout: 60000,
    });
    return await page.evaluate(() => window.environments);
  } finally {
    await page.close();
  }
}

// The room understanding report for one environment, with page errors.
export async function understand(browser, base, id, timeout = 120000) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await page.goto(`${base}/tools/understanding.html?env=${id}`);
    // Ready to start, or a report of a failed load.
    await page.waitForFunction(() => window.ready || window.report, null, {
      timeout,
    });
    if (await page.evaluate(() => window.ready)) {
      await page.getByRole('button', { name: 'Start' }).click();
      await page.waitForFunction(() => window.report, null, { timeout });
    }
    const report = await page.evaluate(() => window.report);
    report.errors.push(...errors);
    return report;
  } finally {
    await page.close();
  }
}
