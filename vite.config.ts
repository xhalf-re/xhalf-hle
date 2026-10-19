import { defineConfig } from 'vitest/config';

export default defineConfig({
  base: '/xhalf-hle/',
  worker: { format: 'es' },
  optimizeDeps: { entries: ['index.html', 'tests/harness/cpu.html'] },
  server: { watch: { ignored: ['**/vendor/**', '**/.private/**'] } },
  test: { include: ['tests/unit/**/*.test.ts'] },
});
