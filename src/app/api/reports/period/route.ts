import { jsonOk, requireSession, withApiHandler } from '@/lib/api-route';
import { listPeriodReports } from '@/lib/repositories/report-repository';

/**
 * top_devices 是数据库里的 JSON 文本，可能因为历史数据或写入异常而损坏。
 * 日报列表那条路径（mappers/daily-report.ts）一直有兜底，这里原先没有——
 * 同一列坏掉会让整个周期报告列表 500，而日报列表照常工作。
 */
function parseTopDevices(raw: unknown): unknown[] {
  if (typeof raw !== 'string' || !raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export const GET = withApiHandler(async (request) => {
  await requireSession();
  const url = new URL(request.url);
  const type = url.searchParams.get('type'); // 'weekly' | 'monthly'
  const limit = Math.min(52, Math.max(1, Number(url.searchParams.get('limit')) || 20));

  if (type !== 'weekly' && type !== 'monthly') {
    return jsonOk({ reports: [] });
  }

  const rows = listPeriodReports(type, limit);
  const reports = rows.map((row) => ({
    id: row.id,
    periodKey: row.report_date,
    periodType: row.period_type,
    totalUpload: row.total_upload,
    totalDownload: row.total_download,
    topDevices: parseTopDevices(row.top_devices),
    avgSignal: row.avg_signal,
    networkQuality: row.network_quality,
    createdAt: row.created_at,
  }));

  return jsonOk({ reports });
}, '获取周期报告失败');
