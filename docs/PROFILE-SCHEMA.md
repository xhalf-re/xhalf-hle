# Web profile schema 2

Configuration has three layers: machine, SDK and firmware. Firmware profiles use `webSchema: 2` to distinguish the web format from the desktop schema. The payload SHA-256 identifies the main firmware, with a corresponding desktop ELF identity. The complete DAT identity validates the boot container; A/B resource lengths and hashes are checked separately.

Public symbols replace raw `expected` bytes and locator pattern/mask values with `guard: {length, sha256}`. Required hook mismatches reject execution. Optional hook mismatches disable the entire acceleration group and record a reason. Only profiles with `status: supported` may run. Migration preserves status and does not approve candidates.

To migrate a desktop configuration:

```sh
python3 scripts/migrate-profile.py LOCAL_PROFILE BASELINE_ROOT OUTPUT_JSON --dat LOCAL_DAT
```

The tool emits configuration and digests, never firmware files. It excludes the desktop ASSERT fallback. Schema 2 removes the startup `patches`, `counter_reads`, `compare_writes`, `control_writes` and `compare_reads` fields. Original timer and MPIDR instructions execute through the CPU system-register model. The machine supplies `mpidr`, `counter_hz` and `gic.timer_irqs` in physical/virtual/hypervisor/secure/hypervisor-virtual output order. The SPCA6500 profile connects the physical timer to IRQ29. Old Web schema 1 profiles must be migrated rather than silently retaining PC-based overrides.

The boot object contains only `load_base`, `zero_from`, `zero_to` and `sram_copy`. Active function/instruction guards live in `symbols`; the former duplicate boot guard table, ELF file offset, BSS/RX observers, idle PC and patch notes are removed. The presentation configuration has no frame-clock interval; scan timing belongs to `peripherals.panel`. Production profiles contain no display completion function/event-group or IRQ-handler-table bindings. Migration also removes the retired `runtime.irq_window`, unused queue-send/touch-signal entries, unused drawing callbacks and desktop `observe.*` symbols. IRQ entry is a CPU responsibility. The retired `runtime.idle` binding and guest-call return trap are removed; input no longer changes guest PC or ThreadX state. The hardware acceptance test merges its guarded completion observer from `tests/private/fixtures/hardware-bindings.json`, validates the profile identity and runs preflight before observing ARM execution.

A new adaptation must validate machine/SDK layouts, pass preflight, cold boot real firmware, and complete menu and power regressions before becoming supported. Synthetic profile tests validate the adaptation mechanism; they do not establish support for another firmware version. See [firmware adaptation](FIRMWARE-ADAPTATION.md).

Virtual storage uses the machine's `peripherals.storage` MMIO window/volume IDs and `scratch.storage_driver`, the SDK's `disk_context`/storage ABI, and required guarded `storage.*` native registration functions. The production profile retains only the `vfs.mount` native entry used by the ARM driver. File API bindings and the stat layout belong to the private acceptance fixture, which validates its profile identity and instruction guards before execution.

Input lowering removes production `sdk.touch.*`, `sdk.key.send`, `sysg.send4` and `runtime.idle` bindings. Observation-only instruction addresses live in `tests/private/fixtures/input-bindings.json` and pass preflight. Machine configuration supplies I2C ports, status bits, GPIO edges, touch geometry, scan interval and keyboard gestures. Battery/thermal and other board-reading SDK bindings remain separate services.

Menu callback symbols (`ui.main_scrawl`, `ui.option_scrawl`, `ui.scrawl_callback`) and `ui.language_table` live only in `tests/private/fixtures/menu-bindings.json`, together with the language-table layout. Menu and frame tests merge the fixture into their test profile, check its identity and run preflight; production profiles do not contain these test observers.

`peripherals.input.gestures` contains fixed display-space `[x, y, elapsed_ms]` samples. `sequences` names ordered gestures with a configured gap. Pointer and keyboard input use the same touch-chip/I2C/GPIO path. There is no SDK key-message table, screen-state branching in input routing, or SGI shortcut bridge.

`ui.first_setup_gestures` maps versioned setup-page IDs to fixed gesture names. Only the optional startup driver reads this table. It queues one operation for the current page, so a click sequence cannot spill into the next setup screen or preview. Ordinary input routing never reads it.
