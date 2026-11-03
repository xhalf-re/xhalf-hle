import type { Gic } from '../runtime/gic';
import { readBytes, writeBytes, type MmioDevice } from './bus';

export interface GpioInputConfig {
  edge_base: number;
  rising_irq: number;
  falling_irq: number;
  pins: number;
  inputs: { address: number; size: number; reset: number }[];
}

/** External input levels and the board's independent rising/falling IRQ banks. */
export class GpioInputs implements MmioDevice {
  readonly ranges;
  private status = new Uint32Array(2);
  private masks = new Uint32Array(2);
  private levels = 0xffffffff;
  private inputs: Uint32Array;
  edges = 0;
  constructor(
    readonly config: GpioInputConfig,
    private gic: Gic,
  ) {
    this.ranges = [
      [config.edge_base, 24],
      ...config.inputs.map(({ address, size }) => [address, size]),
    ] as [number, number][];
    this.inputs = Uint32Array.from(config.inputs, (input) => input.reset);
  }
  enabled(pin: number, falling = true): boolean {
    return !!(this.masks[Number(falling)]! & (1 << pin));
  }
  signal(pin: number, high: boolean): void {
    if (!Number.isInteger(pin) || pin < 0 || pin >= this.config.pins)
      throw new RangeError('External GPIO pin outside board');
    const bit = 1 << pin;
    if (!!(this.levels & bit) === high) return;
    this.levels = (high ? this.levels | bit : this.levels & ~bit) >>> 0;
    const bank = Number(!high);
    this.status[bank] = (this.status[bank]! | bit) >>> 0;
    this.edges++;
    this.update();
  }
  drive(address: number, mask: number, high: boolean): void {
    const index = this.config.inputs.findIndex(
      (input) => input.address === address,
    );
    if (index < 0) throw new RangeError('Unknown GPIO input register');
    this.inputs[index] =
      (high ? this.inputs[index]! | mask : this.inputs[index]! & ~mask) >>> 0;
  }
  private update(): void {
    for (let bank = 0; bank < 2; bank++)
      for (let pin = 0; pin < this.config.pins; pin++)
        this.gic.setLevel(
          (bank ? this.config.falling_irq : this.config.rising_irq) + pin,
          !!(this.status[bank]! & this.masks[bank]! & (1 << pin)),
        );
  }
  read(address: number, size: number): bigint {
    return readBytes(size, (i) => {
      const at = address + i,
        offset = at - this.config.edge_base;
      if (offset >= 0 && offset < 24) {
        const word =
          offset < 8
            ? this.status[offset >>> 2]!
            : this.masks[offset < 16 ? 0 : 1]!;
        return word >>> ((offset & 3) * 8);
      }
      const index = this.config.inputs.findIndex(
        (input) => at >= input.address && at < input.address + input.size,
      );
      return index < 0
        ? 0
        : this.inputs[index]! >>>
            ((at - this.config.inputs[index]!.address) * 8);
    });
  }
  write(address: number, size: number, value: bigint): void {
    writeBytes(size, value, (i, byte) => {
      const offset = address + i - this.config.edge_base;
      if (offset < 0 || offset >= 24) return; // Data-in registers are read-only.
      const bits = (byte << ((offset & 3) * 8)) >>> 0;
      if (offset < 8)
        this.status[offset >>> 2] = (this.status[offset >>> 2]! & ~bits) >>> 0;
      else {
        const bank = offset < 16 ? 0 : 1;
        this.masks[bank] =
          (offset & 4
            ? this.masks[bank]! & ~bits
            : this.masks[bank]! | bits) >>> 0;
      }
    });
    this.update();
  }
  reset(): void {
    this.status.fill(0);
    this.masks.fill(0);
    this.levels = 0xffffffff;
    this.inputs.set(this.config.inputs.map((input) => input.reset));
    this.edges = 0;
    this.update();
  }
}
