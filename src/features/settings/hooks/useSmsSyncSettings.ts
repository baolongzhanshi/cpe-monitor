'use client';

import { useSyncSettings } from './useSyncSettings';
import { SMS_SYNC_INTERVAL, SMS_SYNC_INTERVAL_ERROR } from '@/lib/sync-interval';
import type { SettingsActionContext, SmsSyncConfigForm } from '../types';

export function useSmsSyncSettings(context: SettingsActionContext) {
  const { config, setConfig, initialLoading, saving, stateLabel, save } = useSyncSettings({
    endpoint: '/api/dashboard/sms/settings',
    defaultInterval: SMS_SYNC_INTERVAL.defaultInterval,
    min: SMS_SYNC_INTERVAL.minInterval,
    max: SMS_SYNC_INTERVAL.maxInterval,
    allowFractionalInterval: true,
    intervalValidationMessage: SMS_SYNC_INTERVAL_ERROR,
    label: '短信自动同步',
    context,
  });

  return {
    smsSyncConfig: config as SmsSyncConfigForm,
    setSmsSyncConfig: setConfig,
    initialLoading,
    savingSmsSync: saving,
    smsState: stateLabel,
    saveSmsSyncConfig: save,
  };
}
