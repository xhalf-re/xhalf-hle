import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: { include: ['tests/private/**/*.test.ts'], testTimeout: 60000 },
});
