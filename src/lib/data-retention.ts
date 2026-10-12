import { db, ensureDatabaseReady, toSqliteTimestamp } from '@/lib/db';
import { deleteDeviceInfoSnapshotsBefore } from '@/lib/repositories/device-info-repository';
import { getSetting, setSetting } from '@/lib/settings-store';

export const RETENTION_MIN_DAYS = 7;
export const RETENTION_MAX_DAYS = 3650;
export const DEFAULT_HISTORY_RETENTION_DAYS = 90;
export const DEFAULT_RUN_RETENTION_DAYS = 180;
/** 资源采样是诊断数据，量级比历史流量大得多，单独用较短的固定保留期。 */
const RESOURCE_SAMPLE_RETENTION_DAYS = 30;
const CLEANUP_INTERVAL_MS = 12 * 60 * 60 * 1000;

export interface DataRetentionConfig {
  historyDays: number;
  runDays: number;
  lastCleanupAt: string | null;
}

export interface DataCleanupResult {
  skipped: boolean;
  trafficDeleted: number;
  devicesDeleted: number;
  deviceSnapshotsDeleted: number;
  runsDeleted: number;
  cleanedAt: string;
}

function clampRetentionDays(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(RETENTION_MAX_DAYS, Math.max(RETENTION_MIN_DAYS, parsed));
}

function parseStoredDate(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

export function getDataRetentionConfig(): DataRetentionConfig {
  ensureDatabaseReady();
  return {
    historyDays: clampRetentionDays(
      getSetting('history_retention_days', String(DEFAULT_HISTORY_RETENTION_DAYS)),
      DEFAULT_HISTORY_RETENTION_DAYS,
    ),
    runDays: clampRetentionDays(
      getSetting('collection_run_retention_days', String(DEFAULT_RUN_RETENTION_DAYS)),
      DEFAULT_RUN_RETENTION_DAYS,
    ),
    lastCleanupAt: getSetting('history_last_cleanup_at', '') || null,
  };
}

export function isValidRetentionDays(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isInteger(value)
    && value >= RETENTION_MIN_DAYS
    && value <= RETENTION_MAX_DAYS;
}

export function saveDataRetentionConfig(input: {
  historyDays: number;
  runDays: number;
}): DataRetentionConfig {
  if (!isValidRetentionDays(input.historyDays) || !isValidRetentionDays(input.runDays)) {
    throw new Error(`保留天数必须是 ${RETENTION_MIN_DAYS} 到 ${RETENTION_MAX_DAYS} 之间的整数`);
  }
  setSetting('history_retention_days', String(input.historyDays));
  setSetting('collection_run_retention_days', String(input.runDays));
  return getDataRetentionConfig();
}

export function cleanupHistoricalData(force = false): DataCleanupResult {
  ensureDatabaseReady();
  const config = getDataRetentionConfig();
  const now = new Date();
  const lastCleanupTime = parseStoredDate(config.lastCleanupAt);

  if (
    !force
    && lastCleanupTime !== null
    && now.getTime() - lastCleanupTime < CLEANUP_INTERVAL_MS
  ) {
    return {
      skipped: true,
      trafficDeleted: 0,
      devicesDeleted: 0,
      deviceSnapshotsDeleted: 0,
      runsDeleted: 0,
      cleanedAt: config.lastCleanupAt || now.toISOString(),
    };
  }

  const historyCutoff = toSqliteTimestamp(
    new Date(now.getTime() - config.historyDays * 24 * 60 * 60 * 1000),
  );
  const runCutoff = toSqliteTimestamp(
    new Date(now.getTime() - config.runDays * 24 * 60 * 60 * 1000),
  );

  const cleanup = db.transaction(() => {
    const devices = db.prepare(
      'DELETE FROM device_data WHERE timestamp < ?',
    ).run(historyCutoff);
    const traffic = db.prepare(
      'DELETE FROM traffic_data WHERE timestamp < ?',
    ).run(historyCutoff);
    const deviceSnapshotsDeleted = deleteDeviceInfoSnapshotsBefore(historyCutoff);
    // 以下几张表原先没有任何清理路径，只增不减。
    // 资源采样尤其明显：灰度包每 60 秒写一条汇总加约九条明细，一天约 1.4 万行，
    // 而它正是被用来做长期趋势分析的，不清理反而会把库撑大。
    // sms_messages 是用户数据，刻意不在这里删。
    db.prepare('DELETE FROM alert_logs WHERE triggered_at < ?').run(historyCutoff);
    db.prepare('DELETE FROM system_logs WHERE created_at < ?').run(historyCutoff);
    db.prepare(
      "DELETE FROM notification_outbox WHERE status IN ('sent', 'dead') AND created_at < ?",
    ).run(historyCutoff);
    const resourceCutoffIso = new Date(
      now.getTime() - RESOURCE_SAMPLE_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();
    db.prepare('DELETE FROM resource_samples WHERE sampled_at < ?').run(resourceCutoffIso);
    db.prepare('DELETE FROM resource_process_samples WHERE sampled_at < ?').run(resourceCutoffIso);
    const runs = db.prepare(
      `DELETE FROM collection_runs
       WHERE COALESCE(completed_at, started_at) < ?
         AND NOT EXISTS (
           SELECT 1 FROM traffic_data WHERE traffic_data.collection_id = collection_runs.id
         )
         AND NOT EXISTS (
           SELECT 1 FROM device_data WHERE device_data.collection_id = collection_runs.id
         )`,
    ).run(runCutoff);

    return {
      devicesDeleted: Number(devices.changes || 0),
      trafficDeleted: Number(traffic.changes || 0),
      deviceSnapshotsDeleted,
      runsDeleted: Number(runs.changes || 0),
    };
  });

  const deleted = cleanup();
  const cleanedAt = now.toISOString();
  setSetting('history_last_cleanup_at', cleanedAt);
  return {
    skipped: false,
    ...deleted,
    cleanedAt,
  };
}
