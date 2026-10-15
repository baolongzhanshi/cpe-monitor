'use client';

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';

/** WebView2 注入的宿主桥；用普通浏览器打开页面时不存在。 */
type DesktopBridge = {
  postMessage: (message: unknown) => void;
  addEventListener: (type: 'message', listener: (event: { data: unknown }) => void) => void;
  removeEventListener: (type: 'message', listener: (event: { data: unknown }) => void) => void;
};

declare global {
  interface Window {
    chrome?: { webview?: DesktopBridge };
  }
}

/** 只认宿主回的 autostart-state，其它消息（比如页面的主题汇报）一律忽略。 */
function readAutoStartMessage(data: unknown): boolean | null {
  if (!data || typeof data !== 'object') return null;
  const payload = data as { type?: unknown; enabled?: unknown };
  if (payload.type !== 'autostart-state' || typeof payload.enabled !== 'boolean') return null;
  return payload.enabled;
}

// 宿主桥在页面生命周期内不会出现或消失，所以不需要真正的订阅，只要一个稳定的空订阅函数。
const subscribeDesktopSupport = () => () => {};
const getDesktopSupport = () => Boolean(window.chrome?.webview);
const getDesktopSupportOnServer = () => false;

export interface AutoStartState {
  /** 是否运行在桌面宿主里；只有宿主才能写注册表。 */
  supported: boolean;
  /** 宿主回读的实际状态；还没收到回复时为 null。 */
  enabled: boolean | null;
  /** 已发出请求、正在等宿主回读。 */
  pending: boolean;
  setEnabled: (value: boolean) => void;
}

/**
 * 开机自启的开关状态。
 *
 * 真正的读写发生在宿主进程里（见 desktop-native/AutoStart.cs）：浏览器没有写注册表的权限，
 * 而且只有宿主知道自己的可执行文件路径。这里只负责发请求、接回读。
 */
export function useAutoStart(): AutoStartState {
  const supported = useSyncExternalStore(
    subscribeDesktopSupport,
    getDesktopSupport,
    getDesktopSupportOnServer,
  );
  const [enabled, setEnabledState] = useState<boolean | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    const bridge = window.chrome?.webview;
    if (!supported || !bridge) return;

    const onMessage = (event: { data: unknown }) => {
      const next = readAutoStartMessage(event.data);
      if (next === null) return;
      setEnabledState(next);
      setPending(false);
    };

    bridge.addEventListener('message', onMessage);
    bridge.postMessage({ type: 'autostart-query' });
    return () => bridge.removeEventListener('message', onMessage);
  }, [supported]);

  const setEnabled = useCallback((value: boolean) => {
    const bridge = window.chrome?.webview;
    if (!bridge) return;
    // 状态一律以宿主的回读为准：注册表可能写不进去，不能按请求值先乐观显示。
    setPending(true);
    bridge.postMessage({ type: 'autostart', enabled: value });
  }, []);

  return { supported, enabled, pending, setEnabled };
}
