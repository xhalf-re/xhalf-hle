import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';

test('M6 repeated load/stop releases browser sessions', async ({ browser }) => {
  test.skip(!process.env.XHALF_DAT, 'M6 lifecycle NOT RUN: set XHALF_DAT.');
  test.setTimeout(300000);
  mkdirSync('.private/reports', { recursive: true });
  const cycles: { cycle: number; loadedMs: number; stoppedMs: number }[] = [];
  const context = await browser.newContext();
  try {
    for (let cycle = 0; cycle < 10; cycle++) {
      const page = await context.newPage(),
        started = Date.now();
      await page.goto('./');
      await page
        .getByLabel('Choose firmware', { exact: true })
        .setInputFiles(process.env.XHALF_DAT!);
      await expect
        .poll(
          async () =>
            (await page.locator('#diagnostics').textContent())?.includes(
              'profile',
            ),
          {
            timeout: 30000,
          },
        )
        .toBe(true);
      const loadedMs = Date.now() - started;
      await page
        .getByRole('button', { name: 'Stop and release session' })
        .click();
      await expect(page.getByRole('status')).toContainText('Stopped', {
        timeout: 10000,
      });
      cycles.push({ cycle, loadedMs, stoppedMs: Date.now() - started });
      await page.close();
    }
  } finally {
    await context.close();
  }
  writeFileSync(
    '.private/reports/M6-lifecycle.json',
    JSON.stringify({ cycles }, null, 2),
  );
  expect(cycles).toHaveLength(10);
});
