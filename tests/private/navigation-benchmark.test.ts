import { test, expect } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { DynarmicBackend, type DynarmicModule } from '../../src/cpu/dynarmic';
import { loadBundle } from '../../src/firmware/package';
import { FirmwareProfile } from '../../src/firmware/profile';
import { RuntimeCore } from '../../src/runtime/core';
import { SdkServices } from '../../src/sdk/services';
import { NativeDisplay } from '../../src/sdk/display';
import { SdkGraphics } from '../../src/sdk/graphics';
import { NativeInput } from '../../src/sdk/input';
import { FirstSetup } from '../../src/runtime/first-setup';
import { BulkAcceleration } from '../../src/sdk/acceleration';

/** Unpaced wall/virtual cost of one native menu navigation; see docs/BENCHMARK.md.  Run standalone (no sibling test files): vitest parallels files and skews timing.*/
test.skipIf(!process.env.XHALF_DAT)(
  'navigation benchmark: wall, virtual and instruction cost per menu move',
  async () => {
    const bundle = await loadBundle(readFileSync(process.env.XHALF_DAT!)),
      profile = new FirmwareProfile();
    await profile.preflight(bundle);
    const imported = (await import(
      /* @vite-ignore */ pathToFileURL(
        resolve('public/runtime/dynarmic-arm.js'),
      ).href
    )) as { default: () => Promise<DynarmicModule> };
    const backend = new DynarmicBackend(
      await imported.default(),
      profile.machine.cpu_model,
    );
    const core = new RuntimeCore(backend, profile, bundle),
      input = new NativeInput(core);
    core.executionSliceBudget = Number(process.env.XHALF_STEP_BUDGET ?? 100000);
    const skipDisplayPoll = process.env.XHALF_BENCH_SKIP_DISPLAY === '1';
    let pollMs = 0,
      polls = 0,
      frames = 0,
      stepMs = 0,
      steps = 0;
    let runSliceMs = 0,
      runSliceCalls = 0,
      diagnosticsMs = 0,
      diagnosticsCalls = 0;
    const nativeRunSlice = backend.runSlice?.bind(backend);
    if (!nativeRunSlice) throw new Error('Dynarmic runSlice is required');
    backend.runSlice = (begin, budget) => {
      const started = performance.now();
      const charged = nativeRunSlice(begin, budget);
      runSliceMs += performance.now() - started;
      runSliceCalls++;
      return charged;
    };
    const display = new NativeDisplay(core, (frame) => {
      frames++;
      // A headless consumer must return buffers too: otherwise all samples
      // after boot silently measure a permanently backpressured display.
      display.acknowledge(frame.frame, frame.pixels);
    });
    new SdkServices(core);
    new SdkGraphics(core);
    const acceleration = new BulkAcceleration(core);

    const startup = new FirstSetup(core, input);
    core.beforeStep = () => {
      startup.poll();
      input.poll();
    };
    core.afterStep = () => {
      const t = performance.now();
      if (!skipDisplayPoll) display.poll();
      pollMs += performance.now() - t;
      polls++;
    };
    const originalStep = core.step.bind(core);
    core.step = ((until?: bigint) => {
      const started = performance.now();
      originalStep(until);
      stepMs += performance.now() - started;
      steps++;
    }) as typeof core.step;
    const until = (condition: () => boolean, limit = 120000) => {
      const end = performance.now() + limit;
      while (!condition()) {
        core.step();
        if (performance.now() > end) throw Error('Benchmark deadline');
      }
    };
    const menu = () => core.sdk.menuState();
    try {
      until(() => menu()?.id === 8193 && input.idle);
      // Warm both navigation directions before measuring steady-state work.
      const warmup = Number(process.env.XHALF_NAV_WARMUP ?? 10);
      for (let i = 0; i < warmup; i++) {
        const key = i % 2 === 0 ? 'down' : 'up',
          expected = menu()!.index! + (key === 'down' ? 1 : -1);
        input.press(key);
        input.release(key);
        until(() => menu()?.index === expected && input.idle, 30000);
      }
      // Discard boot/warmup work; counters below are per-navigation deltas.
      const callsBefore = new Map(core.calls);
      const samples: object[] = [];
      const count = Number(process.env.XHALF_NAV_SAMPLES ?? 50);
      for (let i = 0; i < count; i++) {
        const key = i % 2 === 0 ? 'down' : 'up',
          before = menu()!,
          expected = before.index! + (key === 'down' ? 1 : -1);
        const wall0 = performance.now(),
          virtual0 = core.virtualNs,
          instructions0 = core.instructions,
          diagStarted = performance.now(),
          diag0 = core.diagnostics();
        diagnosticsMs += performance.now() - diagStarted;
        diagnosticsCalls++;
        const pollMs0 = pollMs,
          polls0 = polls,
          frames0 = frames,
          stepMs0 = stepMs,
          runSliceMs0 = runSliceMs,
          runSliceCalls0 = runSliceCalls,
          steps0 = steps,
          calls0 = input.sent;
        input.press(key);
        input.release(key);
        let indexMs = -1;
        until(() => {
          if (indexMs < 0 && menu()?.index === expected)
            indexMs = performance.now() - wall0;
          return menu()?.index === expected && input.idle;
        }, 30000);
        const wallMs = performance.now() - wall0,
          diag1Started = performance.now(),
          diag1 = core.diagnostics();
        diagnosticsMs += performance.now() - diag1Started;
        diagnosticsCalls++;
        samples.push({
          key,
          from: before.index,
          to: expected,
          wallMs,
          indexMs,
          virtualMs: Number(core.virtualNs - virtual0) / 1e6,
          instructions: core.instructions - instructions0,
          mmioReads: Number(diag1.mmioReads) - Number(diag0.mmioReads),
          mmioWrites: Number(diag1.mmioWrites) - Number(diag0.mmioWrites),
          hookHits: Number(diag1.hookHits) - Number(diag0.hookHits),
          pollMs: pollMs - pollMs0,
          polls: polls - polls0,
          frames: frames - frames0,
          stepMs: stepMs - stepMs0,
          runSliceMs: runSliceMs - runSliceMs0,
          runSliceCalls: runSliceCalls - runSliceCalls0,
          steps: steps - steps0,
          calls: input.sent - calls0,
        });
      }
      const walls = samples.map((s) => (s as { wallMs: number }).wallMs),
        instructions = samples.map(
          (s) => (s as { instructions: number }).instructions,
        ),
        sorted = [...walls].sort((a, b) => a - b),
        report = {
          measurement:
            'Unpaced Node wall/virtual/instruction cost per native menu navigation (press+release to index change and idle input)',
          warmup,
          runtimeBuild: JSON.parse(
            readFileSync('public/runtime/dynarmic-build.json', 'utf8'),
          ),
          stepBudget: core.executionSliceBudget,
          skipDisplayPoll,
          samples,
          medianMs: sorted[Math.floor(sorted.length / 2)],
          p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
          totalInstructions: instructions.reduce((a, b) => a + b, 0),
          totalWallMs: walls.reduce((a, b) => a + b, 0),
          totalStepMs: samples.reduce(
            (sum, sample) =>
              sum + Number((sample as { stepMs: number }).stepMs),
            0,
          ),
          totalRunSliceMs: samples.reduce(
            (sum, sample) =>
              sum + Number((sample as { runSliceMs: number }).runSliceMs),
            0,
          ),
          totalDiagnosticsMs: diagnosticsMs,
          diagnosticsCalls,
          totalPollMs: samples.reduce(
            (sum, sample) =>
              sum + Number((sample as { pollMs: number }).pollMs),
            0,
          ),
          totalSteps: samples.reduce(
            (sum, sample) => sum + Number((sample as { steps: number }).steps),
            0,
          ),
          totalCalls: samples.reduce(
            (sum, sample) => sum + Number((sample as { calls: number }).calls),
            0,
          ),
          wallMips:
            instructions.reduce((a, b) => a + b, 0) /
            walls.reduce((a, b) => a + b, 0) /
            1000,
          hookCalls: Object.fromEntries(
            [...core.calls].map(([name, count]) => [
              name,
              count - (callsBefore.get(name) ?? 0),
            ]),
          ),
          acceleration: {
            memoryCalls: acceleration.memoryCalls,
            memoryBytes: acceleration.memoryBytes,
            rasterCalls: acceleration.rasterCalls,
            pixelCalls: acceleration.pixelCalls,
            fallbacks: acceleration.fallbacks,
          },
          assertions: core.assertions,
          backend: 'dynarmic',
          executionStats: backend.executionStats,
        };
      mkdirSync('.private/reports', { recursive: true });
      writeFileSync(
        process.env.XHALF_NAV_REPORT ??
          '.private/reports/navigation-benchmark-dynarmic.json',
        JSON.stringify(report, null, 2),
      );
      console.log(
        `navigation: median ${report.medianMs!.toFixed(1)}ms p95 ${report.p95Ms!.toFixed(1)}ms, ${report.wallMips.toFixed(1)} wall MIPS`,
      );

      expect(core.assertions).toBe(0);
      expect(backend.executionStats.undefinedInstructions).toBe(0);
      if (!skipDisplayPoll) {
        expect(
          samples.every(
            (sample) => Number((sample as { frames: number }).frames) > 0,
          ),
        ).toBe(true);
        expect(display.inFlight).toBe(0);
      }
    } finally {
      core.destroy();
    }
  },
  600000,
);
