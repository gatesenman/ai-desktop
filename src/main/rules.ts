import type { Category, DesktopItem, Rule, RuleCond } from '../shared/types';
import { CATEGORY_LABEL } from '../shared/types';

export const RULE_FIELDS: { field: RuleCond['field']; label: string; ops: { op: string; label: string }[]; hint: string }[] = [
  { field: 'ext', label: '扩展名', ops: [{ op: 'in', label: '是其中之一' }, { op: 'notin', label: '不是' }], hint: '.pdf, .docx' },
  {
    field: 'name',
    label: '文件名',
    ops: [
      { op: 'contains', label: '包含' },
      { op: 'starts', label: '开头是' },
      { op: 'ends', label: '结尾是' },
      { op: 'glob', label: '通配符匹配' },
      { op: 'notcontains', label: '不包含' },
    ],
    hint: '发票|invoice（| 分隔多个）',
  },
  { field: 'regex', label: '正则表达式', ops: [{ op: 'matches', label: '匹配' }], hint: '^IMG_\\d+' },
  { field: 'category', label: '文件类型', ops: [{ op: 'is', label: '是' }, { op: 'not', label: '不是' }], hint: 'doc' },
  { field: 'modified', label: '修改时间', ops: [{ op: 'older', label: '早于（天前）' }, { op: 'newer', label: '在最近（天内）' }], hint: '30' },
  { field: 'size', label: '大小', ops: [{ op: 'gt', label: '大于（MB）' }, { op: 'lt', label: '小于（MB）' }], hint: '100' },
  { field: 'kind', label: '种类', ops: [{ op: 'is', label: '是' }], hint: 'folder' },
  {
    field: 'target',
    label: '快捷方式目标',
    ops: [
      { op: 'contains', label: '包含' },
      { op: 'notcontains', label: '不包含' },
      { op: 'starts', label: '开头是' },
      { op: 'ends', label: '结尾是' },
    ],
    hint: 'Program Files\\Adobe|steam',
  },
  { field: 'weekday', label: '星期（整理时）', ops: [{ op: 'in', label: '是' }], hint: '1-5（周一到周五）' },
  { field: 'hour', label: '时段（整理时）', ops: [{ op: 'in', label: '在' }], hint: '9-18' },
];

/** Shortcut target resolver (main process injects shell.readShortcutLink; renderer never evaluates). */
let linkTarget: (p: string) => string = () => '';
export function setLinkTargetResolver(fn: (p: string) => string) {
  linkTarget = fn;
}

/** Parses "1-5,7" / "9-18" style ranges. */
export function inRanges(spec: string, n: number): boolean {
  const parts = spec.split(/[,，\s]+/).filter(Boolean);
  if (!parts.length) return false;
  return parts.some((p) => {
    const m = p.match(/^(\d+)\s*[-~～]\s*(\d+)$/);
    if (m) {
      const a = Number(m[1]);
      const b = Number(m[2]);
      return a <= b ? n >= a && n <= b : n >= a || n <= b; // wraps (e.g. 22-6)
    }
    return Number(p) === n;
  });
}

export const DEFAULT_RULES: Rule[] = [
  {
    id: 'default-shots',
    name: '截图集中存放',
    enabled: true,
    match: 'any',
    conds: [{ field: 'regex', op: 'matches', value: '^(截图|屏幕截图|Screenshot|Snipaste|QQ截图|微信截图|微信图片)' }],
    target: '截图',
    color: '#14b8a6',
    icon: 'ri-screenshot-2-line',
    source: 'default',
  },
  {
    id: 'default-invoice',
    name: '发票与报销',
    enabled: true,
    match: 'any',
    conds: [{ field: 'name', op: 'contains', value: '发票|invoice|报销|收据' }],
    target: '财务票据',
    color: '#e8a92c',
    icon: 'ri-money-cny-circle-line',
    source: 'default',
  },
  {
    id: 'default-installer',
    name: '安装包',
    enabled: true,
    match: 'any',
    conds: [
      { field: 'ext', op: 'in', value: '.msi' },
      { field: 'regex', op: 'matches', value: '(setup|install|安装).*\\.exe$' },
    ],
    target: '安装包',
    color: '#f08c2e',
    icon: 'ri-install-line',
    source: 'default',
  },
];

const DAY = 86400000;

function fullName(it: DesktopItem): string {
  return it.name + (it.isDir ? '' : it.ext && !it.name.toLowerCase().endsWith(it.ext) ? it.ext : '');
}

function globToRe(g: string): RegExp {
  const re = g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp('^' + re + '$', 'i');
}

const reCache = new Map<string, RegExp | null>();
function safeRe(src: string): RegExp | null {
  if (!reCache.has(src)) {
    try {
      reCache.set(src, new RegExp(src, 'i'));
    } catch {
      reCache.set(src, null);
    }
  }
  return reCache.get(src)!;
}

export function condMatches(c: RuleCond, it: DesktopItem, now = Date.now()): boolean {
  const v = String(c.value ?? '').trim();
  const name = fullName(it);
  const lname = name.toLowerCase();
  const alts = v.toLowerCase().split('|').map((x) => x.trim()).filter(Boolean);
  switch (c.field) {
    case 'ext': {
      const exts = v.toLowerCase().split(/[,，\s]+/).filter(Boolean).map((e) => (e.startsWith('.') ? e : '.' + e));
      const hit = !it.isDir && exts.includes(it.ext);
      return c.op === 'notin' ? !hit : hit;
    }
    case 'name':
      if (!alts.length) return false;
      if (c.op === 'starts') return alts.some((a) => lname.startsWith(a));
      if (c.op === 'ends') return alts.some((a) => lname.endsWith(a));
      if (c.op === 'glob') return alts.some((a) => globToRe(a).test(name));
      if (c.op === 'notcontains') return !alts.some((a) => lname.includes(a));
      return alts.some((a) => lname.includes(a));
    case 'regex': {
      const re = safeRe(v);
      return !!re && re.test(name);
    }
    case 'category': {
      const cats = v.split(/[,，\s|]+/).filter(Boolean);
      const hit = cats.includes(it.category) || cats.includes(CATEGORY_LABEL[it.category]);
      return c.op === 'not' ? !hit : hit;
    }
    case 'modified': {
      const days = Number(v);
      if (!Number.isFinite(days)) return false;
      const age = (now - it.mtime) / DAY;
      return c.op === 'newer' ? age <= days : age > days;
    }
    case 'size': {
      const mb = Number(v);
      if (!Number.isFinite(mb) || it.isDir) return false;
      const size = it.size / 1048576;
      return c.op === 'lt' ? size < mb : size > mb;
    }
    case 'kind':
      if (v === 'folder') return it.isDir;
      if (v === 'shortcut') return ['.lnk', '.url', '.appref-ms', '.desktop'].includes(it.ext);
      if (v === 'file') return !it.isDir;
      return false;
    case 'target': {
      if (!alts.length || !['.lnk', '.url'].includes(it.ext)) return false;
      const tgt = (linkTarget(it.path) || '').toLowerCase();
      if (!tgt) return c.op === 'notcontains';
      if (c.op === 'starts') return alts.some((a) => tgt.startsWith(a));
      if (c.op === 'ends') return alts.some((a) => tgt.endsWith(a));
      if (c.op === 'notcontains') return !alts.some((a) => tgt.includes(a));
      return alts.some((a) => tgt.includes(a));
    }
    case 'weekday': {
      const d = new Date(now).getDay() || 7; // 1 = Monday … 7 = Sunday
      return inRanges(v, d);
    }
    case 'hour':
      return inRanges(v, new Date(now).getHours());
  }
  return false;
}

export function ruleMatches(r: Rule, it: DesktopItem, now = Date.now()): boolean {
  if (!r.enabled || !r.conds?.length || !r.target?.trim()) return false;
  return r.match === 'any' ? r.conds.some((c) => condMatches(c, it, now)) : r.conds.every((c) => condMatches(c, it, now));
}

/** first matching rule (rules are ordered by priority) */
export function firstRule(rules: Rule[], it: DesktopItem): Rule | null {
  const now = Date.now();
  for (const r of rules) if (ruleMatches(r, it, now)) return r;
  return null;
}

export function describeRule(r: Rule): string {
  const parts = r.conds.map((c) => {
    const f = RULE_FIELDS.find((x) => x.field === c.field);
    const op = f?.ops.find((o) => o.op === c.op)?.label ?? c.op;
    const val = c.field === 'category' ? CATEGORY_LABEL[c.value as Category] ?? c.value : c.value;
    return `${f?.label ?? c.field}${op}「${val}」`;
  });
  return `${parts.join(r.match === 'any' ? ' 或 ' : ' 且 ')} › 放入「${r.target}」`;
}

/** Sanitise a rule coming from AI / renderer / import. */
export function cleanRule(x: any, id: string): Rule | null {
  if (!x || typeof x !== 'object') return null;
  const fields = new Set(RULE_FIELDS.map((f) => f.field));
  const conds: RuleCond[] = (Array.isArray(x.conds) ? x.conds : [])
    .filter((c: any) => c && fields.has(c.field))
    .map((c: any) => {
      const f = RULE_FIELDS.find((ff) => ff.field === c.field)!;
      return { field: c.field, op: f.ops.some((o) => o.op === c.op) ? c.op : f.ops[0].op, value: String(c.value ?? '').slice(0, 300) };
    })
    .slice(0, 8);
  const target = String(x.target ?? '').trim().slice(0, 24);
  if (!conds.length || !target) return null;
  return {
    id: typeof x.id === 'string' && x.id ? x.id : id,
    name: String(x.name ?? target).trim().slice(0, 30) || target,
    enabled: x.enabled !== false,
    match: x.match === 'any' ? 'any' : 'all',
    conds,
    target,
    color: typeof x.color === 'string' && /^#[0-9a-f]{6}$/i.test(x.color) ? x.color : undefined,
    icon: typeof x.icon === 'string' && /^ri-[a-z0-9-]+$/.test(x.icon) ? x.icon : undefined,
    source: ['user', 'ai', 'learned', 'default'].includes(x.source) ? x.source : 'user',
  };
}

// ---------------------------------------------------------------- local natural-language rule parser (no AI needed)
const TOPICS: { re: RegExp; conds: RuleCond[]; name: string; icon: string; color: string }[] = [
  { re: /发票|票据|报销|invoice/i, conds: [{ field: 'name', op: 'contains', value: '发票|invoice|报销|收据' }], name: '发票', icon: 'ri-money-cny-circle-line', color: '#e8a92c' },
  { re: /截图|截屏|screenshot/i, conds: [{ field: 'regex', op: 'matches', value: '^(截图|屏幕截图|Screenshot|Snipaste|QQ截图|微信截图|微信图片)' }], name: '截图', icon: 'ri-screenshot-2-line', color: '#14b8a6' },
  { re: /合同|协议|contract/i, conds: [{ field: 'name', op: 'contains', value: '合同|协议|contract' }], name: '合同', icon: 'ri-file-shield-2-line', color: '#4f7cff' },
  { re: /报价|quote|quotation/i, conds: [{ field: 'name', op: 'contains', value: '报价|quote' }], name: '报价', icon: 'ri-price-tag-3-line', color: '#2f9bff' },
  { re: /简历|resume|cv\b/i, conds: [{ field: 'name', op: 'contains', value: '简历|resume|cv' }], name: '简历', icon: 'ri-profile-line', color: '#9b6bff' },
  { re: /安装包|安装程序|installer|setup/i, conds: [{ field: 'ext', op: 'in', value: '.exe,.msi' }], name: '安装包', icon: 'ri-install-line', color: '#f08c2e' },
  { re: /\bpdf\b/i, conds: [{ field: 'ext', op: 'in', value: '.pdf' }], name: 'PDF', icon: 'ri-file-pdf-2-line', color: '#ef5350' },
  { re: /word|docx?\b/i, conds: [{ field: 'ext', op: 'in', value: '.doc,.docx,.wps' }], name: 'Word', icon: 'ri-file-word-2-line', color: '#2f9bff' },
  { re: /excel|表格|xlsx?\b/i, conds: [{ field: 'ext', op: 'in', value: '.xls,.xlsx,.csv,.et' }], name: '表格', icon: 'ri-file-excel-2-line', color: '#3dbb63' },
  { re: /ppt|幻灯片|演示文稿/i, conds: [{ field: 'ext', op: 'in', value: '.ppt,.pptx,.dps' }], name: '演示文稿', icon: 'ri-slideshow-3-line', color: '#f08c2e' },
  { re: /设计稿|psd|sketch|figma/i, conds: [{ field: 'ext', op: 'in', value: '.psd,.ai,.sketch,.fig,.xd' }], name: '设计稿', icon: 'ri-palette-line', color: '#e5579a' },
  { re: /图片|照片|图像|image|photo/i, conds: [{ field: 'category', op: 'is', value: 'image' }], name: '图片', icon: 'ri-image-line', color: '#e5579a' },
  { re: /视频|影片|video/i, conds: [{ field: 'category', op: 'is', value: 'video' }], name: '视频', icon: 'ri-film-line', color: '#ef5350' },
  { re: /音乐|音频|歌曲|audio|music/i, conds: [{ field: 'category', op: 'is', value: 'audio' }], name: '音频', icon: 'ri-music-2-line', color: '#9b6bff' },
  { re: /压缩包|压缩文件|zip|rar|7z/i, conds: [{ field: 'category', op: 'is', value: 'archive' }], name: '压缩包', icon: 'ri-file-zip-line', color: '#f08c2e' },
  { re: /快捷方式|软件|程序|应用/i, conds: [{ field: 'category', op: 'is', value: 'program' }], name: '软件', icon: 'ri-apps-2-line', color: '#2f9bff' },
  { re: /文件夹|目录|folder/i, conds: [{ field: 'kind', op: 'is', value: 'folder' }], name: '文件夹', icon: 'ri-folder-3-line', color: '#e8a92c' },
  { re: /文档|资料|document/i, conds: [{ field: 'category', op: 'is', value: 'doc' }], name: '文档', icon: 'ri-file-text-line', color: '#4f7cff' },
];

/**
 * 「把所有发票放到财务格子」「超过 30 天的安装包放进待清理」「名字里有 周报 的文件放到 工作」
 * Returns null when the sentence cannot be understood locally.
 */
export function parseRuleLocal(text: string, id: string): Rule | null {
  const t = text.trim().replace(/[。！!]$/, '');
  if (!t) return null;
  // target box
  let target = '';
  const tm =
    t.match(/(?:放到|放进|放入|移到|移动到|归到|归入|归类到|收到|收进|丢到|扔到|整理到|都去)\s*[「『"“]?([^「」『』"”，。,\s]{1,16}?)[」』"”]?\s*(?:格子|分组|分区|盒子|里|中|这个格子)?$/) ||
    t.match(/[「『"“]([^」』"”]{1,16})[」』"”]\s*(?:格子)?\s*$/);
  if (tm) target = tm[1].replace(/(格子|分组|分区)$/, '').trim();
  const subject = tm ? t.slice(0, tm.index) : t;
  const conds: RuleCond[] = [];
  let topicName = '';
  let icon = 'ri-inbox-2-line';
  let color = '#4f7cff';
  // explicit "名字里有 X / 文件名包含 X / 带 X 的"
  const nm = subject.match(/(?:名字|名称|文件名|标题)\s*(?:里|中)?\s*(?:有|包含|带|含有|含)\s*[「『"“]?([^」』"”的，,\s]{1,20})[」』"”]?/) || subject.match(/(?:带|含|包含)\s*[「『"“]([^」』"”]{1,20})[」』"”]/);
  if (nm) conds.push({ field: 'name', op: 'contains', value: nm[1] });
  const ext = subject.match(/\.([a-z0-9]{1,6})\b/gi);
  if (ext && !nm) conds.push({ field: 'ext', op: 'in', value: ext.join(',').toLowerCase() });
  if (!conds.length) {
    for (const tp of TOPICS) {
      if (tp.re.test(subject)) {
        conds.push(...tp.conds);
        topicName = tp.name;
        icon = tp.icon;
        color = tp.color;
        break;
      }
    }
  }
  const days = subject.match(/(?:超过|大于|多于|早于|老于)\s*(\d+)\s*(天|周|个月|月)/);
  if (days) conds.push({ field: 'modified', op: 'older', value: String(Number(days[1]) * (days[2] === '周' ? 7 : days[2].includes('月') ? 30 : 1)) });
  const recent = subject.match(/(?:最近|近)\s*(\d+)\s*(天|周)/);
  if (recent) conds.push({ field: 'modified', op: 'newer', value: String(Number(recent[1]) * (recent[2] === '周' ? 7 : 1)) });
  if (/今天/.test(subject)) conds.push({ field: 'modified', op: 'newer', value: '1' });
  const big = subject.match(/(?:大于|超过|大过)\s*(\d+(?:\.\d+)?)\s*(m|mb|兆|g|gb)/i);
  if (big) conds.push({ field: 'size', op: 'gt', value: String(Number(big[1]) * (/g/i.test(big[2]) ? 1024 : 1)) });
  if (!conds.length) return null;
  if (!target) target = topicName || '新格子';
  return { id, name: `${topicName || target}自动归类`, enabled: true, match: 'all', conds, target: target.slice(0, 16), color, icon, source: 'user' };
}
