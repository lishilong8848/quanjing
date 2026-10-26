import {
  useEffect,
  useId,
  useMemo,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';
import {
  Activity,
  Building2,
  LayoutGrid,
  LineChart as LineChartIcon,
  RefreshCw,
  Server,
} from 'lucide-react';
import {
  CartesianGrid,
  Area,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { MonthlyEnergyBuilding } from '@shared/monthly-operations-resources.interface';
import { ColumnChart, EmptyState, Panel } from './charts';
import { useChartDetails } from './ChartDetails';
import { numberFormat, type BuildingFilter } from './model';
import type { ReportPeriod } from './period';
import { useResourceData } from './resource-data';
import { useSourceStamp } from './SourceStamp';
import { PueSummary } from './PueSummary';
import {
  BUILDING_COLORS,
  ENERGY_BUILDINGS,
  RESOURCE_METRICS,
  defaultResourceTrendWindow,
  energyBuilding,
  rackLoadRows,
  rackSummary,
  resourceTrend,
  isWaterMetric,
  pueComparisonAxes,
  pueAnnualComparison,
  pueBaselineReferences,
  pueWithWetBulb,
  resourceSource,
  resourceValue,
  type ResourceMetric,
  type ResourceTrendRow,
} from './resource-model';

export function ResourceStatus({
  source,
}: {
  source: 'racks' | 'energy' | 'weather' | 'water' | 'load';
}) {
  const { data, status, error, retry } = useResourceData();
  const state = data?.[source];
  useSourceStamp('resources', state?.syncedAt);
  const message =
    status === 'error'
      ? error
      : status === 'loading'
        ? data
          ? '正在更新…'
          : '正在读取数据…'
        : (state?.message ??
          (state?.status === 'empty' ? '所选范围暂无数据' : null));
  return (
    <div className="mo-live-status" role="status">
      <span
        className={
          status === 'error' ||
          state?.status === 'error' ||
          state?.status === 'stale'
            ? 'is-error'
            : ''
        }
      >
        {message ?? ''}
      </span>
      <Button
        variant="ghost"
        size="sm"
        onClick={retry}
        disabled={status === 'loading'}
        aria-label="刷新实际数据"
      >
        <RefreshCw className={status === 'loading' ? 'mo-spin' : ''} />
        {status === 'loading' ? '读取中' : '刷新'}
      </Button>
    </div>
  );
}
export function MetricPicker({
  value,
  onChange,
  water = false,
}: {
  water?: boolean;
  value: ResourceMetric;
  onChange: (value: ResourceMetric) => void;
}) {
  return (
    <div className="mo-metric-picker">
      <div className="mo-metric-choices" role="group" aria-label="趋势指标">
        {Object.entries(RESOURCE_METRICS)
          .filter(([key]) => isWaterMetric(key as ResourceMetric) === water)
          .map(([key, option]) => (
            <Button
              key={key}
              variant="ghost"
              aria-pressed={value === key}
              onClick={() => onChange(key as ResourceMetric)}
            >
              {option.label}
            </Button>
          ))}
      </div>
      <Select
        value={value}
        onValueChange={(value) => onChange(value as ResourceMetric)}
      >
        <SelectTrigger
          aria-label="选择趋势指标"
          className="mo-live-metric-picker"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {Object.entries(RESOURCE_METRICS)
            .filter(([key]) => isWaterMetric(key as ResourceMetric) === water)
            .map(([key, option]) => (
              <SelectItem key={key} value={key}>
                {option.label}
              </SelectItem>
            ))}
        </SelectContent>
      </Select>
    </div>
  );
}
function chartNumber(value: number, metric: ResourceMetric) {
  return RESOURCE_METRICS[metric].unit === 'kWh' && Math.abs(value) >= 10000
    ? `${numberFormat(value / 10000, 1)}万`
    : numberFormat(value, RESOURCE_METRICS[metric].precision);
}
export function EnergyLines({
  rows,
  buildings,
  metric,
  small = false,
  wetBulbRows,
  presentation = 'standard',
}: {
  rows: ResourceTrendRow[];
  buildings: MonthlyEnergyBuilding[];
  metric: ResourceMetric;
  small?: boolean;
  wetBulbRows?: ResourceTrendRow[];
  presentation?: 'standard' | 'overview';
}) {
  const gradientId = useId().replace(/:/g, '');
  const option = RESOURCE_METRICS[metric];
  const overview = presentation === 'overview';
  const areaBuilding = overview
    ? buildings.includes('园区')
      ? '园区'
      : buildings[0]
    : buildings.length === 1
      ? buildings[0]
      : null;
  const chartRows = useMemo(
    () =>
      wetBulbRows && metric === 'pue' && buildings.length === 1
        ? pueWithWetBulb(rows, wetBulbRows, buildings[0])
        : rows,
    [rows, wetBulbRows, metric, buildings],
  );
  const showWetBulb = chartRows.some((row) => typeof row.wetBulb === 'number');
  const axes =
    metric === 'pue' && buildings.length > 1
      ? pueComparisonAxes(rows, buildings)
      : { primary: buildings, secondary: null };
  const baselines = metric === 'pue' ? pueBaselineReferences(buildings) : [];
  const detail = useChartDetails(
    chartRows,
    [
      ...buildings.map((name) => ({
        key: name,
        name: showWetBulb ? `${name}（PUE）` : name,
      })),
      ...(showWetBulb ? [{ key: 'wetBulb', name: '室外湿球温度（℃）' }] : []),
    ],
    showWetBulb ? '' : option.unit,
    option.label,
  );
  const domainFor = (
    names: string[],
    axisMetric: ResourceMetric = metric,
    referenceValues: number[] = [],
  ) => {
    const values = rows.flatMap((row) =>
      names
        .map((building) => row[building])
        .filter(
          (value): value is number =>
            typeof value === 'number' && Number.isFinite(value),
        ),
    );
    values.push(...referenceValues);
    if (!values.length) return null;
    const min = Math.min(...values),
      max = Math.max(...values);
    const padding = Math.max(
      (max - min) * 0.18,
      axisMetric === 'pue' ? 0.012 : axisMetric === 'wetBulb' ? 1 : max * 0.03,
    );
    return axisMetric === 'pue' ||
      axisMetric === 'wue' ||
      axisMetric === 'wetBulb'
      ? ([
          Math.floor((min - padding) * 100) / 100,
          Math.ceil((max + padding) * 100) / 100,
        ] as [number, number])
      : ([0, 'auto'] as [number, string]);
  };
  const values = rows.flatMap((row) =>
    buildings.flatMap((name) =>
      typeof row[name] === 'number' && Number.isFinite(row[name])
        ? [row[name] as number]
        : [],
    ),
  );
  if (!values.length)
    return <div className="mo-live-chart-empty">此范围暂无有效数据</div>;
  const primaryDomain =
    domainFor(
      axes.primary,
      metric,
      baselines.map((baseline) => baseline.value),
    ) ?? domainFor(buildings)!;
  const secondaryDomain = axes.secondary ? domainFor([axes.secondary]) : null;
  const temperatures = chartRows.flatMap((row) =>
    typeof row.wetBulb === 'number' ? [row.wetBulb] : [],
  ) as number[];
  const weatherDomain: [number, number] | null = temperatures.length
    ? [
        Math.floor(Math.min(...temperatures) - 1),
        Math.ceil(Math.max(...temperatures) + 1),
      ]
    : null;
  return (
    <div
      className={`mo-live-line-chart${small ? ' is-small' : ''}${overview ? ' is-overview' : ''}`}
      role="group"
      aria-label={`${buildings.join('、')}${option.label}趋势，${rows[0]?.name} 至 ${rows.at(-1)?.name}${baselines.length ? `；年度基线${baselines.map((baseline) => baseline.value.toFixed(3)).join('、')}` : ''}${showWetBulb ? '；淡灰虚线为室外湿球温度，右轴摄氏度' : ''}${axes.secondary ? '；E楼使用右侧独立 PUE 轴' : ''}`}
    >
      {axes.secondary && (
        <div className="mo-chart-axis-note">
          左轴：其余楼栋 PUE　右轴：E楼 PUE
        </div>
      )}
      {detail.button}
      {detail.dialog}
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart
          data={chartRows}
          onClick={(state) => {
            const row = chartRows[Number(state.activeTooltipIndex)];
            if (row) detail.open(String(row.name));
          }}
          margin={{
            top: axes.secondary ? 34 : 12,
            right: 14,
            bottom: 4,
            left: 0,
          }}
        >
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop
                offset="0%"
                stopColor={BUILDING_COLORS[areaBuilding ?? buildings[0]]}
                stopOpacity={overview ? 0.22 : 0.18}
              />
              <stop
                offset="100%"
                stopColor={BUILDING_COLORS[buildings[0]]}
                stopOpacity={0.01}
              />
            </linearGradient>
          </defs>
          <CartesianGrid
            stroke="var(--mo-grid)"
            vertical={false}
            strokeDasharray="3 4"
          />
          <XAxis
            dataKey="name"
            tickFormatter={(value) =>
              String(value).length === 7
                ? `${Number(String(value).slice(5))}月`
                : String(value).slice(5).replace('-', '/')
            }
            tick={{ fontSize: 11, fill: 'var(--mo-chart-text)' }}
            tickLine={false}
            axisLine={false}
            minTickGap={small ? 28 : 40}
          />
          <YAxis
            yAxisId="primary"
            width={small ? 48 : 64}
            domain={primaryDomain}
            tickCount={4}
            tickFormatter={(value) => chartNumber(Number(value), metric)}
            tick={{ fontSize: 11, fill: 'var(--mo-chart-text)' }}
            tickLine={false}
            axisLine={false}
          />
          {secondaryDomain && (
            <YAxis
              yAxisId="secondary"
              orientation="right"
              width={54}
              domain={secondaryDomain}
              tickCount={4}
              tickFormatter={(value) => numberFormat(Number(value), 3)}
              tick={{ fontSize: 11, fill: BUILDING_COLORS['E楼'] }}
              tickLine={false}
              axisLine={false}
            />
          )}
          {weatherDomain && (
            <YAxis
              yAxisId="weather"
              orientation="right"
              width={35}
              domain={weatherDomain}
              tickCount={3}
              tickFormatter={(value) => `${numberFormat(Number(value), 0)}°`}
              tick={{ fontSize: 10, fill: 'var(--mo-muted)' }}
              tickLine={false}
              axisLine={false}
            />
          )}
          <Tooltip
            active={detail.isOpen ? false : undefined}
            wrapperStyle={{ zIndex: 20 }}
            labelFormatter={(value) => String(value)}
            formatter={(value, name) => [
              typeof value === 'number'
                ? String(name) === '室外湿球温度'
                  ? `${numberFormat(value, 1)} ℃`
                  : `${numberFormat(value, option.precision)} ${option.unit}`
                : '暂无数据',
              String(name),
            ]}
            contentStyle={{
              borderRadius: 'var(--mo-radius)',
              borderColor: 'var(--mo-border)',
              background: 'var(--mo-tooltip-surface)',
              color: 'var(--mo-ink)',
              fontSize: 12,
            }}
          />
          {areaBuilding && (
            <Area
              yAxisId="primary"
              dataKey={areaBuilding}
              type="monotone"
              fill={`url(#${gradientId})`}
              stroke="none"
              tooltipType="none"
              legendType="none"
              connectNulls={false}
              isAnimationActive={false}
            />
          )}
          {baselines.map((baseline) => (
            <ReferenceLine
              key={baseline.key}
              yAxisId="primary"
              y={baseline.value}
              stroke={
                baseline.key === 'abc' ? 'var(--mo-teal)' : 'var(--mo-amber)'
              }
              strokeWidth={1.5}
              strokeDasharray="7 5"
              opacity={0.72}
              ifOverflow="extendDomain"
            />
          ))}
          {buildings.map((building) => (
            <Line
              yAxisId={building === axes.secondary ? 'secondary' : 'primary'}
              key={building}
              name={building}
              dataKey={building}
              type="monotone"
              strokeLinecap="round"
              strokeLinejoin="round"
              stroke={BUILDING_COLORS[building]}
              strokeWidth={building === '园区' ? 3 : 2}
              strokeDasharray={
                !overview && building === '园区' && buildings.length > 1
                  ? '6 3'
                  : undefined
              }
              dot={
                rows.filter((row) => typeof row[building] === 'number')
                  .length === 1
              }
              activeDot={{ r: 4 }}
              connectNulls={false}
              isAnimationActive={false}
            />
          ))}
          {weatherDomain && (
            <Line
              yAxisId="weather"
              name="室外湿球温度"
              dataKey="wetBulb"
              type="monotone"
              stroke="var(--mo-muted)"
              strokeWidth={1.5}
              strokeDasharray="4 4"
              opacity={0.48}
              dot={false}
              activeDot={{ r: 3 }}
              connectNulls={false}
              isAnimationActive={false}
            />
          )}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
export function LiveTrend({
  period,
  building,
  metric = 'pue',
  comparison,
}: {
  period: ReportPeriod;
  building: BuildingFilter;
  metric?: ResourceMetric;
  comparison?: {
    visible: MonthlyEnergyBuilding[];
    setVisible: Dispatch<SetStateAction<MonthlyEnergyBuilding[]>>;
  };
}) {
  const { data } = useResourceData();
  const [ownVisible, setOwnVisible] = useState<MonthlyEnergyBuilding[]>(
    building === 'all'
      ? ['园区', 'A楼', 'B楼', 'C楼']
      : energyBuilding(building)
        ? [energyBuilding(building)!]
        : [],
  );
  const visible = comparison?.visible ?? ownVisible;
  const setVisible = comparison?.setVisible ?? setOwnVisible;
  const rows = useMemo(
    () => resourceTrend(data, metric, period.start, period.asOf, period.grain),
    [data, metric, period.start, period.asOf, period.grain],
  );
  const selected = energyBuilding(building);
  const latest = useMemo(
    () =>
      [...rows]
        .reverse()
        .find((row) => visible.some((name) => typeof row[name] === 'number')),
    [rows, visible],
  );
  const latestLabel = latest
    ? `${latest.name === period.asOf ? '今日' : '最新'} ${String(latest.name)
        .slice(5)
        .replace('-', '/')}`
    : '';
  return (
    <>
      <ResourceStatus source={resourceSource(metric)} />
      <div
        className="mo-building-toggles"
        role="group"
        aria-label="总览趋势楼栋"
      >
        {ENERGY_BUILDINGS.map((name) => (
          <Button
            key={name}
            variant="outline"
            aria-pressed={visible.includes(name)}
            onClick={() =>
              setVisible((values) =>
                values.includes(name)
                  ? values.filter((x) => x !== name)
                  : [...values, name],
              )
            }
          >
            <i style={{ background: BUILDING_COLORS[name] }} />
            {name}
          </Button>
        ))}
        <Button
          variant="ghost"
          onClick={() => setVisible(['园区', 'A楼', 'B楼', 'C楼'])}
        >
          A–C 对比
        </Button>
      </div>
      {latest && (
        <div className="mo-live-current" aria-label={`${latestLabel}数值`}>
          <strong>{latestLabel}</strong>
          <div>
            {visible.map((name) => {
              const value = latest[name];
              return (
                <span key={name}>
                  <i style={{ background: BUILDING_COLORS[name] }} />
                  <small>{name}</small>
                  <b>
                    {typeof value === 'number'
                      ? chartNumber(value, metric)
                      : '—'}
                  </b>
                  <em>{RESOURCE_METRICS[metric].unit}</em>
                </span>
              );
            })}
          </div>
        </div>
      )}
      {selected || visible.length ? (
        visible.length ? (
          <EnergyLines
            rows={rows}
            buildings={visible}
            metric={metric}
            presentation="overview"
          />
        ) : (
          <EmptyState
            title="所有楼栋已隐藏"
            onReset={() => setVisible(['园区'])}
          />
        )
      ) : (
        <EmptyState
          title="此楼栋暂无该指标"
          description="可查看 A–E 楼和园区"
        />
      )}
      {metric === 'pue' && !comparison && (
        <PueSummary start={period.start} end={period.asOf} visible={visible} />
      )}
    </>
  );
}
export function EnergyExplorer({
  period,
  building,
  initialMetric = 'pue',
  initialWindow = 'recent',
  onRows,
}: {
  period: ReportPeriod;
  building: BuildingFilter;
  initialMetric?: ResourceMetric;
  initialWindow?: 'recent' | 'period';
  onRows?: (
    rows: ResourceTrendRow[],
    metric: ResourceMetric,
    visible: MonthlyEnergyBuilding[],
  ) => void;
}) {
  const { data } = useResourceData();
  const [metric, setMetric] = useState<ResourceMetric>(initialMetric);
  const [window, setWindow] = useState<'recent' | 'period'>(() =>
    initialWindow === 'recent'
      ? defaultResourceTrendWindow(period)
      : initialWindow,
  );
  useEffect(() => {
    setWindow(
      initialWindow === 'recent'
        ? defaultResourceTrendWindow(period)
        : initialWindow,
    );
  }, [initialWindow, period.key]);
  const [layout, setLayout] = useState<'separate' | 'combined'>('separate');
  const [visible, setVisible] = useState<MonthlyEnergyBuilding[]>(
    building === 'all'
      ? ENERGY_BUILDINGS
      : energyBuilding(building)
        ? [energyBuilding(building)!]
        : [],
  );
  const end = data?.range.asOf ?? period.asOf;
  const start =
    window === 'recent'
      ? (data?.range.trendStart ??
        new Date(Date.parse(`${end}T00:00:00Z`) - 29 * 86400000)
          .toISOString()
          .slice(0, 10))
      : period.start;
  const rows = useMemo(
    () =>
      resourceTrend(
        data,
        metric,
        start,
        end,
        window === 'recent' ? 'day' : period.grain,
      ),
    [data, metric, start, end, window, period.grain],
  );
  const wetBulbRows = useMemo(
    () =>
      metric === 'pue'
        ? resourceTrend(
            data,
            'wetBulb',
            start,
            end,
            window === 'recent' ? 'day' : period.grain,
          )
        : [],
    [data, metric, start, end, window, period.grain],
  );
  const option = RESOURCE_METRICS[metric];
  return (
    <div className="mo-energy-explorer">
      <div className="mo-explorer-toolbar">
        <MetricPicker
          water={isWaterMetric(initialMetric)}
          value={metric}
          onChange={setMetric}
        />
        <div className="mo-view-switch" role="group" aria-label="趋势时间范围">
          <Button
            variant="ghost"
            aria-pressed={window === 'recent'}
            onClick={() => setWindow('recent')}
          >
            近30天
          </Button>
          <Button
            variant="ghost"
            aria-pressed={window === 'period'}
            onClick={() => setWindow('period')}
          >
            所选周期
          </Button>
        </div>
        <div className="mo-view-switch" role="group" aria-label="图表布局">
          <Button
            variant="ghost"
            aria-pressed={layout === 'separate'}
            onClick={() => setLayout('separate')}
          >
            <LayoutGrid />
            分楼趋势
          </Button>
          <Button
            variant="ghost"
            aria-pressed={layout === 'combined'}
            onClick={() => setLayout('combined')}
          >
            <LineChartIcon />
            合并对比
          </Button>
        </div>
      </div>
      <div className="mo-building-toggles" role="group" aria-label="显示楼栋">
        {ENERGY_BUILDINGS.map((item) => (
          <Button
            key={item}
            variant="outline"
            aria-pressed={visible.includes(item)}
            onClick={() =>
              setVisible((current) =>
                current.includes(item)
                  ? current.filter((value) => value !== item)
                  : ENERGY_BUILDINGS.filter(
                      (value) => value === item || current.includes(value),
                    ),
              )
            }
          >
            <i style={{ background: BUILDING_COLORS[item] }} />
            {item}
          </Button>
        ))}
        <Button variant="ghost" onClick={() => setVisible(ENERGY_BUILDINGS)}>
          全部显示
        </Button>
        <Button variant="ghost" onClick={() => setVisible(['园区'])}>
          只看园区
        </Button>
        {metric === 'pue' && (
          <Button
            variant="ghost"
            onClick={() => {
              setVisible(['园区', 'A楼', 'B楼', 'C楼']);
              setLayout('combined');
            }}
          >
            A–C 对比
          </Button>
        )}
      </div>
      <div className="mo-explorer-caption">
        <span>
          {start} 至 {end} ·{' '}
          {window === 'recent' || period.grain === 'day' ? '按日' : '按月'}
        </span>
        <span
          title={
            metric === 'pue'
              ? '园区为 A–C 的 PUE（数值）按 IT 电量加权；楼栋读取同一字段，周期按 IT 电量加权'
              : metric === 'wetBulb'
                ? '按有效班次平均；园区为 A–E 楼日均值平均'
                : metric === 'wue'
                  ? '按源表当日用电量加权'
                  : '按有效日累计'
          }
        >
          {metric === 'pue' ? '园区 A–C' : '园区 A–E'}
          {layout === 'separate' ? ' · 独立纵轴' : ''}
        </span>
      </div>
      <ResourceStatus source={resourceSource(metric)} />
      {metric === 'pue' && (
        <PueSummary start={start} end={end} visible={visible} />
      )}
      {!visible.length ? (
        <EmptyState
          title="所有楼栋已隐藏"
          onReset={() => setVisible(ENERGY_BUILDINGS)}
        />
      ) : layout === 'combined' ? (
        <Card className="mo-panel mo-combined-chart">
          {metric === 'pue' && <PueBaselineKey buildings={visible} />}
          <EnergyLines rows={rows} buildings={visible} metric={metric} />
        </Card>
      ) : (
        <div className="mo-small-multiples">
          {visible.map((item) => {
            const known = rows.flatMap((row) =>
              typeof row[item] === 'number'
                ? [{ date: row.name, value: row[item] as number }]
                : [],
            );
            const last = known.at(-1);
            const annualPue =
              period.mode === 'year' && metric === 'pue'
                ? resourceValue(data, 'pue', item === '园区' ? 'all' : item)
                : null;
            const headlineValue =
              period.mode === 'year' && metric === 'pue'
                ? annualPue
                : (last?.value ?? null);
            const annualComparison =
              period.mode === 'year' && metric === 'pue'
                ? pueAnnualComparison(item, annualPue)
                : null;
            return (
              <Card className="mo-building-trend" key={item}>
                <div className="mo-building-trend-head">
                  <span className="mo-building-trend-label">
                    <i style={{ background: BUILDING_COLORS[item] }} />
                    {item}
                    {item === '园区' && metric === 'pue' && <small>A–C</small>}
                  </span>
                  <span
                    className={`mo-building-trend-value${annualComparison ? ' is-annual' : ''}`}
                  >
                    {annualComparison && <small>年度 PUE</small>}
                    <span>
                      <strong>
                        {headlineValue !== null
                          ? chartNumber(headlineValue, metric)
                          : '—'}
                      </strong>
                      <small>{option.unit}</small>
                    </span>
                  </span>
                </div>
                {annualComparison && (
                  <div
                    className={`mo-pue-annual-comparison is-${annualComparison.status}`}
                  >
                    <span>
                      {annualComparison.baseline === null
                        ? '年度基线 —'
                        : `年度基线 ${annualComparison.baseline.toFixed(3)}`}
                    </span>
                    <strong>{annualComparison.text}</strong>
                  </div>
                )}
                <div className="mo-building-trend-chart">
                  <EnergyLines
                    rows={rows}
                    buildings={[item]}
                    metric={metric}
                    wetBulbRows={wetBulbRows}
                    small
                  />
                </div>
                <div className="mo-building-trend-foot">
                  <span>{last ? `最新 ${last.date}` : '暂无有效记录'}</span>
                  <span>
                    {known.length}/{rows.length} 个有效数据点
                  </span>
                  {metric === 'pue' && !annualComparison && (
                    <PueBaselineKey buildings={[item]} compact />
                  )}
                  {metric === 'pue' &&
                    wetBulbRows.some(
                      (row) => typeof row[item] === 'number',
                    ) && (
                      <span className="mo-wet-bulb-key">
                        ┄ 室外湿球温度 · 右轴 ℃
                      </span>
                    )}
                </div>
              </Card>
            );
          })}
        </div>
      )}
      {onRows && (
        <Button variant="outline" onClick={() => onRows(rows, metric, visible)}>
          查看当前趋势明细
        </Button>
      )}
    </div>
  );
}

function PueBaselineKey({
  buildings,
  compact = false,
}: {
  buildings: MonthlyEnergyBuilding[];
  compact?: boolean;
}) {
  const references = pueBaselineReferences(buildings);
  if (!references.length) return null;
  return (
    <span
      className={`mo-pue-baseline-key${compact ? ' is-compact' : ''}`}
      aria-label={references
        .map(
          (reference) => `${reference.label} ${reference.value.toFixed(3)} PUE`,
        )
        .join('，')}
    >
      {references.map((reference) => (
        <span key={reference.key}>
          <i className={`is-${reference.key}`} />
          {reference.label} {reference.value.toFixed(3)}
        </span>
      ))}
    </span>
  );
}
export function RackCharts({
  building,
  onDetail,
  onLoadDetail,
}: {
  building: BuildingFilter;
  onDetail?: (building: BuildingFilter) => void;
  onLoadDetail?: (building: BuildingFilter) => void;
}) {
  const { data } = useResourceData();
  const summary = rackSummary(data, building);
  const rows = rackLoadRows(data, building);
  const rackDate =
    [...summary.rows.map((row) => row.date)].sort().at(-1) ?? '—';
  return (
    <div className="mo-live-racks">
      <ResourceStatus source="racks" />
      <div className="mo-rack-headline">
        <div className="mo-rack-headline-icon">
          <Server />
        </div>
        <div>
          <span>{building === 'all' ? '园区' : building}上架率</span>
          <strong>
            {summary.rate?.toFixed(1) ?? '—'}
            <small>%</small>
          </strong>
        </div>
        <div>
          <span>已上电 / 设计容量</span>
          <b>
            {summary.online === null ? '—' : numberFormat(summary.online)} /{' '}
            {summary.capacity === null ? '—' : numberFormat(summary.capacity)}{' '}
            柜
          </b>
        </div>
        <div>
          <span>可用余量</span>
          <b>
            {summary.available === null ? '—' : numberFormat(summary.available)}{' '}
            柜
          </b>
        </div>
        {onDetail && (
          <Button variant="outline" onClick={() => onDetail(building)}>
            查看图表明细
          </Button>
        )}
      </div>
      <div className="mo-rack-snapshot">
        <Activity />
        <span>
          {data?.racks.month
            ? `${data.racks.month} 快照 · 数据截至 ${rackDate}`
            : '所选截止日期前暂无机柜快照'}
        </span>
      </div>
      {!summary.rows.length ? (
        <EmptyState
          title="暂无可用机柜数据"
          description="可切换日期或楼栋；读取失败时可点击刷新"
        />
      ) : (
        <div className="mo-two-columns">
          <Panel title="机柜容量对比">
            <ColumnChart
              rows={summary.rows.map((row) => ({
                name: row.building,
                capacity: row.capacity,
                online: row.online,
              }))}
              series={[
                {
                  key: 'capacity',
                  name: '设计容量',
                  color: 'var(--mo-light-blue)',
                },
                { key: 'online', name: '已上电', color: 'var(--mo-blue)' },
              ]}
              unit=" 柜"
            />
          </Panel>
          <Panel title="各楼上架率与 IT 负载率">
            <div className="mo-rack-load-meta">
              <span>上架率截至 {rackDate}</span>
              <span>
                IT 负载率截至 {data?.load.date ?? '暂无数据'}
                {data?.load.status === 'stale' ? ' · 最近一次有效数据' : ''}
              </span>
            </div>
            <div className="mo-rack-progress-list mo-rack-dual-list">
              {rows.map((row) => (
                <div className="mo-rack-dual-row" key={row.building}>
                  <div className="mo-rack-building-label">
                    <Building2 aria-hidden="true" />
                    <strong>{row.building}</strong>
                  </div>
                  <div className="mo-rack-dual-metrics">
                    <button
                      type="button"
                      className="mo-rack-metric is-rack"
                      onClick={() => onDetail?.(row.building)}
                      disabled={!onDetail}
                      aria-label={`${row.building}上架率 ${row.rate.toFixed(1)}%${onDetail ? '，查看机柜明细' : ''}`}
                    >
                      <span className="mo-rack-metric-heading">
                        <span>上架率</span>
                        <strong>{row.rate.toFixed(1)}%</strong>
                      </span>
                      <progress
                        value={row.online}
                        max={row.capacity}
                        aria-hidden="true"
                      />
                    </button>
                    <button
                      type="button"
                      className="mo-rack-metric is-load"
                      onClick={() => onLoadDetail?.(row.building)}
                      disabled={!onLoadDetail || row.loadRate === null}
                      aria-label={`${row.building} IT 负载率 ${row.loadRate === null ? '暂无数据' : `${row.loadRate.toFixed(1)}%`}${onLoadDetail && row.loadRate !== null ? '，查看负载明细' : ''}`}
                    >
                      <span className="mo-rack-metric-heading">
                        <span>IT 负载率</span>
                        <strong>
                          {row.loadRate === null
                            ? '—'
                            : `${row.loadRate.toFixed(1)}%`}
                        </strong>
                      </span>
                      <progress
                        value={row.loadRate ?? 0}
                        max={Math.max(100, row.loadRate ?? 0)}
                        aria-hidden="true"
                      />
                    </button>
                    <small>
                      已上电 {numberFormat(row.online)} /{' '}
                      {numberFormat(row.capacity)} 柜 · 可用{' '}
                      {numberFormat(row.capacity - row.online)} 柜
                    </small>
                  </div>
                </div>
              ))}
            </div>
          </Panel>
        </div>
      )}
    </div>
  );
}
