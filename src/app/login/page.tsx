import { redirect } from 'next/navigation';
import { connection } from 'next/server';
import PasswordLogin from '@/components/PasswordLogin';
import { isDesktopMode } from '@/lib/desktop-auth';

export default async function LoginPage() {
  await connection();
  if (isDesktopMode()) redirect('/dashboard');
  return <PasswordLogin />;
}
