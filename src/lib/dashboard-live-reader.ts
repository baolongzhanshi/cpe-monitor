import type {
  CpeDevice,
  CpeNetworkSnapshot,
  CpeOnlineState,
  CpeTrafficStatistics,
} from '../types/cpe';

export const DASHBOARD_LIVE_CACHE_MS = 1_000;
export const DASHBOARD_NETWORK_CACHE_MS = 2_000;
export const DASHBOARD_HOSTS_CACHE_MS = 5_000;
export const DASHBOARD_SLOW_CACHE_MS = 60_000;

interface SnapshotCache<T> {
  read(force?: boolean): Promise<T>;
  peek(): T | undefined;
  sampledAt(): string | null;
}

export function createRequestSnapshotCache<T>(
  load: (force: boolean) => Promise<T>,
  ttlMs: number,
  now: () => number = Date.now,
): SnapshotCache<T> {
  let cachedPromise: Promise<T> | null = null;
  let latestValue: T | undefined;
  let expiresAt = 0;
  let pending = false;
  let collectedAt: string | null = null;

  return {
    read(force = false) {
      if (cachedPromise && (pending || (!force && now() < expiresAt))) return cachedPromise;
      pending = true;
      const startedAt = now();
      // 失败也短暂缓存，多个页面不会在设备离线时同时重复登录。
      cachedPromise = Promise.resolve().then(() => load(force)).then((value) => {
        latestValue = value;
        collectedAt = new Date(now()).toISOString();
        return value;
      }).finally(() => {
        pending = false;
        expiresAt = startedAt + ttlMs;
      });
      return cachedPromise;
    },
    peek() {
      return latestValue;
    },
    sampledAt() { return collectedAt; },
  };
}

export interface DashboardLiveClient {
  ensureLogin(): Promise<boolean>;
  getLastLoginError(): string;
  getTrafficStatistics(): Promise<CpeTrafficStatistics>;
  getMonthStatistics(): Promise<Record<string, string>>;
  getNetworkSnapshot(): Promise<CpeNetworkSnapshot>;
  getHostInfo(): Promise<{ devices: CpeDevice[] }>;
  getOnlineState(): Promise<CpeOnlineState>;
}

export interface DashboardDeviceSnapshot {
  trafficStats: CpeTrafficStatistics;
  networkSnapshot: CpeNetworkSnapshot;
  connectedDevices: number;
  updateState: string;
  collectedAt: string;
  fieldCollectedAt: Record<string, string | null>;
  fieldErrors: Record<string, string>;
}

export function createDashboardLiveReader(
  client: DashboardLiveClient,
  now: () => number = Date.now,
) {
  const login = createRequestSnapshotCache(async () => {
    if (!await client.ensureLogin()) {
      throw new Error(client.getLastLoginError() || 'CPE 登录失败，请检查设备地址、网络连接和密码。');
    }
  }, DASHBOARD_LIVE_CACHE_MS, now);
  const traffic = createRequestSnapshotCache(
    () => client.getTrafficStatistics(), DASHBOARD_LIVE_CACHE_MS, now,
  );
  const month = createRequestSnapshotCache(
    () => client.getMonthStatistics(), DASHBOARD_SLOW_CACHE_MS, now,
  );
  const network = createRequestSnapshotCache(
    () => client.getNetworkSnapshot(), DASHBOARD_NETWORK_CACHE_MS, now,
  );
  const hosts = createRequestSnapshotCache(
    () => client.getHostInfo(), DASHBOARD_HOSTS_CACHE_MS, now,
  );
  const online = createRequestSnapshotCache(
    () => client.getOnlineState(), DASHBOARD_SLOW_CACHE_MS, now,
  );
  const fieldErrors: Record<string, string> = {};
  async function readOptional<T>(key: string, cache: SnapshotCache<T>, fallback: T): Promise<T> {
    try {
      const value = await cache.read();
      delete fieldErrors[key];
      return value;
    } catch (error) {
      fieldErrors[key] = error instanceof Error ? error.message : '可选设备字段读取失败';
      return cache.peek() ?? fallback;
    }
  }
  function unwrap<T>(result: PromiseSettledResult<T>): T {
    if (result.status === 'rejected') throw result.reason;
    return result.value;
  }
  const mergedTraffic = createRequestSnapshotCache(async (force) => {
    await login.read();
    const results = await Promise.allSettled([
      traffic.read(force),
      readOptional('month', month, {}),
    ]);
    const stats = unwrap(results[0]);
    const monthStats = unwrap(results[1]);
    return { ...stats, ...monthStats };
  }, DASHBOARD_LIVE_CACHE_MS, now);
  const live = createRequestSnapshotCache(async (force): Promise<DashboardDeviceSnapshot> => {
    await login.read();
    const results = await Promise.allSettled([
      mergedTraffic.read(force),
      network.read(),
      hosts.read(),
      readOptional('online', online, {}),
    ]);
    // 等待本轮任务全部结束后再处理失败，避免慢请求与下一轮堆叠。
    const trafficStats = unwrap(results[0]);
    const networkSnapshot = unwrap(results[1]);
    const hostInfo = unwrap(results[2]);
    const onlineState = unwrap(results[3]);
    return {
      trafficStats,
      networkSnapshot,
      connectedDevices: hostInfo.devices.filter((device) => device.online).length,
      updateState: String(onlineState.UpdateState || onlineState.upgState || 'unknown'),
      // 重用快字段缓存时保留实际设备响应时间，不把查询时间冒充采集时间。
      collectedAt: traffic.sampledAt() ?? new Date(now()).toISOString(),
      fieldCollectedAt: {
        traffic: traffic.sampledAt(), network: network.sampledAt(),
        hosts: hosts.sampledAt(), month: month.sampledAt(), online: online.sampledAt(),
      },
      fieldErrors: { ...fieldErrors },
    };
  }, DASHBOARD_LIVE_CACHE_MS, now);

  return {
    readLive: () => live.read(),
    readRealtime: () => live.read(true),
    readTraffic: () => mergedTraffic.read(),
    peekLive: () => live.peek(),
  };
}
