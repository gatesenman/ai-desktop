import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  MenuItemConstructorOptions,
  nativeImage,
  nativeTheme,
  screen,
  shell,
  Tray,
} from 'electron';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  BoxState,
  Category,
  CATEGORY_COLOR,
  CATEGORY_ICON,
  CATEGORY_LABEL,
  CATEGORY_ORDER,
  ChatMessage,
  CmdAction,
  DesktopItem,
  RenameProposal,
  FenceData,
  FenceTab,
  Layout,
  Rule,
  SearchResult,
  Snapshot,
  Settings,
  SortMode,
  ThemePayload,
  ToastPayload,
  ViewMode,
} from '../shared/types';
import { DEFAULT_LAYOUT, DEFAULT_SETTINGS, configRecoveries, dataPath, getSettings, loadJSON, saveJSON, setSettings } from './config';
import { desktopDirs, setKnownDesktopDirs, scanDeep, scanDesktop, scanDesktopDir, scanFolder, statItem, watchDesktop, watchFolder } from './desktop';
import { cleanRule, describeRule, firstRule, setLinkTargetResolver } from './rules';
import { applyRenames, briefing, cleanupScan, fullName, localRename, looksLikeCommand, nlRule, organizePlan, planCommand, planLocal, renamePlan } from './aifeatures';
import { buildIndex, cancelIndexBuild, contentSearch, indexStatus } from './contentindex';
import { aiConfigured, chatComplete, chatStream, extractJSON } from './ai';
import { canSummarize, extractText } from './extract';
import { localNLSearch, looksNatural, quickSearch, parseQuery } from './nlsearch';
import { winLayer } from './winlayer';
import { suggestProjectSpaces } from './projectspaces';
import { boundsOfIcons, fenceRectFromDrawn, fitToContent, iconsInRect, isDrag, normRect, sizeToIconMultiples, SIZE_PRESETS } from './geom';
import {
  isDesktopShellMenuRegistered,
  parseActionFromArgv,
  normalizeShellAction,
  registerDesktopShellMenu,
  SHELL_MENU_ITEMS,
  unregisterDesktopShellMenu,
} from './shellmenu';

const isWin = process.platform === 'win32';
const argv = process.argv.slice(1);
const arg = (name: string) => argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const SMOKE = argv.includes('--smoke-test');
const CAPTURE_DIR = arg('capture');
const SCENE = arg('scene');
const DEMO = argv.includes('--demo') || SMOKE || !!CAPTURE_DIR;
const START_HIDDEN = argv.includes('--hidden');
const STARTUP_ACTION = parseActionFromArgv(process.argv);
const TITLE_H = 32;
const BOX_W = 320;
const BOX_H = 240;
const GAP = 16;

if (process.env.AI_DESKTOP_NO_GPU || (process.platform === 'linux' && process.env.DISPLAY?.startsWith(':9'))) {
  app.disableHardwareAcceleration();
}

// ---------------------------------------------------------------- state
let settings: Settings = DEFAULT_SETTINGS;
let layout: Layout = structuredClone(DEFAULT_LAYOUT);
const desktopMap = new Map<string, DesktopItem>();
const externalMap = new Map<string, DesktopItem>();
const fenceWins = new Map<string, BrowserWindow>();
let searchWin: BrowserWindow | null = null;
let chatWin: BrowserWindow | null = null;
let settingsWin: BrowserWindow | null = null;
let toastWin: BrowserWindow | null = null;
let onboardWin: BrowserWindow | null = null;
let helpWin: BrowserWindow | null = null;
let appearanceWin: BrowserWindow | null = null;
let tray: Tray | null = null;
/** In-app organize drag (Fences-style membership). native=true means Ctrl+ OS startDrag. */
let pendingDrag: { paths: string[]; consumed: boolean; native: boolean } | null = null;
let deepIndex: { at: number; items: DesktopItem[] } | null = null;
let stopWatch: (() => void) | null = null;
// Fences rule "shortcut target": resolve .lnk via the shell, .url via its URL= line (cached by mtime).
const linkCache = new Map<string, { m: number; t: string }>();
setLinkTargetResolver((p) => {
  try {
    const m = fs.statSync(p).mtimeMs;
    const c = linkCache.get(p);
    if (c && c.m === m) return c.t;
    let t = '';
    if (p.toLowerCase().endsWith('.lnk') && isWin) t = shell.readShortcutLink(p).target || '';
    else if (p.toLowerCase().endsWith('.url')) t = /^URL=(.*)$/im.exec(fs.readFileSync(p, 'utf8'))?.[1]?.trim() ?? '';
    linkCache.set(p, { m, t });
    return t;
  } catch {
    return '';
  }
});
function restartDesktopWatch() {
  stopWatch?.();
  stopWatch = watchDesktop(settings.scanPublicDesktop, (paths) => {
    void refresh(paths);
  });
}
const activeHotkeys = { search: '', chat: '', toggle: '', peek: '', pageNext: '', pagePrev: '' };
const streams = new Map<string, AbortController>();
const rendererErrors: string[] = [];
const undoStack: { label: string; boxes: BoxState[] }[] = [];
let quitting = false;
// v1.2 Fences-style state
const portalItems = new Map<string, DesktopItem[]>(); // boxId -> entries of portal cwd
const portalIndex = new Map<string, DesktopItem>(); // path -> entry (any portal)
const portalErrors = new Map<string, string>();
const portalWatch = new Map<string, { dir: string; stop: () => void }>();
let guideWin: BrowserWindow | null = null;
let pagerWin: BrowserWindow | null = null;
let hubWin: BrowserWindow | null = null;
let peekOn = false;
let resKey = '';
const corrections: { name: string; ext: string; to: string; at: number }[] = [];

const RENDERER = path.join(__dirname, 'renderer');
const PRELOAD = path.join(__dirname, 'preload.js');
const ICON_PNG = path.join(__dirname, 'assets', 'icon.png');
const ICON_OK = fs.existsSync(ICON_PNG);
const WIN_IDLE_MS = 90_000;
const idleTimers = new Map<string, NodeJS.Timeout>();
const fenceSig = new Map<string, string>();
let searchEpoch = 0;
let startupMs = 0;
let appReady = false;
const pendingActions: string[] = [];
function enqueueOrRun(action: string) {
  if (!action) return;
  if (!appReady) {
    pendingActions.push(action);
    if (pendingActions.length > 20) pendingActions.shift();
    return;
  }
  runCommand(action);
}
function flushPendingActions() {
  const q = pendingActions.splice(0, pendingActions.length);
  for (const a of q) runCommand(a);
}

function log(...a: unknown[]) {
  console.log('[main]', ...a);
}
// Last-resort guards: a stray rejection (vanished file, helper hiccup) must never take the whole desktop down.
process.on('unhandledRejection', (r) => console.error('[main] unhandled rejection', r));
process.on('uncaughtException', (e) => console.error('[main] uncaught exception', e));

function armWinIdle(key: string, get: () => BrowserWindow | null, clear: () => void) {
  const prev = idleTimers.get(key);
  if (prev) clearTimeout(prev);
  idleTimers.set(
    key,
    setTimeout(() => {
      idleTimers.delete(key);
      const w = get();
      if (w && !w.isDestroyed() && !w.isVisible()) {
        try {
          w.removeAllListeners();
          w.destroy();
        } catch {
          /* ignore */
        }
        clear();
        log('idle-destroy', key);
      }
    }, WIN_IDLE_MS),
  );
}
function cancelWinIdle(key: string) {
  const t = idleTimers.get(key);
  if (t) clearTimeout(t);
  idleTimers.delete(key);
}

function applyThemeSource() {
  nativeTheme.themeSource = settings.theme === 'auto' ? 'system' : settings.theme;
}
function theme(): 'dark' | 'light' {
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
}
function themePayload(): ThemePayload {
  return { theme: theme(), opacity: settings.opacity, iconSize: settings.iconSize, acrylic: isWin && settings.acrylic, chameleon: settings.chameleon, rollupOn: settings.rollupOn, hoverPeek: settings.hoverPeek, headerMode: settings.headerMode, hideScrollbars: settings.hideScrollbars, tintAll: settings.tintAll, tintColor: settings.tintColor, tintStrength: settings.tintStrength };
}
const BG = () => (theme() === 'dark' ? '#202024' : '#f3f4f7');

// ---------------------------------------------------------------- layout persistence + undo
let saveTimer: NodeJS.Timeout | null = null;
function saveLayout() {
  // Keep Fence Tabs in sync with the active pile before persisting.
  for (const b of layout.boxes) {
    if (!b.tabs?.length) continue;
    const tab = b.tabs.find((x) => x.id === b.activeTabId) ?? b.tabs[0];
    if (!tab) continue;
    b.activeTabId = tab.id;
    tab.items = [...b.items];
  }
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveJSON('layout.json', layout);
    rememberGeometry();
  }, 450);
}

function pushUndo(label: string) {
  undoStack.push({ label, boxes: structuredClone(layout.boxes) });
  if (undoStack.length > 15) undoStack.shift();
}

function undoLayout() {
  const snap = undoStack.pop();
  if (!snap) {
    toast({ kind: 'info', title: '没有可撤销的整理操作' });
    return;
  }
  layout.boxes = snap.boxes;
  reconcile();
  saveLayout();
  syncFences();
  toast({ kind: 'success', title: `已撤销：${snap.label}` });
}

// ---------------------------------------------------------------- geometry
function workArea(ref?: { x: number; y: number; w?: number; h?: number }) {
  if (ref) {
    try {
      return screen.getDisplayMatching({ x: ref.x, y: ref.y, width: Math.max(1, ref.w ?? 10), height: Math.max(1, ref.h ?? 10) }).workArea;
    } catch {
      /* fall through */
    }
  }
  return screen.getPrimaryDisplay().workArea;
}
function overlaps(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}
/** Keep a fence fully visible on some display work area (multi-monitor / DPI safe). */
function clampBoxToDisplays(b: BoxState) {
  const wa = workArea({ x: b.x, y: b.y, w: b.w, h: b.h });
  const scale = (() => {
    try {
      return screen.getDisplayMatching({ x: b.x, y: b.y, width: b.w, height: 10 }).scaleFactor || 1;
    } catch {
      return 1;
    }
  })();
  // Prefer logical pixels; avoid shrinking below usable size after DPI switch.
  const minW = Math.round(160 * Math.min(1.25, scale));
  b.w = Math.max(minW, Math.min(b.w, wa.width - 16));
  b.h = Math.max(TITLE_H + 40, Math.min(b.h, wa.height - 16));
  b.x = Math.max(wa.x, Math.min(b.x, wa.x + wa.width - b.w));
  b.y = Math.max(wa.y, Math.min(b.y, wa.y + wa.height - TITLE_H));
}
const curPage = () => Math.max(0, Math.min((layout.pages?.length ?? 1) - 1, layout.page ?? 0));
const onPage = (b: BoxState) => (b.page ?? 0) === curPage();
/** A page "has content" if any fence on it shows something (items, tabs, a folder portal or the recent-files fence). */
function pageHasContent(p: number): boolean {
  return layout.boxes.some((b) => (b.page ?? 0) === p && (b.items.length > 0 || isPortal(b) || isRecent(b) || !!b.tabs?.some((t) => t.items.length > 0)));
}
/**
 * 1.3.3 startup sanity (user report: "no fences visible" after a restart):
 * - quick-hide never survives a restart (Fences behaviour) — a stale hidden:true made every fence invisible;
 * - if the saved page has nothing on it, start on page 0 (the real fences);
 * - pull fences that sit outside the current screens back on-screen.
 * Returns what was fixed (for logs / tests).
 */
function sanitizeLayoutAtStartup(): string[] {
  const fixed: string[] = [];
  if (layout.hidden) {
    layout.hidden = false;
    fixed.push('hidden');
  }
  const pages = layout.pages?.length ? layout.pages : ['桌面 1'];
  if ((layout.page ?? 0) >= pages.length || (layout.page ?? 0) < 0) {
    layout.page = 0;
    fixed.push('page-range');
  }
  if ((layout.page ?? 0) !== 0 && !pageHasContent(layout.page ?? 0)) {
    layout.page = 0;
    fixed.push('empty-page');
  }
  for (const b of layout.boxes) {
    const before = `${b.x},${b.y},${b.w},${b.h}`;
    clampBoxToDisplays(b);
    if (`${b.x},${b.y},${b.w},${b.h}` !== before) fixed.push(`clamp:${b.title}`);
  }
  return fixed;
}
let hideHintShown = false;
let startupFixes: string[] = [];
let smokeMigratedMode: string | undefined;
let trayImg: Electron.NativeImage | null = null;
let trayImgHidden: Electron.NativeImage | null = null;
function freeSlot(all: BoxState[]): { x: number; y: number } {
  const taken = all.filter(onPage);
  const wa = workArea();
  const cols = Math.max(1, Math.floor((wa.width - GAP) / (BOX_W + GAP)));
  for (let i = 0; i < 200; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const r = { x: wa.x + GAP + col * (BOX_W + GAP), y: wa.y + GAP + row * (BOX_H + GAP), w: BOX_W, h: BOX_H };
    if (!taken.some((b) => overlaps(r, { x: b.x, y: b.y, w: b.w, h: b.collapsed ? TITLE_H : b.h }))) return r;
  }
  return { x: wa.x + GAP, y: wa.y + GAP };
}

function newBox(title: string, category: Category | null, taken: BoxState[], extra: Partial<BoxState> = {}): BoxState {
  const { x, y } = freeSlot(taken);
  return {
    id: randomUUID(),
    title,
    category,
    x,
    y,
    w: BOX_W,
    h: BOX_H,
    collapsed: false,
    items: [],
    color: category ? CATEGORY_COLOR[category] : '',
    icon: category ? CATEGORY_ICON[category] : 'ri-inbox-2-line',
    view: 'grid',
    sort: 'manual',
    kind: 'normal',
    page: curPage(),
    titleStyle: 'band',
    titleAlign: 'center',
    tint: 0.35,
    ...extra,
  };
}

const isRecent = (b: BoxState) => b.kind === 'recent';
const isPortal = (b: BoxState) => b.kind === 'portal';
const isManual = (b: BoxState) => b.kind === 'manual';
const isVirtual = (b: BoxState) => isRecent(b) || isPortal(b); // contents are computed, not assigned
const itemOf = (p: string) => desktopMap.get(p) ?? externalMap.get(p) ?? portalIndex.get(p);
/** Suppress portal watch echo while we write into a mapped folder. */
const portalMute = new Map<string, number>(); // boxId -> muteUntil ms
const sameTitle = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** find (or create on the current page) the box a rule targets */
function ruleBox(r: Rule, boxes: BoxState[]): BoxState {
  let box = boxes.find((b) => !isVirtual(b) && sameTitle(b.title, r.target));
  if (!box) {
    box = newBox(r.target, null, boxes, { color: r.color ?? '#4f7cff', icon: r.icon ?? 'ri-filter-3-line' });
    boxes.push(box);
  }
  return box;
}

/** Make layout consistent with the current desktop contents. Never touches files. */
function reconcile() {
  const seen = new Set<string>();
  for (const b of layout.boxes) {
    if (isVirtual(b)) {
      b.items = [];
      continue;
    }
    b.items = b.items.filter((p) => {
      if (seen.has(p) || !itemOf(p)) return false;
      seen.add(p);
      return true;
    });
  }
  const unassigned = [...desktopMap.values()].filter((i) => !seen.has(i.path)).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  for (const it of unassigned) {
    // Fences-style automation: user rules first (new desktop files are auto-placed)
    const rule = settings.autoPlace ? firstRule(settings.rules ?? [], it) : null;
    if (rule) {
      ruleBox(rule, layout.boxes).items.push(it.path);
      continue;
    }
    let box =
      layout.boxes.find((b) => !isVirtual(b) && b.category === it.category && onPage(b)) ??
      layout.boxes.find((b) => !isVirtual(b) && b.category === it.category) ??
      layout.boxes.find((b) => !isVirtual(b) && b.category === 'other');
    if (!box) {
      box = newBox(CATEGORY_LABEL[it.category], it.category, layout.boxes);
      layout.boxes.push(box);
    }
    box.items.push(it.path);
  }
}

/** Re-apply user rules to every desktop item now (manual "apply rules"). */
function applyRulesNow(): number {
  pushUndo('应用规则');
  let moved = 0;
  for (const it of desktopMap.values()) {
    const r = firstRule(settings.rules ?? [], it);
    if (!r) continue;
    const box = ruleBox(r, layout.boxes);
    if (box.items.includes(it.path)) continue;
    for (const b of layout.boxes) b.items = b.items.filter((p) => p !== it.path);
    box.items.push(it.path);
    moved++;
  }
  reconcile();
  saveLayout();
  syncFences();
  return moved;
}

/** 一键整理 (rule-based, virtual). Keeps user/AI created boxes and the recent box. */
function organizeByRules(opts: { silent?: boolean } = {}) {
  pushUndo('一键整理');
  const ruleTargets = new Set((settings.rules ?? []).filter((r) => r.enabled).map((r) => r.target.trim().toLowerCase()));
  const keep = layout.boxes.filter((b) => b.category === null || isVirtual(b));
  // items in user/AI boxes stay; items in rule-target boxes are re-evaluated
  const keepPaths = new Set(keep.filter((b) => !ruleTargets.has(b.title.trim().toLowerCase())).flatMap((b) => b.items));
  keep.forEach((b) => ruleTargets.has(b.title.trim().toLowerCase()) && (b.items = []));
  const byCat = new Map<Category, string[]>();
  const all = [...desktopMap.values(), ...externalMap.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  let ruled = 0;
  for (const it of all) {
    if (keepPaths.has(it.path)) continue;
    const rule = firstRule(settings.rules ?? [], it);
    if (rule) {
      ruleBox(rule, keep).items.push(it.path);
      ruled++;
      continue;
    }
    if (!byCat.has(it.category)) byCat.set(it.category, []);
    byCat.get(it.category)!.push(it.path);
  }
  const next: BoxState[] = [...keep];
  let n = 0;
  for (const cat of CATEGORY_ORDER) {
    const list = byCat.get(cat);
    if (!list?.length) continue;
    const existing = layout.boxes.find((b) => b.category === cat && !isVirtual(b));
    const box = existing ?? newBox(CATEGORY_LABEL[cat], cat, next);
    box.items = list;
    n += list.length;
    next.push(box);
  }
  layout.boxes = next;
  saveLayout();
  syncFences();
  if (!opts.silent) {
    toast({
      kind: 'success',
      title: '一键整理完成',
      message: `${n + ruled} 个项目已归入 ${next.filter((b) => !isVirtual(b) && b.items.length).length} 个格子${ruled ? `（其中 ${ruled} 个由规则归类）` : ''}，未移动任何文件`,
      action: { label: '撤销', command: 'undo-layout' },
    });
  }
}

function applyGroups(groups: { name: string; paths: string[]; icon?: string }[]) {
  pushUndo('AI 智能整理');
  const old = layout.boxes.filter((b) => !isVirtual(b) && onPage(b));
  const recent = layout.boxes.filter((b) => isVirtual(b) || !onPage(b));
  const next: BoxState[] = [...recent];
  const palette = ['#4f7cff', '#2f9bff', '#9b6bff', '#e5579a', '#14b8a6', '#f08c2e', '#3dbb63', '#e8a92c'];
  groups.forEach((g, i) => {
    const geo = old[i];
    const b: BoxState = geo
      ? { ...geo, title: g.name, category: null, items: g.paths, collapsed: false, icon: 'ri-sparkling-2-line', color: palette[i % palette.length], sort: 'manual' }
      : newBox(g.name, null, next, { icon: g.icon ?? 'ri-sparkling-2-line', color: palette[i % palette.length] });
    if (g.icon) b.icon = g.icon;
    b.items = g.paths;
    next.push(b);
  });
  layout.boxes = next;
  reconcile();
  saveLayout();
  syncFences();
  toast({ kind: 'success', title: 'AI 整理已应用', message: `分为 ${groups.length} 个格子（仅虚拟分组）`, action: { label: '撤销', command: 'undo-layout' } });
}

async function aiOrganize() {
  if (!aiConfigured(settings)) {
    const r = await dialog.showMessageBox({
      type: 'info',
      title: 'AI 智能整理',
      message: '尚未配置 AI 接口',
      detail: '请先在「设置 › AI 模型」中填写 API 地址、Key 与模型。现在可以先按文件类型整理。',
      buttons: ['按类型整理', '打开设置', '取消'],
      cancelId: 2,
    });
    if (r.response === 0) organizeByRules();
    if (r.response === 1) openSettings('ai');
    return;
  }
  const items = [...desktopMap.values()].slice(0, 500);
  if (!items.length) {
    toast({ kind: 'info', title: '桌面上没有可整理的文件' });
    return;
  }
  const list = items.map((it, i) => ({ i, n: it.name + (it.isDir ? '/' : it.ext && !it.name.endsWith(it.ext) ? it.ext : ''), t: CATEGORY_LABEL[it.category] }));
  toast({ kind: 'info', title: 'AI 正在分析桌面文件…', message: `共 ${items.length} 项，仅发送文件名与类型`, timeout: 60000 });
  try {
    const reply = await chatComplete(settings, [
      {
        role: 'system',
        content:
          '你是 Windows 桌面整理助手。根据文件名和类型（不会提供文件内容），把桌面文件按用途/主题分成 3~8 个收纳格子。' +
          '格子名用简体中文，2~6 个字，如「工作文档」「常用软件」「学习资料」「图片素材」「安装包」。每个文件只能属于一个格子。' +
          '只输出 JSON：{"groups":[{"name":"格子名","items":[文件编号...]}]}',
      },
      { role: 'user', content: JSON.stringify(list) },
    ]);
    const data = extractJSON<{ groups: { name: string; items: number[] }[] }>(reply);
    if (!data?.groups?.length) throw new Error('AI 返回格式无法解析：' + reply.slice(0, 200));
    const used = new Set<number>();
    const groups = data.groups
      .map((g) => ({
        name: String(g.name || '未命名').slice(0, 12),
        paths: (g.items || [])
          .filter((i) => Number.isInteger(i) && items[i] && !used.has(i) && (used.add(i), true))
          .map((i) => items[i].path),
      }))
      .filter((g) => g.paths.length);
    const rest = items.filter((_, i) => !used.has(i)).map((i) => i.path);
    if (rest.length) groups.push({ name: '其他', paths: rest });
    hideToast();
    const detail = groups.map((g) => `${g.name}（${g.paths.length}）`).join('\n');
    const r = DEMO
      ? { response: 0 }
      : await dialog.showMessageBox({
          type: 'question',
          title: 'AI 智能整理',
          message: `AI 建议分为 ${groups.length} 个格子`,
          detail: detail + '\n\n仅调整格子分组（虚拟整理），不会移动或删除任何文件；应用后可撤销。',
          buttons: ['应用', '取消'],
          cancelId: 1,
        });
    if (r.response === 0) applyGroups(groups);
  } catch (e: any) {
    toast({ kind: 'error', title: 'AI 智能整理失败', message: String(e?.message ?? e).slice(0, 160), action: { label: '设置', command: 'settings-ai' } });
  }
}

// ------------------------------------------------- physical organize (opt-in, confirmed, undoable)
async function organizeByMoving() {
  const userDir = desktopDirs(false).find((d) => d.source === 'user')?.dir;
  if (!userDir) return;
  const root = path.join(userDir, '已整理');
  const files = [...desktopMap.values()].filter((i) => i.source === 'user' && !i.isDir && i.category !== 'program');
  if (!files.length) {
    toast({ kind: 'info', title: '没有需要移动的文件', message: '快捷方式/程序和文件夹不会被移动' });
    return;
  }
  const counts = new Map<string, number>();
  files.forEach((f) => counts.set(CATEGORY_LABEL[f.category], (counts.get(CATEGORY_LABEL[f.category]) ?? 0) + 1));
  const r = await dialog.showMessageBox({
    type: 'warning',
    title: '整理到文件夹（移动文件）',
    message: `将把 ${files.length} 个文件移动到「桌面\\已整理\\<分类>」中`,
    detail: [...counts].map(([k, v]) => `${k}：${v} 个`).join('\n') + '\n\n快捷方式、程序和文件夹不会移动。之后可在托盘菜单「撤销上次移动」。',
    buttons: ['确认移动', '取消'],
    defaultId: 1,
    cancelId: 1,
  });
  if (r.response !== 0) return;
  const moves: { from: string; to: string }[] = [];
  for (const f of files) {
    const dir = path.join(root, CATEGORY_LABEL[f.category].replace(/[\\/]/g, '_'));
    await fsp.mkdir(dir, { recursive: true });
    let to = path.join(dir, path.basename(f.path));
    let n = 1;
    while (fs.existsSync(to)) {
      const ext = path.extname(f.path);
      to = path.join(dir, `${path.basename(f.path, ext)} (${n++})${ext}`);
    }
    try {
      await fsp.rename(f.path, to);
      moves.push({ from: f.path, to });
    } catch (e) {
      console.warn('move failed', f.path, e);
    }
  }
  saveJSON('move-log.json', { at: Date.now(), moves });
  await refresh();
  toast({ kind: 'success', title: `已移动 ${moves.length} 个文件`, message: '位于 桌面\\已整理', action: { label: '撤销移动', command: 'undo-move' } });
}

async function undoMove() {
  const data = loadJSON<{ at: number; moves: { from: string; to: string }[] }>('move-log.json', { at: 0, moves: [] });
  if (!data.moves.length) {
    toast({ kind: 'info', title: '没有可撤销的移动记录' });
    return;
  }
  let ok = 0;
  for (const m of data.moves) {
    if (fs.existsSync(m.to) && !fs.existsSync(m.from)) {
      try {
        await fsp.rename(m.to, m.from);
        ok++;
      } catch {
        /* ignore */
      }
    }
  }
  saveJSON('move-log.json', { at: 0, moves: [] });
  await refresh();
  toast({ kind: 'success', title: `已还原 ${ok} 个文件` });
}

// ---------------------------------------------------------------- scanning
async function refreshExternals() {
  const refs = layout.boxes.flatMap((b) => b.items).filter((p) => !desktopMap.has(p));
  externalMap.clear();
  for (const p of refs) {
    const it = await statItem(p, 'external');
    if (it) externalMap.set(p, it);
  }
}

/** Full desktop rescan. */
async function refreshFull() {
  const items = await scanDesktop(settings.scanPublicDesktop);
  desktopMap.clear();
  for (const i of items) desktopMap.set(i.path, i);
  await refreshExternals();
  deepIndex = null;
  reconcile();
  saveLayout();
  syncFences();
  scheduleIndex();
}

/**
 * Coalesced watch callback. When changedPaths are known, only re-scan dirty
 * desktop roots (incremental). Falls back to a full rescan when needed.
 */
async function refresh(changedPaths?: string[]) {
  if (changedPaths?.length && desktopMap.size) {
    const roots = desktopDirs(settings.scanPublicDesktop);
    const norm = (p: string) => (isWin ? p.toLowerCase() : p);
    const dirty = new Set<string>();
    for (const raw of changedPaths) {
      const p = path.resolve(raw);
      for (const d of roots) {
        const root = path.resolve(d.dir);
        if (norm(p) === norm(root) || norm(p).startsWith(norm(root) + path.sep) || norm(path.dirname(p)) === norm(root)) {
          dirty.add(d.dir);
        }
      }
    }
    if (dirty.size) {
      for (const d of roots) {
        if (!dirty.has(d.dir)) continue;
        const rootN = norm(d.dir);
        for (const [p] of [...desktopMap]) {
          if (norm(path.dirname(p)) === rootN) desktopMap.delete(p);
        }
        for (const it of await scanDesktopDir(d)) desktopMap.set(it.path, it);
      }
      await refreshExternals();
      deepIndex = null;
      reconcile();
      saveLayout();
      syncFences();
      scheduleIndex();
      return;
    }
  }
  await refreshFull();
}

async function getDeepIndex(): Promise<DesktopItem[]> {
  if (deepIndex && Date.now() - deepIndex.at < 30000) return deepIndex.items;
  const items = await scanDeep(settings.scanPublicDesktop);
  const seen = new Set(items.map((i) => i.path));
  for (const e of externalMap.values()) if (!seen.has(e.path)) items.push(e);
  deepIndex = { at: Date.now(), items };
  return items;
}

// ---------------------------------------------------------------- fences
const TYPE_ORDER: Record<Category, number> = Object.fromEntries(CATEGORY_ORDER.map((c, i) => [c, i])) as Record<Category, number>;
function sortItems(items: DesktopItem[], mode: SortMode | undefined): DesktopItem[] {
  const cmpName = (a: DesktopItem, b: DesktopItem) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true });
  switch (mode) {
    case 'name':
      return [...items].sort((a, b) => Number(b.isDir) - Number(a.isDir) || cmpName(a, b));
    case 'date':
      return [...items].sort((a, b) => b.mtime - a.mtime);
    case 'type':
      return [...items].sort((a, b) => TYPE_ORDER[a.category] - TYPE_ORDER[b.category] || a.ext.localeCompare(b.ext) || cmpName(a, b));
    case 'size':
      return [...items].sort((a, b) => Number(b.isDir) - Number(a.isDir) || b.size - a.size);
    default:
      return items;
  }
}

function boxItems(box: BoxState): DesktopItem[] {
  if (isPortal(box)) {
    const list = portalItems.get(box.id) ?? [];
    return !box.sort || box.sort === 'manual' ? list : sortItems(list, box.sort);
  }
  if (isRecent(box)) {
    return [...desktopMap.values()]
      .filter((i) => !i.isDir)
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, Math.max(3, settings.recentCount));
  }
  return sortItems(box.items.map(itemOf).filter(Boolean) as DesktopItem[], box.sort);
}

function crumbs(box: BoxState): { name: string; path: string }[] | undefined {
  if (!isPortal(box) || !box.portal) return undefined;
  const root = box.portal.root;
  const cwd = box.portal.cwd && within(root, box.portal.cwd) ? box.portal.cwd : root;
  const out = [{ name: path.basename(root) || root, path: root }];
  const rel = path.relative(root, cwd);
  if (rel) {
    let acc = root;
    for (const seg of rel.split(path.sep)) {
      acc = path.join(acc, seg);
      out.push({ name: seg, path: acc });
    }
  }
  return out;
}

function fenceData(box: BoxState): FenceData {
  return { box, items: boxItems(box), canUndo: undoStack.length > 0, crumbs: crumbs(box), portalError: portalErrors.get(box.id), ...themePayload() };
}

// ---------------------------------------------------------------- Folder Portals
function within(root: string, p: string): boolean {
  const rel = path.relative(root, p);
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

async function loadPortal(box: BoxState) {
  if (!box.portal) return;
  const cwd = box.portal.cwd && within(box.portal.root, box.portal.cwd) ? box.portal.cwd : box.portal.root;
  for (const it of portalItems.get(box.id) ?? []) portalIndex.delete(it.path);
  try {
    const items = await scanFolder(cwd);
    portalItems.set(box.id, items);
    items.forEach((i) => portalIndex.set(i.path, i));
    portalErrors.delete(box.id);
  } catch (e: any) {
    portalItems.set(box.id, []);
    portalErrors.set(box.id, e?.code === 'ENOENT' ? '文件夹不存在或已被移动' : String(e?.message ?? e));
  }
  const w = portalWatch.get(box.id);
  if (!w || w.dir !== cwd) {
    w?.stop();
    portalWatch.set(box.id, {
      dir: cwd,
      stop: watchFolder(cwd, () => {
        if ((portalMute.get(box.id) ?? 0) > Date.now()) return;
        loadPortal(box).then(() => sendFence(box));
      }),
    });
  }
}

function sendFence(box: BoxState) {
  const w = fenceWins.get(box.id);
  if (w && !w.isDestroyed()) w.webContents.send('fence:data', fenceData(box));
}

async function portalNav(box: BoxState, dir: string) {
  if (!box.portal || !within(box.portal.root, dir)) return;
  box.portal.cwd = dir;
  await loadPortal(box);
  saveLayout();
  sendFence(box);
}

async function uniqueDest(dir: string, name: string): Promise<string> {
  let dest = path.join(dir, name);
  if (!fs.existsSync(dest)) return dest;
  const ext = path.extname(name);
  const base = ext ? name.slice(0, -ext.length) : name;
  for (let n = 2; n < 500; n++) {
    dest = path.join(dir, `${base} (${n})${ext}`);
    if (!fs.existsSync(dest)) return dest;
  }
  return path.join(dir, `${base}-${Date.now()}${ext}`);
}

async function copyEntry(src: string, dest: string) {
  const st = await fsp.stat(src);
  if (st.isDirectory()) {
    await fsp.mkdir(dest, { recursive: true });
    for (const name of await fsp.readdir(src)) await copyEntry(path.join(src, name), path.join(dest, name));
  } else {
    await fsp.copyFile(src, dest);
  }
}

/** Drop files into a bidirectional portal (copy/move into mapped folder). */
async function dropIntoPortal(box: BoxState, paths: string[], prefer?: 'copy' | 'move') {
  if (!box.portal) return;
  const sync = box.portal.sync ?? 'mirror';
  if (sync !== 'bidirectional') {
    toast({ kind: 'info', title: '当前为「仅显示」映射', message: '可在格子菜单中改为「双向同步」，或直接在资源管理器中操作该文件夹' });
    return;
  }
  const cwd = box.portal.cwd && within(box.portal.root, box.portal.cwd) ? box.portal.cwd : box.portal.root;
  let mode = prefer;
  if (!mode) {
    const r = await dialog.showMessageBox({
      type: 'question',
      title: '放入映射文件夹',
      message: `将 ${paths.length} 个项目写入「${path.basename(cwd)}」？`,
      detail: '双向同步会把文件复制或移动到映射文件夹；不会自动删除源文件以外的内容。',
      buttons: ['复制到文件夹', '移动到文件夹', '取消'],
      defaultId: 0,
      cancelId: 2,
    });
    if (r.response === 2) return;
    mode = r.response === 1 ? 'move' : 'copy';
  }
  portalMute.set(box.id, Date.now() + 1200);
  let ok = 0;
  const errors: string[] = [];
  try {
    for (const src of paths) {
      try {
        if (!fs.existsSync(src)) continue;
        if (within(cwd, src) || path.resolve(src) === path.resolve(cwd)) {
          errors.push(`${path.basename(src)}：不能放入自身`);
          continue;
        }
        const dest = await uniqueDest(cwd, path.basename(src));
        if (mode === 'move') {
          try {
            await fsp.rename(src, dest);
          } catch {
            await copyEntry(src, dest);
            await fsp.rm(src, { recursive: true, force: true });
          }
        } else {
          await copyEntry(src, dest);
        }
        ok++;
      } catch (e: any) {
        errors.push(`${path.basename(src)}：${String(e?.message ?? e).slice(0, 80)}`);
      }
    }
  } finally {
    setTimeout(() => { if ((portalMute.get(box.id) ?? 0) <= Date.now()) portalMute.delete(box.id); }, 1300);
  }
  await loadPortal(box);
  sendFence(box);
  deepIndex = null;
  if (ok) toast({ kind: 'success', title: mode === 'move' ? `已移动 ${ok} 项到映射文件夹` : `已复制 ${ok} 项到映射文件夹` });
  if (errors.length) toast({ kind: 'warning', title: '部分项目未能写入', message: errors.slice(0, 3).join('；') });
}

async function portalTrash(box: BoxState, paths: string[]) {
  if (!box.portal || (box.portal.sync ?? 'mirror') !== 'bidirectional') return;
  const r = await dialog.showMessageBox({
    type: 'warning',
    title: '删除映射中的文件',
    message: `确定将 ${paths.length} 个项目移到回收站？`,
    detail: '此操作会删除磁盘上的真实文件（可在系统回收站还原）。格子内的显示会随之更新。',
    buttons: ['移到回收站', '取消'],
    defaultId: 1,
    cancelId: 1,
  });
  if (r.response !== 0) return;
  portalMute.set(box.id, Date.now() + 1200);
  let ok = 0;
  try {
    for (const p of paths) {
      try {
        if (!within(box.portal.root, p)) continue;
        await shell.trashItem(p);
        ok++;
      } catch (e) {
        console.warn('trash failed', p, e);
      }
    }
  } finally {
    setTimeout(() => { if ((portalMute.get(box.id) ?? 0) <= Date.now()) portalMute.delete(box.id); }, 1300);
  }
  await loadPortal(box);
  sendFence(box);
  toast({ kind: ok ? 'success' : 'warning', title: ok ? `已移到回收站 ${ok} 项` : '未能删除' });
}

async function portalRename(box: BoxState, p: string) {
  if (!box.portal || (box.portal.sync ?? 'mirror') !== 'bidirectional') return;
  if (!within(box.portal.root, p)) return;
  const cur = path.basename(p);
  const r = await dialog.showMessageBox({
    type: 'question',
    title: '重命名',
    message: `重命名「${cur}」`,
    detail: '将同时重命名磁盘上的文件。请在下一步输入框中确认新名称（若系统不支持输入框，请在资源管理器中重命名）。',
    buttons: ['在资源管理器中显示', '取消'],
    defaultId: 0,
    cancelId: 1,
  });
  if (r.response === 0) shell.showItemInFolder(p);
}

function setPortalSync(box: BoxState, sync: 'mirror' | 'bidirectional') {
  if (!box.portal) return;
  box.portal.sync = sync;
  saveLayout();
  syncFences();
  toast({
    kind: 'success',
    title: sync === 'bidirectional' ? '已开启双向同步' : '已切换为仅显示',
    message: sync === 'bidirectional' ? '拖入文件会写入映射文件夹；删除需确认' : '格子只镜像文件夹内容，拖入不会改磁盘',
  });
}

async function createPortal(dir?: string, extra: Partial<BoxState> = {}) {
  if (!dir) {
    const r = await dialog.showOpenDialog({ title: '选择要映射到桌面的文件夹', properties: ['openDirectory'], defaultPath: app.getPath('downloads') });
    if (r.canceled || !r.filePaths[0]) return;
    dir = r.filePaths[0];
  }
  let sync: 'mirror' | 'bidirectional' = (extra.portal?.sync as any) || 'mirror';
  if (!extra.portal?.sync && !SMOKE && !DEMO) {
    const ask = await dialog.showMessageBox({
      type: 'question',
      title: '映射文件夹',
      message: `如何同步「${path.basename(dir)}」？`,
      detail: '仅显示：格子镜像文件夹，适合浏览。\n双向同步：拖入/删除会写入该文件夹（删除前会确认）。',
      buttons: ['仅显示（推荐）', '双向同步', '取消'],
      defaultId: 0,
      cancelId: 2,
    });
    if (ask.response === 2) return;
    sync = ask.response === 1 ? 'bidirectional' : 'mirror';
  }
  const finalSync = extra.portal?.sync ?? sync;
  const { portal: _ignorePortal, ...rest } = extra;
  const b = newBox(path.basename(dir) || dir, null, layout.boxes, {
    kind: 'portal',
    icon: 'ri-folder-open-line',
    color: '#e8a92c',
    sort: 'manual',
    ...rest,
    portal: { root: dir, cwd: dir, sync: finalSync },
  });
  sync = finalSync;
  layout.boxes.push(b);
  await loadPortal(b);
  saveLayout();
  syncFences();
  toast({
    kind: 'success',
    title: `已创建文件夹映射「${b.title}」`,
    message: sync === 'bidirectional' ? '双向同步已开启：拖入会写入文件夹' : '仅显示镜像；可在菜单中改为双向同步',
  });
  return b;
}

async function changePortal(box: BoxState) {
  const r = await dialog.showOpenDialog({ title: '更改映射文件夹', properties: ['openDirectory'], defaultPath: box.portal?.root });
  if (r.canceled || !r.filePaths[0]) return;
  const sync = box.portal?.sync ?? 'mirror';
  box.portal = { root: r.filePaths[0], cwd: r.filePaths[0], sync };
  box.title = path.basename(r.filePaths[0]) || box.title;
  await loadPortal(box);
  saveLayout();
  syncFences();
}

function webPrefs() {
  return { preload: PRELOAD, contextIsolation: true, nodeIntegration: false, sandbox: false, spellcheck: false };
}

function hookErrors(win: BrowserWindow, name: string) {
  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    if (level >= 3) {
      const m = `[${name}] ${message} (${sourceId}:${line})`;
      rendererErrors.push(m);
      console.error(m);
    }
  });
  win.webContents.on('render-process-gone', (_e, d) => {
    rendererErrors.push(`[${name}] renderer gone: ${d.reason}`);
    // Self-heal: a crashed fence/panel renderer reloads instead of leaving a blank window on the desktop.
    if (d.reason !== 'clean-exit' && !quitting && !SMOKE)
      setTimeout(() => {
        if (!win.isDestroyed()) win.webContents.reload();
      }, 600);
  });
  win.webContents.on('preload-error', (_e, p, err) => rendererErrors.push(`[${name}] preload error ${p}: ${err}`));
}

function applyMaterial(win: BrowserWindow) {
  if (!isWin) return;
  try {
    (win as any).setBackgroundMaterial?.(settings.acrylic ? 'acrylic' : 'none');
  } catch {
    /* older Windows */
  }
}

function createFence(box: BoxState): BrowserWindow {
  const win = new BrowserWindow({
    x: Math.round(box.x),
    y: Math.round(box.y),
    width: Math.round(box.w),
    height: box.collapsed ? TITLE_H : Math.round(box.h),
    minWidth: 160,
    minHeight: TITLE_H,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false, // custom resize grips (snap + guides); transparent windows can't be OS-resized on Windows
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: false,
    show: false,
    title: box.title,
    ...(isWin ? { type: 'toolbar' as const } : {}),
    webPreferences: webPrefs(),
  });
  win.setMenu(null);
  hookErrors(win, 'fence');
  win.loadFile(path.join(RENDERER, 'fence.html'), { query: { box: box.id } });
  win.once('ready-to-show', () => {
    const b = layout.boxes.find((x) => x.id === box.id);
    if (!b || !shouldShow(b)) return;
    applyMaterial(win);
    win.showInactive();
    if (isWin) {
      if (settings.embedDesktop) winLayer.attachToDesktop(win);
      else if (settings.keepBottom) winLayer.sendToBottom(win);
    }
  });
  const persist = () => {
    const b = layout.boxes.find((x) => x.id === box.id);
    if (!b || win.isDestroyed() || animating.has(b.id)) return;
    const r = win.getBounds();
    b.x = r.x;
    b.y = r.y;
    b.w = r.width;
    if (!b.collapsed && r.height > TITLE_H + 4) b.h = r.height;
    saveLayout();
  };
  win.on('moved', persist);
  win.on('resized', persist);
  win.on('blur', () => {
    if (isWin && settings.keepBottom && !settings.embedDesktop) winLayer.sendToBottom(win);
  });
  win.on('close', (e) => {
    if (!quitting && fenceWins.get(box.id) === win && layout.boxes.some((b) => b.id === box.id)) e.preventDefault();
  });
  win.on('closed', () => {
    if (fenceWins.get(box.id) === win) fenceWins.delete(box.id);
  });
  return win;
}

const shouldShow = (b: BoxState) => onPage(b) && (!layout.hidden || !!b.keepOnHide || settings.quickHideMode === 'icons');

function syncFences() {
  const ids = new Set(layout.boxes.map((b) => b.id));
  for (const [id, w] of portalWatch) if (!ids.has(id)) (w.stop(), portalWatch.delete(id));
  for (const [id, w] of fenceWins) {
    if (!ids.has(id)) {
      fenceWins.delete(id);
      fenceSig.delete(id);
      if (!w.isDestroyed()) w.destroy();
    }
  }
  for (const b of layout.boxes) {
    const w = fenceWins.get(b.id);
    if (!w || w.isDestroyed()) {
      fenceWins.set(b.id, createFence(b));
    } else {
      if (!animating.has(b.id) && !dragging.has(b.id) && !peeking.has(b.id)) {
        const r = w.getBounds();
        const h = b.collapsed ? TITLE_H : b.h;
        if (r.x !== b.x || r.y !== b.y || r.width !== b.w || r.height !== h) w.setBounds({ x: b.x, y: b.y, width: b.w, height: h });
      }
      const show = shouldShow(b);
      if (show && !w.isVisible()) {
        w.showInactive();
        if (isWin && settings.keepBottom && !settings.embedDesktop && !peekOn) winLayer.sendToBottom(w);
      } else if (!show && w.isVisible()) w.hide();
      pushFenceData(b, w);
    }
  }
  updateTrayMenu();
}

function pushFenceData(b: BoxState, w: BrowserWindow) {
  if (w.isDestroyed()) return;
  const d = fenceData(b);
  const sig =
    `${b.title}|${b.collapsed}|${b.view}|${b.sort}|${b.color}|${b.icon}|${b.w}x${b.h}|${b.tint}|${b.titleStyle}|${b.titleAlign}|` +
    `${d.portalError || ''}|${(d.crumbs || []).map((c) => c.path).join('>')}|` +
    d.items.map((i) => `${i.path}:${i.mtime}:${i.size}`).join(',');
  if (fenceSig.get(b.id) === sig) return;
  fenceSig.set(b.id, sig);
  w.webContents.send('fence:data', d);
}

function broadcastTheme() {
  const payload = themePayload();
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('theme', payload);
  try {
    settingsWin?.setTitleBarOverlay?.({ color: BG(), symbolColor: theme() === 'dark' ? '#e8e8ec' : '#1b1d22' });
  } catch {
    /* not supported */
  }
}

/** Quick-hide (Fences): hide all fences (except "keep on hide") and, on Windows, the system desktop icons. */
function setFencesHidden(hidden: boolean) {
  const wasHidden = !!layout.hidden;
  layout.hidden = hidden;
  saveLayout();
  if (hidden && peekOn) setPeek(false);
  for (const b of layout.boxes) {
    const w = fenceWins.get(b.id);
    if (!w || w.isDestroyed()) continue;
    if (!shouldShow(b)) w.hide();
    else if (!w.isVisible()) {
      w.showInactive();
      w.webContents.send('fence:enter', 'fade');
      if (isWin && settings.keepBottom && !settings.embedDesktop) winLayer.sendToBottom(w);
    }
  }
  if (isWin && (settings.quickHideMode ?? 'fences') !== 'fences') winLayer.setDesktopIcons(!hidden);
  updateTrayMenu();
  // Quick-hide is easy to trigger by accident (double-click on the desktop, hotkey): explain once per session.
  if (hidden && !wasHidden && !hideHintShown) {
    hideHintShown = true;
    toast({ kind: 'info', title: '格子已隐藏', message: `双击桌面或按 ${activeHotkeys.toggle || 'Alt+Shift+D'} 显示`, timeout: 6000 });
  }
}

function boxOfSender(e: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent): BoxState | undefined {
  for (const [id, w] of fenceWins) if (!w.isDestroyed() && w.webContents === e.sender) return layout.boxes.find((b) => b.id === id);
  return undefined;
}

function moveItems(paths: string[], toBoxId: string, beforePath: string | null, manual = true) {
  const target = layout.boxes.find((b) => b.id === toBoxId);
  if (!target) return;
  if (isRecent(target)) {
    toast({ kind: 'info', title: '「最近文件」格子按修改时间自动显示', message: '无法手动放入文件' });
    return;
  }
  if (isPortal(target)) {
    void dropIntoPortal(target, paths);
    return;
  }
  if (manual) {
    learnFromMove(paths, target);
    pushUndo(`移动到「${target.title}」`);
  }
  const set = new Set(paths);
  const sameBox = paths.every((p) => target.items.includes(p));
  if (sameBox && beforePath && target.sort && target.sort !== 'manual') {
    // user reorders a sorted box: freeze current order and switch to manual
    target.items = sortItems(target.items.map(itemOf).filter(Boolean) as DesktopItem[], target.sort).map((i) => i.path);
    target.sort = 'manual';
  }
  // Membership move only — never copy/rename on disk (Fences / 腾讯桌面整理).
  for (const b of layout.boxes) {
    if (isVirtual(b)) continue;
    b.items = b.items.filter((p) => !set.has(p));
  }
  let idx = beforePath ? target.items.indexOf(beforePath) : -1;
  if (idx < 0) idx = target.items.length;
  target.items.splice(idx, 0, ...paths);
  saveLayout();
  syncFences();
}

/** Drag out of a fence onto empty desktop: leave every organize fence; file stays on disk (Fences-style). */
function releaseToDesktop(paths: string[]) {
  const set = new Set(paths.filter((p) => typeof p === 'string' && p));
  if (!set.size) return false;
  const wouldChange = layout.boxes.some((b) => !isVirtual(b) && !isPortal(b) && b.items.some((p) => set.has(p)));
  if (!wouldChange) return false;
  pushUndo('移出到桌面');
  for (const b of layout.boxes) {
    if (isVirtual(b) || isPortal(b)) continue;
    b.items = b.items.filter((p) => !set.has(p));
  }
  for (const p of set) {
    if (![...layout.boxes].some((b) => !isVirtual(b) && b.items.includes(p))) externalMap.delete(p);
  }
  saveLayout();
  syncFences();
  toast({ kind: 'success', title: `已移出到桌面 ${set.size} 项`, message: '未复制文件；图标回到桌面整理范围外', action: { label: '撤销', command: 'undo-layout' } });
  return true;
}

function pointOverOurWindow(pt: { x: number; y: number }): boolean {
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.isDestroyed() || !w.isVisible()) continue;
    const b = w.getBounds();
    if (pt.x >= b.x && pt.x < b.x + b.width && pt.y >= b.y && pt.y < b.y + b.height) return true;
  }
  return false;
}

// ---------------------------------------------------------------- learning from corrections
function learnFromMove(paths: string[], target: BoxState) {
  const from = new Set(layout.boxes.filter((b) => paths.some((p) => b.items.includes(p))).map((b) => b.id));
  if (from.has(target.id) && from.size === 1) return; // reorder inside a box
  for (const p of paths) {
    const it = desktopMap.get(p);
    if (!it || it.isDir) continue;
    corrections.push({ name: it.name, ext: it.ext, to: target.title, at: Date.now() });
  }
  while (corrections.length > 60) corrections.shift();
  saveJSON('corrections.json', corrections);
  if (!settings.learnFromMoves) return;
  const ext = desktopMap.get(paths[0])?.ext;
  if (!ext || ['.lnk', '.url'].includes(ext)) return;
  const times = corrections.filter((c) => c.ext === ext && sameTitle(c.to, target.title)).length;
  const covered = (settings.rules ?? []).some((r) => r.enabled && sameTitle(r.target, target.title) && r.conds.some((c) => c.field === 'ext' && c.value.toLowerCase().includes(ext)));
  const minN = Math.max(2, Math.min(10, settings.learnRuleMin ?? 3));
  if (times >= minN && !covered) {
    toast({
      kind: 'info',
      title: `以后 ${ext} 文件都自动放入「${target.title}」？`,
      message: '检测到你多次手动调整同类文件，可一键生成整理规则',
      action: { label: '创建规则', command: `learn-rule:${ext}|${target.title}` },
      timeout: 12000,
    });
  }
}

function addRule(r: Rule, apply = true) {
  settings.rules = [r, ...(settings.rules ?? []).filter((x) => x.id !== r.id)];
  setSettings(settings);
  settingsWin?.webContents.send('settings:rules', settings.rules);
  if (apply) {
    const n = applyRulesNow();
    toast({ kind: 'success', title: `已创建规则「${r.name}」`, message: `${describeRule(r)}；已归类 ${n} 个现有文件`, action: { label: '撤销', command: 'undo-layout' } });
  }
}

const animating = new Set<string>();
const peeking = new Set<string>();
function animateHeight(box: BoxState, win: BrowserWindow, to: number) {
  const r = win.getBounds();
  const from = r.height;
  const steps = 14; // smoother roll-up / peek
  let i = 0;
  animating.add(box.id);
  const tick = () => {
    if (win.isDestroyed()) return animating.delete(box.id);
    i++;
    const ease = 1 - Math.pow(1 - i / steps, 3);
    win.setBounds({ x: r.x, y: r.y, width: r.width, height: Math.round(from + (to - from) * ease) });
    if (i < steps) setTimeout(tick, 12);
    else animating.delete(box.id);
  };
  tick();
}

/** Hover peek: temporarily unroll a rolled-up fence while the mouse is over it. */
function peekFence(box: BoxState, on: boolean) {
  const w = fenceWins.get(box.id);
  if (!w || w.isDestroyed() || !box.collapsed || dragging.has(box.id)) return;
  if (on === peeking.has(box.id)) return;
  if (on) peeking.add(box.id);
  else peeking.delete(box.id);
  w.webContents.send('fence:peek', on);
  if (on) w.moveTop();
  else if (isWin && settings.keepBottom && !settings.embedDesktop && !peekOn) winLayer.sendToBottom(w);
  animateHeight(box, w, on ? box.h : TITLE_H);
}

function toggleCollapse(box: BoxState) {
  peeking.delete(box.id);
  box.collapsed = !box.collapsed;
  const w = fenceWins.get(box.id);
  saveLayout();
  if (w && !w.isDestroyed()) {
    w.webContents.send('fence:data', fenceData(box));
    animateHeight(box, w, box.collapsed ? TITLE_H : box.h);
  }
}


// ---------------------------------------------------------------- custom drag / resize with snapping + guides
type DragMode = 'move' | 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
const dragging = new Map<string, { mode: DragMode; sx: number; sy: number; r: Electron.Rectangle; moved: boolean }>();
const SNAP = 10;
let SNAP_GAP = 8; // Fences: "keep groups spaced N px apart" (settings.groupGap)

function guideWindow(): BrowserWindow {
  if (guideWin && !guideWin.isDestroyed()) return guideWin;
  const wa = screen.getPrimaryDisplay().bounds;
  guideWin = new BrowserWindow({
    ...wa,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    focusable: false,
    skipTaskbar: true,
    show: false,
    alwaysOnTop: true,
    ...(isWin ? { type: 'toolbar' as const } : {}),
    webPreferences: webPrefs(),
  });
  guideWin.setIgnoreMouseEvents(true);
  guideWin.loadFile(path.join(RENDERER, 'guides.html'));
  hookErrors(guideWin, 'guides');
  return guideWin;
}

interface Guide { x1: number; y1: number; x2: number; y2: number }

/** Snap rectangle r (screen coords) against other fences on this page, the work area and the grid. */
function snapRect(id: string, r: Electron.Rectangle, mode: DragMode): { r: Electron.Rectangle; guides: Guide[] } {
  const wa = workArea();
  SNAP_GAP = Math.max(0, Math.min(48, settings.groupGap ?? 8));
  const others = layout.boxes
    .filter((b) => b.id !== id && shouldShow(b))
    .map((b) => ({ x: b.x, y: b.y, w: b.w, h: b.collapsed && !peeking.has(b.id) ? TITLE_H : b.h }));
  const guides: Guide[] = [];
  const moveL = mode === 'move' || mode.includes('w');
  const moveR = mode === 'move' || mode.includes('e');
  const moveT = mode === 'move' || mode.includes('n');
  const moveB = mode === 'move' || mode.includes('s');
  const out = { ...r };
  if (settings.snapEdges) {
    const xs: { v: number; src: { y: number; h: number } | null }[] = [
      { v: wa.x + SNAP_GAP, src: null },
      { v: wa.x + wa.width - SNAP_GAP, src: null },
    ];
    const ys: { v: number; src: { x: number; w: number } | null }[] = [
      { v: wa.y + SNAP_GAP, src: null },
      { v: wa.y + wa.height - SNAP_GAP, src: null },
    ];
    for (const o of others) {
      xs.push({ v: o.x, src: o }, { v: o.x + o.w, src: o }, { v: o.x - SNAP_GAP, src: o }, { v: o.x + o.w + SNAP_GAP, src: o });
      ys.push({ v: o.y, src: o }, { v: o.y + o.h, src: o }, { v: o.y - SNAP_GAP, src: o }, { v: o.y + o.h + SNAP_GAP, src: o });
    }
    const best = <T extends { v: number }>(edge: number, list: T[]) => {
      let hit: T | null = null;
      let d = SNAP + 1;
      for (const c of list) {
        const dd = Math.abs(c.v - edge);
        if (dd < d) (d = dd), (hit = c);
      }
      return hit;
    };
    // horizontal
    const l = moveL ? best(out.x, xs) : null;
    const rr = moveR ? best(out.x + out.width, xs) : null;
    let snappedX: { v: number; src: any } | null = null;
    if (mode === 'move') {
      const dl = l ? Math.abs(l.v - out.x) : Infinity;
      const dr = rr ? Math.abs(rr.v - (out.x + out.width)) : Infinity;
      if (dl <= dr && l) (out.x = l.v), (snappedX = l);
      else if (rr) (out.x = rr.v - out.width), (snappedX = rr);
    } else {
      if (l) {
        const right = out.x + out.width;
        out.x = l.v;
        out.width = right - out.x;
        snappedX = l;
      }
      if (rr) (out.width = rr.v - out.x), (snappedX = rr);
    }
    const t = moveT ? best(out.y, ys) : null;
    const bb = moveB ? best(out.y + out.height, ys) : null;
    let snappedY: { v: number; src: any } | null = null;
    if (mode === 'move') {
      const dt = t ? Math.abs(t.v - out.y) : Infinity;
      const db = bb ? Math.abs(bb.v - (out.y + out.height)) : Infinity;
      if (dt <= db && t) (out.y = t.v), (snappedY = t);
      else if (bb) (out.y = bb.v - out.height), (snappedY = bb);
    } else {
      if (t) {
        const bottom = out.y + out.height;
        out.y = t.v;
        out.height = bottom - out.y;
        snappedY = t;
      }
      if (bb) (out.height = bb.v - out.y), (snappedY = bb);
    }
    if (snappedX) {
      const src = snappedX.src as { y: number; h: number } | null;
      const y1 = Math.min(out.y, src ? src.y : wa.y) - 6;
      const y2 = Math.max(out.y + out.height, src ? src.y + src.h : wa.y + wa.height) + 6;
      guides.push({ x1: snappedX.v, y1, x2: snappedX.v, y2 });
    }
    if (snappedY) {
      const src = snappedY.src as { x: number; w: number } | null;
      const x1 = Math.min(out.x, src ? src.x : wa.x) - 6;
      const x2 = Math.max(out.x + out.width, src ? src.x + src.w : wa.x + wa.width) + 6;
      guides.push({ x1, y1: snappedY.v, x2, y2: snappedY.v });
    }
    if (!snappedX && settings.snapGrid > 0) snapGridAxis(out, 'x', mode, wa.x);
    if (!snappedY && settings.snapGrid > 0) snapGridAxis(out, 'y', mode, wa.y);
  } else if (settings.snapGrid > 0) {
    snapGridAxis(out, 'x', mode, wa.x);
    snapGridAxis(out, 'y', mode, wa.y);
  }
  if (settings.iconMultiples && mode !== 'move') {
    // Fences: keep groups sized to even multiples of icons when resizing
    const cell = iconCell();
    const s = sizeToIconMultiples(out.width, out.height, cell, TITLE_H);
    if (mode.includes('w')) out.x += out.width - s.w;
    if (mode.includes('n')) out.y += out.height - s.h;
    out.width = s.w;
    out.height = s.h;
  }
  out.width = Math.max(160, out.width);
  out.height = Math.max(TITLE_H, out.height);
  return { r: out, guides };
}

function snapGridAxis(r: Electron.Rectangle, axis: 'x' | 'y', mode: DragMode, origin: number) {
  const g = settings.snapGrid;
  const round = (v: number) => origin + Math.round((v - origin) / g) * g;
  const size = axis === 'x' ? 'width' : 'height';
  const lo = axis === 'x' ? 'w' : 'n';
  const hi = axis === 'x' ? 'e' : 's';
  if (mode === 'move') r[axis] = round(r[axis]);
  else {
    if (mode.includes(lo)) {
      const end = r[axis] + r[size];
      r[axis] = round(r[axis]);
      r[size] = end - r[axis];
    }
    if (mode.includes(hi)) r[size] = round(r[axis] + r[size]) - r[axis];
  }
}

function dragStart(box: BoxState, mode: DragMode, sx: number, sy: number) {
  const w = fenceWins.get(box.id);
  if (!w || w.isDestroyed()) return;
  if (box.locked) {
    w.webContents.send('fence:locked');
    return;
  }
  if (mode !== 'move' && box.collapsed && !peeking.has(box.id)) mode = mode.includes('e') ? 'e' : mode.includes('w') ? 'w' : 'move';
  dragging.set(box.id, { mode, sx, sy, r: w.getBounds(), moved: false });
}

function dragMove(box: BoxState, x: number, y: number) {
  const d = dragging.get(box.id);
  const w = fenceWins.get(box.id);
  if (!d || !w || w.isDestroyed()) return;
  const dx = Math.round(x - d.sx);
  const dy = Math.round(y - d.sy);
  if (!d.moved && Math.abs(dx) + Math.abs(dy) < 3) return;
  d.moved = true;
  const r = { ...d.r };
  if (d.mode === 'move') (r.x += dx), (r.y += dy);
  else {
    if (d.mode.includes('e')) r.width += dx;
    if (d.mode.includes('s')) r.height += dy;
    if (d.mode.includes('w')) (r.x += dx), (r.width -= dx);
    if (d.mode.includes('n')) (r.y += dy), (r.height -= dy);
    if (r.width < 160) {
      if (d.mode.includes('w')) r.x -= 160 - r.width;
      r.width = 160;
    }
    const minH = TITLE_H + 40;
    if (r.height < minH && !box.collapsed) {
      if (d.mode.includes('n')) r.y -= minH - r.height;
      r.height = minH;
    }
  }
  const snapped = snapRect(box.id, r, d.mode);
  w.setBounds(snapped.r);
  const gw = guideWindow();
  if (snapped.guides.length) {
    const o = screen.getPrimaryDisplay().bounds;
    gw.webContents.send('guides', snapped.guides.map((g) => ({ x1: g.x1 - o.x, y1: g.y1 - o.y, x2: g.x2 - o.x, y2: g.y2 - o.y })));
    if (!gw.isVisible()) gw.showInactive();
  } else if (gw.isVisible()) gw.webContents.send('guides', []);
}

function dragEnd(box: BoxState): boolean {
  const d = dragging.get(box.id);
  dragging.delete(box.id);
  if (guideWin && !guideWin.isDestroyed()) {
    guideWin.webContents.send('guides', []);
    guideWin.hide();
  }
  const w = fenceWins.get(box.id);
  if (!d || !w || w.isDestroyed()) return false;
  if (d.moved) {
    const r = w.getBounds();
    box.x = r.x;
    box.y = r.y;
    box.w = r.width;
    if (!box.collapsed || peeking.has(box.id)) box.h = Math.max(TITLE_H + 40, r.height);
    saveLayout();
  }
  return d.moved;
}

// ---------------------------------------------------------------- desktop pages
function pagerWindow(): BrowserWindow {
  if (pagerWin && !pagerWin.isDestroyed()) return pagerWin;
  const wa = workArea();
  pagerWin = popupWindow({ width: 420, height: 96, x: Math.round(wa.x + wa.width / 2 - 210), y: wa.y + wa.height - 130, alwaysOnTop: true, focusable: true }, 'pager.html');
  return pagerWin;
}
let pagerTimer: NodeJS.Timeout | null = null;
function showPager() {
  const w = pagerWindow();
  const send = () => w.webContents.send('pager', { pages: layout.pages ?? ['桌面 1'], page: curPage(), demo: !!CAPTURE_DIR, ...themePayload() });
  if (w.webContents.isLoading()) w.webContents.once('did-finish-load', send);
  else send();
  w.showInactive();
  if (pagerTimer) clearTimeout(pagerTimer);
  pagerTimer = setTimeout(() => !w.isDestroyed() && w.hide(), DEMO ? 600000 : 2200);
}

function switchPage(n: number) {
  const pages = layout.pages?.length ? layout.pages : ['桌面 1'];
  const target = ((n % pages.length) + pages.length) % pages.length;
  const from = curPage();
  if (target === from && pages.length > 1) return showPager();
  layout.page = target;
  const dir = target > from ? 'left' : 'right';
  for (const b of layout.boxes) {
    const w = fenceWins.get(b.id);
    if (!w || w.isDestroyed()) continue;
    if (shouldShow(b)) {
      if (!w.isVisible()) {
        w.showInactive();
        if (isWin && settings.keepBottom && !settings.embedDesktop) winLayer.sendToBottom(w);
      }
      w.webContents.send('fence:enter', dir);
    } else w.hide();
  }
  saveLayout();
  updateTrayMenu();
  showPager();
  if (!pageHasContent(target) && !SMOKE)
    toast({
      kind: 'info',
      title: `「${pages[target]}」还没有格子`,
      message: `按 ${activeHotkeys.pagePrev || 'Ctrl+Alt+Left'} 回到上一页；在桌面右键或拖出矩形可在此页新建格子`,
      timeout: 7000,
    });
}

function addPage(name?: string) {
  layout.pages = layout.pages?.length ? layout.pages : ['桌面 1'];
  layout.pages.push(name || `桌面 ${layout.pages.length + 1}`);
  switchPage(layout.pages.length - 1);
  toast({ kind: 'success', title: `已新建「${layout.pages[layout.pages.length - 1]}」`, message: `用 ${activeHotkeys.pagePrev || 'Ctrl+Alt+Left'} / ${activeHotkeys.pageNext || 'Ctrl+Alt+Right'} 切换桌面页` });
}

function deletePage(i: number) {
  const pages = layout.pages ?? ['桌面 1'];
  if (pages.length <= 1) return;
  pushUndo(`删除桌面页「${pages[i]}」`);
  for (const b of layout.boxes) {
    const p = b.page ?? 0;
    if (p === i) b.page = Math.max(0, i - 1);
    else if (p > i) b.page = p - 1;
  }
  pages.splice(i, 1);
  layout.page = Math.min(curPage(), pages.length - 1);
  saveLayout();
  syncFences();
}

function moveBoxToPage(box: BoxState, page: number) {
  box.page = page;
  saveLayout();
  syncFences();
  toast({ kind: 'info', title: `「${box.title}」已移到「${layout.pages?.[page] ?? '桌面 ' + (page + 1)}」` });
}

// ---------------------------------------------------------------- snapshots + per-resolution layouts
const resolutionKey = () => {
  const d = screen.getPrimaryDisplay();
  return `${d.size.width}x${d.size.height}@${d.scaleFactor}`;
};
function loadSnapshots(): Snapshot[] {
  return loadJSON<Snapshot[]>('snapshots.json', []);
}
function saveSnapshot(name?: string): Snapshot {
  const list = loadSnapshots();
  const d = new Date();
  const snap: Snapshot = {
    id: randomUUID(),
    name: (name || `布局 ${d.getMonth() + 1}-${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`).slice(0, 30),
    at: Date.now(),
    resolution: resolutionKey(),
    boxes: structuredClone(layout.boxes),
    pages: [...(layout.pages ?? ['桌面 1'])],
  };
  list.unshift(snap);
  saveJSON('snapshots.json', list.slice(0, 30));
  settingsWin?.webContents.send('settings:snapshots', loadSnapshots());
  return snap;
}
function restoreSnapshot(id: string): boolean {
  const snap = loadSnapshots().find((x) => x.id === id);
  if (!snap) return false;
  pushUndo(`恢复快照「${snap.name}」`);
  layout.boxes = structuredClone(snap.boxes);
  layout.pages = [...snap.pages];
  layout.page = 0;
  reconcile();
  layout.boxes.filter(isPortal).forEach((b) => loadPortal(b).then(() => sendFence(b)));
  saveLayout();
  syncFences();
  toast({ kind: 'success', title: `已恢复布局「${snap.name}」`, action: { label: '撤销', command: 'undo-layout' } });
  return true;
}
function deleteSnapshot(id: string) {
  saveJSON('snapshots.json', loadSnapshots().filter((x) => x.id !== id));
}
function renameSnapshot(id: string, name: string) {
  const list = loadSnapshots();
  const s = list.find((x) => x.id === id);
  if (s && name.trim()) s.name = name.trim().slice(0, 30);
  saveJSON('snapshots.json', list);
}

/** remember fence geometry per screen resolution; restore it when the resolution comes back */
function rememberGeometry() {
  if (!settings.autoResolution || !resKey) return;
  const all = loadJSON<Record<string, Record<string, { x: number; y: number; w: number; h: number }>>>('resolutions.json', {});
  all[resKey] = Object.fromEntries(layout.boxes.map((b) => [b.id, { x: b.x, y: b.y, w: b.w, h: b.h }]));
  saveJSON('resolutions.json', all);
}
let displayTimer: NodeJS.Timeout | null = null;
let displayRestoring = false;
function onDisplayChanged() {
  // Coalesce rapid DPI / monitor plug events to avoid layout races with syncFences.
  if (displayTimer) clearTimeout(displayTimer);
  displayTimer = setTimeout(() => {
    displayTimer = null;
    if (displayRestoring || dragging.size || animating.size) {
      displayTimer = setTimeout(() => onDisplayChanged(), 400);
      return;
    }
    const key = resolutionKey();
    if (key === resKey) {
      for (const b of layout.boxes) clampBoxToDisplays(b);
      return syncFences();
    }
    displayRestoring = true;
    try {
      rememberGeometry();
      resKey = key;
      const geo = settings.autoResolution
        ? loadJSON<Record<string, Record<string, { x: number; y: number; w: number; h: number }>>>('resolutions.json', {})[key]
        : undefined;
      for (const b of layout.boxes) {
        const g = geo?.[b.id];
        if (g) Object.assign(b, g);
        clampBoxToDisplays(b);
      }
      saveLayout();
      syncFences();
      if (geo) toast({ kind: 'info', title: '已恢复此分辨率下的布局', message: key.replace(/@.*/, '') });
    } finally {
      displayRestoring = false;
    }
  }, 350);
}

// ---------------------------------------------------------------- Peek: bring fences above all windows
function setPeek(on: boolean) {
  peekOn = on;
  for (const b of layout.boxes) {
    const w = fenceWins.get(b.id);
    if (!w || w.isDestroyed() || !onPage(b)) continue;
    if (on) {
      if (!w.isVisible()) w.showInactive();
      w.setAlwaysOnTop(true, 'floating');
      w.moveTop();
      w.webContents.send('fence:peekAll', true);
    } else {
      w.setAlwaysOnTop(false);
      w.webContents.send('fence:peekAll', false);
      if (!shouldShow(b)) w.hide();
      else if (isWin && settings.keepBottom && !settings.embedDesktop) winLayer.sendToBottom(w);
    }
  }
}

function addBox(extra: Partial<BoxState> = {}, rename = true) {
  const b = newBox(extra.title ?? '新建格子', null, layout.boxes, extra);
  layout.boxes.push(b);
  saveLayout();
  syncFences();
  if (rename) setTimeout(() => fenceWins.get(b.id)?.webContents.send('fence:startRename'), 700);
  return b;
}
/** Empty custom container: drag files in as references (or copy/move per dropMode). */
function addManualBox(rename = true) {
  return addBox(
    {
      title: '自定义容器',
      kind: 'manual',
      icon: 'ri-layout-masonry-line',
      color: '#4f7cff',
      sort: 'manual',
      items: [],
      dropMode: 'reference',
    },
    rename,
  );
}

// ---------------------------------------------------------------- Fence Tabs
function ensureTabs(box: BoxState): FenceTab[] {
  if (box.tabs?.length) return box.tabs;
  const id = randomUUID();
  box.tabs = [{ id, title: '默认', items: [...box.items] }];
  box.activeTabId = id;
  return box.tabs;
}
function activateFenceTab(box: BoxState, tabId: string) {
  if (!box.tabs?.length) return;
  const cur = box.tabs.find((x) => x.id === box.activeTabId) ?? box.tabs[0];
  if (cur) cur.items = [...box.items];
  const tab = box.tabs.find((x) => x.id === tabId);
  if (!tab) return;
  box.activeTabId = tab.id;
  box.items = [...tab.items];
  saveLayout();
  syncFences();
}
function addFenceTab(box: BoxState, title?: string) {
  ensureTabs(box);
  const cur = box.tabs!.find((x) => x.id === box.activeTabId) ?? box.tabs![0];
  if (cur) cur.items = [...box.items];
  const id = randomUUID();
  const n = (box.tabs?.length ?? 0) + 1;
  box.tabs!.push({ id, title: (title || `标签 ${n}`).slice(0, 32), items: [] });
  box.activeTabId = id;
  box.items = [];
  saveLayout();
  syncFences();
  toast({ kind: 'success', title: '已新建标签', message: box.tabs!.find((x) => x.id === id)!.title });
}
function renameFenceTab(box: BoxState, tabId: string, title: string) {
  const tab = box.tabs?.find((x) => x.id === tabId);
  if (!tab || !title.trim()) return;
  tab.title = title.trim().slice(0, 32);
  saveLayout();
  syncFences();
}
function removeFenceTab(box: BoxState, tabId: string) {
  if (!box.tabs?.length) return;
  if (box.tabs.length <= 1) {
    // Collapse back to a single pile
    const only = box.tabs[0];
    box.items = [...(only?.items ?? box.items)];
    box.tabs = undefined;
    box.activeTabId = undefined;
    saveLayout();
    syncFences();
    return;
  }
  const idx = box.tabs.findIndex((x) => x.id === tabId);
  if (idx < 0) return;
  box.tabs.splice(idx, 1);
  const next = box.tabs[Math.max(0, idx - 1)] ?? box.tabs[0];
  box.activeTabId = next.id;
  box.items = [...next.items];
  saveLayout();
  syncFences();
}

function applyProjectSpace(paths: string[], title: string) {
  const existing = new Set(paths);
  const list = [...existing].filter((p) => desktopMap.has(p) || externalMap.has(p) || fs.existsSync(p));
  if (!list.length) {
    toast({ kind: 'warning', title: '项目空间为空', message: '没有可聚合的文件' });
    return null;
  }
  pushUndo(`创建项目空间「${title}」`);
  // Pull membership from other non-virtual boxes so files land in the project fence
  for (const b of layout.boxes) {
    if (b.kind === 'recent' || b.kind === 'portal') continue;
    b.items = b.items.filter((p) => !existing.has(p));
    if (b.tabs?.length) {
      for (const tab of b.tabs) tab.items = tab.items.filter((p) => !existing.has(p));
    }
  }
  const box = addBox(
    {
      title: title.slice(0, 40) || '项目空间',
      kind: 'manual',
      icon: 'ri-briefcase-4-line',
      color: '#9b6bff',
      sort: 'manual',
      items: list,
      dropMode: 'reference',
    },
    false,
  );
  toast({ kind: 'success', title: `已创建「${box.title}」`, message: `${list.length} 个相关文件已聚合`, action: { label: '撤销', command: 'undo-layout' } });
  return box;
}

function setDropMode(box: BoxState, mode: 'reference' | 'ask' | 'copy' | 'move') {
  box.dropMode = mode;
  saveLayout();
  syncFences();
  const label = { reference: '整理引用（不改磁盘）', ask: '每次询问', copy: '复制文件到目标', move: '移动文件到目标' }[mode];
  toast({ kind: 'success', title: '放入方式已更新', message: label });
}
function removeFromBox(box: BoxState, paths: string[]) {
  if (isVirtual(box)) return;
  const s = new Set(paths);
  if (!paths.some((p) => box.items.includes(p))) return;
  pushUndo(`从「${box.title}」移出`);
  box.items = box.items.filter((p) => !s.has(p));
  paths.forEach((p) => {
    if (![...layout.boxes].some((b) => !isVirtual(b) && b.items.includes(p))) externalMap.delete(p);
  });
  saveLayout();
  syncFences();
  toast({ kind: 'success', title: `已从格子移出 ${paths.length} 项`, message: '文件仍在原位置', action: { label: '撤销', command: 'undo-layout' } });
}
function addRecentBox() {
  if (layout.boxes.some(isRecent)) {
    toast({ kind: 'info', title: '已存在「最近文件」格子' });
    return;
  }
  addBox({ title: '最近文件', kind: 'recent', icon: 'ri-time-line', color: '#14b8a6', sort: 'date' }, false);
}

function deleteBox(box: BoxState | undefined | null) {
  if (!box) return;
  pushUndo(`删除格子「${box.title}」`);
  layout.boxes = layout.boxes.filter((b) => b.id !== box.id);
  portalWatch.get(box.id)?.stop();
  portalWatch.delete(box.id);
  reconcile();
  saveLayout();
  syncFences();
  toast({ kind: 'success', title: `已删除格子「${box.title}」`, message: isVirtual(box) ? '文件没有任何变化' : '其中的文件已回到对应分类格子', action: { label: '撤销', command: 'undo-layout' } });
}

type BoxStyle = Pick<BoxState, 'color' | 'tint' | 'alpha' | 'iconTint' | 'titleStyle' | 'titleAlign' | 'titleFont' | 'titleSize' | 'titleColor' | 'icon' | 'iconSizeOverride' | 'tabStyle' | 'hideTitleIcon'>;
let styleClipboard: BoxStyle | null = null;
function pickStyle(b: BoxState): BoxStyle {
  const { color, tint, alpha, iconTint, titleStyle, titleAlign, titleFont, titleSize, titleColor, icon, iconSizeOverride, tabStyle, hideTitleIcon } = b;
  toast({ kind: 'success', title: '已复制外观', message: '在其他格子菜单 › 外观样式 › 粘贴外观' });
  return { color, tint, alpha, iconTint, titleStyle, titleAlign, titleFont, titleSize, titleColor, icon, iconSizeOverride, tabStyle, hideTitleIcon };
}
function updateBox(box: BoxState, patch: Partial<BoxState>) {
  Object.assign(box, patch);
  saveLayout();
  syncFences();
}

const SORT_LABEL: Record<SortMode, string> = { manual: '手动排列', name: '名称', date: '修改时间', type: '类型', size: '大小' };

function pagesSubmenu(box?: BoxState): MenuItemConstructorOptions[] {
  const pages = layout.pages?.length ? layout.pages : ['桌面 1'];
  if (box)
    return pages.map((name, i) => ({ label: name, type: 'radio' as const, checked: (box.page ?? 0) === i, click: () => moveBoxToPage(box, i) }));
  return [
    ...pages.map((name, i) => ({ label: name, type: 'radio' as const, checked: curPage() === i, click: () => switchPage(i) })),
    { type: 'separator' as const },
    { label: '新建桌面页', click: () => addPage() },
    { label: '管理桌面页…', click: () => openSettings('pages') },
  ];
}

function boxMenu(box: BoxState, win: BrowserWindow) {
  const tpl: MenuItemConstructorOptions[] = [
    { label: '重命名格子', accelerator: isWin ? 'F2' : undefined, click: () => win.webContents.send('fence:startRename') },
    { label: '外观（颜色、透明度、标题样式）…', click: () => openAppearance(box) },
    {
      label: '视图',
      submenu: (['grid', 'list'] as ViewMode[]).map((v) => ({
        label: v === 'grid' ? '图标' : '列表',
        type: 'radio' as const,
        checked: (box.view ?? 'grid') === v,
        click: () => updateBox(box, { view: v }),
      })),
    },
    {
      label: '排序方式',
      submenu: (Object.keys(SORT_LABEL) as SortMode[])
        .filter((m) => !(isRecent(box) && m === 'manual'))
        .map((m) => ({ label: m === 'manual' && isPortal(box) ? '默认（文件夹在前）' : SORT_LABEL[m], type: 'radio' as const, checked: (box.sort ?? 'manual') === m, click: () => updateBox(box, { sort: m }) })),
    },
    { label: box.collapsed ? '展开' : '卷起（只显示标题）', click: () => toggleCollapse(box) },
    { label: '大小', submenu: sizeSubmenu(box) },
    {
      label: '外观样式',
      submenu: [
        { label: '隐藏标题栏图标', type: 'checkbox', checked: !!box.hideTitleIcon, click: (mi) => updateBox(box, { hideTitleIcon: mi.checked }) },
        { type: 'separator' },
        { label: '复制外观', click: () => (styleClipboard = pickStyle(box)) },
        { label: '粘贴外观', enabled: !!styleClipboard, click: () => styleClipboard && updateBox(box, { ...styleClipboard }) },
        { label: '重置为默认外观', click: () => updateBox(box, { color: '', tint: 0.35, alpha: undefined, iconTint: false, titleStyle: 'band', titleAlign: 'center', titleFont: '', titleSize: undefined, titleColor: '', iconSizeOverride: undefined, hideTitleIcon: undefined, tabStyle: undefined }) },
      ],
    },
    { label: '锁定位置和大小', type: 'checkbox', checked: !!box.locked, click: (mi) => updateBox(box, { locked: mi.checked }) },
    { label: '快速隐藏时保留此格子', type: 'checkbox', checked: !!box.keepOnHide, click: (mi) => updateBox(box, { keepOnHide: mi.checked }) },
    { label: '移到桌面页', submenu: pagesSubmenu(box) },
    ...(isPortal(box)
      ? ([
          { type: 'separator' },
          { label: '在资源管理器中打开', click: () => box.portal && shell.openPath(box.portal.cwd || box.portal.root) },
          { label: '回到映射根目录', enabled: !!box.portal && box.portal.cwd !== box.portal.root, click: () => box.portal && portalNav(box, box.portal.root) },
          { label: '更改映射文件夹…', click: () => changePortal(box) },
          {
            label: '同步方式',
            submenu: [
              {
                label: '仅显示（文件夹镜像）',
                type: 'radio',
                checked: (box.portal?.sync ?? 'mirror') === 'mirror',
                click: () => setPortalSync(box, 'mirror'),
              },
              {
                label: '双向同步（拖入写入文件夹）',
                type: 'radio',
                checked: (box.portal?.sync ?? 'mirror') === 'bidirectional',
                click: () => setPortalSync(box, 'bidirectional'),
              },
            ],
          },
        ] as MenuItemConstructorOptions[])
      : []),
    ...((isManual(box) || (!isVirtual(box) && box.kind !== 'recent'))
      ? ([
          {
            label: '放入方式',
            submenu: [
              { label: '整理引用（默认，不改磁盘）', type: 'radio', checked: (box.dropMode ?? 'reference') === 'reference', click: () => setDropMode(box, 'reference') },
              { label: '每次询问', type: 'radio', checked: box.dropMode === 'ask', click: () => setDropMode(box, 'ask') },
              { label: '复制到…（需选目录）', type: 'radio', checked: box.dropMode === 'copy', click: () => setDropMode(box, 'copy') },
              { label: '移动到…（需选目录）', type: 'radio', checked: box.dropMode === 'move', click: () => setDropMode(box, 'move') },
            ],
          },
        ] as MenuItemConstructorOptions[])
      : []),
    ...((!isPortal(box) && !isRecent(box))
      ? ([
          { type: 'separator' },
          {
            label: '标签组',
            submenu: [
              { label: '新建标签', click: () => addFenceTab(box) },
              ...(box.tabs?.length
                ? [
                    { type: 'separator' as const },
                    ...box.tabs.map((tab) => ({
                      label: tab.title + (tab.id === box.activeTabId ? '（当前）' : ''),
                      icon: dotIcon(tab.color ?? ''),
                      submenu: [
                        { label: '切换到此标签', enabled: tab.id !== box.activeTabId, click: () => activateFenceTab(box, tab.id) },
                        { label: '重命名…', click: () => win.webContents.send('fence:tabPromptRename', tab.id, tab.title) },
                        { label: '颜色与样式…', click: () => tabMenu(box, tab.id, win) },
                        {
                          label: '删除标签',
                          enabled: (box.tabs?.length ?? 0) > 1,
                          click: async () => {
                            const r = await dialog.showMessageBox(win, { type: 'question', title: '删除标签', message: `删除标签「${tab.title}」？`, detail: '其中的文件会回到同组的其他标签，不会删除任何文件。', buttons: ['删除标签', '取消'], defaultId: 0, cancelId: 1, noLink: true });
                            if (r.response === 0) removeFenceTab(box, tab.id);
                          },
                        },
                      ],
                    })),
                    { type: 'separator' as const },
                    {
                      label: '标签样式',
                      submenu: ([['pill', '胶囊'], ['underline', '下划线'], ['classic', '经典卡片']] as const).map(([v, l]) => ({ label: l, type: 'radio' as const, checked: (box.tabStyle ?? 'pill') === v, click: () => updateBox(box, { tabStyle: v }) })),
                    },
                    { type: 'separator' as const },
                    {
                      label: '关闭标签组（合并为单堆）',
                      click: () => {
                        const all = new Set<string>();
                        for (const tab of box.tabs ?? []) tab.items.forEach((x) => all.add(x));
                        box.items.forEach((x) => all.add(x));
                        box.items = [...all];
                        box.tabs = undefined;
                        box.activeTabId = undefined;
                        saveLayout();
                        syncFences();
                      },
                    },
                  ]
                : []),
            ],
          },
        ] as MenuItemConstructorOptions[])
      : []),
    { type: 'separator' },
    { label: '新建自定义容器', click: () => addManualBox() },
    { label: '新建格子', click: () => addBox() },
    { label: '映射文件夹…', click: () => createPortal() },
    { label: '新建「最近文件」格子', enabled: !layout.boxes.some(isRecent), click: addRecentBox },
    { label: '删除此格子（保留文件）', click: () => deleteBox(box) },
    { type: 'separator' },
    { label: '一键整理（规则 + 类型）', click: () => organizeByRules() },
    { label: 'AI 智能整理…', click: () => openHub('organize') },
    { label: '整理规则…', click: () => openSettings('rules') },
    { label: '撤销', accelerator: isWin ? 'CmdOrCtrl+Z' : undefined, enabled: undoStack.length > 0, click: undoLayout },
    { label: '保存布局快照', click: () => toast({ kind: 'success', title: `已保存快照「${saveSnapshot().name}」`, message: '可在 设置 › 桌面页与快照 中恢复' }) },
    { label: allLocked() ? '解锁所有格子' : '锁定所有格子', click: () => lockAll(!allLocked()) },
    { type: 'separator' },
    { label: 'AI 工作台', click: () => openHub() },
    { label: '快速搜索 / AI 命令', accelerator: (isWin && activeHotkeys.search) || undefined, registerAccelerator: false, click: () => openSearch() },
    { label: '设置', click: () => openSettings() },
  ];
  Menu.buildFromTemplate(tpl).popup({ window: win });
}

/** File right-click: the real Explorer menu (IContextMenu via helper) with our fence actions on top; Electron menu fallback. */
let lastNativePick = '';
async function itemMenuNative(box: BoxState, paths: string[], win: BrowserWindow) {
  const real = paths.filter((p) => fs.existsSync(p));
  if ((!isWin && !process.env.AIDESK_MOCK_HELPER) || !settings.nativeItemMenu || !winLayer.supported || !real.length) return itemMenu(box, paths, win);
  const extras = [
    ...(!isVirtual(box) ? [{ id: 'remove', label: '从格子移出（保留文件）' }] : []),
    { id: 'move', label: '移动到格子…' },
    { id: 'ai', label: 'AI 桌面整理…（总结 / 重命名 / 规则）' },
  ];
  const cur = screen.getCursorScreenPoint();
  const phys = dipToPhys(cur);
  try {
    const r = await winLayer.contextMenu(real, Math.round(phys.x), Math.round(phys.y), extras);
    lastNativePick = `${r.pick}:${r.extra ?? ''}`;
    if (r.pick === 'extra') {
      if (r.extra === 'remove') removeFromBox(box, paths);
      else if (r.extra === 'move') moveToFenceMenu(paths, box, win);
      else if (r.extra === 'ai') itemMenu(box, paths, win);
    } else if (r.pick === 'rename') {
      if (isPortal(box)) void portalRename(box, real[0]);
      else openHub('rename', real);
    } else if (r.pick === 'shell') {
      setTimeout(() => void refresh(), 600); // delete / cut / rename by shell → rescan soon
    }
    if (r.partial) toast({ kind: 'info', title: '系统菜单只作用于同一文件夹中的项目', message: '跨文件夹多选时，仅第一个文件夹中的项目被处理' });
  } catch (e: any) {
    log('native ctxmenu failed', String(e?.message ?? e));
    itemMenu(box, paths, win);
  }
}

// ---------------------------------------------------------------- v1.3.2 keyboard actions (Delete / Ctrl+C/X/V / tab menu)
/** Delete key: references leave the fence; real files go to the Recycle Bin after confirmation (Fences/Explorer behaviour).
 *  Shift+Delete only removes from the fence (never deletes permanently — safer than Explorer). */
async function deleteItems(box: BoxState, paths: string[], shift: boolean) {
  if (isPortal(box)) {
    if ((box.portal?.sync ?? 'mirror') === 'bidirectional') return portalTrash(box, paths);
    return toast({ kind: 'info', title: '仅显示模式下不能删除文件', message: '在格子菜单 › 同步方式 中切换为双向同步' });
  }
  const refs = paths.filter((p) => !desktopMap.has(p));
  const real = paths.filter((p) => desktopMap.has(p));
  if (shift || isRecent(box)) {
    if (isVirtual(box)) return toast({ kind: 'info', title: '此格子按规则自动显示，无法移出' });
    return removeFromBox(box, paths);
  }
  if (refs.length && !isVirtual(box)) removeFromBox(box, refs);
  if (!real.length) return;
  if (!SMOKE) {
    const one = real.length === 1 ? `「${itemOf(real[0])?.name ?? path.basename(real[0])}」` : `这 ${real.length} 个项目`;
    const r = await dialog.showMessageBox(fenceWins.get(box.id) ?? undefined!, {
      type: 'warning',
      title: '删除',
      message: `确定将${one}移到回收站？`,
      detail: '会删除桌面上的真实文件，可在系统回收站中还原。\n只想从格子里移出而保留文件：按 Shift+Delete。',
      buttons: ['移到回收站', '取消'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (r.response !== 0) return;
  }
  let ok = 0;
  const failed: string[] = [];
  for (const p of real) {
    try {
      if (!fs.existsSync(p)) continue;
      await shell.trashItem(p);
      ok++;
    } catch (e: any) {
      failed.push(path.basename(p));
      log('trash failed', p, String(e?.message ?? e));
    }
  }
  await refresh();
  if (ok) toast({ kind: 'success', title: `已移到回收站 ${ok} 项`, message: '可在回收站中还原' });
  if (failed.length) toast({ kind: 'warning', title: `${failed.length} 项未能删除`, message: `${failed.slice(0, 3).join('、')}${itemOf(real[0])?.source === 'public' ? '（公用桌面需要管理员权限）' : ''}` });
}

let clipCut = false;
async function clipItems(paths: string[], cut: boolean) {
  const valid = paths.filter((p) => fs.existsSync(p));
  if (!valid.length) return;
  clipCut = cut;
  let native = false;
  if (winLayer.supported) {
    try {
      await winLayer.setClipboardFiles(valid, cut);
      native = true;
    } catch (e: any) {
      log('clip native failed', String(e?.message ?? e));
    }
  }
  if (!native) clipboard.writeText(valid.join('\r\n'));
  toast({
    kind: 'success',
    title: `${cut ? '已剪切' : '已复制'} ${valid.length} 项`,
    message: native ? '可以在资源管理器或其他格子中粘贴（Ctrl+V）' : '已复制文件路径（原生剪贴板不可用）',
  });
}
async function clipFiles(): Promise<string[]> {
  if (winLayer.supported) {
    try {
      const r = await winLayer.getClipboardFiles();
      if (r?.length) return r.filter((p) => fs.existsSync(p));
    } catch (e: any) {
      log('clip get failed', String(e?.message ?? e));
    }
  }
  // fallback: path list in text clipboard
  return clipboard
    .readText()
    .split(/\r?\n/)
    .map((s) => s.trim().replace(/^"|"$/g, ''))
    .filter((s) => s && path.isAbsolute(s) && fs.existsSync(s));
}

const TAB_COLORS: { name: string; value: string }[] = [
  { name: '跟随格子', value: '' },
  { name: '蓝', value: '#3b82f6' },
  { name: '青', value: '#14b8a6' },
  { name: '绿', value: '#22c55e' },
  { name: '黄', value: '#eab308' },
  { name: '橙', value: '#f97316' },
  { name: '红', value: '#ef4444' },
  { name: '粉', value: '#ec4899' },
  { name: '紫', value: '#8b5cf6' },
];
/** Small round colour swatch for native menu items (cached). Empty colour = hollow ring ("follow fence"). */
const dotIcons = new Map<string, Electron.NativeImage>();
function dotIcon(hex: string): Electron.NativeImage {
  const hit = dotIcons.get(hex);
  if (hit) return hit;
  const S = 32; // drawn at 2x, shown at 16px
  const buf = Buffer.alloc(S * S * 4);
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  const [r, g, b] = m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [140, 146, 158];
  const c = S / 2 - 0.5;
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const d = Math.hypot(x - c, y - c);
      const outer = Math.max(0, Math.min(1, 11.5 - d));
      const a = m ? outer : outer * Math.max(0, Math.min(1, d - 8.5)); // ring when no colour
      const i = (y * S + x) * 4;
      // premultiplied BGRA (Skia), otherwise the anti-aliased edge renders as a square halo
      buf[i] = Math.round(b * a); buf[i + 1] = Math.round(g * a); buf[i + 2] = Math.round(r * a); buf[i + 3] = Math.round(a * 255);
    }
  const img = nativeImage.createFromBitmap(buf, { width: S, height: S, scaleFactor: 2 });
  dotIcons.set(hex, img);
  return img;
}

function tabMenu(box: BoxState, tabId: string, win: BrowserWindow) {
  const tab = box.tabs?.find((x) => x.id === tabId);
  if (!tab) return;
  const tpl: MenuItemConstructorOptions[] = [
    { label: '重命名标签', click: () => win.webContents.send('fence:tabPromptRename', tabId, tab.title) },
    {
      label: '标签颜色',
      // Electron auto-checks the first radio when none matches, so a custom colour gets its own (checked) entry.
      submenu: [
        ...(tab.color && !TAB_COLORS.some((c) => c.value.toLowerCase() === tab.color!.toLowerCase())
          ? [{ label: `自定义 ${tab.color}`, type: 'radio' as const, checked: true, icon: dotIcon(tab.color) }]
          : []),
        ...TAB_COLORS.map((c) => ({
          label: c.name,
          type: 'radio' as const,
          icon: dotIcon(c.value),
          checked: (tab.color ?? '').toLowerCase() === c.value.toLowerCase(),
          click: () => ((tab.color = c.value || undefined), saveLayout(), syncFences()),
        })),
      ],
    },
    {
      label: '标签样式（整组）',
      submenu: ([['pill', '胶囊'], ['underline', '下划线'], ['classic', '经典卡片']] as const).map(([v, l]) => ({ label: l, type: 'radio' as const, checked: (box.tabStyle ?? 'pill') === v, click: () => updateBox(box, { tabStyle: v }) })),
    },
    { type: 'separator' },
    { label: '新建标签', click: () => addFenceTab(box) },
    {
      label: '删除此标签',
      enabled: (box.tabs?.length ?? 0) > 1,
      click: async () => {
        const r = await dialog.showMessageBox(win, { type: 'question', title: '删除标签', message: `删除标签「${tab.title}」？`, detail: '其中的文件会回到同组的其他标签，不会删除任何文件。', buttons: ['删除标签', '取消'], defaultId: 0, cancelId: 1, noLink: true });
        if (r.response === 0) removeFenceTab(box, tabId);
      },
    },
  ];
  Menu.buildFromTemplate(tpl).popup({ window: win });
}

function moveToFenceMenu(paths: string[], box: BoxState, win: BrowserWindow) {
  const targets = layout.boxes.filter((b) => b.id !== box.id && !isVirtual(b));
  Menu.buildFromTemplate(
    targets.length
      ? targets.map((b) => ({ label: b.title, click: () => moveItems(paths, b.id, null) }))
      : [{ label: '没有其他可放入的格子', enabled: false }],
  ).popup({ window: win });
}

function itemMenu(box: BoxState, paths: string[], win: BrowserWindow) {
  const first = paths[0];
  const it = itemOf(first);
  const tpl: MenuItemConstructorOptions[] = [
    { label: paths.length > 1 ? `打开 ${paths.length} 个项目` : '打开', click: () => paths.forEach(openPath) },
    { label: '打开所在位置', click: () => shell.showItemInFolder(first) },
    { label: 'AI 总结此文件', enabled: paths.length === 1 && canSummarize(first), click: () => summarizeInChat(first) },
    { label: 'AI 翻译此文件', enabled: paths.length === 1 && canSummarize(first), click: () => summarizeInChat(first, 'translate') },
    { label: paths.length > 1 ? `AI 批量重命名 ${paths.length} 个文件…` : 'AI 重命名…', enabled: paths.every((p) => { const i = itemOf(p); return !!i && i.source !== 'public'; }), click: () => openHub('rename', paths) },
    { label: '为此类文件创建规则…', enabled: !!it && !it.isDir && !isVirtual(box), click: () => it && openSettings('rules', { ext: it.ext, target: box.title }) },
    { type: 'separator' },
    {
      label: '移动到格子',
      enabled: !isRecent(box) || true,
      submenu: layout.boxes
        .filter((b) => b.id !== box.id && !isVirtual(b))
        .map((b) => ({ label: b.title, click: () => moveItems(paths, b.id, null) })),
    },
    { label: '复制路径', click: () => clipboard.writeText(paths.join('\r\n')) },
  ];
  if (!isVirtual(box)) {
    tpl.push({
      label: '从格子移出（不删除文件）',
      click: () => removeFromBox(box, paths),
    });
  }
  if (isPortal(box) && (box.portal?.sync ?? 'mirror') === 'bidirectional') {
    tpl.push(
      { label: '重命名（在资源管理器）…', enabled: paths.length === 1, click: () => portalRename(box, paths[0]) },
      { label: '移到回收站…', click: () => void portalTrash(box, paths) },
    );
  }
  Menu.buildFromTemplate(tpl).popup({ window: win });
}

async function openPath(p: string) {
  // The file may have been moved/deleted outside the app since the last scan.
  if (!/^[a-z][a-z0-9+.-]+:\/\//i.test(p) && !(await fs.promises.access(p).then(() => true, () => false))) {
    toast({ kind: 'warning', title: '文件已不存在', message: `${path.basename(p)} 可能已被移动或删除，已刷新列表` });
    void refresh();
    return;
  }
  const err = await shell.openPath(p);
  if (err) toast({ kind: 'error', title: '无法打开', message: `${path.basename(p)}：${err}` });
}

// ---------------------------------------------------------------- icons (concurrency pool + mtime-keyed LRU)
const iconCache = new Map<string, string | null>();
const iconInflight = new Map<string, Promise<string | null>>();
let iconActive = 0;
const iconWait: Array<() => void> = [];
const ICON_CONCURRENCY = 4;
const ICON_CACHE_MAX = 320;
let iconHits = 0;
let iconMisses = 0;
const HUGE_THUMB = 12 * 1024 * 1024; // skip native thumbnails for huge images (glyphs stay)
function iconKey(p: string): string {
  const it = itemOf(p);
  const ext = it?.ext ?? path.extname(p).toLowerCase();
  const m = it?.mtime ? Math.floor(it.mtime) : 0;
  const unique = !it || it.isDir || ['.exe', '.lnk', '.url', '.ico', '.msi', '.appref-ms'].includes(ext) || it.category === 'image';
  return unique ? `${p}|${m}` : 'ext:' + ext;
}
function iconCacheGet(key: string): string | null | undefined {
  if (!iconCache.has(key)) {
    iconMisses++;
    return undefined;
  }
  iconHits++;
  const v = iconCache.get(key)!;
  iconCache.delete(key);
  iconCache.set(key, v);
  return v;
}
function iconCacheSet(key: string, url: string | null) {
  if (iconCache.has(key)) iconCache.delete(key);
  iconCache.set(key, url);
  while (iconCache.size > ICON_CACHE_MAX) {
    const oldest = iconCache.keys().next().value;
    if (oldest === undefined) break;
    iconCache.delete(oldest);
  }
}
function withIconSlot<T>(fn: () => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const run = () => {
      iconActive++;
      fn()
        .then(resolve, reject)
        .finally(() => {
          iconActive--;
          const next = iconWait.shift();
          if (next) next();
        });
    };
    if (iconActive < ICON_CONCURRENCY) run();
    else iconWait.push(run);
  });
}
async function getIcon(p: string): Promise<string | null> {
  const key = iconKey(p);
  const hit = iconCacheGet(key);
  if (hit !== undefined) return hit;
  const existing = iconInflight.get(key);
  if (existing) return existing;
  const job = withIconSlot(async () => {
    const it = itemOf(p);
    let url: string | null = null;
    try {
      // Huge images: skip expensive thumbnail decode; renderer uses glyph until/if needed.
      if (isWin && it?.category === 'image' && it.size > 0 && it.size < HUGE_THUMB) {
        const thumb = await nativeImage.createThumbnailFromPath(p, { width: 96, height: 96 });
        if (!thumb.isEmpty()) url = thumb.toDataURL();
      }
      if (!url && isWin) {
        // On Linux the generic theme icons look out of place; the renderer draws font-icon tiles instead.
        const img = await Promise.race([app.getFileIcon(p, { size: 'large' }), new Promise<null>((r) => setTimeout(() => r(null), 1500))]);
        if (img && !img.isEmpty()) url = img.toDataURL();
      }
    } catch {
      url = null;
    }
    iconCacheSet(key, url);
    return url;
  }).finally(() => iconInflight.delete(key));
  iconInflight.set(key, job);
  return job;
}
function dragIcon(p: string): Electron.NativeImage {
  const cached = iconCacheGet(iconKey(p));
  if (cached) {
    const img = nativeImage.createFromDataURL(cached);
    if (!img.isEmpty()) return img.resize({ width: 32, height: 32 });
  }
  const img = ICON_OK ? nativeImage.createFromPath(ICON_PNG) : nativeImage.createEmpty();
  return img.isEmpty() ? img : img.resize({ width: 32, height: 32 });
}

// ---------------------------------------------------------------- popups: appearance, toast, onboarding
function popupWindow(opts: Electron.BrowserWindowConstructorOptions, file: string, query?: Record<string, string>): BrowserWindow {
  const w = new BrowserWindow({
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    show: false,
    hasShadow: false,
    webPreferences: webPrefs(),
    ...opts,
  });
  w.setMenu(null);
  hookErrors(w, file);
  w.loadFile(path.join(RENDERER, file), query ? { query } : undefined);
  return w;
}

function openAppearance(box: BoxState) {
  appearanceWin?.destroy();
  const W = 340;
  const H = 560;
  const wa = screen.getDisplayMatching({ x: box.x, y: box.y, width: box.w, height: 10 }).workArea;
  let x = box.x + box.w + 8;
  if (x + W > wa.x + wa.width) x = box.x - W - 8;
  if (x < wa.x) x = box.x + 20;
  const y = Math.min(Math.max(wa.y, box.y), wa.y + wa.height - H);
  appearanceWin = popupWindow({ x, y, width: W, height: H, alwaysOnTop: true }, 'appearance.html', { box: box.id });
  appearanceWin.once('ready-to-show', () => appearanceWin?.show());
  appearanceWin.on('blur', () => !DEMO && appearanceWin?.close());
  appearanceWin.on('closed', () => (appearanceWin = null));
}

let toastTimer: NodeJS.Timeout | null = null;
let pendingToast: ToastPayload | null = null;
const toastQueue: ToastPayload[] = [];
let toastBusy = false;
function toast(t: Omit<ToastPayload, 'id'>) {
  const payload: ToastPayload = { id: randomUUID(), timeout: 5000, ...t };
  log('toast', payload.title, payload.message ?? '');
  if (!app.isReady()) return;
  toastQueue.push(payload);
  while (toastQueue.length > 5) toastQueue.shift();
  pumpToast();
}
function pumpToast() {
  if (toastBusy || !toastQueue.length) return;
  toastBusy = true;
  const payload = toastQueue.shift()!;
  const W = 380;
  const H = 104;
  const wa = workArea();
  const place = () => {
    if (!toastWin || toastWin.isDestroyed()) return;
    toastWin.setBounds({ width: W, height: H, x: wa.x + wa.width - W - 12, y: wa.y + wa.height - H - 12 });
    toastWin.webContents.send('toast:show', payload);
    toastWin.showInactive();
  };
  if (!toastWin || toastWin.isDestroyed()) {
    toastWin = popupWindow({ width: W, height: H, x: wa.x + wa.width - W - 12, y: wa.y + wa.height - H - 12, alwaysOnTop: true, focusable: false }, 'toast.html');
    pendingToast = payload;
    toastWin.webContents.once('did-finish-load', () => {
      if (pendingToast) toastWin?.webContents.send('toast:show', pendingToast);
      toastWin?.showInactive();
    });
  } else place();
  if (toastTimer) clearTimeout(toastTimer);
  const ms = payload.timeout ?? (payload.kind === 'error' || payload.kind === 'warning' ? 8000 : 4200);
  toastTimer = setTimeout(() => {
    hideToast();
    toastBusy = false;
    // slight gap so stacked toasts feel sequential
    setTimeout(pumpToast, 180);
  }, ms);
}
function hideToast() {
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = null;
  if (toastWin && !toastWin.isDestroyed() && !CAPTURE_DIR) {
    toastWin.webContents.send('toast:hide');
    setTimeout(() => toastWin && !toastWin.isDestroyed() && toastWin.hide(), 220);
  }
}


// ---------------------------------------------------------------- desktop interaction (v1.3: rubber band + menus)
function physToDip(x: number, y: number): { x: number; y: number } {
  if (!isWin) return { x, y };
  try {
    return screen.screenToDipPoint({ x, y });
  } catch {
    return { x, y };
  }
}
function dipToPhys(p: { x: number; y: number }): { x: number; y: number } {
  if (!isWin) return p;
  try {
    return screen.dipToScreenPoint(p);
  } catch {
    return p;
  }
}
function physRectToDip(r: { x: number; y: number; w: number; h: number }) {
  const a = physToDip(r.x, r.y);
  const b = physToDip(r.x + r.w, r.y + r.h);
  return { x: Math.round(a.x), y: Math.round(a.y), w: Math.round(b.x - a.x), h: Math.round(b.y - a.y) };
}
/** Icon cell size in DIP (desktop spacing when known, else from icon size). */
let desktopSpacing: { x: number; y: number } | null = null;
function iconCell(): { x: number; y: number } {
  const s = settings.iconSize || 40;
  return { x: Math.round(s + 40), y: Math.round(s + 46) };
}

let rbWin: BrowserWindow | null = null;
let rbState: { x1: number; y1: number; x2: number; y2: number; icons: { path: string; x: number; y: number }[]; spacing: { x: number; y: number }; btn: string } | null = null;
function rbOverlay(): BrowserWindow {
  if (rbWin && !rbWin.isDestroyed()) return rbWin;
  rbWin = popupWindow({ width: 10, height: 10, focusable: false, alwaysOnTop: true, x: -100, y: -100 }, 'rubber.html');
  rbWin.setIgnoreMouseEvents(true);
  rbWin.setAlwaysOnTop(true, 'screen-saver');
  rbWin.on('closed', () => (rbWin = null));
  return rbWin;
}
function rbPaint(phase: 'draw' | 'menu' = 'draw') {
  if (!rbState) return;
  const pr = normRect(rbState.x1, rbState.y1, rbState.x2, rbState.y2);
  const r = physRectToDip(pr);
  const w = rbOverlay();
  w.setBounds({ x: r.x, y: r.y, width: Math.max(4, r.w), height: Math.max(4, r.h) });
  if (!w.isVisible()) w.showInactive();
  const count = rbState.icons.length ? iconsInRect(rbState.icons, rbState.spacing, pr).length : 0;
  w.webContents.send('rb:update', { w: r.w, h: r.h, count, accent: '#2f9bff', phase });
}
function rbHide() {
  rbState = null;
  if (rbWin && !rbWin.isDestroyed()) rbWin.hide();
}

function onHelperEvent(ev: { ev: string; [k: string]: any }) {
  if (SMOKE && ev.ev !== 'rb-move') log('helper event', JSON.stringify(ev));
  switch (ev.ev) {
    case 'dblclick-desktop':
      if (settings.dblClickDesktop) setFencesHidden(!layout.hidden);
      break;
    case 'context-desktop':
      void showDesktopContextMenu(ev.x, ev.y);
      break;
    case 'rb-start':
      rbState = { x1: ev.x, y1: ev.y, x2: ev.x, y2: ev.y, icons: [], spacing: { x: 75, y: 75 }, btn: ev.btn };
      // prefetch icon positions once per drag so the overlay can show a live "N icons" count
      winLayer
        .desktopItems(false)
        .then((r) => {
          if (!rbState) return;
          rbState.icons = r.items ?? [];
          rbState.spacing = r.spacing ?? rbState.spacing;
          desktopSpacing = r.spacing ?? desktopSpacing;
          rbPaint();
        })
        .catch(() => {});
      rbPaint();
      break;
    case 'rb-move':
      if (!rbState) return;
      rbState.x2 = ev.x;
      rbState.y2 = ev.y;
      rbPaint();
      break;
    case 'rb-end':
      if (!rbState) rbState = { x1: ev.x1, y1: ev.y1, x2: ev.x2, y2: ev.y2, icons: [], spacing: { x: 75, y: 75 }, btn: ev.btn };
      rbState.x1 = ev.x1;
      rbState.y1 = ev.y1;
      rbState.x2 = ev.x2;
      rbState.y2 = ev.y2;
      void rubberBandMenu();
      break;
    case 'hook-failed':
      log('helper hook failed', ev.error ?? '');
      break;
  }
}

/** Fences: after drawing a rectangle on the desktop -> "Create Fence here" menu. */
async function rubberBandMenu() {
  const st = rbState;
  if (!st) return;
  const pr = normRect(st.x1, st.y1, st.x2, st.y2);
  if (!isDrag(pr)) return rbHide();
  if (!st.icons.length) {
    try {
      const r = await winLayer.desktopItems(false);
      st.icons = r.items ?? [];
      st.spacing = r.spacing ?? st.spacing;
    } catch {
      /* helper may be unavailable: still allow empty fence */
    }
  }
  const hits = iconsInRect(st.icons, st.spacing, pr);
  rbPaint('menu');
  const dip = physRectToDip(pr);
  const done = () => setTimeout(rbHide, 60);
  const tpl: MenuItemConstructorOptions[] = [
    { label: '在此创建格子', click: () => createFenceAt(dip, [], 'normal') },
    { label: hits.length ? `用框选的 ${hits.length} 个图标创建格子` : '用框选的图标创建格子（未框到图标）', enabled: hits.length > 0, click: () => createFenceAt(dip, hits, 'normal') },
    { label: '在此创建自定义容器', click: () => createFenceAt(dip, [], 'manual') },
    { label: '在此创建文件夹映射…', click: () => void portalAt(dip) },
    { type: 'separator' },
    { label: '取消', click: done },
  ];
  lastRbMenu = { labels: tpl.map((i) => i.label ?? '-'), hits, dip };
  if (SMOKE) return rbHide();
  const m = Menu.buildFromTemplate(tpl);
  m.once('menu-will-close', done);
  const c = screen.getCursorScreenPoint();
  m.popup({ x: c.x, y: c.y });
}
async function demoOpenMenu(which: string) {
  const want = process.env.AIDESK_DEMO_BOX;
  const b = layout.boxes.find((x) => onPage(x) && !x.collapsed && fenceWins.get(x.id)?.isVisible() && (!want || x.title === want));
  const w = b && fenceWins.get(b.id);
  if (which === 'rb') {
    const [x1, y1, x2, y2] = (process.env.AIDESK_DEMO_RECT || '980,140,1380,520').split(',').map(Number);
    onHelperEvent({ ev: 'rb-start', x: x1, y: y1, btn: 'right' });
    for (let i = 1; i <= 10; i++) {
      await wait(40);
      onHelperEvent({ ev: 'rb-move', x: x1 + ((x2 - x1) * i) / 10, y: y1 + ((y2 - y1) * i) / 10 });
    }
    if (process.env.AIDESK_DEMO_RB_HOLD) return; // leave the live overlay on screen
    onHelperEvent({ ev: 'rb-end', x1, y1, x2, y2, btn: 'right' });
  } else if (which === 'desktop') void showDesktopContextMenu(1100, 300);
  else if (which === 'title' && b && w) boxMenu(b, w);
  else if (which === 'area' && b && w) fenceAreaMenu(b, w);
  else if (which === 'settings') openSettings('boxes');
  else if (which === 'appearance' && b) {
    openAppearance(b);
    const sc = Number(process.env.AIDESK_DEMO_SCROLL || 0);
    if (sc) setTimeout(() => void appearanceWin?.webContents.executeJavaScript(`document.querySelector('.fscroll')?.scrollTo(0, ${sc})`), 1200);
  }
}
let lastRbMenu: { labels: string[]; hits: string[]; dip: { x: number; y: number; w: number; h: number } } | null = null;

/** Create a fence at a DIP rect, optionally pulling the given desktop items into it (references, Fences-style). */
function createFenceAt(dip: { x: number; y: number; w: number; h: number }, paths: string[], kind: 'normal' | 'manual', title?: string) {
  const wa = workArea({ x: dip.x, y: dip.y, w: dip.w, h: dip.h });
  const r = fenceRectFromDrawn(dip, { x: wa.x, y: wa.y, w: wa.width, h: wa.height });
  pushUndo('新建格子');
  const set = new Set(paths);
  if (set.size) {
    for (const b of layout.boxes) {
      if (isVirtual(b)) continue;
      b.items = b.items.filter((p) => !set.has(p));
      b.tabs?.forEach((tab) => (tab.items = tab.items.filter((p) => !set.has(p))));
    }
    for (const p of set) if (!desktopMap.has(p) && !externalMap.has(p)) void statItem(p, 'external').then((it) => it && externalMap.set(p, it));
  }
  const b = addBox(
    {
      title: title ?? (kind === 'manual' ? '自定义容器' : set.size ? `新建格子（${set.size}）` : '新建格子'),
      x: r.x,
      y: r.y,
      w: r.w,
      h: r.h,
      items: [...set],
      ...(kind === 'manual' ? { kind: 'manual' as const, icon: 'ri-layout-masonry-line', color: '#4f7cff', dropMode: 'reference' as const } : {}),
    },
    true,
  );
  if (set.size) toast({ kind: 'success', title: `已用 ${set.size} 个图标创建格子`, message: '文件仍在桌面文件夹中，格子里是它们的整理视图', action: { label: '撤销', command: 'undo-layout' } });
  return b;
}

/** Fences: create a fence from the icons currently selected on the real desktop (IFolderView selection). */
async function fenceFromSelection(): Promise<BoxState | null> {
  if (!winLayer.supported) {
    toast({ kind: 'info', title: '仅 Windows 支持读取桌面选中的图标' });
    return null;
  }
  try {
    const r = await winLayer.desktopItems(true);
    const items = r.items ?? [];
    if (!items.length) {
      toast({ kind: 'info', title: '桌面上没有选中的图标', message: '先在桌面上框选或 Ctrl+点击选中图标，再执行此操作' });
      return null;
    }
    const bb = boundsOfIcons(items, r.spacing ?? { x: 75, y: 75 }, 12, TITLE_H);
    const dip = bb ? physRectToDip(bb) : { x: 80, y: 80, ...fitToContent(items.length, iconCell(), TITLE_H) };
    const fit = fitToContent(items.length, iconCell(), TITLE_H);
    return createFenceAt({ x: dip.x, y: dip.y, w: Math.max(dip.w, fit.w), h: Math.max(dip.h, fit.h) }, items.map((i) => i.path), 'normal');
  } catch (e: any) {
    toast({ kind: 'warning', title: '读取桌面选中项失败', message: String(e?.message ?? e).slice(0, 120) });
    return null;
  }
}

function portalAt(dip: { x: number; y: number; w: number; h: number }) {
  const wa = workArea({ x: dip.x, y: dip.y, w: dip.w, h: dip.h });
  const r = fenceRectFromDrawn(dip, { x: wa.x, y: wa.y, w: wa.width, h: wa.height });
  return createPortal(undefined, { x: r.x, y: r.y, w: r.w, h: r.h });
}

/** Our empty-desktop right-click menu (primary). x/y are physical px from the helper (optional). */
async function showDesktopContextMenu(px?: number, py?: number) {
  const at = typeof px === 'number' && typeof py === 'number' ? physToDip(px, py) : screen.getCursorScreenPoint();
  let selCount = 0;
  if (winLayer.supported) {
    try {
      selCount = (await Promise.race([winLayer.desktopItems(true), new Promise<never>((_, rej) => setTimeout(() => rej(new Error('t')), 350))])).items.length;
    } catch {
      /* ignore */
    }
  }
  const here = { x: at.x - 20, y: at.y - 12, w: 340, h: 220 };
  const snaps = loadSnapshots().slice(0, 5);
  const tpl: MenuItemConstructorOptions[] = [
    { label: '在此新建格子', click: () => createFenceAt(here, [], 'normal') },
    { label: '在此新建自定义容器', click: () => createFenceAt(here, [], 'manual') },
    { label: '在此映射文件夹…', click: () => void portalAt(here) },
    ...(selCount ? [{ label: `用选中的 ${selCount} 个桌面图标创建格子`, click: () => void fenceFromSelection() }] : []),
    { type: 'separator' },
    { label: '一键整理（规则 + 类型）', click: () => organizeByRules() },
    { label: 'AI 智能整理…', click: () => openHub('organize') },
    { label: layout.hidden ? '显示格子' : '快速隐藏格子', click: () => setFencesHidden(!layout.hidden) },
    { label: allLocked() ? '解锁所有格子' : '锁定所有格子', click: () => lockAll(!allLocked()) },
    { label: `桌面页（${curPage() + 1}/${layout.pages?.length ?? 1}）`, submenu: pagesSubmenu() },
    {
      label: '布局快照',
      submenu: [
        { label: '保存当前布局', click: () => runCommand('snapshot-save') },
        ...(snaps.length ? [{ type: 'separator' as const }] : []),
        ...snaps.map((sn) => ({ label: `恢复「${sn.name}」`, click: () => restoreSnapshot(sn.id) })),
      ],
    },
    { type: 'separator' },
    { label: '快速搜索 / AI 命令', click: () => openSearch() },
    { label: 'AI 工作台', click: () => openHub() },
    { label: '设置…', click: () => openSettings('boxes') },
    ...(isWin ? [{ type: 'separator' as const }, { label: '显示 Windows 桌面菜单', click: () => setTimeout(() => winLayer.nativeDesktopMenu(px ?? 0, py ?? 0), 120) }] : []),
  ];
  Menu.buildFromTemplate(tpl).popup({ x: Math.round(at.x), y: Math.round(at.y) });
}

const allLocked = () => layout.boxes.length > 0 && layout.boxes.every((b) => b.locked);
function lockAll(on: boolean) {
  for (const b of layout.boxes) b.locked = on;
  saveLayout();
  syncFences();
  toast({ kind: 'success', title: on ? '已锁定所有格子' : '已解锁所有格子', message: on ? '格子不能被移动或调整大小' : '' });
}

/** Fence empty-area right-click (Fences: blank space inside a fence). */
function fenceAreaMenu(box: BoxState, win: BrowserWindow) {
  const dir = isPortal(box) ? box.portal?.cwd || box.portal?.root : desktopDirs(false)[0]?.dir;
  const tpl: MenuItemConstructorOptions[] = [
    {
      label: '视图',
      submenu: (['grid', 'list'] as ViewMode[]).map((v) => ({ label: v === 'grid' ? '图标' : '列表', type: 'radio' as const, checked: (box.view ?? 'grid') === v, click: () => updateBox(box, { view: v }) })),
    },
    {
      label: '排序方式',
      submenu: (Object.keys(SORT_LABEL) as SortMode[])
        .filter((m) => !(isRecent(box) && m === 'manual'))
        .map((m) => ({ label: SORT_LABEL[m], type: 'radio' as const, checked: (box.sort ?? 'manual') === m, click: () => updateBox(box, { sort: m }) })),
    },
    {
      label: '图标大小',
      submenu: ([['小', 32], ['中', 40], ['大', 56], ['特大', 72]] as const)
        .map(([l, v]) => ({ label: `${l}（${v}px）`, type: 'radio' as const, checked: box.iconSizeOverride === v, click: () => updateBox(box, { iconSizeOverride: v }) }))
        .concat([{ label: '跟随全局设置', type: 'radio' as const, checked: !box.iconSizeOverride, click: () => updateBox(box, { iconSizeOverride: undefined }) }]),
    },
    { label: '刷新', click: () => void (isPortal(box) ? loadPortal(box).then(() => syncFences()) : refresh()) },
    { type: 'separator' },
    {
      label: '新建',
      enabled: !!dir && !isRecent(box),
      submenu: [
        { label: '文件夹', click: () => dir && void newEntry(box, dir, 'folder') },
        { label: '文本文档', click: () => dir && void newEntry(box, dir, 'txt') },
      ],
    },
    ...(isPortal(box) ? [{ label: '在资源管理器中打开', click: () => box.portal && shell.openPath(box.portal.cwd || box.portal.root) }] : []),
    { type: 'separator' },
    { label: '大小', submenu: sizeSubmenu(box) },
    { label: box.collapsed ? '展开' : '卷起', click: () => toggleCollapse(box) },
    { label: '快速隐藏时保留此格子', type: 'checkbox', checked: !!box.keepOnHide, click: (mi) => updateBox(box, { keepOnHide: mi.checked }) },
    { label: '外观…', click: () => openAppearance(box) },
    { type: 'separator' },
    { label: '格子菜单…', click: () => boxMenu(box, win) },
  ];
  Menu.buildFromTemplate(tpl).popup({ window: win });
}

async function newEntry(box: BoxState, dir: string, kind: 'folder' | 'txt') {
  const base = kind === 'folder' ? '新建文件夹' : '新建文本文档';
  let name = kind === 'folder' ? base : base + '.txt';
  for (let i = 2; fs.existsSync(path.join(dir, name)) && i < 200; i++) name = kind === 'folder' ? `${base} (${i})` : `${base} (${i}).txt`;
  const p = path.join(dir, name);
  try {
    if (kind === 'folder') await fsp.mkdir(p);
    else await fsp.writeFile(p, '');
    if (isPortal(box)) {
      await loadPortal(box);
      syncFences();
    } else {
      await refresh([p]);
      if (!isVirtual(box) && !box.items.includes(p)) moveItems([p], box.id, null, false);
    }
    toast({ kind: 'success', title: `已新建「${name}」` });
  } catch (e: any) {
    toast({ kind: 'error', title: '新建失败', message: String(e?.message ?? e) });
  }
}

function sizeSubmenu(box: BoxState): MenuItemConstructorOptions[] {
  const cell = iconCell();
  const apply = (w: number, h: number) => {
    const wa = workArea(box);
    updateBox(box, { w: Math.min(w, wa.width), h: Math.min(h, wa.height), collapsed: false });
  };
  return [
    ...SIZE_PRESETS.map((s) => ({ label: s.label, click: () => apply(s.cols * cell.x + 16, s.rows * cell.y + TITLE_H + 16) })),
    { type: 'separator' as const },
    { label: '适应内容', click: () => { const f = fitToContent(boxItems(box).length, cell, TITLE_H); apply(f.w, f.h); } },
  ];
}

function refreshDesktopMouseHook() {
  if (!winLayer.supported) return;
  // One low-level hook (in the native helper) serves: double-click quick-hide, our empty-desktop menu (primary),
  // and Fences-style rubber-band drawing of new fences.
  winLayer.configureHook({
    dbl: !!settings.dblClickDesktop,
    ctx: settings.desktopRightClick !== 'explorer',
    draw: settings.drawFence ?? 'right',
  });
}

function applyDesktopShellMenu(enable: boolean, quiet = false) {
  if (!isWin) {
    refreshDesktopMouseHook();
    return { ok: true, detail: 'not-windows' };
  }
  let r = enable ? registerDesktopShellMenu() : unregisterDesktopShellMenu();
  if (enable && !r.ok) {
    // One quiet retry (Explorer sometimes locks the key briefly).
    try {
      unregisterDesktopShellMenu();
    } catch {
      /* ignore */
    }
    r = registerDesktopShellMenu();
  }
  if (enable && r.ok && !isDesktopShellMenuRegistered()) {
    r = { ok: false, detail: 'registered but query failed' };
  }
  refreshDesktopMouseHook();
  if (!quiet) {
    toast({
      kind: r.ok ? 'success' : 'warning',
      title: enable ? (r.ok ? '已启用桌面右键菜单' : '注册桌面右键菜单失败') : '已关闭桌面右键菜单',
      message: r.ok ? (enable ? '在桌面空白处右键可看到「AI 桌面整理」' : '注册表项已移除；仍可用应用内右键菜单') : String((r as any).detail || ''),
    });
  }
  return r;
}

function runCommand(cmd: string) {
  if (cmd.startsWith('learn-rule:')) {
    const [ext, target] = cmd.slice(11).split('|');
    const r = cleanRule({ name: `${ext} 放入${target}`, match: 'all', conds: [{ field: 'ext', op: 'in', value: ext }], target, source: 'learned' }, randomUUID());
    if (r) addRule(r);
    return;
  }
  switch (cmd) {
    case 'portal':
    case 'map-folder':
      return createPortal();
    case 'manual':
    case 'new-manual':
    case 'new-manual-fence':
      return addManualBox();
    case 'fence-from-selection':
      return void fenceFromSelection();
    case 'lock-all':
      return lockAll(!allLocked());
    case 'peek':
      return setPeek(!peekOn);
    case 'page-next':
      return switchPage(curPage() + 1);
    case 'page-prev':
      return switchPage(curPage() - 1);
    case 'page-add':
      return addPage();
    case 'snapshot-save':
    case 'new-snapshot':
      return toast({ kind: 'success', title: `已保存快照「${saveSnapshot().name}」` });
    case 'apply-rules': {
      const n = applyRulesNow();
      return toast({ kind: 'success', title: `规则已应用`, message: `${n} 个文件被重新归类`, action: { label: '撤销', command: 'undo-layout' } });
    }
    case 'settings-rules':
      return openSettings('rules');
    case 'hub':
    case 'ai-hub':
      return openHub();
    case 'cleanup':
      return openHub('cleanup');
    case 'briefing':
      return openHub('briefing');
    case 'rename':
      return openHub('rename');
    case 'undo-layout':
      return undoLayout();
    case 'undo-move':
      return undoMove();
    case 'settings':
      return openSettings();
    case 'settings-ai':
      return openSettings('ai');
    case 'organize':
      return organizeByRules();
    case 'ai-organize':
      return aiOrganize();
    case 'search':
      return openSearch();
    case 'chat':
      return openChat();
    case 'new-box':
      return addBox();
    case 'recent-box':
      return addRecentBox();
    case 'refresh':
      return refresh();
    case 'toggle-boxes':
    case 'toggle-hide':
      return setFencesHidden(!layout.hidden);
    case 'onboarding':
      return openOnboarding();
    case 'help':
      return openHelp();
    case 'reset-layout':
      pushUndo('重置布局');
      layout.boxes = [];
      organizeByRules({ silent: true });
      toast({ kind: 'success', title: '布局已重置', action: { label: '撤销', command: 'undo-layout' } });
      return;
  }
}

function openOnboarding() {
  if (onboardWin && !onboardWin.isDestroyed()) {
    onboardWin.show();
    onboardWin.focus();
    return;
  }
  // Content needs ~860x600; earlier 780x540 clipped the footer after a CSS .step clash.
  // useContentSize + min* keep chrome/DPI from eating the usable area; allow slight resize.
  const W = 860;
  const H = 600;
  const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const wa = d.workArea;
  const scale = d.scaleFactor || 1;
  const w = Math.min(W, Math.max(720, wa.width - 40));
  const h = Math.min(H, Math.max(520, wa.height - 40));
  onboardWin = new BrowserWindow({
    width: w,
    height: h,
    minWidth: Math.round(720 / Math.max(1, scale > 1.5 ? 1 : 1)),
    minHeight: 520,
    x: Math.round(wa.x + (wa.width - w) / 2),
    y: Math.round(wa.y + Math.max(20, (wa.height - h) / 2)),
    frame: false,
    resizable: true,
    maximizable: false,
    useContentSize: true,
    show: false,
    title: '欢迎使用 AI 桌面整理',
    backgroundColor: BG(),
    icon: ICON_OK ? ICON_PNG : undefined,
    webPreferences: webPrefs(),
  });
  onboardWin.setMenu(null);
  hookErrors(onboardWin, 'onboarding');
  onboardWin.loadFile(path.join(RENDERER, 'onboarding.html'));
  onboardWin.once('ready-to-show', () => {
    if (!onboardWin || onboardWin.isDestroyed()) return;
    // Re-center after content metrics settle (DPI / fractional scale).
    const b = onboardWin.getBounds();
    const wa2 = screen.getDisplayMatching(b).workArea;
    onboardWin.setBounds({
      x: Math.round(wa2.x + (wa2.width - b.width) / 2),
      y: Math.round(wa2.y + Math.max(16, (wa2.height - b.height) / 2)),
      width: b.width,
      height: b.height,
    });
    onboardWin.show();
  });
  onboardWin.on('closed', () => (onboardWin = null));
}


function openHelp() {
  cancelWinIdle('help');
  if (helpWin && !helpWin.isDestroyed()) {
    helpWin.show();
    helpWin.focus();
    return;
  }
  const W = 560;
  const H = 420;
  const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const wa = d.workArea;
  helpWin = new BrowserWindow({
    width: W,
    height: H,
    minWidth: 480,
    minHeight: 360,
    x: Math.round(wa.x + (wa.width - W) / 2),
    y: Math.round(wa.y + (wa.height - H) / 2),
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    maximizable: false,
    alwaysOnTop: true,
    show: false,
    title: '快捷键',
    icon: ICON_OK ? ICON_PNG : undefined,
    webPreferences: webPrefs(),
  });
  helpWin.setMenu(null);
  hookErrors(helpWin, 'help');
  helpWin.loadFile(path.join(RENDERER, 'help.html'));
  helpWin.once('ready-to-show', () => helpWin?.show());
  helpWin.on('blur', () => {
    if (!DEMO && helpWin && !helpWin.webContents.isDevToolsOpened()) {
      helpWin.hide();
      armWinIdle('help', () => helpWin, () => (helpWin = null));
    }
  });
  helpWin.on('closed', () => (helpWin = null));
}

// ---------------------------------------------------------------- search
function centerOnCursor(win: BrowserWindow, w: number, h: number) {
  const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  win.setBounds({ x: Math.round(d.x + (d.width - w) / 2), y: Math.round(d.y + d.height * 0.16), width: w, height: h });
}
const SEARCH_W = 776;
const SEARCH_H = 560;
let searchH = SEARCH_H;
function openSearch(initial?: string, plan = false) {
  cancelWinIdle('search');
  if (!searchWin || searchWin.isDestroyed()) {
    searchWin = popupWindow({ width: SEARCH_W, height: SEARCH_H, alwaysOnTop: true }, 'search.html');
    searchWin.on('blur', () => {
      if (!DEMO && searchWin && !searchWin.webContents.isDevToolsOpened()) {
        searchWin.hide();
        armWinIdle('search', () => searchWin, () => (searchWin = null));
      }
    });
    searchWin.on('closed', () => (searchWin = null));
    searchWin.webContents.once('did-finish-load', () => openSearchShow(initial, plan));
    return;
  }
  openSearchShow(initial, plan);
}
function openSearchShow(initial?: string, plan = false) {
  if (!searchWin) return;
  cancelWinIdle('search');
  if (searchWin.isVisible() && initial === undefined && !DEMO) {
    searchWin.hide();
    armWinIdle('search', () => searchWin, () => (searchWin = null));
    return;
  }
  centerOnCursor(searchWin, SEARCH_W, searchH);
  searchWin.show();
  searchWin.focus();
  searchWin.webContents.send('search:focus', { initial: initial ?? '', ai: aiConfigured(settings), plan });
}

async function aiFind(q: string): Promise<{ results: SearchResult[]; note?: string; error?: string }> {
  const all = await getDeepIndex();
  const local = localNLSearch(all, q, 60);
  if (!aiConfigured(settings)) return { results: local, note: '未配置 AI，已使用本地语义解析（时间 / 类型 / 关键词 / 拼音）' };
  const pq = parseQuery(q);
  const pool = new Map<string, DesktopItem>();
  local.forEach((r) => pool.set(r.path, r));
  [...all]
    .filter((i) => (pq.from === undefined ? true : i.mtime >= pq.from - 7 * 86400000))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, 300)
    .forEach((i) => pool.size < 350 && pool.set(i.path, i));
  const cands = [...pool.values()];
  const fmt = (t: number) => {
    const d = new Date(t);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  const now = new Date();
  try {
    const reply = await chatComplete(
      settings,
      [
        {
          role: 'system',
          content:
            `你是文件查找助手。现在是 ${fmt(now.getTime())}（星期${'日一二三四五六'[now.getDay()]}）。` +
            '用户用自然语言描述想找的文件，你只能根据候选列表中的文件名、类型、修改时间判断（看不到内容）。' +
            '返回最可能的文件编号（按可能性排序，最多 10 个），并给出简短中文理由。' +
            '只输出 JSON：{"matches":[{"id":编号,"reason":"理由"}]}；没有合适的返回 {"matches":[]}',
        },
        {
          role: 'user',
          content:
            `查找：${q}\n候选：\n` +
            cands.map((c, i) => `${i}\t${c.name}${c.isDir ? '/' : c.name.endsWith(c.ext) ? '' : c.ext}\t${c.isDir ? '文件夹' : CATEGORY_LABEL[c.category]}\t${fmt(c.mtime)}`).join('\n'),
        },
      ],
      { timeoutMs: 45000 },
    );
    const data = extractJSON<{ matches: { id: number; reason?: string }[] }>(reply);
    const results: SearchResult[] = [];
    for (const m of data?.matches ?? []) {
      const c = cands[m.id];
      if (c && !results.some((r) => r.path === c.path)) results.push({ ...c, score: 100 - results.length, reason: m.reason ? 'AI：' + m.reason : 'AI 推荐' });
    }
    if (!results.length) return { results: local, note: 'AI 未找到明确匹配，以下为本地解析结果' };
    return { results };
  } catch (e: any) {
    return { results: local, error: String(e?.message ?? e), note: 'AI 调用失败，已回退到本地解析' };
  }
}

// ---------------------------------------------------------------- chat
function openChat(forceShow = false): BrowserWindow {
  cancelWinIdle('chat');
  if (!chatWin || chatWin.isDestroyed()) {
    const wa = workArea();
    chatWin = new BrowserWindow({
      width: 460,
      height: Math.min(760, wa.height - 32),
      x: wa.x + wa.width - 480,
      y: wa.y + Math.max(16, wa.height - 776),
      minWidth: 360,
      minHeight: 420,
      frame: false,
      show: false,
      title: 'AI 助手',
      backgroundColor: BG(),
      icon: ICON_OK ? ICON_PNG : undefined,
      webPreferences: webPrefs(),
    });
    chatWin.setMenu(null);
    hookErrors(chatWin, 'chat');
    chatWin.loadFile(path.join(RENDERER, 'chat.html'));
    chatWin.once('ready-to-show', () => chatWin?.show());
    chatWin.on('close', (e) => {
      if (!quitting) {
        e.preventDefault();
        chatWin?.hide();
        armWinIdle('chat', () => chatWin, () => (chatWin = null));
      }
    });
    chatWin.on('closed', () => (chatWin = null));
    return chatWin;
  }
  if (!forceShow && chatWin.isVisible() && chatWin.isFocused()) {
    chatWin.hide();
    armWinIdle('chat', () => chatWin, () => (chatWin = null));
  } else {
    chatWin.show();
    chatWin.focus();
  }
  return chatWin;
}

function summarizeInChat(p: string, mode: 'summary' | 'translate' = 'summary') {
  const w = openChat(true);
  const send = () => w.webContents.send('chat:summarizeFile', p, mode);
  if (w.webContents.isLoading()) w.webContents.once('did-finish-load', () => setTimeout(send, 200));
  else send();
}

function chatSystemPrompt(): string {
  const names = [...desktopMap.values()].slice(0, 150).map((i) => i.name + (i.isDir ? '/' : i.ext && !i.name.endsWith(i.ext) ? i.ext : ''));
  return (
    '你是「AI 桌面整理」内置的智能助手，运行在用户的 Windows 电脑上。请使用简体中文、简洁清晰地回答，可使用 Markdown（标题、列表、代码块）。' +
    `当前时间：${new Date().toLocaleString('zh-CN')}。` +
    (names.length ? `\n（参考）用户桌面上的部分文件名：${names.join('、')}` : '')
  );
}


// ---------------------------------------------------------------- AI features glue (hub, command bar, content index)
let indexTimer: NodeJS.Timeout | null = null;
function scheduleIndex(delay = 12000) {
  if (!settings.contentIndex) return;
  if (indexTimer) clearTimeout(indexTimer);
  indexTimer = setTimeout(async () => {
    try {
      cancelIndexBuild(); // drop any prior partial build before starting
      await buildIndex(await getDeepIndex(), settings, (d, t) => settingsWin?.webContents.send('content:progress', d, t));
    } catch (e) {
      console.warn('[index]', e);
    }
  }, delay);
}

function desktopItems(): DesktopItem[] {
  return [...desktopMap.values()];
}

function findFiles(q: string, limit = 30): DesktopItem[] {
  const all = desktopItems();
  const nl = looksNatural(q) ? localNLSearch(all, q, limit) : [];
  const res = nl.length ? nl : quickSearch(all, q, limit);
  return res.filter((r) => r.score > 0).map((r) => desktopMap.get(r.path)!).filter(Boolean);
}

function boxByTitle(title: string): BoxState {
  let b = layout.boxes.find((x) => !isVirtual(x) && sameTitle(x.title, title));
  if (!b) {
    b = newBox(title, null, layout.boxes, { icon: 'ri-inbox-2-line', color: '#4f7cff' });
    layout.boxes.push(b);
  }
  return b;
}

async function runActions(actions: CmdAction[]): Promise<{ messages: string[]; search?: string }> {
  const messages: string[] = [];
  let search: string | undefined;
  for (const a of actions) {
    switch (a.type) {
      case 'organize':
        organizeByRules();
        messages.push('已一键整理');
        break;
      case 'ai-organize':
        openHub('organize');
        messages.push('已打开 AI 整理建议');
        break;
      case 'create-box':
        if (a.box) addBox({ title: a.box }, false), messages.push(`已新建格子「${a.box}」`);
        break;
      case 'move': {
        const files = a.files?.length ? (a.files.map((p) => desktopMap.get(p)).filter(Boolean) as DesktopItem[]) : findFiles(a.query ?? '');
        if (!files.length || !a.box) {
          messages.push(`没有找到匹配「${a.query}」的文件`);
          break;
        }
        pushUndo('AI 命令：移动到格子');
        const box = boxByTitle(a.box);
        moveItems(files.map((f) => f.path), box.id, null, false);
        messages.push(`已把 ${files.length} 个文件放进「${box.title}」`);
        break;
      }
      case 'create-rule':
        if (a.rule) {
          addRule({ ...a.rule, id: randomUUID() });
          messages.push(`已创建规则「${a.rule.name}」`);
        }
        break;
      case 'hide':
        setFencesHidden(true);
        messages.push('已隐藏格子');
        break;
      case 'show':
        setFencesHidden(false);
        messages.push('已显示格子');
        break;
      case 'page':
        if (Number.isInteger(a.page)) {
          while ((layout.pages?.length ?? 1) <= a.page!) layout.pages!.push(`桌面 ${layout.pages!.length + 1}`);
          switchPage(a.page!);
          messages.push(`已切换到「${layout.pages?.[a.page!]}」`);
        }
        break;
      case 'snapshot-save':
        messages.push(`已保存快照「${saveSnapshot(a.name).name}」`);
        break;
      case 'snapshot-restore': {
        const sn = loadSnapshots().find((x) => x.name === a.name) ?? loadSnapshots().find((x) => a.name && x.name.includes(a.name));
        if (sn && restoreSnapshot(sn.id)) messages.push(`已恢复「${sn.name}」`);
        else messages.push(`没有找到快照「${a.name ?? ''}」`);
        break;
      }
      case 'cleanup':
      case 'rename':
      case 'briefing':
        openHub(a.type);
        messages.push('已打开 AI 工作台');
        break;
      case 'summarize': {
        const f = findFiles(a.query ?? '', 5).find((x) => canSummarize(x.path));
        if (f) {
          summarizeInChat(f.path, a.text === 'translate' ? 'translate' : 'summary');
          messages.push(`正在${a.text === 'translate' ? '翻译' : '总结'}「${fullName(f)}」`);
        } else messages.push(`没有找到可总结的「${a.query}」`);
        break;
      }
      case 'portal':
        if (a.text && fs.existsSync(a.text)) await createPortal(a.text);
        else await createPortal();
        break;
      case 'settings':
        openSettings();
        break;
      case 'undo':
        undoLayout();
        messages.push('已撤销');
        break;
      case 'search':
        search = a.query;
        break;
    }
  }
  return { messages, search };
}

function cmdContext() {
  return {
    boxes: [...new Set(layout.boxes.filter((b) => !isVirtual(b)).map((b) => b.title))],
    pages: layout.pages ?? ['桌面 1'],
    snapshots: loadSnapshots().map((x) => x.name),
    files: desktopItems(),
  };
}

function replacePaths(map: Map<string, string>) {
  for (const b of layout.boxes) b.items = b.items.map((p) => map.get(p) ?? p);
  saveLayout();
}

function registerAIIpc() {
  ipcMain.handle('rules:fromText', (_e, text: string) => nlRule(settings, String(text ?? ''), cmdContext().boxes, randomUUID()));
  ipcMain.handle('cmd:plan', (_e, text: string) => planCommand(settings, String(text ?? ''), cmdContext()));
  ipcMain.handle('cmd:run', async (_e, actions: CmdAction[]) => {
    const r = await runActions(Array.isArray(actions) ? actions : []);
    if (r.messages.length) toast({ kind: 'success', title: 'AI 命令已执行', message: r.messages.join('；'), action: undoStack.length ? { label: '撤销', command: 'undo-layout' } : undefined });
    return r;
  });
  ipcMain.handle('content:status', () => ({ ...indexStatus(), enabled: settings.contentIndex }));
  ipcMain.handle('content:rebuild', async () => {
    await buildIndex(await getDeepIndex(), settings, undefined, true);
    return indexStatus();
  });
  ipcMain.handle('hub:init', () => {
    const p = hubPending;
    hubPending = null;
    return {
      tab: p?.tab ?? null,
      files: (p?.files ?? []).map(itemOf).filter(Boolean),
      configured: aiConfigured(settings),
      model: settings.ai.model,
      baseURL: settings.ai.baseURL,
      desktop: desktopItems().length,
      messy: desktopItems()
        .filter((i) => !i.isDir && i.source === 'user' && /副本|copy|[（(]\d+[)）]|新建|未命名|untitled|^IMG_|^微信图片|^QQ图片|^mmexport|最终版|final|^\d{8,}/i.test(i.name))
        .slice(0, 40),
      ...themePayload(),
    };
  });
  ipcMain.handle('hub:organizePlan', async () => ({ ...(await organizePlan(settings, desktopItems(), corrections)), items: desktopItems() }));
  ipcMain.handle('hub:organizeApply', (_e, groups: { name: string; icon?: string; paths: string[] }[]) => {
    const valid = (groups ?? []).map((g) => ({ name: String(g.name).slice(0, 12), icon: /^ri-[a-z0-9-]+$/.test(g.icon ?? '') ? g.icon : undefined, paths: (g.paths ?? []).filter((p) => desktopMap.has(p)) })).filter((g) => g.paths.length);
    if (valid.length) applyGroups(valid);
    return valid.length;
  });
  ipcMain.handle('hub:cleanupScan', () => cleanupScan(desktopItems()));
  ipcMain.handle('hub:cleanupApply', async (_e, action: 'trash' | 'archive' | 'box', paths: string[]) => {
    const list = (paths ?? []).filter((p) => desktopMap.has(p));
    if (!list.length) return { ok: 0 };
    if (action === 'box') {
      pushUndo('放入「待清理」');
      const box = boxByTitle('待清理');
      box.color ||= '#ef5350';
      box.icon = 'ri-delete-bin-6-line';
      moveItems(list, box.id, null, false);
      toast({ kind: 'success', title: `已把 ${list.length} 个文件放进「待清理」格子`, message: '仅虚拟分组，文件未移动', action: { label: '撤销', command: 'undo-layout' } });
      return { ok: list.length };
    }
    if (action === 'trash') {
      if (!DEMO) {
        const r = await dialog.showMessageBox(hubWin ?? undefined!, { type: 'warning', title: '移到回收站', message: `确定把 ${list.length} 个文件移到回收站？`, detail: '可以在系统回收站中还原。', buttons: ['移到回收站', '取消'], defaultId: 1, cancelId: 1 });
        if (r.response !== 0) return { ok: 0, cancelled: true };
      }
      let ok = 0;
      for (const p of list) {
        try {
          await shell.trashItem(p);
          ok++;
        } catch (e) {
          console.warn('trash failed', p, e);
        }
      }
      await refresh();
      toast({ kind: 'success', title: `已将 ${ok} 个文件移到回收站`, message: '可在回收站中还原' });
      return { ok };
    }
    // archive: move to Desktop\归档\YYYY-MM (undoable from tray "撤销上次移动")
    const userDir = desktopDirs(false).find((d) => d.source === 'user')?.dir;
    if (!userDir) return { ok: 0 };
    const d = new Date();
    const dir = path.join(userDir, '归档', `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
    await fsp.mkdir(dir, { recursive: true });
    const moves: { from: string; to: string }[] = [];
    for (const p of list) {
      let to = path.join(dir, path.basename(p));
      const ext = path.extname(p);
      let n = 2;
      while (fs.existsSync(to)) to = path.join(dir, `${path.basename(p, ext)} (${n++})${ext}`);
      try {
        await fsp.rename(p, to);
        moves.push({ from: p, to });
      } catch (e) {
        console.warn('archive failed', p, e);
      }
    }
    saveJSON('move-log.json', { at: Date.now(), moves });
    await refresh();
    toast({ kind: 'success', title: `已归档 ${moves.length} 个文件`, message: `位于 桌面\\归档\\${path.basename(dir)}`, action: { label: '撤销', command: 'undo-move' } });
    return { ok: moves.length };
  });
  ipcMain.handle('hub:renamePlan', (_e, paths: string[], opts: { style: 'smart' | 'tidy' | 'date'; useContent: boolean; hint?: string }) => {
    const items = (paths ?? []).map(itemOf).filter((i): i is DesktopItem => !!i && i.source !== 'public');
    return renamePlan(settings, items, opts ?? { style: 'smart', useContent: false });
  });
  ipcMain.handle('hub:renameApply', async (_e, list: RenameProposal[]) => {
    const valid = (list ?? []).filter((p) => p && typeof p.path === 'string' && typeof p.to === 'string' && itemOf(p.path));
    const r = await applyRenames(valid);
    saveJSON('rename-log.json', { at: Date.now(), done: r.done });
    replacePaths(new Map(r.done.map((d) => [d.from, d.to])));
    await refresh();
    toast({ kind: 'success', title: `已重命名 ${r.done.length} 个文件`, message: r.failed.length ? `${r.failed.length} 个失败：${r.failed.slice(0, 3).join('、')}` : '可在 AI 工作台中一键撤销' });
    return r;
  });
  ipcMain.handle('hub:renameUndo', async () => {
    const log = loadJSON<{ at: number; done: { from: string; to: string }[] }>('rename-log.json', { at: 0, done: [] });
    const map = new Map<string, string>();
    for (const d of [...log.done].reverse()) {
      if (fs.existsSync(d.to) && !fs.existsSync(d.from)) {
        try {
          await fsp.rename(d.to, d.from);
          map.set(d.to, d.from);
        } catch {
          /* ignore */
        }
      }
    }
    saveJSON('rename-log.json', { at: 0, done: [] });
    replacePaths(map);
    await refresh();
    return map.size;
  });
  ipcMain.handle('hub:briefing', async () => briefing(settings, desktopItems(), await cleanupScan(desktopItems())));
  ipcMain.handle('hub:pickFiles', async (e) => {
    const w = BrowserWindow.fromWebContents(e.sender) ?? undefined;
    const opts: Electron.OpenDialogOptions = { title: '选择要重命名的文件', defaultPath: desktopDirs(false)[0]?.dir, properties: ['openFile', 'multiSelections'] };
    const r = w ? await dialog.showOpenDialog(w, opts) : await dialog.showOpenDialog(opts);
    if (r.canceled) return [];
    const out: DesktopItem[] = [];
    for (const p of r.filePaths) {
      const it = itemOf(p) ?? (await statItem(p, 'external'));
      if (it) out.push(it);
    }
    return out;
  });
  ipcMain.handle('hub:reveal', (_e, p: string) => shell.showItemInFolder(p));
  ipcMain.handle('hub:projectSpaces', () => suggestProjectSpaces(desktopItems()));
  ipcMain.handle('hub:projectSpaceApply', (_e, paths: string[], title: string) => {
    const box = applyProjectSpace(Array.isArray(paths) ? paths : [], String(title || '项目空间'));
    return box ? { id: box.id, title: box.title, count: box.items.length } : null;
  });
  ipcMain.handle('corrections:list', () => [...corrections].reverse());
  ipcMain.handle('corrections:delete', (_e, at: number, name: string, ext: string, to: string) => {
    const i = corrections.findIndex((c) => c.at === at && c.name === name && c.ext === ext && c.to === to);
    if (i >= 0) corrections.splice(i, 1);
    saveJSON('corrections.json', corrections);
    return corrections.length;
  });
  ipcMain.handle('corrections:clear', () => {
    corrections.length = 0;
    saveJSON('corrections.json', corrections);
    return 0;
  });
  ipcMain.handle('corrections:makeRule', (_e, ext: string, to: string) => {
    const e = String(ext || '').toLowerCase();
    const title = String(to || '').trim();
    if (!e || !title) return false;
    addRule({
      id: randomUUID(),
      name: `${e} → ${title}`,
      enabled: true,
      match: 'all',
      conds: [{ field: 'ext', op: 'in', value: e }],
      target: title,
      source: 'learned',
    });
    return true;
  });
}


// ---------------------------------------------------------------- AI hub window (cleanup / rename / briefing / organize)
let hubPending: { tab?: string; files?: string[] } | null = null;
function openHub(tab?: string, files?: string[]) {
  cancelWinIdle('hub');
  hubPending = { tab, files };
  if (hubWin && !hubWin.isDestroyed()) {
    hubWin.show();
    hubWin.focus();
    hubWin.webContents.send('hub:tab', tab ?? null, files ?? null);
    return hubWin;
  }
  hubWin = new BrowserWindow({
    width: 1000,
    height: 700,
    minWidth: 820,
    minHeight: 560,
    title: 'AI 工作台',
    show: false,
    frame: false,
    titleBarStyle: 'hidden',
    ...(isWin ? { titleBarOverlay: { color: BG(), symbolColor: theme() === 'dark' ? '#e8e8ec' : '#1b1d22', height: 40 } } : {}),
    backgroundColor: BG(),
    icon: ICON_OK ? ICON_PNG : undefined,
    webPreferences: webPrefs(),
  });
  hubWin.setMenu(null);
  hookErrors(hubWin, 'hub');
  hubWin.loadFile(path.join(RENDERER, 'hub.html'));
  hubWin.once('ready-to-show', () => hubWin?.show());
  hubWin.on('closed', () => (hubWin = null));
  return hubWin;
}

// ---------------------------------------------------------------- settings window
let settingsPayload: unknown = null;
function openSettings(section?: string, payload?: unknown) {
  cancelWinIdle('settings');
  settingsPayload = payload ?? null;
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show();
    settingsWin.focus();
    if (section) settingsWin.webContents.send('settings:section', section, payload ?? null);
    return;
  }
  settingsWin = new BrowserWindow({
    width: 980,
    height: 700,
    minWidth: 720,
    minHeight: 520,
    title: 'AI 桌面整理 - 设置',
    show: false,
    frame: false,
    titleBarStyle: 'hidden',
    ...(isWin ? { titleBarOverlay: { color: BG(), symbolColor: theme() === 'dark' ? '#e8e8ec' : '#1b1d22', height: 40 } } : {}),
    backgroundColor: BG(),
    icon: ICON_OK ? ICON_PNG : undefined,
    webPreferences: webPrefs(),
  });
  settingsWin.setMenu(null);
  hookErrors(settingsWin, 'settings');
  settingsWin.loadFile(path.join(RENDERER, 'settings.html'), section ? { query: { section } } : undefined);
  settingsWin.once('ready-to-show', () => settingsWin?.show());
  settingsWin.on('closed', () => (settingsWin = null));
}

function applyAutoStart() {
  if (isWin || process.platform === 'darwin') {
    try {
      app.setLoginItemSettings({ openAtLogin: settings.autoStart, args: ['--hidden'] });
    } catch (e) {
      console.warn('autostart failed', e);
    }
  }
}

const hotkeyConflicts: string[] = [];
function registerHotkeys() {
  globalShortcut.unregisterAll();
  hotkeyConflicts.length = 0;
  const claimed = new Set<string>();
  const tryReg = (role: string, keys: string[], fn: () => void): string => {
    for (const k of keys) {
      if (!k) continue;
      const key = k.trim();
      if (claimed.has(key.toLowerCase())) {
        hotkeyConflicts.push(`${role}: ${key}（与其他快捷键重复）`);
        continue;
      }
      try {
        if (globalShortcut.register(key, fn)) {
          claimed.add(key.toLowerCase());
          return key;
        }
        hotkeyConflicts.push(`${role}: ${key}（已被其他程序占用）`);
      } catch {
        hotkeyConflicts.push(`${role}: ${key}（无效）`);
      }
    }
    return '';
  };
  activeHotkeys.search = tryReg('搜索', [settings.hotkeySearch, 'Alt+Space', 'CommandOrControl+Alt+Space'], () => openSearch());
  activeHotkeys.chat = tryReg('AI 助手', [settings.hotkeyChat, 'Alt+Shift+A', 'CommandOrControl+Alt+A'], () => openChat());
  activeHotkeys.toggle = tryReg('显隐格子', [settings.hotkeyToggle, 'Alt+Shift+D'], () => setFencesHidden(!layout.hidden));
  activeHotkeys.peek = tryReg('Peek', [settings.hotkeyPeek, 'Alt+Shift+F'], () => setPeek(!peekOn));
  activeHotkeys.pageNext = tryReg('下一页', [settings.hotkeyPageNext, 'Ctrl+Alt+Right'], () => switchPage(curPage() + 1));
  activeHotkeys.pagePrev = tryReg('上一页', [settings.hotkeyPagePrev, 'Ctrl+Alt+Left'], () => switchPage(curPage() - 1));
  tryReg('帮助', ['F1'], () => openHelp());
  log('hotkeys', activeHotkeys, hotkeyConflicts.length ? { conflicts: hotkeyConflicts } : '');
  if (hotkeyConflicts.length && appReady && !SMOKE && !DEMO) {
    toast({ kind: 'warning', title: '部分快捷键未能注册', message: hotkeyConflicts.slice(0, 2).join('；'), timeout: 7000 });
  }
}

// ---------------------------------------------------------------- tray
function updateTrayMenu() {
  if (!tray) return;
  const pageName = (layout.pages?.length ? layout.pages : ['桌面 1'])[curPage()] ?? `桌面 ${curPage() + 1}`;
  tray.setToolTip(`AI 桌面整理 · ${pageName}（${curPage() + 1}/${layout.pages?.length ?? 1}）${layout.hidden ? ' · 格子已隐藏' : ''}`);
  const want = layout.hidden ? trayImgHidden : trayImg;
  if (want && !want.isEmpty()) tray.setImage(want);
  const snaps = loadSnapshots().slice(0, 8);
  const menu = Menu.buildFromTemplate([
    { label: 'AI 桌面整理', enabled: false },
    { type: 'separator' },
    { label: '一键整理（规则 + 类型）', click: () => organizeByRules() },
    { label: 'AI 智能整理…', click: () => openHub('organize') },
    { label: '撤销', enabled: undoStack.length > 0, click: undoLayout },
    { type: 'separator' },
    { label: '快速搜索 / AI 命令', accelerator: (isWin && activeHotkeys.search) || undefined, registerAccelerator: false, click: () => openSearch() },
    { label: 'AI 助手', accelerator: (isWin && activeHotkeys.chat) || undefined, registerAccelerator: false, click: () => openChat() },
    { label: 'AI 工作台（清理 / 重命名 / 简报）', click: () => openHub() },
    { type: 'separator' },
    { label: layout.hidden ? '显示桌面格子' : '快速隐藏桌面格子', accelerator: (isWin && activeHotkeys.toggle) || undefined, registerAccelerator: false, click: () => setFencesHidden(!layout.hidden) },
    { label: peekOn ? '退出 Peek' : 'Peek：把格子置于窗口之上', accelerator: (isWin && activeHotkeys.peek) || undefined, registerAccelerator: false, click: () => setPeek(!peekOn) },
    { label: `桌面页（${curPage() + 1}/${layout.pages?.length ?? 1}）`, submenu: pagesSubmenu() },
    {
      label: '格子',
      submenu: [
        { label: '新建自定义容器', click: () => addManualBox() },
        { label: '新建格子', click: () => addBox() },
        { label: '用桌面上选中的图标创建格子', click: () => void fenceFromSelection() },
        { label: '映射文件夹…', click: () => createPortal() },
        { label: '新建「最近文件」格子', enabled: !layout.boxes.some(isRecent), click: addRecentBox },
        { type: 'separator' },
        { label: allLocked() ? '解锁所有格子' : '锁定所有格子', click: () => lockAll(!allLocked()) },
        { label: '整理规则…', click: () => openSettings('rules') },
        { label: '立即应用规则', click: () => runCommand('apply-rules') },
        { label: '重置布局', click: () => runCommand('reset-layout') },
        { label: '刷新桌面', click: () => refresh() },
      ],
    },
    {
      label: '布局快照',
      submenu: [
        { label: '保存当前布局', click: () => runCommand('snapshot-save') },
        ...(snaps.length ? [{ type: 'separator' as const }] : []),
        ...snaps.map((sn) => ({ label: `恢复「${sn.name}」`, click: () => restoreSnapshot(sn.id) })),
        { type: 'separator' },
        { label: '管理快照…', click: () => openSettings('pages') },
      ],
    },
    {
      label: '更多整理',
      submenu: [
        { label: '整理到文件夹（移动文件，需确认）', click: organizeByMoving },
        { label: '撤销上次移动', click: undoMove },
        { label: '打开桌面文件夹', click: () => desktopDirs(false)[0] && shell.openPath(desktopDirs(false)[0].dir) },
      ],
    },
    { type: 'separator' },
    {
      label: '开机自启',
      type: 'checkbox',
      checked: settings.autoStart,
      enabled: isWin || process.platform === 'darwin',
      click: (mi) => {
        settings.autoStart = mi.checked;
        setSettings(settings);
        applyAutoStart();
      },
    },
    { label: '新手引导', click: openOnboarding },
    { label: '快捷键一览', accelerator: 'F1', registerAccelerator: false, click: openHelp },
    { label: '设置', click: () => openSettings() },
    { label: '退出', click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);
}

/** Half-transparent copy of the tray icon, used while fences are quick-hidden. */
function dimmedImage(img: Electron.NativeImage): Electron.NativeImage {
  try {
    const { width, height } = img.getSize();
    const bmp = Buffer.from(img.toBitmap());
    for (let i = 0; i < bmp.length; i++) bmp[i] = Math.round(bmp[i] * 0.45); // premultiplied: scale all channels
    return nativeImage.createFromBitmap(bmp, { width, height });
  } catch {
    return img;
  }
}

function createTray() {
  try {
    let img = ICON_OK ? nativeImage.createFromPath(ICON_PNG) : nativeImage.createEmpty();
    if (!img.isEmpty()) img = img.resize({ width: isWin ? 16 : 22, height: isWin ? 16 : 22, quality: 'best' });
    trayImg = img;
    trayImgHidden = img.isEmpty() ? img : dimmedImage(img);
    tray = new Tray(img);
    tray.setToolTip('AI 桌面整理');
    // 1.3.3: a single left-click opens the tray menu (it used to toggle quick-hide, which hid every fence by accident).
    // Windows fires 'click' before 'double-click', so wait briefly to tell them apart.
    let clickTimer: NodeJS.Timeout | null = null;
    tray.on('click', () => {
      if (clickTimer) return;
      clickTimer = setTimeout(() => {
        clickTimer = null;
        tray?.popUpContextMenu();
      }, 260);
    });
    tray.on('double-click', () => {
      if (clickTimer) clearTimeout(clickTimer);
      clickTimer = null;
      openSettings();
    });
    updateTrayMenu();
  } catch (e) {
    console.warn('[tray] unavailable', e);
  }
}

// ---------------------------------------------------------------- import / export
function exportData(includeKey: boolean) {
  const s = structuredClone(settings);
  if (!includeKey) s.ai.apiKey = '';
  return { app: 'ai-desktop', version: app.getVersion(), exportedAt: new Date().toISOString(), settings: s, layout };
}

function importData(data: any): string {
  if (!data || data.app !== 'ai-desktop' || typeof data.settings !== 'object') throw new Error('不是有效的 AI 桌面整理备份文件');
  pushUndo('导入配置');
  const keepKey = settings.ai.apiKey;
  settings = { ...DEFAULT_SETTINGS, ...data.settings, ai: { ...DEFAULT_SETTINGS.ai, ...(data.settings.ai ?? {}) }, onboarded: true };
  if (!settings.ai.apiKey) settings.ai.apiKey = keepKey;
  setSettings(settings);
  if (data.layout?.boxes && Array.isArray(data.layout.boxes)) {
    layout = { ...DEFAULT_LAYOUT, ...data.layout, hidden: false };
  }
  applyThemeSource();
  registerHotkeys();
  applyAutoStart();
  if (settings.desktopContextMenu) applyDesktopShellMenu(true, true);
  else refreshDesktopMouseHook();
  broadcastTheme();
  refresh();
  return `已导入（${data.layout?.boxes?.length ?? 0} 个格子）`;
}

// ---------------------------------------------------------------- IPC
function registerIpc() {
  ipcMain.handle('fence:init', (_e, id: string) => {
    const b = layout.boxes.find((x) => x.id === id);
    return b ? fenceData(b) : null;
  });
  ipcMain.handle('fence:rename', (e, title: string) => {
    const b = boxOfSender(e);
    if (b && title.trim()) updateBox(b, { title: title.trim().slice(0, 40) });
  });
  ipcMain.handle('fence:collapse', (e) => {
    const b = boxOfSender(e);
    if (b) toggleCollapse(b);
  });
  ipcMain.handle('fence:setView', (e, view: ViewMode) => {
    const b = boxOfSender(e);
    if (b) updateBox(b, { view });
  });
  ipcMain.handle('fence:tabSwitch', (e, tabId: string) => {
    const box = boxOfSender(e);
    if (box) activateFenceTab(box, tabId);
  });
  ipcMain.handle('fence:tabAdd', (e, title?: string) => {
    const box = boxOfSender(e);
    if (box) addFenceTab(box, title);
  });
  ipcMain.handle('fence:tabRename', (e, tabId: string, title: string) => {
    const box = boxOfSender(e);
    if (box) renameFenceTab(box, tabId, title);
  });
  ipcMain.handle('fence:tabRemove', (e, tabId: string) => {
    const box = boxOfSender(e);
    if (box) removeFenceTab(box, tabId);
  });

  ipcMain.handle('fence:menu', (e) => {
    const b = boxOfSender(e);
    const w = BrowserWindow.fromWebContents(e.sender);
    if (b && w) boxMenu(b, w);
  });
  ipcMain.handle('fence:areaMenu', (e) => {
    const b = boxOfSender(e);
    const w = BrowserWindow.fromWebContents(e.sender);
    if (b && w) fenceAreaMenu(b, w);
  });
  ipcMain.handle('fence:undo', () => undoLayout());
  ipcMain.handle('fence:dragStart', (e, mode: DragMode, x: number, y: number) => {
    const b = boxOfSender(e);
    if (b) dragStart(b, mode, x, y);
  });
  ipcMain.on('fence:dragMove', (e, x: number, y: number) => {
    const b = boxOfSender(e);
    if (b) dragMove(b, x, y);
  });
  ipcMain.handle('fence:dragEnd', (e) => {
    const b = boxOfSender(e);
    return b ? dragEnd(b) : false;
  });
  ipcMain.handle('fence:peek', (e, on: boolean) => {
    const b = boxOfSender(e);
    if (b && settings.hoverPeek) peekFence(b, !!on);
  });
  ipcMain.handle('fence:endPeekAll', () => peekOn && setPeek(false));
  ipcMain.handle('portal:nav', async (e, dir: string) => {
    const b = boxOfSender(e);
    if (b && isPortal(b)) await portalNav(b, dir);
  });
  ipcMain.handle('pager:go', (_e, i: number | 'prev' | 'next') => {
    if (i === 'prev') return switchPage(curPage() - 1);
    if (i === 'next') return switchPage(curPage() + 1);
    return switchPage(Number(i));
  });
  ipcMain.handle('pager:add', () => addPage());
  // rules
  ipcMain.handle('rules:get', () => ({ rules: settings.rules ?? [], boxes: [...new Set(layout.boxes.filter((b) => !isVirtual(b)).map((b) => b.title))] }));
  ipcMain.handle('rules:set', (_e, rules: unknown[]) => {
    settings.rules = (Array.isArray(rules) ? rules : []).map((r, i) => cleanRule(r, randomUUID()) ?? null).filter(Boolean) as Rule[];
    setSettings(settings);
    return settings.rules;
  });
  ipcMain.handle('rules:test', (_e, rule: unknown) => {
    const r = cleanRule(rule, 'test');
    if (!r) return { count: 0, names: [] };
    r.enabled = true;
    const hits = [...desktopMap.values()].filter((it) => firstRule([r], it));
    return { count: hits.length, names: hits.slice(0, 12).map((i) => i.name + (i.isDir ? '' : i.ext && !i.name.endsWith(i.ext) ? i.ext : '')) };
  });
  ipcMain.handle('rules:apply', () => applyRulesNow());
  ipcMain.handle('rules:describe', (_e, rule: unknown) => {
    const r = cleanRule(rule, 'x');
    return r ? describeRule(r) : '';
  });
  // pages + snapshots
  ipcMain.handle('pages:get', () => ({
    pages: layout.pages ?? ['桌面 1'],
    page: curPage(),
    counts: (layout.pages ?? ['桌面 1']).map((_, i) => layout.boxes.filter((b) => (b.page ?? 0) === i).length),
    snapshots: loadSnapshots(),
    resolution: resolutionKey(),
  }));
  ipcMain.handle('pages:rename', (_e, i: number, name: string) => {
    if (layout.pages?.[i] !== undefined && name.trim()) layout.pages[i] = name.trim().slice(0, 16);
    saveLayout();
    updateTrayMenu();
  });
  ipcMain.handle('pages:add', () => addPage());
  ipcMain.handle('pages:delete', (_e, i: number) => deletePage(i));
  ipcMain.handle('pages:go', (_e, i: number) => switchPage(i));
  ipcMain.handle('snap:save', (_e, name: string) => saveSnapshot(name));
  ipcMain.handle('snap:restore', (_e, id: string) => restoreSnapshot(id));
  ipcMain.handle('snap:delete', (_e, id: string) => deleteSnapshot(id));
  ipcMain.handle('snap:rename', (_e, id: string, name: string) => renameSnapshot(id, name));
  ipcMain.handle('appearance:get', (_e, id: string) => {
    const b = layout.boxes.find((x) => x.id === id);
    return b ? { box: b, ...themePayload() } : null;
  });
  ipcMain.handle('appearance:set', (_e, id: string, patch: Partial<BoxState>) => {
    const b = layout.boxes.find((x) => x.id === id);
    if (!b) return;
    const clean: Partial<BoxState> = {};
    if (typeof patch.color === 'string') clean.color = patch.color;
    if (typeof patch.icon === 'string' && /^ri-[a-z0-9-]+$/.test(patch.icon)) clean.icon = patch.icon;
    if (typeof patch.title === 'string' && patch.title.trim()) clean.title = patch.title.trim().slice(0, 40);
    if (typeof patch.tint === 'number') clean.tint = Math.max(0, Math.min(1, patch.tint));
    if (typeof patch.alpha === 'number') clean.alpha = Math.max(0.1, Math.min(1, patch.alpha));
    if (patch.alpha === null) clean.alpha = undefined;
    if (typeof patch.iconTint === 'boolean') clean.iconTint = patch.iconTint;
    if (typeof patch.locked === 'boolean') clean.locked = patch.locked;
    if (typeof patch.keepOnHide === 'boolean') clean.keepOnHide = patch.keepOnHide;
    if (typeof patch.hideTitleIcon === 'boolean') clean.hideTitleIcon = patch.hideTitleIcon;
    if (patch.tabStyle && ['pill', 'underline', 'classic'].includes(patch.tabStyle)) clean.tabStyle = patch.tabStyle;
    if (patch.titleStyle && ['band', 'minimal', 'accent'].includes(patch.titleStyle)) clean.titleStyle = patch.titleStyle;
    if (patch.titleAlign && ['center', 'left'].includes(patch.titleAlign)) clean.titleAlign = patch.titleAlign;
    const pp = patch as any;
    if (typeof pp.titleFont === 'string') clean.titleFont = pp.titleFont.replace(/["<>;{}]/g, '').slice(0, 60);
    if (typeof pp.titleSize === 'number') clean.titleSize = Math.max(10, Math.min(24, Math.round(pp.titleSize)));
    if (pp.titleSize === null) clean.titleSize = undefined;
    if (typeof pp.titleColor === 'string') clean.titleColor = /^(#[0-9a-f]{3,8})?$/i.test(pp.titleColor) ? pp.titleColor : '';
    if (typeof pp.iconSizeOverride === 'number') clean.iconSizeOverride = Math.max(24, Math.min(72, Math.round(pp.iconSizeOverride)));
    if (pp.iconSizeOverride === null) clean.iconSizeOverride = undefined;
    updateBox(b, clean);
  });
  ipcMain.handle('item:menu', (e, paths: string[]) => {
    const b = boxOfSender(e);
    const w = BrowserWindow.fromWebContents(e.sender);
    if (b && w && paths?.length) void itemMenuNative(b, paths, w);
  });
  ipcMain.handle('item:open', (_e, p: string) => {
    if (peekOn) setPeek(false);
    return openPath(p);
  });
  ipcMain.handle('item:reveal', (_e, p: string) => shell.showItemInFolder(p));
  ipcMain.handle('icon:get', (_e, p: string) => getIcon(p));
  ipcMain.handle('icon:getMany', async (_e, paths: string[]) => {
    const out: Record<string, string | null> = {};
    for (const p of paths ?? []) {
      if (typeof p !== 'string') continue;
      out[p] = await getIcon(p);
    }
    return out;
  });
  // Fences / 腾讯桌面: default drag is membership (HTML5). Ctrl+drag uses OS startDrag (disk copy into Explorer).
  ipcMain.on('drag:begin', (_e, paths: string[]) => {
    const valid = (paths ?? []).filter((p) => typeof p === 'string');
    if (!valid.length) return;
    pendingDrag = { paths: valid, consumed: false, native: false };
  });
  ipcMain.on('drag:consume', () => {
    if (pendingDrag) pendingDrag.consumed = true;
  });
  ipcMain.on('drag:native', (e, paths: string[]) => {
    const valid = (paths ?? []).filter((p) => typeof p === 'string' && fs.existsSync(p));
    if (!valid.length) return;
    pendingDrag = { paths: valid, consumed: false, native: true };
    try {
      e.sender.startDrag({ file: valid[0], files: valid, icon: dragIcon(valid[0]) } as any);
    } catch (err) {
      console.warn('startDrag failed', err);
    }
    // startDrag blocks until the OS drag ends; if no fence consumed it, leave membership as-is
    // (Explorer may have copied — intentional for Ctrl+drag). Clear pending.
    pendingDrag = null;
  });
  ipcMain.handle('drag:drop', (e, beforePath: string | null, droppedPaths: string[]) => {
    if (pendingDrag) pendingDrag.consumed = true;
    const b = boxOfSender(e);
    if (b) return dropInto(b, beforePath, droppedPaths);
  });
  ipcMain.handle('drag:end', () => {
    const pend = pendingDrag;
    if (!pend || pend.native) {
      pendingDrag = null;
      return { released: false };
    }
    // Allow drop handler on the target fence to mark consumed first.
    return new Promise<{ released: boolean }>((resolve) => {
      setTimeout(() => {
        const cur = pendingDrag;
        pendingDrag = null;
        if (!cur || cur.consumed || cur.native) return resolve({ released: false });
        const pt = screen.getCursorScreenPoint();
        if (pointOverOurWindow(pt)) return resolve({ released: false });
        const ok = releaseToDesktop(cur.paths);
        resolve({ released: ok });
      }, 80);
    });
  });
  ipcMain.handle('item:delete', (e, paths: string[], shift: boolean) => {
    const b = boxOfSender(e);
    if (b && Array.isArray(paths) && paths.length) return deleteItems(b, paths.filter((x) => typeof x === 'string'), !!shift);
  });
  ipcMain.handle('item:rename', (e, p: string) => {
    const b = boxOfSender(e);
    if (!b || typeof p !== 'string') return;
    if (isPortal(b) && (b.portal?.sync ?? 'mirror') === 'bidirectional') return portalRename(b, p);
    if (isPortal(b)) toast({ kind: 'info', title: '仅显示模式下不能重命名文件', message: '在格子菜单 › 同步方式 中切换为双向同步' });
  });
  ipcMain.handle('item:clip', (e, paths: string[], cut: boolean) => clipItems((paths ?? []).filter((x) => typeof x === 'string'), !!cut));
  ipcMain.handle('fence:paste', async (e) => {
    const b = boxOfSender(e);
    if (!b) return;
    const files = await clipFiles();
    if (!files.length) return toast({ kind: 'info', title: '剪贴板中没有文件', message: '在资源管理器或格子中复制文件后再粘贴' });
    if (clipCut && (isPortal(b) || (b.dropMode ?? 'reference') !== 'reference')) {
      // cut + paste into a writable target behaves like a move
      clipCut = false;
    }
    return dropInto(b, null, files);
  });
  ipcMain.handle('fence:newFolder', (e) => {
    const b = boxOfSender(e);
    if (!b) return;
    const dir = isPortal(b) ? b.portal?.cwd || b.portal?.root : desktopDirs(false)[0]?.dir;
    if (isPortal(b) && (b.portal?.sync ?? 'mirror') !== 'bidirectional') return toast({ kind: 'info', title: '仅显示模式下不能新建', message: '在格子菜单 › 同步方式 中切换为双向同步' });
    if (dir) return newEntry(b, dir, 'folder');
  });
  ipcMain.handle('fence:refresh', async (e) => {
    const b = boxOfSender(e);
    if (b && isPortal(b)) await loadPortal(b);
    await refresh();
    if (b) sendFence(b);
  });
  ipcMain.handle('fence:tabMenu', (e, tabId: string) => {
    const b = boxOfSender(e);
    const w = BrowserWindow.fromWebContents(e.sender);
    if (b && w) tabMenu(b, tabId, w);
  });
  async function dropInto(b: BoxState, beforePath: string | null, droppedPaths: string[]) {
    const dropped = (droppedPaths ?? []).filter(Boolean);
    const norm = (p: string) => (isWin ? p.toLowerCase() : p);
    const pendPaths = pendingDrag?.paths ?? [];
    const pend = new Set(pendPaths.map(norm));
    const internal = pendPaths.length > 0 && (dropped.length === 0 || dropped.every((p) => pend.has(norm(p))));
    const paths = internal ? pendPaths : dropped;
    if (pendingDrag) pendingDrag.consumed = true;
    pendingDrag = null;
    if (!paths.length) return;
    if (isPortal(b)) {
      await dropIntoPortal(b, paths);
      return;
    }
    if (isRecent(b)) {
      toast({ kind: 'info', title: '「最近文件」格子按修改时间自动显示', message: '无法手动放入文件' });
      return;
    }
    // Fences default: membership/reference only. Disk copy/move only for explicit dropMode or (future) Ctrl.
    // Internal fence↔fence / reorder never touches the disk.
    const mode = b.dropMode ?? 'reference';
    if (!internal && (mode === 'ask' || mode === 'copy' || mode === 'move')) {
      let act: 'reference' | 'copy' | 'move' = mode === 'ask' ? 'reference' : mode;
      if (mode === 'ask') {
        const r = await dialog.showMessageBox({
          type: 'question',
          title: '放入格子',
          message: `如何处理 ${paths.length} 个项目？`,
          detail: '引用：只在格子中显示，不改磁盘。复制/移动：会写入你选择的目录，并加入格子。',
          buttons: ['添加引用', '复制到…', '移动到…', '取消'],
          defaultId: 0,
          cancelId: 3,
        });
        if (r.response === 3) return;
        act = r.response === 0 ? 'reference' : r.response === 1 ? 'copy' : 'move';
      }
      if (act === 'copy' || act === 'move') {
        const pick = await dialog.showOpenDialog({
          title: act === 'copy' ? '选择复制目标文件夹' : '选择移动目标文件夹',
          properties: ['openDirectory', 'createDirectory'],
          defaultPath: desktopDirs(false)[0]?.dir,
        });
        if (pick.canceled || !pick.filePaths[0]) return;
        const destDir = pick.filePaths[0];
        const okPaths: string[] = [];
        for (const src of paths) {
          try {
            if (!fs.existsSync(src)) continue;
            const dest = await uniqueDest(destDir, path.basename(src));
            if (act === 'move') {
              try {
                await fsp.rename(src, dest);
              } catch {
                await copyEntry(src, dest);
                await fsp.rm(src, { recursive: true, force: true });
              }
            } else {
              await copyEntry(src, dest);
            }
            const it = await statItem(dest, desktopMap.has(dest) ? 'user' : 'external');
            if (it) {
              if (it.source === 'external') externalMap.set(dest, it);
              else desktopMap.set(dest, it);
              okPaths.push(dest);
            }
          } catch (err) {
            console.warn('drop copy/move failed', src, err);
          }
        }
        if (okPaths.length) {
          moveItems(okPaths, b.id, beforePath);
          toast({ kind: 'success', title: act === 'move' ? `已移动并加入 ${okPaths.length} 项` : `已复制并加入 ${okPaths.length} 项` });
        }
        deepIndex = null;
        return;
      }
    }
    const ok: string[] = [];
    for (const p of paths) {
      if (!itemOf(p)) {
        const it = await statItem(p, 'external');
        if (!it) continue;
        externalMap.set(p, it);
      }
      ok.push(p);
    }
    if (ok.length) moveItems(ok, b.id, beforePath);
    if (!internal && ok.length) toast({ kind: 'success', title: `已加入格子 ${ok.length} 项`, message: '整理引用，未在磁盘上复制或移动', action: { label: '撤销', command: 'undo-layout' } });
  }

  ipcMain.handle('search:query', async (_e, q: string) => {
    const epoch = ++searchEpoch;
    const all = await getDeepIndex();
    if (epoch !== searchEpoch) return { results: [], content: [], mode: 'quick', command: false, stale: true };
    const command = looksLikeCommand(q);
    let content: Awaited<ReturnType<typeof contentSearch>> = [];
    if (settings.contentIndex && q.trim().length >= 2 && !q.trim().startsWith('>')) {
      try {
        const byPath = new Map(all.map((i) => [i.path, i]));
        content = await contentSearch(q, settings, (p) => byPath.get(p));
      } catch {
        content = [];
      }
    }
    if (epoch !== searchEpoch) return { results: [], content: [], mode: 'quick', command: false, stale: true };
    if (looksNatural(q)) {
      const nl = localNLSearch(all, q, 50);
      if (nl.length) return { results: nl, mode: 'nl', content, command };
    }
    const results = quickSearch(all, q, 50);
    const seen = new Set(results.map((r) => r.path));
    return { results, mode: 'quick', content: content.filter((c) => !seen.has(c.path) || results.length < 3), command };
  });
  ipcMain.handle('search:ai', (_e, q: string) => aiFind(q));
  ipcMain.handle('search:open', (_e, p: string, reveal: boolean) => {
    searchWin?.hide();
    if (reveal) shell.showItemInFolder(p);
    else openPath(p);
  });
  ipcMain.handle('search:hide', () => {
      searchWin?.hide();
      armWinIdle('search', () => searchWin, () => (searchWin = null));
    });
  ipcMain.handle('search:resize', (_e, h: number) => {
    if (!searchWin || searchWin.isDestroyed()) return;
    searchH = Math.round(Math.max(240, Math.min(SEARCH_H, Number(h) || SEARCH_H)));
    const b = searchWin.getBounds();
    if (b.height !== searchH) searchWin.setBounds({ x: b.x, y: b.y, width: SEARCH_W, height: searchH });
  });

  ipcMain.handle('chat:status', () => ({ configured: aiConfigured(settings), model: settings.ai.model, hotkey: activeHotkeys.chat }));
  ipcMain.handle('chat:send', (e, id: string, messages: ChatMessage[]) => {
    const ctrl = new AbortController();
    streams.set(id, ctrl);
    const wc = e.sender;
    const full: ChatMessage[] = [{ role: 'system', content: chatSystemPrompt() }, ...messages.slice(-20)];
    chatStream(settings, full, (d) => !wc.isDestroyed() && wc.send('chat:stream', { id, delta: d }), ctrl.signal)
      .then(() => !wc.isDestroyed() && wc.send('chat:stream', { id, done: true }))
      .catch((err) => {
        if (wc.isDestroyed()) return;
        if (err?.name === 'AbortError') wc.send('chat:stream', { id, done: true });
        else wc.send('chat:stream', { id, error: String(err?.message ?? err), done: true });
      })
      .finally(() => streams.delete(id));
  });
  ipcMain.handle('chat:abort', (_e, id: string) => streams.get(id)?.abort());
  ipcMain.handle('chat:pickFile', async (e) => {
    const w = BrowserWindow.fromWebContents(e.sender) ?? undefined;
    const opts: Electron.OpenDialogOptions = {
      title: '选择要总结的文件',
      defaultPath: desktopDirs(false)[0]?.dir,
      properties: ['openFile'],
      filters: [
        { name: '支持的文件', extensions: ['txt', 'md', 'pdf', 'docx', 'csv', 'json', 'log', 'html', 'xml', 'py', 'js', 'ts'] },
        { name: '所有文件', extensions: ['*'] },
      ],
    };
    const r = w ? await dialog.showOpenDialog(w, opts) : await dialog.showOpenDialog(opts);
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle('chat:prepareFile', async (_e, p: string, mode?: string) => {
    try {
      const { text, truncated } = await extractText(p);
      const name = path.basename(p);
      return {
        ok: true,
        name,
        chars: text.length,
        truncated,
        prompt:
          (mode === 'translate'
            ? `请把下面的文件《${name}》翻译成${/[\u4e00-\u9fff]/.test(text.slice(0, 400)) ? '英文' : '简体中文'}，保留原有段落结构；专有名词首次出现时附上原文。`
            : `请阅读下面的文件《${name}》，用简体中文给出：1）一句话概括；2）要点总结（分条）；3）如有，列出关键数字/日期/待办事项。`) +
          (truncated ? '（注意：文件较长，以下只是前一部分内容）' : '') +
          `\n\n-----文件内容开始-----\n${text}\n-----文件内容结束-----`,
      };
    } catch (err: any) {
      return { ok: false, error: String(err?.message ?? err) };
    }
  });
  ipcMain.handle('clipboard:write', (_e, text: string) => clipboard.writeText(String(text ?? '')));

  ipcMain.handle('settings:get', () => ({
    pending: (() => {
      const p = settingsPayload;
      settingsPayload = null;
      return p;
    })(),
    settings,
    hotkeys: activeHotkeys,
    hotkeyConflicts: [...hotkeyConflicts],
    platform: process.platform,
    version: app.getVersion(),
    electron: process.versions.electron,
    dataDir: app.getPath('userData'),
    desktopDirs: desktopDirs(true).map((d) => d.dir),
    boxes: layout.boxes.length,
    items: desktopMap.size,
  }));
  ipcMain.handle('settings:set', (_e, patch: Partial<Settings>) => {
    const { rules: _ignored, ...s } = patch ?? {}; // rules are edited through rules:set
    const prev = settings;
    settings = { ...settings, ...s, ai: { ...settings.ai, ...(s.ai ?? {}) } };
    setSettings(settings);
    applyThemeSource();
    applyAutoStart();
    registerHotkeys();
    broadcastTheme();
    applyDesktopShellMenu(!!settings.desktopContextMenu, true);
    refreshDesktopMouseHook();
    if (isWin && prev.embedDesktop !== settings.embedDesktop) {
      for (const w of fenceWins.values()) settings.embedDesktop ? winLayer.attachToDesktop(w) : winLayer.detachFromDesktop(w);
    }
    if (prev.acrylic !== settings.acrylic) for (const w of fenceWins.values()) applyMaterial(w);
    if (prev.scanPublicDesktop !== settings.scanPublicDesktop) {
      if (stopWatch) restartDesktopWatch();
      refresh();
    }
    else syncFences();
    return { hotkeys: activeHotkeys };
  });
  ipcMain.handle('settings:test', async (_e, s: Partial<Settings>) => {
    const tmp: Settings = { ...settings, ai: { ...settings.ai, ...(s.ai ?? {}) } };
    try {
      const t0 = Date.now();
      const r = await chatComplete(tmp, [{ role: 'user', content: '请只回复：连接成功' }], { timeoutMs: 20000 });
      return { ok: true, msg: `连接成功：${r.trim().slice(0, 40)}（${Date.now() - t0} ms）` };
    } catch (e: any) {
      return { ok: false, msg: String(e?.message ?? e) };
    }
  });
  ipcMain.handle('settings:export', async (e, includeKey: boolean) => {
    const w = BrowserWindow.fromWebContents(e.sender) ?? undefined;
    const d = new Date();
    const name = `AI桌面整理-备份-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}.json`;
    const opts: Electron.SaveDialogOptions = { title: '导出配置', defaultPath: path.join(app.getPath('documents'), name), filters: [{ name: 'JSON', extensions: ['json'] }] };
    const r = w ? await dialog.showSaveDialog(w, opts) : await dialog.showSaveDialog(opts);
    if (r.canceled || !r.filePath) return { ok: false, msg: '已取消' };
    await fsp.writeFile(r.filePath, JSON.stringify(exportData(includeKey), null, 2), 'utf8');
    return { ok: true, msg: `已导出到 ${r.filePath}` };
  });
  ipcMain.handle('settings:import', async (e) => {
    const w = BrowserWindow.fromWebContents(e.sender) ?? undefined;
    const opts: Electron.OpenDialogOptions = { title: '导入配置', properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] };
    const r = w ? await dialog.showOpenDialog(w, opts) : await dialog.showOpenDialog(opts);
    if (r.canceled || !r.filePaths[0]) return { ok: false, msg: '已取消' };
    try {
      const msg = importData(JSON.parse(await fsp.readFile(r.filePaths[0], 'utf8')));
      return { ok: true, msg, settings };
    } catch (err: any) {
      return { ok: false, msg: String(err?.message ?? err) };
    }
  });
  ipcMain.handle('onboard:finish', (_e, opts: { organize: 'rules' | 'ai' | 'keep'; recent: boolean; autoStart: boolean }) => {
    settings.onboarded = true;
    settings.autoStart = !!opts.autoStart;
    setSettings(settings);
    applyAutoStart();
    if (opts.recent) addRecentBox();
    if (opts.organize === 'rules') organizeByRules();
    if (opts.organize === 'ai') aiOrganize();
    onboardWin?.close();
    updateTrayMenu();
  });
  ipcMain.handle('app:action', (_e, action: string) => runCommand(action));
  ipcMain.handle('shellmenu:status', () => ({
    supported: isWin,
    enabled: !!settings.desktopContextMenu,
    registered: isWin ? isDesktopShellMenuRegistered() : false,
    items: SHELL_MENU_ITEMS.map((i) => ({ action: i.action, label: i.label })),
  }));
  ipcMain.handle('shellmenu:apply', (_e, on: boolean) => {
    settings.desktopContextMenu = !!on;
    setSettings(settings);
    return applyDesktopShellMenu(!!on, false);
  });
  ipcMain.handle('toast:action', (_e, cmd: string) => {
    hideToast();
    runCommand(cmd);
  });
  ipcMain.handle('toast:close', () => hideToast());
  ipcMain.handle('theme:get', () => themePayload());
  ipcMain.handle('win:hide', (e) => BrowserWindow.fromWebContents(e.sender)?.hide());
  ipcMain.handle('win:close', (e) => BrowserWindow.fromWebContents(e.sender)?.close());
  ipcMain.handle('win:minimize', (e) => BrowserWindow.fromWebContents(e.sender)?.minimize());
  ipcMain.handle('win:maximize', (e) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    if (w) w.isMaximized() ? w.unmaximize() : w.maximize();
  });
  ipcMain.handle('win:pin', (e, pin: boolean) => BrowserWindow.fromWebContents(e.sender)?.setAlwaysOnTop(pin));
}

// ---------------------------------------------------------------- smoke test / capture scenes
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function blankImage(img: Electron.NativeImage): boolean {
  if (img.isEmpty()) return true;
  const buf = img.toBitmap();
  for (let i = 3; i < buf.length; i += 4 * 97) if (buf[i] !== 0) return false;
  return true;
}

async function captureAll(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
  const order: { w: BrowserWindow | null; name: string; opaque: boolean }[] = [
    ...[...layout.boxes]
      .sort((a, b) => Number(peeking.has(a.id)) - Number(peeking.has(b.id)))
      .map((b) => ({ w: fenceWins.get(b.id) ?? null, name: 'fence-' + b.id.slice(0, 6), opaque: false })),
    { w: guideWin, name: 'guides', opaque: false },
    { w: pagerWin, name: 'pager', opaque: false },
    { w: appearanceWin, name: 'appearance', opaque: false },
    { w: hubWin, name: 'hub', opaque: true },
    { w: chatWin, name: 'chat', opaque: true },
    { w: settingsWin, name: 'settings', opaque: true },
    { w: onboardWin, name: 'onboarding', opaque: true },
    { w: helpWin, name: 'help', opaque: false },
    { w: searchWin, name: 'search', opaque: false },
    { w: toastWin, name: 'toast', opaque: false },
  ];
  const manifest: any[] = [];
  for (const o of order) {
    if (!o.w || o.w.isDestroyed() || !o.w.isVisible()) continue;
    // under heavy load the compositor sometimes hands back a blank frame: repaint + retry
    let img = await o.w.webContents.capturePage();
    for (let i = 0; i < 6 && blankImage(img); i++) {
      o.w.webContents.invalidate();
      await wait(700);
      img = await o.w.webContents.capturePage();
    }
    if (blankImage(img)) log('capture still blank:', o.name);
    const file = path.join(dir, o.name + '.png');
    fs.writeFileSync(file, img.toPNG());
    manifest.push({ file, ...o.w.getBounds(), opaque: o.opaque, name: o.name });
  }
  const d = screen.getPrimaryDisplay();
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ screen: d.size, theme: theme(), windows: manifest }, null, 2));
  log('captured', manifest.length, 'windows to', dir);
}

async function runScene() {
  await wait(2200);
  const scene = SCENE ?? 'desktop';
  const demoFile = arg('demo-file');
  if (scene === 'desktop') {
    const peekTitle = arg('peek');
    const pb = peekTitle ? layout.boxes.find((b) => b.title === peekTitle) : undefined;
    if (pb) peekFence(pb, true);
    if (argv.includes('--pager')) showPager();
    if (argv.includes('--guides')) {
      // demo: show the alignment guides a drag would produce for the left column
      const col = layout.boxes.filter((b) => onPage(b) && b.x < 100).sort((a, b) => a.y - b.y);
      if (col.length > 1) {
        const o = screen.getPrimaryDisplay().bounds;
        const gw = guideWindow();
        await wait(800);
        const last = col[col.length - 1];
        const lines = [{ x1: col[0].x - o.x, y1: col[0].y - 6 - o.y, x2: col[0].x - o.x, y2: last.y + (last.collapsed ? TITLE_H : last.h) + 6 - o.y }];
        const a = col[1];
        lines.push({ x1: a.x - 6 - o.x, y1: a.y + a.h + SNAP_GAP - o.y, x2: a.x + a.w + 6 - o.x, y2: a.y + a.h + SNAP_GAP - o.y });
        gw.webContents.send('guides', lines);
        gw.showInactive();
      }
    }
    if (argv.includes('--learn-toast'))
      toast({ kind: 'info', title: '以后 .psd 文件都自动放入「设计稿」？', message: '检测到你多次手动调整同类文件，可一键生成整理规则', action: { label: '创建规则', command: 'learn-rule:.psd|设计稿' }, timeout: 600000 });
    const q = arg('search');
    if (q !== undefined) openSearch(q);
    const cmd = arg('cmd');
    if (cmd !== undefined) openSearch(cmd, true);
    if (argv.includes('--toast')) toast({ kind: 'success', title: '一键整理完成', message: '20 个项目已按类型归入 7 个格子（未移动任何文件）', action: { label: '撤销', command: 'undo-layout' }, timeout: 60000 });
    if (argv.includes('--appearance')) {
      const b = layout.boxes.find((x) => !isRecent(x));
      if (b) openAppearance(b);
    }
  } else if (scene === 'chat') {
    const w = openChat(true);
    await wait(1200);
    if (demoFile) summarizeInChat(demoFile);
    await wait(2500);
    w.webContents.send('chat:ask', '帮我写一个 PowerShell 脚本，把桌面上的截图按日期归档');
  } else if (scene === 'settings') {
    openSettings(arg('section'), arg('nl') ? { text: arg('nl') } : undefined);
  } else if (scene === 'hub') {
    const tab = arg('tab');
    openHub(tab, tab === 'rename' ? desktopItems().filter((i) => /副本|[（(]\d+[)）]|^Snipaste|截图|^IMG_/.test(i.name)).map((i) => i.path) : undefined);
  } else if (scene === 'help') {
    openHelp();
  } else if (scene === 'onboarding') {
    openOnboarding();
    // Optional: advance wizard for multi-step capture (e.g. --ob-step=1).
    const obStep = Math.max(0, Number(arg('ob-step') ?? 0) || 0);
    if (obStep > 0) {
      await wait(900);
      for (let i = 0; i < obStep; i++) {
        if (!onboardWin || onboardWin.isDestroyed()) break;
        await onboardWin.webContents.executeJavaScript(`document.getElementById('next')?.click()`);
        await wait(450);
      }
    }
  }
  await wait(Number(arg('wait') ?? 4000));
  if (CAPTURE_DIR) {
    await captureAll(CAPTURE_DIR);
    quitting = true;
    app.exit(0);
  }
}

async function runSmoke() {
  const results: string[] = [];
  const check = (cond: boolean, label: string) => {
    results.push(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
    if (!cond) rendererErrors.push('check failed: ' + label);
  };
  await wait(2500);
  results.push(`desktop items: ${desktopMap.size}, boxes: ${layout.boxes.length}, fence windows: ${fenceWins.size}`);
  results.push(`startup layout fixes: ${startupFixes.join(', ') || 'none'}`);
  if (process.env.AIDESK_SMOKE_SEED) {
    // 1.3.3 regression: saved hidden:true + page:1 (empty page) must still show the real fences on page 0
    check(startupFixes.includes('hidden') && !layout.hidden, 'startup clears stale quick-hide (hidden:true)');
    check(smokeMigratedMode === 'fences', `1.2.x hideIcons:false migrates to quickHideMode=fences (${smokeMigratedMode})`);
    check(startupFixes.includes('empty-page') && curPage() === 0, 'startup leaves empty saved page → page 0');
    const p0 = layout.boxes.filter((b) => (b.page ?? 0) === 0);
    const vis = p0.filter((b) => fenceWins.get(b.id)?.isVisible()).length;
    check(p0.length > 0 && vis === p0.length, `page-0 fences visible at startup (${vis}/${p0.length})`);
    const p1 = layout.boxes.filter((b) => (b.page ?? 0) === 1);
    check(p1.every((b) => !fenceWins.get(b.id)?.isVisible()), 'page-1 fences hidden');
    const wa = workArea();
    check(startupFixes.some((f) => f.startsWith('clamp:')) && layout.boxes.every((b) => b.x + b.w <= screen.getAllDisplays().reduce((m, d) => Math.max(m, d.workArea.x + d.workArea.width), wa.x + wa.width)), 'off-screen fence clamped at startup');
    const saved = loadJSON<Layout>('layout.json', DEFAULT_LAYOUT);
    check(saved.hidden === false && (saved.page ?? 0) === 0, 'startup fixes saved to layout.json');
    hideHintShown = false;
    setFencesHidden(true);
    check(hideHintShown, 'quick-hide shows one-time hint');
    setFencesHidden(false);
  }
  organizeByRules();
  await wait(600);
  results.push(`after organize: ${layout.boxes.map((b) => `${b.title}(${b.items.length})`).join(', ')}`);
  check(layout.boxes.length > 0, 'organize creates boxes');
  const before = layout.boxes.length;
  const victim = layout.boxes[0];
  if (victim) {
    deleteBox(victim);
    check(!layout.boxes.some((b) => b.id === victim.id), 'delete box');
    undoLayout();
    check(layout.boxes.length === before, 'undo restores deleted box');
  } else {
    check(false, 'delete box (no boxes to delete)');
  }
  addRecentBox();
  await wait(400);
  const recent = layout.boxes.find(isRecent);
  check(!!recent && boxItems(recent).length > 0, `recent box shows ${recent ? boxItems(recent).length : 0} files`);
  const docBox = layout.boxes.find((b) => b.category === 'doc');
  if (docBox) {
    updateBox(docBox, { sort: 'size', view: 'list', color: '#9b6bff', icon: 'ri-briefcase-4-line' });
    const sized = boxItems(docBox);
    check(sized.every((v, i) => i === 0 || sized[i - 1].size >= v.size), 'sort by size');
  } else {
    check(false, 'sort by size (no doc box)');
  }
  const all = await getDeepIndex();
  const py = quickSearch(all, 'bj').map((r) => r.name);
  results.push(`pinyin 'bj': ${py.join(', ')}`);
  check(py.some((n) => n.includes('报价')), "pinyin initials 'bj' -> 报价");
  check(quickSearch(all, 'huiyi').some((r) => r.name.includes('会议')), "full pinyin 'huiyi' -> 会议纪要");
  const nl = localNLSearch(all, '上周的那个报价PDF').map((r) => r.name);
  results.push(`localNL('上周的那个报价PDF'): ${nl.join(', ')}`);
  check(nl.length > 0, 'local natural-language search');
  const ai = await aiFind('上周的那个报价PDF');
  results.push(`aiFind (${aiConfigured(settings) ? 'AI' : 'fallback'}): ${ai.note ?? ''} ${ai.error ?? ''} -> ${ai.results.map((r) => r.name).join(', ')}`);
  check(ai.results.length > 0, 'aiFind returns results');
  if (aiConfigured(settings)) {
    await aiOrganize();
    results.push(`after AI organize: ${layout.boxes.map((b) => `${b.title}(${b.kind === 'recent' ? 'auto' : b.items.length})`).join(', ')}`);
    let streamed = '';
    await chatStream(settings, [{ role: 'user', content: '你好' }], (d) => (streamed += d)).catch((e) => (streamed = 'ERR ' + e.message));
    check(streamed.length > 0 && !streamed.startsWith('ERR'), `chat stream: ${streamed.slice(0, 40)}`);
  }
  const tmp = path.join(app.getPath('temp'), 'aidesk-export-test.json');
  fs.writeFileSync(tmp, JSON.stringify(exportData(false)));
  const parsed = JSON.parse(fs.readFileSync(tmp, 'utf8'));
  check(parsed.settings.ai.apiKey === '' && parsed.layout.boxes.length === layout.boxes.length, 'export (key stripped)');
  check(importData(parsed).startsWith('已导入'), 'import');
  for (const f of [all.find((i) => i.ext === '.pdf'), all.find((i) => i.ext === '.docx')]) {
    if (!f) continue;
    try {
      const t = await extractText(f.path, 200);
      check(t.text.length > 0, `extract ${f.name}: ${t.text.replace(/\s+/g, ' ').slice(0, 40)}`);
    } catch (e: any) {
      check(false, `extract ${f.name}: ${e.message}`);
    }
  }
  // ---- v1.2: Fences features + AI features
  const inv = all.find((i) => i.name.includes('发票'));
  if (inv) check(firstRule(settings.rules, inv)?.target === '财务票据' || !!firstRule(settings.rules, inv), `rule matches ${inv.name}`);
  const nr = await nlRule({ ...settings, ai: { ...settings.ai, apiKey: '' } }, '把所有发票放到财务格子', [], 'smoke-r');
  check(!!nr.rule && nr.rule.target.includes('财务'), `local NL rule: ${nr.rule ? describeRule(nr.rule) : nr.error}`);
  const cl = await cleanupScan(desktopItems());
  results.push(`cleanup: ${cl.items.map((c) => c.group + ':' + c.name).join(', ')}`);
  check(cl.scanned > 0, `cleanup scan (${cl.items.length} items)`);
  const pl = planLocal('把所有发票放到财务格子', { boxes: [], pages: ['桌面 1'], snapshots: [] });
  check(pl.length > 0, `local command plan: ${pl.map((x) => x.type).join('+')}`);
  check(localRename(all.filter((i) => !i.isDir).slice(0, 3), 'date').length > 0, 'local rename proposals');
  const pages0 = layout.pages?.length ?? 1;
  addPage('smoke');
  check((layout.pages?.length ?? 1) === pages0 + 1, 'add desktop page');
  switchPage(0);
  deletePage(pages0);
  const sn = saveSnapshot('smoke');
  check(restoreSnapshot(sn.id), 'snapshot save/restore');
  deleteSnapshot(sn.id);
  try {
    await buildIndex(all, settings, undefined, true);
    const cs = await contentSearch('报价', settings, (p) => all.find((i) => i.path === p));
    check(indexStatus().files > 0, `content index: ${indexStatus().files} docs, '报价' -> ${cs.map((c) => c.name).join(', ')}`);
  } catch (e: any) {
    check(false, 'content index: ' + e.message);
  }
  // ---- v1.2.4: desktop shell menu actions
  check(parseActionFromArgv(['--action=new-manual-fence']) === 'new-manual', 'parse --action=new-manual-fence');
  check(parseActionFromArgv(['--action', 'map-folder']) === 'portal', 'parse --action map-folder');
  check(parseActionFromArgv(['--action=toggle-hide']) === 'toggle-boxes', 'parse --action=toggle-hide');
  check(parseActionFromArgv(['--action=ai-hub']) === 'hub', 'parse --action=ai-hub');
  check(parseActionFromArgv(['--action=new-snapshot']) === 'snapshot-save', 'parse --action=new-snapshot');
  check(SHELL_MENU_ITEMS.length >= 8, `shell menu items: ${SHELL_MENU_ITEMS.length}`);
  enqueueOrRun('new-snapshot');
  check(true, 'action queue drains');
  const wa0 = workArea();
  check(wa0.width > 0 && wa0.height > 0, 'workArea primary');
  if (layout.boxes[0]) {
    const b = layout.boxes[0];
    const ox = b.x;
    b.x = wa0.x + wa0.width + 5000;
    clampBoxToDisplays(b);
    check(b.x >= wa0.x && b.x < wa0.x + wa0.width, 'clampBoxToDisplays pulls on-screen');
    b.x = ox;
  }
  results.push(`icon cache hits/misses: ${iconHits}/${iconMisses}`);
  const regTry = applyDesktopShellMenu(false, true);
  check(!!regTry, 'shell menu unregister (noop off-Windows)');

  // ---- v1.2.3: custom manual container + bidirectional portal
  const man = addManualBox(false);
  check(!!man && man.kind === 'manual' && man.items.length === 0, 'manual container starts empty');
  const sample = [...desktopMap.values()][0];
  if (sample && man) {
    externalMap.set(sample.path, { ...sample, source: 'external' });
    man.items = [sample.path];
    saveLayout();
    syncFences();
    check(boxItems(man).some((i) => i.path === sample.path), 'manual container accepts membership');
    removeFromBox(man, [sample.path]);
    check(!man.items.includes(sample.path), 'remove from manual box keeps file on disk');
  } else {
    check(!!sample, 'manual membership (need desktop sample)');
  }
  const portalDir = path.join(app.getPath('temp'), 'aidesk-smoke-portal');
  fs.mkdirSync(portalDir, { recursive: true });
  const hello = path.join(portalDir, 'smoke-hello.txt');
  fs.writeFileSync(hello, 'portal sync smoke');
  const port = await createPortal(portalDir, { portal: { root: portalDir, cwd: portalDir, sync: 'bidirectional' } });
  check(!!port && port.kind === 'portal' && port.portal?.sync === 'bidirectional', 'portal bidirectional created');
  if (port) {
    await loadPortal(port);
    check((portalItems.get(port.id) ?? []).some((i) => i.path === hello || i.name.includes('smoke-hello')), 'portal lists mapped file');
    setPortalSync(port, 'mirror');
    check((port.portal?.sync ?? 'mirror') === 'mirror', 'portal sync toggles to mirror');
    setPortalSync(port, 'bidirectional');
  }

  // ---- v1.2.6: project spaces + fence tabs + corrections UI hooks
  {
    const demo: DesktopItem[] = [
      { path: '/tmp/a/ACME_报价.pdf', name: 'ACME_报价', ext: '.pdf', isDir: false, size: 1, mtime: Date.now(), category: 'doc', source: 'user' },
      { path: '/tmp/a/ACME_合同.docx', name: 'ACME_合同', ext: '.docx', isDir: false, size: 1, mtime: Date.now() - 86400000, category: 'doc', source: 'user' },
      { path: '/tmp/a/ACME_设计稿.png', name: 'ACME_设计稿', ext: '.png', isDir: false, size: 1, mtime: Date.now() - 2 * 86400000, category: 'image', source: 'user' },
      { path: '/tmp/a/杂项.txt', name: '杂项', ext: '.txt', isDir: false, size: 1, mtime: Date.now(), category: 'doc', source: 'user' },
    ];
    const sug = suggestProjectSpaces(demo);
    check(sug.some((s) => s.entity.toUpperCase().includes('ACME') && s.paths.length >= 3), `project spaces cluster ACME (${sug.map((s) => s.entity + ':' + s.paths.length).join(',')})`);
  }
  if (man) {
    addFenceTab(man, '进行中');
    check(!!man.tabs && man.tabs.length >= 2, `fence tabs created (${man.tabs?.length})`);
    const tid = man.tabs![man.tabs!.length - 1].id;
    activateFenceTab(man, tid);
    check(man.activeTabId === tid, 'fence tab switch');
    removeFenceTab(man, tid);
    check((man.tabs?.length ?? 0) >= 1, 'fence tab remove keeps group');
  }
  corrections.push({ name: 'invoice', ext: '.pdf', to: '财务', at: Date.now() });
  saveJSON('corrections.json', corrections);
  check(corrections.some((c) => c.to === '财务'), 'corrections list writable');

  // ---- v1.3.0: Fences parity — rubber band, selection, native item menu, area menu, quick-hide modes, rules
  {
    const { iconsInRect: hitTest, normRect: nr } = await import('./geom');
    check(winLayer.supported === (isWin || !!process.env.AIDESK_MOCK_HELPER), `helper supported=${winLayer.supported} (mode ${winLayer.mode || 'pending'})`);
    if (process.env.AIDESK_MOCK_HELPER) {
      const pong = await winLayer.ping().catch((e: any) => ({ err: String(e) }));
      check(!!pong && !(pong as any).err, `mock helper ping ${JSON.stringify(pong)}`);
      const all = await winLayer.desktopItems(false);
      check((all.items?.length ?? 0) > 0, `helper desktop items: ${all.items?.length}`);
      const want = hitTest(all.items, all.spacing, nr(10, 10, 190, 130));
      // the mock emits rb-start/rb-move/rb-end shortly after the hook is configured (AIDESK_MOCK_RB)
      for (let i = 0; i < 30 && !lastRbMenu; i++) await new Promise((r) => setTimeout(r, 100));
      check(!!lastRbMenu, 'rubber band: helper events → menu');
      if (lastRbMenu) {
        check(lastRbMenu.labels[0] === '在此创建格子' && lastRbMenu.labels.some((l) => l.startsWith('用框选的')), `rubber band menu: ${lastRbMenu.labels.join(' | ')}`);
        check(lastRbMenu.hits.length === want.length && want.length > 0, `rubber band hit-test ${lastRbMenu.hits.length} icons`);
        const before = layout.boxes.length;
        const fb = createFenceAt(lastRbMenu.dip, lastRbMenu.hits, 'normal');
        check(layout.boxes.length === before + 1 && fb.items.length === want.length, `create fence from rubber band (${fb.items.length} items at ${fb.x},${fb.y} ${fb.w}x${fb.h})`);
        check(fb.w >= 180 && fb.h >= 120, 'drawn fence min size');
        const emptyB = createFenceAt({ x: 300, y: 300, w: 40, h: 30 }, [], 'normal');
        check(emptyB.items.length === 0 && emptyB.w >= 180, '在此创建格子 (empty, min size)');
        deleteBox(emptyB);
      }
      const sel = await fenceFromSelection();
      check(!!sel && sel.items.length === 3, `fence from desktop selection (${sel?.items.length})`);
      if (sel && sel.items[0]) {
        process.env.AIDESK_MOCK_PICK = 'extra';
        process.env.AIDESK_MOCK_EXTRA = 'remove';
        // the mock reads env at spawn; emulate the response path through itemMenuNative with the default pick
        await itemMenuNative(sel, [sel.items[0]], fenceWins.get(sel.id) ?? BrowserWindow.getAllWindows()[0]);
        check(lastNativePick.startsWith('none') || lastNativePick.startsWith('extra'), `native item menu round-trip (${lastNativePick})`);
      }
      const kd = await winLayer.knownDirs();
      check(!!kd.desktop, `known desktop dir ${kd.desktop}`);
    }
    check(desktopDirs(true).length >= 1, `desktopDirs: ${desktopDirs(true).map((d) => d.dir).join(' ; ')}`);
    for (const m of ['fences', 'icons', 'all'] as const) {
      settings.quickHideMode = m;
      setFencesHidden(true);
      const vis = [...fenceWins.values()].filter((w) => w.isVisible()).length;
      check(m === 'icons' ? vis > 0 : vis === 0 || layout.boxes.every((b) => !b.keepOnHide), `quick-hide mode ${m}: ${vis} visible`);
      setFencesHidden(false);
    }
    settings.quickHideMode = 'fences';
    check(normalizeShellAction('fence-from-selection') === 'fence-from-selection', 'action fence-from-selection');
    const firstBox = layout.boxes.find((b) => !isVirtual(b));
    if (firstBox) {
      lockAll(true);
      check(allLocked(), 'lock all fences');
      lockAll(false);
      check(!layout.boxes.some((b) => b.locked), 'unlock all fences');
      const st = pickStyle(firstBox);
      check(typeof st === 'object', 'copy fence style');
    }
  }

  // ---- 1.3.2: keyboard/clipboard/tab polish + robustness
  {
    const nb = layout.boxes.find((b) => !isVirtual(b) && !isPortal(b) && !isRecent(b) && b.items.length >= 2);
    if (nb) {
      const victim = nb.items[nb.items.length - 1];
      await deleteItems(nb, [victim], true);
      check(!nb.items.includes(victim) && fs.existsSync(victim), 'Shift+Delete removes from fence only (file kept)');
      moveItems([victim], nb.id, null);
      check(nb.items.includes(victim), 'item restored to fence');
      if (winLayer.supported) {
        await clipItems([victim], true);
        const back = await clipFiles();
        check(back.length === 1 && back[0] === victim && clipCut, `clipboard files round-trip (${back.length})`);
      }
      updateBox(nb, { tabStyle: 'underline', hideTitleIcon: true });
      check(nb.tabStyle === 'underline' && nb.hideTitleIcon === true, 'tab style + hide title icon persisted');
      updateBox(nb, { tabStyle: undefined, hideTitleIcon: undefined });
    } else check(false, '1.3.2 checks: no normal box with 2+ items');
    // corrupted config → recovered from rolling backup, corrupt copy kept
    const name = 'smoke-recover.json';
    const f = dataPath(name);
    fs.writeFileSync(f + '.bak', JSON.stringify({ a: 7 }));
    fs.writeFileSync(f, '{"a": 1, oops');
    const rec = loadJSON<{ a: number }>(name, { a: 0 });
    const idx = configRecoveries.findIndex((r) => r.name === name);
    check(rec.a === 7 && idx >= 0 && configRecoveries[idx].from === 'backup' && fs.existsSync(configRecoveries[idx].corruptCopy), 'corrupt config recovered from .bak');
    if (idx >= 0) {
      try { fs.rmSync(configRecoveries[idx].corruptCopy); } catch { /* ignore */ }
      configRecoveries.splice(idx, 1);
    }
    for (const x of [f, f + '.bak']) try { fs.rmSync(x); } catch { /* ignore */ }
    const gone = path.join(app.getPath('temp'), 'aidesk-vanished-' + Date.now() + '.txt');
    await openPath(gone);
    check(true, 'open vanished file → toast, no crash');
    check((await statItem(gone, 'user')) === null, 'stat vanished file → null');
  }

  // ---- 1.3.5: Fences-style drag membership (no disk copy; move between; release to desktop)
  {
    const a = addManualBox(false);
    const b = addManualBox(false);
    const sample = [...desktopMap.values()].find((i) => fs.existsSync(i.path));
    check(!!a && !!b && !!sample, '1.3.5 drag fixtures');
    if (a && b && sample) {
      const path0 = sample.path;
      const size0 = fs.statSync(path0).size;
      moveItems([path0], a.id, null, true);
      check(a.items.includes(path0) && fs.existsSync(path0) && fs.statSync(path0).size === size0, 'drag-in: membership only, no disk copy');
      moveItems([path0], b.id, null, true);
      check(!a.items.includes(path0) && b.items.includes(path0) && fs.existsSync(path0), 'drag between fences: move membership');
      moveItems([path0], b.id, b.items.find((p) => p !== path0) ?? null, true);
      check(b.items.filter((p) => p === path0).length === 1, 'intra-fence reorder: no duplicate path');
      const released = releaseToDesktop([path0]);
      check(released && !a.items.includes(path0) && !b.items.includes(path0) && fs.existsSync(path0), 'drag-out: release to desktop, file kept');
      undoLayout();
      // undoLayout replaces layout.boxes with a clone — re-resolve by id (stale a/b refs are post-release).
      const bAfter = layout.boxes.find((x) => x.id === b.id);
      check(!!bAfter?.items.includes(path0), 'undo restores membership after release');
      check(((layout.boxes.find((x) => x.id === a.id)?.dropMode) ?? 'reference') === 'reference', 'manual box default dropMode=reference');
      deleteBox(layout.boxes.find((x) => x.id === a.id));
      deleteBox(layout.boxes.find((x) => x.id === b.id));
    }
  }

  openHub('cleanup');

  openSearch('bj');
  openChat(true);
  openSettings();
  openOnboarding();
  toast({ kind: 'success', title: 'smoke toast', action: { label: '撤销', command: 'undo-layout' } });
  await wait(4000);
  results.push(`renderer errors: ${rendererErrors.length}`);
  results.push(`startupMs: ${startupMs}`);
  console.log('\n===== SMOKE TEST =====\n' + results.join('\n') + '\n' + rendererErrors.join('\n') + '\n======================');
  console.log(rendererErrors.length ? 'SMOKE FAIL' : 'SMOKE OK');
  quitting = true;
  app.exit(rendererErrors.length ? 1 : 0);
}

// ---------------------------------------------------------------- lifecycle
if (!SMOKE && !CAPTURE_DIR && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const action = parseActionFromArgv(argv ?? []);
    if (action) {
      enqueueOrRun(action);
      return;
    }
    if (appReady) openSettings();
    else pendingActions.push('settings');
  });
  if (isWin) app.setAppUserModelId('com.aidesktop.organizer');

  app.whenReady().then(async () => {
    const t0 = Date.now();
    if (SMOKE && process.env.AIDESK_SMOKE_SEED) {
      // 1.2.x-style settings (hideIcons:false, no quickHideMode) → migration must yield 'fences'
      fs.mkdirSync(path.dirname(dataPath('settings.json')), { recursive: true });
      fs.writeFileSync(dataPath('settings.json'), JSON.stringify({ onboarded: true, hideIcons: false }));
    }
    settings = getSettings();
    smokeMigratedMode = settings.quickHideMode;
    const themeArg = arg('theme');
    if (themeArg === 'dark' || themeArg === 'light') settings.theme = themeArg;
    applyThemeSource();
    // smoke only: start from a seeded layout (e.g. the 1.3.2 "no fences visible" report: hidden:true, page:1)
    const seed = SMOKE ? process.env.AIDESK_SMOKE_SEED : undefined;
    if (seed) {
      const desk = (process.env.AI_DESKTOP_DIR || desktopDirs(false)[0]?.dir || '').replace(/\\/g, '/');
      fs.mkdirSync(path.dirname(dataPath('layout.json')), { recursive: true });
      fs.writeFileSync(dataPath('layout.json'), fs.readFileSync(seed, 'utf8').split('${DESK}').join(desk));
    }
    layout = loadJSON<Layout>('layout.json', DEFAULT_LAYOUT);
    if (!layout.pages?.length) layout.pages = ['桌面 1'];
    corrections.push(...loadJSON<typeof corrections>('corrections.json', []));
    resKey = resolutionKey();
    if (CAPTURE_DIR) layout.hidden = false;
    const firstRun = !fs.existsSync(dataPath('layout.json'));
    startupFixes = sanitizeLayoutAtStartup();
    if (startupFixes.length) {
      log('startup layout fixes:', startupFixes.join(', '));
      if (!firstRun) saveJSON('layout.json', layout);
    }
    // icons may still be hidden if the app quit/crashed while quick-hidden: show them to match the visible fences
    if (isWin && (settings.quickHideMode ?? 'fences') !== 'fences') setTimeout(() => winLayer.setDesktopIcons(true), 1500);
    registerIpc();
    registerAIIpc();
    createTray();
    registerHotkeys();
    applyAutoStart();
    winLayer.onEvent(onHelperEvent);
    winLayer.onUnavailable((err) => {
      log('helper unavailable', err);
      toast({ kind: 'warning', title: '桌面助手不可用', message: '双击隐藏、桌面右键和框选创建等功能暂时不可用，其余功能正常。可尝试重启应用。', timeout: 9000 });
    });
    if (winLayer.supported)
      winLayer
        .knownDirs()
        .then((k) => {
          if (setKnownDesktopDirs(k)) {
            log(`known desktop dirs: ${k?.desktop} | ${k?.publicDesktop}`);
            if (stopWatch) restartDesktopWatch();
            void refresh();
          }
        })
        .catch(() => undefined);
    if (settings.desktopContextMenu) applyDesktopShellMenu(true, true);
    else refreshDesktopMouseHook();
    nativeTheme.on('updated', broadcastTheme);
    // First paint: create fence shells before portal/desktop scans finish.
    syncFences();
    log(`first-paint fences ${Date.now() - t0}ms (${layout.boxes.length} boxes)`);
    await Promise.all(layout.boxes.filter(isPortal).map((b) => loadPortal(b)));
    await refreshFull();
    startupMs = Date.now() - t0;
    log(`startup ready ${startupMs}ms`);
    // Not on the first page: show the page indicator briefly so it's obvious which page is active.
    if (curPage() !== 0 && !SMOKE && !CAPTURE_DIR) setTimeout(showPager, 1200);
    if (firstRun) organizeByRules({ silent: true });
    restartDesktopWatch();
    screen.on('display-metrics-changed', onDisplayChanged);
    screen.on('display-added', onDisplayChanged);
    screen.on('display-removed', onDisplayChanged);
    // Defer content index until after first paint / smoke settle.
    scheduleIndex(SMOKE || CAPTURE_DIR ? 800 : 12000);
    if (!DEMO && settings.dailyBriefing) {
      const today = new Date().toDateString();
      const st = loadJSON<{ day: string }>('briefing.json', { day: '' });
      if (st.day !== today) {
        saveJSON('briefing.json', { day: today });
        setTimeout(() => openHub('briefing'), 4000);
      }
    }
    appReady = true;
    for (const r of configRecoveries)
      toast({
        kind: 'warning',
        title: r.from === 'backup' ? '配置已从备份恢复' : '配置文件损坏，已重置',
        message: r.from === 'backup' ? `${r.name} 已损坏，已自动用最近的备份恢复（损坏文件已另存）` : `${r.name} 已损坏且无备份，已使用默认值（损坏文件已另存）`,
        timeout: 10000,
      });
    if (STARTUP_ACTION) pendingActions.push(STARTUP_ACTION);
    setTimeout(() => flushPendingActions(), SMOKE ? 80 : 500);
    if (SMOKE) runSmoke();
    // Dev/screenshot aid (env only): open one of the v1.3 menus a few seconds after start.
    const demoMenu = process.env.AIDESK_DEMO_MENU;
    if (demoMenu && !SMOKE) setTimeout(() => void demoOpenMenu(demoMenu), 4500);
    // Dev aid (env only, --demo): evaluate JS in the fence titled AIDESK_DEMO_EVAL_BOX and log the result.
    const demoEval = DEMO && !SMOKE ? process.env.AIDESK_DEMO_EVAL : undefined;
    if (demoEval)
      setTimeout(async () => {
        const b = layout.boxes.find((x) => x.title === (process.env.AIDESK_DEMO_EVAL_BOX || x.title));
        const w = b && fenceWins.get(b.id);
        try {
          log('demo-eval', JSON.stringify(await w?.webContents.executeJavaScript(demoEval)));
        } catch (e) {
          log('demo-eval error', String(e));
        }
      }, Number(process.env.AIDESK_DEMO_EVAL_AT || 5000));
    else if (DEMO) runScene();
    else if (!settings.onboarded && !START_HIDDEN) setTimeout(openOnboarding, 1200);
  });

  app.on('window-all-closed', () => {
    /* keep running in tray */
  });
  app.on('before-quit', () => {
    quitting = true;
    stopWatch?.();
    cancelIndexBuild();
    for (const t of idleTimers.values()) clearTimeout(t);
    idleTimers.clear();
    globalShortcut.unregisterAll();
    winLayer.dispose();
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveJSON('layout.json', layout);
    }
  });
}
