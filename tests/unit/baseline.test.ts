import { expect, test } from 'vitest';
import config from '../../vite.config';

test('Pages assets resolve beneath the repository path', () => {
  expect(config.base).toBe('/xhalf-hle/');
});
