import { FirmwareError } from './errors';

export class Bytes {
  private view: DataView;
  constructor(public readonly data: Uint8Array) {
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }
  range(offset: number, length: number): void {
    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(length) ||
      offset < 0 ||
      length < 0 ||
      offset + length > this.data.length
    )
      throw new FirmwareError(
        'INVALID_PACKAGE',
        'The file is truncated or a section is out of bounds. Choose a complete original DAT.',
      );
  }
  u16(offset: number): number {
    this.range(offset, 2);
    return this.view.getUint16(offset, true);
  }
  u32(offset: number): number {
    this.range(offset, 4);
    return this.view.getUint32(offset, true);
  }
  ascii(offset: number, length: number): string {
    this.range(offset, length);
    let result = '';
    for (const value of this.data.subarray(offset, offset + length)) {
      if (!value) break;
      result += String.fromCharCode(value);
    }
    return result;
  }
  requireTag(offset: number, tag: string): void {
    if (this.ascii(offset, tag.length) !== tag)
      throw new FirmwareError(
        'INVALID_PACKAGE',
        'SUNP tag mismatch. Choose a complete original DAT.',
      );
  }
  slice(offset: number, length: number): Uint8Array {
    this.range(offset, length);
    return this.data.subarray(offset, offset + length);
  }
}

export async function sha256(data: Uint8Array): Promise<string> {
  // A view shares DAT storage until the browser's digest operation consumes it.
  const digest = await crypto.subtle.digest(
    'SHA-256',
    data as Uint8Array<ArrayBuffer>,
  );
  return Array.from(new Uint8Array(digest), (value) =>
    value.toString(16).padStart(2, '0'),
  ).join('');
}
