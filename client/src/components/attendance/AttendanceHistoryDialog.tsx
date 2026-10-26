import { useEffect, useMemo, useState } from 'react';
import {
  Building2,
  CalendarRange,
  CheckCircle2,
  RefreshCw,
  Search,
  TriangleAlert,
  Users,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';
import type {
  AttendanceHistoryCategory,
  AttendanceHistoryItem,
} from '@shared/attendance-history.interface';
import {
  buildAttendanceHistoryRankings,
  filterAttendanceHistoryItems,
  getDefaultAttendanceHistoryRange,
  groupAttendanceHistoryItems,
  type AttendanceHistoryCategoryFilter,
  type AttendanceHistoryGroupMode,
  type AttendanceHistoryDrilldown,
} from './attendance-history-presentation';
import { useAttendanceHistory } from './use-attendance-history';
import { usePersonnelTimeInsights } from '../personnel-time-insights/use-personnel-time-insights';
import { PersonnelRecordsPanel } from './PersonnelRecordsPanel';
import {
  AttendanceCorrectionEvidenceDialog,
  type AttendanceCorrectionEvidenceTarget,
} from './AttendanceCorrectionEvidenceDialog';

interface AttendanceHistoryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  canViewCorrectionEvidence: boolean;
}

type RankingMode = 'person' | 'building';

export function AttendanceHistoryDialog({
  open,
  onOpenChange,
  canViewCorrectionEvidence,
}: AttendanceHistoryDialogProps) {
  const defaultRange = useMemo(() => getDefaultAttendanceHistoryRange(), []);
  const [from, setFrom] = useState(defaultRange.from);
  const [through, setThrough] = useState(defaultRange.through);
  const [range, setRange] = useState(defaultRange);
  const [activeTab, setActiveTab] = useState('attendance');
  const [rangeError, setRangeError] = useState<string | null>(null);
  const [groupMode, setGroupMode] =
    useState<AttendanceHistoryGroupMode>('building');
  const [rankingMode, setRankingMode] = useState<RankingMode>('person');
  const [drilldown, setDrilldown] = useState<AttendanceHistoryDrilldown | null>(
    null,
  );
  const [categoryFilter, setCategoryFilter] =
    useState<AttendanceHistoryCategoryFilter>('all');
  const [evidenceTarget, setEvidenceTarget] =
    useState<AttendanceCorrectionEvidenceTarget | null>(null);
  const { data, state, error, query } = useAttendanceHistory();
  const personnel = usePersonnelTimeInsights();
  const queryPersonnel = personnel.query;

  useEffect(() => {
    if (!open) return;
    if (activeTab === 'attendance') void query(range);
    else if (canViewCorrectionEvidence) void queryPersonnel(range);
  }, [
    open,
    activeTab,
    range,
    query,
    queryPersonnel,
    canViewCorrectionEvidence,
  ]);

  useEffect(() => {
    if (!canViewCorrectionEvidence && activeTab !== 'attendance')
      setActiveTab('attendance');
  }, [canViewCorrectionEvidence, activeTab]);

  const filteredItems = useMemo(
    () => filterAttendanceHistoryItems(data?.items ?? [], categoryFilter),
    [categoryFilter, data?.items],
  );
  const groups = useMemo(
    () =>
      groupAttendanceHistoryItems(
        filterAttendanceHistoryItems(filteredItems, 'all', drilldown),
        groupMode,
      ),
    [filteredItems, groupMode, drilldown],
  );
  const rankings = useMemo(
    () => buildAttendanceHistoryRankings(filteredItems),
    [filteredItems],
  );
  const isLoading =
    activeTab === 'attendance'
      ? state === 'loading'
      : personnel.state === 'loading';

  const submitQuery = () => {
    const validationError = validateRange(from, through);
    setRangeError(validationError);
    if (validationError) return;
    setDrilldown(null);
    setRange({ from, through });
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="flex max-h-[90vh] max-w-6xl flex-col gap-0 overflow-hidden p-0">
          <DialogHeader className="border-b px-5 py-4 pr-12">
            <DialogTitle className="flex items-center gap-2">
              <CalendarRange
                className="size-5 text-blue-600"
                aria-hidden="true"
              />
              考勤记录查询
            </DialogTitle>
            <DialogDescription className="sr-only">
              按自定义周期查询考勤记录明细与排行
            </DialogDescription>
          </DialogHeader>

          <Tabs
            value={activeTab}
            onValueChange={setActiveTab}
            className="min-h-0 flex-1 gap-0"
          >
            <TabsList
              className="mx-5 my-3 max-w-full"
              aria-label="考勤查询分组"
            >
              <TabsTrigger value="attendance">考勤异常</TabsTrigger>
              {canViewCorrectionEvidence && (
                <>
                  <TabsTrigger value="leave">请休假</TabsTrigger>
                  <TabsTrigger value="overtime">加班</TabsTrigger>
                </>
              )}
            </TabsList>

            <div className="border-b bg-slate-50/80 px-5 py-3">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
                <label className="grid flex-1 gap-1 text-xs font-medium text-slate-600">
                  开始日期
                  <Input
                    type="date"
                    value={from}
                    onChange={(event) => setFrom(event.target.value)}
                    max={through || undefined}
                  />
                </label>
                <label className="grid flex-1 gap-1 text-xs font-medium text-slate-600">
                  结束日期
                  <Input
                    type="date"
                    value={through}
                    onChange={(event) => setThrough(event.target.value)}
                    min={from || undefined}
                  />
                </label>
                <Button
                  type="button"
                  onClick={submitQuery}
                  disabled={isLoading}
                  className="sm:min-w-24"
                >
                  {isLoading ? (
                    <RefreshCw
                      className="size-4 animate-spin"
                      aria-hidden="true"
                    />
                  ) : (
                    <Search className="size-4" aria-hidden="true" />
                  )}
                  查询
                </Button>
              </div>
              {rangeError && (
                <p
                  className="mt-2 text-xs font-medium text-rose-600"
                  role="alert"
                >
                  {rangeError}
                </p>
              )}
            </div>

            <TabsContent
              value="attendance"
              forceMount
              hidden={activeTab !== 'attendance'}
              className="min-h-0 flex-1 overflow-y-auto px-5 py-4 data-[state=inactive]:hidden"
            >
              {isLoading && data && (
                <div
                  className="mb-3 flex items-center gap-2 rounded-md bg-blue-50 px-3 py-2 text-xs text-blue-700"
                  role="status"
                >
                  <RefreshCw
                    className="size-3.5 animate-spin"
                    aria-hidden="true"
                  />
                  正在更新，当前保留上次查询结果
                </div>
              )}
              {state === 'error' && data && (
                <div
                  className="mb-3 flex items-center gap-2 rounded-md bg-rose-50 px-3 py-2 text-xs text-rose-700"
                  role="alert"
                >
                  <TriangleAlert className="size-3.5" aria-hidden="true" />
                  {error}，当前显示上次查询结果
                </div>
              )}

              {isLoading && !data ? (
                <div
                  className="flex min-h-56 items-center justify-center gap-2 text-sm text-slate-500"
                  role="status"
                >
                  <RefreshCw
                    className="size-4 animate-spin"
                    aria-hidden="true"
                  />
                  考勤异常数据加载中…
                </div>
              ) : state === 'error' && !data ? (
                <div className="flex min-h-56 flex-col items-center justify-center gap-3 text-center">
                  <TriangleAlert
                    className="size-8 text-rose-500"
                    aria-hidden="true"
                  />
                  <p className="text-sm font-medium text-rose-700">{error}</p>
                  <Button type="button" variant="outline" onClick={submitQuery}>
                    重试
                  </Button>
                </div>
              ) : data ? (
                <>
                  <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
                    <MetricCard
                      label="异常人员"
                      value={data.abnormalPeople}
                      icon={Users}
                    />
                    <MetricCard
                      label="异常项"
                      value={data.anomalyCount}
                      icon={TriangleAlert}
                    />
                    <MetricCard
                      label="涉及楼栋"
                      value={data.affectedBuildings}
                      icon={Building2}
                    />
                    <MetricCard
                      label="补卡后正常"
                      value={data.correctedCount}
                      icon={CheckCircle2}
                    />
                  </div>

                  <div
                    className="mt-3 flex flex-wrap items-center gap-2"
                    aria-label="考勤类型筛选"
                  >
                    {(
                      [
                        ['all', '全部'],
                        ['late', '迟到'],
                        ['early', '早退'],
                        ['missing', '未打卡'],
                        ['corrected', '补卡后正常'],
                        ['other', '其他异常'],
                      ] as Array<[AttendanceHistoryCategoryFilter, string]>
                    ).map(([value, label]) => {
                      const count =
                        value === 'all'
                          ? data.items.length
                          : data.categoryBreakdown.find(
                              (item) => item.category === value,
                            )?.count || 0;
                      return (
                        <button
                          key={value}
                          type="button"
                          className={cn(
                            'rounded-full border px-3 py-1.5 text-xs font-medium transition-colors',
                            categoryFilter === value
                              ? 'border-blue-500 bg-blue-50 text-blue-700'
                              : 'border-slate-200 bg-white text-slate-600 hover:border-blue-300 hover:text-blue-700',
                          )}
                          onClick={() => setCategoryFilter(value)}
                          aria-pressed={categoryFilter === value}
                        >
                          {label} {count}
                        </button>
                      );
                    })}
                  </div>

                  {data.items.length === 0 ? (
                    <div className="mt-4 flex min-h-48 flex-col items-center justify-center rounded-lg border border-emerald-200 bg-emerald-50/60 text-center">
                      <CheckCircle2
                        className="size-9 text-emerald-500"
                        aria-hidden="true"
                      />
                      <p className="mt-2 text-sm font-semibold text-emerald-800">
                        {data.checkedCount > 0
                          ? '所选周期内考勤正常'
                          : '所选周期内暂无可核验归档记录'}
                      </p>
                    </div>
                  ) : filteredItems.length === 0 ? (
                    <div className="mt-4 flex min-h-32 items-center justify-center rounded-lg border border-dashed border-slate-200 bg-slate-50/50 text-sm text-slate-500">
                      当前周期没有此类考勤记录
                    </div>
                  ) : (
                    <div className="mt-4 grid min-h-0 gap-4 lg:grid-cols-[minmax(0,1.7fr)_minmax(16rem,0.8fr)]">
                      <section className="min-w-0 rounded-lg border bg-white">
                        <div className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2">
                          <h3 className="text-sm font-semibold text-slate-800">
                            异常明细
                          </h3>
                          <ModeButtons
                            value={groupMode}
                            options={[
                              { value: 'building', label: '按楼栋' },
                              { value: 'category', label: '按类别' },
                            ]}
                            onChange={(value) =>
                              setGroupMode(value as AttendanceHistoryGroupMode)
                            }
                          />
                        </div>
                        {drilldown && (
                          <div className="flex items-center justify-between gap-2 border-b bg-blue-50 px-3 py-2 text-xs text-blue-700">
                            <span>
                              {drilldown.value} ·{' '}
                              {groups.reduce(
                                (sum, group) => sum + group.count,
                                0,
                              )}{' '}
                              项
                            </span>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              onClick={() => setDrilldown(null)}
                            >
                              清除筛选
                            </Button>
                          </div>
                        )}
                        <div className="max-h-[44vh] space-y-3 overflow-y-auto p-3">
                          {groups.length === 0 && (
                            <p className="py-4 text-center text-sm text-slate-500">
                              当前筛选没有考勤记录
                            </p>
                          )}
                          {groups.map((group) => (
                            <div
                              key={group.key}
                              className="overflow-hidden rounded-md border"
                            >
                              <div className="flex items-center justify-between bg-slate-50 px-3 py-2">
                                <span className="text-sm font-semibold text-slate-700">
                                  {group.label}
                                </span>
                                <Badge variant="secondary">
                                  {group.count} 项
                                </Badge>
                              </div>
                              <div className="divide-y">
                                {group.items.map((item) => (
                                  <HistoryRow
                                    key={`${item.key}:${item.expectedAt}`}
                                    item={item}
                                    onViewEvidence={
                                      canViewCorrectionEvidence &&
                                      item.category === 'corrected'
                                        ? () =>
                                            setEvidenceTarget({
                                              businessDate:
                                                item.businessDate || item.date,
                                              entryKey: item.key,
                                              displayName: item.name,
                                              cardLabel:
                                                item.direction === 'OnDuty'
                                                  ? '上班'
                                                  : '下班',
                                            })
                                        : undefined
                                    }
                                  />
                                ))}
                              </div>
                            </div>
                          ))}
                        </div>
                      </section>

                      <section className="min-w-0 rounded-lg border bg-white">
                        <div className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2">
                          <h3 className="text-sm font-semibold text-slate-800">
                            异常排行
                          </h3>
                          <ModeButtons
                            value={rankingMode}
                            options={[
                              { value: 'person', label: '人员' },
                              { value: 'building', label: '楼栋' },
                            ]}
                            onChange={(value) =>
                              setRankingMode(value as RankingMode)
                            }
                          />
                        </div>
                        <ol className="max-h-[44vh] divide-y overflow-y-auto px-3">
                          {(rankingMode === 'person'
                            ? rankings.people
                            : rankings.buildings
                          ).map((entry, index) => (
                            <li
                              key={
                                'name' in entry ? entry.name : entry.building
                              }
                            >
                              <button
                                type="button"
                                className="flex w-full items-center gap-3 rounded-md px-1 py-3 text-left hover:bg-blue-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                                aria-label={`查看${'name' in entry ? entry.name : entry.building}考勤明细`}
                                aria-pressed={
                                  drilldown?.kind === rankingMode &&
                                  drilldown.value ===
                                    ('name' in entry
                                      ? entry.name
                                      : entry.building)
                                }
                                onClick={() =>
                                  setDrilldown({
                                    kind: rankingMode,
                                    value:
                                      'name' in entry
                                        ? entry.name
                                        : entry.building,
                                  })
                                }
                              >
                                <span
                                  className={cn(
                                    'flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-bold',
                                    index < 3
                                      ? 'bg-blue-100 text-blue-700'
                                      : 'bg-slate-100 text-slate-600',
                                  )}
                                >
                                  {index + 1}
                                </span>
                                <div className="min-w-0 flex-1">
                                  <p className="truncate text-sm font-medium text-slate-800">
                                    {'name' in entry
                                      ? entry.name
                                      : entry.building}
                                  </p>
                                  <p className="truncate text-xs text-slate-500">
                                    {'name' in entry
                                      ? entry.buildings.join('、')
                                      : `${entry.peopleCount} 人`}
                                  </p>
                                </div>
                                <strong className="text-sm text-rose-600">
                                  {entry.count} 次
                                </strong>
                              </button>
                            </li>
                          ))}
                        </ol>
                      </section>
                    </div>
                  )}

                  <p className="mt-3 text-right text-xs text-slate-400">
                    数据截至 {data.fetchedAt}
                  </p>
                </>
              ) : null}
            </TabsContent>
            {canViewCorrectionEvidence && (
              <>
                <TabsContent
                  value="leave"
                  forceMount
                  hidden={activeTab !== 'leave'}
                  className="min-h-0 flex-1 overflow-y-auto px-5 py-4 data-[state=inactive]:hidden"
                >
                  <PersonnelRecordsPanel
                    kind="leave"
                    data={personnel.data}
                    state={personnel.state}
                    error={personnel.error}
                    onRetry={() => void queryPersonnel(range, true)}
                  />
                </TabsContent>
                <TabsContent
                  value="overtime"
                  forceMount
                  hidden={activeTab !== 'overtime'}
                  className="min-h-0 flex-1 overflow-y-auto px-5 py-4 data-[state=inactive]:hidden"
                >
                  <PersonnelRecordsPanel
                    kind="overtime"
                    data={personnel.data}
                    state={personnel.state}
                    error={personnel.error}
                    onRetry={() => void queryPersonnel(range, true)}
                  />
                </TabsContent>
              </>
            )}
          </Tabs>
        </DialogContent>
      </Dialog>
      <AttendanceCorrectionEvidenceDialog
        target={evidenceTarget}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setEvidenceTarget(null);
        }}
      />
    </>
  );
}

function MetricCard({
  label,
  value,
  icon: Icon,
}: {
  label: string;
  value: number;
  icon: typeof Users;
}) {
  return (
    <div className="flex items-center gap-3 rounded-lg border bg-slate-50/60 px-3 py-3">
      <span className="flex size-8 items-center justify-center rounded-md bg-blue-50 text-blue-600">
        <Icon className="size-4" aria-hidden="true" />
      </span>
      <div>
        <p className="text-xs text-slate-500">{label}</p>
        <p className="text-lg font-bold text-slate-900">{value}</p>
      </div>
    </div>
  );
}

function ModeButtons({
  value,
  options,
  onChange,
}: {
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
}) {
  return (
    <div className="inline-flex rounded-md bg-slate-100 p-0.5">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={cn(
            'rounded px-2 py-1 text-xs transition-colors',
            value === option.value
              ? 'bg-white font-semibold text-blue-700 shadow-sm'
              : 'text-slate-500 hover:text-slate-800',
          )}
          onClick={() => onChange(option.value)}
          aria-pressed={value === option.value}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function HistoryRow({
  item,
  onViewEvidence,
}: {
  item: AttendanceHistoryItem;
  onViewEvidence?: () => void;
}) {
  return (
    <div
      style={{ contentVisibility: 'auto', containIntrinsicSize: 'auto 2.5rem' }}
      className="grid gap-1 px-3 py-2 text-xs sm:grid-cols-[5.6rem_minmax(0,1fr)_auto] sm:items-center sm:gap-3"
    >
      <span className="font-medium text-slate-500">
        {item.date.slice(5)} {item.expectedAt.slice(11, 16)}
      </span>
      <div className="min-w-0">
        <span className="font-semibold text-slate-800">{item.name}</span>
        <span className="ml-2 text-slate-500">
          {item.building} · {item.shiftLabel} ·{' '}
          {item.direction === 'OnDuty' ? '上班' : '下班'}
        </span>
      </div>
      {onViewEvidence ? (
        <button
          type="button"
          className={cn(
            'w-fit rounded px-2 py-0.5 font-semibold transition-colors hover:ring-2 hover:ring-emerald-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500',
            categoryClassName(item.category),
          )}
          onClick={onViewEvidence}
          aria-label={`查看${item.name}${item.direction === 'OnDuty' ? '上班' : '下班'}补卡举证`}
        >
          {item.reason}
        </button>
      ) : (
        <span
          className={cn(
            'w-fit rounded px-2 py-0.5 font-semibold',
            categoryClassName(item.category),
          )}
        >
          {item.reason}
        </span>
      )}
    </div>
  );
}

function categoryClassName(category: AttendanceHistoryCategory): string {
  if (category === 'late') return 'bg-amber-50 text-amber-700';
  if (category === 'early') return 'bg-orange-50 text-orange-700';
  if (category === 'missing') return 'bg-rose-50 text-rose-700';
  if (category === 'corrected') return 'bg-emerald-50 text-emerald-700';
  return 'bg-violet-50 text-violet-700';
}

function validateRange(from: string, through: string): string | null {
  if (!from || !through) return '请选择完整的开始和结束日期';
  if (from > through) return '开始日期不能晚于结束日期';
  const days =
    Math.floor(
      (Date.parse(`${through}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) /
        (24 * 60 * 60 * 1_000),
    ) + 1;
  if (days > 366) return '查询周期不能超过 366 天';
  return null;
}
