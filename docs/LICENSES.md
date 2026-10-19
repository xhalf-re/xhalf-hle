# Sources and licenses

| Component                              | Source                                                            | License and treatment                                                                                                                                                         |
| -------------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Original project code                  | xndcn, 2026                                                       | MIT; see the root LICENSE.                                                                                                                                                    |
| SUNP/FAT algorithm references          | Author-owned `burn.js`, `burnextract.js` and `burnfat.js`         | Authorship confirmed by the owner. The containing patcher repository is GPL-3.0; that repository is not relicensed. The web implementation records the reference files below. |
| Desktop HLE interoperability contracts | Author-owned xhalf reference; commits and hashes in baseline.json | New TypeScript implementations follow observed contracts; Python files were not copied verbatim.                                                                              |
| Unicorn.js / Unicorn                   | Pinned commits and archive hashes in scripts/wasm-sources.json    | Original GPL terms and component LGPL notices retained. Distribute corresponding source and build materials for the combined runtime.                                         |
| CloudpilotEmu / Pebble / v86           | Architecture research only                                        | No implementation code copied.                                                                                                                                                |

Dependencies are pinned in `package-lock.json`. Regenerate the installed dependency license inventory with `node scripts/dependency-licenses.mjs`; the result is `docs/dependency-licenses.json`. Development dependency licenses do not replace the Wasm runtime license review. Zod is MIT licensed and appears in the inventory.

## Implementation provenance

- `src/firmware/package.ts` follows the SUNP/HDR2 format understood through the author's `burn.js` and `burnextract.js`. `src/services/fat.ts` follows `burnfat.js` and remains a test reference. Production storage uses the firmware's native VFS/FAT through the independently written virtual block device and ARM registration driver.
- Public machine, SDK and firmware JSON files contain layouts, addresses and digests from the reference recorded in [baseline.json](baseline.json). Raw instruction bytes and locator patterns are removed during migration.
- ARM, ThreadX and SDK behavior references are the author's HLE files at commit `7dda47495daf74da1a865dbc0b9383d7b5a516df`. New TypeScript implementations, synthetic tests and independently written AAPCS assembly use MIT.
- Graphics, display, input and acceleration code implements the author's observed interoperability contracts. Native reference images are used only for private differential testing.
- The peripheral bus, timers/IRQs, command-queue subset, panel, serial controllers, virtual frontend, GPIO, capture and clock gates were independently written from private analysis. Public configuration contains only addresses, layouts and digests. `sensor-register.s` and `storage-driver.s` are independently written SDK call bridges, and blank-job END commands follow the interoperability format.
- `src/cpu/slice.c` is independently written MIT code using Unicorn's public block-hook API and the project's board-clock interface. The combined Wasm runtime still follows the upstream GPL conditions.
- `patches/unicorn-helper-temporaries.patch` modifies the GPL core and is distributed under the original GPL-2.0 terms; see [patch documentation](../patches/README.md).

## Distribution

Keep upstream LICENSE, COPYING, LGPL, GLib and author notices with runtime binaries. Provide complete corresponding source, patches and build scripts as described in [WASM-BUILD.md](WASM-BUILD.md). The combined release is not represented as wholly MIT licensed.

Do not distribute manufacturer DAT/ELF files, resource images, fonts, icons, pictures, full RAM snapshots or native GUI screenshots. Profiles may expose addresses, lengths, hashes and the minimum interoperability information needed. Document the purpose and independent assembly basis of each startup replacement. The app does not download, repackage, flash, export modified firmware or bypass update signatures.
