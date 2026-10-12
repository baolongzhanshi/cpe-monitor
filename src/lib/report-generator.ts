import { db } from './db';
import type { DailyReport, DeviceRanking } from '@/types';
import {
  getAppDateKey,
  getAppDayRange,
  getAppHour,
  toSqliteTimestamp,
} from './date-time';
import { computeCounterDelta } from './traffic-units';

interface TrafficReportRow {
  timestamp: string;
  upload_bytes: number | null;
  download_bytes: number | null;
  delta_upload_bytes: number | null;
  delta_download_bytes: number | null;
  upload_bps: number | null;
  download_bps: number | null;
  connected_devices: number | null;
  signal_strength: number | null;
  network_type: string | null;
  band: string | null;
  rsrp: number | null;
  rsrq: number | null;
  sinr: number | null;
  rssi: number | null;
}

interface DeviceReportRow {
  timestamp: string;
  device_name: string | null;
  device_ip: string | null;
  device_mac: string | null;
  upload_bytes: number | null;
  download_bytes: number | null;
  delta_upload_bytes: number | null;
  delta_download_bytes: number | null;
}

function average(values: Array<number | null | undefined>): number | null {
  const available = values.filter((value): value is number => (
    typeof value === 'number' && Number.isFinite(value)
  ));
  if (available.length === 0) return null;
  return available.reduce((total, value) => total + value, 0) / available.length;
}

function getLocalHour(timestamp: string): number {
  return getAppHour(timestamp) ?? 0;
}

interface TrafficSummary {
  totalUpload: number;
  totalDownload: number;
  peakHour: number | null;
  peakTrafficBytes: number;
  networkTypes: string[];
  bands: string[];
}

function computeTrafficSummary(rows: TrafficReportRow[]): TrafficSummary {
  let totalUpload = 0;
  let totalDownload = 0;
  let previousRow: TrafficReportRow | undefined;
  const hourlyTraffic: Record<number, number> = {};
  const networkTypes = new Set<string>();
  const bands = new Set<string>();

  for (const row of rows) {
    const uploadDelta = row.delta_upload_bytes
      ?? computeCounterDelta(row.upload_bytes, previousRow?.upload_bytes);
    const downloadDelta = row.delta_download_bytes
      ?? computeCounterDelta(row.download_bytes, previousRow?.download_bytes);
    totalUpload += uploadDelta;
    totalDownload += downloadDelta;
    const hour = getLocalHour(row.timestamp);
    hourlyTraffic[hour] = (hourlyTraffic[hour] || 0) + uploadDelta + downloadDelta;
    if (row.network_type?.trim()) networkTypes.add(row.network_type.trim());
    if (row.band?.trim()) bands.add(row.band.trim());
    previousRow = row;
  }

  let peakHour: number | null = null;
  let peakTrafficBytes = 0;
  for (const [hour, bytes] of Object.entries(hourlyTraffic)) {
    if (bytes > peakTrafficBytes) {
      peakTrafficBytes = bytes;
      peakHour = Number(hour);
    }
  }

  return {
    totalUpload,
    totalDownload,
    peakHour,
    peakTrafficBytes,
    networkTypes: Array.from(networkTypes),
    bands: Array.from(bands),
  };
}

function computeDeviceRankings(rows: DeviceReportRow[]): DeviceRanking[] {
  const deviceMap = new Map<string, DeviceRanking & {
    previousUpload: number | null;
    previousDownload: number | null;
  }>();

  for (const row of rows) {
    const key = row.device_mac || row.device_ip || `unknown-${row.device_name || 'device'}`;
    const current = deviceMap.get(key) || {
      name: row.device_name || '未知设备',
      ip: row.device_ip || '',
      mac: row.device_mac || key,
      uploadBytes: 0,
      downloadBytes: 0,
      totalBytes: 0,
      previousUpload: null,
      previousDownload: null,
    };
    const uploadDelta = row.delta_upload_bytes
      ?? computeCounterDelta(row.upload_bytes, current.previousUpload);
    const downloadDelta = row.delta_download_bytes
      ?? computeCounterDelta(row.download_bytes, current.previousDownload);
    current.name = row.device_name || current.name;
    current.ip = row.device_ip || current.ip;
    current.mac = row.device_mac || current.mac;
    current.uploadBytes += uploadDelta;
    current.downloadBytes += downloadDelta;
    current.totalBytes = current.uploadBytes + current.downloadBytes;
    current.previousUpload = row.upload_bytes;
    current.previousDownload = row.download_bytes;
    deviceMap.set(key, current);
  }

  return Array.from(deviceMap.values())
    .map(({ name, ip, mac, uploadBytes, downloadBytes, totalBytes }) => ({
      name, ip, mac, uploadBytes, downloadBytes, totalBytes,
    }))
    .sort((left, right) => right.totalBytes - left.totalBytes)
    .slice(0, 10);
}

function computeNetworkQuality(
  sampleCount: number,
  qualitySignal: number | null,
  samplingRatio: number,
): string {
  if (sampleCount < 3 || qualitySignal === null) return '数据不足';
  if (qualitySignal >= -80 && samplingRatio >= 0.7) return '优秀';
  if (qualitySignal >= -95 && samplingRatio >= 0.5) return '良好';
  if (qualitySignal >= -105 && samplingRatio >= 0.3) return '一般';
  return '差';
}

/**
 * 生成日报。
 *
 * day 指定统计哪一天，默认当天——手动"生成今日预览"走这个口径，统计到此刻为止。
 * 定时推送必须传入前一个完整自然日：若统计当天，推送时刻之后的流量不会出现在任何日报里，
 * 例如默认 22:00 推送，每天 22:00 到 24:00 的数据就被永久漏掉。
 */
export async function generateDailyReport(options: { day?: Date } = {}): Promise<DailyReport> {
  const now = new Date();
  const day = options.day ?? now;
  const { dateKey: todayStr, start: today, end: tomorrow } = getAppDayRange(day);
  const todayIso = toSqliteTimestamp(today);
  const tomorrowIso = toSqliteTimestamp(tomorrow);
  // 统计已经结束的一天时按整天算期望采样数，否则只统计到此刻。
  const dayIsComplete = tomorrow.getTime() <= now.getTime();

  const todayTraffic = db.prepare(
    `SELECT
       timestamp, upload_bytes, download_bytes,
       delta_upload_bytes, delta_download_bytes,
       upload_bps, download_bps,
       connected_devices, signal_strength,
       network_type, band, rsrp, rsrq, sinr, rssi
     FROM traffic_data
     WHERE timestamp >= ? AND timestamp < ?
     ORDER BY timestamp ASC`,
  ).all(todayIso, tomorrowIso) as TrafficReportRow[];

  const trafficSummary = computeTrafficSummary(todayTraffic);

  const todayDevices = db.prepare(
    `SELECT
       timestamp, device_name, device_ip, device_mac,
       upload_bytes, download_bytes,
       delta_upload_bytes, delta_download_bytes
     FROM device_data
     WHERE timestamp >= ? AND timestamp < ?
     ORDER BY device_mac, device_ip, timestamp ASC`,
  ).all(todayIso, tomorrowIso) as DeviceReportRow[];

  const topDevices = computeDeviceRankings(todayDevices);

  const intervalSetting = db.prepare(
    "SELECT value FROM system_settings WHERE key = 'scheduler_interval'",
  ).get() as { value?: string } | undefined;
  const intervalMinutes = Math.max(1, Number(intervalSetting?.value || 60));
  const elapsedMinutes = dayIsComplete
    ? 24 * 60
    : Math.min(24 * 60, Math.max(0, Math.ceil((now.getTime() - today.getTime()) / 60_000)));
  const expectedSamples = Math.max(1, Math.ceil(elapsedMinutes / intervalMinutes));
  const samplingRatio = expectedSamples > 0
    ? Math.min(1, todayTraffic.length / expectedSamples)
    : 0;
  const uptimePercent = Math.round(samplingRatio * 1000) / 10;

  const collectionCounts = db.prepare(
    `SELECT status, COUNT(*) AS count
     FROM collection_runs
     WHERE COALESCE(completed_at, started_at) >= ?
       AND COALESCE(completed_at, started_at) < ?
     GROUP BY status`,
  ).all(todayIso, tomorrowIso) as Array<{ status: string; count: number }>;
  const countByStatus = Object.fromEntries(
    collectionCounts.map((row) => [row.status, Number(row.count || 0)]),
  );
  const alertCountRow = db.prepare(
    `SELECT COUNT(*) AS count
     FROM alert_logs
     WHERE triggered_at >= ? AND triggered_at < ?`,
  ).get(todayIso, tomorrowIso) as { count: number } | undefined;

  const avgSignalValue = average(todayTraffic.map((row) => row.signal_strength));
  const avgRsrp = average(todayTraffic.map((row) => row.rsrp));
  const avgRsrq = average(todayTraffic.map((row) => row.rsrq));
  const avgSinr = average(todayTraffic.map((row) => row.sinr));
  const avgRssi = average(todayTraffic.map((row) => row.rssi));
  const qualitySignal = avgRsrp ?? avgSignalValue;
  const networkQuality = computeNetworkQuality(todayTraffic.length, qualitySignal, samplingRatio);

  const connectedValues = todayTraffic
    .map((row) => row.connected_devices)
    .filter((value): value is number => typeof value === 'number');

  return {
    id: 0,
    reportDate: todayStr,
    totalUpload: trafficSummary.totalUpload,
    totalDownload: trafficSummary.totalDownload,
    peakHour: trafficSummary.peakHour,
    topDevices,
    avgSignal: avgSignalValue === null ? null : Math.round(avgSignalValue),
    uptimePercent,
    networkQuality,
    sentAt: null,
    createdAt: null,
    sampleCount: todayTraffic.length,
    expectedSamples,
    successfulCollections: countByStatus.success || 0,
    failedCollections: countByStatus.failed || 0,
    alertCount: Number(alertCountRow?.count || 0),
    peakTrafficBytes: trafficSummary.peakTrafficBytes,
    peakDownloadBps: Math.max(0, ...todayTraffic.map((row) => row.download_bps || 0)),
    peakUploadBps: Math.max(0, ...todayTraffic.map((row) => row.upload_bps || 0)),
    averageDevices: connectedValues.length > 0
      ? connectedValues.reduce((total, value) => total + value, 0) / connectedValues.length
      : 0,
    maxDevices: Math.max(0, ...connectedValues),
    avgRsrp,
    avgRsrq,
    avgSinr,
    avgRssi,
    networkTypes: trafficSummary.networkTypes,
    bands: trafficSummary.bands,
    generatedAt: now.toISOString(),
  };
}

// ─── Weekly / Monthly report generation ──────────────────────────────────

export interface PeriodReport {
  periodType: 'weekly' | 'monthly';
  periodKey: string; // e.g. '2024-W03' or '2024-01'
  startDate: string;
  endDate: string;
  totalUpload: number;
  totalDownload: number;
  dailyAvgUpload: number;
  dailyAvgDownload: number;
  peakDay: string | null;
  peakDayTraffic: number;
  avgSignal: number | null;
  networkQuality: string;
  topDevices: DeviceRanking[];
  dayCount: number;
  generatedAt: string;
}

/** 按 ISO 8601 计算周序号，跨年那一周不会得到 W53 这种无效编号。 */
function isoWeekKey(dateKey: string): string {
  const date = new Date(`${dateKey}T00:00:00Z`);
  const dayNum = (date.getUTCDay() + 6) % 7; // 周一为 0
  const thursday = new Date(date.getTime() + (3 - dayNum) * 86400000);
  const jan4 = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 4));
  const firstThursday = new Date(jan4.getTime() + (3 - ((jan4.getUTCDay() + 6) % 7)) * 86400000);
  const week = 1 + Math.round((thursday.getTime() - firstThursday.getTime()) / (7 * 86400000));
  return `${thursday.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/**
 * 周报与月报的窗口同样按上海自然日计算。
 *
 * 这里原先用机器本地时区（getDay/setDate/setHours），而日报硬编码 +08:00，
 * 机器时区不是 Asia/Shanghai 时两类报告对"同一天"的定义就会互相打架。
 */
function getWeekRange(now: Date): { start: Date; end: Date; key: string } {
  const dateKey = getAppDateKey(now);
  const anchor = new Date(`${dateKey}T00:00:00Z`);
  const diffToMonday = (anchor.getUTCDay() + 6) % 7; // 周一为 0
  const mondayKey = new Date(anchor.getTime() - diffToMonday * 86400000).toISOString().slice(0, 10);
  const start = new Date(`${mondayKey}T00:00:00+08:00`);
  const end = new Date(start.getTime() + 7 * 86400000);
  return { start, end, key: isoWeekKey(mondayKey) };
}

function getMonthRange(now: Date): { start: Date; end: Date; key: string } {
  const monthKey = getAppDateKey(now).slice(0, 7); // YYYY-MM
  const [year, month] = monthKey.split('-').map(Number);
  const nextMonthKey = month === 12
    ? `${year + 1}-01`
    : `${year}-${String(month + 1).padStart(2, '0')}`;
  return {
    start: new Date(`${monthKey}-01T00:00:00+08:00`),
    end: new Date(`${nextMonthKey}-01T00:00:00+08:00`),
    key: monthKey,
  };
}

function generatePeriodReport(periodType: 'weekly' | 'monthly', range: { start: Date; end: Date; key: string }): PeriodReport {
  const startIso = toSqliteTimestamp(range.start);
  const endIso = toSqliteTimestamp(range.end);

  const trafficRows = db.prepare(
    `SELECT timestamp, upload_bytes, download_bytes, delta_upload_bytes, delta_download_bytes,
            upload_bps, download_bps, connected_devices, signal_strength,
            network_type, band, rsrp, rsrq, sinr, rssi
     FROM traffic_data WHERE timestamp >= ? AND timestamp < ? ORDER BY timestamp ASC`,
  ).all(startIso, endIso) as TrafficReportRow[];

  const deviceRows = db.prepare(
    `SELECT timestamp, device_name, device_ip, device_mac, upload_bytes, download_bytes,
            delta_upload_bytes, delta_download_bytes
     FROM device_data WHERE timestamp >= ? AND timestamp < ? ORDER BY device_mac, timestamp ASC`,
  ).all(startIso, endIso) as DeviceReportRow[];

  const summary = computeTrafficSummary(trafficRows);
  const topDevices = computeDeviceRankings(deviceRows);

  // Compute daily aggregates for peak day and averages
  const dailyMap = new Map<string, { upload: number; download: number }>();
  let prevRow: TrafficReportRow | undefined;
  for (const row of trafficRows) {
    const dayKey = row.timestamp.slice(0, 10);
    const upDelta = row.delta_upload_bytes ?? computeCounterDelta(row.upload_bytes, prevRow?.upload_bytes);
    const downDelta = row.delta_download_bytes ?? computeCounterDelta(row.download_bytes, prevRow?.download_bytes);
    const entry = dailyMap.get(dayKey) || { upload: 0, download: 0 };
    entry.upload += upDelta;
    entry.download += downDelta;
    dailyMap.set(dayKey, entry);
    prevRow = row;
  }

  let peakDay: string | null = null;
  let peakDayTraffic = 0;
  for (const [day, val] of dailyMap) {
    const total = val.upload + val.download;
    if (total > peakDayTraffic) { peakDayTraffic = total; peakDay = day; }
  }

  const dayCount = Math.max(1, dailyMap.size);
  const avgSignal = average(trafficRows.map((r) => r.signal_strength));
  const avgRsrp = average(trafficRows.map((r) => r.rsrp));
  const qualitySignal = avgRsrp ?? avgSignal;
  // 采样完整度与日报用同一口径：实际行数 ÷ 期望行数。
  // 这里原先写的是 `dayCount > 0 ? 0.7 : 0`，而 dayCount 已被 Math.max(1, …) 夹到 ≥1，
  // 那个 0 分支不可达，等于恒定传 0.7——评级完全不反映周期内实际采样是否完整。
  const intervalSetting = db.prepare(
    "SELECT value FROM system_settings WHERE key = 'scheduler_interval'",
  ).get() as { value?: string } | undefined;
  const periodIntervalMinutes = Math.max(1, Number(intervalSetting?.value || 60));
  const expectedPeriodSamples = Math.max(1, dayCount * Math.ceil((24 * 60) / periodIntervalMinutes));
  const periodSamplingRatio = Math.min(1, trafficRows.length / expectedPeriodSamples);
  const networkQuality = computeNetworkQuality(trafficRows.length, qualitySignal, periodSamplingRatio);

  return {
    periodType,
    periodKey: range.key,
    startDate: startIso.slice(0, 10),
    endDate: endIso.slice(0, 10),
    totalUpload: summary.totalUpload,
    totalDownload: summary.totalDownload,
    dailyAvgUpload: Math.round(summary.totalUpload / dayCount),
    dailyAvgDownload: Math.round(summary.totalDownload / dayCount),
    peakDay,
    peakDayTraffic,
    avgSignal: avgSignal === null ? null : Math.round(avgSignal),
    networkQuality,
    topDevices,
    dayCount,
    generatedAt: new Date().toISOString(),
  };
}

export function generateWeeklyReport(forDate?: Date): PeriodReport {
  const now = forDate || new Date();
  // Generate for the previous week
  const lastWeek = new Date(now);
  lastWeek.setDate(now.getDate() - 7);
  const range = getWeekRange(lastWeek);
  return generatePeriodReport('weekly', range);
}

export function generateMonthlyReport(forDate?: Date): PeriodReport {
  const now = forDate || new Date();
  // Generate for the previous month
  const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 15);
  const range = getMonthRange(lastMonth);
  return generatePeriodReport('monthly', range);
}
