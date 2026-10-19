import { test, expect } from 'vitest';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { UnicornBackend, type UnicornModule } from '../../src/cpu/unicorn';
import { loadBundle } from '../../src/firmware/package';
import { FirmwareProfile } from '../../src/firmware/profile';
import { RuntimeCore } from '../../src/runtime/core';
import { SdkServices } from '../../src/sdk/services';
import { GuestCalls } from '../../src/sdk/guest';
import { BulkAcceleration } from '../../src/sdk/acceleration';
import { FatVolume } from '../../src/services/fat';
import driver from '../../src/sdk/storage-driver.json';
import firmware from '../../src/profiles/xhalf-main.json';
import bindings from './fixtures/storage-bindings.json';

// Calls execute while the real boot task is stopped at our block driver's
// return, before the UI starts using the disks. No invented ThreadX task or ISR.
test.skipIf(!process.env.XHALF_DAT)(
  'original ARM VFS reads every DAT resource and writes B through virtual sectors',
  async () => {
    const bundle = await loadBundle(readFileSync(process.env.XHALF_DAT!)),
      profile = new FirmwareProfile({
        ...firmware,
        symbols: { ...firmware.symbols, ...bindings.symbols },
      });
    expect(profile.id).toBe(bindings.profile);
    await profile.preflight(bundle);
    const imported = (await import(
        /* @vite-ignore */ pathToFileURL(
          resolve('public/runtime/unicorn-arm.js'),
        ).href
      )) as { default: () => Promise<UnicornModule> },
      cpu = new UnicornBackend(
        await imported.default(),
        profile.machine.cpu_model,
      ),
      core = new RuntimeCore(cpu, profile, bundle),
      guest = new GuestCalls(core),
      originalA = createHash('sha256').update(bundle.images.A).digest('hex'),
      originalB = createHash('sha256').update(bundle.images.B).digest('hex');
    new SdkServices(core);
    new BulkAcceleration(core);
    let registered = false;
    const site = profile.scratch('storage_driver') + driver.mount - 4,
      handle = cpu.hook(
        'code',
        () => {
          registered = true;
          cpu.stop();
        },
        site,
        site,
      ),
      report: Record<string, unknown> = {};
    try {
      const deadline = performance.now() + 15000;
      while (!registered) {
        core.step();
        if (performance.now() > deadline)
          throw Error('Native storage registration timed out');
      }
      cpu.removeHook(handle);
      expect(core.sdk.u32(profile.scratch('storage_driver') + 544)).toBe(0);
      expect(core.sdk.word('tx.system_state')).toBe(0);
      expect(core.sdk.word('tx.current_thread')).not.toBe(0);
      expect(
        [...core.hooks.keys()].some(
          (name) => name.startsWith('vfs.') || name === 'media.mount',
        ),
      ).toBe(false);
      const buffer = 0x46000000,
        path = 0x3f168000,
        packet = 0x3f169000,
        end = 0x3f16a000;
      const invoke = (name: string, args: number[]) => {
        const context = cpu.saveContext();
        try {
          cpu.write(packet, guest.packet(profile.address(name), args));
          cpu.writeRegister('r0', packet);
          cpu.writeRegister('lr', end);
          cpu.run(profile.scratch('call_thunk'), 10000000, end);
          expect(cpu.readRegister('pc'), `${name} returned`).toBe(end);
          return [cpu.readRegister('r0'), cpu.readRegister('r1')];
        } finally {
          cpu.restoreContext(context);
          cpu.freeContext(context);
        }
      };
      const setPath = (text: string) =>
        cpu.write(path, new TextEncoder().encode(text + '\0'));
      const open = (text: string, flags = 0x10) => {
        setPath(text);
        return invoke('vfs.open', [path, flags])[0]!;
      };
      const close = (fd: number) =>
        expect(invoke('vfs.close', [fd])[0]).toBe(0);
      const counts: Record<string, number> = { A: 0, B: 0 };
      let byteCount = 0;
      for (const drive of ['A', 'B'] as const) {
        const fat = new FatVolume(bundle.images[drive]);
        for (const entry of fat.entries.values()) {
          if (entry.directory) continue;
          const filename = `${drive}:/${entry.path}`,
            fd = open(filename);
          expect(fd, filename).not.toBe(0);
          expect(invoke('vfs.size', [fd])[0], filename).toBe(entry.size);
          const size64 = invoke('vfs.size64', [fd]);
          expect(size64).toEqual([entry.size, 0]);
          const expected = fat.readFile(entry.path);
          for (let offset = 0; offset < entry.size;) {
            const size = Math.min(entry.size - offset, 65521);
            expect(invoke('vfs.read', [fd, buffer, size])[0], filename).toBe(
              size,
            );
            expect(
              Buffer.compare(
                cpu.read(buffer, size),
                expected.subarray(offset, offset + size),
              ),
              filename,
            ).toBe(0);
            offset += size;
          }
          expect(invoke('vfs.read', [fd, buffer, 17])[0]).toBe(0);
          expect(invoke('vfs.tell', [fd])[0]).toBe(entry.size);
          close(fd);
          counts[drive] = counts[drive]! + 1;
          byteCount += entry.size;
        }
      }
      expect(open('A:/does-not-exist.bin')).toBe(0);
      expect(open('B:/does-not-exist.bin')).toBe(0);
      const bytes = Uint8Array.from(
          { length: 23017 },
          (_, i) => (i * 79 + 11) & 255,
        ),
        filename = 'B:/HLECHECK.BIN',
        writer = open(filename, 4);
      expect(writer).not.toBe(0);
      cpu.write(buffer, bytes);
      expect(invoke('vfs.write', [writer, buffer, bytes.length])[0]).toBe(
        bytes.length,
      );
      close(writer);
      const reader = open(filename);
      expect(reader).not.toBe(0);
      expect(invoke('vfs.read', [reader, buffer, bytes.length + 19])[0]).toBe(
        bytes.length,
      );
      expect(cpu.read(buffer, bytes.length)).toEqual(bytes);
      expect(invoke('vfs.seek', [reader, 0, 507, 0, 0])[0]).toBe(507);
      expect(invoke('vfs.tell', [reader])[0]).toBe(507);
      expect(invoke('vfs.read', [reader, buffer, 4099])[0]).toBe(4099);
      expect(cpu.read(buffer, 4099)).toEqual(bytes.subarray(507, 4606));
      close(reader);
      setPath(filename);
      cpu.write(buffer, new Uint8Array(bindings.stat.size));
      expect(invoke('vfs.stat', [path, buffer])[0]).toBe(0);
      expect(core.sdk.u32(buffer + bindings.stat.size_offset)).toBe(
        bytes.length,
      );
      expect(core.storage.images[1]!.overlaySectors).toBeGreaterThan(0);
      expect(core.storage.errors).toBe(0);
      expect(createHash('sha256').update(bundle.images.A).digest('hex')).toBe(
        originalA,
      );
      expect(createHash('sha256').update(bundle.images.B).digest('hex')).toBe(
        originalB,
      );
      report.files = counts;
      report.bytes = byteCount;
      report.writeBytes = bytes.length;
      report.metrics = core.diagnostics();
      const b = core.storage.images[1]!;
      const sectors = b.overlaySectors;
      core.storage.reset();
      expect(b.overlaySectors).toBe(0);
      report.resetSectors = sectors;
      report.passed = true;
    } catch (error) {
      report.error = String(error);
      throw error;
    } finally {
      mkdirSync('.private/storage', { recursive: true });
      writeFileSync(
        '.private/storage/acceptance.json',
        JSON.stringify(report, null, 2),
      );
      core.destroy();
    }
  },
  180000,
);
