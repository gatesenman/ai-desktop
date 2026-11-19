import { match as pyMatch } from 'pinyin-pro';
import type { Category, DesktopItem, SearchResult } from '../shared/types';

/** Local (offline) natural-language query parser: time words + type words + keywords. */
export interface ParsedQuery {
  from?: number;
  to?: number;
  exts?: string[];
  categories?: Category[];
  keywords: string[];
  timeLabel?: string;
}

const DAY = 86400000;
function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}
function startOfWeek(d: Date): number {
  const day = (d.getDay() + 6) % 7; // Monday = 0
  return startOfDay(d) - day * DAY;
}

const TYPE_WORDS: { re: RegExp; exts?: string[]; cats?: Category[] }[] = [
  { re: /pdf/i, exts: ['.pdf'] },
  { re: /word|docx?|文档稿/i, exts: ['.doc', '.docx', '.wps'] },
  { re: /excel|xlsx?|表格|报表/i, exts: ['.xls', '.xlsx', '.csv', '.et'] },
  { re: /ppt|幻灯片|演示文稿|课件/i, exts: ['.ppt', '.pptx', '.dps'] },
  { re: /图片|照片|截图|相片|图像|png|jpe?g/i, cats: ['image'] },
  { re: /视频|录像|影片|电影|mp4/i, cats: ['video'] },
  { re: /音乐|歌曲|音频|录音|mp3/i, cats: ['audio'] },
  { re: /压缩包|压缩文件|zip|rar|7z/i, cats: ['archive'] },
  { re: /程序|软件|快捷方式|应用|安装包|exe/i, cats: ['program'] },
  { re: /文件夹|目录/i, cats: ['folder'] },
  { re: /文档|文件稿|资料/i, cats: ['doc'] },
];

const STOP = /(帮我|给我|请|找一下|找找|找到|查找|搜索|找|一下|那个|那份|这个|这份|那些|之前|的|了|文件|一个|我|在|桌面上?|里|中)/g;

export function parseQuery(q: string, now = new Date()): ParsedQuery {
  let rest = q;
  const r: ParsedQuery = { keywords: [] };
  const today = startOfDay(now);
  const setRange = (from: number, to: number, label: string, re: RegExp) => {
    r.from = from;
    r.to = to;
    r.timeLabel = label;
    rest = rest.replace(re, ' ');
  };
  let m: RegExpMatchArray | null;
  if ((m = rest.match(/(最近|近)\s*(\d+|[一二三四五六七八九十两]+)\s*(天|日)/))) {
    const n = cnNum(m[2]);
    setRange(today - (n - 1) * DAY, Infinity, `最近${n}天`, /(最近|近)\s*(\d+|[一二三四五六七八九十两]+)\s*(天|日)/);
  } else if (/今天|今日/.test(rest)) setRange(today, Infinity, '今天', /今天|今日/);
  else if (/昨天|昨日/.test(rest)) setRange(today - DAY, today, '昨天', /昨天|昨日/);
  else if (/前天/.test(rest)) setRange(today - 2 * DAY, today - DAY, '前天', /前天/);
  else if (/上上周/.test(rest)) setRange(startOfWeek(now) - 14 * DAY, startOfWeek(now) - 7 * DAY, '上上周', /上上周/);
  else if (/上周|上星期|上个星期|上礼拜/.test(rest)) setRange(startOfWeek(now) - 7 * DAY, startOfWeek(now), '上周', /上周|上星期|上个星期|上礼拜/);
  else if (/本周|这周|这个星期|这星期/.test(rest)) setRange(startOfWeek(now), Infinity, '本周', /本周|这周|这个星期|这星期/);
  else if (/上个?月/.test(rest)) {
    const f = new Date(now.getFullYear(), now.getMonth() - 1, 1).getTime();
    const t = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    setRange(f, t, '上个月', /上个?月/);
  } else if (/本月|这个月/.test(rest)) setRange(new Date(now.getFullYear(), now.getMonth(), 1).getTime(), Infinity, '本月', /本月|这个月/);
  else if (/今年/.test(rest)) setRange(new Date(now.getFullYear(), 0, 1).getTime(), Infinity, '今年', /今年/);
  else if (/去年/.test(rest)) setRange(new Date(now.getFullYear() - 1, 0, 1).getTime(), new Date(now.getFullYear(), 0, 1).getTime(), '去年', /去年/);
  else if (/最近|近期|刚才|刚刚/.test(rest)) setRange(today - 7 * DAY, Infinity, '最近', /最近|近期|刚才|刚刚/);

  for (const t of TYPE_WORDS) {
    if (t.re.test(rest)) {
      if (t.exts) r.exts = [...(r.exts ?? []), ...t.exts];
      if (t.cats) r.categories = [...(r.categories ?? []), ...t.cats];
      rest = rest.replace(new RegExp(t.re.source, 'gi'), ' ');
    }
  }
  rest = rest.replace(STOP, ' ');
  r.keywords = rest
    .split(/[\s,，。.、;；:："'“”‘’!！?？]+/)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
  return r;
}

function cnNum(s: string): number {
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  const map: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  if (s.length === 1) return map[s] ?? 7;
  if (s.startsWith('十')) return 10 + (map[s[1]] ?? 0);
  if (s.endsWith('十')) return (map[s[0]] ?? 1) * 10;
  return (map[s[0]] ?? 1) * 10 + (map[s[2]] ?? 0);
}

/** fuzzy subsequence score; 0 = no match */
export function fuzzyScore(name: string, q: string): number {
  const n = name.toLowerCase();
  const k = q.toLowerCase();
  if (!k) return 1;
  const idx = n.indexOf(k);
  if (idx === 0) return 100 + k.length;
  if (idx > 0) return 80 + k.length - idx * 0.1;
  let j = 0;
  let score = 0;
  let last = -2;
  for (let i = 0; i < n.length && j < k.length; i++) {
    if (n[i] === k[j]) {
      score += i === last + 1 ? 3 : 1;
      last = i;
      j++;
    }
  }
  return j === k.length ? 10 + score : 0;
}

export interface NameMatch {
  score: number;
  hl: number[];
  pinyin: boolean;
}

const HAS_CJK = /[\u4e00-\u9fff]/;

/** Match one query token against a name: substring > pinyin (full / initials, e.g. bj -> 报价) > fuzzy subsequence. */
export function matchName(name: string, q: string): NameMatch | null {
  const n = name.toLowerCase();
  const k = q.toLowerCase();
  if (!k) return { score: 1, hl: [], pinyin: false };
  const idx = n.indexOf(k);
  if (idx >= 0) {
    return { score: (idx === 0 ? 100 : 80) + k.length - idx * 0.1, hl: Array.from({ length: k.length }, (_, i) => idx + i), pinyin: false };
  }
  if (HAS_CJK.test(name) && /^[a-z0-9]+$/.test(k)) {
    try {
      const m = pyMatch(name, k, { continuous: false });
      if (m && m.length) {
        const contiguous = m.every((v, i) => i === 0 || v === m[i - 1] + 1);
        return { score: 60 + m.length * 2 + (contiguous ? 10 : 0) - m[0] * 0.5, hl: m, pinyin: true };
      }
    } catch {
      /* ignore */
    }
  }
  // fuzzy subsequence
  let j = 0;
  let score = 0;
  let last = -2;
  const hl: number[] = [];
  for (let i = 0; i < n.length && j < k.length; i++) {
    if (n[i] === k[j]) {
      score += i === last + 1 ? 3 : 1;
      last = i;
      hl.push(i);
      j++;
    }
  }
  return j === k.length ? { score: 10 + score, hl, pinyin: false } : null;
}

export function quickSearch(items: DesktopItem[], q: string, limit = 50): SearchResult[] {
  const query = q.trim();
  if (!query) {
    return [...items].sort((a, b) => b.mtime - a.mtime).slice(0, limit).map((i) => ({ ...i, score: 0 }));
  }
  const parts = query.split(/\s+/);
  const out: SearchResult[] = [];
  for (const it of items) {
    let total = 0;
    const hl = new Set<number>();
    let viaPinyin = false;
    let ok = true;
    for (const p of parts) {
      const m = matchName(it.name, p) ?? (it.ext ? matchName(it.name + it.ext, p) : null);
      if (!m) {
        ok = false;
        break;
      }
      total += m.score;
      m.hl.forEach((i) => i < it.name.length && hl.add(i));
      viaPinyin ||= m.pinyin;
    }
    if (ok) {
      out.push({
        ...it,
        score: total + (it.source === 'external' ? 0 : 1) - it.path.split(/[\\/]/).length * 0.5,
        hl: [...hl].sort((a, b) => a - b),
        reason: viaPinyin ? '拼音匹配' : undefined,
      });
    }
  }
  return out.sort((a, b) => b.score - a.score || b.mtime - a.mtime).slice(0, limit);
}

export function looksNatural(q: string): boolean {
  return /今天|昨天|前天|上周|本周|这周|上个?月|本月|这个月|最近|去年|今年|那个|那份|帮我|找|上星期|的/.test(q) && q.length >= 3;
}

/** Offline natural-language search. */
export function localNLSearch(items: DesktopItem[], q: string, limit = 30): SearchResult[] {
  const pq = parseQuery(q);
  const out: SearchResult[] = [];
  for (const it of items) {
    if (pq.from !== undefined && !(it.mtime >= pq.from && it.mtime < (pq.to ?? Infinity))) continue;
    const typeOk =
      (!pq.exts && !pq.categories) ||
      (pq.exts?.includes(it.ext) ?? false) ||
      (pq.categories?.includes(it.category) ?? false);
    if (!typeOk) continue;
    let score = 1;
    let kwHit = 0;
    const hl = new Set<number>();
    for (const k of pq.keywords) {
      const m = matchName(it.name, k);
      const s = m?.score ?? 0;
      if (s >= 60) kwHit++;
      score += s;
      m?.hl.forEach((i) => hl.add(i));
    }
    if (pq.keywords.length && kwHit === 0 && score < 20) continue;
    const reasons: string[] = [];
    if (pq.timeLabel) reasons.push(pq.timeLabel + '修改');
    if (pq.exts || pq.categories) reasons.push('类型匹配');
    if (kwHit) reasons.push('名称包含关键词');
    out.push({ ...it, score, hl: [...hl].sort((a, b) => a - b), reason: reasons.join('，') || undefined });
  }
  return out.sort((a, b) => b.score - a.score || b.mtime - a.mtime).slice(0, limit);
}
