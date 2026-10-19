# Hooks and hardware boundaries

This inventory describes profile `xhalf-main-21aa469f`. Addresses are ARM runtime addresses from `src/profiles/xhalf-main.json`, except test observers explicitly identified below. Some older analysis databases use addresses shifted by `0x54`; do not mix the two address spaces. Symbol labels express interoperability semantics and are not a claim that all original C symbols have been recovered.

With all optional accelerations enabled, the runtime registers the named acceleration, storage, graphics and startup hooks listed below. Touch sampling, physical keys, GPIO input levels and board readings are device-model accesses; they do not add callback hooks. `installedHooks` reports only the named set. Registering a hook, patching a return stub and calling an original function are distinct operations.

## Files and media

All `vfs.*` functions and `media.mount` execute their original ARM code. There are no file API hooks or JavaScript file handles. Native FAT implements paths, directories, allocation, seek, stat, caches and locking.

The production profile retains `vfs.mount` for the ARM driver. File API addresses, guards and the stat layout live in `tests/private/fixtures/storage-bindings.json`; private acceptance merges these bindings into its test profile and validates them before execution. The old file API symbols, unused `media.mount` symbol and SD stub configuration have been removed from production profiles.

`NativeStorage` replaces two physical-disk driver entries with independently encoded LDR-PC veneers into `storage-driver.s`. The boot initializer registers logical volumes 0/7 (A/B) through native `storage.context_register`, the block callback setters and the native device-present setter, then calls the original `vfs.mount`. The media mount callback returns that initialization result. Registration and mounting execute in the actual boot task, without changing ThreadX state or application flags.

| Driver boundary           | ARM address  | Replacement                                                     |
| ------------------------- | ------------ | --------------------------------------------------------------- |
| `init.nand_resource_init` | `0x400bd5c8` | Register and mount the two virtual block devices using the SDK. |
| `storage.media_mount`     | `0x400c8918` | Report the retained native mount result.                        |

The ARM read/write callbacks submit volume, LBA, count and Guest buffer through an emulator-owned MMIO window at `0x10f00000`. `StorageDevice` transfers bounded 512-byte sectors, keeps A read-only and writes B into a sector overlay. The block API is synchronous; no synthetic completion IRQ is required. The device is a mock logical disk; physical NAND commands, ECC, spare areas and flash translation are outside this interface. The DAT supplies the complete A/B disk images. See [storage implementation and acceptance](STORAGE.md).

## Graphics and bulk operations

Implemented in `src/sdk/graphics.ts` and `src/sdk/acceleration.ts`. The first two hooks implement graphics hardware boundaries. The ten optional accelerations validate guards and runtime conditions before substituting host operations; otherwise ARM continues.

| Symbol                         | ARM address  | Hook           | Behavior                                                                                        |
| ------------------------------ | ------------ | -------------- | ----------------------------------------------------------------------------------------------- |
| `image.rect_fill`              | `0x4019a76c` | block          | Decode the MOE descriptor and fill a memory rectangle.                                          |
| `image.combine`                | `0x401daf84` | block          | Compose HWC layers with clipping, scaling, rotation and alpha.                                  |
| `libc.memcpy`                  | `0x40008b8c` | optional block | Copy at least 64 bytes within RAM; short, overlapping or non-RAM operations use ARM.            |
| `libc.memset`                  | `0x4000cdf0` | optional block | Fill at least 64 bytes of RAM.                                                                  |
| `raster.shape.site`            | `0x401fb964` | optional code  | Accelerate rectangle/border pixel loops; resume at `0x401fb9c0`.                                |
| `raster.buffer.site`           | `0x401fbbbc` | optional code  | Accelerate buffer raster loops; resume at `0x401fbc18`.                                         |
| `raster.copy.site`             | `0x401fa694` | optional code  | Copy strided pixel rectangles; resume at `0x401fa718`.                                          |
| `raster.palette`               | `0x401f8788` | optional block | Expand index/color/alpha tables to native OSD pixels.                                           |
| `pixels.rgba.site`             | `0x402ac530` | optional code  | Convert RGBA row prefixes to ABGR, preserving transparent pixels; ARM handles the final pixel.  |
| `pixels.rgba_descriptor.site`  | `0x402ac6d4` | optional code  | Descriptor entry for the same conversion; register/stack layout comes from the SDK profile.     |
| `pixels.coverage.site`         | `0x403b6044` | optional code  | Apply saturated addition and byte stores for font coverage spans; ARM handles the final pixel.  |
| `pixels.masked_transpose.site` | `0x401f8f10` | optional code  | Copy masked colors into a transposed ABGR rectangle; ARM executes the final pixel and epilogue. |

## Board and startup hardware

Implemented in `src/sdk/services.ts` and the machine devices.

| Symbol                       | ARM address  | Hook  | Behavior                                                               |
| ---------------------------- | ------------ | ----- | ---------------------------------------------------------------------- |
| `dma.dma_fill_async`         | `0x4002ab54` | block | Fill DRAM synchronously; return -1 to indicate no pending DMA channel. |
| `dma.dma_copy_sync`          | `0x4007c7c0` | block | Copy DRAM synchronously and return the actual byte count.              |
| `init.sensor_register_write` | `0x40118d80` | block | Acknowledge a sensor register write, set r1=r0 and return 0.           |
| `board.preview_geometry`     | `0x4009afe4` | block | Write the nominal 640×480 preview size; return width 640.              |
| `board.power_control`        | `0x40124b74` | block | Acknowledge physical power control, set r1=r0 and return 0.            |

Board readings are device accesses rather than function hooks. SAR6 supplies the boot battery reading and SAR0 supplies thermal; eye proximity uses native I2C and focus-ring/power probes use serial readback. Board channel values are configured in `machine.json`; the GPIO input window owns `0x1000903c` and `0x1000904c`.

## SDK registration, blank imaging and cache

Implemented by SDK services, `SensorRegistration` and `BlankImageJobs`.

| Symbol                          | ARM address  | Hook  | Behavior                                                                                                                                                                                  |
| ------------------------------- | ------------ | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sdk.sensor.config_initialized` | `0x400eef24` | code  | Register the virtual sensor port through native API `0x400ef6a8` using an independent AAPCS bridge; retain native cached getters.                                                         |
| `imaging.build_blank_job`       | `0x401502d4` | block | Validate the CQ capacity referenced by argument 60 and append an independently encoded END job. DMA completion IRQs and native queues reclaim it; real ISP processing is not implemented. |
| `cache.data_maintenance`        | `0x400029c8` | block | Coherent RAM needs no physical data-cache maintenance. Upper ARM validation and I-cache/TB invalidation remain active.                                                                    |

## Runtime and input dispatch

Implemented in `src/runtime/core.ts` and `src/sdk/input.ts`.

| Symbol         | ARM address  | Hook  | Behavior                                                                                 |
| -------------- | ------------ | ----- | ---------------------------------------------------------------------------------------- |
| `runtime.idle` | `0x40001a20` | code  | Dispatch a pending guest call at the native idle boundary; check at most once per slice. |
| `assert.entry` | `0x40007148` | block | Count ASSERT, stop the CPU and throw an error.                                           |

Acceleration resume addresses are not extra hooks. Pixel fast paths validate instruction digests, RAM bounds, overlap and control arguments. Private ARM differential tests compare pixels, registers and flags. `NativeDisplay` reads real active OSD buffers; the host does not replace menu drawers.

## Fixed return stubs

`SdkServices` patches the following session-memory entries to independently encoded `mov r0,#value; bx lr`. Return values describe the hardware ABI and do not all mean success. These entries do not register JavaScript callbacks.

| Symbol                            | ARM address  | Return value | Hardware boundary                                |
| --------------------------------- | ------------ | ------------ | ------------------------------------------------ |
| `init.boot_mode_probe`            | `0x4000c780` | 0            | Normal boot mode.                                |
| `init.board_power_init`           | `0x40043408` | 0            | Power-chip initialization.                       |
| `init.rtc_reliable_init`          | `0x400413dc` | 0            | RTC retained-marker initialization.              |
| `init.external_control_chip_init` | `0x40320938` | 0            | External control-chip register initialization.   |
| `init.lens_init_ready_probe`      | `0x400445c4` | 1            | Physical lens ready.                             |
| `init.lcd_backlight_level`        | `0x40205dd0` | 0            | Backlight hardware command.                      |
| `init.shutter_home`               | `0x4004484c` | 0            | Physical shutter homing.                         |
| `init.iris_home`                  | `0x4004459c` | 0            | Physical iris homing.                            |
| `init.focus_motor_enable`         | `0x40045b0c` | 0            | Focus-motor enable.                              |
| `init.focus_home_scan`            | `0x40045688` | 0            | Focus home scan.                                 |
| `init.focus_home_reset`           | `0x40045b5c` | 0            | Focus home reset.                                |
| `init.motor_register_write`       | `0x400889d4` | 0            | Motor-chip register transfer.                    |
| `init.focus_ring_register_update` | `0x40159484` | 0            | Focus-ring controller registers.                 |
| `init.video_led_register_update`  | `0x401189d4` | 0            | Video LED current-controller update.             |
| `init.linux_wireless_start`       | `0x406158e0` | 1            | Secondary processor/wireless system unavailable. |

## Direct CPU hooks and startup adaptation

| Boundary                | Count | Addresses / behavior                                                                                          |
| ----------------------- | ----- | ------------------------------------------------------------------------------------------------------------- |
| MMIO read/write         | 2     | Cover `0x10000000–0x10ffffff`; dispatch GIC, UART, configured devices and read stubs.                         |
| Unmapped memory         | 1     | Allocate only declared sparse-DRAM data pages; reject unknown access.                                         |
| Guest-call return       | 1     | Scratch address `0x3f10ff00`; restore interrupted CPU context.                                                |
| GFX submission observer | 1     | Observe `gfx.context + active_buffer`, currently `0x40d751c4–0x40d751c7`; sample after the CPU slice returns. |

System counter, CVAL/TVAL and control accesses execute through Unicorn's architectural CP15 handlers at any ARM/Thumb instruction address. The externally clocked timer model supplies ISTATUS and level outputs; machine configuration routes them to the GIC. No counter/compare PC hooks or MPIDR instruction patches remain. MPIDR is a machine-configured CPU identity. Guest-call dispatch now uses only the native idle boundary.

Retired timer/compare dispatch and display completion bindings are removed from the production profile, together with the unused display event group and IRQ-handler table. Unused ThreadX queue-send, touch-signal and drawing-observer bindings are also removed; the migrator discards desktop `observe.*` metadata. The idle entry retains its guarded `runtime.idle` symbol; no duplicate boot PC/guard table remains. Display completion observation is configured only by the hardware test fixture.

`boot.checksum_slot` at `0x40000bcc` points to an independently encoded return-zero function in scratch memory at `0x3f120000` for the direct-main resident-stage check. This replaces a data slot, not a function-entry hook. It does not implement firmware updating or modified-firmware export.

The native block-budget hook bounds execution and advances virtual hardware time at TB boundaries. External IRQ lines enter QEMU exception handling; the retired `runtime.irq_window` hook and manual CPSR/LR/SPSR/PC exception entry are removed. The GFX observer is installed only for Canvas presentation, does not modify registers, memory or PC, and is complemented by periodic scans for in-place updates.

## Original functions called or observed

| Symbol                                                     | ARM address          | Use                                                                                                                                                                           |
| ---------------------------------------------------------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sysg.send4`                                               | `0x4006f330`         | Fixed M/Tab/1–7/B/C messages, retaining native filtering.                                                                                                                     |
| `sysg.register_shortcut_irq`                               | `0x40003d7c`         | One idle-boundary registration of the emulator's ARM SGI15 handler. Shortcuts subsequently call `sysg.send4` from a real IRQ, without host writes to ThreadX interrupt state. |
| `display.frame_done`                                       | `0x402954b8`         | Test observer in `tests/private/fixtures/hardware-bindings.json`; original completion runs in the firmware task.                                                              |
| `ui.main_scrawl`, `ui.option_scrawl`, `ui.scrawl_callback` | Private menu fixture | Observation-only bindings in `tests/private/fixtures/menu-bindings.json`; production input does not select protocols from callbacks.                                          |

The host does not call menu-selection helpers or branch on menu handlers. First-time setup is a separate driver sending native Tab/M messages. Menu state machines, ThreadX scheduling, resource decoding, font layout and native UI drawing run in firmware.

## MMIO devices

The GIC owns the full distributor and CPU-interface pages. Its single CPU implements 256 IRQs, priority arbitration, distributor/CPU/per-IRQ enables, software pending/active aliases, edge/level configuration, CPU targeting, PMR/BPR, IAR/EOIR/HPPIR and running priority. IRQ output changes drive the native ARM line immediately. Register accesses outside the implemented subset use RAZ/WI semantics. See [architecture](ARCHITECTURE.md) for clock and exception timing.

| Device             | Registers / IRQ                           | Responsibility                                                                                                                       |
| ------------------ | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| HardwareTimers     | `0x10000a00`, IRQ48–63                    | Sixteen count/prescaler channels, periodic/one-shot completion, mask/W1C; native SDK callbacks.                                      |
| CommandQueue       | `0x10011000`, IRQ197                      | Separate HUM status, eight DMA engines, validated command subset, bounded execution, synchronization/cancellation/completion.        |
| PanelController    | `0x1000a000`, IRQ188                      | DCS/power readback, TX/BTA and channel-enable-driven scan/blank IRQs; native initialization and completion run in ARM.               |
| SerialControllers  | `0x10009100`, `0x10009200`, GPIO→IRQ186   | Retire primary/auxiliary transfers on guest time, latch GPIO completion sources 0/2/4/6 and expose configured board readback.        |
| SensorFrontend     | `0x10002000`, `0x10009800`, IRQ128        | Nominal blank source, receive link, phase/readout events; no real sensor imaging.                                                    |
| GpioInterrupts     | `0x10009000`, IRQ186                      | GPIO input levels (including +0x3c/+0x4c), receiver VD and fourteen timing comparators.                                              |
| TouchI2cController | `0x10004300/330/600`, GPIO3→IRQ99         | Native FIFO/length/address transactions, W1C completion/NACK, touch-chip packed status/coordinates and eye-sensor register readback. |
| SarAdc             | `0x10006000`, machine-configured channels | SAR0 thermal and SAR6 battery conversions, native channel selection, completion/mask/W1C at IRQ132.                                  |
| CaptureDma         | `0x1000d800`, `0x1000d880`                | Continuous capture enable, independent reset requests, SOF/EOF and raw-buffer ring indexing.                                         |
| StorageDevice      | `0x10f00000`, synchronous                 | Mock A/B logical block devices, bounded sector transfers, A write protection and B session overlay.                                  |
| ClockGates         | `0x10000044`, `0x10000064`                | Consistent readback across three groups of W1C/W1S gate aliases.                                                                     |

Machine configuration owns register addresses. Generic devices do not implement menu policy. Native SDK timer queues, panel initialization, sensor power/training, preview entry/exit and command-queue quiescence remain in ARM. Data-cache maintenance is a coherent-memory no-op at the lowest boundary; upper ARM validation and instruction/translation-cache invalidation are retained. Required hook digest mismatches reject execution, and unknown CQ commands fail.

The retired touch, key-send and constant board-read bindings are also excluded by `scripts/migrate-profile.py`. The private input acceptance fixture retains guarded observation-only addresses; production symbol lookup has no fallback aliases.

## Hardware completion acceptance

`tests/private/hardware-completion.test.ts` verifies that all eight original MPIDR instructions are unchanged, the retired timer instruction sites have no code/block hooks, real timer IRQs drive ThreadX, panel IRQ188 is acknowledged, scan status is cleared through W1C, and original display completion executes in a native task without injected display calls. Public device tests cover enable/disable, masks, level reassertion, phase-preserving deadlines and bounded pending events independently of Canvas.

Browser diagnostics retain `nativeFrames`, `nativeFrameCompletions` and `coalescedVsyncs`: they now count device scan ticks, acknowledged scan status and coalesced device ticks. They do not count injected SDK callbacks.
