import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { screenInput } from './native-helpers';
async function metrics(
  page: Page,
): Promise<Record<string, number | boolean | string>> {
  const text = await page.locator('#diagnostics').textContent();
  try {
    return JSON.parse(text!);
  } catch {
    return {};
  }
}
test('cold boot automatically reaches native main menu and keyboard changes native state', async ({
  page,
}) => {
  test.skip(
    !process.env.XHALF_DAT,
    'Real menu NOT RUN: set XHALF_DAT locally.',
  );
  test.setTimeout(180000);
  await page.goto('./');
  await page
    .getByLabel('Choose firmware', { exact: true })
    .setInputFiles(process.env.XHALF_DAT!);
  mkdirSync('.private/reports', { recursive: true });
  const started = Date.now(),
    deadline = started + 120000;
  while (true) {
    const status = await page.getByRole('status').textContent(),
      state = await metrics(page);
    writeFileSync(
      '.private/reports/M4-current.json',
      JSON.stringify({ status, state }, null, 2),
    );
    if (status?.includes('RUNTIME_ERROR')) throw new Error(status);
    if (state.menuReady === true) break;
    if (Date.now() > deadline) throw new Error('Main menu boot timeout');
    await page.waitForTimeout(100);
  }
  const initial = await metrics(page);
  const coldMs = Date.now() - started;
  expect(initial.assertions).toBe(0);
  expect(initial.inputErrors).toBe(0);
  await page.locator('canvas').focus();
  await page.screenshot({ path: '.private/reports/M4-main.png' });
  await page.keyboard.press('ArrowDown');
  await expect
    .poll(async () => Number((await metrics(page)).index))
    .not.toBe(Number(initial.index));
  await page.keyboard.press('Digit6');
  await expect.poll(async () => (await metrics(page)).menu).toBe(12289);
  const setupIndex = (await metrics(page)).index;
  await screenInput(page).key('ArrowDown');
  expect((await metrics(page)).index).toBe(setupIndex);
  await screenInput(page).tap(400, 110);
  await expect.poll(async () => (await metrics(page)).menu).toBe(12304);
  await screenInput(page).key('KeyB');
  await expect.poll(async () => (await metrics(page)).menu).toBe(12289);
  const result = await metrics(page);
  expect(result.assertions).toBe(0);
  expect(result.inputErrors).toBe(0);
  writeFileSync(
    '.private/reports/M4-basic.json',
    JSON.stringify({ coldMs, initial, result }, null, 2),
  );
});
