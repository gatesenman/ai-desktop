import { $, $$, api, applyTheme, esc, fmtSize, fmtTime, glyphHTML, icon, iconFor } from './common';
import type { DesktopItem, FenceData } from '../shared/types';

const boxId = new URLSearchParams(location.search).get('box') || '';
const $title = $('#title');
const $count = $('#count');
const $grid = $('#grid');
const $body = $('#body');
const $boxIcon = $('#boxIcon');

let data: FenceData | null = null;
const selected = new Set<string>();
let lastClicked: string | null = null;
let focusIdx = -1;
const VIRTUAL_THRESHOLD = 80;
const OVERSCAN = 16;
let virtualOn = false;
let virtStart = 0;
let virtEnd = 0;
let scrollRaf = 0;

/** Defer native icon IPC until the tile is near the viewport (skips off-screen / huge lists). */
let iconObs: IntersectionObserver | null = null;
function ensureIconObs() {
  if (iconObs) return iconObs;
  iconObs = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const el = e.target as HTMLElement;
        iconObs!.unobserve(el);
        const p = el.dataset.path;
        if (!p || !data) continue;
        const it = data.items.find((x) => x.path === p);
        if (!it) continue;
        // Skip thumbnails for huge images that are (were) off-screen; glyphs already shown.
        if (it.category === 'image' && it.size >= 12 * 1024 * 1024) continue;
        iconFor(it.path).then((url) => {
          if (!url || el.dataset.path !== p) return;
          const ic = el.querySelector('.ic');
          if (!ic) return;
          ic.innerHTML = `<img src="${url}" draggable="false" alt="">`;
          // icon tint overlay is masked by the icon's own alpha, so transparent pixels stay untouched
          (ic as HTMLElement).classList.add('has-img');
          (ic as HTMLElement).style.setProperty('--m', `url("${url}")`);
        });
      }
    },
    { root: $body, rootMargin: '80px', threshold: 0.01 },
  );
  return iconObs;
}


function renderTabs() {
  const el = $('#tabs');
  if (!el || !data) return;
  const tabs = data.box.tabs;
  const show = !!(tabs && tabs.length) && !data.box.collapsed;
  el.hidden = !show;
  document.body.classList.toggle('has-tabs', show);
  if (!show) {
    el.innerHTML = '';
    return;
  }
  const active = data.box.activeTabId ?? tabs![0].id;
  el.className = 'ftabs tabs-' + (data.box.tabStyle ?? 'pill');
  el.innerHTML =
    tabs!
      .map(
        (tab) =>
          `<button class="ftab${tab.id === active ? ' on' : ''}${tab.color ? ' has-c' : ''}" data-tid="${esc(tab.id)}" title="${esc(tab.title)}（双击重命名，右键更多）"${tab.color ? ` style="--tc:${esc(tab.color)}"` : ''}><span class="tl">${esc(tab.title)}</span><span class="n">${tab.id === active ? data!.items.length : tab.items.length}</span></button>`,
      )
      .join('') +
    `<button class="ftab add" data-add="1" title="新建标签">${icon('ri-add-line')}</button>`;
  el.querySelectorAll('.ftab').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const b = btn as HTMLElement;
      if (b.dataset.add) return void api().invoke('fence:tabAdd');
      const id = b.dataset.tid;
      if (id) api().invoke('fence:tabSwitch', id);
    });
    btn.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      const b = btn as HTMLElement;
      if (b.dataset.add || !b.dataset.tid) return;
      startTabRename(b.dataset.tid);
    });
    btn.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const b = btn as HTMLElement;
      if (b.dataset.add || !b.dataset.tid) return;
      api().invoke('fence:tabMenu', b.dataset.tid);
    });
  });
}

/** Inline tab rename (window.prompt is not available in Electron). */
function startTabRename(tabId: string) {
  const btn = $(`#tabs .ftab[data-tid="${CSS.escape(tabId)}"]`) as HTMLElement | null;
  const tab = data?.box.tabs?.find((x) => x.id === tabId);
  if (!btn || !tab || btn.querySelector('input')) return;
  const label = btn.querySelector('.tl') as HTMLElement;
  const input = document.createElement('input');
  input.className = 'tab-edit';
  input.value = tab.title;
  input.maxLength = 24;
  input.spellcheck = false;
  label.replaceWith(input);
  input.focus();
  input.select();
  let finished = false;
  const done = (commit: boolean) => {
    if (finished) return;
    finished = true;
    const v = input.value.trim();
    if (commit && v && v !== tab.title) api().invoke('fence:tabRename', tabId, v);
    else renderTabs();
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') (e.preventDefault(), done(true));
    else if (e.key === 'Escape') (e.preventDefault(), done(false));
  });
  input.addEventListener('click', (e) => e.stopPropagation());
  input.addEventListener('blur', () => done(true));
}
api().on('fence:tabPromptRename', (tabId: string) => startTabRename(tabId));

function render() {
  if (!data) return;
  applyTheme(data);
  const { box } = data;
  document.title = box.title;
  const root = document.documentElement;
  const accent = box.color || '';
  root.style.setProperty('--box-accent', accent || 'var(--accent)');
  root.style.setProperty('--tint', String(accent ? box.tint ?? 0.35 : 0));
  if (typeof box.alpha === 'number') root.style.setProperty('--box-alpha', String(box.alpha));
  const cls = document.body.classList;
  cls.toggle('has-accent', !!accent);
  cls.toggle('recent', box.kind === 'recent');
  cls.toggle('portal', box.kind === 'portal');
  cls.toggle('locked', !!box.locked);
  cls.toggle('icon-tint', !!box.iconTint || !!data.tintAll);
  cls.toggle('no-title-icon', !!box.hideTitleIcon);
  if (data.tintAll && !box.iconTint) {
    root.style.setProperty('--tint-c', data.tintColor || 'var(--accent)');
    root.style.setProperty('--tint-k', String(data.tintStrength ?? 0.6));
  } else {
    root.style.removeProperty('--tint-c');
    root.style.setProperty('--tint-k', '1');
  }
  cls.toggle('header-hover', data.headerMode === 'hover');
  cls.toggle('hide-scroll', !!data.hideScrollbars);
  if (box.iconSizeOverride) root.style.setProperty('--icon', box.iconSizeOverride + 'px');
  else if ((data as any).iconSize) root.style.setProperty('--icon', (data as any).iconSize + 'px');
  root.style.setProperty('--title-font', box.titleFont ? `"${box.titleFont.replace(/"/g, '')}", var(--font)` : 'inherit');
  root.style.setProperty('--title-size', box.titleSize ? box.titleSize + 'px' : '');
  if (box.titleColor) root.style.setProperty('--title-color', box.titleColor);
  else root.style.removeProperty('--title-color');
  cls.toggle('align-left', box.titleAlign === 'left');
  ['band', 'minimal', 'accent'].forEach((t) => cls.toggle('title-' + t, (box.titleStyle ?? 'band') === t));
  $boxIcon.innerHTML = icon(box.icon || 'ri-inbox-2-line');
  if (!$title.querySelector('input')) $title.textContent = box.title;
  $count.textContent = String(data.items.length);
  cls.toggle('collapsed', box.collapsed);
  if (!box.collapsed) cls.remove('peek');
  const view = box.view ?? 'grid';
  $('#view').innerHTML = icon(view === 'grid' ? 'ri-list-unordered' : 'ri-layout-grid-line');
  $('#view').title = view === 'grid' ? '切换为列表视图' : '切换为图标视图';
  $('#collapse').title = box.collapsed ? '展开' : '卷起（只显示标题）';
  // portal breadcrumb
  const cr = data.crumbs ?? [];
  cls.toggle('has-crumbs', cr.length > 1);
  $('#crumbs').innerHTML = cr.length > 1
    ? cr.map((c, i) => `<button class="crumb${i === cr.length - 1 ? ' cur' : ''}" data-p="${esc(c.path)}">${i === 0 ? icon('ri-folder-open-line') : ''}${esc(c.name)}</button>`).join(icon('ri-arrow-right-s-line', 'sep'))
    : '';
  renderTabs();
  $grid.className = view === 'list' ? 'list' : 'grid';
  $grid.innerHTML = '';
  // drop selections that no longer exist
  const paths = new Set(data.items.map((i) => i.path));
  [...selected].forEach((p) => !paths.has(p) && selected.delete(p));
  if (data.portalError) {
    virtualOn = false;
    $grid.innerHTML = `<div class="empty">${icon('ri-folder-warning-line')}<div>${esc(data.portalError)}</div><small>右键标题栏 › 更改映射文件夹</small></div>`;
    return;
  }
  if (!data.items.length) {
    virtualOn = false;
    $grid.innerHTML =
      box.kind === 'recent'
        ? `<div class="empty">${icon('ri-time-line')}<div>暂无最近文件</div><small>桌面上新修改的文件会自动出现在这里</small></div>`
        : box.kind === 'portal'
          ? `<div class="empty">${icon('ri-folder-open-line')}<div>文件夹是空的</div><small>${(box.portal?.sync ?? 'mirror') === 'bidirectional' ? '双向同步：可拖入文件写入此文件夹' : '文件夹中的变化会实时显示在这里'}</small></div>`
          : box.kind === 'manual'
            ? `<div class="empty">${icon('ri-layout-masonry-line')}<div>自定义容器</div><small>从桌面或资源管理器拖入文件；默认添加引用，可在菜单切换放入方式</small></div>`
            : `<div class="empty">${icon('ri-drag-drop-line')}<div>把图标拖到这里</div><small>拖入为引用（不复制文件）；格子间移动归属；拖到空白桌面移出 · Ctrl+拖 = 系统复制 · 按 ? 查看快捷键</small></div>`;
    return;
  }
  virtualOn = data.items.length >= VIRTUAL_THRESHOLD && view === 'list';
  if (virtualOn) {
    paintVirtual(true);
  } else {
    const frag = document.createDocumentFragment();
    data.items.forEach((it, i) => frag.appendChild(view === 'list' ? row(it, i) : tile(it, i)));
    $grid.appendChild(frag);
  }
}

function rowHeight() {
  return 33; // 32px + gap
}
function paintVirtual(force = false) {
  if (!data || !virtualOn) return;
  const view = data.box.view ?? 'grid';
  if (view !== 'list') return;
  const rh = rowHeight();
  const scrollTop = $body.scrollTop;
  const vh = $body.clientHeight || 200;
  const start = Math.max(0, Math.floor(scrollTop / rh) - OVERSCAN);
  const end = Math.min(data.items.length, Math.ceil((scrollTop + vh) / rh) + OVERSCAN);
  if (!force && start === virtStart && end === virtEnd && $grid.childElementCount) return;
  virtStart = start;
  virtEnd = end;
  const totalH = data.items.length * rh;
  const frag = document.createDocumentFragment();
  const top = document.createElement('div');
  top.style.cssText = `height:${start * rh}px;flex-shrink:0;pointer-events:none`;
  frag.appendChild(top);
  for (let i = start; i < end; i++) frag.appendChild(row(data.items[i], i));
  const bot = document.createElement('div');
  bot.style.cssText = `height:${Math.max(0, totalH - end * rh)}px;flex-shrink:0;pointer-events:none`;
  frag.appendChild(bot);
  $grid.innerHTML = '';
  $grid.appendChild(frag);
}
$body.addEventListener(
  'scroll',
  () => {
    if (!virtualOn) return;
    if (scrollRaf) return;
    scrollRaf = requestAnimationFrame(() => {
      scrollRaf = 0;
      paintVirtual();
    });
  },
  { passive: true },
)

function tooltip(it: DesktopItem) {
  const full = it.name + (it.isDir ? '' : it.ext && !it.name.endsWith(it.ext) ? it.ext : '');
  return `${full}\n修改时间：${fmtTime(it.mtime)}${it.isDir ? '' : '\n大小：' + fmtSize(it.size)}${
    it.source === 'external' ? '\n位置：' + it.path + '（引用）' : it.source === 'public' ? '\n公用桌面' : it.source === 'portal' && it.isDir ? '\n双击进入此文件夹' : ''
  }`;
}

function iconSlot(it: DesktopItem): string {
  return `<div class="ic">${glyphHTML(it)}</div>`;
}
function scheduleIcon(el: HTMLElement, it: DesktopItem) {
  // Glyph first; native icon only when near viewport (and not a huge image).
  ensureIconObs().observe(el);
}

function tile(it: DesktopItem, i: number): HTMLElement {
  const el = document.createElement('div');
  el.className = 'tile' + (it.source === 'external' ? ' ext' : '');
  el.innerHTML = `${iconSlot(it)}<div class="nm">${esc(it.name)}</div>${it.source === 'external' ? `<span class="ref">${icon('ri-links-line')}</span>` : ''}`;
  wire(el, it, i);
  return el;
}

function row(it: DesktopItem, i: number): HTMLElement {
  const el = document.createElement('div');
  el.className = 'row' + (it.source === 'external' ? ' ext' : '');
  el.innerHTML = `${iconSlot(it)}<div class="nm">${esc(it.name)}${it.source === 'external' ? ` ${icon('ri-links-line', 'ref-i')}` : ''}</div><div class="meta">${fmtTime(it.mtime)}</div><div class="meta sz">${it.isDir ? '' : fmtSize(it.size)}</div>`;
  wire(el, it, i);
  return el;
}

function wire(el: HTMLElement, it: DesktopItem, i: number) {
  el.dataset.path = it.path;
  el.dataset.idx = String(i);
  el.title = tooltip(it);
  el.draggable = true;
  el.tabIndex = -1;
  if (selected.has(it.path)) el.classList.add('sel');
  scheduleIcon(el, it);
  el.addEventListener('click', (e) => {
    if (e.ctrlKey || e.metaKey) selected.has(it.path) ? selected.delete(it.path) : selected.add(it.path);
    else if (e.shiftKey && lastClicked && data) {
      const paths = data.items.map((x) => x.path);
      const [a, b] = [paths.indexOf(lastClicked), paths.indexOf(it.path)].sort((x, y) => x - y);
      paths.slice(a, b + 1).forEach((p) => selected.add(p));
    } else {
      selected.clear();
      selected.add(it.path);
    }
    lastClicked = it.path;
    focusIdx = i;
    syncSel();
    e.stopPropagation();
  });
  el.addEventListener('dblclick', () => (data?.box.kind === 'portal' && it.isDir ? api().invoke('portal:nav', it.path) : open([it.path])));
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!selected.has(it.path)) {
      selected.clear();
      selected.add(it.path);
      focusIdx = i;
      syncSel();
    }
    api().invoke('item:menu', [...selected]);
  });
  el.addEventListener('dragstart', (e) => {
    if (!selected.has(it.path)) {
      selected.clear();
      selected.add(it.path);
      syncSel();
    }
    const paths = [...selected];
    // Ctrl/Cmd+drag → real OS file drag (Explorer copy/move). Otherwise Fences-style membership only:
    // HTML5 custom MIME between fences — never duplicates on disk.
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      api().send('drag:native', paths);
      return;
    }
    try {
      e.dataTransfer!.effectAllowed = 'all';
      e.dataTransfer!.setData('application/x-aidesk-paths', JSON.stringify(paths));
      e.dataTransfer!.setData('text/plain', paths.join('\n'));
    } catch { /* ignore */ }
    api().send('drag:begin', paths);
  });
  el.addEventListener('dragend', () => {
    api().invoke('drag:end').catch(() => {});
  });
}

function open(paths: string[]) {
  paths.forEach((p) => api().invoke('item:open', p));
  $$('.sel').forEach((t) => {
    t.classList.remove('opening');
    void t.offsetWidth;
    t.classList.add('opening');
  });
}

function syncSel(scroll = true) {
  $$('[data-path]', $grid).forEach((t) => {
    t.classList.toggle('sel', selected.has(t.dataset.path!));
    t.classList.toggle('focus', Number(t.dataset.idx) === focusIdx);
  });
  if (scroll) $$('[data-path]', $grid)[focusIdx]?.scrollIntoView({ block: 'nearest' });
  document.body.classList.toggle('has-sel', selected.size > 0);
}

// ---- drop target (OS file drops: from other boxes, Explorer, other apps)
let dropBefore: string | null = null;
let leaveTimer: number | undefined;
$body.addEventListener('dragover', (e) => {
  e.preventDefault();
  clearTimeout(leaveTimer);
  const portalRO = data?.box.kind === 'portal' && (data.box.portal?.sync ?? 'mirror') !== 'bidirectional';
  if (data?.box.kind === 'recent' || portalRO) {
    e.dataTransfer!.dropEffect = 'none';
    document.body.classList.add('no-drop');
    return;
  }
  // Organize fences: move membership (Fences / 腾讯桌面). Portal: Explorer-style copy/move.
  e.dataTransfer!.dropEffect = data?.box.kind === 'portal' ? 'copy' : 'move';
  document.body.classList.add('dropping');
  const t = (e.target as HTMLElement).closest<HTMLElement>('[data-path]');
  dropBefore = t?.dataset.path ?? null;
  $$('.before', $grid).forEach((x) => x !== t && x.classList.remove('before'));
  t?.classList.add('before');
});
$body.addEventListener('dragleave', () => {
  leaveTimer = window.setTimeout(() => {
    document.body.classList.remove('dropping', 'no-drop');
    $$('.before', $grid).forEach((x) => x.classList.remove('before'));
  }, 60);
});
$body.addEventListener('drop', (e) => {
  e.preventDefault();
  document.body.classList.remove('dropping');
  $$('.before', $grid).forEach((x) => x.classList.remove('before'));
  if (data?.box.kind === 'recent') return;
  document.body.classList.remove('no-drop');
  // Mark consume synchronously so source dragend does not "release to desktop".
  api().send('drag:consume');
  let paths: string[] = [];
  try {
    const raw = e.dataTransfer?.getData('application/x-aidesk-paths') || '';
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) paths = parsed.filter((x) => typeof x === 'string');
    }
  } catch { /* ignore */ }
  if (!paths.length) {
    paths = [...(e.dataTransfer?.files ?? [])].map((f) => api().pathForFile(f)).filter(Boolean);
  }
  api().invoke('drag:drop', dropBefore, paths);
  dropBefore = null;
});

$body.addEventListener('click', () => {
  if (marqueeJustEnded) return void (marqueeJustEnded = false);
  selected.clear();
  focusIdx = -1;
  syncSel();
});

// ---- marquee (rubber-band) selection inside a fence, like the desktop
let marqueeJustEnded = false;
$body.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || (e.target as HTMLElement).closest('[data-path], button, input, .empty a')) return;
  const host = $body.getBoundingClientRect();
  const x0 = e.clientX;
  const y0 = e.clientY;
  const st0 = $body.scrollTop;
  const additive = e.ctrlKey || e.metaKey || e.shiftKey;
  const base = additive ? new Set(selected) : new Set<string>();
  let box: HTMLDivElement | null = null;
  const move = (ev: PointerEvent) => {
    const dx = ev.clientX - x0;
    const dy = ev.clientY - y0 + ($body.scrollTop - st0);
    if (!box && Math.hypot(dx, dy) < 5) return;
    if (!box) {
      box = document.createElement('div');
      box.className = 'marquee';
      $body.appendChild(box);
      $body.setPointerCapture(ev.pointerId);
    }
    const ax = x0 - host.left;
    const ay = y0 - host.top + st0;
    const bx = ev.clientX - host.left;
    const by = ev.clientY - host.top + $body.scrollTop;
    const l = Math.min(ax, bx), t = Math.min(ay, by), w = Math.abs(bx - ax), h = Math.abs(by - ay);
    Object.assign(box.style, { left: l + 'px', top: t + 'px', width: w + 'px', height: h + 'px' });
    const r = { l: l + host.left, t: t + host.top - $body.scrollTop, r: l + w + host.left, b: t + h + host.top - $body.scrollTop };
    selected.clear();
    base.forEach((p) => selected.add(p));
    $$('[data-path]', $grid).forEach((el) => {
      const b = el.getBoundingClientRect();
      if (b.right > r.l && b.left < r.r && b.bottom > r.t && b.top < r.b) selected.add(el.dataset.path!);
    });
    syncSel(false);
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    if (box) {
      box.remove();
      marqueeJustEnded = true;
      setTimeout(() => (marqueeJustEnded = false), 0);
    }
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
});
$body.addEventListener('contextmenu', (e) => {
  // Fences: blank space inside a fence has its own menu (view / sort / new / size …); title bar keeps the fence menu.
  e.preventDefault();
  api().invoke('fence:areaMenu');
});
$('#bar').addEventListener('contextmenu', (e) => {
  e.preventDefault();
  api().invoke('fence:menu');
});
$('#collapse').addEventListener('click', () => api().invoke('fence:collapse'));
$('#back').addEventListener('click', () => {
  const cr = data?.crumbs;
  if (cr && cr.length > 1) api().invoke('portal:nav', cr[cr.length - 2].path);
});
$('#crumbs').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('.crumb');
  if (b && !b.classList.contains('cur')) api().invoke('portal:nav', b.dataset.p);
});

// ---- custom move / resize (main process snaps to grid / other fences and draws alignment guides)
let dragId = 0;
function beginDrag(e: PointerEvent, mode: string, el: HTMLElement): Promise<boolean> {
  return new Promise((resolve) => {
    if (e.button !== 0 || $title.querySelector('input')) return resolve(false);
    const id = ++dragId;
    el.setPointerCapture(e.pointerId);
    api().invoke('fence:dragStart', mode, e.screenX, e.screenY);
    document.body.classList.add('dragging');
    let raf = 0;
    let last: [number, number] = [e.screenX, e.screenY];
    const move = (ev: PointerEvent) => {
      last = [ev.screenX, ev.screenY];
      if (!raf) raf = requestAnimationFrame(() => ((raf = 0), api().send('fence:dragMove', last[0], last[1])));
    };
    const up = async (ev: PointerEvent) => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      try {
        el.releasePointerCapture(ev.pointerId);
      } catch {
        /* already released */
      }
      if (raf) cancelAnimationFrame(raf);
      api().send('fence:dragMove', ev.screenX, ev.screenY);
      const moved = (await api().invoke('fence:dragEnd')) as boolean;
      document.body.classList.remove('dragging');
      resolve(id === dragId && moved);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  });
}
let lastBarClick = 0;
$('#bar').addEventListener('pointerdown', async (e) => {
  if ((e.target as HTMLElement).closest('button, input')) return;
  // Title text owns double-click → rename (Fences). Still allow drag from the title.
  const onTitle = !!(e.target as HTMLElement).closest('#title');
  const moved = await beginDrag(e, 'move', $('#bar'));
  if (moved || !data) return;
  if (onTitle) return; // single-click on name does nothing; dblclick starts rename
  // click (no movement) on the rest of the title bar: roll up / down per setting
  const now = Date.now();
  if (data.rollupOn === 'click') api().invoke('fence:collapse');
  else if (now - lastBarClick < 420) {
    lastBarClick = 0;
    api().invoke('fence:collapse');
    return;
  }
  lastBarClick = now;
});

/** Fences: double-click the fence name to rename in place. */
$title.addEventListener('dblclick', (e) => {
  e.preventDefault();
  e.stopPropagation();
  startRename();
});
$$('.grip').forEach((g) => g.addEventListener('pointerdown', (e) => beginDrag(e, g.dataset.mode!, g)));

// ---- hover peek for rolled-up fences
let peekTimer: number | undefined;
document.body.addEventListener('mouseenter', () => {
  clearTimeout(peekTimer);
  if (data?.box.collapsed && data.hoverPeek !== false) peekTimer = window.setTimeout(() => api().invoke('fence:peek', true), 260);
});
document.body.addEventListener('mouseleave', () => {
  clearTimeout(peekTimer);
  if (data?.box.collapsed && !document.body.classList.contains('dragging')) peekTimer = window.setTimeout(() => api().invoke('fence:peek', false), 220);
});
api().on('fence:peek', (on: boolean) => document.body.classList.toggle('peek', on));
api().on('fence:peekAll', (on: boolean) => document.body.classList.toggle('peekall', on));
api().on('fence:enter', (dir: string) => {
  const b = $('#box');
  b.classList.remove('enter-left', 'enter-right', 'enter-fade');
  void b.offsetWidth;
  b.classList.add('enter-' + dir);
});
api().on('fence:locked', () => {
  const b = $('#box');
  b.classList.remove('shake');
  void b.offsetWidth;
  b.classList.add('shake');
});
$('#menu').addEventListener('click', () => api().invoke('fence:menu'));
$('#view').addEventListener('click', () => data && api().invoke('fence:setView', (data.box.view ?? 'grid') === 'grid' ? 'list' : 'grid'));

// ---- keyboard navigation
function columns(): number {
  const els = $$('[data-path]', $grid);
  if (!els.length || data?.box.view === 'list') return 1;
  const top = els[0].offsetTop;
  let n = 0;
  while (n < els.length && els[n].offsetTop === top) n++;
  return Math.max(1, n);
}
document.addEventListener('keydown', (e) => {
  const typing = !!$title.querySelector('input') || (e.target instanceof HTMLElement && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable));
  if (e.key === 'F1' || (e.key === '?' && !typing && !e.ctrlKey && !e.metaKey && !e.altKey)) { e.preventDefault(); api().invoke('app:action', 'help'); return; }
  if (typing || !data) return;
  const n = data.items.length;
  const move = (d: number) => {
    if (!n) return;
    focusIdx = focusIdx < 0 ? 0 : Math.min(n - 1, Math.max(0, focusIdx + d));
    const p = data!.items[focusIdx].path;
    if (!e.shiftKey) selected.clear();
    selected.add(p);
    lastClicked = p;
    syncSel();
    e.preventDefault();
  };
  switch (e.key) {
    case 'ArrowRight':
      return move(1);
    case 'ArrowLeft':
      return move(-1);
    case 'ArrowDown':
      return move(columns());
    case 'ArrowUp':
      return move(-columns());
    case 'Home':
      focusIdx = 0;
      return move(0);
    case 'End':
      focusIdx = n - 1;
      return move(0);
    case 'Enter':
      if (selected.size === 1 && data.box.kind === 'portal' && data.items.find((i) => i.path === [...selected][0])?.isDir) api().invoke('portal:nav', [...selected][0]);
      else if (selected.size) open([...selected]);
      return;
    case 'Backspace':
      if (data.crumbs && data.crumbs.length > 1) api().invoke('portal:nav', data.crumbs[data.crumbs.length - 2].path);
      return;
    case 'Escape':
      api().invoke('fence:endPeekAll');
      selected.clear();
      focusIdx = -1;
      return syncSel();
    case 'F2':
      // Fences/Explorer: F2 with one file selected renames the file (bidirectional portal) else the fence
      if (selected.size === 1 && data.box.kind === 'portal') return void api().invoke('item:rename', [...selected][0]);
      return startRename();
    case 'Delete':
      if (selected.size) {
        e.preventDefault();
        api().invoke('item:delete', [...selected], e.shiftKey);
      }
      return;
    case 'F5':
      e.preventDefault();
      api().invoke('fence:refresh');
      return;
    case 'ContextMenu':
      e.preventDefault();
      if (selected.size) api().invoke('item:menu', [...selected]);
      else api().invoke('fence:menu');
      return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
    data.items.forEach((i) => selected.add(i.path));
    syncSel();
    e.preventDefault();
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
    api().invoke('fence:undo');
    e.preventDefault();
  }
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key.toLowerCase() === 'c' || e.key.toLowerCase() === 'x') && selected.size) {
    api().invoke('item:clip', [...selected], e.key.toLowerCase() === 'x');
    e.preventDefault();
  }
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'v') {
    api().invoke('fence:paste');
    e.preventDefault();
  }
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'n') {
    api().invoke('fence:newFolder');
    e.preventDefault();
  }
});

/** Inline rename (shared by double-click title, F2, and title-bar context menu). */
function startRename() {
  if (!data || $title.querySelector('input')) return;
  const prev = data.box.title;
  const input = document.createElement('input');
  input.type = 'text';
  input.value = prev;
  input.maxLength = 40;
  input.spellcheck = false;
  input.setAttribute('aria-label', '重命名格子');
  $title.textContent = '';
  $title.appendChild(input);
  document.body.classList.add('editing');
  input.focus();
  input.select();
  let finished = false;
  const done = (commit: boolean) => {
    if (finished) return;
    finished = true;
    document.body.classList.remove('editing');
    const v = input.value.trim();
    input.remove();
    // Empty after trim → keep previous name (never allow blank titles)
    if (commit && v && v !== prev) {
      $title.textContent = v.slice(0, 40);
      api().invoke('fence:rename', v.slice(0, 40));
    } else {
      $title.textContent = data!.box.title; // cancel, empty, or unchanged
    }
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      done(true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      done(false);
    }
  });
  input.addEventListener('blur', () => done(true));
}

api().on('fence:data', (d: FenceData) => {
  data = d;
  render();
});
api().on('fence:startRename', startRename);
api().on('theme', (t) => {
  if (data) Object.assign(data, t);
  applyTheme(t);
  if (data?.box.iconSizeOverride) document.documentElement.style.setProperty('--icon', data.box.iconSizeOverride + 'px');
  if (data) {
    document.body.classList.toggle('header-hover', (data as any).headerMode === 'hover');
    document.body.classList.toggle('hide-scroll', !!(data as any).hideScrollbars);
    // global icon tint may have changed: cheap repaint of classes/vars (keeps selection)
    const cls = document.body.classList;
    cls.toggle('icon-tint', !!data.box.iconTint || !!data.tintAll);
    if (data.tintAll && !data.box.iconTint) {
      document.documentElement.style.setProperty('--tint-c', data.tintColor || 'var(--accent)');
      document.documentElement.style.setProperty('--tint-k', String(data.tintStrength ?? 0.6));
    } else document.documentElement.style.removeProperty('--tint-c');
  }
});
api()
  .invoke('fence:init', boxId)
  .then((d) => {
    data = d as FenceData;
    render();
    requestAnimationFrame(() => document.body.classList.add('ready'));
  });
