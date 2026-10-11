import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_DAILY_REPORT_PUSH_TIME,
  normalizeDailyReportTime,
  resolveDailyReportPushSettings,
} from '../src/lib/daily-report-settings.ts';

test('日报推送时间只接受合法的 HH:mm', () => {
  assert.equal(normalizeDailyReportTime('7:05'), '07:05');
  assert.equal(normalizeDailyReportTime('23:59'), '23:59');
  assert.equal(normalizeDailyReportTime('24:00'), null);
  assert.equal(normalizeDailyReportTime('12:60'), null);
  assert.equal(normalizeDailyReportTime('稍后'), null);
});

test('日报推送设置缺省保持开启并回退到 22:00', () => {
  assert.deepEqual(resolveDailyReportPushSettings({}), {
    enabled: true,
    time: DEFAULT_DAILY_REPORT_PUSH_TIME,
  });
  assert.deepEqual(resolveDailyReportPushSettings({
    daily_report_push_enabled: 'false',
    daily_report_push_time: '8:30',
  }), {
    enabled: false,
    time: '08:30',
  });
});
