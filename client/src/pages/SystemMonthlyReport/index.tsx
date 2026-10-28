import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  AlertCircle,
  CalendarDays,
  CheckCircle2,
  ChevronRight,
  CircleDot,
  ClipboardCheck,
  Clock3,
  FileArchive,
  FileCheck2,
  FileClock,
  FileSpreadsheet,
  History,
  Loader2,
  LogOut,
  UploadCloud,
  UserRound,
  UserRoundCheck,
  UsersRound,
} from 'lucide-react';
import type {
  SystemMonthlyReportDashboard,
  SystemMonthlyReportHistoryItem,
  SystemMonthlyReportIdentityOption,
  SystemMonthlyReportIdentitySessionResponse,
  SystemMonthlyReportPackageTask,
  SystemMonthlyReportReviewRound,
  SystemMonthlyReportRoom,
  SystemMonthlyReportStage,
  SystemMonthlyReportSubmissionOperation,
  SystemMonthlyReportTask,
} from '@shared/system-monthly-report.interface';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';
import { ManagementHeader } from '../PurchaseInventoryManagement/ManagementHeader';
import {
  getSystemMonthlyReportDashboard,
  getSystemMonthlyReportIdentityDirectory,
  getSystemMonthlyReportIdentitySession,
  getSystemMonthlyReportTask,
  createSystemMonthlyReportPackage,
  deleteSystemMonthlyReportStage,
  getSystemMonthlyReportPackageDownloadUrl,
  getSystemMonthlyReportPackageTask,
  retrySystemMonthlyReportPackage,
  logoutSystemMonthlyReportIdentity,
  selectSystemMonthlyReportIdentity,
} from './api';
import { PersonIdentityGate } from './PersonIdentityGate';
import { useAccess } from '@/access/AccessProvider';
import { canUsePageAction } from '../business-action-access';
import { hasAuthenticatedAccessIdentity } from '@/access/access-policy';
import { resolveSelfServiceApplicant } from '@shared/self-service-applicant';
import { ReviewWorkbench } from './ReviewWorkbench';
import { SubmissionDialog } from './SubmissionDialog';
import { SubmissionLauncherDialog } from './SubmissionLauncherDialog';
import { ReviewOpinionsView } from './ReviewOpinionsView';
import { MonthlyPackageDialog } from './MonthlyPackageDialog';
import { FinalReportAttachmentViewer } from './FinalReportAttachmentViewer';
import {
  OverviewDashboard,
  ArchiveAttachmentActions,
  SystemMonthlyReportPeriodNavigator,
} from './OverviewDashboard';
import {
  buildSystemMonthlyReportPackagePeriodOptions,
  systemMonthlyReportPeriodKey,
} from './overview.logic';
import {
  getSystemMonthlyReportAuthorizedAction,
  getSystemMonthlyReportTaskPresentation,
  shouldCommitSystemMonthlyReportResponse,
} from './system-monthly-report.logic';

type PageTab = 'overview' | 'submissions' | 'reviews' | 'schedule' | 'history';

const TASK_STORAGE_KEY = 'system-monthly-report:task-ids';
const AUTO_REFRESH_MS = 5 * 60 * 1000;

export default function SystemMonthlyReportPage() {
  const access = useAccess();
  const allowCreate = canUsePageAction(access, 'system_reports', 'create', true);
  const allowApprove = canUsePageAction(access, 'system_reports', 'approve', true);
  const allowDelete = canUsePageAction(access, 'system_reports', 'delete', true);
  const allowUpdate = canUsePageAction(access, 'system_reports', 'update', true);
  const allowExport = canUsePageAction(access, 'system_reports', 'export', true);
  const allowRefresh = canUsePageAction(access, 'system_reports', 'refresh', true);
  const applicant = useMemo(() => resolveSelfServiceApplicant(access, hasAuthenticatedAccessIdentity(access), '进入体系月报'),
    [access.role, access.accountId, access.displayName, access.expiresAt, access.principalFingerprint]);
  const personalIdentity = applicant.mode === 'automatic';
  const identityScope = `${access.accountId || ''}:${access.principalFingerprint || ''}:${access.role}:${access.displayName || ''}`;
  const identityScopeRef = useRef(identityScope);
  const [identitySession, setIdentitySession] =
    useState<SystemMonthlyReportIdentitySessionResponse | null>(null);
  const [identityOptions, setIdentityOptions] = useState<
    SystemMonthlyReportIdentityOption[]
  >([]);
  const [identityLoading, setIdentityLoading] = useState(true);
  const [identityAcceptingId, setIdentityAcceptingId] = useState('');
  const [identityError, setIdentityError] = useState('');
  const [dashboard, setDashboard] =
    useState<SystemMonthlyReportDashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<PageTab>('overview');
  const [selectedPeriodKey, setSelectedPeriodKey] = useState('');
  const [detailRoom, setDetailRoom] = useState<SystemMonthlyReportRoom | null>(
    null,
  );
  const [submission, setSubmission] = useState<{
    room: SystemMonthlyReportRoom;
    stage: SystemMonthlyReportStage;
    operation: SystemMonthlyReportSubmissionOperation;
  } | null>(null);
  const [submissionLauncherOpen, setSubmissionLauncherOpen] = useState(false);
  const [packageOpen, setPackageOpen] = useState(false);
  const [packageAccepting, setPackageAccepting] = useState(false);
  const [packageTask, setPackageTask] =
    useState<SystemMonthlyReportPackageTask | null>(null);
  const [packageError, setPackageError] = useState('');
  const [packagePeriodKey, setPackagePeriodKey] = useState('');
  const [review, setReview] = useState<{
    room: SystemMonthlyReportRoom;
    round: SystemMonthlyReportReviewRound;
  } | null>(null);
  const [tasks, setTasks] = useState<Record<string, SystemMonthlyReportTask>>(
    {},
  );
  const requestIdRef = useRef(0);
  if (identityScopeRef.current !== identityScope) {
    identityScopeRef.current = identityScope;
    requestIdRef.current += 1;
  }
  const dashboardRef = useRef<SystemMonthlyReportDashboard | null>(null);
  const packageStartRef = useRef(false);
  const packageMutationRef = useRef({ periodKey: '', id: '' });
  const exportedPackageIdsRef = useRef(new Set<string>());
  const backgroundRefreshIdentityRef = useRef('');
  const packagePeriods = useMemo(
    () =>
      dashboard ? buildSystemMonthlyReportPackagePeriodOptions(dashboard) : [],
    [dashboard],
  );
  const canForceRefresh = allowRefresh && dashboard?.viewer?.canForceRefresh === true;
  const canPackage = allowExport && dashboard?.viewer?.canPackage === true;
  const canSubmit =
    allowCreate && dashboard?.period.editable === true &&
    dashboard.rooms.some((room) => room.access?.canSubmit);
  const canDownload =
    allowExport && dashboard?.rooms.some((room) => room.access?.canDownload) === true;
  const activePeriodKey = dashboard
    ? selectedPeriodKey ||
      systemMonthlyReportPeriodKey(
        dashboard.period.year,
        dashboard.period.month,
      )
    : '';
  const detailHistory = useMemo(
    () =>
      dashboard && detailRoom
        ? dashboard.history.find(
            (item) =>
              item.room === detailRoom.room &&
              systemMonthlyReportPeriodKey(item.year, item.month) ===
                activePeriodKey,
          ) || null
        : null,
    [activePeriodKey, dashboard, detailRoom],
  );

  const loadIdentity = useCallback(async () => {
    const scope = identityScope;
    setIdentityLoading(true);
    setIdentityError('');
    try {
      const session = await getSystemMonthlyReportIdentitySession();
      if (scope !== identityScopeRef.current) return;
      setIdentitySession(session);
      if (session.selected) {
        setIdentityOptions([]);
      } else if (!personalIdentity) {
        const directory = await getSystemMonthlyReportIdentityDirectory();
        if (scope !== identityScopeRef.current) return;
        setIdentityOptions(directory.identities);
      } else {
        setIdentityError('登录本人尚未匹配到月报人员，请联系管理员核对');
      }
    } catch (identityFailure) {
      if (scope !== identityScopeRef.current) return;
      setIdentityError(
        readErrorMessage(identityFailure, '人员读取失败，请重试。'),
      );
      setIdentitySession({
        selected: false,
        mode: 'none',
        person: null,
        expiresAt: null,
      });
    } finally {
      if (scope === identityScopeRef.current) setIdentityLoading(false);
    }
  }, [identityScope, personalIdentity]);

  useEffect(() => {
    setIdentitySession(null);
    setIdentityOptions([]);
    dashboardRef.current = null;
    setDashboard(null);
    setTasks({});
    setSubmission(null);
    setReview(null);
    setDetailRoom(null);
    setPackageTask(null);
    setSubmissionLauncherOpen(false);
    setPackageOpen(false);
    backgroundRefreshIdentityRef.current = '';
    if (access.isLoading) return;
    void loadIdentity();
  }, [loadIdentity, access.isLoading]);

  const loadDashboard = useCallback(async (forceRefresh = false) => {
    forceRefresh = forceRefresh && allowRefresh;
    const requestId = ++requestIdRef.current;
    const scope = identityScopeRef.current;
    if (forceRefresh) setRefreshing(true);
    else if (!dashboardRef.current) setLoading(true);
    try {
      const loaded = await getSystemMonthlyReportDashboard(forceRefresh);
      const next = { ...loaded, rooms: loaded.rooms.map(room => ({ ...room, access: room.access ? { ...room.access, canSubmit: room.access.canSubmit && allowCreate, canDownload: room.access.canDownload && allowExport, reviewRounds: allowApprove ? room.access.reviewRounds : [] } : room.access })) };
      if (scope !== identityScopeRef.current) return;
      if (
        !shouldCommitSystemMonthlyReportResponse(
          requestIdRef.current,
          requestId,
        )
      )
        return;
      dashboardRef.current = next;
      setDashboard(next);
      setError('');
    } catch (loadError) {
      if (scope !== identityScopeRef.current) return;
      if (
        !shouldCommitSystemMonthlyReportResponse(
          requestIdRef.current,
          requestId,
        )
      )
        return;
      setError(
        readErrorMessage(loadError, '体系月报数据读取失败，请稍后重试。'),
      );
    } finally {
      if (
        shouldCommitSystemMonthlyReportResponse(requestIdRef.current, requestId)
      ) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [allowRefresh, allowCreate, allowExport, allowApprove]);

  useEffect(() => {
    if (!identitySession?.selected) return;
    void loadDashboard();
    const timer = window.setInterval(
      () => void loadDashboard(),
      AUTO_REFRESH_MS,
    );
    return () => window.clearInterval(timer);
  }, [identitySession?.selected, identitySession?.person?.id, loadDashboard]);

  useEffect(() => {
    if (!identitySession?.selected || !canForceRefresh || !dashboard) return;
    const identityKey = `${identitySession.mode}:${identitySession.person?.id || 'privileged'}`;
    if (backgroundRefreshIdentityRef.current === identityKey) return;
    backgroundRefreshIdentityRef.current = identityKey;
    void loadDashboard(true);
  }, [canForceRefresh, dashboard, identitySession, loadDashboard]);

  useEffect(() => {
    if (!identitySession?.selected) return;
    const taskIds = readStoredTaskIds();
    if (!taskIds.length) return;
    const scope = identityScope;
    void Promise.allSettled(
      taskIds.map((taskId) => getSystemMonthlyReportTask(taskId)),
    ).then((results) => {
      if (scope !== identityScopeRef.current) return;
      const restored: Record<string, SystemMonthlyReportTask> = {};
      for (const result of results) {
        if (result.status === 'fulfilled')
          restored[result.value.targetRecordId] = result.value;
      }
      setTasks(restored);
    });
  }, [identitySession?.selected, identitySession?.person?.id, identityScope]);

  const busyTaskIds = Object.values(tasks)
    .filter((task) => ['accepted', 'syncing'].includes(task.status))
    .map((task) => task.id)
    .sort()
    .join('|');

  useEffect(() => {
    if (!busyTaskIds) return;
    let disposed = false;
    const scope = identityScope;
    const poll = async () => {
      const results = await Promise.allSettled(
        busyTaskIds
          .split('|')
          .map((taskId) => getSystemMonthlyReportTask(taskId)),
      );
      if (disposed || scope !== identityScopeRef.current) return;
      let completed = false;
      setTasks((current) => {
        const next = { ...current };
        for (const result of results) {
          if (result.status !== 'fulfilled') continue;
          const previous = next[result.value.targetRecordId];
          next[result.value.targetRecordId] = result.value;
          if (
            previous?.status !== 'success' &&
            result.value.status === 'success'
          )
            completed = true;
        }
        return next;
      });
      if (completed) void loadDashboard(canForceRefresh);
    };
    void poll();
    const timer = window.setInterval(poll, 1800);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [busyTaskIds, canForceRefresh, loadDashboard, identityScope]);

  const handleTaskChange = useCallback((task: SystemMonthlyReportTask) => {
    if (identityScope !== identityScopeRef.current) return;
    setTasks((current) => ({ ...current, [task.targetRecordId]: task }));
    storeTaskId(task.id);
  }, [identityScope]);

  const handleSynced = useCallback(() => {
    void loadDashboard(canForceRefresh);
  }, [canForceRefresh, loadDashboard]);

  const openSubmission = (
    room: SystemMonthlyReportRoom,
    stage: SystemMonthlyReportStage,
    operation: SystemMonthlyReportSubmissionOperation,
  ) => {
    if (!allowCreate || !room.access?.canSubmit) return;
    setTasks((current) => {
      const next = { ...current };
      delete next[room.recordId];
      return next;
    });
    setSubmission({ room, stage, operation });
  };

  const deleteSubmission = async (
    room: SystemMonthlyReportRoom,
    stage: SystemMonthlyReportStage,
  ) => {
    if (!allowDelete || !dashboard) return;
    const response = await deleteSystemMonthlyReportStage({
      clientMutationId: crypto.randomUUID(),
      currentRecordId: room.recordId,
      room: room.room,
      stage,
      reportYear: dashboard.period.year,
      reportMonth: dashboard.period.month,
    });
    handleTaskChange(response.task);
  };

  useEffect(() => {
    if (
      !packageTask ||
      !['accepted', 'packaging', 'uploading', 'notifying'].includes(
        packageTask.status,
      )
    )
      return;
    let disposed = false;
    const poll = async () => {
      try {
        const next = await getSystemMonthlyReportPackageTask(packageTask.id);
        if (!disposed) setPackageTask(next);
      } catch (pollError) {
        if (!disposed)
          setPackageError(
            readErrorMessage(pollError, '打包任务状态读取失败。'),
          );
      }
    };
    const timer = window.setInterval(() => void poll(), 1800);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [packageTask?.id, packageTask?.status]);

  const downloadPackage = useCallback(async (taskId: string) => {
    if (!allowExport) return;
    setPackageError('');
    try {
      const result = await getSystemMonthlyReportPackageDownloadUrl(taskId);
      window.location.assign(result.url);
    } catch (downloadError) {
      setPackageError(
        readErrorMessage(
          downloadError,
          '压缩包下载失败，请点击“下载 ZIP”重试。',
        ),
      );
    }
  }, [allowExport]);

  useEffect(() => {
    if (
      !packageTask?.packageReady ||
      exportedPackageIdsRef.current.has(packageTask.id)
    )
      return;
    exportedPackageIdsRef.current.add(packageTask.id);
    void downloadPackage(packageTask.id);
  }, [downloadPackage, packageTask?.id, packageTask?.packageReady]);

  const normalizedPackagePeriod = (periodKey: string) => {
    const fallbackPeriod = packagePeriods[0]?.value || periodKey;
    return packagePeriods.some((item) => item.value === periodKey)
      ? periodKey
      : fallbackPeriod;
  };

  const acceptPackage = async (periodKey: string) => {
    if (!canPackage) return;
    if (packageStartRef.current) return;
    const [year, month] = periodKey.split('-').map(Number);
    if (!year || !month) {
      setPackageError('请选择需要打包的月份。');
      return;
    }
    packageStartRef.current = true;
    if (packageMutationRef.current.periodKey !== periodKey) {
      packageMutationRef.current = {
        periodKey,
        id: crypto.randomUUID(),
      };
    }
    setPackageAccepting(true);
    setPackageError('');
    try {
      setPackageTask(
        await createSystemMonthlyReportPackage({
          clientMutationId: packageMutationRef.current.id,
          year,
          month,
        }),
      );
    } catch (packageFailure) {
      setPackageError(
        readErrorMessage(packageFailure, '打包任务未受理，请稍后重试。'),
      );
    } finally {
      packageStartRef.current = false;
      setPackageAccepting(false);
    }
  };

  const startOneClickPackage = (periodKey: string) => {
    if (!canPackage) return;
    const targetPeriod = normalizedPackagePeriod(periodKey);
    if (
      packageTask &&
      `${packageTask.year}-${String(packageTask.month).padStart(2, '0')}` ===
        targetPeriod
    ) {
      setPackageOpen(true);
      return;
    }
    setPackagePeriodKey(targetPeriod);
    setPackageTask(null);
    setPackageError('');
    setPackageOpen(true);
    void acceptPackage(targetPeriod);
  };

  const openPrimaryAction = (room: SystemMonthlyReportRoom) => {
    const action = getSystemMonthlyReportAuthorizedAction(room);
    if (!action) {
      setDetailRoom(room);
      return;
    }
    if (action.kind === 'submit') openSubmission(room, action.stage, 'create');
    else setReview({ room, round: action.round });
  };

  const handleIdentitySelect = async (personId: string) => {
    setIdentityAcceptingId(personId);
    setIdentityError('');
    try {
      const session = await selectSystemMonthlyReportIdentity(personId);
      clearStoredTaskIds();
      backgroundRefreshIdentityRef.current = '';
      setTasks({});
      dashboardRef.current = null;
      setDashboard(null);
      setIdentitySession(session);
      setIdentityOptions([]);
    } catch (selectFailure) {
      setIdentityError(
        readErrorMessage(selectFailure, '人员选择失败，请重试。'),
      );
    } finally {
      setIdentityAcceptingId('');
    }
  };

  const handleIdentityLogout = async () => {
    try {
      const session = await logoutSystemMonthlyReportIdentity();
      clearStoredTaskIds();
      backgroundRefreshIdentityRef.current = '';
      setTasks({});
      dashboardRef.current = null;
      setDashboard(null);
      setIdentitySession(session);
      await loadIdentity();
    } catch (logoutFailure) {
      setError(readErrorMessage(logoutFailure, '人员切换失败，请重试。'));
    }
  };

  if (!identitySession?.selected) {
    if (personalIdentity) {
      return <div className="mx-auto max-w-xl space-y-4 px-4 py-10">
        <h1 className="text-xl font-semibold">体系月报</h1>
        <p>{applicant.name}</p>
        {identityLoading ? <p role="status">正在匹配月报人员</p> : (
          <Alert variant="destructive"><AlertDescription>
            <span role="alert">{identityError || '登录本人尚未匹配到月报人员'}</span>
            <Button className="mt-3" variant="outline" onClick={() => void loadIdentity()}>重试</Button>
          </AlertDescription></Alert>
        )}
      </div>;
    }
    return (
      <PersonIdentityGate
        identities={identityOptions}
        loading={identityLoading}
        acceptingId={identityAcceptingId}
        error={identityError}
        onReload={() => void loadIdentity()}
        onSelect={(personId) => void handleIdentitySelect(personId)}
      />
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-[#eef4ff] via-[#f8fbff] to-[#eef5ff] text-slate-900">
      <ManagementHeader
        activePage="monthly-report"
        title="南通全景运维平台 · 体系月报"
        subtitle="月报提交、分轮审核、进展跟踪与审核排班协同"
        toolbarLabel="体系月报页面工具栏"
        showSearch={false}
        tone="soft"
        sourceLabel="华东1部分机房月报"
        updatedAt={
          dashboard ? formatDateTime(dashboard.sourceUpdatedAt) : '读取中'
        }
        refreshing={refreshing}
        onRefresh={() => void loadDashboard(canForceRefresh)}
        actions={
          <div className="flex items-center gap-2">
            {personalIdentity ? (
              <span className="flex h-11 items-center gap-2 px-3 text-white"><UserRound className="h-4 w-4" />{applicant.name}</span>
            ) : identitySession.mode === 'person' ? (
              <Button
                type="button"
                variant="outline"
                className="h-11 border-white/30 bg-white/10 text-white hover:bg-white/20 hover:text-white"
                onClick={() => void handleIdentityLogout()}
              >
                <UserRound className="h-4 w-4" />
                {identitySession.person?.name}
                <LogOut className="h-4 w-4" />
              </Button>
            ) : null}
            {canSubmit ? (
              <Button
                type="button"
                className="h-11 border border-white/30 bg-white text-blue-700 hover:bg-blue-50"
                onClick={() => setSubmissionLauncherOpen(true)}
              >
                <UploadCloud className="h-4 w-4" />
                提交月报
              </Button>
            ) : null}
          </div>
        }
      />

      <main className="mx-auto w-full max-w-[1920px] space-y-5 px-4 py-5 md:px-8 md:py-7">
        {error ? (
          <Alert variant="destructive" className="border-rose-200 bg-rose-50">
            <AlertCircle />
            <AlertTitle>数据读取异常</AlertTitle>
            <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
              <span>{error}</span>
              <Button
                size="sm"
                variant="outline"
                onClick={() => void loadDashboard(false)}
              >
                重新加载
              </Button>
            </AlertDescription>
          </Alert>
        ) : null}

        {dashboard?.stale ? (
          <Alert className="border-amber-200 bg-amber-50 text-amber-900">
            <Clock3 />
            <AlertTitle>数据更新暂缓</AlertTitle>
            <AlertDescription>当前显示最近一次可用数据。</AlertDescription>
          </Alert>
        ) : null}

        <Tabs
          value={tab}
          onValueChange={(value) => setTab(value as PageTab)}
          className="gap-5"
        >
          <div className="flex flex-col gap-2 overflow-x-auto rounded-lg border border-slate-200 bg-white p-1 shadow-sm [scrollbar-width:none] [&::-webkit-scrollbar]:hidden lg:flex-row lg:items-center lg:justify-between">
            <TabsList className="h-11 min-w-max bg-transparent p-0">
              <Tab value="overview" icon={<CircleDot />}>
                总览
              </Tab>
              <Tab value="submissions" icon={<FileClock />}>
                审核意见
              </Tab>
              <Tab value="reviews" icon={<ClipboardCheck />}>
                审核任务
              </Tab>
              <Tab value="schedule" icon={<CalendarDays />}>
                审核排班
              </Tab>
              <Tab value="history" icon={<History />}>
                历史月报
              </Tab>
            </TabsList>
            {dashboard ? (
              <SystemMonthlyReportPeriodNavigator
                dashboard={dashboard}
                selectedPeriodKey={
                  selectedPeriodKey ||
                  systemMonthlyReportPeriodKey(
                    dashboard.period.year,
                    dashboard.period.month,
                  )
                }
                onChange={(value) => {
                  setSelectedPeriodKey(value);
                  setTab('overview');
                }}
                onOpenHistory={() => setTab('history')}
                onPackage={canPackage ? startOneClickPackage : undefined}
              />
            ) : null}
          </div>

          {loading && !dashboard ? (
            <DashboardSkeleton />
          ) : dashboard ? (
            <>
              <TabsContent value="overview" className="mt-0 space-y-5">
                <OverviewDashboard
                  dashboard={dashboard}
                  selectedPeriodKey={
                    selectedPeriodKey ||
                    systemMonthlyReportPeriodKey(
                      dashboard.period.year,
                      dashboard.period.month,
                    )
                  }
                  filteredRooms={dashboard.rooms}
                  tasks={tasks}
                  canWrite={canPackage}
                  canDownload={canDownload}
                  onPrimaryAction={openPrimaryAction}
                  onRoomDetail={setDetailRoom}
                  onRefresh={() => void loadDashboard(canForceRefresh)}
                  onRequireLogin={() => undefined}
                />
                {dashboard.warnings.map((warning) => (
                  <Alert
                    key={warning}
                    className="border-amber-200 bg-amber-50 text-amber-900"
                  >
                    <Clock3 />
                    <AlertTitle>数据提示</AlertTitle>
                    <AlertDescription>{warning}</AlertDescription>
                  </Alert>
                ))}
              </TabsContent>

              <TabsContent value="submissions" className="mt-0">
                <ReviewOpinionsView
                  dashboard={dashboard}
                  selectedPeriodKey={
                    selectedPeriodKey ||
                    systemMonthlyReportPeriodKey(
                      dashboard.period.year,
                      dashboard.period.month,
                    )
                  }
                />
              </TabsContent>

              <TabsContent value="reviews" className="mt-0">
                <ReviewTaskView
                  rooms={dashboard.rooms}
                  tasks={tasks}
                  onReview={openPrimaryAction}
                />
              </TabsContent>

              <TabsContent value="schedule" className="mt-0">
                <ScheduleView dashboard={dashboard} />
              </TabsContent>

              <TabsContent value="history" className="mt-0">
                <HistoryView
                  history={dashboard.history}
                  query=""
                  canDownload={canDownload}
                  canRetry={canPackage}
                  onRefresh={() => void loadDashboard(canForceRefresh)}
                  onRequireLogin={() => undefined}
                />
              </TabsContent>
            </>
          ) : null}
        </Tabs>
      </main>

      <SubmissionDialog
        open={Boolean(submission)}
        room={submission?.room || null}
        stage={submission?.stage || 'initial'}
        operation={submission?.operation || 'create'}
        task={submission ? tasks[submission.room.recordId] || null : null}
        reportYear={dashboard?.period.year || new Date().getFullYear()}
        reportMonth={dashboard?.period.month || new Date().getMonth() + 1}
        onOpenChange={(open) => !open && setSubmission(null)}
        onTaskChange={handleTaskChange}
        onSynced={handleSynced}
      />
      <SubmissionLauncherDialog
        open={submissionLauncherOpen}
        rooms={dashboard?.rooms || []}
        periodLabel={dashboard?.period.label || '当前体系月报'}
        editable={dashboard?.period.editable === true}
        onOpenChange={setSubmissionLauncherOpen}
        onSelect={(room, stage, operation) => {
          setSubmissionLauncherOpen(false);
          openSubmission(room, stage, operation);
        }}
        onDelete={deleteSubmission}
      />
      <MonthlyPackageDialog
        open={packageOpen}
        accepting={packageAccepting}
        task={packageTask}
        error={packageError}
        periods={packagePeriods}
        selectedPeriodKey={packagePeriodKey}
        onOpenChange={setPackageOpen}
        onPeriodChange={(periodKey) => {
          setPackagePeriodKey(periodKey);
          setPackageError('');
        }}
        onStart={() => void acceptPackage(packagePeriodKey)}
        onRetry={() =>
          allowUpdate &&
          packageTask &&
          void retrySystemMonthlyReportPackage(packageTask.id)
            .then(setPackageTask)
            .catch((retryError) =>
              setPackageError(
                readErrorMessage(retryError, '打包任务重试失败。'),
              ),
            )
        }
        onDownload={() => packageTask && void downloadPackage(packageTask.id)}
      />
      <ReviewWorkbench
        open={Boolean(review)}
        room={review?.room || null}
        round={review?.round || 'initial'}
        standards={dashboard?.standards || []}
        task={review ? tasks[review.room.recordId] || null : null}
        onOpenChange={(open) => !open && setReview(null)}
        onTaskChange={handleTaskChange}
        onSynced={handleSynced}
      />
      <RoomDetailSheet
        room={detailRoom}
        historyItem={detailHistory}
        canDownload={canDownload}
        onClose={() => setDetailRoom(null)}
      />
    </div>
  );
}

function Tab({
  value,
  icon,
  children,
}: {
  value: PageTab;
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <TabsTrigger
      value={value}
      className="h-10 min-w-28 px-4 data-[state=active]:bg-blue-50 data-[state=active]:text-blue-700 data-[state=active]:shadow-none"
    >
      {icon}
      {children}
    </TabsTrigger>
  );
}

function PeriodOverview({
  dashboard,
}: {
  dashboard: SystemMonthlyReportDashboard;
}) {
  const progress = dashboard.summary.totalRooms
    ? Math.round(
        (dashboard.summary.completedRooms / dashboard.summary.totalRooms) * 100,
      )
    : 0;
  const metrics = [
    {
      label: '机房总数',
      value: dashboard.summary.totalRooms,
      icon: UsersRound,
      tone: 'bg-blue-600',
    },
    {
      label: '待提交',
      value: dashboard.summary.pendingSubmissionRooms,
      icon: FileClock,
      tone: 'bg-amber-500',
    },
    {
      label: '审核中',
      value: dashboard.summary.inReviewRooms,
      icon: ClipboardCheck,
      tone: 'bg-cyan-600',
    },
    {
      label: '已归档',
      value: dashboard.summary.completedRooms,
      icon: FileCheck2,
      tone: 'bg-emerald-600',
    },
  ];
  return (
    <section className="grid gap-4 xl:grid-cols-[minmax(0,1.35fr)_minmax(620px,1fr)]">
      <Card className="overflow-hidden border-blue-200 bg-[linear-gradient(135deg,#ffffff_0%,#eff6ff_100%)] shadow-sm">
        <CardContent className="flex h-full flex-col justify-between gap-5 p-6 md:flex-row md:items-center">
          <div>
            <Badge className="bg-blue-100 text-blue-700 hover:bg-blue-100">
              当前周期
            </Badge>
            <h2 className="mt-3 text-2xl font-semibold tracking-tight text-slate-950">
              {dashboard.period.label}
            </h2>
            <p className="mt-2 text-sm text-slate-500">
              初版 {dashboard.period.initialDueDate || '待排期'} · 复审版{' '}
              {dashboard.period.recheckDueDate || '待排期'} · 终版{' '}
              {dashboard.period.finalDueDate || '待排期'}
            </p>
          </div>
          <div className="w-full md:max-w-xs">
            <div className="mb-2 flex items-center justify-between text-sm">
              <span className="font-medium text-slate-700">整体归档进度</span>
              <span className="font-semibold text-blue-700">{progress}%</span>
            </div>
            <Progress value={progress} className="h-2.5" />
            <p className="mt-2 text-xs text-slate-500">
              {dashboard.summary.completedRooms} /{' '}
              {dashboard.summary.totalRooms} 个机房完成归档
            </p>
          </div>
        </CardContent>
      </Card>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 xl:grid-cols-2 2xl:grid-cols-4">
        {metrics.map(({ label, value, icon: Icon, tone }) => (
          <Card key={label} className="border-slate-200 shadow-sm">
            <CardContent className="flex items-center gap-3 p-4">
              <span
                className={cn(
                  'flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-white shadow-sm',
                  tone,
                )}
              >
                <Icon className="h-5 w-5" />
              </span>
              <div>
                <p className="text-2xl font-semibold text-slate-950">{value}</p>
                <p className="text-xs text-slate-500">{label}</p>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </section>
  );
}

function RoomProgressCard({
  rooms,
  tasks,
  onPrimaryAction,
  onDetail,
}: {
  rooms: SystemMonthlyReportRoom[];
  tasks: Record<string, SystemMonthlyReportTask>;
  onPrimaryAction: (room: SystemMonthlyReportRoom) => void;
  onDetail: (room: SystemMonthlyReportRoom) => void;
}) {
  return (
    <Card className="border-slate-200 shadow-sm">
      <CardHeader className="border-b border-slate-100 pb-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <CardTitle className="text-base">机房月报进度</CardTitle>
            <p className="mt-1 text-sm text-slate-500">
              一行只显示当前状态，完整流程可下钻查看
            </p>
          </div>
          <Badge variant="secondary">{rooms.length} 个机房</Badge>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {rooms.length ? (
          <Table>
            <TableHeader>
              <TableRow className="bg-slate-50/80">
                <TableHead className="pl-5">机房</TableHead>
                <TableHead>当前进展</TableHead>
                <TableHead>当前负责人</TableHead>
                <TableHead>截止 / 更新</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rooms.map((room) => {
                const task = tasks[room.recordId];
                const action = getSystemMonthlyReportAuthorizedAction(room);
                const currentStep = room.steps.find(
                  (step) => step.state === 'current',
                );
                return (
                  <TableRow key={room.recordId}>
                    <TableCell className="pl-5">
                      <button
                        className="text-left"
                        onClick={() => onDetail(room)}
                      >
                        <span className="block font-semibold text-slate-950">
                          {room.room}
                        </span>
                        <span className="text-xs text-slate-400">
                          {room.code}
                        </span>
                      </button>
                    </TableCell>
                    <TableCell>
                      <div className="min-w-48">
                        <div className="mb-1.5 flex items-center justify-between gap-2">
                          <StatusBadge room={room} />
                          {task ? <TaskBadge task={task} /> : null}
                        </div>
                        <Progress
                          value={
                            (room.steps.filter(
                              (step) => step.state === 'completed',
                            ).length /
                              room.steps.length) *
                            100
                          }
                          className="h-1.5"
                        />
                      </div>
                    </TableCell>
                    <TableCell>
                      <span className="font-medium text-slate-700">
                        {room.currentOwnerName}
                      </span>
                      <span className="ml-1 text-xs text-slate-400">
                        {room.currentOwnerRole}
                      </span>
                    </TableCell>
                    <TableCell>
                      <span className="text-sm text-slate-600">
                        {currentStep?.date || formatDate(room.latestAt)}
                      </span>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => onDetail(room)}
                        >
                          详情
                        </Button>
                        {action ? (
                          <Button
                            size="sm"
                            onClick={() => onPrimaryAction(room)}
                            disabled={Boolean(
                              task &&
                              ['accepted', 'syncing'].includes(task.status),
                            )}
                          >
                            {action.label}
                            <ChevronRight className="h-3.5 w-3.5" />
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
          <EmptyState
            title="没有匹配的机房"
            description="调整顶部搜索条件后重试。"
          />
        )}
      </CardContent>
    </Card>
  );
}

function ScheduleRail({
  dashboard,
  onOpenSchedule,
}: {
  dashboard: SystemMonthlyReportDashboard;
  onOpenSchedule: () => void;
}) {
  return (
    <Card className="h-fit border-slate-200 shadow-sm">
      <CardHeader className="border-b border-slate-100 pb-4">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">本月审核排班</CardTitle>
          <CalendarDays className="h-5 w-5 text-blue-600" />
        </div>
      </CardHeader>
      <CardContent className="space-y-4 p-4">
        {(['initial', 'recheck'] as const).map((round) => {
          const items = dashboard.schedule
            .filter((item) => item.round === round)
            .slice(0, 5);
          return (
            <section key={round}>
              <div className="mb-2 flex items-center justify-between">
                <h3 className="text-sm font-semibold text-slate-800">
                  {round === 'initial' ? '初审排班' : '复审排班'}
                </h3>
                <Badge variant="outline">
                  {
                    dashboard.schedule.filter((item) => item.round === round)
                      .length
                  }
                </Badge>
              </div>
              <div className="space-y-2">
                {items.map((item) => (
                  <div
                    key={item.recordId}
                    className="flex items-center justify-between gap-3 rounded-lg bg-slate-50 px-3 py-2"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-slate-800">
                        {item.room}
                      </p>
                      <p className="text-xs text-slate-400">
                        来自 {item.reviewerRoom || '未标注机房'}
                      </p>
                    </div>
                    <span className="shrink-0 text-sm font-semibold text-blue-700">
                      {item.reviewer.name}
                    </span>
                  </div>
                ))}
              </div>
            </section>
          );
        })}
        <Button variant="outline" className="w-full" onClick={onOpenSchedule}>
          查看完整排班
          <ChevronRight className="h-4 w-4" />
        </Button>
      </CardContent>
    </Card>
  );
}

function SubmissionProgressView({
  rooms,
  tasks,
  onSubmit,
  onDetail,
}: {
  rooms: SystemMonthlyReportRoom[];
  tasks: Record<string, SystemMonthlyReportTask>;
  onSubmit: (room: SystemMonthlyReportRoom) => void;
  onDetail: (room: SystemMonthlyReportRoom) => void;
}) {
  const submissionRooms = rooms.filter(
    (room) =>
      room.access?.canSubmit &&
      !['initial_review', 'recheck_review'].includes(room.status),
  );
  return (
    <Card className="border-slate-200 shadow-sm">
      <CardHeader>
        <CardTitle>我的提交</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {submissionRooms.map((room) => {
          const task = tasks[room.recordId];
          const action = getSystemMonthlyReportAuthorizedAction(room);
          return (
            <button
              key={room.recordId}
              type="button"
              onClick={() => (action ? onSubmit(room) : onDetail(room))}
              className="rounded-lg border border-slate-200 bg-white p-4 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-blue-300 hover:shadow-md"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="font-semibold text-slate-950">{room.room}</h3>
                  <p className="mt-1 text-xs text-slate-400">{room.code}</p>
                </div>
                {task ? <TaskBadge task={task} /> : <StatusBadge room={room} />}
              </div>
              <div className="mt-4 flex items-center justify-between text-sm">
                <span className="text-slate-500">{room.currentOwnerName}</span>
                <span className="font-semibold text-blue-700">
                  {action?.label || '查看归档'}{' '}
                  <ChevronRight className="inline h-4 w-4" />
                </span>
              </div>
            </button>
          );
        })}
      </CardContent>
    </Card>
  );
}

function ReviewTaskView({
  rooms,
  tasks,
  onReview,
}: {
  rooms: SystemMonthlyReportRoom[];
  tasks: Record<string, SystemMonthlyReportTask>;
  onReview: (room: SystemMonthlyReportRoom) => void;
}) {
  const reviewRooms = rooms.filter((room) =>
    Boolean(getSystemMonthlyReportAuthorizedAction(room)?.kind === 'review'),
  );
  return (
    <Card className="border-slate-200 shadow-sm">
      <CardHeader>
        <CardTitle>待审核任务</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {reviewRooms.length ? (
          reviewRooms.map((room) => {
            const action = getSystemMonthlyReportAuthorizedAction(room);
            const task = tasks[room.recordId];
            return (
              <div
                key={room.recordId}
                className="flex flex-col gap-4 rounded-lg border border-slate-200 p-4 md:flex-row md:items-center md:justify-between"
              >
                <div className="flex items-start gap-3">
                  <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-cyan-50 text-cyan-700">
                    <UserRoundCheck className="h-5 w-5" />
                  </span>
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="font-semibold text-slate-950">
                        {room.room}
                      </h3>
                      <StatusBadge room={room} />
                      {task ? <TaskBadge task={task} /> : null}
                    </div>
                    <p className="mt-1 text-sm text-slate-500">
                      审核人：{room.currentOwnerName} · {room.currentOwnerRole}
                    </p>
                  </div>
                </div>
                <Button
                  onClick={() => onReview(room)}
                  disabled={
                    !action ||
                    Boolean(
                      task && ['accepted', 'syncing'].includes(task.status),
                    )
                  }
                >
                  {action?.label || '查看任务'}
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            );
          })
        ) : (
          <EmptyState
            title="当前没有待审核任务"
            description="提交初版或复审版后，任务会自动进入对应审核队列。"
          />
        )}
      </CardContent>
    </Card>
  );
}

function ScheduleView({
  dashboard,
}: {
  dashboard: SystemMonthlyReportDashboard;
}) {
  return (
    <Card className="border-slate-200 shadow-sm">
      <CardHeader>
        <CardTitle>
          {dashboard.period.year} 年 {dashboard.period.month} 月审核排班
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow className="bg-slate-50">
              <TableHead className="pl-6">审核机房</TableHead>
              <TableHead>初审人员</TableHead>
              <TableHead>初审人员所属机房</TableHead>
              <TableHead>复审人员</TableHead>
              <TableHead>复审人员所属机房</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {dashboard.rooms.map((room) => {
              const initial = dashboard.schedule.find(
                (item) => item.room === room.room && item.round === 'initial',
              );
              const recheck = dashboard.schedule.find(
                (item) => item.room === room.room && item.round === 'recheck',
              );
              return (
                <TableRow key={room.recordId}>
                  <TableCell className="pl-6 font-semibold">
                    {room.room}
                  </TableCell>
                  <TableCell>
                    {initial?.reviewer.name ||
                      room.initialReviewer?.name ||
                      '待排班'}
                  </TableCell>
                  <TableCell className="text-slate-500">
                    {initial?.reviewerRoom || '—'}
                  </TableCell>
                  <TableCell>
                    {recheck?.reviewer.name ||
                      room.recheckReviewer?.name ||
                      '待排班'}
                  </TableCell>
                  <TableCell className="text-slate-500">
                    {recheck?.reviewerRoom || '—'}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function HistoryView({
  history,
  query,
  canDownload,
  canRetry,
  onRefresh,
  onRequireLogin,
}: {
  history: SystemMonthlyReportHistoryItem[];
  query: string;
  canDownload: boolean;
  canRetry: boolean;
  onRefresh: () => void;
  onRequireLogin: () => void;
}) {
  const items = history
    .filter(
      (item) =>
        !query ||
        `${item.room} ${item.year} ${item.month}`.toLowerCase().includes(query),
    )
    .slice(0, 100);
  return (
    <Card className="border-slate-200 shadow-sm">
      <CardHeader>
        <CardTitle>历史月报归档</CardTitle>
      </CardHeader>
      <CardContent className="overflow-x-auto p-0">
        {items.length ? (
          <Table>
            <TableHeader>
              <TableRow className="bg-slate-50">
                <TableHead className="pl-6">月份</TableHead>
                <TableHead>机房</TableHead>
                <TableHead>初版</TableHead>
                <TableHead>复审版</TableHead>
                <TableHead>终版</TableHead>
                <TableHead>最终提交时间</TableHead>
                <TableHead>归档状态</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((item) => (
                <TableRow key={item.recordId}>
                  <TableCell className="pl-6 font-semibold">
                    {item.year}-{String(item.month).padStart(2, '0')}
                  </TableCell>
                  <TableCell>{item.room}</TableCell>
                  <TableCell>
                    <AttachmentCount value={item.initialAttachmentCount} />
                  </TableCell>
                  <TableCell>
                    <AttachmentCount value={item.recheckAttachmentCount} />
                  </TableCell>
                  <TableCell>
                    <AttachmentCount value={item.finalAttachmentCount} />
                  </TableCell>
                  <TableCell className="text-slate-500">
                    {formatDateTime(item.finalSubmittedAt)}
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant="outline"
                      className={cn(
                        item.archiveStatus === 'archived' &&
                          'border-emerald-200 bg-emerald-50 text-emerald-700',
                        item.archiveStatus === 'error' &&
                          'border-rose-200 bg-rose-50 text-rose-700',
                        ['pending', 'syncing'].includes(item.archiveStatus) &&
                          'border-amber-200 bg-amber-50 text-amber-700',
                      )}
                    >
                      {item.archiveStatus === 'archived'
                        ? '已归档'
                        : item.archiveStatus === 'error'
                          ? '归档失败'
                          : '归档中'}
                    </Badge>
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
          <EmptyState
            title="暂无历史月报"
            description="完成终版提交后，归档记录将在这里展示。"
          />
        )}
      </CardContent>
    </Card>
  );
}

function RoomDetailSheet({
  room,
  historyItem,
  canDownload,
  onClose,
}: {
  room: SystemMonthlyReportRoom | null;
  historyItem: SystemMonthlyReportHistoryItem | null;
  canDownload: boolean;
  onClose: () => void;
}) {
  return (
    <Sheet open={Boolean(room)} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
        <SheetHeader className="px-0">
          <SheetTitle className="text-xl">{room?.room} 月报详情</SheetTitle>
          <SheetDescription className="sr-only">
            {room?.room || '机房'}月报流程与审核摘要
          </SheetDescription>
        </SheetHeader>
        {room ? (
          <div className="space-y-6">
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
              <div className="flex items-center justify-between">
                <StatusBadge room={room} />
                <span className="text-xs text-slate-400">
                  更新 {formatDateTime(room.latestAt)}
                </span>
              </div>
              <p className="mt-3 text-sm text-slate-600">
                当前负责人：
                <span className="font-semibold text-slate-900">
                  {room.currentOwnerName}
                </span>
                （{room.currentOwnerRole}）
              </p>
            </div>
            <FinalReportAttachmentViewer
              item={historyItem}
              canDownload={canDownload}
            />
            <ol>
              {room.steps.map((step, index) => (
                <li
                  key={step.key}
                  className="relative flex gap-3 pb-5 last:pb-0"
                >
                  {index < room.steps.length - 1 ? (
                    <span className="absolute left-[9px] top-5 h-full w-px bg-slate-200" />
                  ) : null}
                  {step.state === 'completed' ? (
                    <CheckCircle2 className="relative z-10 h-5 w-5 bg-white text-emerald-600" />
                  ) : step.state === 'current' ? (
                    <CircleDot className="relative z-10 h-5 w-5 bg-white text-blue-600" />
                  ) : (
                    <Clock3 className="relative z-10 h-5 w-5 bg-white text-slate-300" />
                  )}
                  <div>
                    <p
                      className={cn(
                        'text-sm font-semibold',
                        step.state === 'current'
                          ? 'text-blue-700'
                          : 'text-slate-700',
                      )}
                    >
                      {step.label}
                    </p>
                    <p className="mt-0.5 text-xs text-slate-400">
                      {step.date || '待推进'}
                    </p>
                  </div>
                </li>
              ))}
            </ol>
            <section>
              <h3 className="font-semibold text-slate-950">审核问题摘要</h3>
              <div className="mt-3 space-y-3">
                <IssueSummary label="初审" value={room.issueSummary.initial} />
                <IssueSummary label="复审" value={room.issueSummary.recheck} />
              </div>
            </section>
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

function StatusBadge({ room }: { room: SystemMonthlyReportRoom }) {
  const className =
    room.status === 'completed'
      ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
      : room.status.includes('review')
        ? 'border-cyan-200 bg-cyan-50 text-cyan-700'
        : 'border-amber-200 bg-amber-50 text-amber-700';
  return (
    <Badge variant="outline" className={className}>
      {room.statusLabel}
    </Badge>
  );
}

function TaskBadge({ task }: { task: SystemMonthlyReportTask }) {
  const presentation = getSystemMonthlyReportTaskPresentation(task);
  return (
    <Badge
      variant="outline"
      className={cn(
        presentation.tone === 'success' &&
          'border-emerald-200 bg-emerald-50 text-emerald-700',
        presentation.tone === 'info' &&
          'border-blue-200 bg-blue-50 text-blue-700',
        presentation.tone === 'warning' &&
          'border-amber-200 bg-amber-50 text-amber-700',
        presentation.tone === 'error' &&
          'border-rose-200 bg-rose-50 text-rose-700',
      )}
    >
      {presentation.busy && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
      {presentation.label}
    </Badge>
  );
}

function AttachmentCount({ value }: { value: number }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 text-sm',
        value ? 'text-emerald-700' : 'text-slate-400',
      )}
    >
      <FileArchive className="h-4 w-4" />
      {value ? `${value} 个附件` : '未归档'}
    </span>
  );
}
function IssueSummary({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-slate-200 p-3">
      <p className="text-xs font-semibold text-slate-500">{label}</p>
      <p className="mt-1 text-sm leading-6 text-slate-700">
        {value || '暂无问题记录'}
      </p>
    </div>
  );
}
function EmptyState({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="flex min-h-52 flex-col items-center justify-center p-8 text-center">
      <FileSpreadsheet className="h-9 w-9 text-slate-300" />
      <h3 className="mt-3 font-semibold text-slate-800">{title}</h3>
      <p className="mt-1 text-sm text-slate-500">{description}</p>
    </div>
  );
}

function DashboardSkeleton() {
  return (
    <div className="space-y-5">
      <Skeleton className="h-40 w-full" />
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
        <Skeleton className="h-[520px] w-full" />
        <Skeleton className="h-[520px] w-full" />
      </div>
    </div>
  );
}
function formatDate(value: string | null): string {
  return value ? value.slice(0, 10) : '待推进';
}
function formatDateTime(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(date);
}
function readErrorMessage(_error: unknown, fallback: string): string {
  return fallback;
}
function readStoredTaskIds(): string[] {
  try {
    const parsed = JSON.parse(
      window.localStorage.getItem(TASK_STORAGE_KEY) || '[]',
    );
    return Array.isArray(parsed)
      ? parsed
          .filter((value): value is string => typeof value === 'string')
          .slice(-20)
      : [];
  } catch {
    return [];
  }
}
function storeTaskId(taskId: string): void {
  const ids = Array.from(new Set([...readStoredTaskIds(), taskId])).slice(-20);
  window.localStorage.setItem(TASK_STORAGE_KEY, JSON.stringify(ids));
}
function clearStoredTaskIds(): void {
  window.localStorage.removeItem(TASK_STORAGE_KEY);
}
