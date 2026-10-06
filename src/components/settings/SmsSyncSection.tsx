'use client';

import { MessageSquareText } from 'lucide-react';
import { SyncSettingsSection } from '@/components/settings/SyncSettingsSection';
import { SMS_SYNC_INTERVAL } from '@/lib/sync-interval';
import type { SmsSyncConfigForm } from '@/features/settings/types';

interface SmsSyncSectionProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  smsSyncConfig: SmsSyncConfigForm;
  setSmsSyncConfig: (value: SmsSyncConfigForm) => void;
  smsState: string;
  savingSmsSync: boolean;
  onSave: () => void;
}

export function SmsSyncSection({
  open,
  onOpenChange,
  smsSyncConfig,
  setSmsSyncConfig,
  smsState,
  savingSmsSync,
  onSave,
}: SmsSyncSectionProps) {
  return (
    <SyncSettingsSection
      id="automation"
      icon={<MessageSquareText className="h-3.5 w-3.5" />}
      eyebrow="Automation"
      title="短信自动同步"
      description="默认每 15 秒检查新短信；首次同步只保存历史短信，之后推送新收件短信。"
      open={open}
      onOpenChange={onOpenChange}
      config={smsSyncConfig}
      setConfig={setSmsSyncConfig}
      stateLabel={smsState}
      saving={savingSmsSync}
      onSave={onSave}
      min={SMS_SYNC_INTERVAL.minInterval}
      max={SMS_SYNC_INTERVAL.maxInterval}
      intervalUnit="seconds"
      hint="15–86400 秒，默认 15 秒。间隔越长，设备访问频率越低；推送到达时间还受网络和 PushPlus 队列影响。"
      switchDescription="关闭后仍可在短信页手动同步"
      switchAriaLabel="启用短信自动同步"
      saveLabel="保存自动化设置"
    />
  );
}

export default SmsSyncSection;
