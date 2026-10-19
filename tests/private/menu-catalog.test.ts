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

test.skipIf(!process.env.XHALF_DAT || !process.env.XHALF_CATALOG)(
  'enumerate native menu roots and controls without modifying guest state',
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
    const deadline = performance.now() + 180000,
      roots: object[] = [];
    mkdirSync('.private/menu-catalog', { recursive: true });
    const until = (condition: () => boolean) => {
      while (!condition()) {
        core.step();
        if (performance.now() > deadline)
          throw new Error('Native menu catalog deadline exceeded');
      }
    };
    try {
      until(
        () =>
          core.sdk.menuState()?.id ===
            profile.firmware.ui.roles['shooting.main'] && input.idle,
      );
      for (let category = 0; category < 7; category++) {
        input.press(String(category + 1));
        until(() => core.sdk.menuState()?.category === category && input.idle);
        const current = core.sdk.word('ui.current_menu'),
          menu = core.sdk.structure(current, 'menu'),
          items = [];
        for (let row = 0; row < menu.count!; row++) {
          const item = core.sdk.structure(
            menu.items! + row * profile.layouts.item!.size,
            'item',
          );
          let child: Record<string, number> | null = null;
          if (profile.inRam(menu.children! + row * 4, 4)) {
            const pointer = core.sdk.u32(menu.children! + row * 4);
            if (profile.inRam(pointer, profile.layouts.menu!.size)) {
              const entry = core.sdk.structure(pointer, 'menu');
              if (entry.id! >= 0x1000 && entry.id! < 0x10000) child = entry;
            }
          }
          items.push({ row, ...item, child });
        }
        roots.push({
          category,
          name: profile.firmware.ui.categories[category],
          current,
          menu,
          items,
          callback: core.sdk.word('ui.scrawl_callback'),
        });
        writeFileSync(
          '.private/menu-catalog/roots.json',
          JSON.stringify(roots, null, 2),
        );
      }
      expect(roots).toHaveLength(7);
      expect(core.assertions).toBe(0);
    } finally {
      core.destroy();
    }
  },
  200000,
);
