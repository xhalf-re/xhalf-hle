import './style.css';
import { BrowserSession } from './web/session';
import { CanvasPointer } from './web/pointer';
import { renderShell } from './web/shell';
import type { SessionState } from './worker/protocol';

const app = document.querySelector<HTMLElement>('#app')!;
renderShell(app);

const status = document.querySelector<HTMLElement>('[role="status"]')!;
const screen = document.querySelector<HTMLElement>('#screen-state')!;
const progress = document.querySelector<HTMLProgressElement>('#progress')!;
const input = document.querySelector<HTMLInputElement>('#firmware-file')!;
const manual = document.querySelector<HTMLInputElement>('#manual-setup')!;
const stop = document.querySelector<HTMLButtonElement>('#stop')!;
const reset = document.querySelector<HTMLButtonElement>('#reset')!;
const pause = document.querySelector<HTMLButtonElement>('#pause')!;
const diagnostics = document.querySelector<HTMLElement>('#diagnostics')!;
const canvas = document.querySelector<HTMLCanvasElement>('canvas')!;
const context = canvas.getContext('2d')!;
let source: File | undefined;
const labels: Record<SessionState, string> = {
  empty: 'Load your firmware',
  loading: 'Validating firmware',
  loaded: 'Firmware package validated',
  starting: 'Starting firmware',
  running: 'Firmware running',
  paused: 'Paused',
  stopped: 'Session stopped',
  error: 'Unable to load firmware',
};
function showOverlay(): void {
  document.querySelector<HTMLElement>('.empty')!.hidden = false;
  canvas.classList.remove('live');
}
function hideOverlay(): void {
  document.querySelector<HTMLElement>('.empty')!.hidden = true;
}
const session = new BrowserSession((event) => {
  if (event.type === 'progress') {
    progress.value = event.fraction;
    status.textContent = event.stage;
  }
  if (event.type === 'state') {
    screen.textContent = labels[event.state];
    stop.disabled = event.state === 'stopped';
    reset.disabled = !source;
    pause.disabled = !['starting', 'running', 'paused'].includes(event.state);
    pause.textContent = event.state === 'paused' ? 'Resume' : 'Pause';
    if (event.state === 'loaded')
      status.textContent = 'Firmware package, resources and version validated.';
    if (event.state === 'starting')
      status.textContent = 'Starting firmware from a cold boot.';
    if (event.state === 'running')
      status.textContent = 'The native interface is running.';
    if (event.state === 'paused')
      status.textContent = 'Paused. Resume to continue from the current state.';
    if (event.state === 'starting') canvas.focus();
    if (event.state === 'stopped') {
      pointer.cancel();
      delete canvas.dataset.frame;
      context.clearRect(0, 0, canvas.width, canvas.height);
      showOverlay();
      status.textContent = 'Stopped. Firmware and session data released.';
      progress.value = 0;
    }
  }
  if (event.type === 'error') {
    pause.disabled = true;
    screen.textContent = labels.error;
    status.textContent = `${event.code} · ${event.message}`;
    progress.value = 0;
    stop.disabled = false;
    reset.disabled = !source;
  }
  if (event.type === 'metrics')
    diagnostics.textContent = JSON.stringify(event.metrics, null, 2);
  if (event.type === 'metrics')
    (
      window as unknown as { __xhalfMetrics?: typeof event.metrics }
    ).__xhalfMetrics = event.metrics;
  if (event.type === 'metrics' && session.state === 'running')
    status.textContent = event.metrics.menuReady
      ? 'Main menu ready. Click or drag the screen; keyboard controls work where camera buttons are supported.'
      : 'Menus are running. Click or drag the screen; some menus support touch only.';
  if (event.type === 'frame') {
    if (canvas.width !== event.width || canvas.height !== event.height) {
      canvas.width = event.width;
      canvas.height = event.height;
    }
    context.putImageData(
      new ImageData(
        new Uint8ClampedArray(event.pixels),
        event.width,
        event.height,
      ),
      0,
      0,
    );
    if (!canvas.classList.contains('live')) canvas.classList.add('live');
    hideOverlay();
    session.frameAck(event.frame, event.pixels);
    canvas.dataset.frame = String(event.frame);
  }
});
function load(file: File): void {
  pointer.cancel();
  delete canvas.dataset.frame;
  releaseKeys();
  autoPaused = false;
  manualPaused = false;
  context.clearRect(0, 0, canvas.width, canvas.height);
  showOverlay();
  source = file;
  progress.value = 0;
  stop.disabled = false;
  reset.disabled = false;
  session.load(file, manual.checked);
}
input.addEventListener('change', () => {
  const file = input.files?.[0];
  if (file) load(file);
  input.value = '';
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());
const dropTargets = [
  document.querySelector<HTMLElement>('#dropzone')!,
  document.querySelector<HTMLElement>('#stage')!,
];
for (const target of dropTargets) {
  target.addEventListener('dragover', () => {
    for (const t of dropTargets) t.classList.add('dragging');
  });
  target.addEventListener('dragleave', () => {
    for (const t of dropTargets) t.classList.remove('dragging');
  });
  target.addEventListener('drop', (e) => {
    for (const t of dropTargets) t.classList.remove('dragging');
    const files = e.dataTransfer?.files;
    if (files?.length === 1) load(files[0]!);
    else status.textContent = 'Choose one complete DAT file at a time.';
  });
}
stop.addEventListener('click', () => {
  session.stop();
  source = undefined;
  reset.disabled = true;
});
reset.addEventListener('click', () => {
  if (source) load(source);
});
pause.addEventListener('click', () => {
  releaseKeys();
  pointer.cancel();
  autoPaused = false;
  manualPaused = session.state !== 'paused';
  session.command(manualPaused ? 'pause' : 'resume');
});
window.addEventListener('pagehide', () => session.stop());
const held = new Set<string>();
const pointer = new CanvasPointer(
  canvas,
  () => session.state === 'running' && !!canvas.dataset.frame,
  (action, x, y, time) => session.pointer(action, x, y, time),
);
for (const button of document.querySelectorAll<HTMLButtonElement>(
  '.virtual-keys button',
))
  button.addEventListener('click', () => {
    if (session.state !== 'running') return;
    pointer.cancel();
    canvas.focus();
    const key = button.dataset.key!;
    session.key(key, true);
    session.key(key, false);
  });
const keys: Record<string, string> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  Enter: 'return',
  Escape: 'escape',
  Tab: 'tab',
  KeyM: 'm',
  KeyB: 'ui-back',
  KeyC: 'ui-confirm',
  Digit1: '1',
  Digit2: '2',
  Digit3: '3',
  Digit4: '4',
  Digit5: '5',
  Digit6: '6',
  Digit7: '7',
};
window.addEventListener('keydown', (event) => {
  const key = keys[event.code];
  if (
    !key ||
    !['starting', 'running'].includes(session.state) ||
    event.target instanceof HTMLInputElement
  )
    return;
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  if (document.activeElement !== canvas && event.target !== document.body)
    return;
  event.preventDefault();
  if (event.repeat || held.has(key)) return;
  pointer.cancel();
  held.add(key);
  session.key(key, true);
});
window.addEventListener('keyup', (event) => {
  const key = keys[event.code];
  if (key && held.delete(key)) {
    event.preventDefault();
    session.key(key, false);
  }
});
function releaseKeys(): void {
  for (const key of held) session.key(key, false);
  held.clear();
}
let autoPaused = false;
let manualPaused = false;
function backgroundPause(): void {
  pointer.cancel();
  releaseKeys();
  if (!manualPaused && ['running', 'starting'].includes(session.state)) {
    autoPaused = true;
    session.command('pause');
  }
}
function foregroundResume(): void {
  if (
    autoPaused &&
    document.visibilityState === 'visible' &&
    document.hasFocus()
  ) {
    autoPaused = false;
    session.command('resume');
  }
}
window.addEventListener('blur', backgroundPause);
window.addEventListener('focus', foregroundResume);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) backgroundPause();
  else foregroundResume();
});
