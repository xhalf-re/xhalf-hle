import { expect, type Page } from '@playwright/test';
export type Metrics = Record<string, number | boolean | string>;
export async function metrics(page: Page): Promise<Metrics> {
  try {
    return JSON.parse((await page.locator('#diagnostics').textContent())!);
  } catch {
    return {};
  }
}
export function screenInput(page: Page) {
  const settle = async () => {
    await expect
      .poll(async () => (await metrics(page)).inputIdle, { timeout: 15000 })
      .toBe(true);
  };
  const point = async (x: number, y: number) => {
    const box = (await page.locator('canvas').boundingBox())!;
    const scale = Math.min(box.width / 640, box.height / 480);
    return {
      x: box.x + (box.width - 640 * scale) / 2 + x * scale,
      y: box.y + (box.height - 480 * scale) / 2 + y * scale,
    };
  };
  const tap = async (x: number, y: number) => {
    const p = await point(x, y);
    await page.mouse.click(p.x, p.y, { delay: 80 });
    await settle();
  };
  const drag = async (start: number, end: number) => {
    const a = await point(400, start),
      b = await point(400, end);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.waitForTimeout(100);
    await page.mouse.move(b.x, b.y, { steps: 8 });
    await page.waitForTimeout(400);
    await page.mouse.up();
    await settle();
  };
  const row = async (
    index: number,
    scroll: 'mainScroll' | 'subScroll' | 'optionScroll',
  ) => {
    for (let attempt = 0; attempt < 30; attempt++) {
      const y = 110 + index * 101 - Number((await metrics(page))[scroll]);
      if (y >= 80 && y <= 440) {
        await tap(400, y);
        return;
      }
      await drag(y > 440 ? 380 : 100, y > 440 ? 100 : 380);
    }
    throw Error('Screen drag did not expose test row');
  };
  const key = async (code: string) => {
    await page.locator('canvas').focus();
    await page.keyboard.press(code);
    await settle();
  };
  return { tap, drag, row, key, settle, point };
}
