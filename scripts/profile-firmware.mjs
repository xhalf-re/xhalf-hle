#!/usr/bin/env node
import { chromium } from '@playwright/test';
import { preview } from 'vite';
import { execFileSync } from 'node:child_process';
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  existsSync,
  copyFileSync,
  readdirSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { metrics, navigate } from '../tests/browser/performance-helpers.ts';
import {
  analyzeProfile,
  parseSymbols,
  parseSourceMaps,
  sha256,
  distribution,
  metricDelta,
  experimentSummary,
} from './performance/analyze.mjs';
import {
  sourceIdentity,
  treeIdentity,
  verifyRuntime,
  assertHashes,
  hostSnapshot,
} from './performance/identity.mjs';
import { WorkerProfiler } from './performance/worker-profiler.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
const firmwareProfile = JSON.parse(
  readFileSync(join(root, 'src/profiles/xhalf-main.json'), 'utf8'),
);
const mainMenu = firmwareProfile.ui.roles['shooting.main'];
const { values } = parseArgs({
  options: {
    pairs: { type: 'string', default: '3' },
    samples: { type: 'string', default: '100' },
    warmup: { type: 'string', default: '10' },
    'idle-ms': { type: 'string', default: '5000' },
    'interval-us': { type: 'string', default: '1000' },
    label: { type: 'string', default: 'baseline' },
    summarize: { type: 'string' },
    help: { type: 'boolean' },
  },
});
const json = (p, value) =>
  writeFileSync(p, JSON.stringify(value, null, 2) + '\n');
if (values.help) {
  console.log(
    'XHALF_DAT=... npm run profile:firmware -- [--pairs 3 --samples 100 --warmup 10 --idle-ms 5000 --interval-us 1000 --label baseline]\nOffline: npm run profile:firmware -- --summarize .private/performance/<run>\nChromium Worker sampling only; no product instrumentation.',
  );
} else if (values.summarize) {
  const dir = resolve(values.summarize),
    manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  assertHashes(dir, { [manifest.symbols.file]: manifest.symbols.sha256 });
  const symbols = parseSymbols(
    readFileSync(join(dir, manifest.symbols.file), 'utf8'),
  );
  const sourceMaps = loadSourceMaps(dir, manifest.sourceMaps ?? []);
  for (const trial of manifest.trials)
    for (const phase of Object.values(trial.phases ?? {}))
      if (phase.profile) {
        assertHashes(dir, { [phase.profile.file]: phase.profile.sha256 });
        const raw = JSON.parse(
          readFileSync(join(dir, phase.profile.file), 'utf8'),
        );
        json(
          join(dir, phase.profile.summary),
          analyzeProfile(
            raw,
            symbols,
            manifest.runtimeUrl,
            manifest.options.intervalUs,
            sourceMaps,
          ),
        );
      }
  json(join(dir, 'summary.json'), experimentSummary(manifest.trials));
  console.log(`Regenerated summaries: ${dir}`);
} else {
  await run();
}

async function run() {
  const positive = (key, max) => {
    const n = Number(values[key]);
    if (!Number.isInteger(n) || n < 1 || n > max)
      throw Error(`Invalid --${key}`);
    return n;
  };
  const options = {
    pairs: positive('pairs', 20),
    samples: positive('samples', 1000),
    warmup: positive('warmup', 100),
    idleMs: positive('idle-ms', 60000),
    intervalUs: positive('interval-us', 10000),
  };
  if (options.warmup % 2 || options.samples % 2)
    throw Error(
      'Warmup and sample counts must be even to return to the same selection',
    );
  if (!process.env.XHALF_DAT)
    throw Error('Set XHALF_DAT to the supported local firmware file');
  const dat = resolve(process.env.XHALF_DAT);
  if (!existsSync(dat)) throw Error('XHALF_DAT does not exist');
  const firmwareSha256 = sha256(readFileSync(dat));
  const label = values.label;
  if (!/^[a-zA-Z0-9_-]{1,60}$/.test(label))
    throw Error('Use a short alphanumeric --label');
  const parent = join(root, '.private/performance');
  mkdirSync(parent, { recursive: true });
  const lock = join(parent, '.active');
  try {
    mkdirSync(lock);
  } catch {
    throw Error(
      `Another profiling run owns ${lock}; inspect owner.json and its PID before removing a stale lock`,
    );
  }
  json(join(lock, 'owner.json'), {
    pid: process.pid,
    utc: new Date().toISOString(),
  });
  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${label}-${randomUUID().slice(0, 8)}`;
  const dir = join(parent, id);
  mkdirSync(dir);
  const manifest = {
    schema: 1,
    id,
    status: 'running',
    options,
    measurement:
      'production Chromium Worker CPU sampling; paired unprofiled/profiled trials',
    phases: {
      boot: 'firmware file selection to main menu ready (profile starts before Worker code)',
      navigation:
        'after fixed alternating warmup; DOM input to correct native index + idle input + current Canvas + animation frame',
      idle: 'no input on main menu for fixed wall duration after measured navigation',
    },
    firmwareSha256,
    hostStart: hostSnapshot(),
    trials: [],
    warnings: [],
    limitations: [
      'Only Chromium exposes the CDP Worker sampling used here; use test:performance separately for Firefox.',
      'Counters come from published diagnostics and may lag up to the regular metrics interval; sample windows use CDP timestamps.',
      'System load is observed, not controlled. A fresh browser/context is used per trial; OS disk caches are not flushed.',
      'The baseline has no CDP attachment. Measured overhead includes debugger attachment and sampling.',
      'This command does not collect firmware bytes, screenshots, memory dumps or guest disassembly.',
    ],
  };
  const save = () => json(join(dir, 'manifest.json'), manifest);
  save();
  let server,
    browser,
    interrupted = false;
  const interrupt = () => {
    interrupted = true;
    browser?.close().catch(() => {});
  };
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  try {
    manifest.source = sourceIdentity(root);
    save();
    try {
      const output = execFileSync(
        'npm',
        ['run', 'build', '--', '--sourcemap', 'hidden'],
        {
          cwd: root,
          stdio: ['ignore', 'pipe', 'pipe'],
          encoding: 'utf8',
        },
      );
      writeFileSync(join(dir, 'build.log'), output);
    } catch (error) {
      writeFileSync(
        join(dir, 'build.log'),
        String(error.stdout ?? '') + String(error.stderr ?? ''),
      );
      throw error;
    }
    // Maps are private diagnostic inputs, never left in the public build.
    manifest.sourceMaps = collectSourceMaps(join(root, 'dist'), dir);
    const sourceMaps = loadSourceMaps(dir, manifest.sourceMaps);
    manifest.runtime = verifyRuntime(root);
    manifest.dist = treeIdentity(join(root, 'dist'));
    if (sourceIdentity(root).digest !== manifest.source.digest)
      throw Error('Source changed during web build');
    copyFileSync(
      join(root, 'dist/runtime/dynarmic-arm.js.symbols'),
      join(dir, 'runtime.symbols'),
    );
    manifest.symbols = {
      file: 'runtime.symbols',
      sha256: sha256(readFileSync(join(dir, 'runtime.symbols'))),
    };
    const symbols = parseSymbols(
      readFileSync(join(dir, 'runtime.symbols'), 'utf8'),
    );
    server = await preview({
      configFile: false,
      root,
      base: '/xhalf-hle/',
      build: { outDir: 'dist' },
      preview: { host: '127.0.0.1', port: 0, strictPort: true },
    });
    const port = server.httpServer.address().port;
    const url = `http://127.0.0.1:${port}/xhalf-hle/`;
    manifest.runtimeUrl = new URL('runtime/dynarmic-arm.wasm', url).href;
    manifest.launch = {
      headless: true,
      executable:
        process.env.XHALF_BROWSER_EXECUTABLE ?? 'Playwright bundled Chromium',
      args: process.env.XHALF_BROWSER_NO_TRAP
        ? ['--js-flags=--no-wasm-trap-handler']
        : [],
    };
    save();
    for (let pair = 1; pair <= options.pairs; pair++) {
      for (const sampled of pair % 2 ? [false, true] : [true, false]) {
        if (interrupted) throw Error('Interrupted');
        if (
          sourceIdentity(root).digest !== manifest.source.digest ||
          treeIdentity(join(root, 'dist')).digest !== manifest.dist.digest
        )
          throw Error('Sources or served artifacts changed during experiment');
        const trial = {
          id: `pair-${pair}-${sampled ? 'sampled' : 'plain'}`,
          pair,
          sampled,
          status: 'running',
          phases: {},
          hostStart: hostSnapshot(),
        };
        manifest.trials.push(trial);
        save();
        let profiler, context, page;
        try {
          browser = await chromium.launch({
            headless: true,
            executablePath: process.env.XHALF_BROWSER_EXECUTABLE,
            args: manifest.launch.args,
          });
          trial.browserVersion = await browser.version();
          if (
            manifest.browserVersion &&
            manifest.browserVersion !== trial.browserVersion
          )
            throw Error('Browser changed between trials');
          manifest.browserVersion = trial.browserVersion;
          context = await browser.newContext({
            viewport: { width: 1280, height: 900 },
            deviceScaleFactor: 1,
          });
          page = await context.newPage();
          const errors = [];
          page.on('pageerror', (error) => errors.push(String(error)));
          page.on('crash', () => errors.push('Page crashed'));
          await page.goto(url);
          await page.bringToFront();
          trial.browserEnvironment = await page.evaluate(() => ({
            userAgent: navigator.userAgent,
            visibility: document.visibilityState,
            hardwareConcurrency: navigator.hardwareConcurrency,
          }));
          // Check what this server actually sends, not only the build directory.
          for (const [name, hash] of Object.entries(
            manifest.runtime.artifacts,
          )) {
            const response = await page.request.get(
              new URL('runtime/' + name, url).href,
            );
            if (!response.ok() || sha256(await response.body()) !== hash)
              throw Error(`Served runtime mismatch: ${name}`);
          }
          await page.locator('#manual-setup').uncheck();
          if (sampled) {
            profiler = new WorkerProfiler(
              await context.newCDPSession(page),
              options.intervalUs,
            );
            await profiler.arm();
          }
          const bootStart = performance.now();
          await page
            .getByLabel('Choose firmware', { exact: true })
            .setInputFiles(dat);
          if (profiler) {
            await Promise.race([
              profiler.ready,
              new Promise((_, reject) => {
                const t = setTimeout(
                  () => reject(Error('Firmware Worker attachment timeout')),
                  30000,
                );
                t.unref();
              }),
            ]);
            trial.workerTarget = {
              type: profiler.target.type,
              url: profiler.target.url,
              pausedBeforeExecution: true,
            };
          }
          await page.waitForFunction(
            () =>
              window.__xhalfMetrics?.menuReady === true ||
              document.querySelector('#screen-state')?.textContent ===
                'Unable to load firmware',
            null,
            { timeout: 120000 },
          );
          const bootMs = performance.now() - bootStart,
            bootMetrics = await metrics(page);
          await healthy(page, bootMetrics, errors);
          trial.phases.boot = {
            wallMs: bootMs,
            before: {},
            after: bootMetrics,
          };
          if (profiler)
            await capture('boot', trial, profiler, symbols, sourceMaps);
          console.log(`${trial.id}: cold boot ${(bootMs / 1000).toFixed(2)} s`);
          save();
          await page.locator('canvas').focus();
          const initialIndex = Number(bootMetrics.index);
          for (let i = 0; i < options.warmup; i++) await move(page, i);
          const before = await metrics(page);
          if (Number(before.index) !== initialIndex)
            throw Error('Warmup changed the starting selection');
          await healthy(page, before, errors);
          if (profiler) await profiler.start('navigation');
          const start = performance.now(),
            latencies = [];
          for (let i = 0; i < options.samples; i++)
            latencies.push(await move(page, i));
          const wallMs = performance.now() - start,
            after = await metrics(page);
          await healthy(page, after, errors);
          trial.phases.navigation = {
            wallMs,
            latencies,
            latency: distribution(latencies),
            before,
            after,
            delta: metricDelta(before, after),
          };
          if (profiler)
            await capture('navigation', trial, profiler, symbols, sourceMaps);
          console.log(
            `${trial.id}: navigation median ${trial.phases.navigation.latency.median.toFixed(1)} / P95 ${trial.phases.navigation.latency.p95.toFixed(1)} ms`,
          );
          save();
          const idleBefore = await metrics(page);
          if (profiler) await profiler.start('idle');
          const idleStart = performance.now();
          await page.waitForTimeout(options.idleMs);
          const idleWall = performance.now() - idleStart,
            idleAfter = await metrics(page);
          await healthy(page, idleAfter, errors);
          trial.phases.idle = {
            wallMs: idleWall,
            before: idleBefore,
            after: idleAfter,
            delta: metricDelta(idleBefore, idleAfter),
          };
          if (profiler)
            await capture('idle', trial, profiler, symbols, sourceMaps);
          if (Number(idleAfter.index) !== initialIndex)
            throw Error('Workload did not end on its initial selection');
          trial.status = 'complete';
        } catch (error) {
          trial.status = 'failed';
          trial.error = String(error);
          if (page && !page.isClosed()) {
            trial.failureMetrics = await metrics(page).catch(() => ({}));
            trial.failureStatus = await page
              .getByRole('status')
              .textContent()
              .catch(() => null);
          }
          throw error;
        } finally {
          if (profiler?.active) {
            try {
              await capture('failure', trial, profiler, symbols, sourceMaps);
            } catch (error) {
              trial.profileCleanupError = String(error);
            }
          }
          await profiler?.close();
          await context?.close().catch(() => {});
          await browser?.close().catch(() => {});
          browser = undefined;
          trial.hostEnd = hostSnapshot();
          save();
        }
      }
    }
    manifest.sourceEnd = sourceIdentity(root);
    manifest.distEnd = treeIdentity(join(root, 'dist'));
    if (
      manifest.source.digest !== manifest.sourceEnd.digest ||
      manifest.dist.digest !== manifest.distEnd.digest
    )
      throw Error('Source or artifact identity changed');
    manifest.status = 'complete';
    json(join(dir, 'summary.json'), experimentSummary(manifest.trials));
    console.log(`Profile evidence: ${dir}`);
  } catch (error) {
    manifest.status = 'failed';
    manifest.error = String(error);
    console.error(`Profiling failed; evidence retained at ${dir}: ${error}`);
    process.exitCode = 1;
  } finally {
    manifest.hostEnd = hostSnapshot();
    try {
      manifest.sourceEnd = sourceIdentity(root);
      manifest.distEnd = treeIdentity(join(root, 'dist'));
      manifest.identityUnchanged =
        manifest.source?.digest === manifest.sourceEnd.digest &&
        manifest.dist?.digest === manifest.distEnd.digest;
      if (manifest.status === 'complete' && !manifest.identityUnchanged) {
        manifest.status = 'failed';
        manifest.error = 'Identity changed during cleanup';
        process.exitCode = 1;
      }
    } catch (error) {
      manifest.identityCheckError = String(error);
      manifest.status = 'failed';
      process.exitCode = 1;
    }
    json(join(dir, 'summary.json'), experimentSummary(manifest.trials));
    save();
    await browser?.close().catch(() => {});
    if (server)
      await new Promise((resolve) => server.httpServer.close(resolve));
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
    rmSync(lock, { recursive: true });
  }
  async function capture(phase, trial, profiler, symbols, sourceMaps) {
    const raw = await profiler.stop(),
      file = `${trial.id}-${phase}.cpuprofile`,
      summary = `${trial.id}-${phase}-profile.json`;
    json(join(dir, file), raw);
    // Record the raw file before analysis so malformed profiles remain diagnosable.
    trial.phases[phase] ??= {};
    trial.phases[phase].profile = {
      file,
      sha256: sha256(readFileSync(join(dir, file))),
      summary,
    };
    save();
    json(
      join(dir, summary),
      analyzeProfile(
        raw,
        symbols,
        manifest.runtimeUrl,
        options.intervalUs,
        sourceMaps,
      ),
    );
  }
}
async function move(page, i) {
  const before = await metrics(page);
  const expected = Number(before.index) + (i % 2 ? -1 : 1);
  return navigate(page, i % 2 ? 'ArrowUp' : 'ArrowDown', expected);
}
async function healthy(page, state, errors) {
  if (errors.length) throw Error(errors.join('\n'));
  const status = await page.getByRole('status').textContent();
  if (
    status?.includes('ERROR') ||
    state.menu !== mainMenu ||
    state.uiRan !== true ||
    state.hostRan !== true
  )
    throw Error(`Firmware not ready: ${status}`);
  for (const key of [
    'assertions',
    'inputErrors',
    'storageErrors',
    'undefinedInstructions',
  ])
    if (state[key] !== 0) throw Error(`${key}: ${state[key]}`);
  if ((await page.evaluate(() => document.visibilityState)) !== 'visible')
    throw Error('Benchmark page lost visibility');
}

function collectSourceMaps(dist, dir) {
  const result = [];
  const walk = (folder, prefix = '') => {
    for (const name of readdirSync(folder)) {
      const path = join(folder, name),
        relative = prefix + name;
      if (statSync(path).isDirectory()) walk(path, relative + '/');
      else if (name.endsWith('.js.map')) {
        const file = 'maps/' + relative;
        mkdirSync(dirname(join(dir, file)), { recursive: true });
        copyFileSync(path, join(dir, file));
        result.push({
          file,
          sha256: sha256(readFileSync(path)),
          url: '/xhalf-hle/' + relative.slice(0, -4),
        });
        unlinkSync(path);
      }
    }
  };
  walk(dist);
  if (!result.some((r) => r.url.includes('runtime-worker-')))
    throw Error('Missing Worker source map');
  return result;
}
function loadSourceMaps(dir, records) {
  const maps = {};
  for (const r of records) {
    assertHashes(dir, { [r.file]: r.sha256 });
    maps[r.url] = JSON.parse(readFileSync(join(dir, r.file), 'utf8'));
  }
  return parseSourceMaps(maps);
}
