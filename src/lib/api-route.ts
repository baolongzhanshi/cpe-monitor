import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { isLocalDesktopRequest } from '@/lib/desktop-auth';
import { initializeDatabase } from '@/lib/db';

export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status = 500) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export function ensureDatabase() {
  initializeDatabase();
}

export async function requireSession() {
  const session = await getSession();
  if (!session) {
    throw new ApiError('未登录', 401);
  }
  return session;
}

/**
 * 宿主进程不带会话 cookie，它靠"本机回环来源"通过校验；其它来源仍然必须已登录。
 *
 * 用于既服务于宿主、又可能被浏览器访问的接口（诊断导出、资源采样上报）。
 * 这些接口原先完全没有校验——桌面版下只监听回环所以看不出问题，
 * 但一旦按 README 用 Docker 或 npm start 部署，它们就是匿名可写的入口。
 */
export async function isSessionOrLocalRequest(request: Request): Promise<boolean> {
  if (isLocalDesktopRequest(request.headers)) return true;
  return (await getSession()) !== null;
}

export function jsonError(message: string, status = 500, cause?: unknown) {
  if (cause !== undefined) {
    console.error(message, cause);
  }
  return NextResponse.json({ error: message }, { status });
}

export function jsonOk<T>(data: T, init?: ResponseInit) {
  return NextResponse.json(data, init);
}

type RouteHandler = (request: Request) => Promise<Response> | Response;
type RouteHandlerWithoutRequest = () => Promise<Response> | Response;

/**
 * Wraps an API handler with unified error mapping.
 * Throws ApiError for expected failures; other errors become 500.
 */
export function withApiHandler(
  handler: RouteHandler | RouteHandlerWithoutRequest,
  fallbackMessage = '请求失败',
): RouteHandler {
  return async (request: Request) => {
    try {
      if (handler.length === 0) {
        return await (handler as RouteHandlerWithoutRequest)();
      }
      return await (handler as RouteHandler)(request);
    } catch (error) {
      if (error instanceof ApiError) {
        return jsonError(error.message, error.status);
      }
      console.error(fallbackMessage, error);
      const message = error instanceof Error && error.message
        ? error.message
        : fallbackMessage;
      return jsonError(message, 500);
    }
  };
}

export async function parseJsonBody<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch (error) {
    console.error('Failed to parse request body', error);
    throw new ApiError('请求体格式无效', 400);
  }
}
