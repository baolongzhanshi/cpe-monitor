import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveTrafficRange } from '../src/lib/traffic-range.ts';

test('预设流量范围保留原有时间跨度', () => {
  const now = new Date('2026-10-11T12:00:00.000Z');
  const range = resolveTrafficRange('24h', now, null, null);
  assert.equal(range?.start.toISOString(), '2026-10-10T12:00:00.000Z');
  assert.equal(range?.end.toISOString(), now.toISOString());
});

test('自定义流量范围按上海自然日包含结束日', () => {
  const range = resolveTrafficRange(
    'custom',
    new Date('2026-10-11T12:00:00.000Z'),
    '2026-10-10',
    '2026-10-11',
  );
  assert.equal(range?.start.toISOString(), '2026-10-09T16:00:00.000Z');
  assert.equal(range?.end.toISOString(), '2026-10-11T15:59:59.999Z');
});

test('自定义流量范围拒绝无效日期和反向区间', () => {
  const now = new Date('2026-10-11T12:00:00.000Z');
  assert.equal(resolveTrafficRange('custom', now, '2026-02-30', '2026-03-01'), null);
  assert.equal(resolveTrafficRange('custom', now, '2026-10-12', '2026-10-11'), null);
});
