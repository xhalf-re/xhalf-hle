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
    if (this.finished || this.input.pending.length) return;
    const state = this.core.sdk.menuState(),
      ui = this.core.profile.firmware.ui;
    if (!state || this.core.virtualNs - this.time < 150000000n) return;
    if (state.id === ui.roles['shooting.main']) this.finished = true;
    else if (
      state.id! >= ui.first_setup_ids[0]! &&
      state.id! <= ui.first_setup_ids[1]! &&
      (this.last !== state.id || this.core.virtualNs - this.time >= 1000000000n)
    ) {
      this.input.press('tab');
      this.input.release('tab');
      this.last = state.id!;
      this.time = this.core.virtualNs;
    } else if (this.last && state.mode === ui.view_mode && this.input.idle) {
      this.input.press('m');
      this.input.release('m');
      this.time = this.core.virtualNs;
    }
  }
}
