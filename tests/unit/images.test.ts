import { expect, test } from 'vitest';
import { combinePixels, fillPixels } from '../../src/services/images';
import type { Composition } from '../../src/services/images';
test('layer views borrow source pixels without replacing the destination snapshot', () => {
  const memory = Uint8Array.of(255, 1, 11, 21, 255, 2, 12, 22),
    surface = { address: 0, width: 2, height: 1, bpp: 4, format: 14 },
    outputReads: number[] = [],
    layerReads: number[] = [];
  combinePixels(
    {
      surface,
      layers: [
        {
          surface,
          crop: [0, 0, 2, 1],
          target: [0, 0, 2, 1],
          rotate: false,
          mirrorX: true,
          mirrorY: false,
        },
      ],
    },
    (at, n) => {
      outputReads.push(at);
      return memory.slice(at, at + n);
    },
    (at, bytes) => memory.set(bytes, at),
    (at, n) => {
      layerReads.push(at);
      return memory.subarray(at, at + n);
    },
  );
  expect(outputReads).toEqual([0]);
  expect(layerReads).toEqual([0]);
  expect([...memory]).toEqual([255, 2, 12, 22, 255, 1, 11, 21]);
});

test('clipped contiguous ABGR layers retain source origin and native blending', () => {
  const memory = new Uint8Array(64);
  for (let i = 0; i < 6; i++) memory.set([255, 1, 2, 3], i * 4);
  memory.set([0, 8, 9, 10, 255, 11, 12, 13, 128, 21, 22, 23], 32);
  combinePixels(
    {
      surface: { address: 0, width: 3, height: 2, bpp: 4, format: 14 },
      layers: [
        {
          surface: { address: 32, width: 3, height: 2, bpp: 4, format: 14 },
          crop: [0, 0, 3, 1],
          target: [-1, 1, 3, 1],
          rotate: false,
          mirrorX: false,
          mirrorY: false,
        },
      ],
    },
    (at, n) => memory.slice(at, at + n),
    (at, bytes) => memory.set(bytes, at),
  );
  expect([...memory.slice(0, 24)]).toEqual([
    255, 1, 2, 3, 255, 1, 2, 3, 255, 1, 2, 3, 255, 11, 12, 13, 255, 11, 12, 13,
    255, 1, 2, 3,
  ]);
});

test('crop, clockwise rotation, mirrors and nearest scaling compose in native order', () => {
  const memory = new Uint8Array(128);
  for (let i = 0; i < 6; i++) memory.set([255, i + 1, 0, 0], 64 + i * 4);
  combinePixels(
    {
      surface: { address: 0, width: 4, height: 4, bpp: 4, format: 14 },
      layers: [
        {
          surface: { address: 64, width: 3, height: 2, bpp: 4, format: 14 },
          crop: [1, 0, 2, 2],
          target: [0, 0, 4, 4],
          rotate: true,
          mirrorX: true,
          mirrorY: true,
        },
      ],
    },
    (at, n) => memory.slice(at, at + n),
    (at, bytes) => memory.set(bytes, at),
  );
  expect(Array.from({ length: 16 }, (_, i) => memory[i * 4 + 1])).toEqual([
    3, 3, 6, 6, 3, 3, 6, 6, 2, 2, 5, 5, 2, 2, 5, 5,
  ]);
});
test('clips destination edges while keeping the source sampling origin', () => {
  const memory = new Uint8Array(64);
  memory.set([255, 1, 0, 0, 255, 2, 0, 0, 255, 3, 0, 0], 32);
  combinePixels(
    {
      surface: { address: 0, width: 2, height: 1, bpp: 4, format: 14 },
      layers: [
        {
          surface: { address: 32, width: 3, height: 1, bpp: 4, format: 14 },
          crop: [0, 0, 3, 1],
          target: [-1, 0, 3, 1],
          rotate: false,
          mirrorX: false,
          mirrorY: false,
        },
      ],
    },
    (at, n) => memory.slice(at, at + n),
    (at, bytes) => memory.set(bytes, at),
  );
  expect([memory[1], memory[5]]).toEqual([2, 3]);
});

test('composites little-endian ABGR with native straight alpha and preserved transparent pixels', () => {
  const memory = new Uint8Array(64);
  memory.set([255, 10, 20, 30, 255, 40, 50, 60], 0);
  memory.set([0, 99, 99, 99, 128, 100, 110, 120], 32);
  const composition: Composition = {
    surface: { address: 0, width: 2, height: 1, bpp: 4, format: 14 },
    layers: [
      {
        surface: { address: 32, width: 2, height: 1, bpp: 4, format: 14 },
        crop: [0, 0, 2, 1],
        target: [0, 0, 2, 1],
        rotate: false,
        mirrorX: false,
        mirrorY: false,
      },
    ],
  };
  combinePixels(
    composition,
    (at, size) => memory.slice(at, at + size),
    (at, bytes) => memory.set(bytes, at),
  );
  expect(Array.from(memory.slice(0, 8))).toEqual([
    255, 10, 20, 30, 255, 70, 80, 90,
  ]);
});
test('fills clipped valid rectangles and rejects out-of-bounds decoded geometry', () => {
  const memory = new Uint8Array(64).fill(0x5a),
    surface = { address: 0, width: 4, height: 4, bpp: 4, format: 0x101 };
  fillPixels(
    { surface, rect: [1, 1, 2, 2], color: 0x123456ff, planar: false },
    (at, bytes) => memory.set(bytes, at),
  );
  expect(Array.from(memory.slice(20, 28))).toEqual([
    255, 86, 52, 18, 255, 86, 52, 18,
  ]);
  expect(memory[16]).toBe(0x5a);
  expect(memory[48]).toBe(0x5a);
  expect(() =>
    fillPixels(
      { surface, rect: [3, 3, 2, 2], color: 0, planar: false },
      () => {},
    ),
  ).toThrow();
});

test('RGBA row copy preserves transparent pixels and native opacity wrapping', async () => {
  const { copyRgbaRow, addCoverage } =
    await import('../../src/services/images');
  const target = Uint8Array.from([9, 8, 7, 6, 5, 4, 3, 2, 1, 2, 3, 4]);
  copyRgbaRow(
    Uint8Array.from([10, 20, 30, 0, 40, 50, 60, 1, 70, 80, 90, 200]),
    target,
    255,
  );
  expect([...target]).toEqual([9, 8, 7, 6, 2, 60, 50, 40, 254, 90, 80, 70]);
  const faded = Uint8Array.from([9, 8, 7, 6]);
  copyRgbaRow(Uint8Array.from([10, 20, 30, 1]), faded, 50);
  expect([...faded]).toEqual([9, 8, 7, 6]);
  const coverage = Uint8Array.from([0, 1, 120, 199, 200, 255]);
  addCoverage(coverage, 10, 200);
  expect([...coverage]).toEqual([10, 11, 130, 200, 200, 200]);
  const wide = Uint8Array.of(200, 0);
  addCoverage(wide, 100, 1023);
  expect([...wide]).toEqual([44, 100]);
});

test('packed RGB565 clipping and mirroring preserve both bytes', () => {
  const memory = new Uint8Array(64);
  memory.set([1, 11, 2, 12, 3, 13, 4, 14, 5, 15, 6, 16], 32);
  combinePixels(
    {
      surface: { address: 0, width: 4, height: 2, bpp: 2, format: 7 },
      layers: [
        {
          surface: { address: 32, width: 3, height: 2, bpp: 2, format: 7 },
          crop: [1, 0, 2, 2],
          target: [-1, 0, 4, 2],
          rotate: false,
          mirrorX: true,
          mirrorY: false,
        },
      ],
    },
    (at, n) => memory.slice(at, at + n),
    (at, b) => memory.set(b, at),
  );
  expect([...memory.slice(0, 16)]).toEqual([
    3, 13, 2, 12, 2, 12, 0, 0, 6, 16, 5, 15, 5, 15, 0, 0,
  ]);
});

test.each([
  [false, false, false, [1, 2, 3, 4, 5, 6]],
  [false, true, false, [3, 2, 1, 6, 5, 4]],
  [false, false, true, [4, 5, 6, 1, 2, 3]],
  [false, true, true, [6, 5, 4, 3, 2, 1]],
  [true, false, false, [4, 1, 5, 2, 6, 3]],
  [true, true, false, [1, 4, 2, 5, 3, 6]],
  [true, false, true, [6, 3, 5, 2, 4, 1]],
  [true, true, true, [3, 6, 2, 5, 1, 4]],
] as const)(
  'cropped asymmetric pixels rotate=%s mirrorX=%s mirrorY=%s',
  (rotate, mirrorX, mirrorY, expected) => {
    for (const bpp of [2, 4]) {
      for (const offset of [0, 1]) {
        const memory = new Uint8Array(256).fill(0x5a),
          width = rotate ? 2 : 3,
          height = rotate ? 3 : 2,
          pixel = (label: number) =>
            bpp === 4
              ? [255, label, label + 10, label + 20]
              : [label, label + 10];
        // A 3x2 crop inside a padded 5x4 source. Expectations above are
        // hand-written pixel layouts, independent of the sampling arithmetic.
        for (let label = 1; label <= 6; label++)
          memory.set(
            pixel(label),
            128 +
              (Math.floor((label - 1) / 3) * 5 + 6 + ((label - 1) % 3)) * bpp,
          );
        combinePixels(
          {
            surface: { address: 0, width, height, bpp, format: 0 },
            layers: [
              {
                surface: { address: 128, width: 5, height: 4, bpp, format: 0 },
                crop: [1, 1, 3, 2],
                target: [0, 0, width, height],
                rotate,
                mirrorX,
                mirrorY,
              },
            ],
          },
          (at, n) => {
            const bytes = new Uint8Array(n + offset).subarray(offset);
            bytes.set(memory.subarray(at, at + n));
            return bytes;
          },
          (at, bytes) => memory.set(bytes, at),
        );
        expect([...memory.slice(0, 6 * bpp)]).toEqual(expected.flatMap(pixel));
        expect(memory[6 * bpp]).toBe(0x5a);
      }
    }
  },
);

test('layer order uses source snapshots when the source aliases the destination', () => {
  const memory = Uint8Array.of(255, 1, 11, 21, 255, 2, 12, 22),
    surface = { address: 0, width: 2, height: 1, bpp: 4, format: 14 };
  combinePixels(
    {
      surface,
      layers: [
        {
          surface,
          crop: [0, 0, 2, 1],
          target: [0, 0, 2, 1],
          rotate: false,
          mirrorX: true,
          mirrorY: false,
        },
        {
          surface,
          crop: [0, 0, 1, 1],
          target: [0, 0, 1, 1],
          rotate: false,
          mirrorX: false,
          mirrorY: false,
        },
      ],
    },
    (at, n) => memory.slice(at, at + n),
    (at, bytes) => memory.set(bytes, at),
  );
  expect([...memory]).toEqual([255, 1, 11, 21, 255, 1, 11, 21]);
});
