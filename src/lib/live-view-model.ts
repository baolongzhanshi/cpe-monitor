import { parseDateTime, parseTimestampMs } from './date-time.ts';
import { bytesPerSecondToBitsPerSecond } from './traffic-units.ts';
import type { DashboardOverviewResponse, TrafficStatsResponse } from '../types/index';
import type { TrafficHistoryPoint } from '../hooks/useTrafficHistory';

export const MAX_LIVE_POINTS = 180;
/**
 * 超过这个时长没有新样本，就认为界面展示的是历史数据。
 *
 * 秒级实时采集的正常年龄在 1 秒以内；SSE 断开后由 2 秒轮询兜底。
 * 取 6 秒可以容忍连续三次漏采，或两次兜底轮询外加网络延迟，
 * 避免链路上偶发慢一拍就把界面打成过期。
 */
export const LIVE_STALE_AFTER_MS = 6_000;

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

export type LiveFreshnessState = 'paused' | 'waiting' | 'current' | 'stale';

/**
 * 实时数据新鲜度的唯一判定入口。
 *
 * 徽章和状态行原先各用一套规则，会出现一边写"实时 CPE 数据"、
 * 另一边写"显示最近一次数据"的矛盾，所以把判定收敛到这里，两个组件共用结果。
 *
 * watchingSinceMs 是本次可见的起始时刻。刚恢复可见时，上一次采样必然早于恢复时刻，
 * 直接按采样时间判定会立刻闪报过期；因此从恢复时刻起算，给数据留一个到达窗口。
 * 数据正常时采样时间总晚于恢复时刻，锚点自然回落到采样时间，不受影响。
 */
export function readLiveFreshness(input: {
  collectedAt: Date | null;
  stale: boolean;
  pageVisible: boolean;
  watchingSinceMs: number;
  now?: number;
}): LiveFreshnessState {
  const {
    collectedAt, stale, pageVisible, watchingSinceMs, now = Date.now(),
  } = input;
  if (!pageVisible) return 'paused';
  if (!collectedAt) return 'waiting';
  if (stale) return 'stale';
  const anchoredAt = new Date(Math.max(collectedAt.getTime(), watchingSinceMs));
  return isLiveSampleFresh(anchoredAt, false, now) ? 'current' : 'stale';
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
