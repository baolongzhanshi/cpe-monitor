import {
  ApiError,
  ensureDatabase,
  jsonOk,
  requireSession,
  withApiHandler,
} from '@/lib/api-route';
import { readNotificationConfig } from '@/lib/settings-store';
import { sendPushplusSms } from '@/lib/notifiers/pushplus';

export const POST = withApiHandler(async () => {
  await requireSession();
  ensureDatabase();

  const config = readNotificationConfig('pushplus');
  if (!config?.token) {
    throw new ApiError('请先保存 PushPlus Token', 400);
  }

  const accepted = await sendPushplusSms(config, {
    id: 'pushplus-test',
    phone: 'PushPlus 配置测试',
    date: new Date().toISOString(),
    content: '这是一条来自 CPE Monitor 的 PushPlus 测试通知。',
    unread: false,
    direction: 'inbound',
  } as Parameters<typeof sendPushplusSms>[1]);

  if (!accepted) {
    throw new ApiError('PushPlus 未接受测试消息，请检查 Token 和服务状态', 502);
  }

  return jsonOk({ success: true, message: '测试消息已提交给 PushPlus' });
}, 'PushPlus 测试失败');
