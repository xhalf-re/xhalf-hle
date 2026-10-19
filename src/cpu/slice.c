/* MIT. Bounded ARM slices through Unicorn's public basic-block hook API. */
#include <stdint.h>
#include <stdlib.h>
#include <unicorn/unicorn.h>
#include <unicorn/arm.h>

extern uint32_t xhle_arm_clock_advance(uc_engine *cpu, uint64_t counter);
extern uint64_t xhle_arm_clock_deadline(uc_engine *cpu);
extern uint32_t xhle_arm_is_thumb(uc_engine *cpu);
extern void xhle_arm_clock_observer(uc_engine *cpu, void (*callback)(void *), void *opaque);
typedef void (*ClockCallback)(uint64_t now, uint32_t levels);

typedef struct {
    uc_engine *cpu;
    uc_hook hook;
    uint32_t remaining;
    uint32_t charged;
    int running;
    uint32_t elapsed;
    uint32_t instruction_ns;
    uint32_t frequency;
    uint32_t levels;
    uint64_t now;
    uint64_t ticks;
    uint64_t tick_remainder;
    uint64_t deadline;
    ClockCallback clock;
} Slice;

static void clock_advance(Slice *slice, uint64_t now)
{
    if (!slice->clock) return;
    uint64_t delta = now - slice->now;
    slice->now = now;
    /* Carry the fractional tick exactly. Most short TBs do not cross a tick,
       so their counter update needs neither 64-bit division nor remainder. */
    if (delta >= 1000000000) {
        slice->ticks += delta / 1000000000 * slice->frequency;
        delta %= 1000000000;
    }
    uint64_t fraction = slice->tick_remainder + delta * slice->frequency;
    if (fraction >= 1000000000) {
        slice->ticks += fraction / 1000000000;
        fraction %= 1000000000;
    }
    slice->tick_remainder = fraction;
    uint32_t levels = xhle_arm_clock_advance(slice->cpu, slice->ticks);
    if (now >= slice->deadline || levels != slice->levels) {
        slice->levels = levels;
        slice->clock(now, levels);
    }
}

/* Runs at TB entry before the CPU samples IRQ, including cached direct chains. */
static void clock_tb(void *opaque)
{
    Slice *slice = opaque;
    if (!slice->running) return;
    clock_advance(slice, slice->now + (uint64_t)slice->elapsed * slice->instruction_ns);
    slice->elapsed = 0;
}

static void block_budget(uc_engine *cpu, uint64_t address, uint32_t size,
                         void *opaque)
{
    Slice *slice = opaque;
    if (!slice->running) return;
    (void)address;
    /* ARM instructions are four bytes; Thumb instructions are at least two.
       Preserve the runtime's ARM clock ratio while conservatively charging
       Thumb-2 instructions. The final translated block is the only overshoot. */
    uint32_t charge = size / (xhle_arm_is_thumb(cpu) ? 2 : 4);
    if (!charge) charge = 1;
    if (!slice->remaining) {
        uc_emu_stop(cpu);
        return;
    }
    slice->charged += charge;
    slice->remaining = charge >= slice->remaining ? 0 : slice->remaining - charge;
    slice->elapsed = charge;
}

Slice *xhle_slice_create(uc_engine *cpu)
{
    Slice *slice = calloc(1, sizeof(*slice));
    if (!slice) return NULL;
    slice->cpu = cpu;
    slice->deadline = UINT64_MAX;
    if (uc_hook_add(cpu, &slice->hook, UC_HOOK_BLOCK, block_budget, slice, 1, 0)) {
        free(slice);
        return NULL;
    }
    uc_ctl_flush_tb(cpu);
    return slice;
}

uc_err xhle_slice_run(Slice *slice, uint32_t begin, uint32_t budget)
{
    if (!slice || !budget || slice->running) return UC_ERR_ARG;
    slice->remaining = budget;
    slice->charged = 0;
    slice->elapsed = 0;
    slice->running = 1;
    uc_err error = uc_emu_start(slice->cpu, begin, 0, 0, 0);
    slice->running = 0;
    clock_advance(slice, slice->now + (uint64_t)slice->elapsed * slice->instruction_ns);
    slice->elapsed = 0;
    return error;
}

void xhle_slice_clock_configure(Slice *slice, uint32_t instruction_ns,
                                uint32_t frequency, ClockCallback callback)
{
    slice->instruction_ns = instruction_ns;
    slice->frequency = frequency;
    slice->ticks = slice->now / 1000000000 * frequency +
                   slice->now % 1000000000 * frequency / 1000000000;
    slice->tick_remainder = slice->now % 1000000000 * frequency % 1000000000;
    slice->clock = callback;
    xhle_arm_clock_observer(slice->cpu, clock_tb, slice);
}

uint32_t xhle_slice_charged(Slice *slice)
{
    return slice->charged;
}

void xhle_slice_clock_deadline(Slice *slice, uint64_t deadline)
{
    slice->deadline = deadline;
}

uint64_t xhle_slice_clock_now(Slice *slice)
{
    return slice->now;
}

/* Early returns may idle only as far as the next board or generic timer event. */
void xhle_slice_clock_idle(Slice *slice, uint64_t limit)
{
    uint64_t ticks = xhle_arm_clock_deadline(slice->cpu);
    if (ticks != UINT64_MAX && ticks / slice->frequency < UINT64_MAX / 1000000000) {
        uint64_t expiry = ticks / slice->frequency * 1000000000 +
            (ticks % slice->frequency * 1000000000 + slice->frequency - 1) / slice->frequency;
        if (expiry < limit) limit = expiry;
    }
    if (slice->deadline < limit) limit = slice->deadline;
    if (limit > slice->now) clock_advance(slice, limit);
}

void xhle_slice_destroy(Slice *slice)
{
    if (!slice) return;
    if (slice->clock) xhle_arm_clock_observer(slice->cpu, NULL, NULL);
    uc_hook_del(slice->cpu, slice->hook);
    free(slice);
}
