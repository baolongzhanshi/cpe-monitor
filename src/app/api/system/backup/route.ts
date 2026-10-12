import { requireSession, withApiHandler, jsonOk, ApiError } from '@/lib/api-route';
import { db, ensureDatabaseReady, getDatabasePath } from '@/lib/db';
import { writeSystemLog } from '@/lib/system-log';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * 把 WAL 合并回主库，并确认真的合并完成。
 *
 * 运行中的 SQLite 会把最近的提交留在 WAL 里，只复制主文件会得到一个内容悄悄回退的备份。
 * checkpoint 被占用时宁可让接口失败，也不产出这种"看起来成功"的备份——
 * 这正是不在线备份被明令禁止的原因。
 */
function checkpointDatabase(): void {
  const result = db.pragma('wal_checkpoint(TRUNCATE)');
  const busy = Array.isArray(result)
    ? Number((result[0] as { busy?: unknown } | undefined)?.busy ?? 0)
    : 0;
  if (busy !== 0) {
    throw new ApiError('数据库暂时无法完成检查点，请稍后重试', 503);
  }
}

/**
 * 备份统一放在数据库同级的 backups 目录。
 * 不能用 process.cwd()：Next standalone 启动时 chdir 到了 resources\server。
 */
function resolveBackupDir(): string {
  const dir = path.join(path.dirname(getDatabasePath()), 'backups');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export const GET = withApiHandler(async () => {
  await requireSession();
  ensureDatabaseReady();

  const dbPath = getDatabasePath();
  if (!fs.existsSync(dbPath)) {
    throw new ApiError('数据库文件不存在', 500);
  }

  checkpointDatabase();
  const dbBuffer = fs.readFileSync(dbPath);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = `cpe-monitor-backup-${timestamp}.db`;

  writeSystemLog('info', `数据库备份已下载: ${filename}`);

  return new Response(dbBuffer, {
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': String(dbBuffer.length),
    },
  });
}, '备份数据库失败');

export const POST = withApiHandler(async () => {
  await requireSession();
  ensureDatabaseReady();

  const dbPath = getDatabasePath();
  if (!fs.existsSync(dbPath)) {
    throw new ApiError('数据库文件不存在', 500);
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backupPath = path.join(resolveBackupDir(), `auto-backup-${timestamp}.db`);

  checkpointDatabase();
  fs.copyFileSync(dbPath, backupPath);
  writeSystemLog('info', `自动备份已创建: ${backupPath}`);

  return jsonOk({
    success: true,
    backupPath,
    message: '备份已创建',
  });
}, '创建备份失败');
