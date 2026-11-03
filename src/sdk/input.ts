import type { RuntimeCore } from '../runtime/core';
import type { TouchController } from '../devices/touch';

type Gesture = readonly (readonly number[])[];
/** Fixed screen gestures. Every key uses the same physical controller as pointer input. */
export class NativeInput {
  readonly pending: Gesture[] = [];
  readonly touch: TouchController;
  private held = new Set<string>();
  private nextGesture = 0n;
  sent = 0;
  errors = 0;
  constructor(private core: RuntimeCore) {
    this.touch = core.touch;
  }
  get idle(): boolean {
    // Read-only diagnostics; guest queue state never selects or delivers input.
    const state = this.core.sdk.queueState(this.core.sdk.uiQueue());
    return !!(
      state?.suspended &&
      !state.enqueued &&
      !this.pending.length &&
      this.touch.settled
    );
  }
  press(key: string): void {
    const config = this.core.profile.machine.peripherals.input;
    if (this.held.has(key)) return;
    const names = Object.hasOwn(config.gestures, key)
      ? [key]
      : Object.hasOwn(config.sequences, key)
        ? (config.sequences as Record<string, string[]>)[key]
        : undefined;
    if (!names) return;
    const gestures = names.map(
      (name) => (config.gestures as Record<string, Gesture>)[name]!,
    );
    if (this.pending.length + gestures.length > config.queue_limit)
      throw new Error('Input gesture queue limit reached');
    this.pending.push(...gestures);
    this.held.add(key);
  }
  release(key: string): void {
    this.held.delete(key);
  }
  poll(): void {
    if (
      !this.pending.length ||
      !this.touch.settled ||
      this.core.virtualNs < this.nextGesture
    )
      return;
    const gesture = this.pending.shift()!,
      time = Number(this.core.virtualNs / 1000000n);
    for (let i = 0; i < gesture.length; i++) {
      const [x, y, elapsed] = gesture[i]!;
      this.touch.pointer(
        i === 0 ? 'down' : i === gesture.length - 1 ? 'up' : 'move',
        x!,
        y!,
        time + elapsed!,
      );
    }
    this.nextGesture =
      this.core.virtualNs +
      BigInt(Math.round(gesture.at(-1)![2]! * 1e6)) +
      BigInt(this.core.profile.machine.peripherals.input.gesture_gap_ns);
    this.sent++;
  }
}
