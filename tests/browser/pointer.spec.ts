import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { screenInput } from './native-helpers';
test('native screen taps enter an option and native sidebar taps change category', async ({
  page,
}) => {
  test.skip(!process.env.XHALF_DAT, 'Real pointer NOT RUN: set XHALF_DAT.');
  test.setTimeout(180000);
  await page.goto('./');
  await page
    .getByLabel('Choose firmware', { exact: true })
    .setInputFiles(process.env.XHALF_DAT!);
  mkdirSync('.private/input-refactor', { recursive: true });
  const read = async () => {
    try {
      const data = JSON.parse(
        (await page.locator('#diagnostics').textContent())!,
      ) as Record<string, number | boolean>;
      writeFileSync(
        '.private/input-refactor/browser.json',
        JSON.stringify(data, null, 2),
      );
      return data;
    } catch {
      return {};
    }
  };
  await expect
    .poll(async () => (await read()).menuReady, { timeout: 120000 })
    .toBe(true);
  const tap = async (x: number, y: number) => {
    const box = (await page.locator('canvas').boundingBox())!;
    await page.mouse.click(
      box.x + (x * box.width) / 640,
      box.y + (y * box.height) / 480,
      { delay: 80 },
    );
  };
  await tap(400, 211);
  await expect
    .poll(async () => (await read()).menu, { timeout: 15000 })
    .toBe(8195);
  await page.getByRole('button', { name: 'Back Esc', exact: true }).click();
  await expect.poll(async () => (await read()).menu).toBe(8193);
  await tap(50, 333);
  await expect
    .poll(async () => (await read()).category, { timeout: 15000 })
    .toBe(1);
  for (let category = 2; category <= 5; category++) {
    await expect.poll(async () => (await read()).inputIdle).toBe(true);
    await tap(50, 333);
    await expect
      .poll(async () => (await read()).category, { timeout: 15000 })
      .toBe(category);
  }
  await tap(400, 110);
  await expect
    .poll(async () => (await read()).menu, { timeout: 15000 })
    .toBe(12304);
  await expect.poll(async () => (await read()).inputIdle).toBe(true);
  const initialScroll = Number((await read()).subScroll),
    box = (await page.locator('canvas').boundingBox())!;
  await page.mouse.move(
    box.x + (400 * box.width) / 640,
    box.y + (380 * box.height) / 480,
  );
  await page.mouse.down();
  await page.waitForTimeout(100);
  await page.mouse.move(
    box.x + (400 * box.width) / 640,
    box.y + (140 * box.height) / 480,
    { steps: 8 },
  );
  await page.waitForTimeout(450);
  await page.mouse.up();
  await expect
    .poll(async () => (await read()).subScroll, { timeout: 15000 })
    .toBeGreaterThan(initialScroll);
  await expect.poll(async () => (await read()).inputIdle).toBe(true);
  await page.mouse.move(
    box.x + (400 * box.width) / 640,
    box.y + (110 * box.height) / 480,
  );
  await page.mouse.down();
  await page.waitForTimeout(100);
  await page.locator('canvas').dispatchEvent('pointercancel', {
    pointerId: 1,
    isPrimary: true,
    pointerType: 'mouse',
  });
  await page.mouse.up();
  await expect
    .poll(
      async () => {
        const state = await read();
        return state.pointerQueued === 0 && state.touchBusy === false;
      },
      { timeout: 15000 },
    )
    .toBe(true);
  expect((await read()).menu).toBe(12304);
  await page.keyboard.press('ArrowDown');
  await expect
    .poll(async () => (await read()).inputIdle, { timeout: 15000 })
    .toBe(true);
  const controls = screenInput(page);
  await controls.key('KeyB');
  await expect.poll(async () => (await read()).menu).toBe(12289);
  await controls.tap(400, 110);
  await expect.poll(async () => (await read()).menu).toBe(12304);
  const held = await controls.point(400, 110);
  await page.mouse.move(held.x, held.y);
  await page.mouse.down();
  await page.waitForTimeout(150);
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await expect(page.locator('#pause')).toHaveText('Resume');
  await page.mouse.up();
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.locator('#pause')).toHaveText('Pause');
  await controls.settle();
  expect((await read()).menu).toBe(12304);
  await controls.row(4, 'subScroll');
  await expect.poll(async () => (await read()).menu).toBe(12312);
  expect((await read()).assertions).toBe(0);
  expect((await read()).inputErrors).toBe(0);
  expect((await read()).touchEvents).toBeGreaterThan(0);
});
