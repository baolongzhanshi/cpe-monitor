'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useSSE, type SSEEvent } from '@/hooks/useSSE';
import { isPageVisible, usePageVisibility } from '@/hooks/usePageVisibility';

const LAST_SEEN_KEY = 'cpe-monitor-alerts-last-seen';
const LEGACY_LAST_SEEN_KEY = 'cpeye-alerts-last-seen';
const ALERT_EVENT_TYPES = ['alert'] as const;

interface UseAlertNotificationResult {
  unreadCount: number;
  markAsRead: () => void;
  sseStatus: 'connecting' | 'connected' | 'disconnected';
}

/**
 * Global alert notification hook.
 * - Listens to SSE alert events and shows toast notifications.
 * - Tracks unread alert count based on alerts since last visit to alerts page.
 */
export function useAlertNotification(): UseAlertNotificationResult {
  const pageVisible = usePageVisibility();
  const [unreadCount, setUnreadCount] = useState(0);
  const lastSeenRef = useRef<string | null>(null);
  const unreadAbortRef = useRef<AbortController | null>(null);

  // Load last-seen timestamp from localStorage
  useEffect(() => {
    try {
      lastSeenRef.current = localStorage.getItem(LAST_SEEN_KEY)
        ?? localStorage.getItem(LEGACY_LAST_SEEN_KEY);
    } catch { /* ignore */ }
  }, []);

  const fetchUnreadCount = useCallback(async () => {
    const isVisible = isPageVisible;
    if (!isVisible() || unreadAbortRef.current) return;
    const controller = new AbortController();
    unreadAbortRef.current = controller;
    try {
      const since = lastSeenRef.current;
      const url = since
        ? `/api/alerts/unread-count?since=${encodeURIComponent(since)}`
        : '/api/alerts/unread-count';
      const res = await fetch(url, { signal: controller.signal });
      if (res.ok) {
        const data = await res.json();
        if (!controller.signal.aborted && isVisible()) setUnreadCount(data.count ?? 0);
      }
    } catch {
      // 网络不可用时保留未读数，重新打开页面会再次读取。
    } finally {
      if (unreadAbortRef.current === controller) unreadAbortRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!pageVisible) return;
    const timer = setTimeout(() => void fetchUnreadCount(), 0);
    return () => {
      clearTimeout(timer);
      unreadAbortRef.current?.abort();
      unreadAbortRef.current = null;
    };
  }, [pageVisible, fetchUnreadCount]);

  const handleSSEEvent = useCallback((event: SSEEvent) => {
    if (event.type === 'alert') {
      const message = (event.payload.message as string) || '新告警触发';
      const ruleName = (event.payload.ruleName as string) || '';
      toast.warning(ruleName ? `${ruleName}: ${message}` : message, {
        description: new Date(event.timestamp).toLocaleString('zh-CN'),
      });
      // Increment unread count
      setUnreadCount((prev) => prev + 1);
    }
  }, []);

  const { status: sseStatus } = useSSE({
    onEvent: handleSSEEvent,
    enabled: pageVisible,
    eventTypes: ALERT_EVENT_TYPES,
    metrics: false,
  });

  const markAsRead = useCallback(() => {
    const now = new Date().toISOString();
    lastSeenRef.current = now;
    try {
      localStorage.setItem(LAST_SEEN_KEY, now);
      localStorage.removeItem(LEGACY_LAST_SEEN_KEY);
    } catch { /* ignore */ }
    setUnreadCount(0);
  }, []);

  return { unreadCount, markAsRead, sseStatus };
}
