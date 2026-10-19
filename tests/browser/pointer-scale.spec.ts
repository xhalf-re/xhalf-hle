import { test, expect } from '@playwright/test';
test.use({ deviceScaleFactor: 2, viewport: { width: 900, height: 900 } });
test('screen pointer maps letterboxing and high DPI into native logical coordinates', async ({
  page,
}) => {
  test.skip(
    !process.env.XHALF_DAT,
    'Real scaled pointer NOT RUN: set XHALF_DAT.',
  );
  test.setTimeout(180000);
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
  await page.locator('canvas').evaluate((canvas: HTMLCanvasElement) => {
    canvas.style.width = '480px';
    canvas.style.height = '480px';
  });
  await page.waitForTimeout(50);
  const box = (await page.locator('canvas').boundingBox())!;
  // Native y=170 is the second row. A naive square-canvas scale would hit the first row.
  await page.mouse.click(
    box.x + (400 * 480) / 640,
    box.y + 60 + (170 * 360) / 480,
    { delay: 80 },
  );
  await expect
    .poll(async () => (await read()).menu, { timeout: 15000 })
    .toBe(8195);
  expect((await read()).assertions).toBe(0);
});
