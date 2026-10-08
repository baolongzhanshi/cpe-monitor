'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/lib/client-api';
import {
  appendLiveHistoryPoint,
  createLiveHistoryPoint,
  getLiveSampleTime,
  isOlderLiveSample,
  type LiveDashboardViewSnapshot,
} from '@/lib/live-view-model';
import { useSSE, type SSEEvent } from './useSSE';
import { isPageVisible, usePageVisibility } from './usePageVisibility';
import type {
  DashboardOverviewResponse,
  DataPlanConfig,
  SmsSyncStatusView,
  TrafficStatsResponse,
} from '@/types';
import type { TrafficHistoryPoint } from './useTrafficHistory';

export interface DeviceSnapshot {
  deviceInformation?: Record<string, unknown>;
  cellInformation?: {
    cellId?: string;
    networkType?: string;
    carrier?: string;
    band?: string;
    pci?: string | number;
    rsrp?: string | number;
    rsrq?: string | number;
    sinr?: string | number;
  };
}

const LIVE_FALLBACK_POLL_INTERVAL_MS = 2_000;
const DETAILS_REFRESH_INTERVAL_MS = 5 * 60_000;
const SMS_STATUS_REFRESH_INTERVAL_MS = 15_000;

export function useLiveMetrics() {
  const pageVisible = usePageVisibility();
  const [overview, setOverview] = useState<DashboardOverviewResponse | null>(null);
  const [liveMetricHistory, setLiveMetricHistory] = useState<TrafficHistoryPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [trafficStats, setTrafficStats] = useState<TrafficStatsResponse | null>(null);
  const [startDate, setStartDate] = useState<DataPlanConfig | null>(null);
  const [overviewError, setOverviewError] = useState('');
  const [dataError, setDataError] = useState('');
  const [deviceSnapshot, setDeviceSnapshot] = useState<DeviceSnapshot | null>(null);
  const [smsSync, setSmsSync] = useState<SmsSyncStatusView | null>(null);
  const [lastRefreshAt, setLastRefreshAt] = useState<Date | null>(null);
  const [lastRefreshStale, setLastRefreshStale] = useState(true);
  const lastSampleTimeRef = useRef<number | null>(null);
  const livePendingRef = useRef<Promise<void> | null>(null);
  const detailsPendingRef = useRef<Promise<void> | null>(null);
  const smsPendingRef = useRef<Promise<void> | null>(null);
  const liveAbortRef = useRef<AbortController | null>(null);
  const detailsAbortRef = useRef<AbortController | null>(null);
  const smsAbortRef = useRef<AbortController | null>(null);
  const lastDetailsAttemptRef = useRef(0);
  const lastSmsAttemptRef = useRef(0);

  const applyLiveResponse = useCallback((data: LiveDashboardViewSnapshot) => {
    if (!isPageVisible()) return;
    const collectedAt = getLiveSampleTime(data);
    if (isOlderLiveSample(collectedAt, lastSampleTimeRef.current)) return;
    if (collectedAt || lastSampleTimeRef.current === null) {
      setOverview(data.overview);
      setTrafficStats(data.trafficStats);
    }
    setOverviewError(data.overview.cpeError || (data.stale ? '实时数据暂不可用，保留最近一次数据' : ''));
    setLastRefreshStale(Boolean(data.stale || data.overview.cpeError || !collectedAt));
    if (collectedAt) {
      lastSampleTimeRef.current = collectedAt.getTime();
      setLastRefreshAt(collectedAt);
    }
    setLiveMetricHistory((current) => appendLiveHistoryPoint(current, createLiveHistoryPoint(data)));
    setLoading(false);
  }, []);

  const fetchLiveMetrics = useCallback(async () => {
    if (!isPageVisible()) return;
    if (livePendingRef.current) return livePendingRef.current;
    const controller = new AbortController();
    liveAbortRef.current = controller;
    const task = (async () => {
      try {
        const data = await apiFetch<LiveDashboardViewSnapshot>(
          '/api/dashboard/live',
          { signal: controller.signal },
          '获取实时状态失败',
        );
        if (controller.signal.aborted || !isPageVisible()) return;
        applyLiveResponse(data);
      } catch (error) {
        if (controller.signal.aborted || !isPageVisible()) return;
        setOverviewError(error instanceof Error ? error.message : '获取实时状态失败');
        setLastRefreshStale(true);
      } finally {
        if (!controller.signal.aborted && isPageVisible()) setLoading(false);
      }
    })();
    livePendingRef.current = task;
    try {
      await task;
    } finally {
      if (livePendingRef.current === task) livePendingRef.current = null;
      if (liveAbortRef.current === controller) liveAbortRef.current = null;
    }
  }, [applyLiveResponse]);

  const fetchDetails = useCallback(async (force = false) => {
    if (!isPageVisible()) return;
    if (detailsPendingRef.current) return detailsPendingRef.current;
    if (!force && Date.now() - lastDetailsAttemptRef.current < DETAILS_REFRESH_INTERVAL_MS) return;
    lastDetailsAttemptRef.current = Date.now();
    const controller = new AbortController();
    detailsAbortRef.current = controller;
    const task = (async () => {
      const [planResult, deviceResult] = await Promise.allSettled([
        apiFetch<DataPlanConfig>('/api/dashboard/start-date', { signal: controller.signal }, '获取套餐配置失败'),
        apiFetch<DeviceSnapshot>('/api/dashboard/device', { signal: controller.signal }, '获取设备快照失败'),
      ]);
      if (controller.signal.aborted || !isPageVisible()) return;
      if (planResult.status === 'fulfilled') {
        setStartDate(planResult.value);
        setDataError('');
      } else {
        setDataError(planResult.reason instanceof Error ? planResult.reason.message : '获取套餐配置失败');
      }
      if (deviceResult.status === 'fulfilled') setDeviceSnapshot(deviceResult.value);
    })();
    detailsPendingRef.current = task;
    try {
      await task;
    } finally {
      if (detailsPendingRef.current === task) detailsPendingRef.current = null;
      if (detailsAbortRef.current === controller) detailsAbortRef.current = null;
    }
  }, []);

  const fetchSmsSyncStatus = useCallback(async (force = false) => {
    if (!isPageVisible()) return;
    if (smsPendingRef.current) return smsPendingRef.current;
    if (!force && Date.now() - lastSmsAttemptRef.current < SMS_STATUS_REFRESH_INTERVAL_MS) return;
    lastSmsAttemptRef.current = Date.now();
    const controller = new AbortController();
    smsAbortRef.current = controller;
    const task = (async () => {
      try {
        const data = await apiFetch<SmsSyncStatusView>(
          '/api/dashboard/sms/settings',
          { signal: controller.signal },
          '获取短信同步状态失败',
        );
        if (!controller.signal.aborted && isPageVisible()) setSmsSync(data);
      } catch {
        // 自动读取失败时保留上次状态，下一轮继续读取本机数据库。
      }
    })();
    smsPendingRef.current = task;
    try {
      await task;
    } finally {
      if (smsPendingRef.current === task) smsPendingRef.current = null;
      if (smsAbortRef.current === controller) smsAbortRef.current = null;
    }
  }, []);

  const refreshAll = useCallback(async () => {
    await Promise.allSettled([fetchLiveMetrics(), fetchDetails(true), fetchSmsSyncStatus(true)]);
  }, [fetchLiveMetrics, fetchDetails, fetchSmsSyncStatus]);

  const handleSSEEvent = useCallback((event: SSEEvent) => {
    if (event.type === 'connection' && event.payload.status === 'error') {
      setLastRefreshStale(true);
      setOverviewError(String(event.payload.message || '实时采集连接失败'));
      return;
    }
    if (event.type !== 'metrics' || !event.payload.overview || !event.payload.trafficStats) return;
    applyLiveResponse(event.payload as unknown as LiveDashboardViewSnapshot);
  }, [applyLiveResponse]);
  const { status: sseStatus } = useSSE({ onEvent: handleSSEEvent, enabled: pageVisible });

  useEffect(() => {
    if (!pageVisible) return;
    void fetchDetails();
    void fetchSmsSyncStatus();
    void fetchLiveMetrics();
    const detailsTimer = setInterval(() => void fetchDetails(), DETAILS_REFRESH_INTERVAL_MS);
    const smsTimer = setInterval(() => void fetchSmsSyncStatus(), SMS_STATUS_REFRESH_INTERVAL_MS);
    return () => {
      clearInterval(detailsTimer);
      clearInterval(smsTimer);
      liveAbortRef.current?.abort();
      detailsAbortRef.current?.abort();
      smsAbortRef.current?.abort();
      // 中断的辅助读取在恢复可见时重新执行。
      if (detailsAbortRef.current) lastDetailsAttemptRef.current = 0;
      if (smsAbortRef.current) lastSmsAttemptRef.current = 0;
    };
  }, [pageVisible, fetchLiveMetrics, fetchDetails, fetchSmsSyncStatus]);

  // SSE 正常连接时完全由事件驱动；只有断线或连接失败才使用 2 秒兜底轮询。
  useEffect(() => {
    if (!pageVisible || sseStatus === 'connected') return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      await fetchLiveMetrics();
      if (!stopped && isPageVisible()) {
        timer = setTimeout(() => void poll(), LIVE_FALLBACK_POLL_INTERVAL_MS);
      }
    };
    timer = setTimeout(() => void poll(), LIVE_FALLBACK_POLL_INTERVAL_MS);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [pageVisible, sseStatus, fetchLiveMetrics]);

  return {
    overview,
    setOverview,
    liveMetricHistory,
    loading,
    trafficStats,
    startDate,
    overviewError,
    dataError,
    deviceSnapshot,
    smsSync,
    lastRefreshAt,
    lastRefreshStale,
    refreshAll,
    sseStatus,
  };
}
