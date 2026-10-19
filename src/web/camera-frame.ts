/**
 * Line art of the X half body, straight rear view. The geometry is transcribed
 * from Fujifilm's own 649×363 rear render (camera-body-back-transparent.png on
 * the X half product page): body x 34–614, y 6–359 maps to the 1645×1000
 * design box, so every constant below can be checked against that render.
 *
 * The two "screens" of the real camera are one 640×480 panel seen through two
 * openings in the body: the pill-shaped film window and the main window. The
 * main glass shows frame x 272–628 (the menu header bar and row separators of
 * the firmware span exactly this range) over the full 480 rows, which is the
 * 3:4 portrait window of the render; the outer 8–12 columns and the hidden
 * middle of the panel sit behind the body. The canvas therefore covers the
 * whole panel and a clip path reveals only the two openings.
 *
 * Decorative (aria-hidden); styling lives in style.css through the
 * .line / .faint / .etch / .grain classes and currentColor.
 */

/** Scale and origin of the official render → design box (viewBox) mapping. */
const S = 2.828;
const OX = 34;
const OY = 6;
const vx = (x: number): number => +((x - OX) * S).toFixed(1);
const vy = (y: number): number => +((y - OY) * S).toFixed(1);
const vs = (d: number): number => +(d * S).toFixed(1);
type Rect = { x: number; y: number; width: number; height: number };
/** Rectangle given in official-render coordinates (x0, y0, x1, y1). */
const official = (x0: number, y0: number, x1: number, y1: number): Rect => ({
  x: vx(x0),
  y: vy(y0),
  width: vs(x1 - x0),
  height: vs(y1 - y0),
});

/** SVG viewBox: body plus strap lugs (sides) and dial/shutter (top). */
export const VIEW_BOX = { x: -104, y: -96, width: 1848, height: 1106 } as const;
const BODY = { width: 1645, height: 1000 } as const;

/** Openings in the render: film window and main window (CSS rects). */
export const PILL_WINDOW = official(111, 160, 151, 295);
export const MAIN_WINDOW = official(222, 126, 375, 330);

/**
 * Frame columns visible through the main glass. Together with the full 480
 * rows this gives the window's 3:4 aspect; k is the shared design-units per
 * frame pixel.
 */
const GLASS_COLUMNS = { from: 272, to: 628 } as const;
const FRAME = { width: 640, height: 480 } as const;
const K =
  (MAIN_WINDOW.height / FRAME.height +
    MAIN_WINDOW.width / (GLASS_COLUMNS.to - GLASS_COLUMNS.from)) /
  2;

/** Full display panel (the canvas) in design units — exactly 4:3. */
export const PANEL: Rect = {
  x: +(
    MAIN_WINDOW.x +
    MAIN_WINDOW.width / 2 -
    ((GLASS_COLUMNS.from + GLASS_COLUMNS.to) / 2) * K
  ).toFixed(1),
  y: +(MAIN_WINDOW.y + MAIN_WINDOW.height / 2 - (FRAME.height / 2) * K).toFixed(
    1,
  ),
  width: +(FRAME.width * K).toFixed(1),
  height: +(FRAME.height * K).toFixed(1),
};

/** Recessed black bezel around the main glass / film window (render ≈ 13.5 / 8 px). */
const MAIN_RING = vs(13.5);
const PILL_RING = vs(8);
const grow = (r: Rect, d: number): Rect => ({
  x: +(r.x - d).toFixed(1),
  y: +(r.y - d).toFixed(1),
  width: +(r.width + 2 * d).toFixed(1),
  height: +(r.height + 2 * d).toFixed(1),
});
const MAIN_BEZEL = grow(MAIN_WINDOW, MAIN_RING);
const PILL_BEZEL = grow(PILL_WINDOW, PILL_RING);

/** Rounded-rect path for a unit-less rectangle with uniform radius. */
const roundRect = (r: Rect, rx: number): string =>
  `M${r.x + rx} ${r.y}h${r.width - 2 * rx}a${rx} ${rx} 0 0 1 ${rx} ${rx}v${r.height - 2 * rx}` +
  `a${rx} ${rx} 0 0 1 -${rx} ${rx}h-${r.width - 2 * rx}a${rx} ${rx} 0 0 1 -${rx} -${rx}v-${r.height - 2 * rx}` +
  `a${rx} ${rx} 0 0 1 ${rx} -${rx}Z`;

const MAIN_RADIUS = 6;
const pillRadius = PILL_WINDOW.width / 2;

/**
 * clip-path (objectBoundingBox units over the canvas box) that shows only the
 * film window and the main window. Arcs use per-axis radii because the box is
 * not square.
 */
export const PANEL_CLIP_PATH = (() => {
  const fx = (x: number): number => +((x - PANEL.x) / PANEL.width).toFixed(5);
  const fy = (y: number): number => +((y - PANEL.y) / PANEL.height).toFixed(5);
  const rx = (d: number): number => +(d / PANEL.width).toFixed(5);
  const ry = (d: number): number => +(d / PANEL.height).toFixed(5);
  const m = MAIN_WINDOW;
  const p = PILL_WINDOW;
  const main =
    `M${fx(m.x + MAIN_RADIUS)} ${fy(m.y)}H${fx(m.x + m.width - MAIN_RADIUS)}` +
    `A${rx(MAIN_RADIUS)} ${ry(MAIN_RADIUS)} 0 0 1 ${fx(m.x + m.width)} ${fy(m.y + MAIN_RADIUS)}` +
    `V${fy(m.y + m.height - MAIN_RADIUS)}` +
    `A${rx(MAIN_RADIUS)} ${ry(MAIN_RADIUS)} 0 0 1 ${fx(m.x + m.width - MAIN_RADIUS)} ${fy(m.y + m.height)}` +
    `H${fx(m.x + MAIN_RADIUS)}` +
    `A${rx(MAIN_RADIUS)} ${ry(MAIN_RADIUS)} 0 0 1 ${fx(m.x)} ${fy(m.y + m.height - MAIN_RADIUS)}` +
    `V${fy(m.y + MAIN_RADIUS)}` +
    `A${rx(MAIN_RADIUS)} ${ry(MAIN_RADIUS)} 0 0 1 ${fx(m.x + MAIN_RADIUS)} ${fy(m.y)}Z`;
  const pill =
    `M${fx(p.x)} ${fy(p.y + pillRadius)}` +
    `A${rx(pillRadius)} ${ry(pillRadius)} 0 0 1 ${fx(p.x + p.width)} ${fy(p.y + pillRadius)}` +
    `V${fy(p.y + p.height - pillRadius)}` +
    `A${rx(pillRadius)} ${ry(pillRadius)} 0 0 1 ${fx(p.x)} ${fy(p.y + p.height - pillRadius)}Z`;
  return `${main}${pill}`;
})();

/** Top-right step where the dial housing sits (render: x 592, y 46). */
const STEP = { x: vx(592), y: vy(46) };
const SEAM = vy(112);
const BASE = 960;

const eye = { x: vx(130), y: vy(59.5), r: vs(49) };
const sensor = official(190, 39, 207, 78);
const shoe = official(241, 6, 357, 30);
const lever = official(396, 6, 592, 44);
const dial = official(467, -4, 592, 43);
const shutter = official(509, -8, 552, 3);
const slider = official(421, 66, 457, 92);
const play = { x: vx(532.5), y: vy(78.5), r: vs(13.5) };
const lug = { y: vy(94.5), r: vs(16.2), left: vx(16), right: vx(632) };

/** Body line art, rendered below the canvas. */
export const BODY_ART_SVG = `
<svg class="body-art" viewBox="${VIEW_BOX.x} ${VIEW_BOX.y} ${VIEW_BOX.width} ${VIEW_BOX.height}"
     aria-hidden="true" focusable="false">
  <defs>
    <clipPath id="body-clip"><path d="${bodyPath()}"/></clipPath>
    <clipPath id="dial-clip"><rect x="${dial.x}" y="${dial.y}" width="${dial.width}" height="${dial.height}" rx="12"/></clipPath>
    <pattern id="leather-grain" width="26" height="26" patternUnits="userSpaceOnUse">
      <circle class="grain" cx="6" cy="6" r="1.6"/>
      <circle class="grain" cx="19" cy="19" r="1.6"/>
    </pattern>
  </defs>

  <!-- strap lugs sit on the top-plate band -->
  ${[lug.left, lug.right]
    .map(
      (
        cx,
      ) => `<circle class="line faint" cx="${cx}" cy="${lug.y}" r="${lug.r}"/>
  <circle class="line faint" cx="${cx}" cy="${lug.y}" r="${vs(6.5)}"/>`,
    )
    .join('\n  ')}

  <!-- shutter button, exposure dial and frame-advance lever (top right) -->
  <rect class="line" x="${shutter.x}" y="${shutter.y}" width="${shutter.width}" height="${shutter.height}" rx="8"/>
  <rect class="line body" x="${dial.x}" y="${dial.y}" width="${dial.width}" height="${dial.height}" rx="12"/>
  <g clip-path="url(#dial-clip)">${knurl()}</g>
  <rect class="line" x="${lever.x}" y="${lever.y - 12}" width="${lever.width}" height="${lever.height + 12}" rx="8"/>
  <line class="line faint" x1="${lever.x + 14}" y1="${lever.y + lever.height - 18}" x2="${lever.x + lever.width - 14}" y2="${lever.y + lever.height - 18}"/>

  <!-- body shell -->
  <path class="line body" d="${bodyPath()}"/>
  <g clip-path="url(#body-clip)">
    <rect class="leather" x="0" y="${SEAM}" width="${BODY.width}" height="${BASE - SEAM}" fill="url(#leather-grain)"/>
  </g>
  <line class="line faint" x1="10" y1="${SEAM}" x2="${BODY.width - 10}" y2="${SEAM}"/>
  <line class="line faint" x1="10" y1="${BASE}" x2="${BODY.width - 10}" y2="${BASE}"/>

  <!-- cold shoe recess -->
  <rect class="line faint" x="${shoe.x}" y="${shoe.y}" width="${shoe.width}" height="${shoe.height}" rx="10"/>
  <line class="line faint" x1="${shoe.x + 14}" y1="${shoe.y + shoe.height * 0.55}" x2="${shoe.x + shoe.width - 14}" y2="${shoe.y + shoe.height * 0.55}"/>

  <!-- viewfinder eyepiece, eye sensor and pinhole -->
  <circle class="line" cx="${eye.x}" cy="${eye.y}" r="${eye.r}"/>
  <circle class="line faint" cx="${eye.x}" cy="${eye.y}" r="${+(eye.r * 0.8).toFixed(1)}"/>
  <rect class="line" x="${+(eye.x - eye.r * 0.4).toFixed(1)}" y="${+(eye.y - eye.r * 0.36).toFixed(1)}"
        width="${+(eye.r * 0.8).toFixed(1)}" height="${+(eye.r * 0.72).toFixed(1)}" rx="16"/>
  <rect class="line faint" x="${sensor.x}" y="${sensor.y}" width="${sensor.width}" height="${sensor.height}" rx="7"/>
  <circle class="line faint" cx="${vx(73)}" cy="${vy(60)}" r="10"/>

  <!-- rear controls: drawn for fidelity, not part of the emulated input -->
  <g class="dead-key">
    <title>STILL/MOVIE switch — not part of the emulated input</title>
    <rect class="line" x="${slider.x}" y="${slider.y}" width="${slider.width}" height="${slider.height}" rx="${+(slider.height / 2).toFixed(1)}"/>
    <circle class="line faint" cx="${+(slider.x + slider.height / 2).toFixed(1)}" cy="${+(slider.y + slider.height / 2).toFixed(1)}" r="${+(slider.height * 0.4).toFixed(1)}"/>
  </g>
  <text class="etch label" x="${vx(416.5)}" y="${vy(83.5)}" text-anchor="end" textLength="${vs(26.5)}" lengthAdjust="spacingAndGlyphs">STILL</text>
  <text class="etch label" x="${vx(464)}" y="${vy(83.5)}" textLength="${vs(36)}" lengthAdjust="spacingAndGlyphs">MOVIE</text>
  <g class="dead-key">
    <title>PLAY button — playback is outside the emulated feature set</title>
    <circle class="line" cx="${play.x}" cy="${play.y}" r="${play.r}"/>
    <circle class="line faint" cx="${play.x}" cy="${play.y}" r="${+(play.r * 0.62).toFixed(1)}"/>
  </g>
  <text class="etch label" x="${vx(552.5)}" y="${vy(83.5)}" textLength="${vs(26)}" lengthAdjust="spacingAndGlyphs">PLAY</text>

  <!-- recessed bezels and panel glass; the canvas shows through the openings -->
  <path class="bezel" fill-rule="evenodd" d="${roundRect(MAIN_BEZEL, 12)}${roundRect(MAIN_WINDOW, MAIN_RADIUS)}"/>
  <path class="bezel" fill-rule="evenodd" d="${roundRect(PILL_BEZEL, PILL_BEZEL.width / 2)}${roundRect(PILL_WINDOW, pillRadius)}"/>
  <path class="line faint" d="${roundRect(MAIN_BEZEL, 12)}"/>
  <path class="line faint" d="${roundRect(PILL_BEZEL, PILL_BEZEL.width / 2)}"/>
  <path class="glass" d="${roundRect(MAIN_WINDOW, MAIN_RADIUS)}"/>
  <path class="glass" d="${roundRect(PILL_WINDOW, pillRadius)}"/>
</svg>`;

/** Silhouette: rounded body with the stepped notch for the dial housing. */
function bodyPath(): string {
  const w = BODY.width;
  const h = BODY.height;
  return (
    `M14 0H${STEP.x}V${STEP.y}H${w - 20}Q${w} ${STEP.y} ${w} ${STEP.y + 20}` +
    `V${h - 40}Q${w} ${h} ${w - 40} ${h}H40Q0 ${h} 0 ${h - 40}V14Q0 0 14 0Z`
  );
}

/** Fine vertical grooves across the exposure-dial drum. */
function knurl(): string {
  const lines: string[] = [];
  for (let x = dial.x + 8; x < dial.x + dial.width; x += 12)
    lines.push(
      `<line class="line faint" x1="${x}" y1="${dial.y}" x2="${x}" y2="${dial.y + dial.height * 0.55}"/>`,
    );
  return lines.join('');
}
