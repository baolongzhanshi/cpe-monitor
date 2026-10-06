import type { CpeSmsMessage } from '@/lib/cpe-client';

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
