import { canvasPoint } from '../sdk/coordinates';
export type PointerAction = 'down' | 'move' | 'up' | 'cancel';
export class CanvasPointer {
  private active: number | undefined;
  constructor(
    private canvas: HTMLCanvasElement,
    private enabled: () => boolean,
    private send: (
      action: PointerAction,
      x: number,
      y: number,
      time: number,
    ) => void,
  ) {
    canvas.addEventListener('pointerdown', (event) => {
      if (
        !this.enabled() ||
        !event.isPrimary ||
        event.button !== 0 ||
        event.ctrlKey ||
        event.altKey ||
        event.metaKey
      )
        return;
      const position = this.position(event);
      if (!position.inside) return;
      event.preventDefault();
      this.cancel();
      this.active = event.pointerId;
      canvas.focus();
      canvas.setPointerCapture(event.pointerId);
      this.send('down', position.point.x, position.point.y, event.timeStamp);
    });
    canvas.addEventListener('pointermove', (event) => {
      if (event.pointerId !== this.active) return;
      event.preventDefault();
      const { point } = this.position(event);
      this.send('move', point.x, point.y, event.timeStamp);
    });
    canvas.addEventListener('pointerup', (event) => {
      if (event.pointerId !== this.active) return;
      event.preventDefault();
      const position = this.position(event);
      if (position.inside)
        this.send('up', position.point.x, position.point.y, event.timeStamp);
      else this.send('cancel', 0, 0, event.timeStamp);
      this.release();
    });
    canvas.addEventListener('pointercancel', () => this.cancel());
    canvas.addEventListener('lostpointercapture', (event) => {
      if (event.pointerId === this.active) this.cancel();
    });
    window.addEventListener('resize', () => this.cancel());
    window.addEventListener('scroll', () => this.cancel(), true);
    new ResizeObserver(() => this.cancel()).observe(canvas);
  }
  private position(event: PointerEvent) {
    return canvasPoint(
      { x: event.clientX, y: event.clientY },
      this.canvas.getBoundingClientRect(),
      { width: this.canvas.width, height: this.canvas.height },
    );
  }
  private release(): void {
    const id = this.active;
    this.active = undefined;
    if (id !== undefined && this.canvas.hasPointerCapture(id))
      this.canvas.releasePointerCapture(id);
  }
  cancel(): void {
    if (this.active !== undefined) {
      this.send('cancel', 0, 0, performance.now());
      this.release();
    }
  }
}
