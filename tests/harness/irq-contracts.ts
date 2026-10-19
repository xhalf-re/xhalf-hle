import { createUnicornBackend } from '../../src/cpu/unicorn';
import { Gic } from '../../src/runtime/gic';
import programs from '../arm/programs.json';

export async function irqContracts(): Promise<{
  passed: string[];
  timing: object;
}> {
  const cpu = await createUnicornBackend(),
    base = 0x42000000,
    source = 0x60001000;
  const passed: string[] = [];
  const equal = (a: unknown, b: unknown, label: string) => {
    const serialize = (v: unknown) =>
      JSON.stringify(v, (_key, value: unknown) =>
        typeof value === 'bigint' ? `${value}n` : value,
      );
    if (serialize(a) !== serialize(b))
      throw new Error(`${label}: ${serialize(a)} != ${serialize(b)}`);
  };
  const load = (name: keyof typeof programs, at: number) => {
    cpu.write(at, Uint8Array.from(programs[name]));
    cpu.invalidateCode(at, at + programs[name].length);
    return at + programs[name].length;
  };
  const setup = (vector: number, flags = 0) => {
    cpu.setIrq(false);
    cpu.writeRegister('cpsr', 0x92);
    cpu.writeRegister('sp', base + 0xfe00);
    cpu.writeRegister('cpsr', 0x93);
    cpu.writeRegister('sp', base + 0xff00);
    cpu.writeRegister('r0', vector);
    cpu.writeRegister('r1', flags);
    cpu.run(base, 100, load('irq_setup', base));
    cpu.writeRegister('cpsr', 0x13);
    cpu.writeRegister('r8', 0);
    cpu.writeRegister('r1', source);
  };
  try {
    equal(cpu.waitingForInterrupt, false, 'new engine has no pending WFI');
    cpu.map(base, 0x10000);
    cpu.map(0xffff0000, 0x10000);
    cpu.map(source, 0x3000);
    cpu.configureSystemRegisters(27000000, 0);
    for (const [thumb, flags, vector] of [
      [false, 0, base + 0x8000],
      [true, 0, base + 0x9000],
      [false, 0x2000, base + 0x8000],
      [true, 0x40000000, base + 0x9000],
    ] as const) {
      setup(vector, flags);
      const handler = flags & 0x2000 ? 0xffff0018 : vector + 0x18,
        main = base + 0x1000,
        exceptionThumb = !!(flags & 0x40000000);
      load(exceptionThumb ? 'thumb_irq_handler' : 'irq_handler', handler);
      load(thumb ? 'thumb_irq_source' : 'irq_source', main);
      let entry: number[] | undefined,
        returned = false;
      const trigger = cpu.hook('write', () => cpu.setIrq(true), source, source);
      const entryHook = cpu.hook(
        'block',
        () => {
          entry = cpu.readRegisters(['pc', 'cpsr', 'spsr', 'lr', 'sp', 'r6']);
          cpu.setIrq(false);
        },
        handler,
        handler,
      );
      const continuation = main + (thumb ? 8 : 12);
      const finish = cpu.hook(
        'block',
        () => {
          if (cpu.readRegister('r8') === 1) {
            returned = true;
            cpu.stop();
          }
        },
        continuation,
        continuation,
      );
      cpu.runSlice(thumb ? main | 1 : main, 1000);
      if (!entry)
        throw new Error(
          'External IRQ did not enter its vector within cpu.runSlice',
        );
      equal(entry[0], handler, 'VBAR/high vector selection');
      equal(
        entry[1]! & 0x1ff,
        exceptionThumb ? 0x1b2 : 0x192,
        'IRQ mode, A/I and SCTLR.TE',
      );
      equal(
        entry[2]! & 0x1ff,
        thumb ? 0x33 : 0x13,
        'SPSR preserves ARM/Thumb state',
      );
      equal(
        entry.slice(3),
        [continuation + 4, base + 0xfe00, 17],
        'LR_irq, banked SP and incoming TB boundary',
      );
      equal(
        returned,
        true,
        'IRQ returns to the interrupted TB in the same host run',
      );
      equal(
        cpu.readRegister('cpsr') & 0x1ff,
        thumb ? 0x33 : 0x13,
        'exception return restores CPSR',
      );
      equal(
        cpu.readRegister('sp'),
        base + 0xff00,
        'exception return restores banked SP',
      );
      cpu.removeHook(trigger);
      cpu.removeHook(entryHook);
      cpu.removeHook(finish);
    }
    passed.push(
      'irq-native-arm-thumb-vectors',
      'irq-high-vectors-and-te',
      'irq-spsr-banked-return',
    );

    setup(base + 0x8000);
    const main = base + 0x1000,
      handler = base + 0x8018;
    load('loop', main);
    load('irq_handler', handler);
    cpu.writeRegister('cpsr', 0x93);
    let entries = 0;
    const entryHook = cpu.hook(
      'block',
      () => {
        entries++;
        cpu.setIrq(false);
      },
      handler,
      handler,
    );
    cpu.setIrq(true);
    cpu.runSlice(main, 1000);
    equal(entries, 0, 'CPSR.I masks an asserted line through cached TBs');
    cpu.runSlice(main, 1000);
    equal(entries, 0, 'masked IRQ persists across host slices');
    load('irq_unmask', main + 0x100);
    cpu.runSlice(main + 0x100, 1000);
    equal(
      entries,
      1,
      'guest CPSIE delivers a pending line without returning to host',
    );
    cpu.removeHook(entryHook);
    passed.push('irq-masked-line-and-cpsie');

    setup(base + 0x8000);
    load('gic_handler', handler);
    load('irq_source', main);
    const config = {
        distributor: source + 0x1000,
        cpu_interface: source + 0x2000,
      },
      gic = new Gic(config, (level) => cpu.setIrq(level));
    gic.write(config.distributor, 4, 1n);
    gic.write(config.cpu_interface, 4, 1n);
    gic.write(config.cpu_interface + 4, 4, 255n);
    gic.write(config.distributor + 0x104, 4, 8n);
    gic.write(config.distributor + 0x800 + 35, 1, 1n);
    cpu.writeRegister('r4', config.cpu_interface);
    let acknowledged = 1023;
    const read = cpu.hook(
      'read',
      (e) => {
        const value = gic.read(e.address, e.size),
          bytes = new Uint8Array(e.size);
        new DataView(bytes.buffer).setUint32(0, Number(value), true);
        cpu.write(e.address, bytes);
        if (e.address === config.cpu_interface + 0xc)
          acknowledged = Number(value);
      },
      config.cpu_interface,
      config.cpu_interface + 0xfff,
    );
    const write = cpu.hook(
      'write',
      (e) => {
        gic.setLevel(35, false);
        gic.write(e.address, e.size, e.value!);
      },
      config.cpu_interface,
      config.cpu_interface + 0xfff,
    );
    const trigger = cpu.hook(
      'write',
      () => gic.setLevel(35, true),
      source,
      source,
    );
    cpu.runSlice(main, 1000);
    equal(acknowledged, 35, 'native ISR reads GICC_IAR');
    equal(
      [
        cpu.readRegister('r8'),
        gic.active.size,
        gic.pending.size,
        gic.runningPriority,
      ],
      [1, 0, 0, 255],
      'native ISR clears source and writes EOIR',
    );
    cpu.removeHook(read);
    cpu.removeHook(write);
    cpu.removeHook(trigger);
    passed.push('irq-native-gic-iar-eoir');

    setup(base + 0x8000);
    load('irq_handler', handler);
    load('loop', main);
    const arrivals: bigint[] = [];
    cpu.configureExecutionClock(2, 27000000, (now, levels) => {
      if (levels & 1 || now >= 1000n) {
        arrivals.push(now);
        cpu.setExecutionDeadline(undefined);
        cpu.setIrq(true);
      }
    });
    cpu.setExecutionDeadline(1000n);
    let irqTime = 0n;
    const timedEntry = cpu.hook(
      'block',
      () => {
        irqTime = cpu.executionTime;
        cpu.setIrq(false);
        cpu.stop();
      },
      handler,
      handler,
    );
    cpu.runSlice(main, 100000);
    if (irqTime !== 1000n)
      throw new Error(`Device IRQ quantized beyond TB boundary: ${irqTime}`);
    equal(arrivals.length, 1, 'board deadline callback runs only when due');
    cpu.removeHook(timedEntry);
    passed.push('irq-device-deadline-within-slice');

    setup(base + 0x8000);
    load('loop', main);
    const now = cpu.executionTime;
    cpu.advanceSystemCounter((now * 27000000n) / 1000000000n);
    const expiry = (now * 27000000n) / 1000000000n + 27n;
    cpu.writeRegisters([
      ['r0', Number(expiry)],
      ['r1', 0],
      ['r2', 1],
    ]);
    cpu.run(base + 0x400, 100, load('timer_write', base + 0x400));
    cpu.configureExecutionClock(2, 27000000, (_time, levels) =>
      cpu.setIrq(!!(levels & 1)),
    );
    let genericEntry = 0n;
    const generic = cpu.hook(
      'block',
      () => {
        genericEntry = cpu.executionTime;
        cpu.setIrq(false);
        cpu.stop();
      },
      handler,
      handler,
    );
    cpu.runSlice(main, 100000);
    if (genericEntry < now + 950n || genericEntry > now + 1050n)
      throw new Error(
        `Generic timer IRQ quantized beyond TB boundary: ${genericEntry - now}`,
      );
    cpu.removeHook(generic);
    passed.push('irq-generic-timer-within-slice');

    cpu.writeRegister('r2', 0);
    cpu.run(base + 0x400, 100, load('timer_control', base + 0x400));
    setup(base + 0x8000);
    load('wait', main);
    let wakeArmed = false;
    cpu.configureExecutionClock(2, 27000000, () => {
      if (wakeArmed) {
        cpu.setExecutionDeadline(undefined);
        cpu.setIrq(true);
      }
    });
    cpu.runSlice(main, 1000);
    equal(cpu.waitingForInterrupt, true, 'WFI waits for a board interrupt');
    const sleeping = cpu.saveContext(),
      sleepTime = cpu.executionTime;
    wakeArmed = true;
    cpu.setExecutionDeadline(sleepTime + 777n);
    cpu.idleExecutionClock(sleepTime + 200000n);
    equal(
      cpu.executionTime,
      sleepTime + 777n,
      'WFI idles only until the device deadline',
    );
    cpu.restoreContext(sleeping);
    cpu.freeContext(sleeping);
    equal(
      cpu.executionTime,
      sleepTime + 777n,
      'CPU context does not rewind device time',
    );
    equal(
      cpu.waitingForInterrupt,
      false,
      'external IRQ survives CPU context restore and wakes WFI',
    );
    let woke = false;
    const wakeHook = cpu.hook(
      'block',
      () => {
        woke = true;
        cpu.setIrq(false);
        cpu.stop();
      },
      handler,
      handler,
    );
    cpu.runSlice(cpu.readRegister('pc'), 1000);
    equal(woke, true, 'WFI wake enters the native IRQ vector');
    cpu.removeHook(wakeHook);
    passed.push('irq-wfi-deadline-and-device-context');
    return {
      passed,
      timing: {
        deviceDeadlineNs: 1000,
        deviceEntryNs: Number(irqTime),
        genericTimerEntryDeltaNs: Number(genericEntry - now),
        wfiDeadlineDeltaNs: 777,
      },
    };
  } finally {
    cpu.destroy();
  }
}
