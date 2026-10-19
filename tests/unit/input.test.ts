import { expect, test, vi } from 'vitest';
import { NativeInput, NativeTouch } from '../../src/sdk/input';
import { FirmwareProfile } from '../../src/firmware/profile';
import type { RuntimeCore } from '../../src/runtime/core';

function fixture() {
  const profile = new FirmwareProfile(),
    hooks = new Map<string, () => void>();
  const memory = new Map<number, Uint8Array>();
  let driverReady = true,
    queueBusy = false;
  let systemState = 0,
    entry = profile.address('sdk.touch.thread_entry');
  const ret = vi.fn();
  const sdk = {
    uiQueue: () => 0x41801000,
    queueState: () => ({
      available: 20,
      enqueued: Number(queueBusy),
      suspended: Number(!queueBusy),
      message_words: 4,
    }),
    menuState: () => {
      throw new Error('Input must not inspect a menu');
    },
    word: (name: string) =>
      name === 'tx.system_state'
        ? systemState
        : name === 'tx.current_thread'
          ? 0x41802000
          : 0,
    u32: () => profile.sdk.threadx.thread_id,
    field: (_at: number, layout: string) =>
      layout === 'touch_driver' ? Number(driverReady) : entry,
    arguments: () => [
      0x41803000, 0x41803004, 0x41803008, 0x4180300c, 0x41803010,
    ],
    ret,
  };
  const core = {
    profile,
    sdk,
    virtualNs: 0n,
    bind: (name: string, hook: () => void) => hooks.set(name, hook),
    cpu: { write: (at: number, bytes: Uint8Array) => memory.set(at, bytes) },
  } as unknown as RuntimeCore;
  const run = (name: string) => hooks.get(name)!();
  return {
    core,
    memory,
    ret,
    run,
    setQueueBusy: (busy: boolean) => {
      queueBusy = busy;
    },
    setDriverReady: (ready: boolean) => {
      driverReady = ready;
    },
    setContext: (state: number, task: number) => {
      systemState = state;
      entry = task;
    },
  };
}

test('fixed physical keys and releases never depend on the active menu', () => {
  const { core } = fixture(),
    input = new NativeInput(core);
  input.press('return');
  input.press('return');
  input.release('return');
  input.release('return');
  expect(input.nextCall()?.arguments).toEqual([0x70]);
  expect(input.nextCall()?.arguments).toEqual([7]);
  expect(input.nextCall()?.arguments).toEqual([39]);
  expect(input.nextCall()).toBeNull();
  for (const key of ['up', 'down', 'left', 'right', 'escape']) {
    core.virtualNs += BigInt(core.profile.sdk.input.activity_interval_ns);
    input.press(key);
    input.release(key);
    expect(input.nextCall()?.arguments).toEqual([0x70]);
    const message = (
      core.profile.sdk.input.key_map as Record<string, number[]>
    )[key]!;
    expect(input.nextCall()?.arguments).toEqual([message[0]! & 255]);
    expect(input.nextCall()?.arguments[0]).toBe((message[0]! & 255) + 32);
  }
});

test('controller samples preserve down/up, coalesce moves and honor host timing', () => {
  const f = fixture(),
    touch = new NativeTouch(f.core);
  touch.pointer('down', 100, 110, 200);
  for (let i = 1; i <= 1000; i++)
    touch.pointer('move', 100 + (i % 200), 210, 200 + i);
  touch.pointer('up', 100, 210, 1300);
  expect(touch.samples.map((s) => s.action)).toEqual(['down', 'move', 'up']);
  expect(touch.nextCall()?.function).toBe(
    f.core.profile.address('sdk.touch.interrupt'),
  );
  f.run('sdk.touch.dispatch_site');
  f.run('sdk.touch.read');
  f.run('sdk.touch.wait_site');
  expect(f.memory.get(0x41803004)![0]).toBe(1);
  expect(
    new DataView(f.memory.get(0x41803004)!.buffer).getUint16(2, true),
  ).toBe(110);
  expect(
    new DataView(f.memory.get(0x41803004)!.buffer).getUint16(4, true),
  ).toBe(540);
  f.core.virtualNs = 500000000n;
  expect(touch.nextCall()).not.toBeNull();
  f.run('sdk.touch.dispatch_site');
  f.run('sdk.touch.read');
  f.run('sdk.touch.wait_site');
  expect(touch.samples[0]?.action).toBe('move');
  f.core.virtualNs = 1000000000n;
  expect(touch.nextCall()).not.toBeNull();
  f.run('sdk.touch.dispatch_site');
  f.run('sdk.touch.read');
  f.run('sdk.touch.wait_site');
  f.core.virtualNs = 1100000000n;
  touch.nextCall();
  f.run('sdk.touch.dispatch_site');
  f.run('sdk.touch.read');
  f.run('sdk.touch.wait_site');
  expect(f.memory.get(0x41803004)![0]).toBe(0);
  expect(touch.busy).toBe(false);
});

test('cancel before sampling drops the gesture; cancel after sampling requests native controller reset', () => {
  const f = fixture(),
    touch = new NativeTouch(f.core);
  touch.pointer('down', 200, 110, 0);
  touch.cancelPointer();
  expect(touch.busy).toBe(false);
  touch.pointer('down', 200, 110, 0);
  touch.nextCall();
  f.run('sdk.touch.dispatch_site');
  f.run('sdk.touch.read');
  f.run('sdk.touch.wait_site');
  touch.pointer('up', 200, 110, 80);
  touch.cancelPointer();
  expect(touch.samples.map((s) => s.action)).toEqual(['cancel']);
  touch.nextCall();
  f.run('sdk.touch.dispatch_site');
  f.run('sdk.touch.device_read');
  f.run('sdk.touch.wait_site');
  expect(f.ret).toHaveBeenLastCalledWith(2);
  expect(touch.busy).toBe(false);
  touch.pointer('down', 250, 211, 100);
  f.core.virtualNs += 10000000n;
  touch.nextCall();
  f.run('sdk.touch.dispatch_site');
  f.run('sdk.touch.read');
  expect(f.memory.get(0x41803004)![0]).toBe(1);
});

test('sampling rejects ISR and foreign thread contexts and invalid controller coordinates', () => {
  const f = fixture(),
    touch = new NativeTouch(f.core);
  f.setContext(1, f.core.profile.address('sdk.touch.thread_entry'));
  expect(() => f.run('sdk.touch.read')).toThrow(/real SDK/);
  f.setContext(0, 0x40000000);
  expect(() => f.run('sdk.touch.read')).toThrow(/real SDK/);
  expect(() => touch.pointer('down', 640, 0, 0)).toThrow(/Invalid/);
  expect(() => touch.pointer('down', 0, 0, NaN)).toThrow(/Invalid/);
});

test('disabled controller ignores queued samples without blocking keyboard input', () => {
  const f = fixture(),
    input = new NativeInput(f.core);
  f.setDriverReady(false);
  input.touch.pointer('down', 100, 110, 0);
  input.touch.pointer('up', 100, 110, 80);
  input.press('up');
  input.release('up');
  expect(input.nextCall()?.function).toBe(
    f.core.profile.address('sdk.key.send'),
  );
  expect(input.touch.ignored).toBe(2);
  expect(input.touch.busy).toBe(false);
  expect(input.nextCall()?.arguments).toEqual([3]);
  expect(input.nextCall()?.arguments).toEqual([35]);
  expect(input.idle).toBe(true);
});

test('physical edges wait for native acknowledgement without changing their meaning', () => {
  const f = fixture(),
    input = new NativeInput(f.core);
  input.press('down');
  input.release('down');
  expect(input.nextCall()?.arguments).toEqual([0x70]);
  f.setQueueBusy(true);
  expect(input.nextCall()).toBeNull();
  expect(input.pending).toHaveLength(2);
  f.setQueueBusy(false);
  expect(input.nextCall()?.arguments).toEqual([4]);
  f.setQueueBusy(true);
  expect(input.nextCall()).toBeNull();
  f.setQueueBusy(false);
  const release = input.nextCall();
  expect(release?.arguments).toEqual([36]);
  expect(release?.returns).toBe('void');
});

test('a release at a new position retains the last contact scan before lift', () => {
  const f = fixture(),
    touch = new NativeTouch(f.core);
  touch.pointer('down', 100, 110, 0);
  touch.pointer('up', 200, 210, 80);
  expect(touch.samples.map(({ action, x, y }) => [action, x, y])).toEqual([
    ['down', 100, 110],
    ['move', 200, 210],
    ['up', 200, 210],
  ]);
});

test('activity coalescing retains every physical edge in a rapid burst', () => {
  const f = fixture(),
    input = new NativeInput(f.core);
  for (let i = 0; i < 10; i++) {
    input.press('down');
    input.release('down');
    input.press('up');
    input.release('up');
  }
  const codes: number[] = [];
  while (input.pending.length) codes.push(input.nextCall()!.arguments[0]!);
  expect(codes).toEqual([
    0x70,
    ...Array.from({ length: 10 }, () => [4, 36, 3, 35]).flat(),
  ]);
  f.core.virtualNs += BigInt(f.core.profile.sdk.input.activity_interval_ns);
  input.press('down');
  expect(input.nextCall()?.arguments).toEqual([0x70]);
  expect(input.nextCall()?.arguments).toEqual([4]);
});
