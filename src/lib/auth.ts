import { SignJWT, jwtVerify } from 'jose';
import { compare } from 'bcryptjs';
import { cookies, headers } from 'next/headers';
import { isDesktopMode, isLocalDesktopRequest } from '@/lib/desktop-auth';

function resolveJwtSecret(): Uint8Array {
  const secret = process.env.JWT_SECRET?.trim();
  if (!secret) {
    throw new Error('JWT_SECRET is required. Set it in the environment (see .env.example).');
  }
  return new TextEncoder().encode(secret);
}

const JWT_SECRET = resolveJwtSecret();

/**
 * Resolves the admin password hash from environment.
 * Supports ADMIN_PASSWORD_HASH (bcrypt hash, recommended) or
 * legacy ADMIN_PASSWORD (plaintext, hashed at runtime for comparison).
 */
function resolveAdminPasswordHash(): string {
  const hash = process.env.ADMIN_PASSWORD_HASH?.trim();
  if (hash) return hash;
  // Legacy fallback: plaintext password in env (not recommended for production)
  const plain = process.env.ADMIN_PASSWORD?.trim();
  if (plain) return plain;
  throw new Error(
    'ADMIN_PASSWORD_HASH is required. Generate one with: npx tsx scripts/hash-password.ts <password>',
  );
}

/**
 * Verify the input password against the environment-configured admin credential.
 * If ADMIN_PASSWORD_HASH is set (starts with $2), uses bcrypt compare.
 * If only legacy ADMIN_PASSWORD is set, does a direct string comparison.
 */
export async function verifyAdminPassword(inputPassword: string): Promise<boolean> {
  const stored = resolveAdminPasswordHash();
  if (stored.startsWith('$2')) {
    return compare(inputPassword, stored);
  }
  // Legacy plaintext comparison
  return inputPassword === stored;
}

export async function createToken(payload: { userId: number; username: string }): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('24h')
    .sign(JWT_SECRET);
}

/**
 * 会话 cookie 的统一选项，登录与退出必须共用。
 *
 * 退出时若把 Secure 判据换成 NODE_ENV，在 HTTP 部署下浏览器会忽略带 Secure 的删除指令，
 * cookie 留着、会话实际仍然有效，用户以为已经退出。
 */
export function sessionCookieOptions(maxAgeSeconds = 60 * 60 * 24) {
  return {
    httpOnly: true,
    secure: process.env.SECURE_COOKIE === 'true',
    sameSite: 'lax' as const,
    maxAge: maxAgeSeconds,
    path: '/',
  };
}

export async function verifyToken(token: string) {
  try {
    const { payload } = await jwtVerify(token, JWT_SECRET);
    return payload as { userId: number; username: string };
  } catch {
    return null;
  }
}

export async function getSession() {
  const cookieStore = await cookies();
  if (isDesktopMode()) {
    // 免密码仅允许桌面宿主的本机同源访问，拒绝其他网页触发管理操作。
    return isLocalDesktopRequest(await headers()) ? { userId: 1, username: 'admin' } : null;
  }
  const token = cookieStore.get('token')?.value;
  if (!token) return null;
  return verifyToken(token);
}
