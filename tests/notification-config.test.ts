import test from 'node:test';
import assert from 'node:assert/strict';
import {
  notificationConfigNeedsMigration,
  readNotificationConfigForDelivery,
  toPublicNotificationConfig,
  prepareEmailConfigForStorage,
  prepareNotificationConfigForStorage,
  prepareWechatConfigForStorage,
  readEmailConfig,
  readWechatConfig,
  toPublicEmailConfig,
  toPublicWechatConfig,
} from '../src/lib/notification-config.ts';

process.env.CPE_CONFIG_SECRET = 'test-only-clean-code-secret-that-is-long-enough';

test('email secret is encrypted at rest and decrypted for delivery', () => {
  const stored = prepareEmailConfigForStorage({
    smtpHost: 'smtp.example.com',
    smtpPort: 587,
    smtpUser: 'ops@example.com',
    smtpPass: 'smtp-secret-value',
    from: 'ops@example.com',
    to: 'a@example.com\nb@example.com',
  });

  assert.match(stored.smtpPass, /^enc:v1\./);
  assert.equal(stored.smtpPass.includes('smtp-secret-value'), false);

  const delivered = readEmailConfig(stored);
  assert.equal(delivered.smtpPass, 'smtp-secret-value');
  assert.deepEqual(delivered.to, ['a@example.com', 'b@example.com']);

  const publicConfig = toPublicEmailConfig(stored);
  assert.equal(publicConfig.smtpPass, '');
  assert.equal(publicConfig.smtpPasswordSet, true);
});

test('blank email password preserves the previously stored secret', () => {
  const first = prepareEmailConfigForStorage({
    smtpHost: 'smtp.example.com',
    smtpPort: 587,
    smtpUser: 'ops@example.com',
    smtpPass: 'original-secret',
    from: 'ops@example.com',
    to: ['ops@example.com'],
  });

  const updated = prepareEmailConfigForStorage({
    smtpHost: 'smtp2.example.com',
    smtpPort: 465,
    smtpUser: 'ops2@example.com',
    smtpPass: '',
    from: 'ops2@example.com',
    to: 'new@example.com',
  }, first);

  assert.equal(readEmailConfig(updated).smtpPass, 'original-secret');
  assert.equal(readEmailConfig(updated).smtpHost, 'smtp2.example.com');
});

test('legacy plaintext notification secrets are detected for migration', () => {
  const legacyEmail = JSON.stringify({ smtpPass: 'legacy-secret' });
  const legacyWechat = JSON.stringify({ webhookUrl: 'https://qyapi.example/key' });
  assert.equal(notificationConfigNeedsMigration('email', legacyEmail), true);
  assert.equal(notificationConfigNeedsMigration('wechat', legacyWechat), true);

  const encrypted = prepareNotificationConfigForStorage('email', {
    smtpPass: 'legacy-secret',
  });
  assert.equal(notificationConfigNeedsMigration('email', encrypted), false);
});

test('wechat webhook is encrypted and never exposed publicly', () => {
  const stored = prepareWechatConfigForStorage({
    webhookUrl: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test-key',
  });
  assert.match(stored.webhookUrl, /^enc:v1\./);
  assert.equal(readWechatConfig(stored).webhookUrl.includes('test-key'), true);

  const publicConfig = toPublicWechatConfig(stored);
  assert.equal(publicConfig.webhookUrl, '');
  assert.equal(publicConfig.webhookConfigured, true);
});

test('pushplus token is encrypted at rest and redacted from public config', () => {
  const stored = prepareNotificationConfigForStorage('pushplus', { token: 'pushplus-secret-token' });
  const storedConfig = JSON.parse(stored) as { token: string };
  assert.match(storedConfig.token, /^enc:v1\./);
  assert.equal(storedConfig.token.includes('pushplus-secret-token'), false);

  const delivered = readNotificationConfigForDelivery('pushplus', stored) as { token: string };
  assert.equal(delivered.token, 'pushplus-secret-token');

  const publicConfig = toPublicNotificationConfig('pushplus', stored) as {
    token: string;
    tokenConfigured: boolean;
  };
  assert.equal(publicConfig.token, '');
  assert.equal(publicConfig.tokenConfigured, true);
});

test('blank PushPlus token preserves the previously stored token', () => {
  const first = prepareNotificationConfigForStorage('pushplus', { token: 'original-pushplus-token' });
  const updated = prepareNotificationConfigForStorage('pushplus', { token: '' }, first);
  const delivered = readNotificationConfigForDelivery('pushplus', updated) as { token: string };
  assert.equal(delivered.token, 'original-pushplus-token');
});
