import { expect, test } from 'vitest';
import { FatVolume } from '../../src/services/fat';
import { fatFixture, put32, putText } from './fixtures';

test.each([12, 16] as const)(
  'reads FAT%d files and respects sector bounds',
  (bits) => {
    const fat = new FatVolume(fatFixture(bits));
    expect(fat.bits).toBe(bits);
    expect(Array.from(fat.readFile('/hello.txt'))).toEqual([1, 2, 3, 4]);
    expect(() => fat.readSectors(fat.totalSectors, 1)).toThrow();
    expect(() => fat.readFile('../HELLO.TXT')).toThrow();
  },
);
test('rejects invalid geometry, loops, duplicate names and truncated chains', () => {
  const geometry = fatFixture();
  geometry[13] = 3;
  expect(() => new FatVolume(geometry)).toThrow();
  const loop = fatFixture();
  loop[515] = 2;
  loop[516] = 0;
  expect(() => new FatVolume(loop)).toThrow(/chain/);
  const short = fatFixture();
  put32(short, 1024 + 28, 513);
  expect(() => new FatVolume(short)).toThrow(/short/);
  const duplicate = fatFixture();
  duplicate.set(duplicate.slice(1024, 1056), 1056);
  expect(() => new FatVolume(duplicate)).toThrow(/duplicate/);
  const empty = fatFixture();
  empty[11] = 0;
  empty[12] = 0;
  expect(() => new FatVolume(empty)).toThrow();
});
test('validates long filename sequence and checksum instead of trusting LFN rows', () => {
  const bytes = fatFixture();
  const short = bytes.slice(1024, 1056);
  let checksum = 0;
  for (let i = 0; i < 11; i++)
    checksum = (((checksum & 1) << 7) + (checksum >> 1) + short[i]!) & 255;
  const long = new Uint8Array(32);
  long[0] = 0x41;
  long[11] = 0xf;
  long[13] = checksum;
  const name = 'long-name.txt';
  [1, 3, 5, 7, 9, 14, 16, 18, 20, 22, 24, 28, 30].forEach((at, i) =>
    new DataView(long.buffer).setUint16(at, name.charCodeAt(i) || 0, true),
  );
  bytes.set(long, 1024);
  bytes.set(short, 1056);
  expect(Array.from(new FatVolume(bytes).readFile(name))).toEqual([1, 2, 3, 4]);
  bytes[1037] = checksum ^ 1;
  expect(Array.from(new FatVolume(bytes).readFile('HELLO.TXT'))).toEqual([
    1, 2, 3, 4,
  ]);
});
test('a root file cannot be traversed as a directory', () => {
  // A normal root file that isn't a directory must never be treated as one.
  const nested = fatFixture();
  putText(nested, 1024, 'FILE    TXT');
  expect(() => new FatVolume(nested).lookup('FILE.TXT/a')).toThrow();
});
