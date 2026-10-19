// Independently written AAPCS driver for an emulator-owned block device.
// Native SDK registration, locks, FAT mounting and all file APIs run in ARM.
.syntax unified
.arch armv7-a
.arm
.text
.global storage_init, storage_mount, storage_read, storage_write, storage_parameters
storage_init:
    push {r4-r8,lr}
    adr r8,storage_parameters
    ldr r4,[r8,#4]       // context table, two {volume, context} rows
    mov r5,#0
1:  ldm r4!,{r6,r7}
    mov r0,r6
    mov r1,r7
    ldr ip,[r8,#8]       // native context registration / mutex creation
    blx ip
    mov r0,r6
    adr r1,storage_mount
    ldr ip,[r8,#12]      // native mount callback setter
    blx ip
    mov r0,r6
    adr r1,storage_read
    ldr ip,[r8,#16]      // native block-read callback setter
    blx ip
    mov r0,r6
    adr r1,storage_write
    ldr ip,[r8,#20]      // native block-write callback setter
    blx ip
    mov r0,r6
    mov r1,#0
    ldr ip,[r8,#24]      // native optional erase callback setter
    blx ip
    mov r0,r6
    mov r1,#0
    ldr ip,[r8,#28]      // native optional sync callback setter
    blx ip
    mov r0,r6
    mov r1,#0
    ldr ip,[r8,#32]      // native optional format callback setter
    blx ip
    mov r0,r6
    mov r1,#1
    ldr ip,[r8,#36]      // native device-present setter
    blx ip
    mov r0,r6
    add r1,r7,#128       // FAT BPB supplied by the validated DAT
    ldr ip,[r8,#40]      // original vfs.mount
    blx ip
    cmp r0,#0
    blt 2f
    add r5,r5,#1
    cmp r5,#2
    bne 1b
    mov r0,#0
2:  ldr r1,[r8,#44]      // retain native mount result for later media probes
    str r0,[r1]
    pop {r4-r8,pc}

storage_mount:
    adr ip,storage_parameters
    ldr ip,[ip,#44]
    ldr r0,[ip]
    bx lr

storage_read:
    push {r4-r6,lr}
    mov r4,#1
    b 3f
storage_write:
    push {r4-r6,lr}
    mov r4,#2
3:  adr ip,storage_parameters
    ldr ip,[ip]
    ldr r0,[r0,#96]      // SDK block context's logical volume ID
    // Serialize the shared device register packet while IRQs are masked.
    // The transfer is synchronous, bounded, and never invokes Guest code.
    mrs r5,cpsr
    cpsid i
    stmia ip,{r0-r3}
    str r4,[ip,#16]
    ldr r0,[ip,#20]      // block callbacks return actual bytes transferred
    msr cpsr_c,r5
    pop {r4-r6,pc}
.balign 4
storage_parameters:
    .space 48           // Filled from the machine and SDK profiles.
