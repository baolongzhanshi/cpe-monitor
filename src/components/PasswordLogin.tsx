'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { motion, useReducedMotion } from 'framer-motion';
import { Loader2, RadioTower, ShieldCheck } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Callout } from '@/components/Callout';

export default function PasswordLogin() {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [firstRunPassword, setFirstRunPassword] = useState<string | null>(null);
  const router = useRouter();
  const reduce = useReducedMotion();

  useEffect(() => {
    fetch('/api/system/first-run-password', { cache: 'no-store' })
      .then((response) => response.ok ? response.json() : null)
      .then((data: { available?: boolean; password?: string } | null) => {
        if (data?.available && data.password) setFirstRunPassword(data.password);
      })
      .catch(() => undefined);
  }, []);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });

      const data = await res.json();

      if (res.ok) {
        setSuccess(true);
        window.setTimeout(() => router.push('/dashboard'), reduce ? 100 : 450);
      } else {
        setError(data.error || '登录失败');
      }
    } catch {
      setError('网络错误');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background p-4 sm:p-6">
      <motion.div
        className="relative z-10 w-full max-w-md"
        initial={reduce ? undefined : { opacity: 0, scale: 0.92, y: 20 }}
        animate={
          success
            ? { opacity: 0, scale: 0.95, y: -10 }
            : { opacity: 1, scale: 1, y: 0 }
        }
        transition={{ type: 'spring', stiffness: 260, damping: 22 }}
      >
        <Card className="border-border bg-card">
          <CardHeader className="space-y-3 text-center">
            <span
              className="mx-auto inline-flex size-14 items-center justify-center rounded-2xl bg-brand text-primary-foreground shadow-lg shadow-brand/20"
            >
              <RadioTower className="h-6 w-6" />
            </span>
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-brand/70">CPE monitor</p>
            <CardTitle className="bg-gradient-to-r from-brand to-info bg-clip-text text-3xl font-bold tracking-tight text-transparent">
              CPEye
            </CardTitle>
            <CardDescription className="text-sm leading-6">
              5G CPE 流量监控 · 告警与每日报告
            </CardDescription>
            <div className="mx-auto flex w-fit items-center gap-1.5 rounded-full bg-success/10 px-3 py-1.5 text-xs font-semibold text-success">
              <ShieldCheck className="h-3.5 w-3.5" />
              本地管理控制台
            </div>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleLogin} className="space-y-5">
              {firstRunPassword ? (
                <Callout tone="info" title="首次启动密码">
                  已为你生成管理员密码：<code className="select-all break-all">{firstRunPassword}</code><br />
                  请先复制保存，登录成功后此提示会自动隐藏。
                </Callout>
              ) : null}
              <motion.div
                className="space-y-2"
                animate={error && !reduce ? { x: [0, -6, 6, -4, 4, 0] } : { x: 0 }}
                transition={{ duration: 0.4 }}
              >
                <Label htmlFor="password" className="transition-colors duration-200">管理员密码</Label>
                <Input
                  id="password"
                  type="password"
                  placeholder="请输入密码"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="h-11 rounded-xl"
                  required
                  autoComplete="current-password"
                />
              </motion.div>

              {error ? (
                <motion.div
                  initial={reduce ? undefined : { opacity: 0, y: -8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.25 }}
                >
                  <Callout tone="danger" title="登录失败">
                    {error}
                  </Callout>
                </motion.div>
              ) : null}

              <Button
                type="submit"
                className="h-11 w-full rounded-xl text-sm font-semibold"
                disabled={loading || success}
              >
                {loading ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    登录中…
                  </>
                ) : success ? (
                  '登录成功'
                ) : (
                  '登录'
                )}
              </Button>
            </form>
          </CardContent>
        </Card>
      </motion.div>
    </div>
  );
}
