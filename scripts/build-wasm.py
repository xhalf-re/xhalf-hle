#!/usr/bin/env python3
"""Pinned Unicorn.js ARM build. Downloads source, never firmware or resources."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shlex
import shutil
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
    source = ROOT / 'vendor/unicorn-js'
    patched = source / 'unicorn/.xhle-patched'
    if not patched.exists():
        # Only this generated, ignored source tree is reset after interrupted patching.
        shutil.rmtree(source / 'unicorn')
        (source / 'unicorn').mkdir()
        run(['tar', '-xzf', ROOT / '.cache/downloads/unicorn.tar.gz', '-C', source / 'unicorn', '--strip-components=1'])
        (source / 'unicorn/.xhle-source').write_text(LOCK['sources'][1]['sha256'])
    # git apply otherwise discovers the outer repo and silently skips ignored vendor paths.
    if not (source / 'unicorn/.git').exists():
        run(['git', 'init', '--quiet', source / 'unicorn'])
    os.chdir(source)
    spec = importlib.util.spec_from_file_location('unicorn_js_build', source / 'build.py')
    upstream = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(upstream)
    if not patched.exists():
        upstream.patchUnicorn()
    elif patched.read_text() != LOCK['sources'][0]['revision']:
        raise RuntimeError('patched source revision differs; remove generated vendor tree and rebuild')
    if '__EMSCRIPTEN__' not in (source / 'unicorn/CMakeLists.txt').read_text():
        raise RuntimeError('required upstream TCI patch was not applied')
    patched.write_text(LOCK['sources'][0]['revision'])
    for patch in sorted((ROOT / 'patches').glob('*.patch')):
        already = subprocess.run(['git', 'apply', '--reverse', '--check', patch], cwd=source / 'unicorn', stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if already.returncode != 0:
            run(['git', 'apply', patch], cwd=source / 'unicorn')
    upstream.generateConstants()
    asan = '--asan' in sys.argv
    build = source / ('unicorn/build-asan' if asan else 'unicorn/build')
    # __FILE__, assertions and debug information must use portable source names.
    # Apply this while compiling the archive as well as the final Wasm helper.
    prefix_flags = [f'-ffile-prefix-map={ROOT}=.']
    compile_flags = shlex.join(prefix_flags + (['-fsanitize=address', '-g3'] if asan else []))
    # Incremental CMake is deterministic; --clean removes only this generated tree.
    if '--clean' in sys.argv and build.exists(): shutil.rmtree(build)
    run(['emcmake', 'cmake', '-S', source / 'unicorn', '-B', build,
         '-DCMAKE_BUILD_TYPE=Release', '-DBUILD_SHARED_LIBS=OFF', '-DUNICORN_ARCH=arm',
         '-DUNICORN_BUILD_TESTS=OFF', '-DUNICORN_INSTALL=OFF', '-DUNICORN_FUZZ=OFF',
         '-DUNICORN_LEGACY_STATIC_ARCHIVE=ON',
         f'-DCMAKE_C_FLAGS={compile_flags}', f'-DCMAKE_CXX_FLAGS={compile_flags}'], env=env)
    run(['cmake', '--build', build, '--target', 'unicorn_archive', '-j2'], env=env)
    output = ROOT / 'public/runtime'
    output.mkdir(parents=True, exist_ok=True)
    debug_flags = ['-g2', '-sASSERTIONS=2', '-sSTACK_OVERFLOW_CHECK=2'] if '--debug' in sys.argv or asan else []
    if asan: debug_flags += ['-fsanitize=address']
    run(['emcc', '-O3', *prefix_flags, *debug_flags, '-I', source / 'unicorn/include', ROOT / 'src/cpu/slice.c', build / 'libunicorn.a',
         '-sEXPORTED_FUNCTIONS=' + json.dumps(upstream.EXPORTED_FUNCTIONS + ['_xhle_slice_create', '_xhle_slice_run', '_xhle_slice_destroy', '_xhle_arm_clock_configure', '_xhle_arm_clock_advance', '_xhle_arm_clock_deadline', '_xhle_arm_set_irq', '_xhle_slice_clock_configure', '_xhle_slice_clock_deadline', '_xhle_slice_clock_now', '_xhle_slice_clock_idle', '_xhle_slice_charged', '_xhle_arm_is_waiting']),
         '-sEXPORTED_RUNTIME_METHODS=' + json.dumps(['ccall','getValue','setValue','addFunction','removeFunction','writeArrayToMemory']),
         '-sALLOW_TABLE_GROWTH=1', '-sALLOW_MEMORY_GROWTH=1', '-sINITIAL_MEMORY=33554432',
         '-sMAXIMUM_MEMORY=1073741824', '-sSTACK_SIZE=1048576',
         '-sMODULARIZE=1', '-sEXPORT_ES6=1', '-sWASM_BIGINT=1', '-sENVIRONMENT=web,worker,node',
         '-sEXPORT_NAME=MUnicorn', '--post-js', source / 'src/constants_arm.js',
         '--post-js', source / 'src/unicorn-wrapper.js', '--post-js', ROOT / 'scripts/heap-access.js',
         '-o', output / 'unicorn-arm.js'], env=env)
    licenses = output / 'licenses'
    licenses.mkdir(exist_ok=True)
    for name, path in [('unicorn-js-GPL-2.0.txt', source / 'LICENSE'),
                       ('unicorn-COPYING.txt', source / 'unicorn/COPYING'),
                       ('unicorn-COPYING.LGPL2.txt', source / 'unicorn/COPYING.LGPL2'),
                       ('unicorn-COPYING_GLIB.txt', source / 'unicorn/COPYING_GLIB'),
                       ('unicorn-AUTHORS.txt', source / 'unicorn/AUTHORS.TXT'),
                       ('unicorn-CREDITS.txt', source / 'unicorn/CREDITS.TXT')]:
        if not path.exists(): raise RuntimeError('missing license/source attribution: ' + str(path))
        shutil.copyfile(path, licenses / name)
    metadata = {'sources': LOCK, 'helpers': {'src/cpu/slice.c': hashlib.sha256((ROOT / 'src/cpu/slice.c').read_bytes()).hexdigest()}, 'patches': {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted((ROOT / 'patches').glob('*.patch'))}, 'artifacts': {p.name: hashlib.sha256(p.read_bytes()).hexdigest()
                for p in sorted(output.glob('unicorn-arm.*'))}}
    (output / 'build.json').write_text(json.dumps(metadata, indent=2) + '\n')
    print(json.dumps(metadata['artifacts'], indent=2))

if __name__ == '__main__': main()
