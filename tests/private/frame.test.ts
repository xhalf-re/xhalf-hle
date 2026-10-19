import { test, expect } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { UnicornBackend } from '../../src/cpu/unicorn';
import type { UnicornModule } from '../../src/cpu/unicorn';
import { loadBundle } from '../../src/firmware/package';
import { FirmwareProfile } from '../../src/firmware/profile';
import { RuntimeCore } from '../../src/runtime/core';
import { SdkServices } from '../../src/sdk/services';
import { SdkGraphics } from '../../src/sdk/graphics';
import { GuestCalls } from '../../src/sdk/guest';
import { NativeInput } from '../../src/sdk/input';
import { FirstSetup } from '../../src/runtime/first-setup';
import { pointerHelpers } from './pointer-helpers';
import { BulkAcceleration } from '../../src/sdk/acceleration';
import { NativeDisplay, convertFrame } from '../../src/sdk/display';

test.skipIf(!process.env.XHALF_DAT || !process.env.XHALF_BASELINE)(
  'stable main-menu pixels match independent desktop cold-boot reference at the nearest TB boundary',
  async () => {
    const root = process.env.XHALF_BASELINE!,
      report = JSON.parse(
        readFileSync(resolve(root, 'artifacts/hle/verification.json'), 'utf8'),
      ) as {
        profile: string;
        verification_cases: {
          name: string;
          state: Record<string, number>;
          time_ns: number;
          frame_sha256: string;
        }[];
      };
    const reference = report.verification_cases.find(
      (c) => c.name === '01-menu',
    )!;
    expect(report.profile).toBe('xhalf-main-21aa469f');
    const png = readFileSync(resolve(root, 'artifacts/hle/01-menu.png'));
    expect(createHash('sha256').update(png).digest('hex')).toBe(
      reference.frame_sha256,
    );
    const chunks: Buffer[] = [];
    for (let at = 8; at < png.length;) {
      const size = png.readUInt32BE(at),
        kind = png.toString('ascii', at + 4, at + 8);
      if (kind === 'IDAT') chunks.push(png.subarray(at + 8, at + 8 + size));
      at += 12 + size;
    }
    const width = png.readUInt32BE(16),
      height = png.readUInt32BE(20),
      inflated = inflateSync(Buffer.concat(chunks)),
      expected = Buffer.alloc(width * height * 3);
    for (let y = 0; y < height; y++) {
      expect(inflated[y * (width * 3 + 1)]).toBe(0);
      inflated.copy(
        expected,
        y * width * 3,
        y * (width * 3 + 1) + 1,
        (y + 1) * (width * 3 + 1),
      );
    }
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
    const deadline = performance.now() + 120000;
    const until = (predicate: () => boolean) => {
      while (!predicate()) {
        core.step();
        if (performance.now() > deadline)
          throw new Error('Native frame/language regression deadline exceeded');
      }
    };
    try {
      until(
        () => core.sdk.menuState()?.id === reference.state.id && input.idle,
      );
      // Native keyboard focus is separate from the menu index. Match the desktop's row focus.
      input.press('down');
      input.release('down');
      until(() => core.sdk.menuState()?.index === 1 && input.idle);
      input.press('up');
      input.release('up');
      until(() => core.sdk.menuState()?.index === 0 && input.idle);
      while (core.virtualNs < BigInt(reference.time_ns)) {
        core.step(BigInt(reference.time_ns));
        if (performance.now() > deadline)
          throw new Error('Frame reference cold boot deadline exceeded');
      }
      // The board clock now advances by TB, so request the reference deadline
      // and allow only one maximum-size Thumb TB (512 instructions, 2 units each).
      const timestampError = core.virtualNs - BigInt(reference.time_ns);
      expect(timestampError >= 0n && timestampError < 2048n).toBe(true);
      const state = core.sdk.menuState();
      for (const key of ['id', 'index', 'category', 'mode'])
        expect(state?.[key]).toBe(reference.state[key]);
      expect(input.idle).toBe(true);
      const description = display.description();
      expect(description).not.toBeNull();
      const d = description!,
        frame = convertFrame(
          cpu.read(
            d.address,
            d.width * d.height * (d.format === 'rgb565' ? 2 : 4),
          ),
          d.width,
          d.height,
          d.format,
          profile.machine.display.rotation_quarters,
        ),
        rgba = new Uint8Array(frame.pixels),
        rgb = Buffer.alloc(width * height * 3);
      for (let i = 0; i < width * height; i++)
        rgb.set(rgba.subarray(i * 4, i * 4 + 3), i * 3);
      mkdirSync('.private/reports', { recursive: true });
      writeFileSync('.private/reports/M4-frame.rgb', rgb);
      writeFileSync(
        '.private/reports/M4-frame-diff.json',
        JSON.stringify(
          {
            virtualNs: Number(core.virtualNs),
            referenceTimeNs: reference.time_ns,
            timestampErrorNs: Number(timestampError),
            width,
            height,
            expectedSha256: createHash('sha256').update(expected).digest('hex'),
            actualSha256: createHash('sha256').update(rgb).digest('hex'),
          },
          null,
          2,
        ),
      );
      expect([frame.width, frame.height]).toEqual([width, height]);
      expect(Buffer.compare(rgb, expected)).toBe(0);
      const roles = profile.firmware.ui.roles;
      const send = (keys: string[], condition: () => boolean) => {
        for (const key of keys) {
          input.press(key);
          input.release(key);
        }
        until(() => input.idle && condition());
      };
      send(['6'], () => core.sdk.menuState()?.id === roles['setup.main']);
      const pointer = pointerHelpers(core, input, until);
      pointer.row(0);
      until(
        () => core.sdk.menuState()?.id === roles['setup.basic'] && input.idle,
      );
      pointer.row(4);
      until(
        () =>
          core.sdk.menuState()?.id === roles['setup.language'] && input.idle,
      );
      const originalIndex = core.sdk.menuState()!.index!,
        language = () =>
          core.sdk.field(
            core.sdk.word('settings.pointer'),
            'settings',
            'language',
          ),
        originalLanguage = language(),
        count = core.sdk.word('ui.option_visible_count'),
        nextIndex = (originalIndex + 1) % count;
      send(
        ['down', 'up'],
        () => core.sdk.menuState()?.id === roles['setup.language'],
      );
      expect(core.sdk.menuState()?.index).toBe(originalIndex);
      expect(language()).toBe(originalLanguage);
      pointer.row(nextIndex);
      until(() => core.sdk.menuState()?.index === nextIndex && input.idle);
      expect(language()).toBe(
        cpu.read(
          profile.address('ui.language_table') +
            nextIndex * profile.sdk.input.language_stride +
            profile.sdk.input.language_id_offset,
          1,
        )[0],
      );
      pointer.row(originalIndex);
      until(() => core.sdk.menuState()?.index === originalIndex && input.idle);
      expect(language()).toBe(originalLanguage);
      send(
        ['ui-back'],
        () => core.sdk.menuState()?.id === roles['setup.basic'],
      );
      pointer.row(4);
      until(
        () =>
          core.sdk.menuState()?.id === roles['setup.language'] && input.idle,
      );
      expect(core.sdk.menuState()?.index).toBe(originalIndex);
      expect(core.assertions).toBe(0);
    } finally {
      core.destroy();
    }
  },
  150000,
);
