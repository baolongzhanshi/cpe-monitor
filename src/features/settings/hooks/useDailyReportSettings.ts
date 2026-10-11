'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '@/lib/client-api';
import type {
  DailyReportPushApiConfig,
  DailyReportPushForm,
  SettingsActionContext,
} from '../types';

const DEFAULT_DAILY_REPORT_PUSH: DailyReportPushForm = {
  enabled: true,
  time: '22:00',
};

export function useDailyReportSettings(context: SettingsActionContext) {
  const [dailyReportPush, setDailyReportPush] = useState<DailyReportPushForm>(
    DEFAULT_DAILY_REPORT_PUSH,
  );
  const [savingDailyReportPush, setSavingDailyReportPush] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);

  const fetchConfig = useCallback(async () => {
    try {
      const config = await apiFetch<DailyReportPushApiConfig>(
        '/api/settings/daily-report',
        undefined,
        '获取日报推送配置失败',
      );
      setDailyReportPush({
        enabled: config.enabled !== false,
        time: config.time || DEFAULT_DAILY_REPORT_PUSH.time,
      });
    } catch (error) {
      console.error('Failed to fetch daily report push config:', error);
    } finally {
      setInitialLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => { void fetchConfig(); }, 0);
    return () => window.clearTimeout(timer);
  }, [fetchConfig]);

  const saveDailyReportPush = useCallback(async () => {
    setSavingDailyReportPush(true);
    try {
      await apiFetch('/api/settings/daily-report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(dailyReportPush),
      }, '保存失败');
      context.onMessage({ type: 'success', text: '日报推送设置已保存' });
      context.onSaved();
    } catch (error) {
      context.onMessage({
        type: 'error',
        text: error instanceof Error ? error.message : '保存失败',
      });
    } finally {
      setSavingDailyReportPush(false);
    }
  }, [context, dailyReportPush]);

  return {
    dailyReportPush,
    setDailyReportPush,
    savingDailyReportPush,
    initialLoading,
    saveDailyReportPush,
  };
}
