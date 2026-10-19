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

test.skipIf(!process.env.XHALF_DAT)(
  'native IRQ vectors boot ThreadX and distributor masking controls panel interrupts independently of device masks',
  async () => {
    const bundle = await loadBundle(readFileSync(process.env.XHALF_DAT!)),
      profile = new FirmwareProfile();
    await profile.preflight(bundle);
    const { default: create } = (await import(
      /* @vite-ignore */ pathToFileURL(resolve('public/runtime/unicorn-arm.js'))
        .href
    )) as { default: () => Promise<UnicornModule> };
    const cpu = new UnicornBackend(await create(), profile.machine.cpu_model),
      core = new RuntimeCore(cpu, profile, bundle);
    new SdkServices(core);
    new SdkGraphics(core);
    new BulkAcceleration(core);
    new GuestCalls(core);
    const input = new NativeInput(core),
      display = new NativeDisplay(core),
      startup = new FirstSetup(core, input);
    core.nextCall = () => {
      startup.poll();
      return input.nextCall();
    };
    core.completeCall = (call, status) => {
      if (call.kind === 'input') input.complete(status);
    };
    core.afterStep = () => display.poll();
    const started = performance.now(),
      until = (condition: () => boolean) => {
        while (!condition()) {
          core.step();
          if (performance.now() - started > 120000)
            throw new Error('IRQ acceptance deadline exceeded');
        }
      };
    const acknowledgements: Record<number, number> = {};
    let vectors = 0,
      badEntry = 0,
      timerAcks = 0,
      panelAcks = 0;
    const vector = profile.firmware.boot.load_base + 0x18,
      d = profile.machine.gic.distributor,
      c = profile.machine.gic.cpu_interface,
      panel = profile.machine.peripherals.panel.irq,
      timer = profile.machine.gic.timer_irqs[0]!,
      word = Math.floor(panel / 32) * 4,
      bit = 1n << BigInt(panel % 32);
    cpu.hook(
      'block',
      () => {
        vectors++;
        if ((cpu.readRegister('cpsr') & 0x1bf) !== 0x192) badEntry++;
      },
      vector,
      vector,
    );
    cpu.hook(
      'read',
      () => {
        const irq = core.sdk.u32(c + 0xc) & 0x3ff;
        acknowledgements[irq] = (acknowledgements[irq] ?? 0) + 1;
        if (core.gic.active.has(timer)) timerAcks++;
        if (core.gic.active.has(panel)) panelAcks++;
      },
      c + 0xc,
      c + 0xc,
    );
    try {
      expect(profile.firmware.symbols).not.toHaveProperty('runtime.irq_window');
      expect(core.hooks.has('runtime.irq_window')).toBe(false);
      until(
        () =>
          core.sdk.menuState()?.id ===
            profile.firmware.ui.roles['shooting.main'] && input.idle,
      );
      until(() => panelAcks > 5);
      const before = {
        panelAcks,
        timerAcks,
        scans: core.panel.vsyncs,
        ns: core.virtualNs,
      };
      const deviceMask = core.panel.read(
        profile.machine.peripherals.panel.base + 4,
        4,
      );
      core.gic.write(d + 0x180 + word, 4, bit);
      until(() => core.virtualNs >= before.ns + 100000000n);
      expect(core.panel.vsyncs).toBeGreaterThan(before.scans);
      expect(panelAcks).toBe(before.panelAcks);
      expect(timerAcks).toBeGreaterThan(before.timerAcks);
      expect(core.gic.pending.has(panel)).toBe(true);
      expect(core.gic.read(d + 0x100 + word, 4) & bit).toBe(0n);
      expect(
        core.panel.read(profile.machine.peripherals.panel.base + 4, 4),
      ).toBe(deviceMask);
      core.gic.write(d + 0x100 + word, 4, bit);
      until(
        () =>
          panelAcks > before.panelAcks && core.panel.scanAcknowledgements > 0,
      );
      input.press('down');
      input.release('down');
      until(() => input.idle && core.sdk.menuState()?.index === 1);
      input.press('up');
      input.release('up');
      until(() => input.idle && core.sdk.menuState()?.index === 0);
      expect(vectors).toBeGreaterThan(0);
      expect(badEntry).toBe(0);
      expect(core.assertions).toBe(0);
      expect(input.errors).toBe(0);
      expect(core.storage.errors).toBe(0);
      mkdirSync('.private/irq-gic', { recursive: true });
      writeFileSync(
        '.private/irq-gic/native-acceptance.json',
        JSON.stringify(
          {
            passed: true,
            wallMs: performance.now() - started,
            vectors,
            badEntry,
            acknowledgements,
            binaryPoint: Number(core.gic.read(c + 8, 4)),
            priorities: Object.fromEntries(
              Object.keys(acknowledgements).map((id) => [
                id,
                Number(core.gic.read(d + 0x400 + Number(id), 1)),
              ]),
            ),
            timerAcks,
            panelAcks,
            before: { ...before, ns: before.ns.toString() },
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
