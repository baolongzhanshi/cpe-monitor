'use client';

import { useEffect } from 'react';

/**
 * Registers the service worker for PWA support.
 * Render once in the root layout.
 */
export function PWARegister() {
  useEffect(() => {
    // 软件宿主总是读取随当前安装包分发的页面，避免旧 Service Worker 锁住旧界面。
    if ((window as Window & { __CPE_MONITOR_DESKTOP__?: boolean }).__CPE_MONITOR_DESKTOP__) return;
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker
        .register('/sw.js')
        .catch((error) => {
          console.warn('SW registration failed:', error);
        });
    }
  }, []);

  return null;
}
