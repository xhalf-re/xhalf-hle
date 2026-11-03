# Reproducible Wasm build

The standalone ARM runtime uses [dynarmic.js](https://github.com/xndcn/dynarmic.js) at public release commit `157791a52fd1ffe5f9d44dc95b3990736825044e`, pinned in `scripts/dynarmic-source.json`. The Emscripten 4.0.23 toolchain archive identity is recorded in `scripts/wasm-sources.json`. Node 24+, CMake 4.0.2 and Boost headers are required.

```sh
npm ci
python3 -m pip install cmake==4.0.2
sudo apt-get install libboost-dev
npm run wasm:build
# Remove the generated CMake build tree before rebuilding:
npm run wasm:build -- --clean
# Include runtime assertions and symbols:
npm run wasm:build -- --debug
```

`build-wasm.py` installs the pinned toolchain on a fresh checkout and invokes `build-dynarmic.py`. `XHALF_EMSDK` or `EMSDK` selects an already installed toolchain. `npm run dynarmic:build` invokes the latter script directly. `XHALF_BOOST_HEADERS` selects an existing Boost header directory; otherwise the build copies system headers into `.cache/boost-headers` for Emscripten. ASan is not supported for dynamically generated guest Wasm blocks.

The build clones the repository URL in `scripts/dynarmic-source.json`, checks out its exact revision under `.cache/dynarmic-source-<revision>` and initializes recursive submodules. No local source checkout is required. For development, `XHALF_DYNARMIC_SOURCE` explicitly selects a local repository containing the pinned commit; the build creates a detached worktree, so that repository's uncommitted changes are not build inputs. Project patches in `patches/dynarmic/` retain browser code-allocation recovery and module packing. Board dispatch and page-contained memory accesses are supplied by the published upstream.

The runtime links only Dynarmic and its bundled support libraries. `dynarmic-host.cpp` owns physical pages, mapping permissions, host transfers, hooks and execution. `dynarmic-system.h` supplies banked registers, CP15 timers and exception state. No external interpreter, reference engine or generated wrapper is linked. `heap-access.js` exposes a fresh Wasm heap view after memory growth.

Every successful build replaces the generated `public/runtime/` contents, preventing retired runtime binaries from being copied into the website. The browser loads `dynarmic-arm.js` and `dynarmic-arm.wasm`. `dynarmic-arm.js.symbols` resolves emulator Wasm function indices in CPU profiles. `dynarmic-build.json` records the backend, dependencies, source revision, host/system/code-cache/patch hashes and artifact hashes.

## Verification

After changing the CPU sources, patches or compiler flags, rebuild Wasm before building the web app. Run `npm run arm:check`, `npm run check`, the synthetic Dynarmic suite and browser CPU contracts. `audit:public` also checks that generated runtime metadata and symbols contain no retired engine dependencies.

```sh
npm run test:private -- tests/private/dynarmic-contracts.test.ts
npx playwright test tests/browser/cpu.spec.ts
XHALF_DAT=./.private/FPUPDATE.DAT npm run test:performance
```

The performance command builds the web app but does not rebuild Wasm. Do not change build artifacts during sampling. All private CPU tests now use the production Dynarmic runtime. Firmware compatibility requires the private regressions in [PRIVATE-TESTING.md](PRIVATE-TESTING.md); synthetic contracts alone do not establish it.

## Distribution

The published dynarmic.js Wasm backend is MIT licensed. The build copies its license and third-party notices directly from the pinned source, together with the original Dynarmic (0BSD), mcl, fmt and robin-map licenses, into `runtime/licenses/`. The source URL, revision, local patches and build scripts identify the runtime's inputs. Original project code remains MIT. Firmware and extracted resources are never build inputs or public artifacts.
