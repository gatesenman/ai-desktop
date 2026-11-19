/** Pure geometry helpers (rubber-band fence drawing, icon hit-testing, Fences-style sizing). Unit-tested. */
export interface Rect { x: number; y: number; w: number; h: number }
export interface Pt { x: number; y: number }
export interface IconPos { path: string; x: number; y: number }

/** Normalize two drag corners into a rect (any drag direction). */
export function normRect(x1: number, y1: number, x2: number, y2: number): Rect {
  return { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
}

export function intersectArea(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

export function containsPt(r: Rect, p: Pt): boolean {
  return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
}

/**
 * Desktop icons (IFolderView positions = top-left of the icon cell, screen px) whose cell is "inside" the rect:
 * centre inside, or >= 50% of the cell covered (matches Explorer marquee feel). Icons at (-1,-1) = unknown position.
 */
export function iconsInRect(items: IconPos[], spacing: Pt, rect: Rect): string[] {
  const cw = Math.max(1, spacing.x || 75);
  const ch = Math.max(1, spacing.y || 75);
  const out: string[] = [];
  for (const it of items) {
    if (it.x < 0 && it.y < 0) continue;
    const cell = { x: it.x, y: it.y, w: cw, h: ch };
    const centre = { x: it.x + cw / 2, y: it.y + ch / 2 };
    if (containsPt(rect, centre) || intersectArea(cell, rect) >= 0.5 * cw * ch) out.push(it.path);
  }
  return out;
}

/** Bounding box around selected icons (for "create fence from selected icons"), padded for the title bar. */
export function boundsOfIcons(items: IconPos[], spacing: Pt, pad = 12, titleH = 34): Rect | null {
  const known = items.filter((i) => !(i.x < 0 && i.y < 0));
  if (!known.length) return null;
  const cw = spacing.x || 75;
  const ch = spacing.y || 75;
  const x1 = Math.min(...known.map((i) => i.x));
  const y1 = Math.min(...known.map((i) => i.y));
  const x2 = Math.max(...known.map((i) => i.x + cw));
  const y2 = Math.max(...known.map((i) => i.y + ch));
  return { x: x1 - pad, y: y1 - pad - titleH, w: x2 - x1 + pad * 2, h: y2 - y1 + pad * 2 + titleH };
}

/** Clamp a drawn rect to a usable fence size and keep it inside the work area. */
export function fenceRectFromDrawn(r: Rect, wa: Rect, minW = 180, minH = 120): Rect {
  const w = Math.min(wa.w, Math.max(minW, Math.round(r.w)));
  const h = Math.min(wa.h, Math.max(minH, Math.round(r.h)));
  const x = Math.min(Math.max(wa.x, Math.round(r.x)), wa.x + wa.w - w);
  const y = Math.min(Math.max(wa.y, Math.round(r.y)), wa.y + wa.h - h);
  return { x, y, w, h };
}

/** Is the drawn rect big enough to count as a drag (vs. a click)? */
export function isDrag(r: Rect, threshold = 8): boolean {
  return r.w >= threshold || r.h >= threshold;
}

/** Fences "Keep groups sized to even multiples of icons": round body size to whole icon cells. */
export function sizeToIconMultiples(w: number, h: number, cell: Pt, titleH: number, pad = 16): { w: number; h: number; cols: number; rows: number } {
  const cols = Math.max(1, Math.round((w - pad) / cell.x));
  const rows = Math.max(1, Math.round((h - titleH - pad) / cell.y));
  return { w: cols * cell.x + pad, h: rows * cell.y + titleH + pad, cols, rows };
}

/** Size presets (Fences-like quick sizes) in icon cells. */
export const SIZE_PRESETS: { id: string; label: string; cols: number; rows: number }[] = [
  { id: 's', label: '小（3×2）', cols: 3, rows: 2 },
  { id: 'm', label: '中（4×3）', cols: 4, rows: 3 },
  { id: 'l', label: '大（6×4）', cols: 6, rows: 4 },
  { id: 'wide', label: '宽条（8×2）', cols: 8, rows: 2 },
  { id: 'tall', label: '竖条（2×6）', cols: 2, rows: 6 },
];

/** Fit-to-content size for n items. */
export function fitToContent(n: number, cell: Pt, titleH: number, maxCols = 6, pad = 16): { w: number; h: number } {
  const cols = Math.max(1, Math.min(maxCols, Math.ceil(Math.sqrt(Math.max(1, n) * 1.6))));
  const rows = Math.max(1, Math.ceil(Math.max(1, n) / cols));
  return { w: cols * cell.x + pad, h: rows * cell.y + titleH + pad };
}

/** Physical (helper) px -> DIP using a per-display scale table (fallback when Electron's converter is unavailable). */
export function physToDip(p: Pt, displays: { bounds: Rect; scale: number; physOrigin: Pt }[]): Pt {
  for (const d of displays) {
    const pw = d.bounds.w * d.scale;
    const ph = d.bounds.h * d.scale;
    if (p.x >= d.physOrigin.x && p.x < d.physOrigin.x + pw && p.y >= d.physOrigin.y && p.y < d.physOrigin.y + ph) {
      return { x: d.bounds.x + (p.x - d.physOrigin.x) / d.scale, y: d.bounds.y + (p.y - d.physOrigin.y) / d.scale };
    }
  }
  return { ...p };
}
