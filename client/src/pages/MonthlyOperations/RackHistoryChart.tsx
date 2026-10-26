import { useId, useMemo, useState } from 'react';
import {
  Area,
  ComposedChart,
  CartesianGrid,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Button } from '@/components/ui/button';
import type { MonthlyEnergyBuilding } from '@shared/monthly-operations-resources.interface';
import { Panel, EmptyState } from './charts';
import { useChartDetails } from './ChartDetails';
import { useResourceData } from './resource-data';
import {
  BUILDING_COLORS,
  ENERGY_BUILDINGS,
  energyBuilding,
} from './resource-model';
import { numberFormat, type BuildingFilter } from './model';
export function RackHistoryChart({ building }: { building: BuildingFilter }) {
  const { data } = useResourceData();
  const id = useId().replace(/:/g, '');
  const [metric, setMetric] = useState<'rate' | 'online' | 'available'>('rate');
  const [visible, setVisible] = useState<MonthlyEnergyBuilding[]>([
    energyBuilding(building) ?? '园区',
  ]);
  const labels = {
      rate: '上架率',
      online: '已上电数量',
      available: '可用机柜',
    },
    unit = metric === 'rate' ? '%' : '柜';
  const rows = useMemo(
    () =>
      (data?.racks.history ?? []).map((snapshot) => {
        const row: Record<string, string | number | null> = {
          month: snapshot.month,
        };
        for (const name of ENERGY_BUILDINGS) {
          const items = snapshot.rows.filter(
            (item) => name === '园区' || item.building === name,
          );
          if (items.length !== (name === '园区' ? 5 : 1)) {
            row[name] = null;
            continue;
          }
          const capacity = items.reduce((s, r) => s + r.capacity, 0),
            online = items.reduce((s, r) => s + r.online, 0);
          row[name] =
            metric === 'rate'
              ? (online / capacity) * 100
              : metric === 'online'
                ? online
                : capacity - online;
        }
        return row;
      }),
    [data, metric],
  );
  const detail = useChartDetails(
    rows.map((row) => ({ ...row, name: row.month })),
    visible.map((name) => ({ key: name, name })),
    unit,
    `机柜${labels[metric]}`,
  );
  return (
    <Panel title="近12个月机柜趋势" className="mo-rack-history">
      {detail.dialog}
      <div className="mo-explorer-toolbar">
        <div className="mo-view-switch" role="group" aria-label="机柜趋势指标">
          {(['rate', 'online', 'available'] as const).map((key) => (
            <Button
              variant="ghost"
              key={key}
              aria-pressed={metric === key}
              onClick={() => setMetric(key)}
            >
              {labels[key]}
            </Button>
          ))}
        </div>
        <span className="mo-period-note">
          {String(rows[0]?.month ?? '—')} — {String(rows.at(-1)?.month ?? '—')}
        </span>
      </div>
      <div
        className="mo-building-toggles"
        role="group"
        aria-label="机柜趋势楼栋"
      >
        {ENERGY_BUILDINGS.map((name) => (
          <Button
            variant="outline"
            key={name}
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
        <Button variant="ghost" onClick={() => setVisible(ENERGY_BUILDINGS)}>
          全部显示
        </Button>
      </div>
      {!visible.length ? (
        <EmptyState
          title="所有楼栋已隐藏"
          onReset={() => setVisible(['园区'])}
        />
      ) : (
        <div
          className="mo-live-line-chart"
          role="group"
          aria-label={`近12个月机柜${labels[metric]}趋势`}
        >
          {detail.button}
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart
              data={rows}
              onClick={(state) => {
                const row = rows[Number(state.activeTooltipIndex)];
                if (row) detail.open(String(row.month));
              }}
              margin={{ top: 12, right: 20, bottom: 4, left: 0 }}
            >
              <defs>
                <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
                  <stop
                    offset="0%"
                    stopColor={BUILDING_COLORS[visible[0]]}
                    stopOpacity={0.18}
                  />
                  <stop
                    offset="100%"
                    stopColor={BUILDING_COLORS[visible[0]]}
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
                dataKey="month"
                tickFormatter={(value) => String(value).replace('-', '/')}
                tick={{ fontSize: 11, fill: 'var(--mo-chart-text)' }}
                tickLine={false}
                axisLine={false}
                minTickGap={24}
              />
              <YAxis
                domain={metric === 'rate' ? [0, 100] : [0, 'auto']}
                width={55}
                tickCount={5}
                tick={{ fontSize: 11, fill: 'var(--mo-chart-text)' }}
                tickLine={false}
                axisLine={false}
              />
              <Tooltip
                active={detail.isOpen ? false : undefined}
                wrapperStyle={{ zIndex: 20 }}
                formatter={(value, name) => [
                  typeof value === 'number'
                    ? `${numberFormat(value, metric === 'rate' ? 1 : 0)} ${unit}`
                    : '—',
                  String(name),
                ]}
                contentStyle={{
                  background: 'var(--mo-tooltip-surface)',
                  borderColor: 'var(--mo-border)',
                  borderRadius: 'var(--mo-radius)',
                }}
              />
              {visible.length === 1 && (
                <Area
                  dataKey={visible[0]}
                  type="monotone"
                  stroke="none"
                  fill={`url(#${id})`}
                  tooltipType="none"
                  legendType="none"
                  connectNulls={false}
                  isAnimationActive={false}
                />
              )}
              {visible.map((name) => (
                <Line
                  type="monotone"
                  key={name}
                  dataKey={name}
                  name={name}
                  stroke={BUILDING_COLORS[name]}
                  strokeWidth={name === '园区' ? 3 : 2}
                  dot={{ r: 3 }}
                  connectNulls={false}
                  isAnimationActive={false}
                />
              ))}
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}
    </Panel>
  );
}
