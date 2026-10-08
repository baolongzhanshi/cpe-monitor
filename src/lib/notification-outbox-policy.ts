/**
 * 通知出站队列的重试策略。
 *
 * 这里只放纯计算，不依赖数据库或网络，便于离线单元测试。
 */

export const OUTBOX_MAX_ATTEMPTS = 5;
export const OUTBOX_WORKER_INTERVAL_MS = 30_000;

/** 第 1 次失败后等待 30 秒，之后逐级放大，最长 2 小时。 */
export const OUTBOX_BACKOFF_MS = [30_000, 120_000, 480_000, 1_800_000, 7_200_000];

/** 根据已失败次数计算下一次尝试前的等待时间。 */
export function computeOutboxBackoffMs(attempts: number): number {
  if (!Number.isFinite(attempts) || attempts < 1) return OUTBOX_BACKOFF_MS[0];
  const index = Math.min(Math.floor(attempts) - 1, OUTBOX_BACKOFF_MS.length - 1);
  return OUTBOX_BACKOFF_MS[index];
}

/** 是否还允许继续重试；达到上限后记录进入 dead 状态。 */
export function isOutboxRetryable(attempts: number): boolean {
  return attempts < OUTBOX_MAX_ATTEMPTS;
}
