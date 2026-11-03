import { test, expect } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { DynarmicBackend, type DynarmicModule } from '../../src/cpu/dynarmic';

/** Fixed guest work probe for JS hook dispatch. Opt in explicitly. */
test.skipIf(!process.env.XHALF_FIXED_HOOK_PROBE)(
  'fixed-work hook dispatch probe',
  async () => {
    const imported = (await import(
      /* @vite-ignore */ pathToFileURL(
        resolve('public/runtime/dynarmic-arm.js'),
      ).href
    )) as { default: () => Promise<DynarmicModule> };
    const program = new Uint8Array(
      JSON.parse(readFileSync('tests/arm/programs.json', 'utf8')).loop,
    );
    const cpu = new DynarmicBackend(await imported.default(), 17);
    cpu.map(0x40000000, 4096);
    cpu.write(0x40000000, program);
    cpu.writeRegister('pc', 0x40000000);
    cpu.run(0x40000000, 100000);
    let callbacks = 0;
    cpu.hook(
      'block',
      () => {
        callbacks++;
      },
      0x40000000,
      0x40000007,
    );
    const irrelevant: [
      'code' | 'read' | 'write' | 'unmapped' | 'interrupt' | 'invalid',
      number,
      number,
    ][] = [
      ['code', 0x50000000, 0x50000010],
      ['read', 0x10000000, 0x10000010],
      ['write', 0x10000000, 0x10000010],
      ['unmapped', 0x10000000, 0x10000010],
      ['interrupt', 0, 15],
      ['invalid', 0x50000000, 0x50000010],
    ];
    for (let i = 0; i < 4; i++)
      for (const [kind, begin, end] of irrelevant)
        cpu.hook(kind, () => {}, begin, end);
    const budget = 20_000_000,
      started = performance.now();
    let charged = 0;
    while (charged < budget)
      charged += cpu.runSlice(cpu.readRegister('pc'), 2_000_000);
    const elapsedMs = performance.now() - started,
      report = {
        schema: 1,
        measurement:
          'fixed warmed ARM loop, exact runSlice charge, one matching block hook plus 24 irrelevant hooks',
        budget,
        charged,
        elapsedMs,
        mips: charged / elapsedMs / 1000,
        callbacks,
        executionStats: cpu.executionStats,
      };
    mkdirSync('.private/reports', { recursive: true });
    writeFileSync(
      '.private/reports/hook-dispatch-probe.json',
      JSON.stringify(report, null, 2),
    );
    cpu.destroy();
    expect(charged).toBeGreaterThanOrEqual(budget);
    expect(callbacks).toBeGreaterThan(0);
    console.log(JSON.stringify(report));
  },
  120000,
);
