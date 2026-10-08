import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import TrafficChart from '@/components/TrafficChart';
import type { TrafficHistoryPoint } from '@/hooks/useDashboardData';
import { parseTimestampMs } from '@/lib/date-time';

const RANGE_MS: Record<string, number> = {
  '1h': 60 * 60 * 1000,
  '6h': 6 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

interface TrafficTrendCardProps {
  timeRange: string;
  onTimeRangeChange: (range: string) => void;
  data: TrafficHistoryPoint[];
}

export default function TrafficTrendCard({
  timeRange,
  onTimeRangeChange,
  data,
}: TrafficTrendCardProps) {
  // 选中窗口远大于实际数据跨度时给出说明，避免大段空白被误认为故障。
  const first = parseTimestampMs(data[0]?.timestamp);
  const last = parseTimestampMs(data[data.length - 1]?.timestamp);
  const dataSpanMs = first !== null && last !== null ? Math.max(0, last - first) : 0;
  const requestedMs = RANGE_MS[timeRange] ?? 0;
  const insufficientHistory = data.length > 0 && requestedMs > 0 && dataSpanMs < requestedMs * 0.8;

  return (
    <Card className="card-hover py-4 sm:py-5">
      <CardHeader className="px-4 sm:px-6">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
          <div>
            <CardTitle className="text-base sm:text-lg">流量趋势</CardTitle>
            <p className="mt-1 hidden text-sm text-muted-foreground sm:block">
              历史段按采集增量计算平均速率，末尾实时段显示设备当前上下行速率。
            </p>
            {insufficientHistory ? (
              <p className="mt-1 text-xs text-warning">
                历史数据不足所选范围，已显示全部可用数据。
              </p>
            ) : null}
          </div>
          <div className="flex flex-wrap gap-2">
            {['1h', '6h', '24h', '7d', '30d'].map((range) => (
              <Button
                key={range}
                size="sm"
                variant={timeRange === range ? 'default' : 'outline'}
                className="rounded-full px-3"
                onClick={() => onTimeRangeChange(range)}
              >
                {range}
              </Button>
            ))}
          </div>
        </div>
      </CardHeader>
      <CardContent className="px-4 sm:px-6">
        <div className="h-44 sm:h-64 lg:h-80 xl:h-[360px]">
          <TrafficChart data={data} />
        </div>
      </CardContent>
    </Card>
  );
}
