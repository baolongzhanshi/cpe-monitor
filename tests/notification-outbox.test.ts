import assert from 'node:assert/strict';
import test from 'node:test';
import {
  OUTBOX_BACKOFF_MS,
  OUTBOX_MAX_ATTEMPTS,
  computeOutboxBackoffMs,
  isOutboxRetryable,
} from '../src/lib/notification-outbox-policy.ts';

test('出站队列退避时间随失败次数递增并封顶', () => {
  // 未失败或非法输入都按第一次失败的最短等待处理。
  assert.equal(computeOutboxBackoffMs(0), OUTBOX_BACKOFF_MS[0]);
  assert.equal(computeOutboxBackoffMs(Number.NaN), OUTBOX_BACKOFF_MS[0]);
  assert.equal(computeOutboxBackoffMs(1), 30_000);
  assert.equal(computeOutboxBackoffMs(2), 120_000);
  for (let attempts = 1; attempts < OUTBOX_BACKOFF_MS.length; attempts += 1) {
    assert.ok(
      computeOutboxBackoffMs(attempts) < computeOutboxBackoffMs(attempts + 1),
      `第 ${attempts} 次退避应小于下一次`,
    );
  }
  // 超过阶梯长度后停留在最长等待，不再无限增长。
  assert.equal(computeOutboxBackoffMs(OUTBOX_BACKOFF_MS.length), OUTBOX_BACKOFF_MS.at(-1));
  assert.equal(computeOutboxBackoffMs(99), OUTBOX_BACKOFF_MS.at(-1));
});

test('出站队列重试上限边界明确', () => {
  assert.equal(isOutboxRetryable(0), true);
  assert.equal(isOutboxRetryable(OUTBOX_MAX_ATTEMPTS - 1), true);
  assert.equal(isOutboxRetryable(OUTBOX_MAX_ATTEMPTS), false);
  assert.equal(isOutboxRetryable(OUTBOX_MAX_ATTEMPTS + 3), false);
});
