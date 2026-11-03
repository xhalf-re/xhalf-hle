# Dynarmic source changes

The public [dynarmic.js repository](https://github.com/xndcn/dynarmic.js) and exact release revision are recorded in `scripts/dynarmic-source.json`. Project patches apply only to the isolated `.cache/dynarmic-source-<revision>` checkout.

`dynarmic/board-boundaries.patch` connects upstream compilation and release to the host's packed-module cache and handles executable-memory allocation failures. Board boundary dispatch, cycle accounting, guarded chaining and page-contained fast memory accesses are provided by upstream. The former local alignment patch is unnecessary with the published page-containment check: accesses spanning separately allocated or protected pages still use checked callbacks.

The published backend is MIT licensed. The build copies its actual `LICENSE` and `THIRD_PARTY_NOTICES.md`, plus the original bundled dependency licenses, into `runtime/licenses/`. Privileged CPU state and page ownership are implemented in `src/cpu/dynarmic-host.cpp` and `src/cpu/dynarmic-system.h`.

Compiled-block retention is bounded to 65,536 blocks. On a browser executable-memory allocation failure the patch shrinks the cache to 12,288 entries, drops cold blocks at a dispatch boundary and returns before executing the requested instruction. The Worker yields 50 ms so browser collection can reclaim released modules, then resumes at the same PC. Only allocation errors are retried; a continuous five-second failure produces an actionable error.

`scripts/jit-code-cache.js` consolidates batches of 32 compatible blocks into one Wasm module. Only modules with identical type/import layouts and the board emitter's single-function structure are eligible; instructions are copied unchanged. Existing function-table indices are retained. Shared module ownership counts prevent releasing a packed module while another cached block still uses it. This reduces browser executable-allocation overhead without changing guest control flow.

See [benchmark methodology and acceptance](../docs/BENCHMARK.md) for validation and [profiling](../docs/performance/PROFILING.md) for reproducible performance analysis. The current source lock is authoritative.
