'use client';

import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';
import { formatLocalTime } from '@/lib/format';
import { isLiveSampleFresh } from '@/lib/live-view-model';
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
    if (!pageVisible) return;
    // 只更新本地时效标记，不额外向设备或后台发请求。
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [pageVisible]);
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
