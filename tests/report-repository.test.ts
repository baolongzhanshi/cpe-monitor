import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { DAILY_REPORT_UPSERT_SQL } from '../src/lib/repositories/report-repository.ts';

test('日报可在复合唯一索引下创建并重复更新', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpe-report-repository-'));
  const db = new Database(path.join(tempDir, 'test.db'));
  db.exec(`
    CREATE TABLE daily_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      report_date TEXT NOT NULL,
      period_type TEXT DEFAULT 'daily',
      total_upload INTEGER,
      total_download INTEGER,
      peak_hour INTEGER,
      top_devices TEXT,
      avg_signal INTEGER,
      uptime_percent REAL,
      network_quality TEXT,
      sent_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX idx_daily_reports_date_period_unique
    ON daily_reports (report_date, period_type);
  `);

  const upsert = db.prepare(DAILY_REPORT_UPSERT_SQL);
  upsert.run('2026-10-11', 100, 200, 12, '[]', -90, 99.5, '良好');
  upsert.run('2026-10-11', 100, 300, 12, '[]', -90, 99.5, '良好');

  const rows = db.prepare('SELECT report_date, total_download FROM daily_reports').all() as Array<{
    report_date: string;
    total_download: number;
  }>;
  assert.deepEqual(rows, [{ report_date: '2026-10-11', total_download: 300 }]);

  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});
