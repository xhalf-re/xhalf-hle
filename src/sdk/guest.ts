import { words } from './adapter';
import type { RuntimeCore, GuestCall } from '../runtime/core';
import thunk from './call-thunk.json';

export class GuestCalls {
  constructor(private core: RuntimeCore) {
    core.cpu.write(core.profile.scratch('call_thunk'), Uint8Array.from(thunk));
    core.prepareCall = (call) => this.prepareInterrupt(call);
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
  private prepareInterrupt(call: GuestCall): GuestCall {
    this.packet(call.function, call.arguments);
    if (call.arguments.length <= 4) return call;
    const packet = this.core.profile.scratch('call_packet') + 128;
    this.core.cpu.write(packet, this.packet(call.function, call.arguments));
    return {
      ...call,
      function: this.core.profile.scratch('call_thunk'),
      arguments: [packet],
    };
  }
}
