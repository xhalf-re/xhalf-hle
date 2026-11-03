# Architecture

The app runs real ARM firmware and ThreadX in a single Web Worker. The main thread selects files, displays Canvas frames and collects input. All CPU execution and synchronous HLE callbacks stay in the Worker. Vite and TypeScript provide the web shell; the pinned dynarmic.js source supplies the ARM Wasm JIT. The standalone runtime owns memory mapping, system instructions and exception entry/return. SharedArrayBuffer, pthreads and a server emulator are not required.

## Runtime boundaries

| Layer            | Responsibility                                                                      |
| ---------------- | ----------------------------------------------------------------------------------- |
| Firmware loader  | Validate SUNP/HDR2 bounds, extract payload/resource views and calculate identities. |
| Machine profile  | Describe memory, MMIO, IRQs, clocks and display orientation.                        |
| Firmware profile | Bind versioned addresses, startup adaptations and instruction guards.               |
| SDK adapter      | Decode AAPCS arguments, structures, native input protocols and callback contexts.   |
| Runtime core     | Execute the CPU, map memory, deliver IRQs and manage virtual time.                  |
| Host services    | Provide sector-backed virtual disks and graphics operations.                        |
| Web shell        | Manage sessions, Canvas presentation and browser input.                             |

`CpuBackend` isolates the ARM execution backend from the runtime. The browser worker uses the pinned dynarmic.js adapter. Ordinary instructions run as Dynarmic-compiled Wasm blocks over shared RAM; privileged operations run in the native C++/Wasm CPU implementation. CP15, banked registers, WFI, SVC, undefined-instruction traps, IRQ entry/return, SRS/RFE and LDM exception returns are handled by the Dynarmic CPU implementation. Its page table owns physical RAM, mapping permissions and host transfers. There is no firmware-address dispatch or injected exception trampoline. `jitInstructions` and `systemInstructions` report JIT blocks and native system-boundary work. ARM addresses are unsigned 32-bit values; 64-bit timer and Wasm values use explicit BigInt conversions. Wasm views are refreshed after memory growth. Package sections share their backing storage where possible.

Machine, SDK and firmware profiles are separate. Public bindings use byte lengths and SHA-256 guards instead of firmware instruction fragments or locator patterns. Unknown versions, candidate profiles and mismatched required bindings fail before execution. Optional acceleration groups fall back to ARM when their guards or runtime conditions fail.

## Memory and assertions

The machine maps 128 MiB of fixed DRAM and declares additional paged DRAM from `0x48000000` to `0x80000000`. `PagedMemory` maps data pages only within that range, preserving the firmware's heap and ThreadX allocation algorithms without allocating a full gigabyte. Unmapped instruction fetches fail. Host reads/writes validate the entire range, bypass guest permissions and never trigger guest hooks. Partial unmapping releases an allocation when its last page is removed; remapping allocates zero-filled pages. Unmapping and protection changes invalidate affected translated code. Unclaimed registers inside the mapped MMIO window currently retain backing-memory values; device-owned registers use their explicit models.

The CPU system-register model supplies the configured single-primary MPIDR identity. Original MPIDR instructions execute without startup patches. Native ASSERTs stop the session and produce diagnostics. The desktop reference's ASSERT/BKPT fallback is deliberately excluded.

## Input

Pointer and keyboard input both enter a simulated capacitive touch chip. The I2C controller exposes its FIFO at `0x10004300`; the chip at address 0x55 supplies packed contact coordinates. External GPIO source 3 latches a falling edge and raises IRQ99. The unchanged IRQ handler wakes the original `Tup_Thread`, whose ARM I2C driver reads the report. There are no touch dispatch/read/wait hooks, injected ISR calls, input function patches, or host writes to ThreadX state.

`GpioInputs` owns the external rising/falling interrupt banks, masks, W1C status and data-in registers. `I2cController` owns bounded transmit/receive FIFOs, enabled/busy state, transaction deadlines, completion/NACK status and reset cancellation. `TouchController` owns sensor coordinates and stationary-contact scans. Host pointer timestamps become relative guest-time scan deadlines; consecutive movement is coalesced while press and release are retained. Firmware owns calibration, gesture recognition, activity messages and UI dispatch.

Keyboard controls are fixed screen gestures from `machine.json`, independent of menu state. Up/Down drag from the first/middle row, Left/Right tap the category controls, Enter taps the middle row, and Esc/B tap the screen back location. M swipes the main display; Tab taps the screen skip control. Category sequences use the same physical screen path. There are no SDK message shortcuts, injected key releases or host ACTIVE messages. Their effect depends on the controls actually displayed by the firmware.

Cancellation before a contact is sampled drops it. Cancellation after sampling releases the physical contact; firmware can interpret that release as a tap. The host does not fabricate an SDK error to force a reset. Pausing stops guest time and resume does not replay elapsed wall time.

`FirstSetup` is a separate, optional startup driver. It observes setup progress and queues screen gestures, including opening the menu. It never changes guest state. Manual setup does not instantiate it. Input-idle diagnostics read the native UI queue without using it to select or deliver inputs.

Board battery/thermal, eye proximity and focus-ring/power readings still use the SDK services listed in [hooks](HOOKS.md); they are separate from browser touch/keyboard input. See [input devices](INPUT.md) for register contracts, references and acceptance.

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

Dynarmic samples the external IRQ line at translated-block boundaries, after MMIO accesses complete. Its CPU implementation owns exception entry, including CPSR.I/A/T and IT state, banked LR/SP/SPSR, VBAR and SCTLR.V/TE. IRQ entry never passes through the runtime or a firmware-address hook. The privileged model supports the physical-memory board used by this profile; it is not a general MMU, TrustZone or hypervisor implementation.

The GIC is a single-CPU, 256-interrupt model with eight priority bits and no Security Extensions. Distributor and CPU enables, individual enable/pending/active aliases, edge/level configuration, CPU targeting, priorities, PMR and BPR participate in arbitration. Lower numeric priority wins; equal priorities use the lower interrupt ID. IAR acknowledges eligible interrupts, nested running group priorities captured at acknowledge restrict preemption, and ordered EOIR writes release them. Level sources reassert until the device clears them; edge and software pending latches survive masking. Reserved and unimplemented registers read as zero and ignore writes. The [GIC register contract](GIC.md) lists the implemented offsets and access semantics.

Compiled-block retention is bounded. A browser code-allocation failure reduces the cache target, releases cold Wasm modules and yields the Worker for collection before retrying the same guest PC. The retained/peak/released block counts and allocation retries appear in diagnostics. This cache is separate from guest RAM and its Wasm linear memory.

Instruction-hook queries use a 64 KiB conservative address filter before the exact point/range matcher. Collisions only add exact checks; wide/global ranges fall back to the original matcher. The derived index is rebuilt when hooks change. It does not alter memory-hook matching or the block boundary's IRQ/time/budget order. Optional native hook counters compile out of ordinary builds and are marked in diagnostic runtime metadata.

`src/cpu/dynarmic-host.cpp` bounds execution at translated-block boundaries and advances board time in C/Wasm. Dynarmic's block cycle counts supply the instruction-budget estimate; the final block may cross a slice budget. Exact `run` requests split blocks at instruction boundaries. The board uses the machine's configured two nanoseconds per budget unit.

The 27 MHz architectural counter advances at TB boundaries through a native observer that runs before IRQ selection. The five generic timer outputs and scheduled peripheral deadlines update the GIC during execution; JavaScript callbacks occur only when a deadline is due or timer levels change. MMIO also synchronizes device time. Timer programming, the counter and the external IRQ line survive CPU-context restoration. Original CP15 and MPIDR instructions run at any ARM/Thumb PC without firmware-address substitutions.

A host step has a 100,000-unit budget, about 200 microseconds of active guest execution. It does not quantize IRQ delivery. WFI waits for external work; while halted, the board clock advances to the earliest device/generic-timer deadline, bounded by 200 microseconds per host step. Per-instance native hooks and clock callbacks are removed before CPU destruction.

Worker startup uses a 112 ms work budget. After establishing the real-time baseline, it uses 16 ms to serve input and frame acknowledgements promptly. Zero-delay continuation uses MessageChannel task boundaries; positive delays use timers for wall-clock pacing. Stopping closes ports, clears timers and invalidates queued generations.

Each load owns a Worker and session identity. Old-session events cannot affect a replacement session. Hiding or blurring the page releases keys, cancels the pointer and pauses execution. Resume establishes a new wall-clock baseline without catching up time spent in the background. Stopping terminates the Worker and releases firmware buffers and session copies.

Diagnostics contain profile identities, stages, timings, counters and errors. They do not export firmware bytes, memory dumps, resource contents or local file paths.
