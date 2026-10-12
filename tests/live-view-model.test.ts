import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LIVE_STALE_AFTER_MS,
  MAX_LIVE_POINTS,
  appendLiveHistoryPoint,
  createLiveHistoryPoint,
  getLiveSampleTime,
  isLiveSampleFresh,
  isOlderLiveSample,
  mergeLiveChartHistory,
  readLiveFreshness,
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

test('超过阈值或采集失败的样本不显示绿色实时标记', () => {
  const collectedAt = getLiveSampleTime(makeSnapshot());
  const time = collectedAt!.getTime();
  assert.equal(isLiveSampleFresh(collectedAt, false, time + LIVE_STALE_AFTER_MS - 1), true);
  assert.equal(isLiveSampleFresh(collectedAt, false, time + LIVE_STALE_AFTER_MS + 1), false);
  assert.equal(isLiveSampleFresh(collectedAt, true, time + 100), false);
  assert.equal(isLiveSampleFresh(null, false, time), false);
  // 明显早于本机的采样时间戳按时钟偏差处理，不算新鲜。
  assert.equal(isLiveSampleFresh(new Date(time + 6_000), false, time), false);
});

test('新鲜度判定把暂停、等待、过期和正常区分开', () => {
  const now = 1_000_000_000_000;
  const fresh = new Date(now - 500);
  const old = new Date(now - LIVE_STALE_AFTER_MS - 1);
  const base = {
    collectedAt: fresh, stale: false, pageVisible: true, watchingSinceMs: now - 60_000, now,
  };

  assert.equal(readLiveFreshness(base), 'current');
  assert.equal(readLiveFreshness({ ...base, pageVisible: false }), 'paused');
  assert.equal(readLiveFreshness({ ...base, collectedAt: null }), 'waiting');
  assert.equal(readLiveFreshness({ ...base, stale: true }), 'stale');
  assert.equal(readLiveFreshness({ ...base, collectedAt: old }), 'stale');
});

test('刚恢复可见时旧样本不立即判为过期，但一直等不到数据仍会过期', () => {
  const now = 1_000_000_000_000;
  const old = new Date(now - 30_000);
  const common = {
    collectedAt: old, stale: false, pageVisible: true, now,
  };

  // 刚恢复可见：从恢复时刻起算，给数据留一个到达窗口。
  assert.equal(readLiveFreshness({ ...common, watchingSinceMs: now - 100 }), 'current');
  // 恢复后一直没等到新数据：超过阈值仍然判过期。
  assert.equal(readLiveFreshness({ ...common, watchingSinceMs: now - LIVE_STALE_AFTER_MS - 1 }), 'stale');
  // 一直在看、数据确实旧了：照常判过期。
  assert.equal(readLiveFreshness({ ...common, watchingSinceMs: now - 60_000 }), 'stale');
});

test('数据每秒正常到达时必须一直是 current，时钟不推进则会误报过期', () => {
  // 模拟一次正常会话：每秒来一个新样本，判定时钟同步推进。
  const start = 1_000_000_000_000;
  for (let second = 0; second <= 30; second += 1) {
    const tick = start + second * 1_000;
    assert.equal(readLiveFreshness({
      collectedAt: new Date(tick),
      stale: false,
      pageVisible: true,
      watchingSinceMs: start,
      now: tick,
    }), 'current', `第 ${second} 秒应当判为实时`);
  }

  // 反向用例：时钟停在挂载时刻不再推进（曾经的 bug）。
  // 此时 ageMs 变成负数并逐秒远离零点，约 5 秒后越过容差被判为过期。
  // 这条用例是为了钉住"传入的 now 必须跟着时间走"这个前提。
  const mountedAt = start;
  const frozenVerdicts = [0, 1, 3, 4, 5, 10].map((second) => readLiveFreshness({
    collectedAt: new Date(mountedAt + second * 1_000),
    stale: false,
    pageVisible: true,
    watchingSinceMs: mountedAt,
    now: mountedAt,
  }));
  assert.deepEqual(frozenVerdicts, ['current', 'current', 'current', 'current', 'current', 'stale']);
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
