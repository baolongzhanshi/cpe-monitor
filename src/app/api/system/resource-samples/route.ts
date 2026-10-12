import { NextResponse } from 'next/server';
import { db, initializeDatabase } from '@/lib/db';
import { jsonError, isSessionOrLocalRequest } from '@/lib/api-route';
import { sanitizeProcesses } from '@/lib/resource-sample-payload';

export const dynamic = 'force-dynamic';

interface SamplePayload {
  sampledAt?: string;
  processCount?: number;
  workingSetBytes?: number;
  privateBytes?: number;
  cpuPercent?: number;
  handles?: number;
  threads?: number;
  uptimeSeconds?: number;
  processes?: unknown;
}

function nonNegative(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function mb(bytes: number): number {
  return Math.round((bytes / 1024 / 1024) * 10) / 10;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/** 灰度版宿主每隔一分钟上报一条整棵进程树的资源快照。 */
export async function POST(request: Request): Promise<NextResponse> {
  // 宿主无凭据，靠本机回环来源通过校验；其它来源必须已登录，否则任何人都能伪造采样数据。
  if (!(await isSessionOrLocalRequest(request))) {
    return jsonError('未登录', 401);
  }
  initializeDatabase();
  let body: SamplePayload;
  try {
    body = await request.json() as SamplePayload;
  } catch {
    return NextResponse.json({ error: '请求体不是有效 JSON' }, { status: 400 });
  }

  const workingSet = nonNegative(body.workingSetBytes);
  const privateBytes = nonNegative(body.privateBytes);
  if (workingSet === null || privateBytes === null) {
    return NextResponse.json({ error: '缺少有效的内存数据' }, { status: 400 });
  }
  const sampledAt = typeof body.sampledAt === 'string' && body.sampledAt
    ? body.sampledAt
    : new Date().toISOString();

  const processes = sanitizeProcesses(body.processes);

  try {
    const insertSample = db.prepare(`
      INSERT INTO resource_samples
        (sampled_at, source, process_count, working_set_bytes, private_bytes,
         cpu_percent, handles, threads, uptime_seconds)
      VALUES (?, 'desktop-host', ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertProcess = db.prepare(`
      INSERT INTO resource_process_samples
        (sampled_at, process_id, parent_process_id, process_name,
         working_set_bytes, private_bytes, handles, threads, cpu_seconds)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    // 汇总与明细必须同时落库，否则按 sampled_at 关联时会出现半条采样。
    db.transaction(() => {
      insertSample.run(
        sampledAt,
        nonNegative(body.processCount) ?? 0,
        workingSet,
        privateBytes,
        nonNegative(body.cpuPercent) ?? 0,
        nonNegative(body.handles) ?? 0,
        nonNegative(body.threads) ?? 0,
        nonNegative(body.uptimeSeconds) ?? 0,
      );
      for (const process of processes) {
        insertProcess.run(
          sampledAt,
          process.processId,
          process.parentProcessId,
          process.processName,
          process.workingSetBytes,
          process.privateBytes,
          process.handles,
          process.threads,
          process.cpuSeconds,
        );
      }
    })();
  } catch {
    return NextResponse.json({ error: '资源样本写入失败' }, { status: 503 });
  }

  return NextResponse.json({ ok: true });
}

/** 读取最近的样本并给出汇总，供报表使用。 */
export async function GET(request: Request): Promise<NextResponse> {
  if (!(await isSessionOrLocalRequest(request))) {
    return jsonError('未登录', 401);
  }
  initializeDatabase();
  const url = new URL(request.url);
  const requested = Number(url.searchParams.get('limit') ?? 200);
  const limit = Math.min(2000, Math.max(1, Number.isFinite(requested) ? Math.floor(requested) : 200));

  let rows: Array<Record<string, unknown>>;
  try {
    rows = db.prepare(`
      SELECT sampled_at, process_count, working_set_bytes, private_bytes,
             cpu_percent, handles, threads, uptime_seconds
      FROM resource_samples
      ORDER BY sampled_at DESC
      LIMIT ?
    `).all(limit) as Array<Record<string, unknown>>;
  } catch {
    return NextResponse.json({ error: '资源样本表不可用' }, { status: 503 });
  }

  const ordered = [...rows].reverse();
  const numbers = (key: string) => ordered.map((row) => Number(row[key]) || 0);
  const cpu = numbers('cpu_percent');
  const workingSet = numbers('working_set_bytes');
  const privateBytes = numbers('private_bytes');
  const uptime = numbers('uptime_seconds');

  const summary = ordered.length === 0 ? null : {
    count: ordered.length,
    firstAt: String(ordered[0].sampled_at),
    lastAt: String(ordered[ordered.length - 1].sampled_at),
    cpuAvg: round(cpu.reduce((a, b) => a + b, 0) / cpu.length),
    cpuPeak: round(Math.max(...cpu)),
    workingSetFirstMB: mb(workingSet[0]),
    workingSetLastMB: mb(workingSet[workingSet.length - 1]),
    workingSetMinMB: mb(Math.min(...workingSet)),
    workingSetMaxMB: mb(Math.max(...workingSet)),
    privateFirstMB: mb(privateBytes[0]),
    privateLastMB: mb(privateBytes[privateBytes.length - 1]),
    handlesFirst: numbers('handles')[0],
    handlesLast: numbers('handles')[numbers('handles').length - 1],
    threadsFirst: numbers('threads')[0],
    threadsLast: numbers('threads')[numbers('threads').length - 1],
    // 运行时长回落说明应用中途重启过。
    restarted: uptime.some((value, index) => index > 0 && value < uptime[index - 1]),
  };

  return NextResponse.json({ summary, samples: ordered });
}
