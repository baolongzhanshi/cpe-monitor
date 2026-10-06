// 同步间隔在数据库和 API 中统一以分钟存储；短信可使用小数分钟。
export interface SyncIntervalPolicy {
  minInterval: number;
  maxInterval: number;
  allowFractionalInterval?: boolean;
}

export const SMS_SYNC_INTERVAL = {
  defaultInterval: 15 / 60,
  minInterval: 15 / 60,
  maxInterval: 1440,
  allowFractionalInterval: true,
} as const;

export const SMS_SYNC_INTERVAL_ERROR = '短信自动同步间隔必须在 15 秒到 86400 秒（24 小时）之间';

export function isValidSyncInterval(value: unknown, policy: SyncIntervalPolicy): value is number {
  return typeof value === 'number'
    && Number.isFinite(value)
    && (policy.allowFractionalInterval === true || Number.isInteger(value))
    && value >= policy.minInterval
    && value <= policy.maxInterval;
}

export function parseSyncInterval(
  value: string | undefined,
  defaultInterval: number,
  policy: SyncIntervalPolicy,
): number {
  const interval = Number(value || defaultInterval);
  if (!Number.isFinite(interval)
    || (!policy.allowFractionalInterval && !Number.isInteger(interval))) {
    return defaultInterval;
  }
  return Math.min(policy.maxInterval, Math.max(policy.minInterval, interval));
}

export function syncIntervalMilliseconds(intervalMinutes: number): number {
  return Math.round(intervalMinutes * 60 * 1000);
}

export function formatSyncInterval(intervalMinutes: number | string): string {
  const interval = Number(intervalMinutes);
  if (!Number.isFinite(interval) || interval <= 0) return '待设置';
  if (Number.isInteger(interval)) return `${interval} 分钟`;
  const seconds = Math.round(interval * 60 * 1000) / 1000;
  return `${seconds} 秒`;
}
