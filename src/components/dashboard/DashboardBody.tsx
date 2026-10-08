'use client';

import { useState, type ReactNode } from 'react';
import { Download, DownloadCloud, Gauge, PackageOpen, RadioTower, UploadCloud, UsersRound } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Callout } from '@/components/Callout';
import { LoadingBlock } from '@/components/LoadingBlock';
import { PageHeader } from '@/components/PageHeader';
import { PageShell } from '@/components/PageShell';
import RefreshButton from '@/components/RefreshButton';
import CellSnapshotCard from '@/components/dashboard/CellSnapshotCard';
import { CollectionReportDialog, type CollectionReportData } from '@/components/dashboard/CollectionReportDialog';
import DashboardHero from '@/components/dashboard/DashboardHero';
import DataPlanCard from '@/components/dashboard/DataPlanCard';
import MetricStatCard from '@/components/dashboard/MetricStatCard';
import NetworkHistoryGrid from '@/components/dashboard/NetworkHistoryGrid';
import QuickLinks from '@/components/dashboard/QuickLinks';
import { RefreshIndicator } from '@/components/dashboard/RefreshIndicator';
import SchedulerCard from '@/components/dashboard/SchedulerCard';
import StatusPillsRow from '@/components/dashboard/StatusPillsRow';
import TrafficCompareCard from '@/components/dashboard/TrafficCompareCard';
import TrafficStatsPanel from '@/components/dashboard/TrafficStatsPanel';
import TrafficTrendCard from '@/components/dashboard/TrafficTrendCard';
import { formatBytesPerSecond } from '@/lib/format';
import {
  useDashboardSlow,
  useLiveHistory,
  useLiveMeta,
  useLiveOverview,
  useLiveRates,
} from './live-metrics-context';

/**
 * 仪表盘外壳。
 *
 * 这个组件不订阅任何实时切片，只在挂载时渲染一次。
 * 静态区块与上下两块实时区域作为同一批元素传给门控组件，
 * 因此每秒的数据更新只会影响订阅了对应切片的叶子组件。
 */
export default function DashboardBody() {
  const content = (
    <>
      <LiveTop />
      <TrafficCompareCard />
      <LiveBottom />
      <QuickLinks />
    </>
  );

  return (
    <PageShell>
      <DashboardGate>{content}</DashboardGate>
    </PageShell>
  );
}

/** 仅负责首屏加载态；数据就绪后原样透传已经创建好的子树。 */
function DashboardGate({ children }: { children: ReactNode }) {
  const { loading } = useLiveMeta();
  return <>{loading ? <LoadingBlock /> : children}</>;
}

/** 顶部实时区域：状态、指标卡与实时曲线。 */
function LiveTop() {
  const { overview, isConnected, updateLabel, signalQuality, schedulerStatusLabel } = useLiveOverview();
  const { trafficStats } = useLiveRates();
  const { metricHistory, chartHistory } = useLiveHistory();
  const { lastRefreshAt, lastRefreshStale, sseStatus, overviewError, dataError, refreshing, collecting } = useLiveMeta();
  const { startDate, timeRange, setTimeRange, refreshDashboard, collectNow } = useDashboardSlow();
  const [reportOpen, setReportOpen] = useState(false);
  const [reportData, setReportData] = useState<CollectionReportData | null>(null);

  const rate = trafficStats || {};
  const signalBadgeVariant = (
    signalQuality?.variant === 'success'
      || signalQuality?.variant === 'info'
      || signalQuality?.variant === 'warning'
      || signalQuality?.variant === 'danger'
  ) ? signalQuality.variant : 'secondary';

  return (
    <>
      <PageHeader
        eyebrow="CPE / live console"
        title="网络仪表盘"
        description="把实时状态、流量、套餐和设备活动集中在一个可操作的监控台里。"
        icon={<Gauge className="h-6 w-6" />}
        actions={
          <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:flex-wrap sm:items-center">
            <div className="order-last sm:order-first">
              <RefreshIndicator
                sseStatus={sseStatus}
                lastRefreshAt={lastRefreshAt}
                lastRefreshStale={lastRefreshStale}
              />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Badge
                variant={overview?.source === 'cpe' && !lastRefreshStale ? 'default' : 'secondary'}
                className="rounded-full px-3 py-1"
              >
                {lastRefreshStale ? '最近一次数据' : overview?.source === 'cpe' ? '实时 CPE 数据' : '数据库兜底数据'}
              </Badge>
              {/* 实时推送正常时不再占用按钮位置；断线或数据过期才显示手动刷新。 */}
              {lastRefreshStale || sseStatus !== 'connected' ? (
                <RefreshButton
                  onClick={() => { void refreshDashboard(); }}
                  loading={refreshing}
                  label="刷新数据"
                  loadingLabel="刷新中"
                />
              ) : null}
              <Button
                variant="outline"
                size="sm"
                disabled={collecting}
                onClick={async () => {
                  try {
                    const result = await collectNow();
                    setReportData(result);
                    setReportOpen(true);
                    if (result.success) {
                      // 采集成功后刷新一次，立即反映新数据。
                      await refreshDashboard();
                    }
                  } catch {
                    toast.error('采集请求失败，请检查网络连接', { duration: 4000 });
                  }
                }}
              >
                <Download className="mr-1 h-4 w-4" />
                {collecting ? '采集中...' : '立即采集'}
              </Button>
            </div>
          </div>
        }
      />

      {overviewError ? (
        <Callout tone="warning" title="CPE 登录/连接失败">{overviewError}</Callout>
      ) : null}

      {dataError && !overviewError ? (
        <Callout tone="warning" title="部分实时数据不可用">{dataError}</Callout>
      ) : null}

      {overview?.collectionHealth?.status === 'failed' ? (
        <Callout tone="danger" title="最近一次采集失败">
          {overview.collectionHealth.detail}
          {overview.collectionHealth.consecutiveFailures > 1
            ? `，已连续失败 ${overview.collectionHealth.consecutiveFailures} 次`
            : ''}
        </Callout>
      ) : overview?.collectionHealth?.status === 'stale' ? (
        <Callout tone="warning" title="采集数据已过期">
          {overview.collectionHealth.detail}，请检查定时任务或手动执行一次采集。
        </Callout>
      ) : null}

      <StatusPillsRow
        isConnected={isConnected}
        updateLabel={updateLabel}
        updateState={overview?.updateState}
        schedulerLabel={schedulerStatusLabel}
        schedulerRunning={Boolean(overview?.schedulerStatus?.running)}
        collectionHealthLabel={overview?.collectionHealth?.label || '未知'}
        collectionHealthStatus={overview?.collectionHealth?.status || 'never'}
      />

      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <MetricStatCard
          index={0}
          label="下载速率"
          value={formatBytesPerSecond(parseInt(String(rate.CurrentDownloadRate || '0'), 10))}
          color="text-brand"
          icon={<DownloadCloud className="h-5 w-5" />}
          hint="实时下行"
          points={metricHistory.map((point) => point.downloadBps)}
        />
        <MetricStatCard
          index={1}
          label="上传速率"
          value={formatBytesPerSecond(parseInt(String(rate.CurrentUploadRate || '0'), 10))}
          color="text-info"
          icon={<UploadCloud className="h-5 w-5" />}
          hint="实时上行"
          points={metricHistory.map((point) => point.uploadBps)}
        />
        <MetricStatCard
          index={2}
          href="/device#online-devices"
          label="在线设备"
          value={`${overview?.connectedDevices || 0} 台`}
          color="text-success"
          icon={<UsersRound className="h-5 w-5" />}
          hint="点击查看终端列表"
          points={metricHistory.map((point) => point.connectedDevices)}
        />
        <MetricStatCard
          index={3}
          href="/device"
          label="信号强度"
          value={`${overview?.signalStrength ?? 0} dBm`}
          color="text-warning"
          icon={<RadioTower className="h-5 w-5" />}
          hint="蜂窝网络信号"
          badge={signalQuality ? (
            <Badge variant={signalBadgeVariant}>{signalQuality.label}</Badge>
          ) : null}
          points={metricHistory.map((point) => point.rsrp ?? point.signalStrength)}
        />
      </div>

      <div className="grid gap-4 sm:gap-5 xl:grid-cols-[minmax(0,1.45fr)_minmax(0,.75fr)]">
        <TrafficTrendCard
          timeRange={timeRange}
          onTimeRangeChange={setTimeRange}
          data={chartHistory}
        />
        <Card className="card-hover py-4 sm:py-5">
          <CardHeader className="px-4 sm:px-6">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <CardTitle className="flex items-center gap-2 text-base sm:text-lg">
                <span className="metric-icon size-8 rounded-xl sm:size-9"><PackageOpen className="h-4 w-4" /></span>
                套餐用量
              </CardTitle>
              {startDate ? (
                <Badge variant="outline">每月 {startDate.StartDay || 1} 号重置</Badge>
              ) : null}
            </div>
          </CardHeader>
          <CardContent className="px-4 sm:px-6">
            {startDate && trafficStats ? (
              <DataPlanCard startDate={startDate} trafficStats={trafficStats} />
            ) : (
              <Skeleton className="h-64 rounded-3xl" />
            )}
          </CardContent>
        </Card>
      </div>

      <NetworkHistoryGrid data={chartHistory} />

      <CollectionReportDialog
        open={reportOpen}
        onOpenChange={setReportOpen}
        data={reportData}
      />
    </>
  );
}

/** 底部实时区域：运行摘要、小区快照、调度与流量统计。 */
function LiveBottom() {
  const { overview, isConnected, signalQuality } = useLiveOverview();
  const { trafficStats } = useLiveRates();
  const {
    deviceName,
    cell,
    deviceSnapshot,
    smsSyncLabel,
    smsSyncDetail,
    schedulerSaving,
    toggleScheduler,
    changeSchedulerInterval,
    unit,
    setUnit,
  } = useDashboardSlow();

  return (
    <>
      <DashboardHero
        className="hidden sm:block"
        isConnected={isConnected}
        source={overview?.source}
        connectedDevices={overview?.connectedDevices || 0}
        cellId={cell.cellId}
        networkType={cell.networkType || overview?.networkType}
        carrierCode={String(deviceSnapshot?.deviceInformation?.Mccmnc || '')}
        signalStrength={overview?.signalStrength}
        signalLabel={signalQuality?.label}
        smsSyncLabel={smsSyncLabel}
        smsSyncDetail={smsSyncDetail}
        deviceName={deviceName}
      />

      <div className="grid gap-4 sm:gap-5 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,.85fr)]">
        <CellSnapshotCard
          networkType={overview?.networkType}
          connectionStatus={overview?.connectionStatus}
          deviceName={deviceName}
          carrierCode={String(deviceSnapshot?.deviceInformation?.Mccmnc || '')}
          cell={cell}
        />
        <SchedulerCard
          enabled={Boolean(overview?.schedulerStatus?.enabled)}
          interval={overview?.schedulerStatus?.interval || 60}
          running={Boolean(overview?.schedulerStatus?.running)}
          saving={schedulerSaving}
          onToggle={toggleScheduler}
          onIntervalChange={changeSchedulerInterval}
        />
      </div>

      <TrafficStatsPanel
        trafficStats={trafficStats}
        unit={unit}
        onUnitChange={setUnit}
      />
    </>
  );
}
