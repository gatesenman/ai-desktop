// Mock of native/AIDeskHelper.exe for Linux smoke tests: same JSON-lines protocol, fake desktop icon grid.
const readline = require('node:readline');
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const icons = [];
let clip = { paths: [], cut: false };
const dir = process.env.AI_DESKTOP_DIR || '/tmp/fdesk';
try {
  const fs = require('node:fs');
  const path = require('node:path');
  fs.readdirSync(dir).slice(0, 40).forEach((n, i) => icons.push({ path: path.join(dir, n), x: 20 + (i % 4) * 80, y: 20 + Math.floor(i / 4) * 96 }));
} catch {}
out({ ev: 'ready', ver: 'mock', pid: process.pid });
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  const ok = (extra) => m.id != null && out({ id: m.id, ok: true, ...extra });
  switch (m.cmd) {
    case 'ping': return ok({ ver: 'mock' });
    case 'items': return ok({ items: m.selected ? icons.slice(0, 3) : icons, spacing: { x: 80, y: 96 } });
    case 'ctxmenu': return ok({ pick: process.env.AIDESK_MOCK_PICK || 'none', verb: null, extra: process.env.AIDESK_MOCK_EXTRA || null, partial: false });
    case 'dirs': return ok({ desktop: dir, publicDesktop: null });
    case 'clipset': clip = { paths: m.paths || [], cut: !!m.cut }; return ok({ count: clip.paths.length });
    case 'clipget': return ok(clip);
    case 'hook':
      ok({ active: !!(m.dbl || m.ctx || m.draw !== 'off') });
      if (m.draw && m.draw !== 'off' && process.env.AIDESK_MOCK_RB) {
        // simulate a rubber-band drag over the first icons
        setTimeout(() => out({ ev: 'rb-start', x: 10, y: 10, btn: m.draw }), 300);
        setTimeout(() => out({ ev: 'rb-move', x: 120, y: 90 }), 360);
        setTimeout(() => out({ ev: 'rb-end', x1: 10, y1: 10, x2: 190, y2: 130, btn: m.draw }), 420);
      }
      return;
    case 'quit': process.exit(0);
    default: return m.id != null ? out({ id: m.id, ok: true }) : undefined;
  }
});
rl.on('close', () => process.exit(0));
