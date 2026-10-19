import { readBytes, writeBytes, type MmioDevice } from './bus';
export interface ClockRegisters {
  clear: number;
  set: number;
  banks: number;
}
/** Clock gates have write-one set/clear aliases and share their latched readback. */
export class ClockGates implements MmioDevice {
  readonly ranges;
  private enabled: Uint32Array;
  constructor(readonly config: ClockRegisters) {
    this.ranges = [
      [config.clear, config.banks * 4],
      [config.set, config.banks * 4],
    ] as const;
    this.enabled = new Uint32Array(config.banks);
  }
  read(address: number, size: number): bigint {
    const base =
      address >= this.config.set ? this.config.set : this.config.clear;
    return readBytes(
      size,
      (i) =>
        this.enabled[(address - base + i) >>> 2]! >>>
        (((address - base + i) & 3) * 8),
    );
  }
  write(address: number, size: number, value: bigint): void {
    const set = address >= this.config.set,
      base = set ? this.config.set : this.config.clear;
    writeBytes(size, value, (i, byte) => {
      const at = address - base + i,
        bank = at >>> 2,
        bits = byte << ((at & 3) * 8);
      this.enabled[bank] =
        (set ? this.enabled[bank]! | bits : this.enabled[bank]! & ~bits) >>> 0;
    });
  }
  reset(): void {
    this.enabled.fill(0);
  }
}
