import type { RuntimeCore, GuestCall } from '../runtime/core';

type PointerEpoch = { host: number; native?: bigint };
type Sample = {
  action: 'down' | 'move' | 'up' | 'cancel';
  x: number;
  y: number;
  pointer: PointerEpoch;
  elapsed: number;
};

/** A touch controller: the native SDK owns gestures, queues and UI callbacks. */
export class NativeTouch {
  readonly samples: Sample[] = [];
  due = 0n;
  events = 0;
  ignored = 0;
  private woken = false;
  private started = false;
  private inflight: Sample | undefined;
  private epoch: PointerEpoch | undefined;
  private held = false;
  private last: { x: number; y: number } | undefined;
  private contact: { x: number; y: number } | undefined;
  constructor(private core: RuntimeCore) {
    core.bind(
      'sdk.touch.dispatch_site',
      () => {
        if (this.woken) this.started = true;
      },
      true,
    );
    core.bind(
      'sdk.touch.wait_site',
      () => {
        if (!this.started) return;
        this.inflight = undefined;
        this.woken = this.started = false;
      },
      true,
    );
    core.bind('sdk.touch.read', () => this.read());
    core.bind('sdk.touch.device_read', () => {
      if (this.inflight?.action === 'cancel') {
        this.assertTask();
        // A controller read failure follows the SDK's own reset path. There
        // is no native cancel gesture; reporting zero contacts would tap.
        this.contact = undefined;
        this.events++;
        this.core.sdk.ret(2);
      }
    });
  }
  get busy(): boolean {
    return this.samples.length > 0 || this.woken;
  }
  pointer(action: Sample['action'], x: number, y: number, time: number): void {
    if (action === 'cancel') return this.cancelPointer();
    const [width, height] = this.core.profile.sdk.input.pointer_size;
    if (
      !Number.isInteger(x) ||
      !Number.isInteger(y) ||
      x < 0 ||
      y < 0 ||
      x >= width! ||
      y >= height! ||
      !Number.isFinite(time) ||
      time < 0
    )
      throw new Error('Invalid normalized pointer sample');
    if (action === 'down') {
      if (this.held) this.cancelPointer();
      this.held = true;
      this.epoch = { host: time };
    } else if (!this.held) return;
    if (
      action === 'up' &&
      this.last &&
      (x !== this.last.x || y !== this.last.y)
    )
      this.pointer('move', x, y, time);
    const pointer = this.epoch!,
      elapsed = Math.max(0, time - pointer.host);
    if (action === 'move' && x === this.last?.x && y === this.last.y) return;
    const previous = this.samples.at(-1);
    if (
      action === 'move' &&
      previous?.action === 'move' &&
      previous.pointer === pointer
    )
      Object.assign(previous, { x, y, elapsed });
    else {
      if (this.samples.length >= this.core.profile.sdk.input.queue_limit)
        throw new Error('Native pointer queue limit reached');
      this.samples.push({ action, x, y, pointer, elapsed });
    }
    this.last = { x, y };
    if (action === 'up') this.held = false;
  }
  cancelPointer(): void {
    const pointer = this.epoch;
    if (!pointer) return;
    this.samples.splice(
      0,
      this.samples.length,
      ...this.samples.filter((sample) => sample.pointer !== pointer),
    );
    // Even an already consumed press must be reset in the native SDK task.
    if (this.contact || this.inflight?.pointer === pointer)
      this.samples.push({ action: 'cancel', x: 0, y: 0, pointer, elapsed: 0 });
    this.held = false;
    this.epoch = undefined;
    this.last = undefined;
    this.due = this.core.virtualNs;
  }
  nextCall(): GuestCall | null {
    if (this.woken || this.core.virtualNs < this.due) return null;
    const sample = this.samples[0];
    if (!sample && !this.contact) return null;
    const { sdk, profile } = this.core;
    if (
      ['initialized', 'polling'].some(
        (field) =>
          !sdk.field(
            profile.address('sdk.touch.driver'),
            'touch_driver',
            field,
          ),
      )
    ) {
      this.ignored += this.samples.length;
      this.samples.length = 0;
      this.contact = undefined;
      return null;
    }
    const ready =
      sample &&
      (sample.action === 'cancel' ||
        sample.pointer.native === undefined ||
        this.core.virtualNs >=
          sample.pointer.native + BigInt(Math.round(sample.elapsed * 1e6)));
    // Real controllers keep returning held contacts. The SDK's aware gate,
    // debounce and long presses need scans even without pointer movement.
    if (!ready && !this.contact) return null;
    this.inflight = ready ? this.samples.shift() : undefined;
    if (this.inflight?.action === 'down')
      this.inflight.pointer.native = this.core.virtualNs;
    this.woken = true;
    this.due =
      this.core.virtualNs +
      BigInt(this.core.profile.sdk.input.sample_interval_ns);
    return {
      function: this.core.profile.address('sdk.touch.interrupt'),
      arguments: [],
    };
  }
  private assertTask(): void {
    const { sdk, profile } = this.core;
    const current = sdk.word('tx.current_thread');
    if (
      !profile.inRam(current, profile.layouts.thread!.size) ||
      sdk.u32(current) !== profile.sdk.threadx.thread_id ||
      sdk.field(current, 'thread', 'entry') !==
        profile.address('sdk.touch.thread_entry') ||
      sdk.word('tx.system_state') !== 0
    )
      throw new Error('Touch sampling requires the real SDK ThreadX task');
  }
  private read(): void {
    this.assertTask();
    const { sdk, cpu, profile } = this.core;
    if (this.inflight) {
      const sample = this.inflight;
      this.contact =
        sample.action === 'up' || sample.action === 'cancel'
          ? undefined
          : sample;
      this.events++;
    }
    const [, report] = sdk.arguments(2);
    if (!profile.inRam(report!, 42))
      throw new Error('Invalid touch controller report');
    const bytes = new Uint8Array(42),
      view = new DataView(bytes.buffer);
    bytes[0] = this.contact ? 1 : 0;
    // The board wrapper swaps the controller axes and mirrors X. Preserve
    // that native conversion and calibration by supplying controller space.
    view.setUint16(2, this.contact?.y ?? 0, true);
    view.setUint16(
      4,
      profile.sdk.input.pointer_size[0]! - (this.contact?.x ?? 0),
      true,
    );
    cpu.write(report!, bytes);
    sdk.ret(this.contact ? 1 : 0);
  }
}

type Pending = { message: number[]; activity?: boolean };
/** Fixed SDK messages. Never examines menu handlers, rows or selection. */
export class NativeInput {
  readonly pending: Pending[] = [];
  readonly touch: NativeTouch;
  private queue: number | undefined;
  private held = new Set<string>();
  private lastActivity: bigint;
  sent = 0;
  errors = 0;
  get idle(): boolean {
    const state = this.core.sdk.queueState(
      this.queue ?? this.core.sdk.uiQueue(),
    );
    return !!(
      state?.suspended &&
      !state.enqueued &&
      !this.pending.length &&
      !this.touch.busy
    );
  }
  constructor(private core: RuntimeCore) {
    this.lastActivity = -BigInt(core.profile.sdk.input.activity_interval_ns);
    this.touch = new NativeTouch(core);
  }
  press(key: string): void {
    const message = (
      this.core.profile.sdk.input.key_map as Record<string, number[]>
    )[key];
    if (
      !message ||
      !Object.hasOwn(this.core.profile.sdk.input.key_map, key) ||
      this.held.has(key)
    )
      return;
    this.enqueue({ message: [...message], activity: true });
    this.held.add(key);
  }
  release(key: string): void {
    if (!this.held.delete(key)) return;
    if (['up', 'down', 'left', 'right', 'return', 'escape'].includes(key)) {
      const a = this.core.profile.sdk.input;
      this.enqueue({
        message: [
          (a.key_map as Record<string, number[]>)[key]![0]! + a.release_delta,
          0,
          0,
          0,
        ],
      });
    }
  }
  private enqueue(event: Pending): void {
    if (this.pending.length >= this.core.profile.sdk.input.queue_limit)
      throw new Error('Native input queue limit reached');
    this.pending.push(event);
  }
  nextCall(): GuestCall | null {
    const { sdk, profile } = this.core;
    const touchCall = this.touch.nextCall();
    if (touchCall || this.touch.busy) return touchCall;
    if (!this.pending.length) return null;
    if (!this.queue) {
      const queue = sdk.uiQueue();
      if (!sdk.queueState(queue)) return null;
      this.queue = queue;
    }
    if (!this.pending.length) return null;
    const state = sdk.queueState(this.queue);
    if (!state) throw new Error('Native UI queue no longer valid');
    if (!state.available) return null;
    const pending = this.pending[0]!;
    const keyEvent =
      pending.message[0]! >>> 8 === 0xf00000 &&
      (pending.message[0]! & 255) < 0xe0;
    // Let the SDK/UI acknowledge each physical edge before the next one.
    // Its deferred key ring otherwise allows release messages to overtake
    // queued presses. Startup shortcuts have their own native async flow.
    if (keyEvent && (state.enqueued || !state.suspended)) return null;
    let message: number[];
    if (
      pending.activity &&
      this.core.virtualNs - this.lastActivity >=
        BigInt(profile.sdk.input.activity_interval_ns)
    ) {
      pending.activity = false;
      this.lastActivity = this.core.virtualNs;
      message = profile.sdk.input.activity_message;
    } else {
      this.pending.shift();
      message = pending.message;
    }
    if (state.message_words !== message.length)
      throw new Error('Native queue message ABI mismatch');
    const physical =
      message[0]! >>> 8 === 0xf00000 && (message[0]! & 255) < 0xe0;
    return {
      function: profile.address(physical ? 'sdk.key.send' : 'sysg.send4'),
      arguments: physical ? [message[0]! & 255] : message,
      kind: 'input',
      ...(physical ? { returns: 'void' as const } : {}),
    };
  }
  complete(status: number): void {
    if (status) {
      this.errors++;
      throw new Error(`Native input delivery failed (${status})`);
    }
    this.sent++;
  }
}
