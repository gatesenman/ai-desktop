// Rubber-band overlay: a click-through translucent rectangle that follows the desktop drag (Fences "draw a fence").
const api = (window as any).api;
const $ = (id: string) => document.getElementById(id)!;
api.on('rb:update', (d: { w: number; h: number; count: number; accent?: string; phase?: string }) => {
  if (d.accent) document.documentElement.style.setProperty('--a', d.accent);
  $('t').textContent = `新建格子 ${Math.round(d.w)} × ${Math.round(d.h)}`;
  $('n').textContent = d.count > 0 ? `已框选 ${d.count} 个图标` : '';
  $('h').textContent = d.phase === 'menu' ? '选择要创建的内容' : '松开鼠标选择操作';
  document.body.classList.toggle('small', d.w < 220 || d.h < 90);
});
