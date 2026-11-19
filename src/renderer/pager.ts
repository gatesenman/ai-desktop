import { $, api, applyTheme, esc } from './common';

// Desktop Pages indicator (shown briefly when switching pages)
api().on('pager', (d: { pages: string[]; page: number; theme: 'dark' | 'light'; demo?: boolean }) => {
  applyTheme(d);
  document.documentElement.classList.toggle('demo', !!d.demo);
  $('#name').innerHTML = `<i class="ri-pages-line"></i>${esc(d.pages[d.page] ?? '')}<span>${d.page + 1} / ${d.pages.length}</span>`;
  $('#dots').innerHTML = d.pages.map((p, i) => `<button class="dot${i === d.page ? ' on' : ''}" title="${esc(p)}" data-i="${i}"></button>`).join('');
  const pg = $('#pg');
  pg.classList.remove('show');
  void pg.offsetWidth;
  pg.classList.add('show');
});
$('#dots').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('.dot');
  if (b) api().invoke('pager:go', Number(b.dataset.i));
});
$('#prev').addEventListener('click', () => api().invoke('pager:go', 'prev'));
$('#next').addEventListener('click', () => api().invoke('pager:go', 'next'));
