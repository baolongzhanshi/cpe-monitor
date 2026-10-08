'use client';

import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';
import { formatLocalTime } from '@/lib/format';
import { LIVE_STALE_AFTER_MS, isLiveSampleFresh } from '@/lib/live-view-model';
import { usePageVisibility } from '@/hooks/usePageVisibility';

interface RefreshIndicatorProps {
  sseStatus: 'connecting' | 'connected' | 'disconnected';
  lastRefreshAt: Date | null;
  lastRefreshStale?: boolean;
  pollIntervalMs?: number;
  collectionIntervalMs?: number;
  className?: string;
}

export function RefreshIndicator({
  sseStatus,
  lastRefreshAt,
  lastRefreshStale = false,
  pollIntervalMs = 2_000,
  className,
}: RefreshIndicatorProps) {
  const pageVisible = usePageVisibility();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!pageVisible || !lastRefreshAt) return;
    // 只在数据即将失效的边界刷新一次，避免常驻每秒重渲染。
    // 正常情况下父组件会随新数据更新，这个定时器只在断流时兜底。
    const age = Date.now() - lastRefreshAt.getTime();
    const delay = Math.max(250, LIVE_STALE_AFTER_MS - age + 100);
    const timer = window.setTimeout(() => setNow(Date.now()), delay);
    return () => window.clearTimeout(timer);
  }, [pageVisible, lastRefreshAt, now]);
  const fresh = isLiveSampleFresh(lastRefreshAt, lastRefreshStale, now);

  return (
    <span className={cn('inline-flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground', className)}>
      <span className={cn(
        'inline-block h-2 w-2 rounded-full',
        pageVisible && fresh
          ? 'bg-success'
          : pageVisible && lastRefreshAt
            ? 'bg-warning'
            : 'bg-muted-foreground/40',
      )} />
      {lastRefreshAt ? (
        <span>更新于 {formatLocalTime(lastRefreshAt)}</span>
      ) : (
        <span>等待首次采集</span>
      )}
      {/* 一切正常时只留圆点和时间；状态文字只在异常时出现，避免同一件事说三遍。 */}
      {!pageVisible || !lastRefreshAt || !fresh || sseStatus !== 'connected' ? (
        <span className="text-muted-foreground/70">
          {!pageVisible
            ? '页面刷新已暂停'
            : !lastRefreshAt
              ? '等待首次采集'
              : !fresh
                ? '显示最近一次数据'
                : sseStatus === 'connecting'
                  ? '事件连接中'
                  : `断线兜底 ${Math.round(pollIntervalMs / 1000)} 秒`}
        </span>
      ) : null}
    </span>
  );
}
