import { expect, test } from 'vitest';
import { BlankImageJobs } from '../../src/sdk/image-jobs';
import type { RuntimeCore } from '../../src/runtime/core';

function fixture() {
  const memory = new Uint8Array(0x8000),
    view = new DataView(memory.buffer),
    queue = 0x3000,
    stack = 0x1000;
  let callback: (() => void) | undefined,
    returns = 0;
  const core = {
    profile: {
      machine: { imaging: { source: 'blank' } },
      sdk: {
        image_jobs: {
          queue_argument: 60,
          commands_offset: 128,
          capacity_offset: 0,
          length_offset: 4,
        },
      },
      inRam: (address: number, size: number) =>
        address >= 0 && size >= 0 && address + size <= memory.length,
    },
    cpu: { readRegister: () => stack },
    sdk: {
      u32: (address: number) => view.getUint32(address, true),
      put32: (address: number, value: number) =>
        view.setUint32(address, value, true),
      ret: () => {
        returns++;
      },
    },
    bind: (name: string, run: () => void) => {
      expect(name).toBe('imaging.build_blank_job');
      callback = run;
    },
  };
  view.setUint32(stack + 56 * 4, queue, true);
  view.setUint32(queue, 4, true);
  view.setUint32(queue + 4, 1, true);
  view.setUint32(queue + 128, 0x12345678, true);
  view.setUint32(queue + 136, 0xabcdef12, true);
  const jobs = new BlankImageJobs(core as unknown as RuntimeCore);
  return {
    run: () => callback!(),
    memory,
    view,
    queue,
    jobs,
    returns: () => returns,
  };
}

test('blank imaging appends an executable CQ job while preserving existing commands and caller-owned memory', () => {
  const { run, view, queue, jobs, returns } = fixture();
  run();
  expect(view.getUint32(queue + 4, true)).toBe(2);
  expect(view.getUint32(queue + 128, true)).toBe(0x12345678);
  expect(view.getUint32(queue + 132, true)).toBe(0x0f000000);
  expect(view.getUint32(queue + 136, true)).toBe(0xabcdef12);
  expect(jobs.jobs).toBe(1);
  expect(returns()).toBe(1);
});

test('invalid/full imaging queues fail before changing guest memory or reporting success', () => {
  for (const [capacity, length] of [
    [0, 0],
    [4, 4],
    [4, 0xffffffff],
    [0x100001, 0],
    [0x2000, 0],
  ]) {
    const { run, memory, view, queue, jobs, returns } = fixture();
    view.setUint32(queue, capacity!, true);
    view.setUint32(queue + 4, length!, true);
    const before = memory.slice();
    expect(run).toThrow('capacity');
    expect(memory).toEqual(before);
    expect(jobs.jobs).toBe(0);
    expect(returns()).toBe(0);
  }
});
