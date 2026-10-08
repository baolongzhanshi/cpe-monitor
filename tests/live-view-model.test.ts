import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_LIVE_POINTS,
  appendLiveHistoryPoint,
  createLiveHistoryPoint,
  getLiveSampleTime,
  isLiveSampleFresh,
  isOlderLiveSample,
  mergeLiveChartHistory,
  type LiveDashboardViewSnapshot,
} from '../src/lib/live-view-model.ts';

function makeSnapshot(overrides: Partial<LiveDashboardViewSnapshot> = {}): LiveDashboardViewSnapshot {
  return {
    overview: {
      currentUpload: 128,
      currentDownload: 1024,
      connectedDevices: 3,
      signalStrength: -71,
      connectionStatus: '901',
      updateState: '0',
      networkType: '5G NR',
      source: 'cpe',
      cpeError: '',
      networkSnapshot: { rsrp: '-71dBm', rsrq: '-10.0dB', sinr: '33dB', band: 'N41', pci: 549 },
      schedulerStatus: { enabled: true, interval: 30 },
      collectionHealth: {
        status: 'healthy', label: '正常', detail: '', lastRunAt: null, lastSuccessAt: null,
        lastError: null, consecutiveFailures: 0, staleAfterMinutes: 75, ageMinutes: 0,
      },
    },
    trafficStats: { CurrentUploadRate: '128', CurrentDownloadRate: '1024' },
    collectedAt: '2026-10-07T16:30:00.000Z',
    stale: false,
    ...overrides,
  };
}

test('实时曲线按真实采集时间、字节速率和射频值构造，不对缺失信号补零', () => {
  const point = createLiveHistoryPoint(makeSnapshot());
  assert.equal(point?.timestamp, '2026-10-07T16:30:00.000Z');
  assert.equal(point?.downloadBps, 8192);
  assert.equal(point?.uploadBps, 1024);
  assert.equal(point?.rsrp, -71);
  assert.equal(point?.rsrq, -10);
  assert.equal(point?.sinr, 33);
  assert.equal(point?.rssi, null);
  assert.equal(point?.pci, '549');
});

test('失败缓存、缺失采集时间和格式错误不成为新曲线采样', () => {
  assert.equal(createLiveHistoryPoint(makeSnapshot({ stale: true })), null);
  assert.equal(createLiveHistoryPoint(makeSnapshot({ collectedAt: null })), null);
  assert.equal(createLiveHistoryPoint(makeSnapshot({ collectedAt: 'invalid' })), null);
  const failed = makeSnapshot();
  failed.overview.cpeError = '设备离线';
  assert.equal(createLiveHistoryPoint(failed), null);
});

test('快照与事件重复或迟到时不重复插入、不让曲线倒退', () => {
  const point = createLiveHistoryPoint(makeSnapshot());
  const current = appendLiveHistoryPoint([], point);
  assert.equal(appendLiveHistoryPoint(current, point), current);
  assert.equal(appendLiveHistoryPoint(current, {
    timestamp: '2026-10-07T16:29:59.000Z', downloadBps: 8000,
  }), current);
  assert.equal(isOlderLiveSample(new Date('2026-10-07T16:29:59Z'), Date.parse('2026-10-07T16:30:00Z')), true);
});

test('长时间每秒更新仅保留最近 180 条采样', () => {
  let points = [] as ReturnType<typeof appendLiveHistoryPoint>;
  const start = Date.parse('2026-10-07T16:30:00Z');
  for (let index = 0; index < 1000; index += 1) {
    points = appendLiveHistoryPoint(points, {
      timestamp: new Date(start + index * 1000).toISOString(), downloadBps: index,
    });
  }
  assert.equal(points.length, MAX_LIVE_POINTS);
  assert.equal(points[0].downloadBps, 820);
  assert.equal(points.at(-1)?.downloadBps, 999);
});

test('4 秒以上旧样本及失败样本不显示绿色实时标记', () => {
  const collectedAt = getLiveSampleTime(makeSnapshot());
  const time = collectedAt!.getTime();
  assert.equal(isLiveSampleFresh(collectedAt, false, time + 3999), true);
  assert.equal(isLiveSampleFresh(collectedAt, false, time + 4001), false);
  assert.equal(isLiveSampleFresh(collectedAt, true, time + 100), false);
  assert.equal(isLiveSampleFresh(null, false, time), false);
  assert.equal(isLiveSampleFresh(new Date(time + 6000), false, time), false);
});

test('合并历史与实时序列时末尾只追加当前速率一个点，且不篡改原历史', () => {
  const history = [
    { timestamp: '2026-10-07 16:00:00', downloadBps: 1000 },
    { timestamp: '2026-10-07 16:30:00', downloadBps: 2000 },
  ];
  const live = [
    { timestamp: '2026-10-07T16:30:00.000Z', downloadBps: 3000 },
    { timestamp: '2026-10-07T16:30:01.000Z', downloadBps: 4000 },
  ];
  const combined = mergeLiveChartHistory(history, live);
  // 历史点按原有采样保留（含与实时段同分钟的那条），末尾只补当前速率。
  // 之前把每秒一条的实时点整段并入，会让末尾占掉大块宽度、刻度重复。
  assert.deepEqual(combined.map((point) => point.downloadBps), [1000, 2000, 4000]);
  assert.equal(history.length, 2);
  assert.equal(mergeLiveChartHistory(history, []), history);
});
