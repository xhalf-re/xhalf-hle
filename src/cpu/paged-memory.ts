import type {
  ArmRegister,
  CpuBackend,
  CpuContext,
  HookCallback,
  HookHandle,
  HookKind,
} from './backend';
import { memoryRange } from './backend';
/** Explicit machine RAM ranges backed lazily; never maps unknown MMIO or code. */
export class PagedMemory implements CpuBackend {
  configureSystemRegisters(frequency: number, mpidr: number): void {
    this.backend.configureSystemRegisters(frequency, mpidr);
  }
  advanceSystemCounter(counter: bigint): number {
    return this.backend.advanceSystemCounter(counter);
  }
  setIrq(asserted: boolean): void {
    this.backend.setIrq(asserted);
  }
  configureExecutionClock(
    instructionNs: number,
    frequency: number,
    callback: (now: bigint, levels: number) => void,
  ): void {
    this.backend.configureExecutionClock(instructionNs, frequency, callback);
  }
  setExecutionDeadline(deadline: bigint | undefined): void {
    this.backend.setExecutionDeadline(deadline);
  }
  get executionTime(): bigint {
    return this.backend.executionTime;
  }
  idleExecutionClock(limit: bigint): void {
    this.backend.idleExecutionClock(limit);
  }
  get waitingForInterrupt(): boolean {
    return this.backend.waitingForInterrupt;
  }
  private pages = new Set<number>();
  constructor(
    private backend: CpuBackend,
    private ranges: readonly number[][],
  ) {}
  ensure(address: number, size: number): boolean {
    memoryRange(address, size);
    let covered = false;
    for (const [base, length] of this.ranges) {
      if (base === undefined || length === undefined) continue;
      const start = Math.max(address, base),
        end = Math.min(address + size, base + length);
      if (end <= start) continue;
      covered = address >= base && address + size <= base + length;
      let page = Math.floor(start / 4096) * 4096;
      while (page < end) {
        if (this.pages.has(page)) {
          page += 4096;
          continue;
        }
        const first = page;
        do {
          page += 4096;
        } while (page < end && !this.pages.has(page));
        // A framebuffer DMA often touches hundreds of adjacent pages. Mapping
        // each page separately makes Unicorn rebuild its region index for every
        // 4 KiB and slows later memory accesses as the region list grows.
        this.backend.map(first, page - first);
        for (let mapped = first; mapped < page; mapped += 4096)
          this.pages.add(mapped);
      }
    }
    return covered;
  }
  map(address: number, size: number, permissions?: number): void {
    this.backend.map(address, size, permissions);
  }
  unmap(address: number, size: number): void {
    this.backend.unmap(address, size);
    for (let at = address; at < address + size; at += 4096)
      this.pages.delete(at);
  }
  protect(address: number, size: number, permissions: number): void {
    this.backend.protect(address, size, permissions);
  }
  read(address: number, size: number): Uint8Array {
    this.ensure(address, size);
    return this.backend.read(address, size);
  }
  write(address: number, bytes: Uint8Array): void {
    this.ensure(address, bytes.length);
    this.backend.write(address, bytes);
  }
  readRegister(register: ArmRegister): number {
    return this.backend.readRegister(register);
  }
  readRegisters(registers: readonly ArmRegister[]): number[] {
    return this.backend.readRegisters(registers);
  }
  writeRegisters(values: readonly (readonly [ArmRegister, number])[]): void {
    this.backend.writeRegisters(values);
  }
  writeRegister(register: ArmRegister, value: number): void {
    this.backend.writeRegister(register, value);
  }
  readRegisterBytes(id: number, size: number): Uint8Array {
    return this.backend.readRegisterBytes(id, size);
  }
  writeRegisterBytes(id: number, bytes: Uint8Array): void {
    this.backend.writeRegisterBytes(id, bytes);
  }
  hook(
    kind: HookKind,
    callback: HookCallback,
    begin?: number,
    end?: number,
  ): HookHandle {
    return this.backend.hook(kind, callback, begin, end);
  }
  removeHook(handle: HookHandle): void {
    this.backend.removeHook(handle);
  }
  run(begin: number, limit: number, until?: number): void {
    this.backend.run(begin, limit, until);
  }
  runSlice(begin: number, budget: number): number {
    if (this.backend.runSlice) return this.backend.runSlice(begin, budget);
    this.backend.run(begin, budget);
    return budget;
  }
  stop(): void {
    this.backend.stop();
  }
  saveContext(): CpuContext {
    return this.backend.saveContext();
  }
  restoreContext(context: CpuContext): void {
    this.backend.restoreContext(context);
  }
  freeContext(context: CpuContext): void {
    this.backend.freeContext(context);
  }
  invalidateCode(begin: number, end: number): void {
    this.backend.invalidateCode(begin, end);
  }
  destroy(): void {
    this.backend.destroy();
    this.pages.clear();
  }
  get memoryBytes(): number {
    return this.backend.memoryBytes;
  }
}
