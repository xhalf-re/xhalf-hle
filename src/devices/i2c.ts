import {
  readBytes,
  writeBytes,
  type MmioDevice,
  type VirtualEvents,
} from './bus';

export interface I2cTarget {
  read(register: number, length: number): Uint8Array;
  write(register: number, bytes: Uint8Array): void;
  reset?(): void;
}
export interface I2cConfig {
  ports: { base: number; status: number; done_bit: number; nack_bit: number }[];
  reset: number;
  transfer_ns: number;
}

/** FIFO I²C master. Software programs transactions; targets own chip registers. */
export class I2cController implements MmioDevice {
  readonly ranges;
  private ports;
  private statuses = new Map<number, number>();
  private targets = new Map<string, I2cTarget>();
  transfers = 0;
  nacks = 0;
  constructor(
    readonly config: I2cConfig,
    private clock: VirtualEvents,
  ) {
    this.ports = config.ports.map(() => ({
      registers: new Uint8Array(0x30),
      tx: [] as number[],
      rx: [] as number[],
      cursor: 0,
    }));
    this.ranges = config.ports.map((p) => [p.base, 0x30] as [number, number]);
    for (const { status } of config.ports) this.statuses.set(status, 0);
    for (const address of this.statuses.keys()) this.ranges.push([address, 4]);
    this.ranges.push([config.reset, 1]);
  }
  attach(port: number, address: number, target: I2cTarget): void {
    const key = `${port}:${address}`;
    if (
      !this.ports[port] ||
      address < 0 ||
      address > 127 ||
      this.targets.has(key)
    )
      throw new Error('Invalid or duplicate I2C target');
    this.targets.set(key, target);
  }
  private port(address: number): number {
    return this.config.ports.findIndex(
      (p) => address >= p.base && address < p.base + 0x30,
    );
  }
  private status(address: number): number | undefined {
    return [...this.statuses.keys()].find(
      (at) => address >= at && address < at + 4,
    );
  }
  read(address: number, size: number): bigint {
    return readBytes(size, (i) => {
      const at = address + i,
        status = this.status(at);
      if (status !== undefined)
        return this.statuses.get(status)! >>> ((at - status) * 8);
      const index = this.port(at);
      if (index < 0) return 0;
      const port = this.ports[index]!,
        offset = at - this.config.ports[index]!.base;
      return offset === 0x24
        ? (port.rx.shift() ?? 0xff)
        : port.registers[offset]!;
    });
  }
  write(address: number, size: number, value: bigint): void {
    writeBytes(size, value, (i, byte) => {
      const at = address + i,
        status = this.status(at);
      if (status !== undefined) {
        this.statuses.set(
          status,
          (this.statuses.get(status)! & ~(byte << ((at - status) * 8))) >>> 0,
        );
        return;
      }
      if (at === this.config.reset) {
        for (let port = 0; port < this.ports.length; port++)
          if (byte & (0x10 << port)) this.resetPort(port);
        return;
      }
      const index = this.port(at);
      if (index < 0) return;
      const port = this.ports[index]!,
        offset = at - this.config.ports[index]!.base;
      if (offset === 0x20) {
        if (port.tx.length >= 16) throw new Error('I2C transmit FIFO overflow');
        port.tx.push(byte);
        return;
      }
      port.registers[offset] = byte;
      if (offset === 0 && !(byte & 1)) this.resetPort(index);
      if (offset === 4 && byte & 1) this.start(index);
    });
  }
  private start(index: number): void {
    const port = this.ports[index]!,
      config = this.config.ports[index]!,
      tx = port.tx.splice(0),
      address = port.registers[8]! >>> 1,
      read = port.registers[2] !== 0,
      length = port.registers[0xa]! + 1;
    this.clock.cancel(`i2c:${index}`);
    port.rx.length = 0;
    if (!(port.registers[0]! & 1)) {
      port.registers[4] = 0;
      return;
    }
    if (read && length > 16)
      throw new Error('I2C receive FIFO capacity exceeded');
    this.clock.schedule(
      `i2c:${index}`,
      this.clock.now + BigInt(this.config.transfer_ns),
      () => {
        const target = this.targets.get(`${index}:${address}`);
        if (tx.length) port.cursor = tx[0]!;
        if (target) {
          if (read) {
            port.rx.push(...target.read(port.cursor, length));
            port.cursor = (port.cursor + length) & 255;
          } else if (tx.length > 1) {
            target.write(port.cursor, Uint8Array.from(tx.slice(1)));
            port.cursor = (port.cursor + tx.length - 1) & 255;
          }
        } else this.nacks++;
        port.registers[4] = 0;
        this.transfers++;
        this.statuses.set(
          config.status,
          (this.statuses.get(config.status)! |
            (1 << config.done_bit) |
            (target ? 0 : 1 << config.nack_bit)) >>>
            0,
        );
      },
    );
  }
  private resetPort(index: number): void {
    const port = this.ports[index]!,
      config = this.config.ports[index]!;
    this.clock.cancel(`i2c:${index}`);
    port.tx.length = port.rx.length = 0;
    port.registers[4] = 0;
    this.statuses.set(
      config.status,
      (this.statuses.get(config.status)! &
        ~((1 << config.done_bit) | (1 << config.nack_bit))) >>>
        0,
    );
  }
  reset(): void {
    for (let i = 0; i < this.ports.length; i++) {
      this.resetPort(i);
      this.ports[i]!.registers.fill(0);
      this.ports[i]!.cursor = 0;
    }
    this.transfers = this.nacks = 0;
    for (const target of new Set(this.targets.values())) target.reset?.();
  }
}
