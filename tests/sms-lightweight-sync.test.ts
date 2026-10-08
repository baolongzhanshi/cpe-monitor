import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createSmsLightweightSync, ensureFullSmsSync, validateSmsCount,
  type SmsOverview, type SmsReadClient,
} from '../src/lib/sms-lightweight-sync.ts';
import type { CpeSmsMessage } from '../src/types/cpe.ts';

function makeSms(values: Partial<CpeSmsMessage> = {}): CpeSmsMessage {
  return {
    id: '1', phone: '13800138000', content: '测试短信', date: '2026-10-07 12:00:00',
    status: '0', type: '1', box: '0', unread: true, direction: 'inbound', ...values,
  };
}

function createHarness() {
  const state = {
    time: 0,
    overview: { count: { LocalInbox: '1', LocalOutbox: '0' }, contacts: [makeSms()] } as SmsOverview,
    messages: [makeSms()], failOverview: false, failHistory: false, failPersist: false,
  };
  const stats = { checks: 0, history: 0, writes: 0, skipped: 0 };
  let passedOverview: SmsOverview | undefined;
  let client: SmsReadClient = {
    async getSmsOverview() {
      stats.checks += 1;
      if (state.failOverview) throw new Error('摘要读取失败');
      return state.overview;
    },
    async getSmsMessages(overview) {
      stats.history += 1;
      passedOverview = overview;
      if (state.failHistory) throw new Error('历史读取失败');
      return { messages: state.messages, count: state.overview.count };
    },
  };
  const sync = createSmsLightweightSync<{ fullSync: boolean; fetched: number }>({
    getClient: () => client,
    now: () => state.time,
    async persistMessages(messages) {
      if (state.failPersist) throw new Error('写入失败');
      stats.writes += 1;
      return { fullSync: true, fetched: messages.length };
    },
    skippedResult() {
      stats.skipped += 1;
      return { fullSync: false, fetched: 0 };
    },
  });
  return { state, stats, sync, getPassedOverview: () => passedOverview, replaceClient() { client = { ...client }; } };
}

test('启动完整读取，后续无变化检查跳过号码历史并复用已取摘要', async () => {
  const h = createHarness();
  assert.equal((await h.sync.run('scheduler')).fullSync, true);
  assert.equal(h.getPassedOverview(), h.state.overview);
  for (const time of [15_000, 30_000, 45_000]) {
    h.state.time = time;
    assert.equal((await h.sync.run('scheduler')).fullSync, false);
  }
  assert.deepEqual(h.stats, { checks: 4, history: 1, writes: 1, skipped: 3 });
});

test('满一分钟完整核对，检测联系人摘要之外的历史变化', async () => {
  const h = createHarness();
  await h.sync.run('scheduler');
  h.state.messages = [makeSms(), makeSms({ id: '2', content: '较早的历史变化' })];
  h.state.time = 59_999;
  assert.equal((await h.sync.run('scheduler')).fullSync, false);
  h.state.time = 60_000;
  assert.equal((await h.sync.run('scheduler')).fetched, 2);
  assert.equal(h.stats.history, 2);
});

test('同计数的最新短信、未读和方向变化仍完整读取', async () => {
  for (const values of [
    { content: '同数量的新短信' }, { date: '2026-10-07 12:00:01' },
    { status: '1', unread: false }, { box: '1', direction: 'outbound' as const },
    { phone: '13900139000' }, { id: '2' }, { type: '2' },
  ]) {
    const h = createHarness();
    await h.sync.run('scheduler');
    h.state.overview = { ...h.state.overview, contacts: [makeSms(values)] };
    assert.equal((await h.sync.run('scheduler')).fullSync, true);
    assert.equal(h.stats.history, 2);
  }
});

test('计数变化与新增号码立即完整读取，排序变化不产生额外历史读取', async () => {
  const h = createHarness();
  h.state.overview.contacts.push(makeSms({ id: '2', phone: '13900139000' }));
  await h.sync.run('scheduler');
  h.state.overview = {
    count: { LocalOutbox: '0', LocalInbox: '1' },
    contacts: [...h.state.overview.contacts].reverse(),
  };
  assert.equal((await h.sync.run('scheduler')).fullSync, false);
  h.state.overview.count.LocalInbox = '2';
  assert.equal((await h.sync.run('scheduler')).fullSync, true);
  h.state.overview.contacts.push(makeSms({ id: '3', phone: '13700137000' }));
  assert.equal((await h.sync.run('scheduler')).fullSync, true);
});

test('读取或写库失败不保留成功检查点，修复后重新完整读取', async () => {
  for (const flag of ['failOverview', 'failHistory', 'failPersist'] as const) {
    const h = createHarness();
    await h.sync.run('scheduler');
    h.state[flag] = true;
    await assert.rejects(h.sync.run('manual'));
    h.state[flag] = false;
    assert.equal((await h.sync.run('scheduler')).fullSync, true);
  }
});

test('手动、换客户端、重启调度和时钟回拨都强制完整读取', async () => {
  const h = createHarness();
  await h.sync.run('scheduler');
  assert.equal((await h.sync.run('manual')).fullSync, true);
  h.replaceClient();
  assert.equal((await h.sync.run('scheduler')).fullSync, true);
  h.sync.reset();
  assert.equal((await h.sync.run('scheduler')).fullSync, true);
  h.state.time = -1;
  assert.equal((await h.sync.run('scheduler')).fullSync, true);
});

test('缺失、负数、非数字及不安全的短信计数不能建立检查点', async () => {
  const invalidCounts: Record<string, string>[] = [
    {}, { LocalInbox: '-1' }, { LocalInbox: 'NaN' }, { LocalInbox: '1.5' },
    { LocalInbox: '9007199254740992' },
  ];
  for (const count of invalidCounts) {
    assert.throws(() => validateSmsCount(count));
  }
  const h = createHarness();
  await h.sync.run('scheduler');
  h.state.overview.count.LocalInbox = '-1';
  await assert.rejects(h.sync.run('scheduler'));
  h.state.overview.count.LocalInbox = '1';
  assert.equal((await h.sync.run('scheduler')).fullSync, true);
});

test('手动同步等待自动检查后补完整读取，自动完整同步可直接复用', async () => {
  let finishCheck!: (value: { fullSync: boolean }) => void;
  const pending = new Promise<{ fullSync: boolean }>((resolve) => { finishCheck = resolve; });
  let calls = 0;
  const manual = ensureFullSmsSync(async (source) => {
    assert.equal(source, 'manual');
    calls += 1;
    return calls === 1 ? pending : { fullSync: true };
  });
  assert.equal(calls, 1);
  finishCheck({ fullSync: false });
  assert.equal((await manual).fullSync, true);
  assert.equal(calls, 2);
  calls = 0;
  await ensureFullSmsSync(async () => { calls += 1; return { fullSync: true }; });
  assert.equal(calls, 1);
});
