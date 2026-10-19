import { expect, test } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { UnicornBackend, type UnicornModule } from '../../src/cpu/unicorn';
import { loadBundle } from '../../src/firmware/package';
import { FirmwareProfile } from '../../src/firmware/profile';
import { RuntimeCore } from '../../src/runtime/core';
import { SdkServices } from '../../src/sdk/services';
import { SdkGraphics } from '../../src/sdk/graphics';
import { BulkAcceleration } from '../../src/sdk/acceleration';
import { GuestCalls } from '../../src/sdk/guest';
import { NativeDisplay } from '../../src/sdk/display';
import { NativeInput } from '../../src/sdk/input';
import { FirstSetup } from '../../src/runtime/first-setup';
import firmware from '../../src/profiles/xhalf-main.json';
import bindings from './fixtures/hardware-bindings.json';

test.skipIf(!process.env.XHALF_DAT)(
  'unaltered CP15 instructions boot and native display completes through device IRQs without host callbacks',
  async () => {
    const bundle = await loadBundle(readFileSync(process.env.XHALF_DAT!)),
      profile = new FirmwareProfile({
        ...firmware,
        symbols: { ...firmware.symbols, ...bindings.symbols },
      });
    expect(profile.id).toBe(bindings.profile);
    await profile.preflight(bundle);
    const { default: create } = (await import(
      /* @vite-ignore */ pathToFileURL(resolve('public/runtime/unicorn-arm.js'))
        .href
    )) as { default: () => Promise<UnicornModule> };
    const cpu = new UnicornBackend(await create(), profile.machine.cpu_model),
      installed: { kind: string; begin?: number; end?: number }[] = [],
      hook = cpu.hook.bind(cpu);
    cpu.hook = (kind, callback, begin, end) => {
      installed.push({ kind, begin, end });
      return hook(kind, callback, begin, end);
    };
    const core = new RuntimeCore(cpu, profile, bundle);
    new SdkServices(core);
    new SdkGraphics(core);
    new BulkAcceleration(core);
    new GuestCalls(core);
    const input = new NativeInput(core),
      display = new NativeDisplay(core),
      startup = new FirstSetup(core, input),
      started = performance.now();
    core.nextCall = () => {
      startup.poll();
      return input.nextCall();
    };
    core.completeCall = (call, status) => {
      if (call.kind === 'input') input.complete(status);
    };
    core.afterStep = () => display.poll();
    const mpidrSites = [
      0x40000ec0, 0x40000f3c, 0x40001494, 0x40001518, 0x40002bb4, 0x40003270,
      0x4000328c, 0x40004f60,
    ];
    const oldTimerHooks = [
      0x40004720, 0x4000c908, 0x4000ca2c, 0x4000ca88, 0x4000cb2c, 0x4000cb70,
      0x4000cbc4, 0x4000cc58, 0x4000cca8, 0x4000cd1c, 0x4000cd68, 0x40e3800c,
      0x40e3802c, 0x4000c9a0, 0x4000cbf8, 0x4000c9ac, 0x4000cbe0, 0x4000cbe4,
    ];
    let panelIrqs = 0,
      nativeCompletions = 0,
      invalidCompletionContext = 0;
    try {
      for (const address of mpidrSites)
        expect(Array.from(cpu.read(address, 4))).toEqual(
          Array.from(
            bundle.payload.subarray(
              address - profile.firmware.boot.load_base,
              address - profile.firmware.boot.load_base + 4,
            ),
          ),
        );
      expect(
        installed.filter(
          ({ kind, begin, end }) =>
            (kind === 'code' || kind === 'block') &&
            [...mpidrSites, ...oldTimerHooks].some(
              (site) =>
                begin !== undefined &&
                end !== undefined &&
                site >= begin &&
                site <= end,
            ),
        ),
      ).toEqual([]);
      hook(
        'read',
        () => {
          if (core.gic.active.has(profile.machine.peripherals.panel.irq))
            panelIrqs++;
        },
        profile.machine.gic.cpu_interface + 0xc,
        profile.machine.gic.cpu_interface + 0xc,
      );
      const completed = profile.address('display.frame_done');
      hook(
        'code',
        () => {
          nativeCompletions++;
          if (
            !core.sdk.word('tx.current_thread') ||
            core.sdk.word('tx.system_state')
          )
            invalidCompletionContext++;
        },
        completed,
        completed,
      );
      const until = (predicate: () => boolean) => {
        while (!predicate()) {
          core.step();
          if (performance.now() - started > 120000)
            throw new Error('Hardware completion acceptance deadline exceeded');
        }
      };
      until(
        () =>
          core.sdk.menuState()?.id ===
            profile.firmware.ui.roles['shooting.main'] && input.idle,
      );
      for (const key of ['down', 'up', 'down', 'up']) {
        input.press(key);
        input.release(key);
        until(() => input.idle);
      }
      expect(core.sdk.menuState()?.index).toBe(0);
      expect(core.systemTimerAssertions).toBeGreaterThan(0);
      expect(panelIrqs).toBeGreaterThan(0);
      expect(core.panel.vsyncs).toBeGreaterThan(0);
      expect(core.panel.scanAcknowledgements).toBeGreaterThan(0);
      expect(nativeCompletions).toBeGreaterThan(0);
      expect(invalidCompletionContext).toBe(0);
      expect(core.assertions).toBe(0);
      expect(input.errors).toBe(0);
      expect(core.storage.errors).toBe(0);
      mkdirSync('.private/lowering', { recursive: true });
      writeFileSync(
        '.private/lowering/hardware-acceptance.json',
        JSON.stringify(
          {
            passed: true,
            wallMs: performance.now() - started,
            unmodifiedMpidrSites: mpidrSites.length,
            retiredTimerHooks: oldTimerHooks.length,
            panelIrqs,
            nativeCompletions,
            invalidCompletionContext,
            scanFrames: core.panel.vsyncs,
            scanAcknowledgements: core.panel.scanAcknowledgements,
            metrics: core.diagnostics(),
          },
          null,
          2,
        ),
      );
    } finally {
      core.destroy();
    }
  },
  150000,
);
