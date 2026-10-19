import type { Gic } from '../runtime/gic';
import {
  readBytes,
  writeBytes,
  type MmioDevice,
  type VirtualEvents,
} from './bus';

export interface TimerRegisters {
  base: number;
  channels: number;
  stride: number;
  clock_hz: number;
  status: number;
  irq_enable: number;
  irq_disable: number;
  first_irq: number;
}
/** SPCA hardware timers. Firmware owns the wait lists and runs their IRQ callbacks. */
export class HardwareTimers implements MmioDevice {
  readonly ranges;
  private registers: Uint8Array;
  private started: bigint[];
  private active = new Set<number>();
  private counters: number[];
  private status = 0;
  private enabled = 0;
  firings = 0;
  constructor(
    readonly config: TimerRegisters,
    private clock: VirtualEvents,
    private gic: Gic,
  ) {
    this.ranges = [
      [config.base, config.channels * config.stride],
      [config.status, 4],
      [config.irq_enable, 4],
      [config.irq_disable, 4],
    ] as const;
    this.registers = new Uint8Array(config.channels * config.stride);
    this.started = Array(config.channels).fill(0n) as bigint[];
    this.counters = Array(config.channels).fill(0) as number[];
  }
  private key(channel: number): string {
    return `timer:${channel}`;
  }
  private word(channel: number, offset: number): number {
    return new DataView(this.registers.buffer).getUint32(
      channel * this.config.stride + offset,
      true,
    );
  }
  private divider(channel: number): bigint {
    return BigInt(
      new DataView(this.registers.buffer).getUint16(
        channel * this.config.stride + 2,
        true,
      ) + 1,
    );
  }
  private period(channel: number): bigint {
    const numerator =
      BigInt(Math.max(1, this.word(channel, 4))) *
      this.divider(channel) *
      1000000000n;
    return (
      (numerator + BigInt(this.config.clock_hz) - 1n) /
      BigInt(this.config.clock_hz)
    );
  }
  private updateIrq(): void {
    for (let ch = 0; ch < this.config.channels; ch++)
      this.gic.setLevel(
        this.config.first_irq + ch,
        !!(this.status & this.enabled & (1 << ch)),
      );
  }
  private counter(channel: number): number {
    if (!this.active.has(channel)) return this.counters[channel]!;
    return Number(
      (((this.clock.now - this.started[channel]!) *
        BigInt(this.config.clock_hz)) /
        (this.divider(channel) * 1000000000n)) &
        0xffffffffn,
    );
  }
  private arm(channel: number): void {
    this.clock.cancel(this.key(channel));
    this.counters[channel] = this.counter(channel);
    this.active.delete(channel);
    if (!(this.registers[channel * this.config.stride]! & 1)) return;
    this.started[channel] = this.clock.now;
    this.counters[channel] = 0;
    this.active.add(channel);
    const fire = () => {
      this.status = (this.status | (1 << channel)) >>> 0;
      this.firings++;
      if (!(this.registers[channel * this.config.stride]! & 0x10)) {
        this.counters[channel] = this.word(channel, 4);
        this.active.delete(channel);
      }
      this.updateIrq();
      if (this.registers[channel * this.config.stride]! & 0x10) {
        const period = this.period(channel),
          start = this.started[channel]!;
        const next = start + ((this.clock.now - start) / period + 1n) * period;
        this.started[channel] = next - period;
        this.clock.schedule(this.key(channel), next, fire);
      }
    };
    this.clock.schedule(
      this.key(channel),
      this.clock.now + this.period(channel),
      fire,
    );
  }
  read(address: number, size: number): bigint {
    if (
      address >= this.config.base &&
      address < this.config.base + this.registers.length
    ) {
      const offset = address - this.config.base;
      return readBytes(size, (i) => {
        const at = offset + i,
          channel = Math.floor(at / this.config.stride),
          field = at % this.config.stride;
        if (field >= 8 && field < 12) {
          return this.counter(channel) >>> ((field - 8) * 8);
        }
        return this.registers[at]!;
      });
    }
    const base =
      address >= this.config.irq_disable
        ? this.config.irq_disable
        : address >= this.config.irq_enable
          ? this.config.irq_enable
          : this.config.status;
    const value = base === this.config.status ? this.status : this.enabled;
    return readBytes(size, (i) => value >>> ((address - base + i) * 8));
  }
  write(address: number, size: number, value: bigint): void {
    if (
      address >= this.config.base &&
      address < this.config.base + this.registers.length
    ) {
      const offset = address - this.config.base;
      writeBytes(size, value, (i, byte) => {
        this.registers[offset + i] = byte;
      });
      const channel = Math.floor(offset / this.config.stride),
        field = offset % this.config.stride;
      if (field < 8) this.arm(channel);
      return;
    }
    const bits = Number(value) >>> 0;
    if (address === this.config.status)
      this.status = (this.status & ~bits) >>> 0;
    else if (address === this.config.irq_enable)
      this.enabled = (this.enabled | bits) >>> 0;
    else if (address === this.config.irq_disable)
      this.enabled = (this.enabled & ~bits) >>> 0;
    this.updateIrq();
  }
  reset(): void {
    this.registers.fill(0);
    this.status = this.enabled = this.firings = 0;
    this.started.fill(this.clock.now);
    this.active.clear();
    this.counters.fill(0);
    for (let ch = 0; ch < this.config.channels; ch++)
      this.clock.cancel(this.key(ch));
    this.updateIrq();
  }
}
