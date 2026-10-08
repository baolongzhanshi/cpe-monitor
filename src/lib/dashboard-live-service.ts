import { getOrCreateCpeClient } from './cpe-client';
import { getSettingsMap } from './settings-store';
import { getTrafficSchedulerStatus } from './traffic-scheduler-status';
import { getCollectionHealth } from './collection-health';
import { findLatestTrafficOverview } from './repositories/monitoring-repository';
import { createDashboardLiveReader, type DashboardDeviceSnapshot } from './dashboard-live-reader';
import { isCpeConfigured } from './settings-store';
import { getRealtimeRuntime } from './realtime-collector-state';
import type { DashboardLiveResponse } from './dashboard-live-types';

export type { DashboardLiveResponse } from './dashboard-live-types';

function getReader() {
  const readers = getRealtimeRuntime().readers;
  const client = getOrCreateCpeClient();
  let reader = readers.get(client);
  if (!reader) {
    reader = createDashboardLiveReader(client);
    readers.set(client, reader);
  }
  return reader;
}

export async function getDashboardTrafficStats() {
  if (process.env.CPE_ISOLATED_TEST === 'true' || !isCpeConfigured()) return {};
  return getReader().readTraffic();
}

export async function readDashboardLiveResponse(mode: 'on-demand' | 'realtime' = 'on-demand'): Promise<DashboardLiveResponse> {
  const settingsMap = getSettingsMap();
  const schedulerStatus = {
    enabled: settingsMap.scheduler_enabled === 'true',
    interval: parseInt(settingsMap.scheduler_interval || '60', 10),
    running: getTrafficSchedulerStatus().running,
  };
  const collectionHealth = getCollectionHealth({
    schedulerEnabled: schedulerStatus.enabled,
    intervalMinutes: schedulerStatus.interval,
  });

  let snapshot: DashboardDeviceSnapshot | undefined;
  let cpeError = '';
  if (process.env.CPE_ISOLATED_TEST === 'true') {
    cpeError = '隔离测试不访问 CPE 设备';
  } else if (!isCpeConfigured()) {
    cpeError = 'CPE 未配置';
  } else try {
    const reader = getReader();
    try {
      snapshot = mode === 'realtime' ? await reader.readRealtime() : await reader.readLive();
    } catch (error) {
      snapshot = reader.peekLive();
      throw error;
    }
  } catch (error) {
    cpeError = error instanceof Error ? error.message : '读取 CPE 实时状态失败。';
  }

  const latestTraffic = snapshot ? undefined : findLatestTrafficOverview();
  const networkSnapshot = snapshot?.networkSnapshot || null;
  return {
    overview: {
      // 历史累计字节数不能作为当前速率；离线时显示 0 并明确错误。
      currentUpload: snapshot ? parseInt(String(snapshot.trafficStats.CurrentUploadRate || '0'), 10) : 0,
      currentDownload: snapshot ? parseInt(String(snapshot.trafficStats.CurrentDownloadRate || '0'), 10) : 0,
      connectedDevices: snapshot?.connectedDevices ?? latestTraffic?.connected_devices ?? 0,
      signalStrength: networkSnapshot?.signalStrength ?? latestTraffic?.signal_strength ?? 0,
      connectionStatus: networkSnapshot?.connectionStatus || 'unknown',
      updateState: snapshot?.updateState || 'unknown',
      networkType: networkSnapshot?.networkType || 'unknown',
      networkSnapshot: networkSnapshot ? {
        ...networkSnapshot,
        pci: String(networkSnapshot.pci ?? ''), band: String(networkSnapshot.band ?? ''),
        nrarfcn: String(networkSnapshot.nrarfcn ?? ''), rsrp: String(networkSnapshot.rsrp ?? ''),
        rsrq: String(networkSnapshot.rsrq ?? ''), rssi: String(networkSnapshot.rssi ?? ''),
        sinr: String(networkSnapshot.sinr ?? ''),
      } : null,
      source: snapshot ? 'cpe' as const : 'database' as const,
      cpeError,
      schedulerStatus,
      collectionHealth,
    },
    trafficStats: snapshot?.trafficStats || {},
    collectedAt: snapshot?.collectedAt || null,
    stale: Boolean(cpeError) || !snapshot,
    fieldCollectedAt: snapshot?.fieldCollectedAt,
    fieldErrors: snapshot?.fieldErrors,
  };
}

export async function getDashboardLiveResponse(): Promise<DashboardLiveResponse> {
  return getRealtimeRuntime().collector?.getSnapshot() || readDashboardLiveResponse();
}
