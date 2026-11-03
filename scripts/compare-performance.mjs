#!/usr/bin/env node
import { chromium } from '@playwright/test';
import { preview } from 'vite';
import { parseArgs } from 'node:util';
import { execFileSync } from 'node:child_process';
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  cpSync,
} from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { metrics, navigate } from '../tests/browser/performance-helpers.ts';
import { sha256, distribution } from './performance/analyze.mjs';
import {
  sourceIdentity,
  treeIdentity,
  verifyRuntime,
  assertHashes,
  hostSnapshot,
} from './performance/identity.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
const { values } = parseArgs({
  options: {
    snapshot: { type: 'string' },
    'allow-instrumentation': { type: 'boolean' },
    baseline: { type: 'string' },
    candidate: { type: 'string' },
    pairs: { type: 'string', default: '3' },
    samples: { type: 'string', default: '100' },
    warmup: { type: 'string', default: '10' },
  },
});
const parent = join(root, '.private/performance');
mkdirSync(parent, { recursive: true });
const json = (p, v) => writeFileSync(p, JSON.stringify(v, null, 2) + '\n');
const lock = join(parent, '.active');
try {
  mkdirSync(lock);
} catch {
  throw Error(
    'A performance run is active; inspect .private/performance/.active/owner.json',
  );
}
json(join(lock, 'owner.json'), {
  pid: process.pid,
  utc: new Date().toISOString(),
});
const stamp = () =>
  new Date().toISOString().replace(/[:.]/g, '-') +
  '-' +
  randomUUID().slice(0, 8);
try {
  if (values.snapshot) {
    if (!/^[\w-]{1,60}$/.test(values.snapshot))
      throw Error('Invalid snapshot label');
    const source = sourceIdentity(root);
    execFileSync('npm', ['run', 'build'], { stdio: 'pipe' });
    const runtime = verifyRuntime(root, {
        allowInstrumentation: values['allow-instrumentation'],
      }),
      dist = treeIdentity(join(root, 'dist'));
    if (sourceIdentity(root).digest !== source.digest)
      throw Error('Sources changed while snapshotting');
    const dir = join(parent, 'snapshots', stamp() + '-' + values.snapshot);
    mkdirSync(dir, { recursive: true });
    cpSync(join(root, 'dist'), join(dir, 'dist'), { recursive: true });
    json(join(dir, 'snapshot.json'), {
      schema: 1,
      label: values.snapshot,
      source,
      runtime,
      dist,
      firmwareProfile: JSON.parse(
        readFileSync('src/profiles/xhalf-main.json', 'utf8'),
      ).firmware,
    });
    console.log(`Snapshot: ${dir}`);
  } else await compare();
} finally {
  rmSync(lock, { recursive: true });
}

async function compare() {
  const load = (path) => {
    if (!path)
      throw Error('Use --snapshot LABEL or --baseline DIR --candidate DIR');
    const dir = resolve(path),
      metadata = JSON.parse(readFileSync(join(dir, 'snapshot.json'), 'utf8'));
    assertHashes(join(dir, 'dist'), metadata.dist.files);
    if (treeIdentity(join(dir, 'dist')).digest !== metadata.dist.digest)
      throw Error('Snapshot contains changed/extra files');
    return { dir, metadata };
  };
  const snapshots = {
    baseline: load(values.baseline),
    candidate: load(values.candidate),
  };
  if (
    !values['allow-instrumentation'] &&
    Object.values(snapshots).some(
      (s) => s.metadata.runtime.instrumentation?.nativeHooks,
    )
  )
    throw Error('Counter-build comparison requires --allow-instrumentation');
  if (
    snapshots.baseline.metadata.dist.digest ===
    snapshots.candidate.metadata.dist.digest
  )
    throw Error('Baseline and candidate artifacts are identical');
  const integer = (s, max) => {
    const n = Number(s);
    if (!Number.isInteger(n) || n < 1 || n > max)
      throw Error('Invalid workload option');
    return n;
  };
  const options = {
    pairs: integer(values.pairs, 20),
    samples: integer(values.samples, 1000),
    warmup: integer(values.warmup, 100),
  };
  if (options.samples % 2 || options.warmup % 2)
    throw Error('Use even navigation counts');
  const dat = resolve(process.env.XHALF_DAT ?? '');
  const firmwareSha256 = sha256(readFileSync(dat));
  for (const { metadata } of Object.values(snapshots))
    if (firmwareSha256 !== metadata.firmwareProfile.package_sha256)
      throw Error('Snapshot firmware mismatch');
  const dir = join(parent, 'comparison-' + stamp());
  mkdirSync(dir);
  const manifest = {
    schema: 1,
    status: 'running',
    options,
    firmwareSha256,
    source: sourceIdentity(root),
    snapshots,
    measurement:
      'Unprofiled alternating baseline/candidate; shared visible-frame endpoint; fresh browser per trial',
    trials: [],
    hostStart: hostSnapshot(),
  };
  const save = () => json(join(dir, 'manifest.json'), manifest);
  save();
  const servers = {},
    urls = {};
  let browser,
    interrupted = false;
  const interrupt = () => {
    interrupted = true;
    browser?.close().catch(() => {});
  };
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  try {
    for (const [kind, snapshot] of Object.entries(snapshots)) {
      servers[kind] = await preview({
        configFile: false,
        root: snapshot.dir,
        base: '/xhalf-hle/',
        build: { outDir: 'dist' },
        preview: { host: '127.0.0.1', port: 0, strictPort: true },
      });
      urls[kind] =
        `http://127.0.0.1:${servers[kind].httpServer.address().port}/xhalf-hle/`;
    }
    manifest.launch = {
      executable:
        process.env.XHALF_BROWSER_EXECUTABLE ?? 'Playwright bundled Chromium',
      args: process.env.XHALF_BROWSER_NO_TRAP
        ? ['--js-flags=--no-wasm-trap-handler']
        : [],
    };
    for (let pair = 1; pair <= options.pairs; pair++)
      for (const kind of pair % 2
        ? ['baseline', 'candidate']
        : ['candidate', 'baseline']) {
        if (interrupted) throw Error('Interrupted');
        const trial = {
          pair,
          kind,
          status: 'running',
          hostStart: hostSnapshot(),
        };
        manifest.trials.push(trial);
        save();
        try {
          browser = await chromium.launch({
            headless: true,
            executablePath: process.env.XHALF_BROWSER_EXECUTABLE,
            args: manifest.launch.args,
          });
          const version = await browser.version();
          if (manifest.browserVersion && version !== manifest.browserVersion)
            throw Error('Browser changed');
          manifest.browserVersion = version;
          const context = await browser.newContext({
            viewport: { width: 1280, height: 900 },
            deviceScaleFactor: 1,
          });
          const page = await context.newPage(),
            errors = [];
          page.on('pageerror', (e) => errors.push(String(e)));
          page.on('crash', () => errors.push('Page crashed'));
          await page.goto(urls[kind]);
          await page.bringToFront();
          await page.locator('#manual-setup').uncheck();
          for (const [name, hash] of Object.entries(
            snapshots[kind].metadata.runtime.artifacts,
          )) {
            const response = await page.request.get(
              new URL('runtime/' + name, urls[kind]).href,
            );
            if (!response.ok() || sha256(await response.body()) !== hash)
              throw Error('Served snapshot mismatch');
          }
          const start = performance.now();
          await page
            .getByLabel('Choose firmware', { exact: true })
            .setInputFiles(dat);
          await page.waitForFunction(
            () =>
              window.__xhalfMetrics?.menuReady === true ||
              document.querySelector('#screen-state')?.textContent ===
                'Unable to load firmware',
            null,
            { timeout: 120000 },
          );
          trial.bootMs = performance.now() - start;
          if ((await metrics(page)).menuReady !== true)
            throw Error(await page.getByRole('status').textContent());
          await page.locator('canvas').focus();
          const move = async (i) => {
            const state = await metrics(page);
            return navigate(
              page,
              i % 2 ? 'ArrowUp' : 'ArrowDown',
              Number(state.index) + (i % 2 ? -1 : 1),
            );
          };
          for (let i = 0; i < options.warmup; i++) await move(i);
          trial.before = await metrics(page);
          trial.latencies = [];
          const navStart = performance.now();
          for (let i = 0; i < options.samples; i++)
            trial.latencies.push(await move(i));
          trial.wallMs = performance.now() - navStart;
          trial.after = await metrics(page);
          trial.latency = distribution(trial.latencies);
          for (const key of [
            'assertions',
            'inputErrors',
            'storageErrors',
            'undefinedInstructions',
          ])
            if (trial.after[key] !== 0)
              throw Error(`${key}: ${trial.after[key]}`);
          if (errors.length) throw Error(errors.join('\n'));
          if (
            (await page.evaluate(() => document.visibilityState)) !== 'visible'
          )
            throw Error('Page hidden');
          trial.status = 'complete';
          console.log(
            `pair ${pair} ${kind}: boot ${(trial.bootMs / 1000).toFixed(2)}s median ${trial.latency.median.toFixed(1)}ms P95 ${trial.latency.p95.toFixed(1)}ms`,
          );
        } catch (error) {
          trial.status = 'failed';
          trial.error = String(error);
          throw error;
        } finally {
          await browser?.close().catch(() => {});
          browser = undefined;
          trial.hostEnd = hostSnapshot();
          save();
        }
      }
    if (sourceIdentity(root).digest !== manifest.source.digest)
      throw Error('Comparison code/source changed');
    for (const snapshot of Object.values(snapshots))
      if (
        treeIdentity(join(snapshot.dir, 'dist')).digest !==
        snapshot.metadata.dist.digest
      )
        throw Error('Snapshot changed during comparison');
    const pairs = [];
    for (let i = 1; i <= options.pairs; i++) {
      const a = manifest.trials.find(
          (t) => t.pair === i && t.kind === 'baseline',
        ),
        b = manifest.trials.find((t) => t.pair === i && t.kind === 'candidate');
      pairs.push({
        pair: i,
        bootRatio: b.bootMs / a.bootMs,
        medianRatio: b.latency.median / a.latency.median,
        p95Ratio: b.latency.p95 / a.latency.p95,
        instructionRatio:
          (b.after.instructions - b.before.instructions) /
          (a.after.instructions - a.before.instructions),
      });
    }
    manifest.status = 'complete';
    json(join(dir, 'summary.json'), {
      pairs,
      ratios: Object.fromEntries(
        ['bootRatio', 'medianRatio', 'p95Ratio', 'instructionRatio'].map(
          (k) => [k, distribution(pairs.map((p) => p[k]))],
        ),
      ),
      note: 'Ratios are candidate/baseline. No CPU sampling or assumed statistical significance.',
    });
  } catch (error) {
    manifest.status = 'failed';
    manifest.error = String(error);
    console.error(error);
    process.exitCode = 1;
  } finally {
    await browser?.close().catch(() => {});
    for (const server of Object.values(servers))
      await new Promise((resolve) => server.httpServer.close(resolve));
    manifest.hostEnd = hostSnapshot();
    save();
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
  }
  console.log(`Comparison evidence: ${dir}`);
}
