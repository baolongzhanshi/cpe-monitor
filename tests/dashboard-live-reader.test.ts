import assert from 'node:assert/strict';
import test from 'node:test';
import { createDashboardLiveReader, type DashboardLiveClient } from '../src/lib/dashboard-live-reader.ts';
import type { CpeNetworkSnapshot } from '../src/types/cpe.ts';

function makeHarness() {
  let time = 0;
  let fail = false;
  const calls = { login: 0, traffic: 0, month: 0, network: 0, hosts: 0, online: 0 };
  const client: DashboardLiveClient = {
    async ensureLogin() { calls.login += 1; return !fail; },
    getLastLoginError() { return '设备离线'; },
    async getTrafficStatistics() { calls.traffic += 1; return { CurrentDownloadRate: '1024' }; },
    async getMonthStatistics() { calls.month += 1; return { CurrentMonthDownload: '4096' }; },
    async getNetworkSnapshot() {
      calls.network += 1;
      return { signalStrength: -71, connectionStatus: 'connected' } as CpeNetworkSnapshot;
    },
    async getHostInfo() { calls.hosts += 1; return { devices: [] }; },
    async getOnlineState() { calls.online += 1; return { UpdateState: '0' }; },
  };
  return {
    reader: createDashboardLiveReader(client, () => time), calls,
    setTime(value: number) { time = value; },
    setFail(value: boolean) { fail = value; },
  };
}

test('概览与流量并发读取共用请求，慢字段每分钟读取一次', async () => {
  const h = makeHarness();
  const [live, traffic] = await Promise.all([h.reader.readLive(), h.reader.readTraffic(), h.reader.readLive()]);
  assert.equal(live.trafficStats.CurrentMonthDownload, '4096');
  assert.equal(traffic.CurrentDownloadRate, '1024');
  assert.deepEqual(h.calls, { login: 1, traffic: 1, month: 1, network: 1, hosts: 1, online: 1 });
  h.setTime(5_000);
  await h.reader.readLive();
  assert.deepEqual(h.calls, { login: 2, traffic: 2, month: 1, network: 2, hosts: 2, online: 1 });
  h.setTime(61_000);
  await h.reader.readLive();
  assert.deepEqual(h.calls, { login: 3, traffic: 3, month: 2, network: 3, hosts: 3, online: 2 });
});

test('失败短暂复用且保留最后快照，恢复后更新', async () => {
  const h = makeHarness();
  const snapshot = await h.reader.readLive();
  h.setTime(5_000);
  h.setFail(true);
  await assert.rejects(h.reader.readLive(), /设备离线/);
  await assert.rejects(h.reader.readLive(), /设备离线/);
  assert.equal(h.calls.login, 2);
  assert.equal(h.reader.peekLive(), snapshot);
  h.setTime(10_000);
  h.setFail(false);
  assert.notEqual(await h.reader.readLive(), snapshot);
  assert.equal(h.calls.login, 3);
});

test('逐秒采集对速率、信号、终端分级刷新，字段时间保留真实采样点', async () => {
  const h = makeHarness();
  const first = await h.reader.readRealtime();
  assert.equal(first.collectedAt, new Date(0).toISOString());
  h.setTime(1_000);
  const second = await h.reader.readRealtime();
  assert.deepEqual(h.calls, { login: 2, traffic: 2, month: 1, network: 1, hosts: 1, online: 1 });
  assert.equal(second.collectedAt, new Date(1_000).toISOString());
  assert.equal(second.fieldCollectedAt.network, new Date(0).toISOString());
  assert.equal(second.fieldCollectedAt.hosts, new Date(0).toISOString());
  h.setTime(2_000);
  await h.reader.readRealtime();
  assert.equal(h.calls.network, 2);
  assert.equal(h.calls.hosts, 1);
  h.setTime(5_000);
  const fifth = await h.reader.readRealtime();
  assert.equal(h.calls.hosts, 2);
  assert.equal(fifth.fieldCollectedAt.hosts, new Date(5_000).toISOString());
  assert.equal(fifth.fieldCollectedAt.month, new Date(0).toISOString());
});

test('按需读取缓存不会更新设备采集时间，失败也不会推进最后成功快照', async () => {
  const h = makeHarness();
  const first = await h.reader.readLive();
  h.setTime(500);
  assert.equal((await h.reader.readLive()).collectedAt, first.collectedAt);
  assert.equal(h.calls.traffic, 1);
  h.setTime(1_000);
  h.setFail(true);
  await assert.rejects(h.reader.readRealtime(), /设备离线/);
  assert.equal(h.reader.peekLive()?.collectedAt, first.collectedAt);
});
