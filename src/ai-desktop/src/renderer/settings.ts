import { $, $$, api, esc, icon, initTheme } from './common';
import type { Rule, RuleCond, Settings, Snapshot } from '../shared/types';
import { CATEGORY_LABEL, CATEGORY_ORDER } from '../shared/types';
import { RULE_FIELDS, describeRule } from '../main/rules';

initTheme();
const PRESETS: Record<string, { name: string; baseURL: string; model: string; hint: string; color: string; mono: string }> = {
  deepseek: { name: 'DeepSeek', baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-chat', hint: 'platform.deepseek.com', color: '#4d6bfe', mono: 'DS' },
  qwen: { name: '通义千问', baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus', hint: '阿里云百炼控制台', color: '#615ced', mono: '通' },
  openai: { name: 'OpenAI', baseURL: 'https://api.openai.com/v1', model: 'gpt-4o-mini', hint: 'platform.openai.com', color: '#10a37f', mono: 'AI' },
  moonshot: { name: 'Kimi', baseURL: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k', hint: 'platform.moonshot.cn', color: '#16191e', mono: 'K' },
  zhipu: { name: '智谱 GLM', baseURL: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash', hint: 'open.bigmodel.cn', color: '#3859ff', mono: '智' },
  siliconflow: { name: '硅基流动', baseURL: 'https://api.siliconflow.cn/v1', model: 'Qwen/Qwen2.5-7B-Instruct', hint: 'cloud.siliconflow.cn', color: '#7c3aed', mono: 'SF' },
  ollama: { name: 'Ollama', baseURL: 'http://localhost:11434/v1', model: 'qwen2.5:7b', hint: '本地运行，无需 Key', color: '#5a6578', mono: 'OL' },
  custom: { name: '自定义', baseURL: '', model: '', hint: '任意 OpenAI 兼容接口', color: '#8a8f99', mono: '…' },
};

let current: Settings;
let info: any;

// ---------------------------------------------------------------- navigation
function showSection(id: string) {
  $$('.nav-item').forEach((n) => n.classList.toggle('active', n.dataset.sec === id));
  $$('.page').forEach((p) => p.classList.toggle('active', p.id === 'sec-' + id));
  $('.content').scrollTop = 0;
  if (id === 'learn') void loadLearn();
}
$$('.nav-item').forEach((n) => n.addEventListener('click', () => showSection(n.dataset.sec!)));
api().on('settings:section', (sec: string, payload: any) => {
  showSection(sec);
  if (sec === 'rules' && payload) draftFromPayload(payload);
});
const initialSec = new URLSearchParams(location.search).get('section');

// ---------------------------------------------------------------- toast
let toastT: number | undefined;
function toast(msg: string, kind: 'ok' | 'bad' = 'ok') {
  const t = $('#toast');
  t.className = 'toast show ' + kind;
  t.innerHTML = `${icon(kind === 'ok' ? 'ri-checkbox-circle-fill' : 'ri-error-warning-fill')}<span>${esc(msg)}</span>`;
  clearTimeout(toastT);
  toastT = window.setTimeout(() => t.classList.remove('show'), 2200);
}

// ---------------------------------------------------------------- save
let saveT: number | undefined;
async function save(patch: Partial<Settings>, quiet = true) {
  current = { ...current, ...patch, ai: { ...current.ai, ...(patch.ai ?? {}) } };
  clearTimeout(saveT);
  saveT = window.setTimeout(async () => {
    const r: any = await api().invoke('settings:set', current);
    showHotkeys(r.hotkeys);
    if (!quiet) toast('已保存');
    else flashSaved();
  }, 250);
}
function flashSaved() {
  const s = $('#saved');
  s.classList.remove('show');
  void s.offsetWidth;
  s.classList.add('show');
}

// ---------------------------------------------------------------- AI section
function renderPresets() {
  const wrap = $('#presets');
  wrap.innerHTML = Object.entries(PRESETS)
    .map(
      ([k, p]) =>
        `<button class="preset" data-k="${k}"><span class="mono" style="--c:${p.color}">${esc(p.mono)}</span><span class="pn">${esc(p.name)}</span><span class="phint">${esc(p.hint)}</span><i class="ri-checkbox-circle-fill pk"></i></button>`,
    )
    .join('');
  $$('.preset', wrap).forEach((b) =>
    b.addEventListener('click', () => {
      const p = PRESETS[b.dataset.k!];
      if (b.dataset.k !== 'custom') {
        $<HTMLInputElement>('#baseURL').value = p.baseURL;
        $<HTMLInputElement>('#model').value = p.model;
        save({ ai: { ...current.ai, baseURL: p.baseURL, model: p.model } });
      }
      markPreset(b.dataset.k!);
      $<HTMLInputElement>('#apiKey').focus();
    }),
  );
}
function markPreset(k?: string) {
  const key = k ?? Object.entries(PRESETS).find(([, v]) => v.baseURL && v.baseURL === current.ai.baseURL)?.[0] ?? 'custom';
  $$('.preset').forEach((b) => b.classList.toggle('active', b.dataset.k === key));
}
function aiFromForm() {
  return {
    baseURL: $<HTMLInputElement>('#baseURL').value.trim(),
    apiKey: $<HTMLInputElement>('#apiKey').value.trim(),
    model: $<HTMLInputElement>('#model').value.trim(),
    temperature: Number($<HTMLInputElement>('#temperature').value),
  };
}
['#baseURL', '#apiKey', '#model'].forEach((s) =>
  $(s).addEventListener('change', () => {
    save({ ai: aiFromForm() });
    markPreset();
    updateAIState();
  }),
);
$('#temperature').addEventListener('input', () => ($('#tempVal').textContent = Number($<HTMLInputElement>('#temperature').value).toFixed(1)));
$('#temperature').addEventListener('change', () => save({ ai: aiFromForm() }));
$('#toggleKey').addEventListener('click', () => {
  const k = $<HTMLInputElement>('#apiKey');
  k.type = k.type === 'password' ? 'text' : 'password';
  $('#toggleKey').innerHTML = icon(k.type === 'password' ? 'ri-eye-line' : 'ri-eye-off-line');
});
$('#test').addEventListener('click', async () => {
  const out = $('#testOut');
  out.className = 'status-line busy';
  out.innerHTML = `<span class="spinner"></span>正在连接…`;
  const r: any = await api().invoke('settings:test', { ai: aiFromForm() });
  out.className = 'status-line ' + (r.ok ? 'ok' : 'bad');
  out.innerHTML = `${icon(r.ok ? 'ri-checkbox-circle-fill' : 'ri-close-circle-fill')}<span>${esc(r.msg)}</span>`;
  if (r.ok) save({ ai: aiFromForm() });
});
function updateAIState() {
  const a = aiFromForm();
  const ok = !!(a.baseURL && a.model && (a.apiKey || /localhost|127\.0\.0\.1/.test(a.baseURL)));
  const el = $('#aiState');
  for (const el2 of [el, $('#aiState2')]) {
    el2.className = 'pill ' + (ok ? 'ok' : 'warn');
    el2.innerHTML = `<i class="dot"></i>${ok ? '已配置' : '未配置（使用本地规则）'}`;
  }
}

// ---------------------------------------------------------------- generic controls
function bindToggle(id: keyof Settings) {
  const el = $<HTMLInputElement>('#' + id);
  el.checked = !!current[id];
  el.onchange = () => save({ [id]: el.checked } as Partial<Settings>);
}
function bindRange(id: 'opacity' | 'iconSize' | 'recentCount' | 'tintStrength', fmt: (v: number) => string) {
  const el = $<HTMLInputElement>('#' + id);
  const out = $('#' + id + 'Val');
  el.value = String(current[id]);
  out.textContent = fmt(current[id]);
  const paint = () => el.style.setProperty('--p', ((Number(el.value) - Number(el.min)) / (Number(el.max) - Number(el.min))) * 100 + '%');
  paint();
  el.addEventListener('input', () => {
    out.textContent = fmt(Number(el.value));
    paint();
    save({ [id]: Number(el.value) } as Partial<Settings>);
  });
}
function bindSegment(id: 'theme' | 'rollupOn' | 'snapGrid' | 'groupGap' | 'headerMode' | 'drawFence' | 'desktopRightClick' | 'quickHideMode' = 'theme') {
  $$(`#${id} button`).forEach((b) => {
    b.classList.toggle('active', b.dataset.v === String(current[id]));
    b.onclick = () => {
      $$(`#${id} button`).forEach((x) => x.classList.toggle('active', x === b));
      save({ [id]: id === 'snapGrid' || id === 'groupGap' ? Number(b.dataset.v) : b.dataset.v } as Partial<Settings>);
    };
  });
}

// hotkeys
type HotkeyKey = 'hotkeySearch' | 'hotkeyChat' | 'hotkeyToggle' | 'hotkeyPeek' | 'hotkeyPageNext' | 'hotkeyPagePrev';
function hotkeyCapture(input: HTMLInputElement, key: HotkeyKey) {
  input.value = current[key];
  input.onkeydown = (e) => {
    e.preventDefault();
    if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;
    if (e.key === 'Escape') return input.blur();
    if (e.key === 'Backspace') {
      input.value = '';
      return;
    }
    const parts: string[] = [];
    if (e.ctrlKey) parts.push('Ctrl');
    if (e.altKey) parts.push('Alt');
    if (e.shiftKey) parts.push('Shift');
    if (e.metaKey) parts.push('Super');
    let k = e.key === ' ' ? 'Space' : e.key.length === 1 ? e.key.toUpperCase() : e.key;
    if (/^Arrow/.test(k)) k = k.slice(5);
    if (!parts.length && !/^F\d+$/.test(k)) return;
    input.value = [...parts, k].join('+');
    save({ [key]: input.value } as Partial<Settings>, false);
    input.blur();
  };
}
function showHotkeys(h: { search: string; chat: string; toggle: string; peek?: string; pageNext?: string; pagePrev?: string }) {
  const set = (id: string, want: string, got: string) => {
    const el = $('#' + id);
    if (!got) el.innerHTML = `<span class="pill bad"><i class="dot"></i>注册失败，可能被占用</span>`;
    else if (want && got !== want) el.innerHTML = `<span class="pill warn"><i class="dot"></i>已回退为 ${esc(got)}</span>`;
    else el.innerHTML = `<span class="pill ok"><i class="dot"></i>已生效</span>`;
  };
  set('hkSearchState', current.hotkeySearch, h.search);
  set('hkChatState', current.hotkeyChat, h.chat);
  set('hkToggleState', current.hotkeyToggle, h.toggle);
  set('hkPeekState', current.hotkeyPeek, h.peek ?? '');
  set('hkPageNextState', current.hotkeyPageNext, h.pageNext ?? '');
  set('hkPagePrevState', current.hotkeyPagePrev, h.pagePrev ?? '');
  $('#pageKeys').textContent = h.pagePrev && h.pageNext ? `${h.pagePrev} / ${h.pageNext} 切换` : '';
}

// ---------------------------------------------------------------- rules editor
let rules: Rule[] = [];
let boxTitles: string[] = [];
let openRule: string | null = null;
let draft: Rule | null = null;
const SOURCE: Record<string, [string, string]> = { default: ['内置', ''], ai: ['AI', 'ai'], learned: ['学习', 'learned'], user: ['自定义', ''] };
const uid = () => Math.random().toString(36).slice(2, 10);

function condRow(c: RuleCond, i: number): string {
  const f = RULE_FIELDS.find((x) => x.field === c.field) ?? RULE_FIELDS[0];
  const fieldSel = `<select class="field fsel" data-k="field">${RULE_FIELDS.map((x) => `<option value="${x.field}"${x.field === c.field ? ' selected' : ''}>${x.label}</option>`).join('')}</select>`;
  const opSel = `<select class="field osel" data-k="op">${f.ops.map((o) => `<option value="${o.op}"${o.op === c.op ? ' selected' : ''}>${o.label}</option>`).join('')}</select>`;
  let val: string;
  if (c.field === 'category')
    val = `<select class="field vin" data-k="value">${CATEGORY_ORDER.map((k) => `<option value="${k}"${k === c.value ? ' selected' : ''}>${CATEGORY_LABEL[k]}</option>`).join('')}</select>`;
  else if (c.field === 'kind')
    val = `<select class="field vin" data-k="value">${[['folder', '文件夹'], ['shortcut', '快捷方式'], ['file', '文件']].map(([k, l]) => `<option value="${k}"${k === c.value ? ' selected' : ''}>${l}</option>`).join('')}</select>`;
  else val = `<input class="field vin" data-k="value" value="${esc(c.value)}" placeholder="${esc(f.hint)}" spellcheck="false">`;
  return `<div class="cond" data-i="${i}">${fieldSel}${opSel}${val}<button class="tb rm" title="删除条件">${icon('ri-close-line')}</button></div>`;
}

function ruleCard(r: Rule, i: number, isDraft = false): string {
  const open = isDraft || openRule === r.id;
  const [srcLabel, srcCls] = SOURCE[r.source ?? 'user'] ?? SOURCE.user;
  return `<div class="rule${open ? ' open' : ''}${r.enabled ? '' : ' off'}${isDraft ? ' draft' : ''}" data-id="${r.id}">
    <div class="rh">
      ${isDraft ? `<span class="fi sm" style="--g:#9b6bff">${icon('ri-sparkling-2-line')}</span>` : `<div class="order"><button class="tb up" title="上移（提高优先级）"${i === 0 ? ' disabled' : ''}>${icon('ri-arrow-up-s-line')}</button><button class="tb down" title="下移"${i === rules.length - 1 ? ' disabled' : ''}>${icon('ri-arrow-down-s-line')}</button></div>
      <label class="switch"><input class="en" type="checkbox"${r.enabled ? ' checked' : ''}><span></span></label>`}
      <div class="rmain"><div class="rtitle"><b>${esc(r.name)}</b><span class="src ${srcCls}">${srcLabel}</span>${isDraft ? '<span class="src ai">草稿</span>' : ''}</div><small>${esc(describeRule(r))}</small></div>
      <span class="hits" data-hits></span>
      <span class="target" style="--c:${r.color || 'var(--accent)'}">${icon(r.icon || 'ri-inbox-2-line')}${esc(r.target)}</span>
      ${isDraft ? '' : `<button class="tb edit" title="编辑">${icon(open ? 'ri-arrow-up-s-line' : 'ri-pencil-line')}</button><button class="tb del" title="删除规则">${icon('ri-delete-bin-6-line')}</button>`}
    </div>
    ${open ? `<div class="rb">
      <div class="rrow"><label>名称</label><input class="field rname" value="${esc(r.name)}" spellcheck="false" maxlength="30"></div>
      <div class="rrow"><label>满足</label><div class="segment sm rmatch"><button data-v="all"${r.match === 'all' ? ' class="active"' : ''}>全部条件</button><button data-v="any"${r.match === 'any' ? ' class="active"' : ''}>任一条件</button></div></div>
      <div class="conds">${r.conds.map(condRow).join('')}</div>
      <div class="rrow"><label></label><button class="link addc">${icon('ri-add-line')} 添加条件</button></div>
      <div class="rrow"><label>放入格子</label><input class="field rtarget" value="${esc(r.target)}" list="boxTitles" spellcheck="false" maxlength="24"><small class="muted">不存在时自动新建</small></div>
      <div class="rrow test"><label></label><span class="testout muted"></span></div>
      ${isDraft ? `<div class="rrow"><label></label><div class="inline"><button class="btn primary keep">${icon('ri-check-line')}添加并应用</button><button class="btn drop">放弃</button></div></div>` : ''}
    </div>` : ''}
  </div>`;
}

function renderRules() {
  $('#rules').innerHTML =
    (rules.length ? rules.map((r, i) => ruleCard(r, i)).join('') : `<div class="empty-card">${icon('ri-filter-3-line')}<b>还没有规则</b><small>用上方一句话生成，或点击「新建规则」</small></div>`) +
    `<datalist id="boxTitles">${boxTitles.map((t) => `<option value="${esc(t)}">`).join('')}</datalist>`;
  $('#nlDraft').innerHTML = draft ? ruleCard(draft, -1, true) : '';
  const on = rules.filter((r) => r.enabled).length;
  $('#rulesState').className = 'pill ' + (on ? 'ok' : '');
  $('#rulesState').innerHTML = `<i class="dot"></i>${on} 条启用`;
  $$('.rule').forEach((el) => wireRule(el));
  $$('.rule').forEach((el) => testRule(el));
}

function ruleOf(el: HTMLElement): Rule | null {
  const id = el.dataset.id;
  return draft?.id === id ? draft : rules.find((r) => r.id === id) ?? null;
}
let rulesSaveT: number | undefined;
function saveRules(rerender = true) {
  clearTimeout(rulesSaveT);
  rulesSaveT = window.setTimeout(() => api().invoke('rules:set', rules).then(() => flashSaved()), 300);
  if (rerender) renderRules();
}
async function testRule(el: HTMLElement) {
  const r = ruleOf(el);
  if (!r) return;
  const res: any = await api().invoke('rules:test', r);
  const hits = el.querySelector('[data-hits]');
  if (hits) hits.textContent = res.count ? `匹配 ${res.count}` : '无匹配';
  hits?.classList.toggle('zero', !res.count);
  const out = el.querySelector('.testout');
  if (out) out.innerHTML = res.count ? `${icon('ri-checkbox-circle-line')} 当前桌面匹配 ${res.count} 个：${esc(res.names.join('、'))}${res.count > res.names.length ? ' 等' : ''}` : `${icon('ri-information-line')} 当前桌面没有匹配的文件`;
}
function wireRule(el: HTMLElement) {
  const r = ruleOf(el);
  if (!r) return;
  const isDraft = r === draft;
  const idx = rules.indexOf(r);
  const q = <T extends HTMLElement = HTMLElement>(sel: string) => el.querySelector<T>(sel);
  q('.en')?.addEventListener('change', (e) => ((r.enabled = (e.target as HTMLInputElement).checked), saveRules()));
  q('.up')?.addEventListener('click', () => (rules.splice(idx - 1, 0, ...rules.splice(idx, 1)), saveRules()));
  q('.down')?.addEventListener('click', () => (rules.splice(idx + 1, 0, ...rules.splice(idx, 1)), saveRules()));
  q('.del')?.addEventListener('click', () => (rules.splice(idx, 1), saveRules()));
  q('.edit')?.addEventListener('click', () => ((openRule = openRule === r.id ? null : r.id), renderRules()));
  q('.rh .rmain')?.addEventListener('click', () => !isDraft && ((openRule = openRule === r.id ? null : r.id), renderRules()));
  const changed = (rerender = false) => {
    if (isDraft) {
      if (rerender) renderRules();
      else testRule(el);
      return;
    }
    saveRules(rerender);
    if (!rerender) {
      el.querySelector('.rmain small')!.textContent = describeRule(r);
      el.querySelector('.rtitle b')!.textContent = r.name;
      testRule(el);
    }
  };
  q('.rname')?.addEventListener('input', (e) => ((r.name = (e.target as HTMLInputElement).value), changed()));
  q('.rtarget')?.addEventListener('input', (e) => {
    r.target = (e.target as HTMLInputElement).value;
    const t = el.querySelector('.target');
    if (t) t.lastChild!.textContent = r.target;
    changed();
  });
  el.querySelectorAll<HTMLElement>('.rmatch button').forEach((b) => b.addEventListener('click', () => ((r.match = b.dataset.v as Rule['match']), changed(true))));
  q('.addc')?.addEventListener('click', () => (r.conds.push({ field: 'name', op: 'contains', value: '' }), changed(true)));
  el.querySelectorAll<HTMLElement>('.cond').forEach((row) => {
    const c = r.conds[Number(row.dataset.i)];
    row.querySelector('.rm')!.addEventListener('click', () => (r.conds.splice(Number(row.dataset.i), 1), changed(true)));
    row.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-k]').forEach((inp) =>
      inp.addEventListener(inp.tagName === 'INPUT' ? 'input' : 'change', () => {
        const k = inp.dataset.k as keyof RuleCond;
        (c as any)[k] = inp.value;
        if (k === 'field') {
          const f = RULE_FIELDS.find((x) => x.field === c.field)!;
          c.op = f.ops[0].op;
          c.value = c.field === 'category' ? 'doc' : c.field === 'kind' ? 'folder' : '';
          return changed(true);
        }
        changed();
      }),
    );
  });
  q('.keep')?.addEventListener('click', async () => {
    if (!draft) return;
    rules.unshift(draft);
    draft = null;
    await api().invoke('rules:set', rules);
    const n = await api().invoke('rules:apply');
    toast(`已添加规则，归类了 ${n} 个文件`);
    renderRules();
  });
  q('.drop')?.addEventListener('click', () => ((draft = null), renderRules()));
}
$('#addRule').addEventListener('click', () => {
  const r: Rule = { id: uid(), name: '新规则', enabled: true, match: 'all', conds: [{ field: 'ext', op: 'in', value: '' }], target: boxTitles[0] ?? '新格子', source: 'user' };
  rules.unshift(r);
  openRule = r.id;
  saveRules();
});
$('#applyRules').addEventListener('click', async () => {
  const n = await api().invoke('rules:apply');
  toast(`规则已应用：${n} 个文件被重新归类`);
});
async function nlGenerate(text: string) {
  if (!text.trim()) return;
  const btn = $<HTMLButtonElement>('#nlGo');
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner"></span>生成中…`;
  const r: any = await api().invoke('rules:fromText', text);
  btn.disabled = false;
  btn.innerHTML = `${icon('ri-magic-line')}生成规则`;
  if (!r?.rule) return toast(r?.error ?? '没能理解这句话，换个说法试试', 'bad');
  draft = { ...r.rule, id: uid() };
  renderRules();
  if (r.via === 'local') toast('未配置 AI：已用本地解析生成规则');
}
$('#nlGo').addEventListener('click', () => nlGenerate($<HTMLInputElement>('#nlText').value));
$('#nlText').addEventListener('keydown', (e) => e.key === 'Enter' && nlGenerate($<HTMLInputElement>('#nlText').value));
$$('.nlhints .chip').forEach((c) =>
  c.addEventListener('click', () => {
    $<HTMLInputElement>('#nlText').value = c.textContent ?? '';
    nlGenerate(c.textContent ?? '');
  }),
);
function draftFromPayload(p: { ext?: string; target?: string; text?: string }) {
  if (p.text) {
    $<HTMLInputElement>('#nlText').value = p.text;
    nlGenerate(p.text);
    return;
  }
  if (!p?.ext) return;
  draft = { id: uid(), name: `${p.ext} 放入${p.target ?? ''}`, enabled: true, match: 'all', conds: [{ field: 'ext', op: 'in', value: p.ext }], target: p.target ?? '新格子', source: 'user' };
  renderRules();
}
api().on('settings:rules', (r: Rule[]) => ((rules = r), renderRules()));
async function loadRules() {
  const r: any = await api().invoke('rules:get');
  rules = r.rules;
  boxTitles = r.boxes;
  renderRules();
}

// ---------------------------------------------------------------- pages + snapshots
async function loadPages() {
  const d: any = await api().invoke('pages:get');
  $('#pageList').innerHTML = (d.pages as string[])
    .map(
      (p, i) => `<div class="prow2${i === d.page ? ' cur' : ''}" data-i="${i}">
        <span class="pidx">${i + 1}</span>
        <input class="field pname2" value="${esc(p)}" maxlength="16" spellcheck="false">
        <span class="muted small">${d.counts[i]} 个格子</span>
        ${i === d.page ? `<span class="pill ok"><i class="dot"></i>当前</span>` : `<button class="btn go">${icon('ri-arrow-right-line')}切换</button>`}
        <button class="tb pdel" title="删除此页（格子移到上一页）"${d.pages.length <= 1 ? ' disabled' : ''}>${icon('ri-delete-bin-6-line')}</button>
      </div>`,
    )
    .join('');
  $$('#pageList .prow2').forEach((row) => {
    const i = Number(row.dataset.i);
    row.querySelector('.pname2')!.addEventListener('change', (e) => api().invoke('pages:rename', i, (e.target as HTMLInputElement).value).then(flashSaved));
    row.querySelector('.go')?.addEventListener('click', () => api().invoke('pages:go', i).then(loadPages));
    row.querySelector('.pdel')!.addEventListener('click', () => api().invoke('pages:delete', i).then(loadPages));
  });
  renderSnaps(d.snapshots);
  $('#resNow').textContent = `当前 ${String(d.resolution).replace('@', '，缩放 ')}；开启后会按「宽x高@缩放」分别记忆格子位置`;
  const dpi = $('#dpiHint');
  if (dpi) dpi.textContent = `当前键：${d.resolution}。换主屏、改系统缩放（125%/150%）或跨屏拖动时，格子会按最近显示器工作区吸附；建议为常用分辨率各存一份快照。`;
}
function renderSnaps(list: Snapshot[]) {
  const fmt = (t: number) => {
    const d = new Date(t);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };
  $('#snapList').innerHTML = list.length
    ? list
        .map(
          (sn) => `<div class="snap" data-id="${sn.id}"><span class="fi sm" style="--g:#4f7cff">${icon('ri-layout-4-line')}</span>
          <div class="sm2"><input class="sname" value="${esc(sn.name)}" maxlength="30" spellcheck="false"><small>${fmt(sn.at)} · ${sn.boxes.length} 个格子 · ${sn.pages.length} 页 · <span class="chip2">${esc(sn.resolution.replace(/@.*/, ''))}</span></small></div>
          <button class="btn restore">${icon('ri-history-line')}恢复</button><button class="tb sdel" title="删除快照">${icon('ri-delete-bin-6-line')}</button></div>`,
        )
        .join('')
    : `<div class="muted small pad">还没有快照</div>`;
  $$('#snapList .snap').forEach((el) => {
    const id = el.dataset.id!;
    el.querySelector('.restore')!.addEventListener('click', () => api().invoke('snap:restore', id).then(() => toast('已恢复布局，可在托盘菜单撤销')));
    el.querySelector('.sdel')!.addEventListener('click', () => api().invoke('snap:delete', id).then(loadPages));
    el.querySelector('.sname')!.addEventListener('change', (e) => api().invoke('snap:rename', id, (e.target as HTMLInputElement).value).then(flashSaved));
  });
}
api().on('settings:snapshots', renderSnaps);
$('#addPage').addEventListener('click', () => api().invoke('pages:add').then(loadPages));
$('#snapSave').addEventListener('click', async () => {
  await api().invoke('snap:save', $<HTMLInputElement>('#snapName').value.trim());
  $<HTMLInputElement>('#snapName').value = '';
  toast('快照已保存');
  loadPages();
});

// content index (AI 功能)
async function loadIndexState() {
  const st: any = await api().invoke('content:status').catch(() => null);
  if (st) $('#idxState').textContent = `为桌面上的 txt / md / pdf / docx 建立本地全文索引，搜索时可按内容找到文件。${st.files ? `已索引 ${st.files} 个文件` : '尚未建立索引'}${st.embedded ? `，其中 ${st.embedded} 个含语义向量` : ''}。`;
}
$('#rebuildIdx').addEventListener('click', async () => {
  $('#idxState').textContent = '正在重建索引…';
  await api().invoke('content:rebuild').catch(() => null);
  loadIndexState();
});
$('#embedModel').addEventListener('change', (e) => save({ embedModel: (e.target as HTMLInputElement).value.trim() }));

// actions + backup
$$('[data-action]').forEach((b) => b.addEventListener('click', () => api().invoke('app:action', b.dataset.action)));
$('#export').addEventListener('click', async () => {
  const r: any = await api().invoke('settings:export', $<HTMLInputElement>('#exportKey').checked);
  if (r.msg !== '已取消') toast(r.msg, r.ok ? 'ok' : 'bad');
});
$('#import').addEventListener('click', async () => {
  const r: any = await api().invoke('settings:import');
  if (r.msg === '已取消') return;
  toast(r.msg, r.ok ? 'ok' : 'bad');
  if (r.ok) load();
});

// window controls (non-Windows: draw our own; Windows uses the native title bar overlay)
$('#wMin').addEventListener('click', () => api().invoke('win:minimize'));
$('#wMax').addEventListener('click', () => api().invoke('win:maximize'));
$('#wClose').addEventListener('click', () => api().invoke('win:close'));


// ---------------------------------------------------------------- learning corrections
async function loadLearn() {
  const list = $('#learnList');
  if (!list) return;
  const rows: { name: string; ext: string; to: string; at: number }[] = await api().invoke('corrections:list');
  const pill = $('#learnState');
  if (pill) {
    pill.className = 'pill ' + (rows.length ? 'ok' : '');
    pill.innerHTML = `<i class="dot"></i>${rows.length} 条记录`;
  }
  // group by ext+to
  const groups = new Map<string, { ext: string; to: string; items: typeof rows }>();
  for (const c of rows) {
    const k = `${c.ext}|${c.to}`;
    const g = groups.get(k) ?? { ext: c.ext, to: c.to, items: [] };
    g.items.push(c);
    groups.set(k, g);
  }
  if (!groups.size) {
    list.innerHTML = `<div class="empty-card">${icon('ri-lightbulb-flash-line')}<b>还没有纠正记录</b><small>把桌面文件拖进某个格子后会出现在这里</small></div>`;
    return;
  }
  list.innerHTML = [...groups.values()]
    .map((g) => {
      const samples = g.items.slice(0, 5).map((c) => esc(c.name + c.ext)).join('、');
      const more = g.items.length > 5 ? ` 等 ${g.items.length} 个` : '';
      return `<div class="rule-card learn-card">
        <div class="rh"><span class="fi sm" style="--g:#e8a92c">${icon('ri-lightbulb-flash-line')}</span>
          <div class="rt"><b>${esc(g.ext)} → 「${esc(g.to)}」</b><small>${g.items.length} 次 · ${samples}${more}</small></div>
          <div class="inline">
            <button class="btn mk" data-ext="${esc(g.ext)}" data-to="${esc(g.to)}">${icon('ri-filter-3-line')}生成规则</button>
            <button class="tb delg" title="删除本组" data-ext="${esc(g.ext)}" data-to="${esc(g.to)}">${icon('ri-delete-bin-6-line')}</button>
          </div>
        </div>
        <div class="learn-items">${g.items
          .map(
            (c) =>
              `<div class="learn-row"><span>${esc(c.name + c.ext)}</span><span class="muted small">${new Date(c.at).toLocaleString()}</span><button class="tb del1" data-at="${c.at}" data-name="${esc(c.name)}" data-ext="${esc(c.ext)}" data-to="${esc(c.to)}">${icon('ri-close-line')}</button></div>`,
          )
          .join('')}</div>
      </div>`;
    })
    .join('');
  list.querySelectorAll('.mk').forEach((b) =>
    b.addEventListener('click', async () => {
      const el = b as HTMLElement;
      await api().invoke('corrections:makeRule', el.dataset.ext, el.dataset.to);
      toast('已生成规则');
      showSection('rules');
      await loadRules();
    }),
  );
  list.querySelectorAll('.del1').forEach((b) =>
    b.addEventListener('click', async () => {
      const el = b as HTMLElement;
      await api().invoke('corrections:delete', Number(el.dataset.at), el.dataset.name, el.dataset.ext, el.dataset.to);
      await loadLearn();
    }),
  );
  list.querySelectorAll('.delg').forEach((b) =>
    b.addEventListener('click', async () => {
      const el = b as HTMLElement;
      const rows: any[] = await api().invoke('corrections:list');
      for (const c of rows) {
        if (c.ext === el.dataset.ext && c.to === el.dataset.to) {
          await api().invoke('corrections:delete', c.at, c.name, c.ext, c.to);
        }
      }
      await loadLearn();
    }),
  );
}
$('#learnRefresh')?.addEventListener('click', () => loadLearn());
$('#learnClear')?.addEventListener('click', async () => {
  if (!confirm('清空全部纠正记录？')) return;
  await api().invoke('corrections:clear');
  await loadLearn();
});


async function load() {
  info = await api().invoke('settings:get');
  current = info.settings;
  $<HTMLInputElement>('#baseURL').value = current.ai.baseURL;
  $<HTMLInputElement>('#apiKey').value = current.ai.apiKey;
  $<HTMLInputElement>('#model').value = current.ai.model;
  $<HTMLInputElement>('#temperature').value = String(current.ai.temperature);
  $('#tempVal').textContent = current.ai.temperature.toFixed(1);
  markPreset();
  updateAIState();
  bindSegment('theme');
  bindSegment('rollupOn');
  bindSegment('snapGrid');
  bindRange('tintStrength', (v) => Math.round(v * 100) + '%');
  {
    const tc = $<HTMLInputElement>('#tintColor');
    tc.value = current.tintColor || '#4f7cff';
    tc.classList.toggle('dim', !current.tintColor);
    tc.oninput = () => (tc.classList.remove('dim'), save({ tintColor: tc.value }));
    $('#tintColorReset').onclick = () => (tc.classList.add('dim'), save({ tintColor: '' }));
    // colour/strength only matter while global tint is on
    const row = tc.closest('.setting') as HTMLElement;
    const sync = () => row.classList.toggle('is-off', !$<HTMLInputElement>('#tintAll').checked);
    $<HTMLInputElement>('#tintAll').addEventListener('change', sync);
    row.classList.toggle('is-off', !current.tintAll);
  }
  for (const k of ['groupGap', 'headerMode', 'drawFence', 'desktopRightClick', 'quickHideMode'] as const) bindSegment(k);
  $<HTMLInputElement>('#embedModel').value = current.embedModel ?? '';
  bindRange('opacity', (v) => Math.round(v * 100) + '%');
  bindRange('iconSize', (v) => v + ' px');
  bindRange('recentCount', (v) => v + ' 个');
  (
    ['autoStart', 'embedDesktop', 'keepBottom', 'dblClickDesktop', 'desktopContextMenu', 'acrylic', 'scanPublicDesktop', 'hoverPeek', 'snapEdges', 'chameleon', 'tintAll', 'iconMultiples', 'hideScrollbars', 'nativeItemMenu', 'autoResolution', 'autoPlace', 'learnFromMoves', 'contentIndex', 'dailyBriefing'] as (keyof Settings)[]
  ).forEach(bindToggle);
  hotkeyCapture($<HTMLInputElement>('#hotkeyPeek'), 'hotkeyPeek');
  hotkeyCapture($<HTMLInputElement>('#hotkeyPageNext'), 'hotkeyPageNext');
  hotkeyCapture($<HTMLInputElement>('#hotkeyPagePrev'), 'hotkeyPagePrev');
  const lf2 = document.getElementById('learnFromMoves2') as HTMLInputElement | null;
  if (lf2) {
    lf2.checked = !!current.learnFromMoves;
    lf2.onchange = () => {
      const main = document.getElementById('learnFromMoves') as HTMLInputElement | null;
      if (main) main.checked = lf2.checked;
      void save({ learnFromMoves: lf2.checked });
    };
  }
  const lrm = document.getElementById('learnRuleMin') as HTMLInputElement | null;
  if (lrm) {
    lrm.value = String(current.learnRuleMin ?? 3);
    const lv = document.getElementById('learnRuleMinVal');
    if (lv) lv.textContent = String(current.learnRuleMin ?? 3) + ' 次';
    lrm.oninput = () => {
      const n = Number(lrm.value);
      if (lv) lv.textContent = n + ' 次';
      void save({ learnRuleMin: n } as Partial<Settings>);
    };
  }
  await Promise.all([loadRules(), loadPages(), loadIndexState()]);
  if (info.pending) draftFromPayload(info.pending);
  hotkeyCapture($<HTMLInputElement>('#hotkeySearch'), 'hotkeySearch');
  hotkeyCapture($<HTMLInputElement>('#hotkeyChat'), 'hotkeyChat');
  hotkeyCapture($<HTMLInputElement>('#hotkeyToggle'), 'hotkeyToggle');
  showHotkeys(info.hotkeys);
  const hk = document.getElementById('hkConflict');
  if (hk) {
    if (info.hotkeyConflicts?.length) {
      hk.hidden = false;
      hk.textContent = '冲突：' + info.hotkeyConflicts.join('；');
    } else hk.hidden = true;
  }
  const win = info.platform === 'win32';
  $$('.win-only').forEach((el) => {
    el.classList.toggle('disabled', !win);
    el.querySelectorAll('input').forEach((i) => ((i as HTMLInputElement).disabled = !win));
  });
  if (!win && info.platform !== 'darwin') {
    $<HTMLInputElement>('#autoStart').disabled = true;
    $('#autoStart').closest('.setting')?.classList.add('disabled');
  }
  $('#ver').textContent = `版本 ${info.version}`;
  $('#aboutList').innerHTML = [
    ['版本', `${info.version}（Electron ${info.electron}）`],
    ['平台', info.platform],
    ['数据目录', info.dataDir],
    ['扫描的桌面', info.desktopDirs.join('；') || '（未找到）'],
    ['当前', `${info.boxes} 个格子 · ${info.items} 个桌面项目`],
  ]
    .map(([k, v]) => `<div class="kv"><span>${esc(k)}</span><b>${esc(String(v))}</b></div>`)
    .join('');
}

renderPresets();
load().then(() => showSection(initialSec || 'ai'));
document.documentElement.dataset.platform = api().platform;

// ---- settings search filter
const $setSearch = document.getElementById('setSearch') as HTMLInputElement | null;
$setSearch?.addEventListener('input', () => {
  const q = ($setSearch.value || '').trim().toLowerCase();
  document.querySelectorAll('.setting, .nav-item, .action, .group-title').forEach((el) => {
    const text = (el.textContent || '').toLowerCase();
    const hide = !!q && !text.includes(q);
    (el as HTMLElement).style.display = hide ? 'none' : '';
  });
  if (q) {
    // reveal sections that have visible settings
    document.querySelectorAll('.panel').forEach((panel) => {
      const any = [...panel.querySelectorAll('.setting, .action')].some((x) => (x as HTMLElement).style.display !== 'none');
      (panel as HTMLElement).dataset.searchHit = any ? '1' : '0';
    });
  }
});
