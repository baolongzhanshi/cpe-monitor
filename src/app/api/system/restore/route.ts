import { requireSession, withApiHandler, jsonOk, ApiError } from '@/lib/api-route';
import { closeDatabase, db, getDatabasePath, initializeDatabase } from '@/lib/db';
import { writeSystemLog } from '@/lib/system-log';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** 恢复失败时要回滚，所以这些文件必须按顺序处理，任一步出错都不能留下半套状态。 */
const SIDECAR_SUFFIXES = ['-wal', '-shm'];

function removeSidecars(dbPath: string): void {
  for (const suffix of SIDECAR_SUFFIXES) {
    const sidecar = `${dbPath}${suffix}`;
    if (fs.existsSync(sidecar)) fs.unlinkSync(sidecar);
  }
}

export const POST = withApiHandler(async (request) => {
  await requireSession();

  const formData = await request.formData();
  const file = formData.get('file') as File | null;

  if (!file) {
    throw new ApiError('请上传数据库文件', 400);
  }

  if (!file.name.endsWith('.db')) {
    throw new ApiError('仅支持 .db 格式的数据库文件', 400);
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  if (!buffer.subarray(0, 16).toString('ascii').startsWith('SQLite format 3')) {
    throw new ApiError('无效的数据库文件', 400);
  }

  const dbPath = getDatabasePath();
  const backupDir = path.join(path.dirname(dbPath), 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const preRestoreBackup = path.join(backupDir, `pre-restore-${timestamp}.db`);

  // 必须先断开连接再动文件。连接存活时覆盖主库、再删掉它的 WAL/SHM，
  // 会让连接的分页缓存与新文件内容不一致，而且恢复的数据在进程重启前根本不可见。
  //
  // 从下面这行到校验结束必须是纯同步的：Node 只有一个 JS 线程，同步块内不会有别的
  // 请求或定时器插进来调用 getDb() 把连接提前重开。一旦中间引入 await，这个前提就没了。
  const hadExisting = fs.existsSync(dbPath);
  closeDatabase();
  if (hadExisting) {
    fs.copyFileSync(dbPath, preRestoreBackup);
  }

  try {
    fs.writeFileSync(dbPath, buffer);
    removeSidecars(dbPath);
    // 重新打开会顺带跑一遍迁移，再用 integrity_check 确认换上去的文件真的可用。
    initializeDatabase();
    const integrity = db.pragma('integrity_check');
    const passed = Array.isArray(integrity)
      && (integrity[0] as { integrity_check?: unknown } | undefined)?.integrity_check === 'ok';
    if (!passed) {
      throw new Error('恢复后的数据库未通过完整性校验');
    }
  } catch (error) {
    closeDatabase();
    if (hadExisting) {
      fs.copyFileSync(preRestoreBackup, dbPath);
      removeSidecars(dbPath);
      initializeDatabase();
    }
    const reason = error instanceof Error ? error.message : String(error);
    writeSystemLog('error', `数据库恢复失败，已回滚到恢复前状态：${reason}`);
    throw new ApiError('恢复失败，已回滚到恢复前的数据库', 500);
  }

  writeSystemLog('warn', `数据库已恢复，恢复前备份: ${preRestoreBackup}`);

  return jsonOk({
    success: true,
    message: '数据库恢复成功，数据已重新加载。建议退出并重新打开本程序，让后台定时任务也用上新数据。',
    preRestoreBackup,
  });
}, '恢复数据库失败');
