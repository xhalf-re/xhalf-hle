// Entirely synthetic containers and FAT volumes; no vendor resource bytes.
export function put32(bytes: Uint8Array, at: number, value: number): void {
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(
    at,
    value >>> 0,
    true,
  );
}
function put16(bytes: Uint8Array, at: number, value: number): void {
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint16(
    at,
    value,
    true,
  );
}
export function putText(bytes: Uint8Array, at: number, value: string): void {
  bytes.set(new TextEncoder().encode(value), at);
}
export function fatFixture(bits: 12 | 16 = 12): Uint8Array {
  const sectors = bits === 12 ? 10 : 4200,
    fatSectors = bits === 12 ? 1 : 17;
  const bytes = new Uint8Array(sectors * 512);
  put16(bytes, 11, 512);
  bytes[13] = 1;
  put16(bytes, 14, 1);
  bytes[16] = 1;
  put16(bytes, 17, 16);
  put16(bytes, 19, sectors);
  put16(bytes, 22, fatSectors);
  put16(bytes, 510, 0xaa55);
  bytes.set(
    bits === 12
      ? [0xf8, 0xff, 0xff, 0xff, 0x0f]
      : [0xf8, 0xff, 0xff, 0xff, 0xff, 0xff],
    512,
  );
  const root = (1 + fatSectors) * 512,
    data = root + 512;
  putText(bytes, root, 'HELLO   TXT');
  bytes[root + 11] = 0x20;
  put16(bytes, root + 26, 2);
  put32(bytes, root + 28, 4);
  bytes.set([1, 2, 3, 4], data);
  return bytes;
}
export function fixChecksum(bytes: Uint8Array): void {
  const view = new DataView(bytes.buffer);
  put32(bytes, 0x1fc, 0);
  let sum = 0;
  for (let at = 0; at < view.getUint32(0x10, true); at += 4)
    sum = (sum + view.getUint32(at, true)) >>> 0;
  put32(bytes, 0x1fc, -sum);
}
export function packageFixture(): Uint8Array {
  const bytes = new Uint8Array(0x5500);
  putText(bytes, 0, 'SUNP BURN FILE');
  [0x5000, 0x500, 0x600, 0x3000, 0, 0x4000, 0x4800, 0].forEach((v, i) =>
    put32(bytes, 0x10 + i * 4, v),
  );
  putText(bytes, 0x500, 'SUNP BURN HDR 1');
  putText(bytes, 0x600, 'SUNP BURN HDR 2');
  put32(bytes, 0x610, 2);
  for (const [i, volume, offset] of [
    [0, 'A', 0x800],
    [1, 'B', 0x1c00],
  ] as const) {
    const row = new Uint8Array(128);
    putText(row, 0, `synthetic:build<sign>${volume}?`);
    put32(row, 0x70, offset);
    put32(row, 0x74, 5120);
    bytes.set(
      row.map((v) => v ^ 0x7a),
      0x620 + i * 128,
    );
    bytes.set(fatFixture(), offset);
  }
  put32(bytes, 0x3000, 0xea000000);
  putText(bytes, 0x4000, 'SUNP BURN HDR 3');
  putText(bytes, 0x4800, 'DRAMPAR3V');
  fixChecksum(bytes);
  return bytes;
}
