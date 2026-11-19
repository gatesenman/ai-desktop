/**
 * Windows desktop-layer helper client (v1.3).
 *
 * ONE long-lived native helper (native/AIDeskHelper.exe, C# / .NET Framework 4.x, shipped in resources/helper) talks
 * JSON lines over stdin/stdout. If the exe is missing/blocked we fall back to compiling the SAME C# source with
 * PowerShell 5.1 `Add-Type` (slower first start, same protocol). No per-action PowerShell spawning.
 *
 * Commands: ping, bottom/attach/detach {hwnd}, icons {show}, hook {dbl,ctx,draw}, items {selected},
 *           ctxmenu {paths,x,y,extras}, nativeDesktopMenu {x,y}, dirs, quit.
 * Events:   ready, dblclick-desktop, context-desktop {x,y}, rb-start/rb-move/rb-end (physical px), hook-failed.
 *
 * On Linux smoke tests a mock helper (scripts/mock-helper.cjs) speaks the same protocol (AIDESK_MOCK_HELPER=path).
 */
import { BrowserWindow, app } from 'electron';
import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export interface HelperEvent { ev: string; [k: string]: any }
export interface DesktopIconPos { path: string; x: number; y: number }
export interface CtxExtra { id?: string; label?: string; sep?: boolean; disabled?: boolean }
export interface CtxResult { pick: 'none' | 'shell' | 'extra' | 'rename'; verb?: string | null; extra?: string | null; partial?: boolean }

const MOCK = process.env.AIDESK_MOCK_HELPER || '';
const isWin = process.platform === 'win32';
const supported = isWin || !!MOCK;

let proc: ChildProcessWithoutNullStreams | null = null;
let ready = false;
let failedExe = false;
let failedAll = false;
let mode: 'exe' | 'powershell' | 'mock' | 'none' = 'none';
let restarts = 0;
let seq = 0;
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
const queue: string[] = [];
let eventHandler: ((ev: HelperEvent) => void) | null = null;
let hookCfg = { dbl: false, ctx: false, draw: 'off' as 'off' | 'left' | 'right' };
let iconsHidden = false;
let lastError = '';
let unavailableHandler: ((err: string) => void) | null = null;
let unavailableFired = false;

function resourcesDir(): string {
  return app.isPackaged ? process.resourcesPath : path.join(app.getAppPath(), 'native');
}
function exePath(): string {
  const a = path.join(resourcesDir(), 'helper', 'AIDeskHelper.exe');
  if (fs.existsSync(a)) return a;
  return path.join(resourcesDir(), 'AIDeskHelper.exe');
}
function csPath(): string {
  const a = path.join(resourcesDir(), 'helper', 'AIDeskHelper.cs');
  if (fs.existsSync(a)) return a;
  return path.join(resourcesDir(), 'AIDeskHelper.cs');
}

function start(): ChildProcessWithoutNullStreams | null {
  if (!supported || failedAll) return null;
  if (proc && !proc.killed) return proc;
  ready = false;
  try {
    if (MOCK) {
      mode = 'mock';
      proc = spawn(process.execPath, [MOCK], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
    } else if (!failedExe && fs.existsSync(exePath())) {
      mode = 'exe';
      proc = spawn(exePath(), [], { windowsHide: true });
    } else {
      mode = 'powershell';
      const cs = csPath();
      if (!fs.existsSync(cs)) throw new Error('helper source missing: ' + cs);
      const ps = `$ErrorActionPreference='Stop'; Add-Type -Path '${cs.replace(/'/g, "''")}' -ReferencedAssemblies System.Windows.Forms,System.Drawing; [AIDesk.Program]::Run()`;
      proc = spawn('powershell.exe', ['-NoProfile', '-NoLogo', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', ps], { windowsHide: true });
    }
  } catch (e: any) {
    lastError = String(e?.message ?? e);
    onDead(true);
    return null;
  }
  const p = proc;
  const startedAt = Date.now();
  p.on('error', (e) => {
    lastError = String(e?.message ?? e);
    console.warn('[helper] error', mode, e);
    if (proc === p) onDead(true);
  });
  p.on('exit', (code) => {
    if (proc !== p) return;
    const early = !ready || Date.now() - startedAt < 3000;
    console.warn('[helper] exit', mode, code, early ? '(early)' : '');
    onDead(early);
  });
  p.stderr.on('data', (d) => {
    const s = String(d).trim();
    if (s) lastError = s.slice(0, 400);
  });
  let buf = '';
  p.stdout.setEncoding('utf8');
  p.stdout.on('data', (d: string) => {
    buf += d;
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) onLine(line);
    }
  });
  return p;
}

function onDead(early: boolean) {
  proc = null;
  ready = false;
  for (const [, w] of pending) {
    clearTimeout(w.timer);
    w.reject(new Error('helper exited'));
  }
  pending.clear();
  if (early) {
    if (mode === 'exe') failedExe = true; // next start() tries PowerShell Add-Type fallback
    else failedAll = mode !== 'mock' || failedAll;
  }
  if (!failedAll && restarts < 4 && (hookCfg.dbl || hookCfg.ctx || hookCfg.draw !== 'off' || iconsHidden)) {
    restarts++;
    setTimeout(() => {
      start();
    }, 800 * restarts);
  } else if ((failedAll || restarts >= 4) && !unavailableFired && mode !== 'mock') {
    // Tell the app once so it can explain degraded features instead of failing silently.
    unavailableFired = true;
    try {
      unavailableHandler?.(lastError || 'helper exited');
    } catch {
      /* ignore */
    }
  }
}

function onLine(line: string) {
  let msg: any;
  try {
    msg = JSON.parse(line);
  } catch {
    console.log('[helper]', line);
    return;
  }
  if (msg.ev === 'ready') {
    ready = true;
    restarts = 0;
    // re-apply state after (re)start
    write({ cmd: 'hook', ...hookCfg });
    if (iconsHidden) write({ cmd: 'icons', show: false });
    while (queue.length) proc?.stdin.write(queue.shift()!);
    eventHandler?.(msg);
    return;
  }
  if (msg.ev) {
    eventHandler?.(msg);
    return;
  }
  const w = pending.get(msg.id);
  if (!w) return;
  pending.delete(msg.id);
  clearTimeout(w.timer);
  if (msg.ok) w.resolve(msg);
  else w.reject(new Error(msg.error || 'helper error'));
}

function write(obj: any) {
  const line = JSON.stringify(obj) + '\n';
  const p = start();
  if (!p) return false;
  try {
    if (ready) p.stdin.write(line);
    else queue.push(line);
    return true;
  } catch {
    return false;
  }
}

function request<T = any>(cmd: string, args: Record<string, any> = {}, timeoutMs = 4000): Promise<T> {
  return new Promise((resolve, reject) => {
    if (!supported || failedAll) return reject(new Error('helper unavailable'));
    const id = ++seq;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`helper timeout: ${cmd}`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    if (!write({ id, cmd, ...args })) {
      clearTimeout(timer);
      pending.delete(id);
      reject(new Error('helper unavailable'));
    }
  });
}

export function hwndOf(win: BrowserWindow): string {
  const buf = win.getNativeWindowHandle();
  return buf.length >= 8 ? buf.readBigUInt64LE(0).toString() : String(buf.readUInt32LE(0));
}

function sendHwnd(cmd: string, win: BrowserWindow) {
  if (!isWin || win.isDestroyed()) return;
  write({ cmd, hwnd: hwndOf(win) });
}

export const winLayer = {
  supported,
  get mode() {
    return mode;
  },
  get alive() {
    return !!proc && ready;
  },
  get lastError() {
    return lastError;
  },
  onEvent: (fn: (ev: HelperEvent) => void) => {
    eventHandler = fn;
  },
  /** Called once when the native helper is given up on (exe and PowerShell fallback both failed). */
  onUnavailable: (fn: (err: string) => void) => {
    unavailableHandler = fn;
  },
  /** Configure the low-level mouse hook: double-click hide, in-app desktop menu, rubber-band drawing button. */
  configureHook: (cfg: { dbl: boolean; ctx: boolean; draw: 'off' | 'left' | 'right' }) => {
    if (!supported) return;
    const changed = cfg.dbl !== hookCfg.dbl || cfg.ctx !== hookCfg.ctx || cfg.draw !== hookCfg.draw;
    hookCfg = { ...cfg };
    const need = cfg.dbl || cfg.ctx || cfg.draw !== 'off';
    if (!changed && proc) return;
    if (!need && !proc) return;
    if (ready) write({ cmd: 'hook', ...hookCfg });
    else start(); // the 'ready' handler applies hookCfg
  },
  /** hide / show the system desktop icons (quick-hide); best effort */
  setDesktopIcons: (show: boolean) => {
    if (!isWin && !MOCK) return;
    iconsHidden = !show;
    if (proc || !show) write({ cmd: 'icons', show });
  },
  sendToBottom: (w: BrowserWindow) => sendHwnd('bottom', w),
  attachToDesktop: (w: BrowserWindow) => sendHwnd('attach', w),
  detachFromDesktop: (w: BrowserWindow) => sendHwnd('detach', w),
  ping: () => request<{ ver: string }>('ping', {}, 8000),
  /** Desktop icons with screen positions (physical px). selected=true -> only the current selection. */
  desktopItems: (selected = false) => request<{ items: DesktopIconPos[]; spacing: { x: number; y: number } }>('items', { selected }, 3000),
  /** Native Explorer context menu for files (IContextMenu) with our extra items on top. x/y physical px. */
  contextMenu: (paths: string[], x: number, y: number, extras: CtxExtra[]) => request<CtxResult>('ctxmenu', { paths, x, y, extras }, 120000),
  /** Show the original Windows desktop background menu (replays a right click past our hook). */
  nativeDesktopMenu: (x: number, y: number) => write({ cmd: 'nativeDesktopMenu', x, y }),
  knownDirs: () => request<{ desktop: string | null; publicDesktop: string | null }>('dirs', {}, 5000),
  /** Explorer-compatible file clipboard (CF_HDROP + Preferred DropEffect). */
  setClipboardFiles: (paths: string[], cut: boolean) => request<{ count: number }>('clipset', { paths, cut }, 5000),
  getClipboardFiles: async () => (await request<{ paths: string[]; cut: boolean }>('clipget', {}, 5000)).paths ?? [],
  dispose: () => {
    try {
      if (iconsHidden && proc) proc.stdin.write(JSON.stringify({ cmd: 'icons', show: true }) + '\n');
      proc?.stdin.end();
    } catch {
      /* ignore */
    }
    const p = proc;
    setTimeout(() => {
      try {
        p?.kill();
      } catch {
        /* ignore */
      }
    }, 300);
    proc = null;
  },
};
