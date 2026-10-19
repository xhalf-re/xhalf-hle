import type { CpuBackend, ArmRegister } from '../cpu/backend';
import type { FirmwareProfile } from '../firmware/profile';

export const registerName = (name: string): ArmRegister =>
  (name === 'ip' ? 'r12' : name === 'fp' ? 'r11' : name) as ArmRegister;
export function words(values: number[]): Uint8Array {
  const bytes = new Uint8Array(values.length * 4),
    view = new DataView(bytes.buffer);
  values.forEach((value, i) => view.setUint32(i * 4, value >>> 0, true));
  return bytes;
}
export class SdkAdapter {
  constructor(
    readonly cpu: CpuBackend,
    readonly profile: FirmwareProfile,
  ) {}
  u32(address: number): number {
    return new DataView(this.cpu.read(address, 4).buffer).getUint32(0, true);
  }
  put32(address: number, value: number): void {
    this.cpu.write(address, words([value]));
  }
  word(name: string): number {
    return this.u32(this.profile.address(name));
  }
  byte(name: string): number {
    return this.cpu.read(this.profile.address(name), 1)[0]!;
  }
  offset(layout: string, field: string): number {
    const definition = this.profile.layouts[layout]?.fields[field];
    if (!definition) throw new Error(`Unknown SDK field ${layout}.${field}`);
    return definition[0];
  }
  field(address: number, layout: string, field: string): number {
    const definition = this.profile.layouts[layout]?.fields[field];
    if (!definition) throw new Error(`Unknown SDK field ${layout}.${field}`);
    const [offset, format] = definition,
      view = new DataView(
        this.cpu.read(address + offset, { I: 4, H: 2, B: 1 }[format]).buffer,
      );
    return format === 'I'
      ? view.getUint32(0, true)
      : format === 'H'
        ? view.getUint16(0, true)
        : view.getUint8(0);
  }
  structure(address: number, layout: string): Record<string, number> {
    const definition = this.profile.layouts[layout];
    if (!definition) throw new Error(`Unknown SDK layout ${layout}`);
    const length =
      definition.size ||
      Math.max(
        ...Object.values(definition.fields).map(
          ([offset, format]) => offset + { I: 4, H: 2, B: 1 }[format],
        ),
      );
    if (!this.profile.inRam(address, length))
      throw new Error('SDK structure outside RAM');
    const view = new DataView(this.cpu.read(address, length).buffer);
    return Object.fromEntries(
      Object.entries(definition.fields).map(([name, [offset, format]]) => [
        name,
        format === 'I'
          ? view.getUint32(offset, true)
          : format === 'H'
            ? view.getUint16(offset, true)
            : view.getUint8(offset),
      ]),
    );
  }
  arguments(count = 4): number[] {
    const args = this.cpu.readRegisters(
      (['r0', 'r1', 'r2', 'r3'] as const).slice(0, count),
    );
    if (count > 4) {
      const view = new DataView(
        this.cpu.read(this.cpu.readRegister('sp'), (count - 4) * 4).buffer,
      );
      for (let i = 4; i < count; i++)
        args.push(view.getUint32((i - 4) * 4, true));
    }
    return args;
  }
  ret(value = 0, high?: number): void {
    this.cpu.writeRegisters([
      ['r0', value >>> 0],
      ...(high === undefined ? [] : [['r1', high >>> 0] as const]),
      ['pc', this.cpu.readRegister('lr')],
    ]);
  }
  physical(pointer: number): number {
    return (pointer | this.profile.machine.memory.physical_alias) >>> 0;
  }
  string(address: number, limit = 1024): string {
    if (!address) return '';
    const result: number[] = [];
    while (result.length < limit) {
      const at = address + result.length,
        size = Math.min(limit - result.length, 4096 - (at & 4095)),
        bytes = this.cpu.read(at, size);
      for (const b of bytes) {
        if (!b) return new TextDecoder().decode(Uint8Array.from(result));
        result.push(b);
      }
    }
    throw new Error('Unterminated SDK string');
  }
  uiQueue(): number {
    const schema = this.profile.layouts.sysg!;
    return this.u32(
      this.word('sysg.context_literal') +
        this.offset('sysg', 'queue_base') +
        Number(schema.ui_channel) * Number(schema.channel_stride),
    );
  }
  queueState(pointer: number): Record<string, number> | null {
    if (!this.profile.inRam(pointer, this.profile.layouts.queue!.size, true))
      return null;
    const row = this.structure(pointer, 'queue');
    return row.id === this.profile.sdk.threadx.queue_id ? row : null;
  }
  menuState(): Record<string, number> | null {
    const pointer = this.word('ui.current_menu');
    if (!this.profile.inRam(pointer, this.profile.layouts.menu!.size, true))
      return null;
    const row = this.structure(pointer, 'menu'),
      range = this.profile.sdk.input.menu_id_range;
    if (row.id! < range[0]! || row.id! >= range[1]!) return null;
    return {
      id: row.id!,
      count: row.count!,
      index: row.index!,
      handler: row.handler!,
      mode: this.field(this.profile.address('ui.state'), 'ui_state', 'mode'),
      category: this.byte('ui.category'),
    };
  }
  threads(): Record<string, number | string | boolean>[] {
    const count = this.u32(this.word('tx.created_count_literal')),
      head = this.u32(this.word('tx.created_head_literal'));
    if (count > 1024 || Boolean(count) !== Boolean(head))
      throw new Error('Invalid ThreadX list');
    let pointer = head;
    const seen = new Set<number>(),
      rows: Record<string, number | string | boolean>[] = [];
    for (let i = 0; i < count; i++) {
      if (
        seen.has(pointer) ||
        !this.profile.inRam(pointer, this.profile.layouts.thread!.size, true)
      )
        throw new Error('Invalid ThreadX chain');
      seen.add(pointer);
      const row = this.structure(pointer, 'thread');
      if (row.id !== this.profile.sdk.threadx.thread_id)
        throw new Error('Invalid ThreadX control block');
      if (this.field(row.next!, 'thread', 'previous') !== pointer)
        throw new Error('ThreadX links disagree');
      const name = this.string(row.name!, 256);
      rows.push({
        ...row,
        address: pointer,
        name,
        ui: this.profile.sdk.threadx.ui_thread_names.includes(name),
      });
      pointer = row.next!;
    }
    if (pointer !== head) throw new Error('ThreadX count mismatch');
    return rows;
  }
}
