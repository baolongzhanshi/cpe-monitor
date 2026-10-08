'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/lib/client-api';
import { parseDateTime } from '@/lib/date-time';
import { getLiveSampleTime, isOlderLiveSample, type LiveDashboardViewSnapshot } from '@/lib/live-view-model';
import { isPageVisible, usePageVisibility } from './usePageVisibility';
import { useSSE, type SSEEvent } from './useSSE';
import type { OnlineDeviceRow } from '@/components/device/OnlineDevicesTable';
import type { CpeDevicePageResponse, CpeNetworkSnapshot } from '@/types/cpe';

export type DevicePageData = CpeDevicePageResponse;

const DEVICE_DETAILS_INTERVAL_MS = 5 * 60_000;
const ONLINE_DEVICES_INTERVAL_MS = 5_000;
const LIVE_FALLBACK_INTERVAL_MS = 2_000;
const DEVICE_EVENT_TYPES = ['metrics', 'connection'] as const;

export function useDevicePage() {
  const pageVisible = usePageVisibility();
  const [deviceInfo, setDeviceInfo] = useState<DevicePageData | null>(null);
  const [loading, setLoading] = useState(true);
  const [rawDevices, setRawDevices] = useState<OnlineDeviceRow[]>([]);
  const [devicesLoading, setDevicesLoading] = useState(true);
  const [selectedDevice, setSelectedDevice] = useState<OnlineDeviceRow | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [deviceError, setDeviceError] = useState('');
  const [devicesError, setDevicesError] = useState('');
  const [liveError, setLiveError] = useState('');
  const [lastRefreshAt, setLastRefreshAt] = useState<Date | null>(null);
  const [lastRefreshStale, setLastRefreshStale] = useState(true);
  const latestNetworkRef = useRef<CpeNetworkSnapshot | null>(null);
  const latestNetworkTimeRef = useRef<number | null>(null);
  const devicePendingRef = useRef<Promise<void> | null>(null);
  const devicesPendingRef = useRef<Promise<void> | null>(null);
  const livePendingRef = useRef<Promise<void> | null>(null);
  const deviceAbortRef = useRef<AbortController | null>(null);
  const devicesAbortRef = useRef<AbortController | null>(null);
  const liveAbortRef = useRef<AbortController | null>(null);

  const applyLiveSnapshot = useCallback((data: LiveDashboardViewSnapshot) => {
    if (!isPageVisible()) return;
    if (data.stale || data.overview.cpeError) {
      setLiveError(data.overview.cpeError || '实时信号暂不可用，保留最近一次数据');
      setLastRefreshStale(true);
      return;
    }
    const collectedAt = parseDateTime(data.fieldCollectedAt?.network) || getLiveSampleTime(data);
    if (!collectedAt || isOlderLiveSample(collectedAt, latestNetworkTimeRef.current)) return;
    const network = data.overview.networkSnapshot;
    if (!network) return;
    setLiveError('');
    setLastRefreshStale(false);
    // 速率事件每秒抵达，只有信号实际采集时间变化时才更新设备详情。
    if (collectedAt.getTime() === latestNetworkTimeRef.current) return;
    latestNetworkTimeRef.current = collectedAt.getTime();
    setLastRefreshAt(collectedAt);
    latestNetworkRef.current = network as CpeNetworkSnapshot;
    setDeviceInfo((current) => current
      ? { ...current, cellInformation: latestNetworkRef.current || current.cellInformation }
      : current);
  }, []);

  const fetchDeviceInfo = useCallback(async () => {
    if (!isPageVisible()) return;
    if (devicePendingRef.current) return devicePendingRef.current;
    const controller = new AbortController();
    deviceAbortRef.current = controller;
    const task = (async () => {
      try {
        const data = await apiFetch<DevicePageData>(
          '/api/dashboard/device',
          { signal: controller.signal },
          '获取设备信息失败',
        );
        if (controller.signal.aborted || !isPageVisible()) return;
        if (data.deviceInformation?.DeviceName) {
          // 慢身份读取晚于实时事件完成时，保留刚收到的信号和小区状态。
          setDeviceInfo(latestNetworkRef.current
            ? { ...data, cellInformation: latestNetworkRef.current }
            : data);
          if (data.source === 'database') {
            setDeviceError(
              data.cpeError
                ? `CPE 暂不可用，已显示本地缓存：${data.cpeError}`
                : 'CPE 暂不可用，已显示本地缓存设备信息',
            );
          } else {
            setDeviceError('');
          }
          return;
        }
        throw new Error('CPE 未返回设备身份信息，请点击刷新重试');
      } catch (error) {
        if (controller.signal.aborted || !isPageVisible()) return;
        setDeviceError(error instanceof Error ? error.message : '无法获取设备信息');
      } finally {
        if (!controller.signal.aborted && isPageVisible()) setLoading(false);
      }
    })();
    devicePendingRef.current = task;
    try {
      await task;
    } finally {
      if (devicePendingRef.current === task) devicePendingRef.current = null;
      if (deviceAbortRef.current === controller) deviceAbortRef.current = null;
    }
  }, []);

  const fetchConnectedDevices = useCallback(async () => {
    if (!isPageVisible()) return;
    if (devicesPendingRef.current) return devicesPendingRef.current;
    const controller = new AbortController();
    devicesAbortRef.current = controller;
    const task = (async () => {
      try {
        const data = await apiFetch<{ devices?: OnlineDeviceRow[] }>(
          '/api/dashboard/devices',
          { signal: controller.signal },
          '获取在线设备失败',
        );
        if (controller.signal.aborted || !isPageVisible()) return;
        setRawDevices(data.devices || []);
        setDevicesError('');
      } catch (error) {
        if (controller.signal.aborted || !isPageVisible()) return;
        setDevicesError(
          error instanceof Error ? error.message : 'CPE 登录失败，无法获取在线设备列表。',
        );
      } finally {
        if (!controller.signal.aborted && isPageVisible()) setDevicesLoading(false);
      }
    })();
    devicesPendingRef.current = task;
    try {
      await task;
    } finally {
      if (devicesPendingRef.current === task) devicesPendingRef.current = null;
      if (devicesAbortRef.current === controller) devicesAbortRef.current = null;
    }
  }, []);

  const refreshDevicePage = useCallback(async () => {
    // CPE 共享设备会话，先读取慢身份信息，再读取终端列表。
    await fetchDeviceInfo();
    await fetchConnectedDevices();
  }, [fetchConnectedDevices, fetchDeviceInfo]);

  const fetchLiveSignal = useCallback(async () => {
    if (!isPageVisible()) return;
    if (livePendingRef.current) return livePendingRef.current;
    const controller = new AbortController();
    liveAbortRef.current = controller;
    const task = (async () => {
      try {
        const data = await apiFetch<LiveDashboardViewSnapshot>(
          '/api/dashboard/live', { signal: controller.signal }, '获取实时信号失败',
        );
        if (!controller.signal.aborted) applyLiveSnapshot(data);
      } catch (error) {
        if (!controller.signal.aborted && isPageVisible()) {
          setLiveError(error instanceof Error ? error.message : '获取实时信号失败');
          setLastRefreshStale(true);
        }
      }
    })();
    livePendingRef.current = task;
    try {
      await task;
    } finally {
      if (livePendingRef.current === task) livePendingRef.current = null;
      if (liveAbortRef.current === controller) liveAbortRef.current = null;
    }
  }, [applyLiveSnapshot]);

  const handleSSEEvent = useCallback((event: SSEEvent) => {
    if (event.type === 'metrics' && event.payload.overview && event.payload.trafficStats) {
      applyLiveSnapshot(event.payload as unknown as LiveDashboardViewSnapshot);
    } else if (event.type === 'connection' && event.payload.status === 'error') {
      setLiveError(String(event.payload.message || '实时采集连接失败'));
      setLastRefreshStale(true);
    }
  }, [applyLiveSnapshot]);
  const { status: sseStatus } = useSSE({
    onEvent: handleSSEEvent, enabled: pageVisible, eventTypes: DEVICE_EVENT_TYPES,
  });

  useEffect(() => {
    if (!pageVisible) return;
    const initialTimer = window.setTimeout(() => {
      void refreshDevicePage();
      void fetchLiveSignal();
    }, 0);
    const detailsTimer = window.setInterval(() => void refreshDevicePage(), DEVICE_DETAILS_INTERVAL_MS);
    const devicesTimer = window.setInterval(() => {
      if (!devicePendingRef.current) void fetchConnectedDevices();
    }, ONLINE_DEVICES_INTERVAL_MS);
    return () => {
      window.clearTimeout(initialTimer);
      window.clearInterval(detailsTimer);
      window.clearInterval(devicesTimer);
      deviceAbortRef.current?.abort();
      devicesAbortRef.current?.abort();
      liveAbortRef.current?.abort();
    };
  }, [pageVisible, refreshDevicePage, fetchConnectedDevices, fetchLiveSignal]);

  useEffect(() => {
    if (!pageVisible || sseStatus === 'connected') return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      await fetchLiveSignal();
      if (!stopped && isPageVisible()) timer = setTimeout(() => void poll(), LIVE_FALLBACK_INTERVAL_MS);
    };
    timer = setTimeout(() => void poll(), LIVE_FALLBACK_INTERVAL_MS);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [pageVisible, sseStatus, fetchLiveSignal]);

  useEffect(() => {
    if (loading || window.location.hash !== '#online-devices') return;
    const frame = window.requestAnimationFrame(() => {
      document.getElementById('online-devices')?.scrollIntoView({
        behavior: 'smooth',
        block: 'start',
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [loading]);

  return {
    deviceInfo,
    loading,
    rawDevices,
    devicesLoading,
    selectedDevice,
    setSelectedDevice,
    dialogOpen,
    setDialogOpen,
    deviceError: deviceError || liveError,
    devicesError,
    refreshDevicePage,
    sseStatus,
    lastRefreshAt,
    lastRefreshStale,
  };
}
