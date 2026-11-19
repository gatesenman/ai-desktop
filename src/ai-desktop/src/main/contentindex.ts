/**
 * Local content index for "find files by what's inside" (P1: semantic search).
 * - Always local: BM25 over latin words + CJK bigrams; stored in userData/content-index.json; nothing leaves the machine.
 * - Optional: if an embeddings model is configured, each file also gets a vector of its first ~1.5k chars and queries are
 *   scored with cosine similarity (hybrid). With Ollama this stays local too.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { DesktopItem, SearchResult, Settings } from '../shared/types';
import { dataPath } from './config';
import { extractText } from './extract';
import { embed } from './ai';

const INDEXABLE = new Set(['.txt', '.md', '.markdown', '.csv', '.log', '.json', '.html', '.htm', '.xml', '.pdf', '.docx', '.py', '.js', '.ts', '.ini', '.yaml', '.yml']);
const MAX_FILES = 400;
const MAX_CHARS = 20000;

interface Doc {
  path: string;
  mtime: number;
  size: number;
  text: string; // first MAX_CHARS chars (for snippets)
  tf: Record<string, number>;
  len: number;
  vec?: number[];
}
interface Index {
  version: 2;
  docs: Record<string, Doc>;
  embedModel?: string;
}

let idx: Index | null = null;
let building: Promise<void> | null = null;

export function tokenize(text: string): string[] {
  const out: string[] = [];
  const lower = text.toLowerCase();
  for (const m of lower.matchAll(/[a-z0-9][a-z0-9_.-]{1,30}/g)) out.push(m[0]);
  for (const run of lower.match(/[\u4e00-\u9fff]+/g) ?? []) {
    if (run.length === 1) out.push(run);
    for (let i = 0; i < run.length - 1; i++) out.push(run.slice(i, i + 2));
  }
  return out;
}

function load(): Index {
  if (idx) return idx;
  try {
    idx = JSON.parse(fs.readFileSync(dataPath('content-index.json'), 'utf8'));
    if (idx?.version !== 2) idx = null;
  } catch {
    idx = null;
  }
  return (idx ??= { version: 2, docs: {} });
}
function persist() {
  try {
    fs.writeFileSync(dataPath('content-index.json'), JSON.stringify(idx));
  } catch (e) {
    console.warn('[index] save failed', e);
  }
}

export function indexStatus() {
  const i = load();
  const docs = Object.values(i.docs);
  return { files: docs.length, embedded: docs.filter((d) => d.vec?.length).length, building: !!building };
}

export function canIndex(it: DesktopItem): boolean {
  return !it.isDir && INDEXABLE.has(it.ext) && it.size < 30 * 1024 * 1024;
}

const yieldTick = () => new Promise<void>((r) => setImmediate(r));

let buildGen = 0;
/** Cancel an in-flight index build. Next buildIndex starts fresh after the old one unwinds. */
export function cancelIndexBuild() {
  buildGen++;
}

/** incremental (re)build; only changed files are re-read. Yields to the event loop so UI/IPC stay responsive. */
export function buildIndex(items: DesktopItem[], s: Settings, onProgress?: (done: number, total: number) => void, force = false): Promise<void> {
  const my = ++buildGen;
  const prev = building;
  const job = (async () => {
    if (prev) await prev.catch(() => {});
    if (my !== buildGen) return;
    const i = load();
    if (force) i.docs = {};
    const want = items.filter(canIndex).sort((a, b) => b.mtime - a.mtime).slice(0, MAX_FILES);
    const keep = new Set(want.map((w) => w.path));
    for (const p of Object.keys(i.docs)) if (!keep.has(p)) delete i.docs[p];
    const model = s.embedModel?.trim() || '';
    if (i.embedModel !== model) {
      Object.values(i.docs).forEach((d) => delete d.vec);
      i.embedModel = model;
    }
    let done = 0;
    let changed = force;
    for (const it of want) {
      if (my !== buildGen) return;
      const old = i.docs[it.path];
      if (!old || old.mtime !== it.mtime || old.size !== it.size) {
        try {
          const { text } = await extractText(it.path, MAX_CHARS);
          const toks = tokenize(text + ' ' + it.name);
          const tf: Record<string, number> = {};
          for (const t of toks) tf[t] = (tf[t] ?? 0) + 1;
          i.docs[it.path] = { path: it.path, mtime: it.mtime, size: it.size, text: text.replace(/\s+/g, ' ').slice(0, MAX_CHARS), tf, len: toks.length };
          changed = true;
        } catch {
          /* unreadable file */
        }
      }
      onProgress?.(++done, want.length);
      if (changed && done % 40 === 0) persist();
      if (done % 5 === 0) await yieldTick();
    }
    if (my !== buildGen) return;
    if (model) {
      const need = Object.values(i.docs).filter((d) => !d.vec?.length);
      for (let k = 0; k < need.length; k += 16) {
        if (my !== buildGen) return;
        const batch = need.slice(k, k + 16);
        try {
          const vecs = await embed(s, model, batch.map((d) => `${path.basename(d.path)}\n${d.text.slice(0, 1500)}`));
          batch.forEach((d, j) => vecs[j] && (d.vec = vecs[j]));
          changed = true;
        } catch (e) {
          console.warn('[index] embeddings failed', (e as Error).message);
          break;
        }
        await yieldTick();
      }
    }
    if (my === buildGen && changed) persist();
  })();
  building = job;
  job.finally(() => {
    if (building === job) building = null;
  });
  return job;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let k = 0; k < Math.min(a.length, b.length); k++) {
    dot += a[k] * b[k];
    na += a[k] * a[k];
    nb += b[k] * b[k];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

function snippet(text: string, terms: string[]): string {
  const lower = text.toLowerCase();
  let at = -1;
  for (const t of terms) {
    at = lower.indexOf(t);
    if (at >= 0) break;
  }
  if (at < 0) return text.slice(0, 70);
  const start = Math.max(0, at - 24);
  return (start > 0 ? '…' : '') + text.slice(start, start + 72) + (start + 72 < text.length ? '…' : '');
}

/** BM25 (+ cosine when vectors exist). `itemOf` maps a path to a DesktopItem (skips deleted files). */
export async function contentSearch(q: string, s: Settings, itemOf: (p: string) => DesktopItem | undefined, limit = 12): Promise<(SearchResult & { snippet: string })[]> {
  const i = load();
  const docs = Object.values(i.docs);
  if (!docs.length || !q.trim()) return [];
  const terms = [...new Set(tokenize(q))].filter((t) => !/^(的|了|是|在|和|有|我|那个|文件|文档|一个|里面|内容|关于|提到)$/.test(t));
  if (!terms.length) return [];
  const N = docs.length;
  const avg = docs.reduce((a, d) => a + d.len, 0) / N || 1;
  const df = new Map<string, number>();
  for (const t of terms) df.set(t, docs.filter((d) => d.tf[t]).length);
  let qvec: number[] | null = null;
  if (i.embedModel && docs.some((d) => d.vec)) {
    try {
      qvec = (await embed(s, i.embedModel, [q], 8000))[0] ?? null;
    } catch {
      qvec = null;
    }
  }
  const scored = docs
    .map((d) => {
      let bm = 0;
      let hit = 0;
      for (const t of terms) {
        const f = d.tf[t] ?? 0;
        if (!f) continue;
        hit++;
        const n = df.get(t) ?? 0;
        const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
        bm += (idf * f * 2.2) / (f + 1.2 * (0.25 + 0.75 * (d.len / avg)));
      }
      const coverage = hit / terms.length;
      const sem = qvec && d.vec ? cosine(qvec, d.vec) : 0;
      const score = bm * (0.4 + coverage) + (sem > 0.45 ? sem * 6 : 0);
      return { d, score, coverage, sem };
    })
    .filter((x) => x.score > 0.5 && (x.coverage >= 0.5 || x.sem > 0.55))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  const out: (SearchResult & { snippet: string })[] = [];
  for (const x of scored) {
    const it = itemOf(x.d.path);
    if (!it) continue;
    out.push({ ...it, score: x.score, reason: x.sem > 0.55 && x.coverage < 0.5 ? '语义相关' : '内容匹配', snippet: snippet(x.d.text, terms) });
  }
  return out;
}
