import { NextResponse } from 'next/server';
import { ensureSchedulerStarted } from '@/lib/scheduler';
import { APP_VERSION } from '@/lib/app-version';
import { getRealtimeCollectorStatus } from '@/lib/realtime-collector';

export async function GET() {
  // 桌面启动页会请求此接口，恢复后台同步不依赖管理员进入仪表盘。
  await ensureSchedulerStarted();
  return NextResponse.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: APP_VERSION,
    realtime: getRealtimeCollectorStatus(),
  });
}
