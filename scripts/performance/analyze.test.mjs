import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  analyzeProfile,
  parseSymbols,
  distribution,
  experimentSummary,
  sha256,
} from './analyze.mjs';
import { assertHashes, verifyRuntime } from './identity.mjs';
const runtime = 'http://127.0.0.1:123/runtime/dynarmic-arm.wasm';
const node = (id, name, url = '', children = []) => ({
  id,
  callFrame: { functionName: name, url, lineNumber: 0, columnNumber: 0 },
  children,
});
const profile = () => ({
  startTime: 100,
  endTime: 11100,
  nodes: [
    node(1, '(root)', '', [2, 4, 5, 6]),
    node(2, 'wasm-function[8]', runtime, [3]),
    node(3, 'wasm-function[8]', runtime),
    node(4, 'wasm-function[8]', 'wasm://wasm/other'),
    node(5, '(idle)'),
    node(6, 'wasm-function[77]', runtime),
  ],
  samples: [3, 4, 5, 6],
  timeDeltas: [1000, 2000, 3000, 4000],
});
test('weights observations, resolves only matching runtime and deduplicates recursive inclusive frames', () => {
  const r = analyzeProfile(
    profile(),
    parseSymbols('8:Host::interested(unsigned int, unsigned int)'),
    runtime,
  );
  assert.equal(r.sampledMs, 10);
  assert.equal(r.busySampledMs, 7);
  assert.equal(r.tailUnassignedMs, 1);
  assert.equal(r.self.find((r) => r.group === 'hook lookup').ms, 1);
  assert.equal(r.inclusive.find((r) => r.group === 'hook lookup').ms, 1);
  assert.equal(r.self.find((r) => r.group === 'generated Wasm').ms, 2);
  assert.equal(
    r.self.find((r) => r.group === 'unresolved native runtime').ms,
    4,
  );
  assert.equal(
    r.groups.reduce((a, b) => a + b.ms, 0),
    10,
  );
});
test('invalid timing, samples, stacks and duplicate symbols fail closed', () => {
  assert.throws(() =>
    analyzeProfile({ ...profile(), timeDeltas: [1] }, new Map(), runtime),
  );
  assert.throws(() =>
    analyzeProfile(
      { ...profile(), samples: [99, 4, 5, 6] },
      new Map(),
      runtime,
    ),
  );
  assert.throws(() =>
    analyzeProfile(
      { ...profile(), timeDeltas: [-100, 2, 3, 4] },
      new Map(),
      runtime,
    ),
  );
  const cycle = profile();
  cycle.nodes[2].children = [2];
  assert.throws(() => analyzeProfile(cycle, new Map(), runtime));
  assert.throws(() => parseSymbols('1:a\n1:b'));
});
test('reports sampling gaps and nearest-rank P95 explicitly', () => {
  const p = profile();
  p.timeDeltas = [6000, 1000, 1000, 1000];
  assert.equal(analyzeProfile(p, new Map(), runtime, 1000).longGapMs, 6);
  assert.deepEqual(distribution([4, 1, 3, 2]), {
    count: 4,
    min: 1,
    median: 2.5,
    p95: 4,
    max: 4,
    mean: 2.5,
  });
});
test('profiler overhead uses complete matching pairs and exposes failures', () => {
  const make = (id, pair, sampled, mult) => ({
    id,
    pair,
    sampled,
    status: 'complete',
    phases: {
      boot: { wallMs: 100 * mult },
      idle: { wallMs: 50 * mult },
      navigation: { latency: { median: 10 * mult, p95: 20 * mult } },
    },
  });
  const r = experimentSummary([
    make('a', 1, false, 1),
    make('b', 1, true, 1.2),
    make('c', 2, true, 2),
    { id: 'd', pair: 2, sampled: false, status: 'failed' },
  ]);
  assert.equal(r.pairs.length, 1);
  assert.equal(r.failedTrials, 1);
  assert.equal(r.overhead.navigation.p95.median, 1.2);
});
test('artifact validation detects mismatched symbols and refuses path escape', () => {
  const dir = mkdtempSync(join(tmpdir(), 'xhalf-profile-'));
  try {
    writeFileSync(join(dir, 'runtime.symbols'), '1:before');
    const expected = { 'runtime.symbols': sha256('1:before') };
    assert.doesNotThrow(() => assertHashes(dir, expected));
    writeFileSync(join(dir, 'runtime.symbols'), '1:after');
    assert.throws(() => assertHashes(dir, expected), /identity mismatch/);
    assert.throws(() => assertHashes(dir, { '../escape': 'x' }), /escapes/);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('production JS frames resolve through their own captured source map', async () => {
  const { parseSourceMaps } = await import('./analyze.mjs');
  const maps = parseSourceMaps({
    '/xhalf-hle/assets/worker.js': {
      version: 3,
      sources: ['../../src/sdk/graphics.ts'],
      names: ['draw'],
      mappings: 'AAAAA',
      sourcesContent: ['draw()'],
    },
  });
  const p = {
    startTime: 0,
    endTime: 1000,
    nodes: [node(1, 'a', 'http://127.0.0.1/xhalf-hle/assets/worker.js')],
    samples: [1],
    timeDeltas: [1000],
  };
  const r = analyzeProfile(p, new Map(), runtime, 1000, maps);
  assert.equal(r.self[0].source.file, 'src/sdk/graphics.ts');
  assert.equal(r.self[0].source.name, 'draw');
  assert.equal(r.self[0].group, 'JS graphics/display');
  p.nodes[0].callFrame.url = 'http://127.0.0.1/xhalf-hle/assets/different.js';
  assert.equal(
    analyzeProfile(p, new Map(), runtime, 1000, maps).self[0].group,
    'JavaScript',
  );
});

test('microsecond CDP timestamp jitter is bounded, reported and never silently discarded', () => {
  const p = profile();
  p.timeDeltas = [1000, -2, 3000, 4000];
  const r = analyzeProfile(p, new Map(), runtime);
  assert.equal(r.negativeDeltaCount, 1);
  assert.equal(r.negativeDeltaCorrectionUs, 2);
  assert.equal(r.sampledMs, 8);
  assert.equal(r.rawSignedDurationMs, 7.998);
  p.timeDeltas[1] = -11;
  assert.throws(() => analyzeProfile(p, new Map(), runtime));
});

test('instrumented runtimes require explicit profiling opt-in', () => {
  const dir = mkdtempSync(join(tmpdir(), 'xhalf-instrumentation-'));
  try {
    const files = {
      'scripts/dynarmic-source.json': JSON.stringify({ revision: 'fixture' }),
      'src/cpu/dynarmic-host.cpp': 'host fixture',
      'src/cpu/dynarmic-system.h': 'system fixture',
      'scripts/jit-code-cache.js': 'cache fixture',
      'public/runtime/fixture.js': 'runtime fixture',
      'dist/runtime/fixture.js': 'runtime fixture',
    };
    for (const [name, contents] of Object.entries(files)) {
      const path = join(dir, name);
      mkdirSync(path.slice(0, path.lastIndexOf('/')), { recursive: true });
      writeFileSync(path, contents);
    }
    mkdirSync(join(dir, 'patches/dynarmic'), { recursive: true });
    const build = {
      backend: 'dynarmic',
      source: { revision: 'fixture' },
      host: sha256('host fixture'),
      system: sha256('system fixture'),
      codeCache: sha256('cache fixture'),
      patches: {},
      artifacts: { 'fixture.js': sha256('runtime fixture') },
      instrumentation: { nativeHooks: true },
    };
    const manifest = join(dir, 'public/runtime/dynarmic-build.json');
    writeFileSync(manifest, JSON.stringify(build));
    assert.throws(() => verifyRuntime(dir), /explicit diagnostic opt-in/);
    assert.equal(
      verifyRuntime(dir, { allowInstrumentation: true }).instrumentation
        .nativeHooks,
      true,
    );
    build.instrumentation.nativeHooks = false;
    writeFileSync(manifest, JSON.stringify(build));
    assert.equal(verifyRuntime(dir).instrumentation.nativeHooks, false);
  } finally {
    rmSync(dir, { recursive: true });
  }
});
