import { test, expect, vi } from 'vitest';
import privilegedStates from '../arm/privileged-states.json';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DynarmicBackend, type DynarmicModule } from '../../src/cpu/dynarmic';
import programs from '../arm/programs.json';
import { systemRegisterContracts } from '../harness/system-register-contracts';
import { runContracts } from '../harness/cpu-contracts';
import { irqContracts } from '../harness/irq-contracts';
const base = 0x40000000;
async function make(mapped = true) {
  const url = pathToFileURL(resolve('public/runtime/dynarmic-arm.js')).href;
  const imported = (await import(/* @vite-ignore */ url)) as {
    default: () => Promise<DynarmicModule>;
  };
  const cpu = new DynarmicBackend(await imported.default());
  if (mapped) cpu.map(base, 65536);
  return cpu;
}
test('Dynarmic bounded execution and system-mode roundtrip', async () => {
  const cpu = await make();
  try {
    cpu.write(base, Uint8Array.from(programs.loop));
    cpu.run(base, 20);
    expect(cpu.readRegister('r0')).toBe(10);
    cpu.write(base, Uint8Array.from(programs.banked));
    cpu.invalidateCode(base, base + 16);
    cpu.writeRegister('r2', base + 0xf000);
    cpu.writeRegister('r3', base + 0xe000);
    cpu.run(base, 4);
    expect(cpu.readRegisters(['r0', 'r1'])).toEqual([
      base + 0xe000,
      base + 0xf000,
    ]);
    cpu.writeRegister('cpsr', 0x13);
    cpu.writeRegister('sp', base + 0xd000);
    cpu.writeRegister('cpsr', 0x12);
    cpu.writeRegister('sp', base + 0xc000);
    cpu.writeRegister('lr', base + 0x104);
    cpu.writeRegister('spsr', 0x13);
    cpu.write(base, Uint8Array.from(programs.irq));
    cpu.invalidateCode(base, base + 8);
    cpu.run(base, 2);
    expect(cpu.readRegisters(['pc', 'sp'])).toEqual([
      base + 0x100,
      base + 0xd000,
    ]);
    expect(cpu.executionStats.jitInstructions).toBeGreaterThan(0);
    expect(cpu.executionStats.systemInstructions).toBeGreaterThan(0);
  } finally {
    cpu.destroy();
  }
}, 30000);

test('Dynarmic architectural counter and timer contracts', async () => {
  const cpu = await make();
  try {
    expect(systemRegisterContracts(cpu, base)).toHaveLength(4);
  } finally {
    cpu.destroy();
  }
}, 30000);
test('Dynarmic native IRQ contracts', async () => {
  const result = await irqContracts(make);
  expect(result.passed.length).toBeGreaterThan(0);
}, 30000);

test('Dynarmic shared CPU contracts', async () => {
  const result = await runContracts(() => make(false));
  expect(result.passed.length).toBeGreaterThan(25);
}, 120000);

test('Dynarmic RRX consumes carry and preserves result flags', async () => {
  const cpu = await make();
  try {
    cpu.write(base, Uint8Array.from(programs.rrx_flags));
    for (const carry of [0, 1]) {
      cpu.writeRegister('cpsr', 0x13 | (carry << 29));
      cpu.writeRegister('r1', 3);
      cpu.run(base, 2);
      expect(cpu.readRegister('r0')).toBe(carry ? 0x80000001 : 1);
      expect(cpu.readRegister('r2') >>> 28).toBe(carry ? 10 : 2);
    }
  } finally {
    cpu.destroy();
  }
});

test('Dynarmic accesses across separately mapped pages', async () => {
  const cpu = await make();
  try {
    const data = 0x60000000;
    cpu.map(data, 4096);
    cpu.map(data + 4096, 4096);
    cpu.write(data + 4094, Uint8Array.of(1, 2, 3, 4, 0, 0, 0, 0));
    cpu.write(base, Uint8Array.from(programs.memory));
    cpu.writeRegister('r1', data + 4094);
    cpu.run(base, 4);
    expect(cpu.readRegister('r0')).toBe(0x04030202);
    expect(Array.from(cpu.read(data + 4098, 4))).toEqual([2, 2, 3, 4]);
  } finally {
    cpu.destroy();
  }
});

test('Dynarmic privileged execution matches verified architectural states', async () => {
  const dynarmic = await make();
  const names = [
    'r0',
    'r1',
    'r2',
    'r3',
    'r8',
    'r9',
    'r10',
    'r11',
    'r12',
    'sp',
    'lr',
    'pc',
    'cpsr',
    'spsr',
  ] as const;
  try {
    for (const [program, count, thumb, mode] of [
      ['privileged_modes', 9, false, 0x13],
      ['thumb_privileged', 6, true, 0x13],
      ['rfe_ia', 1, false, 0x12],
      ['srs_db', 1, false, 0x12],
      ['ldm_return', 1, false, 0x12],
      ['user_bank_store', 1, false, 0x11],
      ['user_bank_load', 1, false, 0x11],
      ['movs_return', 1, false, 0x12],
      ['banked_saved', 2, false, 0x13],
    ] as const) {
      const cpu = dynarmic;
      {
        cpu.write(base, Uint8Array.from(programs[program]));
        cpu.invalidateCode(base, base + programs[program].length);
        for (const m of [0x10, 0x11, 0x12, 0x13]) {
          cpu.writeRegister('cpsr', m);
          for (let i = 8; i < 13; i++)
            cpu.writeRegister(`r${i}` as (typeof names)[number], (m << 8) + i);
          cpu.writeRegister('sp', base + 0xf000);
          cpu.writeRegister('lr', base + 0x100);
          cpu.writeRegister('spsr', 0x60000013);
        }
        cpu.writeRegister('cpsr', mode);
        cpu.writeRegisters([
          ['r0', base + 0xf000],
          ['r1', 0xa0000013],
          ['r2', 0x93],
          ['r3', 0],
        ]);
        const data = new Uint8Array(64);
        const view = new DataView(data.buffer);
        view.setUint32(0, base + 0x100, true);
        view.setUint32(
          4,
          program === 'ldm_return' ? base + 0x200 : 0x60000013,
          true,
        );
        cpu.write(base + 0xeff0, new Uint8Array(128));
        cpu.write(base + 0xf000, data);
        cpu.run(thumb ? base | 1 : base, count);
        const current = cpu.readRegisters(names);
        cpu.writeRegister('cpsr', 0x13);
        const supervisor = cpu.readRegisters(['sp', 'lr']);
        cpu.writeRegister('cpsr', 0x10);
        const result = {
          current,
          supervisor,
          user: cpu.readRegisters(names.slice(4, 11)),
          memory: Array.from(cpu.read(base + 0xeff0, 64)),
        };
        expect(result, program).toEqual(privilegedStates[program]);
      }
    }
    expect(dynarmic.executionStats.undefinedInstructions).toBe(0);
  } finally {
    dynarmic.destroy();
  }
});

test('Dynarmic enters SVC and undefined vectors in the standalone CPU', async () => {
  const cpu = await make();
  try {
    for (const [program, thumb, vector, mode, size] of [
      ['svc', false, 8, 0x13, 4],
      ['thumb_svc', true, 8, 0x13, 2],
      ['invalid', false, 4, 0x1b, 4],
    ] as const) {
      cpu.writeRegister('cpsr', 0x13);
      cpu.writeRegister('r0', base + 0x8000);
      cpu.writeRegister('r1', 0);
      cpu.write(base, Uint8Array.from(programs.irq_setup));
      cpu.invalidateCode(base, base + programs.irq_setup.length);
      cpu.run(base, 100, base + programs.irq_setup.length);
      cpu.writeRegister('cpsr', 0x10);
      cpu.write(base, Uint8Array.from(programs[program]));
      cpu.invalidateCode(base, base + programs[program].length);
      cpu.run(thumb ? base | 1 : base, 1);
      expect(cpu.readRegister('pc')).toBe(base + 0x8000 + vector);
      expect(cpu.readRegister('cpsr') & 0x9f).toBe(mode | 0x80);
      expect(cpu.readRegister('spsr') & 0x3f).toBe(thumb ? 0x30 : 0x10);
      expect(cpu.readRegister('lr')).toBe(base + size);
    }
  } finally {
    cpu.destroy();
  }
});

test('Dynarmic contexts restore CP15 control while preserving the live IRQ', async () => {
  const cpu = await make();
  const setup = (vector: number, flags: number) => {
    cpu.writeRegister('r0', vector);
    cpu.writeRegister('r1', flags);
    cpu.write(base, Uint8Array.from(programs.irq_setup));
    cpu.invalidateCode(base, base + programs.irq_setup.length);
    cpu.run(base, 100, base + programs.irq_setup.length);
  };
  try {
    cpu.writeRegister('cpsr', 0x13);
    setup(base + 0x8000, 0);
    const context = cpu.saveContext();
    setup(base + 0x9000, 0x40000000);
    cpu.setIrq(true);
    cpu.restoreContext(context);
    cpu.freeContext(context);
    const vector = base + 0x8018;
    cpu.hook('block', () => cpu.stop(), vector, vector);
    cpu.runSlice(base + 0x100, 100);
    expect(cpu.readRegister('pc')).toBe(vector);
    expect(cpu.readRegister('cpsr') & 0x1ff).toBe(0x192);
    expect(cpu.executionStats.irqEntries).toBe(1);
  } finally {
    cpu.destroy();
  }
});

test('standalone memory transfers, partial unmap and permission transitions', async () => {
  const cpu = await make();
  const data = 0x60000000;
  try {
    cpu.map(data, 3 * 4096);
    const expected = Uint8Array.from(
      { length: 3 * 4096 },
      (_, i) => (i * 17) & 255,
    );
    cpu.write(data, expected);
    cpu.unmap(data + 4096, 4096);
    expect(cpu.read(data, 4096)).toEqual(expected.slice(0, 4096));
    expect(cpu.read(data + 8192, 4096)).toEqual(expected.slice(8192));
    expect(() => cpu.unmap(data, 3 * 4096)).toThrow();
    expect(() => cpu.protect(data, 3 * 4096, 0)).toThrow();
    const before = cpu.read(data + 4094, 2);
    expect(() => cpu.write(data + 4094, Uint8Array.of(7, 8, 9, 10))).toThrow();
    expect(cpu.read(data + 4094, 2)).toEqual(before);
    expect(() => cpu.read(data + 4094, 4)).toThrow();
    cpu.map(data + 4096, 4096, 0);
    expect(cpu.read(data + 4096, 4096)).toEqual(new Uint8Array(4096));
    let guestHooks = 0;
    cpu.hook(
      'read',
      () => {
        guestHooks++;
      },
      data,
      data + 12287,
    );
    cpu.hook(
      'write',
      () => {
        guestHooks++;
      },
      data,
      data + 12287,
    );
    cpu.write(data + 4094, Uint8Array.of(1, 2, 3, 4, 0, 0, 0, 0));
    expect(cpu.read(data + 4094, 8)).toEqual(
      Uint8Array.of(1, 2, 3, 4, 0, 0, 0, 0),
    );
    expect(guestHooks).toBe(0);
    cpu.write(base, Uint8Array.from(programs.memory));
    cpu.writeRegister('r1', data + 4094);
    expect(() => cpu.run(base, 1)).toThrow();
    cpu.protect(data, 3 * 4096, 3);
    cpu.run(base, 4);
    expect(cpu.readRegister('r0')).toBe(0x04030202);
    expect(guestHooks).toBeGreaterThan(0);
    cpu.unmap(data, 3 * 4096);
    cpu.map(data, 3 * 4096);
    expect(cpu.read(data, 3 * 4096)).toEqual(new Uint8Array(3 * 4096));

    cpu.write(base, Uint8Array.from(programs.jump));
    cpu.invalidateCode(base, base + programs.jump.length);
    cpu.run(base, 1);
    cpu.protect(base, 4096, 3);
    expect(() => cpu.run(base, 1)).toThrow();
    cpu.protect(base, 4096, 7);
    cpu.run(base, 1);
    expect(cpu.readRegister('r0')).toBe(1);
    cpu.unmap(base, 4096);
    cpu.map(base, 4096);
    cpu.write(base, Uint8Array.from(programs.jump.slice(4)));
    cpu.run(base, 1);
    expect(cpu.readRegister('r0')).toBe(2);

    cpu.map(0xfffff000, 4096);
    cpu.write(0xfffffffc, Uint8Array.of(1, 2, 3, 4));
    expect(cpu.read(0xfffffffc, 4)).toEqual(Uint8Array.of(1, 2, 3, 4));
    expect(() => cpu.read(0xffffffff, 2)).toThrow();
    expect(() => cpu.map(data, 4096, 1.5)).toThrow();
    expect(() => cpu.map(data + 1, 4096)).toThrow();
    expect(cpu.read(0, 0)).toHaveLength(0);
  } finally {
    cpu.destroy();
  }
});

test('standalone page allocations are released after their last page is unmapped', async () => {
  const cpu = await make(false);
  const data = 0x60000000,
    size = 8 * 1024 * 1024;
  try {
    cpu.map(data, size);
    const highWater = cpu.memoryBytes;
    cpu.unmap(data, size);
    for (let i = 0; i < 12; i++) {
      cpu.map(data, size);
      cpu.unmap(data + 4096, size - 8192);
      cpu.unmap(data, 4096);
      cpu.unmap(data + size - 4096, 4096);
    }
    expect(cpu.memoryBytes).toBe(highWater);
    const d0 = Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8);
    cpu.writeRegisterBytes('d0', d0);
    expect(cpu.readRegisterBytes('s1', 4)).toEqual(d0.slice(4));
    expect(cpu.readRegisterBytes('q0', 16).slice(0, 8)).toEqual(d0);
    expect(() => cpu.readRegisterBytes('q16', 16)).toThrow();
    expect(() => cpu.readRegisterBytes('d32', 8)).toThrow();
    expect(() => cpu.readRegisterBytes('s32', 4)).toThrow();
  } finally {
    cpu.destroy();
  }
});

test('JIT cache evicts cold blocks and recompiles them without changing CPU state', async () => {
  const cpu = await make(false);
  const count = 70000;
  cpu.map(base, 0x80000);
  const bytes = new Uint8Array(count * 4);
  for (let i = 0; i < count; i++) bytes.set(programs.loop.slice(0, 4), i * 4);
  cpu.write(base, bytes);
  try {
    cpu.run(base, count);
    expect(cpu.readRegister('r0')).toBe(count);
    expect(cpu.executionStats.jitPeakLiveBlocks).toBeLessThanOrEqual(
      cpu.executionStats.jitCacheCapacity,
    );
    expect(cpu.executionStats.jitReleasedBlocks).toBeGreaterThan(0);
    expect(cpu.executionStats.jitPackedModules).toBeGreaterThan(0);
    expect(cpu.executionStats.jitLiveModules).toBeLessThan(
      cpu.executionStats.jitLiveBlocks,
    );
    const compiled = cpu.executionStats.jitCompiledBlocks;
    cpu.run(base, 1);
    expect(cpu.readRegister('r0')).toBe(count + 1);
    expect(cpu.executionStats.jitCompiledBlocks).toBeGreaterThan(compiled);
  } finally {
    cpu.destroy();
  }
}, 30000);

test('temporary JIT code allocation failure yields and resumes at the same instruction', async () => {
  const imported = await import(
    /* @vite-ignore */ pathToFileURL(resolve('public/runtime/dynarmic-arm.js'))
      .href
  );
  const module: DynarmicModule = await imported.default();
  const cpu = new DynarmicBackend(module);
  cpu.map(base, 4096);
  cpu.write(base, Uint8Array.from(programs.jump));
  const original = WebAssembly.Module;
  let fail = true;
  const spy = vi.spyOn(WebAssembly, 'Module').mockImplementation(function (
    bytes: BufferSource,
  ) {
    if (fail) throw new RangeError('out of memory');
    return new original(bytes);
  } as unknown as typeof WebAssembly.Module);
  try {
    cpu.run(base, 1);
    expect(cpu.readRegisters(['pc', 'r0'])).toEqual([base, 0]);
    expect(cpu.executionStats.jitRetryPending).toBe(1);
    expect(cpu.executionStats.jitCompileRetries).toBe(1);
    fail = false;
    module.dynarmicWasmStats!.retryAfter = 0;
    cpu.run(cpu.readRegister('pc'), 1);
    expect(cpu.readRegisters(['pc', 'r0'])).toEqual([base + 4, 1]);
    expect(cpu.executionStats.jitRetryPending).toBe(0);
    fail = true;
    module.dynarmicWasmStats!.retryStarted = performance.now() - 6000;
    module.dynarmicWasmStats!.retryAfter = 0;
    expect(() => cpu.run(base + 4, 1)).toThrow(
      'could not allocate JIT code memory',
    );
    expect(cpu.readRegisters(['pc', 'r0'])).toEqual([base + 4, 1]);
  } finally {
    spy.mockRestore();
    cpu.destroy();
  }
});

test('packed modules survive partial invalidation and release all owners on destroy', async () => {
  const imported = await import(
    /* @vite-ignore */ pathToFileURL(resolve('public/runtime/dynarmic-arm.js'))
      .href
  );
  const module: DynarmicModule = await imported.default();
  const cpu = new DynarmicBackend(module);
  cpu.map(base, 4096);
  const bytes = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) bytes.set(programs.loop.slice(0, 4), i * 4);
  cpu.write(base, bytes);
  try {
    cpu.run(base, 256);
    expect(cpu.executionStats.jitPackedModules).toBeGreaterThan(0);
    cpu.write(base + 4, Uint8Array.from(programs.jump.slice(4, 8)));
    cpu.invalidateCode(base + 4, base + 8);
    cpu.run(base, 3);
    expect(cpu.readRegister('r0')).toBe(3);
    expect(cpu.executionStats.jitLiveModules).toBeGreaterThan(0);
  } finally {
    cpu.destroy();
  }
  expect(module.dynarmicWasmStats!.liveModules).toBe(0);
  expect(module.dynarmicWasmStats!.liveBlocks).toBe(0);
});
