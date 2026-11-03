import type { VirtualEvents } from './bus';
import type { I2cTarget } from './i2c';
import type { GpioInputs } from './gpio-input';

type PointerEpoch = { host: number; native?: bigint };
type Sample = {
  action: 'down' | 'move' | 'up' | 'cancel';
  x: number;
  y: number;
  pointer: PointerEpoch;
  elapsed: number;
};
export interface TouchConfig {
  port: number;
  address: number;
  irq_pin: number;
  width: number;
  height: number;
  sample_interval_ns: number;
  queue_limit: number;
}

/** A single-contact capacitive chip. The original ARM driver decodes its reports. */
export class TouchController implements I2cTarget {
  readonly samples: Sample[] = [];
  private registers = new Uint8Array(256);
  private epoch: PointerEpoch | undefined;
  private held = false;
  private last: { x: number; y: number } | undefined;
  private contact: { x: number; y: number } | undefined;
  private unread = false;
  private reportUntil = 0n;
  events = 0;
  ignored = 0;
  scans = 0;
  reports = 0;
  constructor(
    readonly config: TouchConfig,
    private clock: VirtualEvents,
    private gpio: GpioInputs,
  ) {
    this.registers[0x3f] = 1; // Number of supported contacts.
  }
  get busy(): boolean {
    return (
      this.samples.length > 0 ||
      this.contact !== undefined ||
      (this.unread && this.clock.now < this.reportUntil)
    );
  }
  get settled(): boolean {
    return !this.busy && this.clock.now >= this.reportUntil;
  }
  pointer(action: Sample['action'], x: number, y: number, time: number): void {
    if (action === 'cancel') return this.cancelPointer();
    if (
      !Number.isInteger(x) ||
      !Number.isInteger(y) ||
      x < 0 ||
      y < 0 ||
      x >= this.config.width ||
      y >= this.config.height ||
      !Number.isFinite(time) ||
      time < 0
    )
      throw new Error('Invalid normalized pointer sample');
    if (action === 'down') {
      if (this.held) this.cancelPointer();
      this.held = true;
      this.epoch = { host: time };
    } else if (!this.held) return;
    if (
      action === 'up' &&
      this.last &&
      (x !== this.last.x || y !== this.last.y)
    )
      this.pointer('move', x, y, time);
    if (action === 'move' && x === this.last?.x && y === this.last.y) return;
    const pointer = this.epoch!,
      elapsed = Math.max(0, time - pointer.host),
      previous = this.samples.at(-1);
    if (
      action === 'move' &&
      previous?.action === 'move' &&
      previous.pointer === pointer
    )
      Object.assign(previous, { x, y, elapsed });
    else {
      if (this.samples.length >= this.config.queue_limit)
        throw new Error('Pointer queue limit reached');
      this.samples.push({ action, x, y, pointer, elapsed });
    }
    this.last = { x, y };
    if (action === 'up') this.held = false;
    this.schedule();
  }
  cancelPointer(): void {
    const pointer = this.epoch;
    if (!pointer) return;
    this.samples.splice(
      0,
      this.samples.length,
      ...this.samples.filter((sample) => sample.pointer !== pointer),
    );
    if (this.contact)
      this.samples.push({ action: 'cancel', x: 0, y: 0, pointer, elapsed: 0 });
    this.held = false;
    this.epoch = undefined;
    this.last = undefined;
    if (!this.samples.length && !this.contact) this.clock.cancel('touch:scan');
    this.schedule();
  }
  private schedule(): void {
    if (this.clock.has('touch:scan') || (!this.samples.length && !this.contact))
      return;
    this.clock.schedule(
      'touch:scan',
      this.clock.now + BigInt(this.config.sample_interval_ns),
      () => this.scan(),
    );
  }
  private scan(): void {
    const sample = this.samples[0];
    if (
      sample &&
      (sample.action === 'cancel' ||
        sample.pointer.native === undefined ||
        this.clock.now >=
          sample.pointer.native + BigInt(Math.round(sample.elapsed * 1e6)))
    ) {
      this.samples.shift();
      if (sample.action === 'down') sample.pointer.native = this.clock.now;
      this.contact =
        sample.action === 'up' || sample.action === 'cancel'
          ? undefined
          : sample;
      this.events++;
    }
    this.unread = true;
    this.reportUntil = this.clock.now + BigInt(this.config.sample_interval_ns);
    this.scans++;
    this.gpio.signal(this.config.irq_pin, true);
    this.gpio.signal(this.config.irq_pin, false);
    this.schedule();
  }
  read(register: number, length: number): Uint8Array {
    const x = this.contact?.y ?? 0,
      y = this.contact ? this.config.width - this.contact.x : 0;
    let consumed = false;
    const bytes = Uint8Array.from({ length }, (_, i) => {
      const at = (register + i) & 255;
      if (at === 0x12)
        return (this.contact ? 0x80 : 0) | ((x >>> 8) << 4) | (y >>> 8);
      if (at === 0x13) return x & 255;
      if (at === 0x14) {
        consumed = true;
        return y & 255;
      }
      return this.registers[at]!;
    });
    if (consumed) {
      this.unread = false;
      this.reports++;
      this.gpio.signal(this.config.irq_pin, true);
    }
    return bytes;
  }
  write(register: number, bytes: Uint8Array): void {
    for (let i = 0; i < bytes.length; i++) {
      const at = (register + i) & 255;
      if (at !== 0x3f && (at < 0x12 || at > 0x14))
        this.registers[at] = bytes[i]!;
    }
  }
  reset(): void {
    this.clock.cancel('touch:scan');
    this.samples.length = 0;
    this.registers.fill(0);
    this.registers[0x3f] = 1;
    this.contact = this.epoch = this.last = undefined;
    this.held = this.unread = false;
    this.reportUntil = 0n;
    this.events = this.ignored = this.scans = this.reports = 0;
    this.gpio.signal(this.config.irq_pin, true);
  }
}
