import assert from 'node:assert/strict';
import test from 'node:test';
import { createRealtimeCollector } from '../src/lib/realtime-collector-core.ts';
import type { RealtimeCollectorStatus } from '../src/lib/dashboard-live-types.ts';

type Sample = { collectedAt: string | null; stale: boolean; error?: string; realtime?: RealtimeCollectorStatus };

function makeHarness() {
  let time = 0;
  let configured = true;
  let duration = 250;
  let mode: 'success' | 'stale' | 'throw' = 'success';
  let release: (() => void) | null = null;
  let held: Promise<void> | null = null;
  let calls = 0;
  let active = 0;
  let maxActive = 0;
  let token = 0;
  let lastSuccessfulAt: string | null = null;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const published: Sample[] = [];
  const collector = createRealtimeCollector<Sample>({
    now: () => time,
    isConfigured: () => configured,
    setTimer(callback, delay) {
      const id = ++token;
      timers.set(id, { at: time + delay, callback });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer(id) { timers.delete(id as unknown as number); },
    async collect() {
      calls += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      try {
        if (held) await held;
        time += duration;
        if (mode === 'throw') throw new Error('设备请求超时');
        if (mode === 'stale') return { collectedAt: lastSuccessfulAt, stale: true, error: '设备离线' };
        lastSuccessfulAt = new Date(time).toISOString();
        return { collectedAt: lastSuccessfulAt, stale: false };
      } finally { active -= 1; }
    },
    readError: (sample) => sample.error ?? '',
    failureSample: (message, previous) => previous ? { ...previous, stale: true, error: message } : null,
    decorate: (sample, realtime) => ({ ...sample, realtime }),
    publish: (sample) => published.push(sample),
  });
  async function flush() { await new Promise<void>((resolve) => setImmediate(resolve)); }
  async function next() {
    const selected = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    assert.ok(selected, '应存在下一轮定时器');
    timers.delete(selected[0]);
    time = selected[1].at;
    selected[1].callback();
    await flush();
  }
  return {
    collector, published, timers, next, flush,
    nextAt: () => Math.min(...[...timers.values()].map((timer) => timer.at)),
    calls: () => calls, maxActive: () => maxActive,
    setConfigured(value: boolean) { configured = value; },
    setMode(value: typeof mode) { mode = value; },
    setDuration(value: number) { duration = value; },
    hold() { held = new Promise<void>((resolve) => { release = resolve; }); },
    release() { release?.(); release = null; held = null; },
  };
}

test('可见订阅按开始时间保持一秒周期，全部释放后改为后台十五秒', async () => {
  const h = makeHarness();
  const first = h.collector.acquireSubscriber();
  const second = h.collector.acquireSubscriber();
  await h.next();
  assert.equal(h.calls(), 1);
  assert.equal(h.nextAt(), 1_000);
  assert.equal(h.collector.getStatus().lastSuccessAt, new Date(250).toISOString());
  await h.next();
  assert.equal(h.nextAt(), 2_000);
  first(); first();
  assert.equal(h.collector.getStatus().subscribers, 1);
  second();
  assert.equal(h.collector.getStatus().subscribers, 0);
  assert.equal(h.nextAt(), 16_000);
  h.collector.stop();
  assert.equal(h.timers.size, 0);
});

test('同一轮在途请求被所有启动和手动读取复用，慢采集不重叠', async () => {
  const h = makeHarness();
  h.setDuration(1_500);
  h.hold();
  h.collector.acquireSubscriber();
  await h.next();
  const first = h.collector.collectNow();
  const second = h.collector.collectNow();
  assert.equal(first, second);
  assert.equal(h.calls(), 1);
  assert.equal(h.timers.size, 0);
  h.release();
  await first;
  await h.flush();
  assert.equal(h.nextAt(), 1_550);
  await h.next();
  assert.equal(h.maxActive(), 1);
  h.collector.stop();
});

test('stale 响应和异常不推进成功时间，离线按五至六十秒退避，恢复后回到一秒', async () => {
  const h = makeHarness();
  h.collector.acquireSubscriber();
  await h.next();
  const successAt = h.collector.getStatus().lastSuccessAt;
  h.setMode('stale');
  await h.next();
  assert.equal(h.collector.getStatus().lastSuccessAt, successAt);
  assert.equal(h.collector.getSnapshot()?.collectedAt, successAt);
  assert.equal(h.collector.getSnapshot()?.stale, true);
  assert.equal(h.collector.getStatus().intervalMs, 5_000);
  assert.equal(h.nextAt(), 6_000);
  h.collector.acquireSubscriber();
  assert.equal(h.nextAt(), 6_000, '新订阅不能绕过离线退避');
  h.setMode('throw');
  await h.next();
  assert.equal(h.collector.getStatus().intervalMs, 10_000);
  assert.equal(h.collector.getStatus().lastError, '设备请求超时');
  for (let index = 0; index < 5; index += 1) await h.next();
  assert.equal(h.collector.getStatus().intervalMs, 60_000);
  assert.equal(h.collector.getStatus().lastSuccessAt, successAt);
  h.setMode('success');
  await h.next();
  assert.equal(h.collector.getStatus().consecutiveFailures, 0);
  assert.equal(h.collector.getStatus().intervalMs, 1_000);
  assert.equal(h.collector.getSnapshot()?.stale, false);
  assert.notEqual(h.collector.getStatus().lastSuccessAt, successAt);
  h.collector.stop();
});

test('未配置时不调用采集函数，也不生成采样时间；保存配置后可继续采集', async () => {
  const h = makeHarness();
  h.setConfigured(false);
  h.collector.acquireSubscriber();
  await h.next();
  assert.equal(h.calls(), 0);
  assert.equal(h.collector.getStatus().lastAttemptAt, null);
  assert.equal(h.collector.getStatus().lastSuccessAt, null);
  assert.equal(h.nextAt(), 15_000);
  h.setConfigured(true);
  await h.next();
  assert.equal(h.calls(), 1);
  assert.equal(h.collector.getStatus().intervalMs, 1_000);
  h.collector.stop();
});

test('停止期间的在途采集不会重建定时器，随后重启也不会形成重复循环', async () => {
  const h = makeHarness();
  h.hold();
  h.collector.start();
  await h.next();
  h.collector.stop();
  h.collector.start();
  h.release();
  await h.flush();
  assert.equal(h.timers.size, 1);
  await h.next();
  assert.equal(h.maxActive(), 1);
  h.collector.stop();
  assert.equal(h.timers.size, 0);
});
