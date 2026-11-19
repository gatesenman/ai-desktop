import { $, $$, api, esc, icon, initTheme } from './common';

initTheme();
let step = 0;
const panels = $$<HTMLElement>('.ob-panel[data-step]');
const choice = { organize: 'rules' as 'rules' | 'ai' | 'keep' };

function go(n: number) {
  step = Math.max(0, Math.min(panels.length - 1, n));
  // Only the active panel is visible: unique .ob-panel + .is-active (never reuse .step / .active for display).
  panels.forEach((p) => {
    const i = Number(p.dataset.step);
    p.classList.toggle('is-active', i === step);
    p.hidden = i !== step;
    p.setAttribute('aria-hidden', i === step ? 'false' : 'true');
  });
  $$('.ob-dots .ob-dot').forEach((d, i) => d.classList.toggle('is-on', i <= step));
  $('#back').style.visibility = step === 0 ? 'hidden' : 'visible';
  $('#next').innerHTML = step === panels.length - 1 ? `开始使用 ${icon('ri-arrow-right-line')}` : `下一步 ${icon('ri-arrow-right-line')}`;
  $('#stepNo').textContent = `${step + 1} / ${panels.length}`;
  // keep active panel scrolled to top so footer never covers content
  panels.find((p) => Number(p.dataset.step) === step)?.scrollTo({ top: 0 });
}
$('#next').addEventListener('click', () => {
  if (step < panels.length - 1) return go(step + 1);
  api().invoke('onboard:finish', {
    organize: choice.organize,
    recent: $<HTMLInputElement>('#obRecent').checked,
    autoStart: $<HTMLInputElement>('#obAuto').checked,
  });
});
$('#back').addEventListener('click', () => go(step - 1));
$('#skip').addEventListener('click', () => api().invoke('onboard:finish', { organize: 'keep', recent: false, autoStart: false }));
$$('.opt').forEach((o) =>
  o.addEventListener('click', () => {
    $$('.opt').forEach((x) => x.classList.toggle('active', x === o));
    choice.organize = o.dataset.v as any;
  }),
);

// quick AI setup
const PRE: Record<string, [string, string]> = {
  deepseek: ['https://api.deepseek.com/v1', 'deepseek-chat'],
  qwen: ['https://dashscope.aliyuncs.com/compatible-mode/v1', 'qwen-plus'],
  openai: ['https://api.openai.com/v1', 'gpt-4o-mini'],
  moonshot: ['https://api.moonshot.cn/v1', 'moonshot-v1-8k'],
  ollama: ['http://localhost:11434/v1', 'qwen2.5:7b'],
};
$('#obTest').addEventListener('click', async () => {
  const [baseURL, model] = PRE[$<HTMLSelectElement>('#obPreset').value];
  const apiKey = $<HTMLInputElement>('#obKey').value.trim();
  const out = $('#obOut');
  out.className = 'status-line busy';
  out.innerHTML = `<span class="spinner"></span>正在连接…`;
  const r: any = await api().invoke('settings:test', { ai: { baseURL, model, apiKey } });
  out.className = 'status-line ' + (r.ok ? 'ok' : 'bad');
  out.innerHTML = `${icon(r.ok ? 'ri-checkbox-circle-fill' : 'ri-close-circle-fill')}<span>${esc(r.msg)}</span>`;
  if (r.ok) await api().invoke('settings:set', { ai: { baseURL, model, apiKey, temperature: 0.3 } });
});
$('#close').addEventListener('click', () => api().invoke('onboard:finish', { organize: 'keep', recent: false, autoStart: false }));
api()
  .invoke('settings:get')
  .then((r: any) => {
    $$('[data-hk]').forEach((el) => (el.textContent = r.hotkeys[el.dataset.hk!] || '未设置'));
    if (r.platform !== 'win32' && r.platform !== 'darwin') ($('#obAuto') as HTMLInputElement).disabled = true;
  });
go(0);
