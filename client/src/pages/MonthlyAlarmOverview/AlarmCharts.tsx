import { useRef, useState, type MouseEvent } from 'react';
import { X } from 'lucide-react';
import type { MonthlyAlarmOverviewRecord } from '@shared/monthly-alarm-overview.interface';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
} from '@/components/ui/dialog';

const BUILDINGS = ['A', 'B', 'C', 'D', 'E'];
const RECOVERY = [
  '1小时内恢复',
  '1~3小时内恢复',
  '3~6小时内恢复',
  '6~12小时内恢复',
  '12~24小时内恢复',
  '24小时以上恢复',
  '未恢复数',
];

function metricValue(
  summary: MonthlyAlarmOverviewRecord[],
  building: string,
  metric: string,
): number | null {
  return (
    summary.find((row) => row.building === building && row.metric === metric)
      ?.quantity ?? null
  );
}

function valueOf(
  summary: MonthlyAlarmOverviewRecord[],
  building: string,
  metric: string,
) {
  return metricValue(summary, building, metric) ?? 0;
}

type Selection = { metric: string; building?: string };

export function AlarmCharts({
  summary,
  records,
  buildingFilter,
}: {
  summary: MonthlyAlarmOverviewRecord[];
  records: MonthlyAlarmOverviewRecord[];
  buildingFilter: string;
}) {
  const [selection, setSelection] = useState<Selection | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const openDetail = (
    event: MouseEvent<HTMLButtonElement>,
    nextSelection: Selection,
  ) => {
    triggerRef.current = event.currentTarget;
    setSelection(nextSelection);
  };
  const buildings = buildingFilter === 'all' ? BUILDINGS : [buildingFilter];
  const chartRows = buildings.map((building) => ({
    building,
    total: metricValue(summary, building, '告警总数'),
    restored: metricValue(summary, building, '恢复数'),
    unrestored: metricValue(summary, building, '未恢复数'),
  }));
  const maxValue = Math.max(1, ...chartRows.map((row) => row.total ?? 0));
  const maxRecovery = Math.max(
    1,
    ...RECOVERY.map((metric) =>
      buildings.reduce(
        (total, building) => total + valueOf(summary, building, metric),
        0,
      ),
    ),
  );
  const selectedBuildings = selection?.building
    ? [selection.building]
    : buildings;
  const breakdown = selection
    ? selectedBuildings.map((building) => ({
        building,
        value: metricValue(summary, building, selection.metric),
      }))
    : [];
  const selectedTotal = breakdown.reduce(
    (total, row) => total + (row.value ?? 0),
    0,
  );
  const relatedIssues =
    selection?.metric === '未恢复数'
      ? records.filter(
          (row) =>
            row.section === '未恢复异常告警' &&
            selectedBuildings.includes(row.building),
        )
      : [];
  const selectedBuilding = selection?.building;
  const buildingTotal = selectedBuilding
    ? metricValue(summary, selectedBuilding, '告警总数')
    : null;
  const buildingRestored = selectedBuilding
    ? metricValue(summary, selectedBuilding, '恢复数')
    : null;
  const buildingUnrestored = selectedBuilding
    ? metricValue(summary, selectedBuilding, '未恢复数')
    : null;
  const detailRows =
    selection?.metric === '恢复数' && selectedBuilding
      ? RECOVERY.slice(0, -1).map((metric) => ({
          label: metric,
          value: metricValue(summary, selectedBuilding, metric),
        }))
      : selectedBuilding
        ? []
        : [...breakdown]
            .sort((a, b) => (b.value ?? -1) - (a.value ?? -1))
            .map((row) => ({
              label: `EA118-${row.building}`,
              value: row.value,
            }));
  const detailMax = Math.max(1, ...detailRows.map((row) => row.value ?? 0));

  return (
    <>
      <section className="mao-chart-grid" aria-label="告警统计图表">
        <div className="mao-panel mao-glass-panel">
          <div className="mao-panel-heading">
            <h2>各楼栋告警与恢复</h2>
            <div className="mao-chart-legend">
              <span className="is-restored">已恢复</span>
              <span className="is-unrestored">未恢复</span>
            </div>
          </div>
          <div className="mao-column-chart">
            {chartRows.map((row) => (
              <div className="mao-column-group" key={row.building}>
                <div className="mao-column-total">
                  <strong>{row.total ?? '—'}</strong>
                  {row.total === maxValue && <em>最高</em>}
                </div>
                <div className="mao-column-stack">
                  {row.total !== null &&
                    row.restored !== null &&
                    row.restored > 0 && (
                      <button
                        type="button"
                        className="mao-column is-restored"
                        style={{
                          height: `${Math.max(3, (row.restored / maxValue) * 100)}%`,
                        }}
                        onClick={(event) =>
                          openDetail(event, {
                            building: row.building,
                            metric: '恢复数',
                          })
                        }
                        aria-label={`EA118-${row.building} 已恢复 ${row.restored} 条，查看数据`}
                        title={`已恢复 ${row.restored} 条`}
                      />
                    )}
                  {row.total !== null &&
                    row.unrestored !== null &&
                    row.unrestored > 0 && (
                      <button
                        type="button"
                        className="mao-column is-unrestored"
                        style={{
                          height: `${Math.max(3, (row.unrestored / maxValue) * 100)}%`,
                        }}
                        onClick={(event) =>
                          openDetail(event, {
                            building: row.building,
                            metric: '未恢复数',
                          })
                        }
                        aria-label={`EA118-${row.building} 未恢复 ${row.unrestored} 条，查看数据`}
                        title={`未恢复 ${row.unrestored} 条`}
                      />
                    )}
                </div>
                <span>EA118-{row.building}</span>
                <div className="mao-column-values">
                  <span>{row.restored ?? '—'}</span>
                  <span>{row.unrestored ?? '—'}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="mao-panel mao-glass-panel">
          <div className="mao-panel-heading">
            <h2>告警恢复时间分布</h2>
          </div>
          <div className="mao-recovery-list">
            {RECOVERY.map((metric) => {
              const value = buildings.reduce(
                (total, building) => total + valueOf(summary, building, metric),
                0,
              );
              return (
                <button
                  className={`mao-recovery-row ${metric === '未恢复数' ? 'is-unrestored' : ''}`}
                  key={metric}
                  type="button"
                  onClick={(event) => openDetail(event, { metric })}
                  aria-label={`${metric} ${value} 条，查看楼栋数据`}
                >
                  <span>{metric}</span>
                  <span className="mao-bar-track">
                    <i
                      style={{
                        width: `${Math.max(value ? 2 : 0, (value / maxRecovery) * 100)}%`,
                      }}
                    />
                  </span>
                  <strong>
                    {value}
                    {value === maxRecovery && value > 0 && <em>最高</em>}
                  </strong>
                </button>
              );
            })}
          </div>
        </div>
      </section>
      <Dialog
        open={Boolean(selection)}
        onOpenChange={(open) => {
          if (!open) setSelection(null);
        }}
      >
        <DialogContent
          className="mao-drilldown-dialog"
          showCloseButton={false}
          aria-describedby={undefined}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            triggerRef.current?.focus();
          }}
        >
          <header className="mao-dialog-header">
            <div>
              <span>
                {selectedBuilding ? `EA118-${selectedBuilding}` : '全部楼栋'}
              </span>
              <DialogTitle>
                {selection?.metric === '恢复数'
                  ? '已恢复'
                  : selection?.metric === '未恢复数'
                    ? '未恢复'
                    : selection?.metric}
              </DialogTitle>
            </div>
            <DialogClose className="mao-dialog-close" aria-label="关闭数据详情">
              <X aria-hidden="true" />
            </DialogClose>
          </header>
          <div className="mao-drilldown-body">
            <div className="mao-drilldown-hero">
              <strong>{selectedTotal}</strong>
              <span>条</span>
              {buildingTotal !== null && buildingTotal > 0 && (
                <div className="mao-drilldown-share">
                  <span>占本栋告警</span>
                  <b>{((selectedTotal / buildingTotal) * 100).toFixed(1)}%</b>
                  <i>
                    <em
                      style={{
                        width: `${Math.min(100, (selectedTotal / buildingTotal) * 100)}%`,
                      }}
                    />
                  </i>
                </div>
              )}
            </div>
            {selectedBuilding && (
              <div className="mao-drilldown-summary">
                <div>
                  <span>告警总数</span>
                  <strong>{buildingTotal ?? '—'}</strong>
                </div>
                {selection?.metric !== '恢复数' && (
                  <div>
                    <span>已恢复</span>
                    <strong>{buildingRestored ?? '—'}</strong>
                  </div>
                )}
                {selection?.metric !== '未恢复数' && (
                  <div>
                    <span>未恢复</span>
                    <strong>{buildingUnrestored ?? '—'}</strong>
                  </div>
                )}
              </div>
            )}
            {detailRows.length > 0 && (
              <section className="mao-drilldown-details">
                <h3>{selectedBuilding ? '恢复时间' : '楼栋分布'}</h3>
                <div className="mao-drilldown-bars">
                  {detailRows.map((row) => (
                    <div className="mao-drilldown-bar" key={row.label}>
                      <span>{row.label}</span>
                      <i>
                        <em
                          style={{
                            width: `${row.value === null ? 0 : (row.value / detailMax) * 100}%`,
                          }}
                        />
                      </i>
                      <strong>{row.value ?? '—'}</strong>
                      {row.value === detailMax && detailMax > 0 && (
                        <small>最高</small>
                      )}
                    </div>
                  ))}
                </div>
              </section>
            )}
            {selection?.metric === '未恢复数' && (
              <section className="mao-drilldown-issues">
                <h3>未恢复异常告警</h3>
                {relatedIssues.length ? (
                  relatedIssues.map((row) => (
                    <div key={row.id}>
                      <span>{row.problem || row.event || '问题未填写'}</span>
                      <strong>EA118-{row.building}</strong>
                    </div>
                  ))
                ) : (
                  <p>本月未登记异常告警明细</p>
                )}
              </section>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
