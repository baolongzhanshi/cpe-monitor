'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/lib/client-api';
import { isPageVisible, usePageVisibility } from './usePageVisibility';

export interface TrafficHistoryPoint {
  timestamp: string;
  uploadBytes?: number;
  downloadBytes?: number;
  uploadBps?: number;
  downloadBps?: number;
  connectedDevices?: number;
  signalStrength?: number;
  networkType?: string | null;
  band?: string | null;
  cellId?: string | null;
  pci?: string | null;
  rsrp?: number | null;
  rsrq?: number | null;
  sinr?: number | null;
  rssi?: number | null;
}

export function useTrafficHistory() {
  const pageVisible = usePageVisibility();
  const [trafficHistory, setTrafficHistory] = useState<TrafficHistoryPoint[]>([]);
  const [timeRange, setTimeRange] = useState('24h');
  const historyAbortRef = useRef<AbortController | null>(null);

  const fetchTrafficHistory = useCallback(async (range = timeRange) => {
    if (!isPageVisible()) return;
    historyAbortRef.current?.abort();
    const controller = new AbortController();
    historyAbortRef.current = controller;
    try {
      const data = await apiFetch<TrafficHistoryPoint[]>(
        `/api/dashboard/traffic?range=${range}`,
        { signal: controller.signal },
        '获取流量历史失败',
      );
      if (!controller.signal.aborted && isPageVisible()) {
        setTrafficHistory(Array.isArray(data) ? data : []);
      }
    } catch (error) {
      if (!controller.signal.aborted) console.error(error);
    } finally {
      if (historyAbortRef.current === controller) historyAbortRef.current = null;
    }
  }, [timeRange]);

  useEffect(() => {
    if (!pageVisible) return;
    const timer = window.setTimeout(() => {
      void fetchTrafficHistory(timeRange);
    }, 0);
    return () => {
      window.clearTimeout(timer);
      historyAbortRef.current?.abort();
    };
  }, [pageVisible, timeRange, fetchTrafficHistory]);

  return {
    trafficHistory,
    timeRange,
    setTimeRange,
    fetchTrafficHistory,
  };
}
