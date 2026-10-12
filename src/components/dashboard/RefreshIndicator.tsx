'use client';

import { cn } from '@/lib/utils';
import { formatLocalTime } from '@/lib/format';
import type { LiveFreshnessState } from '@/lib/live-view-model';

interface RefreshIndicatorProps {
  sseStatus: 'connecting' | 'connected' | 'disconnected';
  lastRefreshAt: Date | null;
  /** 新鲜度由 useLiveFreshness 统一算好，这里只负责显示。 */
  freshness: LiveFreshnessState;
  pollIntervalMs?: number;
  className?: string;
}

export function RefreshIndicator({
  sseStatus,
  lastRefreshAt,
  freshness,
  pollIntervalMs = 2_000,
  className,
}: RefreshIndicatorProps) {
  // 一切正常时只留圆点和时间；状态文字只在异常时出现，避免同一件事说三遍。
  const statusText = freshness === 'paused'
    ? '页面刷新已暂停'
    : freshness === 'waiting'
      ? '等待首次采集'
      : freshness === 'stale'
        ? '显示最近一次数据'
        : sseStatus === 'connecting'
          ? '事件连接中'
          : sseStatus !== 'connected'
            ? `断线兜底 ${Math.round(pollIntervalMs / 1000)} 秒`
            : null;

  return (
    <span className={cn('inline-flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground', className)}>
      <span className={cn(
        'inline-block h-2 w-2 rounded-full',
        freshness === 'current'
          ? 'bg-success'
          : freshness === 'stale'
            ? 'bg-warning'
            : 'bg-muted-foreground/40',
      )} />
      {/* 没有时间戳时这里就是占位，下面不再重复同一句话。 */}
      {lastRefreshAt ? (
        <span>更新于 {formatLocalTime(lastRefreshAt)}</span>
      ) : (
        <span>等待首次采集</span>
      )}
      {statusText && statusText !== '等待首次采集' ? (
        <span className="text-muted-foreground/70">{statusText}</span>
      ) : null}
    </span>
  );
}
