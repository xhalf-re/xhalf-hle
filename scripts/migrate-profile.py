#!/usr/bin/env python3
"""Migrate a local desktop profile to public length/digest-only Web schema 2.

Never embeds source bytes or locator patterns. Does not promote candidates.
"""
import argparse
import hashlib
import json
from pathlib import Path

def numbers(value):
    if isinstance(value, dict): return {key: numbers(item) for key, item in value.items()}
    if isinstance(value, list): return [numbers(item) for item in value]
    if isinstance(value, str) and value.startswith('0x'):
        try: return int(value, 16)
        except ValueError: pass
    return value

def guard(raw):
    data = bytes.fromhex(raw)
    return {'length': len(data), 'sha256': hashlib.sha256(data).hexdigest()}

def migrate(document, resource_root, dat):
    d = numbers(document)
    if d.get('schema') != 1 or d.get('target') != 'main': raise ValueError('requires a desktop schema-1 main profile')
    d['webSchema'] = 2
    d['firmware']['package_sha256'] = hashlib.sha256(dat.read_bytes()).hexdigest()
    # Only runtime startup parameters survive. Timer/MPIDR instructions execute
    # architecturally; active hook guards belong to their symbol bindings.
    d['boot'] = {key: d['boot'][key] for key in ('load_base', 'zero_from', 'zero_to', 'sram_copy')}
    d.pop('boot_patch_notes', None)
    # Desktop observers and retired host entry points have no web consumers.
    retired = {
        'runtime.irq_window', 'runtime.compare_read_site', 'display.frame_done',
        'display.event_group', 'irq.handlers', 'tx.queue_send', 'sdk.touch.signal',
        'ui.main_list_scrawl', 'ui.sub_scrawl', 'ui.viewdraw',
        'sdk.touch.dispatch_site', 'sdk.touch.wait_site', 'sdk.touch.read',
        'sdk.touch.device_read', 'sdk.touch.interrupt', 'sdk.touch.thread_entry',
        'sdk.touch.driver', 'sdk.key.send', 'boot.key_adc',
        'board.boot_adc_interval', 'board.thermal_read', 'board.eye_sensor_read',
        'board.power_probe', 'board.focus_ring_read',
        'ui.main_scrawl', 'ui.option_scrawl', 'ui.scrawl_callback',
        'ui.language_table',
    }
    d['symbols'] = {
        name: binding for name, binding in d['symbols'].items()
        if name not in retired and not name.startswith('observe.')
    }
    d['stubs'] = [stub for stub in d.get('stubs', []) if stub['symbol'] not in retired]
    for binding in d['symbols'].values():
        raw = binding.pop('expected', '')
        if raw: binding['guard'] = guard(raw)
        binding.pop('locator', None)
    resources = {}
    for drive, filename in document['resources'].items():
        data = (resource_root / filename).read_bytes()
        resources[drive] = {'length': len(data), 'sha256': hashlib.sha256(data).hexdigest()}
    d['resources'] = resources
    return d

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('resource_root', type=Path)
    parser.add_argument('destination', type=Path)
    parser.add_argument('--dat', type=Path, required=True)
    args = parser.parse_args()
    d = migrate(json.loads(args.source.read_text()), args.resource_root, args.dat)
    args.destination.parent.mkdir(parents=True, exist_ok=True)
    args.destination.write_text(json.dumps(d, indent=2) + '\n')

if __name__ == '__main__': main()
