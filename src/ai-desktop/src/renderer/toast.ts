import { $, api, esc, icon, initTheme } from './common';
import type { ToastPayload } from '../shared/types';

initTheme();
const ICON = { info: 'ri-information-fill', success: 'ri-checkbox-circle-fill', warning: 'ri-error-warning-fill', error: 'ri-close-circle-fill' };
const card = $('#card');
api().on('toast:show', (t: ToastPayload) => {
  card.className = 'tcard ' + t.kind;
  card.innerHTML =
    `<div class="ti">${icon(ICON[t.kind])}</div><div class="tbody"><div class="tt">${esc(t.title)}</div>${t.message ? `<div class="tm">${esc(t.message)}</div>` : ''}</div>` +
    (t.action ? `<button class="ta" data-cmd="${esc(t.action.command)}">${esc(t.action.label)}</button>` : '') +
    `<button class="tx" title="关闭">${icon('ri-close-line')}</button><div class="bar" style="animation-duration:${t.timeout ?? 5000}ms"></div>`;
  void card.offsetWidth;
  card.classList.add('show');
  card.querySelector<HTMLElement>('.ta')?.addEventListener('click', (e) => api().invoke('toast:action', (e.currentTarget as HTMLElement).dataset.cmd));
  card.querySelector<HTMLElement>('.tx')!.addEventListener('click', () => api().invoke('toast:close'));
});
api().on('toast:hide', () => card.classList.remove('show'));
