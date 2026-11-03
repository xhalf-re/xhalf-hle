import { runtimePath, TestBackend, type TestModule } from './cpu-backend';
import { test, expect } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { loadBundle } from '../../src/firmware/package';
import { FirmwareProfile } from '../../src/firmware/profile';
import { RuntimeCore } from '../../src/runtime/core';
import { SdkServices } from '../../src/sdk/services';
import { NativeDisplay } from '../../src/sdk/display';
import { SdkGraphics } from '../../src/sdk/graphics';
import { NativeInput } from '../../src/sdk/input';
import { FirstSetup } from '../../src/runtime/first-setup';
import { BulkAcceleration } from '../../src/sdk/acceleration';
import firmware from '../../src/profiles/xhalf-main.json';
import bindings from './fixtures/input-bindings.json';

test.skipIf(!process.env.XHALF_DAT)(
  'I2C/GPIO input boots, navigates and executes unmodified ARM drivers in native IRQ/task contexts',
  async () => {
    const bundle = await loadBundle(readFileSync(process.env.XHALF_DAT!)),
      profile = new FirmwareProfile({
        ...firmware,
        symbols: { ...firmware.symbols, ...bindings.symbols },
      });
    expect(profile.id).toBe(bindings.profile);
    await profile.preflight(bundle);
    const imported = (await import(
        /* @vite-ignore */ pathToFileURL(resolve(runtimePath)).href
      )) as { default: () => Promise<TestModule> },
      cpu = new TestBackend(
        await imported.default(),
        profile.machine.cpu_model,
      ),
      installed: { kind: string; begin?: number; end?: number }[] = [],
      hook = cpu.hook.bind(cpu);
    cpu.hook = (kind, callback, begin, end) => {
      installed.push({ kind, begin, end });
      return hook(kind, callback, begin, end);
    };
    const core = new RuntimeCore(cpu, profile, bundle),
      display = new NativeDisplay(core),
      input = new NativeInput(core);
    new SdkServices(core);
    new SdkGraphics(core);
    new BulkAcceleration(core);
    const startup = new FirstSetup(core, input);
    core.beforeStep = () => {
      startup.poll();
      input.poll();
    };
    core.afterStep = () => display.poll();
    const retired = Object.entries(bindings.symbols).filter(
      ([name]) => !name.startsWith('input.'),
    );
    let isrs = 0,
      reads = 0,
      invalidIsr = 0,
      invalidTask = 0,
      inputIrqs = 0;
    const gestureEvents = new Set<number>();
    const originalWrite = cpu.write.bind(cpu),
      stateAddress = profile.address('tx.system_state');
    cpu.write = (address, bytes) => {
      if (address < stateAddress + 4 && address + bytes.length > stateAddress)
        throw new Error('Host must not write ThreadX system_state');
      originalWrite(address, bytes);
    };
    mkdirSync('.private/input-lowering', { recursive: true });
    let lastProgress = 0;
    const until = (condition: () => boolean, limit = 120000) => {
      const end = performance.now() + limit;
      while (!condition()) {
        core.step();
        if (performance.now() - lastProgress >= 1000) {
          lastProgress = performance.now();
          writeFileSync(
            '.private/input-lowering/progress.json',
            JSON.stringify({
              menu: core.sdk.menuState(),
              virtualMs: Number(core.virtualNs / 1000000n),
              pending: input.pending.length,
              busy: input.touch.busy,
              settled: input.touch.settled,
              idle: input.idle,
              gestures: input.sent,
              isrs,
              reads,
              invalidIsr,
              invalidTask,
            }),
          );
        }
        if (performance.now() > end) throw Error('Native input deadline');
      }
    };
    const advance = (ms: number) => {
      const end = core.virtualNs + BigInt(ms) * 1000000n;
      until(() => core.virtualNs >= end && input.idle, 30000);
    };
    const tap = (x: number, y: number) => {
      const time = Number(core.virtualNs / 1000000n);
      input.touch.pointer('down', x, y, time);
      input.touch.pointer('up', x, y, time + 80);
      advance(500);
    };
    try {
      for (const [name, binding] of retired) {
        expect(
          installed.some(
            ({ kind, begin, end }) =>
              (kind === 'block' || kind === 'code') &&
              begin !== undefined &&
              end !== undefined &&
              binding.address >= begin &&
              binding.address <= end,
          ),
          name,
        ).toBe(false);
        const offset = binding.address - profile.firmware.boot.load_base;
        expect(
          Array.from(cpu.read(binding.address, binding.guard.length)),
          name,
        ).toEqual(
          Array.from(
            bundle.payload.subarray(offset, offset + binding.guard.length),
          ),
        );
      }
      hook(
        'block',
        () => {
          isrs++;
          if (
            !core.gic.active.has(99) ||
            core.sdk.word('tx.system_state') === 0
          )
            invalidIsr++;
        },
        profile.address('sdk.touch.interrupt'),
        profile.address('sdk.touch.interrupt'),
      );
      hook(
        'block',
        () => {
          reads++;
          const thread = core.sdk.word('tx.current_thread');
          if (
            core.sdk.word('tx.system_state') !== 0 ||
            !profile.inRam(thread, profile.layouts.thread!.size) ||
            core.sdk.field(thread, 'thread', 'entry') !==
              profile.address('sdk.touch.thread_entry')
          )
            invalidTask++;
        },
        profile.address('sdk.touch.read'),
        profile.address('sdk.touch.read'),
      );
      hook(
        'block',
        () => {
          gestureEvents.add(cpu.readRegister('r0'));
        },
        profile.address('input.scrawl'),
        profile.address('input.scrawl'),
      );
      hook(
        'read',
        () => {
          if (core.gic.active.has(99)) inputIrqs++;
        },
        profile.machine.gic.cpu_interface + 12,
        profile.machine.gic.cpu_interface + 12,
      );
      until(() => core.sdk.menuState()?.id === 8193 && input.idle);
      tap(400, 211);
      expect(core.sdk.menuState()?.id).toBe(8195);
      input.press('ui-back');
      input.release('ui-back');
      advance(500);
      expect(core.sdk.menuState()?.id).toBe(8193);
      tap(50, 333);
      expect(core.sdk.menuState()?.category).toBe(1);
      tap(50, 140);
      expect(core.sdk.menuState()?.category).toBe(0);
      // An unconsumed browser press must disappear without injecting an ISR.
      const before = input.touch.scans;
      input.touch.pointer('down', 400, 211, Number(core.virtualNs / 1000000n));
      input.touch.cancelPointer();
      advance(200);
      expect(core.sdk.menuState()?.id).toBe(8193);
      expect(input.touch.scans - before).toBeLessThanOrEqual(1);
      expect(input.touch.busy).toBe(false);
      expect(isrs).toBeGreaterThan(0);
      expect(inputIrqs).toBeGreaterThan(0);
      expect(reads).toBeGreaterThan(0);
      expect(invalidIsr).toBe(0);
      expect(invalidTask).toBe(0);
      expect([...gestureEvents]).toEqual(
        expect.arrayContaining([0x800, 0x900, 0xa00]),
      );
      expect(core.assertions).toBe(0);
      expect(cpu.executionStats.undefinedInstructions).toBe(0);
      mkdirSync('.private/input-lowering', { recursive: true });
      writeFileSync(
        '.private/input-lowering/acceptance.json',
        JSON.stringify(
          {
            passed: true,
            isrs,
            inputIrqs,
            reads,
            invalidIsr,
            invalidTask,
            i2cTransfers: core.i2c.transfers,
            i2cNacks: core.i2c.nacks,
            touchScans: core.touch.scans,
            touchReports: core.touch.reports,
            hostThreadXWrites: 0,
            inputFunctionHooks: 0,
            menu: core.sdk.menuState()?.id,
          },
          null,
          2,
        ),
      );
    } finally {
      core.destroy();
    }
  },
  180000,
);
