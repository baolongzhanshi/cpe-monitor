import { createHash } from 'node:crypto';
import type { CpeSmsMessage } from '../types/cpe';

export const SMS_FULL_SYNC_INTERVAL_MS = 60_000;

export interface SmsOverview {
  count: Record<string, string>;
  contacts: CpeSmsMessage[];
}

export interface SmsReadClient {
  getSmsOverview(): Promise<SmsOverview>;
  getSmsMessages(overview?: SmsOverview): Promise<{
    messages: CpeSmsMessage[];
    count: Record<string, string>;
  }>;
}

export interface SmsSyncMode {
  fullSync: boolean;
}

export function validateSmsCount(count: Record<string, string>): void {
  if (!Object.hasOwn(count, 'LocalInbox')) {
    throw new Error('CPE 短信计数缺少收件箱信息，请重试。');
  }
  for (const [key, value] of Object.entries(count)) {
    if (!/^(?:Local|Sim)(?:Inbox|Outbox|Unread|Draft|Deleted)$/.test(key)) continue;
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
      throw new Error('CPE 返回了无效的短信计数，请重试。');
    }
  }
}

export function getExpectedLocalSmsCount(count: Record<string, string>): number {
  validateSmsCount(count);
  return Number(count.LocalInbox) + Number(count.LocalOutbox || 0);
}

function getOverviewSignature(overview: SmsOverview): string {
  validateSmsCount(overview.count);
  const count = Object.entries(overview.count)
    .sort(([a], [b]) => a.localeCompare(b));
  const contacts = overview.contacts.map((sms) => JSON.stringify([
    sms.id, sms.phone, sms.date, sms.content, sms.status, sms.type,
    sms.box, sms.unread, sms.direction,
  ])).sort();
  return createHash('sha256').update(JSON.stringify([count, contacts])).digest('hex');
}

export function createSmsLightweightSync<Result extends SmsSyncMode>(options: {
  getClient: () => SmsReadClient;
  persistMessages: (messages: CpeSmsMessage[]) => Promise<Result>;
  skippedResult: () => Result;
  now?: () => number;
  fullSyncIntervalMs?: number;
}) {
  const now = options.now || Date.now;
  const interval = options.fullSyncIntervalMs ?? SMS_FULL_SYNC_INTERVAL_MS;
  let checkpoint: { client: SmsReadClient; signature: string; syncedAt: number } | null = null;
  let generation = 0;

  return {
    reset(): void {
      checkpoint = null;
      generation += 1;
    },
    async run(source: 'scheduler' | 'manual'): Promise<Result> {
      const startedAt = now();
      const currentGeneration = generation;
      try {
        const client = options.getClient();
        const overview = await client.getSmsOverview();
        const signature = getOverviewSignature(overview);
        if (
          source !== 'manual'
          && checkpoint?.client === client
          && checkpoint.signature === signature
          && startedAt >= checkpoint.syncedAt
          && startedAt - checkpoint.syncedAt < interval
        ) {
          return options.skippedResult();
        }

        const { messages } = await client.getSmsMessages(overview);
        const result = await options.persistMessages(messages);
        // 只有读取和入库均成功，才允许后续轮询跳过历史读取。
        if (generation === currentGeneration) {
          checkpoint = { client, signature, syncedAt: startedAt };
        }
        return result;
      } catch (error) {
        checkpoint = null;
        throw error;
      }
    },
  };
}

export async function ensureFullSmsSync<Result extends SmsSyncMode>(
  sync: (source: 'manual') => Promise<Result>,
): Promise<Result> {
  // 手动操作可能复用进行中的自动检查，检查结束后补一次完整同步。
  let result = await sync('manual');
  while (!result.fullSync) result = await sync('manual');
  return result;
}
