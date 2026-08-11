// TDSF 服务器实时监控 —— 迷你折线图（纯 SVG，零依赖）
// -----------------------------------------------------------------------------
// 用 SVG path 绘制轻量折线趋势图，适合实时数据流。
// 不引入 recharts/chart.js 等重型库，保持 Tauri 应用包体积最小。

import { useMemo } from 'react';

interface MiniSparklineProps {
  /** 数据点（数值数组，自动归一化到图表高度） */
  data: number[];
  /** 图表宽度（px） */
  width?: number;
  /** 图表高度（px） */
  height?: number;
  /** 线条颜色（CSS color，默认主题色） */
  color?: string;
  /** 是否填充区域 */
  fill?: boolean;
  /** 填充透明度 */
  fillOpacity?: number;
  /** 线宽 */
  strokeWidth?: number;
}

export function MiniSparkline({
  data,
  width = 120,
  height = 32,
  color = 'currentColor',
  fill = true,
  fillOpacity = 0.12,
  strokeWidth = 1.5,
}: MiniSparklineProps) {
  const { linePath, areaPath } = useMemo(() => {
    if (data.length < 2) {
      return { linePath: '', areaPath: '' };
    }

    const max = Math.max(...data, 0.01);
    const min = Math.min(...data, 0);
    const range = max - min || 1;
    const stepX = width / (data.length - 1);

    const points = data.map((value, i) => {
      const x = i * stepX;
      // y 反转（SVG 原点在左上）：值越大 y 越小
      const y = height - ((value - min) / range) * height;
      return { x, y };
    });

    // 折线 path
    const line = points
      .map((p, i) => (i === 0 ? `M ${p.x.toFixed(1)} ${p.y.toFixed(1)}` : `L ${p.x.toFixed(1)} ${p.y.toFixed(1)}`))
      .join(' ');

    // 填充区域 path（折线 + 底部闭合）
    const area = `${line} L ${width.toFixed(1)} ${height} L 0 ${height} Z`;

    return { linePath: line, areaPath: area };
  }, [data, width, height]);

  if (data.length < 2) {
    return (
      <svg width={width} height={height} className="opacity-30">
        <line
          x1="0"
          y1={height / 2}
          x2={width}
          y2={height / 2}
          stroke={color}
          strokeWidth={strokeWidth}
          strokeDasharray="2 3"
        />
      </svg>
    );
  }

  return (
    <svg width={width} height={height} className="overflow-visible">
      {fill && <path d={areaPath} fill={color} fillOpacity={fillOpacity} />}
      <path
        d={linePath}
        fill="none"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}
