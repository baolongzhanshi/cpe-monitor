import type { RealtimeCollectorStatus } from './dashboard-live-types';

export const REALTIME_VISIBLE_INTERVAL_MS = 1_000;
export const REALTIME_BACKGROUND_INTERVAL_MS = 15_000;
export const REALTIME_MIN_RETRY_MS = 5_000;
export const REALTIME_MAX_RETRY_MS = 60_000;

interface LiveSample { collectedAt: string | null; stale: boolean }

interface CollectorOptions<T extends LiveSample> {
  collect: () => Promise<T>;
  isConfigured: () => boolean;
  publish: (sample: T) => void;
  decorate: (sample: T, status: RealtimeCollectorStatus) => T;
  failureSample: (message: string, previous: T | null) => T | null;
  readError: (sample: T) => string;
  now?: () => number;
  setTimer?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

export interface RealtimeCollector<T> {
  start(): void;
  stop(): void;
  acquireSubscriber(): () => void;
  collectNow(): Promise<T | null>;
  getSnapshot(): T | null;
  getStatus(): RealtimeCollectorStatus;
}

// 注入时钟和定时器便于离线验证；此模块不引用数据库、设备或通知渠道。
export function createRealtimeCollector<T extends LiveSample>(options: CollectorOptions<T>): RealtimeCollector<T> {
  const now = options.now ?? Date.now;
  const setTimer = options.setTimer ?? ((callback, delay) => {
    const timer = setTimeout(callback, delay);
    timer.unref?.();
    return timer;
  });
  const clearTimer = options.clearTimer ?? clearTimeout;
  let running = false;
  let subscribers = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: Promise<T | null> | null = null;
  let cycleRunning = false;
  let generation = 0;
  let latest: T | null = null;
  let lastAttemptAt: number | null = null;
  let lastSuccessAt: number | null = null;
  let nextAttemptAt: number | null = null;
  let consecutiveFailures = 0;
  let lastError: string | null = null;
  let sequence = 0;
  let configured = true;

  function interval(): number {
    if (!configured) return REALTIME_BACKGROUND_INTERVAL_MS;
    if (consecutiveFailures > 0) {
      return Math.min(REALTIME_MAX_RETRY_MS, REALTIME_MIN_RETRY_MS * 2 ** Math.min(consecutiveFailures - 1, 8));
    }
    return subscribers > 0 ? REALTIME_VISIBLE_INTERVAL_MS : REALTIME_BACKGROUND_INTERVAL_MS;
  }

  function getStatus(): RealtimeCollectorStatus {
    return {
      running, subscribers, intervalMs: interval(), sequence,
      lastAttemptAt: lastAttemptAt === null ? null : new Date(lastAttemptAt).toISOString(),
      lastSuccessAt: lastSuccessAt === null ? null : new Date(lastSuccessAt).toISOString(),
      nextAttemptAt: nextAttemptAt === null ? null : new Date(nextAttemptAt).toISOString(),
      ageMs: lastSuccessAt === null ? null : Math.max(0, now() - lastSuccessAt),
      consecutiveFailures, lastError,
    };
  }

  function getSnapshot(): T | null {
    return latest ? options.decorate(latest, getStatus()) : null;
  }

  function clearScheduled(): void {
    if (timer !== null) clearTimer(timer);
    timer = null;
    nextAttemptAt = null;
  }

  function schedule(delay: number): void {
    if (!running || cycleRunning) return;
    clearScheduled();
    const currentGeneration = generation;
    nextAttemptAt = now() + delay;
    timer = setTimer(() => {
      timer = null;
      nextAttemptAt = null;
      cycleRunning = true;
      const startedAt = now();
      void collectNow().finally(() => {
        cycleRunning = false;
        if (!running) return;
        if (generation !== currentGeneration) { schedule(0); return; }
        // 采集耗时计入周期，避免“采集一秒、再等待一秒”的累积延迟。
        const desired = interval();
        schedule(Math.max(50, desired - Math.max(0, now() - startedAt)));
      });
    }, delay);
  }

  function start(): void {
    if (running) return;
    running = true;
    generation += 1;
    schedule(0);
  }

  function stop(): void {
    running = false;
    generation += 1;
    clearScheduled();
  }

  function acquireSubscriber(): () => void {
    subscribers += 1;
    start();
    if (!cycleRunning && consecutiveFailures === 0) {
      const elapsed = lastAttemptAt === null ? Infinity : Math.max(0, now() - lastAttemptAt);
      schedule(Math.max(0, REALTIME_VISIBLE_INTERVAL_MS - elapsed));
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      subscribers = Math.max(0, subscribers - 1);
      if (!cycleRunning && running && consecutiveFailures === 0 && subscribers === 0) {
        const elapsed = lastAttemptAt === null ? 0 : Math.max(0, now() - lastAttemptAt);
        schedule(Math.max(50, REALTIME_BACKGROUND_INTERVAL_MS - elapsed));
      }
    };
  }

  async function executeCollection(): Promise<T | null> {
    try {
      configured = options.isConfigured();
      if (!configured) {
        lastError = 'CPE 未配置';
        consecutiveFailures = 0;
        latest = options.failureSample(lastError, null);
        return getSnapshot();
      }
      lastAttemptAt = now();
      const sample = await options.collect();
      latest = sample;
      const sampledAt = sample.collectedAt ? Date.parse(sample.collectedAt) : NaN;
      const sampleExpired = Number.isFinite(sampledAt) && now() - sampledAt > Math.max(5_000, interval() * 3);
      if (sample.stale || !Number.isFinite(sampledAt) || sampleExpired) {
        consecutiveFailures += 1;
        lastError = options.readError(sample) || (sampleExpired ? '本轮设备采样已过期' : '设备未返回有效的实时采样');
        latest = options.failureSample(lastError, sample) ?? sample;
      } else {
        lastSuccessAt = sampledAt;
        consecutiveFailures = 0;
        lastError = null;
      }
    } catch (error) {
      consecutiveFailures += 1;
      lastError = error instanceof Error ? error.message : '实时采集失败';
      latest = options.failureSample(lastError, latest);
    }
    sequence += 1;
    const snapshot = getSnapshot();
    if (snapshot && running) options.publish(snapshot);
    return snapshot;
  }

  function collectNow(): Promise<T | null> {
    if (pending) return pending;
    // 在回调执行前保存 Promise，同步失败和并发启动同样只产生一次采集。
    const task = Promise.resolve().then(executeCollection);
    pending = task;
    void task.finally(() => { if (pending === task) pending = null; });
    return task;
  }

  return { start, stop, acquireSubscriber, collectNow, getSnapshot, getStatus };
}
