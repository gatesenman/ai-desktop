import { $, $$, api, applyTheme, esc, icon } from './common';
import { BOX_COLORS, BOX_ICONS, BoxState } from '../shared/types';

const boxId = new URLSearchParams(location.search).get('box') || '';
let box: BoxState;
let globalAlpha = 0.6;

function paint() {
  const root = document.documentElement.style;
  root.setProperty('--box-accent', box.color || 'var(--accent)');
  root.setProperty('--tint', String(box.color ? box.tint ?? 0.35 : 0));
  root.setProperty('--pv-alpha', String(box.alpha ?? globalAlpha));
  $('#pvIcon').innerHTML = icon(box.icon || 'ri-inbox-2-line');
  $('#pvTitle').textContent = box.title;
  $('#pv').className = `pv t-${box.titleStyle ?? 'band'}${box.titleAlign === 'left' ? ' left' : ''}${box.color ? ' has-accent' : ''}`;
  $$('.sw').forEach((s) => s.classList.toggle('active', (s.dataset.c ?? '') === (box.color ?? '')));
  $$('.ib').forEach((s) => s.classList.toggle('active', s.dataset.i === (box.icon || 'ri-inbox-2-line')));
  const tint = $<HTMLInputElement>('#tint');
  tint.value = String(box.tint ?? 0.35);
  tint.disabled = !box.color;
  tint.style.setProperty('--p', `${(box.tint ?? 0.35) * 100}%`);
  $('#tintVal').textContent = box.color ? `${Math.round((box.tint ?? 0.35) * 100)}%` : '—';
  const a = box.alpha ?? globalAlpha;
  const alpha = $<HTMLInputElement>('#alpha');
  alpha.value = String(a);
  alpha.style.setProperty('--p', `${((a - 0.15) / 0.85) * 100}%`);
  $('#alphaVal').textContent = `${Math.round(a * 100)}%`;
  $('#alphaReset').classList.toggle('on', box.alpha === undefined);
  $$('#tstyle button').forEach((b) => b.classList.toggle('active', b.dataset.v === (box.titleStyle ?? 'band')));
  $$('#talign button').forEach((b) => b.classList.toggle('active', b.dataset.v === (box.titleAlign ?? 'center')));
  $$('#tabstyle button').forEach((b) => b.classList.toggle('active', b.dataset.v === (box.tabStyle ?? 'pill')));
  $('#pvIcon').style.display = box.hideTitleIcon ? 'none' : '';
  for (const k of ['iconTint', 'locked', 'keepOnHide', 'hideTitleIcon'] as const) $<HTMLInputElement>('#' + k).checked = !!box[k];
  // v1.3 title font / size / colour, per-fence icon size (Fences personalisation)
  $<HTMLSelectElement>('#tfont').value = box.titleFont ?? '';
  const ts = box.titleSize ?? 12.5;
  const tsEl = $<HTMLInputElement>('#tsize');
  tsEl.value = String(Math.round(ts));
  tsEl.style.setProperty('--p', `${((ts - 10) / 14) * 100}%`);
  $('#tsizeVal').textContent = box.titleSize ? `${box.titleSize}px` : '默认';
  $<HTMLInputElement>('#tcolor').value = box.titleColor || '#ffffff';
  $('#tcolorReset').classList.toggle('on', !box.titleColor);
  const is = box.iconSizeOverride ?? globalIcon;
  const isEl = $<HTMLInputElement>('#isize');
  isEl.value = String(is);
  isEl.style.setProperty('--p', `${((is - 24) / 48) * 100}%`);
  $('#isizeVal').textContent = box.iconSizeOverride ? `${is}px` : '全局';
  $('#isizeReset').classList.toggle('on', !box.iconSizeOverride);
  const pvt = $('#pvTitle');
  pvt.style.fontFamily = box.titleFont ? `"${box.titleFont}"` : '';
  pvt.style.fontSize = box.titleSize ? box.titleSize + 'px' : '';
  pvt.style.color = box.titleColor || '';
}
let globalIcon = 40;
function set(patch: Partial<BoxState> | Record<string, unknown>) {
  Object.assign(box, patch);
  if ((patch as any).alpha === null) delete box.alpha;
  if ((patch as any).titleSize === null) delete box.titleSize;
  if ((patch as any).iconSizeOverride === null) delete box.iconSizeOverride;
  paint();
  api().invoke('appearance:set', boxId, patch);
}

api()
  .invoke('appearance:get', boxId)
  .then((r: any) => {
    if (!r) return;
    applyTheme(r);
    globalAlpha = r.opacity ?? 0.6;
    globalIcon = r.iconSize ?? 40;
    box = r.box;
    $<HTMLInputElement>('#name').value = box.title;
    $('#colors').innerHTML = BOX_COLORS.map(
      (c) => `<button class="sw${c.value ? '' : ' none'}" data-c="${c.value}" title="${esc(c.name)}" style="--c:${c.value || 'transparent'}">${c.value ? icon('ri-check-line') : icon('ri-forbid-line')}</button>`,
    ).join('');
    $('#icons').innerHTML = BOX_ICONS.map((i) => `<button class="ib" data-i="${i}">${icon(i)}</button>`).join('');
    $$('.sw').forEach((s) => s.addEventListener('click', () => set({ color: s.dataset.c ?? '' })));
    $$('.ib').forEach((s) => s.addEventListener('click', () => set({ icon: s.dataset.i })));
    paint();
    requestAnimationFrame(() => document.body.classList.add('show'));
  });
$('#tint').addEventListener('input', (e) => set({ tint: Number((e.target as HTMLInputElement).value) }));
$('#alpha').addEventListener('input', (e) => set({ alpha: Number((e.target as HTMLInputElement).value) }));
$('#alphaReset').addEventListener('click', () => set({ alpha: null }));
$$('#tstyle button').forEach((b) => b.addEventListener('click', () => set({ titleStyle: b.dataset.v as BoxState['titleStyle'] })));
$$('#tabstyle button').forEach((b) => b.addEventListener('click', () => set({ tabStyle: b.dataset.v as BoxState['tabStyle'] })));
$$('#talign button').forEach((b) => b.addEventListener('click', () => set({ titleAlign: b.dataset.v as BoxState['titleAlign'] })));
for (const k of ['iconTint', 'locked', 'keepOnHide', 'hideTitleIcon'] as const) $('#' + k).addEventListener('change', (e) => set({ [k]: (e.target as HTMLInputElement).checked }));
$('#name').addEventListener('change', () => {
  const v = $<HTMLInputElement>('#name').value.trim();
  if (v) set({ title: v });
});
$('#name').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') ($(`#name`) as HTMLInputElement).blur();
});
$('#tfont').addEventListener('change', (e) => set({ titleFont: (e.target as HTMLSelectElement).value }));
$('#tsize').addEventListener('input', (e) => set({ titleSize: Number((e.target as HTMLInputElement).value) }));
$('#tsizeReset').addEventListener('click', () => set({ titleSize: null }));
$('#tcolor').addEventListener('input', (e) => set({ titleColor: (e.target as HTMLInputElement).value }));
$('#tcolorReset').addEventListener('click', () => set({ titleColor: '' }));
$('#isize').addEventListener('input', (e) => set({ iconSizeOverride: Number((e.target as HTMLInputElement).value) }));
$('#isizeReset').addEventListener('click', () => set({ iconSizeOverride: null }));
$('#close').addEventListener('click', () => api().invoke('win:close'));
document.addEventListener('keydown', (e) => e.key === 'Escape' && api().invoke('win:close'));
api().on('theme', applyTheme);
