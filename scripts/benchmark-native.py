#!/usr/bin/env python3
"""Synthetic CPU microbenchmark; does not load firmware or snapshots."""
import json
from pathlib import Path
from statistics import median
from time import perf_counter
import unicorn
import resource
from unicorn.arm_const import UC_ARM_REG_PC

programs = json.loads((Path(__file__).resolve().parent.parent / 'tests/arm/programs.json').read_text())
cpu = unicorn.Uc(unicorn.UC_ARCH_ARM, unicorn.UC_MODE_ARM)
cpu.mem_map(0x40000000, 4096)
cpu.mem_write(0x40000000, bytes(programs['loop']))
count = 1_000_000

def sample():
    cpu.reg_write(UC_ARM_REG_PC, 0x40000000)
    start = perf_counter()
    cpu.emu_start(0x40000000, 0, count=count)
    return (perf_counter() - start) * 1000

sample()
instructions = [sample() for _ in range(5)]
hits = [0]
def on_code(*_): hits[0] += 1
hook = cpu.hook_add(unicorn.UC_HOOK_CODE, on_code, begin=0x40000000, end=0x40000000)
cpu.ctl_remove_cache(0x40000000, 0x40000008)
hooks = [sample() for _ in range(5)]
cpu.hook_del(hook)
assert hits[0] == count // 2 * 5
print(json.dumps({'unicorn': unicorn.__version__, 'instructionCount': count,
                  'instructionMs': instructions, 'medianInstructionMs': median(instructions),
                  'hookMs': hooks, 'medianHookMs': median(hooks),
                  'processMaxRssKiB': resource.getrusage(resource.RUSAGE_SELF).ru_maxrss}, indent=2))
