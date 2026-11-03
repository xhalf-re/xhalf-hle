import { test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { DynarmicBackend } from '../../src/cpu/dynarmic';
import type { DynarmicModule } from '../../src/cpu/dynarmic';
import { loadBundle } from '../../src/firmware/package';
import { FirmwareProfile } from '../../src/firmware/profile';
import { RuntimeCore } from '../../src/runtime/core';
import { BulkAcceleration } from '../../src/sdk/acceleration';

/** Charged-instruction cost of one bound call; fresh engine per case. */
test.skipIf(!process.env.XHALF_DAT)(
  'binding skips ARM body',
  async () => {
    const bundle = await loadBundle(readFileSync(process.env.XHALF_DAT!)),
      profile0 = new FirmwareProfile();
    await profile0.preflight(bundle);
    const imported = (await import(
      /* @vite-ignore */ pathToFileURL(
        resolve('public/runtime/dynarmic-arm.js'),
      ).href
    )) as { default: () => Promise<DynarmicModule> };
    const end = 0x3f142000,
      sp = 0x3f00e000;
    const call = async (name: string, r0: number, r1: number, r2 = 0) => {
      const profile = new FirmwareProfile();
      await profile.preflight(bundle);
      const cpu = new DynarmicBackend(
          await imported.default(),
          profile.machine.cpu_model,
        ),
        core = new RuntimeCore(cpu, profile, bundle);
      new BulkAcceleration(core);
      cpu.write(end, new Uint8Array([0xfe, 0xff, 0xff, 0xea])); // b .
      for (const [r, v] of [
        ['cpsr', 0xd3],
        ['sp', sp],
        ['lr', end],
        ['r0', r0],
        ['r1', r1],
        ['r2', r2],
      ] as const)
        cpu.writeRegister(r, v >>> 0);
      // 64-instruction budget: the real divide loop needs ~100+; a skipped body
      // reaches lr in ~1 and spends the rest spinning at the stop gate.
      const charged = cpu.runSlice(profile.address(name), 64);
      const result = {
        charged,
        atGate: cpu.readRegister('pc') >>> 0 === end,
        r0: cpu.readRegister('r0') >>> 0,
        r1: cpu.readRegister('r1') >>> 0,
        pc: cpu.readRegister('pc') >>> 0,
      };
      core.destroy();
      return result;
    };
    const u = await call('libc.uidivmod', 1000003, 7);
    console.log('uidivmod(1000003,7):', JSON.stringify(u));
    expect(u.atGate).toBe(true);
    expect(u.r0).toBe(142857);
    expect(u.r1).toBe(4);
    const z = await call('libc.uidivmod', 5, 0);
    console.log('uidivmod(5,0):', JSON.stringify(z));
    expect(z.atGate).toBe(true);
    expect(z.r0).toBe(0xffffffff);
    const d = await call('libc.uidiv', 4294967295, 3);
    console.log('uidiv(0xffffffff,3):', JSON.stringify(d));
    expect(d.atGate).toBe(true);
    expect(d.r0).toBe(1431655765);
    expect(profile0.id).toBeTruthy();
  },
  120000,
);
