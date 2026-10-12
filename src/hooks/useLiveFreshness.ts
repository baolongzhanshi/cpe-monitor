'use client';

import { useEffect, useState } from 'react';
import { LIVE_STALE_AFTER_MS, readLiveFreshness, type LiveFreshnessState } from '@/lib/live-view-model';
import { usePageVisibility } from '@/hooks/usePageVisibility';

/**
 * 算一次实时数据新鲜度，供同一页面上的所有指示器共用。
 *
 * 判定本身在 readLiveFreshness 里，这里只负责两件事：记录本次可见的起始时刻，
 * 以及在数据即将失效的边界定时重算一次。页面上的徽章和状态行都读这一份结果，
 * 避免各自为政得出相反结论。
 */
export function useLiveFreshness(collectedAt: Date | null, stale: boolean): LiveFreshnessState {
  const pageVisible = usePageVisibility();
  const [now, setNow] = useState(() => Date.now());
  const [watchingSinceMs, setWatchingSinceMs] = useState(() => Date.now());

  // 订阅可见性变化，记下每次恢复可见的时刻。不放在 effect 体里直接 setState，
  // 那样会触发级联渲染；这里只在外部事件回调中更新。
  useEffect(() => {
    const markVisible = () => setWatchingSinceMs(Date.now());
    document.addEventListener('visibilitychange', markVisible);
    window.addEventListener('cpe-monitor-visibility', markVisible);
    return () => {
      document.removeEventListener('visibilitychange', markVisible);
      window.removeEventListener('cpe-monitor-visibility', markVisible);
    };
  }, []);

  useEffect(() => {
    if (!pageVisible || !collectedAt) return;
    // 只在数据即将失效的边界醒一次，避免常驻每秒重渲染；
    // 正常情况下父组件会随新数据更新，这个定时器只在断流时兜底。
    const anchoredAt = Math.max(collectedAt.getTime(), watchingSinceMs);
    const delay = Math.max(250, LIVE_STALE_AFTER_MS - (Date.now() - anchoredAt) + 100);
    const timer = window.setTimeout(() => setNow(Date.now()), delay);
    return () => window.clearTimeout(timer);
  }, [pageVisible, collectedAt, watchingSinceMs, now]);

  return readLiveFreshness({
    collectedAt,
    stale,
    pageVisible,
    watchingSinceMs,
    now,
  });
}
