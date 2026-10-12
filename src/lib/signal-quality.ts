/**
 * 信号强度分级的唯一来源。
 *
 * 此前仪表盘徽章、设备页射频卡、采集报告弹窗和采集报告邮件各写了一套阈值
 * （-70/-85/-100、-80/-90/-100、-80/-95/-105），同一个 RSRP 在不同界面会得出相反结论。
 * 这里收敛成一套，各处只负责显示。
 */

export type SignalQualityVariant = 'success' | 'info' | 'warning' | 'danger';

export interface SignalQuality {
  label: string;
  variant: SignalQualityVariant;
}

/** RSRP 分档（dBm），数值越接近 0 越好。 */
export const RSRP_QUALITY_THRESHOLDS: [number, number, number] = [-70, -85, -100];

const LEVELS: Array<{ min: number } & SignalQuality> = [
  { min: RSRP_QUALITY_THRESHOLDS[0], label: '优秀', variant: 'success' },
  { min: RSRP_QUALITY_THRESHOLDS[1], label: '良好', variant: 'info' },
  { min: RSRP_QUALITY_THRESHOLDS[2], label: '一般', variant: 'warning' },
];

/** 0 表示设备没有上报，返回 null 由调用方决定怎么显示。 */
export function getSignalQuality(strength: number): SignalQuality | null {
  if (strength === 0) return null;
  for (const level of LEVELS) {
    if (strength >= level.min) return { label: level.label, variant: level.variant };
  }
  return { label: '较差', variant: 'danger' };
}
