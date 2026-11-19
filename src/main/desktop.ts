import { app } from 'electron';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Category, DesktopItem } from '../shared/types';

const EXT: Record<Exclude<Category, 'folder' | 'other'>, string[]> = {
  doc: ['.txt', '.md', '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.csv', '.ppt', '.pptx', '.wps', '.et', '.dps', '.rtf', '.odt', '.ods', '.odp', '.json', '.xml', '.log', '.epub', '.ofd', '.html', '.htm'],
  image: ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.svg', '.ico', '.tif', '.tiff', '.heic', '.psd', '.ai', '.raw', '.cr2', '.nef'],
  video: ['.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.webm', '.m4v', '.rmvb', '.ts', '.3gp'],
  audio: ['.mp3', '.wav', '.flac', '.aac', '.ogg', '.m4a', '.wma', '.ape'],
  archive: ['.zip', '.rar', '.7z', '.tar', '.gz', '.bz2', '.xz', '.iso', '.cab', '.tgz'],
  program: ['.exe', '.lnk', '.url', '.msi', '.bat', '.cmd', '.ps1', '.appref-ms', '.desktop', '.appimage', '.sh', '.com', '.scr'],
};

const EXT_MAP = new Map<string, Category>();
for (const [cat, list] of Object.entries(EXT)) for (const e of list) EXT_MAP.set(e, cat as Category);

export function categorize(name: string, isDir: boolean): Category {
  if (isDir) return 'folder';
  return EXT_MAP.get(path.extname(name).toLowerCase()) ?? 'other';
}

const IGNORE = new Set(['desktop.ini', 'thumbs.db', '.ds_store']);

export interface DesktopDir {
  dir: string;
  source: 'user' | 'public';
}

/** Known-folder paths reported by the native helper (SHGetKnownFolderPath) — authoritative on Windows. */
let knownDesktop: { user?: string; pub?: string } = {};
export function setKnownDesktopDirs(k: { desktop?: string | null; publicDesktop?: string | null } | null | undefined): boolean {
  if (!k) return false;
  const next = { user: k.desktop || undefined, pub: k.publicDesktop || undefined };
  const changed = next.user !== knownDesktop.user || next.pub !== knownDesktop.pub;
  knownDesktop = next;
  return changed;
}

const isDir = (d: string) => {
  try {
    return fs.statSync(d).isDirectory();
  } catch {
    return false;
  }
};

export function desktopDirs(includePublic: boolean): DesktopDir[] {
  const override = process.env.AI_DESKTOP_DIR;
  if (override) return isDir(override) ? [{ dir: override, source: 'user' }] : [];
  // User desktop: helper known folder → Electron (handles redirection) → OneDrive backup → profile.
  const userCands: string[] = [];
  if (knownDesktop.user) userCands.push(knownDesktop.user);
  try {
    userCands.push(app.getPath('desktop'));
  } catch {
    /* ignore */
  }
  if (process.platform === 'win32') {
    for (const od of [process.env.OneDrive, process.env.OneDriveConsumer, process.env.OneDriveCommercial]) if (od) userCands.push(path.join(od, 'Desktop'), path.join(od, '桌面'));
    if (process.env.USERPROFILE) userCands.push(path.join(process.env.USERPROFILE, 'Desktop'));
  }
  userCands.push(path.join(app.getPath('home'), 'Desktop'));
  const user = userCands.find(isDir);
  const dirs: DesktopDir[] = user ? [{ dir: user, source: 'user' }] : [];
  if (includePublic && process.platform === 'win32') {
    const pubCands = [knownDesktop.pub, path.join(process.env.PUBLIC || 'C:\\Users\\Public', 'Desktop'), process.env.SystemDrive ? path.join(process.env.SystemDrive + '\\', 'Users', 'Public', 'Desktop') : ''].filter(Boolean) as string[];
    const pub = pubCands.find(isDir);
    if (pub) dirs.push({ dir: pub, source: 'public' });
  }
  // Case-insensitive dedupe (Windows paths), e.g. when Public == user on odd setups.
  const seen = new Set<string>();
  return dirs.filter((d) => {
    const k = path.resolve(d.dir).toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export function displayName(name: string, isDir: boolean): string {
  if (isDir) return name;
  const ext = path.extname(name).toLowerCase();
  if (ext === '.lnk' || ext === '.url' || ext === '.appref-ms' || ext === '.desktop') return name.slice(0, -ext.length);
  return name;
}

export async function statItem(p: string, source: DesktopItem['source']): Promise<DesktopItem | null> {
  try {
    const st = await fsp.stat(p);
    const base = path.basename(p);
    const isDir = st.isDirectory();
    return {
      path: p,
      name: displayName(base, isDir),
      ext: isDir ? '' : path.extname(base).toLowerCase(),
      isDir,
      size: st.size,
      mtime: st.mtimeMs,
      category: categorize(base, isDir),
      source,
    };
  } catch {
    return null;
  }
}

/** Scan one desktop root's top-level entries. */
export async function scanDesktopDir(d: DesktopDir): Promise<DesktopItem[]> {
  const out: DesktopItem[] = [];
  let names: string[] = [];
  try {
    names = await fsp.readdir(d.dir);
  } catch {
    return out;
  }
  for (const n of names) {
    if (IGNORE.has(n.toLowerCase()) || n.startsWith('.') || n.startsWith('~$')) continue;
    const it = await statItem(path.join(d.dir, n), d.source);
    if (it) out.push(it);
  }
  return out;
}

/** Top-level entries of the desktop folders (what the boxes show). */
export async function scanDesktop(includePublic: boolean): Promise<DesktopItem[]> {
  const out: DesktopItem[] = [];
  for (const d of desktopDirs(includePublic)) out.push(...(await scanDesktopDir(d)));
  return out;
}

/** Folder Portal: entries of any folder (folders first). */
export async function scanFolder(dir: string, limit = 400): Promise<DesktopItem[]> {
  const names = await fsp.readdir(dir);
  const out: DesktopItem[] = [];
  for (const n of names) {
    if (out.length >= limit) break;
    if (IGNORE.has(n.toLowerCase()) || n.startsWith('.') || n.startsWith('~$')) continue;
    const it = await statItem(path.join(dir, n), 'portal');
    if (it) out.push(it);
  }
  return out.sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name, 'zh-CN', { numeric: true }));
}

export function watchFolder(dir: string, onChange: () => void): () => void {
  let t: NodeJS.Timeout | null = null;
  try {
    const w = fs.watch(dir, { persistent: false }, () => {
      if (t) clearTimeout(t);
      t = setTimeout(onChange, 750);
    });
    return () => w.close();
  } catch {
    return () => {};
  }
}

/** Recursive scan for quick search (bounded depth / count). */
export async function scanDeep(includePublic: boolean, maxDepth = 3, limit = 8000): Promise<DesktopItem[]> {
  const out: DesktopItem[] = [];
  const walk = async (dir: string, depth: number, source: 'user' | 'public') => {
    if (out.length >= limit) return;
    let ents: fs.Dirent[] = [];
    try {
      ents = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      if (out.length >= limit) return;
      if (IGNORE.has(e.name.toLowerCase()) || e.name.startsWith('.') || e.name.startsWith('~$')) continue;
      if (e.name === 'node_modules') continue;
      const p = path.join(dir, e.name);
      const it = await statItem(p, source);
      if (!it) continue;
      out.push(it);
      if (it.isDir && depth < maxDepth) await walk(p, depth + 1, source);
    }
  };
  for (const d of desktopDirs(includePublic)) await walk(d.dir, 1, d.source);
  return out;
}

/**
 * Watch desktop roots. Coalesces events (~900ms) and reports changed paths so
 * callers can do incremental updates instead of a full rescan.
 */
export function watchDesktop(includePublic: boolean, onChange: (changedPaths?: string[]) => void): () => void {
  const watchers: fs.FSWatcher[] = [];
  let t: NodeJS.Timeout | null = null;
  const pending = new Set<string>();
  const fire = (dir: string, filename: string | Buffer | null | undefined) => {
    if (filename != null && filename !== '') pending.add(path.join(dir, filename.toString()));
    else pending.add(dir);
    if (t) clearTimeout(t);
    t = setTimeout(() => {
      const files = [...pending];
      pending.clear();
      t = null;
      onChange(files);
    }, 900);
  };
  for (const d of desktopDirs(includePublic)) {
    try {
      watchers.push(fs.watch(d.dir, { persistent: false }, (_ev, filename) => fire(d.dir, filename)));
    } catch (e) {
      console.warn('[desktop] watch failed', d.dir, e);
    }
  }
  return () => {
    if (t) clearTimeout(t);
    watchers.forEach((w) => w.close());
  };
}
