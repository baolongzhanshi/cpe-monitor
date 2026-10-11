import { formatBytes } from './format';
import { readNotificationConfig } from './settings-store';
import { sendDailyReport } from './notifiers/email';
import { sendDailyReportWechat } from './notifiers/wechat';
import { sendDailyReportPushplus } from './notifiers/pushplus';
import type { DailyReport } from '@/types';

export interface DailyReportDeliveryResult {
  emailConfigured: boolean;
  wechatConfigured: boolean;
  pushplusConfigured: boolean;
  emailSent: boolean;
  wechatSent: boolean;
  pushplusSent: boolean;
  sent: boolean;
}

export async function deliverDailyReport(
  report: DailyReport,
): Promise<DailyReportDeliveryResult> {
  const emailConfig = readNotificationConfig('email');
  const wechatConfig = readNotificationConfig('wechat');
  const pushplusConfig = readNotificationConfig('pushplus');
  const payload = {
    date: report.reportDate,
    totalDownload: formatBytes(report.totalDownload),
    totalUpload: formatBytes(report.totalUpload),
    deviceCount: report.topDevices?.length || 0,
    networkQuality: report.networkQuality || '数据不足',
    avgSignal: report.avgSignal || 0,
  };

  const [emailSent, wechatSent, pushplusSent] = await Promise.all([
    emailConfig ? sendDailyReport(emailConfig, report) : Promise.resolve(false),
    wechatConfig?.webhookUrl ? sendDailyReportWechat(wechatConfig, payload) : Promise.resolve(false),
    pushplusConfig?.token ? sendDailyReportPushplus(pushplusConfig, payload) : Promise.resolve(false),
  ]);

  return {
    emailConfigured: Boolean(emailConfig),
    wechatConfigured: Boolean(wechatConfig?.webhookUrl),
    pushplusConfigured: Boolean(pushplusConfig?.token),
    emailSent,
    wechatSent,
    pushplusSent,
    sent: emailSent || wechatSent || pushplusSent,
  };
}
