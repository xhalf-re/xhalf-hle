#!/usr/bin/env python3
"""Generate public byte fixtures only from our synthetic assembly sources."""
import json
from pathlib import Path
import subprocess
import sys

root = Path(__file__).resolve().parent.parent
cache = root / '.cache/arm-tests'
cache.mkdir(parents=True, exist_ok=True)
subprocess.run(['clang-15', '--target=armv7-none-eabi', '-c', root / 'tests/arm/contracts.s', '-o', cache / 'contracts.o'], check=True)
programs = {}
for name in ['registers', 'memory', 'jump', 'loop', 'svc', 'invalid', 'irq', 'banked', 'helper_stress', 'call', 'thunk', 'wait', 'thumb_wait', 'system_registers', 'thumb_system_registers', 'timer_write', 'timer_read', 'timer_control', 'timer_tval', 'virtual_timer', 'irq_setup', 'irq_source', 'thumb_irq_source', 'irq_handler', 'thumb_irq_handler', 'irq_unmask', 'gic_handler']:
    target = cache / (name + '.bin')
    subprocess.run(['llvm-objcopy-15', '-O', 'binary', '--only-section=.text.' + name, cache / 'contracts.o', target], check=True)
    programs[name] = list(target.read_bytes())
target = root / 'tests/arm/programs.json'
if '--check' in sys.argv:
    if json.loads(target.read_text()) != programs:
        raise SystemExit('ARM fixtures differ from the assembly sources')
    print('ARM fixture bytes match assembly sources')
else:
    target.write_text(json.dumps(programs, indent=2) + '\n')
subprocess.run(['clang-15', '--target=armv7-none-eabi', '-c', root / 'src/sdk/call-thunk.s', '-o', cache / 'thunk.o'], check=True)
subprocess.run(['llvm-objcopy-15', '-O', 'binary', '--only-section=.text', cache / 'thunk.o', cache / 'thunk.bin'], check=True)
thunk=list((cache / 'thunk.bin').read_bytes())
assert thunk == programs['thunk'], 'runtime AAPCS trampoline differs from tested program'
target=root / 'src/sdk/call-thunk.json'
if '--check' in sys.argv:
    assert json.loads(target.read_text()) == thunk, 'runtime AAPCS fixture is stale'
else:
    target.write_text(json.dumps(thunk) + '\n')
subprocess.run(['clang-15', '--target=armv7-none-eabi', '-c', root / 'src/sdk/sensor-register.s', '-o', cache / 'sensor-register.o'], check=True)
subprocess.run(['llvm-objcopy-15', '-O', 'binary', '--only-section=.text', cache / 'sensor-register.o', cache / 'sensor-register.bin'], check=True)
sensor_register=list((cache / 'sensor-register.bin').read_bytes())
target=root / 'src/sdk/sensor-register.json'
if '--check' in sys.argv:
    assert json.loads(target.read_text()) == sensor_register, 'sensor registration bridge fixture is stale'
else:
    target.write_text(json.dumps(sensor_register) + '\n')

subprocess.run(['clang-15', '--target=armv7-none-eabi', '-c', root / 'src/sdk/storage-driver.s', '-o', cache / 'storage-driver.o'], check=True)
subprocess.run(['llvm-objcopy-15', '-O', 'binary', '--only-section=.text', cache / 'storage-driver.o', cache / 'storage-driver.bin'], check=True)
symbols = {}
for row in subprocess.check_output(['llvm-nm-15', '--defined-only', cache / 'storage-driver.o'], text=True).splitlines():
    address, _, name = row.split()
    symbols[name] = int(address, 16)
storage_driver = dict(code=list((cache / 'storage-driver.bin').read_bytes()), **{name: symbols['storage_' + name] for name in ('mount', 'read', 'write', 'parameters')})
target = root / 'src/sdk/storage-driver.json'
if '--check' in sys.argv:
    assert json.loads(target.read_text()) == storage_driver, 'storage driver fixture is stale'
else:
    target.write_text(json.dumps(storage_driver) + '\n')

subprocess.run(['clang-15', '--target=armv7-none-eabi', '-c', root / 'src/sdk/shortcut-irq.s', '-o', cache / 'shortcut-irq.o'], check=True)
subprocess.run(['llvm-objcopy-15', '-O', 'binary', '--only-section=.text', cache / 'shortcut-irq.o', cache / 'shortcut-irq.bin'], check=True)
shortcut_irq=list((cache / 'shortcut-irq.bin').read_bytes())
target=root / 'src/sdk/shortcut-irq.json'
if '--check' in sys.argv:
    assert json.loads(target.read_text()) == shortcut_irq, 'shortcut IRQ bridge fixture is stale'
else:
    target.write_text(json.dumps(shortcut_irq) + '\n')
