import { existsSync, readFileSync, writeFileSync } from 'node:fs';
const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
const packages = Object.keys(lock.packages)
  .filter(Boolean)
  .map((path) => {
    const installed = existsSync(`${path}/package.json`);
    const p = installed
      ? JSON.parse(readFileSync(`${path}/package.json`, 'utf8'))
      : lock.packages[path];
    return {
      name: p.name ?? path.split('node_modules/').at(-1),
      version: p.version,
      license: p.license ?? 'UNDECLARED',
      source: lock.packages[path].resolved,
      installed,
    };
  });
writeFileSync(
  'docs/dependency-licenses.json',
  `${JSON.stringify(packages, null, 2)}\n`,
);
console.log(`${packages.length} locked dependency licenses recorded.`);
