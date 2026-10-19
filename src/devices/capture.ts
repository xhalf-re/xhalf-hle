import {
  readBytes,
  writeBytes,
  type MmioDevice,
  type VirtualEvents,
} from './bus';

export interface CaptureRegisters {
  base: number;
  ports: number;
  stride: number;
  reset_ns: number;
}

/** Raw capture DMA control and circular buffer indices, driven by receiver frames. */
export class CaptureDma implements MmioDevice {
  readonly ranges;
  private registers: Uint8Array;
  private active: boolean[];
  frames = 0;
  constructor(
    readonly config: CaptureRegisters,
    private clock: VirtualEvents,
    private signal: (source: number) => void,
  ) {
    this.ranges = [[config.base, config.ports * config.stride]] as const;
    this.registers = new Uint8Array(config.ports * config.stride);
    this.active = Array(config.ports * 2).fill(false) as boolean[];
  }
  frame(port: number, start: boolean): void {
    const base = port * this.config.stride;
    for (let lane = 0; lane < 2; lane++) {
      const channel = port * 2 + lane,
        control = base + 0x10 + lane * 0x30;
      if (start) {
        this.active[channel] = !!(this.registers[base + lane]! & 1);
        if (this.active[channel]) this.signal(25 + channel);
      } else if (this.active[channel]) {
        this.active[channel] = false;
        const ring = this.registers[control + 4]!;
        if (ring & 1)
          this.registers[control + 5] =
            (this.registers[control + 5]! + 1) % (ring & 2 ? 2 : 4);
        this.frames++;
        this.signal(37 + channel);
      }
    }
  }
  read(address: number, size: number): bigint {
    return readBytes(
      size,
      (i) => this.registers[address - this.config.base + i]!,
    );
  }
  write(address: number, size: number, value: bigint): void {
    writeBytes(size, value, (i, byte) => {
      const at = address - this.config.base + i;
      this.registers[at] = byte;
      if ([0x14, 0x44].includes(at % this.config.stride))
        this.registers[at + 1] = (byte >>> 4) & 3;
      if (at % this.config.stride === 2) {
        const port = Math.floor(at / this.config.stride),
          key = `capture:reset:${port}`;
        this.clock.cancel(key);
        if (byte & 1)
          this.clock.schedule(
            key,
            this.clock.now + BigInt(this.config.reset_ns),
            () => {
              this.registers[at] = this.registers[at]! & ~1;
              this.registers[port * this.config.stride + 0x15] = 0;
              this.registers[port * this.config.stride + 0x45] = 0;
            },
          );
      }
    });
  }
  reset(): void {
    this.registers.fill(0);
    this.active.fill(false);
    this.frames = 0;
    for (let port = 0; port < this.config.ports; port++)
      this.clock.cancel(`capture:reset:${port}`);
  }
}
