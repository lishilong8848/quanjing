import {
  Bar,
  BarChart,
  Cell,
  LabelList,
  Pie,
  PieChart,
  ResponsiveContainer,
  XAxis,
  YAxis,
} from 'recharts';

import type { BuildingUsage, ExpiryHeatmapRow, TopDeviceItem } from './model';

const MONTH_LABELS = [
  '1月',
  '2月',
  '3月',
  '4月',
  '5月',
  '6月',
  '7月',
  '8月',
  '9月',
  '10月',
  '11月',
  '12月',
] as const;

const HEATMAP_LEGEND_LEVELS = [1, 2, 3, 4, 5] as const;

export function MetricStatusLamp() {
  return (
    <span className="lifecycle-status-lamp" aria-hidden="true">
      <i className="lifecycle-status-lamp-halo" />
      <i className="lifecycle-status-lamp-core" />
    </span>
  );
}

function clampRate(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

export interface UsageRingSelection {
  building: string;
  status?: '未到期' | '待评估';
}

export function UsageRingGroup({
  data,
  onSelect,
}: {
  data: readonly BuildingUsage[];
  onSelect?: (selection: UsageRingSelection) => void;
}) {
  if (data.length === 0) {
    return <p className="lifecycle-chart-empty">暂无设备使用状态数据</p>;
  }

  return (
    <div
      className="lifecycle-usage-rings lifecycle-usage-ring-group"
      role="list"
      aria-label="各楼栋设备使用状态"
    >
      {data.map((item, index) => {
        const notExpiredRate = clampRate(item.notExpiredRate);
        const evaluationRate = clampRate(item.evaluationRate);
        const ringData = [
          { name: '未到期', value: notExpiredRate },
          { name: '需评估', value: evaluationRate },
        ];
        const gradientKey = `lifecycle-usage-${index}`;
        const trackGradientId = `${gradientKey}-track`;
        const blueGradientId = `${gradientKey}-blue`;
        const orangeGradientId = `${gradientKey}-orange`;

        return (
          <article
            key={item.building}
            className="lifecycle-usage-ring lifecycle-usage-ring-item"
            role="listitem"
          >
            <button
              type="button"
              className="lifecycle-usage-ring-trigger"
              aria-haspopup="dialog"
              aria-label={`查看${item.building}设备清单`}
              onClick={() => onSelect?.({ building: item.building })}
            >
              <div
                className="lifecycle-usage-ring-chart"
                role="img"
                aria-label={`${item.building}未到期率 ${notExpiredRate}%，需评估率 ${evaluationRate}%`}
              >
                <ResponsiveContainer
                  width="100%"
                  height="100%"
                  minWidth={0}
                  minHeight={70}
                >
                  <PieChart>
                    <defs>
                      <linearGradient
                        id={trackGradientId}
                        x1="0"
                        y1="0"
                        x2="1"
                        y2="1"
                      >
                        <stop
                          offset="0%"
                          stopColor="var(--lifecycle-surface-muted)"
                          stopOpacity={0.82}
                        />
                        <stop
                          offset="48%"
                          stopColor="var(--lifecycle-border)"
                          stopOpacity={0.62}
                        />
                        <stop
                          offset="100%"
                          stopColor="var(--lifecycle-divider)"
                          stopOpacity={0.38}
                        />
                      </linearGradient>
                      <linearGradient
                        id={blueGradientId}
                        x1="0"
                        y1="0"
                        x2="1"
                        y2="1"
                      >
                        <stop
                          offset="0%"
                          stopColor="var(--lifecycle-chart-green-start)"
                          stopOpacity={0.86}
                        />
                        <stop
                          offset="45%"
                          stopColor="var(--lifecycle-chart-green-end)"
                          stopOpacity={0.98}
                        />
                        <stop
                          offset="100%"
                          stopColor="var(--lifecycle-success)"
                          stopOpacity={0.96}
                        />
                      </linearGradient>
                      <linearGradient
                        id={orangeGradientId}
                        x1="0"
                        y1="0"
                        x2="1"
                        y2="1"
                      >
                        <stop
                          offset="0%"
                          stopColor="var(--lifecycle-chart-orange-start)"
                          stopOpacity={0.82}
                        />
                        <stop
                          offset="45%"
                          stopColor="var(--lifecycle-chart-orange-end)"
                          stopOpacity={0.96}
                        />
                        <stop
                          offset="100%"
                          stopColor="var(--lifecycle-warning)"
                          stopOpacity={0.98}
                        />
                      </linearGradient>
                    </defs>
                    <Pie
                      className="lifecycle-usage-ring-track"
                      data={[{ name: '底轨', value: 100 }]}
                      dataKey="value"
                      cx="50%"
                      cy="50%"
                      innerRadius="61%"
                      outerRadius="94%"
                      startAngle={90}
                      endAngle={-270}
                      stroke="none"
                      isAnimationActive={false}
                    >
                      <Cell fill={`url(#${trackGradientId})`} />
                    </Pie>
                    <Pie
                      className="lifecycle-usage-ring-value"
                      data={ringData}
                      dataKey="value"
                      nameKey="name"
                      cx="50%"
                      cy="50%"
                      innerRadius="66%"
                      outerRadius="89%"
                      startAngle={90}
                      endAngle={-270}
                      paddingAngle={2}
                      cornerRadius={6}
                      stroke="rgba(255, 255, 255, 0.72)"
                      strokeWidth={1}
                      isAnimationActive={false}
                    >
                      <Cell fill={`url(#${blueGradientId})`} />
                      <Cell fill={`url(#${orangeGradientId})`} />
                    </Pie>
                  </PieChart>
                </ResponsiveContainer>
                <span
                  className="lifecycle-usage-ring-center"
                  aria-hidden="true"
                >
                  <strong>{notExpiredRate}%</strong>
                  <span>{evaluationRate}%</span>
                </span>
              </div>
              <strong className="lifecycle-usage-building">
                {item.building}
              </strong>
            </button>
            <p className="lifecycle-usage-counts">
              <button
                type="button"
                aria-haspopup="dialog"
                onClick={() =>
                  onSelect?.({
                    building: item.building,
                    status: '未到期',
                  })
                }
              >
                <strong>{notExpiredRate}%</strong>
                <span className="lifecycle-usage-status-label">未到期</span>
                <small className="lifecycle-usage-status-count">
                  ({item.notExpired})
                </small>
              </button>
              <button
                type="button"
                aria-haspopup="dialog"
                onClick={() =>
                  onSelect?.({
                    building: item.building,
                    status: '待评估',
                  })
                }
              >
                <strong>{evaluationRate}%</strong>
                <span className="lifecycle-usage-status-label">需评估</span>
                <small className="lifecycle-usage-status-count">
                  ({item.evaluation})
                </small>
              </button>
            </p>
          </article>
        );
      })}
    </div>
  );
}

export interface GradientBarSeries<T extends object> {
  dataKey: keyof T & string;
  label: string;
  startColor: string;
  endColor: string;
}

interface GradientBarChartProps<T extends object> {
  data: readonly T[];
  series: readonly GradientBarSeries<T>[];
  gradientPrefix: string;
  ariaLabel: string;
  maxValue: number;
  onSelect?: (selection: { datum: T; series: GradientBarSeries<T> }) => void;
}

function normalizeGradientId(value: string): string {
  const normalized = value.replace(/[^a-zA-Z0-9_-]/g, '-');
  return normalized || 'lifecycle-gradient';
}

export function GradientBarChart<T extends object>({
  data,
  series,
  gradientPrefix,
  ariaLabel,
  maxValue,
  onSelect,
}: GradientBarChartProps<T>) {
  const safeMaxValue = Math.max(1, Number.isFinite(maxValue) ? maxValue : 1);
  const safeGradientPrefix = normalizeGradientId(gradientPrefix);
  const tickStep =
    safeMaxValue <= 6
      ? 2
      : safeMaxValue <= 15
        ? 5
        : safeMaxValue <= 40
          ? 10
          : 20;
  const yAxisTicks = Array.from(
    { length: Math.floor(safeMaxValue / tickStep) + 1 },
    (_, index) => index * tickStep,
  );
  if (yAxisTicks.at(-1) !== safeMaxValue) yAxisTicks.push(safeMaxValue);

  if (data.length === 0 || series.length === 0) {
    return (
      <div
        className="lifecycle-chart lifecycle-gradient-bar-chart lifecycle-chart-empty"
        role="img"
        aria-label={`${ariaLabel}，暂无数据`}
      >
        暂无图表数据
      </div>
    );
  }

  return (
    <div
      className="lifecycle-chart lifecycle-gradient-bar-chart"
      role="group"
      aria-label={ariaLabel}
    >
      <ResponsiveContainer
        width="100%"
        height="100%"
        minWidth={0}
        minHeight={140}
      >
        <BarChart
          data={[...data]}
          barCategoryGap="26%"
          barGap={4}
          margin={{ top: 24, right: 10, bottom: 0, left: 0 }}
        >
          <defs>
            {series.map((item, index) => (
              <linearGradient
                key={item.dataKey}
                id={`${safeGradientPrefix}-${index}`}
                x1="0"
                y1="0"
                x2="0"
                y2="1"
              >
                <stop offset="0%" stopColor={item.startColor} />
                <stop offset="100%" stopColor={item.endColor} />
              </linearGradient>
            ))}
          </defs>
          <XAxis
            dataKey="building"
            axisLine={{ stroke: '#dce6f3' }}
            tickLine={false}
            tick={{ fill: '#38527a', fontSize: 11, fontWeight: 600 }}
            interval={0}
          />
          <YAxis
            hide
            domain={[0, safeMaxValue]}
            allowDecimals={false}
            axisLine={false}
            tickLine={false}
            tick={{ fill: '#526987', fontSize: 11 }}
            ticks={yAxisTicks}
            width={0}
          />
          {series.map((item, index) => (
            <Bar
              key={item.dataKey}
              dataKey={item.dataKey}
              name={item.label}
              fill={`url(#${safeGradientPrefix}-${index})`}
              radius={[5, 5, 0, 0]}
              maxBarSize={30}
              isAnimationActive={false}
              className={onSelect ? 'lifecycle-clickable-bar' : undefined}
              onClick={(entry: { payload?: T }, dataIndex: number) => {
                const datum = entry.payload || data[dataIndex];
                if (datum) onSelect?.({ datum, series: item });
              }}
            >
              <LabelList
                dataKey={item.dataKey}
                position="top"
                fill="#172d53"
                fontSize={11}
                fontWeight={700}
              />
            </Bar>
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function getHeatmapLevel(value: number, maximum: number): number {
  if (!Number.isFinite(value) || value <= 0 || maximum <= 0) return 0;
  return Math.min(5, Math.max(1, Math.ceil((value / maximum) * 5)));
}

export interface ExpiryHeatmapSelection {
  building: string;
  monthIndex: number;
  monthLabel: string;
  value: number;
}

export function ExpiryHeatmap({
  data,
  onSelect,
}: {
  data: readonly ExpiryHeatmapRow[];
  onSelect?: (selection: ExpiryHeatmapSelection) => void;
}) {
  if (data.length === 0) {
    return <p className="lifecycle-chart-empty">暂无设备到期数据</p>;
  }

  const maximum = Math.max(
    0,
    ...data.flatMap((row) =>
      row.values.map((value) => (Number.isFinite(value) ? value : 0)),
    ),
  );

  return (
    <figure
      className="lifecycle-heatmap lifecycle-expiry-heatmap"
      role="group"
      aria-label="各楼栋设备到期月份热力图"
    >
      <div
        className="lifecycle-heatmap-grid"
        role="grid"
        aria-label="楼栋与月份设备到期热度"
        aria-rowcount={data.length + 1}
        aria-colcount={MONTH_LABELS.length + 1}
      >
        <span
          className="lifecycle-heatmap-building"
          role="columnheader"
          aria-label="楼栋"
          aria-rowindex={1}
          aria-colindex={1}
        />
        {MONTH_LABELS.map((month, monthIndex) => (
          <span
            key={month}
            className="lifecycle-heatmap-month"
            role="columnheader"
            aria-rowindex={1}
            aria-colindex={monthIndex + 2}
          >
            {month}
          </span>
        ))}
        {data.map((row, rowIndex) => [
          <strong
            key={`${row.building}-label`}
            className="lifecycle-heatmap-building"
            role="rowheader"
            aria-rowindex={rowIndex + 2}
            aria-colindex={1}
          >
            {row.building}
          </strong>,
          ...MONTH_LABELS.map((month, monthIndex) => {
            const rawValue = row.values[monthIndex] ?? 0;
            const value = Number.isFinite(rawValue) ? rawValue : 0;
            const level = getHeatmapLevel(value, maximum);
            const label = `${row.building}${month}设备到期热度 ${value}`;

            return (
              <button
                key={`${row.building}-${month}`}
                type="button"
                className={`lifecycle-heatmap-cell lifecycle-heatmap-level-${level}`}
                role="gridcell"
                aria-haspopup="dialog"
                aria-label={label}
                aria-rowindex={rowIndex + 2}
                aria-colindex={monthIndex + 2}
                title={label}
                data-level={level}
                data-value={value}
                onClick={() =>
                  onSelect?.({
                    building: row.building,
                    monthIndex,
                    monthLabel: month,
                    value,
                  })
                }
              />
            );
          }),
        ])}
      </div>
      <figcaption className="lifecycle-heatmap-legend">
        <span>少</span>
        <span className="lifecycle-heatmap-legend-levels" aria-hidden="true">
          {HEATMAP_LEGEND_LEVELS.map((level) => (
            <i
              key={level}
              className={`lifecycle-heatmap-legend-cell lifecycle-heatmap-level-${level}`}
            />
          ))}
        </span>
        <span>多</span>
      </figcaption>
    </figure>
  );
}

export function TopDevicesList({
  data,
  onSelect,
}: {
  data: readonly TopDeviceItem[];
  onSelect?: (item: TopDeviceItem) => void;
}) {
  if (data.length === 0) {
    return <p className="lifecycle-chart-empty">暂无设备数量排行数据</p>;
  }

  return (
    <ol
      className="lifecycle-top-list lifecycle-top-devices-list"
      aria-label="设备数量 TOP5"
    >
      {data.slice(0, 5).map((item, index) => (
        <li key={item.id} className="lifecycle-top-device-item">
          <button
            type="button"
            className="lifecycle-top-device-trigger"
            aria-haspopup="dialog"
            aria-label={`查看${item.name}设备清单，共${item.count}条`}
            onClick={() => onSelect?.(item)}
          >
            <span
              className={`lifecycle-top-rank lifecycle-top-device-rank lifecycle-top-device-rank-${index + 1}`}
              aria-label={`第 ${index + 1} 名`}
            >
              {index + 1}
            </span>
            <span className="lifecycle-top-device-name">{item.name}</span>
            <strong className="lifecycle-top-device-count">{item.count}</strong>
          </button>
        </li>
      ))}
    </ol>
  );
}
