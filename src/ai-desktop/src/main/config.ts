import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { Layout, Settings } from '../shared/types';
import { DEFAULT_RULES } from './rules';

export function dataPath(name: string): string {
  return path.join(app.getPath('userData'), name);
}

/** Config files that are backed up (rolling .bak) and recovered automatically when corrupted. */
const PROTECTED = new Set(['layout.json', 'settings.json', 'snapshots.json', 'corrections.json', 'resolutions.json']);
const BAK_EVERY_MS = 5 * 60 * 1000;
const lastBak = new Map<string, number>();
/** Recoveries performed this session (main shows a toast once at startup). */
export const configRecoveries: { name: string; from: 'backup' | 'defaults'; corruptCopy: string }[] = [];

function parseFile(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}

/** Parsed file content without defaults merged in (null if missing/unreadable). */
export function readRawJSON(name: string): unknown {
  try {
    return parseFile(dataPath(name));
  } catch {
    return null;
  }
}

export function loadJSON<T>(name: string, def: T): T {
  const file = dataPath(name);
  const merge = (parsed: unknown): T =>
    def && typeof def === 'object' && !Array.isArray(def) ? (deepMerge(structuredClone(def), parsed) as T) : ((parsed ?? structuredClone(def)) as T);
  if (!fs.existsSync(file)) return structuredClone(def);
  try {
    return merge(parseFile(file));
  } catch (e) {
    // Corrupted (power loss, disk full, manual edit…): keep a copy for support, then try the rolling backup.
    let corruptCopy = '';
    try {
      corruptCopy = `${file}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      fs.copyFileSync(file, corruptCopy);
    } catch {
      /* ignore */
    }
    console.error('[config] corrupted', name, (e as Error)?.message);
    try {
      const bak = parseFile(file + '.bak');
      fs.copyFileSync(file + '.bak', file);
      configRecoveries.push({ name, from: 'backup', corruptCopy });
      return merge(bak);
    } catch {
      configRecoveries.push({ name, from: 'defaults', corruptCopy });
      return structuredClone(def);
    }
  }
}

export function saveJSON(name: string, data: unknown): void {
  try {
    const p = dataPath(name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const json = JSON.stringify(data, null, 2);
    if (json === undefined) return;
    // rolling backup of the last known-good file (only if it still parses)
    if (PROTECTED.has(name) && fs.existsSync(p) && Date.now() - (lastBak.get(name) ?? 0) > BAK_EVERY_MS) {
      try {
        parseFile(p);
        fs.copyFileSync(p, p + '.bak');
        lastBak.set(name, Date.now());
      } catch {
        /* current file is bad: keep the older .bak */
      }
    }
    const tmp = p + '.tmp';
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeSync(fd, json);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, p);
  } catch (e) {
    console.error('[config] save failed', name, e);
  }
}

function deepMerge(target: any, src: any): any {
  if (!src || typeof src !== 'object') return target;
  for (const k of Object.keys(src)) {
    const v = src[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object' && !Array.isArray(target[k])) {
      target[k] = deepMerge(target[k], v);
    } else {
      target[k] = v;
    }
  }
  return target;
}

export const DEFAULT_SETTINGS: Settings = {
  ai: { baseURL: 'https://api.deepseek.com/v1', apiKey: '', model: 'deepseek-chat', temperature: 0.3 },
  theme: 'auto',
  opacity: 0.6,
  iconSize: 44,
  autoStart: false,
  hotkeySearch: 'Alt+Space',
  hotkeyChat: 'Alt+Shift+A',
  hotkeyToggle: 'Alt+Shift+D',
  embedDesktop: false,
  keepBottom: true,
  dblClickDesktop: true,
  desktopContextMenu: true,
  acrylic: false,
  scanPublicDesktop: true,
  recentCount: 12,
  onboarded: false,
  rollupOn: 'dblclick',
  hoverPeek: true,
  snapGrid: 8,
  snapEdges: true,
  hideIcons: false, // legacy (≤1.2.6); superseded by quickHideMode
  chameleon: false,
  hotkeyPeek: 'Alt+Shift+F',
  hotkeyPageNext: 'Ctrl+Alt+Right',
  hotkeyPagePrev: 'Ctrl+Alt+Left',
  autoResolution: true,
  rules: DEFAULT_RULES,
  autoPlace: true,
  learnFromMoves: true,
  learnRuleMin: 3,
  drawFence: 'right',
  desktopRightClick: 'app',
  nativeItemMenu: true,
  quickHideMode: 'all', // Fences default: quick-hide hides fences and desktop icons
  headerMode: 'always',
  hideScrollbars: false,
  iconMultiples: false,
  groupGap: 8,
  tintAll: false,
  tintColor: '',
  tintStrength: 0.6,
  dailyBriefing: false,
  contentIndex: true,
  embedModel: '',
};

export const DEFAULT_LAYOUT: Layout = { version: 1, boxes: [], hidden: false, pages: ['桌面 1'], page: 0 };

let settingsCache: Settings | null = null;
export function getSettings(): Settings {
  if (!settingsCache) {
    const s = loadJSON<Settings>('settings.json', DEFAULT_SETTINGS);
    settingsCache = { ...DEFAULT_SETTINGS, ...s, ai: { ...DEFAULT_SETTINGS.ai, ...(s.ai ?? {}) } };
    // migrate 1.2.x: hideIcons -> quickHideMode. Must look at the RAW file: the loaded object is already
    // merged with defaults, so quickHideMode would always look "set" and the migration never ran.
    // (1.2.x default hideIcons=true ≙ 'all'; users who switched it off keep fences-only hiding)
    const raw = readRawJSON('settings.json') as Record<string, unknown> | null;
    if (raw && typeof raw === 'object' && raw.quickHideMode === undefined && 'hideIcons' in raw)
      settingsCache.quickHideMode = raw.hideIcons === false ? 'fences' : 'all';
    settingsCache.hideIcons = false;
  }
  return settingsCache;
}
export function setSettings(s: Settings): void {
  settingsCache = s;
  saveJSON('settings.json', s);
}
