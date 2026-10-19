import { test, expect } from '@playwright/test';
test('manual first setup completes through native keyboard skip and menu actions', async ({
  page,
}) => {
  test.skip(
    !process.env.XHALF_DAT,
    'Real manual setup NOT RUN: set XHALF_DAT.',
  );
  test.setTimeout(240000);
  await page.goto('./');
  await page.locator('#manual-setup').check();
  await page
    .getByLabel('Choose firmware', { exact: true })
    .setInputFiles(process.env.XHALF_DAT!);
  const read = async () => {
    try {
      return JSON.parse(
        (await page.locator('#diagnostics').textContent())!,
      ) as Record<string, number | boolean>;
    } catch {
      return {};
    }
  };
  await expect
    .poll(async () => (await read()).uiRan, { timeout: 60000 })
    .toBe(true);
  await page.locator('canvas').focus();
  const deadline = Date.now() + 180000;
  let last = 0,
    action = 0;
  while (true) {
    const state = await read(),
      status = await page.getByRole('status').textContent();
    if (status?.includes('RUNTIME_ERROR')) throw new Error(status);
    if (state.menuReady) break;
    if (Date.now() > deadline)
      throw new Error('Manual setup did not reach native main menu');
    if (
      Number(state.menu) >= 12290 &&
      Number(state.menu) <= 12301 &&
      (!last || last !== state.menu || Date.now() - action > 2500)
    ) {
      await page.keyboard.press('Tab');
      last = Number(state.menu);
      action = Date.now();
    } else if (
      state.mode === 8208 &&
      state.inputIdle &&
      Date.now() - action > 500
    ) {
      await page.keyboard.press('KeyM');
      action = Date.now();
    }
    await page.waitForTimeout(200);
  }
  expect((await read()).assertions).toBe(0);
  expect((await read()).inputErrors).toBe(0);
});
