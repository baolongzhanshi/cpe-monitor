'use client';

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useDashboardData } from '@/hooks/useDashboardData';

type DashboardData = ReturnType<typeof useDashboardData>;

/** 每秒变化：实时速率与累计流量。 */
export type LiveRatesSlice = Pick<DashboardData, 'trafficStats'>;
/** 约两秒变化：连接、信号、小区与调度状态。 */
export type LiveOverviewSlice = Pick<
  DashboardData,
  'overview' | 'isConnected' | 'updateLabel' | 'signalQuality' | 'schedulerStatusLabel'
>;
/** 每秒追加：实时曲线与迷你趋势数据。 */
export type LiveHistorySlice = Pick<DashboardData, 'chartHistory' | 'metricHistory'>;
/** 每秒变化：刷新时效、加载与错误提示。 */
export type LiveMetaSlice = Pick<
  DashboardData,
  'loading' | 'lastRefreshAt' | 'lastRefreshStale' | 'sseStatus'
  | 'overviewError' | 'dataError' | 'refreshing' | 'collecting'
>;
/** 低频变化：套餐、设备快照、短信状态与操作回调。 */
export type LiveSlowSlice = Pick<
  DashboardData,
  'timeRange' | 'setTimeRange' | 'unit' | 'setUnit' | 'startDate' | 'deviceSnapshot'
  | 'smsSync' | 'smsSyncLabel' | 'smsSyncDetail' | 'deviceName' | 'cell'
  | 'schedulerSaving' | 'toggleScheduler' | 'changeSchedulerInterval'
  | 'refreshDashboard' | 'collectNow'
>;

const RatesContext = createContext<LiveRatesSlice | null>(null);
const OverviewContext = createContext<LiveOverviewSlice | null>(null);
const HistoryContext = createContext<LiveHistorySlice | null>(null);
const MetaContext = createContext<LiveMetaSlice | null>(null);
const SlowContext = createContext<LiveSlowSlice | null>(null);

/**
 * 仪表盘实时数据提供者。
 *
 * 秒级状态集中在这里，页面外壳和静态区块通过 children 传入，
 * 因此它们不会随每秒的数据更新重新渲染；只有订阅对应切片的组件会更新。
 */
export function LiveMetricsProvider({ children }: { children: ReactNode }) {
  const data = useDashboardData();

  const rates = useMemo<LiveRatesSlice>(
    () => ({ trafficStats: data.trafficStats }),
    [data.trafficStats],
  );
  const overview = useMemo<LiveOverviewSlice>(
    () => ({
      overview: data.overview,
      isConnected: data.isConnected,
      updateLabel: data.updateLabel,
      signalQuality: data.signalQuality,
      schedulerStatusLabel: data.schedulerStatusLabel,
    }),
    [data.overview, data.isConnected, data.updateLabel, data.signalQuality, data.schedulerStatusLabel],
  );
  const history = useMemo<LiveHistorySlice>(
    () => ({ chartHistory: data.chartHistory, metricHistory: data.metricHistory }),
    [data.chartHistory, data.metricHistory],
  );
  const meta = useMemo<LiveMetaSlice>(
    () => ({
      loading: data.loading,
      lastRefreshAt: data.lastRefreshAt,
      lastRefreshStale: data.lastRefreshStale,
      sseStatus: data.sseStatus,
      overviewError: data.overviewError,
      dataError: data.dataError,
      refreshing: data.refreshing,
      collecting: data.collecting,
    }),
    [
      data.loading, data.lastRefreshAt, data.lastRefreshStale, data.sseStatus,
      data.overviewError, data.dataError, data.refreshing, data.collecting,
    ],
  );
  const slow = useMemo<LiveSlowSlice>(
    () => ({
      timeRange: data.timeRange,
      setTimeRange: data.setTimeRange,
      unit: data.unit,
      setUnit: data.setUnit,
      startDate: data.startDate,
      deviceSnapshot: data.deviceSnapshot,
      smsSync: data.smsSync,
      smsSyncLabel: data.smsSyncLabel,
      smsSyncDetail: data.smsSyncDetail,
      deviceName: data.deviceName,
      cell: data.cell,
      schedulerSaving: data.schedulerSaving,
      toggleScheduler: data.toggleScheduler,
      changeSchedulerInterval: data.changeSchedulerInterval,
      refreshDashboard: data.refreshDashboard,
      collectNow: data.collectNow,
    }),
    [
      data.timeRange, data.setTimeRange, data.unit, data.setUnit, data.startDate,
      data.deviceSnapshot, data.smsSync, data.smsSyncLabel, data.smsSyncDetail,
      data.deviceName, data.cell, data.schedulerSaving, data.toggleScheduler,
      data.changeSchedulerInterval, data.refreshDashboard, data.collectNow,
    ],
  );

  return (
    <SlowContext.Provider value={slow}>
      <RatesContext.Provider value={rates}>
        <OverviewContext.Provider value={overview}>
          <HistoryContext.Provider value={history}>
            <MetaContext.Provider value={meta}>{children}</MetaContext.Provider>
          </HistoryContext.Provider>
        </OverviewContext.Provider>
      </RatesContext.Provider>
    </SlowContext.Provider>
  );
}

function useRequiredContext<T>(context: React.Context<T | null>, name: string): T {
  const value = useContext(context);
  if (value === null) throw new Error(`${name} 必须在 LiveMetricsProvider 内部使用。`);
  return value;
}

export const useLiveRates = () => useRequiredContext(RatesContext, 'useLiveRates');
export const useLiveOverview = () => useRequiredContext(OverviewContext, 'useLiveOverview');
export const useLiveHistory = () => useRequiredContext(HistoryContext, 'useLiveHistory');
export const useLiveMeta = () => useRequiredContext(MetaContext, 'useLiveMeta');
export const useDashboardSlow = () => useRequiredContext(SlowContext, 'useDashboardSlow');
