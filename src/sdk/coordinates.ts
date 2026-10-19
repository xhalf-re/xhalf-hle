export interface Point {
  x: number;
  y: number;
}
export interface Size {
  width: number;
  height: number;
}
export interface Rect extends Size {
  left: number;
  top: number;
}
/** Contained image geometry, including CSS letterboxing. Inputs use CSS pixels, never device pixels. */
export function canvasPoint(
  client: Point,
  box: Rect,
  image: Size,
): { point: Point; inside: boolean } {
  if (
    box.width <= 0 ||
    box.height <= 0 ||
    image.width <= 0 ||
    image.height <= 0
  )
    return { point: { x: 0, y: 0 }, inside: false };
  const scale = Math.min(box.width / image.width, box.height / image.height),
    left = box.left + (box.width - image.width * scale) / 2,
    top = box.top + (box.height - image.height * scale) / 2;
  const x = (client.x - left) / scale,
    y = (client.y - top) / scale,
    inside = x >= 0 && x < image.width && y >= 0 && y < image.height;
  return {
    point: {
      x: Math.max(0, Math.min(image.width - 1, Math.floor(x))),
      y: Math.max(0, Math.min(image.height - 1, Math.floor(y))),
    },
    inside,
  };
}
/** Invert the display rotation only when the SDK consumes raw scan-buffer coordinates. */
export function sdkPoint(
  point: Point,
  display: Size,
  scan: Size,
  rotation: number,
  space: string,
  target: Size,
): Point {
  let x = point.x,
    y = point.y,
    source = display;
  if (space === 'scan-buffer') {
    const turn = ((rotation % 4) + 4) % 4;
    [x, y] =
      turn === 1
        ? [scan.width - 1 - point.y, point.x]
        : turn === 2
          ? [scan.width - 1 - point.x, scan.height - 1 - point.y]
          : turn === 3
            ? [point.y, scan.height - 1 - point.x]
            : [point.x, point.y];
    source = scan;
  } else if (space !== 'display')
    throw new Error('Unknown SDK pointer coordinate space');
  return {
    x: Math.max(
      0,
      Math.min(target.width - 1, Math.floor((x * target.width) / source.width)),
    ),
    y: Math.max(
      0,
      Math.min(
        target.height - 1,
        Math.floor((y * target.height) / source.height),
      ),
    ),
  };
}
