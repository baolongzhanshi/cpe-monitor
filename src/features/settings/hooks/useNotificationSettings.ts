'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiFetch } from '@/lib/client-api';
import type {
  EmailConfigForm,
  NotificationApiRow,
  PublicEmailApiConfig,
  PublicPushplusApiConfig,
  PublicWechatApiConfig,
  PushplusConfigForm,
  SettingsActionContext,
  WechatConfigForm,
} from '../types';

const DEFAULT_EMAIL: EmailConfigForm = {
  smtpHost: '', smtpPort: '587', smtpUser: '', smtpPass: '', from: '', to: '',
};

export function useNotificationSettings(context: SettingsActionContext) {
  const [emailConfig, setEmailConfig] = useState<EmailConfigForm>(DEFAULT_EMAIL);
  const [wechatConfig, setWechatConfig] = useState<WechatConfigForm>({ webhookUrl: '' });
  const [pushplusConfig, setPushplusConfig] = useState<PushplusConfigForm>({ token: '' });
  const [emailPasswordSet, setEmailPasswordSet] = useState(false);
  const [wechatWebhookSet, setWechatWebhookSet] = useState(false);
  const [pushplusTokenSet, setPushplusTokenSet] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);
  const [savingEmail, setSavingEmail] = useState(false);
  const [savingWechat, setSavingWechat] = useState(false);
  const [savingPushplus, setSavingPushplus] = useState(false);
  const [testingPushplus, setTestingPushplus] = useState(false);

  const fetchConfigs = useCallback(async () => {
    try {
      const rows = await apiFetch<NotificationApiRow[]>('/api/settings/notification', undefined, '获取通知配置失败');
      for (const row of rows) {
        if (row.type === 'email') {
          const parsed = JSON.parse(row.config) as PublicEmailApiConfig;
          setEmailConfig({
            smtpHost: parsed.smtpHost || '',
            smtpPort: String(parsed.smtpPort || 587),
            smtpUser: parsed.smtpUser || '',
            smtpPass: '',
            from: parsed.from || '',
            to: Array.isArray(parsed.to) ? parsed.to.join('\n') : parsed.to || '',
          });
          setEmailPasswordSet(Boolean(parsed.smtpPasswordSet));
        } else if (row.type === 'wechat') {
          const parsed = JSON.parse(row.config) as PublicWechatApiConfig;
          setWechatConfig({ webhookUrl: parsed.webhookUrl || '' });
          setWechatWebhookSet(Boolean(parsed.webhookConfigured));
        } else if (row.type === 'pushplus') {
          const parsed = JSON.parse(row.config) as PublicPushplusApiConfig;
          setPushplusTokenSet(Boolean(parsed.tokenConfigured));
        }
      }
    } catch (error) {
      console.error('Failed to fetch notification configs:', error);
    } finally {
      setInitialLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => { void fetchConfigs(); }, 0);
    return () => window.clearTimeout(timer);
  }, [fetchConfigs]);

  const saveEmailConfig = useCallback(async () => {
    setSavingEmail(true);
    try {
      await apiFetch('/api/settings/notification', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'email', config: emailConfig, enabled: true }),
      }, '保存失败');
      if (emailConfig.smtpPass.trim()) setEmailPasswordSet(true);
      setEmailConfig((current) => ({ ...current, smtpPass: '' }));
      context.onMessage({ type: 'success', text: '邮件配置已保存' });
      context.onSaved();
    } catch (error) {
      context.onMessage({ type: 'error', text: error instanceof Error ? error.message : '保存失败' });
    } finally {
      setSavingEmail(false);
    }
  }, [context, emailConfig]);

  const saveWechatConfig = useCallback(async () => {
    setSavingWechat(true);
    try {
      await apiFetch('/api/settings/notification', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'wechat', config: wechatConfig, enabled: true }),
      }, '保存失败');
      if (wechatConfig.webhookUrl.trim()) setWechatWebhookSet(true);
      setWechatConfig({ webhookUrl: '' });
      context.onMessage({ type: 'success', text: '企业微信配置已保存' });
      context.onSaved();
    } catch (error) {
      context.onMessage({ type: 'error', text: error instanceof Error ? error.message : '保存失败' });
    } finally {
      setSavingWechat(false);
    }
  }, [context, wechatConfig]);

  const savePushplusConfig = useCallback(async () => {
    setSavingPushplus(true);
    try {
      await apiFetch('/api/settings/notification', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'pushplus', config: pushplusConfig, enabled: true }),
      }, '保存失败');
      if (pushplusConfig.token.trim()) setPushplusTokenSet(true);
      setPushplusConfig({ token: '' });
      context.onMessage({ type: 'success', text: 'PushPlus 配置已保存' });
      context.onSaved();
    } catch (error) {
      context.onMessage({ type: 'error', text: error instanceof Error ? error.message : '保存失败' });
    } finally {
      setSavingPushplus(false);
    }
  }, [context, pushplusConfig]);

  const testPushplus = useCallback(async () => {
    setTestingPushplus(true);
    try {
      const result = await apiFetch<{ success: boolean; message: string }>('/api/settings/notification/pushplus/test', {
        method: 'POST',
      }, 'PushPlus 测试失败');
      context.onMessage({ type: result.success ? 'success' : 'error', text: result.message });
    } catch (error) {
      context.onMessage({ type: 'error', text: error instanceof Error ? error.message : 'PushPlus 测试失败' });
    } finally {
      setTestingPushplus(false);
    }
  }, [context]);

  const emailConfigured = Boolean(emailConfig.smtpHost && emailConfig.to);
  const wechatConfigured = wechatWebhookSet || Boolean(wechatConfig.webhookUrl);
  const pushplusConfigured = pushplusTokenSet || Boolean(pushplusConfig.token);
  const recipientCount = useMemo(() => (
    emailConfig.to
      ? emailConfig.to.split(/[\n,;]+/).map((item) => item.trim()).filter(Boolean).length
      : 0
  ), [emailConfig.to]);

  return {
    emailConfig, setEmailConfig, wechatConfig, setWechatConfig,
    pushplusConfig, setPushplusConfig,
    emailPasswordSet, wechatWebhookSet, pushplusTokenSet,
    emailConfigured, wechatConfigured, pushplusConfigured, recipientCount,
    initialLoading, savingEmail, savingWechat, savingPushplus, testingPushplus,
    saveEmailConfig, saveWechatConfig, savePushplusConfig, testPushplus,
  };
}
