import fs from 'node:fs';
import { NextResponse } from 'next/server';

/** 首次启动展示一次性密码；登录成功后由登录接口删除文件。 */
export async function GET() {
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
