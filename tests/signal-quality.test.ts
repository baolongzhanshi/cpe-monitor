import assert from 'node:assert/strict';
import test from 'node:test';
import { RSRP_QUALITY_THRESHOLDS, getSignalQuality } from '../src/lib/signal-quality.ts';

test('RSRP 分档边界与阈值一致，不随调用方改变', () => {
  const [excellent, good, fair] = RSRP_QUALITY_THRESHOLDS;

  assert.equal(getSignalQuality(excellent)?.label, '优秀');
  assert.equal(getSignalQuality(excellent + 1)?.label, '优秀');
  assert.equal(getSignalQuality(excellent - 1)?.label, '良好');

  assert.equal(getSignalQuality(good)?.label, '良好');
  assert.equal(getSignalQuality(good - 1)?.label, '一般');

  assert.equal(getSignalQuality(fair)?.label, '一般');
  assert.equal(getSignalQuality(fair - 1)?.label, '较差');
});

test('未上报的信号强度返回 null，让调用方自己决定显示', () => {
  assert.equal(getSignalQuality(0), null);
});

test('每个分级都带徽章样式，界面无需再自行分档', () => {
  const variants = [-60, -80, -95, -110].map((value) => getSignalQuality(value)?.variant);
  assert.deepEqual(variants, ['success', 'info', 'warning', 'danger']);
});
