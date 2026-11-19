import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const dist = path.join(root, 'dist');
const prod = process.argv.includes('--prod');
fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(path.join(dist, 'renderer', 'fonts'), { recursive: true });
fs.mkdirSync(path.join(dist, 'assets'), { recursive: true });

const common = { bundle: true, sourcemap: !prod, minify: prod, logLevel: 'warning', target: 'es2022' };
await build({ ...common, entryPoints: ['src/main/main.ts'], outfile: 'dist/main.js', platform: 'node', format: 'cjs', external: ['electron'], packages: 'external' });
await build({ ...common, entryPoints: ['src/preload/preload.ts'], outfile: 'dist/preload.js', platform: 'node', format: 'cjs', external: ['electron'] });
await build({
  ...common,
  entryPoints: ['fence', 'search', 'chat', 'settings', 'appearance', 'toast', 'onboarding', 'guides', 'pager', 'hub', 'help', 'rubber'].map((n) => `src/renderer/${n}.ts`),
  outdir: 'dist/renderer',
  platform: 'browser',
  format: 'iife',
});
for (const f of fs.readdirSync(path.join(root, 'static'))) fs.copyFileSync(path.join(root, 'static', f), path.join(dist, 'renderer', f));
// Icon font (Remix Icon, Apache-2.0) bundled locally: no CDN, works offline.
const ri = path.join(root, 'node_modules', 'remixicon', 'fonts');
let css = fs.readFileSync(path.join(ri, 'remixicon.css'), 'utf8');
// keep only woff2/woff/ttf sources
css = css.replace(/@font-face\s*{[^}]*}/, `@font-face {\n  font-family: "remixicon";\n  src: url("remixicon.woff2") format("woff2"), url("remixicon.woff") format("woff");\n  font-display: block;\n}`);
fs.writeFileSync(path.join(dist, 'renderer', 'fonts', 'remixicon.css'), css);
for (const f of ['remixicon.woff2', 'remixicon.woff']) fs.copyFileSync(path.join(ri, f), path.join(dist, 'renderer', 'fonts', f));
fs.copyFileSync(path.join(root, 'node_modules', 'remixicon', 'License'), path.join(dist, 'renderer', 'fonts', 'LICENSE-remixicon.txt'));
fs.copyFileSync(path.join(root, 'build', 'icon.png'), path.join(dist, 'assets', 'icon.png'));
fs.copyFileSync(path.join(root, 'build', 'icon.png'), path.join(dist, 'renderer', 'icon.png'));
console.log('build ok');
