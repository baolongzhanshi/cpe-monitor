import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createEventStream } from '../src/lib/sse-stream.ts';

const decoder = new TextDecoder();

test('取消一个 SSE 连接不影响其他连接，全部关闭后监听归零', async () => {
  const eventBus = new EventEmitter();
  const firstAbort = new AbortController();
  const secondAbort = new AbortController();
  const first = createEventStream({ eventBus, signal: firstAbort.signal, initialEvent: { id: 1 } }).getReader();
  const second = createEventStream({ eventBus, signal: secondAbort.signal, initialEvent: { id: 2 } }).getReader();
  try {
    await first.read();
    await second.read();
    assert.equal(eventBus.listenerCount('message'), 2);
    await first.cancel();
    assert.equal(eventBus.listenerCount('message'), 1);
    eventBus.emit('message', { type: 'alert', payload: { message: '测试告警' } });
    assert.match(decoder.decode((await second.read()).value), /测试告警/);
    secondAbort.abort();
    assert.equal(eventBus.listenerCount('message'), 0);
    assert.equal((await second.read()).done, true);
  } finally {
    firstAbort.abort();
    secondAbort.abort();
    await first.cancel();
    await second.cancel();
  }
});

test('已经取消的请求不保留监听或心跳，流立即结束', async () => {
  const eventBus = new EventEmitter();
  const abort = new AbortController();
  abort.abort();
  const reader = createEventStream({ eventBus, signal: abort.signal, initialEvent: { id: 1 } }).getReader();
  assert.equal(eventBus.listenerCount('message'), 0);
  assert.equal((await reader.read()).done, true);
});

test('SSE 立即提供最近快照，abort 和 cancel 只释放一次订阅租约', async () => {
  const eventBus = new EventEmitter();
  const abort = new AbortController();
  let releases = 0;
  const reader = createEventStream({
    eventBus, signal: abort.signal,
    initialEvent: { type: 'connection' },
    initialEvents: [{ type: 'metrics', payload: { collectedAt: '2026-10-08T00:00:00Z' } }],
    onClose: () => { releases += 1; },
  }).getReader();
  assert.match(decoder.decode((await reader.read()).value), /connection/);
  assert.match(decoder.decode((await reader.read()).value), /2026-10-08T00:00:00Z/);
  abort.abort();
  await reader.cancel();
  assert.equal(releases, 1);
  assert.equal(eventBus.listenerCount('message'), 0);
});

test('已取消请求仍释放预先取得的租约，告警订阅可过滤速率事件', async () => {
  const eventBus = new EventEmitter();
  const aborted = new AbortController();
  aborted.abort();
  let releases = 0;
  const closed = createEventStream({
    eventBus, signal: aborted.signal, initialEvent: {}, onClose: () => { releases += 1; },
  }).getReader();
  assert.equal((await closed.read()).done, true);
  assert.equal(releases, 1);

  const abort = new AbortController();
  const reader = createEventStream({
    eventBus, signal: abort.signal, initialEvent: { type: 'connection' },
    filter: (event) => !(event && typeof event === 'object' && 'type' in event && event.type === 'metrics'),
  }).getReader();
  await reader.read();
  eventBus.emit('message', { type: 'metrics', payload: { speed: 12 } });
  eventBus.emit('message', { type: 'alert', payload: { message: '配额提醒' } });
  const event = decoder.decode((await reader.read()).value);
  assert.match(event, /配额提醒/);
  assert.doesNotMatch(event, /metrics/);
  await reader.cancel();
});

test('事件总线在不同模块实例中仍为同一对象', async () => {
  const first = await import('../src/lib/event-bus.ts');
  const copyUrl = new URL('../src/lib/event-bus.ts?independent-route', import.meta.url);
  const second = await import(copyUrl.href);
  assert.equal(first.eventBus, second.eventBus);
});
