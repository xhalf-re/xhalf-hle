import type { RuntimeCore } from '../runtime/core';
import driver from './storage-driver.json';
import { words } from './adapter';

/** Install a virtual board disk driver using the SDK's own block registry. */
export class NativeStorage {
  constructor(core: RuntimeCore) {
    const { cpu, sdk, profile, bundle } = core,
      base = profile.scratch('storage_driver'),
      table = base + 512,
      status = base + 544,
      contexts = base + 1024,
      abi = profile.sdk.storage,
      ids = profile.machine.peripherals.storage.volume_ids;
    if (
      driver.parameters + 48 !== driver.code.length ||
      profile.layouts.disk_context!.size !== 128 ||
      sdk.offset('disk_context', 'volume') !== 96 ||
      abi.context_bpb_offset !== 128 ||
      abi.context_stride !== 1024 ||
      base % 8 !== 0 ||
      !profile.inRam(base, 4096)
    )
      throw new Error('Invalid virtual disk driver ABI');
    const code = Uint8Array.from(driver.code);
    code.set(
      words([
        profile.machine.peripherals.storage.base,
        table,
        ...[
          'context_register',
          'mount_set',
          'read_set',
          'write_set',
          'erase_set',
          'sync_set',
          'format_set',
          'present_set',
        ].map((name) => profile.address(`storage.${name}`)),
        profile.address('vfs.mount'),
        status,
      ]),
      driver.parameters,
    );
    cpu.write(base, code);
    cpu.write(status, words([0]));
    const rows: number[] = [];
    for (const [i, drive] of (['A', 'B'] as const).entries()) {
      const context = contexts + i * abi.context_stride,
        bytes = new Uint8Array(abi.context_stride),
        view = new DataView(bytes.buffer),
        name = context + abi.context_bpb_offset + 512;
      bytes[sdk.offset('disk_context', 'vendor')] = 1;
      bytes[sdk.offset('disk_context', 'present')] = 1;
      view.setUint32(sdk.offset('disk_context', 'name'), name, true);
      view.setUint32(sdk.offset('disk_context', 'volume'), ids[i]!, true);
      view.setUint32(
        sdk.offset('disk_context', 'sector_count'),
        bundle.images[drive].length / 512,
        true,
      );
      bytes.set(bundle.images[drive].subarray(0, 512), abi.context_bpb_offset);
      bytes.set(new TextEncoder().encode(`VIRTUAL-${drive}\0`), name - context);
      cpu.write(context, bytes);
      rows.push(ids[i]!, context);
    }
    cpu.write(table, words(rows));
    // Independent LDR PC literal veneers enter our ARM driver in the real
    // boot task. No ISR injection, file API replacement or guest-state edits.
    core.patch('init.nand_resource_init', words([0xe51ff004, base]));
    core.patch('storage.media_mount', words([0xe51ff004, base + driver.mount]));
  }
}
