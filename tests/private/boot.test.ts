import { test, expect } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { UnicornBackend } from '../../src/cpu/unicorn';
import type { UnicornModule } from '../../src/cpu/unicorn';
import { loadBundle } from '../../src/firmware/package';
import { FirmwareProfile } from '../../src/firmware/profile';
import { RuntimeCore } from '../../src/runtime/core';
import { SdkServices } from '../../src/sdk/services';
import { NativeDisplay } from '../../src/sdk/display';
import { SdkGraphics } from '../../src/sdk/graphics';
import { GuestCalls } from '../../src/sdk/guest';
test.skipIf(!process.env.XHALF_DAT)(
  'real firmware boots with the identical Wasm core in Node for engine diagnosis',
  async () => {
    const bundle = await loadBundle(readFileSync(process.env.XHALF_DAT!)),
      profile = new FirmwareProfile();
    await profile.preflight(bundle);
    const url = pathToFileURL(resolve('public/runtime/unicorn-arm.js')).href;
    const imported = (await import(/* @vite-ignore */ url)) as {
      default: () => Promise<UnicornModule>;
    };
    const cpu = new UnicornBackend(
        await imported.default(),
        profile.machine.cpu_model,
      ),
      core = new RuntimeCore(cpu, profile, bundle),
      display = new NativeDisplay(core);
    new SdkServices(core);
    new GuestCalls(core);
    new SdkGraphics(core);
    core.afterStep = () => display.poll();
    const started = performance.now();
    let last = 0,
      ready = false;
    mkdirSync('.private/reports', { recursive: true });
    try {
      while (performance.now() - started < 120000) {
        core.step();
        if (performance.now() - last > 200) {
          last = performance.now();
          const metrics = core.diagnostics();
          writeFileSync(
            '.private/reports/M3-node.json',
            JSON.stringify(metrics, null, 2),
          );
          if (
            metrics.uiCreated &&
            metrics.hostRan &&
            Number(metrics.menu) > 0
          ) {
            ready = true;
            break;
          }
        }
      }
      expect(ready).toBe(true);
    } catch (error) {
      writeFileSync(
        '.private/reports/M3-node-error.json',
        JSON.stringify(
          {
            error: String(error),
            stack: error instanceof Error ? error.stack : '',
            pc: cpu.readRegister('pc'),
            cpsr: cpu.readRegister('cpsr'),
            registers: Object.fromEntries(
              (
                [
                  'r0',
                  'r1',
                  'r2',
                  'r3',
                  'r4',
                  'r5',
                  'r6',
                  'r7',
                  'r8',
                  'sp',
                  'lr',
                ] as const
              ).map((r) => [r, cpu.readRegister(r)]),
            ),
          },
          null,
          2,
        ),
      );
      throw error;
    } finally {
      try {
        core.destroy();
      } catch {}
    }
  },
  150000,
);
