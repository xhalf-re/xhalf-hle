# Input devices

Browser pointer events and keyboard gestures enter the same capacitive touch
controller. The guest executes its original I2C driver, GPIO interrupt handler,
ThreadX touch task, gesture recognizer and menu code. Production input installs
no instruction hooks, patches no functions, injects no calls and never writes
ThreadX state.

## Design references

The implementation was reviewed against these public references before the
migration. They inform device boundaries and register semantics; this board's
register contract was independently checked against the supplied firmware.

- [QEMU memory API](https://www.qemu.org/docs/master/devel/memory.html#mmio-operations):
  MMIO access callbacks, access widths and ownership of device registers.
- [QEMU PL061 GPIO](https://github.com/qemu/qemu/blob/master/hw/gpio/pl061.c):
  input transitions, independent pending status and masks, and derived IRQ output.
- [QEMU i.MX I2C](https://github.com/qemu/qemu/blob/master/hw/i2c/imx_i2c.c):
  separate controller/target state, FIFO/data access side effects, NACK and reset.

This implementation does not emulate either reference chip. It models the
SPCA6500 interfaces actually used by the supported firmware. Devices have no
firmware addresses, ThreadX structure knowledge or menu selection policy.

## Register contract

Addresses and wiring are in `src/profiles/machine.json`.

| Device         | Register                                 | Behavior                                                                                             |
| -------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| External GPIO  | `0x10000008 / 0x1000000c`                | Rising/falling status, W1C. Edges latch while masked.                                                |
| External GPIO  | `0x10000010 / 0x10000014`                | Rising mask set/clear.                                                                               |
| External GPIO  | `0x10000018 / 0x1000001c`                | Falling mask set/clear.                                                                              |
| External GPIO  | IRQ64–89 / IRQ96–121                     | One rising/falling line per external source. Touch uses falling source 3, IRQ99.                     |
| GPIO inputs    | Machine `gpio_input.inputs`              | Read-only levels; host/device wiring drives changes.                                                 |
| I2C ports      | `0x10004300`, `0x10004330`, `0x10004600` | Independent 0x30-byte register windows.                                                              |
| I2C            | `+0x00 / +0x02 / +0x04`                  | Enable, transfer mode, start/busy.                                                                   |
| I2C            | `+0x08 / +0x0a`                          | Wire address and read count minus one.                                                               |
| I2C            | `+0x20 / +0x24`                          | Transmit/receive FIFOs, consumed by accesses.                                                        |
| I2C completion | Machine `status`, `done_bit`, `nack_bit` | W1C completion and NACK; transfer completes on guest time. The native touch driver polls these bits. |
| I2C reset      | `0x10004012`                             | Per-port reset cancels unfinished work and clears FIFO/status. Disabling a port also cancels work.   |
| Touch target   | Port 0, address `0x55`                   | Register-addressed I2C target.                                                                       |
| Touch target   | `0x12–0x14`                              | Contact-valid bit and two packed 11-bit coordinates. Native ARM applies board transforms.            |
| Touch target   | `0x3f`                                   | One supported contact.                                                                               |

The target supplies controller coordinates, not SDK report structures. A whole
coordinate report is captured for each completed I2C transaction. Unknown I2C
targets NACK; the host does not replace their ARM wrappers with success values.

The serial transfer engines also latch GPIO completion sources 0/2/4/6. Clearing
busy alone does not notify native consumers waiting on their completion queues.

## Timing and host controls

`VirtualEvents` schedules scans and transfers on guest time. A held contact keeps
producing scans. Host timestamps specify relative motion/release deadlines;
motion updates coalesce, while press and release remain ordered. Each device
uses replaceable event keys, and reset discards pending events.

`peripherals.input.gestures` defines fixed screen-space points and elapsed times.
`sequences` composes these gestures without inspecting firmware state. Keyboard
release ends key repeat suppression; the mapped gesture already contains its
physical release. UI-queue reads are used only for idle diagnostics. They do not
choose an input protocol, redirect guest execution or gate physical sampling.

An unsampled cancelled press is discarded. A sampled cancellation releases the
contact through the chip. The real firmware may treat that release as a tap;
there is no synthetic SDK error/reset path. No elapsed wall time is replayed
after pause/resume.

`FirstSetup` is the only startup navigation policy. It queues the same device
gestures as manual operation and stops after reaching the main menu. Manual
setup runs without this driver.

## Acceptance

Public input tests exercise register transactions, delayed completion, NACK,
reset, masked edges, acknowledge/EOI/W1C, stationary contacts, timestamps,
cancellation, bounded event queues and keyboard input without a CPU/SDK adapter.

`tests/private/native-input.test.ts` merges guarded observation bindings from
`fixtures/input-bindings.json`. It verifies unchanged original instructions,
absence of input/idle hooks, real IRQ99 acknowledge, native ISR/task contexts,
menu actions and absence of host writes to ThreadX state. Aggregate evidence is
written to `.private/input-lowering/acceptance.json`; firmware and screenshots
remain private.
