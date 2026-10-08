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
