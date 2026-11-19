import { $, $$, api, esc, fmtSize, fmtTime, glyphHTML, icon, iconFor, initTheme, md } from './common';
import type { CleanupItem, DesktopItem, RenameProposal } from '../shared/types';

initTheme();
let configured = false;
let messy: DesktopItem[] = [];

// ---------------------------------------------------------------- navigation
const loaded = new Set<string>();
function show(id: string) {
  $$('.nav-item[data-sec]').forEach((n) => n.classList.toggle('active', n.dataset.sec === id));
  $$('.page').forEach((p) => p.classList.toggle('active', p.id === 'sec-' + id));
  $('.content').scrollTop = 0;
  if (!loaded.has(id)) {
    loaded.add(id);
    if (id === 'organize') loadOrganize();
    if (id === 'cleanup') loadCleanup();
    if (id === 'briefing') loadBriefing();
    if (id === 'projects') loadProjects();
  }
}
$$('.nav-item[data-sec]').forEach((n) => n.addEventListener('click', () => show(n.dataset.sec!)));
$$('.nav-item[data-go]').forEach((n) => n.addEventListener('click', () => api().invoke('app:action', n.dataset.go)));
$('#wMin').addEventListener('click', () => api().invoke('win:minimize'));
$('#wMax').addEventListener('click', () => api().invoke('win:maximize'));
$('#wClose').addEventListener('click', () => api().invoke('win:close'));

const loading = (text: string) => `<div class="loading"><span class="dots"><i></i><i></i><i></i></span>${esc(text)}</div>`;
const thumb = (it: DesktopItem, el: HTMLElement) => iconFor(it.path).then((u) => u && (el.innerHTML = `<img src="${u}" alt="">`));
const fname = (it: DesktopItem) => it.name + (it.isDir ? '' : it.ext && !it.name.toLowerCase().endsWith(it.ext) ? it.ext : '');

// ---------------------------------------------------------------- organize
interface Group { name: string; icon: string; reason: string; paths: string[]; on: boolean }
let groups: Group[] = [];
let names = new Map<string, DesktopItem>();
async function loadOrganize() {
  $('#oGroups').innerHTML = loading(configured ? 'AI 正在分析桌面上的文件名…' : '正在按规则和类型生成建议…');
  $('#oBar').classList.remove('show');
  const r: any = await api().invoke('hub:organizePlan');
  names = new Map((r.items as DesktopItem[]).map((i) => [i.path, i]));
  groups = r.groups.map((g: any) => ({ ...g, on: true }));
  $('#oVia').className = 'pill ' + (r.via === 'ai' ? 'ai' : '');
  $('#oVia').innerHTML = `<i class="dot"></i>${r.via === 'ai' ? 'AI 生成' : '本地规则'}`;
  if (r.note) $('#oNote').innerHTML = `${icon('ri-information-line')} ${esc(r.note)}。勾选想要的分组，可直接修改名称；应用后只调整格子分组，不移动文件，可撤销。`;
  renderGroups();
}
function renderGroups() {
  $('#oGroups').innerHTML = groups
    .map(
      (g, i) => `<div class="ocard${g.on ? '' : ' off'}" data-i="${i}">
      <div class="oh"><label class="check"><input type="checkbox"${g.on ? ' checked' : ''}></label><span class="oic">${icon(g.icon)}</span><input class="oname" value="${esc(g.name)}" maxlength="12" spellcheck="false"><span class="ocount">${g.paths.length}</span></div>
      ${g.reason ? `<div class="oreason">${icon('ri-lightbulb-flash-line')}${esc(g.reason)}</div>` : ''}
      <div class="ofiles">${g.paths
        .slice(0, 8)
        .map((p) => {
          const it = names.get(p);
          return it ? `<span class="ofile" title="${esc(fname(it))}"><span class="ic" data-p="${esc(p)}">${glyphHTML(it)}</span><span class="t">${esc(fname(it))}</span></span>` : '';
        })
        .join('')}${g.paths.length > 8 ? `<span class="more">+${g.paths.length - 8}</span>` : ''}</div></div>`,
    )
    .join('');
  $$('.ocard').forEach((c) => {
    const g = groups[Number(c.dataset.i)];
    c.querySelector('input[type=checkbox]')!.addEventListener('change', (e) => ((g.on = (e.target as HTMLInputElement).checked), c.classList.toggle('off', !g.on), sum()));
    c.querySelector('.oname')!.addEventListener('input', (e) => (g.name = (e.target as HTMLInputElement).value));
    c.querySelectorAll<HTMLElement>('.ofile .ic').forEach((el) => {
      const it = names.get(el.dataset.p!);
      if (it) thumb(it, el);
    });
  });
  sum();
}
function sum() {
  const on = groups.filter((g) => g.on);
  $('#oSum').textContent = `已选 ${on.length} 组 · ${on.reduce((a, g) => a + g.paths.length, 0)} 个文件`;
  $('#oBar').classList.toggle('show', groups.length > 0);
}
$('#oRegen').addEventListener('click', loadOrganize);
$('#oApply').addEventListener('click', async () => {
  const n = await api().invoke('hub:organizeApply', groups.filter((g) => g.on && g.name.trim()));
  $('#oSum').innerHTML = `${icon('ri-checkbox-circle-fill')} 已应用 ${n} 个分组，可在托盘菜单或格子右键「撤销」`;
});

// ---------------------------------------------------------------- cleanup
const GROUPS: Record<CleanupItem['group'], [string, string, string]> = {
  duplicate: ['重复文件', 'ri-file-copy-2-line', '#ef5350'],
  installer: ['已用过的安装包', 'ri-install-line', '#f08c2e'],
  large: ['大文件', 'ri-hard-drive-2-line', '#9b6bff'],
  stale: ['长期未动', 'ri-time-line', '#7b8798'],
  temp: ['临时文件', 'ri-file-damage-line', '#e8a92c'],
  empty: ['空文件夹', 'ri-folder-line', '#14b8a6'],
};
let cleanup: CleanupItem[] = [];
const picked = new Set<string>();
async function loadCleanup() {
  $('#cList').innerHTML = loading('正在扫描桌面（按内容比对重复文件）…');
  $('#cStats').innerHTML = '';
  $('#cBar').classList.remove('show');
  const r: any = await api().invoke('hub:cleanupScan');
  cleanup = r.items;
  picked.clear();
  cleanup.filter((c) => ['duplicate', 'temp', 'installer'].includes(c.group)).forEach((c) => picked.add(c.path));
  const count = (g: string) => cleanup.filter((c) => c.group === g).length;
  $('#cStats').innerHTML =
    `<div class="cbig"><b>${fmtSize(r.bytes)}</b><span>可释放空间</span><small>扫描了 ${r.scanned} 个桌面项目，发现 ${cleanup.length} 个建议项</small></div>` +
    (Object.keys(GROUPS) as CleanupItem['group'][])
      .filter((g) => g !== 'empty' && g !== 'temp')
      .map((g) => `<div class="cstat" style="--g:${GROUPS[g][2]}"><span class="fi sm">${icon(GROUPS[g][1])}</span><b>${count(g)}</b><span>${GROUPS[g][0]}</span></div>`)
      .join('');
  renderCleanup();
}
function renderCleanup() {
  if (!cleanup.length) {
    $('#cList').innerHTML = `<div class="empty-card big">${icon('ri-checkbox-circle-line')}<b>桌面很干净</b><small>没有发现重复、过期或大文件</small></div>`;
    $('#cBar').classList.remove('show');
    return;
  }
  $('#cList').innerHTML = (Object.keys(GROUPS) as CleanupItem['group'][])
    .filter((g) => cleanup.some((c) => c.group === g))
    .map((g) => {
      const list = cleanup.filter((c) => c.group === g);
      const allOn = list.every((c) => picked.has(c.path));
      return `<div class="cgroup"><div class="cgh" style="--g:${GROUPS[g][2]}"><label class="check"><input type="checkbox" data-g="${g}"${allOn ? ' checked' : ''}></label><span class="fi sm">${icon(GROUPS[g][1])}</span><b>${GROUPS[g][0]}</b><span class="muted small">${list.length} 项 · ${fmtSize(list.reduce((a, c) => a + c.size, 0))}</span></div>
      ${list
        .map(
          (c) => `<div class="crow${picked.has(c.path) ? ' on' : ''}" data-p="${esc(c.path)}"><label class="check"><input type="checkbox"${picked.has(c.path) ? ' checked' : ''}></label><span class="ic">${glyphHTML(c)}</span>
          <div class="cm"><b>${esc(fname(c))}</b><small>${esc(c.reason)}</small></div><span class="muted small">${c.isDir ? '' : fmtSize(c.size)}</span><span class="muted small t">${fmtTime(c.mtime)}</span><button class="tb rv" title="打开所在位置">${icon('ri-folder-open-line')}</button></div>`,
        )
        .join('')}</div>`;
    })
    .join('');
  $$('.crow').forEach((row) => {
    const p = row.dataset.p!;
    const it = cleanup.find((c) => c.path === p)!;
    thumb(it, row.querySelector('.ic')!);
    row.querySelector('input')!.addEventListener('change', (e) => {
      (e.target as HTMLInputElement).checked ? picked.add(p) : picked.delete(p);
      row.classList.toggle('on', picked.has(p));
      csum();
    });
    row.querySelector('.rv')!.addEventListener('click', () => api().invoke('hub:reveal', p));
  });
  $$('.cgh input').forEach((cb) =>
    cb.addEventListener('change', (e) => {
      const on = (e.target as HTMLInputElement).checked;
      cleanup.filter((c) => c.group === (cb as HTMLElement).dataset.g).forEach((c) => (on ? picked.add(c.path) : picked.delete(c.path)));
      renderCleanup();
    }),
  );
  csum();
}
function csum() {
  const sel = cleanup.filter((c) => picked.has(c.path));
  $('#cSum').textContent = `已选 ${sel.length} 项 · ${fmtSize(sel.reduce((a, c) => a + c.size, 0))}`;
  $('#cBar').classList.add('show');
  $$('#cBar .btn').forEach((b) => ((b as HTMLButtonElement).disabled = !sel.length));
}
async function cleanupAction(action: 'trash' | 'archive' | 'box') {
  const r: any = await api().invoke('hub:cleanupApply', action, [...picked]);
  if (r?.ok && action !== 'box') loadCleanup();
}
$('#cScan').addEventListener('click', loadCleanup);
$('#cBox').addEventListener('click', () => cleanupAction('box'));
$('#cArchive').addEventListener('click', () => cleanupAction('archive'));
$('#cTrash').addEventListener('click', () => cleanupAction('trash'));

// ---------------------------------------------------------------- rename
let rFiles: DesktopItem[] = [];
let proposals: (RenameProposal & { on: boolean })[] = [];
let rStyle: 'smart' | 'date' | 'tidy' = 'smart';
function setFiles(list: DesktopItem[]) {
  rFiles = list;
  proposals = [];
  $('#rCount').textContent = list.length ? `已选择 ${list.length} 个文件` : '未选择文件';
  $('#rPickHint').textContent = list.length ? list.slice(0, 4).map(fname).join('、') + (list.length > 4 ? ' 等' : '') : '从桌面选择，或一键挑出命名混乱的文件（副本、(1)、IMG_、微信图片…）';
  renderProposals();
}
$$('#rStyle button').forEach((b) =>
  b.addEventListener('click', () => {
    rStyle = b.dataset.v as typeof rStyle;
    $$('#rStyle button').forEach((x) => x.classList.toggle('active', x === b));
  }),
);
$('#rMessy').addEventListener('click', () => setFiles(messy));
$('#rPick').addEventListener('click', async () => {
  const list = (await api().invoke('hub:pickFiles')) as DesktopItem[];
  if (list.length) setFiles(list);
});
async function genRename() {
  if (!rFiles.length) {
    $('#rNote').textContent = '请先选择文件';
    return;
  }
  $('#rTable').innerHTML = loading(rStyle === 'smart' && configured ? 'AI 正在为文件起名…' : '正在生成…');
  const r: any = await api().invoke('hub:renamePlan', rFiles.map((f) => f.path), { style: rStyle, useContent: $<HTMLInputElement>('#rContent').checked, hint: $<HTMLInputElement>('#rHint').value.trim() });
  proposals = r.proposals.map((p: RenameProposal) => ({ ...p, on: p.to !== p.from }));
  $('#rNote').innerHTML = `${r.via === 'ai' ? icon('ri-sparkling-2-line') + ' AI 生成' : icon('ri-cpu-line') + ' 本地生成'}${r.note ? ' · ' + esc(r.note) : ''}`;
  renderProposals();
}
function renderProposals() {
  if (!proposals.length) {
    $('#rTable').innerHTML = '';
    $('#rBar').classList.remove('show');
    return;
  }
  $('#rTable').innerHTML =
    `<div class="rth"><span></span><span>原文件名</span><span></span><span>新文件名</span><span>理由</span></div>` +
    proposals
      .map(
        (p, i) => `<div class="rtr${p.on ? '' : ' off'}${p.to === p.from ? ' same' : ''}" data-i="${i}"><label class="check"><input type="checkbox"${p.on ? ' checked' : ''}></label>
        <span class="from" title="${esc(p.from)}">${esc(p.from)}</span>${icon('ri-arrow-right-line', 'arrow')}<input class="field to" value="${esc(p.to)}" spellcheck="false"><span class="why">${esc(p.reason ?? '')}</span></div>`,
      )
      .join('');
  $$('.rtr').forEach((row) => {
    const p = proposals[Number(row.dataset.i)];
    row.querySelector('input[type=checkbox]')!.addEventListener('change', (e) => ((p.on = (e.target as HTMLInputElement).checked), row.classList.toggle('off', !p.on), rsum()));
    row.querySelector('.to')!.addEventListener('input', (e) => (p.to = (e.target as HTMLInputElement).value));
  });
  rsum();
}
function rsum() {
  const n = proposals.filter((p) => p.on && p.to !== p.from).length;
  $('#rSum').textContent = `将重命名 ${n} 个文件（同名时自动加编号）`;
  $('#rBar').classList.add('show');
}
$('#rGo').addEventListener('click', genRename);
$('#rApply').addEventListener('click', async () => {
  const r: any = await api().invoke('hub:renameApply', proposals.filter((p) => p.on && p.to !== p.from));
  $('#rSum').innerHTML = `${icon('ri-checkbox-circle-fill')} 已重命名 ${r.done.length} 个文件${r.failed.length ? `，${r.failed.length} 个失败` : ''}`;
  proposals = [];
  $('#rTable').innerHTML = '';
});
$('#rUndo').addEventListener('click', async () => {
  const n = await api().invoke('hub:renameUndo');
  $('#rNote').textContent = n ? `已撤销 ${n} 个文件的重命名` : '没有可撤销的重命名';
});

// ---------------------------------------------------------------- briefing
async function loadBriefing() {
  const h = new Date().getHours();
  const hello = h < 6 ? '夜深了' : h < 11 ? '早上好' : h < 13 ? '中午好' : h < 18 ? '下午好' : '晚上好';
  const d = new Date();
  const wk = '日一二三四五六'[d.getDay()];
  $('#bHero').innerHTML = `<div class="hdate">${d.getMonth() + 1}月${d.getDate()}日 · 星期${wk}</div><h1>${hello}，这是你的今日桌面简报</h1><div class="hsum">${loading(configured ? 'AI 正在撰写简报…' : '正在汇总…')}</div>`;
  $('#bBody').innerHTML = '';
  const b: any = await api().invoke('hub:briefing');
  $('#bHero .hsum').innerHTML = `<div class="md">${md(b.markdown)}</div><span class="via">${b.via === 'ai' ? icon('ri-sparkling-2-line') + ' AI 撰写（仅基于文件名与统计）' : icon('ri-cpu-line') + ' 本地生成'}</span>`;
  const gb = (x: number) => fmtSize(x);
  const clutterCls = b.stats.clutter >= 60 ? 'bad' : b.stats.clutter >= 35 ? 'warn' : 'ok';
  $('#bBody').innerHTML =
    `<div class="btiles">
      <div class="btile"><span class="fi sm" style="--g:#2f9bff">${icon('ri-add-circle-line')}</span><b>${b.stats.today}</b><span>今天新增 / 修改</span></div>
      <div class="btile"><span class="fi sm" style="--g:#9b6bff">${icon('ri-calendar-line')}</span><b>${b.stats.week}</b><span>本周</span></div>
      <div class="btile ${clutterCls}"><span class="fi sm" style="--g:${clutterCls === 'bad' ? '#ef5350' : clutterCls === 'warn' ? '#f08c2e' : '#3dbb63'}">${icon('ri-dashboard-3-line')}</span><b>${b.stats.clutter}<small>/100</small></b><span>杂乱指数</span><i class="gauge"><i style="width:${b.stats.clutter}%"></i></i></div>
      <div class="btile"><span class="fi sm" style="--g:#ef5350">${icon('ri-hard-drive-2-line')}</span><b>${gb(b.stats.reclaim)}</b><span>可释放</span></div>
    </div>
    <div class="bcols">
      <div class="card bcard"><div class="bch">${icon('ri-file-list-3-line')}<b>今天的文件</b></div>${
        b.newFiles.length
          ? b.newFiles.map((f: any) => `<button class="bfile" data-p="${esc(f.path)}"><span>${esc(f.name)}</span><small>${fmtTime(f.mtime)}</small></button>`).join('')
          : '<div class="muted small pad">今天还没有新文件</div>'
      }</div>
      <div class="card bcard"><div class="bch">${icon('ri-task-line')}<b>可能的待办</b><span class="muted small">从你的笔记中本地提取</span></div>${
        b.todos.length ? b.todos.map((t: any) => `<div class="btodo">${icon('ri-checkbox-blank-circle-line')}<div><span>${esc(t.text)}</span><small>${esc(t.file)}</small></div></div>`).join('') : '<div class="muted small pad">没有发现待办事项</div>'
      }</div>
    </div>
    <div class="bact"><button class="btn" data-a="organize">${icon('ri-magic-line')}一键整理</button><button class="btn" data-t="organize">${icon('ri-sparkling-2-line')}AI 整理建议</button><button class="btn" data-t="cleanup">${icon('ri-brush-3-line')}清理 ${b.stats.dup + b.stats.stale + b.stats.large} 个建议项</button></div>`;
  $$('.bfile').forEach((el) => el.addEventListener('click', () => api().invoke('item:open', el.dataset.p)));
  $$('.bact [data-t]').forEach((el) => el.addEventListener('click', () => show(el.dataset.t!)));
  $$('.bact [data-a]').forEach((el) => el.addEventListener('click', () => api().invoke('app:action', el.dataset.a)));
}

// ---------------------------------------------------------------- init

// ---------------------------------------------------------------- project spaces
async function loadProjects() {
  const list = $('#pList');
  if (!list) return;
  list.innerHTML = `<div class="empty-card">${icon('ri-loader-4-line')}<b>正在扫描项目线索…</b></div>`;
  const rows: any[] = await api().invoke('hub:projectSpaces');
  if (!rows?.length) {
    list.innerHTML = `<div class="empty-card">${icon('ri-briefcase-4-line')}<b>暂未发现可聚合的项目</b><small>在文件名中多次出现同一客户/项目名，且时间相近时会出现建议</small></div>`;
    $('#pSum').textContent = '';
    $('#pBar').hidden = true;
    return;
  }
  list.innerHTML = rows
    .map(
      (r) => `<div class="ocard proj" data-id="${esc(r.id)}">
      <div class="ohd"><span class="fi" style="--g:#9b6bff">${icon('ri-briefcase-4-line')}</span>
        <input class="oname" value="${esc(r.title)}" spellcheck="false">
        <span class="pill">${r.paths.length} 项</span></div>
      <p class="oreason">${esc(r.reason)}</p>
      <div class="ofiles">${r.paths.slice(0, 8).map((p: string) => `<span class="chip">${esc(p.split(/[/\\]/).pop() || p)}</span>`).join('')}${r.paths.length > 8 ? `<span class="muted small">+${r.paths.length - 8}</span>` : ''}</div>
      <div class="oact"><button class="btn primary apply">${icon('ri-check-line')}创建项目格子</button></div>
    </div>`,
    )
    .join('');
  list.querySelectorAll('.ocard').forEach((card, i) => {
    const r = rows[i];
    card.querySelector('.apply')?.addEventListener('click', async () => {
      const title = (card.querySelector('.oname') as HTMLInputElement)?.value?.trim() || r.title;
      const res = await api().invoke('hub:projectSpaceApply', r.paths, title);
      if (res) {
        (card as HTMLElement).classList.add('done');
        (card.querySelector('.apply') as HTMLButtonElement).disabled = true;
        (card.querySelector('.apply') as HTMLButtonElement).textContent = '已创建';
      }
    });
  });
  $('#pSum').textContent = `${rows.length} 个建议`;
  $('#pBar').hidden = false;
}
$('#pScan')?.addEventListener('click', () => loadProjects());

function openTab(tab: string | null, files: DesktopItem[] | null) {
  if (files?.length) setFiles(files);
  const t = tab && ['briefing', 'organize', 'cleanup', 'rename', 'projects'].includes(tab) ? tab : 'briefing';
  show(t);
  if (t === 'rename' && files?.length) genRename();
  if (loaded.has(t) && tab === t && t !== 'rename' && !files) {
    /* already loaded: keep */
  }
}
api().on('hub:tab', (tab: string | null, paths: string[] | null) => {
  if (paths?.length) api().invoke('hub:init').then((r: any) => openTab(tab, r.files));
  else openTab(tab, null);
});
api()
  .invoke('hub:init')
  .then((r: any) => {
    configured = r.configured;
    messy = r.messy ?? [];
    $('#model').className = 'pill ' + (configured ? 'ok' : 'warn');
    $('#model').innerHTML = `<i class="dot"></i>${configured ? esc(r.model) : '未配置 AI · 使用本地规则'}`;
    openTab(r.tab, r.files);
  });
document.documentElement.dataset.platform = api().platform;
