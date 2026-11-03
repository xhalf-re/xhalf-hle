import type { Page } from '@playwright/test';

export type Metrics = Record<string, number | boolean | string>;

export async function metrics(page: Page): Promise<Metrics> {
  try {
    const fast = await page.evaluate(
      () => (window as unknown as { __xhalfMetrics?: Metrics }).__xhalfMetrics,
    );
    if (fast) return fast;
    return JSON.parse(
      (await page.locator('#diagnostics').textContent())!,
    ) as Metrics;
  } catch (error) {
    return { diagnosticError: String(error) };
  }
}

/** Shared visible-frame endpoint for acceptance and diagnostic profiling. */
export async function navigate(
  page: Page,
  code: string,
  expected: number,
): Promise<number> {
  return page.evaluate(
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
}
