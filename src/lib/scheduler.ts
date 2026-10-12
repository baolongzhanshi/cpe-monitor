/**
 * Scheduler — orchestration layer for traffic collection, daily reports,
 * SMS sync, and device info sync scheduling.
 *
 * SMS and device-info sync logic lives in dedicated modules; this file
 * re-exports their public API for backward compatibility and coordinates
 * the traffic-collection cron and daily report generation.
 */
import cron, { type ScheduledTask } from 'node-cron';
import { initializeDatabase } from './db';
import { generateDailyReport, generateWeeklyReport, generateMonthlyReport } from './report-generator';
import { deliverDailyReport } from './daily-report-delivery';
import {
  resolveDailyReportPushSettings,
} from './daily-report-settings';
import { getSettingsMap } from './settings-store';
import { checkAlerts } from './alert-service';
import { collectTrafficData } from './traffic-collection-service';
import { APP_TIME_ZONE } from './date-time';
import { markDailyReportSent, upsertDailyReport, upsertPeriodReport } from './repositories/report-repository';
import { ensureSmsSchedulerStarted } from './sms-sync-scheduler';
import { ensureDeviceInfoSchedulerStarted } from './device-info-sync-scheduler';
import { writeSystemLog } from './system-log';
import { ensureRealtimeCollectorStarted } from './realtime-collector';
import { getTrafficSchedulerStatus, setTrafficSchedulerRunning } from './traffic-scheduler-status';

// ─── Re-exports for backward compatibility ──────────────────────────────
export { checkAlerts } from './alert-service';
export { collectTrafficData } from './traffic-collection-service';
export { collectDeviceInfo } from './device-info-collection-service';
export type { DeviceInfoCollectionResult } from './device-info-collection-service';

export {
  SMS_SYNC_MIN_INTERVAL,
  SMS_SYNC_MAX_INTERVAL,
  SMS_SYNC_DEFAULT_INTERVAL,
  getSmsSyncStatus,
  isValidSmsSyncInterval,
  restartSmsScheduler,
  stopSmsScheduler,
  ensureSmsSchedulerStarted,
  syncSmsMessages,
} from './sms-sync-scheduler';
export type { SmsSyncStatus, SmsSyncResult } from './sms-sync-scheduler';

export {
  DEVICE_INFO_SYNC_MIN_INTERVAL,
  DEVICE_INFO_SYNC_MAX_INTERVAL,
  DEVICE_INFO_SYNC_DEFAULT_INTERVAL,
  getDeviceInfoSyncStatus,
  isValidDeviceInfoSyncInterval,
  restartDeviceInfoScheduler,
  stopDeviceInfoScheduler,
  ensureDeviceInfoSchedulerStarted,
  syncDeviceInfo,
} from './device-info-sync-scheduler';
export type { DeviceInfoSyncStatus } from './device-info-sync-scheduler';

// ─── Traffic collection & daily report scheduling ───────────────────────

interface SchedulerTasks {
  hourlyTask: ScheduledTask | null;
  dailyTask: ScheduledTask | null;
  weeklyTask: ScheduledTask | null;
  monthlyTask: ScheduledTask | null;
}
const shared = globalThis as typeof globalThis & { __cpeMonitorSchedulerTasks?: SchedulerTasks };
const tasks = shared.__cpeMonitorSchedulerTasks ??= {
  hourlyTask: null, dailyTask: null, weeklyTask: null, monthlyTask: null,
};

export function getSchedulerStatus(): { running: boolean } {
  return { ...getTrafficSchedulerStatus() };
}

export function stopScheduler(): void {
  if (tasks.hourlyTask) { tasks.hourlyTask.stop(); tasks.hourlyTask = null; }
  if (tasks.dailyTask) { tasks.dailyTask.stop(); tasks.dailyTask = null; }
  if (tasks.weeklyTask) { tasks.weeklyTask.stop(); tasks.weeklyTask = null; }
  if (tasks.monthlyTask) { tasks.monthlyTask.stop(); tasks.monthlyTask = null; }
  setTrafficSchedulerRunning(false);
}

export function syncDailyReportSchedule(): void {
  if (tasks.dailyTask) {
    tasks.dailyTask.stop();
    tasks.dailyTask = null;
  }

  const settings = resolveDailyReportPushSettings(getSettingsMap());
  if (!settings.enabled) return;

  const [hour, minute] = settings.time.split(':').map(Number);
  tasks.dailyTask = cron.schedule(
    `${minute} ${hour} * * *`,
    async () => {
      console.log('Generating daily report...');
      await generateAndSendDailyReport();
    },
    { timezone: APP_TIME_ZONE },
  );
}

export async function startScheduler(): Promise<void> {
  initializeDatabase();
  const settingsMap = getSettingsMap();
  const enabled = settingsMap.scheduler_enabled === 'true';

  if (!enabled) {
    stopScheduler();
  } else {
    const interval = parseInt(settingsMap.scheduler_interval || '60', 10);
    stopScheduler();

    const cronExpression = interval <= 5
      ? '*/5 * * * *'
      : interval <= 15
        ? '*/15 * * * *'
        : interval <= 30
          ? '*/30 * * * *'
          : '0 * * * *';

    tasks.hourlyTask = cron.schedule(
      cronExpression,
      async () => {
        console.log('Running traffic collection...');
        writeSystemLog('info', `定时采集开始 (interval: ${interval}min)`);
        await collectTrafficData();
        await checkAlerts();
      },
      // noOverlap：上一轮还没结束时不再起一轮。node-cron 默认允许重叠，
      // 而一次采集可能超过采集周期，重叠会把同一段流量增量重复计入。
      { timezone: APP_TIME_ZONE, noOverlap: true },
    );
    setTrafficSchedulerRunning(true);

    // Weekly report: Sunday 22:30
    tasks.weeklyTask = cron.schedule(
      '30 22 * * 0',
      () => {
        console.log('Generating weekly report...');
        generateAndStoreWeeklyReport();
      },
      { timezone: APP_TIME_ZONE },
    );

    // Monthly report: 1st of month 00:30
    tasks.monthlyTask = cron.schedule(
      '30 0 1 * *',
      () => {
        console.log('Generating monthly report...');
        generateAndStoreMonthlyReport();
      },
      { timezone: APP_TIME_ZONE },
    );

    console.log(`Scheduler started with interval: ${interval} minutes`);
    writeSystemLog('info', `调度器已启动，采集间隔 ${interval} 分钟`);
  }

  syncDailyReportSchedule();
  await ensureSmsSchedulerStarted();
  await ensureDeviceInfoSchedulerStarted();
  await ensureRealtimeCollectorStarted();
}

export async function ensureSchedulerStarted(): Promise<void> {
  if (process.env.CPE_ISOLATED_TEST === 'true') return;
  initializeDatabase();
  const settings = getSettingsMap();

  if (settings.scheduler_enabled === 'true' && !getSchedulerStatus().running) {
    await startScheduler();
    return;
  }

  if (settings.scheduler_enabled !== 'true' && getSchedulerStatus().running) {
    stopScheduler();
  }

  syncDailyReportSchedule();
  await ensureSmsSchedulerStarted();
  await ensureDeviceInfoSchedulerStarted();
  await ensureRealtimeCollectorStarted();
}

// ─── Daily Report ───────────────────────────────────────────────────────

async function generateAndSendDailyReport(): Promise<void> {
  try {
    // 统计前一个完整自然日。统计当天的话，推送时刻之后的流量不会出现在任何一份日报里。
    const report = await generateDailyReport({ day: new Date(Date.now() - 24 * 60 * 60 * 1000) });
    upsertDailyReport(report);
    const delivery = await deliverDailyReport(report);
    if (delivery.sent) markDailyReportSent(report.reportDate);

    console.log('Daily report generated and stored');
    writeSystemLog('info', `日报生成完成: ${report.reportDate}`);
  } catch (error) {
    console.error('Failed to generate daily report:', error);
  }
}

function generateAndStoreWeeklyReport(): void {
  try {
    const report = generateWeeklyReport();
    upsertPeriodReport(report);
    writeSystemLog('info', `周报生成完成: ${report.periodKey}`);
    console.log('Weekly report generated:', report.periodKey);
  } catch (error) {
    console.error('Failed to generate weekly report:', error);
  }
}

function generateAndStoreMonthlyReport(): void {
  try {
    const report = generateMonthlyReport();
    upsertPeriodReport(report);
    writeSystemLog('info', `月报生成完成: ${report.periodKey}`);
    console.log('Monthly report generated:', report.periodKey);
  } catch (error) {
    console.error('Failed to generate monthly report:', error);
  }
}
