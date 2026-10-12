import fs from 'node:fs';
import { NextResponse } from 'next/server';
import { isDesktopMode } from '@/lib/desktop-auth';

/** 只允许从本机回环地址读取，避免把引导密码暴露给局域网里的任意客户端。 */
function isLoopbackHost(request: Request): boolean {
  const host = request.headers.get('host')?.toLowerCase() ?? '';
  return host.startsWith('127.0.0.1:')
    || host.startsWith('localhost:')
    || host.startsWith('[::1]:');
}

/** 首次启动展示一次性密码；登录成功后由登录接口删除文件。 */
export async function GET(request: Request) {
  if (isDesktopMode() || !isLoopbackHost(request)) {
    return NextResponse.json({ available: false }, { headers: { 'Cache-Control': 'no-store' } });
  }
  const filePath = process.env.CPE_FIRST_RUN_PASSWORD_FILE?.trim();
  if (!filePath || !fs.existsSync(filePath)) {
    return NextResponse.json({ available: false });
  }

  const password = fs.readFileSync(filePath, 'utf8').trim();
  if (!password) return NextResponse.json({ available: false });
  return NextResponse.json({ available: true, password }, {
    headers: { 'Cache-Control': 'no-store' },
  });
}
