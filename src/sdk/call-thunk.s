// Self-written ARM AAPCS trampoline, validated against synthetic callees.
.syntax unified
.arch armv7-a
.arm
.text
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
