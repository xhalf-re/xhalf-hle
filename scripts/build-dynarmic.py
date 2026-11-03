#!/usr/bin/env python3
"""Build the standalone pinned Dynarmic ARM CPU and memory runtime."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
ROOT = Path(__file__).resolve().parent.parent
LOCK = json.loads((ROOT / 'scripts/dynarmic-source.json').read_text())
SOURCE = ROOT / '.cache' / ('dynarmic-source-' + LOCK['revision'])

def run(args, **kwargs):
    subprocess.run([str(x) for x in args], check=True, **kwargs)

if not (SOURCE / '.git').exists():
    local = os.environ.get('XHALF_DYNARMIC_SOURCE')
    if local:
        run(['git', '-C', Path(local).resolve(), 'worktree', 'add', '--detach', SOURCE, LOCK['revision']])
    else:
        run(['git', 'clone', '--no-checkout', LOCK['repository'], SOURCE])
        run(['git', '-C', SOURCE, 'checkout', '--detach', LOCK['revision']])
if subprocess.check_output(['git','-C',str(SOURCE),'rev-parse','HEAD'],text=True).strip()!=LOCK['revision']:
    raise RuntimeError('Dynarmic source revision mismatch')
run(['git','-C',SOURCE,'submodule','update','--init','--recursive'])
for patch in sorted((ROOT/'patches/dynarmic').glob('*.patch')):
    applied = subprocess.run(['git','apply','--reverse','--check',str(patch)], cwd=SOURCE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if applied.returncode: run(['git','apply',patch],cwd=SOURCE)
host = ROOT/'src/cpu/dynarmic-host.cpp'
exports = sorted(set(['_malloc', '_free'] +
    ['_'+x for x in re.findall(r'EMSCRIPTEN_KEEPALIVE\s+\w+\s*\*?\s*(dh_\w+)\(',host.read_text())] +
    ['_'+x for x in re.findall(r'dynarmic_wasm_[a-z0-9_]+', ''.join(p.read_text() for p in sorted((SOURCE/'src/dynarmic/backend/wasm').glob('thunks*.cpp'))))]))
build = ROOT/'.cache/dynarmic-build'
if '--clean' in sys.argv and (build/'out').exists(): shutil.rmtree(build/'out')
build.mkdir(parents=True,exist_ok=True)
boost = os.environ.get('XHALF_BOOST_HEADERS')
if not boost:
    cached_boost = ROOT/'.cache/boost-headers'
    if not (cached_boost/'boost/version.hpp').exists():
        cached_boost.mkdir(parents=True, exist_ok=True)
        shutil.copytree('/usr/include/boost', cached_boost/'boost', dirs_exist_ok=True)
    boost = str(cached_boost)
if '--asan' in sys.argv:
    raise RuntimeError('ASan is not supported for dynamically compiled guest Wasm blocks')
# Link into a private staging directory. Keep public/runtime itself in place:
# deleting the directory loses Vite's public-file watcher during development.
output=build/'runtime'
if output.exists(): shutil.rmtree(output)
output.mkdir(parents=True)
prefix=f'-ffile-prefix-map={ROOT}=.'
debug = '-g2 -sASSERTIONS=2 -sSTACK_OVERFLOW_CHECK=2' if '--debug' in sys.argv else ''
(build/'CMakeLists.txt').write_text(f'''cmake_minimum_required(VERSION 3.16)
project(xhalf_dynarmic LANGUAGES C CXX)
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
add_compile_options("{prefix}")
set(DYNARMIC_JS_TESTS OFF CACHE BOOL "")
set(DYNARMIC_JS_EXAMPLES OFF CACHE BOOL "")
add_subdirectory("{SOURCE}" dynarmic)
add_executable(xhalf_dynarmic "{host}")
target_link_libraries(xhalf_dynarmic PRIVATE dynarmic merry::mcl)
target_include_directories(xhalf_dynarmic PRIVATE "{boost}")
target_compile_definitions(xhalf_dynarmic PRIVATE BOOST_NO_CXX98_FUNCTION_BASE)
target_link_options(xhalf_dynarmic PRIVATE
 {debug}
 --emit-symbol-map
 -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createDynarmic
 -sENVIRONMENT=web,worker,node -sALLOW_TABLE_GROWTH=1 -sALLOW_MEMORY_GROWTH=1
 -sEXPORTED_RUNTIME_METHODS=addFunction,removeFunction
 -sINITIAL_MEMORY=33554432 -sMAXIMUM_MEMORY=1073741824 -sSTACK_SIZE=1048576
 -sEXPORTED_FUNCTIONS={','.join(exports)}
 "SHELL:--post-js {ROOT/'scripts/heap-access.js'}"
 "SHELL:--post-js {ROOT/'scripts/jit-code-cache.js'}")
set_target_properties(xhalf_dynarmic PROPERTIES OUTPUT_NAME "dynarmic-arm" RUNTIME_OUTPUT_DIRECTORY "{output}")
''')
emsdk=Path(os.environ.get('XHALF_EMSDK', os.environ.get('EMSDK', str(ROOT/'vendor/emsdk'))))
emcmake=shutil.which('emcmake') or str(emsdk/'upstream/emscripten/emcmake')
run([emcmake,'cmake','-S',build,'-B',build/'out','-DCMAKE_BUILD_TYPE=Release',f'-DBoost_INCLUDE_DIR={boost}'])
run(['cmake','--build',build/'out','-j2'])
licenses = output/'licenses'
licenses.mkdir(exist_ok=True)
for source, target in [
    (SOURCE/'LICENSE', 'dynarmic-js-LICENSE.txt'),
    (SOURCE/'THIRD_PARTY_NOTICES.md', 'dynarmic-js-THIRD-PARTY-NOTICES.md'),
    (SOURCE/'externals/dynarmic/LICENSE.txt', 'dynarmic-LICENSE.txt'),
    (SOURCE/'externals/dynarmic/externals/mcl/LICENSE', 'mcl-LICENSE.txt'),
    (SOURCE/'externals/dynarmic/externals/fmt/LICENSE.rst', 'fmt-LICENSE.txt'),
    (SOURCE/'externals/dynarmic/externals/robin-map/LICENSE', 'robin-map-LICENSE.txt'),
]:
    shutil.copyfile(source, licenses/target)

def digest(p): return hashlib.sha256(p.read_bytes()).hexdigest()
(output/'dynarmic-build.json').write_text(json.dumps({'source':LOCK,'host':digest(host),'system':digest(ROOT/'src/cpu/dynarmic-system.h'),'codeCache':digest(ROOT/'scripts/jit-code-cache.js'),'patches':{p.name:digest(p) for p in (ROOT/'patches/dynarmic').glob('*.patch')},'backend':'dynarmic','dependencies':['dynarmic.js','dynarmic','mcl','fmt','robin-map'],'artifacts':{p.name:digest(p) for p in output.glob('dynarmic-arm.*')}},indent=2)+'\n')

public = ROOT/'public/runtime'
public.mkdir(parents=True,exist_ok=True)
produced = {p.relative_to(output) for p in output.rglob('*') if p.is_file()}
for relative in sorted(produced):
    destination = public/relative
    destination.parent.mkdir(parents=True,exist_ok=True)
    shutil.copyfile(output/relative,destination)
for old in list(public.rglob('*')):
    if old.is_file() and old.relative_to(public) not in produced: old.unlink()
