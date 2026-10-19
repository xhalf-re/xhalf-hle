# Native IRQ and GIC

The machine profile supplies distributor and CPU-interface addresses and timer IRQ wiring. This board models one CPU, 256 interrupts, eight priority bits and no Security Extensions. Devices drive level inputs or pulse events; guest instructions control the GIC registers. The two register pages are fully owned by the device model, including reserved locations that read as zero and ignore writes.

| Distributor offset | Register             | Behavior                                                                                                           |
| ------------------ | -------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `0x000`            | CTLR                 | Distributor enable; reset disabled.                                                                                |
| `0x004`, `0x008`   | TYPER, IIDR          | One CPU, 256 IRQs; model identity.                                                                                 |
| `0x100`, `0x180`   | ISENABLER, ICENABLER | Set/clear per-IRQ enable; SGIs stay enabled.                                                                       |
| `0x200`, `0x280`   | ISPENDR, ICPENDR     | Software pending latches for PPIs/SPIs; SGI writes are ignored. Clearing cannot suppress an asserted level source. |
| `0x300`, `0x380`   | ISACTIVER, ICACTIVER | Software active state; independent of the CPU running-priority stack.                                              |
| `0x400`            | IPRIORITYR           | Byte-addressable priorities; lower numbers win, then lower IRQ ID.                                                 |
| `0x800`            | ITARGETSR            | Route SPIs to CPU0; SGI/PPI targets read as CPU0.                                                                  |
| `0xc00`            | ICFGR                | Edge/level selection; SGIs are fixed edge-triggered.                                                               |
| `0xf00`            | SGIR                 | Self or explicit CPU0 targeting; the other-CPU set is empty.                                                       |
| `0xf10`, `0xf20`   | CPENDSGIR, SPENDSGIR | Single-source SGI pending aliases.                                                                                 |

| CPU offset | Register | Behavior                                                                                             |
| ---------- | -------- | ---------------------------------------------------------------------------------------------------- |
| `0x00`     | CTLR     | CPU-interface enable; reset disabled.                                                                |
| `0x04`     | PMR      | Only priorities strictly lower than PMR are eligible; reset masks all.                               |
| `0x08`     | BPR      | Split group priority from subpriority for preemption.                                                |
| `0x0c`     | IAR      | Acknowledge an eligible interrupt, activate it and push its priority; otherwise return 1023.         |
| `0x10`     | EOIR     | Complete the most recently acknowledged interrupt; out-of-order or spurious IDs do not change state. |
| `0x14`     | RPR      | Group priority captured at acknowledge; 255 while idle.                                              |
| `0x18`     | HPPIR    | Highest enabled pending IRQ within PMR, without acknowledging it.                                    |
| `0xfc`     | IIDR     | CPU-interface identity.                                                                              |

CPU-interface accesses require aligned words. Distributor bitmaps, priorities, targets and configuration support byte, halfword and word accesses. Individual disabled interrupts retain pending state. Level inputs remain pending while asserted, including while active; edge and software events latch independently and can become active-and-pending. Active interrupts cannot be acknowledged again until deactivated. BPR prevents same-group priority from preempting a running interrupt. RPR retains the group priority captured at acknowledge; later BPR writes do not recompute active priorities.

The native ARM patch drives `CPU_INTERRUPT_HARD` and samples it before guest execution at each TB entry, including cached direct chains. A native board-clock observer first advances the architectural counter and processes due peripheral events. QEMU then chooses the exception vector and saves CPSR, SPSR and banked registers. Checks inside memory hooks do not take IRQs in the middle of an unfinished MMIO access. VBAR, SCTLR.V/TE and ARM/Thumb exception return follow the CPU model; there is no firmware IRQ-window hook or manual exception entry.

Virtual time uses the existing instruction-budget estimate at TB resolution. WFI waits for external work and advances only to the next device/generic-timer deadline, bounded by one host step. Host step budgets do not quantize interrupt delivery. CPU context restoration preserves device time, timer programming, IRQ levels and GIC state. See [architecture](ARCHITECTURE.md) and [private acceptance](PRIVATE-TESTING.md#native-irq-and-gic-acceptance).

Register semantics were cross-checked against the [ARM GIC architecture specification](https://developer.arm.com/documentation/ihi0048/latest/) and the [QEMU GIC model](https://github.com/qemu/qemu/blob/v4.2.0/hw/intc/arm_gic.c), including captured running group priority and the dedicated SGI pending registers.
