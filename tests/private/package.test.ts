import { test, expect } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { loadBundle } from '../../src/firmware/package';
import { FirmwareProfile } from '../../src/firmware/profile';
import { sha256 } from '../../src/firmware/bytes';
import { FatVolume } from '../../src/services/fat';

test.skipIf(!process.env.XHALF_DAT || !process.env.XHALF_BASELINE)(
  'real DAT matches the independent desktop patcher, ELF and resource images',
  async () => {
    const root = process.env.XHALF_BASELINE!,
      dat = readFileSync(process.env.XHALF_DAT!);
    const require = createRequire(import.meta.url);
    const burn = require(resolve(root, 'patcher/burn.js')) as {
      parseHeader(bytes: Buffer): { code1: number; hdr3: number };
    };
    const extract = require(resolve(root, 'patcher/burnextract.js')) as {
      resourceEntries(
        bytes: Buffer,
        header: object,
      ): { volume: string | null; offset: number; length: number }[];
    };
    const fat = require(resolve(root, 'patcher/burnfat.js')) as {
      parseFat(bytes: Uint8Array): {
        files: {
          name: string;
          length: number;
          ranges: { offset: number; length: number }[];
        }[];
      };
    };
    const bundle = await loadBundle(dat),
      header = burn.parseHeader(dat),
      entries = extract.resourceEntries(dat, header);
    const profile = new FirmwareProfile();
    await profile.preflight(bundle);
    const report: { profile: string; payload: object; A?: object; B?: object } =
      {
        profile: profile.id,
        payload: {
          length: bundle.payload.length,
          sha256: bundle.identity.payload,
        },
      };
    const elf = readFileSync(resolve(root, 'output.elf')).subarray(84);
    expect(Buffer.compare(bundle.payload, elf)).toBe(0);
    expect(
      Buffer.compare(bundle.payload, dat.subarray(header.code1, header.hdr3)),
    ).toBe(0);
    for (const drive of ['A', 'B'] as const) {
      const reference = entries.find((e) => e.volume === drive)!;
      expect(
        Buffer.compare(
          bundle.images[drive],
          dat.subarray(reference.offset, reference.offset + reference.length),
        ),
      ).toBe(0);
      const image = readFileSync(
        resolve(root, `fpupdate/resource-${drive.toLowerCase()}.img`),
      );
      expect(Buffer.compare(bundle.images[drive], image)).toBe(0);
      const parsed = new FatVolume(bundle.images[drive]),
        files = fat.parseFat(image).files;
      for (const file of files) {
        const bytes = parsed.readFile(file.name),
          expected = Buffer.concat(
            file.ranges.map((r) =>
              image.subarray(r.offset, r.offset + r.length),
            ),
          );
        expect(bytes.length).toBe(file.length);
        expect(Buffer.compare(bytes, expected)).toBe(0);
      }
      report[drive] = {
        length: image.length,
        sha256: await sha256(image),
        comparedFiles: files.length,
      };
    }
    mkdirSync('.private/reports', { recursive: true });
    writeFileSync(
      '.private/reports/M2-diff.json',
      JSON.stringify(report, null, 2),
    );
  },
);
