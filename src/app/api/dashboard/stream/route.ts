import { eventBus } from '@/lib/event-bus';
import { getSession } from '@/lib/auth';
import { createEventStream } from '@/lib/sse-stream';
import { ensureSchedulerStarted } from '@/lib/scheduler';
import { acquireRealtimeSubscriber, getRealtimeSnapshot } from '@/lib/realtime-collector';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: Request) {
  const session = await getSession();
  if (!session) {
    return new Response('Unauthorized', { status: 401 });
  }

  await ensureSchedulerStarted();
  // 顶栏告警连接不提高采集频率；实际展示实时数据的可见页面才持有订阅租约。
  const watchesMetrics = new URL(request.url).searchParams.get('metrics') !== '0';
  const release = watchesMetrics ? acquireRealtimeSubscriber() : () => {};
  const snapshot = watchesMetrics ? getRealtimeSnapshot() : null;

  const stream = createEventStream({
    eventBus,
    signal: request.signal,
    initialEvent: {
      type: 'connection',
      payload: { status: 'connected' },
      timestamp: new Date().toISOString(),
    },
    initialEvents: snapshot ? [{ type: 'metrics', payload: snapshot, timestamp: new Date().toISOString() }] : [],
    onClose: release,
    filter: (event) => watchesMetrics || !(event && typeof event === 'object' && 'type' in event && event.type === 'metrics'),
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
