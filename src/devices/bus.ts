export interface MmioDevice {
  readonly ranges: readonly (readonly [number, number])[];
  read(address: number, size: number): bigint;
  write(address: number, size: number, value: bigint): void;
  reset(): void;
  synchronizationDelay?(module: number): bigint | undefined;
}

/** Device deadlines use guest time. Replacing/cancelling a key retains no stale events. */
export class VirtualEvents {
  now = 0n;
  private events = new Map<
    string,
    { at: bigint; serial: number; run: () => void }
  >();
  private serial = 0;
  private next: bigint | undefined;
  onDeadlineChanged: ((deadline: bigint | undefined) => void) | undefined;
  has(key: string): boolean {
    return this.events.has(key);
  }
  get pending(): number {
    return this.events.size;
  }
  get nextDeadline(): bigint | undefined {
    return this.next;
  }
  schedule(key: string, at: bigint, run: () => void): void {
    if (at <= this.now)
      throw new Error('Device deadline must be in the future');
    this.events.set(key, { at, serial: ++this.serial, run });
    this.findNext();
  }
  cancel(key: string): void {
    if (this.events.delete(key)) this.findNext();
  }
  private findNext(): void {
    const previous = this.next;
    this.next = undefined;
    for (const e of this.events.values())
      if (this.next === undefined || e.at < this.next) this.next = e.at;
    if (this.next !== previous) this.onDeadlineChanged?.(this.next);
  }
  advance(now: bigint): void {
    if (now < this.now) throw new Error('Device time cannot move backwards');
    this.now = now;
    while (this.next !== undefined && this.next <= now) {
      let selected:
        [string, { at: bigint; serial: number; run: () => void }] | undefined;
      for (const entry of this.events)
        if (
          !selected ||
          entry[1].at < selected[1].at ||
          (entry[1].at === selected[1].at &&
            entry[1].serial < selected[1].serial)
        )
          selected = entry;
      this.events.delete(selected![0]);
      this.findNext();
      selected![1].run();
    }
  }
  reset(): void {
    this.events.clear();
    this.next = undefined;
    this.onDeadlineChanged?.(undefined);
    this.now = 0n;
    this.serial = 0;
  }
}

export class PeripheralBus {
  readonly clock = new VirtualEvents();
  private regions: { start: number; end: number; device: MmioDevice }[] = [];
  private lastRegion:
    { start: number; end: number; device: MmioDevice } | undefined;
  private devices: MmioDevice[] = [];
  attach(device: MmioDevice): void {
    for (const [start, length] of device.ranges) {
      const end = start + length;
      if (
        length <= 0 ||
        this.regions.some((r) => start < r.end && end > r.start)
      )
        throw new Error('Overlapping device registers');
      this.regions.push({ start, end, device });
    }
    if (!this.devices.includes(device)) this.devices.push(device);
    this.lastRegion = undefined;
  }
  private device(address: number, size: number): MmioDevice | undefined {
    const cached = this.lastRegion;
    if (cached && address >= cached.start && address + size <= cached.end)
      return cached.device;
    const region = this.regions.find(
      (r) => address >= r.start && address + size <= r.end,
    );
    this.lastRegion = region;
    return region?.device;
  }
  read(address: number, size: number): bigint | undefined {
    return this.device(address, size)?.read(address, size);
  }
  write(address: number, size: number, value: bigint): void {
    this.device(address, size)?.write(address, size, value);
  }
  synchronizationDelay(module: number): bigint {
    for (const device of this.devices) {
      const delay = device.synchronizationDelay?.(module);
      if (delay !== undefined) return delay;
    }
    throw new Error(`Unsupported device synchronization endpoint (${module})`);
  }
  reset(): void {
    this.clock.reset();
    for (const device of this.devices) device.reset();
    this.lastRegion = undefined;
  }
}

export function readBytes(
  size: number,
  byte: (offset: number) => number,
): bigint {
  let value = 0n;
  for (let i = 0; i < size; i++)
    value |= BigInt(byte(i) & 255) << BigInt(i * 8);
  return value;
}
export function writeBytes(
  size: number,
  value: bigint,
  byte: (offset: number, value: number) => void,
): void {
  for (let i = 0; i < size; i++)
    byte(i, Number((value >> BigInt(i * 8)) & 255n));
}
