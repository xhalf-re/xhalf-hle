import { createHash } from 'node:crypto';
import { SourceMap } from 'node:module';

export const sha256 = (bytes) =>
  createHash('sha256').update(bytes).digest('hex');

export function parseSymbols(text) {
  const result = new Map();
  for (const line of text.trim().split('\n')) {
    const match = /^(\d+):(.+)$/.exec(line);
    if (!match) throw Error('Malformed Wasm symbol map');
    const index = Number(match[1]);
    if (result.has(index)) throw Error(`Duplicate symbol ${index}`);
    result.set(index, match[2]);
  }
  return result;
}

export function parseSourceMaps(payloads) {
  return new Map(
    Object.entries(payloads).map(([url, payload]) => [
      url,
      new SourceMap(payload),
    ]),
  );
}

function jsCategory(source) {
  if (/src\/sdk\/(graphics|display|acceleration)\.ts$/.test(source))
    return 'JS graphics/display';
  if (/src\/cpu\//.test(source)) return 'JS CPU/memory adapter';
  if (/src\/(devices|services)\//.test(source)) return 'JS devices/services';
  if (/src\/(runtime|worker)\//.test(source)) return 'JS runtime/scheduling';
  if (/src\/firmware\//.test(source)) return 'JS firmware loading';
  if (/src\/sdk\//.test(source)) return 'JS SDK/input';
  return 'other mapped JavaScript';
}

export function distribution(values) {
  if (!values.length || values.some((v) => !Number.isFinite(v)))
    throw Error('Expected finite, nonempty measurements');
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return {
    count: values.length,
    min: sorted[0],
    median:
      sorted.length % 2
        ? sorted[middle]
        : (sorted[middle - 1] + sorted[middle]) / 2,
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
    max: sorted.at(-1),
    mean: sorted.reduce((sum, v) => sum + v, 0) / sorted.length,
  };
}

function category(symbol) {
  if (/__hash_table.*::find|AddressSpace::Get(?:OrEmit)?\(/.test(symbol))
    return 'block lookup';
  if (/Host::interested|Host::index_hooks/.test(symbol)) return 'hook lookup';
  if (/Host::AddTicks|Host::update_clock|ArmSystem::advance/.test(symbol))
    return 'clock accounting';
  if (/Host::GetTicksRemaining/.test(symbol)) return 'board boundary';
  if (/^dh_run$|Host::run\(|::Core<.*::Run\(/.test(symbol))
    return 'dispatcher (includes inlined work)';
  if (
    /Host::execute_system|ArmSystem::(?:exception|cp15|set_cpsr)/.test(symbol)
  )
    return 'privileged CPU';
  if (
    /Host::(?:read\(|write\(|transfer\(|valid\()|^dh_(?:read|write)$/.test(
      symbol,
    )
  )
    return 'host memory';
  if (
    /GenerateIR|::TranslatorVisitor::|::Optimization::|::Emit|::RegAlloc::|::ModuleBuilder::/.test(
      symbol,
    )
  )
    return 'JIT translation/emission';
  return 'other native runtime';
}

/** Sampling attribution, not a hardware CPU-time counter. timeDeltas weight
 * observations; the unobserved final tail is explicitly left unassigned. */
export function analyzeProfile(
  profile,
  symbols,
  runtimeUrl,
  intervalUs = 1000,
  sourceMaps = new Map(),
) {
  const { nodes, samples, timeDeltas, startTime, endTime } = profile;
  if (
    !Array.isArray(nodes) ||
    !Array.isArray(samples) ||
    !samples.length ||
    !Array.isArray(timeDeltas) ||
    samples.length !== timeDeltas.length ||
    !Number.isFinite(startTime) ||
    !Number.isFinite(endTime) ||
    endTime < startTime ||
    timeDeltas.some(
      (n) => !Number.isFinite(n) || n < -Math.min(10, intervalUs / 100),
    )
  )
    throw Error('Invalid CPU profile timing');
  // CDP can emit a few -1/-2 us deltas from timestamp ordering jitter.
  // Retain the signed total and report every clipped microsecond explicitly.
  const weights = timeDeltas.map((n) => Math.max(0, n));
  const negativeDeltas = timeDeltas.filter((n) => n < 0);
  const byId = new Map(),
    parents = new Map(),
    frames = new Map();
  for (const node of nodes) {
    if (byId.has(node.id)) throw Error('Duplicate CPU profile node');
    byId.set(node.id, node);
    const frame = node.callFrame;
    const match = /^wasm-function\[(\d+)\]$/.exec(frame.functionName);
    let name = frame.functionName || '(anonymous)',
      group,
      url = frame.url || '';
    if (url === runtimeUrl && match) {
      name =
        symbols.get(Number(match[1])) ?? `unresolved runtime index ${match[1]}`;
      group = symbols.has(Number(match[1]))
        ? category(name)
        : 'unresolved native runtime';
      url = 'runtime/dynarmic-arm.wasm';
    } else if (url.startsWith('wasm://') && match) {
      name = 'generated Wasm (guest blocks or engine wrappers)';
      group = 'generated Wasm';
      url = 'wasm://generated';
    } else if (name === '(idle)') group = 'idle';
    else if (name === '(garbage collector)') group = 'garbage collection';
    else if (name === '(program)' || name === '(root)') group = 'unattributed';
    else if (match) group = 'unresolved Wasm';
    else if (['Module', 'Instance'].includes(name) && !url)
      group = 'Wasm engine compile/instantiate';
    else if (url) group = 'JavaScript';
    else group = 'unknown/native engine';
    let source;
    if (group === 'JavaScript') {
      let pathname;
      try {
        pathname = new URL(url).pathname;
      } catch {
        pathname = url;
      }
      const map = sourceMaps.get(pathname);
      if (map) {
        const entry = map.findEntry(frame.lineNumber, frame.columnNumber);
        if (entry.originalSource) {
          source = {
            file: entry.originalSource.replace(/^(\.\.\/)+/, ''),
            line: entry.originalLine + 1,
            column: entry.originalColumn + 1,
            name: entry.name || null,
          };
          group = jsCategory(source.file);
        }
      } else if (pathname.endsWith('/runtime/dynarmic-arm.js'))
        group = 'JS Wasm glue/compilation';
    }
    const key =
      group === 'generated Wasm'
        ? group
        : JSON.stringify([name, url, frame.lineNumber, frame.columnNumber]);
    frames.set(node.id, {
      key,
      name,
      group,
      url,
      line: frame.lineNumber,
      column: frame.columnNumber,
      source,
    });
    for (const child of node.children ?? []) {
      if (parents.has(child)) throw Error('Multiple CPU profile parents');
      parents.set(child, node.id);
    }
  }
  for (const [child] of parents)
    if (!byId.has(child)) throw Error('Missing CPU profile child');
  const self = new Map(),
    inclusive = new Map(),
    groups = new Map();
  const add = (map, key, amount) => map.set(key, (map.get(key) ?? 0) + amount);
  let idleUs = 0,
    unattributedUs = 0,
    longGapUs = 0;
  samples.forEach((id, i) => {
    const frame = frames.get(id),
      dt = weights[i];
    if (!frame) throw Error('Unknown sampled node');
    add(self, frame.key, dt);
    add(groups, frame.group, dt);
    if (frame.group === 'idle') idleUs += dt;
    if (frame.group === 'unattributed') unattributedUs += dt;
    if (dt > intervalUs * 5) longGapUs += dt;
    const seenFrames = new Set(),
      seenIds = new Set();
    for (let cursor = id; cursor !== undefined; cursor = parents.get(cursor)) {
      if (seenIds.has(cursor)) throw Error('Cyclic CPU profile stack');
      seenIds.add(cursor);
      const parent = frames.get(cursor);
      if (!parent) throw Error('Missing CPU profile parent');
      if (!seenFrames.has(parent.key)) add(inclusive, parent.key, dt);
      seenFrames.add(parent.key);
    }
  });
  const sampledUs = weights.reduce((a, b) => a + b, 0),
    durationUs = endTime - startTime;
  const busyUs = sampledUs - idleUs - unattributedUs;
  const unique = new Map([...frames.values()].map((v) => [v.key, v]));
  const rows = (table) =>
    [...table]
      .sort((a, b) => b[1] - a[1])
      .map(([key, us]) => ({
        ...unique.get(key),
        ms: us / 1000,
        sampledPct: sampledUs ? (100 * us) / sampledUs : 0,
        busyPct: busyUs ? (100 * us) / busyUs : 0,
      }));
  return {
    schema: 1,
    sampleCount: samples.length,
    negativeDeltaCount: negativeDeltas.length,
    negativeDeltaCorrectionUs: -negativeDeltas.reduce((a, b) => a + b, 0),
    rawSignedDurationMs: timeDeltas.reduce((a, b) => a + b, 0) / 1000,
    requestedIntervalUs: intervalUs,
    durationMs: durationUs / 1000,
    sampledMs: sampledUs / 1000,
    busySampledMs: busyUs / 1000,
    idleMs: idleUs / 1000,
    unattributedMs: unattributedUs / 1000,
    tailUnassignedMs: Math.max(0, durationUs - sampledUs) / 1000,
    timingExcessMs: Math.max(0, sampledUs - durationUs) / 1000,
    longGapMs: longGapUs / 1000,
    deltaUs: distribution(weights),
    groups: [...groups]
      .sort((a, b) => b[1] - a[1])
      .map(([name, us]) => ({
        name,
        ms: us / 1000,
        sampledPct: (100 * us) / sampledUs,
        busyPct: ['idle', 'unattributed'].includes(name)
          ? null
          : busyUs
            ? (100 * us) / busyUs
            : 0,
      })),
    self: rows(self),
    inclusive: rows(inclusive),
    caveats: [
      'Inclusive rows overlap; recursive frames are counted once per sample.',
      'Busy sampled time excludes idle and unattributed samples, includes GC and unknown frames; it is not measured process CPU time.',
      'Long sample gaps can include descheduling or blocked engine work; inspect their weight before attributing CPU cost.',
      'Generated Wasm names may include small engine-generated wrappers. Inlined work remains charged to its enclosing function.',
      'These are Worker-only samples. Main-thread rendering and compositor work are not captured.',
    ],
  };
}

export function metricDelta(before, after) {
  const keys = [
    'instructions',
    'jitInstructions',
    'systemInstructions',
    'irqEntries',
    'mmioReads',
    'mmioWrites',
    'hookHits',
    'graphicsMs',
    'frames',
    'nativeFrames',
    'memoryCalls',
    'rasterCalls',
    'jitCompiledBlocks',
    'jitCompileMs',
    'jitTranslateMs',
    'jitEmitMs',
    'jitReleasedBlocks',
    'jitCompileRetries',
    'jitPackedModules',
    'storageReadBytes',
    'storageWriteBytes',
  ];
  return Object.fromEntries(
    keys
      .filter((k) => Number.isFinite(before[k]) && Number.isFinite(after[k]))
      .map((k) => [k, after[k] - before[k]]),
  );
}

export function experimentSummary(trials) {
  const complete = trials.filter((t) => t.status === 'complete'),
    pairs = [];
  for (const pair of new Set(complete.map((t) => t.pair))) {
    const normal = complete.find((t) => t.pair === pair && !t.sampled),
      sampled = complete.find((t) => t.pair === pair && t.sampled);
    if (!normal || !sampled) continue;
    const ratios = {};
    for (const phase of ['boot', 'navigation', 'idle']) {
      const a = normal.phases[phase],
        b = sampled.phases[phase];
      if (!a || !b) continue;
      ratios[phase] =
        phase === 'navigation'
          ? {
              median: b.latency.median / a.latency.median,
              p95: b.latency.p95 / a.latency.p95,
            }
          : { wall: b.wallMs / a.wallMs };
    }
    pairs.push({ pair, ratios });
  }
  return {
    schema: 1,
    completedTrials: complete.length,
    failedTrials: trials.length - complete.length,
    pairs,
    latencyByRun: complete.map((t) => ({
      id: t.id,
      sampled: t.sampled,
      bootMs: t.phases.boot.wallMs,
      navigation: t.phases.navigation.latency,
    })),
    overhead: Object.fromEntries(
      ['boot', 'navigation', 'idle'].map((phase) => [
        phase,
        Object.fromEntries(
          (phase === 'navigation' ? ['median', 'p95'] : ['wall']).map((k) => [
            k,
            pairs.length
              ? distribution(pairs.map((p) => p.ratios[phase][k]))
              : null,
          ]),
        ),
      ]),
    ),
    note: 'Overhead ratios are sampled / unsampled within each alternating-order pair. Repeat spread is reported; profiles are not latency acceptance.',
  };
}
