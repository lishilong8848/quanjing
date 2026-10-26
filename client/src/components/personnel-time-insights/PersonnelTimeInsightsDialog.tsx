import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  AlertTriangle,
  BarChart3,
  CalendarRange,
  ChevronDown,
  ChevronRight,
  Clock3,
  ExternalLink,
  RefreshCw,
  Search,
  UserRound,
} from 'lucide-react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from '@/components/ui/hover-card';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import type { PersonProfileDetail } from '@shared/api.interface';
import type {
  PersonnelTimeInsightsMetrics,
  PersonnelTimeInsightsPersonSummary,
  PersonnelTimeInsightsResponse,
} from '@shared/personnel-time-insights.interface';
import {
  filterPersonnelTimeInsightsPeople,
  formatPersonnelHours,
  getCurrentMonthPersonnelTimeInsightsRange,
  getDefaultPersonnelTimeInsightsRange,
  groupPersonnelTimeInsightsPeople,
  validatePersonnelTimeInsightsRange,
  type PersonnelTimeInsightsRange,
} from './personnel-time-insights-presentation';
import { usePersonnelTimeInsights } from './use-personnel-time-insights';

interface PersonnelTimeInsightsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  profiles: readonly PersonProfileDetail[];
}

type GroupMode = 'building' | 'all';

export function PersonnelTimeInsightsDialog({
  open,
  onOpenChange,
  profiles,
}: PersonnelTimeInsightsDialogProps) {
  const defaultRange = useMemo(
    () => getDefaultPersonnelTimeInsightsRange(),
    [],
  );
  const [from, setFrom] = useState(defaultRange.from);
  const [through, setThrough] = useState(defaultRange.through);
  const [rangeError, setRangeError] = useState<string | null>(null);
  const [searchText, setSearchText] = useState('');
  const [groupMode, setGroupMode] = useState<GroupMode>('building');
  const [expandedPeople, setExpandedPeople] = useState<Set<string>>(
    () => new Set(),
  );
  const { data, state, error, query } = usePersonnelTimeInsights();

  useEffect(() => {
    if (!open || state !== 'idle') return;
    void query(defaultRange);
  }, [defaultRange, open, query, state]);

  const profileByName = useMemo(
    () =>
      new Map(
        profiles.map((profile) => [
          normalizeName(profile.supervisorText),
          profile,
        ]),
      ),
    [profiles],
  );
  const filteredPeople = useMemo(
    () => filterPersonnelTimeInsightsPeople(data?.people ?? [], searchText),
    [data?.people, searchText],
  );
  const groups = useMemo(
    () => groupPersonnelTimeInsightsPeople(filteredPeople, groupMode),
    [filteredPeople, groupMode],
  );
  const buildingMetrics = useMemo(
    () => new Map((data?.buildings ?? []).map((item) => [item.building, item])),
    [data?.buildings],
  );
  const isLoading = state === 'loading';

  const submitRange = (range: PersonnelTimeInsightsRange, force = true) => {
    const validationError = validatePersonnelTimeInsightsRange(
      range.from,
      range.through,
    );
    setRangeError(validationError);
    if (validationError) return;
    setFrom(range.from);
    setThrough(range.through);
    void query(range, force);
  };

  const togglePerson = (key: string) => {
    setExpandedPeople((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[92vh] w-[calc(100vw-2rem)] max-w-[92rem] flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="border-b border-slate-200 px-5 py-4 pr-12">
          <DialogTitle className="flex items-center gap-2 text-base font-semibold text-slate-900">
            <Clock3 className="size-5 text-blue-600" aria-hidden="true" />
            人员工时与休假分析
          </DialogTitle>
          <DialogDescription className="sr-only">
            查询人员加班、请休假、调休余额和差旅统计
          </DialogDescription>
        </DialogHeader>

        <div className="border-b border-slate-200 bg-slate-50 px-5 py-3">
          <div className="flex flex-col gap-3 xl:flex-row xl:items-end">
            <div className="grid flex-1 gap-3 sm:grid-cols-2">
              <DateField label="开始日期" value={from} onChange={setFrom} />
              <DateField
                label="结束日期"
                value={through}
                onChange={setThrough}
              />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => submitRange(defaultRange)}
                disabled={isLoading}
              >
                本年度
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  submitRange(getCurrentMonthPersonnelTimeInsightsRange())
                }
                disabled={isLoading}
              >
                本月
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={() => submitRange({ from, through })}
                disabled={isLoading}
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
          </div>
          {rangeError ? (
            <p className="mt-2 text-xs font-medium text-rose-600" role="alert">
              {rangeError}
            </p>
          ) : null}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <LoadNotice state={state} error={error} hasData={Boolean(data)} />
          {isLoading && !data ? (
            <CenteredState icon="loading" text="正在汇总人员工时与休假数据" />
          ) : state === 'error' && !data ? (
            <CenteredState
              icon="error"
              text={error || '统计加载失败'}
              action={() => submitRange({ from, through })}
            />
          ) : data ? (
            <div className="space-y-4">
              <MetricsGrid metrics={data.metrics} />
              <InsightsCharts data={data} />
              <section className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
                <div className="flex flex-col gap-3 border-b border-slate-200 bg-slate-50/80 px-4 py-3 lg:flex-row lg:items-center lg:justify-between">
                  <div>
                    <h3 className="text-sm font-semibold text-slate-900">
                      人员清单
                    </h3>
                    <p className="mt-0.5 text-xs text-slate-500">
                      共 {filteredPeople.length}{' '}
                      人，点击行可查看加班及请休假明细
                    </p>
                  </div>
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                    <div className="relative">
                      <Search
                        className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-slate-400"
                        aria-hidden="true"
                      />
                      <Input
                        value={searchText}
                        onChange={(event) => setSearchText(event.target.value)}
                        placeholder="搜索姓名、楼栋或岗位"
                        className="h-8 w-full pl-8 sm:w-56"
                      />
                    </div>
                    <div className="flex rounded-md border border-slate-200 bg-white p-0.5">
                      <ModeButton
                        active={groupMode === 'building'}
                        onClick={() => setGroupMode('building')}
                      >
                        分楼栋
                      </ModeButton>
                      <ModeButton
                        active={groupMode === 'all'}
                        onClick={() => setGroupMode('all')}
                      >
                        全部人员
                      </ModeButton>
                    </div>
                  </div>
                </div>
                {groups.length === 0 ? (
                  <div className="px-4 py-12 text-center text-sm text-slate-500">
                    当前筛选条件下暂无人员记录
                  </div>
                ) : (
                  <div className="divide-y divide-slate-200">
                    {groups.map((group) => (
                      <PersonnelGroupTable
                        key={group.building}
                        label={group.building}
                        people={group.people}
                        metrics={
                          groupMode === 'building'
                            ? buildingMetrics.get(group.building)
                            : data.metrics
                        }
                        profileByName={profileByName}
                        expandedPeople={expandedPeople}
                        onTogglePerson={togglePerson}
                      />
                    ))}
                  </div>
                )}
              </section>
            </div>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function DateField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="grid gap-1 text-xs font-medium text-slate-600">
      {label}
      <Input
        type="date"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-9 bg-white"
      />
    </label>
  );
}

function LoadNotice({
  state,
  error,
  hasData,
}: {
  state: string;
  error: string | null;
  hasData: boolean;
}) {
  if (state === 'loading' && hasData) {
    return (
      <div
        className="mb-3 flex items-center gap-2 rounded-md border border-blue-100 bg-blue-50 px-3 py-2 text-xs text-blue-700"
        role="status"
      >
        <RefreshCw className="size-3.5 animate-spin" aria-hidden="true" />
        正在更新，当前保留上次查询结果
      </div>
    );
  }
  if (state === 'error' && hasData) {
    return (
      <div
        className="mb-3 flex items-center gap-2 rounded-md border border-rose-100 bg-rose-50 px-3 py-2 text-xs text-rose-700"
        role="alert"
      >
        <AlertTriangle className="size-3.5" aria-hidden="true" />
        {error}，当前显示上次查询结果
      </div>
    );
  }
  return null;
}

function CenteredState({
  icon,
  text,
  action,
}: {
  icon: 'loading' | 'error';
  text: string;
  action?: () => void;
}) {
  return (
    <div className="flex min-h-72 flex-col items-center justify-center gap-3 text-sm text-slate-500">
      {icon === 'loading' ? (
        <RefreshCw
          className="size-5 animate-spin text-blue-600"
          aria-hidden="true"
        />
      ) : (
        <AlertTriangle className="size-5 text-rose-600" aria-hidden="true" />
      )}
      <span>{text}</span>
      {action ? (
        <Button type="button" variant="outline" size="sm" onClick={action}>
          重试
        </Button>
      ) : null}
    </div>
  );
}

function MetricsGrid({ metrics }: { metrics: PersonnelTimeInsightsMetrics }) {
  const cards = [
    {
      label: '加班人员',
      value: `${metrics.overtimePeople} 人`,
      note: '已确认实际加班',
    },
    {
      label: '实际加班',
      value: formatPersonnelHours(metrics.overtimeHours),
      note: '全部结算方式',
    },
    {
      label: '可用调休',
      value: formatPersonnelHours(metrics.compensatoryAvailableHours),
      note: `累计 ${formatPersonnelHours(metrics.compensatoryAccruedHours)} · 已用 ${formatPersonnelHours(metrics.compensatoryUsedHours)}`,
      negative: metrics.compensatoryAvailableHours < 0,
    },
    {
      label: '加班费工时',
      value: formatPersonnelHours(metrics.overtimePayHours),
      note: '已确认按加班费结算',
    },
    {
      label: '请休假',
      value: formatPersonnelHours(metrics.leaveHours),
      note: '不含差旅',
    },
    {
      label: '差旅',
      value: formatPersonnelHours(metrics.travelHours),
      note: '已审批差旅',
    },
  ];
  return (
    <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
      {cards.map((card) => (
        <div
          key={card.label}
          className="rounded-lg border border-slate-200 bg-white px-4 py-3 shadow-sm"
        >
          <div className="text-xs font-medium text-slate-500">{card.label}</div>
          <div
            className={cn(
              'mt-1 text-xl font-semibold tabular-nums text-slate-900',
              card.negative && 'text-rose-600',
            )}
          >
            {card.value}
          </div>
          <div
            className="mt-1 truncate text-[11px] text-slate-400"
            title={card.note}
          >
            {card.note}
          </div>
        </div>
      ))}
    </section>
  );
}

function InsightsCharts({ data }: { data: PersonnelTimeInsightsResponse }) {
  return (
    <section className="grid gap-4 xl:grid-cols-2">
      <ChartPanel title="周期趋势" icon={<CalendarRange className="size-4" />}>
        <ResponsiveContainer width="100%" height={220}>
          <LineChart
            data={data.monthly}
            margin={{ top: 8, right: 16, bottom: 0, left: -20 }}
          >
            <CartesianGrid
              stroke="hsl(214 20% 90%)"
              strokeDasharray="3 3"
              vertical={false}
            />
            <XAxis
              dataKey="month"
              tick={{ fontSize: 11, fill: 'hsl(220 9% 46%)' }}
              axisLine={false}
              tickLine={false}
            />
            <YAxis
              tick={{ fontSize: 11, fill: 'hsl(220 9% 46%)' }}
              axisLine={false}
              tickLine={false}
            />
            <Tooltip
              formatter={(value: number) => formatPersonnelHours(value)}
            />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Line
              type="monotone"
              dataKey="overtimeHours"
              name="加班"
              stroke="hsl(217 91% 60%)"
              strokeWidth={2}
              dot={false}
            />
            <Line
              type="monotone"
              dataKey="leaveHours"
              name="请休假"
              stroke="hsl(220 9% 46%)"
              strokeWidth={2}
              dot={false}
            />
            <Line
              type="monotone"
              dataKey="compensatoryUsedHours"
              name="已用调休"
              stroke="hsl(38 70% 48%)"
              strokeWidth={2}
              dot={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </ChartPanel>
      <ChartPanel title="楼栋对比" icon={<BarChart3 className="size-4" />}>
        <ResponsiveContainer width="100%" height={220}>
          <BarChart
            data={data.buildings}
            margin={{ top: 8, right: 16, bottom: 0, left: -20 }}
          >
            <CartesianGrid
              stroke="hsl(214 20% 90%)"
              strokeDasharray="3 3"
              vertical={false}
            />
            <XAxis
              dataKey="building"
              tick={{ fontSize: 11, fill: 'hsl(220 9% 46%)' }}
              axisLine={false}
              tickLine={false}
            />
            <YAxis
              tick={{ fontSize: 11, fill: 'hsl(220 9% 46%)' }}
              axisLine={false}
              tickLine={false}
            />
            <Tooltip
              formatter={(value: number) => formatPersonnelHours(value)}
            />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Bar
              dataKey="overtimeHours"
              name="加班"
              fill="hsl(217 78% 62%)"
              radius={[3, 3, 0, 0]}
            />
            <Bar
              dataKey="leaveHours"
              name="请休假"
              fill="hsl(215 16% 65%)"
              radius={[3, 3, 0, 0]}
            />
          </BarChart>
        </ResponsiveContainer>
      </ChartPanel>
    </section>
  );
}

function ChartPanel({
  title,
  icon,
  children,
}: {
  title: string;
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-4 pb-3 pt-3 shadow-sm">
      <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-slate-800">
        <span className="text-blue-600">{icon}</span>
        {title}
      </div>
      {children}
    </div>
  );
}

function ModeButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'rounded px-2.5 py-1 text-xs font-medium transition-colors',
        active ? 'bg-blue-600 text-white' : 'text-slate-600 hover:bg-slate-100',
      )}
    >
      {children}
    </button>
  );
}

function PersonnelGroupTable({
  label,
  people,
  metrics,
  profileByName,
  expandedPeople,
  onTogglePerson,
}: {
  label: string;
  people: PersonnelTimeInsightsPersonSummary[];
  metrics?: Partial<PersonnelTimeInsightsMetrics>;
  profileByName: Map<string, PersonProfileDetail>;
  expandedPeople: Set<string>;
  onTogglePerson: (key: string) => void;
}) {
  return (
    <section>
      <div className="flex flex-wrap items-center justify-between gap-2 bg-slate-50 px-4 py-2.5">
        <div className="flex items-center gap-2">
          <span className="rounded-md border border-blue-100 bg-blue-50 px-2 py-0.5 text-sm font-semibold text-blue-700">
            {label}
          </span>
          <span className="text-xs text-slate-500">{people.length} 人</span>
        </div>
        {metrics ? (
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
            <span>加班 {formatPersonnelHours(metrics.overtimeHours ?? 0)}</span>
            <span>请休假 {formatPersonnelHours(metrics.leaveHours ?? 0)}</span>
            <span
              className={cn(
                (metrics.compensatoryAvailableHours ?? 0) < 0 &&
                  'font-semibold text-rose-600',
              )}
            >
              可用调休{' '}
              {formatPersonnelHours(metrics.compensatoryAvailableHours ?? 0)}
            </span>
          </div>
        ) : null}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[1020px] border-collapse text-sm">
          <thead>
            <tr className="border-y border-slate-200 bg-white text-left text-xs font-medium text-slate-500">
              <th className="w-10 px-3 py-2" aria-label="展开明细" />
              <th className="px-3 py-2">人员</th>
              <th className="px-3 py-2 text-right">实际加班</th>
              <th className="px-3 py-2 text-right">加班费</th>
              <th className="px-3 py-2 text-right">调休累计</th>
              <th className="px-3 py-2 text-right">已用调休</th>
              <th className="px-3 py-2 text-right">可用调休</th>
              <th className="px-3 py-2 text-right">请休假</th>
              <th className="px-3 py-2 text-right">差旅</th>
              <th className="px-3 py-2">状态</th>
            </tr>
          </thead>
          <tbody>
            {people.map((person) => {
              const expanded = expandedPeople.has(person.key);
              const profile = profileByName.get(normalizeName(person.name));
              return (
                <PersonRow
                  key={person.key}
                  person={person}
                  profile={profile}
                  expanded={expanded}
                  onToggle={() => onTogglePerson(person.key)}
                />
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function PersonRow({
  person,
  profile,
  expanded,
  onToggle,
}: {
  person: PersonnelTimeInsightsPersonSummary;
  profile?: PersonProfileDetail;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <tr className="border-b border-slate-100 text-slate-700 hover:bg-slate-50/70">
        <td className="px-3 py-2.5">
          <button
            type="button"
            onClick={onToggle}
            className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
            aria-label={`${expanded ? '收起' : '展开'}${person.name}明细`}
            aria-expanded={expanded}
          >
            {expanded ? (
              <ChevronDown className="size-4" />
            ) : (
              <ChevronRight className="size-4" />
            )}
          </button>
        </td>
        <td className="px-3 py-2.5">
          <PersonContact person={person} profile={profile} />
        </td>
        <HourCell value={person.overtimeHours} strong />
        <HourCell value={person.overtimePayHours} />
        <HourCell value={person.compensatoryAccruedHours} />
        <HourCell value={person.compensatoryUsedHours} />
        <HourCell
          value={person.compensatoryAvailableHours}
          negative={person.compensatoryAvailableHours < 0}
          strong
        />
        <HourCell value={person.leaveHours} />
        <HourCell value={person.travelHours} />
        <td className="px-3 py-2.5">
          {person.pendingOvertimeCount > 0 ? (
            <span className="inline-flex rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700">
              {person.pendingOvertimeCount} 条待确认
            </span>
          ) : (
            <span className="text-xs text-slate-400">已核算</span>
          )}
        </td>
      </tr>
      {expanded ? <PersonDetailsRow person={person} /> : null}
    </>
  );
}

function HourCell({
  value,
  negative = false,
  strong = false,
}: {
  value: number;
  negative?: boolean;
  strong?: boolean;
}) {
  return (
    <td
      className={cn(
        'px-3 py-2.5 text-right tabular-nums text-slate-600',
        strong && 'font-semibold text-slate-900',
        negative && 'text-rose-600',
      )}
    >
      {formatPersonnelHours(value)}
    </td>
  );
}

function PersonContact({
  person,
  profile,
}: {
  person: PersonnelTimeInsightsPersonSummary;
  profile?: PersonProfileDetail;
}) {
  const chatUrl = profile?.feishuChatUrl || null;
  const triggerClass =
    'inline-flex items-center gap-1 font-semibold text-slate-900 underline-offset-2 hover:text-blue-700 hover:underline';
  return (
    <HoverCard openDelay={120} closeDelay={120}>
      <HoverCardTrigger asChild>
        {chatUrl ? (
          <a
            href={chatUrl}
            className={triggerClass}
            aria-label={`打开与${person.name}的飞书会话`}
          >
            {person.name}
            <ExternalLink
              className="size-3 text-slate-400"
              aria-hidden="true"
            />
          </a>
        ) : (
          <button type="button" className={triggerClass}>
            {person.name}
          </button>
        )}
      </HoverCardTrigger>
      <HoverCardContent className="w-72 border-slate-200 p-3 shadow-lg">
        <div className="flex items-start gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-blue-50 text-blue-700">
            <UserRound className="size-5" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="font-semibold text-slate-900">{person.name}</div>
            <div className="mt-0.5 text-xs text-slate-500">
              {person.building} · {profile?.position || person.position}
            </div>
            {profile?.phone ? (
              <div className="mt-2 text-xs text-slate-600">
                电话：{profile.phone}
              </div>
            ) : null}
            {chatUrl ? (
              <a
                href={chatUrl}
                className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-blue-700 hover:underline"
              >
                打开飞书会话
                <ExternalLink className="size-3" />
              </a>
            ) : (
              <div className="mt-2 text-xs text-slate-400">
                暂无可用飞书会话链接
              </div>
            )}
          </div>
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}

function PersonDetailsRow({
  person,
}: {
  person: PersonnelTimeInsightsPersonSummary;
}) {
  return (
    <tr className="border-b border-slate-200 bg-slate-50/80">
      <td colSpan={10} className="px-5 py-3">
        <div className="grid gap-4 lg:grid-cols-2">
          <DetailList
            title="加班明细"
            empty="无已确认加班"
            items={person.details.overtime.map((item) => ({
              key: item.recordId,
              primary: formatDateTime(item.startAt),
              secondary: `${formatPersonnelHours(item.hours)} · ${item.disposition}${item.legacyDefaultedDisposition ? '（历史默认）' : ''}`,
            }))}
          />
          <DetailList
            title="请休假及差旅明细"
            empty="无已审批请休假或差旅"
            items={person.details.leave.map((item) => ({
              key: `${item.recordId}-${item.date}-${item.startAt}`,
              primary: `${item.date} ${timePart(item.startAt)}–${timePart(item.endAt)}`,
              secondary: `${item.leaveType} · ${formatPersonnelHours(item.hours)}`,
            }))}
          />
        </div>
      </td>
    </tr>
  );
}

function DetailList({
  title,
  empty,
  items,
}: {
  title: string;
  empty: string;
  items: Array<{ key: string; primary: string; secondary: string }>;
}) {
  return (
    <div>
      <div className="mb-2 text-xs font-semibold text-slate-700">{title}</div>
      {items.length === 0 ? (
        <div className="rounded-md border border-dashed border-slate-200 bg-white px-3 py-3 text-xs text-slate-400">
          {empty}
        </div>
      ) : (
        <div className="grid gap-1.5 sm:grid-cols-2">
          {items.map((item) => (
            <div
              key={item.key}
              className="rounded-md border border-slate-200 bg-white px-3 py-2"
            >
              <div className="text-xs font-medium text-slate-700">
                {item.primary}
              </div>
              <div className="mt-0.5 text-xs text-slate-500">
                {item.secondary}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function formatDateTime(value: string): string {
  return value.replace('T', ' ').slice(0, 16);
}

function timePart(value: string): string {
  const match = value.match(/(?:T|\s)(\d{2}:\d{2})/u);
  return match?.[1] || value.slice(-5);
}

function normalizeName(value: string): string {
  return String(value || '')
    .replace(/\s+/gu, '')
    .trim();
}
