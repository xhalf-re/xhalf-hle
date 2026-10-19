# Reproducible ARM Wasm builds

Source identities are locked in `scripts/wasm-sources.json`:

| Component     | Pinned version                             |
| ------------- | ------------------------------------------ |
| Unicorn.js    | `1220477c7fb0f8fe4b500f4bd211de52f6dfe638` |
| Unicorn 2.1.4 | `8028ec436f2d9376525352dd38ed9ed6b9f6be10` |
| Emscripten    | `4.0.23`                                   |
| CMake         | `4.0.2`                                    |

Downloaded archives are checked against SHA-256 digests. The build does not follow moving branches or download firmware.

```sh
python3 -m pip install cmake==4.0.2
npm run wasm:build
# Rebuild the generated Unicorn tree from scratch:
python3 scripts/build-wasm.py --clean
```

Prerequisites are Python 3, CMake, a C compiler, Git, tar and curl. Compilation uses two jobs to limit peak memory. Download caches and upstream sources are generated under ignored `.cache/` and `vendor/` directories.

The upstream `build.py` supplies TCI/helper adaptations and generated constants. The project script retains those changes, applies the patches in `patches/`, and links an ARM-only static library as an ES module plus a separate Wasm binary, without pthreads or SharedArrayBuffer. The project's `heap-access.js` exposes refreshed views after memory growth. The MIT `src/cpu/slice.c` helper provides the `_xhle_slice_*` entry points through Unicorn's public block-hook API while preserving exact instruction-count execution. The opt-in `unicorn-arm-system-registers.patch` exposes `_xhle_arm_clock_configure` and `_xhle_arm_clock_advance` for architectural CP15 counter/timer and MPIDR behavior. It also exposes `_xhle_arm_set_irq` and `_xhle_arm_is_waiting`; QEMU samples the board line at TB entry and performs exception entry. The `_xhle_slice_clock_*` board-clock interface and `_xhle_slice_charged` advance virtual time, notify due deadlines/timer changes and report charged work. The runtime must use a matching Wasm build containing these exports; no PC-hook fallback is installed.

Compiler file-prefix mapping is applied to both the archive and final helper compilation. Embedded `__FILE__` strings, assertion locations and debug paths use repository-relative names instead of the build machine's checkout path. Emscripten's fixed virtual filesystem home is a synthetic runtime constant, not a host path.

Outputs are generated in ignored `public/runtime/`; Vite copies them beneath the Pages subpath. `build.json` records source identities, patch/helper digests and artifact hashes. JS and Wasm outputs must always be used as a matching pair. After changing C code or compiler flags, rebuild Wasm before running `npm run build` or browser tests.

`--debug` adds symbols, assertions and stack checks. `--asan` builds a separate AddressSanitizer archive. These are diagnostic modes; rebuild normally before performance verification or release.

## License and corresponding source

Each build copies the original Unicorn.js GPL license, Unicorn COPYING/LGPL/GLib notices, AUTHORS and CREDITS into `runtime/licenses/`. Distribute the combined runtime under its upstream GPL conditions.

For a binary release, provide the exact upstream source archives identified by the lock file, all project patches, the independently written helper sources, and the build scripts and lock files needed to reproduce the binaries. Retain upstream notices. Exclude generated caches, compiler installations, build directories, private firmware and local configuration from source bundles. Upstream links alone do not replace the corresponding-source requirement.

## Verification

Run `npm run arm:check`, `npm run check` and the browser CPU contract tests after a rebuild. Compare artifact hashes from two clean builds to check reproducibility. Use private real-firmware regressions separately; synthetic contracts alone do not establish firmware compatibility.

`XHALF_DAT=./.private/FPUPDATE.DAT npm run test:performance` rebuilds the web app before testing the production preview. It does not rebuild Wasm. Do not alter build artifacts during sampling.
