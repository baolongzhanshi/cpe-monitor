import { parseTimestampMs } from '@/lib/date-time';

export interface TimeAxisExtent {
  /** 数据实际跨越的时间长度，用于选择刻度格式。 */
  spanMs: number;
  /** 数据实际起点；只有一个采样点或时间无效时不设置，交给图表自动处理。 */
  min?: number;
  /** 数据实际终点；只有一个采样点或时间无效时不设置。 */
  max?: number;
}

/**
 * 取数据实际覆盖的时间范围。
 *
 * 横轴按它收边：之前横轴用的是请求窗口的起止，最后一个采样点之后
 * 会留下几个小时的空白，短跨度看起来尤其浪费。
 */
export function getTimeAxisExtent(data: Array<{ timestamp: string }>): TimeAxisExtent {
  const first = parseTimestampMs(data[0]?.timestamp);
  const last = parseTimestampMs(data[data.length - 1]?.timestamp);
  if (first === null || last === null || last <= first) return { spanMs: 0 };
  return { spanMs: last - first, min: first, max: last };
}

/**
 * 时间轴刻度与提示标题的统一格式化。
 *
 * 三个趋势图都用线性时间轴（而不是类目轴），刻度文本需要按跨度自适应：
 * 超过一天带月日，一周内精确到分钟，很短跨度精确到秒；统一使用应用时区。
 */
export function formatTimeAxisLabel(timestampMs: number, spanMs: number): string {
  const date = new Date(timestampMs);
  if (!Number.isFinite(timestampMs) || Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('zh-CN', {
    month: spanMs > 24 * 60 * 60 * 1000 ? '2-digit' : undefined,
    day: spanMs > 24 * 60 * 60 * 1000 ? '2-digit' : undefined,
    hour: '2-digit',
    minute: spanMs <= 7 * 24 * 60 * 60 * 1000 ? '2-digit' : undefined,
    second: spanMs < 5 * 60 * 1000 ? '2-digit' : undefined,
    timeZone: 'Asia/Shanghai',
  });
}
