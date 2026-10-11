import type { CpeSmsMessage } from '@/lib/cpe-client';
import type { AlertPayload, DailyReportPayload } from './types';

export interface PushplusConfig {
  token: string;
}

export interface PushplusSendResult {
  accepted: boolean;
  message: string;
  messageId: string | null;
}

interface PushplusApiResponse {
  code?: number;
  msg?: string;
  data?: string;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export async function sendPushplusMessage(
  config: PushplusConfig,
  title: string,
  content: string,
): Promise<PushplusSendResult> {
  if (!config.token.trim()) {
    return { accepted: false, message: 'PushPlus Token 未配置', messageId: null };
  }

  try {
    const response = await fetch('https://www.pushplus.plus/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: config.token.trim(),
        title,
        content,
        channel: 'wechat',
        template: 'html',
      }),
      signal: AbortSignal.timeout(15000),
    });
    const result = await response.json().catch(() => ({})) as PushplusApiResponse;

    if (!response.ok || result.code !== 200) {
      return {
        accepted: false,
        message: result.msg || `PushPlus 请求失败（HTTP ${response.status}）`,
        messageId: null,
      };
    }

    return {
      accepted: true,
      message: 'PushPlus 已受理，实际送达状态由 PushPlus 异步处理',
      messageId: typeof result.data === 'string' ? result.data : null,
    };
  } catch (error) {
    return {
      accepted: false,
      message: error instanceof Error && error.name === 'TimeoutError'
        ? '连接 PushPlus 超时'
        : '无法连接 PushPlus',
      messageId: null,
    };
  }
}

export async function sendPushplusSms(
  config: PushplusConfig,
  sms: CpeSmsMessage,
): Promise<boolean> {
  const content = [
    `<p><strong>号码：</strong>${escapeHtml(sms.phone || '未知')}</p>`,
    `<p><strong>时间：</strong>${escapeHtml(sms.date || '未知')}</p>`,
    `<p><strong>内容：</strong></p>`,
    `<blockquote>${escapeHtml(sms.content).replaceAll('\n', '<br>')}</blockquote>`,
    '<p>由 CPE Monitor 自动同步</p>',
  ].join('');
  const result = await sendPushplusMessage(config, 'CPE 收到新短信', content);
  if (!result.accepted) console.error('PushPlus SMS notification was not accepted:', result.message);
  return result.accepted;
}

export async function sendAlertPushplus(
  config: PushplusConfig,
  alert: AlertPayload,
): Promise<boolean> {
  const content = [
    `<h2>CPE 告警通知</h2>`,
    `<p><strong>规则：</strong>${escapeHtml(alert.ruleName)}</p>`,
    `<p><strong>时间：</strong>${escapeHtml(alert.timestamp)}</p>`,
    `<p><strong>详情：</strong>${escapeHtml(alert.message)}</p>`,
    '<p>请及时检查设备状态。</p>',
  ].join('');
  const result = await sendPushplusMessage(config, `CPE 告警 - ${alert.ruleName}`, content);
  if (!result.accepted) console.error('PushPlus alert notification was not accepted:', result.message);
  return result.accepted;
}

export async function sendDailyReportPushplus(
  config: PushplusConfig,
  report: DailyReportPayload,
): Promise<boolean> {
  const content = [
    `<h2>CPE 流量日报 - ${escapeHtml(report.date)}</h2>`,
    '<h3>今日概览</h3>',
    `<p><strong>总下载：</strong>${escapeHtml(report.totalDownload)}</p>`,
    `<p><strong>总上传：</strong>${escapeHtml(report.totalUpload)}</p>`,
    `<p><strong>在线设备：</strong>${report.deviceCount} 台</p>`,
    '<h3>网络质量</h3>',
    `<p><strong>评级：</strong>${escapeHtml(report.networkQuality)}</p>`,
    `<p><strong>平均信号：</strong>${report.avgSignal} dBm</p>`,
    '<p>由 CPE Monitor 自动生成</p>',
  ].join('');
  const result = await sendPushplusMessage(config, `CPE 流量日报 - ${report.date}`, content);
  if (!result.accepted) console.error('PushPlus daily report notification was not accepted:', result.message);
  return result.accepted;
}
