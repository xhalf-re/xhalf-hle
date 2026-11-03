import { CpuError, address32, memoryRange } from './backend';
import type {
  ArmRegister,
  CpuBackend,
  FpRegister,
  CpuContext,
  CpuHook,
  HookCallback,
  HookKind,
} from './backend';
export interface DynarmicModule {
  xhleHeap(): Uint8Array;
  _malloc(size: number): number;
  _free(pointer: number): void;
  addFunction(
    callback: (...args: unknown[]) => number | void,
    signature: string,
  ): number;
  removeFunction(pointer: number): void;
  dynarmicWasmStats?: Record<string, number>;
  _dh_create(cb: number): number;
  _dh_destroy(h: number): void;
  _dh_read(h: number, a: number, n: number, p: number): number;
  _dh_write(h: number, a: number, n: number, p: number): number;
  _dh_map(h: number, a: number, n: number, p: number): number;
  _dh_unmap(h: number, a: number, n: number): number;
  _dh_protect(h: number, a: number, n: number, p: number): number;
  _dh_run(h: number, b: number, n: number, e: number, exact: number): number;
  _dh_error(h: number): number;
  _dh_configure(h: number, f: number, m: number): void;
  _dh_advance(h: number, counter: bigint): number;
  _dh_waiting(h: number): number;
  _dh_fp(h: number, id: number, size: number): number;
  _dh_save(h: number): number;
  _dh_restore(h: number, context: number): void;
  _dh_free_context(context: number): void;
  _dh_irq_count(h: number): bigint;
  _dh_undefined_count(h: number): bigint;
  _dh_undefined_pc(h: number): number;
  _dh_reg_read(h: number, i: number): number;
  _dh_reg_write(h: number, i: number, v: number): void;
  _dh_hook(h: number, k: number, b: number, e: number): number;
  _dh_unhook(h: number, id: number): void;
  _dh_stop(h: number): void;
  _dh_invalidate(h: number, a: number, n: number): void;
  _dh_irq(h: number, on: number): void;
  _dh_clock(h: number, u: number, f: number, cb: number): void;
  _dh_now(h: number): bigint;
  _dh_deadline(h: number, d: bigint): void;
  _dh_idle(h: number, d: bigint): void;
  _dh_jit_count(h: number): bigint;
  _dh_slow_count(h: number): bigint;
}
const kinds: HookKind[] = [
  'invalid',
  'code',
  'block',
  'read',
  'write',
  'unmapped',
  'interrupt',
];
const registers: ArmRegister[] = [
  'r0',
  'r1',
  'r2',
  'r3',
  'r4',
  'r5',
  'r6',
  'r7',
  'r8',
  'r9',
  'r10',
  'r11',
  'r12',
  'sp',
  'lr',
  'pc',
  'cpsr',
  'spsr',
  'fpexc',
  'fpscr',
];
export class DynarmicBackend implements CpuBackend {
  private host: number;
  private transfer = 0;
  private transferSize = 0;
  private snapshots = new Set<number>();
  private eventPointer: number;
  private timePointer = 0;
  private pendingError: unknown;
  private released = false;
  private bindings = new Map<
    number,
    { kind: HookKind; cb: HookCallback; begin: number; end: number }
  >();
  constructor(
    private dyn: DynarmicModule,
    model = 17,
  ) {
    if (model !== 17)
      throw new RangeError('Only the Cortex-A15 board CPU is supported');
    this.eventPointer = dyn.addFunction((k, a, n, v) => {
      try {
        const kind = kinds[Number(k)]!,
          address = Number(a) >>> 0,
          size = Number(n);
        if (Number(k) === 7)
          throw new CpuError(
            'run',
            size,
            `Dynarmic memory fault at 0x${address.toString(16)}`,
          );
        const event: CpuHook = { kind, address, size };
        if (kind === 'unmapped') event.access = Number(v);
        if (kind === 'write') event.value = v as bigint;
        if (kind === 'interrupt') event.interrupt = Number(v);
        let handled = false;
        for (const h of this.bindings.values())
          if (
            h.kind === kind &&
            (h.begin > h.end || (address >= h.begin && address <= h.end))
          )
            handled = h.cb(event) === true || handled;
        return Number(handled);
      } catch (e) {
        this.pendingError = e;
        if (this.host) this.dyn._dh_stop(this.host);
        return 0;
      }
    }, 'iiiij');
    this.host = dyn._dh_create(this.eventPointer);
  }
  private requireLive() {
    if (this.released) throw new Error('CPU has been destroyed');
  }
  private checked(code: number) {
    if (code) throw new CpuError('CPU', code);
  }
  get memoryBytes() {
    this.requireLive();
    return this.dyn.xhleHeap().byteLength;
  }
  private buffer(n: number) {
    if (n > this.transferSize) {
      const next = this.dyn._malloc(Math.max(n, 256));
      if (!next) throw new CpuError('allocate transfer buffer', 1);
      if (this.transfer) this.dyn._free(this.transfer);
      this.transfer = next;
      this.transferSize = Math.max(n, 256);
    }
    return this.transfer;
  }
  read(a: number, n: number) {
    this.requireLive();
    memoryRange(a, n);
    if (n > 0xffffffff) throw new RangeError('Transfer exceeds native size');
    if (!n) return new Uint8Array();
    const p = this.buffer(n);
    this.checked(this.dyn._dh_read(this.host, a, n, p));
    return this.dyn.xhleHeap().slice(p, p + n);
  }
  write(a: number, bytes: Uint8Array) {
    this.requireLive();
    memoryRange(a, bytes.byteLength);
    if (!bytes.length) return;
    const p = this.buffer(bytes.byteLength);
    this.dyn.xhleHeap().set(bytes, p);
    this.checked(this.dyn._dh_write(this.host, a, bytes.byteLength, p));
  }
  configureSystemRegisters(f: number, m: number) {
    this.requireLive();
    address32(f);
    address32(m);
    if (!f) throw new RangeError('Counter frequency must be positive');
    this.dyn._dh_configure(this.host, f, m);
  }
  advanceSystemCounter(counter: bigint) {
    this.requireLive();
    if (counter < 0n || counter > 0xffffffffffffffffn)
      throw new RangeError('System counter outside uint64');
    return this.dyn._dh_advance(this.host, counter);
  }
  get waitingForInterrupt() {
    this.requireLive();
    return !!this.dyn._dh_waiting(this.host);
  }
  setIrq(on: boolean) {
    this.requireLive();
    this.dyn._dh_irq(this.host, Number(on));
  }
  configureExecutionClock(
    u: number,
    f: number,
    cb: (n: bigint, l: number) => void,
  ) {
    this.requireLive();
    address32(u);
    address32(f);
    if (!u || !f) throw new RangeError('Clock rates must be positive');
    const next = this.dyn.addFunction((n, l) => {
      try {
        cb(n as bigint, Number(l));
      } catch (e) {
        this.pendingError = e;
        this.stop();
      }
    }, 'vji');
    this.dyn._dh_clock(this.host, u, f, next);
    if (this.timePointer) this.dyn.removeFunction(this.timePointer);
    this.timePointer = next;
  }
  setExecutionDeadline(d: bigint | undefined) {
    this.requireLive();
    if (d !== undefined && (d < 0n || d > 0xffffffffffffffffn))
      throw new RangeError('Invalid deadline');
    this.dyn._dh_deadline(this.host, d ?? 0xffffffffffffffffn);
  }
  get executionTime() {
    this.requireLive();
    return this.dyn._dh_now(this.host);
  }
  idleExecutionClock(limit: bigint) {
    this.requireLive();
    if (limit < 0n || limit > 0xffffffffffffffffn)
      throw new RangeError('Invalid idle deadline');
    this.dyn._dh_idle(this.host, limit);
    this.throwPending();
  }
  private pageRange(a: number, n: number, p = 0) {
    memoryRange(a, n);
    if (
      !n ||
      n > 0xffffffff ||
      a % 4096 ||
      n % 4096 ||
      !Number.isInteger(p) ||
      p < 0 ||
      p > 7
    )
      throw new CpuError('memory mapping', 15);
  }
  map(a: number, n: number, p = 7) {
    this.requireLive();
    this.pageRange(a, n, p);
    this.checked(this.dyn._dh_map(this.host, a, n, p));
  }
  unmap(a: number, n: number) {
    this.requireLive();
    this.pageRange(a, n);
    this.checked(this.dyn._dh_unmap(this.host, a, n));
  }
  protect(a: number, n: number, p: number) {
    this.requireLive();
    this.pageRange(a, n, p);
    this.checked(this.dyn._dh_protect(this.host, a, n, p));
  }
  readRegister(r: ArmRegister) {
    this.requireLive();
    const i = registers.indexOf(r);
    if (i < 0) throw new RangeError('Unknown ARM register');
    return this.dyn._dh_reg_read(this.host, i) >>> 0;
  }
  writeRegister(r: ArmRegister, v: number) {
    this.requireLive();
    const i = registers.indexOf(r);
    if (i < 0) throw new RangeError('Unknown ARM register');
    this.dyn._dh_reg_write(this.host, i, v >>> 0);
  }
  readRegisters(rs: readonly ArmRegister[]) {
    return rs.map((r) => this.readRegister(r));
  }
  writeRegisters(rs: readonly (readonly [ArmRegister, number])[]) {
    for (const [r, v] of rs) this.writeRegister(r, v);
  }
  private fpPointer(id: FpRegister, size: number) {
    const match = /^([sdq])(\d+)$/.exec(id);
    if (
      !match ||
      size !== ({ s: 4, d: 8, q: 16 } as Record<string, number>)[match[1]!]
    )
      throw new RangeError('Unsupported FP register or size');
    const index = Number(match[2]);
    if (!Number.isSafeInteger(index) || index >= (size === 4 ? 32 : 256 / size))
      throw new RangeError('Unsupported FP register or size');
    return this.dyn._dh_fp(this.host, index, size);
  }
  readRegisterBytes(id: FpRegister, n: number) {
    this.requireLive();
    const p = this.fpPointer(id, n);
    if (!p) throw new RangeError('Unsupported FP register or size');
    return this.dyn.xhleHeap().slice(p, p + n);
  }
  writeRegisterBytes(id: FpRegister, b: Uint8Array) {
    this.requireLive();
    const p = this.fpPointer(id, b.byteLength);
    if (!p) throw new RangeError('Unsupported FP register or size');
    this.dyn.xhleHeap().set(b, p);
  }
  hook(kind: HookKind, cb: HookCallback, begin = 1, end = 0) {
    this.requireLive();
    address32(begin);
    address32(end);
    const id = this.dyn._dh_hook(this.host, kinds.indexOf(kind), begin, end);
    this.bindings.set(id, { kind, cb, begin, end });
    return id;
  }
  removeHook(id: number) {
    this.requireLive();
    if (!this.bindings.delete(id)) throw new Error('Unknown CPU hook');
    this.dyn._dh_unhook(this.host, id);
  }
  private execute(b: number, n: number, end: number, exact: boolean) {
    this.requireLive();
    address32(b);
    address32(end);
    if (!Number.isInteger(n) || n <= 0 || n > 0x7fffffff)
      throw new RangeError('Finite positive budget required');
    const charged = this.dyn._dh_run(this.host, b, n, end, Number(exact));
    this.throwPending();
    if (this.dyn.dynarmicWasmStats?.compileFailed)
      throw new CpuError(
        'compile ARM block',
        1,
        'The browser could not allocate JIT code memory after releasing cached blocks. Close other emulator tabs and reload.',
      );
    this.checked(this.dyn._dh_error(this.host));
    return charged;
  }
  private throwPending() {
    if (this.pendingError) {
      const e = this.pendingError;
      this.pendingError = undefined;
      throw e;
    }
  }
  run(b: number, n: number, end = 0) {
    this.execute(b, n, end, true);
  }
  runSlice(b: number, n: number) {
    return this.execute(b, n, 0, false);
  }
  stop() {
    this.requireLive();
    this.dyn._dh_stop(this.host);
  }
  saveContext(): CpuContext {
    this.requireLive();
    const id = this.dyn._dh_save(this.host);
    this.snapshots.add(id);
    return { id };
  }
  restoreContext(c: CpuContext) {
    this.requireLive();
    if (!this.snapshots.has(c.id)) throw new Error('Unknown CPU context');
    this.dyn._dh_restore(this.host, c.id);
  }
  freeContext(c: CpuContext) {
    this.requireLive();
    if (!this.snapshots.delete(c.id)) throw new Error('Unknown CPU context');
    this.dyn._dh_free_context(c.id);
  }
  invalidateCode(a: number, e: number) {
    this.requireLive();
    address32(a);
    if (!Number.isInteger(e) || e <= a || e > 0x100000000)
      throw new RangeError('Invalid cache range');
    this.dyn._dh_invalidate(this.host, a, e - a);
  }
  get executionStats() {
    this.requireLive();
    return {
      jitInstructions: Number(this.dyn._dh_jit_count(this.host)),
      jitCompileRetries: this.dyn.dynarmicWasmStats?.compileRetries ?? 0,
      jitRetryPending: this.dyn.dynarmicWasmStats?.retryPending ?? 0,
      jitLiveModules: this.dyn.dynarmicWasmStats?.liveModules ?? 0,
      jitPeakLiveModules: this.dyn.dynarmicWasmStats?.peakLiveModules ?? 0,
      jitPackedModules: this.dyn.dynarmicWasmStats?.packedModules ?? 0,
      jitLiveBlocks: this.dyn.dynarmicWasmStats?.liveBlocks ?? 0,
      jitPeakLiveBlocks: this.dyn.dynarmicWasmStats?.peakLiveBlocks ?? 0,
      jitReleasedBlocks: this.dyn.dynarmicWasmStats?.releasedBlocks ?? 0,
      jitCacheCapacity: this.dyn.dynarmicWasmStats?.cacheCapacity ?? 65536,
      jitCompiledBlocks: this.dyn.dynarmicWasmStats?.blocks ?? 0,
      jitCompileMs: this.dyn.dynarmicWasmStats?.compileMs ?? 0,
      jitTranslateMs: this.dyn.dynarmicWasmStats?.translateMs ?? 0,
      jitEmitMs: this.dyn.dynarmicWasmStats?.emitMs ?? 0,
      systemInstructions: Number(this.dyn._dh_slow_count(this.host)),
      irqEntries: Number(this.dyn._dh_irq_count(this.host)),
      undefinedInstructions: Number(this.dyn._dh_undefined_count(this.host)),
      lastUndefinedPc: this.dyn._dh_undefined_pc(this.host) >>> 0,
    };
  }
  destroy() {
    if (this.released) return;
    for (const id of this.snapshots) this.dyn._dh_free_context(id);
    this.snapshots.clear();
    this.dyn._dh_destroy(this.host);
    if (this.transfer) this.dyn._free(this.transfer);
    this.bindings.clear();
    this.dyn.removeFunction(this.eventPointer);
    if (this.timePointer) this.dyn.removeFunction(this.timePointer);
    this.released = true;
  }
}
export async function createDynarmicBackend() {
  const url = new URL(
    `${import.meta.env.BASE_URL}runtime/dynarmic-arm.js`,
    globalThis.location.origin,
  ).href;
  const m = (await import(/* @vite-ignore */ url)) as {
    default: () => Promise<DynarmicModule>;
  };
  return new DynarmicBackend(await m.default());
}
