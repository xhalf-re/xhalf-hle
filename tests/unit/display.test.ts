import { afterEach, expect, test, vi } from 'vitest';
import { convertFrame, NativeDisplay } from '../../src/sdk/display';
import type { DisplayFrame } from '../../src/sdk/display';
import { FirmwareProfile } from '../../src/firmware/profile';
import type { RuntimeCore } from '../../src/runtime/core';

afterEach(() => vi.restoreAllMocks());
test('rotates native ABGR clockwise, preserving each pixel alpha', () => {
  const result = convertFrame(
    Uint8Array.from([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21,
      22, 23, 24,
    ]),
    2,
    3,
    'abgr8888',
    -1,
  );
  expect([result.width, result.height]).toEqual([3, 2]);
  expect(Array.from(new Uint8Array(result.pixels))).toEqual([
    20, 19, 18, 17, 12, 11, 10, 9, 4, 3, 2, 1, 24, 23, 22, 21, 16, 15, 14, 13,
    8, 7, 6, 5,
  ]);
});
test('expands RGB565 endpoints and reuses a correctly sized output buffer', () => {
  const buffer = new ArrayBuffer(12),
    result = convertFrame(
      Uint8Array.from([0, 0xf8, 0xe0, 7, 0x1f, 0]),
      3,
      1,
      'rgb565',
      0,
      buffer,
    );
  expect(result.pixels).toBe(buffer);
  expect(Array.from(new Uint8Array(buffer))).toEqual([
    255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255,
  ]);
});

function device(withCanvas = true) {
  let now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  let submit = () => {};
  const profile = new FirmwareProfile(),
    frames: DisplayFrame[] = [],
    memory = new Map<number, Uint8Array>([
      [0x42000000, Uint8Array.of(255, 0, 0, 100, 255, 0, 0, 101)],
      [0x42000100, Uint8Array.of(255, 0, 0, 200, 255, 0, 0, 201)],
    ]),
    state = { index: 0, ready: true, width: 2, height: 1, format: 0x101 },
    read = vi.fn((address: number) => memory.get(address)!.slice()),
    core = {
      profile,
      virtualNs: 0n,
      sdk: {
        word: () => (state.ready ? 0x42001000 : 0),
        offset: () => profile.layouts.gfx_context!.fields.active_buffer![0],
        field: () => state.index,
        structure: () => ({
          address: state.index === 0 ? 0x42000000 : 0x42000100,
          width: state.width,
          height: state.height,
          format: state.format,
        }),
      },
      cpu: {
        read,
        hook: vi.fn((_kind: string, callback: () => void) => {
          submit = callback;
          return 1;
        }),
      },
    } as unknown as RuntimeCore,
    display = new NativeDisplay(
      core,
      withCanvas ? (f) => frames.push(f) : undefined,
    );
  const advance = (ms: number) => {
    now += ms;
    core.virtualNs += BigInt(Math.round(ms * 1e6));
  };
  return {
    core,
    display,
    frames,
    memory,
    state,
    read,
    advance,
    submit: () => submit(),
  };
}

test('in-place guest writes invalidate current pixels even without graphics hooks', () => {
  const { display, frames, memory, advance } = device();
  display.poll();
  display.acknowledge(1, frames[0]!.pixels);
  expect(display.settled).toBe(true);
  memory.get(0x42000000)![3] = 150;
  expect(display.current).toBe(false);
  expect(display.settled).toBe(false);
  advance(40);
  display.poll();
  expect(frames).toHaveLength(2);
  expect(new Uint8Array(frames[1]!.pixels)[0]).toBe(150);
  expect(display.current).toBe(true);
  expect(display.settled).toBe(false);
  display.acknowledge(2, frames[1]!.pixels);
  expect(display.settled).toBe(true);
  // Unchanged scans stay quiet; alpha-only changes are still real changes.
  advance(40);
  display.poll();
  expect(frames).toHaveLength(2);
  memory.get(0x42000000)![0] = 77;
  advance(40);
  display.poll();
  expect(frames).toHaveLength(3);
  expect(new Uint8Array(frames[2]!.pixels)[3]).toBe(77);
});

test('native double-buffer selection and geometry changes choose the actual scanout', () => {
  const { display, frames, state, memory, advance } = device();
  display.poll();
  state.index = 1;
  expect(display.current).toBe(false);
  advance(40);
  display.poll();
  expect(new Uint8Array(frames[1]!.pixels)[0]).toBe(200);
  display.acknowledge(1, frames[0]!.pixels);
  display.acknowledge(2, frames[1]!.pixels);
  state.width = 1;
  state.height = 2;
  display.poll();
  expect([frames[2]!.width, frames[2]!.height]).toEqual([2, 1]);
  display.acknowledge(3, frames[2]!.pixels);
  state.format = 0x002; // Unsupported formats are not presented as current.
  expect(display.current).toBe(false);
  advance(40);
  display.poll();
  expect(frames).toHaveLength(3);
  state.format = 0x101;
  state.index = 2;
  expect(display.description()).toBeNull();
  advance(40);
  display.poll();
  expect(frames).toHaveLength(3);
  state.index = 0;
  memory.get(0x42000000)![3] = 180;
  advance(40);
  display.poll();
  expect(frames).toHaveLength(4);
  expect(display.current).toBe(true);
});

test('backpressure keeps only two buffers and publishes the newest pixels after an out-of-order ack', () => {
  const { display, frames, memory, advance } = device();
  display.poll();
  advance(40);
  memory.get(0x42000000)![3] = 110;
  display.poll();
  expect(display.inFlight).toBe(2);
  advance(40);
  memory.get(0x42000000)![3] = 120;
  display.poll();
  expect(display.dropped).toBe(1);
  expect(display.current).toBe(false);
  advance(40);
  memory.get(0x42000000)![3] = 130;
  display.poll();
  expect(frames).toHaveLength(2);
  display.acknowledge(2, frames[1]!.pixels);
  display.poll();
  expect(frames).toHaveLength(3);
  expect(frames[2]!.pixels).toBe(frames[1]!.pixels);
  expect(new Uint8Array(frames[2]!.pixels)[0]).toBe(130);
  expect(display.inFlight).toBe(2);
  expect(() => display.acknowledge(3, new ArrayBuffer(1))).toThrow(
    'acknowledgement',
  );
  display.acknowledge(1, frames[0]!.pixels);
  display.acknowledge(3, frames[2]!.pixels);
  expect(display.settled).toBe(true);
  display.acknowledge(1, new ArrayBuffer(8));
  expect(display.inFlight).toBe(0);
});

test('headless presentation does not read guest memory or generate SDK calls', () => {
  const { display, read, advance } = device(false);
  for (let i = 0; i < 5; i++) {
    advance(1000);
    display.poll();
  }
  expect(read).not.toHaveBeenCalled();
});

test('native active-buffer submission publishes promptly between periodic content scans', () => {
  const { core, display, frames, state, submit, advance } = device();
  const address =
    core.profile.address('gfx.context') +
    core.sdk.offset('gfx_context', 'active_buffer');
  expect(core.cpu.hook).toHaveBeenCalledWith(
    'write',
    expect.any(Function),
    address,
    address + 3,
  );
  display.poll();
  state.index = 1;
  advance(1);
  submit();
  display.poll();
  expect(frames).toHaveLength(2);
  expect(new Uint8Array(frames[1]!.pixels)[0]).toBe(200);
  expect(display.submissions).toBe(1);
  expect(display.current).toBe(true);
});
