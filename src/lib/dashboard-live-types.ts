import type { DashboardOverviewResponse } from '../types/index';
import type { CpeTrafficStatistics } from '../types/cpe';

export interface RealtimeCollectorStatus {
  running: boolean;
  subscribers: number;
  intervalMs: number;
  sequence: number;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  nextAttemptAt: string | null;
  ageMs: number | null;
  consecutiveFailures: number;
  lastError: string | null;
}

export type DashboardLiveResponse = {
  overview: DashboardOverviewResponse;
  trafficStats: CpeTrafficStatistics;
  collectedAt: string | null;
  stale: boolean;
  fieldCollectedAt?: Record<string, string | null>;
  fieldErrors?: Record<string, string>;
  realtime?: RealtimeCollectorStatus;
};
