import { useId, type ReactNode } from 'react';
import { ArrowUpRight, Inbox } from 'lucide-react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  LabelList,
  Line,
  LineChart,
  Pie,
  PieChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useChartDetails } from './ChartDetails';

export const CHART_COLORS = [
  'var(--mo-blue)',
  'var(--mo-teal)',
  'var(--mo-sky)',
  'var(--mo-amber)',
  'var(--mo-violet)',
  'var(--mo-muted)',
];
export type ChartRow = Record<string, string | number | null>;
export function Panel({
  title,
  eyebrow,
  action,
  onAction,
  children,
  className = '',
}: {
  title: string;
  eyebrow?: string;
  action?: string;
  onAction?: () => void;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Card className={`mo-panel ${className}`}>
      <div className="mo-panel-heading">
        <div>
          {eyebrow && <span className="mo-eyebrow">{eyebrow}</span>}
          <h2>{title}</h2>
        </div>
        {onAction && (
          <Button
            variant="ghost"
            size="sm"
            className="mo-text-button"
            onClick={onAction}
            aria-label={`${action ?? '查看明细'}：${title}`}
          >
            {action ?? '查看明细'}
            <ArrowUpRight aria-hidden="true" />
          </Button>
        )}
      </div>
      {children}
    </Card>
  );
}
export function EmptyState({
  title = '暂无匹配记录',
  description = '试试其他楼栋或筛选条件',
  onReset,
}: {
  title?: string;
  description?: string;
  onReset?: () => void;
}) {
  return (
    <div className="mo-empty" role="status">
      <Inbox aria-hidden="true" />
      <strong>{title}</strong>
      <span>{description}</span>
      {onReset && (
        <Button variant="outline" size="sm" onClick={onReset}>
          重置筛选
        </Button>
      )}
    </div>
  );
}
const axis = {
  stroke: 'var(--mo-muted)',
  fontSize: 11,
  tickLine: false,
  axisLine: false,
};
const tooltip = {
  background: 'var(--mo-tooltip-surface)',
  border: '1px solid var(--mo-border)',
  borderRadius: 'var(--mo-radius)',
  fontSize: 12,
  color: 'var(--mo-ink)',
};

export function TrendChart({
  rows,
  series,
  unit = '',
  target,
  area = true,
  dateAxis = true,
  onSelect,
}: {
  rows: ChartRow[];
  series: { key: string; name: string; color?: string }[];
  unit?: string;
  target?: number;
  area?: boolean;
  dateAxis?: boolean;
  onSelect?: (name: string) => void;
}) {
  const id = useId().replace(/:/g, '');
  const detail = useChartDetails(
    rows,
    series,
    unit,
    series.map((s) => s.name).join('、'),
  );
  const select = (name: string) =>
    onSelect ? onSelect(name) : detail.open(name);
  if (!rows.length)
    return (
      <EmptyState
        title="暂无资源演示数据"
        description="可切换至 A–E 楼查看容量与能耗"
      />
    );
  const common = [
    <CartesianGrid
      key="grid"
      stroke="var(--mo-grid)"
      strokeDasharray="3 5"
      vertical={false}
    />,
    <XAxis
      key="x-axis"
      dataKey="name"
      {...axis}
      minTickGap={24}
      tickFormatter={(value: string) =>
        dateAxis
          ? value.length === 7
            ? value.replace('-', '/')
            : value.slice(5).replace('-', '/')
          : value
      }
      dy={8}
    />,
    <YAxis
      key="y-axis"
      {...axis}
      width={46}
      domain={unit === 'PUE' ? ['auto', 'auto'] : [0, 'auto']}
      tickFormatter={(value: number) =>
        value >= 10000
          ? `${(value / 10000).toFixed(0)}万`
          : value.toLocaleString('zh-CN', {
              maximumFractionDigits: unit === 'PUE' ? 3 : 2,
            })
      }
    />,
    <Tooltip
      key="tooltip"
      active={detail.isOpen ? false : undefined}
      wrapperStyle={{ zIndex: 20 }}
      contentStyle={tooltip}
      formatter={(value: number, name: string) => [
        `${value.toLocaleString('zh-CN', { maximumFractionDigits: unit === 'PUE' || unit === 'WUE' ? 3 : 1 })}${unit === 'PUE' || unit === 'WUE' ? '' : ` ${unit}`}`,
        name,
      ]}
    />,
    series.length > 1 && (
      <Legend
        key="legend"
        iconType="circle"
        iconSize={7}
        wrapperStyle={{ fontSize: 11, paddingTop: 14 }}
      />
    ),
    target !== undefined && (
      <ReferenceLine
        key="reference"
        y={target}
        stroke="var(--mo-amber)"
        strokeDasharray="5 5"
        label={{
          value: `参考线 ${target}`,
          position: 'insideTopRight',
          fill: 'var(--mo-amber)',
          fontSize: 11,
        }}
      />
    ),
  ];
  return (
    <div
      className="mo-chart"
      role="group"
      aria-label={
        series.map((item) => item.name).join('、') +
        '趋势图，可通过查看明细读取数值'
      }
    >
      {detail.button}
      {detail.dialog}
      <ResponsiveContainer width="100%" height="100%">
        {area ? (
          <AreaChart
            data={rows}
            onClick={(state) => {
              const row = rows[Number(state.activeTooltipIndex)];
              if (row) select(String(row.name));
            }}
            margin={{ top: 18, right: 14, left: 0, bottom: 8 }}
          >
            <defs>
              {series.map((item, index) => (
                <linearGradient
                  id={`${id}-${index}`}
                  key={item.key}
                  x1="0"
                  y1="0"
                  x2="0"
                  y2="1"
                >
                  <stop
                    offset="0%"
                    stopColor={item.color ?? CHART_COLORS[index]}
                    stopOpacity={0.2}
                  />
                  <stop
                    offset="100%"
                    stopColor={item.color ?? CHART_COLORS[index]}
                    stopOpacity={0.01}
                  />
                </linearGradient>
              ))}
            </defs>
            {common}
            {series.map((item, index) => (
              <Area
                key={item.key}
                type="monotone"
                dataKey={item.key}
                name={item.name}
                stroke={item.color ?? CHART_COLORS[index]}
                fill={`url(#${id}-${index})`}
                strokeWidth={2.5}
                isAnimationActive={false}
                activeDot={{ r: 5, strokeWidth: 3 }}
              />
            ))}
          </AreaChart>
        ) : (
          <LineChart
            data={rows}
            onClick={(state) => {
              const row = rows[Number(state.activeTooltipIndex)];
              if (row) select(String(row.name));
            }}
            margin={{ top: 18, right: 14, left: 0, bottom: 8 }}
          >
            {common}
            {series.map((item, index) => (
              <Line
                key={item.key}
                type="monotone"
                dataKey={item.key}
                name={item.name}
                stroke={item.color ?? CHART_COLORS[index]}
                strokeWidth={2.5}
                dot={false}
                isAnimationActive={false}
              />
            ))}
          </LineChart>
        )}
      </ResponsiveContainer>
    </div>
  );
}
export function ColumnChart({
  rows,
  series,
  onSelect,
  unit = '',
}: {
  rows: ChartRow[];
  series: { key: string; name: string; color?: string }[];
  onSelect?: (name: string, series?: string) => void;
  unit?: string;
}) {
  const id = useId().replace(/:/g, '');
  const detail = useChartDetails(
    rows,
    series,
    unit,
    series.map((s) => s.name).join('、'),
  );
  if (!rows.length) return <EmptyState />;
  const label = (value: unknown) =>
    typeof value === 'number' && Number.isFinite(value)
      ? value.toLocaleString('zh-CN', { maximumFractionDigits: 2 }) +
        (unit.trim() === '%' ? '%' : '')
      : '';
  const labelWidth = Math.max(
    24,
    ...rows.flatMap((row) =>
      series.map((item) => label(row[item.key]).length * 7 + 10),
    ),
  );
  const categoryWidth = Math.max(
    series.length * labelWidth + 14,
    ...rows.map((row) => String(row.name).length * 8 + 14),
  );
  return (
    <div className="mo-column-scroll">
      {detail.button}
      {detail.dialog}
      <div
        className="mo-chart mo-column-chart"
        style={{ minWidth: rows.length * categoryWidth + 64 }}
        role="group"
        aria-label={`${series.map((item) => item.name).join('、')}对比图，可通过查看明细读取数值`}
      >
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={rows}
            margin={{ top: 28, right: 16, bottom: 8, left: 0 }}
            barGap={5}
          >
            <defs>
              {series.map((item, index) => (
                <linearGradient
                  key={item.key}
                  id={`${id}-bar-${index}`}
                  x1="0"
                  y1="0"
                  x2="0"
                  y2="1"
                >
                  <stop
                    offset="0%"
                    stopColor={item.color ?? CHART_COLORS[index]}
                    stopOpacity={0.96}
                  />
                  <stop
                    offset="100%"
                    stopColor={item.color ?? CHART_COLORS[index]}
                    stopOpacity={0.48}
                  />
                </linearGradient>
              ))}
            </defs>
            <CartesianGrid
              stroke="var(--mo-grid)"
              strokeDasharray="3 5"
              vertical={false}
            />
            <XAxis dataKey="name" {...axis} dy={5} />
            <YAxis
              {...axis}
              hide
              width={0}
              allowDecimals={!!unit && unit !== '项'}
            />
            <Tooltip
              active={detail.isOpen ? false : undefined}
              wrapperStyle={{ zIndex: 20 }}
              contentStyle={tooltip}
              cursor={{ fill: 'var(--mo-soft)' }}
              formatter={(value: number, name: string) => [
                `${value.toLocaleString('zh-CN', { maximumFractionDigits: 2 })}${unit}`,
                name,
              ]}
            />
            <Legend
              iconType="circle"
              iconSize={7}
              wrapperStyle={{ fontSize: 11, paddingTop: 12 }}
            />
            {series.map((item, index) => (
              <Bar
                key={item.key}
                dataKey={item.key}
                name={item.name}
                fill={`url(#${id}-bar-${index})`}
                radius={[4, 4, 0, 0]}
                maxBarSize={26}
                isAnimationActive={false}
                onClick={(entry: ChartRow) =>
                  onSelect
                    ? onSelect(String(entry.name), item.key)
                    : detail.open(String(entry.name))
                }
                cursor="pointer"
              >
                <LabelList
                  dataKey={item.key}
                  position="top"
                  offset={8}
                  formatter={label}
                  fill={
                    item.color === 'var(--mo-light-blue)'
                      ? 'var(--mo-muted)'
                      : (item.color ?? CHART_COLORS[index])
                  }
                  fontSize={11}
                  fontWeight={600}
                />
              </Bar>
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
export function Distribution({
  rows,
  label,
  onSelect,
}: {
  rows: { name: string; value: number; color?: string }[];
  label: string;
  onSelect?: (name: string) => void;
}) {
  const id = useId().replace(/:/g, '');
  const detail = useChartDetails(
    rows,
    [{ key: 'value', name: label }],
    '',
    label,
  );
  const select = (name: string) =>
    onSelect ? onSelect(name) : detail.open(name);
  const total = rows.reduce((sum, row) => sum + row.value, 0);
  if (!total) return <EmptyState />;
  return (
    <div className="mo-distribution">
      {detail.dialog}
      <div
        className="mo-donut"
        role="group"
        aria-label={`${label}分布，总计${total}`}
      >
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <defs>
              {rows.map((row, index) => (
                <linearGradient
                  key={row.name}
                  id={`${id}-ring-${index}`}
                  x1="0"
                  y1="0"
                  x2="1"
                  y2="1"
                >
                  <stop
                    offset="0%"
                    stopColor={
                      row.color ?? CHART_COLORS[index % CHART_COLORS.length]
                    }
                    stopOpacity={0.95}
                  />
                  <stop
                    offset="100%"
                    stopColor={
                      row.color ?? CHART_COLORS[index % CHART_COLORS.length]
                    }
                    stopOpacity={0.62}
                  />
                </linearGradient>
              ))}
            </defs>
            <Pie
              data={rows}
              dataKey="value"
              nameKey="name"
              innerRadius="72%"
              outerRadius="94%"
              paddingAngle={3}
              cornerRadius={4}
              stroke="none"
              isAnimationActive={false}
              onClick={(entry: { name: string }) => select(entry.name)}
              cursor="pointer"
            >
              {rows.map((row, index) => (
                <Cell key={row.name} fill={`url(#${id}-ring-${index})`} />
              ))}
            </Pie>
            <Tooltip
              active={detail.isOpen ? false : undefined}
              contentStyle={tooltip}
              wrapperStyle={{ zIndex: 20 }}
            />
          </PieChart>
        </ResponsiveContainer>
        <div className="mo-donut-center">
          <strong>{total.toLocaleString()}</strong>
          <span>{label}</span>
        </div>
      </div>
      <div className="mo-legend-list">
        {rows.map((row, index) => (
          <button
            key={row.name}
            type="button"
            onClick={() => select(row.name)}
            aria-label={`${row.name} ${row.value} 条，查看明细`}
          >
            <i
              style={{
                background:
                  row.color ?? CHART_COLORS[index % CHART_COLORS.length],
              }}
            />
            <span>{row.name}</span>
            <strong>{row.value}</strong>
            <small>{((row.value / total) * 100).toFixed(0)}%</small>
          </button>
        ))}
      </div>
    </div>
  );
}
