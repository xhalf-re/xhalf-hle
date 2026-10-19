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
import { NativeInput } from '../../src/sdk/input';
import { FirstSetup } from '../../src/runtime/first-setup';
import { BulkAcceleration } from '../../src/sdk/acceleration';

test.skipIf(!process.env.XHALF_DAT)(
  '30 virtual minutes of mixed native interaction',
  async () => {
    const bundle = await loadBundle(readFileSync(process.env.XHALF_DAT!)),
      profile = new FirmwareProfile();
    await profile.preflight(bundle);
    const imported = (await import(
      /* @vite-ignore */ pathToFileURL(resolve('public/runtime/unicorn-arm.js'))
        .href
    )) as { default: () => Promise<UnicornModule> };
    const cpu = new UnicornBackend(
        await imported.default(),
        profile.machine.cpu_model,
      ),
      core = new RuntimeCore(cpu, profile, bundle),
      display = new NativeDisplay(core),
      input = new NativeInput(core);
    new SdkServices(core);
    new GuestCalls(core);
    new SdkGraphics(core);
    new BulkAcceleration(core);
    const startup = new FirstSetup(core, input);
    core.nextCall = () => {
      startup.poll();
      return input.nextCall();
    };
    core.afterStep = () => display.poll();
    core.completeCall = (call, status) => {
      if (call.kind === 'input') input.complete(status);
    };
    const wall = performance.now(),
      start = core.virtualNs,
      target = start + 1800n * 1000000000n,
      samples: object[] = [];
    let nextProgress = start,
      nextInput = start + 10n * 1000000000n,
      sequence = 0;
    mkdirSync('.private/reports', { recursive: true });
    try {
      while (core.virtualNs < target) {
        if (core.virtualNs >= nextInput) {
          const key = sequence++ % 2 ? 'up' : 'down';
          input.press(key);
          input.release(key);
          nextInput += 10n * 1000000000n;
        }
        core.step();
        if (core.virtualNs >= nextProgress) {
          writeFileSync(
            '.private/reports/M6-stability-progress.json',
            JSON.stringify(
              {
                virtualSeconds: Number(core.virtualNs - start) / 1e9,
                targetSeconds: 1800,
                wallMs: performance.now() - wall,
                wasmBytes: cpu.memoryBytes,
                assertions: core.assertions,
                inputErrors: input.errors,
                storageErrors: core.storage.errors,
                scanFrames: core.panel.vsyncs,
                scanAcknowledgements: core.panel.scanAcknowledgements,
              },
              null,
              2,
            ),
          );
          nextProgress += 10n * 1000000000n;
        }
        if (
          samples.length === 0 ||
          core.virtualNs >= start + BigInt(samples.length) * 300n * 1000000000n
        )
          samples.push({
            virtualSeconds: Number(core.virtualNs - start) / 1e9,
            wasmBytes: cpu.memoryBytes,
            inputPending: input.pending.length,
            touchBusy: input.touch.busy,
            threads: core.diagnostics().threads,
          });
      }
      const memory = samples.map((sample) =>
        Number((sample as { wasmBytes: number }).wasmBytes),
      );
      const steadyMemory = memory.slice(1);
      expect(core.assertions).toBe(0);
      expect(input.errors).toBe(0);
      expect(input.pending.length).toBe(0);
      expect(input.touch.busy).toBe(false);
      expect(Math.max(...steadyMemory) - Math.min(...steadyMemory)).toBe(0);
      writeFileSync(
        '.private/reports/M6-stability.json',
        JSON.stringify(
          {
            passed: true,
            virtualSeconds: Number(core.virtualNs - start) / 1e9,
            wallMs: performance.now() - wall,
            samples,
            wasmMin: Math.min(...memory),
            wasmMax: Math.max(...memory),
            wasmGrowth: Math.max(...memory) - Math.min(...memory),
            steadyWasmGrowth:
              Math.max(...steadyMemory) - Math.min(...steadyMemory),
            assertions: core.assertions,
            inputErrors: input.errors,
          },
          null,
          2,
        ),
      );
    } finally {
      core.destroy();
    }
  },
  // The current peripheral model takes longer than real time in the Node Wasm backend.
  3600000,
);
