import { requireSession, withApiHandler, jsonOk } from '@/lib/api-route';
import { db, ensureDatabaseReady } from '@/lib/db';
import { getAppDayRange, parseDateTime, toSqliteTimestamp } from '@/lib/date-time';

export const GET = withApiHandler(async (request) => {
  await requireSession();
  ensureDatabaseReady();

  const { searchParams } = new URL(request.url);
  const since = searchParams.get('since');

  // alert_logs.triggered_at 由 datetime('now') 写入，是 'YYYY-MM-DD HH:mm:ss' 的 UTC 文本。
  // 拿带 T 和 Z 的 ISO 字符串直接比较会在第 11 个字符处分叉（空格 0x20 < 'T' 0x54），
  // 结果当天的告警一条都统计不到，未读角标长期恒为 0。
  //
  // 默认口径也改成上海自然日，与项目其它地方一致，而不是机器本地零点。
  const baseline = since
    ? parseDateTime(since)
    : getAppDayRange().start;
  const operator = since ? '>' : '>=';
  const row = baseline
    ? db.prepare(
      `SELECT COUNT(*) AS count FROM alert_logs WHERE triggered_at ${operator} ?`,
    ).get(toSqliteTimestamp(baseline)) as { count: number }
    : { count: 0 };

  return jsonOk({ count: row.count });
}, '获取未读告警数失败');
