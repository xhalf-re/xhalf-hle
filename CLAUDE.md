# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A browser HLE/emulator for the X half camera: it runs the camera's real ARM firmware (ThreadX + native menus) from a user-supplied `FPUPDATE.DAT` inside a single Web Worker, using a standalone dynarmic.js Wasm JIT backend. Vite + TypeScript web shell, deployed to GitHub Pages under `/xhalf-hle/`. Only the firmware identity in `src/profiles/xhalf-main.json` is supported.

## Commands

Node ≥ 24. The Wasm runtime must be built before anything that touches the CPU (unit tests that load it, `build`, browser tests):

```sh
npm ci
python3 -m pip install cmake==4.0.2
npm run wasm:build            # scripts/build-wasm.py → public/runtime/ (ignored); --clean, --debug
npm run check                 # format:check + typecheck + unit tests + build + audit:public (what CI runs)
npm run dev                   # vite on 127.0.0.1:5173/xhalf-hle/
npm run arm:check             # verify committed ARM byte fixtures match .s sources (needs clang-15/llvm-15)
```

Tests:

```sh
npm test                                     # vitest, tests/unit/**
npx vitest run tests/unit/gic.test.ts        # single unit file
npx vitest run tests/unit/gic.test.ts -t "<name>"     # single test by name
npm run test:e2e                             # playwright, tests/browser/** (starts preview :4173 and dev :5173)
npx playwright test tests/browser/cpu.spec.ts
XHALF_DAT=./.private/FPUPDATE.DAT npm run test:private                       # real-firmware vitest suite
XHALF_DAT=./.private/FPUPDATE.DAT npm run test:private -- tests/private/storage.test.ts
```

Private (real firmware) tests and firmware-dependent browser specs skip themselves unless `XHALF_DAT` is set; see `docs/PRIVATE-TESTING.md` for `XHALF_BASELINE`, `XHALF_CATALOG`, `XHALF_BROWSER_EXECUTABLE`, `XHALF_BROWSER_NO_TRAP`. Some private cases legitimately take many minutes of wall time (power ~10 min/case, 1,800 s virtual stability up to 1 h).

After changing `src/cpu/dynarmic-host.cpp`, `src/cpu/dynarmic-system.h`, `patches/dynarmic/*.patch` or compiler flags, rebuild Wasm before `npm run build` / browser tests — JS and Wasm outputs must be a matching pair, and the runtime requires the `_dh_*` exports (no fallback).

After editing any ARM assembly (`tests/arm/contracts.s`, `src/sdk/*.s`), run `python3 scripts/assemble-tests.py` (without `--check`) to regenerate the committed `*.json` byte fixtures (`tests/arm/programs.json`, `src/sdk/*.json`). `call-thunk.s` must stay byte-identical to the `thunk` program in `contracts.s`.

Formatting is Prettier (`singleQuote`, `trailingComma: all`); `npm run format` to fix.

## Architecture

Read `docs/ARCHITECTURE.md` first; `docs/HOOKS.md` is the authoritative inventory of every hook/HLE boundary for the supported profile. Big picture:

- **Main thread** (`src/main.ts`, `src/web/`): file selection, session lifecycle, Canvas presentation, pointer/keyboard → worker messages. One Worker per load; session IDs fence off stale events. Page blur/hide pauses execution without catch-up.
- **Worker** (`src/worker/runtime-worker.ts`, `protocol.ts`): owns all CPU execution and synchronous HLE callbacks. Cooperative scheduling (`src/runtime/cooperative.ts`) with a 112 ms startup / 16 ms steady work budget, MessageChannel for zero-delay continuation.
- **CPU** (`src/cpu/`): `CpuBackend` isolates `dynarmic.ts`. `dynarmic-host.cpp` owns sparse physical memory, permissions, host transfers and bounded block execution. `dynarmic-system.h` implements banked registers, native IRQ/exception handling, CP15 generic timers, the 27 MHz counter and MPIDR. Virtual time advances by 2 ns per budget unit. `paged-memory.ts` lazily maps DRAM in `0x48000000–0x80000000`.
- **Runtime core** (`src/runtime/core.ts`): maps memory, installs named hooks, runs guest calls (via the AAPCS `call-thunk`), delivers IRQs through `gic.ts` (single-CPU GICv2-like model, see `docs/GIC.md`). `first-setup.ts` skips initial setup with native Tab/M messages (absent in manual-setup mode).
- **Devices** (`src/devices/`): MMIO models dispatched by `PeripheralBus` from `machine.json` — timers, panel/display controller (scan/blank IRQ188), GPIO + I2C touch (IRQ99), SAR ADC (IRQ132), serial, command queue, clock gates, sensor frontend, capture DMA, and the emulator-owned block device at `0x10f00000`. Time-based behavior uses `VirtualEvents` on guest time, never wall time.
- **SDK adapter** (`src/sdk/`): firmware-SDK-level glue — AAPCS argument decoding, graphics descriptor HLE (`graphics.ts`), framebuffer → Canvas (`display.ts`), input key/gesture mapping (`input.ts`), optional ARM accelerations (`acceleration.ts`), and independently written ARM bridges (`*.s`) for storage driver registration and sensor port registration.
- **Firmware/profiles** (`src/firmware/`, `src/profiles/`): SUNP/HDR2 package parsing and identity checks; three-layer config — `machine.json` (memory, MMIO, IRQs, board values), `sdk.json` (structure layouts/ABIs), `xhalf-main.json` (versioned addresses with `guard: {length, sha256}`). Schema in `docs/PROFILE-SCHEMA.md`, validated with zod.
- **Host services** (`src/services/`): `fat.ts` is an independent FAT parser used only for test verification; firmware runs its own FAT/VFS over virtual sectors (A read-only, B session-local overlay). `images.ts` handles image buffers.

### Design rules the codebase enforces

- **Prefer native execution over HLE.** The project's direction is lowering HLE to device/hardware models: no VFS/file API hooks, no touch dispatch hooks, no timer PC hooks, no injected display-completion callbacks, no manual exception entry, no host writes to ThreadX state. New behavior should be a device model or a guarded SDK-boundary binding, not a firmware-address patch.
- **No firmware-address branches or menu policy in generic code** (devices, services, input). Version-specific addresses belong in profiles; input mapping uses fixed screen-space gestures from `machine.json`, never menu state.
- **Required bindings fail closed**: unknown firmware, `status: candidate` profiles, or guard mismatches reject before execution. Optional acceleration groups fall back to ARM as a whole when any guard fails.
- **Test-only bindings** (file APIs, completion observers, menu classifiers) live in `tests/private/fixtures/*.json` and are merged into a test profile + preflighted; never add them to production profiles.
- ARM addresses are unsigned 32-bit (`>>> 0`); 64-bit timer values use BigInt. Refresh Wasm heap views after memory growth.

### Public/private boundary

`npm run audit:public` fails if tracked files or `dist/` contain DAT/ELF/img/png/snapshot/trace files or SUNP/ELF magic. Keep all firmware, extracted resources, screenshots, traces and test outputs in the ignored `.private/` (and caches in `.cache/`). Public profiles and fixtures may contain only lengths, SHA-256 digests and interoperability metadata — no original instruction bytes or locator patterns. Diagnostics must not export firmware bytes or memory dumps. Public ARM fixtures are assembled only from the project's own `.s` sources.
