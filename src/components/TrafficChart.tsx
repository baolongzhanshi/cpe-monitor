'use client';

import { useCallback, useMemo, useState } from 'react';
import { Line } from 'react-chartjs-2';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
  Filler,
} from 'chart.js';
import zoomPlugin from 'chartjs-plugin-zoom';
import 'hammerjs';
import { parseTimestampMs } from '@/lib/date-time';
import {
  useChartTheme,
  buildTooltipOptions,
  buildLegendOptions,
  CHART_DEFAULTS,
} from '@/lib/chart-theme';
import { formatTimeAxisLabel, getTimeAxisExtent } from '@/lib/chart-time-axis';

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
  Filler,
  zoomPlugin,
);

const DOWNLOAD_FILL_ALPHA = 18;
const UPLOAD_FILL_ALPHA = 14;

interface TrafficData {
  timestamp: string;
  uploadBytes?: number | null;
  downloadBytes?: number | null;
  uploadBps?: number | null;
  downloadBps?: number | null;
  networkType?: string | null;
  band?: string | null;
  connectedDevices?: number | null;
}

interface TrafficChartProps {
  data: TrafficData[];
}

export function TrafficChart({ data }: TrafficChartProps) {
  const themeColors = useChartTheme();

  const toMegabitsPerSecond = (bitsPerSecond: number | null | undefined) =>
    Number(((bitsPerSecond || 0) / 1_000_000).toFixed(3));

  // 数据实际时间范围：既决定刻度格式，也用来收掉横轴两侧的空白。
  const extent = useMemo(() => getTimeAxisExtent(data), [data]);

  // 用户是否手动缩放或平移过。只置真、不再复位：手动调整后横轴归用户控制，
  // 直到组件重新挂载（例如离开页面再回来）。回调若因插件版本差异没触发，
  // userAdjusted 始终为假，行为与改动前完全一致。
  const [userAdjusted, setUserAdjusted] = useState(false);
  const markUserAdjusted = useCallback(() => setUserAdjusted(true), []);

  const chartData = useMemo(
    () => {
      // 用 {x, y} 时间点而不是类目下标：历史采样间隔并不相等，
      // 按序号等距摆放会把 5 分钟和 60 分钟的间隔画成一样宽，时间轴不会。
      const points = (pick: (entry: TrafficData) => number | null | undefined) =>
        data.map((entry) => ({
          x: parseTimestampMs(entry.timestamp) ?? 0,
          y: toMegabitsPerSecond(pick(entry)),
        }));

      return ({
      datasets: [
        {
          label: '下载',
          data: points((entry) => entry.downloadBps),
          borderColor: themeColors.primary,
          backgroundColor: `color-mix(in oklch, ${themeColors.primary} ${DOWNLOAD_FILL_ALPHA}%, transparent)`,
          fill: true,
          tension: CHART_DEFAULTS.tension,
          pointRadius: 0,
          pointHoverRadius: CHART_DEFAULTS.pointHoverRadius,
          borderWidth: CHART_DEFAULTS.lineWidth,
        },
        {
          label: '上传',
          data: points((entry) => entry.uploadBps),
          borderColor: themeColors.secondary,
          backgroundColor: `color-mix(in oklch, ${themeColors.secondary} ${UPLOAD_FILL_ALPHA}%, transparent)`,
          fill: true,
          tension: CHART_DEFAULTS.tension,
          pointRadius: 0,
          pointHoverRadius: CHART_DEFAULTS.pointHoverRadius,
          borderWidth: CHART_DEFAULTS.lineWidth,
        },
      ],
      });
    },
    [data, themeColors],
  );

  const options = useMemo(
    () => ({
      responsive: true,
      animation: false as const,
      maintainAspectRatio: false,
      interaction: {
        mode: 'index' as const,
        intersect: false,
      },
      plugins: {
        legend: {
          position: 'top' as const,
          ...buildLegendOptions(themeColors),
        },
        tooltip: {
          ...buildTooltipOptions(themeColors),
          callbacks: {
            title: (items: { parsed: { x: number | null } }[]) => (
              items.length && items[0].parsed.x !== null ? formatTimeAxisLabel(items[0].parsed.x, extent.spanMs) : ''
            ),
            label: (context: { dataset: { label?: string }; parsed: { y: number | null } }) => {
              return `${context.dataset.label || ''}: ${context.parsed.y ?? 0} Mbps`;
            },
            afterBody: (items: { dataIndex: number }[]) => {
              if (!items.length) return [];
              const idx = items[0].dataIndex;
              const point = data[idx];
              if (!point) return [];
              const lines: string[] = [];
              if (point.networkType) lines.push(`网络制式: ${point.networkType}`);
              if (point.band) lines.push(`频段: ${point.band}`);
              if (point.connectedDevices != null) lines.push(`在线设备: ${point.connectedDevices}`);
              return lines;
            },
          },
        },
        zoom: {
          pan: {
            enabled: true,
            mode: 'x' as const,
            onPanComplete: markUserAdjusted,
          },
          zoom: {
            drag: {
              enabled: true,
              backgroundColor: `color-mix(in oklch, ${themeColors.primary} 15%, transparent)`,
            },
            mode: 'x' as const,
            onZoomComplete: markUserAdjusted,
          },
        },
      },
      scales: {
        x: {
          type: 'linear' as const,
          // 用户缩放或平移之后就不再写 min/max。
          // react-chartjs-2 更新 options 时是整体替换 scales，而 zoom 插件正是靠改写
          // scale.options.min/max 记住缩放状态的——数据每秒追加一个点就会把缩放顶回去，
          // 结果是想细看某一段时间几乎做不到。插件的双击还原会自己恢复原范围，不受影响。
          ...(userAdjusted ? {} : { min: extent.min, max: extent.max }),
          grid: {
            color: `color-mix(in oklch, ${themeColors.border} 70%, transparent)`,
          },
          ticks: {
            color: themeColors.muted,
            maxRotation: 0,
            callback: (value: string | number) => formatTimeAxisLabel(Number(value), extent.spanMs),
          },
        },
        y: {
          beginAtZero: true,
          grid: {
            color: `color-mix(in oklch, ${themeColors.border} 70%, transparent)`,
          },
          ticks: { color: themeColors.muted },
          title: {
            display: true,
            text: '平均速率 (Mbps)',
            color: themeColors.muted,
          },
        },
      },
    }),
    [themeColors, data, extent, userAdjusted, markUserAdjusted],
  );

  return <Line data={chartData} options={options} />;
}

export default TrafficChart;
