# Virtual block storage

The runtime uses a mock logical disk for the original firmware's FAT/VFS. It reads the A/B volume images directly from the user-provided DAT. NAND dumps and physical controller protocols are unnecessary for this boundary.

`src/sdk/storage-driver.s` is an independently written ARM AAPCS driver. Its initializer runs in the real boot task, calls the native SDK context/callback registration functions, marks volumes 0/7 present through the native API, and calls the original `vfs.mount` for each volume. Two validated driver entries use LDR-PC veneers: physical NAND initialization and its media mount callback. All file APIs, native FAT, caches, allocation, mutexes and ThreadX queues remain original firmware code. The mount callback reports the actual initialization result.

The driver submits synchronous block requests to `StorageDevice` through a small emulator-owned MMIO window. Interrupts are masked only while the shared request registers are being used and restored before returning; the device never calls Guest code during the transfer. There are no per-file JavaScript callbacks, path parsing or host file descriptors. `src/services/fat.ts` is retained solely as an independent test oracle and is excluded from the production dependency graph. Physical NAND identification, page/OOB layout, bad-block translation and ECC are outside this mock's interface.

| Offset | u32 register | Meaning                                         |
| ------ | ------------ | ----------------------------------------------- |
| `0x00` | Volume       | SDK logical volume ID, 0=A and 7=B.             |
| `0x04` | LBA          | First 512-byte logical sector.                  |
| `0x08` | Count        | Sector count, bounded to 32,768 per request.    |
| `0x0c` | Buffer       | Guest RAM pointer.                              |
| `0x10` | Command      | Aligned u32 doorbell: 1=read, 2=write, 3=flush. |
| `0x14` | Bytes        | Actual transferred bytes; zero on failure.      |
| `0x18` | Status       | 0=success, 1=read-only, 2=range, 3=unsupported. |
| `0x1c` | Capacity     | Selected image size in sectors.                 |
| `0x20` | Sector size  | 512 bytes.                                      |

A rejects sector writes. B uses a copy-on-write map of sectors, including filesystem metadata, so native FAT can create, extend and reopen files. Reset/new sessions discard that overlay; input DAT bytes are never changed. `RuntimeCore.destroy()` clears device state and releases the CPU. Bounds are checked before any transfer; unknown volumes/commands and non-RAM or wrapping Guest pointers return an error without modifying memory or disk data.

Public checks cover sector transfers, write protection, bounds, byte/halfword register accesses, Node Buffer copy semantics and overlay reset. `npm run arm:check` verifies that the driver byte fixture and symbol offsets match its assembly source.

The private storage acceptance test reads all 2,457 regular DAT files through the original ARM APIs (A: 2,454; B: 3), comparing 114,301,654 bytes with the independent parser. It also verifies a 23,017-byte B file across sector/cluster boundaries, EOF, missing files, size/size64, close/reopen, seek/tell, stat, unchanged source hashes and overlay reset. The test asserts that no VFS or media mount hooks are installed. File API bindings and the stat layout live only in `tests/private/fixtures/storage-bindings.json`; the test checks the fixture's profile identity and preflights its guards together with the runtime bindings. Raw results remain under `.private/storage/`.

## Local acceptance · 2026-10-19

| Check                                                                                                             | Result                                         |
| ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Public formatting, types, unit tests, production build and content audit                                          | Pass, 63 tests.                                |
| ARM driver assembly/fixture consistency                                                                           | Pass.                                          |
| Original ARM VFS all-file differential and B write/seek/stat/reset                                                | Pass, 2,457 files / 114,301,654 bytes.         |
| Private boot, stable-frame differential, native touch and three power scenarios                                   | Pass, 7 private tests including storage.       |
| Chromium boot, 44-case menu matrix, display backpressure, manual setup, pointer/high-DPI and ten load/stop cycles | Pass, 8 browser tests including performance.   |
| Three production cold boots                                                                                       | 17.966 s, 17.964 s, 16.951 s; threshold 120 s. |
| 100 visible native navigation samples                                                                             | P95 223.9 ms; threshold 300 ms.                |

These are local results for the supported profile and supplied DAT. Native assertions, input errors and storage errors were zero in the interaction acceptance runs. The stable main-menu framebuffer matched the independent desktop reference exactly at the same virtual time and keyboard focus. Full logs, source-image details and screenshots remain in ignored private storage. This change does not publish or deploy the application.
