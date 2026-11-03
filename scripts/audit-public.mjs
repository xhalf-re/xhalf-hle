import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
  .split('\0')
  .filter((name) => name && existsSync(name));
const forbidden =
  /(?:^|\/)(?:\.private|artifacts|test-results|playwright-report)\/|\.(?:dat|elf|img|snap|ppm|png|trace|cpuprofile)$/i;
const failures = tracked.filter((name) => forbidden.test(name));
function inspect(path) {
  const stat = statSync(path);
  if (stat.isDirectory()) {
    for (const name of readdirSync(path)) inspect(join(path, name));
    return;
  }
  const bytes = readFileSync(path);
  // Containers and snapshots must never be present in a public build.
  if (
    bytes.subarray(0, 15).toString().startsWith('SUNP BURN FILE') ||
    bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
  )
    failures.push(path);
  if (forbidden.test(path)) failures.push(path);
}
for (const name of tracked) inspect(name);
try {
  inspect('dist');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
// A historical binary in public/runtime would otherwise be silently published.
for (const root of ['public/runtime', 'dist/runtime']) {
  if (!existsSync(root)) continue;
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const file = join(dir, name);
      if (/unicorn/i.test(name)) failures.push(file);
      if (statSync(file).isDirectory()) walk(file);
    }
  };
  walk(root);
  const manifest = join(root, 'dynarmic-build.json');
  if (!existsSync(manifest)) {
    failures.push(`${root}: missing runtime identity`);
    continue;
  }
  const build = JSON.parse(readFileSync(manifest, 'utf8'));
  if (build.backend !== 'dynarmic' || /unicorn/i.test(JSON.stringify(build)))
    failures.push(`${root}: retired runtime dependency`);
  const symbols = join(root, 'dynarmic-arm.js.symbols');
  if (
    !existsSync(symbols) ||
    /(?:^\d+:uc_|unicorn|qemu|tcg_)/im.test(readFileSync(symbols, 'utf8'))
  )
    failures.push(`${root}: missing symbols or retired engine symbols`);
}
if (failures.length) {
  console.error('Public boundary audit failed:', [...new Set(failures)]);
  process.exit(1);
}
console.log(
  `Public boundary audit: ${tracked.length} tracked files and available build inspected.`,
);
