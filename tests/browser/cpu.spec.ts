import { expect, test } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';

test('ARM Wasm contracts, ABI, hooks and memory growth', async ({ page }) => {
  await page.goto('http://127.0.0.1:5173/xhalf-hle/tests/harness/cpu.html');
  const result = await page.evaluate(async () => {
    const harness = window as unknown as {
      runContracts(): Promise<{ passed: string[]; benchmark: object }>;
    };
    return harness.runContracts();
  });
  expect(result.passed).toHaveLength(34);
  console.log(JSON.stringify(result));
  mkdirSync('.cache', { recursive: true });
  writeFileSync('.cache/benchmark-wasm.json', JSON.stringify(result, null, 2));
});

test('Worker yields for commands and remains responsive after faults', async ({
  page,
}) => {
  await page.goto('http://127.0.0.1:5173/xhalf-hle/tests/harness/cpu.html');
  const result = await page.evaluate(async () => {
    const worker = (
      window as unknown as { createCpuWorker(): Worker }
    ).createCpuWorker();
    const messages: { type: string; id?: number; value?: number }[] = [];
    worker.onmessage = (e) => messages.push(e.data);
    const wait = async (predicate: () => boolean) => {
      const deadline = performance.now() + 5000;
      while (!predicate()) {
        if (performance.now() > deadline)
          throw new Error('Worker response timeout');
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    };
    await wait(() => messages.some((m) => m.type === 'ready'));
    const start = performance.now();
    worker.postMessage({ type: 'start', id: 1 });
    await wait(() => messages.some((m) => m.id === 1));
    await new Promise((resolve) => setTimeout(resolve, 100));
    worker.postMessage({ type: 'ping', id: 2 });
    await wait(() => messages.some((m) => m.id === 2));
    worker.postMessage({ type: 'stop', id: 3 });
    await wait(() => messages.some((m) => m.id === 3));
    const stopped = messages.find((m) => m.id === 3)!.value;
    await new Promise((resolve) => setTimeout(resolve, 30));
    worker.postMessage({ type: 'ping', id: 4 });
    await wait(() => messages.some((m) => m.id === 4));
    const stable = stopped === messages.find((m) => m.id === 4)!.value;
    worker.postMessage({ type: 'fault', id: 5 });
    await wait(() => messages.some((m) => m.type === 'error'));
    worker.postMessage({ type: 'ping', id: 6 });
    await wait(() => messages.some((m) => m.id === 6));
    worker.postMessage({ type: 'start', id: 7 });
    await wait(() => messages.some((m) => m.id === 7));
    await new Promise((resolve) => setTimeout(resolve, 30));
    worker.postMessage({ type: 'ping', id: 8 });
    await wait(() => messages.some((m) => m.id === 8));
    const resumed = messages.find((m) => m.id === 8)!.value! > stopped!;
    worker.postMessage({ type: 'stop', id: 9 });
    await wait(() => messages.some((m) => m.id === 9));
    worker.terminate();
    return {
      stable,
      resumed,
      elapsed: performance.now() - start,
      executed: stopped! > 0,
    };
  });
  expect(result.stable).toBe(true);
  expect(result.executed).toBe(true);
  expect(result.resumed).toBe(true);
  expect(result.elapsed).toBeLessThan(3000);
});
