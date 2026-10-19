import { runContracts } from './cpu-contracts';
// This harness is served only by the development test server, never built into the app.
Object.assign(window, {
  runContracts,
  createCpuWorker: () =>
    new Worker(new URL('./cpu-worker.ts', import.meta.url), { type: 'module' }),
});
