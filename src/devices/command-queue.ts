import type { Gic } from '../runtime/gic';
import {
  readBytes,
  writeBytes,
  type MmioDevice,
  type VirtualEvents,
} from './bus';
type QueueExecution = {
  pc: number;
  bank: number;
  registers: Uint32Array;
  instructions: number;
  generation: number;
};
export interface CommandDma {
  readWord(address: number): number;
  synchronizationDelay(module: number): bigint;
  readRegister(address: number, size: number): number;
  writeRegister(address: number, size: number, value: number): void;
}
export interface CommandQueueRegisters {
  base: number;
  channels: number;
  irq: number;
  completion_ns: number;
}
/** CQ command/flush completion and the native SDK's mask/W1C interrupt aggregator. */
export class CommandQueue implements MmioDevice {
  readonly ranges;
  private registers = new Uint8Array(0x200);
  private status = [0, 0];
  private masks = [0, 0];
  private generations = new Uint32Array(8);
  completions = 0;
  instructions = 0;
  constructor(
    readonly config: CommandQueueRegisters,
    private clock: VirtualEvents,
    private gic: Gic,
    private dma?: CommandDma,
  ) {
    this.ranges = [[config.base, 0x200]] as const;
  }
  private updateIrq(): void {
    this.gic.setLevel(
      this.config.irq,
      !!(
        (this.status[0]! & this.masks[0]!) |
        (this.status[1]! & this.masks[1]!)
      ),
    );
  }
  read(address: number, size: number): bigint {
    return readBytes(size, (i) => {
      const offset = address - this.config.base + i;
      if (offset < 8) return this.status[offset >>> 2]! >>> ((offset & 3) * 8);
      if (offset >= 0x10 && offset < 0x18)
        return this.masks[(offset - 0x10) >>> 2]! >>> ((offset & 3) * 8);
      return this.registers[offset]!;
    });
  }
  private word(offset: number): number {
    return new DataView(this.registers.buffer).getUint32(offset, true);
  }
  private setWord(offset: number, value: number): void {
    new DataView(this.registers.buffer).setUint32(offset, value >>> 0, true);
  }
  private run(channel: number, state?: QueueExecution): void {
    const offset = 0x100 + channel * 32,
      dma = this.dma;
    if (!dma) throw new Error('CQ DMA transport unavailable');
    const execution = state ?? {
      pc: this.word(offset + 4),
      bank: 0,
      registers: new Uint32Array(16),
      instructions: 0,
      generation: this.generations[channel]!,
    };
    if (
      execution.generation !== this.generations[channel] ||
      !(this.registers[offset]! & 1)
    )
      return;
    let { pc, bank } = execution;
    const registers = execution.registers;
    for (let count = 0; count < 256; count++) {
      if (++execution.instructions > 1000000)
        throw new Error('CQ command execution budget exceeded');
      this.instructions++;
      if (pc & 3) throw new Error('Unaligned CQ command address');
      const word = dma.readWord(pc),
        opcode = word >>> 28;
      this.setWord(offset + 12, pc);
      pc = (pc + 4) >>> 0;
      if (word === 0x0f000000) {
        this.registers[offset] = this.registers[offset]! & ~1;
        this.status[0] = (this.status[0]! | (1 << channel)) >>> 0;
        this.completions++;
        this.updateIrq();
        return;
      }
      if (word === 0) continue;
      if ((word & 0xff000000) === 0x01000000) {
        bank = word & 255;
        continue;
      }
      if ((word & 0xffffffe0) === 0x02000000) {
        const delay = dma.synchronizationDelay(word & 31);
        execution.pc = pc;
        execution.bank = bank;
        this.clock.schedule(`cq-job:${channel}`, this.clock.now + delay, () =>
          this.run(channel, execution),
        );
        return;
      }
      if ((word & 0xff000000) === 0x12000000) {
        const condition = (word >>> 20) & 15,
          value = registers[(word >>> 16) & 15]!;
        if (condition > 1)
          throw new Error(`Unsupported CQ branch condition (${condition})`);
        if (condition === 0 ? value === 0 : value !== 0)
          pc = (pc + ((word << 16) >> 16) * 4) >>> 0;
        continue;
      }
      if (opcode === 2) {
        pc = ((word & 0x0fffffff) << 2) >>> 0;
        continue;
      }
      if (
        opcode === 13 &&
        ((word >>> 24) & 15) === 6 &&
        (word & 0xffff) === 0
      ) {
        const value = registers[(word >>> 16) & 15]!;
        registers[(word >>> 20) & 15] = value;
        registers[15] = value;
        continue;
      }
      if (opcode === 13 && ((word >>> 24) & 15) === 2) {
        const value = registers[(word >>> 16) & 15]! & (word & 0xffff);
        registers[(word >>> 20) & 15] = value;
        registers[15] = value;
        continue;
      }
      const address = (0x10000000 | (bank << 12) | (word & 0xfff)) >>> 0;
      if (opcode === 4) {
        const mask = (word >>> 20) & 255,
          value = (word >>> 12) & 255;
        dma.writeRegister(
          address,
          1,
          (dma.readRegister(address, 1) & ~mask) | (value & mask),
        );
        continue;
      }
      if (opcode === 5) {
        dma.writeRegister(address, 2, (word >>> 12) & 0xffff);
        continue;
      }
      if (opcode === 6) {
        const operation = (word >>> 24) & 15,
          reg = (word >>> 20) & 15;
        if (operation === 13) {
          registers[reg] = word & 0xffff;
          continue;
        }
        if (operation === 8 || operation === 4) {
          registers[reg] = dma.readRegister(address, operation === 4 ? 2 : 1);
          continue;
        }
        if (operation === 12 || operation === 0) {
          dma.writeRegister(address, operation === 0 ? 2 : 1, registers[reg]!);
          continue;
        }
      }
      throw new Error(
        `Unsupported CQ operation (${opcode},${(word >>> 24) & 15}) at 0x${(pc - 4).toString(16)}`,
      );
    }
    execution.pc = pc;
    execution.bank = bank;
    this.clock.schedule(
      `cq-job:${channel}`,
      this.clock.now + BigInt(this.config.completion_ns),
      () => this.run(channel, execution),
    );
  }
  write(address: number, size: number, value: bigint): void {
    const begin = address - this.config.base;
    writeBytes(size, value, (i, byte) => {
      const offset = begin + i;
      if (offset < 8) {
        const bank = offset >>> 2;
        this.status[bank] =
          (this.status[bank]! & ~(byte << ((offset & 3) * 8))) >>> 0;
      } else if (offset >= 0x10 && offset < 0x18) {
        const bank = (offset - 0x10) >>> 2,
          shift = (offset & 3) * 8;
        this.masks[bank] =
          ((this.masks[bank]! & ~(255 << shift)) | (byte << shift)) >>> 0;
      } else {
        this.registers[offset] = byte;
        if (offset >= 0x100) {
          const ch = (offset - 0x100) >>> 5,
            field = (offset - 0x100) & 31,
            key = `cq-job:${ch}`;
          if (field === 0) {
            this.generations[ch] = this.generations[ch]! + 1;
            this.clock.cancel(key);
            if (byte & 1)
              this.clock.schedule(
                key,
                this.clock.now + BigInt(this.config.completion_ns),
                () => this.run(ch),
              );
          } else if (field === 2 && byte & 1) {
            this.generations[ch] = this.generations[ch]! + 1;
            this.clock.cancel(key);
          }
        }
        const channel = offset - 0x90;
        if (channel >= 0 && channel < this.config.channels) {
          const key = `cq:${channel}`;
          this.clock.cancel(key);
          if (byte & 0xc0)
            this.clock.schedule(
              key,
              this.clock.now + BigInt(this.config.completion_ns),
              () => {
                this.registers[offset] = byte & 0x3f;
                this.status[1] = (this.status[1]! | (1 << channel)) >>> 0;
                this.completions++;
                this.updateIrq();
              },
            );
        }
      }
    });
    this.updateIrq();
  }
  reset(): void {
    this.registers.fill(0);
    this.status.fill(0);
    this.masks.fill(0);
    this.completions = this.instructions = 0;
    this.generations.fill(0);
    for (let ch = 0; ch < this.config.channels; ch++) {
      this.clock.cancel(`cq:${ch}`);
      this.clock.cancel(`cq-job:${ch}`);
    }
    this.updateIrq();
  }
}
