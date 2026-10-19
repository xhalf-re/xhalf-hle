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
import { pointerHelpers } from './pointer-helpers';
import { BulkAcceleration } from '../../src/sdk/acceleration';

test.skipIf(!process.env.XHALF_DAT || !process.env.XHALF_CATALOG)(
  'discover reachable native menus through actual queue and SDK task navigation',
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
    const roots = [8193, 8197, 8205, 8211, 8217, 12289, 32769],
      nodes: {
        category: number;
        path: number[];
        id: number;
        count: number;
        callback: number;
        rows: {
          index: number;
          flags: number;
          child?: number;
          result?: string;
        }[];
      }[] = [],
      edges: object[] = [];
    mkdirSync('.private/menu-catalog', { recursive: true });
    const save = () =>
      writeFileSync(
        '.private/menu-catalog/tree.json',
        JSON.stringify(
          {
            nodes,
            edges,
            diagnostics: core.diagnostics(),
            currentMenu: core.sdk.menuState(),
            currentStructure: core.sdk.structure(
              core.sdk.word('ui.current_menu'),
              'menu',
            ),
            callback: core.sdk.word('ui.scrawl_callback'),
            touch: {
              samples: input.touch.samples.length,
              pending: input.touch.samples.map(({ action, x, y, elapsed }) => ({
                action,
                x,
                y,
                elapsed,
              })),
              busy: input.touch.busy,
              events: input.touch.events,
              due: Number(input.touch.due),
              woken: (input.touch as unknown as { woken: boolean }).woken,
            },
          },
          null,
          2,
        ),
      );
    const state = () => core.sdk.menuState();
    const until = (condition: () => boolean, label: string, ms = 30000) => {
      const deadline = performance.now() + ms;
      while (!condition()) {
        core.step();
        if (performance.now() > deadline) {
          save();
          throw new Error(`Native menu catalog stalled: ${label}`);
        }
      }
    };
    const key = (key: string) => {
      const sent = input.sent;
      input.press(key);
      input.release(key);
      until(() => input.sent > sent && input.idle, `key ${key}`);
    };
    const menu = () =>
      core.sdk.structure(core.sdk.word('ui.current_menu'), 'menu');
    const signature = () =>
      `${state()?.id}:${state()?.count}:${core.sdk.word('ui.scrawl_callback')}`;
    const root = (category: number) => {
      for (let attempt = 0; attempt < 12; attempt++) {
        const s = state();
        if (s?.mode === profile.firmware.ui.view_mode) key('m');
        else if (s && roots.includes(s.id!)) {
          key(String(category + 1));
          if (state()?.category === category && state()?.id === roots[category])
            return;
        } else
          key(attempt === 0 ? 'left' : attempt === 1 ? 'ui-back' : 'escape');
      }
      throw new Error('Native menu did not return to a root');
    };
    const route = (category: number, path: number[]) => {
      root(category);
      for (const index of path) {
        pointerTap(index);
      }
    };
    const pointer = pointerHelpers(core, input, (condition) =>
      until(condition, 'screen gesture'),
    );
    const pointerTap = pointer.row;
    const explore = (
      category: number,
      path: number[],
      ancestors: Set<string>,
    ) => {
      route(category, path);
      const current = state()!,
        structure = menu(),
        callback = core.sdk.word('ui.scrawl_callback'),
        id = current.id!,
        count = current.count!;
      if (count < 0 || count > 255)
        throw new Error('Invalid native menu row count');
      const node = {
        category,
        path: [...path],
        id,
        count,
        callback,
        rows: Array.from({ length: count }, (_, index) => ({
          index,
          flags: core.sdk.field(
            structure.items! + index * profile.layouts.item!.size,
            'item',
            'flags',
          ),
        })) as {
          index: number;
          flags: number;
          child?: number;
          result?: string;
        }[],
      };
      nodes.push(node);
      save();
      if (category === 5 && path.length >= 2) {
        node.rows.forEach(
          (row) =>
            (row.result =
              row.flags & 0x40 ? 'native-disabled' : 'native-setup'),
        );
        save();
        key('ui-back');
        return;
      }
      if (count > 20) {
        // The verified long-list pointer path is exercised independently with
        // a real drag. Keep this catalog bounded while preserving every native
        // row and its disabled state for the acceptance matrix.
        node.rows.forEach(
          (row) =>
            (row.result =
              row.flags & 0x40 ? 'native-disabled' : 'native-long-list'),
        );
        save();
        key('ui-back');
        return;
      }
      if (callback === profile.address('ui.option_scrawl')) {
        node.rows.forEach(
          (row) =>
            (row.result = row.flags & 0x40 ? 'native-disabled' : 'option'),
        );
        save();
        return;
      }
      if (path.length >= 8)
        throw new Error('Native menu depth requires further review');
      for (const row of node.rows) {
        if (row.flags & 0x40) {
          row.result = 'native-disabled';
          save();
          continue;
        }
        route(category, path);
        const before = signature();
        pointerTap(row.index);
        const after = signature(),
          child = state();
        row.child = child?.id;
        row.result =
          child?.mode === profile.firmware.ui.view_mode
            ? 'native-returns-view'
            : after === before
              ? 'native-action'
              : 'submenu';
        edges.push({
          category,
          path: [...path, row.index],
          from: id,
          to: child?.id,
          result: row.result,
        });
        save();
        if (category === 6 && path.length >= 1) {
          key('ui-back');
          continue;
        }
        if (
          child?.mode !== profile.firmware.ui.view_mode &&
          after !== before &&
          !nodes.some(
            (known) => known.category === category && known.id === child?.id,
          ) &&
          !ancestors.has(after)
        ) {
          const next = new Set(ancestors);
          next.add(before);
          explore(category, [...path, row.index], next);
        } else key('left');
      }
    };
    try {
      until(() => state()?.id === roots[0] && input.idle, 'cold boot', 120000);
      if (process.env.XHALF_TREE_LONGLIST) {
        route(5, [0, 1]);
        const before = input.touch.events,
          time = Number(core.virtualNs / 1000000n);
        input.touch.pointer('down', 400, 380, time);
        input.touch.pointer('move', 400, 100, time + 20);
        input.touch.pointer('up', 400, 100, time + 40);
        until(
          () => input.touch.events > before && input.idle,
          'long-list drag',
        );
        save();
        expect(core.sdk.u32(profile.address('ui.sub_scroll'))).toBeGreaterThan(
          0,
        );
        return;
      }
      const categories = process.env.XHALF_TREE_CATEGORY
        ? [Number(process.env.XHALF_TREE_CATEGORY)]
        : [0, 1, 2, 3, 4, 6];
      for (const category of categories) explore(category, [], new Set());
      expect(core.assertions).toBe(0);
      save();
    } finally {
      core.destroy();
    }
  },
  1800000,
);
