import { test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { UnicornBackend } from '../../src/cpu/unicorn';
import type { UnicornModule } from '../../src/cpu/unicorn';
import { loadBundle } from '../../src/firmware/package';
import { FirmwareProfile } from '../../src/firmware/profile';
import { RuntimeCore } from '../../src/runtime/core';
import { BulkAcceleration } from '../../src/sdk/acceleration';
import { words, registerName } from '../../src/sdk/adapter';

test.skipIf(!process.env.XHALF_DAT)(
  'bulk memory, raster, icon copy and palette match real ARM firmware loops',
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
      sp = 0x3f00e000,
      end = 0x3f142000;
    const regs = (values: Record<string, number>) =>
      Object.entries(values).forEach(([r, v]) =>
        cpu.writeRegister(registerName(r), v),
      );
    const invoke = (address: number) => {
      cpu.run(address, 500000, end);
      expect(cpu.readRegister('pc')).toBe(end);
    };
    const memory = (name: string, dst: number, src: number, size: number) => {
      cpu.write(
        0x42000000,
        Uint8Array.from({ length: 16384 }, (_, i) => (i * 29 + 11) & 255),
      );
      regs({ cpsr: 0xd3, sp, lr: end, r0: dst, r1: src, r2: size });
      invoke(profile.address(name));
      expect(cpu.readRegister('r0')).toBe(dst);
      return cpu.read(0x42000000, 16384);
    };
    const draw = (
      site: string,
      style: number,
      c: number,
      r: number,
      stride: number,
      mx: number,
      my: number,
    ) => {
      const target = 0x42001000,
        first = site === profile.sdk.raster.sites[0],
        initial = Uint8Array.from(
          { length: stride * (r + 2) * 4 },
          (_, i) => (i * 37 + 19) & 255,
        );
      cpu.write(target, initial);
      cpu.write(
        profile.address('raster.colors'),
        Uint8Array.from([0x12, 0x34, 0x56, 0x78]),
      );
      cpu.write(
        profile.address('raster.border_color'),
        Uint8Array.from([0xab, 0xcd, 0xef, 1]),
      );
      cpu.write(sp, new Uint8Array(256));
      regs({
        cpsr: 0xd3 | (style === 1 ? 0x40000000 : 0),
        sp,
        r4: c,
        r5: r,
        r6: mx,
        r7: my,
        r8: my,
        r11: style,
        r12: 0,
        r10: 0,
      });
      if (first) {
        regs({ r1: target });
        cpu.write(sp + 12, words([stride]));
        cpu.write(sp + 0x44 + 32, words([end]));
      } else {
        cpu.write(0x42000000, words([target, stride]));
        regs({ r0: 0x42000000, r1: style, r3: target });
        cpu.write(sp + 44, words([end]));
      }
      invoke(profile.address(site));
      expect(cpu.readRegister('r0')).toBe(1);
      return cpu.read(target, initial.length);
    };
    const copy = (columns: number, rows: number, ss: number, ts: number) => {
      const source = 0x42000000,
        target = 0x42008000,
        descriptor = 0x42010000;
      cpu.write(
        source,
        Uint8Array.from(
          { length: ss * rows * 4 },
          (_, i) => (i * 17 + 3) & 255,
        ),
      );
      cpu.write(target, new Uint8Array(ts * (rows + 1) * 4).fill(0x5a));
      cpu.write(descriptor, words([source, ss]));
      cpu.write(sp, new Uint8Array(256));
      cpu.write(sp + 4, words([columns * 4]));
      cpu.write(sp + 12, words([ts]));
      cpu.write(sp + 0x44 + 32, words([end]));
      regs({
        cpsr: 0xd3,
        sp,
        r0: source,
        r3: columns,
        r4: descriptor,
        r5: target,
        r6: rows,
        r12: 0,
      });
      invoke(profile.address(profile.sdk.raster.copy));
      return {
        bytes: cpu.read(target, ts * (rows + 1) * 4),
        r0: cpu.readRegister('r0'),
      };
    };
    const palette = () => {
      const source = 0x42000000,
        target = 0x42001000,
        colors = 0x42002000,
        alpha = 0x42003000;
      cpu.write(
        source,
        Uint8Array.from({ length: 512 }, (_, i) => i & 255),
      );
      cpu.write(
        colors,
        words(Array.from({ length: 256 }, (_, i) => (i * 0x01030507) >>> 0)),
      );
      cpu.write(
        alpha,
        Uint8Array.from({ length: 256 }, (_, i) => 255 - i),
      );
      cpu.write(sp, words([colors, alpha]));
      regs({ cpsr: 0xd3, sp, lr: end, r0: 32, r1: 16, r2: source, r3: target });
      invoke(profile.address(profile.sdk.raster.palette));
      return cpu.read(target, 2048);
    };
    const registers = () =>
      Object.fromEntries(
        [...Array.from({ length: 13 }, (_, i) => `r${i}`), 'sp', 'cpsr'].map(
          (r) => [r, cpu.readRegister(registerName(r))],
        ),
      );
    const rgba = (
      width: number,
      rows: number,
      stride: number,
      opacity: number,
      overlap = false,
      cached = false,
    ) => {
      const source = 0x42000003,
        target = overlap ? source : 0x42008001;
      const data = Uint8Array.from(
        { length: width * rows * 4 },
        (_, i) => (i * 17 + 3) & 255,
      );
      for (let i = 3; i < data.length; i += 4) if (i % 20 === 3) data[i] = 0;
      cpu.write(
        0x42008000,
        new Uint8Array(stride * (rows + 1) * 4 + 16).fill(0x5a),
      );
      cpu.write(source, data);
      cpu.write(sp, new Uint8Array(256));
      cpu.write(sp + 4, words([opacity]));
      cpu.write(sp + 12, words([stride]));
      cpu.write(sp + 0x64, words([end]));
      cpu.write(sp + 0x68, words([rows]));
      regs({
        cpsr: 0x800000d3,
        sp,
        r0: source + 3,
        r1: target + 4,
        r2: target,
        r3: 0,
        r4: target,
        r5: width,
        r6: 0,
        r7: width * 4,
        r8: 7,
        r9: 8,
        r10: 9,
        r11: 10,
        r12: source + 3,
      });
      if (cached) {
        const descriptor = 0x42010000;
        cpu.write(descriptor, words([target, stride]));
        cpu.write(sp, new Uint8Array(256));
        cpu.write(sp + 4, words([rows]));
        cpu.write(sp + 12, words([opacity]));
        cpu.write(sp + 0x34, words([end]));
        regs({
          cpsr: 0x800000d3,
          sp,
          r0: source + 3,
          r1: descriptor,
          r2: 0,
          r3: target,
          r4: width,
          r5: source + 3,
          r6: target + 4,
          r7: 0,
          r8: 7,
          r9: 8,
          r10: width * 4,
          r11: 10,
          r12: target,
        });
      }
      invoke(
        profile.address(profile.sdk.pixel_loops.rgba[cached ? 1 : 0]!.site),
      );
      return {
        bytes: cpu.read(target, stride * (rows + 1) * 4),
        regs: registers(),
      };
    };
    const coverage = (
      length: number,
      increment: number,
      maximum: number,
      offset: number,
    ) => {
      const base = 0x42008003,
        site = profile.address(profile.sdk.pixel_loops.coverage_site),
        done = site + 48;
      cpu.write(
        base,
        Uint8Array.from({ length: length + 8 }, (_, i) => (i * 53 + 19) & 255),
      );
      cpu.write(sp, new Uint8Array(256));
      cpu.write(sp + 28, words([maximum & 255]));
      cpu.write(sp + 32, words([increment]));
      regs({
        cpsr: 0x800000d3,
        sp,
        r0: base,
        r1: 0,
        r2: base + offset + 1,
        r3: base + offset,
        r4: 17,
        r5: 18,
        r6: maximum,
        r7: 19,
        r8: length,
        r9: 20,
        r10: 21,
        r11: 22,
        r12: 23,
      });
      cpu.run(site, 500000, done);
      expect(cpu.readRegister('pc')).toBe(done);
      return { bytes: cpu.read(base, length + 8), regs: registers() };
    };
    const transpose = (
      columns: number,
      rows: number,
      sourceStride: number,
      targetStride: number,
      alpha: number,
      pattern: number,
      overlap = false,
    ) => {
      const a = profile.sdk.pixel_loops.masked_transpose,
        target = 0x42020003,
        mask = overlap ? target : 0x42010000,
        colors = 0x42014000,
        config = 0x42018000,
        size = (columns - 1) * targetStride + rows * 4,
        first = target - (columns - 1) * targetStride,
        sourceSize = (rows - 1) * sourceStride + columns;
      cpu.write(first - 8, new Uint8Array(size + 16).fill(0x5a));
      cpu.write(
        mask,
        Uint8Array.from({ length: sourceSize }, (_, i) =>
          pattern === 0 ? 0 : pattern === 1 ? 255 : (i * 19 + pattern) % 7,
        ),
      );
      cpu.write(
        colors,
        Uint8Array.from(
          { length: sourceSize * 4 },
          (_, i) => (i * 17 + 3) & 255,
        ),
      );
      cpu.write(config + a.source_stride, words([sourceStride]));
      cpu.write(sp, words([11, 12, 13, 14, 15, 16, 17, 18, end]));
      regs({
        cpsr: 0x980000d3,
        sp,
        r0: target,
        r1: target,
        r2: 0,
        r3: 0,
        r4: config,
        r5: colors - a.colors_offset,
        r6: rows,
        r7: targetStride,
        r8: alpha,
        r9: 19,
        r10: mask - a.mask_offset,
        r11: 21,
        r12: columns,
      });
      invoke(profile.address(a.site));
      return { bytes: cpu.read(first - 8, size + 16), regs: registers() };
    };
    try {
      const memoryCases: [string, number, number, number][] = [
        ...[
          [0, 0, 4096],
          [1, 3, 129],
          [3, 1, 67],
          [0, 2, 63],
          [0, 0, 0],
        ].map(
          ([d, s, n]) =>
            ['libc.memcpy', 0x42002000 + d!, 0x42000000 + s!, n!] as [
              string,
              number,
              number,
              number,
            ],
        ),
        ...[
          [0, 0, 4096],
          [1, 0x1234, 129],
          [3, 0xfffffffe, 67],
          [0, 7, 63],
        ].map(
          ([d, v, n]) =>
            ['libc.memset', 0x42002000 + d!, v!, n!] as [
              string,
              number,
              number,
              number,
            ],
        ),
      ];
      const shapes: [string, number, number, number, number, number, number][] =
        [];
      for (const site of profile.sdk.raster.sites)
        for (const style of [0, 1, 2, 3])
          for (const [c, r, p, mx, my] of [
            [11, 9, 6, 2, 1],
            [12, 8, 0, 0, 0],
            [7, 5, 2, 4, 3],
            [19, 13, 3, 1, 4],
          ])
            shapes.push([site, style, c!, r!, c! + p!, mx!, my!]);
      const copies: [number, number, number, number][] = [
        [17, 11, 17, 17],
        [7, 19, 12, 17],
        [1, 1, 4, 5],
      ];
      const expectedMemory = memoryCases.map((c) => memory(...c)),
        expectedShapes = shapes.map((c) => draw(...c)),
        expectedCopies = copies.map((c) => copy(...c)),
        expectedPalette = palette();
      const rgbaCases: [number, number, number, number, boolean][] = [];
      for (const width of [1, 2, 9, 31])
        for (const rows of [1, 3])
          for (const opacity of [0, 1, 50, 100, 255, 256])
            rgbaCases.push([width, rows, width + 7, opacity, false]);
      rgbaCases.push([17, 3, 17, 100, true]);
      const coverageCases: [number, number, number, number][] = [];
      for (const length of [1, 2, 9, 31])
        for (const increment of [0, 1, 64, 256])
          for (const maximum of [0, 127, 255, 256, 1023, 65535])
            coverageCases.push([length, increment, maximum, 0]);
      coverageCases.push([19, 5, 255, 3], [11, 65536, 255, 0]);
      const expectedRgba = rgbaCases.map((c) => rgba(...c)),
        expectedCached = rgbaCases.map((c) => rgba(...c, true)),
        expectedCoverage = coverageCases.map((c) => coverage(...c));
      const transposeCases: [
        number,
        number,
        number,
        number,
        number,
        number,
        boolean?,
      ][] = [];
      for (const [columns, rows] of [
        [1, 1],
        [1, 13],
        [19, 1],
        [17, 11],
      ])
        for (const pattern of [0, 1, 2, 6])
          for (const alpha of [0, 1, 255, 511])
            transposeCases.push([
              columns!,
              rows!,
              columns! + 3,
              rows! * 4 + 12,
              alpha,
              pattern,
            ]);
      transposeCases.push([7, 5, 11, 32, 127, 2, true]);
      const expectedTranspose = transposeCases.map((c) => transpose(...c));
      const fast = new BulkAcceleration(core);
      memoryCases.forEach((c, i) =>
        expect(Buffer.compare(memory(...c), expectedMemory[i]!)).toBe(0),
      );
      shapes.forEach((c, i) =>
        expect(Buffer.compare(draw(...c), expectedShapes[i]!)).toBe(0),
      );
      copies.forEach((c, i) => {
        const result = copy(...c);
        expect(Buffer.compare(result.bytes, expectedCopies[i]!.bytes)).toBe(0);
        expect(result.r0).toBe(expectedCopies[i]!.r0);
      });
      expect(Buffer.compare(palette(), expectedPalette)).toBe(0);
      expect(fast.rasterCalls).toBe(shapes.length + copies.length + 1);
      expect(fast.memoryCalls).toBeGreaterThan(0);
      rgbaCases.forEach((c, i) => {
        expect(rgba(...c)).toEqual(expectedRgba[i]);
        expect(rgba(...c, true)).toEqual(expectedCached[i]);
      });
      coverageCases.forEach((c, i) =>
        expect(coverage(...c)).toEqual(expectedCoverage[i]),
      );
      transposeCases.forEach((c, i) =>
        expect(transpose(...c)).toEqual(expectedTranspose[i]),
      );
      expect(fast.pixelCalls).toBeGreaterThan(0);
    } finally {
      core.destroy();
    }
  },
  60000,
);
