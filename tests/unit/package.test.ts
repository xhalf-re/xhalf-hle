import { expect, test } from 'vitest';
import { loadBundle, parsePackage } from '../../src/firmware/package';
import { packageFixture, fixChecksum, put32 } from './fixtures';

test('extracts main and resources as shared views without Node dependencies', async () => {
  const bytes = packageFixture(),
    bundle = await loadBundle(bytes);
  expect(bundle.payload.length).toBe(4096);
  expect(bundle.images.A.length).toBe(5120);
  expect(bundle.payload.buffer).toBe(bytes.buffer);
  expect(bundle.images.A.buffer).toBe(bytes.buffer);
  expect(bundle.identity.payload).toMatch(/^[0-9a-f]{64}$/);
});
test('rejects truncation, section order, HDR table bounds and checksum corruption', () => {
  const bytes = packageFixture();
  expect(() => parsePackage(bytes.subarray(0, 0x5300))).toThrow();
  for (const [offset, value] of [
    [0x14, 0x700],
    [0x18, 0x4900],
    [0x610, 0xffffffff],
  ]) {
    const bad = bytes.slice();
    put32(bad, offset!, value!);
    expect(() => parsePackage(bad)).toThrow();
  }
  const bad = bytes.slice();
  bad[0x3100] = 1;
  expect(() => parsePackage(bad)).toThrow(/checksum/);
});
test('rejects missing, duplicate and overlapping resource volumes', () => {
  const missing = packageFixture();
  put32(missing, 0x610, 1);
  fixChecksum(missing);
  expect(() => parsePackage(missing)).toThrow(/missing/);
  const duplicate = packageFixture();
  duplicate[0x620 + 128 + 'synthetic:build<sign>'.length] =
    'A'.charCodeAt(0) ^ 0x7a;
  expect(() => parsePackage(duplicate)).toThrow(/duplicate volumes/);
  const overlap = packageFixture();
  const row = overlap.slice(0x6a0, 0x720).map((v) => v ^ 0x7a);
  put32(row, 0x70, 0x900);
  overlap.set(
    row.map((v) => v ^ 0x7a),
    0x6a0,
  );
  expect(() => parsePackage(overlap)).toThrow(/overlap/);
});
test('supports cancellation before and after asynchronous fingerprinting', async () => {
  const cancelled = new AbortController();
  cancelled.abort();
  await expect(
    loadBundle(packageFixture(), cancelled.signal),
  ).rejects.toMatchObject({ code: 'CANCELLED' });
  const active = new AbortController(),
    pending = loadBundle(packageFixture(), active.signal);
  active.abort();
  await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
});
