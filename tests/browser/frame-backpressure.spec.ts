import { test, expect } from '@playwright/test';
test('slow frame acknowledgements preserve native display completion and responsive input', async ({
  page,
}) => {
  test.skip(
    !process.env.XHALF_DAT,
    'Real frame pipeline NOT RUN: set XHALF_DAT.',
  );
  test.setTimeout(180000);
  await page.addInitScript(() => {
    const original = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (
      this: Worker,
      message: unknown,
      transfer: Transferable[] | StructuredSerializeOptions = [],
    ) {
      if ((message as { type?: string }).type === 'frameAck')
        setTimeout(
          () => Reflect.apply(original, this, [message, transfer]),
          1500,
        );
      else Reflect.apply(original, this, [message, transfer]);
    } as typeof original;
  });
  await page.goto('./');
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
    .poll(async () => (await read()).menuReady, { timeout: 120000 })
    .toBe(true);
  await page.locator('canvas').focus();
  const initial = await read();
  for (let i = 0; i < 10; i++) {
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowUp');
  }
  await expect
    .poll(
      async () => {
        const state = await read();
        return (
          state.inputIdle === true &&
          Number(state.inputSent) > Number(initial.inputSent) &&
          state.index === initial.index
        );
      },
      { timeout: 30000 },
    )
    .toBe(true);
  await expect
    .poll(async () => (await read()).frameSettled, { timeout: 15000 })
    .toBe(true);
  const final = await read();
  expect(final.frameDrops).toBeGreaterThan(0);
  expect(final.nativeFrameCompletions).toBeGreaterThan(0);
  expect(final.assertions).toBe(0);
  expect(final.inputErrors).toBe(0);
});
