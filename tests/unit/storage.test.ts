import { expect, test } from 'vitest';
import { BlockImage, StorageDevice } from '../../src/devices/storage';
import { PeripheralBus } from '../../src/devices/bus';
import machine from '../../src/profiles/machine.json';

function fixture() {
  const base = machine.peripherals.storage.base,
    A = Uint8Array.from({ length: 4096 }, (_, i) => (i * 13 + 7) & 255),
    B = new Uint8Array(4096),
    ram = new Uint8Array(4096),
    bus = new PeripheralBus(),
    storage = new StorageDevice(
      machine.peripherals.storage,
      { A, B },
      {
        valid: (address, size) =>
          address >= 0x40000000 && address + size <= 0x40001000,
        read: (address, size) =>
          ram.slice(address - 0x40000000, address - 0x40000000 + size),
        write: (address, bytes) => ram.set(bytes, address - 0x40000000),
      },
    );
  bus.attach(storage);
  const command = (
    volume: number,
    lba: number,
    count: number,
    buffer: number,
    op: number,
  ) => {
    for (const [offset, value] of [volume, lba, count, buffer].entries())
      bus.write(base + offset * 4, 4, BigInt(value));
    bus.write(base + 16, 4, BigInt(op));
    return {
      bytes: Number(bus.read(base + 20, 4)),
      status: Number(bus.read(base + 24, 4)),
    };
  };
  return { base, A, B, ram, bus, storage, command };
}

test('block device transfers exact sectors through MMIO and separates A from writable B', () => {
  const { A, B, ram, command, storage, bus, base } = fixture();
  expect(command(0, 1, 2, 0x40000011, 1)).toEqual({ bytes: 1024, status: 0 });
  expect(ram.subarray(17, 1041)).toEqual(A.subarray(512, 1536));
  expect(bus.read(base + 28, 4)).toBe(8n);
  expect(bus.read(base + 32, 4)).toBe(512n);
  expect(command(7, 2, 2, 0x40000011, 2)).toEqual({ bytes: 1024, status: 0 });
  ram.fill(0);
  expect(command(7, 2, 2, 0x40000000, 1).bytes).toBe(1024);
  expect(ram.subarray(0, 1024)).toEqual(A.subarray(512, 1536));
  expect(B.every((byte) => byte === 0)).toBe(true);
  expect(storage.images[1]!.overlaySectors).toBe(2);
  expect(storage.bytesRead).toBe(2048);
  expect(storage.bytesWritten).toBe(1024);
  bus.reset();
  expect(storage.images[1]!.overlaySectors).toBe(0);
  command(7, 2, 2, 0x40000000, 1);
  expect(ram.subarray(0, 1024)).toEqual(new Uint8Array(1024));
});

test('invalid sectors, unknown volumes, readonly writes and bad Guest pointers fail atomically', () => {
  const { storage, command, ram, A } = fixture();
  ram.fill(0xa5);
  for (const request of [
    [0, 0, 1, 0x40000000, 2, 1],
    [0, 8, 1, 0x40000000, 1, 2],
    [0, 0xffffffff, 2, 0x40000000, 1, 2],
    [0, 0, 0xffffffff, 0x40000000, 1, 2],
    [7, 0, 1, 0xfffffff0, 2, 2],
    [7, 0, 1, 0x10000000, 1, 2],
    [2, 0, 1, 0x40000000, 1, 3],
    [7, 0, 1, 0x40000000, 99, 3],
  ]) {
    const [volume, lba, count, address, op, status] = request as [
      number,
      number,
      number,
      number,
      number,
      number,
    ];
    expect(command(volume, lba, count, address, op)).toEqual({
      bytes: 0,
      status,
    });
  }
  expect(ram.every((byte) => byte === 0xa5)).toBe(true);
  expect(storage.images[1]!.overlaySectors).toBe(0);
  expect(storage.images[0]!.read(0, 8)).toEqual(A);
  expect(storage.errors).toBe(8);
  expect(command(7, 8, 0, 0, 1)).toEqual({ bytes: 0, status: 0 });
  expect(command(7, 0, 0, 0, 3)).toEqual({ bytes: 0, status: 0 });
});

test('sector data is copied at both boundaries, including Node Buffer inputs', () => {
  const bytes = Buffer.alloc(1024),
    image = new BlockImage(bytes, true),
    sector = Buffer.alloc(512, 7);
  image.write(1, sector);
  sector.fill(8);
  const result = image.read(1, 1);
  expect(result[0]).toBe(7);
  result.fill(9);
  expect(image.read(1, 1)[0]).toBe(7);
  expect(bytes.every((byte) => byte === 0)).toBe(true);
  image.reset();
  expect(image.read(1, 1)[0]).toBe(0);
  expect(() => image.read(-1, 1)).toThrow(/range/);
  expect(() => image.write(0, new Uint8Array(513))).toThrow(/Unaligned/);
  expect(() => new BlockImage(new Uint8Array(1))).toThrow(/aligned/);
});

test('request words support byte and halfword accesses; readback cannot retrigger IO', () => {
  const { bus, storage, base, command } = fixture();
  command(7, 0, 1, 0x40000000, 1);
  const count = storage.commands;
  bus.write(base, 1, 0n);
  bus.write(base + 4, 2, 1n);
  bus.write(base + 6, 2, 0n);
  expect(bus.read(base, 8)).toBe(1n << 32n);
  bus.read(base + 20, 8);
  expect(storage.commands).toBe(count);
  expect(() => bus.write(base + 16, 1, 1n)).toThrow(/width/);
});
