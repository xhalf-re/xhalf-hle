// Self-written AAPCS bridge: register virtual board ports in the native SDK.
.syntax unified
.arch armv7-a
.arm
.text
push {r0-r12,lr}
adr r4,parameters
ldm r4!,{r5,r6,r8,r9}
add r4,r4,#8
mov r0,#0
str r0,registration_status
mov r7,#0
1: cmp r7,r6
bhs 3f
ldr r2,[r4],#4
cmp r2,#0
beq 2f
push {r2,r3}
mov r0,r8
mov r1,r7
mov r2,r7
blx r5
pop {r2,r3}
cmp r0,#0
bne 4f
mov r0,r9
mov r1,r7
blx r5
cmp r0,#0
bne 4f
2: add r7,r7,#1
b 1b
4: str r0,registration_status
3: pop {r0-r12,lr}
ldr pc,return_pc
.balign 4
parameters:
.word 0 // native API
.word 0 // port count
.word 0 // identity command
.word 0 // interface command
return_pc:
.word 0 // native initializer continuation
registration_status:
.word 0
// Interface types follow; supplied from the machine profile, never guest bytes.
