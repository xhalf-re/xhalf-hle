import type { Gic } from '../runtime/gic';
import {
  readBytes,
  writeBytes,
  type MmioDevice,
  type VirtualEvents,
} from './bus';
export interface FrontendRegisters {
  base: number;
  port_base: number;
  port_stride: number;
  interface_types: number[];
  irq: number;
  frame_interval_ns: number;
  transition_ns: number;
  sync_width_ns: number;
  readout_ns: number;
}
/** Nominal sensor links and frame-boundary/DMA completion; firmware owns preview policy. */
export class SensorFrontend implements MmioDevice {
  readonly ranges;
  private status = new Uint32Array(6);
  private masks = new Uint32Array(6);
  private ports: Uint8Array;
  private scheduled = false;
  frames = 0;
  synchronizations = 0;
  constructor(
    readonly config: FrontendRegisters,
    private clock: VirtualEvents,
    private gic: Gic,
    private signalGpio: (source: number) => void = () => {},
    private gpioFrame: () => void = () => {},
    private captureFrame: (port: number, start: boolean) => void = () => {},
  ) {
    this.ranges = [
      [config.base, 0x38],
      [config.port_base, config.port_stride * config.interface_types.length],
    ] as const;
    this.ports = new Uint8Array(
      config.port_stride * config.interface_types.length,
    );
    for (let port = 0; port < config.interface_types.length; port++)
      this.ports[port * config.port_stride + 0x80] = 2;
    this.frameClock();
  }
  synchronizationDelay(module: number): bigint | undefined {
    if (module !== 2) return undefined;
    this.synchronizations++;
    return BigInt(
      this.config.interface_types.some((_, port) => this.streaming(port))
        ? this.config.frame_interval_ns
        : this.config.transition_ns,
    );
  }
  interfaceType(port: number): number {
    return this.config.interface_types[port] ?? 0;
  }
  private updateIrq(): void {
    this.gic.setLevel(
      this.config.irq,
      this.status.some((s, i) => !!(s & this.masks[i]!)),
    );
  }
  signal(source: number): void {
    const bank = source >>> 5;
    this.status[bank] = (this.status[bank]! | (1 << (source & 31))) >>> 0;
    this.updateIrq();
  }
  private streaming(port: number): boolean {
    return (
      !!this.interfaceType(port) &&
      !(this.ports[port * this.config.port_stride + 0x80]! & 2)
    );
  }
  private frameClock(): void {
    const active = this.config.interface_types.some(Boolean);
    if (!active) {
      this.clock.cancel('sensor:frame');
      this.scheduled = false;
      return;
    }
    if (this.scheduled) return;
    this.scheduled = true;
    this.clock.schedule(
      'sensor:frame',
      this.clock.now + BigInt(this.config.frame_interval_ns),
      () => {
        this.scheduled = false;
        this.gpioFrame();
        const raise = (source: number) => {
          const bank = source >>> 5;
          this.status[bank] = (this.status[bank]! | (1 << (source & 31))) >>> 0;
        };
        for (let port = 0; port < this.config.interface_types.length; port++)
          if (this.interfaceType(port)) {
            const captured = this.streaming(port);
            if (captured) this.captureFrame(port, true);
            this.signalGpio(0x21 + port * 2);
            this.signalGpio(0x29 + port * 8);
            this.signalGpio(0x2a + port * 8);
            this.clock.schedule(
              `sensor:sync-end:${port}`,
              this.clock.now + BigInt(this.config.sync_width_ns),
              () => {
                this.signalGpio(0x20 + port * 2);
                if (captured && port === 0) {
                  raise(0);
                }
                this.updateIrq();
              },
            );
            this.clock.schedule(
              `sensor:readout-end:${port}`,
              this.clock.now + BigInt(this.config.readout_ns),
              () => {
                this.signalGpio(0x2b + port * 8);
                this.signalGpio(0x2c + port * 8);
                if (captured && port === 0)
                  for (const source of [3, 14]) raise(source);
                this.captureFrame(port, false);
                this.updateIrq();
              },
            );
            this.frames++;
          }
        this.updateIrq();
        this.frameClock();
      },
    );
  }
  read(address: number, size: number): bigint {
    return readBytes(size, (i) => {
      const at = address - this.config.base + i;
      if (at >= 0 && at < 0x18)
        return this.status[at >>> 2]! >>> ((at & 3) * 8);
      if (at >= 0x20 && at < 0x38)
        return this.masks[(at - 0x20) >>> 2]! >>> ((at & 3) * 8);
      if (address >= this.config.port_base)
        return this.ports[address - this.config.port_base + i]!;
      return 0;
    });
  }
  write(address: number, size: number, value: bigint): void {
    writeBytes(size, value, (i, byte) => {
      if (address >= this.config.port_base) {
        const at = address - this.config.port_base + i,
          port = Math.floor(at / this.config.port_stride),
          field = at % this.config.port_stride;
        if (field === 0x80) {
          this.ports[at] = (byte & ~2) | (this.ports[at]! & 2);
          this.clock.schedule(
            `sensor:link:${port}`,
            this.clock.now + BigInt(this.config.transition_ns),
            () => {
              this.ports[at] =
                (this.ports[at]! & ~2) | ((this.ports[at]! & 1) << 1);
              this.frameClock();
            },
          );
        } else this.ports[at] = byte;
      } else {
        const at = address - this.config.base + i;
        if (at < 0x18) {
          const bank = at >>> 2;
          this.status[bank] =
            (this.status[bank]! & ~(byte << ((at & 3) * 8))) >>> 0;
        } else if (at >= 0x20) {
          const bank = (at - 0x20) >>> 2,
            shift = (at & 3) * 8;
          this.masks[bank] =
            ((this.masks[bank]! & ~(255 << shift)) | (byte << shift)) >>> 0;
        }
      }
    });
    this.updateIrq();
    this.frameClock();
  }
  reset(): void {
    this.status.fill(0);
    this.masks.fill(0);
    this.ports.fill(0);
    this.frames = this.synchronizations = 0;
    this.scheduled = false;
    this.clock.cancel('sensor:frame');
    for (let port = 0; port < this.config.interface_types.length; port++) {
      this.ports[port * this.config.port_stride + 0x80] = 2;
      this.clock.cancel(`sensor:link:${port}`);
      this.clock.cancel(`sensor:sync-end:${port}`);
      this.clock.cancel(`sensor:readout-end:${port}`);
    }
    this.updateIrq();
  }
}
