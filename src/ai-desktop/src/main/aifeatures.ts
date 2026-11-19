/**
 * AI features (v1.2). Every feature has two paths:
 *   - AI path: OpenAI-compatible chat completion; only file-name-level metadata is sent unless the user opts in.
 *   - Local path: deterministic rules, used automatically when no model is configured or the call fails.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { CleanupItem, CmdAction, DesktopItem, RenameProposal, Rule, Settings } from '../shared/types';
import { CATEGORY_LABEL, CATEGORY_ICON } from '../shared/types';
import { aiConfigured, chatComplete, extractJSON } from './ai';
import { cleanRule, describeRule, firstRule, parseRuleLocal, RULE_FIELDS } from './rules';
import { extractText, canSummarize } from './extract';

const DAY = 86400000;
export const fullName = (it: DesktopItem) => it.name + (it.isDir ? '' : it.ext && !it.name.toLowerCase().endsWith(it.ext) ? it.ext : '');
const meta = (it: DesktopItem, i: number) => ({
  i,
  n: fullName(it) + (it.isDir ? '/' : ''),
  t: CATEGORY_LABEL[it.category],
  kb: it.isDir ? undefined : Math.round(it.size / 1024),
  d: Math.max(0, Math.round((Date.now() - it.mtime) / DAY)),
});

// ---------------------------------------------------------------- natural-language rule
export async function nlRule(s: Settings, text: string, boxTitles: string[], id: string): Promise<{ rule: Rule | null; via: 'ai' | 'local'; error?: string }> {
  if (aiConfigured(s)) {
    try {
      const fields = RULE_FIELDS.map((f) => `${f.field}(${f.ops.map((o) => o.op).join('/')})：${f.label}，例 ${f.hint}`).join('；');
      const reply = await chatComplete(
        s,
        [
          {
            role: 'system',
            content:
              '你把用户的一句话转换成桌面整理规则 JSON。字段：' + fields +
              '。category 的取值：doc,image,video,audio,archive,program,folder,other。modified 的 value 是天数，size 的 value 是 MB。name 的多个关键词用 | 分隔。' +
              `已有格子：${boxTitles.join('、') || '（无）'}，目标格子名优先复用已有格子（2~6 个字）。` +
              '只输出 JSON：{"name":"规则名","match":"all|any","conds":[{"field":"","op":"","value":""}],"target":"格子名","icon":"ri-xxx-line（Remix Icon，可选）"}',
          },
          { role: 'user', content: text },
        ],
        { timeoutMs: 30000 },
      );
      const rule = cleanRule({ ...extractJSON(reply), source: 'ai' }, id);
      if (rule) return { rule, via: 'ai' };
    } catch (e: any) {
      const local = parseRuleLocal(text, id);
      return { rule: local, via: 'local', error: local ? undefined : String(e?.message ?? e) };
    }
  }
  const local = parseRuleLocal(text, id);
  return { rule: local, via: 'local', error: local ? undefined : '没能理解这句话。可以这样说：「把所有发票放到财务格子」' };
}

// ---------------------------------------------------------------- organize plan with explanations (+ learning from corrections)
export interface PlanGroup {
  name: string;
  icon: string;
  reason: string;
  paths: string[];
}
export async function organizePlan(
  s: Settings,
  items: DesktopItem[],
  corrections: { name: string; ext: string; to: string }[],
): Promise<{ groups: PlanGroup[]; via: 'ai' | 'local'; note?: string }> {
  const list = items.slice(0, 400);
  if (aiConfigured(s)) {
    try {
      const prefs = corrections.slice(-25).map((c) => `「${c.name}${c.ext}」->「${c.to}」`);
      const rules = (s.rules ?? []).filter((r) => r.enabled).map((r) => describeRule(r));
      const reply = await chatComplete(
        s,
        [
          {
            role: 'system',
            content:
              '你是 Windows 桌面整理助手。根据文件名、类型、大小(kb)和距今天数(d)（不会提供文件内容），把桌面文件按用途/项目/主题分成 3~8 个格子。' +
              '格子名用简体中文 2~6 个字；每个格子给出一句话理由（为什么这些文件放在一起，20 字以内）和一个 Remix Icon 图标类名（如 ri-briefcase-4-line）。每个文件只能属于一个格子。' +
              (prefs.length ? `\n用户过去的手动调整（请尊重这些偏好）：${prefs.join('；')}` : '') +
              (rules.length ? `\n用户已有的规则（规则覆盖的文件请按规则归类）：${rules.join('；')}` : '') +
              '\n只输出 JSON：{"groups":[{"name":"","icon":"","reason":"","items":[编号...]}]}',
          },
          { role: 'user', content: JSON.stringify(list.map(meta)) },
        ],
        { timeoutMs: 90000 },
      );
      const data = extractJSON<{ groups: { name: string; icon?: string; reason?: string; items: number[] }[] }>(reply);
      if (!data?.groups?.length) throw new Error('AI 返回格式无法解析');
      const used = new Set<number>();
      const groups: PlanGroup[] = data.groups
        .map((g) => ({
          name: String(g.name || '未命名').slice(0, 12),
          icon: /^ri-[a-z0-9-]+$/.test(g.icon ?? '') ? g.icon! : 'ri-sparkling-2-line',
          reason: String(g.reason ?? '').slice(0, 60),
          paths: (g.items || []).filter((i) => Number.isInteger(i) && list[i] && !used.has(i) && (used.add(i), true)).map((i) => list[i].path),
        }))
        .filter((g) => g.paths.length);
      const rest = list.filter((_, i) => !used.has(i)).map((i) => i.path);
      if (rest.length) groups.push({ name: '其他', icon: 'ri-shapes-line', reason: 'AI 未归类的文件', paths: rest });
      return { groups, via: 'ai', note: `AI 只收到了 ${list.length} 个文件名与类型${prefs.length ? `，并参考了你的 ${prefs.length} 次手动调整` : ''}` };
    } catch (e: any) {
      const r = localPlan(s, list);
      return { ...r, note: `AI 调用失败，已改用本地规则：${String(e?.message ?? e).slice(0, 80)}` };
    }
  }
  return { ...localPlan(s, list), note: '未配置 AI，按你的规则和文件类型给出建议' };
}

function localPlan(s: Settings, items: DesktopItem[]): { groups: PlanGroup[]; via: 'local' } {
  const map = new Map<string, PlanGroup>();
  for (const it of items) {
    const r = firstRule(s.rules ?? [], it);
    const key = r ? 'r:' + r.target : 'c:' + it.category;
    if (!map.has(key))
      map.set(key, r
        ? { name: r.target, icon: r.icon ?? 'ri-filter-3-line', reason: `规则「${r.name}」`, paths: [] }
        : { name: CATEGORY_LABEL[it.category], icon: CATEGORY_ICON[it.category], reason: `同为${CATEGORY_LABEL[it.category]}类型`, paths: [] });
    map.get(key)!.paths.push(it.path);
  }
  return { groups: [...map.values()].sort((a, b) => b.paths.length - a.paths.length), via: 'local' };
}

// ---------------------------------------------------------------- desktop clutter cleanup (local, no AI needed)
async function hashFile(p: string, size: number): Promise<string> {
  const h = createHash('sha1');
  if (size <= 8 * 1024 * 1024) {
    h.update(await fsp.readFile(p));
  } else {
    // large files: size + head + middle + tail (fast, practically unique)
    const fd = await fsp.open(p, 'r');
    try {
      const buf = Buffer.alloc(256 * 1024);
      for (const at of [0, Math.floor(size / 2), Math.max(0, size - buf.length)]) {
        const { bytesRead } = await fd.read(buf, 0, buf.length, at);
        h.update(buf.subarray(0, bytesRead));
      }
      h.update(String(size));
    } finally {
      await fd.close();
    }
  }
  return h.digest('hex');
}

export async function cleanupScan(items: DesktopItem[]): Promise<{ items: CleanupItem[]; bytes: number; scanned: number }> {
  const out: CleanupItem[] = [];
  const now = Date.now();
  const files = items.filter((i) => !i.isDir && i.source !== 'public');
  // duplicates: same size first, then content hash
  const bySize = new Map<number, DesktopItem[]>();
  for (const f of files) if (f.size > 0 && !['.lnk', '.url'].includes(f.ext)) bySize.set(f.size, [...(bySize.get(f.size) ?? []), f]);
  const dupPaths = new Set<string>();
  for (const group of bySize.values()) {
    if (group.length < 2) continue;
    const byHash = new Map<string, DesktopItem[]>();
    for (const f of group) {
      try {
        const h = await hashFile(f.path, f.size);
        byHash.set(h, [...(byHash.get(h) ?? []), f]);
      } catch {
        /* unreadable */
      }
    }
    for (const same of byHash.values()) {
      if (same.length < 2) continue;
      // keep the one with the "cleanest" name (no 副本 / (1)), oldest first
      const score = (x: DesktopItem) => (/副本|copy|\(\d+\)|（\d+）/i.test(x.name) ? 1 : 0);
      same.sort((a, b) => score(a) - score(b) || a.mtime - b.mtime);
      for (const d of same.slice(1)) {
        out.push({ ...d, group: 'duplicate', reason: `与「${fullName(same[0])}」内容完全相同`, dupOf: same[0].path });
        dupPaths.add(d.path);
      }
    }
  }
  for (const f of files) {
    if (dupPaths.has(f.path)) continue;
    const days = Math.round((now - f.mtime) / DAY);
    const nm = fullName(f);
    if (/^~\$|\.(tmp|temp|crdownload|part|download|bak)$/i.test(nm)) out.push({ ...f, group: 'temp', reason: '临时 / 未完成下载的文件' });
    else if ((f.ext === '.msi' || (f.ext === '.exe' && /setup|install|安装|installer|_x64|amd64|-win/i.test(nm))) && days >= 7)
      out.push({ ...f, group: 'installer', reason: `安装包，${days} 天前下载，安装后通常可删除` });
    else if (f.size >= 500 * 1024 * 1024) out.push({ ...f, group: 'large', reason: `大文件 ${(f.size / 1073741824).toFixed(2)} GB，建议移到其他磁盘或网盘` });
    else if (days >= 90 && f.category !== 'program') out.push({ ...f, group: 'stale', reason: `${days} 天未修改，可能已不再需要` });
  }
  for (const d of items.filter((i) => i.isDir && i.source === 'user')) {
    try {
      const ents = (await fsp.readdir(d.path)).filter((n) => !/^(desktop\.ini|thumbs\.db|\.ds_store)$/i.test(n));
      if (!ents.length) out.push({ ...d, group: 'empty', reason: '空文件夹' });
    } catch {
      /* ignore */
    }
  }
  const bytes = out.filter((o) => o.group !== 'empty').reduce((a, o) => a + o.size, 0);
  return { items: out, bytes, scanned: items.length };
}

// ---------------------------------------------------------------- batch rename
const clean = (base: string) =>
  base
    .replace(/\s*[-_ ]?(副本|copy)(\s*\(\d+\))?$/i, '')
    .replace(/\s*[（(]\d+[)）]$/, '')
    .replace(/[\s_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_?(最终版|最终|final)(_?v?\d+)?$/i, '')
    .trim();
const ymd = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const ILLEGAL = /[\\/:*?"<>|\r\n]/g;

export function localRename(items: DesktopItem[], style: 'tidy' | 'date'): RenameProposal[] {
  return items.map((it) => {
    const ext = it.isDir ? '' : path.extname(path.basename(it.path));
    const base = path.basename(it.path, ext);
    let to = clean(base) || base;
    if (style === 'date' && !/^\d{4}-?\d{2}-?\d{2}/.test(to)) to = `${ymd(it.mtime)}_${to}`;
    return { path: it.path, from: path.basename(it.path), to: (to + ext).replace(ILLEGAL, '_'), reason: style === 'date' ? '日期前缀 + 去除副本/编号' : '去除副本/编号/多余空格' };
  });
}

export async function renamePlan(s: Settings, items: DesktopItem[], opts: { style: 'smart' | 'tidy' | 'date'; useContent: boolean; hint?: string }): Promise<{ proposals: RenameProposal[]; via: 'ai' | 'local'; note?: string }> {
  if (opts.style !== 'smart' || !aiConfigured(s)) {
    return { proposals: localRename(items, opts.style === 'smart' ? 'date' : opts.style), via: 'local', note: opts.style === 'smart' ? '未配置 AI：使用本地规范化（日期前缀 + 去除副本/编号）' : undefined };
  }
  const payload = [];
  for (const [i, it] of items.slice(0, 60).entries()) {
    let peek = '';
    if (opts.useContent && canSummarize(it.path)) {
      try {
        peek = (await extractText(it.path, 300)).text.replace(/\s+/g, ' ').slice(0, 300);
      } catch {
        /* ignore */
      }
    }
    payload.push({ i, n: path.basename(it.path), date: ymd(it.mtime), ...(peek ? { head: peek } : {}) });
  }
  try {
    const reply = await chatComplete(
      s,
      [
        {
          role: 'system',
          content:
            '你是文件命名助手。为每个文件给出一个清晰、规范的新文件名：简体中文为主，格式建议「日期_主题_补充信息」（日期用 YYYY-MM-DD，可从原名或 date 推断），' +
            '去掉「副本」「(1)」「最终版」「新建」等噪声；保持原扩展名不变；不要包含 \\ / : * ? " < > |；不确定时保持接近原名。' +
            (opts.hint ? `用户的额外要求：${opts.hint}。` : '') +
            '每个文件给出 12 字以内的理由。只输出 JSON：{"items":[{"i":编号,"name":"新文件名（含扩展名）","reason":""}]}',
        },
        { role: 'user', content: JSON.stringify(payload) },
      ],
      { timeoutMs: 90000 },
    );
    const data = extractJSON<{ items: { i: number; name: string; reason?: string }[] }>(reply);
    if (!data?.items?.length) throw new Error('AI 返回格式无法解析');
    const proposals = items.slice(0, 60).map((it, i) => {
      const ext = it.isDir ? '' : path.extname(it.path);
      const got = data.items.find((x) => x.i === i);
      let to = String(got?.name ?? '').replace(ILLEGAL, '_').trim() || path.basename(it.path);
      if (ext && !to.toLowerCase().endsWith(ext.toLowerCase())) to += ext;
      return { path: it.path, from: path.basename(it.path), to: to.slice(0, 120), reason: String(got?.reason ?? '').slice(0, 30) };
    });
    return { proposals, via: 'ai', note: opts.useContent ? '已发送文件名和每个文件开头 300 字用于理解内容' : '仅发送了文件名和日期' };
  } catch (e: any) {
    return { proposals: localRename(items, 'date'), via: 'local', note: `AI 调用失败，已改用本地规范化：${String(e?.message ?? e).slice(0, 80)}` };
  }
}

export async function applyRenames(list: RenameProposal[]): Promise<{ done: { from: string; to: string }[]; failed: string[] }> {
  const done: { from: string; to: string }[] = [];
  const failed: string[] = [];
  for (const p of list) {
    const dir = path.dirname(p.path);
    const name = p.to.replace(ILLEGAL, '_').trim();
    if (!name || name === path.basename(p.path)) continue;
    let target = path.join(dir, name);
    const ext = path.extname(name);
    let n = 2;
    while (fs.existsSync(target) && target.toLowerCase() !== p.path.toLowerCase()) target = path.join(dir, `${path.basename(name, ext)} (${n++})${ext}`);
    try {
      await fsp.rename(p.path, target);
      done.push({ from: p.path, to: target });
    } catch {
      failed.push(path.basename(p.path));
    }
  }
  return { done, failed };
}

// ---------------------------------------------------------------- daily desktop briefing
export interface Briefing {
  stats: { total: number; today: number; week: number; clutter: number; reclaim: number; dup: number; stale: number; large: number };
  newFiles: { name: string; path: string; mtime: number }[];
  todos: { text: string; file: string }[];
  markdown: string;
  via: 'ai' | 'local';
}
export async function briefing(s: Settings, items: DesktopItem[], cleanup: { items: CleanupItem[]; bytes: number }): Promise<Briefing> {
  const now = Date.now();
  const startToday = new Date(new Date().toDateString()).getTime();
  const files = items.filter((i) => !i.isDir);
  const today = files.filter((f) => f.mtime >= startToday).sort((a, b) => b.mtime - a.mtime);
  const week = files.filter((f) => now - f.mtime < 7 * DAY);
  const g = (k: CleanupItem['group']) => cleanup.items.filter((c) => c.group === k).length;
  // clutter score: loose icons + cleanup candidates
  const clutter = Math.min(100, Math.round(items.length * 1.2 + cleanup.items.length * 4));
  // local todo extraction from recently modified text files (never sent to AI)
  const todos: { text: string; file: string }[] = [];
  for (const f of week.filter((x) => ['.txt', '.md'].includes(x.ext)).slice(0, 10)) {
    try {
      const { text } = await extractText(f.path, 4000);
      for (const line of text.split(/\r?\n/)) {
        const t = line.trim().replace(/^[-*\d.、\s]+/, '');
        if (/待办|todo|截止|deadline|周[一二三四五六日]前|明天|提交|记得|需要完成/i.test(t) && t.length <= 80) todos.push({ text: t, file: fullName(f) });
        if (todos.length >= 6) break;
      }
    } catch {
      /* ignore */
    }
  }
  const stats = { total: items.length, today: today.length, week: week.length, clutter, reclaim: cleanup.bytes, dup: g('duplicate'), stale: g('stale'), large: g('large') };
  const gb = (b: number) => (b >= 1073741824 ? (b / 1073741824).toFixed(1) + ' GB' : Math.round(b / 1048576) + ' MB');
  let markdown =
    `今天桌面上新增或修改了 **${today.length}** 个文件，本周 **${week.length}** 个；桌面共有 ${items.length} 个项目，杂乱指数 **${clutter}**/100。\n\n` +
    (cleanup.items.length ? `- 发现 ${stats.dup} 个重复文件、${stats.stale} 个长期未动的文件、${stats.large} 个大文件，可释放约 **${gb(cleanup.bytes)}**。\n` : '- 桌面很干净，没有需要清理的文件。\n') +
    (today.length ? `- 今天的文件：${today.slice(0, 5).map((f) => '「' + fullName(f) + '」').join('、')}${today.length > 5 ? ' 等' : ''}。\n` : '') +
    (todos.length ? `- 从你的笔记中找到 ${todos.length} 条可能的待办（见下方）。\n` : '');
  let via: 'ai' | 'local' = 'local';
  if (aiConfigured(s)) {
    try {
      const reply = await chatComplete(
        s,
        [
          {
            role: 'system',
            content:
              '你是桌面助理，根据统计和文件名写一份简短的「今日桌面简报」（简体中文 Markdown，不超过 120 字，2~4 条要点，语气友好）。' +
              '要点包括：今天在忙什么（从文件名推断主题）、一条整理建议、一条提醒。不要编造不存在的文件。',
          },
          { role: 'user', content: JSON.stringify({ stats: { ...stats, reclaim: gb(cleanup.bytes) }, today: today.slice(0, 20).map(fullName), week: week.slice(0, 30).map(fullName) }) },
        ],
        { timeoutMs: 45000 },
      );
      if (reply.trim()) {
        markdown = reply.trim();
        via = 'ai';
      }
    } catch {
      /* keep local */
    }
  }
  return { stats, newFiles: today.slice(0, 8).map((f) => ({ name: fullName(f), path: f.path, mtime: f.mtime })), todos, markdown, via };
}

// ---------------------------------------------------------------- AI command bar
const CMD_TYPES = ['organize', 'ai-organize', 'create-box', 'move', 'create-rule', 'hide', 'show', 'page', 'snapshot-save', 'snapshot-restore', 'cleanup', 'rename', 'briefing', 'summarize', 'search', 'settings', 'portal', 'undo'];

export function looksLikeCommand(q: string): boolean {
  const t = q.trim();
  if (t.startsWith('>') || t.startsWith('》')) return true;
  return /^(请|帮我|帮忙)?\s*(把|将|新建|创建|建一个|隐藏|显示|切换到?|保存|恢复|整理|清理|重命名|总结|翻译|撤销|打开设置|映射)/.test(t);
}

/** Deterministic parser for common commands (used without AI, and as a fast path). */
export function planLocal(text: string, ctx: { boxes: string[]; pages: string[]; snapshots: string[] }): CmdAction[] {
  const t = text.trim().replace(/^[>》]\s*/, '').replace(/^(请|帮我|帮忙)\s*/, '').replace(/[。！!？?]$/, '');
  if (!t) return [];
  if (/^撤销/.test(t)) return [{ type: 'undo', label: '撤销上一次整理' }];
  if (/(ai|智能).*整理|整理.*(ai|智能)/i.test(t)) return [{ type: 'ai-organize', label: 'AI 智能整理（先预览）' }];
  if (/^(一键)?整理(一下)?(桌面)?$/.test(t)) return [{ type: 'organize', label: '一键整理（规则 + 类型）' }];
  if (/清理|重复|大文件|垃圾|过期/.test(t)) return [{ type: 'cleanup', label: '扫描桌面，给出清理建议' }];
  if (/简报|今天.*(做|忙|桌面)|日报/.test(t)) return [{ type: 'briefing', label: '生成今日桌面简报' }];
  if (/^重命名/.test(t)) return [{ type: 'rename', label: '打开 AI 批量重命名' }];
  let m = t.match(/^(?:新建|创建|建)(?:一个)?(?:叫|名为)?\s*[「『"“]?([^「」『』"”]{1,16}?)[」』"”]?\s*(?:的)?\s*(?:格子|分组|分区)$/);
  if (m) return [{ type: 'create-box', box: m[1].trim(), label: `新建格子「${m[1].trim()}」` }];
  m = t.match(/^(?:新建|创建)?(?:文件夹)?映射\s*(.+)$/);
  if (m) return [{ type: 'portal', text: m[1].trim(), label: `把文件夹「${m[1].trim()}」映射到桌面` }];
  if (/^(隐藏|收起)(所有|全部)?(格子|图标|桌面)/.test(t)) return [{ type: 'hide', label: '快速隐藏所有格子' }];
  if (/^(显示|展开)(所有|全部)?(格子|图标|桌面)/.test(t)) return [{ type: 'show', label: '显示所有格子' }];
  m = t.match(/^切换到?\s*(?:第\s*)?(\d+|[一二三四五六七八九])\s*(?:页|个桌面)/);
  if (m) {
    const n = '一二三四五六七八九'.indexOf(m[1]) + 1 || Number(m[1]);
    return [{ type: 'page', page: n - 1, label: `切换到第 ${n} 个桌面页` }];
  }
  m = t.match(/^切换到?\s*[「『"“]?(.+?)[」』"”]?\s*(?:页|桌面)?$/);
  if (m) {
    const i = ctx.pages.findIndex((p) => p.includes(m![1]) || m![1].includes(p));
    if (i >= 0) return [{ type: 'page', page: i, label: `切换到桌面页「${ctx.pages[i]}」` }];
  }
  m = t.match(/^保存(?:当前)?(?:布局|快照)(?:为|叫)?\s*[「『"“]?([^」』"”]*)[」』"”]?$/);
  if (m) return [{ type: 'snapshot-save', name: m[1].trim(), label: `保存布局快照${m[1].trim() ? `「${m[1].trim()}」` : ''}` }];
  m = t.match(/^恢复(?:布局|快照)?\s*[「『"“]?([^」』"”]+)[」』"”]?$/);
  if (m) {
    const name = ctx.snapshots.find((x) => x.includes(m![1].trim())) ?? m[1].trim();
    return [{ type: 'snapshot-restore', name, label: `恢复布局快照「${name}」` }];
  }
  m = t.match(/^(总结|翻译)\s*(?:一下)?\s*(.+)$/);
  if (m) return [{ type: 'summarize', query: m[2].replace(/(这个|那个)?(文件|文档)$/, '').trim(), text: m[1] === '翻译' ? 'translate' : 'summary', label: `${m[1]}「${m[2].trim()}」` }];
  // "把…放到…": persistent rule when it says 所有/以后/都, otherwise a one-off move
  m = t.match(/^(?:把|将)(.+?)(?:都|全部)?(?:放到|放进|放入|移到|移动到|归到|收到)\s*[「『"“]?([^「」『』"”]{1,16}?)[」』"”]?\s*(?:格子|分组|里)?$/);
  if (m) {
    const persistent = /所有|全部|以后|今后|自动|每次|新的/.test(m[1]) || /都$/.test(m[1]);
    if (persistent) {
      const r = parseRuleLocal(t, 'cmd');
      if (r) return [{ type: 'create-rule', rule: r, label: `创建规则：${describeRule(r)}` }];
    }
    return [{ type: 'move', query: m[1].replace(/^(这些|那些|这个|那个)/, '').trim(), box: m[2].trim(), label: `把匹配「${m[1].trim()}」的文件放进「${m[2].trim()}」` }];
  }
  if (/设置/.test(t)) return [{ type: 'settings', label: '打开设置' }];
  return [];
}

export async function planCommand(
  s: Settings,
  text: string,
  ctx: { boxes: string[]; pages: string[]; snapshots: string[]; files: DesktopItem[] },
): Promise<{ actions: CmdAction[]; reply: string; via: 'ai' | 'local' }> {
  const local = planLocal(text, ctx);
  if (!aiConfigured(s)) {
    return local.length
      ? { actions: local, reply: '', via: 'local' }
      : { actions: [{ type: 'search', query: text.replace(/^[>》]\s*/, ''), label: `搜索「${text.replace(/^[>》]\s*/, '')}」` }], reply: '未配置 AI，仅支持常用命令（如「整理桌面」「新建 XX 格子」「把所有发票放到财务格子」）', via: 'local' };
  }
  try {
    const reply = await chatComplete(
      s,
      [
        {
          role: 'system',
          content:
            '你是桌面整理软件的命令解析器，把用户的话转换为动作列表（最多 4 个）。可用动作：' +
            'organize(按规则和类型整理)、ai-organize(AI 整理)、create-box{box}、move{query,box}(把搜索到的文件放进格子)、' +
            'create-rule{rule:{name,match,conds:[{field,op,value}],target}}(持久规则，field: ext/name/regex/category/modified/size/kind)、' +
            'hide、show、page{page:从0开始}、snapshot-save{name}、snapshot-restore{name}、cleanup、rename、briefing、summarize{query,text:"summary"|"translate"}、search{query}、settings、undo。' +
            `已有格子：${ctx.boxes.join('、')}；桌面页：${ctx.pages.join('、')}；快照：${ctx.snapshots.join('、') || '无'}。` +
            '每个动作带 label（给用户看的中文说明）。「所有/以后/自动」类描述用 create-rule，一次性的用 move。听不懂就用 search。' +
            '只输出 JSON：{"actions":[{"type":"","label":"",...}],"reply":"一句话回复"}',
        },
        { role: 'user', content: text.replace(/^[>》]\s*/, '') },
      ],
      { timeoutMs: 30000 },
    );
    const data = extractJSON<{ actions: any[]; reply?: string }>(reply);
    const actions: CmdAction[] = (data?.actions ?? [])
      .filter((a) => a && CMD_TYPES.includes(a.type))
      .slice(0, 4)
      .map((a) => {
        const out: CmdAction = { type: a.type, label: String(a.label ?? a.type).slice(0, 80) };
        if (typeof a.box === 'string') out.box = a.box.slice(0, 24);
        if (typeof a.query === 'string') out.query = a.query.slice(0, 80);
        if (typeof a.name === 'string') out.name = a.name.slice(0, 30);
        if (typeof a.text === 'string') out.text = a.text.slice(0, 20);
        if (Number.isInteger(a.page)) out.page = a.page;
        if (a.type === 'create-rule') {
          const r = cleanRule({ ...a.rule, source: 'ai' }, 'cmd-' + Date.now());
          if (!r) return null;
          out.rule = r;
          out.label = `创建规则：${describeRule(r)}`;
        }
        return out;
      })
      .filter(Boolean) as CmdAction[];
    if (!actions.length) throw new Error('no actions');
    return { actions, reply: String(data?.reply ?? '').slice(0, 120), via: 'ai' };
  } catch {
    return local.length
      ? { actions: local, reply: '', via: 'local' }
      : { actions: [{ type: 'search', query: text.replace(/^[>》]\s*/, ''), label: `搜索「${text.replace(/^[>》]\s*/, '')}」` }], reply: '', via: 'local' };
  }
}
