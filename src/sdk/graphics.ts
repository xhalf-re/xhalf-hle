import type { RuntimeCore } from '../runtime/core';
import { combinePixels, fillPixels } from '../services/images';
import type { Composition, Fill } from '../services/images';

function canCompose4(composition: Composition): boolean {
  const s = composition.surface;
  if (
    s.width <= 0 ||
    s.height <= 0 ||
    s.width > 4096 ||
    s.height > 4096 ||
    s.bpp !== 4
  )
    return false;
  return composition.layers.every((layer) => {
    const source = layer.surface,
      [sx, sy, cw, ch] = layer.crop,
      [dx, dy, dw, dh] = layer.target;
    if (!cw || !ch || !dw || !dh) return true;
    return (
      !layer.rotate &&
      !layer.mirrorX &&
      !layer.mirrorY &&
      source.bpp === 4 &&
      sx >= 0 &&
      sy >= 0 &&
      cw >= 0 &&
      ch >= 0 &&
      sx + cw <= source.width &&
      sy + ch <= source.height &&
      dw >= 0 &&
      dh >= 0 &&
      cw === dw &&
      ch === dh &&
      source.width * source.height * 4 <= 0xffffffff &&
      Number.isInteger(dx) &&
      Number.isInteger(dy)
    );
  });
}

/** SDK graphics hardware. Drawing never determines whether scanout is current. */
export class SdkGraphics {
  graphicsMs = 0;
  constructor(private core: RuntimeCore) {
    const { cpu, profile, sdk } = core;
    core.bind('image.rect_fill', () => {
      const started = performance.now();
      const decoded = this.decodeFill(cpu.readRegister('r0'));
      if (decoded)
        fillPixels(decoded, (a, b) => {
          if (!profile.inRam(a, b.length, true))
            throw new Error('Fill outside DRAM');
          cpu.write(a, b);
        });
      this.graphicsMs += performance.now() - started;
      sdk.ret();
    });
    core.bind('image.combine', () => {
      const started = performance.now();
      const decoded = this.decodeComposition(cpu.readRegister('r0')),
        read = (a: number, n: number, layer = false) => {
          if (!profile.inRam(a, n, true))
            throw new Error('Composition read outside DRAM');
          return layer && cpu.readView ? cpu.readView(a, n) : cpu.read(a, n);
        };
      let combined = false;
      if (canCompose4(decoded) && cpu.compose4) {
        const s = decoded.surface;
        if (!profile.inRam(s.address, s.width * s.height * s.bpp, true))
          throw new Error('Composition read outside DRAM');
        for (const layer of decoded.layers) {
          const source = layer.surface,
            [, , cw, ch] = layer.crop,
            [, , dw, dh] = layer.target;
          if (
            cw &&
            ch &&
            dw &&
            dh &&
            !profile.inRam(
              source.address,
              source.width * source.height * source.bpp,
              true,
            )
          )
            throw new Error('Composition read outside DRAM');
        }
        combined = cpu.compose4(decoded);
      }
      if (!combined)
        combinePixels(
          decoded,
          (a, n) => read(a, n),
          (a, b) => {
            if (!profile.inRam(a, b.length, true))
              throw new Error('Composition write outside DRAM');
            cpu.write(a, b);
          },
          (a, n) => read(a, n, true),
        );
      this.graphicsMs += performance.now() - started;
      sdk.ret();
    });
  }
  private decodeFill(descriptor: number): Fill | null {
    const { sdk, profile } = this.core,
      v = sdk.structure(descriptor, 'fill'),
      formats = profile.sdk.images;
    if (!v.rect_width || !v.rect_height) return null;
    const packed = (formats.fill_packed_formats as Record<string, number>)[
        `0x${v.format!.toString(16)}`
      ],
      planar = formats.fill_yuv_formats.includes(v.format!);
    if (!packed && !planar) throw new Error('Unsupported fill format');
    return {
      surface: {
        address: sdk.physical(v.address!),
        width: v.width!,
        height: v.height!,
        bpp: packed ?? 1,
        format: v.format!,
      },
      rect:
        v.flags! & formats.fill_rect_flag
          ? [v.x!, v.y!, v.rect_width!, v.rect_height!]
          : [0, 0, v.width!, v.height!],
      color: v.color!,
      planar,
    };
  }
  private decodeComposition(descriptor: number): Composition {
    const { sdk, profile } = this.core,
      v = sdk.structure(descriptor, 'hwc'),
      formats = profile.sdk.images,
      abi = profile.layouts.hwc!,
      bpp = (f: number) =>
        (formats.hwc_formats as Record<string, number>)[String(f)];
    const result: Composition = {
      surface: {
        address: sdk.physical(v.address!),
        width: v.width!,
        height: v.height!,
        bpp: bpp(v.format!) ?? 2,
        format: v.format!,
      },
      layers: [],
    };
    for (let i = 0; i < Number(abi.layer_count); i++) {
      const row = sdk.structure(
        descriptor + i * Number(abi.layer_stride),
        'hwc_layer',
      );
      if (!row.address || !row.width || !row.height) continue;
      const size = bpp(row.format!);
      if (!size) throw new Error('Unsupported HWC format');
      result.layers.push({
        surface: {
          address: sdk.physical(row.address),
          width: row.width,
          height: row.height,
          bpp: size,
          format: row.format!,
        },
        crop:
          row.flags! & formats.crop_flag
            ? [row.crop_x!, row.crop_y!, row.crop_width!, row.crop_height!]
            : [0, 0, row.width, row.height],
        target:
          row.flags! & formats.output_rect_flag
            ? [row.x!, row.y!, row.out_width!, row.out_height!]
            : [0, 0, v.width!, v.height!],
        rotate: !!(row.transform! & formats.rotate_flag),
        mirrorX: !!(row.transform! & formats.mirror_x),
        mirrorY: !!(row.transform! & formats.mirror_y),
      });
    }
    return result;
  }
}
