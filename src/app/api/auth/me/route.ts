import { jsonOk, requireSession, withApiHandler } from '@/lib/api-route';
import { isDesktopMode } from '@/lib/desktop-auth';

export const GET = withApiHandler(async () => {
  const session = await requireSession();
  return jsonOk({
    userId: session.userId,
    username: session.username,
    desktopMode: isDesktopMode(),
  });
}, '认证失败');
