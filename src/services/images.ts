/** Host pixel services accept decoded geometry, never ARM registers or firmware addresses. */
export interface Surface {
  address: number;
  width: number;
  height: number;
  bpp: number;
  format: number;
}
export interface Fill {
  surface: Surface;
  rect: [number, number, number, number];
  color: number;
  planar: boolean;
}
export interface Layer {
  surface: Surface;
  crop: [number, number, number, number];
  target: [number, number, number, number];
  rotate: boolean;
  mirrorX: boolean;
  mirrorY: boolean;
}
export interface Composition {
  surface: Surface;
  layers: Layer[];
}
export type ReadMemory = (address: number, size: number) => Uint8Array;
export type WriteMemory = (address: number, bytes: Uint8Array) => void;
export function fillPixels(fill: Fill, write: WriteMemory): void {
  const { surface: s, color, planar } = fill,
    [x, y, w, h] = fill.rect;
  if (
    s.width <= 0 ||
    s.height <= 0 ||
    s.width > 8192 ||
    s.height > 8192 ||
    x < 0 ||
    y < 0 ||
    w < 0 ||
    h < 0 ||
    x + w > s.width ||
    y + h > s.height
  )
    throw new Error('Invalid fill geometry');
  if (!w || !h) return;
  if (planar) {
    const row = new Uint8Array(w).fill((color >>> 16) & 255),
      chroma = new Uint8Array(w);
    for (let i = 0; i < w; i++)
      chroma[i] = i & 1 ? (color >>> 8) & 255 : color & 255;
    for (let r = y; r < y + h; r++) {
      write(s.address + r * s.width + x, row);
      write(s.address + s.width * s.height + r * s.width + x, chroma);
    }
    return;
  }
  const row = new Uint8Array(w * s.bpp);
  for (let at = 0; at < row.length; at++)
    row[at] = (color >>> (8 * (at % s.bpp))) & 255;
  if (x === 0 && w === s.width) {
    const block = new Uint8Array(row.length * h);
    for (let i = 0; i < h; i++) block.set(row, i * row.length);
    write(s.address + y * s.width * s.bpp, block);
  } else
    for (let r = y; r < y + h; r++)
      write(s.address + (r * s.width + x) * s.bpp, row);
}
export function combinePixels(
  composition: Composition,
  read: ReadMemory,
  write: WriteMemory,
): void {
  const s = composition.surface;
  if (s.width <= 0 || s.height <= 0 || s.width > 4096 || s.height > 4096)
    throw new Error('Invalid composition geometry');
  const output = read(s.address, s.width * s.height * s.bpp),
    littleEndian = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1,
    outputWords =
      s.bpp === 4 && littleEndian && output.byteOffset % 4 === 0
        ? new Uint32Array(
            output.buffer,
            output.byteOffset,
            output.byteLength / 4,
          )
        : undefined;
  for (const layer of composition.layers) {
    const src = layer.surface,
      [sx, sy, cw, ch] = layer.crop,
      [dx, dy, dw, dh] = layer.target;
    if (!cw || !ch || !dw || !dh) continue;
    if (
      src.bpp !== s.bpp ||
      sx < 0 ||
      sy < 0 ||
      cw < 0 ||
      ch < 0 ||
      sx + cw > src.width ||
      sy + ch > src.height ||
      dw < 0 ||
      dh < 0
    )
      throw new Error('Unsupported composition layer');
    const bytes = read(src.address, src.width * src.height * src.bpp),
      rw = layer.rotate ? ch : cw,
      rh = layer.rotate ? cw : ch;
    const x0 = Math.max(0, dx),
      x1 = Math.min(s.width, dx + dw),
      y0 = Math.max(0, dy),
      y1 = Math.min(s.height, dy + dh);
    if (x1 <= x0 || y1 <= y0) continue;
    const xSamples = Int32Array.from({ length: x1 - x0 }, (_, i) => {
        const tx = Math.floor(((x0 + i - dx) * rw) / dw);
        return layer.mirrorX ? rw - 1 - tx : tx;
      }),
      sourceWords =
        src.bpp === 4 && littleEndian && bytes.byteOffset % 4 === 0
          ? new Uint32Array(
              bytes.buffer,
              bytes.byteOffset,
              bytes.byteLength / 4,
            )
          : undefined;
    for (let y = y0; y < y1; y++) {
      let ty = Math.floor(((y - dy) * rh) / dh);
      if (layer.mirrorY) ty = rh - 1 - ty;
      for (let x = x0; x < x1; x++) {
        const tx = xSamples[x - x0]!;
        const ix = layer.rotate ? ty : tx,
          iy = layer.rotate ? ch - 1 - tx : ty,
          from = ((sy + iy) * src.width + sx + ix) * src.bpp,
          to = (y * s.width + x) * s.bpp;
        if (s.bpp === 4) {
          const alpha = bytes[from]!;
          if (!alpha) continue;
          if (alpha === 255) {
            if (sourceWords && outputWords)
              outputWords[to / 4] = sourceWords[from / 4]!;
            else {
              output[to] = bytes[from]!;
              output[to + 1] = bytes[from + 1]!;
              output[to + 2] = bytes[from + 2]!;
              output[to + 3] = bytes[from + 3]!;
            }
            continue;
          }
          const oldAlpha = output[to]!;
          for (let c = 1; c < 4; c++)
            output[to + c] = Math.floor(
              (bytes[from + c]! * alpha +
                output[to + c]! * (255 - alpha) +
                127) /
                255,
            );
          output[to] =
            alpha + Math.floor((oldAlpha * (255 - alpha) + 127) / 255);
        } else
          for (let component = 0; component < s.bpp; component++)
            output[to + component] = bytes[from + component]!;
      }
    }
  }
  write(s.address, output);
}

/** Native RGBA -> ABGR copy: zero resulting alpha preserves the destination. */
export function copyRgbaRow(
  source: Uint8Array,
  target: Uint8Array,
  opacity: number,
): void {
  if (
    source.length !== target.length ||
    source.length % 4 ||
    !Number.isInteger(opacity) ||
    opacity < 0 ||
    opacity > 255
  )
    throw new Error('Invalid RGBA row');
  for (let i = 0; i < source.length; i += 4) {
    const alpha = Math.floor((source[i + 3]! * opacity) / 100) & 255;
    if (!alpha) continue;
    const red = source[i]!,
      green = source[i + 1]!,
      blue = source[i + 2]!;
    target[i] = alpha;
    target[i + 1] = blue;
    target[i + 2] = green;
    target[i + 3] = red;
  }
}

/** Native coverage clamping followed by storage of the low byte. */
export function addCoverage(
  bytes: Uint8Array,
  increment: number,
  maximum: number,
): void {
  if (
    !Number.isInteger(increment) ||
    increment < 0 ||
    increment > 65535 ||
    !Number.isInteger(maximum) ||
    maximum < 0 ||
    maximum > 65535
  )
    throw new Error('Invalid coverage span');
  for (let i = 0; i < bytes.length; i++)
    bytes[i] = Math.min(maximum, bytes[i]! + increment);
}
