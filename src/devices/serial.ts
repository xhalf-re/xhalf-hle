import {
  readBytes,
  writeBytes,
  type MmioDevice,
  type VirtualEvents,
} from './bus';
export interface SerialRegisters {
  base: number;
  ports: number;
  stride: number;
  transfer_ns: number;
}
/** Synchronous serial transfer engines: trigger/busy bits retire on guest-time deadlines. */
export class SerialControllers implements MmioDevice {
  readonly ranges;
  private registers: Uint8Array;
  transfers = 0;
  constructor(
    readonly config: SerialRegisters,
    private clock: VirtualEvents,
  ) {
    this.ranges = [[config.base, config.ports * config.stride]] as const;
    this.registers = new Uint8Array(config.ports * config.stride);
  }
  read(address: number, size: number): bigint {
    return readBytes(
      size,
      (i) => this.registers[address - this.config.base + i]!,
    );
  }
  write(address: number, size: number, value: bigint): void {
    writeBytes(size, value, (i, byte) => {
      const at = address - this.config.base + i,
        field = at % this.config.stride;
      this.registers[at] = byte;
      if (field === 4 || field === 0x44) {
        const key = `serial:${at}`;
        this.clock.cancel(key);
        if (byte & 1)
          this.clock.schedule(
            key,
            this.clock.now + BigInt(this.config.transfer_ns),
            () => {
              this.registers[at] = this.registers[at]! & ~1;
              this.transfers++;
            },
          );
      }
    });
  }
  reset(): void {
    this.registers.fill(0);
    this.transfers = 0;
    for (let port = 0; port < this.config.ports; port++)
      for (const field of [4, 0x44])
        this.clock.cancel(`serial:${port * this.config.stride + field}`);
  }
}
