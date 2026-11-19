import { $, api, esc, icon, initTheme, md } from './common';
import type { ChatMessage, StreamEvent } from '../shared/types';

initTheme();
interface Msg extends ChatMessage {
  file?: { name: string; chars: number; truncated: boolean };
  el?: HTMLElement;
}
const $log = $('#log');
const $input = $<HTMLTextAreaElement>('#input');
const $send = $<HTMLButtonElement>('#send');
const $model = $('#model');
const $pin = $('#pin');

const history: Msg[] = [];
let streaming: string | null = null;
let configured = false;

const AVATAR = `<div class="avatar">${icon('ri-sparkling-2-fill')}</div>`;

function fileIcon(name: string) {
  const ext = name.split('.').pop()?.toLowerCase();
  if (ext === 'pdf') return ['ri-file-pdf-2-line', '#e5484d'];
  if (ext === 'docx' || ext === 'doc') return ['ri-file-word-2-line', '#2b6be6'];
  if (ext === 'md') return ['ri-markdown-line', '#7b8798'];
  return ['ri-file-text-line', '#7b8798'];
}

function addMsg(role: 'user' | 'assistant' | 'note', html: string, cls = ''): HTMLElement {
  $log.querySelector('.welcome')?.remove();
  const el = document.createElement('div');
  el.className = `msg ${role} ${cls}`;
  el.innerHTML =
    role === 'assistant'
      ? `${AVATAR}<div class="col"><div class="b">${html}</div><div class="acts"><button class="act copy-msg" title="复制">${icon('ri-file-copy-line')}</button></div></div>`
      : `<div class="b">${html}</div>`;
  $log.appendChild(el);
  scrollDown();
  return el;
}
const scrollDown = () => ($log.scrollTop = $log.scrollHeight);

function welcome() {
  $log.innerHTML = '';
  const el = document.createElement('div');
  el.className = 'welcome';
  el.innerHTML = configured
    ? `<div class="hero">${icon('ri-sparkling-2-fill')}</div><h2>有什么可以帮你？</h2><p>可以直接提问，也可以让我总结桌面上的 txt / pdf / docx 文件</p>
       <div class="chips">
        <button data-act="file">${icon('ri-file-text-line')}总结一个文件</button>
        <button data-q="桌面上哪些文件可能可以清理或归档？">${icon('ri-delete-bin-6-line')}哪些文件可以清理？</button>
        <button data-q="帮我设计一套桌面文件夹的命名规范，适合办公使用。">${icon('ri-folder-transfer-line')}文件夹命名规范</button>
        <button data-q="写一个 PowerShell 脚本，把下载文件夹里超过 30 天的文件移动到归档目录。">${icon('ri-terminal-box-line')}写个整理脚本</button>
       </div>`
    : `<div class="hero off">${icon('ri-robot-2-line')}</div><h2>尚未配置 AI</h2><p>在设置中填写 API 地址、Key 与模型即可使用。<br>支持 DeepSeek、通义千问、OpenAI、Kimi、智谱、Ollama 等 OpenAI 兼容接口。</p>
       <div class="chips"><button data-act="settings" class="primary-chip">${icon('ri-settings-3-line')}去配置</button></div>`;
  $log.appendChild(el);
}

async function refreshStatus() {
  const s: any = await api().invoke('chat:status');
  const was = configured;
  configured = s.configured;
  $model.innerHTML = `<i class="dot"></i>${esc(configured ? s.model : '未配置')}`;
  $model.classList.toggle('off', !configured);
  if (was !== configured && !history.length) welcome();
}

function send(content: string, file?: Msg['file']) {
  if (streaming || !content.trim()) return;
  if (!configured) {
    addMsg('note', `${icon('ri-error-warning-line')} 未配置 AI，无法发送。<button class="link-btn" data-act="settings">打开设置</button>`);
    refreshStatus();
    return;
  }
  const user: Msg = { role: 'user', content, file };
  history.push(user);
  if (file) {
    const [ic, col] = fileIcon(file.name);
    addMsg(
      'user',
      `<div class="filecard"><span class="fi" style="--g:${col}">${icon(ic)}</span><div><div class="fn">${esc(file.name)}</div><div class="fs">${file.chars.toLocaleString()} 字${
        file.truncated ? ' · 已截取前部分' : ''
      } · 请求总结</div></div></div>`,
      'file',
    );
  } else addMsg('user', esc(content).replace(/\n/g, '<br>'));
  const asst: Msg = { role: 'assistant', content: '' };
  asst.el = addMsg('assistant', `<span class="typing"><i></i><i></i><i></i></span>`);
  asst.el.classList.add('pending');
  history.push(asst);
  const id = Math.random().toString(36).slice(2);
  streaming = id;
  setSending(true);
  api().invoke(
    'chat:send',
    id,
    history.filter((m) => m !== asst).map((m) => ({ role: m.role, content: m.content })),
  );
}

function setSending(on: boolean) {
  $send.classList.toggle('stop', on);
  $send.innerHTML = icon(on ? 'ri-stop-fill' : 'ri-send-plane-2-fill');
  $send.title = on ? '停止生成' : '发送（Enter）';
}

let raf = 0;
api().on('chat:stream', (ev: StreamEvent) => {
  if (ev.id !== streaming) return;
  const asst = history[history.length - 1];
  const b = asst.el!.querySelector('.b') as HTMLElement;
  if (ev.delta) {
    asst.content += ev.delta;
    asst.el!.classList.remove('pending');
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      b.innerHTML = md(asst.content, true) + '<span class="caret"></span>';
      scrollDown();
    });
  }
  if (ev.error) {
    cancelAnimationFrame(raf);
    asst.el!.classList.remove('pending');
    b.innerHTML = (asst.content ? md(asst.content) : '') + `<div class="err">${icon('ri-close-circle-line')} ${esc(ev.error)}</div>`;
    if (!asst.content) history.splice(history.length - 2, 2);
  }
  if (ev.done) {
    cancelAnimationFrame(raf);
    streaming = null;
    setSending(false);
    if (!ev.error) b.innerHTML = asst.content ? md(asst.content) : '<span class="muted">（无回复）</span>';
    scrollDown();
  }
});

async function summarize(path: string) {
  const r: any = await api().invoke('chat:prepareFile', path);
  if (!r.ok) {
    addMsg('note', `${icon('ri-close-circle-line')} 无法读取文件：${esc(r.error)}`);
    return;
  }
  send(r.prompt, { name: r.name, chars: r.chars, truncated: r.truncated });
}
async function pickFile() {
  const p = (await api().invoke('chat:pickFile')) as string | null;
  if (p) summarize(p);
}

function autosize() {
  $input.style.height = 'auto';
  $input.style.height = Math.min(160, $input.scrollHeight) + 'px';
  $send.disabled = !streaming && !$input.value.trim();
}

$send.addEventListener('click', () => {
  if (streaming) {
    api().invoke('chat:abort', streaming);
    return;
  }
  const v = $input.value;
  $input.value = '';
  autosize();
  send(v);
});
$input.addEventListener('input', autosize);
$input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    if (!streaming) $send.click();
  }
  if (e.key === 'Escape') api().invoke('win:hide');
});
$log.addEventListener('click', (e) => {
  const t = e.target as HTMLElement;
  const copy = t.closest<HTMLElement>('.copy');
  if (copy) {
    const code = copy.closest('.code')!.querySelector('code')!.textContent ?? '';
    api().invoke('clipboard:write', code);
    copy.innerHTML = `${icon('ri-check-line')}<span>已复制</span>`;
    setTimeout(() => (copy.innerHTML = `${icon('ri-file-copy-line')}<span>复制</span>`), 1500);
    return;
  }
  const cm = t.closest<HTMLElement>('.copy-msg');
  if (cm) {
    const el = cm.closest('.msg')!;
    const m = history.find((x) => x.el === el);
    if (m) api().invoke('clipboard:write', m.content);
    cm.innerHTML = icon('ri-check-line');
    setTimeout(() => (cm.innerHTML = icon('ri-file-copy-line')), 1500);
    return;
  }
  const chip = t.closest<HTMLElement>('[data-q],[data-act]');
  if (chip?.dataset.q) send(chip.dataset.q);
  if (chip?.dataset.act === 'file') pickFile();
  if (chip?.dataset.act === 'settings') api().invoke('app:action', 'settings-ai');
});
$('#file').addEventListener('click', pickFile);
$('#clear').addEventListener('click', () => {
  if (streaming) api().invoke('chat:abort', streaming);
  history.length = 0;
  welcome();
});
let pinned = false;
$pin.addEventListener('click', () => {
  pinned = !pinned;
  $pin.classList.toggle('on', pinned);
  $pin.innerHTML = icon(pinned ? 'ri-pushpin-fill' : 'ri-pushpin-line');
  api().invoke('win:pin', pinned);
});
$('#settings').addEventListener('click', () => api().invoke('app:action', 'settings-ai'));
$('#close').addEventListener('click', () => api().invoke('win:hide'));
$('#min').addEventListener('click', () => api().invoke('win:minimize'));
api().on('chat:summarizeFile', (p: string) => summarize(p));
api().on('chat:ask', (q: string) => send(q));
window.addEventListener('focus', refreshStatus);

refreshStatus().then(() => {
  if (!history.length) welcome();
});
autosize();
$input.focus();
