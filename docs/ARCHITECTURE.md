# Architecture

The app runs real ARM firmware and ThreadX in a single Web Worker. The main thread selects files, displays Canvas frames and collects input. All CPU execution and synchronous HLE callbacks stay in the Worker. Vite and TypeScript provide the web shell; Unicorn.js supplies the ARM Wasm backend. SharedArrayBuffer, pthreads and a server emulator are not required.

## Runtime boundaries

| Layer            | Responsibility                                                                      |
| ---------------- | ----------------------------------------------------------------------------------- |
| Firmware loader  | Validate SUNP/HDR2 bounds, extract payload/resource views and calculate identities. |
| Machine profile  | Describe memory, MMIO, IRQs, clocks and display orientation.                        |
| Firmware profile | Bind versioned addresses, startup adaptations and instruction guards.               |
| SDK adapter      | Decode AAPCS arguments, structures, native input protocols and callback contexts.   |
| Runtime core     | Execute the CPU, map memory, deliver IRQs and manage virtual time and guest calls.  |
| Host services    | Provide sector-backed virtual disks and graphics operations.                        |
| Web shell        | Manage sessions, Canvas presentation and browser input.                             |

`CpuBackend` isolates the Unicorn wrapper from the runtime. ARM addresses are unsigned 32-bit values; 64-bit timer and Wasm values use explicit BigInt conversions. Wasm views are refreshed after memory growth. Package sections share their backing storage where possible.

Machine, SDK and firmware profiles are separate. Public bindings use byte lengths and SHA-256 guards instead of firmware instruction fragments or locator patterns. Unknown versions, candidate profiles and mismatched required bindings fail before execution. Optional acceleration groups fall back to ARM when their guards or runtime conditions fail.

## Memory and assertions

The machine maps 128 MiB of fixed DRAM and declares additional paged DRAM from `0x48000000` to `0x80000000`. `PagedMemory` maps data pages only within that range, preserving the firmware's heap and ThreadX allocation algorithms without allocating a full gigabyte. Unmapped instruction fetches fail. Unclaimed registers inside the mapped MMIO window currently retain backing-memory values; device-owned registers use their explicit models.

The CPU system-register model supplies the configured single-primary MPIDR identity. Original MPIDR instructions execute without startup patches. Native ASSERTs stop the session and produce diagnostics. The desktop reference's ASSERT/BKPT fallback is deliberately excluded.

## Input

GPIO inputs own the data-in registers at `0x1000903c`, `0x1000904c`, `0x10004040` and the shutter input at `0x1000a10e`. External GPIO edges use their original rising/falling SPI lines and native masks/W1C. The shutter stages drive active-low GPIO levels. The firmware has no direction-key ADC scan branch: browser Up/Down perform fixed touch gestures starting at the first/middle visible rows, Left/Right tap the native category controls, Enter taps the middle row, and Esc taps screen back. The native menu decides whether a row press focuses, opens or selects it. These mappings use screen coordinates from the machine profile and never inspect menu state. They do not emulate relative cursor keys; full lists remain accessible by dragging the screen.

Touch reports enter the I2C controller FIFO at `0x10004300`. Touch-chip address 0x55 supplies the contact status and packed coordinates; GPIO source 3 raises falling-edge IRQ99. The unchanged ISR wakes the real `Tup_Thread`, whose original ARM I2C driver reads each scan. Host event timestamps determine controller scan deadlines. No touch dispatch/read/wait hooks or injected touch ISR calls remain.

SAR conversions select the native channel, complete on guest time, latch status and raise IRQ132. The former `boot.key_adc` actually reads the battery on SAR6; thermal uses SAR0. Nominal values live in `machine.json`. Eye proximity is an I2C register read and focus-ring/power probes use serial readback; these share the configurable board channel values without replacing their ARM wrappers.

Primary and auxiliary serial completion latch GPIO sources 0/2/4/6, routed through IRQ186. The native interrupt consumers drain their software queues; completing only the controller busy bit leaves those queues full.

Cancellation sends one I2C NACK. The stock board wrapper does not propagate that failure as SDK status 2: a sampled cancellation currently looks like a release. Restoring the former reset behavior requires an explicit error-propagation adaptation; device NACK alone does not establish that behavior.

M, Tab, 1–7 and B/C remain fixed `sysg.send4` shortcuts. Physical direction release messages, two-second host ACTIVE coalescing and UI-consumption backpressure have been removed.

Shortcut messages run through an independently written ARM handler on SGI15. The original IRQ registration function installs that handler once at the idle boundary; subsequent delivery uses the GIC and the native exception path. The handler calls the original `sysg.send4`. The host never writes ThreadX `system_state`.

`FirstSetup` is a separate startup driver. It uses native Tab/M messages to skip initial setup and open the main menu. Manual setup does not create this driver.

## Display

`SdkGraphics` decodes graphics descriptors and implements rectangle filling and hardware composition. `NativeDisplay` reads the GFX active framebuffer, converts pixels and manages Canvas backpressure. Display-controller timing and completion are device responsibilities.

The panel/display controller advances its scan clock only while a channel is enabled through registers `+0x20/+0x21`. Scan/blank status latches independently of interrupt masks and raises level IRQ188 when unmasked; native acknowledge/W1C/EOI processing runs in ARM. Deadlines retain their phase across CPU slices, with repeated pending frame edges coalesced. The firmware's own display completion function executes in its native task; the host never queues or injects `display.frame_done`. Canvas acknowledgements do not control device timing.

Presentation compares the active buffer's address, dimensions, format and exact bytes, including alpha. A narrow write observer detects GFX active-buffer submissions; sampling runs after the CPU slice returns. Periodic scans also detect in-place updates without submissions. ABGR8888/RGB565 conversion and native rotation are preserved.

At most two transferable RGBA buffers are in flight. When capacity is exhausted, stale presentation requests are dropped; the latest guest pixels are read when a buffer returns. Firmware display completion events are still delivered. `frameCurrent` compares the last presented pixels against guest memory; `frameSettled` also requires all frames to be acknowledged. Headless execution retains the same device-driven scan clock and interrupts.

## Devices and image jobs

`PeripheralBus` dispatches MMIO using machine configuration. `VirtualEvents` provides bounded, replaceable and cancellable events on virtual time. Timers, command queue, panel, serial controllers, clock gates, sensor frontend, GPIO and capture DMA are independent devices. Level IRQs follow GIC acknowledge/EOI/W1C semantics. Device implementations contain no menu policy or firmware-address branches.

`StorageDevice` exposes A/B logical sectors at the emulator-owned MMIO window `0x10f00000`. An independently written ARM driver registers its block callbacks through native SDK APIs in the actual boot task and calls the original `vfs.mount`. FAT, paths, handles, allocation, caches and locks run in firmware. A is read-only; B writes use a session-local sector overlay. Native block callbacks are synchronous and require no invented completion IRQ. There is no production VFS HLE fallback or JavaScript filesystem parser. The mock models logical disks; physical NAND/ECC/FTL are outside its boundary. See [storage](STORAGE.md) for the ABI and validation.

The command queue implements a validated subset with separate HUM and DMA status groups. It checks commands, addresses, budgets and cancellation generations, executes at most 256 commands per turn, and yields at synchronization endpoints. Unknown commands fail. Native SDK timer queues, panel initialization, sensor power/training and preview tasks remain in ARM.

An independently written AAPCS bridge registers the virtual sensor port through the SDK configuration API. `BlankImageJobs` supplies minimal valid blank image command jobs at the physical processing boundary. Completion follows DMA IRQs and native queues; it does not modify UI or ready state. Real ISP processing and sensor imaging are not implemented. Capture enable and reset are independent; SOF precedes VD, and EOF advances the native buffer ring.

Coherent RAM needs no physical data-cache maintenance. Upper ARM layers still validate addresses and return DMA addresses. Instruction-cache and translation-cache maintenance remain active.

## CPU scheduling and lifecycle

The opt-in ARM backend patch implements the external IRQ line with QEMU's `CPU_INTERRUPT_HARD`. Cached and chained TBs sample the line at TB entry; checks inside MMIO hooks cannot interrupt an unfinished register access. QEMU performs exception entry, including CPSR.I/A/T and IT state, banked LR/SP/SPSR, VBAR and SCTLR.V/TE. The runtime has no firmware IRQ-window hook or manual exception entry.

The GIC is a single-CPU, 256-interrupt model with eight priority bits and no Security Extensions. Distributor and CPU enables, individual enable/pending/active aliases, edge/level configuration, CPU targeting, priorities, PMR and BPR participate in arbitration. Lower numeric priority wins; equal priorities use the lower interrupt ID. IAR acknowledges eligible interrupts, nested running group priorities captured at acknowledge restrict preemption, and ordered EOIR writes release them. Level sources reassert until the device clears them; edge and software pending latches survive masking. Reserved and unimplemented registers read as zero and ignore writes. The [GIC register contract](GIC.md) lists the implemented offsets and access semantics.

`src/cpu/slice.c` uses Unicorn's `UC_HOOK_BLOCK` API to bound execution and advance the board clock in C/Wasm. ARM charges four-byte instructions; Thumb charges by the minimum two-byte width. Completed TBs advance time at the machine's configured two nanoseconds per budget unit. The final TB can cross the budget, and hooks can return early, so these are scheduling estimates rather than exact retired-instruction or cycle counts. `run` retains Unicorn's exact instruction-count interface.

The 27 MHz architectural counter advances at TB boundaries through a native observer that runs before IRQ selection. The five generic timer outputs and scheduled peripheral deadlines update the GIC during execution; JavaScript callbacks occur only when a deadline is due or timer levels change. MMIO also synchronizes device time. Timer programming, the counter and the external IRQ line survive CPU-context restoration. Original CP15 and MPIDR instructions run at any ARM/Thumb PC without firmware-address substitutions.

A host step has a 100,000-unit budget, about 200 microseconds of active guest execution. It does not quantize IRQ delivery. WFI waits for external work; while halted, the board clock advances to the earliest device/generic-timer deadline, bounded by 200 microseconds per host step. Explicit callback returns consume only their charged execution time. Per-instance native hooks and clock callbacks are removed before CPU destruction.

Worker startup uses a 112 ms work budget. After establishing the real-time baseline, it uses 16 ms to serve input and frame acknowledgements promptly. Zero-delay continuation uses MessageChannel task boundaries; positive delays use timers for wall-clock pacing. Stopping closes ports, clears timers and invalidates queued generations.

Each load owns a Worker and session identity. Old-session events cannot affect a replacement session. Hiding or blurring the page releases keys, cancels the pointer and pauses execution. Resume establishes a new wall-clock baseline without catching up time spent in the background. Stopping terminates the Worker and releases firmware buffers and session copies.

Diagnostics contain profile identities, stages, timings, counters and errors. They do not export firmware bytes, memory dumps, resource contents or local file paths.
