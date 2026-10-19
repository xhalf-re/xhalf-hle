import type { RuntimeCore } from '../runtime/core';
import { registerName } from './adapter';
import { copyRgbaRow, addCoverage } from '../services/images';
/** Replace validated bulk loops; unsupported calls continue in ARM. */
export class BulkAcceleration {
  memoryCalls = 0;
  memoryBytes = 0;
  rasterCalls = 0;
  rasterPixels = 0;
  pixelCalls = 0;
  fallbacks = 0;
  private abi;
  private pixelAbi;
  constructor(private core: RuntimeCore) {
    this.abi = core.profile.sdk.raster;
    this.pixelAbi = core.profile.sdk.pixel_loops;
    if (
      this.group('pixels', [
        ...this.pixelAbi.rgba.map((row) => row.site),
        this.pixelAbi.coverage_site,
        this.pixelAbi.masked_transpose.site,
      ])
    ) {
      for (const row of this.pixelAbi.rgba)
        core.bind(row.site, () => this.rgbaRow(row), true);
      core.bind(this.pixelAbi.coverage_site, () => this.coverageSpan(), true);
      core.bind(
        this.pixelAbi.masked_transpose.site,
        () => this.maskedTranspose(),
        true,
      );
    }
    if (this.group('memory', ['libc.memcpy', 'libc.memset'])) {
      core.bind('libc.memcpy', () => {
        const [dst, src, size] = core.sdk.arguments();
        if (
          size! < 64 ||
          !this.ram(dst!, size!) ||
          !this.ram(src!, size!) ||
          (src !== dst &&
            Math.max(src!, dst!) < Math.min(src! + size!, dst! + size!))
        ) {
          this.fallbacks++;
          return;
        }
        core.cpu.write(dst!, core.cpu.read(src!, size!));
        this.memoryCalls++;
        this.memoryBytes += size!;
        core.sdk.ret(dst);
      });
      core.bind('libc.memset', () => {
        const [dst, value, size] = core.sdk.arguments();
        if (size! < 64 || !this.ram(dst!, size!)) {
          this.fallbacks++;
          return;
        }
        core.cpu.write(dst!, new Uint8Array(size!).fill(value! & 255));
        this.memoryCalls++;
        this.memoryBytes += size!;
        core.sdk.ret(dst);
      });
    }
    const a = this.abi,
      names = [
        ...a.sites,
        a.copy,
        a.palette,
        a.shape_done,
        a.buffer_done,
        a.copy_done,
        'raster.colors',
        'raster.border_color',
      ];
    if (this.group('raster', names)) {
      for (const name of a.sites)
        core.bind(name, () => this.draw(name === a.sites[0]), true);
      core.bind(a.copy, () => this.copy(), true);
      core.bind(a.palette, () => this.palette());
    }
  }
  private group(name: string, names: string[]): boolean {
    const { profile } = this.core;
    if (
      profile.disabledGroups.has(name) ||
      names.some((key) => {
        const symbol = profile.firmware.symbols[key];
        return !symbol || profile.disabledGroups.has(symbol.group);
      })
    ) {
      profile.disabledGroups.set(
        name,
        'Optional acceleration group unavailable',
      );
      return false;
    }
    return true;
  }
  private rgbaRow(a: (typeof this.pixelAbi.rgba)[number]): void {
    const { cpu } = this.core;
    const [width, column, sourceAlpha, target, next, sp] = cpu.readRegisters([
      registerName(a.columns),
      registerName(a.column),
      registerName(a.source_alpha),
      registerName(a.target),
      registerName(a.next_target),
      'sp',
    ]) as [number, number, number, number, number, number];
    if (column !== 0 || width <= 1) return;
    const source = sourceAlpha - 3,
      size = (width - 1) * 4;
    if (
      width > 8192 ||
      next !== target + 4 ||
      !this.ram(source, size) ||
      !this.dram(target, size) ||
      !this.ram(sp + a.opacity_stack, 4) ||
      (target < sp + 128 && sp < target + size) ||
      (source < sp + 128 && sp < source + size) ||
      Math.max(source, target) < Math.min(source + size, target + size)
    ) {
      this.fallbacks++;
      return;
    }
    const opacity = this.core.sdk.u32(sp + a.opacity_stack);
    if (opacity > 255) {
      this.fallbacks++;
      return;
    }
    const bytes = cpu.read(target, size);
    copyRgbaRow(cpu.read(source, size), bytes, opacity);
    cpu.write(target, bytes);
    cpu.writeRegisters([
      [registerName(a.column), width - 1],
      [registerName(a.target), target + size],
      [registerName(a.next_target), next + size],
      [registerName(a.source_alpha), sourceAlpha + size],
    ]);
    // Execute the final pixel in ARM to restore scratch registers and flags.
    this.pixelCalls++;
  }
  private coverageSpan(): void {
    const { cpu, sdk } = this.core,
      a = this.pixelAbi;
    const [position, base, length, maximum, next, sp] = cpu.readRegisters([
      registerName(a.coverage_position),
      registerName(a.coverage_base),
      registerName(a.coverage_length),
      registerName(a.coverage_maximum),
      registerName(a.coverage_next),
      'sp',
    ]) as [number, number, number, number, number, number];
    const remaining = base + length - position;
    if (remaining <= 1) return;
    if (
      length > 8192 ||
      position < base ||
      maximum > 65535 ||
      next !== position + 1 ||
      !this.ram(sp + a.coverage_increment_stack, 4) ||
      !this.ram(sp + a.coverage_clamp_stack, 4) ||
      (position + 1 < sp + a.coverage_increment_stack + 4 &&
        sp + a.coverage_clamp_stack < position + remaining) ||
      !this.dram(position + 1, remaining - 1)
    ) {
      this.fallbacks++;
      return;
    }
    const increment = sdk.u32(sp + a.coverage_increment_stack),
      clamp = sdk.u32(sp + a.coverage_clamp_stack);
    if (increment > 65535 || clamp !== (maximum & 255)) {
      this.fallbacks++;
      return;
    }
    const size = remaining - 1,
      bytes = cpu.read(position + 1, size);
    addCoverage(bytes, increment, maximum);
    cpu.write(position + 1, bytes);
    cpu.writeRegisters([
      [registerName(a.coverage_position), position + size],
      [registerName(a.coverage_next), position + size + 1],
    ]);
    this.pixelCalls++;
  }
  private maskedTranspose(): void {
    const { cpu, sdk } = this.core,
      a = this.pixelAbi.masked_transpose;
    const [
      target,
      base,
      column,
      row,
      config,
      colors,
      rows,
      stride,
      alpha,
      mask,
      columns,
      sp,
    ] = cpu.readRegisters([
      'r0',
      'r1',
      'r2',
      'r3',
      'r4',
      'r5',
      'r6',
      'r7',
      'r8',
      'r10',
      'r12',
      'sp',
    ]) as number[];
    if (column !== 0 || row !== 0 || target !== base || columns! * rows! <= 1)
      return;
    if (!this.ram(config! + a.source_stride, 4)) {
      this.fallbacks++;
      return;
    }
    const sourceStride = sdk.u32(config! + a.source_stride),
      sourceSize = (rows! - 1) * sourceStride + columns!,
      targetSize = (columns! - 1) * stride! + rows! * 4,
      targetStart = base! - (columns! - 1) * stride!,
      maskStart = mask! + a.mask_offset,
      colorStart = colors! + a.colors_offset;
    const overlap = (p: number, n: number, q: number, m: number) =>
      p < q + m && q < p + n;
    if (
      columns! < 1 ||
      columns! > 8192 ||
      rows! < 1 ||
      rows! > 8192 ||
      sourceStride < columns! ||
      sourceStride > 8192 ||
      stride! < rows! * 4 ||
      stride! > 32768 ||
      sourceSize > 1048576 ||
      targetSize > 4194304 ||
      !this.ram(maskStart, sourceSize) ||
      !this.ram(colorStart, sourceSize * 4) ||
      !this.dram(targetStart, targetSize) ||
      overlap(targetStart, targetSize, maskStart, sourceSize) ||
      overlap(targetStart, targetSize, colorStart, sourceSize * 4) ||
      overlap(targetStart, targetSize, config! + a.source_stride, 4) ||
      [
        [targetStart, targetSize],
        [maskStart, sourceSize],
        [colorStart, sourceSize * 4],
      ].some(([p, n]) => overlap(p!, n!, sp!, 128))
    ) {
      this.fallbacks++;
      return;
    }
    const output = cpu.read(targetStart, targetSize),
      coverage = cpu.read(maskStart, sourceSize),
      color = cpu.read(colorStart, sourceSize * 4);
    for (let y = 0; y < rows!; y++) {
      for (let x = 0; x < columns!; x++) {
        // Leave the final pixel and loop epilogue to ARM, including its flags.
        if (x === columns! - 1 && y === rows! - 1) break;
        const source = y * sourceStride + x;
        if (!coverage[source]) continue;
        const dest = (columns! - 1 - x) * stride! + y * 4;
        output[dest] = alpha! & 255;
        output[dest + 1] = color[source * 4 + 1]!;
        output[dest + 2] = color[source * 4 + 2]!;
        output[dest + 3] = color[source * 4 + 3]!;
      }
    }
    cpu.write(targetStart, output);
    cpu.writeRegisters([
      ['r0', base! + (rows! - 1) * 4 - (columns! - 1) * stride!],
      ['r1', base! + (rows! - 1) * 4],
      ['r2', columns! - 1],
      ['r3', rows! - 1],
    ]);
    this.pixelCalls++;
  }
  private ram(pointer: number, size: number): boolean {
    return this.core.profile.inRam(pointer, size);
  }
  private dram(pointer: number, size: number): boolean {
    return this.core.profile.inRam(pointer, size, true);
  }
  private reg(key: keyof typeof this.abi): number {
    return this.core.cpu.readRegister(registerName(String(this.abi[key])));
  }
  private copy(): void {
    const { cpu, sdk, profile } = this.core,
      a = this.abi,
      source = this.reg('copy_source'),
      target = this.reg('copy_target'),
      columns = this.reg('copy_columns'),
      rows = this.reg('copy_rows');
    const sourceStride = sdk.u32(this.reg('copy_descriptor') + a.source_stride),
      targetStride = sdk.u32(cpu.readRegister('sp') + a.copy_stride_stack),
      ss = ((rows - 1) * sourceStride + columns) * 4,
      ts = ((rows - 1) * targetStride + columns) * 4;
    if (
      !(
        columns > 0 &&
        columns <= Math.min(sourceStride, targetStride) &&
        Math.max(sourceStride, targetStride) <= 8192 &&
        rows > 0 &&
        rows <= 8192 &&
        this.dram(source, ss) &&
        this.dram(target, ts)
      ) ||
      Math.max(source, target) < Math.min(source + ss, target + ts)
    ) {
      this.fallbacks++;
      return;
    }
    if (columns === sourceStride && columns === targetStride)
      cpu.write(target, cpu.read(source, columns * rows * 4));
    else
      for (let row = 0; row < rows; row++)
        cpu.write(
          target + row * targetStride * 4,
          cpu.read(source + row * sourceStride * 4, columns * 4),
        );
    this.rasterCalls++;
    this.rasterPixels += rows * columns;
    cpu.writeRegister('r0', source + rows * (sourceStride - columns) * 4);
    cpu.writeRegister('pc', profile.address(a.copy_done));
  }
  private palette(): void {
    const { cpu, sdk } = this.core,
      [width, height, source, target] = sdk.arguments(),
      palette = sdk.u32(cpu.readRegister('sp')),
      alpha = sdk.u32(cpu.readRegister('sp') + 4),
      size = width! * height!;
    if (!(
      width! > 0 &&
      width! <= 8192 &&
      height! > 0 &&
      height! <= 8192 &&
      this.dram(source!, size) &&
      this.dram(target!, size * 4) &&
      this.dram(palette, 1024) &&
      this.dram(alpha, 256)
    )) {
      this.fallbacks++;
      return;
    }
    const indices = cpu.read(source!, size),
      colors = new DataView(cpu.read(palette, 1024).buffer),
      opacity = cpu.read(alpha, 256),
      output = new Uint8Array(size * 4),
      view = new DataView(output.buffer);
    for (let i = 0; i < size; i++) {
      const index = indices[i]!;
      view.setUint32(
        i * 4,
        (colors.getUint32(index * 4, true) | opacity[index]!) >>> 0,
        true,
      );
    }
    cpu.write(target!, output);
    this.rasterCalls++;
    this.rasterPixels += size;
    sdk.ret(width);
  }
  private draw(shape: boolean): void {
    const { cpu, sdk, profile } = this.core,
      a = this.abi,
      columns = this.reg('shape_columns'),
      rows = this.reg('shape_rows'),
      mx = this.reg('shape_margin_x');
    const target = shape ? this.reg('shape_target') : this.reg('buffer_target'),
      stride = shape
        ? sdk.u32(cpu.readRegister('sp') + a.shape_stride_stack)
        : sdk.u32(this.reg('buffer_descriptor') + a.source_stride),
      style = this.reg(shape ? 'shape_style' : 'buffer_style'),
      my = this.reg(shape ? 'shape_margin_y' : 'buffer_margin_y'),
      done = profile.address(shape ? a.shape_done : a.buffer_done);
    if (!(
      columns > 0 &&
      columns <= stride &&
      stride <= 8192 &&
      rows > 0 &&
      rows <= 8192 &&
      this.dram(target, ((rows - 1) * stride + columns) * 4)
    )) {
      this.fallbacks++;
      return;
    }
    const color = cpu.read(profile.address('raster.colors'), 4).reverse(),
      border = cpu.read(profile.address('raster.border_color'), 4).reverse();
    const line = (pixel: Uint8Array, n: number) => {
      const bytes = new Uint8Array(n * 4);
      for (let i = 0; i < n; i++) bytes.set(pixel, i * 4);
      return bytes;
    };
    if (style === 1) {
      const edge = line(border, columns);
      for (let row = 0; row < rows; row++) {
        const pointer = target + row * stride * 4;
        if (row < my || row >= rows - my || mx * 2 >= columns)
          cpu.write(pointer, edge);
        else if (mx) {
          cpu.write(pointer, edge.subarray(0, mx * 4));
          cpu.write(pointer + (columns - mx) * 4, edge.subarray(0, mx * 4));
        }
      }
    } else if (style === 2) {
      const middle = line(border, columns),
        edge = line(border, columns);
      if (columns - mx > mx) middle.set(line(color, columns - mx * 2), mx * 4);
      for (let row = 0; row < rows; row++)
        cpu.write(
          target + row * stride * 4,
          row >= my && rows - row > mx ? middle : edge,
        );
    } else {
      const row = line(color, columns);
      if (columns === stride) {
        const all = new Uint8Array(row.length * rows);
        for (let i = 0; i < rows; i++) all.set(row, i * row.length);
        cpu.write(target, all);
      } else
        for (let i = 0; i < rows; i++) cpu.write(target + i * stride * 4, row);
    }
    this.rasterCalls++;
    this.rasterPixels += rows * columns;
    cpu.writeRegister('pc', done);
  }
}
