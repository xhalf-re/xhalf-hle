import type { CpuBackend, CpuContext } from '../cpu/backend';
import type { FirmwareBundle } from '../firmware/package';
import type { FirmwareProfile } from '../firmware/profile';
import { SdkAdapter, registerName, words } from '../sdk/adapter';
import { Gic } from './gic';
import { PagedMemory } from '../cpu/paged-memory';
import { PeripheralBus } from '../devices/bus';
import { HardwareTimers } from '../devices/timer';
import { CommandQueue } from '../devices/command-queue';
import { PanelController } from '../devices/panel';
import { SerialControllers } from '../devices/serial';
import { SensorFrontend } from '../devices/frontend';
import { GpioInterrupts } from '../devices/gpio';
import { ClockGates } from '../devices/clocks';
import { CaptureDma } from '../devices/capture';
import { StorageDevice } from '../devices/storage';

export interface GuestCall {
  function: number;
  arguments: number[];
  kind?: string;
  returns?: 'void';
}
export class RuntimeCore {
  readonly sdk: SdkAdapter;
  readonly gic: Gic;
  readonly peripherals = new PeripheralBus();
  readonly hardwareTimers: HardwareTimers;
  readonly commandQueue: CommandQueue;
  readonly panel: PanelController;
  readonly serial: SerialControllers;
  readonly frontend: SensorFrontend;
  readonly gpio: GpioInterrupts;
  readonly capture: CaptureDma;
  readonly storage: StorageDevice;
  virtualNs = 0n;
  instructions = 0;
  mmioReads = 0;
  mmioWrites = 0;
  uartCharacters = 0;
  assertions = 0;
  systemTimerAssertions = 0;
  private systemTimerLevels = 0;
  readonly hooks = new Map<string, number>();
  readonly calls = new Map<string, number>();
  nextCall: (() => GuestCall | null) | undefined;
  prepareCall: ((call: GuestCall) => GuestCall) | undefined;
  completeCall: ((call: GuestCall, status: number) => void) | undefined;
  afterStep: (() => void) | undefined;
  private injected:
    | {
        context: CpuContext;
        pc: number;
        systemState: number;
        budget: number;
        call: GuestCall;
      }
    | undefined;
  private callPollStep = -1;
  constructor(
    readonly cpu: CpuBackend,
    readonly profile: FirmwareProfile,
    readonly bundle: FirmwareBundle,
  ) {
    const paged = new PagedMemory(cpu, profile.machine.sparse_dram);
    cpu = paged;
    this.cpu = cpu;
    this.sdk = new SdkAdapter(cpu, profile);
    const m = profile.machine,
      b = profile.firmware.boot;
    cpu.configureSystemRegisters(m.counter_hz, m.mpidr);
    cpu.setIrq(false);
    this.gic = new Gic(m.gic, (asserted) => cpu.setIrq(asserted));
    this.peripherals.attach(this.gic);
    this.peripherals.attach(new ClockGates(m.peripherals.clocks));
    this.hardwareTimers = new HardwareTimers(
      m.peripherals.timers,
      this.peripherals.clock,
      this.gic,
    );
    this.peripherals.attach(this.hardwareTimers);
    this.commandQueue = new CommandQueue(
      m.peripherals.command_queue,
      this.peripherals.clock,
      this.gic,
      {
        synchronizationDelay: (module) =>
          this.peripherals.synchronizationDelay(module),
        readWord: (address) => {
          const physical = (address | m.memory.physical_alias) >>> 0;
          if (!profile.inRam(physical, 4, true))
            throw new Error('CQ command outside DRAM');
          return this.sdk.u32(physical);
        },
        readRegister: (address, size) => {
          if (
            address < m.memory.mmio[0]! ||
            address + size > m.memory.mmio[0]! + m.memory.mmio[1]!
          )
            throw new Error('CQ register outside MMIO');
          const handled = this.peripherals.read(address, size);
          if (handled !== undefined) return Number(handled);
          const bytes = cpu.read(address, size);
          return size === 1
            ? bytes[0]!
            : new DataView(bytes.buffer).getUint16(0, true);
        },
        writeRegister: (address, size, value) => {
          if (
            address < m.memory.mmio[0]! ||
            address + size > m.memory.mmio[0]! + m.memory.mmio[1]!
          )
            throw new Error('CQ register outside MMIO');
          this.peripherals.write(address, size, BigInt(value >>> 0));
          const bytes = new Uint8Array(size),
            view = new DataView(bytes.buffer);
          if (size === 1) view.setUint8(0, value);
          else view.setUint16(0, value, true);
          cpu.write(address, bytes);
        },
      },
    );
    this.peripherals.attach(this.commandQueue);
    this.panel = new PanelController(
      m.peripherals.panel,
      this.peripherals.clock,
      this.gic,
    );
    this.peripherals.attach(this.panel);
    this.serial = new SerialControllers(
      m.peripherals.serial,
      this.peripherals.clock,
    );
    this.peripherals.attach(this.serial);
    this.gpio = new GpioInterrupts(
      m.peripherals.gpio,
      this.gic,
      this.peripherals.clock,
    );
    this.peripherals.attach(this.gpio);
    this.capture = new CaptureDma(
      m.peripherals.capture,
      this.peripherals.clock,
      (source) => this.frontend.signal(source),
    );
    this.peripherals.attach(this.capture);
    this.frontend = new SensorFrontend(
      m.peripherals.frontend,
      this.peripherals.clock,
      this.gic,
      (source) => this.gpio.signal(source),
      () => this.gpio.frame(),
      (port, start) => this.capture.frame(port, start),
    );
    this.peripherals.attach(this.frontend);
    this.storage = new StorageDevice(m.peripherals.storage, bundle.images, {
      valid: (address, size) => profile.inRam(address, size),
      read: (address, size) => cpu.read(address, size),
      write: (address, bytes) => cpu.write(address, bytes),
    });
    this.peripherals.attach(this.storage);
    for (const key of ['dram', 'sram', 'scratch', 'mmio'] as const) {
      const region = m.memory[key];
      cpu.map(region[0]!, region[1]!);
    }
    for (const base of [m.static_ttbr0, m.scratch.ttbr0]) {
      const values = Array.from(
        { length: 4096 },
        (_, i) => ((i << 20) | m.section_flags) >>> 0,
      );
      cpu.write(base, words(values));
    }
    cpu.write(b.load_base, bundle.payload);
    if (b.sram_copy) {
      const [source, target, size] = b.sram_copy;
      if (profile.inRam(source, size))
        cpu.write(target, cpu.read(source, size));
    }
    if (b.zero_from !== null) {
      const end = b.zero_to ?? b.load_base + bundle.payload.length;
      if (end < b.zero_from || !profile.inRam(b.zero_from, end - b.zero_from))
        throw new Error('Invalid BSS range');
      cpu.write(b.zero_from, new Uint8Array(end - b.zero_from));
    }
    cpu.writeRegister('pc', b.load_base);
    cpu.hook('unmapped', (event) => {
      if (
        (event.access === 19 || event.access === 20) &&
        paged.ensure(event.address, event.size)
      )
        return true;
      throw new Error(
        `Unmapped ARM access ${event.access} at 0x${event.address.toString(16)}, PC 0x${cpu.readRegister('pc').toString(16)}`,
      );
    });
    const stubs = new Map(
      Object.entries({ ...m.read_stubs, ...m.hle_read_stubs }).map(
        ([key, value]) => [Number(key), value],
      ),
    );
    const [mmio, size] = m.memory.mmio;
    cpu.hook(
      'read',
      (e) => {
        this.mmioReads++;
        this.synchronizeClock();
        let value: number | bigint | undefined = this.peripherals.read(
          e.address,
          e.size,
        );
        if (value !== undefined) {
          /* Device owns this register. */
        } else if (e.address === m.uart.status) value = 0x60;
        else if (e.address === m.uart.rx) value = 0;
        else value = stubs.get(e.address);
        if (value !== undefined) {
          const bytes = new Uint8Array(e.size),
            view = new DataView(bytes.buffer);
          if (e.size === 1) view.setUint8(0, Number(value));
          else if (e.size === 2) view.setUint16(0, Number(value), true);
          else if (e.size === 4) view.setUint32(0, Number(value), true);
          else if (e.size === 8) view.setBigUint64(0, BigInt(value), true);
          else throw new Error('Unsupported MMIO access width');
          cpu.write(e.address, bytes);
        }
      },
      mmio!,
      mmio! + size! - 1,
    );
    cpu.hook(
      'write',
      (e) => {
        this.mmioWrites++;
        this.synchronizeClock();
        this.peripherals.write(e.address, e.size, e.value ?? 0n);
        if (e.address === m.uart.tx) this.uartCharacters++;
      },
      mmio!,
      mmio! + size! - 1,
    );
    this.bind('assert.entry', () => {
      this.assertions++;
      cpu.stop();
      throw new Error(
        `Native ASSERT at PC 0x${cpu.readRegister('pc').toString(16)}, LR 0x${cpu.readRegister('lr').toString(16)}`,
      );
    });
    const ret = profile.scratch('inject_return');
    cpu.write(ret, words([0xeafffffe]));
    cpu.hook('block', () => this.leaveCall(), ret, ret);
    this.bind(
      'runtime.idle',
      () => {
        if (!this.injected && this.callPollStep !== this.instructions) {
          // Host input is constant during cpu.run().
          // Revisit delivery on the next slice rather than repeatedly
          // inspecting the same SDK queues in native polling loops.
          this.callPollStep = this.instructions;
          const call = this.nextCall?.();
          if (call) this.enterCall(call);
        }
      },
      true,
    );
    cpu.configureExecutionClock(
      m.ns_per_instruction,
      m.counter_hz,
      (now, levels) => {
        this.virtualNs = now;
        this.peripherals.clock.advance(now);
        this.updateSystemTimerLevels(levels);
      },
    );
    this.peripherals.clock.onDeadlineChanged = (deadline) =>
      cpu.setExecutionDeadline(deadline);
    cpu.setExecutionDeadline(this.peripherals.clock.nextDeadline);
  }
  bind(
    name: string,
    callback: () => void,
    code = false,
    optional = false,
  ): boolean {
    const symbol = this.profile.firmware.symbols[name];
    if (!symbol || this.profile.disabledGroups.has(symbol.group)) {
      if (optional) return false;
      throw new Error(`Required hook unavailable: ${name}`);
    }
    this.hooks.set(
      name,
      this.cpu.hook(
        code ? 'code' : 'block',
        () => {
          this.calls.set(name, (this.calls.get(name) ?? 0) + 1);
          callback();
        },
        symbol.address,
        symbol.address,
      ),
    );
    return true;
  }
  patch(name: string, bytes: Uint8Array): void {
    const address = this.profile.address(name);
    this.cpu.write(address, bytes);
    this.cpu.invalidateCode(address, address + bytes.length);
  }
  private updateSystemTimerLevels(levels: number): void {
    if (levels === this.systemTimerLevels) return;
    this.profile.machine.gic.timer_irqs.forEach((irq, index) => {
      if (!((levels ^ this.systemTimerLevels) & (1 << index))) return;
      if (levels & ~this.systemTimerLevels & (1 << index))
        this.systemTimerAssertions++;
      this.gic.setLevel(irq, !!(levels & (1 << index)));
    });
    this.systemTimerLevels = levels;
  }
  private synchronizeClock(): void {
    const now = this.cpu.executionTime;
    if (now !== this.virtualNs) {
      this.virtualNs = now;
      this.peripherals.clock.advance(now);
    }
  }
  private enterCall(call: GuestCall): void {
    const prepared = this.prepareCall?.(call) ?? call;
    if (prepared.arguments.length > 4)
      throw new Error(
        'ISR call requires the AAPCS trampoline for stack arguments',
      );
    const systemState = this.sdk.word('tx.system_state'),
      context = this.cpu.saveContext(),
      pc = this.cpu.readRegister('pc');
    this.injected = { context, pc, systemState, budget: 2000000, call };
    this.sdk.put32(this.profile.address('tx.system_state'), systemState + 1);
    this.cpu.writeRegister('lr', this.profile.scratch('inject_return'));
    this.cpu.writeRegister('pc', prepared.function);
    for (let i = 0; i < 4; i++)
      this.cpu.writeRegister(registerName(`r${i}`), prepared.arguments[i] ?? 0);
  }
  private leaveCall(): void {
    const current = this.injected;
    if (!current) throw new Error('Unexpected callback return trap');
    const result = this.cpu.readRegister('r0');
    this.cpu.restoreContext(current.context);
    this.cpu.freeContext(current.context);
    this.cpu.writeRegister('pc', current.pc);
    this.sdk.put32(
      this.profile.address('tx.system_state'),
      current.systemState,
    );
    this.injected = undefined;
    this.cpu.stop();
    this.completeCall?.(
      current.call,
      current.call.returns === 'void' ? 0 : result,
    );
  }
  /** An optional deadline bounds the budget; the final TB can cross it. */
  step(until?: bigint): void {
    const start = this.cpu.executionTime,
      unit = BigInt(this.profile.machine.ns_per_instruction);
    if (until !== undefined && until <= start)
      throw new RangeError('Runtime step deadline must be in the future');
    let count = 100000;
    if (until !== undefined) {
      const remaining = (until - start + unit - 1n) / unit;
      if (remaining < BigInt(count)) count = Number(remaining);
    }
    const end = start + BigInt(count) * unit,
      [address, cpsr] = this.cpu.readRegisters(['pc', 'cpsr']),
      pc = (address! | (cpsr! & 0x20 ? 1 : 0)) >>> 0;
    let charged = 0;
    if (!this.cpu.waitingForInterrupt) {
      if (this.cpu.runSlice) charged = this.cpu.runSlice(pc, count);
      else {
        this.cpu.run(pc, count);
        charged = count;
      }
    }
    this.instructions += charged;
    if (this.cpu.waitingForInterrupt) this.cpu.idleExecutionClock(end);
    this.synchronizeClock();
    if (this.injected) {
      this.injected.budget -= charged;
      if (this.injected.budget <= 0)
        throw new Error('Native callback instruction budget exceeded');
    }
    this.afterStep?.();
  }
  diagnostics(): Record<string, string | number | boolean> {
    let threads: ReturnType<SdkAdapter['threads']> = [],
      stable = true;
    try {
      threads = this.sdk.threads();
    } catch {
      stable = false;
    }
    const menu = this.sdk.menuState();
    return {
      profile: this.profile.id,
      pc: this.cpu.readRegister('pc'),
      virtualMs: Number(this.virtualNs / 1000000n),
      instructions: this.instructions,
      mmioReads: this.mmioReads,
      mmioWrites: this.mmioWrites,
      uartCharacters: this.uartCharacters,
      assertions: this.assertions,
      systemTimerAssertions: this.systemTimerAssertions,
      threads: threads.length,
      threadSnapshotStable: stable,
      threadRuns: threads.reduce((n, t) => n + Number(t.run_count), 0),
      uiCreated: threads.some((t) => t.ui === true),
      uiRan: threads.some((t) => t.ui === true && Number(t.run_count) > 0),
      uiBusyThreads: threads.filter((t) => t.ui && Number(t.state) === 0)
        .length,
      touchTaskState: Number(
        threads.find((t) => t.name === 'Tup_Thread')?.state ?? -1,
      ),
      touchDrawState: Number(
        threads.find((t) => t.name === 'Tup_DrawThread')?.state ?? -1,
      ),
      hostRan: threads.some(
        (t) =>
          t.name === this.profile.sdk.threadx.ui_thread_names[0] &&
          Number(t.run_count) > 0,
      ),
      menu: menu?.id ?? 0,
      index: menu?.index ?? 0,
      menuCount: menu?.count ?? 0,
      mode: menu?.mode ?? 0,
      optionCount: this.sdk.word('ui.option_visible_count'),
      mainScroll: this.sdk.word('ui.main_scroll') | 0,
      subScroll: this.sdk.word('ui.sub_scroll') | 0,
      optionScroll: this.sdk.word('ui.option_scroll') | 0,
      category: menu?.category ?? 0,
      wasmBytes: this.cpu.memoryBytes,
      currentThread: this.sdk.word('tx.current_thread'),
      systemState: this.sdk.word('tx.system_state'),
      sensorFrames: this.frontend.frames,
      captureDmaFrames: this.capture.frames,
      storageCommands: this.storage.commands,
      storageReadBytes: this.storage.bytesRead,
      storageWriteBytes: this.storage.bytesWritten,
      storageErrors: this.storage.errors,
      storageOverlaySectors: this.storage.images[1]!.overlaySectors,
      serialTransfers: this.serial.transfers,
      panelTransfers: this.panel.transfers,
      cqCompletions: this.commandQueue.completions,
      hardwareTimerFirings: this.hardwareTimers.firings,
      deviceEvents: this.peripherals.clock.pending,
      installedHooks: this.hooks.size,
      hookHits: Array.from(this.calls.values()).reduce(
        (n, value) => n + value,
        0,
      ),
      blockedThreads: threads.filter((thread) => Number(thread.state) > 2)
        .length,
    };
  }
  destroy(): void {
    this.peripherals.reset();
    this.cpu.destroy();
  }
}
