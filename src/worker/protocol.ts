import type { FirmwareErrorCode } from '../firmware/errors';
export type SessionState =
  | 'empty'
  | 'loading'
  | 'loaded'
  | 'starting'
  | 'running'
  | 'paused'
  | 'stopped'
  | 'error';
export type Command = { request: number; session: number } & (
  | { type: 'load'; file: File; manualSetup: boolean }
  | { type: 'start' | 'pause' | 'resume' | 'stop' | 'reset' }
  | { type: 'frameAck'; frame: number; pixels: ArrayBuffer }
  | { type: 'key'; key: string; down: boolean }
  | {
      type: 'pointer';
      action: 'down' | 'move' | 'up' | 'cancel';
      x: number;
      y: number;
      time: number;
    }
);
export type WorkerEvent = { request: number; session: number } & (
  | { type: 'state'; state: SessionState; profile?: string }
  | { type: 'progress'; stage: string; fraction: number }
  | {
      type: 'error';
      code: FirmwareErrorCode | 'NOT_READY' | 'RUNTIME_ERROR';
      message: string;
    }
  | { type: 'metrics'; metrics: Record<string, string | number | boolean> }
  | {
      type: 'frame';
      width: number;
      height: number;
      pixels: ArrayBuffer;
      frame: number;
    }
);
