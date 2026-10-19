import { readBytes, writeBytes, type MmioDevice } from './bus';

/** Logical sectors, with writes kept in the current emulation session. */
export class BlockImage {
  readonly sectorSize = 512;
  readonly sectorCount: number;
  private readonly overlay = new Map<number, Uint8Array>();

  constructor(
    private readonly bytes: Uint8Array,
    readonly writable = false,
  ) {
    if (!bytes.length || bytes.length % this.sectorSize)
      throw new Error('Storage image is not sector aligned');
    this.sectorCount = bytes.length / this.sectorSize;
  }

  range(lba: number, count: number): void {
    if (
      !Number.isSafeInteger(lba) ||
      !Number.isSafeInteger(count) ||
      lba < 0 ||
      count < 0 ||
      lba + count > this.sectorCount
    )
      throw new Error('Storage sector range outside image');
  }

  read(lba: number, count: number): Uint8Array {
    this.range(lba, count);
    const result = Uint8Array.from(
      this.bytes.subarray(lba * 512, (lba + count) * 512),
    );
    for (let i = 0; i < count; i++) {
      const sector = this.overlay.get(lba + i);
      if (sector) result.set(sector, i * 512);
    }
    return result;
  }

  write(lba: number, bytes: Uint8Array): void {
    if (!this.writable) throw new Error('Storage image is read-only');
    if (bytes.length % 512) throw new Error('Unaligned storage write');
    this.range(lba, bytes.length / 512);
    for (let i = 0; i < bytes.length / 512; i++)
      this.overlay.set(
        lba + i,
        Uint8Array.from(bytes.subarray(i * 512, (i + 1) * 512)),
      );
  }

  get overlaySectors(): number {
    return this.overlay.size;
  }

  reset(): void {
    this.overlay.clear();
  }
}

export interface StorageConfig {
  base: number;
  max_transfer_sectors: number;
  volume_ids: number[];
}

export interface StorageMemory {
  valid(address: number, size: number): boolean;
  read(address: number, size: number): Uint8Array;
  write(address: number, bytes: Uint8Array): void;
}

/**
 * Emulator-owned block device ABI, used by the independently written ARM
 * driver. This is a virtual disk, not a model of the physical NAND controller.
 * Native FAT/VFS owns paths, allocation, handles, caches and locking. The SDK
 * block callbacks are synchronous, so no synthetic interrupt is necessary.
 * Registers (u32 LE): volume, LBA, count, buffer, command, bytes, status,
 * capacity, sector size. Commands: 1=read, 2=write, 3=flush.
 */
export class StorageDevice implements MmioDevice {
  readonly ranges: readonly (readonly [number, number])[];
  readonly images: readonly BlockImage[];
  commands = 0;
  bytesRead = 0;
  bytesWritten = 0;
  errors = 0;
  private readonly registers = new Uint8Array(36);

  constructor(
    readonly config: StorageConfig,
    images: { A: Uint8Array; B: Uint8Array },
    private readonly memory: StorageMemory,
  ) {
    if (
      config.base % 4 ||
      config.volume_ids.length !== 2 ||
      new Set(config.volume_ids).size !== 2 ||
      config.volume_ids.some(
        (id) => !Number.isInteger(id) || id < 0 || id > 15,
      ) ||
      !Number.isInteger(config.max_transfer_sectors) ||
      config.max_transfer_sectors <= 0 ||
      config.max_transfer_sectors > 32768
    )
      throw new Error('Invalid virtual storage configuration');
    this.ranges = [[config.base, this.registers.length]];
    this.images = [new BlockImage(images.A), new BlockImage(images.B, true)];
  }

  read(address: number, size: number): bigint {
    const image = this.selected();
    this.put32(28, image?.sectorCount ?? 0);
    this.put32(32, 512);
    return readBytes(
      size,
      (i) => this.registers[address - this.config.base + i]!,
    );
  }

  write(address: number, size: number, value: bigint): void {
    const offset = address - this.config.base;
    // The doorbell is one aligned word, issued after all request words.
    if (offset === 16) {
      if (size !== 4) throw new Error('Invalid storage command access width');
      this.execute(Number(value));
    } else if (offset >= 0 && offset + size <= 16)
      writeBytes(size, value, (i, byte) => {
        this.registers[offset + i] = byte;
      });
  }

  reset(): void {
    this.registers.fill(0);
    for (const image of this.images) image.reset();
    this.commands = this.bytesRead = this.bytesWritten = this.errors = 0;
  }

  private selected(): BlockImage | undefined {
    return this.images[this.config.volume_ids.indexOf(this.u32(0))];
  }

  private execute(command: number): void {
    this.commands++;
    this.put32(20, 0);
    this.put32(24, 0);
    const image = this.selected();
    if (!image || ![1, 2, 3].includes(command)) return this.fail(3);
    if (command === 3) return;
    const lba = this.u32(4),
      count = this.u32(8),
      address = this.u32(12);
    if (count > this.config.max_transfer_sectors) return this.fail(2);
    try {
      image.range(lba, count);
    } catch {
      return this.fail(2);
    }
    const size = count * 512;
    if (!size) return;
    if (!this.memory.valid(address, size)) return this.fail(2);
    if (command === 2 && !image.writable) return this.fail(1);
    if (command === 1) {
      this.memory.write(address, image.read(lba, count));
      this.bytesRead += size;
    } else {
      image.write(lba, this.memory.read(address, size));
      this.bytesWritten += size;
    }
    this.put32(20, size);
  }

  private fail(status: number): void {
    this.errors++;
    this.put32(24, status);
  }

  private u32(offset: number): number {
    return new DataView(this.registers.buffer).getUint32(offset, true);
  }

  private put32(offset: number, value: number): void {
    new DataView(this.registers.buffer).setUint32(offset, value, true);
  }
}
