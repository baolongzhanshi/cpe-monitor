import type { EventEmitter } from 'node:events';

interface EventStreamOptions {
  eventBus: EventEmitter;
  signal: AbortSignal;
  initialEvent: unknown;
  initialEvents?: unknown[];
  heartbeatMs?: number;
  onClose?: () => void;
  filter?: (event: unknown) => boolean;
}

export function createEventStream({
  eventBus,
  signal,
  initialEvent,
  initialEvents = [],
  heartbeatMs = 30_000,
  onClose,
  filter,
}: EventStreamOptions): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let cleanup = () => {};

  return new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

      const onAbort = () => {
        cleanup();
        try { controller.close(); } catch { /* 流可能已经被客户端取消。 */ }
      };

      const write = (value: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(value));
        } catch {
          cleanup();
        }
      };
      const send = (event: unknown) => {
        if (filter && !filter(event)) return;
        const isMetrics = event && typeof event === 'object' && 'type' in event && event.type === 'metrics';
        if (isMetrics && controller.desiredSize !== null && controller.desiredSize <= 0) return;
        write(`data: ${JSON.stringify(event)}\n\n`);
      };

      // 每个连接只清理自己的监听，关闭一个窗口不会中断其他客户端。
      cleanup = () => {
        if (closed) return;
        closed = true;
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        eventBus.off('message', send);
        signal.removeEventListener('abort', onAbort);
        onClose?.();
      };

      eventBus.on('message', send);
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) {
        onAbort();
        return;
      }
      heartbeatTimer = setInterval(() => write(': heartbeat\n\n'), heartbeatMs);
      send(initialEvent);
      for (const event of initialEvents) send(event);
    },
    cancel() {
      cleanup();
    },
  }, { highWaterMark: 2 });
}
