/**
 * Windows desktop-background cascading context menu (HKCU only, no elevation).
 * Registers under DesktopBackground\Shell\AIDesktop with SubCommands="" so Explorer
 * shows a cascade of AI Desktop actions that relaunch the exe with --action=.
 */
import { app } from 'electron';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const SHELL_MENU_ROOT = 'HKCU\\Software\\Classes\\DesktopBackground\\Shell\\AIDesktop';

export interface ShellMenuItem {
  id: string;
  action: string;
  label: string;
  icon?: string; // remix hint for docs; Windows uses exe/.ico
}

/** Ordered cascade items (id prefix sorts in Explorer). */
export const SHELL_MENU_ITEMS: ShellMenuItem[] = [
  { id: '01newmanual', action: 'new-manual-fence', label: '新建自定义容器' },
  { id: '02mapfolder', action: 'map-folder', label: '映射文件夹…' },
  { id: '03organize', action: 'organize', label: '一键整理' },
  { id: '04aiorganize', action: 'ai-organize', label: 'AI 智能整理…' },
  { id: '05togglehide', action: 'toggle-hide', label: '显示 / 隐藏格子' },
  { id: '06search', action: 'search', label: '快速搜索 / AI 命令' },
  { id: '07aihub', action: 'ai-hub', label: 'AI 工作台' },
  { id: '08snapshot', action: 'new-snapshot', label: '保存布局快照' },
  { id: '09settings', action: 'settings', label: '设置' },
];

function reg(args: string[]): { ok: boolean; out: string } {
  const r = spawnSync('reg.exe', args, { encoding: 'utf8', windowsHide: true });
  const out = `${r.stdout || ''}${r.stderr || ''}`.trim();
  return { ok: r.status === 0, out };
}

/** Path used in registry command / Icon. Prefer packaged exe; fall back to electron. */
export function shellMenuTarget(): { exe: string; icon: string } {
  const exe = process.execPath;
  const candidates = [
    path.join(path.dirname(exe), 'resources', 'app.asar.unpacked', 'build', 'icon.ico'),
    path.join(path.dirname(exe), 'icon.ico'),
    path.join(__dirname, '..', 'assets', 'icon.png'),
    path.join(app.getAppPath(), 'build', 'icon.ico'),
    path.join(process.cwd(), 'build', 'icon.ico'),
  ];
  const ico = candidates.find((p) => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  });
  return { exe, icon: ico || exe };
}

export function isDesktopShellMenuRegistered(): boolean {
  if (process.platform !== 'win32') return false;
  const r = reg(['query', SHELL_MENU_ROOT, '/v', 'MUIVerb']);
  return r.ok;
}

export function unregisterDesktopShellMenu(): { ok: boolean; detail: string } {
  if (process.platform !== 'win32') return { ok: true, detail: 'skipped (not Windows)' };
  const r = reg(['delete', SHELL_MENU_ROOT, '/f']);
  // delete returns non-zero if missing — treat as ok
  if (r.ok || /unable to find|找不到|ERROR: The system was unable to find/i.test(r.out)) {
    return { ok: true, detail: 'removed' };
  }
  return { ok: false, detail: r.out || 'reg delete failed' };
}

export function registerDesktopShellMenu(): { ok: boolean; detail: string; exe: string } {
  if (process.platform !== 'win32') return { ok: false, detail: 'skipped (not Windows)', exe: '' };
  const { exe, icon } = shellMenuTarget();
  unregisterDesktopShellMenu();
  const steps: { ok: boolean; out: string }[] = [];
  steps.push(reg(['add', SHELL_MENU_ROOT, '/v', 'MUIVerb', '/d', 'AI 桌面整理', '/f']));
  steps.push(reg(['add', SHELL_MENU_ROOT, '/v', 'Icon', '/d', icon, '/f']));
  // Empty SubCommands = cascade from child shell\* keys
  steps.push(reg(['add', SHELL_MENU_ROOT, '/v', 'SubCommands', '/d', '', '/f']));
  steps.push(reg(['add', SHELL_MENU_ROOT, '/v', 'Position', '/d', 'Bottom', '/f']));

  for (const it of SHELL_MENU_ITEMS) {
    const key = `${SHELL_MENU_ROOT}\\shell\\${it.id}`;
    const cmdKey = `${key}\\command`;
    // Quote exe; action is a simple token
    const cmdline = `"${exe}" --action=${it.action}`;
    steps.push(reg(['add', key, '/v', 'MUIVerb', '/d', it.label, '/f']));
    steps.push(reg(['add', key, '/v', 'Icon', '/d', icon, '/f']));
    steps.push(reg(['add', cmdKey, '/ve', '/d', cmdline, '/f']));
  }

  const failed = steps.filter((s) => !s.ok);
  if (failed.length) {
    return { ok: false, detail: failed.map((f) => f.out).join(' | ').slice(0, 400), exe };
  }
  return { ok: true, detail: `registered ${SHELL_MENU_ITEMS.length} items → ${exe}`, exe };
}

/** Map CLI --action= tokens onto internal runCommand ids. */
export function normalizeShellAction(raw: string): string | null {
  const a = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/^--+/, '');
  if (!a) return null;
  const map: Record<string, string> = {
    'new-manual-fence': 'new-manual',
    'new-manual': 'new-manual',
    manual: 'new-manual',
    'map-folder': 'portal',
    portal: 'portal',
    organize: 'organize',
    'ai-organize': 'ai-organize',
    'toggle-hide': 'toggle-boxes',
    'toggle-boxes': 'toggle-boxes',
    search: 'search',
    settings: 'settings',
    'ai-hub': 'hub',
    hub: 'hub',
    'new-snapshot': 'snapshot-save',
    'snapshot-save': 'snapshot-save',
    snapshot: 'snapshot-save',
    'fence-from-selection': 'fence-from-selection',
    'lock-all': 'lock-all',
  };
  return map[a] ?? (SHELL_MENU_ITEMS.some((i) => i.action === a) ? a : null);
}

export function parseActionFromArgv(argv: string[]): string | null {
  for (const a of argv) {
    if (a.startsWith('--action=')) return normalizeShellAction(a.slice('--action='.length));
    if (a === '--action') continue;
  }
  // support `--action foo` form
  const i = argv.indexOf('--action');
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('-')) return normalizeShellAction(argv[i + 1]);
  return null;
}
