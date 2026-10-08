'use client';

import { useEffect, useState } from 'react';

let hostVisible = true;

export function isPageVisible(): boolean {
  const embeddedVisible = typeof window === 'undefined'
    ? true
    : (window as Window & { __CPE_MONITOR_VISIBLE__?: boolean }).__CPE_MONITOR_VISIBLE__;
  return typeof document !== 'undefined'
    && hostVisible
    && embeddedVisible !== false
    && document.visibilityState !== 'hidden';
}

export function usePageVisibility(): boolean {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const updateVisibility = () => {
      // 浏览器标签页不可见时暂停请求；窗口失焦不会影响实时刷新。
      setVisible(isPageVisible());
    };
    const updateHostVisibility = (event: Event) => {
      const detail = (event as CustomEvent<{ visible?: boolean }>).detail;
      if (typeof detail?.visible === 'boolean') hostVisible = detail.visible;
      updateVisibility();
    };
    updateVisibility();
    document.addEventListener('visibilitychange', updateVisibility);
    window.addEventListener('cpe-monitor-visibility', updateHostVisibility);
    return () => {
      document.removeEventListener('visibilitychange', updateVisibility);
      window.removeEventListener('cpe-monitor-visibility', updateHostVisibility);
    };
  }, []);

  return visible;
}
