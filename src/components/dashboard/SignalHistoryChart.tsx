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

interface SignalHistoryChartProps {
  data: TrafficHistoryPoint[];
}

interface ThemeColors {
  rsrp: string;
  rsrq: string;
  sinr: string;
  rssi: string;
  muted: string;
  border: string;
  card: string;
  foreground: string;
}

interface TooltipContext {
  dataset: { label?: string };
  parsed: { y: number | null };
}

function readCssColor(variableName: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback;
  return getComputedStyle(document.documentElement)
    .getPropertyValue(variableName)
    .trim() || fallback;
}

function readThemeColors(): ThemeColors {
  return {
    rsrp: readCssColor('--chart-1', 'oklch(0.6 0.15 201)'),
    rsrq: readCssColor('--chart-2', 'oklch(0.6 0.13 175)'),
    sinr: readCssColor('--chart-3', 'oklch(0.68 0.15 75)'),
    rssi: readCssColor('--chart-4', 'oklch(0.62 0.17 305)'),
    muted: readCssColor('--muted-foreground', 'oklch(0.5 0 0)'),
    border: readCssColor('--border', 'oklch(0.9 0 0)'),
    card: readCssColor('--card', 'oklch(1 0 0)'),
    foreground: readCssColor('--foreground', 'oklch(0.15 0 0)'),
  };
}

export default function SignalHistoryChart({ data }: SignalHistoryChartProps) {
  const { resolvedTheme } = useTheme();
  const { hue } = useThemeColor();
  const [colors, setColors] = useState<ThemeColors>(() => readThemeColors());
  const [visible, setVisible] = useState({ rsrp: true, rsrq: true, sinr: true, rssi: false });

  const toggleMetric = (key: keyof typeof visible) => {
    setVisible((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => setColors(readThemeColors()));
    return () => window.cancelAnimationFrame(frame);
  }, [resolvedTheme, hue]);

  // 数据实际时间范围：时间轴按真实时间摆放采样点，并按它收边。
  const extent = useMemo(() => getTimeAxisExtent(data), [data]);

  const chartData = useMemo(() => {
    const points = (pick: (entry: TrafficHistoryPoint) => number | null | undefined) =>
      data.map((entry) => ({ x: parseTimestampMs(entry.timestamp) ?? 0, y: pick(entry) ?? null }));
    return {
      datasets: [
        ...(visible.rsrp ? [{
          label: 'RSRP',
          data: points((entry) => entry.rsrp),
          borderColor: colors.rsrp,
          backgroundColor: `color-mix(in oklch, ${colors.rsrp} 10%, transparent)`,
          yAxisID: 'dbm',
          pointRadius: 0,
          pointHoverRadius: 4,
          borderWidth: 2,
          tension: 0.25,
          spanGaps: false,
        }] : []),
        ...(visible.rssi ? [{
          label: 'RSSI',
          data: points((entry) => entry.rssi),
          borderColor: colors.rssi,
          backgroundColor: `color-mix(in oklch, ${colors.rssi} 10%, transparent)`,
          yAxisID: 'dbm',
          pointRadius: 0,
          pointHoverRadius: 4,
          borderWidth: 1.5,
          tension: 0.25,
          spanGaps: false,
        }] : []),
        ...(visible.rsrq ? [{
          label: 'RSRQ',
          data: points((entry) => entry.rsrq),
          borderColor: colors.rsrq,
          backgroundColor: `color-mix(in oklch, ${colors.rsrq} 10%, transparent)`,
          yAxisID: 'db',
          pointRadius: 0,
          pointHoverRadius: 4,
          borderWidth: 1.5,
          tension: 0.25,
          spanGaps: false,
        }] : []),
        ...(visible.sinr ? [{
          label: 'SINR',
          data: points((entry) => entry.sinr),
          borderColor: colors.sinr,
          backgroundColor: `color-mix(in oklch, ${colors.sinr} 10%, transparent)`,
          yAxisID: 'db',
          pointRadius: 0,
          pointHoverRadius: 4,
          borderWidth: 2,
          tension: 0.25,
          spanGaps: false,
        }] : []),
      ],
    };
  }, [colors, data, visible]);

  const options = useMemo(() => ({
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
        labels: {
          color: colors.muted,
          usePointStyle: true,
          pointStyle: 'circle' as const,
          boxWidth: 8,
          padding: 14,
        },
      },
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
          label: (context: TooltipContext) => {
            const unit = context.dataset.label === 'RSRP' || context.dataset.label === 'RSSI'
              ? 'dBm'
              : 'dB';
            return `${context.dataset.label || ''}: ${context.parsed.y ?? '-'} ${unit}`;
          },
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
          maxTicksLimit: 8,
          callback: (value: string | number) => formatTimeAxisLabel(Number(value), extent.spanMs),
        },
      },
      dbm: {
        type: 'linear' as const,
        position: 'left' as const,
        suggestedMin: -130,
        suggestedMax: -40,
        grid: {
          color: `color-mix(in oklch, ${colors.border} 65%, transparent)`,
        },
        ticks: { color: colors.muted },
        title: {
          display: true,
          text: 'RSRP / RSSI (dBm)',
          color: colors.muted,
        },
      },
      db: {
        type: 'linear' as const,
        position: 'right' as const,
        suggestedMin: -30,
        suggestedMax: 40,
        grid: { drawOnChartArea: false },
        ticks: { color: colors.muted },
        title: {
          display: true,
          text: 'RSRQ / SINR (dB)',
          color: colors.muted,
        },
      },
    },
  }), [colors, extent]);

  return (
    <div className="flex h-full flex-col gap-2">
      <div className="flex flex-wrap gap-1.5">
        {([
          { key: 'rsrp' as const, label: 'RSRP', color: colors.rsrp },
          { key: 'rsrq' as const, label: 'RSRQ', color: colors.rsrq },
          { key: 'sinr' as const, label: 'SINR', color: colors.sinr },
          { key: 'rssi' as const, label: 'RSSI', color: colors.rssi },
        ]).map((m) => (
          <button
            key={m.key}
            type="button"
            onClick={() => toggleMetric(m.key)}
            className={`rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-colors ${
              visible[m.key]
                ? 'border-transparent text-white'
                : 'border-border text-muted-foreground opacity-50'
            }`}
            style={visible[m.key] ? { backgroundColor: m.color } : undefined}
          >
            {m.label}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1">
        <Line data={chartData} options={options} />
      </div>
    </div>
  );
}
