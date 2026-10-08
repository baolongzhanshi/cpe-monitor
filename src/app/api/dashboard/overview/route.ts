import { jsonOk, requireSession, withApiHandler } from '@/lib/api-route';
import { ensureSchedulerStarted } from '@/lib/scheduler';
import { getDashboardLiveResponse } from '@/lib/dashboard-live-service';

export const dynamic = 'force-dynamic';

export const GET = withApiHandler(async () => {
  await requireSession();
  await ensureSchedulerStarted();

  const { overview } = await getDashboardLiveResponse();
  return jsonOk(overview, { headers: { 'Cache-Control': 'no-store' } });
}, '获取仪表盘概览失败');
