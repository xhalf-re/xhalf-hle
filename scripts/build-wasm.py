#!/usr/bin/env python3
"""Bootstrap the pinned Emscripten toolchain and build the standalone ARM runtime."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parent.parent
LOCK = json.loads((ROOT / 'scripts/wasm-sources.json').read_text())

def run(args, **kwargs):
    subprocess.run([str(a) for a in args], check=True, **kwargs)

def fetch_sources():
    for item in LOCK['sources']:
        archive = ROOT / '.cache/downloads' / (item['name'] + '.tar.gz')
        archive.parent.mkdir(parents=True, exist_ok=True)
        if not archive.exists():
            run(['curl', '--http1.1', '-fsSL', '--retry', '3', '--connect-timeout', '15', '--max-time', '300',
                 f"https://api.github.com/repos/{item['repository']}/tarball/{item['revision']}", '-o', archive])
        if hashlib.sha256(archive.read_bytes()).hexdigest() != item['sha256']:
            raise RuntimeError('source archive digest mismatch: ' + item['name'])
        destination = ROOT / item['destination']
        marker = destination / '.xhle-source'
        if marker.exists():
            if marker.read_text() != item['sha256']:
                raise RuntimeError('source tree identity mismatch: ' + str(destination))
            continue
        destination.mkdir(parents=True, exist_ok=True)
        run(['tar', '-xzf', archive, '-C', destination, '--strip-components=1'])
        marker.write_text(item['sha256'])

def main():
    selected = os.environ.get('XHALF_EMSDK') or os.environ.get('EMSDK')
    if selected:
        emsdk = Path(selected).resolve()
    else:
        fetch_sources()
        emsdk = ROOT / 'vendor/emsdk'
        run([sys.executable, emsdk / 'emsdk.py', 'install', LOCK['emscripten']])
        run([sys.executable, emsdk / 'emsdk.py', 'activate', LOCK['emscripten']])
    env = os.environ.copy()
    env['PATH'] = str(emsdk / 'upstream/emscripten') + os.pathsep + env['PATH']
    env['EMSDK'] = str(emsdk)
    env['EM_CONFIG'] = str(emsdk / '.emscripten')
    env['SOURCE_DATE_EPOCH'] = '1760486400'
    if subprocess.check_output(['cmake', '--version'], text=True).splitlines()[0] != 'cmake version 4.0.2':
        raise RuntimeError('build requires CMake 4.0.2; install with: python3 -m pip install cmake==4.0.2')
    run([sys.executable, ROOT / 'scripts/build-dynarmic.py', *sys.argv[1:]], env=env)

if __name__ == '__main__': main()
