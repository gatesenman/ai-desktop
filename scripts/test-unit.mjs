// Bundle + run unit tests (no test framework dependency).
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
const files = fs.readdirSync('test').filter((f) => f.endsWith('.test.ts'));
fs.mkdirSync('dist-test', { recursive: true });
for (const f of files) {
  const out = `dist-test/${f.replace(/\.ts$/, '.cjs')}`;
  await build({ entryPoints: [`test/${f}`], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'warning' });
  execFileSync(process.execPath, [out], { stdio: 'inherit' });
}
