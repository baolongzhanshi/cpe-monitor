import type { RealtimeCollector } from './realtime-collector-core';
import type { DashboardLiveResponse } from './dashboard-live-types';
import type { DashboardLiveClient, createDashboardLiveReader } from './dashboard-live-reader';

interface RealtimeRuntime {
  collector: RealtimeCollector<DashboardLiveResponse> | null;
  readers: WeakMap<DashboardLiveClient, ReturnType<typeof createDashboardLiveReader>>;
}

const shared = globalThis as typeof globalThis & {
  __cpeMonitorRealtimeRuntime?: RealtimeRuntime;
};

export function getRealtimeRuntime(): RealtimeRuntime {
  return shared.__cpeMonitorRealtimeRuntime ??= { collector: null, readers: new WeakMap() };
}
