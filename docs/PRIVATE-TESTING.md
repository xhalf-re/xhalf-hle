# Private testing

Keep all original and derived firmware test data in the ignored `.private/` directory. Do not put DAT files, ELF files, resource images, native GUI screenshots, video, traces, caches or memory dumps in source directories, public assets or CI artifacts. Configure external inputs through environment variables rather than committed absolute paths.

## Inputs

| Variable                   | Purpose                                                                   |
| -------------------------- | ------------------------------------------------------------------------- |
| `XHALF_DAT`                | Complete, user-supplied `FPUPDATE.DAT`.                                   |
| `XHALF_BASELINE`           | Optional desktop reference root for package and stable-frame comparisons. |
| `XHALF_CATALOG`            | Enable private native menu catalog traversal.                             |
| `XHALF_BROWSER_EXECUTABLE` | Optional installed Chrome/Edge executable.                                |
| `XHALF_BROWSER_NO_TRAP`    | Set to `1` when the local browser needs `--no-wasm-trap-handler`.         |

The desktop reference uses `output.elf`, `fpupdate/resource-a.img`, `fpupdate/resource-b.img` and `artifacts/hle/verification.json` with its corresponding reference frame. Source identities are recorded in [baseline.json](baseline.json). Treat these files as read-only inputs. Both runtimes must cold boot independently; desktop CPU snapshots are not browser startup inputs.

Run commands from the repository root after building the Wasm runtime:

```sh
npm run check
npm run arm:check
XHALF_DAT=./.private/FPUPDATE.DAT npm run test:private
npm run build
XHALF_DAT=./.private/FPUPDATE.DAT npm run test:e2e
XHALF_DAT=./.private/FPUPDATE.DAT npm run test:performance
```

Export `XHALF_BASELINE` when running reference-dependent tests. Tests that need missing inputs explicitly skip themselves. Private Vitest and Playwright outputs remain under `.private/`; synthetic CPU benchmark outputs use the ignored `.cache/` directory.

## Coverage

Public CI verifies synthetic package/FAT/profile cases, device semantics, graphics, coordinates, input queues, ARM ABI/hooks/cache contracts and browser error recovery. Real firmware verification covers package extraction, cold boot, stable pixels, native input context, menu traversal, pointer handling, power policy and lifecycle behavior.

For a release, exercise direct clicks and drags, supported keyboard controls and mixed input in desktop Chrome and Edge. Include pointer cancellation, scaling, high DPI, delayed Canvas acknowledgements, manual setup and ten load/stop cycles. Use the private stability test for 1,800 seconds of virtual mixed interaction; record its execution mode separately from a browser session's wall-clock duration.

Native ASSERTs, unhandled exceptions, persistent input queues and unrecoverable waits fail verification. Compare stable frames at the same native state, virtual time and keyboard focus. Screenshots and traces remain private; public results may include scenario identifiers, versions, hashes and timing statistics only.

Public CI explicitly reports that real firmware tests were not run. A successful public workflow cannot substitute for private firmware verification.

## Storage migration

`tests/private/storage.test.ts` stops the real boot task at the virtual disk initializer return and invokes the original ARM VFS APIs in that task context. It compares every regular A/B resource with the independent FAT parser, checks missing files/EOF/size64, performs B create/write/close/reopen/seek/stat, checks image hashes and resets the sector overlay. The test does not inject an ISR or fabricate a ThreadX task. Evidence is written to `.private/storage/acceptance.json`.

```sh
XHALF_DAT=./.private/FPUPDATE.DAT npm run test:private -- tests/private/storage.test.ts
```

## Architectural timer and display completion

After rebuilding Wasm, the hardware acceptance test verifies unchanged MPIDR instructions, removal of timer PC hooks, real timer assertions, native panel IRQ acknowledge/W1C handling and display completion in the original task context. No host display callbacks are installed. The guarded completion observation binding lives in `tests/private/fixtures/hardware-bindings.json`, is merged into the test profile and passes preflight before use; production profiles do not carry it. Its report is written to `.private/lowering/hardware-acceptance.json`.

```sh
XHALF_DAT=./.private/FPUPDATE.DAT npm run test:private -- tests/private/hardware-completion.test.ts
```

The browser CPU harness also executes relocated ARM and Thumb system-register instructions, full 64-bit counter comparisons, signed TVAL, masks, virtual timers and CPU-context restoration. Display diagnostics count device ticks and scan acknowledgements; they no longer count injected SDK callbacks.

The 1,800-second virtual stability case allows one hour of wall time for the current full peripheral model in the Node Wasm backend. This is an execution timeout for functional coverage, separate from the browser cold-boot and navigation performance limits. Progress is written every ten virtual seconds to `.private/reports/M6-stability-progress.json`; the final success report is written only after all assertions pass.

## Native IRQ and GIC acceptance

After rebuilding Wasm, `tests/private/irq.test.ts` cold boots the firmware with its original IRQ vector, verifies native IRQ entry and removal of `runtime.irq_window`, masks only the panel IRQ in GICD_ICENABLER, and checks that device scans and the system tick continue while panel acknowledgements stop. GICD_ISENABLER then delivers the pending level and native navigation resumes. The device's own mask stays enabled throughout. Evidence is retained in `.private/irq-gic/native-acceptance.json`.

The synthetic CPU contracts independently cover ARM/Thumb IRQ entry and return, relocated VBAR, high vectors, SCTLR.TE, CPSR.I and guest CPSIE, native IAR/EOIR, deadlines within a long host slice, WFI wakeup and device state across CPU-context restoration. Unit tests cover GIC reset, priorities, PMR/BPR, nesting, edge/level and software pending/active semantics. Real firmware regressions remain separate.

The native power cases allow ten minutes of Node/Wasm wall time per case to execute their original 120/140-second virtual scenarios with native ISR delivery. This is a functional-test execution limit. Browser performance uses the 120-second cold-boot and 300-ms navigation P95 gates in [benchmark methodology](BENCHMARK.md).
