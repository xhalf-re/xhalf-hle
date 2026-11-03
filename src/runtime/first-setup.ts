import type { RuntimeCore } from './core';
import type { NativeInput } from '../sdk/input';

/** Optional startup automation, separate from the SDK's input routing. */
export class FirstSetup {
  private last = 0;
  private time = -1000000000n;
  private finished = false;
  constructor(
    private core: RuntimeCore,
    private input: NativeInput,
  ) {}
  poll(): void {
    if (this.finished || this.input.pending.length || this.input.touch.busy)
      return;
    const state = this.core.sdk.menuState(),
      ui = this.core.profile.firmware.ui;
    if (!state || this.core.virtualNs - this.time < 150000000n) return;
    if (state.id === ui.roles['shooting.main']) {
      this.input.press('up');
      this.input.release('up');
      this.finished = true;
    } else if (this.last && state.mode === ui.view_mode) {
      if (this.input.idle) {
        this.input.press('m');
        this.input.release('m');
        this.time = this.core.virtualNs;
      }
    } else if (
      state.id! >= ui.first_setup_ids[0]! &&
      state.id! <= ui.first_setup_ids[1]! &&
      (this.last !== state.id || this.core.virtualNs - this.time >= 1000000000n)
    ) {
      const key = ui.first_setup_gestures[String(state.id)] ?? 'tab';
      this.input.press(key);
      this.input.release(key);
      this.last = state.id!;
      this.time = this.core.virtualNs;
    }
  }
}
