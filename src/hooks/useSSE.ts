'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { isPageVisible, usePageVisibility } from './usePageVisibility';

export interface SSEEvent {
  type: 'metrics' | 'alert' | 'collection' | 'connection';
  payload: Record<string, unknown>;
  timestamp: string;
}

type SSEStatus = 'connecting' | 'connected' | 'disconnected';

interface UseSSEOptions {
  /** Called on every SSE event. */
  onEvent?: (event: SSEEvent) => void;
  /** Whether the SSE connection is enabled. Defaults to true. */
  enabled?: boolean;
  /** 只订阅需要的事件，避免全局告警组件跟随每秒指标重复渲染。 */
  eventTypes?: readonly SSEEvent['type'][];
  /** 是否持有实时指标采集租约；告警页应关闭。 */
  metrics?: boolean;
}

interface UseSSEResult {
  status: SSEStatus;
  lastEvent: SSEEvent | null;
  /** Manually reconnect. */
  reconnect: () => void;
}

const MAX_RETRY_DELAY = 30_000;
const BASE_RETRY_DELAY = 2_000;

export function useSSE({ onEvent, enabled = true, eventTypes, metrics = true }: UseSSEOptions = {}): UseSSEResult {
  const pageVisible = usePageVisibility();
  const [status, setStatus] = useState<SSEStatus>('disconnected');
  const [lastEvent, setLastEvent] = useState<SSEEvent | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const retryCountRef = useRef(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onEventRef = useRef(onEvent);
  const eventTypesRef = useRef(eventTypes);
  const metricsRef = useRef(metrics);
  const enabledRef = useRef(false);
  useEffect(() => {
    onEventRef.current = onEvent;
    eventTypesRef.current = eventTypes;
    metricsRef.current = metrics;
  }, [onEvent, eventTypes, metrics]);

  const disconnect = useCallback(() => {
    if (eventSourceRef.current) {
      const es = eventSourceRef.current;
      eventSourceRef.current = null;
      es.onopen = null;
      es.onmessage = null;
      es.onerror = null;
      es.close();
    }
    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
  }, []);

  const connect = useCallback(function connectStream() {
    if (!enabledRef.current || !isPageVisible()) return;
    disconnect();

    setStatus('connecting');
    const es = new EventSource(`/api/dashboard/stream?metrics=${metricsRef.current ? '1' : '0'}`);
    eventSourceRef.current = es;

    es.onopen = () => {
      if (eventSourceRef.current !== es || !enabledRef.current || !isPageVisible()) return;
      setStatus('connected');
      retryCountRef.current = 0;
    };

    es.onmessage = (event) => {
      if (eventSourceRef.current !== es || !enabledRef.current || !isPageVisible()) return;
      try {
        const data = JSON.parse(event.data) as SSEEvent;
        if (!data || typeof data.payload !== 'object' || data.payload === null) return;
        if (eventTypesRef.current && !eventTypesRef.current.includes(data.type)) return;
        setLastEvent(data);
        onEventRef.current?.(data);
      } catch {
        // 忽略格式不完整的事件，保留现有页面状态。
      }
    };

    es.onerror = () => {
      if (eventSourceRef.current !== es) return;
      disconnect();
      setStatus('disconnected');
      if (!enabledRef.current || !isPageVisible()) return;

      // 仅可见页面使用指数退避重连。
      const delay = Math.min(
        BASE_RETRY_DELAY * 2 ** retryCountRef.current,
        MAX_RETRY_DELAY,
      );
      retryCountRef.current += 1;
      retryTimerRef.current = setTimeout(() => {
        retryTimerRef.current = null;
        connectStream();
      }, delay);
    };
  }, [disconnect]);

  const reconnect = useCallback(() => {
    retryCountRef.current = 0;
    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
    connect();
  }, [connect]);

  useEffect(() => {
    enabledRef.current = enabled && pageVisible;
    if (!enabledRef.current) {
      disconnect();
      setStatus('disconnected');
      return;
    }

    retryCountRef.current = 0;
    connect();

    return () => {
      enabledRef.current = false;
      disconnect();
    };
  }, [enabled, pageVisible, metrics, connect, disconnect]);

  return { status, lastEvent, reconnect };
}
