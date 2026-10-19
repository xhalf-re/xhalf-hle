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
  'native controller reaches the SDK gesture processor in its own task',
  async () => {
    const bundle = await loadBundle(readFileSync(process.env.XHALF_DAT!)),
      profile = new FirmwareProfile();
    await profile.preflight(bundle);
    const imported = (await import(
      /* @vite-ignore */ pathToFileURL(resolve('public/runtime/unicorn-arm.js'))
        .href
    )) as { default: () => Promise<UnicornModule> };
    const core = new RuntimeCore(
        new UnicornBackend(await imported.default(), profile.machine.cpu_model),
        profile,
        bundle,
      ),
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
    const trace: object[] = [];
    const snapshot = () => ({
      ms: Number(core.virtualNs / 1000000n),
      menu: core.sdk.menuState(),
      controller: [...core.cpu.read(0x40e137f4, 6)],
      policy: [...core.cpu.read(0x413d319c, 6)],
      sdk: [...core.cpu.read(0x413e174c + 0x34, 6)],
      scrawl: [...core.cpu.read(0x413e174c + 0xb38, 0x14)],
      draw: [...core.cpu.read(0x413e3d20, 8)],
      gesture: [...core.cpu.read(0x413e4bc4, 0x2c)],
      queue: input.touch.samples.length,
      events: input.touch.events,
    });
    core.cpu.hook(
      'block',
      () => {
        trace.push({
          name: 'enable',
          lr: core.cpu.readRegister('lr'),
          args: core.sdk.arguments(),
          ...snapshot(),
        });
      },
      0x40502a0c,
      0x40502a0c,
    );
    let recording = false;
    for (const [name, address] of Object.entries({
      read: 0x405e8a8c,
      sample: 0x405b5380,
      controllerRead: 0x405b5314,
      analyze: 0x405b3dcc,
      gate: 0x405b4f88,
      gesture: 0x405f9f64,
      release: 0x405f9d58,
      scrawl: 0x405b41cc,
      app: 0x404a9138,
    }))
      core.cpu.hook(
        'block',
        () => {
          if (recording && trace.length < 500)
            trace.push({ name, args: core.sdk.arguments(5), ...snapshot() });
        },
        address,
        address,
      );
    const until = (condition: () => boolean, limit = 120000) => {
      const end = performance.now() + limit;
      while (!condition()) {
        core.step();
        if (performance.now() > end) throw Error('Native controller deadline');
      }
    };
    mkdirSync('.private/input-refactor', { recursive: true });
    try {
      until(() => core.sdk.menuState()?.id === 8193 && input.idle);
      trace.push({ name: 'boot', ...snapshot() });
      recording = true;
      const time = Number(core.virtualNs / 1000000n);
      input.touch.pointer('down', 400, 211, time);
      input.touch.pointer('up', 400, 211, time + 80);
      const end = core.virtualNs + 1000000000n;
      until(() => core.virtualNs >= end && input.idle, 30000);
      trace.push({ name: 'final', ...snapshot() });
      expect(core.sdk.menuState()?.id).toBe(8195);
      const events = trace.filter(
        (row) => (row as { name: string }).name === 'scrawl',
      ) as { args: number[] }[];
      expect(events.map((row) => row.args[0])).toEqual(
        expect.arrayContaining([0x800, 0x900, 0xa00]),
      );
      expect(core.assertions).toBe(0);
    } finally {
      writeFileSync(
        '.private/input-refactor/native.json',
        JSON.stringify(trace, null, 2),
      );
      core.destroy();
    }
  },
  180000,
);
