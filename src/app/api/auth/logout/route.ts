import { NextResponse } from 'next/server';
import { sessionCookieOptions } from '@/lib/auth';
import { isDesktopMode } from '@/lib/desktop-auth';

export async function GET(request: Request) {
  const response = NextResponse.redirect(new URL(isDesktopMode() ? '/dashboard' : '/login', request.url));
  // 必须与登录用同一套选项，否则这个删除指令可能被浏览器忽略、会话实际没退出。
  response.cookies.set('token', '', sessionCookieOptions(0));
  return response;
}
