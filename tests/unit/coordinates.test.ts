import { expect, test } from 'vitest';
import { canvasPoint, sdkPoint } from '../../src/sdk/coordinates';
test('maps contained canvas content, rejecting letterbox and preserving CSS-pixel scaling', () => {
  expect(
    canvasPoint(
      { x: 500, y: 350 },
      { left: 100, top: 50, width: 800, height: 600 },
      { width: 640, height: 480 },
    ),
  ).toEqual({ point: { x: 320, y: 240 }, inside: true });
  expect(
    canvasPoint(
      { x: 500, y: 150 },
      { left: 100, top: 50, width: 800, height: 800 },
      { width: 640, height: 480 },
    ).inside,
  ).toBe(true);
  expect(
    canvasPoint(
      { x: 500, y: 100 },
      { left: 100, top: 50, width: 800, height: 800 },
      { width: 640, height: 480 },
    ).inside,
  ).toBe(false);
  expect(
    canvasPoint(
      { x: 900, y: 650 },
      { left: 100, top: 50, width: 800, height: 600 },
      { width: 640, height: 480 },
    ),
  ).toEqual({ point: { x: 639, y: 479 }, inside: false });
});
test('SDK display coordinates stay logical, while scan-buffer coordinates invert rotation', () => {
  const display = { width: 640, height: 480 },
    scan = { width: 480, height: 640 };
  expect(
    sdkPoint({ x: 400, y: 110 }, display, scan, -1, 'display', display),
  ).toEqual({ x: 400, y: 110 });
  expect(
    sdkPoint({ x: 400, y: 110 }, display, scan, -1, 'scan-buffer', scan),
  ).toEqual({ x: 110, y: 239 });
  expect(
    sdkPoint({ x: 0, y: 0 }, display, scan, -1, 'scan-buffer', scan),
  ).toEqual({ x: 0, y: 639 });
});
