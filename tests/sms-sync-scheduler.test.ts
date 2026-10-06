import assert from 'node:assert/strict';
import test from 'node:test';
import { hasStoredSmsChanged } from '../src/lib/sms-sync-utils.ts';

const sms = {
  phone: '13800138000',
  content: '验证码 123456',
  date: '2026-10-07 12:00:00',
  unread: false,
  direction: 'inbound',
};

test('短信字段未变化时跳过 SQLite UPDATE，状态或正文变化时仍更新', () => {
  const rawJson = JSON.stringify(sms);
  const existing = {
    ...sms,
    received_at: sms.date,
    raw_json: rawJson,
  };

  assert.equal(hasStoredSmsChanged(existing, sms, rawJson), false);
  assert.equal(hasStoredSmsChanged({ ...existing, unread: 1 }, sms, rawJson), true);
  assert.equal(hasStoredSmsChanged({ ...existing, content: '旧正文' }, sms, rawJson), true);
  assert.equal(hasStoredSmsChanged({ ...existing, raw_json: JSON.stringify({ ...sms, unread: true }) }, sms, rawJson), true);
});
