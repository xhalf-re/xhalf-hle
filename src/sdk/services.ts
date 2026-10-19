import type { RuntimeCore } from '../runtime/core';
import { words } from './adapter';
import { SensorRegistration } from './sensor';
import { BlankImageJobs } from './image-jobs';
import { NativeStorage } from './storage';

export class SdkServices {
  readonly sensor: SensorRegistration;
  readonly imaging: BlankImageJobs;
  constructor(readonly core: RuntimeCore) {
    const { cpu, profile, sdk } = core,
      board = profile.sdk.board_services;
    new NativeStorage(core);
    this.sensor = new SensorRegistration(core);
    this.imaging = new BlankImageJobs(core);
    for (const stub of profile.firmware.stubs) {
      if (stub.behavior === 'return') {
        if (stub.return_value < 0 || stub.return_value >= 256)
          throw new Error('Unsupported return stub');
        core.patch(
          stub.symbol,
          words([0xe3a00000 | stub.return_value, 0xe12fff1e]),
        );
      } else
        core.bind(stub.symbol, () => {
          const [r0, r1, r2] = sdk.arguments();
          if (stub.behavior === 'sensor_write') {
            cpu.writeRegister('r1', r0!);
            sdk.ret();
          } else if (stub.name === 'dma_fill_async') {
            const dst = sdk.physical(r0!);
            if (!profile.inRam(dst, r2!, true))
              throw new Error('DMA fill outside DRAM');
            const bytes = new Uint8Array(r2!);
            for (let i = 0; i < bytes.length; i++)
              bytes[i] = (r1! >>> (8 * (i & 3))) & 255;
            cpu.write(dst, bytes);
            sdk.ret(-1);
          } else if (stub.name === 'dma_copy_sync') {
            const dst = sdk.physical(r0!),
              src = sdk.physical(r1!);
            if (
              !profile.inRam(dst, r2!, true) ||
              !profile.inRam(src, r2!, true)
            )
              throw new Error('DMA copy outside DRAM');
            cpu.write(dst, cpu.read(src, r2!));
            sdk.ret(r2);
          } else throw new Error('Unknown DMA boundary');
        });
    }
    core.bind('boot.key_adc', () => {
      const view = new DataView(
          cpu.read(profile.address('board.boot_adc_interval'), 4).buffer,
        ),
        low = view.getUint16(0, true),
        high = view.getUint16(2, true);
      if (low > high) throw new Error('Invalid boot ADC interval');
      sdk.ret(Math.floor((low + high) / 2));
    });
    core.bind('board.focus_ring_read', () => {
      sdk.put32(cpu.readRegister('r1'), 0);
      sdk.ret();
    });
    core.bind('board.thermal_read', () => sdk.ret(board.thermal_adc));
    core.bind('board.eye_sensor_read', () =>
      sdk.ret(board.eye_sensor_proximity),
    );
    core.bind('board.preview_geometry', () => {
      for (const [reg, value] of [
        ['r2', board.preview_width],
        ['r3', board.preview_height],
      ] as const) {
        const ptr = cpu.readRegister(reg);
        if (ptr) sdk.put32(ptr, value);
      }
      sdk.ret(board.preview_width);
    });
    core.bind('board.power_control', () => {
      cpu.writeRegister('r1', cpu.readRegister('r0'));
      sdk.ret();
    });
    core.bind('board.power_probe', () => {
      cpu.write(cpu.readRegister('r1'), Uint8Array.of(0));
      sdk.ret();
    });
    const checksum = profile.scratch('checksum');
    cpu.write(checksum, words([0xe3a00000, 0xe12fff1e]));
    core.patch('boot.checksum_slot', words([checksum]));
    // Guest RAM is coherent in the CPU backend. Keep the native wrapper's
    // validation and DMA address return; only data-cache hardware work is absent.
    core.bind('cache.data_maintenance', () => {
      const [address, size] = sdk.arguments(2);
      if (profile.inRam(address!, size!)) sdk.ret();
    });
  }
}
