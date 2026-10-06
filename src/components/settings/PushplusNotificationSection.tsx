'use client';

import { Send } from 'lucide-react';
import { SettingsAccordionSection } from '@/components/settings/SettingsAccordionSection';
import { SaveButton } from '@/components/settings/SaveButton';
import FieldGroup from '@/components/forms/FieldGroup';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { PushplusConfigForm } from '@/features/settings/types';

interface PushplusNotificationSectionProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  config: PushplusConfigForm;
  setConfig: (value: PushplusConfigForm) => void;
  configured: boolean;
  loading: boolean;
  testing: boolean;
  onSave: () => void;
  onTest: () => void;
}

export function PushplusNotificationSection({
  open,
  onOpenChange,
  config,
  setConfig,
  configured,
  loading,
  testing,
  onSave,
  onTest,
}: PushplusNotificationSectionProps) {
  return (
    <SettingsAccordionSection
      id="pushplus"
      icon={<Send className="h-3.5 w-3.5" />}
      eyebrow="PushPlus"
      title="PushPlus 短信同步推送"
      description="发现 CPE 新收件短信后，推送完整内容到 PushPlus。"
      open={open}
      onOpenChange={onOpenChange}
      status={<Badge variant={configured ? 'info' : 'secondary'}>{configured ? '已配置' : '未配置'}</Badge>}
      summary={[{ label: 'Token', value: config.token ? '将更新' : configured ? '已安全保存' : '—', mono: true }]}
    >
      <FieldGroup
        label="PushPlus Token"
        hint={configured ? 'Token 已加密保存；留空可保留现有 Token。' : '在 PushPlus 官网登录后，从个人中心复制 Token。'}
      >
        <Input
          className="h-9 rounded-lg bg-background/60 font-mono text-xs"
          type="password"
          autoComplete="new-password"
          value={config.token}
          onChange={(event) => setConfig({ ...config, token: event.target.value })}
          placeholder={configured ? '留空保持现有 Token' : '粘贴 PushPlus Token'}
        />
      </FieldGroup>
      <p className="rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-xs leading-5 text-muted-foreground">
        CPE 短信正文会通过 PushPlus 微信消息通道推送。PushPlus 短信通道只能发送固定提醒，不能携带短信正文；接口受理后也会异步投递，实际到达时间取决于轮询与 PushPlus 队列。
      </p>
      <div className="mt-auto flex flex-wrap justify-end gap-2 border-t border-border/60 pt-3">
        <Button type="button" variant="outline" size="sm" onClick={onTest} disabled={!configured || loading || testing}>
          <Send className="mr-1.5 h-3.5 w-3.5" />
          {testing ? '提交中…' : '发送测试'}
        </Button>
        <SaveButton saving={loading} onClick={onSave} label="保存 PushPlus 配置" />
      </div>
    </SettingsAccordionSection>
  );
}

export default PushplusNotificationSection;
