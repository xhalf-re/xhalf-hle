// Independently written synthetic ARMv7-A programs. No firmware instructions.
.syntax unified
.arch armv7-a
.arm

.section .text.system_registers,"ax"
mrc p15,0,r4,c0,c0,5
mrc p15,0,r5,c14,c0,0
mrrc p15,0,r6,r7,c14
mrrc p15,1,r8,r9,c14

.section .text.thumb_system_registers,"ax"
.thumb
mrc p15,0,r4,c0,c0,5
mrc p15,0,r5,c14,c0,0
mrrc p15,0,r6,r7,c14
mrrc p15,1,r8,r9,c14
.arm

.section .text.timer_write,"ax"
mcrr p15,2,r0,r1,c14
mcr p15,0,r2,c14,c2,1

.section .text.timer_read,"ax"
mrrc p15,2,r4,r5,c14
mrc p15,0,r6,c14,c2,1
mrc p15,0,r7,c14,c2,0

.section .text.timer_control,"ax"
mcr p15,0,r2,c14,c2,1

.section .text.timer_tval,"ax"
mcr p15,0,r0,c14,c2,0

.section .text.virtual_timer,"ax"
mcrr p15,3,r0,r1,c14
mcr p15,0,r2,c14,c3,1
mrrc p15,3,r4,r5,c14
mrc p15,0,r6,c14,c3,1
.section .text.registers,"ax"
mov r0,#0x37
sub r1,r2,r3
adds r4,r0,#1
cmp r4,#0x38
.section .text.memory,"ax"
ldr r0,[r1]
add r0,r0,#1
str r0,[r1,#4]
ldrb r2,[r1,#1]
.section .text.jump,"ax"
mov r0,#1
mov r0,#2
mov r1,#3
.section .text.loop,"ax"
add r0,r0,#1
b .-4
.section .text.svc,"ax"
svc #0
mov r0,#9
.section .text.invalid,"ax"
udf #0
.section .text.irq,"ax"
add r0,r0,#1
subs pc,lr,#4
.section .text.banked,"ax"
.arch_extension virt
msr sp_irq,r3
msr sp_fiq,r2
mrs r0,sp_irq
mrs r1,sp_fiq
.section .text.helper_stress,"ax"
movw r1,#0
movt r1,#0x6000
mov r0,#1
.rept 160
str r0,[r1]
.endr
.section .text.call,"ax"
push {r4,lr}
mov r4,#0x99
add r0,r0,r1
add r0,r0,r2
add r0,r0,r3
ldr r1,[sp,#8]
add r0,r0,r1
ldr r1,[sp,#12]
add r0,r0,r1
and r1,sp,#7
pop {r4,pc}
.section .text.thunk,"ax"
// AAPCS trampoline: packet = target, count, padded r0-r3, remaining words.
// Save 24 bytes, then align outgoing argument area to eight bytes.
push {r4-r8,lr}
ldr r4,[r0]
ldr r5,[r0,#4]
add r6,r0,#8
subs r5,r5,#4
movlt r5,#0
lsl r7,r5,#2
add r7,r7,#7
bic r7,r7,#7
sub sp,sp,r7
add r8,r6,#16
mov ip,#0
1: cmp ip,r5
bge 2f
ldr r0,[r8,ip,lsl #2]
str r0,[sp,ip,lsl #2]
add ip,ip,#1
b 1b
2: ldm r6,{r0-r3}
blx r4
add sp,sp,r7
pop {r4-r8,pc}

.section .text.wait,"ax"
mov r0,#1
wfi
mov r0,#2

.section .text.thumb_wait,"ax"
.thumb
movs r0,#41
adds r0,#1
wfi
movs r0,#43
1: b 1b
.arm

.section .text.irq_setup,"ax"
.arm
mcr p15,0,r0,c12,c0,0
mrc p15,0,r3,c1,c0,0
bic r3,r3,#0x2000
bic r3,r3,#0x40000000
orr r3,r3,r1
mcr p15,0,r3,c1,c0,0
isb

.section .text.irq_source,"ax"
str r0,[r1]
mov r6,#17
b 1f
1: add r6,r6,#1
b 1b

.section .text.thumb_irq_source,"ax"
.thumb
str r0,[r1]
movs r6,#17
b 1f
nop
1: adds r6,#1
b 1b
.arm

.section .text.irq_handler,"ax"
add r8,r8,#1
subs pc,lr,#4

.section .text.thumb_irq_handler,"ax"
.thumb
add.w r8,r8,#1
subs pc,lr,#4
.arm

.section .text.irq_unmask,"ax"
cpsie i
b 1f
1: add r6,r6,#1
b 1b

.section .text.gic_handler,"ax"
ldr r2,[r4,#0xc]
add r8,r8,#1
str r2,[r4,#0x10]
subs pc,lr,#4
