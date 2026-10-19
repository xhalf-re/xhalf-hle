# Benchmark methodology

The reference machine is an Intel Core i7-12700 with 20 logical CPUs, 32 GiB RAM and Ubuntu 22.04 x86_64. Measurements below used the `powersave` governor. Record governor, host load, memory pressure, browser version and power conditions for each run; results from different conditions are not interchangeable.

Start timing after the site's runtime resources have loaded. Cold-boot latency runs from submitting a complete DAT to the interactive shooting menu. Use three independent browser sessions, each cold booting from the DAT without a prebuilt CPU snapshot. The target is at most 120 seconds per boot.

Collect at least 100 ordinary navigation samples. Latency runs from a DOM input event to the correct native menu state, empty input queues, current Canvas pixels and the next animation frame. The target is P95 at most 300 ms. Native long presses, gestures and confirmation waits are measured separately. Avoid concurrent emulator jobs during sampling.

```sh
XHALF_DAT=./.private/FPUPDATE.DAT npm run test:performance
```

This command rebuilds the web app and tests the production preview. It does not rebuild Wasm; run `npm run wasm:build` first after changing C sources or build flags. Do not modify runtime artifacts during a measurement.

## Recorded measurements

Measured on 2026-10-18 with the native block-budget backend and MessageChannel scheduling:

| Browser                         | Three independent cold boots | Navigation samples | P95      |
| ------------------------------- | ---------------------------- | ------------------ | -------- |
| Chrome for Testing 156.0.8078.4 | 17.008 / 16.947 / 17.957 s   | 100                | 226.5 ms |
| Microsoft Edge 142.0.3595.94    | 18.009 / 17.983 / 17.986 s   | 100                | 237.0 ms |

Chrome's median was 147.25 ms and maximum 255 ms. Edge's median was 156.9 ms and maximum 347.9 ms. These are version-specific local measurements, not results for every browser or a later deployment. Firefox and Safari have not been verified.

Rerun on 2026-10-19 after the storage migration and removal of obsolete storage Hook metadata, using a fresh production build and sequential browser runs:

| Browser                         | Three independent cold boots | Navigation samples | P95      | Result |
| ------------------------------- | ---------------------------- | ------------------ | -------- | ------ |
| Chrome for Testing 156.0.8078.4 | 20.033 / 18.998 / 19.001 s   | 100                | 231.8 ms | Pass   |
| Microsoft Edge 142.0.3595.94    | 20.026 / 18.979 / 18.979 s   | 100                | 244.7 ms | Pass   |

Both browsers met the unchanged 120-second cold-boot and 300-ms navigation P95 limits. ASSERTs, input errors, storage errors and frame drops were zero. Wasm memory remained 425,000,960 bytes (about 405 MiB), matching the previous measurements. Navigation medians/maxima were 154.05/337.7 ms in Chrome and 162.15/390.9 ms in Edge; the latency limit applies to P95.

Compared with the immediately preceding storage acceptance (17.966 / 17.964 / 16.951 s; P95 223.9 ms), Chrome's cold-boot median increased 5.8% and navigation P95 increased 3.5%. Edge's older recorded baseline had P95 237.0 ms and used a different Wasm artifact. These timing differences do not establish a regression caused by Hook cleanup: host background workloads were active, with a starting load average of 2.77, about 20 GiB available RAM and the `powersave` governor. Edge used `XHALF_BROWSER_NO_TRAP=1`. The exact reports, baseline copies, environment details and tested artifact hashes are retained in `.private/storage/performance-regression/`.

Lifecycle and stability checks separately cover ten load/stop cycles, responsiveness while paused or faulted, background pause/resume, native automatic shutdown, and 1,800 seconds of virtual mixed interaction. Record virtual duration separately from wall-clock duration. The architectural timer/display implementation validated in that migration passed a full 1,800-second virtual run on 2026-10-19; see the migration results below. Raw timing samples and firmware-derived evidence stay in ignored private storage.

## Architectural timer and display completion migration

Measured on 2026-10-19 after removing the 17 timer PC hooks, eight MPIDR instruction patches, compare-read input dispatch and host display completion injection. Both browsers used the same rebuilt Wasm and production app, three independent cold boots and 100 navigation samples. Other emulator execution was paused during performance sampling.

| Browser                         | Three independent cold boots | Navigation samples | P95      | Result |
| ------------------------------- | ---------------------------- | ------------------ | -------- | ------ |
| Chrome for Testing 156.0.8078.4 | 18.000 / 17.969 / 16.960 s   | 100                | 223.9 ms | Pass   |
| Microsoft Edge 142.0.3595.94    | 19.008 / 18.967 / 17.985 s   | 100                | 236.8 ms | Pass   |

The unchanged limits remain 120 seconds for cold boot and 300 ms for navigation P95. Both runs recorded zero ASSERTs, input errors and storage errors. Wasm memory remained 425,000,960 bytes. Display completion metrics now count device scan acknowledgements rather than injected SDK calls; counts must not be compared as the same callback metric across this migration. Exact samples and tested runtime identities are retained in `.private/lowering/performance-chromium.json` and `.private/lowering/performance-edge.json`.

The revised implementation also passed an uninterrupted, unpaced Node/Wasm stability run covering 1,800 virtual seconds in 2,271.417 wall seconds (about 37.9 minutes). All 53,986 scan ticks were acknowledged, ASSERT/input/storage errors were zero, input queues drained, and steady Wasm memory growth was zero at 425,000,960 bytes. The test's execution timeout is one hour; the browser performance limits above are separate. Chromium and Edge each passed all 13 functional browser tests, including the menu matrix, delayed frame acknowledgements, pointer scaling, manual setup and lifecycle checks. Native frame pixels matched the desktop reference at the same virtual time, and native hardware completion, menu catalog, storage and power regressions passed. Consolidated private evidence is in `.private/lowering/acceptance.json`.

## Native IRQ and GIC migration

Measured on 2026-10-19 with native QEMU IRQ entry, the distributor/CPU-interface GIC model and TB-based board time. Chrome and Edge ran sequentially with the same rebuilt runtime; no other emulator test from this session ran during sampling. Each browser used three independent DAT cold boots and 100 navigation samples. CPU affinity and the `powersave` governor were unchanged. The final repeat retained CPU placement, frequency and host-load observations; its load average ranged from 1.97 to 2.68 and an external emulator process was also observed.

| Browser                         | Three independent cold boots | Navigation samples | P95      | Result |
| ------------------------------- | ---------------------------- | ------------------ | -------- | ------ |
| Chrome for Testing 156.0.8078.4 | 22.020 / 21.976 / 21.990 s   | 100                | 277.3 ms | Pass   |
| Microsoft Edge 142.0.3595.94    | 23.024 / 22.986 / 22.993 s   | 100                | 296.6 ms | Pass   |

Both browsers met the 120-second cold-boot and 300-ms navigation P95 gates with zero ASSERTs, input errors, storage errors and frame drops. Wasm memory remained 425,000,960 bytes. Relative to the preceding timer/display migration, Chrome's median cold boot increased from 17.969 to 21.990 seconds and P95 from 223.9 to 277.3 ms; Edge's median increased from 18.967 to 22.993 seconds and P95 from 236.8 to 296.6 ms. These measurements include native interrupt execution and TB time accounting. Exact samples and tested runtime hashes are retained in `.private/irq-gic/performance-chromium.json` and `.private/irq-gic/performance-edge.json`.

An earlier repeat of the final code recorded P95 515.3 ms: latencies approximately doubled after the first 54 samples while another emulator was using a CPU core. A subsequent diagnostic of the unchanged artifacts recorded 277.9 ms, and the full monitored repeat produced the passing values above. The cause of the transient slowdown was not isolated. The failed samples and later host telemetry remain in `.private/irq-gic/final-performance-failure/` and `.private/irq-gic/performance-host.json`; results should be assessed with those conditions.

The synthetic deadline contract enters a 1,000-ns device IRQ at 1,000 ns within a 100,000-unit host slice. This verifies TB scheduling of the estimated virtual clock; it is not a cycle-accurate hardware latency measurement. The stable frame comparison uses the nearest TB boundary to the reference deadline and still compares every pixel; the recorded error was 1 ns with equal pixel hashes.

Native IRQ/GIC verification passed 69 public unit tests, 34 CPU contracts, seven native firmware regressions, three native power cases, and 13 functional tests in each browser. The native mask test observes actual IRQ entry, suppresses only panel IRQ188 in the distributor while scans and the system tick continue, and restores delivery by re-enabling it. Power cases retained the original 120/140-second virtual scenarios. Consolidated evidence is in `.private/irq-gic/acceptance.json`.

The 1,800-virtual-second stability result above belongs to the earlier timer/display migration. Charged block-budget units replace the old full-slice instruction estimate, so instruction counters across this migration are not directly comparable. See [native IRQ/GIC acceptance](PRIVATE-TESTING.md#native-irq-and-gic-acceptance) for the current coverage.
