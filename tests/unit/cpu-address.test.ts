import { expect, test } from 'vitest';
import { address32, memoryRange } from '../../src/cpu/backend';

test('rejects ARM32 wraparound and invalid sizes before calling Wasm', () => {
  expect(address32(0xffffffff)).toBe(0xffffffff);
  expect(() => address32(-1)).toThrow(RangeError);
  expect(() => address32(0x100000000)).toThrow(RangeError);
  expect(() => memoryRange(0xfffffffc, 4)).not.toThrow();
  expect(() => memoryRange(0xfffffffc, 8)).toThrow(RangeError);
  expect(() => memoryRange(0, -1)).toThrow(RangeError);
});
