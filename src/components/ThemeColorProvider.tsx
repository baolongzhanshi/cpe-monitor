'use client';

import { useEffect, type ReactNode } from 'react';
import { useTheme } from 'next-themes';
import { useThemeColor } from '@/hooks/useThemeColor';

type WebViewBridge = { postMessage?: (message: unknown) => void };

/**
 * Applies the persisted brand hue to the document root on mount and keeps it
 * in sync with dark/light mode changes. Render inside next-themes' ThemeProvider.
 */
export function ThemeColorProvider({ children }: { children: ReactNode }) {
  useThemeColor();
  const { resolvedTheme } = useTheme();

  // 把页面实际生效的主题告诉桌面宿主，让原生标题栏与页面保持一致。
  // 浏览器里没有这个通道，会静默跳过。
  useEffect(() => {
    const bridge = (window as Window & { chrome?: { webview?: WebViewBridge } }).chrome?.webview;
    if (!bridge?.postMessage || !resolvedTheme) return;
    bridge.postMessage({ type: 'theme', dark: resolvedTheme === 'dark' });
  }, [resolvedTheme]);

  return <>{children}</>;
}
