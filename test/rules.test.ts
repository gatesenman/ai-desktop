import assert from 'node:assert/strict';
import { condMatches, inRanges, setLinkTargetResolver } from '../src/main/rules';
import type { DesktopItem } from '../src/shared/types';

const t = (name: string, fn: () => void) => { fn(); console.log('PASS ', name); };
const it = (p: Partial<DesktopItem>): DesktopItem => ({ path: 'C:/d/x', name: 'x', ext: '', isDir: false, size: 0, mtime: Date.now(), category: 'other', source: 'user', ...p } as DesktopItem);

t('inRanges simple/list/wrap', () => {
  assert.ok(inRanges('1-5', 3));
  assert.ok(!inRanges('1-5', 6));
  assert.ok(inRanges('1-5,7', 7));
  assert.ok(inRanges('22-6', 23) && inRanges('22-6', 2) && !inRanges('22-6', 12));
});
t('weekday/hour against now', () => {
  const mon10 = new Date(2026, 9, 19, 10, 0).getTime(); // Monday
  assert.ok(condMatches({ field: 'weekday', op: 'in', value: '1-5' }, it({}), mon10));
  assert.ok(!condMatches({ field: 'weekday', op: 'in', value: '6-7' }, it({}), mon10));
  assert.ok(condMatches({ field: 'hour', op: 'in', value: '9-18' }, it({}), mon10));
});
t('shortcut target ops', () => {
  setLinkTargetResolver((p) => (p.endsWith('ps.lnk') ? 'C:\\Program Files\\Adobe\\Photoshop.exe' : ''));
  const lnk = it({ path: 'C:/d/ps.lnk', ext: '.lnk', name: 'ps' });
  assert.ok(condMatches({ field: 'target', op: 'contains', value: 'adobe|steam' }, lnk));
  assert.ok(condMatches({ field: 'target', op: 'ends', value: '.exe' }, lnk));
  assert.ok(!condMatches({ field: 'target', op: 'notcontains', value: 'adobe' }, lnk));
  assert.ok(!condMatches({ field: 'target', op: 'contains', value: 'adobe' }, it({ ext: '.txt' })));
});
