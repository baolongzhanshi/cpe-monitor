import { parseDateTime, parseTimestampMs } from './date-time.ts';
import { bytesPerSecondToBitsPerSecond } from './traffic-units.ts';
import type { DashboardOverviewResponse, TrafficStatsResponse } from '../types/index';
import type { TrafficHistoryPoint } from '../hooks/useTrafficHistory';

export const MAX_LIVE_POINTS = 180;
export const LIVE_STALE_AFTER_MS = 4_000;

export interface LiveDashboardViewSnapshot {
  overview: DashboardOverviewResponse;
  trafficStats: TrafficStatsResponse;
  collectedAt: string | null;
  stale: boolean;
  sequence?: number;
  fieldCollectedAt?: Record<string, string | null>;
  fieldErrors?: Record<string, string>;
}

export function getLiveSampleTime(data: LiveDashboardViewSnapshot): Date | null {
  return parseDateTime(data.collectedAt);
}

export function isOlderLiveSample(sampleTime: Date | null, latestTimeMs: number | null): boolean {
  return sampleTime !== null && latestTimeMs !== null && sampleTime.getTime() < latestTimeMs;
}

export function isLiveSampleFresh(
  collectedAt: Date | null,
  stale: boolean,
  now = Date.now(),
): boolean {
  if (stale || !collectedAt) return false;
  const ageMs = now - collectedAt.getTime();
  return Number.isFinite(ageMs) && ageMs >= -5_000 && ageMs <= LIVE_STALE_AFTER_MS;
}

function metricNumber(value: unknown): number | null {
  const match = String(value ?? '').match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const number = Number(match[0]);
  return Number.isFinite(number) ? number : null;
}

export function createLiveHistoryPoint(data: LiveDashboardViewSnapshot): TrafficHistoryPoint | null {
  const collectedAt = getLiveSampleTime(data);
  if (data.stale || data.overview.cpeError || !collectedAt) return null;
  const network = data.overview.networkSnapshot;
  return {
    timestamp: collectedAt.toISOString(),
    uploadBps: bytesPerSecondToBitsPerSecond(Number(data.trafficStats.CurrentUploadRate)),
    downloadBps: bytesPerSecondToBitsPerSecond(Number(data.trafficStats.CurrentDownloadRate)),
    connectedDevices: data.overview.connectedDevices,
    signalStrength: data.overview.signalStrength,
    rsrp: metricNumber(network?.rsrp) ?? data.overview.signalStrength,
    rsrq: metricNumber(network?.rsrq),
    sinr: metricNumber(network?.sinr),
    rssi: metricNumber(network?.rssi),
    networkType: data.overview.networkType || null,
    band: network?.band == null ? null : String(network.band),
    cellId: network?.cellId == null ? null : String(network.cellId),
    pci: network?.pci == null ? null : String(network.pci),
  };
}

export function appendLiveHistoryPoint(
  current: TrafficHistoryPoint[],
  point: TrafficHistoryPoint | null,
): TrafficHistoryPoint[] {
  if (!point) return current;
  const currentLastMs = parseTimestampMs(current.at(-1)?.timestamp);
  const pointMs = parseTimestampMs(point.timestamp);
  // 重复快照或迟到事件不会重复插入，也不会让曲线时间倒退。
  if (pointMs === null || (currentLastMs !== null && pointMs <= currentLastMs)) return current;
  return [...current.slice(-(MAX_LIVE_POINTS - 1)), point];
}

export function mergeLiveChartHistory(
  history: TrafficHistoryPoint[],
  live: TrafficHistoryPoint[],
): TrafficHistoryPoint[] {
  if (!live.length) return history;
  const tail = live[live.length - 1];
  const tailMs = parseTimestampMs(tail.timestamp);
  if (tailMs === null) return history;
  // 历史窗口保留原有采样，末尾只追加“当前速率”这一个点。
  // 之前把每秒一条的实时点整段并入历史序列：历史是 5~60 分钟一个点，
  // 末尾却多出上百个一秒点，配合类目轴等距摆放会让最后几秒占掉大块宽度、
  // 刻度重复成同一分钟，曲线形状也被实时段主导。
  return [...history.filter((point) => {
    const timestampMs = parseTimestampMs(point.timestamp);
    return timestampMs !== null && timestampMs < tailMs;
  }), tail];
}
