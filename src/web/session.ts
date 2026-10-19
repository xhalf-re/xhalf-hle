import type { Command, SessionState, WorkerEvent } from '../worker/protocol';
/** Each load owns a Worker; termination releases CPU, native memory and DAT views. */
export class BrowserSession {
  private worker: Worker | undefined;
  private session = 0;
  private request = 0;
  state: SessionState = 'empty';
  constructor(private onEvent: (event: WorkerEvent) => void) {}
  load(file: File, manualSetup: boolean): void {
    this.worker?.terminate();
    this.worker = undefined;
    this.session++;
    const worker = new Worker(
      new URL('../worker/runtime-worker.ts', import.meta.url),
      { type: 'module' },
    );
    const session = this.session;
    this.worker = worker;
    this.state = 'loading';
    worker.onmessage = (event: MessageEvent<WorkerEvent>) => {
      if (session !== this.session || event.data.session !== this.session)
        return;
      if (event.data.type === 'state') this.state = event.data.state;
      if (event.data.type === 'error') this.state = 'error';
      this.onEvent(event.data);
    };
    worker.onerror = (error) => {
      if (session !== this.session) return;
      this.state = 'error';
      worker.terminate();
      this.worker = undefined;
      this.onEvent({
        type: 'error',
        code: 'RUNTIME_ERROR',
        message: `The runtime worker stopped unexpectedly: ${error.message || 'Unknown error'}. Please reload the firmware.`,
        session,
        request: this.request,
      });
    };
    this.post({
      type: 'load',
      file,
      manualSetup,
      session,
      request: ++this.request,
    });
  }
  private post(command: Command): void {
    this.worker?.postMessage(command);
  }
  stop(): void {
    this.worker?.terminate();
    this.worker = undefined;
    this.state = 'stopped';
    this.session++;
    this.onEvent({
      type: 'state',
      state: 'stopped',
      session: this.session,
      request: ++this.request,
    });
  }
  command(type: 'start' | 'pause' | 'resume' | 'reset'): void {
    this.post({ type, session: this.session, request: ++this.request });
  }
  key(key: string, down: boolean): void {
    this.post({
      type: 'key',
      key,
      down,
      session: this.session,
      request: ++this.request,
    });
  }
  pointer(
    action: 'down' | 'move' | 'up' | 'cancel',
    x: number,
    y: number,
    time: number,
  ): void {
    this.post({
      type: 'pointer',
      action,
      x,
      y,
      time,
      session: this.session,
      request: ++this.request,
    });
  }
  frameAck(frame: number, pixels: ArrayBuffer): void {
    this.worker?.postMessage(
      {
        type: 'frameAck',
        frame,
        pixels,
        session: this.session,
        request: ++this.request,
      },
      [pixels],
    );
  }
}
