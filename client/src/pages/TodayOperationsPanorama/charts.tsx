import {
  Bar,
  BarChart,
  ComposedChart,
  LabelList,
  Legend,
  Line,
  PolarAngleAxis,
  RadialBar,
  RadialBarChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import type {
  TodayOperationsAlarmBuildingPoint,
  TodayOperationsAlarmExpectation,
} from '@shared/today-operations-alarm.interface';

import {
  PANORAMA_RACK_SUMMARY,
  type RackBuildingLoad,
  type RackBuildingUsage,
} from './data';
import {
  formatAlarmBarLabel,
  resolveAlarmChartSelection,
  type AlarmChartPeriod,
  type AlarmChartSelection,
} from './alarm-chart-model';

type AlarmTrendPoint = Pick<
  TodayOperationsAlarmBuildingPoint,
  'building' | 'expected' | 'unexpected' | 'unclassified'
>;

const CHART_TEXT_COLOR = 'hsl(220 52% 28%)';
const CHART_GRID_COLOR = 'hsl(214 48% 91%)';
const BLUE = 'hsl(217 91% 58%)';
const ORANGE = 'hsl(28 94% 52%)';
const MUTED_BLUE = 'hsl(214 24% 66%)';

function formatInteger(value: unknown): string {
  const number = Number(value);
  return Number.isFinite(number) ? number.toLocaleString('zh-CN') : '0';
}

function getAxisMaximum(data: readonly AlarmTrendPoint[]): number {
  const maximum = Math.max(
    1,
    ...data.flatMap((item) => [
      item.expected,
      item.unexpected,
      item.unclassified,
    ]),
  );
  const magnitude = 10 ** Math.max(0, Math.floor(Math.log10(maximum)) - 1);
  return Math.ceil((maximum * 1.18) / magnitude) * magnitude;
}

export function RackUsageGauge({
  value = PANORAMA_RACK_SUMMARY.usageRate,
}: {
  value?: number;
}) {
  const normalizedValue = Number.isFinite(value)
    ? Math.min(100, Math.max(0, value))
    : 0;
  const chartData = [
    { name: '机柜使用率', value: normalizedValue, fill: BLUE },
  ];

  return (
    <span
      className="today-panorama-rack-gauge-visual"
      role="img"
      aria-label={`机柜使用率 ${Math.round(normalizedValue)}%`}
      style={{
        display: 'block',
        position: 'relative',
        width: '100%',
        height: '100%',
        minHeight: 112,
      }}
    >
      <ResponsiveContainer
        width="100%"
        height="100%"
        minWidth={0}
        minHeight={112}
      >
        <RadialBarChart
          data={chartData}
          cx="50%"
          cy="83%"
          innerRadius={58}
          outerRadius={74}
          barSize={14}
          startAngle={180}
          endAngle={0}
        >
          <PolarAngleAxis
            type="number"
            domain={[0, 100]}
            dataKey="value"
            tick={false}
          />
          <RadialBar
            dataKey="value"
            background={{ fill: 'hsl(214 42% 92%)' }}
            cornerRadius={9}
            isAnimationActive={false}
          />
        </RadialBarChart>
      </ResponsiveContainer>
      <span className="today-panorama-rack-gauge-value" aria-hidden="true">
        <strong>{Math.round(normalizedValue)}%</strong>
        <small>机柜使用率</small>
      </span>
    </span>
  );
}

export function RackLoadChart({
  data = PANORAMA_RACK_SUMMARY.buildingLoads,
}: {
  data?: readonly RackBuildingLoad[];
}) {
  const chartData = [...data];
  const summary = chartData
    .map((item) => `${item.building} ${item.value.toFixed(1)}%`)
    .join('，');

  return (
    <div
      role="img"
      aria-label={`各楼IT负载率：${summary}`}
      style={{ width: '100%', height: '100%', minHeight: 148 }}
    >
      <ResponsiveContainer
        width="100%"
        height="100%"
        minWidth={0}
        minHeight={148}
      >
        <ComposedChart
          data={chartData}
          margin={{ top: 26, right: 10, bottom: 4, left: 10 }}
          barCategoryGap="42%"
        >
          <XAxis
            dataKey="building"
            axisLine={false}
            tickLine={false}
            tick={{ fill: CHART_TEXT_COLOR, fontSize: 12, fontWeight: 600 }}
            tickMargin={10}
            interval={0}
          />
          <YAxis hide domain={[0, 100]} width={0} />
          <Bar
            dataKey="value"
            fill="hsl(214 94% 72%)"
            radius={[5, 5, 0, 0]}
            maxBarSize={48}
            isAnimationActive={false}
          />
          <Line
            type="monotone"
            dataKey="value"
            stroke={ORANGE}
            strokeWidth={2}
            strokeDasharray="5 4"
            dot={{ r: 3.5, fill: ORANGE, stroke: 'white', strokeWidth: 1.5 }}
            activeDot={{ r: 5 }}
            isAnimationActive={false}
          >
            <LabelList
              dataKey="value"
              position="top"
              offset={10}
              fill={ORANGE}
              fontSize={12}
              fontWeight={700}
              formatter={(label) => `${Number(label).toFixed(1)}%`}
            />
          </Line>
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

export function RackUsageDetailChart({
  data,
}: {
  data: readonly RackBuildingUsage[];
}) {
  const chartData = [...data];
  const countMaximum = Math.ceil(
    Math.max(1, ...chartData.flatMap((item) => [item.total, item.online])) *
      1.16,
  );
  const maximumUsageRate = Math.max(
    100,
    ...chartData.map((item) => item.usageRate),
  );
  const rateMaximum = Math.ceil((maximumUsageRate * 11) / 100) * 10;
  const summary = chartData
    .map(
      (item) =>
        `${item.building}：设计机柜 ${item.total.toLocaleString('zh-CN')}，` +
        `已上架机柜 ${item.online.toLocaleString('zh-CN')}，` +
        `机柜上架率 ${item.usageRate.toFixed(1)}%`,
    )
    .join('；');

  return (
    <div
      role="img"
      aria-label={`各楼机柜上架率：${summary}`}
      style={{ width: '100%', height: '100%', minHeight: 280 }}
    >
      <ResponsiveContainer
        width="100%"
        height="100%"
        minWidth={0}
        minHeight={280}
      >
        <ComposedChart
          data={chartData}
          margin={{ top: 28, right: 20, bottom: 8, left: 4 }}
          barCategoryGap="28%"
        >
          <XAxis
            dataKey="building"
            axisLine={false}
            tickLine={false}
            tick={{ fill: CHART_TEXT_COLOR, fontSize: 12, fontWeight: 650 }}
            tickMargin={10}
            interval={0}
          />
          <YAxis
            yAxisId="count"
            domain={[0, countMaximum]}
            axisLine={false}
            tickLine={false}
            tick={{ fill: CHART_TEXT_COLOR, fontSize: 11 }}
            width={44}
            allowDecimals={false}
          />
          <YAxis
            yAxisId="rate"
            orientation="right"
            domain={[0, rateMaximum]}
            axisLine={false}
            tickLine={false}
            tickFormatter={(value) => `${formatInteger(value)}%`}
            tick={{ fill: ORANGE, fontSize: 11 }}
            width={44}
          />
          <Tooltip
            formatter={(value, name) => [
              name === '机柜上架率'
                ? `${Number(value).toFixed(1)}%`
                : formatInteger(value),
              name,
            ]}
            labelFormatter={(label) => `${String(label)}`}
          />
          <Legend verticalAlign="top" align="center" height={32} />
          <Bar
            dataKey="total"
            yAxisId="count"
            name="设计机柜"
            fill="hsl(214 94% 82%)"
            radius={[5, 5, 0, 0]}
            maxBarSize={34}
            isAnimationActive={false}
          >
            <LabelList
              className="today-panorama-rack-count-label"
              dataKey="total"
              position="top"
              offset={7}
              fill={CHART_TEXT_COLOR}
              fontSize={11}
              fontWeight={700}
              formatter={formatInteger}
            />
          </Bar>
          <Bar
            dataKey="online"
            yAxisId="count"
            name="已上架机柜"
            fill={BLUE}
            radius={[5, 5, 0, 0]}
            maxBarSize={34}
            isAnimationActive={false}
          >
            <LabelList
              className="today-panorama-rack-count-label"
              dataKey="online"
              position="top"
              offset={7}
              fill={BLUE}
              fontSize={11}
              fontWeight={700}
              formatter={formatInteger}
            />
          </Bar>
          <Line
            dataKey="usageRate"
            yAxisId="rate"
            name="机柜上架率"
            type="monotone"
            stroke={ORANGE}
            strokeWidth={2.5}
            dot={{ r: 4, fill: ORANGE, stroke: 'white', strokeWidth: 1.5 }}
            activeDot={{ r: 5.5 }}
            isAnimationActive={false}
          >
            <LabelList
              className="today-panorama-rack-rate-label"
              dataKey="usageRate"
              position="top"
              offset={10}
              fill={ORANGE}
              fontSize={11}
              fontWeight={700}
              formatter={(label) => `${Number(label).toFixed(1)}%`}
            />
          </Line>
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

function AlarmBarChart({
  data,
  ariaLabel,
  period,
  onSelect,
}: {
  data: readonly AlarmTrendPoint[];
  ariaLabel: string;
  period: AlarmChartPeriod;
  onSelect?: (selection: AlarmChartSelection) => void;
}) {
  const chartData = [...data];
  const axisMaximum = getAxisMaximum(data);
  const handleBarClick =
    (expectation: TodayOperationsAlarmExpectation) => (entry: unknown) => {
      const candidate = entry as
        | (Partial<AlarmTrendPoint> & { payload?: AlarmTrendPoint })
        | null;
      const point =
        candidate?.payload ??
        (candidate?.building ? (candidate as AlarmTrendPoint) : null);
      if (!point) return;
      const selection = resolveAlarmChartSelection(period, point, expectation);
      if (selection) onSelect?.(selection);
    };
  const summary = chartData
    .map(
      (item) =>
        `${item.building}预期内${formatInteger(item.expected)}条、预期外${formatInteger(item.unexpected)}条、未分类${formatInteger(item.unclassified)}条`,
    )
    .join('；');

  return (
    <div
      role="img"
      aria-label={`${ariaLabel}：${summary}`}
      style={{ width: '100%', height: '100%', minHeight: 224 }}
    >
      <ResponsiveContainer
        width="100%"
        height="100%"
        minWidth={0}
        minHeight={224}
      >
        <BarChart
          data={chartData}
          margin={{ top: 28, right: 10, bottom: 4, left: 10 }}
          barCategoryGap="26%"
          barGap={4}
        >
          <XAxis
            dataKey="building"
            axisLine={false}
            tickLine={false}
            tick={{ fill: CHART_TEXT_COLOR, fontSize: 12, fontWeight: 600 }}
            tickMargin={11}
            interval={0}
          />
          <YAxis
            hide
            domain={[0, axisMaximum]}
            width={0}
            allowDecimals={false}
          />
          <Tooltip
            cursor={{ fill: 'hsl(214 90% 96% / 0.6)' }}
            contentStyle={{
              border: `1px solid ${CHART_GRID_COLOR}`,
              borderRadius: 8,
              boxShadow: '0 8px 24px hsl(217 50% 25% / 0.1)',
              color: CHART_TEXT_COLOR,
              fontSize: 12,
            }}
            formatter={(value, name) => {
              const label =
                name === 'expected'
                  ? '预期内'
                  : name === 'unexpected'
                    ? '预期外'
                    : '未分类';
              return [`${formatInteger(value)} 条`, label];
            }}
          />
          <Bar
            dataKey="expected"
            name="expected"
            fill={BLUE}
            radius={[4, 4, 0, 0]}
            maxBarSize={38}
            cursor={onSelect ? 'pointer' : 'default'}
            onClick={onSelect ? handleBarClick('expected') : undefined}
            isAnimationActive={false}
          >
            <LabelList
              dataKey="expected"
              position="top"
              offset={7}
              fill={BLUE}
              fontSize={11}
              fontWeight={700}
              formatter={formatAlarmBarLabel}
            />
          </Bar>
          <Bar
            dataKey="unexpected"
            name="unexpected"
            fill={ORANGE}
            radius={[4, 4, 0, 0]}
            maxBarSize={38}
            cursor={onSelect ? 'pointer' : 'default'}
            onClick={onSelect ? handleBarClick('unexpected') : undefined}
            isAnimationActive={false}
          >
            <LabelList
              dataKey="unexpected"
              position="top"
              offset={7}
              fill={ORANGE}
              fontSize={11}
              fontWeight={700}
              formatter={formatAlarmBarLabel}
            />
          </Bar>
          <Bar
            dataKey="unclassified"
            name="unclassified"
            fill={MUTED_BLUE}
            radius={[4, 4, 0, 0]}
            maxBarSize={30}
            cursor={onSelect ? 'pointer' : 'default'}
            onClick={onSelect ? handleBarClick('unclassified') : undefined}
            isAnimationActive={false}
          >
            <LabelList
              dataKey="unclassified"
              position="top"
              offset={7}
              fill={MUTED_BLUE}
              fontSize={11}
              fontWeight={700}
              formatter={formatAlarmBarLabel}
            />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export function SevenDayAlarmChart({
  data,
  onSelect,
}: {
  data: readonly AlarmTrendPoint[];
  onSelect?: (selection: AlarmChartSelection) => void;
}) {
  return (
    <AlarmBarChart
      data={data}
      ariaLabel="近7天各楼预期内、预期外和未分类告警"
      period="sevenDay"
      onSelect={onSelect}
    />
  );
}

export function YesterdayAlarmChart({
  data,
  onSelect,
}: {
  data: readonly AlarmTrendPoint[];
  onSelect?: (selection: AlarmChartSelection) => void;
}) {
  return (
    <AlarmBarChart
      data={data}
      ariaLabel="昨日各楼预期内、预期外和未分类告警"
      period="yesterday"
      onSelect={onSelect}
    />
  );
}
