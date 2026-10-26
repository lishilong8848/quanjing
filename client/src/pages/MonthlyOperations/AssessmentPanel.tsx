import { useMemo, useRef, useState } from 'react';
import {
  Activity,
  ClipboardCheck,
  RefreshCw,
  SearchCheck,
  ShieldAlert,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { SourceModal } from './SourceModal';
import type {
  AssessmentKind,
  AssessmentRow,
} from '@shared/monthly-operations-assessment.interface';
import {
  ColumnChart,
  Distribution,
  EmptyState,
  Panel,
  CHART_COLORS,
} from './charts';
import { MetricCard } from './components';
import type { PanelProps } from './Overview';
import { ASSESSMENT_KINDS, useAssessment } from './assessment-data';
import {
  assessmentFilter,
  assessmentProgress,
  assessmentScope,
  groupEventTimingAnomalies,
} from './assessment-model';
import { AssessmentList } from './AssessmentList';
import { useSourceStamp } from './SourceStamp';
import { FeishuSourceLinks } from './FeishuSourceLinks';
import { OpenRiskList } from './OpenRiskList';

export const ASSESSMENT_TITLES: Record<AssessmentKind, string> = {
  risk: '风险排查',
  drill: '智航演练',
  event: '智航事件',
  inspection: '现场巡检',
};
export function AssessmentPanel({ view }: PanelProps) {
  const [kind, setKind] = useState<AssessmentKind>('risk');
  return (
    <div className="mo-topic-content mo-assessment">
      <div className="mo-section-heading">
        <h2>智航考核</h2>
        <div className="mo-heading-actions">
          <FeishuSourceLinks source={kind} />
          <Tabs
            value={kind}
            onValueChange={(v) => setKind(v as AssessmentKind)}
          >
            <TabsList aria-label="考核专题">
              {ASSESSMENT_KINDS.map((k) => (
                <TabsTrigger key={k} value={k}>
                  {ASSESSMENT_TITLES[k]}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </div>
      </div>
      <AssessmentSource
        key={`${kind}-${view.period.key}-${view.building}`}
        kind={kind}
        view={view}
      />
    </div>
  );
}
function AssessmentSource({
  kind,
  view,
}: {
  kind: AssessmentKind;
  view: PanelProps['view'];
}) {
  const { data, loading, error, retry } = useAssessment(kind, view.period);
  useSourceStamp('assessment', data?.syncedAt);
  const records = useMemo(
    () => assessmentScope(data?.records ?? [], view.building),
    [data, view.building],
  );
  const timingGroups = useMemo(
    () => (kind === 'event' ? groupEventTimingAnomalies(records) : []),
    [kind, records],
  );
  const previewRecords = useMemo(
    () =>
      kind === 'event'
        ? [
            ...records.filter((row) => !row.tags.includes('处理异常')),
            ...timingGroups,
          ]
        : records,
    [kind, records, timingGroups],
  );
  const [selection, setSelection] = useState<{
    tag: string;
    building: string;
    title: string;
  } | null>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const open = (
    tag = 'all',
    building = 'all',
    title = ASSESSMENT_TITLES[kind] + '清单',
  ) => {
    trigger.current = document.activeElement as HTMLElement;
    setSelection({ tag, building, title });
  };
  const ready = !!data,
    done = records.filter((r) => r.done).length;
  const value = (n: number) =>
    ready && (kind !== 'risk' || assessmentProgress(records).valid > 0)
      ? String(n)
      : '—';
  const tags =
    kind === 'risk'
      ? ['数据待核对']
      : kind === 'drill'
        ? ['逾期', '待评估']
        : kind === 'event'
          ? ['非真实事件', 'I2事件', '已恢复待解决', '处理异常']
          : ['巡检异常', '延迟提交', '超期待提交'];
  const isTimingTag = (tag: string) =>
    kind === 'event' && ['处理异常', '响应超时', '确认超时'].includes(tag);
  const tagCount = (tag: string, building = 'all') =>
    (isTimingTag(tag) ? timingGroups : records).filter(
      (row) =>
        row.tags.includes(tag) &&
        (building === 'all' || row.building === building),
    ).length;
  const buildings = [...new Set(records.map((r) => r.building))].sort();
  const progress = assessmentProgress(records);
  const rows = buildings.map((name) => {
    const subset = records.filter((r) => r.building === name),
      p = assessmentProgress(subset);
    return kind === 'risk'
      ? { name, planned: p.planned, checked: p.checked, approved: p.approved }
      : {
          name,
          total: subset.length,
          done: subset.filter((r) => r.done).length,
          ...Object.fromEntries(
            tags.map((t, i) => [
              's' + i,
              tagCount(t, name),
            ]),
          ),
        };
  });
  const group = (key: 'status' | 'building') =>
    [...new Set(records.map((r) => r[key]))].map((name, i) => ({
      name,
      value: records.filter((r) => r[key] === name).length,
      color: CHART_COLORS[i % CHART_COLORS.length],
    }));
  const selectGroup = (name: string) => {
    const subset = records.filter((r) => r.status === name);
    setGroupRows(subset);
    open('group', 'all', name + '清单');
  };
  const [groupRows, setGroupRows] = useState<AssessmentRow[]>([]);
  const selected = selection
    ? selection.tag === 'group'
      ? groupRows
      : assessmentFilter(
          isTimingTag(selection.tag) ? timingGroups : records,
          selection.tag,
          '',
          selection.building,
        )
    : [];
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
          {!!data?.invalid && (
            <span role="alert">源表有 {data.invalid} 条日期或数量待核对</span>
          )}
          <Button variant="ghost" size="sm" onClick={retry} disabled={loading}>
            <RefreshCw className={loading ? 'animate-spin' : ''} />
            {loading ? '更新中' : '刷新'}
          </Button>
        </div>
        <div
          className={`mo-metrics mo-assessment-metrics${kind === 'event' ? ' is-event' : ''}`}
        >
          {kind === 'risk' ? (
            <>
              <MetricCard
                title="应完成条目"
                value={value(progress.planned)}
                unit="项"
                icon={SearchCheck}
                onClick={() => open()}
              />
              <MetricCard
                title="已排查"
                value={value(progress.checked)}
                unit="项"
                icon={ClipboardCheck}
                onClick={() => open('all', 'all', '各楼排查进度')}
              />
              <MetricCard
                title="已审核"
                value={value(progress.approved)}
                unit="项"
                icon={ClipboardCheck}
                tone="teal"
                onClick={() => open('all', 'all', '各楼审核进度')}
              />
              <MetricCard
                title="待审核"
                value={value(Math.max(0, progress.planned - progress.approved))}
                unit="项"
                icon={ShieldAlert}
                tone="amber"
                onClick={() => open('pending', 'all', '待完成审核楼栋')}
              />
            </>
          ) : (
            <>
              <MetricCard
                title={
                  kind === 'drill'
                    ? '计划演练'
                    : kind === 'event'
                      ? '周期事件'
                      : '巡检工单'
                }
                value={value(records.length)}
                unit="项"
                icon={Activity}
                onClick={() => open()}
              />
              {kind === 'drill' ? (
                <>
                  <MetricCard
                    title="已完成演练"
                    value={value(done)}
                    unit="项"
                    icon={ClipboardCheck}
                    tone="teal"
                    onClick={() => open('done', 'all', '已完成演练')}
                  />
                  {tags.map((tag) => (
                    <MetricCard
                      key={tag}
                      title={tag}
                      value={value(tagCount(tag))}
                      unit="项"
                      icon={ShieldAlert}
                      tone="amber"
                      onClick={() => open(tag, 'all', tag + '演练')}
                    />
                  ))}
                </>
              ) : (
                tags.map((tag) => (
                  <MetricCard
                    key={tag}
                    title={tag}
                    value={value(tagCount(tag))}
                    unit="项"
                    note={
                      kind === 'event' && tag === '处理异常'
                        ? `响应 ${tagCount('响应超时')} · 确认 ${tagCount('确认超时')}`
                        : undefined
                    }
                    icon={ShieldAlert}
                    tone="amber"
                    onClick={() => open(tag, 'all', tag + '清单')}
                  />
                ))
              )}
            </>
          )}
        </div>
        {!ready ? (
          <EmptyState
            title={loading ? '考核数据加载中' : '考核数据暂不可用'}
            description={error || ''}
          />
        ) : records.length === 0 && kind !== 'risk' ? (
          <EmptyState title="所选周期暂无记录" description="" />
        ) : (
          <>
            {records.length > 0 && (
              <div
                className={`mo-two-columns mo-assessment-chart-grid ${kind === 'risk' ? 'mo-risk-chart-grid' : ''}`}
              >
                <Panel
                  title={
                    kind === 'risk'
                      ? '各楼排查与审核进度'
                      : kind === 'drill'
                        ? '各楼演练进度'
                        : '各楼关注分布'
                  }
                  onAction={() => open()}
                >
                  <ColumnChart
                    rows={rows}
                    series={
                      kind === 'risk'
                        ? [
                            {
                              key: 'planned',
                              name: '应完成',
                              color: 'var(--mo-light-blue)',
                            },
                            { key: 'checked', name: '已排查' },
                            {
                              key: 'approved',
                              name: '已审核',
                              color: 'var(--mo-teal)',
                            },
                          ]
                        : kind === 'drill'
                          ? [
                              {
                                key: 'total',
                                name: '计划',
                                color: 'var(--mo-light-blue)',
                              },
                              {
                                key: 'done',
                                name: '已完成',
                                color: 'var(--mo-teal)',
                              },
                            ]
                          : tags.map((name, i) => ({
                              key: 's' + i,
                              name,
                              color: CHART_COLORS[i],
                            }))
                    }
                    unit=" 项"
                    onSelect={(building, key) =>
                      open(
                        kind === 'drill' && key === 'done'
                          ? 'done'
                          : key?.startsWith('s')
                            ? tags[Number(key.slice(1))]
                            : 'all',
                        building,
                        building + ASSESSMENT_TITLES[kind],
                      )
                    }
                  />
                </Panel>
                <Panel title={kind === 'risk' ? '各楼审核完成率' : '状态分布'}>
                  {kind === 'risk' ? (
                    <div className="mo-assessment-progress">
                      {records.map((r) => (
                        <button
                          key={r.id}
                          onClick={() =>
                            open('all', r.building, r.building + '风险排查')
                          }
                        >
                          <span>{r.building}</span>
                          <strong>
                            {r.planned &&
                            r.approved !== null &&
                            !r.tags.includes('数据待核对')
                              ? ((100 * r.approved) / r.planned).toFixed(1) +
                                '%'
                              : '—'}
                          </strong>
                          <i>
                            <b
                              style={{
                                width: `${r.planned && r.approved !== null ? Math.min(100, (100 * r.approved) / r.planned) : 0}%`,
                              }}
                            />
                          </i>
                          <small>
                            {r.approved ?? '—'} / {r.planned ?? '—'} 项
                          </small>
                        </button>
                      ))}
                    </div>
                  ) : (
                    <Distribution
                      rows={group('status')}
                      label={ASSESSMENT_TITLES[kind]}
                      onSelect={selectGroup}
                    />
                  )}
                </Panel>
              </div>
            )}
            <Panel
              title={
                kind === 'risk'
                  ? 'OPEN 风险项与本期排查'
                  : ASSESSMENT_TITLES[kind] + '清单'
              }
            >
              {kind === 'risk' ? (
                <OpenRiskList
                  items={data.openRisks ?? []}
                  status={data.openRiskStatus}
                  building={view.building}
                />
              ) : (
                <AssessmentList
                  kind={kind}
                  records={previewRecords}
                  defaultTag={
                    kind === 'event' || kind === 'inspection' ? 'focus' : 'all'
                  }
                  compact
                />
              )}
            </Panel>
          </>
        )}
      </>
    ),
    [data, records, previewRecords, timingGroups, loading, error, kind],
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
            <AssessmentList kind={kind} records={selected} />
          </div>
        </SourceModal>
      )}
    </>
  );
}
