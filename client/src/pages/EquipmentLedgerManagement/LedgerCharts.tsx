import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import type { CSSProperties, ReactNode } from 'react';
import type {
  LedgerSummary,
  LedgerSystemPoint,
} from '@shared/equipment-ledger.interface';
import type { LedgerSelection } from './LedgerPanels';

const STATES = [
  { name: '在保', key: 'inWarranty', tone: 'covered' },
  { name: '过保', key: 'expired', tone: 'expired' },
  { name: '待确认', key: 'pending', tone: 'pending' },
] as const;
const CRITICAL = [
  '柴发',
  'UPS',
  'HVDC',
  '蓄电池',
  '冷水机组',
  '空调',
  '变压器',
  '配电柜',
];
const number = (value: number) => value.toLocaleString('zh-CN');
const percent = (value: number, total: number) =>
  total ? `${((value / total) * 100).toFixed(1)}%` : '0%';
type Select = (selection: LedgerSelection) => void;

function ChartCard({
  title,
  children,
  className = '',
}: {
  title: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Card data-slot="card" className={`equipment-ledger-chart ${className}`}>
      <CardHeader data-slot="card-header">
        <CardTitle data-slot="card-title">{title}</CardTitle>
      </CardHeader>
      <CardContent data-slot="card-content">{children}</CardContent>
    </Card>
  );
}

function WarrantyRing({
  summary,
  onSelect,
}: {
  summary: LedgerSummary;
  onSelect: Select;
}) {
  let offset = 0;
  const circumference = 2 * Math.PI * 66;
  return (
    <ChartCard title="维保状态" className="equipment-ledger-warranty">
      <div className="equipment-ledger-ring">
        <svg
          viewBox="0 0 180 180"
          role="group"
          aria-label={`维保状态：${STATES.map((s) => `${s.name}${number(summary.metrics[s.key])}条`).join('，')}`}
        >
          <circle cx="90" cy="90" r="66" className="ledger-ring-base" />
          {STATES.map((state) => {
            const count = summary.metrics[state.key];
            const length = summary.metrics.total
              ? (count / summary.metrics.total) * circumference
              : 0;
            const start = offset;
            offset += length;
            const arcPoint = (distance: number) => {
              const angle = (distance / circumference) * Math.PI * 2;
              return `${90 + 66 * Math.cos(angle)} ${90 + 66 * Math.sin(angle)}`;
            };
            const select = () =>
              onSelect({ title: state.name, query: { warranty: state.name } });
            return count ? (
              <path
                key={state.key}
                d={`M ${arcPoint(start)} A 66 66 0 0 1 ${arcPoint(start + length / 2)} A 66 66 0 0 1 ${arcPoint(start + length)}`}
                className={`ledger-ring-segment series-${state.tone}`}
                role="button"
                tabIndex={0}
                aria-label={`${state.name} ${number(count)}条`}
                onClick={select}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    select();
                  }
                }}
              />
            ) : null;
          })}
          <text
            x="90"
            y="84"
            className="ledger-ring-caption"
            textAnchor="middle"
          >
            设备条目
          </text>
          <text
            x="90"
            y="109"
            className="ledger-ring-total"
            textAnchor="middle"
          >
            {number(summary.metrics.total)}
          </text>
        </svg>
      </div>
      <div className="equipment-ledger-ring-legend">
        {STATES.map((state) => (
          <button
            key={state.key}
            type="button"
            aria-haspopup="dialog"
            onClick={() =>
              onSelect({ title: state.name, query: { warranty: state.name } })
            }
          >
            <span>
              <i className={`series-${state.tone}`} />
              {state.name}
            </span>
            <strong>{number(summary.metrics[state.key])}</strong>
            <small>
              {percent(summary.metrics[state.key], summary.metrics.total)}
            </small>
          </button>
        ))}
      </div>
    </ChartCard>
  );
}

function Buildings({
  buildings,
  onSelect,
  onBuilding,
}: {
  buildings: LedgerSummary[];
  onSelect: Select;
  onBuilding: (building: string) => void;
}) {
  const groups = [
    { name: '自建楼', names: ['A楼', 'B楼', 'C楼'] },
    { name: '代维楼', names: ['D楼', 'E楼'] },
  ];
  const others = buildings
    .filter((b) => !groups.some((g) => g.names.includes(b.building)))
    .map((b) => b.building);
  if (others.length) groups.push({ name: '其他楼栋', names: others });
  const max = Math.max(1, ...buildings.map((b) => b.metrics.total));
  return (
    <ChartCard title="楼栋维保" className="equipment-ledger-build-chart">
      <div className="equipment-ledger-site-groups">
        {groups.map((group) => {
          const rows = buildings.filter((b) =>
            group.names.includes(b.building),
          );
          const total = rows.reduce((n, b) => n + b.metrics.total, 0);
          return (
            <section key={group.name} aria-label={group.name}>
              <button
                type="button"
                className="equipment-ledger-group-total"
                aria-haspopup="dialog"
                onClick={() =>
                  onSelect({
                    title: group.name,
                    query: { management: group.name },
                  })
                }
              >
                <span>{group.name}</span>
                <strong>
                  {number(total)}
                  <small> 条</small>
                </strong>
              </button>
              <div className="equipment-ledger-columns">
                {rows.map((row) => (
                  <div key={row.building} className="equipment-ledger-column">
                    <strong
                      className={row.metrics.total === max ? 'is-highest' : ''}
                    >
                      {number(row.metrics.total)}
                    </strong>
                    <div className="equipment-ledger-column-plot">
                      <div
                        className="equipment-ledger-column-stack"
                        style={{
                          height: `${(row.metrics.total / max) * 100}%`,
                        }}
                      >
                        {STATES.map((state) =>
                          row.metrics[state.key] ? (
                            <button
                              key={state.key}
                              type="button"
                              className={`series-${state.tone}`}
                              style={{
                                height: `${(row.metrics[state.key] / row.metrics.total) * 100}%`,
                              }}
                              aria-label={`${row.building} ${state.name} ${row.metrics[state.key]}条`}
                              aria-haspopup="dialog"
                              title={`${state.name} ${number(row.metrics[state.key])}`}
                              onClick={() =>
                                onSelect({
                                  title: `${row.building} · ${state.name}`,
                                  query: {
                                    building: row.building,
                                    warranty: state.name,
                                  },
                                })
                              }
                            />
                          ) : null,
                        )}
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => onBuilding(row.building)}
                    >
                      {row.building}
                    </Button>
                  </div>
                ))}
              </div>
            </section>
          );
        })}
      </div>
      <div className="equipment-ledger-series-legend">
        {STATES.map((s) => (
          <span key={s.key}>
            <i className={`series-${s.tone}`} />
            {s.name}
          </span>
        ))}
      </div>
      <div className="equipment-ledger-building-access">
        {buildings.map((b) => (
          <div key={b.building}>
            <strong>{b.building}</strong>
            {STATES.map((s) => (
              <button
                type="button"
                key={s.key}
                aria-haspopup="dialog"
                onClick={() =>
                  onSelect({
                    title: `${b.building} · ${s.name}`,
                    query: { building: b.building, warranty: s.name },
                  })
                }
              >
                {s.name} {number(b.metrics[s.key])}
              </button>
            ))}
          </div>
        ))}
      </div>
    </ChartCard>
  );
}

function FamilyMatrix({
  summary,
  onSelect,
}: {
  summary: LedgerSummary;
  onSelect: Select;
}) {
  const rows = [...summary.families]
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);
  return (
    <ChartCard title="设备大类维保" className="equipment-ledger-family-matrix">
      <div className="equipment-ledger-matrix">
        <div className="ledger-matrix-head">
          <span>设备大类</span>
          {STATES.map((s) => (
            <span key={s.key}>{s.name}</span>
          ))}
        </div>
        {rows.map((row) => (
          <div key={row.name}>
            <button
              type="button"
              aria-haspopup="dialog"
              onClick={() =>
                onSelect({ title: row.name, query: { family: row.name } })
              }
            >
              {row.name}
            </button>
            {STATES.map((s) => (
              <button
                key={s.key}
                type="button"
                className={`matrix-${s.tone}`}
                style={
                  {
                    '--ledger-density': row.count ? row[s.key] / row.count : 0,
                  } as CSSProperties
                }
                aria-haspopup="dialog"
                aria-label={`${row.name} ${s.name} ${row[s.key]}条`}
                onClick={() =>
                  onSelect({
                    title: `${row.name} · ${s.name}`,
                    query: { family: row.name, warranty: s.name },
                  })
                }
              >
                {number(row[s.key])}
              </button>
            ))}
          </div>
        ))}
      </div>
      {!rows.length ? <p className="equipment-ledger-empty">暂无设备</p> : null}
    </ChartCard>
  );
}

function Composition({
  systems,
  onSelect,
}: {
  systems: LedgerSystemPoint[];
  onSelect: Select;
}) {
  const totalKinds = systems.reduce((n, point) => n + point.kindCount, 0);
  const sorted = [...systems].sort((a, b) => b.kindCount - a.kindCount);
  return (
    <ChartCard title="设备构成" className="equipment-ledger-composition">
      <div className="equipment-ledger-kind-total">
        <strong>{totalKinds}</strong>
        <span>类</span>
      </div>
      <div className="equipment-ledger-kind-rail" aria-hidden="true">
        {sorted.map((point, i) => (
          <i
            key={point.name}
            className={`system-color-${i % 5}`}
            style={{ flexGrow: point.kindCount }}
          />
        ))}
      </div>
      <div className="equipment-ledger-system-grid">
        {sorted.map((point, i) => (
          <button
            type="button"
            key={point.name}
            aria-haspopup="dialog"
            className={`equipment-ledger-system system-color-${i % 5}`}
            aria-label={`${point.name} ${point.kindCount}类 ${percent(point.kindCount, totalKinds)}`}
            onClick={() =>
              onSelect({
                title: `${point.name} · ${point.kindCount}类`,
                dimension: 'families',
                query: { system: point.name },
              })
            }
          >
            <span>{point.name}</span>
            <strong>
              {point.kindCount}
              <small> 类</small>
            </strong>
            <em>{percent(point.kindCount, totalKinds)}</em>
            <small className="equipment-ledger-system-families">
              {point.families.slice(0, 3).join(' · ')}
            </small>
          </button>
        ))}
      </div>
      {!totalKinds ? <p className="equipment-ledger-empty">暂无种类</p> : null}
    </ChartCard>
  );
}

function CriticalEquipment({
  summary,
  onSelect,
}: {
  summary: LedgerSummary;
  onSelect: Select;
}) {
  return (
    <ChartCard title="关键设备" className="equipment-ledger-critical">
      <div className="equipment-ledger-critical-grid">
        {CRITICAL.map((name) => {
          const point = summary.families.find((p) => p.name === name);
          return (
            <button
              type="button"
              key={name}
              aria-haspopup="dialog"
              onClick={() => onSelect({ title: name, query: { family: name } })}
            >
              <span>{name}</span>
              <strong>
                {number(point?.count || 0)}
                <small> 条</small>
              </strong>
              <span className="equipment-ledger-critical-states">
                <span>在保 {number(point?.inWarranty || 0)}</span>
                <span>过保 {number(point?.expired || 0)}</span>
              </span>
            </button>
          );
        })}
      </div>
    </ChartCard>
  );
}

export function LedgerCharts({
  summary,
  buildings,
  onSelect,
  onBuilding,
  overview,
}: {
  summary: LedgerSummary;
  buildings: LedgerSummary[];
  onSelect: Select;
  onBuilding: (building: string) => void;
  overview: boolean;
}) {
  return (
    <section className="equipment-ledger-charts" aria-label="设备分布">
      <div className="equipment-ledger-chart-row">
        <WarrantyRing summary={summary} onSelect={onSelect} />
        {overview ? (
          <Buildings
            buildings={buildings}
            onSelect={onSelect}
            onBuilding={onBuilding}
          />
        ) : (
          <FamilyMatrix summary={summary} onSelect={onSelect} />
        )}
      </div>
      <div className="equipment-ledger-chart-row equipment-ledger-chart-row-bottom">
        <Composition systems={summary.systems} onSelect={onSelect} />
        <CriticalEquipment summary={summary} onSelect={onSelect} />
      </div>
    </section>
  );
}
