import { useAccess } from '@/access/AccessProvider';
import { canUsePageAction } from '../business-action-access';
import { useMemo, useState } from 'react';
import {
  AlertTriangle,
  Archive,
  PackageOpen,
  CalendarClock,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Download,
  FolderSync,
  History,
  ListTodo,
  Loader2,
  RefreshCw,
  UsersRound,
} from 'lucide-react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Legend,
  Line,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type {
  SystemMonthlyReportDashboard,
  SystemMonthlyReportHistoryItem,
  SystemMonthlyReportRoom,
  SystemMonthlyReportStepKey,
  SystemMonthlyReportTask,
} from '@shared/system-monthly-report.interface';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Progress } from '@/components/ui/progress';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';
import {
  getSystemMonthlyReportArchiveDownloadUrl,
  retrySystemMonthlyReportArchive,
} from './api';
import {
  buildSystemMonthlyReportOverviewModel,
  buildSystemMonthlyReportStageDrilldownRows,
  systemMonthlyReportPeriodKey,
} from './overview.logic';
import {
  buildSystemMonthlyReportPersonalTodos,
  getSystemMonthlyReportAuthorizedAction,
  getSystemMonthlyReportTaskPresentation,
  type SystemMonthlyReportPersonalTodo,
} from './system-monthly-report.logic';

const CHART_COLORS = {
  teal: '#62c8bd',
  tealLight: '#bce9e2',
  blue: '#6f91f6',
  blueDark: '#4f74eb',
  orange: '#f6a56a',
  pending: '#e8edf6',
  grid: '#e8edf5',
  text: '#64748b',
};

type Drilldown =
  | { kind: 'stage'; key: SystemMonthlyReportStepKey; label: string }
  | { kind: 'todo'; label: string }
  | { kind: 'archive'; label: string }
  | null;

export function SystemMonthlyReportPeriodNavigator({
  dashboard,
  selectedPeriodKey,
  onChange,
  onOpenHistory,
  onPackage,
}: {
  dashboard: SystemMonthlyReportDashboard;
  selectedPeriodKey: string;
  onChange: (periodKey: string) => void;
  onOpenHistory: () => void;
  onPackage?: (periodKey: string) => void;
}) {
  const model = buildSystemMonthlyReportOverviewModel(
    dashboard,
    selectedPeriodKey,
  );
  const index = model.availablePeriodKeys.indexOf(model.selectedPeriodKey);
  const newer = index > 0 ? model.availablePeriodKeys[index - 1] : '';
  const older =
    index >= 0 && index < model.availablePeriodKeys.length - 1
      ? model.availablePeriodKeys[index + 1]
      : '';
  return (
    <div className="flex min-w-max items-center gap-2">
      <Button
        type="button"
        size="icon"
        variant="outline"
        className="h-9 w-9 border-slate-200 bg-white text-slate-500"
        disabled={!older}
        aria-label="查看上一个月"
        onClick={() => older && onChange(older)}
      >
        <ChevronLeft className="h-4 w-4" />
      </Button>
      {onPackage ? (
        <Button
          type="button"
          variant="outline"
          className="h-9 border-blue-200 bg-blue-50/70 text-blue-700 hover:bg-blue-100"
          onClick={() => onPackage(model.selectedPeriodKey)}
        >
          <PackageOpen className="h-4 w-4" />
          一键打包并发送
        </Button>
      ) : null}
      <label className="relative">
        <span className="sr-only">选择月报月份</span>
        <select
          value={model.selectedPeriodKey}
          onChange={(event) => onChange(event.target.value)}
          className="h-9 min-w-36 appearance-none rounded-lg border border-slate-200 bg-white py-1 pl-10 pr-8 text-sm font-medium text-slate-700 outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
        >
          {model.availablePeriodKeys.map((key) => (
            <option key={key} value={key}>
              {formatPeriodLabel(key)}
            </option>
          ))}
        </select>
        <CalendarClock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
      </label>
      <Button
        type="button"
        size="icon"
        variant="outline"
        className="h-9 w-9 border-slate-200 bg-white text-slate-500"
        disabled={!newer}
        aria-label="查看下一个月"
        onClick={() => newer && onChange(newer)}
      >
        <ChevronRight className="h-4 w-4" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        className="h-9 text-blue-600 hover:bg-blue-50 hover:text-blue-700"
        onClick={onOpenHistory}
      >
        <History className="h-4 w-4" />
        查看历史月报
      </Button>
    </div>
  );
}

export function OverviewDashboard({
  dashboard,
  selectedPeriodKey,
  filteredRooms,
  tasks,
  canWrite,
  canDownload,
  onPrimaryAction,
  onRoomDetail,
  onRefresh,
  onRequireLogin,
}: {
  dashboard: SystemMonthlyReportDashboard;
  selectedPeriodKey: string;
  filteredRooms: SystemMonthlyReportRoom[];
  tasks: Record<string, SystemMonthlyReportTask>;
  canWrite: boolean;
  canDownload: boolean;
  onPrimaryAction: (room: SystemMonthlyReportRoom) => void;
  onRoomDetail: (room: SystemMonthlyReportRoom) => void;
  onRefresh: () => void;
  onRequireLogin: () => void;
}) {
  const model = useMemo(
    () => buildSystemMonthlyReportOverviewModel(dashboard, selectedPeriodKey),
    [dashboard, selectedPeriodKey],
  );
  const [drilldown, setDrilldown] = useState<Drilldown>(null);
  const selectedIsCurrent = model.selectedPeriodKey === model.currentPeriodKey;
  const totalRooms = model.selectedSnapshot.totalRooms;
  const completedRooms = model.selectedSnapshot.completedRooms;
  const completionRate = totalRooms
    ? Math.round((completedRooms / totalRooms) * 100)
    : 0;
  const selectedRows = selectedIsCurrent ? filteredRooms : [];
  const personalTodos = buildSystemMonthlyReportPersonalTodos(selectedRows);
  const firstTodo = personalTodos[0];
  const periodLabel = formatPeriodLabel(model.selectedPeriodKey);
  const handleTodoAction = (room: SystemMonthlyReportRoom) => {
    setDrilldown(null);
    onPrimaryAction(room);
  };

  return (
    <div className="space-y-3">
      <section
        data-testid="monthly-overview-primary-grid"
        className="grid gap-3 min-[1100px]:grid-cols-[240px_minmax(0,1fr)_290px] min-[1440px]:grid-cols-[278px_minmax(0,1fr)_344px] min-[1680px]:grid-cols-[300px_minmax(0,1fr)_360px]"
      >
        <Card className="h-full border-slate-200/80 bg-white/95 shadow-[0_8px_28px_rgba(51,78,124,0.07)]">
          <CardHeader className="px-4 pb-0 pt-4">
            <CardTitle className="flex items-center gap-2 text-base">
              整体归档进度
              <span className="text-xs font-normal text-slate-400">
                {periodLabel}
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-4 pt-0">
            <button
              type="button"
              className="relative mx-auto block h-44 w-full rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-blue-300"
              aria-label={`查看已归档 ${completedRooms} 个机房明细`}
              onClick={() =>
                setDrilldown({ kind: 'archive', label: '归档进度明细' })
              }
            >
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={[
                      { name: '已归档', value: completedRooms },
                      {
                        name: '未归档',
                        value: Math.max(0, totalRooms - completedRooms),
                      },
                    ]}
                    dataKey="value"
                    cx="50%"
                    cy="50%"
                    innerRadius={54}
                    outerRadius={72}
                    startAngle={90}
                    endAngle={-270}
                    strokeWidth={0}
                  >
                    <Cell fill={CHART_COLORS.teal} />
                    <Cell fill={CHART_COLORS.pending} />
                  </Pie>
                </PieChart>
              </ResponsiveContainer>
              <span className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center pt-1">
                <strong className="text-xl font-semibold text-slate-950">
                  {completedRooms} / {totalRooms}
                </strong>
                <span className="mt-1 text-sm text-slate-500">已归档</span>
                <span className="mt-0.5 text-xl font-semibold text-teal-600">
                  {completionRate}%
                </span>
              </span>
            </button>
            <div className="flex items-center justify-center gap-4 text-[11px] text-slate-500">
              <span className="inline-flex items-center gap-2">
                <i className="h-2.5 w-2.5 rounded-sm bg-[#62c8bd]" />
                已归档 {completedRooms}
              </span>
              <span className="inline-flex items-center gap-2">
                <i className="h-2.5 w-2.5 rounded-sm bg-slate-200" />
                未归档 {Math.max(0, totalRooms - completedRooms)}
              </span>
            </div>
          </CardContent>
        </Card>

        <Card className="h-full min-w-0 border-slate-200/80 bg-white/95 shadow-[0_8px_28px_rgba(51,78,124,0.07)]">
          <CardHeader className="px-4 pb-0 pt-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <CardTitle className="text-base">五阶段推进</CardTitle>
                <p className="mt-1 text-xs text-slate-400">
                  柱形显示完成/待完成，折线显示完成率
                </p>
              </div>
              <Badge
                variant="outline"
                className="border-blue-100 bg-blue-50/70 text-blue-600"
              >
                {totalRooms} 个机房
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="h-52 px-2 pb-2 pt-0 md:px-4">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart
                data={model.stageSeries}
                margin={{ top: 22, right: 8, bottom: 0, left: -16 }}
              >
                <defs>
                  <linearGradient
                    id="monthlyStageCompleted"
                    x1="0"
                    y1="0"
                    x2="0"
                    y2="1"
                  >
                    <stop offset="0%" stopColor="#72d2c7" />
                    <stop offset="100%" stopColor="#4fb7ac" />
                  </linearGradient>
                  <linearGradient
                    id="monthlyStagePending"
                    x1="0"
                    y1="0"
                    x2="0"
                    y2="1"
                  >
                    <stop offset="0%" stopColor="#edf1f8" />
                    <stop offset="100%" stopColor="#dfe6f1" />
                  </linearGradient>
                </defs>
                <CartesianGrid
                  stroke={CHART_COLORS.grid}
                  vertical={false}
                  strokeDasharray="4 5"
                />
                <XAxis
                  dataKey="label"
                  tick={{ fill: CHART_COLORS.text, fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                  interval={0}
                />
                <YAxis
                  yAxisId="rooms"
                  allowDecimals={false}
                  tick={{ fill: CHART_COLORS.text, fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis
                  yAxisId="rate"
                  orientation="right"
                  domain={[0, 100]}
                  tickFormatter={(value) => `${value}%`}
                  tick={{ fill: CHART_COLORS.text, fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                />
                <Tooltip content={<StageTooltip />} />
                <Legend
                  wrapperStyle={{ fontSize: 12, color: CHART_COLORS.text }}
                />
                <Bar
                  yAxisId="rooms"
                  dataKey="completed"
                  name="已完成"
                  stackId="rooms"
                  fill="url(#monthlyStageCompleted)"
                  radius={[5, 5, 0, 0]}
                  maxBarSize={54}
                  onClick={(data) =>
                    data?.key &&
                    setDrilldown({
                      kind: 'stage',
                      key: data.key,
                      label: data.label,
                    })
                  }
                />
                <Bar
                  yAxisId="rooms"
                  dataKey="pending"
                  name="待完成"
                  stackId="rooms"
                  fill="url(#monthlyStagePending)"
                  radius={[5, 5, 0, 0]}
                  maxBarSize={54}
                  onClick={(data) =>
                    data?.key &&
                    setDrilldown({
                      kind: 'stage',
                      key: data.key,
                      label: data.label,
                    })
                  }
                />
                <Line
                  yAxisId="rate"
                  type="monotone"
                  dataKey="completionRate"
                  name="完成率"
                  stroke={CHART_COLORS.blueDark}
                  strokeWidth={2.2}
                  dot={{ r: 4, fill: CHART_COLORS.blueDark, strokeWidth: 0 }}
                  activeDot={{ r: 6 }}
                  onClick={(data: any) =>
                    data?.payload?.key &&
                    setDrilldown({
                      kind: 'stage',
                      key: data.payload.key,
                      label: data.payload.label,
                    })
                  }
                />
              </ComposedChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        <Card
          data-testid="system-monthly-report-personal-todos"
          className="h-full border-border bg-card shadow-sm"
        >
          <CardHeader className="px-4 pb-2 pt-4">
            <CardTitle className="text-base">个人待办</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 px-4 pb-4">
            <div className="from-primary/5 to-muted/50 rounded-lg border border-primary/10 bg-gradient-to-br p-4">
              <div className="flex items-start gap-3">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-sm">
                  <ListTodo className="h-5 w-5" />
                </span>
                <div className="min-w-0">
                  <h3 className="truncate text-base font-semibold text-primary">
                    {firstTodo?.action.label || '当前暂无待办'}
                  </h3>
                  <p className="mt-0.5 text-xs text-slate-500">
                    {firstTodo?.room.room || '本月可操作事项已完成'}
                  </p>
                </div>
              </div>
              <p className="mt-3 text-center text-sm text-slate-500">
                <strong className="mr-1 text-2xl font-semibold text-primary">
                  {personalTodos.length}
                </strong>
                项待处理
              </p>
              <Button
                size="sm"
                className="mt-3 h-8 w-full shadow-sm"
                onClick={() =>
                  setDrilldown({ kind: 'todo', label: '个人待办' })
                }
                disabled={!personalTodos.length}
              >
                {personalTodos.length ? '查看待办' : '暂无待办'}
              </Button>
            </div>
            <div className="flex items-center gap-2 rounded-lg border border-orange-100 bg-orange-50/70 px-3 py-2 text-xs text-orange-600">
              <AlertTriangle className="h-4 w-4 shrink-0" />第 5
              个工作日为终版提交最终期限
            </div>
          </CardContent>
        </Card>
      </section>

      <MilestoneTimeline
        totalRooms={totalRooms}
        stageSeries={model.stageSeries}
        milestones={model.selectedSnapshot.milestones || []}
      />

      <section
        data-testid="monthly-overview-detail-grid"
        className="grid gap-3 min-[1100px]:grid-cols-[minmax(0,1fr)_360px] min-[1440px]:grid-cols-[minmax(0,1fr)_440px] min-[1680px]:grid-cols-[minmax(0,1fr)_500px]"
      >
        <RoomProgressTable
          current={selectedIsCurrent}
          rooms={selectedRows}
          history={model.selectedHistory}
          tasks={tasks}
          canDownload={canDownload}
          canRetry={canWrite}
          onPrimaryAction={onPrimaryAction}
          onRoomDetail={onRoomDetail}
          onRefresh={onRefresh}
          onRequireLogin={onRequireLogin}
        />
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-1">
          <TrendCard trend={model.trend} />
          <ArchiveSummary
            dashboard={dashboard}
            selectedPeriodKey={model.selectedPeriodKey}
            onOpen={() => setDrilldown({ kind: 'archive', label: '归档明细' })}
          />
        </div>
      </section>

      <OverviewDrilldownDialog
        value={drilldown}
        onOpenChange={(open) => !open && setDrilldown(null)}
        snapshot={model.selectedSnapshot}
        history={model.selectedHistory}
        todos={personalTodos}
        tasks={tasks}
        onTodoAction={handleTodoAction}
      />
    </div>
  );
}

function MilestoneTimeline({
  totalRooms,
  stageSeries,
  milestones,
}: {
  totalRooms: number;
  stageSeries: Array<{
    key: SystemMonthlyReportStepKey;
    completed: number;
    label: string;
  }>;
  milestones: Array<{
    key: SystemMonthlyReportStepKey;
    date: string | null;
    workdayIndex: number;
    label: string;
  }>;
}) {
  const firstIncomplete = stageSeries.findIndex(
    (item) => item.completed < totalRooms,
  );
  return (
    <Card className="overflow-hidden border-slate-200/80 bg-white/95 shadow-[0_8px_28px_rgba(51,78,124,0.06)]">
      <CardContent className="px-4 py-3 md:px-6">
        <ol className="grid gap-3 md:grid-cols-5 md:gap-0">
          {milestones.map((milestone, index) => {
            const stage = stageSeries.find(
              (item) => item.key === milestone.key,
            );
            const completed = Boolean(
              totalRooms && stage?.completed === totalRooms,
            );
            const current = index === firstIncomplete;
            const overdue = Boolean(
              current && milestone.date && milestone.date < todayKey(),
            );
            return (
              <li
                key={milestone.key}
                className="relative flex gap-3 md:block md:text-center"
              >
                {index > 0 ? (
                  <span
                    className={cn(
                      'absolute left-[-50%] top-8 hidden h-px w-full md:block',
                      completed
                        ? 'bg-teal-400'
                        : current
                          ? 'bg-gradient-to-r from-teal-300 to-blue-400'
                          : 'bg-slate-200',
                    )}
                  />
                ) : null}
                <div className="relative z-10 md:flex md:flex-col md:items-center">
                  <p
                    className={cn(
                      'mb-1.5 text-[11px] font-medium',
                      current ? 'text-blue-600' : 'text-slate-500',
                    )}
                  >
                    第{milestone.workdayIndex}工作日&nbsp;{' '}
                    {formatShortDate(milestone.date)}
                  </p>
                  <span
                    className={cn(
                      'flex h-7 w-7 items-center justify-center rounded-full border-2 text-xs font-semibold shadow-[0_0_0_5px_white]',
                      completed && 'border-teal-500 bg-teal-500 text-white',
                      current &&
                        !overdue &&
                        'border-blue-500 bg-blue-500 text-white',
                      overdue && 'border-orange-400 bg-orange-400 text-white',
                      !completed &&
                        !current &&
                        'border-slate-200 bg-white text-slate-400',
                    )}
                  >
                    {completed ? (
                      <CheckCircle2 className="h-4 w-4" />
                    ) : (
                      milestone.workdayIndex
                    )}
                  </span>
                  <p className="mt-1.5 text-xs font-medium text-slate-700">
                    {milestone.label}
                  </p>
                  <Badge
                    variant="outline"
                    className={cn(
                      'mt-1 h-5 px-2 text-[10px]',
                      completed && 'border-teal-100 bg-teal-50 text-teal-600',
                      current &&
                        !overdue &&
                        'border-blue-100 bg-blue-50 text-blue-600',
                      overdue &&
                        'border-orange-100 bg-orange-50 text-orange-600',
                      !completed &&
                        !current &&
                        'border-slate-200 bg-slate-50 text-slate-400',
                    )}
                  >
                    {completed
                      ? '已完成'
                      : overdue
                        ? '逾期风险'
                        : current
                          ? '进行中'
                          : '待开始'}
                  </Badge>
                </div>
              </li>
            );
          })}
        </ol>
      </CardContent>
    </Card>
  );
}

function RoomProgressTable({
  current,
  rooms,
  history,
  tasks,
  canDownload,
  canRetry,
  onPrimaryAction,
  onRoomDetail,
  onRefresh,
  onRequireLogin,
}: {
  current: boolean;
  rooms: SystemMonthlyReportRoom[];
  history: SystemMonthlyReportHistoryItem[];
  tasks: Record<string, SystemMonthlyReportTask>;
  canDownload: boolean;
  canRetry: boolean;
  onPrimaryAction: (room: SystemMonthlyReportRoom) => void;
  onRoomDetail: (room: SystemMonthlyReportRoom) => void;
  onRefresh: () => void;
  onRequireLogin: () => void;
}) {
  return (
    <Card className="min-w-0 overflow-hidden border-slate-200/80 bg-white/95 shadow-[0_8px_28px_rgba(51,78,124,0.07)]">
      <CardHeader className="border-b border-slate-100 px-4 pb-3 pt-4">
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="text-base">
            {current ? '机房推进明细' : '历史终版归档明细'}
          </CardTitle>
          <Badge variant="secondary">
            {current ? rooms.length : history.length} 个机房
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="overflow-x-auto p-0">
        {current ? (
          rooms.length ? (
            <Table>
              <TableHeader>
                <TableRow className="bg-slate-50/70">
                  <TableHead className="pl-5">机房</TableHead>
                  <TableHead>当前阶段</TableHead>
                  <TableHead>十夫长（机房负责人）</TableHead>
                  <TableHead>可提报人员</TableHead>
                  <TableHead>当前处理人</TableHead>
                  <TableHead>截止节点</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rooms.map((room) => {
                  const action = getSystemMonthlyReportAuthorizedAction(room);
                  const task = tasks[room.recordId];
                  const currentStep = room.steps.find(
                    (step) => step.state === 'current',
                  );
                  const progress = Math.round(
                    (room.steps.filter((step) => step.state === 'completed')
                      .length /
                      Math.max(1, room.steps.length)) *
                      100,
                  );
                  return (
                    <TableRow key={room.recordId}>
                      <TableCell className="pl-5 font-semibold text-slate-900">
                        {room.room}
                      </TableCell>
                      <TableCell>
                        <div className="min-w-36">
                          <div className="flex items-center justify-between gap-2">
                            <StatusPill
                              status={room.status}
                              label={room.statusLabel}
                            />
                            {task ? <TaskPill task={task} /> : null}
                          </div>
                          <Progress value={progress} className="mt-2 h-1.5" />
                        </div>
                      </TableCell>
                      <TableCell className="text-slate-700">
                        {room.leaders.map((item) => item.name).join('、') ||
                          room.leader?.name ||
                          '未维护'}
                      </TableCell>
                      <TableCell className="max-w-44 truncate text-slate-600">
                        {room.submitters.map((item) => item.name).join('、') ||
                          '未维护'}
                      </TableCell>
                      <TableCell>
                        <span className="text-slate-700">
                          {room.currentOwnerName}
                        </span>
                        <span className="ml-1 text-xs text-slate-400">
                          {room.currentOwnerRole}
                        </span>
                      </TableCell>
                      <TableCell
                        className={cn(
                          currentStep?.date &&
                            currentStep.date < todayKey() &&
                            'text-rose-500',
                        )}
                      >
                        {room.status === 'completed'
                          ? '已归档'
                          : currentStep?.date || '待推进'}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1">
                          <Button
                            size="sm"
                            variant="ghost"
                            className="text-blue-600"
                            onClick={() => onRoomDetail(room)}
                          >
                            查看
                          </Button>
                          {action ? (
                            <Button
                              size="sm"
                              variant="outline"
                              className="border-blue-200 text-blue-600"
                              disabled={Boolean(
                                task &&
                                ['accepted', 'syncing'].includes(task.status),
                              )}
                              onClick={() => onPrimaryAction(room)}
                            >
                              {action.label}
                            </Button>
                          ) : null}
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          ) : (
            <CompactEmpty icon={UsersRound} title="没有匹配的机房" />
          )
        ) : history.length ? (
          <Table>
            <TableHeader>
              <TableRow className="bg-slate-50/70">
                <TableHead className="pl-5">机房</TableHead>
                <TableHead>最终提交时间</TableHead>
                <TableHead>终版附件</TableHead>
                <TableHead>归档状态</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {history.map((item) => (
                <TableRow key={item.recordId}>
                  <TableCell className="pl-5 font-semibold text-slate-900">
                    {item.room}
                  </TableCell>
                  <TableCell className="text-slate-500">
                    {formatDateTime(item.finalSubmittedAt)}
                  </TableCell>
                  <TableCell>{item.finalAttachmentCount} 个</TableCell>
                  <TableCell>
                    <ArchiveStatusBadge status={item.archiveStatus} />
                  </TableCell>
                  <TableCell className="text-right">
                    <ArchiveAttachmentActions
                      item={item}
                      canDownload={canDownload}
                      canRetry={canRetry}
                      onRefresh={onRefresh}
                      onRequireLogin={onRequireLogin}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <CompactEmpty icon={Archive} title="该月份暂无终版月报" />
        )}
      </CardContent>
    </Card>
  );
}

function TrendCard({
  trend,
}: {
  trend: Array<{
    periodKey: string;
    month: number;
    completedRooms: number;
    totalRooms: number;
    completionRate: number;
  }>;
}) {
  return (
    <Card className="min-w-0 border-slate-200/80 bg-white/95 shadow-[0_8px_28px_rgba(51,78,124,0.07)]">
      <CardHeader className="px-4 pb-0 pt-4">
        <CardTitle className="text-base">近 6 个月归档趋势</CardTitle>
        <p className="mt-0.5 text-[11px] text-slate-400">同月按最后终版统计</p>
      </CardHeader>
      <CardContent className="h-28 px-2 pb-2 pt-0">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={trend}
            margin={{ top: 12, right: 5, bottom: 0, left: -24 }}
          >
            <defs>
              <linearGradient id="monthlyTrendBar" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#7da1f8" />
                <stop offset="100%" stopColor="#b9cafa" />
              </linearGradient>
            </defs>
            <CartesianGrid
              stroke={CHART_COLORS.grid}
              vertical={false}
              strokeDasharray="4 5"
            />
            <XAxis
              dataKey="month"
              tickFormatter={(value) => `${value}月`}
              tick={{ fill: CHART_COLORS.text, fontSize: 10 }}
              axisLine={false}
              tickLine={false}
            />
            <YAxis
              allowDecimals={false}
              tick={{ fill: CHART_COLORS.text, fontSize: 9 }}
              axisLine={false}
              tickLine={false}
            />
            <Tooltip
              formatter={(value, name) => [
                name === 'completedRooms' ? `${value} 个机房` : `${value}%`,
                name === 'completedRooms' ? '已归档' : '归档率',
              ]}
              labelFormatter={(_, payload) =>
                payload?.[0]?.payload?.periodKey || ''
              }
            />
            <Bar
              dataKey="completedRooms"
              name="已归档"
              fill="url(#monthlyTrendBar)"
              radius={[5, 5, 0, 0]}
              maxBarSize={30}
            />
          </BarChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}

function ArchiveSummary({
  dashboard,
  selectedPeriodKey,
  onOpen,
}: {
  dashboard: SystemMonthlyReportDashboard;
  selectedPeriodKey: string;
  onOpen: () => void;
}) {
  const periods = useMemo(() => {
    const map = new Map<string, SystemMonthlyReportHistoryItem[]>();
    for (const item of dashboard.history) {
      const key = systemMonthlyReportPeriodKey(item.year, item.month);
      map.set(key, [...(map.get(key) || []), item]);
    }
    return Array.from(map.entries())
      .sort(([left], [right]) => right.localeCompare(left))
      .slice(0, 3);
  }, [dashboard.history]);
  return (
    <Card className="border-slate-200/80 bg-white/95 shadow-[0_8px_28px_rgba(51,78,124,0.07)]">
      <CardHeader className="px-4 pb-1 pt-4">
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="text-base">终版附件归档</CardTitle>
          <FolderSync className="h-5 w-5 text-teal-500" />
        </div>
      </CardHeader>
      <CardContent className="space-y-1 px-4 pb-3">
        {periods.length ? (
          periods.map(([key, items]) => {
            const archived = items.reduce(
              (sum, item) => sum + item.archivedAttachmentCount,
              0,
            );
            const total = items.reduce(
              (sum, item) => sum + item.finalAttachmentCount,
              0,
            );
            const status = items.some((item) => item.archiveStatus === 'error')
              ? 'error'
              : items.every((item) => item.archiveStatus === 'archived')
                ? 'archived'
                : 'syncing';
            return (
              <button
                key={key}
                type="button"
                onClick={onOpen}
                className={cn(
                  'flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1 text-left transition hover:bg-slate-50',
                  key === selectedPeriodKey && 'bg-blue-50/60',
                )}
              >
                <span className="text-xs font-medium text-slate-600">
                  {formatPeriodLabel(key)}
                </span>
                <span className="text-[11px] text-slate-500">
                  已归档 {archived} / {total}
                </span>
                <ArchiveStatusBadge status={status} />
              </button>
            );
          })
        ) : (
          <p className="py-3 text-center text-sm text-slate-400">
            暂无终版附件
          </p>
        )}
        <Button
          variant="ghost"
          size="sm"
          className="mt-0.5 h-7 w-full text-blue-600"
          onClick={onOpen}
        >
          查看归档明细
          <ChevronRight className="h-4 w-4" />
        </Button>
        <div className="flex flex-wrap items-center gap-3 border-t border-slate-100 pt-1.5 text-[10px] text-slate-400">
          <span className="inline-flex items-center gap-1">
            <i className="h-1.5 w-1.5 rounded-full bg-teal-500" />
            已归档
          </span>
          <span className="inline-flex items-center gap-1">
            <i className="h-1.5 w-1.5 rounded-full bg-orange-400" />
            归档中
          </span>
          <span className="inline-flex items-center gap-1">
            <i className="h-1.5 w-1.5 rounded-full bg-rose-400" />
            归档失败
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

export function ArchiveAttachmentActions({
  item,
  canDownload,
  canRetry,
  onRefresh,
  onRequireLogin,
}: {
  item: SystemMonthlyReportHistoryItem;
  canDownload: boolean;
  canRetry: boolean;
  onRefresh: () => void;
  onRequireLogin: () => void;
}) {
  const access = useAccess();
  canDownload = canDownload && canUsePageAction(access, 'system_reports', 'export', true);
  canRetry = canRetry && canUsePageAction(access, 'system_reports', 'update', true);
  const [busyId, setBusyId] = useState('');
  const [error, setError] = useState('');
  const attachment = item.attachments[0];
  if (!canDownload)
    return (
      <Button
        size="sm"
        variant="ghost"
        className="text-blue-600"
        onClick={onRequireLogin}
      >
        登录下载
      </Button>
    );
  if (!attachment)
    return <span className="text-xs text-slate-400">附件信息已裁剪</span>;
  const run = async (action: 'download' | 'retry') => {
    if (action === 'download' ? !canDownload : !canRetry) return;
    setBusyId(attachment.id);
    setError('');
    try {
      if (action === 'download') {
        const result = await getSystemMonthlyReportArchiveDownloadUrl(
          attachment.id,
        );
        window.location.assign(result.url);
      } else {
        await retrySystemMonthlyReportArchive(attachment.id);
        onRefresh();
      }
    } catch {
      setError('操作失败，请稍后重试');
    } finally {
      setBusyId('');
    }
  };
  const action =
    attachment.status === 'archived' ? (
      <Button
        size="sm"
        variant="ghost"
        className="text-blue-600"
        disabled={busyId === attachment.id}
        onClick={() => void run('download')}
      >
        {busyId ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Download className="h-4 w-4" />
        )}
        下载
      </Button>
    ) : attachment.status === 'error' && canRetry ? (
      <Button
        size="sm"
        variant="outline"
        className="border-rose-200 text-rose-600"
        disabled={busyId === attachment.id}
        onClick={() => void run('retry')}
      >
        {busyId ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <RefreshCw className="h-4 w-4" />
        )}
        重试归档
      </Button>
    ) : attachment.status === 'error' ? (
      <span className="text-xs text-rose-500">请联系管理员重试</span>
    ) : (
      <span className="inline-flex items-center gap-1 text-xs text-orange-500">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        归档中
      </span>
    );
  return (
    <div className="inline-flex flex-col items-end gap-1">
      {action}
      {error ? (
        <span
          role="alert"
          className="max-w-48 text-right text-[10px] text-rose-500"
        >
          {error}
        </span>
      ) : null}
    </div>
  );
}

function OverviewDrilldownDialog({
  value,
  onOpenChange,
  snapshot,
  history,
  todos,
  tasks,
  onTodoAction: handleTodoAction,
}: {
  value: Drilldown;
  onOpenChange: (open: boolean) => void;
  snapshot: SystemMonthlyReportDashboard['monthlySnapshots'][number];
  history: SystemMonthlyReportHistoryItem[];
  todos: SystemMonthlyReportPersonalTodo[];
  tasks: Record<string, SystemMonthlyReportTask>;
  onTodoAction: (room: SystemMonthlyReportRoom) => void;
}) {
  const list =
    value?.kind === 'stage'
      ? buildSystemMonthlyReportStageDrilldownRows(snapshot, value.key)
      : [];
  return (
    <Dialog open={Boolean(value)} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[80vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{value?.label || '明细'}</DialogTitle>
          <DialogDescription className="sr-only">
            {value?.label || '月报'}机房明细
          </DialogDescription>
        </DialogHeader>
        {value?.kind === 'todo' ? (
          todos.length ? (
            <>
              <div className="hidden overflow-hidden rounded-lg border border-slate-200 sm:block">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-slate-50">
                      <TableHead>机房</TableHead>
                      <TableHead>待办项目</TableHead>
                      <TableHead>处理状态</TableHead>
                      <TableHead className="text-right">操作</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {todos.map((item) => {
                      const task = tasks[item.room.recordId];
                      const busy = Boolean(
                        task && ['accepted', 'syncing'].includes(task.status),
                      );
                      return (
                        <TableRow key={item.room.recordId}>
                          <TableCell className="font-medium text-slate-800">
                            {item.room.room}
                          </TableCell>
                          <TableCell>{item.action.label}</TableCell>
                          <TableCell>
                            {task ? (
                              <TaskPill task={task} />
                            ) : (
                              <Badge
                                variant="outline"
                                className="border-orange-100 bg-orange-50 text-orange-700"
                              >
                                待处理
                              </Badge>
                            )}
                          </TableCell>
                          <TableCell className="text-right">
                            <Button
                              type="button"
                              size="sm"
                              disabled={busy}
                              onClick={() => handleTodoAction(item.room)}
                            >
                              {busy ? '处理中' : item.action.label}
                            </Button>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
              <div className="space-y-3 sm:hidden">
                {todos.map((item) => {
                  const task = tasks[item.room.recordId];
                  const busy = Boolean(
                    task && ['accepted', 'syncing'].includes(task.status),
                  );
                  return (
                    <div
                      key={item.room.recordId}
                      className="rounded-lg border border-slate-200 p-4"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="font-medium text-slate-900">
                            {item.room.room}
                          </p>
                          <p className="mt-1 text-sm text-slate-600">
                            {item.action.label}
                          </p>
                        </div>
                        {task ? <TaskPill task={task} /> : null}
                      </div>
                      <Button
                        type="button"
                        size="sm"
                        className="mt-4 w-full"
                        disabled={busy}
                        onClick={() => handleTodoAction(item.room)}
                      >
                        {busy ? '处理中' : item.action.label}
                      </Button>
                    </div>
                  );
                })}
              </div>
            </>
          ) : (
            <CompactEmpty
              icon={ListTodo}
              title="当前没有需要你处理的月报任务"
            />
          )
        ) : value?.kind === 'stage' ? (
          <div className="overflow-hidden rounded-lg border border-slate-200">
            <Table>
              <TableHeader>
                <TableRow className="bg-slate-50">
                  <TableHead>机房</TableHead>
                  <TableHead>完成状态</TableHead>
                  <TableHead>完成时间</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.map((item) => (
                  <TableRow key={item.room}>
                    <TableCell className="font-medium text-slate-800">
                      {item.room}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant="outline"
                        className={
                          item.completed
                            ? 'border-teal-100 bg-teal-50 text-teal-700'
                            : 'border-orange-100 bg-orange-50 text-orange-700'
                        }
                      >
                        {item.completed ? '已完成' : '未完成'}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-slate-500">
                      {item.completed
                        ? item.completedAt
                          ? formatDateTime(item.completedAt)
                          : '时间未记录'
                        : '—'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {list.length ? null : (
              <CompactEmpty icon={History} title="该月份暂无机房阶段明细" />
            )}
          </div>
        ) : (
          <div className="space-y-2">
            {history.length ? (
              history.map((item) => (
                <div
                  key={item.recordId}
                  className="flex items-center justify-between rounded-lg border border-slate-200 px-4 py-3"
                >
                  <div>
                    <p className="font-medium text-slate-800">{item.room}</p>
                    <p className="mt-1 text-xs text-slate-400">
                      {formatDateTime(item.finalSubmittedAt)} ·{' '}
                      {item.finalAttachmentCount} 个终版附件
                    </p>
                  </div>
                  <ArchiveStatusBadge status={item.archiveStatus} />
                </div>
              ))
            ) : (
              <CompactEmpty icon={Archive} title="该月份暂无终版归档" />
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function StageTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  const row = payload[0]?.payload;
  return (
    <div className="rounded-lg border border-slate-200 bg-white/95 px-3 py-2 text-xs shadow-lg">
      <p className="mb-1 font-semibold text-slate-700">{label}</p>
      <p className="text-teal-600">已完成：{row.completed}</p>
      <p className="text-slate-500">待完成：{row.pending}</p>
      <p className="text-blue-600">完成率：{row.completionRate}%</p>
    </div>
  );
}
function StatusPill({
  status,
  label,
}: {
  status: SystemMonthlyReportRoom['status'];
  label: string;
}) {
  return (
    <Badge
      variant="outline"
      className={cn(
        'whitespace-nowrap text-[11px]',
        status === 'completed' && 'border-teal-100 bg-teal-50 text-teal-600',
        status.includes('review') && 'border-blue-100 bg-blue-50 text-blue-600',
        status.includes('pending') &&
          'border-orange-100 bg-orange-50 text-orange-600',
      )}
    >
      {label}
    </Badge>
  );
}
function TaskPill({ task }: { task: SystemMonthlyReportTask }) {
  const presentation = getSystemMonthlyReportTaskPresentation(task);
  return (
    <Badge
      variant="outline"
      className="border-blue-100 bg-blue-50 text-[10px] text-blue-600"
    >
      {presentation.busy ? (
        <Loader2 className="mr-1 h-3 w-3 animate-spin" />
      ) : null}
      {presentation.label}
    </Badge>
  );
}
function ArchiveStatusBadge({
  status,
}: {
  status: SystemMonthlyReportHistoryItem['archiveStatus'];
}) {
  const copy =
    status === 'archived'
      ? '已归档'
      : status === 'error'
        ? '归档失败'
        : status === 'syncing'
          ? '归档中'
          : '待归档';
  return (
    <Badge
      variant="outline"
      className={cn(
        'whitespace-nowrap text-[10px]',
        status === 'archived' && 'border-teal-100 bg-teal-50 text-teal-600',
        status === 'error' && 'border-rose-100 bg-rose-50 text-rose-600',
        ['pending', 'syncing'].includes(status) &&
          'border-orange-100 bg-orange-50 text-orange-600',
      )}
    >
      {copy}
    </Badge>
  );
}
function CompactEmpty({
  icon: Icon,
  title,
}: {
  icon: typeof Archive;
  title: string;
}) {
  return (
    <div className="flex min-h-36 flex-col items-center justify-center p-6 text-center">
      <Icon className="h-8 w-8 text-slate-300" />
      <p className="mt-2 text-sm text-slate-500">{title}</p>
    </div>
  );
}
function formatPeriodLabel(value: string): string {
  const [year, month] = value.split('-');
  return `${year}年${Number(month)}月`;
}
function formatShortDate(value: string | null): string {
  if (!value) return '日期待更新';
  const date = new Date(`${value}T00:00:00+08:00`);
  const weekday = new Intl.DateTimeFormat('zh-CN', {
    weekday: 'short',
    timeZone: 'Asia/Shanghai',
  }).format(date);
  return `${value.slice(5)} ${weekday}`;
}
function formatDateTime(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
        timeZone: 'Asia/Shanghai',
      }).format(date);
}
function todayKey(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}
