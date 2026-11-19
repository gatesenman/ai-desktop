import { $, api, esc, fmtTime, glyphHTML, highlight, icon, iconFor, initTheme } from './common';
import type { CmdAction, SearchResult } from '../shared/types';

initTheme();
const $q = $<HTMLInputElement>('#q');
const $list = $('#list');
const $status = $('#status');
const $ai = $<HTMLButtonElement>('#ai');
const $panel = $('.panel');
const $clear = $('#clear');

type Row = { kind: 'cmd' } | { kind: 'file'; r: SearchResult } | { kind: 'content'; r: SearchResult & { snippet?: string } };
let results: SearchResult[] = [];
let content: (SearchResult & { snippet?: string })[] = [];
let isCommand = false;
let rows: Row[] = [];
let active = 0;
let seq = 0;
let aiOn = false;
let mode: 'recent' | 'quick' | 'nl' | 'ai' = 'recent';
let plan: { actions: CmdAction[]; reply: string; via: string } | null = null;
let planBusy = false;

function sectionLabel(): string {
  switch (mode) {
    case 'recent':
      return `${icon('ri-time-line')} 最近修改`;
    case 'nl':
      return `${icon('ri-lightbulb-flash-line')} 本地语义匹配`;
    case 'ai':
      return `${icon('ri-sparkling-2-line')} AI 推荐`;
    default:
      return `${icon('ri-focus-3-line')} 最佳匹配`;
  }
}

const ACTION_ICON: Record<string, string> = {
  organize: 'ri-magic-line', 'ai-organize': 'ri-sparkling-2-line', 'create-box': 'ri-add-box-line', move: 'ri-drag-move-2-line', 'create-rule': 'ri-filter-3-line',
  hide: 'ri-eye-off-line', show: 'ri-eye-line', page: 'ri-pages-line', 'snapshot-save': 'ri-camera-lens-line', 'snapshot-restore': 'ri-history-line',
  cleanup: 'ri-brush-3-line', rename: 'ri-edit-2-line', briefing: 'ri-newspaper-line', summarize: 'ri-file-text-line', search: 'ri-search-line', settings: 'ri-settings-3-line', portal: 'ri-folder-open-line', undo: 'ri-arrow-go-back-line',
};

function fileRow(r: SearchResult & { snippet?: string }, i: number, isContent: boolean): HTMLElement {
  const el = document.createElement('div');
  el.className = 'res' + (i === active ? ' active' : '');
  const dir = r.path.replace(/[\\/][^\\/]*$/, '');
  const ext = r.isDir ? '' : r.ext && !r.name.endsWith(r.ext) ? `<span class="ext">${esc(r.ext)}</span>` : '';
  const chip = r.reason ? `<span class="chip${r.reason.startsWith('AI') ? ' ai' : isContent ? ' ct' : ''}">${esc(r.reason.replace(/^AI：/, ''))}</span>` : '';
  const sub = isContent && r.snippet ? `<span class="snip">${esc(r.snippet)}</span>` : `<span class="path">${esc(dir)}</span>`;
  el.innerHTML =
    `<div class="ic">${glyphHTML(r)}</div>` +
    `<div class="meta"><div class="nm">${highlight(r.name, r.hl)}${ext}</div><div class="sub">${chip}${sub}</div></div>` +
    `<div class="side"><span class="time">${fmtTime(r.mtime)}</span><span class="enter">${icon('ri-corner-down-left-line')}</span></div>`;
  iconFor(r.path).then((u) => {
    if (u) el.querySelector('.ic')!.innerHTML = `<img src="${u}" alt="">`;
  });
  el.addEventListener('click', (e) => api().invoke('search:open', r.path, e.ctrlKey));
  return el;
}

function cmdRow(i: number): HTMLElement {
  const el = document.createElement('div');
  el.className = 'res cmd' + (i === active ? ' active' : '') + (plan ? ' planned' : '');
  const q = $q.value.trim().replace(/^[>》]\s*/, '');
  if (!plan) {
    el.innerHTML =
      `<div class="ic"><span class="cmdic">${icon(planBusy ? 'ri-loader-4-line' : 'ri-sparkling-2-fill', planBusy ? 'spin' : '')}</span></div>` +
      `<div class="meta"><div class="nm">执行命令：${esc(q)}</div><div class="sub"><span class="chip ai">${aiOn ? 'AI 命令' : '本地命令'}</span><span class="path">${planBusy ? '正在理解你的意思…' : '按 Enter 生成执行计划，确认后才会执行'}</span></div></div>` +
      `<div class="side"><span class="enter">${icon('ri-corner-down-left-line')}</span></div>`;
    el.addEventListener('click', makePlan);
  } else {
    el.innerHTML =
      `<div class="plan"><div class="ph2">${icon('ri-sparkling-2-fill')}<b>执行计划</b><span class="via">${plan.via === 'ai' ? 'AI 解析' : '本地解析'}</span>${plan.reply ? `<span class="reply">${esc(plan.reply)}</span>` : ''}</div>` +
      plan.actions.map((a, k) => `<div class="step"><span class="n">${k + 1}</span>${icon(ACTION_ICON[a.type] ?? 'ri-play-line')}<span>${esc(a.label ?? a.type)}</span></div>`).join('') +
      `<div class="pact"><button class="btn primary" id="runPlan">${icon('ri-play-fill')}执行<kbd>Enter</kbd></button><button class="btn" id="cancelPlan">取消<kbd>Esc</kbd></button><small>整理类操作可撤销；不会删除文件</small></div></div>`;
    el.querySelector('#runPlan')!.addEventListener('click', runPlan);
    el.querySelector('#cancelPlan')!.addEventListener('click', () => ((plan = null), render()));
  }
  return el;
}

function render() {
  $list.innerHTML = '';
  $ai.querySelector('span')!.textContent = isCommand ? (plan ? '执行' : '生成计划') : 'AI 查找';
  $ai.querySelector('i')!.className = isCommand ? 'ri-terminal-box-fill' : 'ri-sparkling-2-fill';
  rows = [...(isCommand ? [{ kind: 'cmd' } as Row] : []), ...results.map((r) => ({ kind: 'file', r }) as Row), ...content.map((r) => ({ kind: 'content', r }) as Row)];
  if (active >= rows.length) active = Math.max(0, rows.length - 1);
  if (!rows.length) {
    const q = $q.value.trim();
    $list.innerHTML =
      `<div class="empty-res">${icon(q ? 'ri-folder-warning-line' : 'ri-inbox-2-line')}<b>${q ? '没有找到匹配的文件' : '桌面上还没有文件'}</b><small>${
        q ? '试试拼音首字母（如 bj = 报价），按 Tab 用 AI 查找，或以 &gt; 开头输入命令' : '把文件放到桌面后会自动出现在这里'
      }</small></div>`;
    fit();
    return;
  }
  let i = 0;
  if (isCommand) {
    const head = document.createElement('div');
    head.className = 'sec';
    head.innerHTML = `${icon('ri-terminal-box-line')} 命令`;
    $list.appendChild(head);
    $list.appendChild(cmdRow(i++));
  }
  if (results.length) {
    const head = document.createElement('div');
    head.className = 'sec';
    head.innerHTML = `${sectionLabel()}<span>${results.length}</span>`;
    $list.appendChild(head);
    results.forEach((r) => $list.appendChild(fileRow(r, i++, false)));
  }
  if (content.length) {
    const head = document.createElement('div');
    head.className = 'sec';
    head.innerHTML = `${icon('ri-file-search-line')} 内容匹配<span>${content.length}</span>`;
    $list.appendChild(head);
    content.forEach((r) => $list.appendChild(fileRow(r, i++, true)));
  }
  $list.querySelectorAll<HTMLElement>('.res').forEach((el, j) =>
    el.addEventListener('mousemove', () => {
      if (active === j) return;
      active = j;
      $list.querySelectorAll('.res').forEach((x, k) => x.classList.toggle('active', k === j));
    }),
  );
  fit();
}

async function makePlan() {
  const q = $q.value.trim();
  if (!q || planBusy) return;
  planBusy = true;
  render();
  setStatus(`<span class="dots"><i></i><i></i><i></i></span>${aiOn ? 'AI 正在把你的话转换成操作…' : '正在本地解析命令…'}`);
  try {
    plan = (await api().invoke('cmd:plan', q)) as typeof plan;
    if (plan && plan.actions.length === 1 && plan.actions[0].type === 'search') {
      const sq = plan.actions[0].query ?? q;
      plan = null;
      isCommand = false;
      $q.value = sq.replace(/^[>》]\s*/, '');
      setStatus(`${icon('ri-information-line')} 没有识别出命令，已改为搜索`);
      planBusy = false;
      return runQuick(true);
    }
    setStatus(plan?.reply && plan.via === 'local' ? `${icon('ri-information-line')} ${esc(plan.reply)}` : '');
  } finally {
    planBusy = false;
    active = 0;
    render();
  }
}

async function runPlan() {
  if (!plan) return;
  const r: any = await api().invoke('cmd:run', plan.actions);
  plan = null;
  if (r?.search) {
    $q.value = r.search;
    return runQuick(true);
  }
  setStatus(`${icon('ri-checkbox-circle-line')} ${esc((r?.messages ?? []).join('；') || '已执行')}`);
  api().invoke('search:hide');
}

// Spotlight-style: the popup grows/shrinks with its results
function fit() {
  requestAnimationFrame(() => {
    const content = [...$list.children].reduce((h, c) => h + (c as HTMLElement).offsetHeight, 0) + 14;
    const listH = Math.min(380, Math.max(150, content));
    const panelH = 60 + 2 + listH + 38 + 2;
    api().invoke('search:resize', panelH + 24 + 40);
  });
}

function setStatus(html: string) {
  $status.innerHTML = html;
}

async function runQuick(keepStatus = false) {
  const my = ++seq;
  const q = $q.value;
  $clear.classList.toggle('show', !!q);
  const r: any = await api().invoke('search:query', q);
  if (my !== seq) return;
  results = q.trim().startsWith('>') ? [] : r.results;
  content = r.content ?? [];
  if (!plan) isCommand = !!r.command;
  active = 0;
  mode = q.trim() ? r.mode : 'recent';
  if (!keepStatus) setStatus('');
  render();
}

async function runAI() {
  const q = $q.value.trim();
  if (!q) {
    $q.focus();
    return;
  }
  if (isCommand) return plan ? runPlan() : makePlan();
  const my = ++seq;
  mode = 'ai';
  $panel.classList.add('thinking');
  $ai.disabled = true;
  setStatus(`<span class="dots"><i></i><i></i><i></i></span>${aiOn ? 'AI 正在理解你的描述…' : '正在本地解析描述…'}`);
  try {
    const r: any = await api().invoke('search:ai', q);
    if (my !== seq) return;
    results = r.results;
    content = [];
    active = 0;
    if (!aiOn || r.error) mode = 'nl';
    setStatus(
      r.error
        ? `<span class="warn">${icon('ri-error-warning-line')} ${esc(r.note ?? '')}：${esc(r.error.slice(0, 80))}</span>`
        : r.note
          ? `${icon('ri-information-line')} ${esc(r.note)}`
          : '',
    );
    render();
  } finally {
    $panel.classList.remove('thinking');
    $ai.disabled = false;
  }
}

let t: number | undefined;
$q.addEventListener('input', () => {
  plan = null;
  clearTimeout(t);
  t = window.setTimeout(() => runQuick(), 70);
});
$clear.addEventListener('click', () => {
  $q.value = '';
  $q.focus();
  runQuick();
});
$q.addEventListener('keydown', (e) => {
  const scroll = () => $list.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
  if (e.key === 'ArrowDown') {
    active = (active + 1) % Math.max(1, rows.length);
    render();
    scroll();
    e.preventDefault();
  } else if (e.key === 'ArrowUp') {
    active = (active - 1 + rows.length) % Math.max(1, rows.length);
    render();
    scroll();
    e.preventDefault();
  } else if (e.key === 'Enter') {
    const row = rows[active];
    if (row?.kind === 'cmd') plan ? runPlan() : makePlan();
    else if (row) api().invoke('search:open', row.r.path, e.ctrlKey);
  } else if (e.key === 'Tab') {
    e.preventDefault();
    runAI();
  } else if (e.key === 'Escape') {
    if (plan) {
      plan = null;
      render();
    } else if ($q.value) {
      $q.value = '';
      runQuick();
    } else api().invoke('search:hide');
  }
});
$ai.addEventListener('click', runAI);

api().on('search:focus', (p: { initial: string; ai: boolean }) => {
  aiOn = p.ai;
  $ai.title = aiOn ? 'AI 自然语言查找（Tab）' : '未配置 AI：使用本地语义解析（Tab）';
  $ai.classList.toggle('off', !aiOn);
  $q.value = p.initial;
  $panel.classList.remove('show');
  void $panel.offsetWidth;
  $panel.classList.add('show');
  $q.focus();
  if (!p.initial) $q.select();
  plan = null;
  runQuick().then(() => p.initial && (p as any).plan && isCommand && makePlan());
});
runQuick();
