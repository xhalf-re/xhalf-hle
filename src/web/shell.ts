import {
  BODY_ART_SVG,
  MAIN_WINDOW,
  PANEL,
  PANEL_CLIP_PATH,
  VIEW_BOX,
} from './camera-frame';

/** Percentage of the stage box, matching how the SVG scales inside it. */
function pct(value: number, base: number): string {
  return `${((value / base) * 100).toFixed(3)}%`;
}

function boxVars(
  name: string,
  rect: {
    x: number;
    y: number;
    width: number;
    height: number;
  },
): string {
  return (
    `--${name}-left:${pct(rect.x - VIEW_BOX.x, VIEW_BOX.width)};` +
    `--${name}-top:${pct(rect.y - VIEW_BOX.y, VIEW_BOX.height)};` +
    `--${name}-width:${pct(rect.width, VIEW_BOX.width)};` +
    `--${name}-height:${pct(rect.height, VIEW_BOX.height)}`
  );
}

/**
 * Page skeleton. The stage stacks two layers that scale in lockstep through
 * the shared SVG viewBox: the body line art and the canvas over the full
 * display panel. A clip path reveals only the film window and the main
 * window, so the hidden middle of the panel is simply the body underneath.
 * The LCD state layer covers the main window.
 */
export function renderShell(app: HTMLElement): void {
  app.innerHTML = `
  <header><span class="mark" aria-hidden="true">×½</span><div><h1>X half HLE</h1><p>A firmware emulator in your browser · Unofficial project</p></div><span class="badge">Local only</span></header>
  <section class="stage" id="stage" aria-label="Camera body and firmware screen"
      style="${boxVars('panel', PANEL)};${boxVars('main', MAIN_WINDOW)};--stage-ratio:${VIEW_BOX.width}/${VIEW_BOX.height};--stage-aspect:${(VIEW_BOX.width / VIEW_BOX.height).toFixed(4)}">
    ${BODY_ART_SVG}
    <svg width="0" height="0" aria-hidden="true" focusable="false" style="position:absolute"><defs><clipPath id="panel-clip" clipPathUnits="objectBoundingBox"><path d="${PANEL_CLIP_PATH}"/></clipPath></defs></svg>
    <canvas width="640" height="480" tabindex="0" aria-label="Native firmware display"></canvas>
    <div class="empty"><span class="indicator"></span><h2 id="screen-state">Load your firmware</h2><p>The native display will appear here after startup.</p></div>
  </section>
  <section class="dock" aria-label="Firmware and session controls">
    <div class="dropzone" id="dropzone"><p><strong>Drop FPUPDATE.DAT onto the camera</strong> · your file stays in this browser</p><label class="file-button">Choose firmware<input id="firmware-file" type="file" accept=".DAT,.dat" aria-label="Choose firmware" /></label></div>
    <label class="option"><input id="manual-setup" type="checkbox" checked /> Complete first-time setup manually</label>
    <div class="actions"><button id="pause" disabled>Pause</button><button id="reset" disabled>Reload</button><button id="stop" disabled>Stop and release session</button></div>
    <progress id="progress" max="1" value="0" aria-label="Firmware loading progress"></progress>
    <p role="status" aria-live="polite">Choose firmware to start.</p>
    <nav class="virtual-keys" aria-label="Buttons and shortcuts"><button data-key="m">Menu M</button><button data-key="return">Confirm Enter</button><button data-key="escape">Back Esc</button><button data-key="tab">Skip Tab</button><button data-key="ui-back">Screen back B</button><button data-key="ui-confirm">Screen confirm C</button></nav>
    <p class="key-help">Click or drag the screen to navigate. Arrow keys / Enter / Esc work in menus that support camera buttons. M: menu · 1–7: categories · Tab: skip first-time setup · B/C: back/confirm</p>
  </section>
  <details><summary>Diagnostics</summary><pre id="diagnostics">Not started</pre></details>
  <footer>Desktop Chrome / Edge · Firmware stays in your browser</footer>
`;
}
