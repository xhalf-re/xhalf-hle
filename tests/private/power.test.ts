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

test
  .skipIf(!process.env.XHALF_DAT)
  .each(['idle', 'shooting_keys', 'setup_keys'])(
  'native power policy from independent DAT cold boot: %s',
  async (name) => {
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
      // Native IRQ handling executes every due ISR. Allow Node/Wasm enough
      // wall time for the unchanged 120/140-second virtual power scenarios.
      deadline = wall + 600000;
    mkdirSync('.private/power', { recursive: true });
    const until = (predicate: () => boolean) => {
      while (!predicate()) {
        core.step();
        if (performance.now() > deadline)
          throw new Error(`Native power case ${name} wall deadline exceeded`);
      }
    };
    try {
      until(
        () =>
          core.sdk.menuState()?.id ===
            profile.firmware.ui.roles['shooting.main'] && input.idle,
      );
      if (name === 'setup_keys') {
        input.press(profile.firmware.ui.verification.setup_category_key);
        until(
          () =>
            core.sdk.menuState()?.id ===
              profile.firmware.ui.roles['setup.main'] && input.idle,
        );
      }
      const timeout = core.sdk.field(
          profile.address('power.context'),
          'power',
          'timeout',
        ),
        setting = core.sdk.field(
          core.sdk.word('settings.pointer'),
          'settings',
          'auto_power_off',
        );
      expect(timeout).toBeGreaterThan(0);
      expect(setting).not.toBe(profile.sdk.power.auto_off_disabled);
      const interval = Math.max(1, Math.floor(timeout / 12)),
        start = core.virtualNs,
        duration = BigInt(timeout + interval * 2) * 1000000000n;
      let shutdown = false,
        sequence = 0,
        next = start + BigInt(interval) * 1000000000n;
      const events: { message: number; elapsedSeconds: number }[] = [],
        samples: object[] = [];
      core.bind('sysg.send4', () => {
        const message = cpu.readRegister('r0');
        if (
          message === profile.sdk.power.idle_timeout_message ||
          message === profile.sdk.power.force_off_message
        ) {
          events.push({
            message,
            elapsedSeconds: Number(core.virtualNs - start) / 1e9,
          });
          if (message === profile.sdk.power.force_off_message) {
            shutdown = true;
            cpu.stop();
          }
        }
      });
      let sample = start;
      while (!shutdown && core.virtualNs - start < duration) {
        if (name !== 'idle' && core.virtualNs >= next) {
          const key = sequence++ % 2 ? 'up' : 'down';
          input.press(key);
          input.release(key);
          next += BigInt(interval) * 1000000000n;
        }
        core.step();
        if (core.virtualNs - sample >= BigInt(interval) * 1000000000n) {
          sample = core.virtualNs;
          samples.push({
            elapsedSeconds: Number(sample - start) / 1e9,
            idleTicks: core.sdk.field(
              profile.address('power.context'),
              'power',
              'idle_ticks',
            ),
            inputSent: input.sent,
          });
          writeFileSync(
            `.private/power/${name}.json`,
            JSON.stringify(
              { name, timeout, setting, events, samples },
              null,
              2,
            ),
          );
        }
        if (performance.now() > deadline)
          throw new Error(`Native power case ${name} wall deadline exceeded`);
      }
      expect(core.assertions).toBe(0);
      expect(input.errors).toBe(0);
      expect(shutdown).toBe(name === 'idle');
      if (name !== 'idle')
        expect(core.virtualNs - start >= duration).toBe(true);
      writeFileSync(
        `.private/power/${name}.json`,
        JSON.stringify(
          {
            name,
            passed: true,
            timeout,
            setting,
            events,
            samples,
            elapsedSeconds: Number(core.virtualNs - start) / 1e9,
            wallMs: performance.now() - wall,
          },
          null,
          2,
        ),
      );
    } finally {
      core.destroy();
    }
  },
  620000,
);
