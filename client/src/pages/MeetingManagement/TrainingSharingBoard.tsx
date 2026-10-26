import {
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type CSSProperties,
} from 'react';
import {
  ArrowRight,
  BookOpen,
  Layers,
  Search,
  Trophy,
  Users,
  X,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  NativeSelect,
  NativeSelectOption,
} from '@/components/ui/native-select';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type {
  MeetingSnapshot,
  MeetingSummary,
} from '../../../../shared/meeting-management.interface';
import { meetingPage } from './model';
import {
  filterTraining,
  isTrainingBuilding,
  trainingAttendance,
  trainingInsights,
  type TrainingFilters,
} from './training-model';
import {
  TrainingPager,
  TrainingTimeline,
  TrainingRanking,
  TrainingResources,
} from './TrainingSharingPanels';
import './training-sharing.css';

const unique = (values: (string | undefined)[]) =>
  [...new Set(values.filter((v): v is string => Boolean(v)))].sort();
type Drill =
  | { kind: 'metric'; key: string }
  | { kind: 'person'; id: string }
  | { kind: 'specialty'; label: string };
export function TrainingSharingBoard({
  snapshot,
  loading,
  onOpenRecord,
  ResourceLinks,
}: {
  snapshot: MeetingSnapshot | null;
  loading: boolean;
  onOpenRecord: (id: string) => void;
  ResourceLinks: ComponentType<{ item: MeetingSummary }>;
}) {
  const [filters, setFilters] = useState<TrainingFilters>({});
  const [drill, setDrill] = useState<Drill | null>(null);
  const [drillPage, setDrillPage] = useState(1);
  const all = useMemo(
    () => snapshot?.records.filter((r) => r.source === 'training') || [],
    [snapshot],
  );
  const shown = useMemo(() => filterTraining(all, filters), [all, filters]);
  const insights = useMemo(() => trainingInsights(shown), [shown]);
  const people = useMemo(
    () => [
      ...new Map(
        all.flatMap((r) => r.presenters || []).map((p) => [p.id, p]),
      ).values(),
    ],
    [all],
  );
  const drillTrigger = useRef<HTMLElement | null>(null);
  const openingDetail = useRef(false);
  const state = snapshot?.sources?.find((s) => s.source === 'training');
  const unavailable = (!snapshot && !loading) || state?.count === null;
  const busy = !snapshot && loading;
  const change = (key: keyof TrainingFilters, value: string) => {
    setFilters((old) => ({ ...old, [key]: value }));
  };
  const reset = () => {
    setFilters({});
  };
  const open = (value: Drill) => {
    drillTrigger.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    openingDetail.current = false;
    setDrill(value);
    setDrillPage(1);
  };
  const groups = [
    ...insights.groups,
    ...(insights.ungrouped.length
      ? [{ label: '专业未填写', rows: insights.ungrouped }]
      : []),
  ];
  const metrics = [
    {
      key: 'records',
      label: '分享记录',
      value: insights.rows.length,
      unit: '条',
      hint: `已完成 ${insights.completed.length} 条`,
      Icon: BookOpen,
      tone: 'blue',
      rows: insights.rows,
    },
    {
      key: 'participants',
      label: '累计参与',
      value: insights.completed.length ? insights.participants : 0,
      unit: '人次',
      hint: insights.missingAttendance
        ? `${insights.missingAttendance} 条人数未记录`
        : '已完成分享',
      Icon: Users,
      tone: 'cyan',
      rows: insights.attended,
    },
    {
      key: 'people',
      label: '分享人',
      value: insights.people.length,
      unit: '位',
      hint: `已完成分享 ${insights.ranking.length} 位`,
      Icon: Trophy,
      tone: 'indigo',
      rows: insights.rows.filter((r) => r.presenters?.length),
    },
    {
      key: 'specialties',
      label: '专业覆盖',
      value: insights.groups.length,
      unit: '类',
      hint: insights.ungrouped.length
        ? `${insights.ungrouped.length} 条专业未填写`
        : '楼栋单独筛选',
      Icon: Layers,
      tone: 'amber',
      rows: insights.rows.filter((r) => !insights.ungrouped.includes(r)),
    },
  ];
  const selectedPerson =
    drill?.kind === 'person'
      ? insights.ranking.find((r) => r.person.id === drill.id)
      : null;
  const selectedGroup =
    drill?.kind === 'specialty'
      ? groups.find((g) => g.label === drill.label)
      : null;
  const selectedMetric =
    drill?.kind === 'metric' ? metrics.find((m) => m.key === drill.key) : null;
  const drillRows =
    selectedPerson?.rows || selectedGroup?.rows || selectedMetric?.rows || [];
  const drillTitle = selectedPerson
    ? `${selectedPerson.person.name}的分享`
    : selectedGroup?.label || selectedMetric?.label || '分享记录';
  const drillRecords = meetingPage(drillRows, drillPage, 10);
  const message = busy
    ? '正在读取培训分享…'
    : unavailable
      ? state?.message || '数据读取失败，请刷新重试'
      : '没有符合条件的分享记录';
  const empty = (
    <div
      className="meeting-empty"
      role={unavailable ? 'alert' : busy ? 'status' : undefined}
    >
      {message}
    </div>
  );
  const activeFilters = Object.values(filters).some(Boolean);
  return (
    <div className="meeting-source-board meeting-training-board training-sharing-board">
      <Card className="training-filter-panel">
        <div className="meeting-archive-heading">
          <h2>培训分享</h2>
          <span>
            {busy
              ? '读取中'
              : unavailable
                ? '读取失败'
                : `${insights.rows.length} 条记录`}
          </span>
        </div>
        <div className="meeting-source-filters training-filters">
          <label className="meeting-source-search">
            <span>关键词</span>
            <div>
              <Search />
              <Input
                aria-label="板块关键词"
                value={filters.query || ''}
                placeholder="搜索主题、分享人或专业"
                onChange={(e) => change('query', e.target.value)}
              />
            </div>
          </label>
          {(
            [
              [
                'year',
                '年份',
                '板块年份',
                unique(all.map((r) => r.date?.slice(0, 4))).reverse(),
                '全部年份',
              ],
              [
                'subtype',
                '分享类型',
                '板块类型',
                unique(all.map((r) => r.subtype)),
                '全部类型',
              ],
              [
                'specialty',
                '专业',
                '楼栋专业',
                unique(
                  all
                    .flatMap((r) => r.specialties || [])
                    .filter((s) => !isTrainingBuilding(s)),
                ),
                '全部专业',
              ],
              [
                'building',
                '楼栋',
                '培训楼栋',
                unique(
                  all
                    .flatMap((r) => r.specialties || [])
                    .filter(isTrainingBuilding),
                ),
                '全部楼栋',
              ],
            ] as const
          ).map(([key, label, aria, options, placeholder]) => (
            <label key={key}>
              <span>{label}</span>
              <NativeSelect
                aria-label={aria}
                value={filters[key] || ''}
                onChange={(e) => change(key, e.target.value)}
              >
                <NativeSelectOption value="">{placeholder}</NativeSelectOption>
                {options.map((v) => (
                  <NativeSelectOption key={v}>{v}</NativeSelectOption>
                ))}
              </NativeSelect>
            </label>
          ))}
          <label>
            <span>分享人</span>
            <NativeSelect
              aria-label="分享人"
              value={filters.presenter || ''}
              onChange={(e) => change('presenter', e.target.value)}
            >
              <NativeSelectOption value="">全部分享人</NativeSelectOption>
              {people.map((p) => (
                <NativeSelectOption key={p.id} value={p.id}>
                  {p.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </label>
          <label>
            <span>资料</span>
            <NativeSelect
              aria-label="板块资料"
              value={filters.content || ''}
              onChange={(e) => change('content', e.target.value)}
            >
              <NativeSelectOption value="">全部记录</NativeSelectOption>
              <NativeSelectOption value="documents">
                已关联资料
              </NativeSelectOption>
            </NativeSelect>
          </label>
          <Button variant="ghost" onClick={reset}>
            重置
          </Button>
        </div>
        {state?.state === 'error' && state.count !== null && (
          <p className="training-source-warning" role="alert">
            当前展示最近一次成功同步的数据；{state.message}
          </p>
        )}
      </Card>
      <section className="meeting-metrics" aria-label="培训分享指标">
        {metrics.map(({ key, label, value, unit, hint, Icon, tone }) => (
          <Card key={key} className="meeting-metric">
            <button
              className="training-metric-button"
              aria-label={`查看${label}`}
              disabled={busy || unavailable}
              onClick={() => open({ kind: 'metric', key })}
            >
              <CardContent className="meeting-metric-content">
                <span className={`meeting-metric-icon meeting-tone-${tone}`}>
                  <Icon />
                </span>
                <div>
                  <p>{label}</p>
                  <strong>
                    {busy || unavailable || value === null ? '—' : value}
                    <small>{unit}</small>
                  </strong>
                  <small>
                    {busy ? '读取中…' : unavailable ? '来源不可用' : hint}
                  </small>
                </div>
                <ArrowRight />
              </CardContent>
            </button>
          </Card>
        ))}
      </section>
      <div className="training-insight-grid">
        <TrainingTimeline
          key={`timeline-${JSON.stringify(filters)}`}
          rows={insights.rows}
          busy={busy}
          unavailable={unavailable}
          empty={empty}
          activeFilters={activeFilters}
          onOpenRecord={onOpenRecord}
        />
        <TrainingRanking
          key={`ranking-${JSON.stringify(filters)}`}
          ranking={insights.ranking}
          busy={busy}
          unavailable={unavailable}
          message={message}
          onOpenPerson={(id) => open({ kind: 'person', id })}
        />
      </div>
      <Card className="meeting-analysis-panel training-specialty-panel">
        <div className="meeting-panel-heading">
          <h2>
            <Layers />
            专业分组
          </h2>
          <span>
            {busy || unavailable ? '—' : insights.groups.length} 个专业
          </span>
        </div>
        {!groups.length || busy || unavailable ? (
          empty
        ) : (
          <div className="training-specialty-groups">
            {groups.map((group, i) => (
              <button
                key={group.label}
                aria-label={`查看${group.label}分享`}
                onClick={() => open({ kind: 'specialty', label: group.label })}
                style={
                  {
                    '--training-accent': `var(--meeting-chart-${group.label === '专业未填写' ? 'neutral' : ['blue', 'cyan', 'indigo', 'amber'][i % 4]})`,
                  } as CSSProperties
                }
              >
                <span>
                  <strong>{group.label}</strong>
                  <ArrowRight />
                </span>
                <span className="training-specialty-value">
                  <strong>{group.rows.length}</strong>
                  <small>条分享</small>
                </span>
                <span className="training-bar">
                  <i
                    style={
                      {
                        '--training-width': `${(group.rows.length / Math.max(1, insights.rows.length)) * 100}%`,
                      } as CSSProperties
                    }
                  />
                </span>
                <small>
                  {
                    new Set(
                      group.rows
                        .flatMap((r) => r.presenters || [])
                        .map((p) => p.id),
                    ).size
                  }{' '}
                  位分享人
                </small>
              </button>
            ))}
          </div>
        )}
      </Card>
      <TrainingResources
        key={JSON.stringify(filters)}
        rows={insights.rows}
        busy={busy}
        unavailable={unavailable}
        empty={empty}
        ResourceLinks={ResourceLinks}
        onOpenRecord={onOpenRecord}
      />
      <Dialog
        open={Boolean(drill)}
        onOpenChange={(value) => {
          if (!value) setDrill(null);
        }}
      >
        <DialogContent
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (!openingDetail.current) drillTrigger.current?.focus();
          }}
          showCloseButton={false}
          className="meeting-demo-dialog training-drill-dialog"
        >
          <DialogHeader>
            <DialogTitle>{drillTitle}</DialogTitle>
            <DialogDescription className="sr-only">
              当前筛选对应的分享记录
            </DialogDescription>
          </DialogHeader>
          {state?.state === 'error' && state.count !== null && (
            <p className="meeting-demo-drill-meta" role="status">
              当前展示最近一次成功同步的数据
            </p>
          )}
          <div className="meeting-demo-drill-meta">
            {drillRows.length} 条分享记录
            {selectedPerson
              ? ` · ${selectedPerson.shares} 次分享 · ${selectedPerson.participants === null ? '参与人数未记录' : `${selectedPerson.participants} 人次`}`
              : selectedMetric
                ? ` · ${selectedMetric.value ?? '未记录'} ${selectedMetric.unit}`
                : ''}
          </div>
          <div className="meeting-demo-drill-list">
            {busy || unavailable ? (
              empty
            ) : !drillRows.length ? (
              <div className="meeting-empty">没有符合条件的分享记录</div>
            ) : (
              drillRecords.records.map((r) => (
                <section key={r.id}>
                  <button
                    onClick={() => {
                      openingDetail.current = true;
                      setDrill(null);
                      onOpenRecord(r.id);
                    }}
                  >
                    <span>
                      <strong>{r.title}</strong>
                      <small>
                        {r.date || '日期未填写'} ·{' '}
                        {r.presenters?.map((p) => p.name).join('、') ||
                          '分享人未填写'}{' '}
                        ·{' '}
                        {trainingAttendance(r) === null
                          ? '人数未记录'
                          : `${trainingAttendance(r)} 人参与`}
                      </small>
                    </span>
                    <ArrowRight />
                  </button>
                </section>
              ))
            )}
          </div>
          {drillRows.length > 10 && (
            <TrainingPager
              current={drillRecords.page}
              total={drillRecords.pages}
              change={setDrillPage}
            />
          )}
          <DialogClose asChild>
            <Button variant="outline">
              <X />
              关闭
            </Button>
          </DialogClose>
        </DialogContent>
      </Dialog>
    </div>
  );
}
