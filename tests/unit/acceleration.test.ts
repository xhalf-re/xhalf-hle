import { test, expect, vi } from 'vitest';
import { FirmwareProfile } from '../../src/firmware/profile';
import { BulkAcceleration } from '../../src/sdk/acceleration';
import type { RuntimeCore } from '../../src/runtime/core';

test.each(['accel.memory', 'accel.raster', 'accel.pixels'])(
  'a disabled optional group retains native execution: %s',
  (group) => {
    const profile = new FirmwareProfile();
    profile.disabledGroups.set(group, 'Instruction digest mismatch');
    const bind = vi.fn();
    expect(
      () => new BulkAcceleration({ profile, bind } as unknown as RuntimeCore),
    ).not.toThrow();
    const rejected = Object.entries(profile.firmware.symbols)
      .filter(([, s]) => s.group === group)
      .map(([name]) => name);
    expect(rejected.length).toBeGreaterThan(0);
    expect(
      bind.mock.calls.some(([name]) => rejected.includes(name as string)),
    ).toBe(false);
    expect(bind.mock.calls.length).toBeGreaterThan(0);
  },
);
