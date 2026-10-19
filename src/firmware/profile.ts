import { z } from 'zod';
import machineDocument from '../profiles/machine.json';
import sdkDocument from '../profiles/sdk.json';
import firmwareDocument from '../profiles/xhalf-main.json';
import type { FirmwareBundle } from './package';
import { sha256 } from './bytes';
import { checkCancelled, FirmwareError } from './errors';

const uint = z.number().int().min(0).max(0xffffffff);
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const span = z
  .object({
    length: z
      .number()
      .int()
      .positive()
      .max(512 * 1024 * 1024),
    sha256: digest,
  })
  .strict();
const guard = span.extend({ length: z.number().int().positive().max(4096) });
const format = z.enum(['I', 'H', 'B']);
const layoutSchema = z
  .object({ size: uint, fields: z.record(z.string(), z.tuple([uint, format])) })
  .catchall(uint);
export type Layout = z.infer<typeof layoutSchema>;
export type Machine = typeof machineDocument;
export type Sdk = Omit<typeof sdkDocument, 'layouts'> & {
  layouts: Record<string, Layout>;
};
const symbolSchema = z
  .object({
    address: uint,
    kind: z.enum(['function', 'code', 'data', 'literal']),
    optional: z.boolean().default(false),
    group: z.string().default('core'),
    guard: guard.optional(),
    analysis_name: z.string().optional(),
  })
  .strict();
export const firmwareSchema = z
  .object({
    schema: z.literal(1),
    webSchema: z.literal(2),
    id: z.string(),
    target: z.literal('main'),
    status: z.enum(['candidate', 'supported']),
    description: z.string(),
    machine: z.string(),
    sdk: z.string(),
    firmware: z
      .object({
        sha256: digest,
        payload_sha256: digest,
        package_sha256: digest,
      })
      .strict(),
    boot: z
      .object({
        load_base: uint,
        zero_from: uint.nullable(),
        zero_to: uint.nullable(),
        sram_copy: z.tuple([uint, uint, uint]).nullable(),
      })
      .strict(),
    symbols: z.record(z.string(), symbolSchema),
    stubs: z.array(
      z
        .object({
          symbol: z.string(),
          name: z.string(),
          behavior: z.enum(['return', 'dma', 'sensor_write']),
          return_value: z.number().int(),
          reason: z.string(),
        })
        .strict(),
    ),
    ui: z
      .object({
        roles: z.record(z.string(), uint),
        categories: z.array(z.string()).length(7),
        first_setup_ids: z.array(uint),
        view_mode: uint,
        basic_language_index: uint,
        first_item: uint,
        verification: z
          .object({
            setup_sidebar_index: uint,
            setup_rows: uint,
            language_scroll_delta: uint,
            shooting_submenu_index: uint,
            first_category_key: z.string(),
            setup_category_key: z.string(),
          })
          .strict(),
      })
      .strict(),
    resources: z.object({ A: span, B: span }).strict(),
    state_abi: uint,
    layout_overrides: z.record(z.string(), layoutSchema).optional(),
  })
  .strict();
export type Firmware = z.infer<typeof firmwareSchema>;

function templateSchema(template: unknown): z.ZodType {
  if (typeof template === 'number') return z.number().int().safe();
  if (typeof template === 'string') return z.string();
  if (Array.isArray(template)) {
    if (!template.length) return z.array(z.unknown());
    // SDK tables are allowed to grow; each row retains its defined ABI shape.
    const schemas = template.map(templateSchema);
    return z.array(
      schemas.length === 1
        ? schemas[0]!
        : z.union(schemas as [z.ZodType, z.ZodType, ...z.ZodType[]]),
    );
  }
  if (template && typeof template === 'object')
    return z
      .object(
        Object.fromEntries(
          Object.entries(template).map(([key, value]) => [
            key,
            templateSchema(value),
          ]),
        ),
      )
      .strict();
  throw new Error('Unsupported profile template type');
}
const machineSchema = templateSchema(machineDocument);
// Layout tuples need their own validation rather than template array inference.
const { layouts: _layouts, ...sdkTemplate } = sdkDocument;
const sdkSchema = templateSchema(sdkTemplate);

export class FirmwareProfile {
  private dramRanges: [number, number][] = [];
  private otherRamRanges: [number, number][] = [];
  readonly firmware: Firmware;
  readonly machine: Machine;
  readonly sdk: Sdk;
  readonly layouts: Record<string, Layout>;
  readonly disabledGroups = new Map<string, string>();
  constructor(
    firmware: unknown = firmwareDocument,
    machine: unknown = machineDocument,
    sdk: unknown = sdkDocument,
  ) {
    try {
      this.firmware = firmwareSchema.parse(firmware);
      this.machine = machineSchema.parse(machine) as Machine;
      const raw = z
        .object({ layouts: z.record(z.string(), layoutSchema) })
        .passthrough()
        .parse(sdk);
      const { layouts, ...rest } = raw;
      this.sdk = {
        ...(sdkSchema.parse(rest) as Omit<Sdk, 'layouts'>),
        layouts,
      };
    } catch {
      throw new FirmwareError(
        'PROFILE_MISMATCH',
        'Unsupported profile format. Update the app or review a new profile.',
      );
    }
    const f = this.firmware,
      m = this.machine,
      s = this.sdk;
    if (
      !['display', 'scan-buffer'].includes(s.input.pointer_space) ||
      s.input.pointer_size.length !== 2 ||
      s.input.pointer_size.some(
        (value) => !Number.isInteger(value) || value <= 0 || value > 8192,
      )
    )
      throw new FirmwareError(
        'PROFILE_MISMATCH',
        'Invalid SDK touch coordinate space.',
      );
    if (
      f.status !== 'supported' ||
      f.machine !== m.id ||
      f.sdk !== s.id ||
      m.schema !== 1 ||
      s.schema !== 1 ||
      m.architecture !== 'arm32' ||
      s.adapter !== 'spca6500-arm32'
    )
      throw new FirmwareError(
        'PROFILE_MISMATCH',
        'The profile is not approved or does not match the machine/SDK.',
      );
    for (const binding of Object.values(f.symbols)) {
      if (
        (binding.kind === 'function' || binding.kind === 'code') &&
        (binding.address % 4 || !binding.guard)
      )
        throw new FirmwareError(
          'PROFILE_MISMATCH',
          'An ARM hook address or validation guard is missing.',
        );
    }
    const regions = ['dram', 'sram', 'scratch', 'mmio'] as const;
    for (const region of regions) {
      const [base, size] = m.memory[region];
      if (
        base === undefined ||
        size === undefined ||
        base < 0 ||
        base % 4096 ||
        size <= 0 ||
        size % 4096 ||
        base + size > 0x100000000
      )
        throw new FirmwareError('PROFILE_MISMATCH', 'Invalid memory mapping.');
      for (const other of regions) {
        if (other === region) continue;
        const [a, n] = m.memory[other];
        if (
          a === undefined ||
          n === undefined ||
          (base < a + n && a < base + size)
        )
          throw new FirmwareError(
            'PROFILE_MISMATCH',
            'Memory mappings overlap.',
          );
      }
    }
    this.layouts = structuredClone(s.layouts);
    for (const range of m.sparse_dram) {
      const [base, size] = range;
      if (
        range.length !== 2 ||
        base === undefined ||
        size === undefined ||
        base < 0 ||
        base % 4096 ||
        size <= 0 ||
        size % 4096 ||
        base + size > 0x100000000
      )
        throw new FirmwareError(
          'PROFILE_MISMATCH',
          'Invalid paged DRAM range.',
        );
      for (const region of regions) {
        const [a, n] = m.memory[region];
        if (
          a !== undefined &&
          n !== undefined &&
          base < a + n &&
          a < base + size
        )
          throw new FirmwareError(
            'PROFILE_MISMATCH',
            'Paged DRAM overlaps a fixed mapping.',
          );
      }
    }
    for (const [name, override] of Object.entries(f.layout_overrides ?? {}))
      this.layouts[name] = override;
    for (const [base, size] of [m.memory.dram, ...m.sparse_dram].sort(
      (a, b) => a[0]! - b[0]!,
    )) {
      const previous = this.dramRanges.at(-1),
        limit = base! + size!;
      if (previous && base! <= previous[1])
        previous[1] = Math.max(previous[1], limit);
      else this.dramRanges.push([base!, limit]);
    }
    this.otherRamRanges = [m.memory.sram, m.memory.scratch].map(
      ([base, size]) => [base!, base! + size!],
    );
    for (const layout of Object.values(this.layouts))
      for (const [offset, type] of Object.values(layout.fields)) {
        if (layout.size && offset + { I: 4, H: 2, B: 1 }[type] > layout.size)
          throw new FirmwareError(
            'PROFILE_MISMATCH',
            'An SDK field is out of bounds.',
          );
      }
  }
  get id(): string {
    return this.firmware.id;
  }
  address(name: string): number {
    const symbol = this.firmware.symbols[name];
    if (!symbol)
      throw new FirmwareError(
        'PROFILE_MISMATCH',
        `Missing required binding: ${name}`,
      );
    return symbol.address;
  }
  scratch(name: keyof Machine['scratch']): number {
    return this.machine.scratch[name];
  }
  inRam(address: number, length = 0, dramOnly = false): boolean {
    if (
      !Number.isSafeInteger(address) ||
      !Number.isSafeInteger(length) ||
      length < 0
    )
      return false;
    for (const [base, limit] of this.dramRanges)
      if (address >= base && address < limit && address + length <= limit)
        return true;
    if (!dramOnly)
      for (const [base, limit] of this.otherRamRanges)
        if (address >= base && address < limit && address + length <= limit)
          return true;
    return false;
  }
  async preflight(bundle: FirmwareBundle, signal?: AbortSignal): Promise<void> {
    const f = this.firmware;
    checkCancelled(signal);
    if (bundle.identity.payload !== f.firmware.payload_sha256)
      throw new FirmwareError(
        'UNKNOWN_FIRMWARE',
        'This firmware version is not supported. A matching profile is required.',
      );
    if (bundle.identity.package !== f.firmware.package_sha256)
      throw new FirmwareError(
        'PROFILE_MISMATCH',
        'The firmware package does not match the validated container. Boot parameters must come from an approved DAT.',
      );
    for (const drive of ['A', 'B'] as const) {
      if (
        bundle.images[drive].length !== f.resources[drive].length ||
        bundle.identity[drive] !== f.resources[drive].sha256
      )
        throw new FirmwareError(
          'PROFILE_MISMATCH',
          'Resource volumes do not match the validated version. Choose a complete original DAT.',
        );
    }
    const check = async (address: number, expected: z.infer<typeof guard>) => {
      const offset = address - f.boot.load_base;
      return (
        offset >= 0 &&
        offset + expected.length <= bundle.payload.length &&
        (await sha256(
          bundle.payload.subarray(offset, offset + expected.length),
        )) === expected.sha256
      );
    };
    this.disabledGroups.clear();
    for (const [name, symbol] of Object.entries(f.symbols)) {
      if (symbol.guard && !(await check(symbol.address, symbol.guard))) {
        if (symbol.optional)
          this.disabledGroups.set(symbol.group, `Validation failed: ${name}`);
        else
          throw new FirmwareError(
            'PROFILE_MISMATCH',
            `Required hook validation failed: ${name}`,
          );
      }
      checkCancelled(signal);
    }
    checkCancelled(signal);
  }
}
