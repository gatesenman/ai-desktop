// Audit: every channel the renderers invoke/listen to must be allow-listed in preload (regression from 1.2.6).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
const pre = fs.readFileSync('src/preload/preload.ts', 'utf8');
const set = (name: string) => new Set([...(pre.split(`const ${name} = new Set([`)[1].split(']')[0].matchAll(/'([^']+)'/g))].map((m) => m[1]));
const INVOKE = set('INVOKE');
const EVENTS = set('EVENTS');
const missing: string[] = [];
for (const f of fs.readdirSync('src/renderer').filter((x) => x.endsWith('.ts'))) {
  const s = fs.readFileSync(path.join('src/renderer', f), 'utf8');
  for (const m of s.matchAll(/\.invoke(?:<[^>]*>)?\(\s*'([^']+)'/g)) if (!INVOKE.has(m[1])) missing.push(`${f}: invoke ${m[1]}`);
  for (const m of s.matchAll(/\.on\(\s*'([^']+)'/g)) if (!EVENTS.has(m[1]) && m[1].includes(':')) missing.push(`${f}: on ${m[1]}`);
}
const main = fs.readFileSync('src/main/main.ts', 'utf8') + fs.readFileSync('src/main/ai.ts', 'utf8');
const unhandled = [...INVOKE].filter((c) => !main.includes(`'${c}'`));
assert.deepEqual(missing, [], 'renderer channels missing from preload');
console.log('PASS  channel audit renderer ⊆ preload (' + INVOKE.size + ' invoke, ' + EVENTS.size + ' events)');
if (unhandled.length) console.log('WARN  preload channels without a main handler:', unhandled.join(', '));
