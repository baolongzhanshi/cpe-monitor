'use client';

import { Clock } from 'lucide-react';
import { SettingsAccordionSection } from '@/components/settings/SettingsAccordionSection';
import { SaveButton } from '@/components/settings/SaveButton';
import FieldGroup from '@/components/forms/FieldGroup';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import type { DailyReportPushForm } from '@/features/settings/types';

interface DailyReportPushSectionProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  value: DailyReportPushForm;
  onChange: (value: DailyReportPushForm) => void;
  saving: boolean;
  onSave: () => void;
}

export function DailyReportPushSection({
  open,
  onOpenChange,
  value,
  onChange,
  saving,
  onSave,
}: DailyReportPushSectionProps) {
  return (
    <SettingsAccordionSection
      id="report-push"
      icon={<Clock className="h-3.5 w-3.5" />}
      eyebrow="Daily report"
      title="每日流量报告推送"
      description="按设定时间生成当日流量报告，并发送到已配置的邮件、企业微信和 PushPlus 渠道。"
      open={open}
      onOpenChange={onOpenChange}
      status={
        <Badge variant={value.enabled ? 'info' : 'secondary'}>
          {value.enabled ? '已开启' : '已关闭'}
        </Badge>
      }
      summary={[
        { label: '推送', value: value.enabled ? '开启' : '关闭' },
        { label: '时间', value: value.time },
      ]}
    >
      <div className="fluid-card-grid gap-4 [--fluid-card-min:13rem]">
        <div className="flex min-h-10 items-center gap-2">
          <Switch
            checked={value.enabled}
            onCheckedChange={(enabled) => onChange({ ...value, enabled })}
          />
          <Label>每天自动推送日报</Label>
        </div>
        <FieldGroup label="推送时间" hint="使用本机时区，精确到分钟。">
          <Input
            type="time"
            value={value.time}
            disabled={!value.enabled}
            onChange={(event) => onChange({ ...value, time: event.target.value })}
          />
        </FieldGroup>
      </div>
      <p className="rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-xs leading-5 text-muted-foreground">
        只会发送到已经配置并启用的通知渠道；没有任何可用渠道时仍会生成并保存报告，但不会推送。
      </p>
      <div className="mt-auto flex justify-end border-t border-border/60 pt-3">
        <SaveButton saving={saving} onClick={onSave} label="保存日报推送设置" />
      </div>
    </SettingsAccordionSection>
  );
}

export default DailyReportPushSection;
