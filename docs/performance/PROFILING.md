# Reproducible Worker profiling

## Run

Node 24+, built Wasm, npm dependencies, Playwright Chromium and the supported local DAT are required. The command builds the production web app itself; do not run another build or emulator benchmark alongside it.

```sh
XHALF_DAT=./.private/FPUPDATE.DAT npm run profile:firmware -- --label baseline
# Quick pipeline check, not a representative baseline:
XHALF_DAT=./.private/FPUPDATE.DAT npm run profile:firmware -- \
  --pairs 1 --samples 10 --warmup 2 --idle-ms 1000 --label smoke
# Recompute symbolized profiles and paired overhead offline, without a browser/DAT:
npm run profile:firmware -- --summarize .private/performance/<run-directory>
npm run test:profile
```

Default: three pairs, 100 measured navigations, ten warmup navigations, five seconds of menu idle and a requested 1,000 μs sampling interval. Pair order alternates plain/sampled, sampled/plain, plain/sampled. Each trial uses a new browser process and context. `XHALF_BROWSER_EXECUTABLE` selects a Chromium executable; `XHALF_BROWSER_NO_TRAP` is recorded if used. Firefox does not expose this CDP profiler; its formal browser acceptance remains a separate check.

The profiler creates its own preview server on an ephemeral loopback port, without touching existing 5173/5174/4173 services. A lock under `.private/performance/.active` prevents simultaneous invocations of this command. It cannot prevent unrelated tests or workloads: record those conditions and do not kill other people's processes. If a process is killed, inspect `owner.json` and verify that PID is no longer active before removing the stale lock.

## Identity and workload

Before sampling, the command records git HEAD, branch, dirty state and hashes of tracked/unignored source, scripts, tests, patches and build configuration. It checks the Wasm manifest against the source lock, native host/system/code-cache sources, patch set and all emitted runtime artifact hashes. Each trial verifies the runtime responses served by its own preview. The source and full `dist/` digest must remain unchanged through the run. A mismatch fails the experiment and preserves its partial evidence.

The production build emits hidden source maps. The command moves them into the private experiment directory before serving the site; they are not linked from JavaScript or left in `dist/`. The served minified assets retain production behavior. Each profile uses the captured, hash-verified main-Wasm symbols and captured JS source maps, never whatever happens to be present in a later build.

A sampled trial attaches to its dedicated Worker through CDP while that Worker is paused before its first instruction. The boot profile starts before resuming the Worker. It includes firmware validation, native runtime startup and native first-setup completion; boot wall time starts at file selection and ends at main-menu readiness. Main-thread file reading and rendering are not Worker samples.

Warmup alternates Down/Up and returns to the initial selection. Measured navigation uses the same helper as `tests/browser/m6-performance.spec.ts`: a DOM event must lead to the expected native index, an idle input queue, current Canvas pixels and a subsequent animation frame. There are no arbitrary pauses between navigation samples. Menu-idle sampling observes the firmware's continuing background work; it does not mean the guest CPU is asleep. Diagnostics before/after each phase and counter deltas are retained; diagnostics can lag the current CPU by their regular reporting interval.

Every phase checks zero assertion/input/storage/undefined-instruction errors, the expected main menu with active native UI/host threads, and a visible page. Boot additionally requires `menuReady`; the navigation helper verifies current pixels and idle input at each endpoint. Periodic background redraws can transiently clear `menuReady` between endpoints and are not themselves failures. Browser/Worker attachment, CDP timeouts and failed navigation terminate the experiment, retain evidence and release owned resources. Profiled latency is diagnostic: only the independent formal performance command establishes the existing ≤120 s cold-boot and ≤300 ms P95 gates.

## Evidence

Each run has a unique directory under `.private/performance/`, containing:

- `manifest.json`: status, source/artifact/browser/firmware identities, options, host load/memory observations, per-trial phases, latency arrays, diagnostics and failures.
- `runtime.symbols` and `maps/`: exact symbolization inputs and their recorded hashes.
- `pair-N-sampled-{boot,navigation,idle}.cpuprofile`: raw Worker CPU samples, retained privately.
- Matching `*-profile.json`: weighted self/inclusive rows, grouped costs, source locations, sampling gaps and caveats.
- `summary.json`: individual latency results and per-pair sampled/plain overhead ratios with min/median/max/spread.

No firmware bytes, memory dumps, screenshots or guest disassembly are collected. Do not publish raw profiles or private diagnostics; share reviewed aggregate findings and validation limits in [BENCHMARK.md](../BENCHMARK.md). Failed runs stay available and must not be silently replaced by passing repeats. The offline command accepts incomplete manifests with available captured profiles; it does not transform failure status into success.

## Interpretation

Chromium occasionally emits a few negative microsecond deltas from timestamp-order jitter. Negative deltas up to the smaller of 10 μs or 1% of the requested interval are clamped to zero weight; their count, total correction and raw signed duration are explicitly recorded. Larger negative deltas fail analysis. No sample is silently removed.

Self time is weighted by `timeDeltas`, not by assuming every sample has the requested period. Inclusive time walks ancestors and deduplicates recursive frames; inclusive rows overlap and must never be added as a partition. Idle and unattributed samples remain separate. The final unsampled interval, sampling duration discrepancy and intervals >5× the requested period are reported. Long intervals can include scheduling delays, so these numbers estimate sampled execution attribution, not OS CPU consumption.

Main-runtime Wasm indices resolve only when the frame URL matches the captured runtime URL. Generated `wasm://` modules remain explicitly grouped as guest blocks or engine wrappers, not mislabeled with the main module's symbol map. Unknown Wasm indices remain unresolved. JavaScript uses the exact generated-asset source maps; raw minified names and original source locations are both retained. Native functions can contain substantial inlined work: `dh_run` self time alone does not identify the cost of hooks, timers or hash lookup.

Compare phases and repeats before choosing an optimization. High profiler overhead, wide repeat spread, substantial unknown attribution or long-gap weight is a reason to investigate the measurement. Do not optimize a small historical hotspot merely because it has a convenient name.

## Unprofiled candidate comparison

Profiler/plain pairs measure sampling overhead. To measure an implementation change, save production snapshots **before and after** the change and compare those fixed snapshots without a profiler:

```sh
npm run performance:compare -- --snapshot baseline-l1a
# Implement, rebuild Wasm if native code changed, and run mechanism tests.
npm run performance:compare -- --snapshot candidate-l1a
XHALF_DAT=./.private/FPUPDATE.DAT npm run performance:compare -- \
  --baseline .private/performance/snapshots/<baseline> \
  --candidate .private/performance/snapshots/<candidate>
```

Each snapshot builds the web app, verifies the matched runtime and copies `dist/` with a source/artifact manifest into ignored private storage. Comparison owns two ephemeral previews and alternates baseline/candidate order for three pairs by default, with the same 10-move warmup and 100 visible-frame moves. Both snapshots must agree with the selected firmware identity. Served runtime hashes are checked, every trial uses a fresh browser, and all snapshot files plus the comparison code/source digest are checked again at completion. Do not edit code or run other emulator jobs during comparison.

The comparison report contains all six latency distributions, before/after diagnostics, machine observations and candidate/baseline ratios for boot, median, P95 and instruction-budget work. A ratio below one is an observed improvement, not an automatic significance claim. Preserve the snapshots for repeat experiments; never use a later rebuilt `dist/` as though it were the tested baseline. Source and runtime snapshots remain private and are not published with the app.

## Optional native hook census

`XHALF_PROFILE_HOOKS=1 npm run dynarmic:build` builds local host lookup counters for each hook kind. The define applies only to `dynarmic-host.cpp`; it does not change dynarmic.js. Check/hit counts include execution and translation-time interest queries; after warmup the report's JIT compilation delta bounds the latter. Counts are per CPU instance, survive CPU-context restoration, contain no guest addresses and are read with a refreshed heap view. A hit means a positive interest query, not a distinct callback. These counts cannot determine lookup time.

The default build compiles out counter storage and increments. Rebuild without the environment variable before production acceptance; `test:performance` and the standard profiling preflight reject counter builds. Snapshotting/comparing them requires explicit `--allow-instrumentation`. Use a normal/counter snapshot pair to observe instrumentation overhead separately and inspect counter deltas in each trial's `before`/`after` diagnostics. Instrumented latency is not candidate performance evidence.
