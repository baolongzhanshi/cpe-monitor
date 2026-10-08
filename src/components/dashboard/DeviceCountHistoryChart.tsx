'use client';

import { useEffect, useMemo, useState } from 'react';
import { useTheme } from 'next-themes';
import { Line } from 'react-chartjs-2';
import { useThemeColor } from '@/hooks/useThemeColor';
import {
  CategoryScale,
  Chart as ChartJS,
  Filler,
  Legend,
  LinearScale,
  LineElement,
  PointElement,
  Tooltip,
} from 'chart.js';
import type { TrafficHistoryPoint } from '@/hooks/useDashboardData';
import { parseTimestampMs } from '@/lib/date-time';
import { formatTimeAxisLabel, getTimeAxisExtent } from '@/lib/chart-time-axis';

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Tooltip,
  Legend,
  Filler,
);

interface DeviceCountHistoryChartProps {
  data: TrafficHistoryPoint[];
}

function readCssColor(variableName: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback;
  return getComputedStyle(document.documentElement)
    .getPropertyValue(variableName)
    .trim() || fallback;
}

export default function DeviceCountHistoryChart({ data }: DeviceCountHistoryChartProps) {
  const { resolvedTheme } = useTheme();
  const { hue } = useThemeColor();
  const [colors, setColors] = useState(() => ({
    line: readCssColor('--chart-2', 'oklch(0.6 0.13 175)'),
    muted: readCssColor('--muted-foreground', 'oklch(0.5 0 0)'),
    border: readCssColor('--border', 'oklch(0.9 0 0)'),
    card: readCssColor('--card', 'oklch(1 0 0)'),
    foreground: readCssColor('--foreground', 'oklch(0.15 0 0)'),
  }));

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => setColors({
      line: readCssColor('--chart-2', 'oklch(0.6 0.13 175)'),
      muted: readCssColor('--muted-foreground', 'oklch(0.5 0 0)'),
      border: readCssColor('--border', 'oklch(0.9 0 0)'),
      card: readCssColor('--card', 'oklch(1 0 0)'),
      foreground: readCssColor('--foreground', 'oklch(0.15 0 0)'),
    }));
    return () => window.cancelAnimationFrame(frame);
  }, [resolvedTheme, hue]);

  // 数据实际时间范围：时间轴按真实时间摆放采样点，并按它收边。
  const extent = useMemo(() => getTimeAxisExtent(data), [data]);

  const chartData = useMemo(() => ({
    datasets: [{
      label: '在线设备',
      data: data.map((entry) => ({
        x: parseTimestampMs(entry.timestamp) ?? 0,
        y: entry.connectedDevices ?? null,
      })),
      borderColor: colors.line,
      backgroundColor: `color-mix(in oklch, ${colors.line} 16%, transparent)`,
      fill: true,
      stepped: true,
      pointRadius: 0,
      pointHoverRadius: 4,
      borderWidth: 2,
      spanGaps: false,
    }],
  }), [colors.line, data]);

  const options = useMemo(() => ({
    responsive: true,
    animation: false as const,
    maintainAspectRatio: false,
    interaction: {
      mode: 'index' as const,
      intersect: false,
    },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: colors.card,
        titleColor: colors.foreground,
        bodyColor: colors.foreground,
        borderColor: colors.border,
        borderWidth: 1,
        callbacks: {
          title: (items: { parsed: { x: number | null } }[]) => (
            items.length && items[0].parsed.x !== null
              ? formatTimeAxisLabel(items[0].parsed.x, extent.spanMs)
              : ''
          ),
          label: (context: { parsed: { y: number | null } }) => (
            `在线设备：${context.parsed.y ?? 0} 台`
          ),
        },
      },
    },
    scales: {
      x: {
        type: 'linear' as const,
        min: extent.min,
        max: extent.max,
        grid: {
          color: `color-mix(in oklch, ${colors.border} 65%, transparent)`,
        },
        ticks: {
          color: colors.muted,
          maxRotation: 0,
          autoSkip: true,
          maxTicksLimit: 7,
          callback: (value: string | number) => formatTimeAxisLabel(Number(value), extent.spanMs),
        },
      },
      y: {
        beginAtZero: true,
        suggestedMax: Math.max(5, ...data.map((entry) => entry.connectedDevices || 0)),
        grid: {
          color: `color-mix(in oklch, ${colors.border} 65%, transparent)`,
        },
        ticks: {
          color: colors.muted,
          precision: 0,
          stepSize: 1,
        },
        title: {
          display: true,
          text: '设备数量',
          color: colors.muted,
        },
      },
    },
  }), [colors, data, extent]);

  return <Line data={chartData} options={options} />;
}
