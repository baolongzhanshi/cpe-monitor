'use client';

import DashboardBody from '@/components/dashboard/DashboardBody';
import { LiveMetricsProvider } from '@/components/dashboard/live-metrics-context';

/**
 * 仪表盘入口。
 *
 * 实时数据由 LiveMetricsProvider 统一持有；页面本身不订阅秒级状态，
 * 因此外壳、静态区块与已创建的元素树不会随每次数据更新重新渲染，
 * 只有订阅了对应切片的叶子组件会更新。
 */
export default function DashboardPage() {
  return (
    <LiveMetricsProvider>
      <DashboardBody />
    </LiveMetricsProvider>
  );
}
