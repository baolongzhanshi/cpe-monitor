export const DAILY_REPORT_PUSH_ENABLED_KEY = 'daily_report_push_enabled';
export const DAILY_REPORT_PUSH_TIME_KEY = 'daily_report_push_time';
export const DEFAULT_DAILY_REPORT_PUSH_ENABLED = true;
export const DEFAULT_DAILY_REPORT_PUSH_TIME = '22:00';

export interface DailyReportPushSettings {
  enabled: boolean;
  time: string;
}

export function normalizeDailyReportTime(value: unknown): string | null {
  const text = typeof value === 'string' ? value.trim() : '';
  const match = text.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return null;
  }
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

export function resolveDailyReportPushSettings(
  settings: Record<string, string>,
): DailyReportPushSettings {
  return {
    enabled: settings[DAILY_REPORT_PUSH_ENABLED_KEY] !== 'false',
    time: normalizeDailyReportTime(settings[DAILY_REPORT_PUSH_TIME_KEY])
      ?? DEFAULT_DAILY_REPORT_PUSH_TIME,
  };
}
