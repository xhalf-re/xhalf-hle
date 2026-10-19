import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import type { Page } from '@playwright/test';

type Metrics = Record<string, number | boolean | string>;

async function metrics(page: Page): Promise<Metrics> {
  try {
    const fast = await page.evaluate(
      () => (window as unknown as { __xhalfMetrics?: Metrics }).__xhalfMetrics,
    );
    if (fast) return fast;
    return JSON.parse(
      (await page.locator('#diagnostics').textContent())!,
    ) as Metrics;
  } catch {
    return {};
  }
}

async function boot(page: Page, timeout = 120000): Promise<number> {
  await page.goto('./');
  const started = Date.now();
  await page
    .getByLabel('Choose firmware', { exact: true })
    .setInputFiles(process.env.XHALF_DAT!);
  await expect
    .poll(async () => (await metrics(page)).menuReady, { timeout })
    .toBe(true);
  const result = await metrics(page);
  expect(result.assertions).toBe(0);
  expect(result.inputErrors).toBe(0);
  return Date.now() - started;
}

test('M6 cold boot and 100 native navigation samples', async ({ browser }) => {
  test.skip(
    !process.env.XHALF_DAT,
    'M6 private performance NOT RUN: set XHALF_DAT.',
  );
  test.setTimeout(1200000);
  mkdirSync('.private/reports', { recursive: true });
  const coldMs: number[] = [];
  let context = await browser.newContext();
  let page = await context.newPage();
  try {
    const coldRuns = Number(process.env.XHALF_M6_COLD_RUNS ?? 3);
    for (let i = 0; i < coldRuns; i++) {
      if (i > 0) {
        await context.close();
        context = await browser.newContext();
        page = await context.newPage();
      }
      coldMs.push(await boot(page));
    }
    const runtimeBuild = await (
      await page.request.get(new URL('runtime/build.json', page.url()).href)
    ).json();
    await page.locator('canvas').focus();
    const navigationMs: number[] = [];
    const sampleCount = Number(process.env.XHALF_M6_SAMPLES ?? 100);
    for (let i = 0; i < sampleCount; i++) {
      const before = await metrics(page),
        code = i % 2 === 0 ? 'ArrowDown' : 'ArrowUp',
        expected = Number(before.index) + (i % 2 === 0 ? 1 : -1);
      const elapsed = await page.evaluate(
        ({ code, expected }) =>
          new Promise<number>((resolve, reject) => {
            const canvas = document.querySelector<HTMLCanvasElement>('canvas')!,
              firstFrame = Number(canvas.dataset.frame),
              started = performance.now();
            let scheduled = false;
            const observer = new MutationObserver(() => {
              const state = (window as unknown as { __xhalfMetrics?: Metrics })
                  .__xhalfMetrics,
                frame = Number(canvas.dataset.frame);
              if (
                !scheduled &&
                state?.index === expected &&
                state.inputIdle === true &&
                state.frameCurrent === true &&
                frame > firstFrame &&
                frame >= Number(state.frames)
              ) {
                scheduled = true;
                requestAnimationFrame(() => {
                  clearTimeout(timeout);
                  observer.disconnect();
                  resolve(performance.now() - started);
                });
              }
            });
            const timeout = setTimeout(() => {
              observer.disconnect();
              reject(Error('Visible navigation deadline'));
            }, 5000);
            observer.observe(document.querySelector('#diagnostics')!, {
              childList: true,
              characterData: true,
              subtree: true,
            });
            observer.observe(canvas, {
              attributes: true,
              attributeFilter: ['data-frame'],
            });
            canvas.dispatchEvent(
              new KeyboardEvent('keydown', { code, key: code, bubbles: true }),
            );
            canvas.dispatchEvent(
              new KeyboardEvent('keyup', { code, key: code, bubbles: true }),
            );
          }),
        { code, expected },
      );
      navigationMs.push(elapsed);
    }
    const sorted = [...navigationMs].sort((a, b) => a - b),
      p95 = sorted[Math.ceil(sorted.length * 0.95) - 1]!,
      report = {
        measurement:
          'Browser event to animation frame with expected selection, idle native UI queue, and current Canvas pixels',
        coldMs,
        sampleCount,
        navigationMs,
        navigationP95Ms: p95,
        runtimeBuild,
        final: await metrics(page),
      };
    writeFileSync(
      '.private/reports/M6-performance.json',
      JSON.stringify(report, null, 2),
    );
    expect(Math.max(...coldMs)).toBeLessThanOrEqual(120000);
    expect(p95).toBeLessThanOrEqual(300);
    expect(report.final.assertions).toBe(0);
    expect(report.final.inputErrors).toBe(0);
  } finally {
    await context.close();
  }
});
