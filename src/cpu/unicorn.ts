import { address32, memoryRange } from './backend';
import type {
  ArmRegister,
  CpuBackend,
  CpuContext,
  HookCallback,
  HookHandle,
  HookKind,
} from './backend';

type RawHook = { handle: number; callback: number };
interface Engine {
  handle_ptr: number;
  hook_add(
    type: number,
    callback: (...args: unknown[]) => boolean | void,
    data: null,
    begin: bigint,
    end: bigint,
  ): RawHook;
  hook_del(hook: RawHook): void;
  context_alloc(): number;
  context_save(context: number): void;
  context_restore(context: number): void;
  context_free(context: number): void;
  ctl_remove_cache(begin: bigint, end: bigint): void;
  ctl_flush_tb(): void;
  ctl_set_cpu_model(model: number): void;
  close(): void;
}
/** Declared against the pinned C headers and JS wrapper, exercised by ARM tests. */
export interface UnicornModule {
  Unicorn: new (architecture: number, mode: number) => Engine;
  xhleHeap(): Uint8Array;
  _malloc(size: number): number;
  _free(pointer: number): void;
  _uc_mem_map(
    handle: number,
    address: bigint,
    size: bigint,
    permissions: number,
  ): number;
  _uc_mem_unmap(handle: number, address: bigint, size: bigint): number;
  _uc_mem_protect(
    handle: number,
    address: bigint,
    size: bigint,
    permissions: number,
  ): number;
  _uc_mem_read(
    handle: number,
    address: bigint,
    pointer: number,
    size: bigint,
  ): number;
  _uc_mem_write(
    handle: number,
    address: bigint,
    pointer: number,
    size: bigint,
  ): number;
  _uc_reg_read(handle: number, id: number, pointer: number): number;
  _uc_reg_write(handle: number, id: number, pointer: number): number;
  _uc_reg_read_batch(
    handle: number,
    ids: number,
    pointers: number,
    count: number,
  ): number;
  _uc_reg_write_batch(
    handle: number,
    ids: number,
    pointers: number,
    count: number,
  ): number;
  _uc_emu_start(
    handle: number,
    begin: bigint,
    until: bigint,
    timeout: bigint,
    count: number,
  ): number;
  _uc_emu_stop(handle: number): number;
  _xhle_slice_create(handle: number): number;
  _xhle_slice_run(slice: number, begin: number, budget: number): number;
  _xhle_slice_destroy(slice: number): void;
  _xhle_slice_charged(slice: number): number;
  _xhle_arm_is_waiting(handle: number): number;
  _xhle_slice_clock_configure(
    slice: number,
    instructionNs: number,
    frequency: number,
    callback: number,
  ): void;
  _xhle_slice_clock_deadline(slice: number, deadline: bigint): void;
  _xhle_slice_clock_now(slice: number): bigint;
  _xhle_slice_clock_idle(slice: number, limit: bigint): void;
  _xhle_arm_clock_configure(
    handle: number,
    frequency: number,
    mpidr: number,
  ): number;
  _xhle_arm_clock_advance(handle: number, counter: bigint): number;
  _xhle_arm_set_irq(handle: number, asserted: number): number;
  _uc_hook_add(
    handle: number,
    hook: number,
    type: number,
    callback: number,
    data: number,
    begin: bigint,
    end: bigint,
    extra: number,
  ): number;
  addFunction(
    callback: (...args: unknown[]) => number | void,
    signature: string,
  ): number;
  removeFunction(pointer: number): void;
  strerror(code: number): string;
  [constant: `ARM_REG_${string}`]: number;
}

export class CpuError extends Error {
  constructor(
    public readonly operation: string,
    public readonly code: number,
    description: string,
  ) {
    super(`${operation}: ${description} (${code})`);
    this.name = 'CpuError';
  }
}

const hookTypes = {
  code: 4,
  block: 8,
  read: 1024,
  write: 2048,
  unmapped: 112,
  interrupt: 1,
  invalid: 16384,
} as const;

export class UnicornBackend implements CpuBackend {
  private engine: Engine;
  private handle: number;
  private transfer = 0;
  private transferSize = 0;
  private hooks = new Map<number, RawHook>();
  private contexts = new Set<number>();
  private nextHook = 1;
  private dead = false;
  private slice = 0;
  private clockCallback = 0;
  private registerIds = new Map<ArmRegister, number>();

  constructor(
    private module: UnicornModule,
    cpuModel = 17,
  ) {
    this.engine = new module.Unicorn(1, 0);
    this.handle = this.view().getUint32(this.engine.handle_ptr, true);
    // Cortex-A15 is Unicorn's desktop ARM default; banked MSR needs ARMv7 VE.
    this.engine.ctl_set_cpu_model(cpuModel);
  }
  private view(): DataView {
    return new DataView(this.module.xhleHeap().buffer);
  }
  private check(code: number, operation: string): void {
    if (code) throw new CpuError(operation, code, this.module.strerror(code));
  }
  private live(): void {
    if (this.dead) throw new Error('CPU has been destroyed');
  }
  private buffer(size: number): number {
    this.live();
    if (size > this.transferSize) {
      if (this.transfer) this.module._free(this.transfer);
      this.transferSize = Math.max(256, size);
      this.transfer = this.module._malloc(this.transferSize);
      if (!this.transfer) throw new Error('Wasm allocation failed');
    }
    return this.transfer;
  }
  get memoryBytes(): number {
    return this.module.xhleHeap().byteLength;
  }
  configureSystemRegisters(frequency: number, mpidr: number): void {
    this.live();
    address32(frequency);
    address32(mpidr);
    if (!frequency) throw new RangeError('Counter frequency must be positive');
    this.check(
      this.module._xhle_arm_clock_configure(this.handle, frequency, mpidr),
      'configure ARM system registers',
    );
  }
  advanceSystemCounter(counter: bigint): number {
    this.live();
    if (counter < 0n || counter > 0xffffffffffffffffn)
      throw new RangeError('System counter outside uint64');
    return this.module._xhle_arm_clock_advance(this.handle, counter);
  }
  setIrq(asserted: boolean): void {
    this.live();
    this.check(
      this.module._xhle_arm_set_irq(this.handle, Number(asserted)),
      'set ARM IRQ line',
    );
  }
  private ensureSlice(): number {
    this.live();
    if (!this.slice) {
      this.slice = this.module._xhle_slice_create(this.handle);
      if (!this.slice) throw new Error('CPU slice allocation failed');
    }
    return this.slice;
  }
  configureExecutionClock(
    instructionNs: number,
    frequency: number,
    callback: (now: bigint, levels: number) => void,
  ): void {
    address32(instructionNs);
    address32(frequency);
    if (!instructionNs || !frequency)
      throw new RangeError('Clock rates must be positive');
    const slice = this.ensureSlice();
    const pointer = this.module.addFunction(
      (now, levels) => callback(now as bigint, Number(levels)),
      'vji',
    );
    this.module._xhle_slice_clock_configure(
      slice,
      instructionNs,
      frequency,
      pointer,
    );
    if (this.clockCallback) this.module.removeFunction(this.clockCallback);
    this.clockCallback = pointer;
  }
  setExecutionDeadline(deadline: bigint | undefined): void {
    if (
      deadline !== undefined &&
      (deadline < 0n || deadline > 0xffffffffffffffffn)
    )
      throw new RangeError('Execution deadline outside uint64');
    this.module._xhle_slice_clock_deadline(
      this.ensureSlice(),
      deadline ?? 0xffffffffffffffffn,
    );
  }
  get executionTime(): bigint {
    this.live();
    return this.slice ? this.module._xhle_slice_clock_now(this.slice) : 0n;
  }
  idleExecutionClock(limit: bigint): void {
    this.live();
    if (!this.clockCallback)
      throw new Error('Execution clock is not configured');
    if (limit < 0n || limit > 0xffffffffffffffffn)
      throw new RangeError('Execution clock limit outside uint64');
    this.module._xhle_slice_clock_idle(this.ensureSlice(), limit);
  }
  get waitingForInterrupt(): boolean {
    this.live();
    return !!this.module._xhle_arm_is_waiting(this.handle);
  }
  map(address: number, size: number, permissions = 7): void {
    this.live();
    memoryRange(address, size);
    this.check(
      this.module._uc_mem_map(
        this.handle,
        BigInt(address),
        BigInt(size),
        permissions,
      ),
      'map',
    );
  }
  unmap(address: number, size: number): void {
    this.live();
    memoryRange(address, size);
    this.check(
      this.module._uc_mem_unmap(this.handle, BigInt(address), BigInt(size)),
      'unmap',
    );
  }
  protect(address: number, size: number, permissions: number): void {
    this.live();
    memoryRange(address, size);
    this.check(
      this.module._uc_mem_protect(
        this.handle,
        BigInt(address),
        BigInt(size),
        permissions,
      ),
      'protect',
    );
  }
  read(address: number, size: number): Uint8Array {
    memoryRange(address, size);
    const pointer = this.buffer(size);
    this.check(
      this.module._uc_mem_read(
        this.handle,
        BigInt(address),
        pointer,
        BigInt(size),
      ),
      'read',
    );
    return this.module.xhleHeap().slice(pointer, pointer + size);
  }
  write(address: number, bytes: Uint8Array): void {
    memoryRange(address, bytes.length);
    const pointer = this.buffer(bytes.length);
    this.module.xhleHeap().set(bytes, pointer);
    this.check(
      this.module._uc_mem_write(
        this.handle,
        BigInt(address),
        pointer,
        BigInt(bytes.length),
      ),
      'write',
    );
  }
  private registerId(register: ArmRegister): number {
    const cached = this.registerIds.get(register);
    if (cached !== undefined) return cached;
    const id = this.module[`ARM_REG_${register.toUpperCase()}`];
    if (id === undefined) throw new Error(`Unknown ARM register ${register}`);
    this.registerIds.set(register, id);
    return id;
  }
  private registerPacket(registers: readonly ArmRegister[]): number {
    if (registers.length > 32) throw new Error('Register batch is too large');
    const pointer = this.buffer(registers.length * 12),
      view = this.view();
    registers.forEach((register, i) => {
      view.setUint32(pointer + i * 4, this.registerId(register), true);
      view.setUint32(
        pointer + registers.length * 4 + i * 4,
        pointer + registers.length * 8 + i * 4,
        true,
      );
    });
    return pointer;
  }
  readRegisters(registers: readonly ArmRegister[]): number[] {
    if (!registers.length) return [];
    const pointer = this.registerPacket(registers),
      count = registers.length;
    this.check(
      this.module._uc_reg_read_batch(
        this.handle,
        pointer,
        pointer + count * 4,
        count,
      ),
      'read registers',
    );
    const view = this.view();
    return registers.map((_, i) =>
      view.getUint32(pointer + count * 8 + i * 4, true),
    );
  }
  writeRegisters(values: readonly (readonly [ArmRegister, number])[]): void {
    if (!values.length) return;
    const pointer = this.registerPacket(values.map(([r]) => r)),
      count = values.length,
      view = this.view();
    values.forEach(([, value], i) =>
      view.setUint32(pointer + count * 8 + i * 4, value >>> 0, true),
    );
    this.check(
      this.module._uc_reg_write_batch(
        this.handle,
        pointer,
        pointer + count * 4,
        count,
      ),
      'write registers',
    );
  }
  readRegister(register: ArmRegister): number {
    const pointer = this.buffer(8);
    this.check(
      this.module._uc_reg_read(this.handle, this.registerId(register), pointer),
      'read register',
    );
    return this.view().getUint32(pointer, true);
  }
  writeRegister(register: ArmRegister, value: number): void {
    const pointer = this.buffer(8);
    this.view().setUint32(pointer, value >>> 0, true);
    this.check(
      this.module._uc_reg_write(
        this.handle,
        this.registerId(register),
        pointer,
      ),
      'write register',
    );
  }
  readRegisterBytes(id: number, size: number): Uint8Array {
    const pointer = this.buffer(size);
    this.module.xhleHeap().fill(0, pointer, pointer + size);
    this.check(
      this.module._uc_reg_read(this.handle, id, pointer),
      'read register bytes',
    );
    return this.module.xhleHeap().slice(pointer, pointer + size);
  }
  writeRegisterBytes(id: number, bytes: Uint8Array): void {
    const pointer = this.buffer(bytes.length);
    this.module.xhleHeap().set(bytes, pointer);
    this.check(
      this.module._uc_reg_write(this.handle, id, pointer),
      'write register bytes',
    );
  }
  hook(kind: HookKind, callback: HookCallback, begin = 1, end = 0): HookHandle {
    this.live();
    address32(begin);
    address32(end);
    if (kind === 'invalid') {
      const pointer = this.buffer(8);
      const fn = this.module.addFunction(
        () =>
          callback({ kind, address: this.readRegister('pc'), size: 4 }) === true
            ? 1
            : 0,
        'iii',
      );
      const result = this.module._uc_hook_add(
        this.handle,
        pointer,
        hookTypes.invalid,
        fn,
        0,
        BigInt(begin),
        BigInt(end),
        0,
      );
      if (result) {
        this.module.removeFunction(fn);
        this.check(result, 'invalid hook');
      }
      const id = this.nextHook++;
      this.hooks.set(id, {
        handle: this.view().getUint32(pointer, true),
        callback: fn,
      });
      this.engine.ctl_flush_tb();
      return id;
    }
    const hook = this.engine.hook_add(
      hookTypes[kind],
      (...args) => {
        if (kind === 'interrupt')
          return callback({
            kind,
            address: this.readRegister('pc'),
            size: 0,
            interrupt: Number(args[1]),
          });
        if (kind === 'code' || kind === 'block')
          return callback({
            kind,
            address: address32(Number(args[1])),
            size: Number(args[2]),
          });
        return callback({
          kind,
          access: Number(args[1]),
          address: address32(Number(args[2])),
          size: Number(args[3]),
          value: BigInt(args[4] as bigint),
        });
      },
      null,
      BigInt(begin),
      BigInt(end),
    );
    const id = this.nextHook++;
    this.hooks.set(id, hook);
    this.engine.ctl_flush_tb();
    return id;
  }
  removeHook(handle: HookHandle): void {
    this.live();
    const raw = this.hooks.get(handle);
    if (!raw) throw new Error('Unknown CPU hook');
    this.engine.hook_del(raw);
    this.engine.ctl_flush_tb();
    this.hooks.delete(handle);
  }
  run(begin: number, instructionLimit: number, until = 0): void {
    this.live();
    address32(begin);
    address32(until);
    if (
      !Number.isInteger(instructionLimit) ||
      instructionLimit <= 0 ||
      instructionLimit > 0x7fffffff
    )
      throw new RangeError('A finite positive instruction limit is required');
    this.check(
      this.module._uc_emu_start(
        this.handle,
        BigInt(begin),
        BigInt(until),
        0n,
        instructionLimit,
      ),
      'run',
    );
  }
  stop(): void {
    this.live();
    this.check(this.module._uc_emu_stop(this.handle), 'stop');
  }
  runSlice(begin: number, budget: number): number {
    this.live();
    address32(begin);
    if (!Number.isInteger(budget) || budget <= 0 || budget > 0x7fffffff)
      throw new RangeError('A finite positive instruction budget is required');
    this.ensureSlice();
    this.check(
      this.module._xhle_slice_run(this.slice, begin, budget),
      'run slice',
    );
    return this.module._xhle_slice_charged(this.slice) >>> 0;
  }
  saveContext(): CpuContext {
    this.live();
    const id = this.engine.context_alloc();
    this.contexts.add(id);
    this.engine.context_save(id);
    return { id };
  }
  restoreContext(context: CpuContext): void {
    this.live();
    if (!this.contexts.has(context.id)) throw new Error('Unknown CPU context');
    this.engine.context_restore(context.id);
  }
  freeContext(context: CpuContext): void {
    this.live();
    if (!this.contexts.delete(context.id))
      throw new Error('Unknown CPU context');
    this.engine.context_free(context.id);
  }
  invalidateCode(begin: number, end: number): void {
    this.live();
    address32(begin);
    if (!Number.isInteger(end) || end <= begin || end > 0x100000000)
      throw new RangeError('Invalid cache range');
    if (end - begin === 0x100000000) this.engine.ctl_flush_tb();
    else this.engine.ctl_remove_cache(BigInt(begin), BigInt(end));
  }
  destroy(): void {
    if (this.dead) return;
    if (this.slice) this.module._xhle_slice_destroy(this.slice);
    if (this.clockCallback) this.module.removeFunction(this.clockCallback);
    for (const id of this.hooks.keys()) this.removeHook(id);
    for (const id of this.contexts) this.freeContext({ id });
    this.engine.close();
    this.module._free(this.engine.handle_ptr); // upstream close does not release this JS allocation
    if (this.transfer) this.module._free(this.transfer);
    this.dead = true;
  }
}

export async function createUnicornBackend(
  cpuModel = 17,
): Promise<UnicornBackend> {
  const url = new URL(
    `${import.meta.env.BASE_URL}runtime/unicorn-arm.js`,
    globalThis.location.origin,
  ).href;
  const imported = (await import(/* @vite-ignore */ url)) as {
    default: (options?: object) => Promise<UnicornModule>;
  };
  const module = await imported.default();
  return new UnicornBackend(module, cpuModel);
}
