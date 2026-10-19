import { expect, test } from 'vitest';
import { PeripheralBus, VirtualEvents } from '../../src/devices/bus';
import { HardwareTimers } from '../../src/devices/timer';
import { CommandQueue } from '../../src/devices/command-queue';
import { enabledGic } from './gic-fixture';
import machine from '../../src/profiles/machine.json';
import { ClockGates } from '../../src/devices/clocks';
import { GpioInterrupts } from '../../src/devices/gpio';
import { PanelController } from '../../src/devices/panel';
import { SensorFrontend } from '../../src/devices/frontend';
import { CaptureDma } from '../../src/devices/capture';
import { SerialControllers } from '../../src/devices/serial';
function devices() {
  const bus = new PeripheralBus(),
    gic = enabledGic(),
    timers = new HardwareTimers(machine.peripherals.timers, bus.clock, gic),
    cq = new CommandQueue(machine.peripherals.command_queue, bus.clock, gic);
  bus.attach(timers);
  bus.attach(cq);
  return { bus, gic, timers, cq };
}
test('virtual events replace/cancel deadlines and preserve equal-time ordering without stale queue growth', () => {
  const clock = new VirtualEvents(),
    events: string[] = [];
  for (let i = 0; i < 1000; i++)
    clock.schedule('replace', 100n, () => events.push('old'));
  expect(clock.pending).toBe(1);
  clock.schedule('replace', 20n, () => events.push('first'));
  clock.schedule('second', 20n, () => events.push('second'));
  clock.schedule('cancel', 10n, () => events.push('cancelled'));
  clock.cancel('cancel');
  clock.advance(20n);
  expect(events).toEqual(['first', 'second']);
  expect(clock.pending).toBe(0);
  expect(() => clock.advance(19n)).toThrow('backwards');
  expect(() => clock.schedule('past', 19n, () => {})).toThrow('future');
});
test('hardware one-shot timer latches masked expiry and dispatches a level IRQ until W1C', () => {
  const { bus, gic, timers } = devices(),
    t = machine.peripherals.timers,
    base = t.base + 2 * t.stride;
  bus.write(base + 2, 2, 26n);
  bus.write(base + 4, 4, 10n);
  bus.write(base, 1, 1n);
  bus.clock.advance(9999n);
  expect(bus.read(t.status, 4)).toBe(0n);
  bus.clock.advance(10000n);
  expect(bus.read(t.status, 4)).toBe(4n);
  expect(gic.pending.size).toBe(0);
  bus.write(t.irq_enable, 4, 4n);
  expect(gic.acknowledge()).toBe(t.first_irq + 2);
  gic.complete(t.first_irq + 2);
  expect(gic.acknowledge()).toBe(t.first_irq + 2);
  bus.write(t.status, 4, 4n);
  gic.complete(t.first_irq + 2);
  expect(gic.highest()).toBe(1023);
  bus.clock.advance(100000n);
  expect(bus.read(base + 8, 4)).toBe(10n);
  expect(timers.firings).toBe(1);
});
test('hardware timers preserve periodic phase, disable interrupts and cancel stopped deadlines', () => {
  const { bus, gic, timers } = devices(),
    t = machine.peripherals.timers;
  bus.write(t.base + 2, 2, 26n);
  bus.write(t.base + 4, 4, 10n);
  bus.write(t.irq_enable, 4, 1n);
  bus.write(t.base, 1, 0x11n);
  bus.clock.advance(25000n);
  expect(timers.firings).toBe(1);
  expect(bus.clock.pending).toBe(1);
  expect(bus.read(t.base + 8, 4)).toBe(5n);
  bus.write(t.status, 4, 1n);
  bus.clock.advance(30000n);
  expect(timers.firings).toBe(2);
  bus.write(t.irq_disable, 4, 1n);
  expect(gic.highest()).toBe(1023);
  bus.write(t.base, 1, 0n);
  expect(bus.clock.pending).toBe(0);
  const count = bus.read(t.base + 8, 4);
  bus.clock.advance(100000n);
  expect(bus.read(t.base + 8, 4)).toBe(count);
});
test('CQ flush completes through its aggregated IRQ and native mask/W1C registers', () => {
  const { bus, gic, cq } = devices(),
    c = machine.peripherals.command_queue;
  bus.write(c.base + 0x14, 4, 4n);
  bus.write(c.base + 0x92, 1, 0x89n);
  expect(bus.read(c.base + 0x92, 1)).toBe(0x89n);
  expect(gic.highest()).toBe(1023);
  bus.clock.advance(1000n);
  expect(bus.read(c.base + 0x92, 1)).toBe(9n);
  expect(bus.read(c.base, 8)).toBe(4n << 32n);
  expect(gic.acknowledge()).toBe(c.irq);
  bus.write(c.base + 4, 4, 4n);
  gic.complete(c.irq);
  expect(gic.highest()).toBe(1023);
  expect(cq.completions).toBe(1);
});
test('CQ cancellation and reset prevent late interrupts and retain no device events', () => {
  const { bus, gic, cq } = devices(),
    c = machine.peripherals.command_queue;
  bus.write(c.base + 0x10, 4, 1n);
  bus.write(c.base + 0x90, 1, 0x41n);
  bus.write(c.base + 0x90, 1, 1n);
  bus.clock.advance(1000n);
  expect(cq.completions).toBe(0);
  expect(gic.pending.size).toBe(0);
  bus.write(c.base + 0x90, 1, 0x41n);
  bus.reset();
  bus.clock.advance(100000n);
  expect(bus.clock.pending).toBe(0);
  expect(gic.highest()).toBe(1023);
  expect(bus.read(c.base, 8)).toBe(0n);
  expect(() => bus.attach(cq)).toThrow('Overlapping');
  expect(bus.read(0x10001000, 4)).toBeUndefined();
});

test('both HUM request modes use bank one and cannot complete a normal DMA channel', () => {
  const { bus, gic, cq } = devices(),
    c = machine.peripherals.command_queue;
  bus.write(c.base + 0x10, 4, 4n);
  bus.write(c.base + 0x92, 1, 0x49n);
  bus.clock.advance(1000n);
  expect(cq.completions).toBe(1);
  expect(bus.read(c.base, 4)).toBe(0n);
  expect(bus.read(c.base + 4, 4)).toBe(4n);
  expect(gic.highest()).toBe(1023);
  bus.write(c.base + 0x14, 4, 4n);
  expect(gic.highest()).toBe(c.irq);
});

test('serial reset cancels pending transfers and CPU slices coalesce completed busy bits', () => {
  const clock = new VirtualEvents(),
    c = machine.peripherals.serial,
    serial = new SerialControllers(c, clock);
  serial.write(c.base + 4, 1, 0x13n);
  serial.write(c.base + c.stride + 0x44, 1, 3n);
  clock.advance(1000n);
  expect(serial.read(c.base + 4, 1)).toBe(0x12n);
  expect(serial.read(c.base + c.stride + 0x44, 1)).toBe(2n);
  expect(serial.transfers).toBe(2);
  serial.write(c.base + 4, 1, 1n);
  serial.reset();
  clock.advance(10000n);
  expect(clock.pending).toBe(0);
  expect(serial.transfers).toBe(0);
});

function commandFixture(program: number[], read = (_address: number) => 0) {
  const clock = new VirtualEvents(),
    gic = enabledGic(),
    writes: number[][] = [],
    c = machine.peripherals.command_queue,
    cq = new CommandQueue(c, clock, gic, {
      readWord: (address) => {
        const word = program[(address - 0x1000) / 4];
        if (word === undefined) throw new Error('Command outside test DRAM');
        return word >>> 0;
      },
      synchronizationDelay: (module) => {
        if (module !== 2) throw new Error('Unknown sync endpoint');
        return 10000n;
      },
      readRegister: (address) => read(address),
      writeRegister: (address, size, value) =>
        writes.push([address, size, value]),
    });
  cq.write(c.base + 0x104, 4, 0x1000n);
  cq.write(c.base + 0x10, 4, 1n);
  cq.write(c.base + 0x100, 1, 1n);
  return { clock, cq, gic, writes, c };
}

test('CQ executes MMIO masks, register operations, D6 comparison and asynchronous synchronization before END', () => {
  const { clock, cq, writes, gic, c } = commandFixture(
    [
      0x01000002, 0x4ff5a040, 0x68000040, 0xd20000ff, 0xd6100000, 0x6c100041,
      0x02000002, 0x50012042, 0x0f000000,
    ],
    () => 0x35,
  );
  clock.advance(1000n);
  expect(writes).toEqual([
    [0x10002040, 1, 0x5a],
    [0x10002041, 1, 0x35],
  ]);
  expect(cq.completions).toBe(0);
  expect(gic.highest()).toBe(1023);
  clock.advance(11000n);
  expect(writes.at(-1)).toEqual([0x10002042, 2, 0x12]);
  expect(cq.completions).toBe(1);
  expect(gic.acknowledge()).toBe(c.irq);
});

test('CQ polling branches yield, observe device changes and cancel synchronization on stop', () => {
  let busy = true;
  const { clock, cq, c } = commandFixture(
    [0x68000000, 0x1210fffe, 0x02000002, 0x0f000000],
    () => (busy ? 1 : 0),
  );
  clock.advance(1000n);
  expect(cq.instructions).toBe(256);
  expect(clock.pending).toBe(1);
  busy = false;
  clock.advance(2000n);
  expect(cq.completions).toBe(0);
  cq.write(c.base + 0x100, 1, 0n);
  clock.advance(12000n);
  expect(cq.completions).toBe(0);
  expect(clock.pending).toBe(0);
});

test('CQ rejects unknown instructions, conditions, endpoints and out-of-range command memory', () => {
  for (const [program, message] of [
    [[0x70000000], 'Unsupported CQ operation'],
    [[0x12200000], 'Unsupported CQ branch condition'],
    [[0x02000003], 'Unknown sync endpoint'],
    [[0], 'Command outside test DRAM'],
  ] as const) {
    const { clock } = commandFixture([...program]);
    expect(() => clock.advance(1000n)).toThrow(message);
  }
  const { clock, cq, c } = commandFixture([0x0f000000]);
  cq.write(c.base + 0x104, 4, 0x1001n);
  expect(() => clock.advance(1000n)).toThrow('Unaligned');
});

test('clock gates share byte/word set and clear aliases without losing unrelated gates', () => {
  const config = machine.peripherals.clocks,
    gates = new ClockGates(config);
  gates.write(config.set, 4, 0x80400001n);
  gates.write(config.set + 1, 1, 2n);
  gates.write(config.clear, 4, 0x400000n);
  expect(gates.read(config.set, 4)).toBe(0x80000201n);
  expect(gates.read(config.clear, 4)).toBe(0x80000201n);
  gates.reset();
  expect(gates.read(config.set, 4)).toBe(0n);
});

test('GPIO compare completion uses masked latches, frame rearming, W1C and reset cancellation', () => {
  const clock = new VirtualEvents(),
    gic = enabledGic(),
    c = machine.peripherals.gpio,
    gpio = new GpioInterrupts(c, gic, clock);
  gpio.write(c.base + 0x58, 4, 270n);
  clock.advance(10000n);
  expect(gpio.read(c.base, 4)).toBe(1n << 18n);
  expect(gic.highest()).toBe(1023);
  gpio.write(c.base + 0x20, 4, 1n << 18n);
  expect(gic.acknowledge()).toBe(c.irq);
  gpio.write(c.base, 4, 1n << 18n);
  gic.complete(c.irq);
  expect(gic.highest()).toBe(1023);
  gpio.frame();
  gpio.reset();
  clock.advance(20000n);
  expect(clock.pending).toBe(0);
  expect(gpio.read(c.base, 4)).toBe(0n);
});

test('panel DCS transport tracks sleep/display state, FIFO readback and masked scan/blank completion', () => {
  const clock = new VirtualEvents(),
    gic = enabledGic(),
    c = machine.peripherals.panel,
    panel = new PanelController(c, clock, gic);
  const transfer = (type: number, command: number, bta = false) => {
    panel.write(c.base + 0x739, 1, BigInt(type));
    panel.write(c.base + 0x73a, 1, BigInt(command));
    panel.write(c.base + 0x730, 1, bta ? 5n : 1n);
    clock.advance(clock.now + BigInt(c.transfer_ns));
  };
  transfer(5, 0x11);
  transfer(5, 0x29);
  transfer(6, 0x0a, true);
  expect(panel.read(c.base + 0x762, 1)).toBe(0x9cn);
  expect(panel.read(c.base + 0x750, 1)).toBe(4n);
  expect(gic.highest()).toBe(1023);
  panel.write(c.base + 4, 4, 0x06000000n);
  expect(gic.acknowledge()).toBe(c.irq);
  panel.write(c.base, 4, 0xffffffffn);
  gic.complete(c.irq);
  panel.write(c.base + 0x20, 2, 0x101n);
  panel.write(c.base + 4, 4, 0xb0bn);
  clock.advance(clock.now + BigInt(c.frame_interval_ns));
  expect(panel.read(c.base, 4)).toBe(0xb0bn);
  panel.reset();
  expect(clock.pending).toBe(0);
  expect(gic.highest()).toBe(1023);
});

test('scanout enable drives phase-preserving device frames independently of masks and Canvas', () => {
  const clock = new VirtualEvents(),
    gic = enabledGic(),
    c = machine.peripherals.panel,
    panel = new PanelController(c, clock, gic),
    interval = BigInt(c.frame_interval_ns);
  panel.write(c.base + 4, 4, 0x202n);
  clock.advance(interval);
  expect(panel.vsyncs).toBe(0);
  expect(clock.pending).toBe(0);
  panel.write(c.base + 0x20, 1, 1n);
  clock.advance(interval * 2n);
  expect(panel.vsyncs).toBe(1);
  expect(panel.read(c.base, 4)).toBe(0xbn);
  expect(gic.acknowledge()).toBe(c.irq);
  gic.complete(c.irq);
  expect(gic.highest()).toBe(c.irq);
  panel.write(c.base + 4, 4, 0n);
  expect(gic.highest()).toBe(1023);
  clock.advance(interval * 12n + 100n);
  expect(panel.vsyncs).toBe(11);
  expect(clock.nextDeadline).toBe(interval * 13n);
  expect(clock.pending).toBe(1);
  panel.write(c.base + 4, 4, 0x202n);
  expect(gic.acknowledge()).toBe(c.irq);
  panel.write(c.base, 4, 0xbn);
  gic.complete(c.irq);
  expect(panel.scanAcknowledgements).toBe(1);
  expect(gic.highest()).toBe(1023);
  panel.write(c.base + 0x20, 1, 0n);
  expect(clock.pending).toBe(0);
  panel.write(c.base + 0x21, 1, 1n);
  clock.advance(clock.now + interval);
  expect(panel.read(c.base, 4)).toBe(0xb00n);
  expect(panel.scanAcknowledgements).toBe(1);
  panel.reset();
  expect(panel.vsyncs).toBe(0);
  expect(panel.scanAcknowledgements).toBe(0);
  expect(clock.pending).toBe(0);
});

test('receiver and capture honor link readiness, capture enable, frame phases and circular DMA indices', () => {
  const clock = new VirtualEvents(),
    gic = enabledGic(),
    c = machine.peripherals.frontend,
    raw = machine.peripherals.capture,
    edges: number[] = [],
    irq: number[] = [],
    dma = new CaptureDma(raw, clock, (source) => irq.push(source)),
    front = new SensorFrontend(
      c,
      clock,
      gic,
      (source) => edges.push(source),
      () => {},
      (port, start) => dma.frame(port, start),
    );
  clock.advance(BigInt(c.frame_interval_ns));
  expect(edges).toEqual([33, 41, 42]);
  expect(irq).toEqual([]);
  front.write(c.port_base + 0x80, 1, 0n);
  expect(front.read(c.port_base + 0x80, 1)).toBe(2n);
  clock.advance(clock.now + BigInt(c.transition_ns));
  expect(front.read(c.port_base + 0x80, 1)).toBe(0n);
  dma.write(raw.base, 1, 1n);
  dma.write(raw.base + 2, 1, 1n);
  dma.write(raw.base + 0x14, 1, 1n);
  clock.advance(BigInt(c.frame_interval_ns) * 2n);
  expect(irq).toEqual([25]);
  clock.advance(clock.now + BigInt(c.readout_ns));
  expect(irq).toEqual([25, 37]);
  expect(dma.read(raw.base + 0x15, 1)).toBe(1n);
  expect(dma.read(raw.base + 2, 1)).toBe(0n);
  clock.advance(BigInt(c.frame_interval_ns) * 3n);
  clock.advance(clock.now + BigInt(c.readout_ns));
  expect(irq).toEqual([25, 37, 25, 37]);
  expect(dma.read(raw.base + 0x15, 1)).toBe(2n);
  expect(front.synchronizationDelay(2)).toBe(BigInt(c.frame_interval_ns));
  expect(front.synchronizationDelay(3)).toBeUndefined();
  front.reset();
  dma.reset();
  expect(clock.pending).toBe(0);
  expect(front.read(c.port_base + 0x80, 1)).toBe(2n);
  expect(dma.frames).toBe(0);
});
