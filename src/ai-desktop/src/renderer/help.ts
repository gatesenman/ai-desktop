import { $, api, esc, initTheme } from './common';

initTheme();
const FALLBACK: [string, string][] = [
  ['快速搜索 / AI 命令', 'Alt+Space'],
  ['AI 助手', 'Alt+Shift+A'],
  ['快速隐藏 / 显示格子', 'Alt+Shift+D'],
  ['Peek（格子置顶）', 'Alt+Shift+F'],
  ['下一桌面页', 'Ctrl+Alt+Right'],
  ['上一桌面页', 'Ctrl+Alt+Left'],
  ['方向键', '移动选择'],
  ['Enter', '打开选中项'],
  ['Ctrl+A', '全选'],
  ['在空白处拖动', '框选多个图标'],
  ['F2 / 双击名称', '重命名格子（选中文件夹映射项时重命名文件）'],
  ['Delete', '删除选中项（文件进回收站，引用仅移出）'],
  ['Shift+Delete', '仅从格子移出，不动文件'],
  ['Ctrl+C / Ctrl+X', '复制 / 剪切文件'],
  ['Ctrl+V', '粘贴到格子'],
  ['Ctrl+Shift+N', '新建文件夹'],
  ['F5', '刷新'],
  ['Ctrl+Z', '撤销整理'],
  ['双击标题栏空白', '卷起 / 展开'],
  ['双击标签', '重命名标签'],
  ['Backspace', '映射文件夹返回'],
  ['Esc', '关闭本页 / 退出 Peek'],
];

function render(rows: [string, string][]) {
  $('#grid').innerHTML = rows.map(([a, b]) => `<div><span>${esc(a)}</span><kbd>${esc(b)}</kbd></div>`).join('');
}
render(FALLBACK);

api()
  .invoke('settings:get')
  .then((r: any) => {
    const h = r.hotkeys || {};
    const dyn: [string, string][] = [
      ['快速搜索 / AI 命令', h.search || 'Alt+Space'],
      ['AI 助手', h.chat || 'Alt+Shift+A'],
      ['快速隐藏 / 显示格子', h.toggle || 'Alt+Shift+D'],
      ['Peek（格子置顶）', h.peek || 'Alt+Shift+F'],
      ['下一桌面页', h.pageNext || 'Ctrl+Alt+Right'],
      ['上一桌面页', h.pagePrev || 'Ctrl+Alt+Left'],
      ...FALLBACK.slice(6),
    ];
    render(dyn);
  })
  .catch(() => {});

$('#close').addEventListener('click', () => api().invoke('win:close'));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' || e.key === 'F1' || e.key === '?') {
    e.preventDefault();
    api().invoke('win:close');
  }
});
