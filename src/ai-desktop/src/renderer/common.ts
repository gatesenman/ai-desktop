import type { Api } from '../preload/preload';
import { CATEGORY_COLOR, CATEGORY_ICON, DesktopItem, ThemePayload } from '../shared/types';

declare global {
  interface Window {
    api: Api;
  }
}

export const api = (): Api => window.api;
export const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T;
export const $$ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => [...root.querySelectorAll(sel)] as T[];

export function applyTheme(t: Partial<ThemePayload>) {
  const root = document.documentElement;
  if (t.theme) root.dataset.theme = t.theme;
  if (t.opacity !== undefined) root.style.setProperty('--box-alpha', String(t.opacity));
  if (t.iconSize !== undefined) root.style.setProperty('--icon', t.iconSize + 'px');
  root.classList.toggle('acrylic', !!t.acrylic);
  if (t.chameleon !== undefined) root.classList.toggle('chameleon', !!t.chameleon);
  root.dataset.platform = api().platform;
}

export function initTheme() {
  const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  applyTheme({ theme: dark ? 'dark' : 'light' });
  api().on('theme', applyTheme);
  api().invoke('theme:get').then((t: any) => t && applyTheme(t));
}

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export const icon = (cls: string, extra = '') => `<i class="${cls}${extra ? ' ' + extra : ''}" aria-hidden="true"></i>`;

/** Highlight matched character indices with <mark>. */
export function highlight(text: string, hl?: number[]): string {
  if (!hl?.length) return esc(text);
  const set = new Set(hl);
  let out = '';
  let open = false;
  for (let i = 0; i < text.length; i++) {
    const m = set.has(i);
    if (m && !open) (out += '<mark>'), (open = true);
    if (!m && open) (out += '</mark>'), (open = false);
    out += esc(text[i]);
  }
  return out + (open ? '</mark>' : '');
}

// ---------------------------------------------------------------- file glyphs (icon font fallback / Linux)
const EXT_GLYPH: Record<string, [string, string]> = {
  '.pdf': ['ri-file-pdf-2-line', '#e5484d'],
  '.doc': ['ri-file-word-2-line', '#2b6be6'],
  '.docx': ['ri-file-word-2-line', '#2b6be6'],
  '.wps': ['ri-file-word-2-line', '#2b6be6'],
  '.xls': ['ri-file-excel-2-line', '#1f9d55'],
  '.xlsx': ['ri-file-excel-2-line', '#1f9d55'],
  '.csv': ['ri-file-excel-2-line', '#1f9d55'],
  '.et': ['ri-file-excel-2-line', '#1f9d55'],
  '.ppt': ['ri-file-ppt-2-line', '#e8702a'],
  '.pptx': ['ri-file-ppt-2-line', '#e8702a'],
  '.md': ['ri-markdown-line', '#7b8798'],
  '.txt': ['ri-file-text-line', '#7b8798'],
  '.json': ['ri-file-code-line', '#c49a1a'],
  '.html': ['ri-file-code-line', '#e8702a'],
  '.exe': ['ri-window-2-line', '#2f9bff'],
  '.msi': ['ri-window-2-line', '#2f9bff'],
  '.bat': ['ri-terminal-box-line', '#5a6578'],
  '.cmd': ['ri-terminal-box-line', '#5a6578'],
  '.ps1': ['ri-terminal-box-line', '#3a6fd8'],
  '.url': ['ri-links-line', '#2f9bff'],
};
const APP_GLYPH: [RegExp, string, string][] = [
  [/chrome|谷歌浏览器/i, 'ri-chrome-fill', '#4285f4'],
  [/edge/i, 'ri-edge-fill', '#1f8fe5'],
  [/微信|wechat|weixin/i, 'ri-wechat-fill', '#07c160'],
  [/^qq|腾讯qq/i, 'ri-qq-fill', '#12b7f5'],
  [/vs ?code|visual studio code/i, 'ri-code-box-fill', '#1f8ad2'],
  [/steam/i, 'ri-steam-fill', '#3d7fb5'],
  [/钉钉|dingtalk/i, 'ri-dingding-fill', '#3296fa'],
  [/bilibili|哔哩/i, 'ri-bilibili-fill', '#fb7299'],
  [/网易云|cloudmusic/i, 'ri-netease-cloud-music-fill', '#e60026'],
  [/firefox|火狐/i, 'ri-firefox-fill', '#ff7139'],
  [/telegram/i, 'ri-telegram-fill', '#26a5e4'],
];

export function glyphFor(it: DesktopItem): { icon: string; color: string; badge: string } {
  if (it.isDir) return { icon: 'ri-folder-3-fill', color: '#e8a92c', badge: '' };
  if (it.category === 'program') {
    for (const [re, ic, col] of APP_GLYPH) if (re.test(it.name)) return { icon: ic, color: col, badge: '' };
  }
  const e = EXT_GLYPH[it.ext];
  if (e) return { icon: e[0], color: e[1], badge: it.category === 'doc' ? it.ext.slice(1).toUpperCase().slice(0, 4) : '' };
  const badge = it.ext && it.category !== 'program' ? it.ext.slice(1).toUpperCase().slice(0, 4) : '';
  return { icon: CATEGORY_ICON[it.category], color: CATEGORY_COLOR[it.category], badge };
}

export function glyphHTML(it: DesktopItem): string {
  const g = glyphFor(it);
  return `<span class="glyph${it.isDir ? ' folder' : ''}" style="--g:${g.color}">${icon(g.icon)}${g.badge ? `<b>${esc(g.badge)}</b>` : ''}</span>`;
}

const iconMemo = new Map<string, Promise<string | null>>();
export function iconFor(p: string): Promise<string | null> {
  if (!iconMemo.has(p)) iconMemo.set(p, api().invoke('icon:get', p) as Promise<string | null>);
  return iconMemo.get(p)!;
}

export function fmtTime(ms: number): string {
  const d = new Date(ms);
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const days = Math.floor((new Date(now.toDateString()).getTime() - new Date(d.toDateString()).getTime()) / 86400000);
  if (days === 0) return `今天 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (days === 1) return `昨天 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (days < 7 && days > 0) return `${days} 天前`;
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function fmtSize(n: number): string {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 ** 3) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return (n / 1024 ** 3).toFixed(2) + ' GB';
}

// ---------------------------------------------------------------- markdown (safe: escape first)
function inline(s: string): string {
  return esc(s)
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<span class="link" title="$2">$1</span>');
}

export function md(src: string, streaming = false): string {
  const lines = src.replace(/\r/g, '').split('\n');
  const out: string[] = [];
  let i = 0;
  let list: 'ul' | 'ol' | null = null;
  const closeList = () => {
    if (list) out.push(`</${list}>`);
    list = null;
  };
  let para: string[] = [];
  const flushPara = () => {
    if (para.length) out.push(`<p>${para.map(inline).join('<br>')}</p>`);
    para = [];
  };
  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(/^\s*```\s*([\w+-]*)/);
    if (fence) {
      flushPara();
      closeList();
      const lang = fence[1] || 'text';
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i++]);
      const closed = i < lines.length;
      i++;
      out.push(
        `<div class="code"><div class="code-h"><span>${esc(lang)}</span>${closed || !streaming ? `<button class="copy" title="复制代码">${icon('ri-file-copy-line')}<span>复制</span></button>` : ''}</div><pre><code>${esc(code.join('\n'))}</code></pre></div>`,
      );
      continue;
    }
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^(#{1,4})\s+(.+)/))) {
      flushPara();
      closeList();
      out.push(`<h${Math.min(6, m[1].length + 2)}>${inline(m[2])}</h${Math.min(6, m[1].length + 2)}>`);
    } else if ((m = line.match(/^\s*[-*+]\s+(.+)/))) {
      flushPara();
      if (list !== 'ul') (closeList(), out.push('<ul>'), (list = 'ul'));
      out.push(`<li>${inline(m[1])}</li>`);
    } else if ((m = line.match(/^\s*\d+[.)、]\s+(.+)/))) {
      flushPara();
      if (list !== 'ol') (closeList(), out.push('<ol>'), (list = 'ol'));
      out.push(`<li>${inline(m[1])}</li>`);
    } else if ((m = line.match(/^>\s?(.*)/))) {
      flushPara();
      closeList();
      out.push(`<blockquote>${inline(m[1])}</blockquote>`);
    } else if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      flushPara();
      closeList();
      out.push('<hr>');
    } else if (!line.trim()) {
      flushPara();
      closeList();
    } else {
      closeList();
      para.push(line);
    }
    i++;
  }
  flushPara();
  closeList();
  return out.join('');
}
