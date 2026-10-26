import { useMemo, useRef, useState } from 'react';
import { ClipboardCheck, RefreshCw, ShieldAlert, Wrench } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { SourceModal } from './SourceModal';
import type {
  MaintenanceRow,
  MaintenanceType,
} from '@shared/monthly-operations-maintenance.interface';
import type { PanelProps } from './Overview';
import { BUILDINGS } from './model';
import { Panel, ColumnChart, Distribution, EmptyState } from './charts';
import { MetricCard } from './components';
import { AssessmentList } from './AssessmentList';
import { useMaintenance } from './maintenance-data';
import { useSourceStamp } from './SourceStamp';
import { FeishuSourceLinks } from './FeishuSourceLinks';
export function MaintenancePanel({ view }: PanelProps) {
  const [kind, setKind] = useState<MaintenanceType>('planned');
  return (
    <div className="mo-topic-content mo-maintenance">
      <div className="mo-section-heading">
        <h2>维护推进</h2>
        <div className="mo-heading-actions">
          <FeishuSourceLinks source={kind} />
          <Tabs value={kind} onValueChange={(v) => setKind(v as MaintenanceType)}>
            <TabsList aria-label="维护类型">
              <TabsTrigger value="planned">计划性维护</TabsTrigger>
              <TabsTrigger value="unplanned">非计划性维护</TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
      </div>
      <MaintenanceSource
        key={`${kind}-${view.period.key}-${view.building}`}
        kind={kind}
        view={view}
      />
    </div>
  );
}
function MaintenanceSource({
  kind,
  view,
}: {
  kind: MaintenanceType;
  view: PanelProps['view'];
}) {
  const { data, loading, error, retry } = useMaintenance(kind, view.period);
  useSourceStamp('assurance', data?.syncedAt);
  const records = useMemo(
    () =>
      (data?.records ?? []).filter(
        (r) => view.building === 'all' || r.building === view.building,
      ),
    [data, view.building],
  );
  const done = records.filter((r) => r.done),
    running = records.filter((r) => r.running),
    abnormal = records.filter((r) => r.abnormal);
  const [selection, setSelection] = useState<{
      title: string;
      rows: MaintenanceRow[];
    } | null>(null),
    trigger = useRef<HTMLElement | null>(null);
  const open = (title: string, rows = records) => {
    trigger.current = document.activeElement as HTMLElement;
    setSelection({ title, rows });
  };
  const buildings = BUILDINGS.filter(
    (b) => view.building === 'all' || b === view.building,
  );
  const rows = buildings.map((name) => {
    const items = records.filter((r) => r.building === name);
    return {
      name,
      total: items.length,
      done: items.filter((r) => r.done).length,
      running: items.filter((r) => r.running).length,
    };
  });
  const specialties = [...new Set(records.map((r) => r.specialty))].map(
    (name) => ({
      name,
      value: records.filter((r) => r.specialty === name).length,
    }),
  );
  const warning =
    error ||
    (data?.status === 'stale' && data.message !== '后台更新中'
      ? data.message
      : '');
  const content = useMemo(
    () => (
      <>
        <div className="mo-assessment-tools">
          {warning && <span role="alert">{warning}</span>}
          <Button variant="ghost" size="sm" onClick={retry} disabled={loading}>
            <RefreshCw className={loading ? 'animate-spin' : ''} />
            {loading ? '更新中' : '刷新维护'}
          </Button>
        </div>
        <div className="mo-metrics">
          <MetricCard
            title={kind === 'planned' ? '维护计划' : '非计划性维护'}
            value={data ? String(records.length) : '—'}
            unit="项"
            icon={ClipboardCheck}
            onClick={() => open('维护清单')}
          />
          <MetricCard
            title="完成率"
            value={
              data && records.length
                ? ((100 * done.length) / records.length).toFixed(1)
                : '—'
            }
            unit="%"
            icon={ClipboardCheck}
            tone="teal"
            note={data ? `${done.length} / ${records.length} 项` : undefined}
            onClick={() => open('已完成维护', done)}
          />
          <MetricCard
            title="进行中维护"
            value={data ? String(running.length) : '—'}
            unit="项"
            icon={Wrench}
            onClick={() => open('进行中维护', running)}
          />
          <MetricCard
            title="维护异常"
            value={data ? String(abnormal.length) : '—'}
            unit="项"
            icon={ShieldAlert}
            tone="amber"
            onClick={() => open('维护异常清单', abnormal)}
          />
        </div>
        {!data ? (
          <EmptyState
            title={loading ? '维护数据加载中' : '维护数据暂不可用'}
            description={error || ''}
          />
        ) : (
          <>
            <div className="mo-assessment-chart-grid">
              <Panel title="各楼维护进度" onAction={() => open('各楼维护清单')}>
                <ColumnChart
                  rows={rows}
                  series={[
                    {
                      key: 'total',
                      name: '总项',
                      color: 'var(--mo-light-blue)',
                    },
                    { key: 'done', name: '已完成', color: 'var(--mo-teal)' },
                    { key: 'running', name: '进行中', color: 'var(--mo-blue)' },
                  ]}
                  unit=" 项"
                  onSelect={(name, key) =>
                    open(
                      name + '维护清单',
                      records.filter(
                        (r) =>
                          r.building === name &&
                          (key === 'done'
                            ? r.done
                            : key === 'running'
                              ? r.running
                              : true),
                      ),
                    )
                  }
                />
                <div className="mo-maintenance-rates">
                  {rows.map((r) => (
                    <button
                      key={r.name}
                      onClick={() =>
                        open(
                          r.name + '维护清单',
                          records.filter((item) => item.building === r.name),
                        )
                      }
                    >
                      <span>{r.name}</span>
                      <strong>
                        {r.total
                          ? ((100 * r.done) / r.total).toFixed(1) + '%'
                          : '—'}
                      </strong>
                    </button>
                  ))}
                </div>
              </Panel>
              <Panel title="专业分布">
                <Distribution
                  rows={specialties}
                  label="维护事项"
                  onSelect={(name) =>
                    open(
                      name + '维护清单',
                      records.filter((r) => r.specialty === name),
                    )
                  }
                />
              </Panel>
            </div>
            <Panel
              title="维护异常明细"
              action={`全部 ${abnormal.length} 项`}
              onAction={() => open('维护异常清单', abnormal)}
            >
              <AssessmentList kind="maintenance" records={abnormal} compact />
            </Panel>
            <Panel title="维护执行清单">
              <AssessmentList kind="maintenance" records={records} compact />
            </Panel>
          </>
        )}
      </>
    ),
    [data, records, loading, error, kind],
  );
  return (
    <>
      {content}
      {selection && (
        <SourceModal
          title={selection.title}
          trigger={trigger.current}
          onClose={() => setSelection(null)}
        >
          <div className="mo-assessment-sheet-body">
            <AssessmentList kind="maintenance" records={selection.rows} />
          </div>
        </SourceModal>
      )}
    </>
  );
}
