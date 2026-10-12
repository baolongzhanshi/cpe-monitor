'use client';

import { useEffect, useState } from 'react';
import { readLiveFreshness, type LiveFreshnessState } from '@/lib/live-view-model';
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

  // 每秒推进一次时钟。
  //
  // 判定必须在渲染时读到当前时间，而 React 要求渲染是纯的、不允许在渲染期调用 Date.now()，
  // 所以由这个定时器把时间推进到 state，渲染只读 state。页面不可见时不推进，避免后台空转。
  //
  // 这里曾经用"只在失效边界醒一次"的写法：数据每秒到来会让 effect 每秒重跑并重排定时器，
  // 定时器因此永不触发，state 里的时间停在挂载时刻，ageMs 每秒负增长，
  // 约 5 秒后越过容差被判为过期且再也回不来——仪表盘与设备页都会中招。
  useEffect(() => {
    if (!pageVisible) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [pageVisible]);

  return readLiveFreshness({
    collectedAt,
    stale,
    pageVisible,
    watchingSinceMs,
    now,
  });
}
