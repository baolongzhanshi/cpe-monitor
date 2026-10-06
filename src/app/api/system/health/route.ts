import { NextResponse } from 'next/server';
import { ensureSchedulerStarted } from '@/lib/scheduler';

export async function GET() {
  // 桌面启动页会请求此接口，恢复后台同步不依赖管理员进入仪表盘。
  await ensureSchedulerStarted();
  return NextResponse.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: '1.0.0',
  });
}
