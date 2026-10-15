'use client';

import { Power } from 'lucide-react';
import { SettingsAccordionSection } from '@/components/settings/SettingsAccordionSection';
import { Switch } from '@/components/ui/switch';
import { useAutoStart } from '@/hooks/useAutoStart';

interface AutoStartSectionProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function AutoStartSection({ open, onOpenChange }: AutoStartSectionProps) {
  const { supported, enabled, pending, setEnabled } = useAutoStart();

  // 用普通浏览器打开（Docker 部署或本地开发）时没有宿主可写注册表，整块不出现。
  if (!supported) return null;

  const stateLabel = enabled === null ? '读取中…' : enabled ? '已启用' : '已关闭';

  return (
    <SettingsAccordionSection
      id="autostart"
      icon={<Power className="h-3.5 w-3.5" />}
      eyebrow="Windows startup"
      title="开机自启"
      description="登录 Windows 后自动启动 CPE Monitor 并继续后台同步；只写当前用户的注册表项，不需要管理员权限。"
      summary={[{ label: '状态', value: stateLabel }]}
      open={open}
      onOpenChange={onOpenChange}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <p className="text-sm font-medium">随 Windows 启动</p>
          <p className="text-xs leading-5 text-muted-foreground">
            打开后写入当前用户的 Run 项，指向现在这个安装位置的 CPEMonitor.exe；关闭后移除该项。
            程序被移动到别的目录时，下次启动会自动改回正确路径。
          </p>
        </div>
        <Switch
          checked={enabled === true}
          disabled={pending || enabled === null}
          onCheckedChange={(checked) => setEnabled(checked)}
          aria-label="随 Windows 启动"
        />
      </div>
    </SettingsAccordionSection>
  );
}
