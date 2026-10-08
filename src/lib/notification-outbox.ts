/**
 * 通知出站队列（outbox）。
 *
 * 短信入库与“待发送”记录在同一个流程里落库，避免“已入库但没发”或“发了但没记”。
 * 投递失败按指数退避重试，超过上限进入 dead 状态并保留原因。
 * 每个渠道单独一行，(渠道, 类型, 去重键) 唯一，重复同步同一条短信不会重复入队。
 *
 * 送达语义是“至少一次”：发送成功后进程立即崩溃，重启后仍可能重发一次。
 * 上游渠道没有可用的幂等键，因此不承诺精确一次。
 */
import { db, initializeDatabase } from './db';
import { readNotificationConfig } from './settings-store';
import { sendSmsNotification } from './notifiers/email';
import { sendSmsWechat } from './notifiers/wechat';
import { sendPushplusSms } from './notifiers/pushplus';
import {
  OUTBOX_WORKER_INTERVAL_MS,
  computeOutboxBackoffMs,
  isOutboxRetryable,
} from './notification-outbox-policy';
import type { CpeSmsMessage } from '@/types/cpe';

export {
  OUTBOX_BACKOFF_MS,
  OUTBOX_MAX_ATTEMPTS,
  OUTBOX_WORKER_INTERVAL_MS,
  computeOutboxBackoffMs,
  isOutboxRetryable,
} from './notification-outbox-policy';

export type OutboxChannel = 'email' | 'wechat' | 'pushplus';

export const OUTBOX_CHANNELS: readonly OutboxChannel[] = ['email', 'wechat', 'pushplus'];

export function isOutboxChannelConfigured(channel: OutboxChannel): boolean {
  if (channel === 'email') {
    const config = readNotificationConfig('email');
    const to = config?.to;
    return Boolean(to && (Array.isArray(to) ? to.length > 0 : true));
  }
  if (channel === 'wechat') return Boolean(readNotificationConfig('wechat')?.webhookUrl);
  return Boolean(readNotificationConfig('pushplus')?.token);
}

/** 把一条新入站短信按已配置渠道入队；重复调用不会产生重复记录。 */
export function enqueueSmsNotifications(sms: CpeSmsMessage, fingerprint: string): number {
  initializeDatabase();
  const payload = JSON.stringify({
    id: sms.id,
    phone: sms.phone,
    content: sms.content,
    date: sms.date,
    direction: sms.direction,
    unread: sms.unread,
  });
  const insert = db.prepare(`
    INSERT OR IGNORE INTO notification_outbox (kind, channel, dedupe_key, payload_json, status)
    VALUES ('sms', ?, ?, ?, 'pending')
  `);
  let enqueued = 0;
  for (const channel of OUTBOX_CHANNELS) {
    if (!isOutboxChannelConfigured(channel)) continue;
    const result = insert.run(channel, fingerprint, payload);
    if (Number(result.changes) > 0) enqueued += 1;
  }
  return enqueued;
}

interface OutboxRow {
  id: number;
  kind: string;
  channel: string;
  dedupe_key: string;
  payload_json: string;
  attempts: number;
}

export interface OutboxDrainResult {
  attempted: number;
  sent: number;
  retried: number;
  dead: number;
}

let draining: Promise<OutboxDrainResult> | null = null;
let workerTimer: ReturnType<typeof setInterval> | null = null;

async function sendOutboxRow(row: OutboxRow): Promise<boolean> {
  if (row.kind !== 'sms') return false;
  const sms = JSON.parse(row.payload_json) as CpeSmsMessage;
  if (row.channel === 'email') {
    const config = readNotificationConfig('email');
    return config ? sendSmsNotification(config, sms) : false;
  }
  if (row.channel === 'wechat') {
    const config = readNotificationConfig('wechat');
    return config?.webhookUrl ? sendSmsWechat(config, sms) : false;
  }
  if (row.channel === 'pushplus') {
    const config = readNotificationConfig('pushplus');
    return config?.token ? sendPushplusSms(config, sms) : false;
  }
  return false;
}

/** 处理到期的待发送记录。同一进程内不会并发重入。 */
export async function drainNotificationOutbox(
  options: { limit?: number; now?: Date } = {},
): Promise<OutboxDrainResult> {
  if (draining) return draining;
  draining = runDrain(options).finally(() => { draining = null; });
  return draining;
}

async function runDrain(
  { limit = 20, now = new Date() }: { limit?: number; now?: Date },
): Promise<OutboxDrainResult> {
  initializeDatabase();
  const result: OutboxDrainResult = { attempted: 0, sent: 0, retried: 0, dead: 0 };
  const rows = db.prepare(`
    SELECT id, kind, channel, dedupe_key, payload_json, attempts
    FROM notification_outbox
    WHERE status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
    ORDER BY id
    LIMIT ?
  `).all(now.toISOString(), limit) as OutboxRow[];

  for (const row of rows) {
    result.attempted += 1;
    let accepted = false;
    try {
      accepted = await sendOutboxRow(row);
    } catch {
      accepted = false;
    }

    if (accepted) {
      db.prepare(`
        UPDATE notification_outbox
        SET status = 'sent', attempts = attempts + 1, last_error = NULL, updated_at = ?
        WHERE id = ?
      `).run(new Date().toISOString(), row.id);
      if (row.kind === 'sms') {
        // 保持旧字段语义：至少一个渠道送达。
        db.prepare('UPDATE sms_messages SET notified = 1 WHERE fingerprint = ?').run(row.dedupe_key);
      }
      result.sent += 1;
      continue;
    }

    const attempts = row.attempts + 1;
    if (!isOutboxRetryable(attempts)) {
      db.prepare(`
        UPDATE notification_outbox
        SET status = 'dead', attempts = ?, last_error = ?, updated_at = ?
        WHERE id = ?
      `).run(attempts, '投递失败且已达重试上限', new Date().toISOString(), row.id);
      result.dead += 1;
      continue;
    }

    const nextAttemptAt = new Date(now.getTime() + computeOutboxBackoffMs(attempts)).toISOString();
    db.prepare(`
      UPDATE notification_outbox
      SET attempts = ?, next_attempt_at = ?, last_error = ?, updated_at = ?
      WHERE id = ?
    `).run(attempts, nextAttemptAt, '投递失败，等待重试', new Date().toISOString(), row.id);
    result.retried += 1;
  }

  return result;
}

/** 周期性处理待发送记录。定时器不阻止进程退出。 */
export function startNotificationOutboxWorker(intervalMs = OUTBOX_WORKER_INTERVAL_MS): void {
  if (workerTimer) return;
  workerTimer = setInterval(() => {
    void drainNotificationOutbox().catch(() => { /* 下一轮继续重试 */ });
  }, intervalMs);
  if (typeof workerTimer.unref === 'function') workerTimer.unref();
}

export function stopNotificationOutboxWorker(): void {
  if (!workerTimer) return;
  clearInterval(workerTimer);
  workerTimer = null;
}
