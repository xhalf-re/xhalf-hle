import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import os from 'node:os';
import { sha256 } from './analyze.mjs';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
export function sourceIdentity(root) {
  const names = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { cwd: root, encoding: 'utf8' },
  ).split('\0');
  const files = Object.fromEntries(
    [...new Set(names)]
      .filter((n) =>
        /^(src\/|scripts\/|tests\/|patches\/)|^(package.*\.json|vite\.config\.ts|tsconfig\.json|playwright\.config\.ts)$/.test(
          n,
        ),
      )
      .sort()
      .map((n) => [
        n,
        existsSync(join(root, n)) ? sha256(readFileSync(join(root, n))) : null,
      ]),
  );
  return {
    head: git('rev-parse', 'HEAD'),
    branch: git('branch', '--show-current'),
    dirty: !!git('status', '--porcelain'),
    files,
    digest: sha256(JSON.stringify(files)),
  };
}
export function treeIdentity(root) {
  const files = {};
  const walk = (dir, prefix = '') => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name),
        rel = prefix + name;
      if (statSync(p).isDirectory()) walk(p, rel + '/');
      else files[rel] = sha256(readFileSync(p));
    }
  };
  walk(root);
  return { files, digest: sha256(JSON.stringify(files)) };
}
export function assertHashes(root, expected) {
  for (const [relative, hash] of Object.entries(expected)) {
    if (
      resolve(root, relative) !== resolve(root) &&
      !resolve(root, relative).startsWith(resolve(root) + '/')
    )
      throw Error('Artifact path escapes root');
    if (
      !existsSync(join(root, relative)) ||
      sha256(readFileSync(join(root, relative))) !== hash
    )
      throw Error(`Artifact identity mismatch: ${relative}`);
  }
}
export function verifyRuntime(root, { allowInstrumentation = false } = {}) {
  const build = JSON.parse(
    readFileSync(join(root, 'public/runtime/dynarmic-build.json'), 'utf8'),
  );
  const lock = JSON.parse(
    readFileSync(join(root, 'scripts/dynarmic-source.json'), 'utf8'),
  );
  if (
    build.backend !== 'dynarmic' ||
    JSON.stringify(build.source) !== JSON.stringify(lock)
  )
    throw Error('Runtime source lock mismatch; rebuild Wasm');
  if (build.instrumentation?.nativeHooks && !allowInstrumentation)
    throw Error(
      'Instrumented runtime requires explicit diagnostic opt-in; rebuild without XHALF_PROFILE_HOOKS',
    );
  assertHashes(root, {
    'src/cpu/dynarmic-host.cpp': build.host,
    'src/cpu/dynarmic-system.h': build.system,
    'scripts/jit-code-cache.js': build.codeCache,
    ...Object.fromEntries(
      Object.entries(build.patches).map(([n, h]) => [
        'patches/dynarmic/' + n,
        h,
      ]),
    ),
  });
  const patches = readdirSync(join(root, 'patches/dynarmic'))
    .filter((n) => n.endsWith('.patch'))
    .sort();
  if (
    JSON.stringify(patches) !==
    JSON.stringify(Object.keys(build.patches).sort())
  )
    throw Error('Runtime patch set mismatch');
  for (const directory of ['public/runtime', 'dist/runtime'])
    assertHashes(join(root, directory), build.artifacts);
  return build;
}
export function hostSnapshot() {
  const optional = (path) => {
    try {
      return readFileSync(path, 'utf8').trim();
    } catch {
      return null;
    }
  };
  return {
    utc: new Date().toISOString(),
    node: process.version,
    platform: os.platform(),
    arch: os.arch(),
    cpus: os.cpus().length,
    cpuModel: os.cpus()[0]?.model,
    totalMemory: os.totalmem(),
    freeMemory: os.freemem(),
    loadAverage: os.loadavg(),
    governor: optional('/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor'),
    meminfo: optional('/proc/meminfo'),
    cpuStat: optional('/proc/stat'),
  };
}
