// Native fast path for the common contiguous ABGR32 composition shape.
// Unsupported shapes return NotSupported before touching guest memory.
#pragma once
#include <algorithm>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <memory>

struct NativeComposeSurface {
  U32 address, width, height, bpp;
};
struct NativeComposeLayer {
  U32 address, width, height, bpp;
  int32_t sx, sy, cw, ch, dx, dy, dw, dh;
  U32 flags;
};
static_assert(sizeof(NativeComposeSurface) == 16);
static_assert(sizeof(NativeComposeLayer) == 52);
inline constexpr U32 NativeComposeNotSupported = 0xffffffffu;

template <typename Memory>
U32 nativeCompose4(Memory &memory, const NativeComposeSurface *surface,
                   const NativeComposeLayer *layers, U32 count) {
  const auto &s = *surface;
  if (!s.width || !s.height || s.width > 4096 || s.height > 4096 ||
      s.bpp != 4)
    return NativeComposeNotSupported;
  for (U32 i = 0; i < count; i++) {
    const auto &layer = layers[i];
    if (!layer.cw || !layer.ch || !layer.dw || !layer.dh)
      continue;
    if (layer.flags || layer.bpp != 4 || layer.sx < 0 || layer.sy < 0 ||
        layer.cw < 0 || layer.ch < 0 ||
        int64_t(layer.sx) + layer.cw > layer.width ||
        int64_t(layer.sy) + layer.ch > layer.height || layer.dw < 0 ||
        layer.dh < 0 || layer.cw != layer.dw || layer.ch != layer.dh ||
        U64(layer.width) * layer.height * 4 > 0xffffffffull)
      return NativeComposeNotSupported;
  }
  const U32 outputSize = s.width * s.height * 4;
  std::unique_ptr<uint8_t, decltype(&free)> output(
      static_cast<uint8_t *>(malloc(outputSize)), &free);
  if (!output)
    return NoMemory;
  if (const U32 error = memory.transfer(s.address, outputSize, output.get(), false))
    return error;
  for (U32 i = 0; i < count; i++) {
    const auto &layer = layers[i];
    if (!layer.cw || !layer.ch || !layer.dw || !layer.dh)
      continue;
    const U32 sourceSize = layer.width * layer.height * 4;
    uint8_t *view;
    if (const U32 error = memory.view(layer.address, sourceSize, &view))
      return error;
    std::unique_ptr<uint8_t, decltype(&free)> copy(nullptr, &free);
    if (!view) {
      copy.reset(static_cast<uint8_t *>(malloc(sourceSize)));
      if (!copy)
        return NoMemory;
      if (const U32 error =
              memory.transfer(layer.address, sourceSize, copy.get(), false))
        return error;
      view = copy.get();
    }
    const int64_t right = int64_t(layer.dx) + layer.dw,
                  bottom = int64_t(layer.dy) + layer.dh;
    const U32 x0 = std::max(0, layer.dx),
              x1 = right <= 0
                       ? 0
                       : U32(std::min<int64_t>(s.width, right)),
              y0 = std::max(0, layer.dy),
              y1 = bottom <= 0
                       ? 0
                       : U32(std::min<int64_t>(s.height, bottom));
    if (x1 <= x0 || y1 <= y0)
      continue;
    const U32 sourceStride = layer.width * 4, outputStride = s.width * 4,
              sourceX = layer.sx + x0 - layer.dx,
              sourceY = layer.sy + y0 - layer.dy;
    for (U32 y = y0; y < y1; y++) {
      const uint8_t *from =
          view + (sourceY + y - y0) * sourceStride + sourceX * 4;
      uint8_t *to = output.get() + y * outputStride + x0 * 4;
      for (U32 x = x0; x < x1; x++, from += 4, to += 4) {
        const U32 alpha = from[0];
        if (!alpha)
          continue;
        if (alpha == 255) {
          memcpy(to, from, 4);
          continue;
        }
        const U32 inverse = 255 - alpha, oldAlpha = to[0];
        for (U32 c = 1; c < 4; c++)
          to[c] = (from[c] * alpha + to[c] * inverse + 127) / 255;
        to[0] = alpha + (oldAlpha * inverse + 127) / 255;
      }
    }
  }
  return memory.transfer(s.address, outputSize, output.get(), true);
}
