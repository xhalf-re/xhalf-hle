import type { Gic } from '../runtime/gic';
import {
  readBytes,
  writeBytes,
  type VirtualEvents,
  type MmioDevice,
} from './bus';
export interface GpioRegisters {
  base: number;
  irq: number;
  counter_hz: number;
}
/** GPIO/receiver interrupt latch. Board wiring supplies edges; guest installs handlers. */
export class GpioInterrupts implements MmioDevice {
  readonly ranges;
  private status = new Uint32Array(3);
  private masks = new Uint32Array(3);
  private counters = new Uint32Array(14);
  constructor(
    readonly config: GpioRegisters,
    private gic: Gic,
    private clock: VirtualEvents,
  ) {
    this.ranges = [
      [config.base, 0xc],
      [config.base + 0x20, 0xc],
      [config.base + 0x50, 14 * 4],
    ] as const;
  }
  signal(source: number): void {
    if (source < 0 || source >= 96)
      throw new Error('GPIO interrupt source out of range');
    const bank = source >>> 5;
    this.status[bank] = (this.status[bank]! | (1 << (source & 31))) >>> 0;
    this.update();
  }
  private update(): void {
    this.gic.setLevel(
      this.config.irq,
      this.status.some((value, i) => !!(value & this.masks[i]!)),
    );
  }
  private arm(channel: number): void {
    const word = this.counters[channel]!,
      key = `gpio:timer:${channel}`;
    this.clock.cancel(key);
    if (word) {
      const ticks =
          BigInt(Math.max(1, word & 0xffff)) * BigInt((word >>> 16) + 1),
        delay =
          (ticks * 1000000000n + BigInt(this.config.counter_hz) - 1n) /
          BigInt(this.config.counter_hz);
      this.clock.schedule(key, this.clock.now + delay, () =>
        this.signal(16 + channel),
      );
    }
  }
  frame(): void {
    for (let channel = 0; channel < this.counters.length; channel++)
      if (this.counters[channel] && !this.clock.has(`gpio:timer:${channel}`))
        this.arm(channel);
  }
  read(address: number, size: number): bigint {
    return readBytes(size, (i) => {
      const at = address - this.config.base + i;
      if (at >= 0x50)
        return this.counters[(at - 0x50) >>> 2]! >>> ((at & 3) * 8);
      return (
        (at < 0x20
          ? this.status[at >>> 2]!
          : this.masks[(at - 0x20) >>> 2]!) >>>
        ((at & 3) * 8)
      );
    });
  }
  write(address: number, size: number, value: bigint): void {
    if (address >= this.config.base + 0x50) {
      const affected = new Set<number>();
      writeBytes(size, value, (i, byte) => {
        const at = address - this.config.base - 0x50 + i,
          channel = at >>> 2,
          shift = (at & 3) * 8;
        this.counters[channel] =
          ((this.counters[channel]! & ~(255 << shift)) | (byte << shift)) >>> 0;
        affected.add(channel);
      });
      for (const channel of affected) this.arm(channel);
      return;
    }
    writeBytes(size, value, (i, byte) => {
      const at = address - this.config.base + i,
        bank = (at & 0x1f) >>> 2,
        shift = (at & 3) * 8;
      if (at < 0x20)
        this.status[bank] = (this.status[bank]! & ~(byte << shift)) >>> 0;
      else
        this.masks[bank] =
          ((this.masks[bank]! & ~(255 << shift)) | (byte << shift)) >>> 0;
    });
    this.update();
  }
  reset(): void {
    this.status.fill(0);
    this.masks.fill(0);
    this.counters.fill(0);
    for (let channel = 0; channel < 14; channel++)
      this.clock.cancel(`gpio:timer:${channel}`);
    this.update();
  }
}
