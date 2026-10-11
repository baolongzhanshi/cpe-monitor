import { getAppDateKey } from './date-time.ts';

export interface TrafficRange {
  start: Date;
  end: Date;
}

const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function isValidDateKey(value: string | null): value is string {
  if (!value || !DATE_KEY_PATTERN.test(value)) return false;
  const date = new Date(`${value}T00:00:00+08:00`);
  return !Number.isNaN(date.getTime()) && getAppDateKey(date) === value;
}

export function resolveTrafficRange(
  range: string,
  now: Date,
  startParam: string | null,
  endParam: string | null,
): TrafficRange | null {
  if (range === 'custom') {
    if (!isValidDateKey(startParam) || !isValidDateKey(endParam)) return null;
    const start = new Date(`${startParam}T00:00:00+08:00`);
    const end = new Date(`${endParam}T23:59:59.999+08:00`);
    return start.getTime() <= end.getTime() ? { start, end } : null;
  }

  const duration = range === '1h' ? 60 * 60 * 1000
    : range === '6h' ? 6 * 60 * 60 * 1000
      : range === '7d' ? 7 * 24 * 60 * 60 * 1000
        : range === '30d' ? 30 * 24 * 60 * 60 * 1000
          : 24 * 60 * 60 * 1000;
  return { start: new Date(now.getTime() - duration), end: now };
}
