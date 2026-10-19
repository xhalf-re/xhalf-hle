import { expect, test } from 'vitest';
import { FirmwareProfile } from '../../src/firmware/profile';
import firmware from '../../src/profiles/xhalf-main.json';
import machine from '../../src/profiles/machine.json';
import sdk from '../../src/profiles/sdk.json';
import { loadBundle } from '../../src/firmware/package';
import { sha256 } from '../../src/firmware/bytes';
import { packageFixture } from './fixtures';

test('validates the public contract without firmware PC timer bindings or startup patches', () => {
  const profile = new FirmwareProfile();
  expect(profile.id).toBe(firmware.id);
  expect(profile.firmware.webSchema).toBe(2);
  expect(profile.machine.mpidr).toBe(0);
  expect(Object.keys(profile.firmware.boot).sort()).toEqual([
    'load_base',
    'sram_copy',
    'zero_from',
    'zero_to',
  ]);
  expect(profile.firmware).not.toHaveProperty('boot_patch_notes');
  for (const name of [
    'runtime.irq_window',
    'runtime.compare_read_site',
    'display.frame_done',
    'display.event_group',
    'irq.handlers',
  ])
    expect(Object.hasOwn(profile.firmware.symbols, name)).toBe(false);
  expect(profile.machine.display).not.toHaveProperty('frame_interval_ns');
  expect(JSON.stringify(firmware)).not.toMatch(
    /"expected"|"pattern"|"mask"|"locator"/,
  );
});
test('rejects candidates, wrong SDK, missing instruction guards and illegal maps', () => {
  expect(
    () => new FirmwareProfile({ ...firmware, status: 'candidate' }),
  ).toThrow();
  expect(() => new FirmwareProfile({ ...firmware, sdk: 'unknown' })).toThrow();
  const missing = structuredClone(firmware);
  delete (missing.symbols['storage.context_register'] as { guard?: unknown })
    .guard;
  expect(() => new FirmwareProfile(missing)).toThrow();
  const map = structuredClone(machine);
  map.memory.dram = [0xffff0000, 0x20000];
  expect(() => new FirmwareProfile(firmware, map)).toThrow();
  const badSdk = structuredClone(sdk);
  badSdk.layouts.menu.fields.index = [999, 'I'];
  expect(() => new FirmwareProfile(firmware, machine, badSdk)).toThrow();
});
test('checks payload identity, required hashes and optional group degradation before execution', async () => {
  const bundle = await loadBundle(packageFixture());
  await expect(new FirmwareProfile().preflight(bundle)).rejects.toMatchObject({
    code: 'UNKNOWN_FIRMWARE',
  });
  const guard = {
    length: 4,
    sha256: await sha256(bundle.payload.subarray(0, 4)),
  };
  const candidate = {
    ...firmware,
    firmware: {
      ...firmware.firmware,
      payload_sha256: bundle.identity.payload,
      package_sha256: bundle.identity.package,
    },
    resources: {
      A: { length: bundle.images.A.length, sha256: bundle.identity.A },
      B: { length: bundle.images.B.length, sha256: bundle.identity.B },
    },
    symbols: {
      required: { address: 0x40000000, kind: 'function', guard },
      optional: {
        address: 0x40000004,
        kind: 'code',
        optional: true,
        group: 'memory',
        guard,
      },
    },
  };
  const syntheticSdk = sdk;
  const profile = new FirmwareProfile(candidate, machine, syntheticSdk);
  await profile.preflight(bundle);
  expect(profile.disabledGroups.has('memory')).toBe(true);
  await expect(
    new FirmwareProfile(
      {
        ...candidate,
        symbols: {
          ...candidate.symbols,
          required: { ...candidate.symbols.required, address: 0x40000004 },
        },
      },
      machine,
      syntheticSdk,
    ).preflight(bundle),
  ).rejects.toMatchObject({ code: 'PROFILE_MISMATCH' });
  await expect(
    new FirmwareProfile(
      {
        ...candidate,
        resources: {
          ...candidate.resources,
          A: { ...candidate.resources.A, sha256: '0'.repeat(64) },
        },
      },
      machine,
      syntheticSdk,
    ).preflight(bundle),
  ).rejects.toMatchObject({ code: 'PROFILE_MISMATCH' });
});

test('RAM ranges preserve contiguous spans, holes, zero-length ends and SRAM isolation', () => {
  const p = new FirmwareProfile();
  expect(p.inRam(0x47fff000, 8192, true)).toBe(true);
  expect(p.inRam(0x80000000, 0, true)).toBe(false);
  expect(p.inRam(0xfffffff0, 64)).toBe(false);
  expect(p.inRam(p.machine.memory.scratch[0]!, 4)).toBe(true);
  expect(p.inRam(p.machine.memory.scratch[0]!, 4, true)).toBe(false);
  const map = structuredClone(machine);
  map.sparse_dram = [[0x50000000, 4096]];
  const isolated = new FirmwareProfile(firmware, map);
  expect(isolated.inRam(0x47fff000, 8192, true)).toBe(false);
  expect(isolated.inRam(0x50000000, 4096, true)).toBe(true);
  expect(isolated.inRam(0x50001000, 0, true)).toBe(false);
});
