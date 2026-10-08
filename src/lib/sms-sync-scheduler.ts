/**
 * SMS Sync Scheduler — manages periodic SMS message synchronization.
 *
 * Uses the generic IntervalScheduler factory for scheduling lifecycle;
 * this module only contains SMS-specific business logic.
 */
import crypto from 'crypto';
import { db, initializeDatabase } from './db';
import { getOrCreateCpeClient } from './cpe-client';
import { getSettingsMap, isCpeConfigured, setSetting } from './settings-store';
import {
  drainNotificationOutbox,
  enqueueSmsNotifications,
  startNotificationOutboxWorker,
  stopNotificationOutboxWorker,
} from './notification-outbox';
import { createIntervalScheduler, type SyncStatus } from './interval-scheduler';
import { hasStoredSmsChanged, type ExistingSmsRecord } from './sms-sync-utils';
import { SMS_SYNC_INTERVAL } from './sync-interval';
import { createSmsLightweightSync, ensureFullSmsSync } from './sms-lightweight-sync';
import type { CpeSmsMessage } from '@/types/cpe';

export const SMS_SYNC_MIN_INTERVAL = SMS_SYNC_INTERVAL.minInterval;
export const SMS_SYNC_MAX_INTERVAL = SMS_SYNC_INTERVAL.maxInterval;
export const SMS_SYNC_DEFAULT_INTERVAL = SMS_SYNC_INTERVAL.defaultInterval;

export type SmsSyncStatus = SyncStatus;

export interface SmsSyncResult {
  fetched: number;
  inserted: number;
  updated: number;
  notificationsSent: number;
  firstSync: boolean;
  syncedAt: string;
  fullSync: boolean;
}

const lightweightSync = createSmsLightweightSync<SmsSyncResult>({
  getClient: getOrCreateCpeClient,
  persistMessages: persistSmsMessages,
  skippedResult: () => ({
    fetched: 0, inserted: 0, updated: 0, notificationsSent: 0,
    firstSync: false, syncedAt: new Date().toISOString(), fullSync: false,
  }),
});

const scheduler = createIntervalScheduler({
  name: 'SMS sync',
  settingPrefix: 'sms',
  defaultInterval: SMS_SYNC_DEFAULT_INTERVAL,
  minInterval: SMS_SYNC_MIN_INTERVAL,
  maxInterval: SMS_SYNC_MAX_INTERVAL,
  allowFractionalInterval: true,
  shouldRun: isCpeConfigured,
  task: (source) => performSmsSync(source),
});

export function getSmsSyncStatus(): SmsSyncStatus {
  return scheduler.getStatus();
}

export function isValidSmsSyncInterval(value: unknown): value is number {
  return scheduler.isValidInterval(value);
}

export async function restartSmsScheduler(): Promise<SmsSyncStatus> {
  lightweightSync.reset();
  return scheduler.restart();
}

export function stopSmsScheduler(): void {
  scheduler.stop();
  lightweightSync.reset();
  stopNotificationOutboxWorker();
}

export async function ensureSmsSchedulerStarted(): Promise<void> {
  // 出站队列与短信同步节奏解耦：即使用户把同步间隔调大，失败通知仍按退避节奏重试。
  startNotificationOutboxWorker();
  return scheduler.ensureStarted();
}

export async function syncSmsMessages(): Promise<SmsSyncResult> {
  return ensureFullSmsSync((source) => scheduler.sync(source) as Promise<SmsSyncResult>);
}

// ─── Business Logic ────────────────────────────────────────────────────────

async function performSmsSync(source: 'scheduler' | 'manual'): Promise<SmsSyncResult> {
  initializeDatabase();
  return lightweightSync.run(source);
}

async function persistSmsMessages(messages: CpeSmsMessage[]): Promise<SmsSyncResult> {
  const existingCount = (
    db.prepare('SELECT COUNT(*) as count FROM sms_messages').get() as { count?: number } | undefined
  )?.count || 0;

  const settings = getSettingsMap();
  const firstSync = settings.sms_initial_sync_completed !== 'true' && existingCount === 0;
  let inserted = 0;
  let updated = 0;
  let notificationsSent = 0;

  for (const sms of messages) {
    const fingerprint = crypto.createHash('sha256')
      .update(`${sms.id}|${sms.phone}|${sms.date}|${sms.content}`)
      .digest('hex');
    const rawJson = JSON.stringify(sms);
    const existing = db.prepare(`
      SELECT phone, content, received_at, unread, direction, raw_json
      FROM sms_messages
      WHERE fingerprint = ?
    `).get(fingerprint) as ExistingSmsRecord | undefined;
    if (existing) {
      if (hasStoredSmsChanged(existing, sms, rawJson)) {
        db.prepare(`
          UPDATE sms_messages
          SET phone = ?, content = ?, received_at = ?, unread = ?, direction = ?, raw_json = ?
          WHERE fingerprint = ?
        `).run(
          sms.phone,
          sms.content,
          sms.date,
          sms.unread ? 1 : 0,
          sms.direction,
          rawJson,
          fingerprint,
        );
        updated += 1;
      }
      continue;
    }

    // 新入站短信只写入出站队列，由队列负责投递与重试；首次导入的旧短信不推送。
    const notified = 0;
    if (!firstSync && sms.direction === 'inbound') {
      enqueueSmsNotifications(sms, fingerprint);
    }

    db.prepare(`
      INSERT INTO sms_messages
        (fingerprint, message_id, phone, content, received_at, unread, direction, notified, raw_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      fingerprint,
      sms.id,
      sms.phone,
      sms.content,
      sms.date,
      sms.unread ? 1 : 0,
      sms.direction,
      notified,
      rawJson,
    );
    inserted += 1;
  }

  // 立即尝试投递一次，未成功的记录留在队列里按退避重试。
  const drained = await drainNotificationOutbox();
  notificationsSent = drained.sent;

  const syncedAt = new Date().toISOString();
  setSetting('sms_initial_sync_completed', 'true');
  console.log(`SMS sync completed: ${messages.length} messages${firstSync ? ' (initial snapshot)' : ''}`);
  return { fetched: messages.length, inserted, updated, notificationsSent, firstSync, syncedAt, fullSync: true };
}
