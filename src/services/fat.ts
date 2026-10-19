// FAT12/16 and LFN rules independently implemented from the user's burnfat.js.
import { Bytes } from '../firmware/bytes';
import { FirmwareError } from '../firmware/errors';

export interface FatEntry {
  path: string;
  size: number;
  directory: boolean;
  ranges: { offset: number; length: number }[];
}
function invalid(message: string): never {
  throw new FirmwareError(
    'INVALID_FILESYSTEM',
    `Invalid resource volume: ${message}`,
  );
}
export function normalizedPath(path: string): string {
  const parts = path
    .replaceAll('\\', '/')
    .split('/')
    .filter((p) => p && p !== '.');
  if (parts.some((p) => p === '..' || /[\x00-\x1f:]/.test(p)))
    throw new Error('Invalid VFS path');
  return parts.join('/').toLowerCase();
}

export class FatVolume {
  readonly entries = new Map<string, FatEntry>();
  readonly bits: 12 | 16;
  readonly sectorSize: number;
  readonly totalSectors: number;
  private reader: Bytes;
  private fatStart: number;
  private clusterSize: number;
  private clusterCount: number;
  private dataStart: number;

  constructor(private image: Uint8Array) {
    this.reader = new Bytes(image);
    if (image.length < 512 || this.reader.u16(510) !== 0xaa55)
      invalid('boot signature');
    const bps = this.reader.u16(11),
      spc = image[13]!,
      reserved = this.reader.u16(14),
      fats = image[16]!,
      roots = this.reader.u16(17);
    const sectors = this.reader.u16(19) || this.reader.u32(32),
      fatSectors = this.reader.u16(22);
    if (
      ![512, 1024, 2048, 4096].includes(bps) ||
      !spc ||
      spc & (spc - 1) ||
      !reserved ||
      !fats ||
      !roots ||
      !fatSectors ||
      sectors * bps > image.length
    )
      invalid('geometry');
    this.sectorSize = bps;
    this.totalSectors = sectors;
    this.fatStart = reserved * bps;
    const rootStart = (reserved + fats * fatSectors) * bps;
    this.dataStart = rootStart + Math.ceil((roots * 32) / bps) * bps;
    this.clusterSize = spc * bps;
    this.clusterCount = Math.floor(
      (sectors * bps - this.dataStart) / this.clusterSize,
    );
    this.bits = this.clusterCount < 4085 ? 12 : 16;
    if (
      this.clusterCount <= 0 ||
      this.clusterCount >= 65525 ||
      Math.ceil(((this.clusterCount + 2) * this.bits) / 8) > fatSectors * bps
    )
      invalid('cluster table');
    const visited = new Set<number>();
    this.directory(this.reader.slice(rootStart, roots * 32), '', 0, visited);
  }
  private chain(first: number): { offset: number; length: number }[] {
    const seen = new Set<number>(),
      ranges: { offset: number; length: number }[] = [];
    let cluster = first;
    while (true) {
      if (cluster < 2 || cluster >= this.clusterCount + 2 || seen.has(cluster))
        invalid('cyclic or invalid chain');
      seen.add(cluster);
      ranges.push({
        offset: this.dataStart + (cluster - 2) * this.clusterSize,
        length: this.clusterSize,
      });
      const pair = this.reader.u16(
        this.fatStart +
          (this.bits === 12 ? Math.floor((cluster * 3) / 2) : cluster * 2),
      );
      cluster =
        this.bits === 12 ? (cluster & 1 ? pair >> 4 : pair & 0xfff) : pair;
      if (cluster >= (this.bits === 12 ? 0xff8 : 0xfff8)) return ranges;
    }
  }
  private gather(
    ranges: FatEntry['ranges'],
    size = ranges.reduce((n, r) => n + r.length, 0),
  ): Uint8Array {
    const result = new Uint8Array(size);
    let offset = 0;
    for (const range of ranges) {
      const length = Math.min(range.length, size - offset);
      if (!length) break;
      result.set(this.reader.slice(range.offset, length), offset);
      offset += length;
    }
    if (offset !== size) invalid('truncated file');
    return result;
  }
  private directory(
    data: Uint8Array,
    prefix: string,
    depth: number,
    visited: Set<number>,
  ): void {
    if (depth > 64) invalid('directory depth');
    let parts: string[] = [],
      expected = 0,
      checksum = -1;
    for (let offset = 0; offset + 32 <= data.length; offset += 32) {
      const row = data.subarray(offset, offset + 32),
        r = new Bytes(row);
      if (row[0] === 0) break;
      if (row[0] === 0xe5) {
        parts = [];
        expected = 0;
        continue;
      }
      if (row[11] === 0x0f) {
        const sequence = row[0]! & 0x1f;
        if (row[0]! & 0x40) {
          parts = [];
          expected = sequence;
          checksum = row[13]!;
        }
        if (!sequence || sequence !== expected || row[13] !== checksum) {
          parts = [];
          expected = 0;
          continue;
        }
        parts[sequence - 1] = [1, 3, 5, 7, 9, 14, 16, 18, 20, 22, 24, 28, 30]
          .map((at) => String.fromCharCode(r.u16(at)))
          .join('');
        expected--;
        continue;
      }
      let sum = 0;
      for (let i = 0; i < 11; i++)
        sum = (((sum & 1) << 7) + (sum >> 1) + row[i]!) & 255;
      const shortBase = r.ascii(0, 8).trimEnd(),
        shortExt = r.ascii(8, 3).trimEnd();
      const short =
        (row[12]! & 8 ? shortBase.toLowerCase() : shortBase) +
        (shortExt
          ? '.' + (row[12]! & 16 ? shortExt.toLowerCase() : shortExt)
          : '');
      const name =
        parts.length && !expected && checksum === sum
          ? parts
              .join('')
              .split('\0')[0]!
              .replace(/\uffff+$/, '')
          : short;
      parts = [];
      expected = 0;
      if (row[11]! & 8 || name === '.' || name === '..') continue;
      if (!name || /[\\/\x00-\x1f:]/.test(name)) invalid('filename');
      const path = normalizedPath(prefix ? `${prefix}/${name}` : name);
      if (this.entries.has(path)) invalid('duplicate path');
      const first = r.u16(26),
        size = r.u32(28),
        directory = !!(row[11]! & 16);
      const ranges = directory || size ? this.chain(first) : [];
      if (!directory && ranges.reduce((n, range) => n + range.length, 0) < size)
        invalid('short file chain');
      this.entries.set(path, { path, size, directory, ranges });
      if (directory) {
        if (visited.has(first)) invalid('cyclic directory');
        visited.add(first);
        this.directory(this.gather(ranges), path, depth + 1, visited);
      }
    }
  }
  lookup(path: string): FatEntry {
    const normalized = normalizedPath(path);
    if (!normalized) return { path: '', directory: true, size: 0, ranges: [] };
    const entry = this.entries.get(normalized);
    if (!entry) throw new Error('File not found');
    return entry;
  }
  readFile(path: string): Uint8Array {
    const entry = this.lookup(path);
    if (entry.directory) throw new Error('Is a directory');
    return this.gather(entry.ranges, entry.size);
  }
  readSectors(sector: number, count: number): Uint8Array {
    if (
      !Number.isSafeInteger(sector) ||
      !Number.isSafeInteger(count) ||
      sector < 0 ||
      count < 0 ||
      sector + count > this.totalSectors
    )
      invalid('sector range');
    return this.image.subarray(
      sector * this.sectorSize,
      (sector + count) * this.sectorSize,
    );
  }
}
