import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
test('real DAT cold boots native ThreadX and UI without ASSERT', async ({
  page,
}) => {
  test.skip(
    !process.env.XHALF_DAT,
    'Real firmware boot NOT RUN: set XHALF_DAT locally.',
  );
  test.setTimeout(240000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('./');
  await page.locator('#manual-setup').check();
  await page
    .getByLabel('Choose firmware', { exact: true })
    .setInputFiles(process.env.XHALF_DAT!);
  mkdirSync('.private/reports', { recursive: true });
  const deadline = Date.now() + 180000;
  while (true) {
    const status = await page.getByRole('status').textContent();
    const diagnostics = await page.locator('#diagnostics').textContent();
    writeFileSync(
      '.private/reports/M3-browser.json',
      JSON.stringify(
        {
          status,
          diagnostics,
          errors,
        },
        null,
        2,
      ),
    );
    if (status?.includes('RUNTIME_ERROR')) throw new Error(status);
    let state: Record<string, unknown> = {};
    try {
      state = JSON.parse(diagnostics!);
    } catch {}
    if (
      state.uiCreated &&
      state.uiRan &&
      state.hostRan &&
      Number(state.menu) > 0
    )
      break;
    if (Date.now() > deadline)
      throw new Error('Native UI boot timeout; see private report');
    await page.waitForTimeout(250);
  }
  expect(errors).toEqual([]);
  const metrics = JSON.parse(
    (await page.locator('#diagnostics').textContent())!,
  );
  expect(metrics.assertions).toBe(0);
  expect(metrics.storageReadBytes).toBeGreaterThan(0);
  expect(metrics.hostRan).toBe(true);
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Resume', exact: true }),
  ).toBeEnabled();
  await page.getByRole('button', { name: 'Resume', exact: true }).click();
  await page.getByRole('button', { name: 'Stop and release session' }).click();
  await expect(page.getByRole('status')).toContainText('Stopped');
});
