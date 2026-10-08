import { requireSession, withApiHandler, jsonOk } from '@/lib/api-route';
import { getDashboardTrafficStats } from '@/lib/dashboard-live-service';

export const dynamic = 'force-dynamic';

export const GET = withApiHandler(async () => {
  await requireSession();
  return jsonOk(await getDashboardTrafficStats(), { headers: { 'Cache-Control': 'no-store' } });
}, '获取流量统计失败');
