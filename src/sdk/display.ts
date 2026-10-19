import type { RuntimeCore } from '../runtime/core';
export interface FrameDescription {
  address: number;
  width: number;
  height: number;
  format: 'abgr8888' | 'rgb565';
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
    bytes = new Uint8Array(pixels),
    view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const dx =
        turn === 1
          ? y
          : turn === 2
            ? width - 1 - x
            : turn === 3
              ? height - 1 - y
              : x;
      const dy =
          turn === 1
            ? width - 1 - x
            : turn === 2
              ? height - 1 - y
              : turn === 3
                ? x
                : y,
        to = (dy * w + dx) * 4,
        from = (y * width + x) * (format === 'rgb565' ? 2 : 4);
      if (format === 'abgr8888') {
        bytes[to] = raw[from + 3]!;
        bytes[to + 1] = raw[from + 2]!;
        bytes[to + 2] = raw[from + 1]!;
        bytes[to + 3] = raw[from]!;
      } else {
        const v = view.getUint16(from, true),
          r = (v >>> 11) & 31,
          g = (v >>> 5) & 63,
          b = v & 31;
        bytes[to] = (r << 3) | (r >>> 2);
        bytes[to + 1] = (g << 2) | (g >>> 4);
        bytes[to + 2] = (b << 3) | (b >>> 2);
        bytes[to + 3] = 255;
      }
    }
  return { width: w, height: h, pixels };
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
    return !!(
      frame &&
      last &&
      sameDescription(frame, last.description) &&
      samePixels(this.read(frame), last.bytes)
    );
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
    return this.core.cpu.read(
      frame.address,
      frame.width * frame.height * (frame.format === 'rgb565' ? 2 : 4),
    );
  }
  poll(): void {
    if (!this.emit) return;
    const now = performance.now();
    if (!this.submitted && now - this.lastTime < 33) return;
    this.submitted = false;
    this.lastTime = now;
    const frame = this.description();
    if (!frame) return;
    const raw = this.read(frame),
      last = this.lastScanout;
    if (
      last &&
      sameDescription(frame, last.description) &&
      samePixels(raw, last.bytes)
    )
      return;
    if (this.pending.size >= 2) {
      this.dropped++;
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
    this.lastScanout = { description: frame, bytes: raw };
    this.pending.set(++this.sent, converted.pixels.byteLength);
    this.emit({ ...converted, frame: this.sent });
  }
}
