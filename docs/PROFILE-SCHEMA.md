# Web profile schema 2

Configuration has three layers: machine, SDK and firmware. Firmware profiles use `webSchema: 2` to distinguish the web format from the desktop schema. The payload SHA-256 identifies the main firmware, with a corresponding desktop ELF identity. The complete DAT identity validates the boot container; A/B resource lengths and hashes are checked separately.

Public symbols replace raw `expected` bytes and locator pattern/mask values with `guard: {length, sha256}`. Required hook mismatches reject execution. Optional hook mismatches disable the entire acceleration group and record a reason. Only profiles with `status: supported` may run. Migration preserves status and does not approve candidates.

To migrate a desktop configuration:

```sh
python3 scripts/migrate-profile.py LOCAL_PROFILE BASELINE_ROOT OUTPUT_JSON --dat LOCAL_DAT
```

The tool emits configuration and digests, never firmware files. It excludes the desktop ASSERT fallback. Schema 2 removes the startup `patches`, `counter_reads`, `compare_writes`, `control_writes` and `compare_reads` fields. Original timer and MPIDR instructions execute through the CPU system-register model. The machine supplies `mpidr`, `counter_hz` and `gic.timer_irqs` in physical/virtual/hypervisor/secure/hypervisor-virtual output order. The SPCA6500 profile connects the physical timer to IRQ29. Old Web schema 1 profiles must be migrated rather than silently retaining PC-based overrides.

The boot object contains only `load_base`, `zero_from`, `zero_to` and `sram_copy`. Active function/instruction guards live in `symbols`; the former duplicate boot guard table, ELF file offset, BSS/RX observers, idle PC and patch notes are removed. The presentation configuration has no frame-clock interval; scan timing belongs to `peripherals.panel`. Production profiles contain no display completion function/event-group or IRQ-handler-table bindings. Migration also removes the retired `runtime.irq_window`, unused queue-send/touch-signal entries, unused drawing callbacks and desktop `observe.*` symbols. IRQ entry is a CPU responsibility. The guarded `runtime.idle` binding still dispatches host input calls. The hardware acceptance test merges its guarded completion observer from `tests/private/fixtures/hardware-bindings.json`, validates the profile identity and runs preflight before observing ARM execution.

A new adaptation must validate machine/SDK layouts, pass preflight, cold boot real firmware, and complete menu and power regressions before becoming supported. Synthetic profile tests validate the adaptation mechanism; they do not establish support for another firmware version. See [firmware adaptation](FIRMWARE-ADAPTATION.md).

Virtual storage uses the machine's `peripherals.storage` MMIO window/volume IDs and `scratch.storage_driver`, the SDK's `disk_context`/storage ABI, and required guarded `storage.*` native registration functions. The production profile retains only the `vfs.mount` native entry used by the ARM driver. File API bindings and the stat layout belong to the private acceptance fixture, which validates its profile identity and instruction guards before execution.

Input lowering removes the production `sdk.touch.*`, `sdk.key.send`, `boot.key_adc`, `board.boot_adc_interval` and board reading bindings. Migration filters them as well. Instruction addresses used to verify original input execution live only in the private acceptance fixture and pass preflight. There are no hard-coded fallback addresses in the profile reader. Machine configuration supplies SAR/I2C/GPIO register addresses, IRQ routing and board sample values. The original boot ADC name referred to the battery reading (SAR6), rather than a browser direction-key mapping.

The former menu callback classifiers (`ui.main_scrawl`, `ui.option_scrawl` and `ui.scrawl_callback`) are also removed from production and migration. Private menu enumeration and pixel comparisons merge `tests/private/fixtures/menu-bindings.json` before preflight.

`peripherals.input.gestures` contains fixed display-space `[x, y, elapsed_ms]` samples. Browser keys write these samples into the same I2C/GPIO device path as pointer input; `sdk.input.key_map` contains only M, Tab, 1–7 and B/C shortcut messages. `gpio_levels` wires the two native shutter stages. No guessed direction-key ADC ladder values remain.
