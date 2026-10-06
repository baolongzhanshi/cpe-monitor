import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SMS_SYNC_INTERVAL,
  formatSyncInterval,
  isValidSyncInterval,
  parseSyncInterval,
  syncIntervalMilliseconds,
} from '../src/lib/sync-interval.ts';

test('短信的新安装默认和最短间隔均为 15 秒，转换后不会被取整成一分钟', () => {
  assert.equal(SMS_SYNC_INTERVAL.defaultInterval, 0.25);
  assert.equal(SMS_SYNC_INTERVAL.minInterval, 0.25);
  assert.equal(syncIntervalMilliseconds(SMS_SYNC_INTERVAL.defaultInterval), 15000);
  assert.equal(parseSyncInterval('0.25', SMS_SYNC_INTERVAL.defaultInterval, SMS_SYNC_INTERVAL), 0.25);
  assert.equal(parseSyncInterval(undefined, SMS_SYNC_INTERVAL.defaultInterval, SMS_SYNC_INTERVAL), 0.25);
  assert.equal(syncIntervalMilliseconds(30 / 60), 30000);
  assert.equal(syncIntervalMilliseconds(1), 60000);
});

test('短信接受小数分钟及上下边界，拒绝更短间隔和无效类型', () => {
  for (const value of [0.25, 0.5, 1, 1.5, 15, 1440]) {
    assert.equal(isValidSyncInterval(value, SMS_SYNC_INTERVAL), true, String(value));
  }
  for (const value of [0, 0.249, -1, 1440.001, Number.NaN, Infinity, -Infinity, '0.25', null, undefined]) {
    assert.equal(isValidSyncInterval(value, SMS_SYNC_INTERVAL), false, String(value));
  }
  assert.equal(parseSyncInterval('15', SMS_SYNC_INTERVAL.defaultInterval, SMS_SYNC_INTERVAL), 15);
  assert.equal(parseSyncInterval('0.1', SMS_SYNC_INTERVAL.defaultInterval, SMS_SYNC_INTERVAL), 0.25);
  assert.equal(parseSyncInterval('1441', SMS_SYNC_INTERVAL.defaultInterval, SMS_SYNC_INTERVAL), 1440);
  assert.equal(parseSyncInterval('Infinity', SMS_SYNC_INTERVAL.defaultInterval, SMS_SYNC_INTERVAL), 0.25);
});

test('设备信息等默认同步策略仍拒绝小数分钟', () => {
  const devicePolicy = { minInterval: 30, maxInterval: 10080 };
  for (const value of [30, 360, 10080]) {
    assert.equal(isValidSyncInterval(value, devicePolicy), true);
  }
  for (const value of [0.25, 29, 30.5, 10080.5, Number.NaN, Infinity]) {
    assert.equal(isValidSyncInterval(value, devicePolicy), false);
  }
  assert.equal(parseSyncInterval('30.5', 360, devicePolicy), 360);
  assert.equal(parseSyncInterval('30', 360, devicePolicy), 30);
});

test('短信间隔使用秒显示，分钟配置保持清楚且兼容已有值', () => {
  assert.equal(formatSyncInterval('0.25'), '15 秒');
  assert.equal(formatSyncInterval(0.5), '30 秒');
  assert.equal(formatSyncInterval(1.25), '75 秒');
  assert.equal(formatSyncInterval(1), '1 分钟');
  assert.equal(formatSyncInterval('15'), '15 分钟');
  assert.equal(formatSyncInterval(''), '待设置');
});
