import { NextResponse } from 'next/server';
import { db, initializeDatabase } from '@/lib/db';

export const dynamic = 'force-dynamic';

/** 日志里疑似包含凭据的行一律替换，导出的文件可以安全地发给别人排查。 */
const SENSITIVE = /(token|password|passwd|secret|webhook|pushplus|authorization|api[_-]?key|cookie)/i;

function redact(message: string): string {
  return SENSITIVE.test(message) ? '[已隐藏：疑似包含凭据]' : message;
}

function countOf(sql: string): number {
  try {
    const row = db.prepare(sql).get() as { count?: number } | undefined;
    return Number(row?.count ?? 0);
  } catch {
    return -1;
  }
}

/**
 * 生成脱敏诊断报告。
 *
 * 只包含版本类信息、表计数和最近日志；不含短信正文、设备密码、
 * PushPlus Token 与运行密钥，遇到疑似凭据的日志行直接替换。
 */
export async function GET(): Promise<NextResponse> {
  initializeDatabase();

  let schemaVersion = -1;
  try {
    schemaVersion = Number(db.pragma('user_version', { simple: true }));
  } catch { /* 读不到就保持 -1，导出仍然可用 */ }

  let logs: Array<{ level: string; at: string; message: string }> = [];
  try {
    const rows = db.prepare(
      'SELECT level, message, created_at FROM system_logs ORDER BY created_at DESC LIMIT 200',
    ).all() as Array<{ level?: string; message?: string; created_at?: string }>;
    logs = rows.map((row) => ({
      level: String(row.level ?? ''),
      at: String(row.created_at ?? ''),
      message: redact(String(row.message ?? '')),
    }));
  } catch { /* 表不存在时返回空日志 */ }

  const report = {
    generatedAt: new Date().toISOString(),
    schemaVersion,
    counts: {
      smsMessages: countOf('SELECT COUNT(*) AS count FROM sms_messages'),
      trafficSamples: countOf('SELECT COUNT(*) AS count FROM traffic_data'),
      alertLogs: countOf('SELECT COUNT(*) AS count FROM alert_logs'),
      outboxPending: countOf("SELECT COUNT(*) AS count FROM notification_outbox WHERE status = 'pending'"),
      outboxDead: countOf("SELECT COUNT(*) AS count FROM notification_outbox WHERE status = 'dead'"),
    },
    logs,
    note: '报告不含短信正文、设备密码、PushPlus Token 与运行密钥。',
  };

  return new NextResponse(JSON.stringify(report, null, 2), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': 'attachment; filename="cpe-monitor-diagnostics.json"',
      'Cache-Control': 'no-store',
    },
  });
}
