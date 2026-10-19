import { createUnicornBackend, CpuError } from '../../src/cpu/unicorn';
import type { CpuBackend, ArmRegister } from '../../src/cpu/backend';
import { PagedMemory } from '../../src/cpu/paged-memory';
import programs from '../arm/programs.json';
import sensorBridge from '../../src/sdk/sensor-register.json';
import { irqContracts } from './irq-contracts';
import { systemRegisterContracts } from './system-register-contracts';

function equal(actual: unknown, expected: unknown, label: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error(
      `${label}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`,
    );
}
const base = 0x40000000;
function load(cpu: CpuBackend, name: keyof typeof programs, at = base): number {
  const bytes = Uint8Array.from(programs[name]);
  cpu.write(at, bytes);
  cpu.invalidateCode(at, at + bytes.length);
  return at + bytes.length;
}
function word(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, true);
  return bytes;
}
export async function runContracts(): Promise<{
  passed: string[];
  benchmark: object;
}> {
  const cpu = await createUnicornBackend();
  const passed: string[] = [];
  try {
    cpu.map(base, 0x10000);
    cpu.map(0xffff0000, 0x10000);
    cpu.writeRegister('r2', 0x456);
    cpu.writeRegister('r3', 0x123);
    let end = load(cpu, 'registers');
    cpu.run(base, 100, end);
    equal(
      [cpu.readRegister('r0'), cpu.readRegister('r1'), cpu.readRegister('r4')],
      [0x37, 0x333, 0x38],
      'ARM arithmetic',
    );
    equal(cpu.readRegister('cpsr') & 0x40000000, 0x40000000, 'CPSR Z');
    passed.push('registers-cpsr');
    const batchNames = ['r0', 'r1', 'r4'] as const,
      batchBefore = cpu.readRegisters(batchNames);
    cpu.writeRegisters([
      ['r0', 0xffffffff],
      ['r1', 0x80000000],
      ['r4', 0x12345678],
    ]);
    equal(
      cpu.readRegisters(batchNames),
      [0xffffffff, 0x80000000, 0x12345678],
      'batch GPR values',
    );
    cpu.writeRegisters(batchNames.map((r, i) => [r, batchBefore[i]!] as const));
    passed.push('register-batch');

    const high = 0xffff8000;
    cpu.write(high, word(0x89abcdef));
    cpu.writeRegister('r1', high);
    const memoryEvents: string[] = [];
    const rh = cpu.hook(
      'read',
      (e) => {
        memoryEvents.push(`r:${e.address}`);
      },
      high,
      high + 7,
    );
    let removedHit = false;
    const wh = cpu.hook(
      'write',
      () => {
        removedHit = true;
      },
      1,
      0,
    );
    cpu.removeHook(wh);
    const write = cpu.hook(
      'write',
      (e) => {
        memoryEvents.push(`w:${e.address}:${e.value}`);
      },
      high,
      high + 7,
    );
    end = load(cpu, 'memory');
    cpu.run(base, 100, end);
    equal(
      new DataView(cpu.read(high + 4, 4).buffer).getUint32(0, true),
      0x89abcdf0,
      'high write',
    );
    equal(cpu.readRegister('r2'), 0xcd, 'byte read');
    equal(removedHit, false, 'removed hook');
    equal(
      memoryEvents,
      [`r:${high}`, `w:${high + 4}:2309737968`, `r:${high + 1}`],
      'memory hooks',
    );
    cpu.removeHook(rh);
    cpu.removeHook(write);
    passed.push('memory-high-address-hooks');

    const blocks: number[] = [];
    const block = cpu.hook('block', (e) => {
      blocks.push(e.address);
    });
    const jump = cpu.hook(
      'code',
      () => {
        cpu.writeRegister('pc', base + 8);
      },
      base,
      base,
    );
    end = load(cpu, 'jump');
    cpu.writeRegister('r0', 99);
    cpu.run(base, 100, end);
    equal([cpu.readRegister('r0'), cpu.readRegister('r1')], [99, 3], 'hook PC');
    if (!blocks.includes(base)) throw new Error('block hook did not run');
    cpu.removeHook(jump);
    cpu.removeHook(block);
    passed.push('hook-pc-block');

    const stop = cpu.hook('code', () => cpu.stop(), base + 4, base + 4);
    cpu.run(base, 100, end);
    equal(cpu.readRegister('pc'), base + 4, 'stop PC');
    cpu.removeHook(stop);
    cpu.run(cpu.readRegister('pc'), 100, end);
    equal(cpu.readRegister('r0'), 2, 'resume');
    passed.push('stop-resume');

    cpu.writeRegister('r4', 0xdeadbeef);
    cpu.writeRegister('cpsr', 0x13);
    cpu.writeRegister('sp', base + 0xff00);
    const context = cpu.saveContext();
    cpu.writeRegister('r4', 0);
    cpu.writeRegister('cpsr', 0x12);
    cpu.writeRegister('sp', 0xfffff000);
    cpu.restoreContext(context);
    equal(cpu.readRegister('r4'), 0xdeadbeef, 'context register');
    equal(cpu.readRegister('sp'), base + 0xff00, 'context banked sp');
    cpu.freeContext(context);
    const double = Uint8Array.from([
      0x10, 0x32, 0x54, 0x76, 0x98, 0xba, 0xdc, 0xfe,
    ]);
    cpu.writeRegisterBytes(14, double); // pinned ARM_REG_D0
    equal(
      Array.from(cpu.readRegisterBytes(14, 8)),
      Array.from(double),
      '64-bit VFP register',
    );
    passed.push('context-banked');

    cpu.writeRegister('cpsr', 0x13);
    cpu.writeRegister('sp', base + 0xff00);
    cpu.writeRegister('pc', base + 0x300);
    cpu.writeRegister('cpsr', 0x92);
    cpu.writeRegister('sp', base + 0xfe00);
    cpu.writeRegister('lr', base + 0x304);
    cpu.writeRegister('spsr', 0x13);
    load(cpu, 'irq', base + 0x100);
    cpu.writeRegister('r0', 10);
    cpu.run(base + 0x100, 2);
    equal(
      [
        cpu.readRegister('r0'),
        cpu.readRegister('pc'),
        cpu.readRegister('cpsr') & 0xff,
        cpu.readRegister('sp'),
      ],
      [11, base + 0x300, 0x13, base + 0xff00],
      'IRQ exception return',
    );
    passed.push('irq-spsr-return');
    load(cpu, 'banked');
    cpu.writeRegister('r2', base + 0xfe00);
    cpu.writeRegister('r3', base + 0xfd00);
    cpu.run(base, 4);
    equal(
      [cpu.readRegister('r0'), cpu.readRegister('r1')],
      [base + 0xfd00, base + 0xfe00],
      'ARMv7 banked MSR/MRS',
    );
    passed.push('banked-msr-mrs');
    cpu.map(0x60000000, 4096);
    let writes = 0;
    const stressHook = cpu.hook(
      'write',
      () => {
        writes++;
      },
      0x60000000,
      0x60000fff,
    );
    end = load(cpu, 'helper_stress');
    let instructions = 0;
    const instructionHook = cpu.hook(
      'code',
      () => {
        instructions++;
      },
      base,
      end - 4,
    );
    cpu.run(base, 1000, end);
    equal(writes, 160, 'many helper calls in one translation block');
    equal(instructions, 163, 'per-instruction helpers in a large block');
    cpu.removeHook(instructionHook);
    cpu.removeHook(stressHook);
    passed.push('helper-temporary-lifetimes');

    cpu.write(base, word(0xe3a00001));
    cpu.invalidateCode(base, base + 4);
    cpu.run(base, 1);
    equal(cpu.readRegister('r0'), 1, 'cache first');
    cpu.write(base, word(0xe3a00002));
    cpu.invalidateCode(base, base + 4);
    cpu.run(base, 1);
    equal(cpu.readRegister('r0'), 2, 'cache replaced');
    passed.push('cache-invalidation');

    const intr: number[] = [];
    const ih = cpu.hook('interrupt', (e) => {
      intr.push(e.interrupt!);
    });
    end = load(cpu, 'svc');
    cpu.run(base, 100, end);
    equal(intr, [2], 'SVC interrupt');
    equal(cpu.readRegister('r0'), 9, 'SVC resume');
    cpu.removeHook(ih);
    passed.push('interrupt-hook');

    let invalid = 0;
    const invalidHook = cpu.hook('invalid', () => {
      invalid++;
      return false;
    });
    load(cpu, 'invalid');
    let invalidError = false;
    try {
      cpu.run(base, 1);
    } catch (error) {
      invalidError = error instanceof CpuError && error.code === 10;
    }
    equal([invalid, invalidError], [1, true], 'invalid instruction');
    cpu.removeHook(invalidHook);
    passed.push('invalid-instruction');

    cpu.writeRegister('r1', 0x70000000);
    load(cpu, 'memory');
    let unmapped = 0;
    const missing = cpu.hook('unmapped', (e) => {
      unmapped++;
      equal(e.address, 0x70000000, 'missing address');
      return false;
    });
    let failure = false;
    try {
      cpu.run(base, 1);
    } catch (error) {
      failure = error instanceof CpuError && error.code === 6;
    }
    equal([unmapped, failure], [1, true], 'unmapped failure');
    cpu.removeHook(missing);
    const recovery = cpu.hook('unmapped', (e) => {
      cpu.map(e.address, 4096);
      cpu.write(e.address, word(41));
      return true;
    });
    cpu.run(base, 4);
    equal(cpu.readRegister('r0'), 42, 'unmapped recovery');
    cpu.removeHook(recovery);
    passed.push('unmapped-reject-recover');

    cpu.protect(0x70000000, 4096, 1);
    failure = false;
    try {
      cpu.run(base + 8, 1);
    } catch (error) {
      failure = error instanceof CpuError && error.code === 12;
    }
    equal(failure, true, 'write protection');
    cpu.unmap(0x70000000, 4096);
    passed.push('protection-unmap');
    const paged = new PagedMemory(cpu, [[0x71000000, 0x10000]]);
    paged.write(0x71000ffc, Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]));
    equal(
      Array.from(paged.read(0x71000ffc, 8)),
      [1, 2, 3, 4, 5, 6, 7, 8],
      'sparse RAM across page boundary',
    );
    let outside = false;
    try {
      paged.write(0x72000000, Uint8Array.of(1));
    } catch (error) {
      outside = error instanceof CpuError;
    }
    equal(outside, true, 'unknown memory remains unmapped');
    passed.push('sparse-ram-boundaries');

    load(cpu, 'thunk');
    load(cpu, 'call', base + 0x1000);
    const packet = [base + 0x1000, 6, 1, 2, 3, 4, 5, 6];
    cpu.write(
      base + 0x2000,
      Uint8Array.from(packet.flatMap((v) => Array.from(word(v)))),
    );
    cpu.writeRegister('sp', base + 0xf000);
    cpu.writeRegister('r0', base + 0x2000);
    cpu.writeRegister('r4', 0x12345678);
    cpu.writeRegister('lr', base + 0x3000);
    cpu.run(base, 1000, base + 0x3000);
    equal(
      [
        cpu.readRegister('r0'),
        cpu.readRegister('r1'),
        cpu.readRegister('r4'),
        cpu.readRegister('sp'),
      ],
      [21, 0, 0x12345678, base + 0xf000],
      'AAPCS six arguments, alignment, callee-saved',
    );
    passed.push('aapcs-stack-arguments');

    // Mapping enough RAM forces growth; all subsequent reads must use fresh Wasm views.
    const before = cpu.memoryBytes;
    cpu.map(0x50000000, 64 * 1024 * 1024);
    cpu.write(0x53fffffc, word(0xabcdef01));
    equal(
      Array.from(cpu.read(0x53fffffc, 4)),
      [1, 239, 205, 171],
      'growth read',
    );
    if (cpu.memoryBytes <= before)
      throw new Error('growth test did not grow memory');
    cpu.writeRegisters([
      ['r0', 0xfedcba98],
      ['r12', 0x87654321],
    ]);
    equal(
      cpu.readRegisters(['r0', 'r12']),
      [0xfedcba98, 0x87654321],
      'batch after growth',
    );
    passed.push('memory-growth-view');

    end = load(cpu, 'jump');
    cpu.run(base, 1000, end);
    let cachedBlocks = 0;
    const cached = cpu.hook(
      'block',
      () => {
        cachedBlocks++;
      },
      base,
      base,
    );
    cpu.run(base, 1000, end);
    equal(cachedBlocks, 1, 'block hook added to cached translation');
    cpu.removeHook(cached);
    cpu.run(base, 1000, end);
    equal(cachedBlocks, 1, 'removed block hook on cached translation');
    passed.push('cached-block-hooks');
    const shim = base + 0x8000,
      api = base + 0x9000,
      continuation = base + 0x7000;
    const shimBytes = new Uint8Array(sensorBridge.length + 16);
    shimBytes.set(sensorBridge);
    const parameters = new DataView(shimBytes.buffer),
      parameterAt = sensorBridge.length - 24;
    [api, 4, 0, 1, continuation, 0, 1, 0, 2, 0].forEach((value, i) =>
      parameters.setUint32(parameterAt + i * 4, value, true),
    );
    cpu.write(shim, shimBytes);
    cpu.write(api, word(0xe12fff1e));
    const savedNames: ArmRegister[] = Array.from(
      { length: 13 },
      (_, i) => `r${i}` as ArmRegister,
    );
    savedNames.push('sp', 'lr');
    const sensorBefore = savedNames.map((_, i) => 0x11223300 + i);
    sensorBefore[13] = base + 0xf000;
    const calls: number[][] = [];
    let failAt = -1;
    const apiHook = cpu.hook(
      'code',
      () => {
        calls.push(cpu.readRegisters(['r0', 'r1', 'r2']));
        equal(cpu.readRegister('sp') % 8, 0, 'sensor bridge stack alignment');
        const lr = cpu.readRegister('lr');
        cpu.writeRegisters([
          ['r0', calls.length === failAt ? 37 : 0],
          ['r1', 0xdead],
          ['r2', 0xbeef],
          ['r3', 0x1234],
          ['r12', 0x5678],
          ['pc', lr],
        ]);
      },
      api,
      api,
    );
    for (const failure of [-1, 2]) {
      calls.length = 0;
      failAt = failure;
      cpu.writeRegisters(
        savedNames.map((name, i) => [name, sensorBefore[i]!] as const),
      );
      cpu.run(shim, 1000, continuation);
      equal(
        cpu.readRegister('pc'),
        continuation,
        'sensor bridge returns to native initializer',
      );
      equal(
        cpu.readRegisters(savedNames),
        sensorBefore,
        'sensor bridge preserves interrupted registers/SP/LR',
      );
      equal(
        calls,
        failure < 0
          ? [
              [0, 0, 0],
              [1, 0, 1],
              [0, 2, 2],
              [1, 2, 2],
            ]
          : [
              [0, 0, 0],
              [1, 0, 1],
            ],
        'sensor SDK port registration calls',
      );
      equal(
        new DataView(
          cpu.read(shim + sensorBridge.length - 4, 4).buffer,
        ).getUint32(0, true),
        failure < 0 ? 0 : 37,
        'sensor SDK error retained',
      );
    }
    cpu.removeHook(apiHook);
    passed.push('sensor-registration-aapcs');
    end = load(cpu, 'wait');
    cpu.run(base, 100000, end);
    equal(
      cpu.readRegister('r0'),
      1,
      'WFI yields without executing its continuation',
    );
    equal(cpu.readRegister('pc'), base + 8, 'WFI return PC');
    cpu.run(base + 8, 100, end);
    equal(cpu.readRegister('r0'), 2, 'WFI continuation resumes');
    passed.push('wait-for-interrupt');
    load(cpu, 'loop');
    cpu.writeRegister('r0', 0);
    cpu.runSlice(base, 40000);
    const blockIterations = cpu.readRegister('r0');
    if (blockIterations < 19999 || blockIterations > 20001)
      throw new Error(
        `Block slice exceeded its instruction budget: ${blockIterations}`,
      );
    let interrupted = false;
    const stopSlice = cpu.hook(
      'code',
      () => {
        interrupted = true;
        cpu.stop();
      },
      base,
      base,
    );
    cpu.runSlice(base, 40000);
    equal(interrupted, true, 'block slice honors code-hook stop');
    cpu.removeHook(stopSlice);
    cpu.writeRegister('r0', 0);
    cpu.run(base, 20);
    equal(
      cpu.readRegister('r0'),
      10,
      'exact count remains available after block slices',
    );
    const waitEnd = load(cpu, 'wait');
    cpu.runSlice(base, 1000);
    equal(cpu.readRegister('pc'), base + 8, 'block slice preserves WFI exit');
    equal(cpu.readRegister('r0'), 1, 'block slice preserves WFI state');
    cpu.run(base + 8, 100, waitEnd);
    equal(cpu.readRegister('r0'), 2, 'exact execution resumes block-slice WFI');
    load(cpu, 'wait', 0xffff9000);
    cpu.runSlice(0xffff9000, 1000);
    equal(
      cpu.readRegister('pc'),
      0xffff9008,
      'block slice preserves unsigned high code addresses',
    );
    passed.push('bounded-block-slices');
    load(cpu, 'thumb_wait');
    cpu.runSlice(base | 1, 1000);
    equal(cpu.readRegister('r0'), 42, 'Thumb slice instruction state');
    equal(cpu.readRegister('pc'), base + 6, 'Thumb slice WFI return PC');
    cpu.runSlice((base + 6) | 1, 1000);
    equal(
      cpu.readRegister('r0'),
      43,
      'Thumb slice resumes with bounded backward branch',
    );
    cpu.writeRegister('cpsr', cpu.readRegister('cpsr') & ~0x20);
    passed.push('thumb-block-slices');
    passed.push(...systemRegisterContracts(cpu, base + 0x4000));
    const irq = await irqContracts();
    passed.push(...irq.passed);
    load(cpu, 'loop');
    cpu.writeRegister('r0', 0);
    const count = 1000000;
    const sample = () => {
      const started = performance.now();
      cpu.run(base, count);
      return performance.now() - started;
    };
    sample();
    const instructionMs = Array.from({ length: 5 }, sample);
    let hits = 0;
    const bh = cpu.hook(
      'code',
      () => {
        hits++;
      },
      base,
      base,
    );
    const hookMs = Array.from({ length: 5 }, sample);
    cpu.removeHook(bh);
    equal(hits, (count / 2) * 5, 'benchmark hooks installed over cached code');
    return {
      passed,
      benchmark: {
        irqTiming: irq.timing,
        instructionCount: count,
        instructionMs,
        hookMs,
        memoryBytes: cpu.memoryBytes,
      },
    };
  } finally {
    cpu.destroy();
  }
}
