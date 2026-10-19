// SUNP/HDR2 algorithm: user's burn.js and burnextract.js, pinned in baseline.json.
// Pure byte implementation: no filesystem, repacking, signing or firmware export.
import { Bytes, sha256 } from './bytes';
import { checkCancelled, FirmwareError } from './errors';

export interface ResourceRecord {
  index: number;
  volume: string | null;
  offset: number;
  length: number;
  bytes: Uint8Array;
}
export interface PackageHeader {
  signature: number;
  hdr1: number;
  hdr2: number;
  main: number;
  rawC: number;
  hdr3: number;
  drampar: number;
  fw2: number;
}
export interface FirmwareBundle {
  bytes: Uint8Array;
  header: PackageHeader;
  payload: Uint8Array;
  resources: ResourceRecord[];
  images: { A: Uint8Array; B: Uint8Array };
  identity: { package: string; payload: string; A: string; B: string };
}

export function parsePackage(
  bytes: Uint8Array,
): Omit<FirmwareBundle, 'identity'> {
  const reader = new Bytes(bytes);
  reader.range(0, 0x500);
  reader.requireTag(0, 'SUNP BURN FILE');
  const h: PackageHeader = {
    signature: reader.u32(0x10),
    hdr1: reader.u32(0x14),
    hdr2: reader.u32(0x18),
    main: reader.u32(0x1c),
    rawC: reader.u32(0x20),
    hdr3: reader.u32(0x24),
    drampar: reader.u32(0x28),
    fw2: reader.u32(0x2c),
  };
  if (h.signature !== bytes.length && h.signature + 0x500 !== bytes.length)
    throw new FirmwareError(
      'INVALID_PACKAGE',
      'DAT length does not match the SUNP header. Choose a complete file.',
    );
  const offsets = [
    0x500,
    h.hdr1,
    h.hdr2,
    h.main,
    h.hdr3,
    h.drampar,
    h.signature,
  ];
  for (let i = 1; i < offsets.length; i++) {
    if (offsets[i]! < offsets[i - 1]! || offsets[i]! > h.signature)
      throw new FirmwareError(
        'INVALID_PACKAGE',
        'Invalid SUNP section layout.',
      );
  }
  if (
    h.hdr1 + 0xa0 > h.hdr2 ||
    h.hdr2 + 0x20 > h.main ||
    h.main + 0x50 > h.hdr3 ||
    h.hdr3 + 0x20 > h.drampar
  )
    throw new FirmwareError(
      'INVALID_PACKAGE',
      'Truncated SUNP section header.',
    );
  for (const [at, tag] of [
    [h.hdr1, 'SUNP BURN HDR 1'],
    [h.hdr2, 'SUNP BURN HDR 2'],
    [h.hdr3, 'SUNP BURN HDR 3'],
    [h.drampar, 'DRAMPAR3V'],
  ] as const)
    reader.requireTag(at, tag);
  if (reader.u32(h.main) >>> 24 !== 0xea)
    throw new FirmwareError(
      'INVALID_PACKAGE',
      'The main firmware entry is not an ARM branch.',
    );
  if (h.rawC) {
    if (h.rawC < h.hdr2 + 0x20 || h.rawC >= h.main)
      throw new FirmwareError(
        'INVALID_PACKAGE',
        'rawC section is out of bounds.',
      );
    reader.requireTag(h.rawC, 'firstburn\n');
  }
  if (h.fw2 && (h.fw2 < 0x500 || h.fw2 >= h.signature))
    throw new FirmwareError('INVALID_PACKAGE', 'FW2 section is out of bounds.');
  const count = reader.u32(h.hdr2 + 0x10),
    tableEnd = h.hdr2 + 0x20 + count * 0x80;
  if (count > 4096 || tableEnd > (h.rawC || h.main))
    throw new FirmwareError(
      'INVALID_PACKAGE',
      'HDR2 resource table is out of bounds.',
    );
  if (h.hdr3 + 0x20 + reader.u32(h.hdr3 + 0x10) * 0x70 > h.drampar)
    throw new FirmwareError(
      'INVALID_PACKAGE',
      'HDR3 record table is out of bounds.',
    );
  const records: ResourceRecord[] = [];
  const volumes = new Set<string>();
  for (let index = 0; index < count; index++) {
    const record = Uint8Array.from(
      reader.slice(h.hdr2 + 0x20 + index * 0x80, 0x80),
      (value) => value ^ 0x7a,
    );
    const row = new Bytes(record),
      offset = row.u32(0x70),
      length = row.u32(0x74);
    const volume =
      /:build<sign>([a-z])\?$/i.exec(row.ascii(0, 0x70))?.[1]?.toUpperCase() ??
      null;
    if (offset < tableEnd || !length || offset + length > (h.rawC || h.main))
      throw new FirmwareError(
        'INVALID_PACKAGE',
        'HDR2 resource data is out of bounds.',
      );
    if (
      records.some(
        (previous) =>
          offset < previous.offset + previous.length &&
          previous.offset < offset + length,
      )
    )
      throw new FirmwareError(
        'INVALID_PACKAGE',
        'HDR2 resource data ranges overlap.',
      );
    if (volume && volumes.has(volume))
      throw new FirmwareError(
        'INVALID_PACKAGE',
        'HDR2 contains duplicate volumes.',
      );
    if (volume) volumes.add(volume);
    records.push({
      index,
      volume,
      offset,
      length,
      bytes: reader.slice(offset, length),
    });
  }
  const A = records.find((r) => r.volume === 'A')?.bytes,
    B = records.find((r) => r.volume === 'B')?.bytes;
  if (!A || !B)
    throw new FirmwareError(
      'MISSING_RESOURCE',
      'DAT is missing A/B resource volumes. Choose a complete original file.',
    );
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let sum = 0,
    offset = 0;
  for (; offset + 4 <= h.signature; offset += 4)
    sum = (sum + view.getUint32(offset, true)) >>> 0;
  let tail = 0;
  for (let i = 0; offset + i < h.signature; i++)
    tail |= bytes[offset + i]! << (8 * i);
  if ((sum + (tail >>> 0)) >>> 0)
    throw new FirmwareError(
      'INVALID_PACKAGE',
      'DAT checksum mismatch. The file may be damaged.',
    );
  return {
    bytes,
    header: h,
    payload: reader.slice(h.main, h.hdr3 - h.main),
    resources: records,
    images: { A, B },
  };
}

export async function loadBundle(
  bytes: Uint8Array,
  signal?: AbortSignal,
): Promise<FirmwareBundle> {
  checkCancelled(signal);
  const parsed = parsePackage(bytes);
  const [packageHash, payload, A, B] = await Promise.all([
    sha256(parsed.bytes),
    sha256(parsed.payload),
    sha256(parsed.images.A),
    sha256(parsed.images.B),
  ]);
  checkCancelled(signal);
  return { ...parsed, identity: { package: packageHash, payload, A, B } };
}
