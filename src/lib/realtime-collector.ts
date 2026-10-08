import { eventBus } from './event-bus';
import { readDashboardLiveResponse } from './dashboard-live-service';
import { isCpeConfigured } from './settings-store';
import { createRealtimeCollector } from './realtime-collector-core';
import { getRealtimeRuntime } from './realtime-collector-state';
import type { DashboardLiveResponse } from './dashboard-live-types';

function getCollector() {
  const runtime = getRealtimeRuntime();
  return runtime.collector ??= createRealtimeCollector<DashboardLiveResponse>({
    collect: () => readDashboardLiveResponse('realtime'),
    isConfigured: isCpeConfigured,
    publish: (sample) => eventBus.broadcast('metrics', sample),
    readError: (sample) => sample.overview.cpeError,
    failureSample: (message, previous) => previous ? {
      ...previous, stale: true,
      overview: { ...previous.overview, cpeError: message },
    } : null,
    decorate: (sample, realtime) => {
      const aged = realtime.ageMs !== null && realtime.ageMs > Math.max(5_000, realtime.intervalMs * 3);
      return {
        ...sample, realtime, stale: sample.stale || aged,
        overview: aged && !sample.overview.cpeError
          ? { ...sample.overview, cpeError: '最近采集结果已过期，正在等待新采样。' }
          : sample.overview,
      };
    },
  });
}

export function getRealtimeSnapshot(): DashboardLiveResponse | null {
  return getRealtimeRuntime().collector?.getSnapshot() ?? null;
}

export function getRealtimeCollectorStatus() {
  return getCollector().getStatus();
}

export async function ensureRealtimeCollectorStarted(): Promise<void> {
  if (process.env.CPE_ISOLATED_TEST === 'true') return;
  // 启动时不阻塞健康接口，设备暂时离线也能打开设置页面。
  getCollector().start();
}

export function acquireRealtimeSubscriber(): () => void {
  if (process.env.CPE_ISOLATED_TEST === 'true') return () => {};
  return getCollector().acquireSubscriber();
}

export function stopRealtimeCollector(): void {
  getRealtimeRuntime().collector?.stop();
}
