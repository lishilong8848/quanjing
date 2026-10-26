import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useAccess } from '@/access/AccessProvider';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { WeeklyWorkbenchControls } from './WeeklyWorkbenchControls';
import { weeklyTargetRecords } from './weekly-record-state';
import type {
  MeetingSnapshot,
  MeetingSummary,
} from '../../../../shared/meeting-management.interface';
import { weeklyPeriod } from '../../../../shared/weekly-workspace.rules';
import {
  canDeleteWeeklyTask,
  weeklyRecordBlockReason,
} from '../../../../shared/weekly-job-locks';
import type {
  WeeklyJob,
  WeeklyMeetingKind,
  WeeklyMeetingEntry,
  WeeklyWorkspace,
} from '../../../../shared/weekly-workspace.interface';
import { meetingError } from './api';
import {
  changeWeeklyTask,
  invalidateWeeklyFormRecord,
  retryWeeklyJob,
  retryWeeklyNotification,
  weeklyJob,
  weeklyWorkspace,
} from './weekly-api';
const MeetingDialog = lazy(() =>
  import('./WeeklyMeetingDialog').then((m) => ({
    default: m.WeeklyMeetingDialog,
  })),
);
const GenerateDialog = lazy(() =>
  import('./WeeklyGenerateDialog').then((m) => ({
    default: m.WeeklyGenerateDialog,
  })),
);
const STATUS = {
  planned: '未召开',
  held: '已召开',
  postponed: '延期',
  cancelled: '取消',
};
const STAGE = {
  queued: '等待处理',
  'row-create': '新建条目',
  prepare: '采集内容',
  create: '创建文档',
  document: '更新文档',
  permissions: '核对文档权限',
  archive: '归档回读',
  attachments: '附件同步',
  done: '完成',
};

export function WeeklyWorkbench({
  snapshot,
  onOpenRecord,
  onSynced,
  externalJob,
}: {
  snapshot: MeetingSnapshot | null;
  onOpenRecord: (id: string) => void;
  onSynced: (job: WeeklyJob) => void;
  externalJob?: WeeklyJob | null;
}) {
  const { role } = useAccess();
  const editable = role === 'admin' || role === 'editor' || (role === 'professional_admin' || role === 'professional_engineer');
  const [data, setData] = useState<WeeklyWorkspace | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState('');
  const [dialog, setDialog] = useState<
    WeeklyMeetingKind | 'generate' | 'create-row' | null
  >(null);
  const [jobs, setJobs] = useState<WeeklyJob[]>([]);
  const [showDeleted, setShowDeleted] = useState(false);
  const [changingTask, setChangingTask] = useState<string | null>(null);
  const [lastTaskChange, setLastTaskChange] = useState<string | null>(null);
  const taskChangeActive = useRef(false);
  const taskMutationIds = useRef(new Map<string, string>());
  const confirmedTaskMutations = useRef(new Set<string>());
  useEffect(() => {
    if (externalJob)
      setJobs((current) => [
        externalJob,
        ...current.filter((job) => job.id !== externalJob.id),
      ]);
  }, [externalJob]);
  const [recovery, setRecovery] = useState<Record<string, string>>({});
  const [retrying, setRetrying] = useState<string | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [pollResume, setPollResume] = useState(0);
  const [draft, setDraft] = useState<WeeklyMeetingEntry | null>(null);
  const seenSuccess = useRef(new Set<string>());
  const engineProbes = useRef(0);
  const workspaceRequest = useRef(0);
  const mounted = useRef(true);
  const syncedRef = useRef(onSynced);
  syncedRef.current = onSynced;
  const records = useMemo(
    () => weeklyTargetRecords(snapshot?.records || [], jobs),
    [snapshot, jobs],
  );
  const manualSelection = useRef(false);
  useEffect(() => {
    if (
      selected &&
      selected !== 'new' &&
      !selected.startsWith('pending:') &&
      !records.some((r) => r.id === selected)
    ) {
      manualSelection.current = false;
      setSelected(records[0]?.id || '');
      return;
    }
    if (
      selected.startsWith('pending:') &&
      !records.some((record) => record.id === selected)
    ) {
      setSelected('new');
      return;
    }
    if (
      !manualSelection.current &&
      selected !== 'new' &&
      !selected.startsWith('pending:') &&
      records.length
    ) {
      setSelected(
        [...records].sort(
          (a, b) =>
            (b.date || '').localeCompare(a.date || '') ||
            a.id.localeCompare(b.id),
        )[0].id,
      );
    }
  }, [records, selected]);
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
  }).format(new Date());
  const period = weeklyPeriod(today);
  const newRecord: MeetingSummary = {
    id: 'new',
    title: '新建周报条目',
    date: period.endDate,
    weekLabel: null,
    scope: '机房',
    nature: '管理类',
    source: 'nantong-weekly',
    documentUrl: null,
    updatedAt: null,
    hasActions: false,
    sectionTitles: [],
    searchText: '',
  };
  const record =
    selected === 'new' ? newRecord : records.find((r) => r.id === selected);
  const load = useCallback(async (signal: AbortSignal, recheck = false) => {
    const request = ++workspaceRequest.current;
    try {
      const workspace = await weeklyWorkspace(signal, editable && recheck);
      if (
        signal.aborted ||
        !mounted.current ||
        request !== workspaceRequest.current
      )
        return;
      setData((current) => {
        if (!current) return workspace;
        const meetings = new Map(
          workspace.meetings.map((entry) => [entry.id, entry]),
        );
        for (const entry of current.meetings) {
          const old = meetings.get(entry.id);
          if (!old || old.version < entry.version)
            meetings.set(entry.id, entry);
        }
        return { ...workspace, meetings: [...meetings.values()] };
      });
      setJobs((current) => {
        const merged = new Map(workspace.jobs.map((job) => [job.id, job]));
        for (const job of current) {
          const old = merged.get(job.id);
          if (!old || old.updatedAt < job.updatedAt) merged.set(job.id, job);
        }
        return [...merged.values()].sort((a, b) =>
          b.createdAt.localeCompare(a.createdAt),
        );
      });
      setError(null);
    } catch (reason) {
      if (
        !signal.aborted &&
        mounted.current &&
        request === workspaceRequest.current
      ) {
        setError(meetingError(reason));
        setData((current) =>
          current?.runtime.message === '正在检查周报引擎'
            ? {
                ...current,
                runtime: {
                  ...current.runtime,
                  message: '检查状态读取失败，请重新检查',
                },
              }
            : current,
        );
      }
    }
  }, [editable]);
  useEffect(() => {
    const controller = new AbortController();
    mounted.current = true;
    void load(controller.signal, true);
    return () => {
      mounted.current = false;
      controller.abort();
    };
  }, [load]);
  useEffect(() => {
    if (data?.runtime.message !== '正在检查周报引擎') return;
    if (engineProbes.current >= 12) {
      setData(
        (current) =>
          current && {
            ...current,
            runtime: {
              ...current.runtime,
              message: '检查尚未返回，请重新检查',
            },
          },
      );
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      engineProbes.current += 1;
      void load(controller.signal);
    }, 2000);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [data, load]);
  const pending = jobs.filter(
    (j) =>
      ['accepted', 'running', 'deleting'].includes(j.status) ||
      (j.notification &&
        ['pending', 'sending'].includes(j.notification.status)),
  );
  const pendingKey = pending
    .map((j) => j.id)
    .sort()
    .join(',');
  useEffect(() => {
    if (!pendingKey) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let polls = 0;
    const poll = async () => {
      try {
        const results = await Promise.all(
          pendingKey.split(',').map((id) => weeklyJob(id, controller.signal)),
        );
        if (controller.signal.aborted) return;
        for (const result of results) {
          if (result.deletion)
            confirmedTaskMutations.current.add(
              result.deletion.clientMutationId,
            );
        }
        setJobs((current) =>
          current.map((job) => {
            const result = results.find((r) => r.id === job.id);
            return result &&
              (result.updatedAt >= job.updatedAt ||
                (job.status === 'deleting' &&
                  result.deletion?.clientMutationId ===
                    job.deletion?.clientMutationId))
              ? result
              : job;
          }),
        );
        for (const job of results)
          if (job.status === 'error')
            invalidateWeeklyFormRecord(job.targetRecordId);
        for (const job of results)
          if (job.status === 'success' && !seenSuccess.current.has(job.id)) {
            seenSuccess.current.add(job.id);
            syncedRef.current(job);
            if (job.createOnly || job.record) {
              manualSelection.current = true;
              setSelected((current) =>
                current.startsWith('pending:') || current === 'new'
                  ? job.targetRecordId
                  : current,
              );
            }
            if (job.meeting)
              setData((current) =>
                current
                  ? {
                      ...current,
                      meetings: [
                        ...current.meetings.filter(
                          (m) => m.id !== job.meeting?.id,
                        ),
                        job.meeting!,
                      ],
                    }
                  : current,
              );
          }
        polls += 1;
        if (
          results.some(
            (j) =>
              ['accepted', 'running', 'deleting'].includes(j.status) ||
              (j.notification &&
                ['pending', 'sending'].includes(j.notification.status)),
          ) &&
          polls < 120
        )
          timer = setTimeout(() => void poll(), 2000);
        else if (polls >= 120) setWaiting(true);
      } catch (reason) {
        if (!controller.signal.aborted) {
          setError(meetingError(reason));
          setWaiting(true);
        }
      }
    };
    timer = setTimeout(() => void poll(), 500);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [pendingKey, pollResume]);
  const accepted = (job: WeeklyJob, additional: WeeklyJob[] = []) => {
    const incoming = [job, ...additional];
    setJobs((current) => [
      ...incoming,
      ...current.filter((j) => !incoming.some((next) => next.id === j.id)),
    ]);
    setDialog(null);
    setWaiting(false);
    setDraft(null);
    if (
      job.targetRecordId === 'new' &&
      ['accepted', 'running'].includes(job.status)
    )
      setSelected(`pending:${job.id}`);
    if (job.status === 'success') {
      syncedRef.current(job);
      if (job.meeting)
        setData((current) =>
          current
            ? {
                ...current,
                meetings: [
                  ...current.meetings.filter((m) => m.id !== job.meeting?.id),
                  job.meeting!,
                ],
              }
            : current,
        );
      if (job.createOnly) {
        manualSelection.current = true;
        setSelected(job.targetRecordId);
      }
    }
  };
  const retry = async (job: WeeklyJob) => {
    if (retrying) return;
    setRetrying(job.id);
    setError(null);
    try {
      const result = await retryWeeklyJob(
        job.id,
        job.status === 'uncertain' ? recovery[job.id] : undefined,
        job.targetRecordId === 'new',
        job.kind === 'attachments',
      );
      if (mounted.current) accepted(result);
    } catch (reason) {
      if (mounted.current) setError(meetingError(reason));
    } finally {
      if (mounted.current) setRetrying(null);
    }
  };
  const retryNotification = async (job: WeeklyJob) => {
    if (retrying) return;
    setRetrying(job.id);
    try {
      const result = await retryWeeklyNotification(job.id);
      if (mounted.current)
        setJobs((current) =>
          current.map((item) => (item.id === result.id ? result : item)),
        );
    } catch (reason) {
      if (mounted.current) setError(meetingError(reason));
    } finally {
      if (mounted.current) setRetrying(null);
    }
  };
  const changeTask = async (job: WeeklyJob, action: 'delete' | 'restore') => {
    if ((role !== 'admin' && (role !== 'professional_admin' && role !== 'professional_engineer')) || taskChangeActive.current) return;
    if (
      action === 'delete' ? !canDeleteWeeklyTask(job) : job.status !== 'deleted'
    )
      return;
    const key = `${action}:${job.id}`;
    if (
      action === 'delete' &&
      ['error', 'restored'].includes(job.deletion?.status || '')
    )
      taskMutationIds.current.delete(key);
    const clientMutationId =
      taskMutationIds.current.get(key) || crypto.randomUUID();
    taskMutationIds.current.set(key, clientMutationId);
    const optimistic: WeeklyJob = {
      ...job,
      status: action === 'delete' ? 'deleting' : job.deletion!.previousStatus,
      updatedAt: new Date().toISOString(),
      ...(action === 'delete'
        ? {
            deletion: {
              clientMutationId,
              status: 'checking' as const,
              previousStatus: job.status as 'error' | 'uncertain',
              requestedAt: new Date().toISOString(),
              error: null,
            },
          }
        : {}),
    };
    taskChangeActive.current = true;
    setChangingTask(job.id);
    setLastTaskChange(job.id);
    setError(null);
    setWaiting(false);
    setJobs((current) =>
      current.map((item) => (item.id === job.id ? optimistic : item)),
    );
    try {
      const result = await changeWeeklyTask(job.id, action, clientMutationId);
      confirmedTaskMutations.current.add(clientMutationId);
      if (mounted.current) {
        setJobs((current) =>
          current.map((item) =>
            item.id === result.id &&
            (item.updatedAt === optimistic.updatedAt ||
              item.updatedAt <= result.updatedAt)
              ? result
              : item,
          ),
        );
        if (action === 'restore') {
          setShowDeleted(false);
          taskMutationIds.current.delete(`delete:${job.id}`);
        }
      }
      if (result.status !== 'deleting') taskMutationIds.current.delete(key);
    } catch (reason) {
      if (mounted.current) {
        if (!confirmedTaskMutations.current.has(clientMutationId)) {
          setJobs((current) =>
            current.map((item) =>
              item.id === job.id && item.updatedAt === optimistic.updatedAt
                ? job
                : item,
            ),
          );
        }
        setError(meetingError(reason));
      }
    } finally {
      taskChangeActive.current = false;
      if (mounted.current) setChangingTask(null);
    }
  };
  const changedTask = jobs.find((job) => job.id === lastTaskChange);
  const meetings = data?.meetings || [];
  const latest = useMemo(
    () =>
      [...meetings]
        .filter((m) => m.status === 'held')
        .sort((a, b) =>
          (b.actualDate || b.plannedDate).localeCompare(
            a.actualDate || a.plannedDate,
          ),
        )
        .slice(0, 2),
    [meetings],
  );
  const blockReason = weeklyRecordBlockReason(selected, jobs);
  return (
    <Card className="weekly-workbench">
      <CardContent className="weekly-workbench-content">
        <WeeklyWorkbenchControls
          records={records}
          record={record}
          selected={selected}
          blockReason={blockReason}
          data={data}
          onSelect={(id) => {
            manualSelection.current = true;
            setSelected(id);
          }}
          onOpen={onOpenRecord}
          onAction={(action) => {
            if (!editable) return;
            if (action === 'create-row') setSelected('new');
            setDialog(action);
          }}
        />
        {!data && !error && <p role="status">正在读取周会状态…</p>}
        {data && !data.runtime.ready && (
          <Button
            variant="outline"
            size="sm"
            disabled={!editable || data.runtime.message === '正在检查周报引擎'}
            onClick={() => {
              engineProbes.current = 0;
              setData(
                (current) =>
                  current && {
                    ...current,
                    runtime: {
                      ...current.runtime,
                      ready: false,
                      message: '正在检查周报引擎',
                    },
                  },
              );
              void load(new AbortController().signal, true);
            }}
          >
            {data.runtime.message === '正在检查周报引擎'
              ? '正在检查'
              : '重新检查'}
          </Button>
        )}
        {(error || data?.peopleError) && (
          <p role="alert" className="weekly-error">
            {error || data?.peopleError}
          </p>
        )}
        {data?.runtime.ready && data.runtime.message && (
          <p className="weekly-console-notice">{data.runtime.message}</p>
        )}
        {data?.schedule.message && (
          <p role="alert" className="weekly-error">
            {data.schedule.message}
          </p>
        )}
        {meetings.length > 0 && (
          <div className="weekly-meeting-list">
            {[...meetings]
              .sort((a, b) => b.plannedDate.localeCompare(a.plannedDate))
              .slice(0, 8)
              .map((meeting) => (
                <div key={meeting.id}>
                  <strong>
                    {meeting.kind === 'ali' ? '阿里会议' : '属地周会'}
                  </strong>
                  <span>
                    {meeting.plannedDate}
                    {meeting.status === 'postponed'
                      ? ` → ${meeting.actualDate}`
                      : ''}
                  </span>
                  <Badge variant="outline">{STATUS[meeting.status]}</Badge>
                  <span>{meeting.note}</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={!editable || jobs.some(
                      (j) =>
                        j.targetRecordId === meeting.targetRecordId &&
                        j.kind !== 'attachments' &&
                        ['accepted', 'running', 'uncertain'].includes(j.status),
                    )}
                    onClick={() => {
                      setSelected(meeting.targetRecordId);
                      setDialog(meeting.kind);
                    }}
                  >
                    调整／填写
                  </Button>
                </div>
              ))}
          </div>
        )}
        {latest.some((m) => m.todos.length) && (
          <section className="weekly-latest">
            <h3>最新填写待办</h3>
            {latest.flatMap((meeting) =>
              meeting.todos.map((todo) => (
                <div
                  key={`${meeting.id}-${todo.id}`}
                  className="weekly-action-row"
                >
                  <Badge variant="outline">
                    {todo.status === 'done' ? '已完成' : '待办'}
                  </Badge>
                  <strong>{todo.content}</strong>
                  <span className="weekly-owner">
                    示例人员019：{todo.ownerName || '待明确'}
                  </span>
                  <span>截止：{todo.dueDate || '未设置'}</span>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => onOpenRecord(meeting.targetRecordId)}
                  >
                    查看周报
                  </Button>
                </div>
              )),
            )}
          </section>
        )}
        {jobs.length > 0 && (
          <section className="weekly-jobs" aria-label="周会任务状态">
            <Button
              variant="ghost"
              size="sm"
              aria-pressed={showDeleted}
              onClick={() => setShowDeleted((value) => !value)}
            >
              {showDeleted
                ? '返回任务列表'
                : `已删除任务 ${jobs.filter((job) => job.status === 'deleted').length}`}
            </Button>
            {changedTask && (
              <p
                role="status"
                className={
                  changedTask.deletion?.status === 'error'
                    ? 'weekly-error'
                    : 'weekly-muted'
                }
              >
                {changingTask
                  ? '正在提交任务变更…'
                  : changedTask.status === 'deleting'
                    ? '已受理，正在核对源表并删除任务…'
                    : changedTask.status === 'deleted'
                      ? '任务已删除'
                      : changedTask.deletion?.status === 'restored'
                        ? '任务已恢复'
                        : changedTask.deletion?.status === 'error'
                          ? `删除失败：${changedTask.deletion.error}`
                          : ''}
              </p>
            )}
            {[...jobs]
              .filter((job) =>
                showDeleted
                  ? job.status === 'deleted'
                  : !['deleted', 'deleting'].includes(job.status),
              )
              .sort(
                (a, b) =>
                  Number(a.status === 'success') -
                    Number(b.status === 'success') ||
                  b.createdAt.localeCompare(a.createdAt),
              )
              .slice(0, 6)
              .map((job) => (
                <div key={job.id} className="weekly-job" role="status">
                  <strong>
                    {job.kind === 'attachments'
                      ? `会议附件${job.attachmentNames?.length ? ` · ${job.attachmentNames.join('、')}` : ''}`
                      : job.kind === 'action-edit'
                        ? '待办修改'
                        : job.kind === 'meeting'
                          ? '会议／待办保存'
                          : job.createOnly
                            ? '新建周报条目'
                            : '周报生成'}
                  </strong>
                  <span>
                    {job.status === 'deleted'
                      ? '已删除'
                      : job.status === 'success'
                        ? '已完成'
                        : job.status === 'error'
                          ? '失败'
                          : job.status === 'uncertain'
                            ? job.kind === 'attachments'
                              ? '待核对附件'
                              : job.stage === 'row-create'
                                ? '待核对条目'
                                : '待核对文档'
                            : `已受理 · ${STAGE[job.stage]}`}
                  </span>
                  {job.kind === 'generate' && job.endDate && (
                    <span>{job.endDate}</span>
                  )}
                  {job.status !== 'deleted' && job.error && (
                    <span className="weekly-error">{job.error}</span>
                  )}
                  {job.deletion?.status === 'error' && (
                    <span className="weekly-error">
                      删除失败：{job.deletion.error}
                    </span>
                  )}
                  {(role === 'admin' || (role === 'professional_admin' || role === 'professional_engineer')) && canDeleteWeeklyTask(job) && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={Boolean(changingTask)}
                      onClick={() => void changeTask(job, 'delete')}
                    >
                      删除任务
                    </Button>
                  )}
                  {(role === 'admin' || (role === 'professional_admin' || role === 'professional_engineer')) && job.status === 'deleted' && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={Boolean(changingTask)}
                      onClick={() => void changeTask(job, 'restore')}
                    >
                      恢复任务
                    </Button>
                  )}
                  {!job.createOnly && job.documentUrl && job.notification && (
                    <span>
                      群提醒：
                      {job.notification.status === 'success'
                        ? '已发送'
                        : job.notification.status === 'error'
                          ? '发送失败'
                          : job.notification.status === 'uncertain'
                            ? '待核对'
                            : '发送中'}
                      {job.notification.error && (
                        <span className="weekly-error">
                          {' '}
                          {job.notification.error}
                        </span>
                      )}
                      {job.notification.status === 'error' && (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={!editable || retrying === job.id}
                          onClick={() => void retryNotification(job)}
                        >
                          重试群提醒
                        </Button>
                      )}
                    </span>
                  )}
                  {job.documentUrl && (
                    <a
                      href={job.documentUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      打开周报
                    </a>
                  )}
                  {job.status === 'error' && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!editable || retrying === job.id}
                      onClick={() => void retry(job)}
                    >
                      重试失败步骤
                    </Button>
                  )}
                  {job.status === 'error' && job.meeting && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setSelected(job.targetRecordId);
                        setDraft({
                          ...job.meeting!,
                          version:
                            meetings.find((m) => m.id === job.meeting?.id)
                              ?.version || 0,
                        });
                        setDialog(job.meeting!.kind);
                      }}
                    >
                      恢复草稿
                    </Button>
                  )}
                  {job.status === 'uncertain' && (role === 'admin' || (role === 'professional_admin' || role === 'professional_engineer')) && (
                    <>
                      {job.targetRecordId === 'new' &&
                        job.kind === 'generate' && (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={!editable || retrying === job.id}
                            onClick={() => void retry(job)}
                          >
                            查找已创建条目
                          </Button>
                        )}
                      <Input
                        aria-label={
                          job.kind === 'attachments'
                            ? '已关联会议附件编号'
                            : job.targetRecordId === 'new'
                              ? '已创建周报记录编号'
                              : '已创建周报文档链接'
                        }
                        placeholder={
                          job.kind === 'attachments'
                            ? '填写核对后已关联附件的 file token'
                            : job.targetRecordId === 'new'
                              ? '核对生成标识后填写rec开头记录编号'
                              : '粘贴核对后的已有文档链接'
                        }
                        value={recovery[job.id] || ''}
                        onChange={(e) =>
                          setRecovery((current) => ({
                            ...current,
                            [job.id]: e.target.value,
                          }))
                        }
                      />
                      <Button
                        size="sm"
                        disabled={!editable || !recovery[job.id] || retrying === job.id}
                        onClick={() => void retry(job)}
                      >
                        绑定并继续
                      </Button>
                    </>
                  )}
                </div>
              ))}
          </section>
        )}
        {waiting && (
          <p>
            任务仍可在后台继续，
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setWaiting(false);
                setPollResume((value) => value + 1);
                const controller = new AbortController();
                void load(controller.signal);
              }}
            >
              查看最新状态
            </Button>
          </p>
        )}
        {dialog && record && (
          <Suspense
            fallback={
              <div className="weekly-opening" role="status">
                正在打开表单…
              </div>
            }
          >
            {dialog === 'generate' || dialog === 'create-row' ? (
              <GenerateDialog
                record={record}
                createOnly={dialog === 'create-row'}
                schedule={data?.schedule}
                jobs={jobs}
                onDeleteTask={
                  (role === 'admin' || (role === 'professional_admin' || role === 'professional_engineer'))
                    ? (job) => void changeTask(job, 'delete')
                    : undefined
                }
                onClose={() => setDialog(null)}
                onAccepted={accepted}
                onFillTodos={(kind) => setDialog(kind)}
              />
            ) : (
              <MeetingDialog
                key={`${record.id}:${dialog}`}
                record={record}
                kind={dialog}
                entry={
                  draft?.targetRecordId === record.id && draft.kind === dialog
                    ? draft
                    : meetings.find(
                        (m) =>
                          m.targetRecordId === record.id && m.kind === dialog,
                      )
                }
                people={data?.people || []}
                onClose={() => setDialog(null)}
                onAccepted={accepted}
              />
            )}
          </Suspense>
        )}
      </CardContent>
    </Card>
  );
}
