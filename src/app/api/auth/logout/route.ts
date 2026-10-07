import { NextResponse } from 'next/server';
import { isDesktopMode } from '@/lib/desktop-auth';

export async function GET(request: Request) {
  const response = NextResponse.redirect(new URL(isDesktopMode() ? '/dashboard' : '/login', request.url));
  response.cookies.set('token', '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 0,
    path: '/',
  });
  return response;
}
