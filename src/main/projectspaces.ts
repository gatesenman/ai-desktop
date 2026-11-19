/**
 * Smart project spaces: cluster desktop files by shared name entities
 * (client/project tokens) + time proximity into suggested Portal-like groups.
 */
import type { DesktopItem } from '../shared/types';

export interface ProjectSpaceSuggestion {
  id: string;
  title: string;
  entity: string;
  paths: string[];
  score: number;
  reason: string;
}

const STOP = new Set([
  'the', 'and', 'for', 'with', 'from', 'copy', '副本', '新建', '文档', '文件', '文件夹',
  'untitled', 'screenshot', '屏幕截图', '微信图片', 'image', 'img', 'photo', 'pic',
  'temp', 'tmp', 'backup', '旧版', '最终', 'final', 'draft', '草稿', 'v1', 'v2', 'v3',
  'setup', 'install', 'installer', 'readme', 'license', 'desktop', 'desktop.ini',
]);

const CN_STOP = new Set(['的', '了', '和', '与', '及', '或', '在', '是', '有', '为', '到', '这', '那', '我', '你', '他']);

function tokenize(name: string): string[] {
  const base = name.replace(/\.[^.]+$/, '').trim();
  const out = new Set<string>();
  // Latin tokens: ACME, EastChina, Q3, ProjectX
  for (const m of base.matchAll(/[A-Za-z][A-Za-z0-9_-]{1,24}/g)) {
    const t = m[0].replace(/^_+|_+$/g, '');
    if (t.length < 2) continue;
    const low = t.toLowerCase();
    if (STOP.has(low)) continue;
    if (/^\d+$/.test(t)) continue;
    out.add(t.length <= 4 && /^[A-Z0-9_-]+$/.test(t) ? t.toUpperCase() : t);
  }
  // Chinese runs 2–6 chars
  for (const m of base.matchAll(/[\u4e00-\u9fff]{2,6}/g)) {
    const t = m[0];
    if ([...t].every((c) => CN_STOP.has(c))) continue;
    if (STOP.has(t)) continue;
    out.add(t);
  }
  // Strip common date/version noise from tokens
  return [...out].filter((t) => !/^\d{4}([_-]?\d{1,2}){0,2}$/.test(t));
}

function rarityBoost(token: string, freq: number, nFiles: number): number {
  // Prefer uncommon tokens (project names) over ubiquitous ones.
  // On small desktops (<12 files) high share is expected for a real project — do not over-penalize.
  if (nFiles < 12) return freq >= 3 ? 1.15 : 1.0;
  const ratio = freq / Math.max(1, nFiles);
  if (ratio > 0.55) return 0.35;
  if (ratio > 0.35) return 0.7;
  return 1.15 - ratio * 0.4;
}

/** Suggest project spaces from a flat desktop item list. */
export function suggestProjectSpaces(items: DesktopItem[], opts?: { minFiles?: number; maxSuggestions?: number }): ProjectSpaceSuggestion[] {
  const minFiles = opts?.minFiles ?? 2;
  const maxSuggestions = opts?.maxSuggestions ?? 8;
  const files = items.filter((i) => !i.isDir && !['.lnk', '.url'].includes(i.ext));
  if (files.length < minFiles) return [];

  const tokenToPaths = new Map<string, string[]>();
  const pathTokens = new Map<string, string[]>();
  for (const it of files) {
    const toks = tokenize(it.name);
    pathTokens.set(it.path, toks);
    for (const t of toks) {
      const arr = tokenToPaths.get(t) ?? [];
      arr.push(it.path);
      tokenToPaths.set(t, arr);
    }
  }

  const n = files.length;
  const pathMeta = new Map(files.map((f) => [f.path, f]));
  const suggestions: ProjectSpaceSuggestion[] = [];
  const used = new Set<string>();

  const ranked = [...tokenToPaths.entries()]
    .map(([entity, paths]) => {
      const uniq = [...new Set(paths)];
      const boost = rarityBoost(entity, uniq.length, n);
      // time proximity: stdev of mtimes (days)
      const mtimes = uniq.map((p) => pathMeta.get(p)!.mtime).sort((a, b) => a - b);
      const spanDays = (mtimes[mtimes.length - 1] - mtimes[0]) / 86400000;
      const timeScore = spanDays <= 14 ? 1.3 : spanDays <= 60 ? 1.0 : spanDays <= 180 ? 0.7 : 0.4;
      const score = uniq.length * boost * timeScore;
      return { entity, paths: uniq, score, spanDays };
    })
    .filter((x) => x.paths.length >= minFiles && x.score >= 1.2)
    .sort((a, b) => b.score - a.score || b.paths.length - a.paths.length);

  for (const r of ranked) {
    const free = r.paths.filter((p) => !used.has(p));
    if (free.length < minFiles) continue;
    free.forEach((p) => used.add(p));
    const cats = new Set(free.map((p) => pathMeta.get(p)!.category));
    const reasonParts = [
      `${free.length} 个文件共享「${r.entity}」`,
      r.spanDays <= 14 ? '时间邻近（约两周内）' : r.spanDays <= 60 ? '近期相关' : '跨度较长但仍相关',
    ];
    if (cats.size >= 2) reasonParts.push(`含 ${cats.size} 种类型`);
    suggestions.push({
      id: `proj-${r.entity.slice(0, 24)}-${free.length}`,
      title: `${r.entity} 项目`,
      entity: r.entity,
      paths: free,
      score: Math.round(r.score * 10) / 10,
      reason: reasonParts.join(' · '),
    });
    if (suggestions.length >= maxSuggestions) break;
  }
  return suggestions;
}
