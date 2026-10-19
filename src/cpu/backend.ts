/** Addresses are unsigned ARM32 values; reject wraparound rather than alias RAM. */
export function address32(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff)
    throw new RangeError('ARM32 address out of range');
  return value;
}

export function memoryRange(address: number, size: number): void {
  address32(address);
  if (!Number.isSafeInteger(size) || size < 0 || address + size > 0x100000000)
    throw new RangeError('ARM32 memory range out of bounds');
}

export type ArmRegister =
  | `r${0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12}`
  | 'sp'
  | 'lr'
  | 'pc'
  | 'cpsr'
  | 'spsr'
  | 'fpexc'
  | 'fpscr';
export type HookKind =
  'code' | 'block' | 'read' | 'write' | 'unmapped' | 'interrupt' | 'invalid';
export type CpuHook = {
  kind: HookKind;
  address: number;
  size: number;
  access?: number;
  value?: bigint;
  interrupt?: number;
};
export type HookCallback = (event: CpuHook) => boolean | void;
export type HookHandle = number;
export type CpuContext = { readonly id: number };

export interface CpuBackend {
  configureSystemRegisters(frequency: number, mpidr: number): void;
  /** Update the external counter and return the five generic timer IRQ levels. */
  advanceSystemCounter(counter: bigint): number;
  /** External level-sensitive IRQ input; exception entry is owned by the CPU. */
  setIrq(asserted: boolean): void;
  /** Advance board time at TB boundaries; callbacks run only on deadlines/IRQ changes. */
  configureExecutionClock(
    instructionNs: number,
    frequency: number,
    callback: (now: bigint, levels: number) => void,
  ): void;
  setExecutionDeadline(deadline: bigint | undefined): void;
  readonly executionTime: bigint;
  idleExecutionClock(limit: bigint): void;
  /** True after WFI until an external interrupt supplies work. */
  readonly waitingForInterrupt: boolean;
  map(address: number, size: number, permissions?: number): void;
  unmap(address: number, size: number): void;
  protect(address: number, size: number, permissions: number): void;
  read(address: number, size: number): Uint8Array;
  write(address: number, bytes: Uint8Array): void;
  readRegister(register: ArmRegister): number;
  readRegisters(registers: readonly ArmRegister[]): number[];
  writeRegister(register: ArmRegister, value: number): void;
  writeRegisters(values: readonly (readonly [ArmRegister, number])[]): void;
  readRegisterBytes(id: number, size: number): Uint8Array;
  writeRegisterBytes(id: number, bytes: Uint8Array): void;
  hook(
    kind: HookKind,
    callback: HookCallback,
    begin?: number,
    end?: number,
  ): HookHandle;
  removeHook(handle: HookHandle): void;
  run(begin: number, instructionLimit: number, until?: number): void;
  /** Approximate instruction budget, stopped at a translated block boundary. */
  runSlice?(begin: number, instructionBudget: number): number;
  stop(): void;
  saveContext(): CpuContext;
  restoreContext(context: CpuContext): void;
  freeContext(context: CpuContext): void;
  invalidateCode(begin: number, end: number): void;
  destroy(): void;
  readonly memoryBytes: number;
}
