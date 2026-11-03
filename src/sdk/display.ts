import type { RuntimeCore } from '../runtime/core';
export interface FrameDescription {
  address: number;
  width: number;
  height: number;
  format: 'abgr8888' | 'rgb565';
}
/** Lazily built rgb565 → RGBA expansion table (opaque alpha). */
let rgb565Table: Uint32Array | undefined;
function rgb565Lut(): Uint32Array {
  if (rgb565Table) return rgb565Table;
  rgb565Table = new Uint32Array(65536);
  for (let v = 0; v < 65536; v++) {
    const r = (v >>> 11) & 31,
      g = (v >>> 5) & 63,
      b = v & 31;
    // Little-endian RGBA bytes.
    rgb565Table[v] =
      (r << 3) |
      (r >>> 2) |
      (((g << 2) | (g >>> 4)) << 8) |
      (((b << 3) | (b >>> 2)) << 16) |
      0xff000000;
  }
  return rgb565Table;
}

export function convertFrame(
  raw: Uint8Array,
  width: number,
  height: number,
  format: FrameDescription['format'],
  rotation: number,
  output?: ArrayBuffer,
): { width: number; height: number; pixels: ArrayBuffer } {
  if (
    width <= 0 ||
    height <= 0 ||
    width > 4096 ||
    height > 4096 ||
    raw.length !== width * height * (format === 'rgb565' ? 2 : 4)
  )
    throw new Error('Invalid framebuffer geometry');
  const turn = ((rotation % 4) + 4) % 4,
    w = turn % 2 ? height : width,
    h = turn % 2 ? width : height;
  const pixels =
      output?.byteLength === w * h * 4 ? output : new ArrayBuffer(w * h * 4),
    out = new Uint32Array(pixels);
  // cpu.read returns a fresh aligned buffer; view the source as machine words
  // and convert one whole pixel per iteration instead of per byte.
  if (format === 'abgr8888') {
    const src = new Uint32Array(raw.buffer, raw.byteOffset, width * height);
    // ABGR bytes → RGBA bytes: swap the low and high byte of each 32-bit word.
    const map = (p: number): number =>
      ((p >>> 24) |
        ((p >>> 8) & 0xff00) |
        ((p & 0xff00) << 8) |
        ((p & 0xff) << 24)) >>>
      0;
    scatter(src, out, width, height, turn, map);
  } else {
    const src = new Uint16Array(raw.buffer, raw.byteOffset, width * height),
      lut = rgb565Lut();
    scatter(src, out, width, height, turn, (p) => lut[p]!);
  }
  return { width: w, height: h, pixels };
}

/** Row-major rotate into out; map() converts one source word to an RGBA word. */
function scatter(
  src: Uint16Array | Uint32Array,
  out: Uint32Array,
  width: number,
  height: number,
  turn: number,
  map: (pixel: number) => number,
): void {
  if (turn === 0) {
    for (let i = 0, n = width * height; i < n; i++) out[i] = map(src[i]!);
    return;
  }
  if (turn === 2) {
    for (let i = 0, n = width * height; i < n; i++)
      out[i] = map(src[n - 1 - i]!);
    return;
  }
  const w = height,
    h = width;
  for (let dy = 0; dy < h; dy++) {
    const row = dy * w;
    // turn 1: source column width-1-dy, walked top-down as dx grows.
    // turn 3: source column dy, walked bottom-up as dx grows.
    let at = turn === 1 ? width - 1 - dy : (height - 1) * width + dy;
    const stride = turn === 1 ? width : -width;
    for (let dx = 0; dx < w; dx++) {
      out[row + dx] = map(src[at]!);
      at += stride;
    }
  }
}
export interface DisplayFrame {
  width: number;
  height: number;
  pixels: ArrayBuffer;
  frame: number;
}

type Scanout = { description: FrameDescription; bytes: Uint8Array };
function sameDescription(a: FrameDescription, b: FrameDescription): boolean {
  return (
    a.address === b.address &&
    a.width === b.width &&
    a.height === b.height &&
    a.format === b.format
  );
}
function samePixels(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  // Compare exact bytes, including alpha. No hashes or draw-operation hints.
  if (!(a.byteOffset & 3) && !(b.byteOffset & 3)) {
    const size = a.length >>> 2,
      left = new Uint32Array(a.buffer, a.byteOffset, size),
      right = new Uint32Array(b.buffer, b.byteOffset, size);
    for (let i = 0; i < size; i++) if (left[i] !== right[i]) return false;
    for (let i = size * 4; i < a.length; i++) if (a[i] !== b[i]) return false;
  } else {
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  }
  return true;
}

/** Host presentation of native scanout. Hardware timing belongs to the device. */
export class NativeDisplay {
  private sent = 0;
  private pending = new Map<number, number>();
  private reusable: ArrayBuffer[] = [];
  private lastTime = -Infinity;
  private lastScanout: Scanout | undefined;
  private readBuffers: Uint8Array[] = [];
  private submitted = false;
  submissions = 0;
  dropped = 0;
  constructor(
    private core: RuntimeCore,
    private emit?: (frame: DisplayFrame) => void,
  ) {
    if (emit) {
      const address =
        core.profile.address('gfx.context') +
        core.sdk.offset('gfx_context', 'active_buffer');
      // The native merger commits by writing its active-buffer index. Observe
      // that SDK boundary; sample only after the CPU slice has finished.
      core.cpu.hook(
        'write',
        () => {
          this.submitted = true;
          this.submissions++;
        },
        address,
        address + 3,
      );
    }
  }
  get frameCount(): number {
    return this.sent;
  }
  get settled(): boolean {
    return !this.pending.size && this.current;
  }
  get inFlight(): number {
    return this.pending.size;
  }
  /** The latest emitted pixels match guest RAM now; acknowledgement is separate. */
  get current(): boolean {
    const frame = this.description(),
      last = this.lastScanout;
    if (!frame || !last || !sameDescription(frame, last.description))
      return false;
    const raw = this.read(frame),
      current = samePixels(raw, last.bytes);
    this.recycleRead(raw);
    return current;
  }
  acknowledge(frame: number, pixels: ArrayBuffer): void {
    const expected = this.pending.get(frame);
    if (expected === undefined) return;
    if (pixels.byteLength !== expected)
      throw new Error('Invalid display frame acknowledgement');
    this.pending.delete(frame);
    this.reusable.push(pixels);
    // Return capacity promptly; the next poll samples the latest guest frame.
    this.lastTime = -Infinity;
  }
  description(): FrameDescription | null {
    const { sdk, profile } = this.core,
      base = profile.address('gfx.context'),
      index = sdk.field(base, 'gfx_context', 'active_buffer');
    if (index !== 0 && index !== 1) return null;
    const layout = profile.layouts.gfx_context!,
      row = sdk.structure(
        base +
          Number(layout.buffer_base) +
          index * Number(layout.buffer_stride),
        'gfx_buffer',
      );
    const format = (
      profile.sdk.images.display_formats as Record<string, string>
    )[`0x${row.format!.toString(16)}`];
    if (format !== 'abgr8888' && format !== 'rgb565') return null;
    if (
      row.width! <= 0 ||
      row.height! <= 0 ||
      row.width! > 4096 ||
      row.height! > 4096 ||
      !profile.inRam(
        row.address!,
        row.width! * row.height! * (format === 'rgb565' ? 2 : 4),
        true,
      )
    )
      return null;
    return {
      address: row.address!,
      width: row.width!,
      height: row.height!,
      format,
    };
  }
  private read(frame: FrameDescription): Uint8Array {
    const size =
        frame.width * frame.height * (frame.format === 'rgb565' ? 2 : 4),
      readInto = this.core.cpu.readInto;
    if (!readInto) return this.core.cpu.read(frame.address, size);
    let raw = this.readBuffers.pop();
    if (!raw || raw.byteLength !== size) raw = new Uint8Array(size);
    readInto.call(this.core.cpu, frame.address, raw);
    return raw;
  }
  private recycleRead(raw: Uint8Array): void {
    if (this.core.cpu.readInto) this.readBuffers.push(raw);
  }
  poll(): void {
    if (!this.emit) return;
    const now = performance.now(),
      committed = this.submitted;
    if (!committed && now - this.lastTime < 33) return;
    this.submitted = false;
    this.lastTime = now;
    const frame = this.description();
    if (!frame) return;
    const raw = this.read(frame),
      last = this.lastScanout;
    // A merger commit means fresh pixels; the exact compare only gates the
    // throttled in-place scan.
    if (
      !committed &&
      last &&
      sameDescription(frame, last.description) &&
      samePixels(raw, last.bytes)
    ) {
      this.recycleRead(raw);
      return;
    }
    if (this.pending.size >= 2) {
      this.dropped++;
      this.recycleRead(raw);
      return;
    }
    const converted = convertFrame(
      raw,
      frame.width,
      frame.height,
      frame.format,
      this.core.profile.machine.display.rotation_quarters,
      this.reusable.pop(),
    );
    const previous = this.lastScanout;
    this.lastScanout = { description: frame, bytes: raw };
    if (previous) this.recycleRead(previous.bytes);
    this.pending.set(++this.sent, converted.pixels.byteLength);
    this.emit({ ...converted, frame: this.sent });
  }
}
