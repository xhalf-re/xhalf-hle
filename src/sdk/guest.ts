import { words } from './adapter';
import type { RuntimeCore } from '../runtime/core';
import thunk from './call-thunk.json';

export class GuestCalls {
  constructor(core: RuntimeCore) {
    core.cpu.write(core.profile.scratch('call_thunk'), Uint8Array.from(thunk));
  }
  packet(target: number, args: number[]): Uint8Array {
    if (
      !Number.isInteger(target) ||
      !target ||
      target > 0xffffffff ||
      target % 4 ||
      args.length > 16 ||
      args.some((v) => !Number.isInteger(v) || v < 0 || v > 0xffffffff)
    )
      throw new Error('Invalid ARM AAPCS call packet');
    return words([
      target,
      args.length,
      ...args,
      ...Array(Math.max(0, 4 - args.length)).fill(0),
    ]);
  }
}
