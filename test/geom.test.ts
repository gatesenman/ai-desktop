import assert from 'node:assert/strict';
import { boundsOfIcons, fenceRectFromDrawn, fitToContent, iconsInRect, isDrag, normRect, physToDip, sizeToIconMultiples } from '../src/main/geom';

let n = 0;
const t = (name: string, fn: () => void) => { fn(); n++; console.log('PASS ', name); };

t('normRect any direction', () => {
  assert.deepEqual(normRect(100, 100, 40, 20), { x: 40, y: 20, w: 60, h: 80 });
  assert.deepEqual(normRect(0, 0, 10, 10), { x: 0, y: 0, w: 10, h: 10 });
});
const sp = { x: 75, y: 90 };
const icons = [
  { path: 'A', x: 0, y: 0 },
  { path: 'B', x: 75, y: 0 },
  { path: 'C', x: 0, y: 90 },
  { path: 'D', x: 300, y: 300 },
  { path: 'U', x: -1, y: -1 },
];
t('iconsInRect centre inside', () => assert.deepEqual(iconsInRect(icons, sp, normRect(10, 10, 120, 60)), ['A', 'B']));
t('iconsInRect half coverage', () => assert.deepEqual(iconsInRect(icons, sp, { x: 0, y: 0, w: 40, h: 90 }), ['A']));
t('iconsInRect excludes tiny overlap', () => assert.deepEqual(iconsInRect(icons, sp, { x: 70, y: 0, w: 10, h: 10 }), []));
t('iconsInRect skips unknown positions', () => assert.ok(!iconsInRect(icons, sp, { x: -5, y: -5, w: 1000, h: 1000 }).includes('U')));
t('iconsInRect reverse-drag rect', () => assert.deepEqual(iconsInRect(icons, sp, normRect(400, 400, 290, 290)), ['D']));
t('boundsOfIcons', () => {
  const b = boundsOfIcons(icons.slice(0, 3), sp, 10, 30)!;
  assert.deepEqual(b, { x: -10, y: -40, w: 170, h: 230 });
  assert.equal(boundsOfIcons([{ path: 'U', x: -1, y: -1 }], sp), null);
});
t('fenceRectFromDrawn min size + clamp', () => {
  const wa = { x: 0, y: 0, w: 1920, h: 1040 };
  assert.deepEqual(fenceRectFromDrawn({ x: 10, y: 10, w: 20, h: 20 }, wa), { x: 10, y: 10, w: 180, h: 120 });
  assert.deepEqual(fenceRectFromDrawn({ x: 1900, y: 1000, w: 300, h: 200 }, wa), { x: 1620, y: 840, w: 300, h: 200 });
});
t('isDrag threshold', () => {
  assert.equal(isDrag({ x: 0, y: 0, w: 3, h: 4 }), false);
  assert.equal(isDrag({ x: 0, y: 0, w: 30, h: 4 }), true);
});
t('sizeToIconMultiples', () => assert.deepEqual(sizeToIconMultiples(330, 230, { x: 80, y: 90 }, 34, 16), { w: 336, h: 230, cols: 4, rows: 2 }));
t('fitToContent', () => {
  const f = fitToContent(8, { x: 80, y: 90 }, 34);
  assert.ok(f.w >= 80 * 3 && f.h >= 90 * 2);
});
t('physToDip 150% secondary display', () => {
  const displays = [
    { bounds: { x: 0, y: 0, w: 1920, h: 1080 }, scale: 1, physOrigin: { x: 0, y: 0 } },
    { bounds: { x: 1920, y: 0, w: 1707, h: 960 }, scale: 1.5, physOrigin: { x: 1920, y: 0 } },
  ];
  assert.deepEqual(physToDip({ x: 1920 + 300, y: 150 }, displays), { x: 2120, y: 100 });
  assert.deepEqual(physToDip({ x: 100, y: 100 }, displays), { x: 100, y: 100 });
});
console.log(`\n${n} unit tests passed`);
