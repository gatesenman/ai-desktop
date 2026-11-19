import { api } from './common';

// Alignment guides drawn while a fence is dragged / resized (click-through overlay window).
const svg = document.getElementById('svg')!;
api().on('guides', (lines: { x1: number; y1: number; x2: number; y2: number }[]) => {
  svg.innerHTML = lines
    .map(
      (l) =>
        `<line x1="${l.x1 + 0.5}" y1="${l.y1 + 0.5}" x2="${l.x2 + 0.5}" y2="${l.y2 + 0.5}" class="g"/>` +
        `<circle cx="${l.x1 + 0.5}" cy="${l.y1 + 0.5}" r="2.5" class="d"/><circle cx="${l.x2 + 0.5}" cy="${l.y2 + 0.5}" r="2.5" class="d"/>`,
    )
    .join('');
});
