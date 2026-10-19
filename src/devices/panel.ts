import type { Gic } from '../runtime/gic';
import {
  readBytes,
  writeBytes,
  type MmioDevice,
  type VirtualEvents,
} from './bus';
export interface PanelRegisters {
  base: number;
  irq: number;
  transfer_ns: number;
  frame_interval_ns: number;
}
/** MIPI command transport and DCS power state; native initialization tables remain guest code. */
export class PanelController implements MmioDevice {
  readonly ranges;
  private registers = new Uint8Array(0x810);
  private status = [0, 0];
  private masks = [0, 0];
  private power = 0x88;
  transfers = 0;
  vsyncs = 0;
  scanAcknowledgements = 0;
  coalescedVsyncs = 0;
  private vsyncScheduled = false;
  private nextVsync = 0n;
  constructor(
    readonly config: PanelRegisters,
    private clock: VirtualEvents,
    private gic: Gic,
  ) {
    this.ranges = [
      [config.base, 0x24],
      [config.base + 0x700, 0x100],
      [config.base + 0x800, 0x10],
    ] as const;
  }
  private updateIrq(): void {
    this.gic.setLevel(
      this.config.irq,
      !!(
        (this.status[0]! & this.masks[0]!) |
        (this.status[1]! & this.masks[1]!)
      ),
    );
  }
  read(address: number, size: number): bigint {
    return readBytes(size, (i) => {
      const at = address - this.config.base + i;
      if (at < 4) return this.status[0]! >>> ((at & 3) * 8);
      if (at < 8) return this.masks[0]! >>> ((at & 3) * 8);
      if (at >= 0x800 && at < 0x804) return this.status[1]! >>> ((at & 3) * 8);
      if (at >= 0x808 && at < 0x80c) return this.masks[1]! >>> ((at & 3) * 8);
      return this.registers[at]!;
    });
  }
  private scanSources(): number {
    return (
      (this.registers[0x20]! & 1 ? 0xb : 0) |
      (this.registers[0x21]! & 1 ? 0xb00 : 0)
    );
  }
  private syncClock(): void {
    if (!this.scanSources()) {
      this.clock.cancel('panel:vsync');
      this.vsyncScheduled = false;
      this.nextVsync = 0n;
      return;
    }
    if (this.vsyncScheduled) return;
    this.vsyncScheduled = true;
    const interval = BigInt(this.config.frame_interval_ns);
    if (!this.nextVsync) this.nextVsync = this.clock.now + interval;
    this.clock.schedule('panel:vsync', this.nextVsync, () => {
      this.vsyncScheduled = false;
      const sources = this.scanSources(),
        ticks = (this.clock.now - this.nextVsync) / interval + 1n;
      this.nextVsync += ticks * interval;
      this.coalescedVsyncs +=
        Number(ticks) - (this.status[0]! & this.masks[0]! & sources ? 0 : 1);
      this.status[0] = (this.status[0]! | sources) >>> 0;
      this.vsyncs += Number(ticks);
      this.updateIrq();
      this.syncClock();
    });
  }
  private transfer(channel: number): void {
    const type = this.registers[0x739]! & 0x3f,
      mode = this.registers[0x730 + channel]! & 0xc,
      command = this.registers[type === 0x39 || type === 0x29 ? 0x7a0 : 0x73a]!;
    if (type === 5 || type === 0x15 || type === 0x39) {
      if (command === 1) this.power = 0x88;
      else if (command === 0x11) this.power = this.power! | 0x10;
      else if (command === 0x10) this.power = this.power! & ~0x10;
      else if (command === 0x29) this.power = this.power! | 0xc;
      else if (command === 0x28) this.power = this.power! & ~4;
    }
    this.clock.schedule(
      `panel:${channel}`,
      this.clock.now + BigInt(this.config.transfer_ns),
      () => {
        this.registers[0x730 + channel] = this.registers[0x730 + channel]! & ~1;
        this.status[0] =
          (this.status[0]! | ((1 << 25) | (mode ? 1 << 26 : 0))) >>> 0;
        if (type === 6) {
          this.registers.fill(0, 0x760, 0x770);
          this.registers[0x750] = 4;
          this.registers[0x760] = 0x21;
          this.registers[0x762] = command === 0x0a ? this.power! : 0;
          this.status[0] = (this.status[0]! | (1 << 29)) >>> 0;
        }
        this.transfers++;
        this.updateIrq();
      },
    );
  }
  write(address: number, size: number, value: bigint): void {
    writeBytes(size, value, (i, byte) => {
      const at = address - this.config.base + i;
      if (at < 4) {
        const cleared =
          this.status[0]! & this.masks[0]! & (byte << ((at & 3) * 8));
        if (cleared & 0xb0b) this.scanAcknowledgements++;
        this.status[0] = (this.status[0]! & ~(byte << ((at & 3) * 8))) >>> 0;
      } else if (at < 8)
        this.masks[0] =
          ((this.masks[0]! & ~(255 << ((at & 3) * 8))) |
            (byte << ((at & 3) * 8))) >>>
          0;
      else if (at >= 0x800 && at < 0x804)
        this.status[1] = (this.status[1]! & ~(byte << ((at & 3) * 8))) >>> 0;
      else if (at >= 0x808 && at < 0x80c)
        this.masks[1] =
          ((this.masks[1]! & ~(255 << ((at & 3) * 8))) |
            (byte << ((at & 3) * 8))) >>>
          0;
      else {
        this.registers[at] = byte;
        if ((at === 0x730 || at === 0x731) && byte & 1)
          this.transfer(at - 0x730);
      }
    });
    this.updateIrq();
    this.syncClock();
  }
  reset(): void {
    this.registers.fill(0);
    this.status.fill(0);
    this.masks.fill(0);
    this.power = 0x88;
    this.transfers = 0;
    this.clock.cancel('panel:vsync');
    this.vsyncScheduled = false;
    this.nextVsync = 0n;
    this.vsyncs = this.scanAcknowledgements = this.coalescedVsyncs = 0;
    this.clock.cancel('panel:0');
    this.clock.cancel('panel:1');
    this.updateIrq();
  }
}
