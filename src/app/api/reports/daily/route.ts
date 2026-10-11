import { ensureDatabase, jsonOk, requireSession, withApiHandler } from '@/lib/api-route';
import { generateDailyReport } from '@/lib/report-generator';
import {
  listRecentDailyReports,
  upsertDailyReport,
} from '@/lib/repositories/report-repository';

export const GET = withApiHandler(async () => {
  await requireSession();
  return jsonOk(listRecentDailyReports(30));
}, '获取报告列表失败');

export const POST = withApiHandler(async () => {
  await requireSession();
  ensureDatabase();
  const report = await generateDailyReport();
  upsertDailyReport(report);
  return jsonOk(report);
}, '生成报告失败');
