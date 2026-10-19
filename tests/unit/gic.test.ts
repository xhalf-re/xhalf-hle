import { expect, test } from 'vitest';
import { Gic } from '../../src/runtime/gic';
import { enabledGic, gicConfig } from './gic-fixture';

const d = gicConfig.distributor,
  c = gicConfig.cpu_interface;
const bit = (irq: number) => 1n << BigInt(irq % 32);
const bank = (base: number, irq: number) => d + base + Math.floor(irq / 32) * 4;

test('reset gates both interfaces, per-IRQ enables, routing and priority mask', () => {
  const output: boolean[] = [],
    gic = new Gic(gicConfig, (level) => output.push(level));
  gic.raise(35);
  expect(gic.pending.has(35)).toBe(true);
  expect(gic.acknowledge()).toBe(1023);
  gic.write(d, 4, 1n);
  gic.write(c, 4, 1n);
  gic.write(c + 4, 4, 255n);
  gic.write(bank(0x100, 35), 4, bit(35));
  expect(gic.acknowledge()).toBe(1023);
  gic.write(d + 0x800 + 35, 1, 1n);
  expect(output).toEqual([true]);
  gic.write(bank(0x180, 35), 4, bit(35));
  expect(output).toEqual([true, false]);
  expect(gic.pending.has(35)).toBe(true);
  gic.write(bank(0x100, 35), 4, bit(35));
  expect(gic.acknowledge()).toBe(35);
  expect(output).toEqual([true, false, true, false]);
  expect(gic.read(c + 0x14, 4)).toBe(0n);
  gic.write(c + 0x10, 4, 35n);
  expect(gic.read(c + 0x14, 4)).toBe(255n);
});

test('arbitrates priority before ID, reads HPPIR without acknowledging and applies PMR strictly', () => {
  const gic = enabledGic();
  gic.write(d + 0x400 + 35, 1, 0x40n);
  gic.write(d + 0x400 + 29, 1, 0x80n);
  gic.raise(29);
  gic.raise(35);
  gic.write(c + 4, 4, 0x40n);
  expect(gic.highest()).toBe(1023);
  gic.write(c + 4, 4, 0x41n);
  expect(gic.read(c + 0x18, 4)).toBe(35n);
  expect(gic.active.size).toBe(0);
  expect(gic.read(c + 0xc, 4)).toBe(35n);
  expect(gic.read(bank(0x300, 35), 4) & bit(35)).toBe(bit(35));
  gic.complete(35);
  gic.write(c + 4, 4, 255n);
  gic.raise(30);
  gic.write(d + 0x400 + 30, 1, 0x80n);
  expect(gic.highest()).toBe(29);
});

test('BPR separates group priority from subpriority and EOIR unwinds nested running priority', () => {
  const gic = enabledGic();
  gic.write(c + 8, 4, 3n);
  for (const [irq, priority] of [
    [35, 0x28],
    [36, 0x21],
    [37, 0x10],
  ])
    gic.write(d + 0x400 + irq!, 1, BigInt(priority!));
  gic.raise(35);
  expect(gic.acknowledge()).toBe(35);
  gic.raise(36);
  expect(gic.highest()).toBe(36);
  expect(gic.acknowledge()).toBe(1023);
  gic.raise(37);
  expect(gic.acknowledge()).toBe(37);
  expect(gic.runningPriority).toBe(0x10);
  gic.complete(35); // Out-of-order and spurious EOIs cannot corrupt the stack.
  gic.complete(1023);
  expect(gic.runningPriority).toBe(0x10);
  gic.complete(37);
  expect(gic.runningPriority).toBe(0x20);
  expect(gic.acknowledge()).toBe(1023);
  gic.write(c + 8, 4, 0n);
  expect(gic.runningPriority).toBe(0x20);
  expect(gic.acknowledge()).toBe(1023);
  gic.complete(35);
  expect(gic.acknowledge()).toBe(36);
  gic.complete(36);
  expect(gic.runningPriority).toBe(255);
});

test('level pending follows the line independently of software pending, active and ICPENDR', () => {
  const gic = enabledGic();
  gic.setLevel(48, true);
  gic.write(bank(0x280, 48), 4, bit(48));
  expect(gic.pending.has(48)).toBe(true);
  expect(gic.acknowledge()).toBe(48);
  expect(gic.acknowledge()).toBe(1023);
  gic.complete(48);
  expect(gic.acknowledge()).toBe(48);
  gic.raise(48); // A new event while active survives line deassertion.
  gic.setLevel(48, false);
  gic.complete(48);
  expect(gic.acknowledge()).toBe(48);
  gic.complete(48);
  expect(gic.highest()).toBe(1023);
  gic.setLevel(48, true);
  gic.setLevel(48, false);
  expect(gic.highest()).toBe(1023);
});

test('edge configuration latches rising edges until acknowledge, including active-and-pending', () => {
  const gic = enabledGic();
  gic.write(d + 0xc00 + 48 / 4, 1, 2n);
  expect(gic.read(d + 0xc00 + 48 / 4, 1)).toBe(2n);
  gic.setLevel(48, true);
  gic.setLevel(48, false);
  expect(gic.acknowledge()).toBe(48);
  gic.setLevel(48, true);
  gic.complete(48);
  expect(gic.acknowledge()).toBe(48);
  gic.complete(48);
  gic.setLevel(48, true);
  expect(gic.highest()).toBe(1023);
  gic.setLevel(48, false);
  gic.setLevel(48, true);
  gic.write(bank(0x280, 48), 4, bit(48));
  expect(gic.highest()).toBe(1023);
});

test('software pending/active aliases and byte/halfword priority writes share register state', () => {
  const gic = enabledGic();
  gic.write(d + 0x400 + 60, 4, 0x10203040n);
  gic.write(d + 0x400 + 61, 2, 0x5060n);
  expect(gic.read(d + 0x400 + 60, 4)).toBe(0x10506040n);
  gic.write(bank(0x200, 60), 4, bit(60));
  gic.write(bank(0x300, 60), 4, bit(60));
  expect(gic.acknowledge()).toBe(1023);
  gic.write(bank(0x380, 60), 4, bit(60));
  expect(gic.highest()).toBe(60);
  gic.write(bank(0x280, 60), 4, bit(60));
  expect(gic.highest()).toBe(1023);
});

test('SGIs target the single CPU and reserved registers remain RAZ/WI', () => {
  const gic = enabledGic();
  expect(gic.read(d + 4, 4)).toBe(7n);
  expect(gic.read(d + 0xc00, 4)).toBe(0xaaaaaaaan);
  gic.write(d + 0x180, 4, 0xffffn);
  expect(gic.read(d + 0x100, 2)).toBe(0xffffn);
  gic.write(d + 0xf00, 4, 0x01000005n); // All other CPUs: none.
  expect(gic.highest()).toBe(1023);
  gic.write(d + 0xf00, 4, 0x02000005n);
  expect(gic.acknowledge()).toBe(5);
  gic.complete(5);
  gic.write(d + 0xf00, 4, 0x10006n);
  expect(gic.acknowledge()).toBe(6);
  gic.complete(6);
  gic.write(d + 0x200, 4, 1n << 5n);
  expect(gic.highest()).toBe(1023);
  gic.write(d + 0xf20 + 5, 1, 1n);
  gic.write(d + 0x280, 4, 1n << 5n);
  expect(gic.highest()).toBe(5);
  gic.write(d + 0xf10 + 5, 1, 1n);
  expect(gic.highest()).toBe(1023);
  for (const offset of [0x80, 0x500, 0x900, 0xe00]) {
    gic.write(d + offset, 4, 0xffffffffn);
    expect(gic.read(d + offset, 4)).toBe(0n);
  }
  gic.raise(29);
  gic.reset();
  expect(gic.acknowledge()).toBe(1023);
  expect(gic.pending.size).toBe(0);
  expect(() => gic.raise(256)).toThrow(RangeError);
});
