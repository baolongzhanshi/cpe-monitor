'use client';

import { useCallback, useRef, useState } from 'react';
import { Check, ChevronLeft, ChevronRight, Rocket, Wifi, BellRing, Timer, PartyPopper, LoaderCircle } from 'lucide-react';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { apiFetch } from '@/lib/client-api';
import { cn } from '@/lib/utils';
import { normalizeCpeUrl } from '@/lib/cpe-url';

async function saveSetupStep(url: string, body: unknown, fallbackError: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    await apiFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    }, fallbackError);
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error('保存超时，请重试。');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

const STEPS = [
  { id: 'welcome', label: '欢迎', icon: Rocket },
  { id: 'connection', label: 'CPE 连接', icon: Wifi },
  { id: 'notification', label: '通知渠道', icon: BellRing },
  { id: 'scheduler', label: '定时采集', icon: Timer },
  { id: 'done', label: '完成', icon: PartyPopper },
] as const;

interface SetupWizardProps {
  open: boolean;
  onComplete: () => void;
}

export function SetupWizard({ open, onComplete }: SetupWizardProps) {
  const [step, setStep] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const savingRef = useRef(false);

  // CPE 连接信息
  const [cpeUrl, setCpeUrl] = useState('');
  const [cpeUsername, setCpeUsername] = useState('admin');
  const [cpePassword, setCpePassword] = useState('');

  // 定时采集设置
  const [schedulerEnabled, setSchedulerEnabled] = useState(true);
  const [schedulerInterval, setSchedulerInterval] = useState('60');

  const finishSetup = useCallback(async () => {
    await saveSetupStep('/api/system/setup-status', { completed: true }, '保存设置失败');
    onComplete();
  }, [onComplete]);

  const saveCpeConfig = useCallback(async () => {
    const normalizedUrl = normalizeCpeUrl(cpeUrl);
    await saveSetupStep('/api/settings/cpe', {
      cpeUrl: normalizedUrl,
      cpeUsername: cpeUsername.trim() || 'admin',
      cpePassword: cpePassword || undefined,
    }, '保存 CPE 配置失败');
    setCpeUrl(normalizedUrl);
  }, [cpeUrl, cpeUsername, cpePassword]);

  const saveScheduler = useCallback(async () => {
    const interval = Number(schedulerInterval);
    if (schedulerEnabled && (!Number.isInteger(interval) || interval < 5 || interval > 1440)) {
      throw new Error('采集间隔应为 5～1440 分钟的整数');
    }
    await saveSetupStep('/api/dashboard/scheduler', {
      enabled: schedulerEnabled,
      interval: schedulerEnabled ? interval : 60,
    }, '保存调度器配置失败');
  }, [schedulerEnabled, schedulerInterval]);

  const runAction = useCallback(async (action: () => Promise<void>) => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      await action();
    } catch (error) {
      setError(error instanceof Error ? error.message : '保存设置失败，请重试。');
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, []);

  const handleNext = () => runAction(async () => {
    if (step === 1) await saveCpeConfig();
    if (step === 3) await saveScheduler();
    if (step === STEPS.length - 1) {
      await finishSetup();
      return;
    }
    setStep((s) => Math.min(s + 1, STEPS.length - 1));
  });

  const handleBack = () => {
    setError(null);
    setStep((s) => Math.max(s - 1, 0));
  };

  const handleSkip = () => runAction(finishSetup);

  const currentStep = STEPS[step];

  return (
    <Dialog open={open}>
      <DialogContent showCloseButton={false} className="sm:max-w-md" aria-busy={saving}>
        <DialogHeader>
          <div className="mb-2 flex items-center gap-1.5">
            {STEPS.map((s, i) => (
              <div
                key={s.id}
                className={cn(
                  'h-1.5 flex-1 rounded-full transition-colors',
                  i <= step ? 'bg-brand' : 'bg-muted',
                )}
              />
            ))}
          </div>
          <DialogTitle className="flex items-center gap-2">
            <currentStep.icon className="h-5 w-5 text-brand" />
            {currentStep.label}
          </DialogTitle>
          <DialogDescription>
            {step === 0 && '欢迎使用 CPEye！接下来几步将帮助你完成基本配置。'}
            {step === 1 && '配置你的 CPE 路由器连接信息，用于采集流量和设备数据。'}
            {step === 2 && '可选：配置通知渠道，在告警触发时接收提醒。可稍后在设置中配置。'}
            {step === 3 && '配置定时数据采集，系统将按设定间隔自动收集流量数据。'}
            {step === 4 && '配置完成！你可以随时在设置页面修改这些选项。'}
          </DialogDescription>
        </DialogHeader>

        {/* 当前步骤 */}
        <div className="min-h-[140px] space-y-4">
          {step === 0 && (
            <div className="flex flex-col items-center justify-center gap-3 py-6 text-center">
              <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-brand/10">
                <Rocket className="h-8 w-8 text-brand" />
              </div>
              <p className="text-sm text-muted-foreground">
                CPEye 帮助你监控 CPE 路由器的流量、信号和设备状态。<br />
                让我们花 1 分钟完成初始设置。
              </p>
            </div>
          )}

          {step === 1 && (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="cpe-url">CPE 地址</Label>
                <Input
                  id="cpe-url"
                  placeholder="http://192.168.1.1"
                  value={cpeUrl}
                  disabled={saving}
                  onChange={(e) => setCpeUrl(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="cpe-user">用户名</Label>
                <Input
                  id="cpe-user"
                  placeholder="admin"
                  value={cpeUsername}
                  disabled={saving}
                  onChange={(e) => setCpeUsername(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="cpe-pass">密码</Label>
                <Input
                  id="cpe-pass"
                  type="password"
                  placeholder="CPE 管理密码"
                  value={cpePassword}
                  disabled={saving}
                  onChange={(e) => setCpePassword(e.target.value)}
                />
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="flex flex-col items-center justify-center gap-3 py-6 text-center">
              <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-muted">
                <BellRing className="h-7 w-7 text-muted-foreground" />
              </div>
              <p className="text-sm text-muted-foreground">
                通知渠道（邮件、企业微信等）可在设置页面中随时配置。<br />
                此步骤可直接跳过。
              </p>
            </div>
          )}

          {step === 3 && (
            <div className="space-y-4">
              <label className="flex items-center gap-3 rounded-xl border border-border/60 p-3">
                <input
                  type="checkbox"
                  checked={schedulerEnabled}
                  disabled={saving}
                  onChange={(e) => setSchedulerEnabled(e.target.checked)}
                  className="h-4 w-4 rounded border-input accent-brand"
                />
                <span className="text-sm">启用定时采集</span>
              </label>
              {schedulerEnabled && (
                <div className="space-y-2">
                  <Label htmlFor="interval">采集间隔（分钟）</Label>
                  <Input
                    id="interval"
                    type="number"
                    min={5}
                    max={1440}
                    value={schedulerInterval}
                    disabled={saving}
                    onChange={(e) => setSchedulerInterval(e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">推荐 30~60 分钟，过短可能增加 CPE 负担。</p>
                </div>
              )}
            </div>
          )}

          {step === 4 && (
            <div className="flex flex-col items-center justify-center gap-3 py-6 text-center">
              <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-success/10">
                <Check className="h-8 w-8 text-success" />
              </div>
              <p className="text-sm text-muted-foreground">
                一切就绪！点击「开始使用」进入仪表盘。
              </p>
            </div>
          )}
        </div>

        {error && (
          <p role="alert" className="break-words rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
            {error}
          </p>
        )}

        <DialogFooter className="flex-row justify-between">
          <div className="flex gap-2">
            {step > 0 && step < STEPS.length - 1 && (
              <Button variant="ghost" size="sm" onClick={handleBack} disabled={saving}>
                <ChevronLeft className="mr-1 h-4 w-4" />上一步
              </Button>
            )}
            {step > 0 && step < STEPS.length - 1 && (
              <Button variant="ghost" size="sm" onClick={handleSkip} disabled={saving}>
                跳过引导
              </Button>
            )}
          </div>
          <Button onClick={handleNext} disabled={saving || (step === 1 && !cpeUrl.trim())}>
            {saving && <LoaderCircle className="mr-1 h-4 w-4 animate-spin" />}
            {saving ? '保存中…' : step === STEPS.length - 1 ? '开始使用' : step === 0 ? '开始配置' : '下一步'}
            {step < STEPS.length - 1 && <ChevronRight className="ml-1 h-4 w-4" />}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
