'use client';

import { useCallback, useMemo, useState } from 'react';
import { formatSyncTime, maskSecret } from '@/lib/format';
import { useCpeSettings } from '@/features/settings/hooks/useCpeSettings';
import { useDataRetentionSettings } from '@/features/settings/hooks/useDataRetentionSettings';
import { useDataQuotaSettings } from '@/features/settings/hooks/useDataQuotaSettings';
import { useDailyReportSettings } from '@/features/settings/hooks/useDailyReportSettings';
import { useNotificationSettings } from '@/features/settings/hooks/useNotificationSettings';
import { useSmsSyncSettings } from '@/features/settings/hooks/useSmsSyncSettings';
import { useDeviceInfoSyncSettings } from '@/features/settings/hooks/useDeviceInfoSyncSettings';
import { useSystemUpdate } from '@/features/settings/hooks/useSystemUpdate';
import type { SettingsActionContext, SettingsMessage, SettingsSectionId } from '@/features/settings/types';

export type {
  CpeConfigForm,
  DataQuotaForm,
  DataRetentionForm,
  DailyReportPushForm,
  DeviceInfoSyncConfigForm,
  EmailConfigForm,
  SettingsSectionId,
  SmsSyncConfigForm,
  SyncConfigForm,
  TestResultState,
  UpdateStatusState,
  WechatConfigForm,
  PushplusConfigForm,
} from '@/features/settings/types';

export function useSettingsPage() {
  const [message, setMessage] = useState<SettingsMessage>({ type: '', text: '' });
  const [openSection, setOpenSection] = useState<SettingsSectionId | null>(null);
  const collapseSection = useCallback(() => setOpenSection(null), []);
  const onMessage = useCallback((next: SettingsMessage) => setMessage(next), []);
  const actionContext = useMemo<SettingsActionContext>(() => ({ onMessage, onSaved: collapseSection }), [collapseSection, onMessage]);

  const cpe = useCpeSettings(actionContext);
  const notifications = useNotificationSettings(actionContext);
  const dailyReport = useDailyReportSettings(actionContext);
  const sms = useSmsSyncSettings(actionContext);
  const deviceInfoSync = useDeviceInfoSyncSettings(actionContext);
  const retention = useDataRetentionSettings(actionContext);
  const quota = useDataQuotaSettings(actionContext);
  const update = useSystemUpdate();

  const pageLoading = cpe.initialLoading
    || notifications.initialLoading
    || dailyReport.initialLoading
    || sms.initialLoading
    || deviceInfoSync.initialLoading
    || retention.initialLoading
    || quota.initialLoading;
  // 各区块的保存状态各自独立，调用方按区块取自己的那个。
  // 这里曾经聚合成一个 loading 传给多个区块，结果是保存邮件通知会让 CPE 与企微的按钮
  // 一起转圈、保存结束后三个按钮一起闪「已保存」，而实际只保存了一个。
  // 聚合值本身已无人使用，直接删除，避免又有人拿它当"整页保存中"用。

  const overviewMeta = useMemo(() => ({
    cpeConfigured: Boolean(cpe.cpeConfig.cpeUrl),
    cpeUrl: cpe.cpeConfig.cpeUrl,
    smsEnabled: sms.smsSyncConfig.enabled,
    smsInterval: sms.smsSyncConfig.interval,
    smsLastSyncedAt: sms.smsSyncConfig.lastSyncedAt,
    smsLastError: sms.smsSyncConfig.lastError,
    emailConfigured: notifications.emailConfigured,
    emailHost: notifications.emailConfig.smtpHost,
    recipientCount: notifications.recipientCount,
    wechatConfigured: notifications.wechatConfigured,
    pushplusConfigured: notifications.pushplusConfigured,
    wechatMasked: notifications.wechatConfig.webhookUrl
      ? maskSecret(notifications.wechatConfig.webhookUrl)
      : notifications.wechatWebhookSet ? '已安全保存' : '',
    smsSyncLabel: formatSyncTime(sms.smsSyncConfig.lastSyncedAt),
  }), [cpe.cpeConfig.cpeUrl, notifications, sms.smsSyncConfig]);

  return {
    ...cpe,
    ...notifications,
    ...dailyReport,
    ...sms,
    ...deviceInfoSync,
    ...retention,
    ...quota,
    ...update,
    pageLoading,
    message,
    openSection,
    setOpenSection,
    overviewMeta,
  };
}
