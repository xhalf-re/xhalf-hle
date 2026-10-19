import type { CpuBackend } from '../../src/cpu/backend';
import programs from '../arm/programs.json';

export function systemRegisterContracts(
  cpu: CpuBackend,
  base: number,
): string[] {
  const equal = (actual: unknown, expected: unknown, label: string) => {
    if (JSON.stringify(actual) !== JSON.stringify(expected))
      throw new Error(
        `${label}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`,
      );
  };
  const run = (name: keyof typeof programs, at = base, thumb = false) => {
    const bytes = Uint8Array.from(programs[name]);
    cpu.write(at, bytes);
    cpu.invalidateCode(at, at + bytes.length);
    cpu.run(thumb ? at | 1 : at, 100, at + bytes.length);
  };
  cpu.configureSystemRegisters(27000000, 0);
  cpu.writeRegister('cpsr', 0x13);
  const counter = 0x1234567887654321n;
  cpu.advanceSystemCounter(counter);
  for (const [name, at, thumb] of [
    ['system_registers', base, false],
    ['system_registers', base + 0x100, false],
    ['thumb_system_registers', base + 0x200, true],
  ] as const) {
    run(name, at, thumb);
    equal(
      cpu.readRegisters(['r4', 'r5', 'r6', 'r7', 'r8', 'r9']),
      [0, 27000000, 0x87654321, 0x12345678, 0x87654321, 0x12345678],
      'architectural reads at relocated ARM/Thumb PCs',
    );
  }
  cpu.writeRegister('cpsr', 0x13);
  const write = (value: bigint, ctl: number) => {
    cpu.writeRegisters([
      ['r0', Number(value & 0xffffffffn)],
      ['r1', Number(value >> 32n)],
      ['r2', ctl],
    ]);
    run('timer_write');
  };
  const control = (ctl: number) => {
    cpu.writeRegister('r2', ctl);
    run('timer_control');
  };
  write(counter + 10n, 1);
  equal(cpu.advanceSystemCounter(counter + 9n), 0, 'timer before compare');
  run('timer_read');
  equal(
    cpu.readRegisters(['r4', 'r5', 'r6', 'r7']),
    [0x8765432b, 0x12345678, 1, 1],
    'CVAL, CTL and TVAL readback',
  );
  equal(
    cpu.advanceSystemCounter(counter + 10n),
    1,
    'physical level at compare',
  );
  run('timer_read');
  equal(cpu.readRegister('r6'), 5, 'read-only ISTATUS');
  control(7);
  equal(cpu.advanceSystemCounter(counter + 10n), 0, 'IMASK deasserts output');
  run('timer_read');
  equal(cpu.readRegister('r6'), 7, 'masked expiration keeps ISTATUS');
  control(1);
  equal(
    cpu.advanceSystemCounter(counter + 10n),
    1,
    'unmask reasserts expired level',
  );
  write(counter + 20n, 1);
  equal(cpu.advanceSystemCounter(counter + 10n), 0, 'reprogram clears level');
  control(0);
  equal(
    cpu.advanceSystemCounter(counter + 30n),
    0,
    'disabled timer stays silent',
  );
  cpu.writeRegister('r0', 0xfffffffe);
  run('timer_tval');
  control(1);
  equal(
    cpu.advanceSystemCounter(counter + 30n),
    1,
    'signed negative TVAL expires immediately',
  );
  run('timer_read');
  equal(cpu.readRegister('r7'), 0xfffffffe, 'signed TVAL readback');
  const context = cpu.saveContext();
  write(counter + 100n, 1);
  cpu.advanceSystemCounter(counter + 40n);
  cpu.restoreContext(context);
  cpu.freeContext(context);
  run('system_registers');
  equal(
    cpu.readRegisters(['r6', 'r7']),
    [0x87654349, 0x12345678],
    'context restore does not rewind counter',
  );
  equal(
    cpu.advanceSystemCounter(counter + 40n),
    0,
    'context restore preserves timer programming',
  );
  run('timer_read');
  equal(cpu.readRegister('r4'), 0x87654385, 'context restore preserves CVAL');
  control(0);
  cpu.writeRegisters([
    ['r0', 0x87654353],
    ['r1', 0x12345678],
    ['r2', 1],
  ]);
  run('virtual_timer');
  equal(
    cpu.readRegisters(['r4', 'r5', 'r6']),
    [0x87654353, 0x12345678, 1],
    'virtual CVAL and CTL',
  );
  equal(
    cpu.advanceSystemCounter(counter + 49n),
    0,
    'virtual timer before compare',
  );
  equal(
    cpu.advanceSystemCounter(counter + 50n),
    2,
    'independent virtual timer output',
  );
  cpu.configureSystemRegisters(1234567, 0x80000002);
  cpu.advanceSystemCounter(0x8000000000000010n);
  write(1n, 1);
  equal(
    cpu.advanceSystemCounter(0x8000000000000010n),
    1,
    'comparison uses the full unsigned 64-bit counter',
  );
  run('system_registers', base + 0x300);
  equal(
    cpu.readRegisters(['r4', 'r5', 'r6', 'r7']),
    [0x80000002, 1234567, 0x10, 0x80000000],
    'configured identity and high counter',
  );
  return [
    'system-registers-any-pc',
    'generic-timer-levels',
    'system-device-context',
    'virtual-timer',
  ];
}
