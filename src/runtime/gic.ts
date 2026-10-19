import { readBytes, writeBytes, type MmioDevice } from '../devices/bus';

const IRQ_COUNT = 256;
const SPURIOUS = 1023;

/** Single CPU GIC with eight priority bits and no Security Extensions. */
export class Gic implements MmioDevice {
  readonly ranges: readonly (readonly [number, number])[];
  readonly pending = new Set<number>();
  readonly active = new Set<number>();
  private levels = new Set<number>();
  private latched = new Set<number>();
  private enabled = new Uint8Array(IRQ_COUNT);
  private priority = new Uint8Array(IRQ_COUNT);
  private targets = new Uint8Array(IRQ_COUNT);
  private edge = new Uint8Array(IRQ_COUNT);
  private stack: { irq: number; priority: number }[] = [];
  private distributorEnabled = false;
  private cpuEnabled = false;
  private pmr = 0;
  private bpr = 0;
  private line = false;

  constructor(
    private config = { distributor: 0x1000, cpu_interface: 0x2000 },
    private output: (asserted: boolean) => void = () => {},
  ) {
    this.ranges = [
      [config.distributor, 0x1000],
      [config.cpu_interface, 0x1000],
    ];
    this.reset();
  }
  reset(): void {
    this.pending.clear();
    this.active.clear();
    this.levels.clear();
    this.latched.clear();
    this.enabled.fill(0);
    this.enabled.fill(1, 0, 16); // SGIs are always enabled.
    this.priority.fill(0);
    this.targets.fill(0);
    this.targets.fill(1, 0, 32);
    this.edge.fill(0);
    this.edge.fill(1, 0, 16);
    this.stack = [];
    this.distributorEnabled = this.cpuEnabled = false;
    this.pmr = this.bpr = 0;
    this.update();
  }
  private valid(irq: number): boolean {
    return Number.isInteger(irq) && irq >= 0 && irq < IRQ_COUNT;
  }
  setLevel(irq: number, asserted: boolean): void {
    if (!this.valid(irq)) throw new RangeError('GIC IRQ out of range');
    if (this.levels.has(irq) === asserted) return;
    if (asserted) {
      if (!this.levels.has(irq) && this.edge[irq]) this.latched.add(irq);
      this.levels.add(irq);
    } else this.levels.delete(irq);
    this.refreshPending(irq);
    this.update();
  }
  /** Pulse/event input, also retained while an interrupt is active or masked. */
  raise(irq: number): void {
    if (!this.valid(irq)) throw new RangeError('GIC IRQ out of range');
    this.latched.add(irq);
    this.refreshPending(irq);
    this.update();
  }
  private refreshPending(irq: number): void {
    if (this.latched.has(irq) || (!this.edge[irq] && this.levels.has(irq)))
      this.pending.add(irq);
    else this.pending.delete(irq);
  }
  /** Highest enabled pending priority; equal priorities use the lowest ID. */
  highest(): number {
    if (!this.distributorEnabled || !this.cpuEnabled) return SPURIOUS;
    let best = SPURIOUS,
      priority = this.pmr;
    for (const irq of this.pending) {
      const p = this.priority[irq]!;
      if (
        this.enabled[irq] &&
        this.targets[irq]! & 1 &&
        !this.active.has(irq) &&
        (p < priority || (p === priority && irq < best && best !== SPURIOUS))
      ) {
        best = irq;
        priority = p;
      }
    }
    return best;
  }
  get runningPriority(): number {
    return this.stack.at(-1)?.priority ?? 0xff;
  }
  private deliverable(): number {
    const irq = this.highest();
    if (irq === SPURIOUS) return irq;
    return !this.stack.length || this.priority[irq]! < this.runningPriority
      ? irq
      : SPURIOUS;
  }
  private update(): void {
    const asserted = this.deliverable() !== SPURIOUS;
    if (asserted !== this.line) {
      this.line = asserted;
      this.output(asserted);
    }
  }
  acknowledge(): number {
    const irq = this.deliverable();
    if (irq !== SPURIOUS) {
      this.latched.delete(irq);
      this.refreshPending(irq);
      this.active.add(irq);
      this.stack.push({
        irq,
        priority: this.priority[irq]! & (0xff << (this.bpr + 1)),
      });
      this.update();
    }
    return irq;
  }
  complete(value: number): void {
    const irq = value & 0x3ff;
    if (this.stack.at(-1)?.irq !== irq) return;
    this.stack.pop();
    this.active.delete(irq);
    this.update();
  }
  private bitmap(offset: number, has: (irq: number) => boolean): number {
    const first = offset * 8;
    let value = 0;
    for (let bit = 0; bit < 8; bit++)
      if (first + bit < IRQ_COUNT && has(first + bit)) value |= 1 << bit;
    return value;
  }
  private readDistributor(offset: number): number {
    if (offset === 0) return Number(this.distributorEnabled);
    if (offset === 4) return IRQ_COUNT / 32 - 1;
    if (offset >= 8 && offset < 12)
      return (0x0102043b >>> ((offset - 8) * 8)) & 255;
    if (offset >= 0x100 && offset < 0x200)
      return this.bitmap((offset - 0x100) % 0x80, (irq) => !!this.enabled[irq]);
    if (offset >= 0x200 && offset < 0x300)
      return this.bitmap((offset - 0x200) % 0x80, (irq) =>
        this.pending.has(irq),
      );
    if (offset >= 0x300 && offset < 0x400)
      return this.bitmap((offset - 0x300) % 0x80, (irq) =>
        this.active.has(irq),
      );
    if (offset >= 0x400 && offset < 0x800)
      return this.priority[offset - 0x400] ?? 0;
    if (offset >= 0x800 && offset < 0xc00)
      return this.targets[offset - 0x800] ?? 0;
    if (offset >= 0xc00 && offset < 0xd00) {
      let value = 0;
      for (let i = 0; i < 4; i++)
        value |= (this.edge[(offset - 0xc00) * 4 + i] ?? 0) << (i * 2 + 1);
      return value;
    }
    if (offset >= 0xf10 && offset < 0xf30)
      return Number(this.latched.has((offset - 0xf10) % 16));
    return 0;
  }
  private writeDistributor(offset: number, value: number): void {
    if (offset === 0) this.distributorEnabled = !!(value & 1);
    else if (offset >= 0x100 && offset < 0x400) {
      const bank = offset & ~0x7f,
        first = (offset & 0x7f) * 8;
      for (let bit = 0; bit < 8 && first + bit < IRQ_COUNT; bit++) {
        if (!(value & (1 << bit))) continue;
        const irq = first + bit;
        if (bank === 0x100 && irq >= 16) this.enabled[irq] = 1;
        if (bank === 0x180 && irq >= 16) this.enabled[irq] = 0;
        if (bank === 0x200 && irq >= 16) this.latched.add(irq);
        if (bank === 0x280 && irq >= 16) this.latched.delete(irq);
        if (bank === 0x300) this.active.add(irq);
        if (bank === 0x380) this.active.delete(irq);
        this.refreshPending(irq);
      }
    } else if (offset >= 0x400 && offset < 0x400 + IRQ_COUNT)
      this.priority[offset - 0x400] = value;
    else if (offset >= 0x820 && offset < 0x800 + IRQ_COUNT)
      this.targets[offset - 0x800] = value & 1;
    else if (offset >= 0xc04 && offset < 0xc00 + IRQ_COUNT / 4) {
      for (let i = 0; i < 4; i++) {
        const irq = (offset - 0xc00) * 4 + i;
        this.edge[irq] = (value >> (i * 2 + 1)) & 1;
        this.refreshPending(irq);
      }
    } else if (offset >= 0xf10 && offset < 0xf30 && value & 1) {
      const irq = (offset - 0xf10) % 16;
      if (offset < 0xf20) this.latched.delete(irq);
      else this.latched.add(irq);
      this.refreshPending(irq);
    }
  }
  read(address: number, size: number): bigint {
    if (
      address >= this.config.cpu_interface &&
      address < this.config.cpu_interface + 0x1000
    ) {
      const offset = address - this.config.cpu_interface;
      if (size !== 4 || offset % 4) return 0n;
      return BigInt(
        offset === 0
          ? Number(this.cpuEnabled)
          : offset === 4
            ? this.pmr
            : offset === 8
              ? this.bpr
              : offset === 0xc
                ? this.acknowledge()
                : offset === 0x14
                  ? this.runningPriority
                  : offset === 0x18
                    ? this.highest()
                    : offset === 0xfc
                      ? 0x0102043b
                      : 0,
      );
    }
    return readBytes(size, (i) =>
      this.readDistributor(address - this.config.distributor + i),
    );
  }
  write(address: number, size: number, value: bigint): void {
    const offset = address - this.config.cpu_interface;
    if (offset >= 0 && offset < 0x1000) {
      if (size !== 4 || offset % 4) return;
      const v = Number(value & 0xffffffffn);
      if (offset === 0) this.cpuEnabled = !!(v & 1);
      if (offset === 4) this.pmr = v & 255;
      if (offset === 8) this.bpr = v & 7;
      if (offset === 0x10) this.complete(v);
    } else if (address - this.config.distributor === 0xf00 && size === 4) {
      const v = Number(value),
        filter = (v >>> 24) & 3;
      if (filter === 2 || (filter === 0 && v & 0x10000)) this.raise(v & 15);
    } else
      writeBytes(size, value, (i, byte) =>
        this.writeDistributor(address - this.config.distributor + i, byte),
      );
    this.update();
  }
}
