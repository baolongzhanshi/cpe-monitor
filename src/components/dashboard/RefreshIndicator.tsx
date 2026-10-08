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
  collectionIntervalMs = 1_000,
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
      <span className="text-muted-foreground/70">
        {!pageVisible
          ? '页面刷新已暂停'
          : lastRefreshAt && !fresh
            ? '显示最近一次数据'
            : sseStatus === 'connected'
              ? `约 ${Math.round(collectionIntervalMs / 1000)} 秒采集 · 实时推送`
              : `断线兜底 ${Math.round(pollIntervalMs / 1000)} 秒`}
      </span>
      {pageVisible && sseStatus === 'connecting' ? (
        <span className="text-muted-foreground/70">事件连接中</span>
      ) : null}
    </span>
  );
}
