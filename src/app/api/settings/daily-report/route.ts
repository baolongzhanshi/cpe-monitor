import {
  ApiError,
  ensureDatabase,
  jsonOk,
  parseJsonBody,
  requireSession,
  withApiHandler,
} from '@/lib/api-route';
import {
  DAILY_REPORT_PUSH_ENABLED_KEY,
  DAILY_REPORT_PUSH_TIME_KEY,
  normalizeDailyReportTime,
  resolveDailyReportPushSettings,
} from '@/lib/daily-report-settings';
import { syncDailyReportSchedule } from '@/lib/scheduler';
import { getSettingsMap, setSetting } from '@/lib/settings-store';

export const GET = withApiHandler(async () => {
  await requireSession();
  ensureDatabase();
  return jsonOk(resolveDailyReportPushSettings(getSettingsMap()));
}, '获取日报推送设置失败');

export const POST = withApiHandler(async (request) => {
  await requireSession();
  ensureDatabase();
  const body = await parseJsonBody<{ enabled?: boolean; time?: string }>(request);
  if (typeof body.enabled !== 'boolean') {
    throw new ApiError('日报推送开关格式不正确', 400);
  }
  const time = normalizeDailyReportTime(body.time);
  if (!time) {
    throw new ApiError('日报推送时间格式应为 HH:mm', 400);
  }

  setSetting(DAILY_REPORT_PUSH_ENABLED_KEY, String(body.enabled));
  setSetting(DAILY_REPORT_PUSH_TIME_KEY, time);
  syncDailyReportSchedule();

  return jsonOk({ enabled: body.enabled, time });
}, '保存日报推送设置失败');
