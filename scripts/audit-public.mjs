import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
  .split('\0')
  .filter((name) => name && existsSync(name));
const forbidden =
  /(?:^|\/)(?:\.private|artifacts|test-results|playwright-report)\/|\.(?:dat|elf|img|snap|ppm|png|trace)$/i;
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
if (failures.length) {
  console.error('Public boundary audit failed:', [...new Set(failures)]);
  process.exit(1);
}
console.log(
  `Public boundary audit: ${tracked.length} tracked files and available build inspected.`,
);
