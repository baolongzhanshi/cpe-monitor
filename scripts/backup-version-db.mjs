import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const [sourcePath, destinationPath] = process.argv.slice(2);
if (!sourcePath || !destinationPath) {
  throw new Error('用法：node scripts/backup-version-db.mjs 源数据库 目标数据库');
}
if (path.resolve(sourcePath) === path.resolve(destinationPath)) {
  throw new Error('数据库备份目标不能覆盖源数据库。');
}
if (fs.existsSync(destinationPath)) {
  throw new Error('数据库备份目标已经存在，拒绝覆盖。');
}

const source = new Database(sourcePath, { readonly: true, fileMustExist: true });
try {
  // SQLite 在线备份读取一致的快照，并包含 WAL 中已经提交的数据。
  await source.backup(destinationPath);
} finally {
  source.close();
}

const snapshot = new Database(destinationPath, { readonly: true, fileMustExist: true });
try {
  const checks = snapshot.pragma('integrity_check');
  if (checks.length !== 1 || checks[0].integrity_check !== 'ok') {
    throw new Error('SQLite 备份完整性校验失败。');
  }
  const tables = snapshot.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table'").get().count;
  console.log(JSON.stringify({ integrity: 'ok', tables, bytes: fs.statSync(destinationPath).size }));
} finally {
  snapshot.close();
}
