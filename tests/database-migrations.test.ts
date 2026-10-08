import test from 'node:test';
import assert from 'node:assert/strict';
import {
  runDatabaseMigrations,
  type SqliteDatabase,
  type SqliteRunResult,
  type SqliteStatement,
} from '../src/lib/db.ts';

class FakeStatement implements SqliteStatement {
  private readonly database: FakeDatabase;
  private readonly sql: string;

  constructor(
    database: FakeDatabase,
    sql: string,
  ) {
    this.database = database;
    this.sql = sql;
  }

  run(...params: unknown[]): SqliteRunResult {
    if (/INSERT OR IGNORE INTO system_settings/i.test(this.sql)) {
      const [key, value] = params.map(String);
      if (!this.database.settings.has(key)) this.database.settings.set(key, value);
    }
    return { changes: 1, lastInsertRowid: 1 };
  }

  get(): unknown {
    if (/PRAGMA user_version/i.test(this.sql)) {
      return { user_version: this.database.userVersion };
    }
    return undefined;
  }

  all(): unknown[] {
    const match = this.sql.match(/PRAGMA table_info\(([^)]+)\)/i);
    if (!match) return [];
    return [...(this.database.columns.get(match[1]) || [])].map((name) => ({ name }));
  }
}

class FakeDatabase implements SqliteDatabase {
  userVersion = 0;
  execCount = 0;
  settings = new Map<string, string>();
  columns = new Map<string, Set<string>>([
    ['traffic_data', new Set(['id', 'timestamp', 'upload_bytes', 'download_bytes'])],
    ['device_data', new Set(['id', 'timestamp', 'device_mac'])],
  ]);

  prepare(sql: string): SqliteStatement {
    return new FakeStatement(this, sql);
  }

  exec(sql: string): SqliteDatabase {
    this.execCount += 1;
    const alterMatches = sql.matchAll(/ALTER TABLE\s+(\w+)\s+ADD COLUMN\s+(\w+)/gi);
    for (const match of alterMatches) {
      const columns = this.columns.get(match[1]) || new Set<string>();
      columns.add(match[2]);
      this.columns.set(match[1], columns);
    }
    return this;
  }

  pragma(source: string): unknown {
    const match = source.match(/user_version\s*=\s*(\d+)/i);
    if (match) this.userVersion = Number(match[1]);
    return this.userVersion;
  }

  transaction<T>(task: () => T): () => T {
    return task;
  }

  close(): void {}
}

test('database migrations advance once and remain idempotent', () => {
  const database = new FakeDatabase();
  assert.equal(runDatabaseMigrations(database), 7);
  assert.equal(database.userVersion, 7);
  assert.ok(database.columns.get('traffic_data')?.has('collection_id'));
  assert.ok(database.columns.get('traffic_data')?.has('rsrp'));
  assert.ok(database.columns.get('device_data')?.has('raw_json'));

  const execCount = database.execCount;
  assert.equal(runDatabaseMigrations(database), 7);
  assert.equal(database.execCount, execCount);
});

test('新数据库将短信默认间隔写为 0.25 分钟，设备信息仍是整数分钟', () => {
  const database = new FakeDatabase();
  runDatabaseMigrations(database);
  assert.equal(database.settings.get('sms_sync_interval'), '0.25');
  assert.equal(database.settings.get('device_info_sync_interval'), '360');
});

test('迁移和再次启动都保留已有用户的短信同步间隔', () => {
  const database = new FakeDatabase();
  database.settings.set('sms_sync_interval', '15');
  runDatabaseMigrations(database);
  assert.equal(database.settings.get('sms_sync_interval'), '15');
  database.settings.set('sms_sync_interval', '0.5');
  runDatabaseMigrations(database);
  assert.equal(database.settings.get('sms_sync_interval'), '0.5');
});
