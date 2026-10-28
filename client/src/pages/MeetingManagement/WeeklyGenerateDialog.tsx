import { canUsePageAction } from '../business-action-access';
import { useAccess } from '@/access/AccessProvider';
import { useEffect, useRef, useState } from 'react';
import { NavLink } from 'react-router-dom';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import {
  weeklyTodosEmpty,
  WEEKLY_EMPTY_TODOS_MESSAGE,
} from '../../../../shared/weekly-workspace.rules';
import type { MeetingSummary } from '../../../../shared/meeting-management.interface';
import type {
  GenerateWeeklyReport,
  WeeklyJob,
  WeeklyWorkspace,
} from '../../../../shared/weekly-workspace.interface';
import { meetingError } from './api';
import { weeklyMutation, weeklyFormRecord } from './weekly-api';
import {
  canDeleteWeeklyTask,
  weeklyCreationBlockReason,
} from '../../../../shared/weekly-job-locks';

export function WeeklyGenerateDialog({
  record,
  onClose,
  onAccepted,
  createOnly = false,
  schedule,
  jobs = [],
  onDeleteTask,
  onFillTodos,
}: {
  record: MeetingSummary;
  onClose: () => void;
  onAccepted: (job: WeeklyJob) => void;
  createOnly?: boolean;
  schedule?: WeeklyWorkspace['schedule'];
  jobs?: WeeklyJob[];
  onDeleteTask?: (job: WeeklyJob) => void;
  onFillTodos?: (kind: 'ali' | 'local') => void;
}) {
  const canGenerate = canUsePageAction(useAccess(), 'meetings', record.id === 'new' ? 'create' : 'update', true);
  const date = new Date(`${record.date}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 6);
  const [startDate, setStart] = useState(date.toISOString().slice(0, 10));
  const [endDate, setEnd] = useState(record.date || '');
  const [state, setState] = useState<'ready' | 'submitting' | 'error'>('ready');
  const [error, setError] = useState<string | null>(null);
  const mutation = useRef<GenerateWeeklyReport | null>(null);
  const submitting = useRef(false);
  const mounted = useRef(true);
  const [targetReady, setTargetReady] = useState(record.id === 'new');
  const [documentUrl, setDocumentUrl] = useState(record.documentUrl);
  const [readAttempt, setReadAttempt] = useState(0);
  const [emptyTodos, setEmptyTodos] = useState(false);
  const [confirmedNoTodos, setConfirmedNoTodos] = useState(false);
  const creationBlockReason =
    record.id === 'new' ? weeklyCreationBlockReason(endDate, jobs) : '';
  const oldTasks =
    record.id === 'new'
      ? jobs.filter(
          (job) => job.endDate === endDate && canDeleteWeeklyTask(job),
        )
      : [];
  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    if (record.id !== 'new') {
      setTargetReady(false);
      void weeklyFormRecord(record.id, controller.signal)
        .then((result) => {
          if (controller.signal.aborted) return;
          if (result.meeting.date !== record.date) {
            setError('目标周报日期已修改，请重新选择条目');
            return;
          }
          setDocumentUrl(result.meeting.documentUrl);
          setEmptyTodos(weeklyTodosEmpty(result.meeting.sections));
          setConfirmedNoTodos(false);
          setTargetReady(true);
          setError(null);
        })
        .catch((reason) => {
          if (!controller.signal.aborted) setError(meetingError(reason));
        });
    }
    return () => {
      mounted.current = false;
      controller.abort();
    };
  }, [record.id, record.date, readAttempt]);
  const save = async () => {
    if (!canGenerate || submitting.current || !targetReady || creationBlockReason) return;
    if (!createOnly && emptyTodos && !confirmedNoTodos) return;
    if (!startDate || !endDate || startDate > endDate) {
      setError('请选择有效的起止日期');
      return;
    }
    if (record.id !== 'new' && endDate !== record.date) {
      setError('结束日期须与目标周报日期一致，请切换目标条目');
      return;
    }
    submitting.current = true;
    setState('submitting');
    setError(null);
    const command = mutation.current || {
      clientMutationId: crypto.randomUUID(),
      targetRecordId: record.id,
      startDate,
      endDate,
      expectedDocumentUrl: documentUrl,
      createOnly,
      ...(!createOnly && confirmedNoTodos ? { confirmedNoTodos: true } : {}),
    };
    mutation.current = command;
    try {
      const job = await weeklyMutation('generate', command);
      if (mounted.current) onAccepted(job);
    } catch (reason) {
      if (mounted.current) {
        setState('error');
        const message = meetingError(reason);
        setError(message);
        if (message.includes(WEEKLY_EMPTY_TODOS_MESSAGE)) {
          setEmptyTodos(true);
          setConfirmedNoTodos(false);
          mutation.current = null;
        }
      }
    } finally {
      submitting.current = false;
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && state !== 'submitting') onClose();
      }}
    >
      <DialogContent className="weekly-dialog">
        <DialogHeader>
          <DialogTitle>{createOnly ? '新建周报条目' : '生成周报'}</DialogTitle>
          <DialogDescription className="sr-only">
            选择本期统计起止周期
          </DialogDescription>
        </DialogHeader>
        <div className="weekly-target">
          <strong>{record.title}</strong>
          <span>{record.id === 'new' ? endDate : record.date} · 目标周报</span>
        </div>
        <div className="weekly-form-grid">
          <label>
            开始日期
            <Input
              type="date"
              value={startDate}
              disabled={state === 'submitting'}
              onChange={(e) => {
                setStart(e.target.value);
                mutation.current = null;
                setError(null);
              }}
            />
          </label>
          <label>
            结束日期
            <Input
              type="date"
              value={endDate}
              disabled={state === 'submitting'}
              onChange={(e) => {
                setEnd(e.target.value);
                mutation.current = null;
                setError(null);
              }}
            />
          </label>
        </div>
        {!createOnly && (
          <div className="weekly-generation-info">
            <NavLink
              to="/meeting-templates/nantong-weekly-v3.html"
              target="_blank"
              rel="noreferrer"
            >
              查看周报模板 v3
            </NavLink>
            <span>
              {schedule
                ? schedule.enabled
                  ? `定时生成：每周${['日', '一', '二', '三', '四', '五', '六'][schedule.weekday]} ${schedule.time}（北京时间）`
                  : '定时生成尚未开启，可手动生成'
                : '正在读取定时生成状态…'}
            </span>
          </div>
        )}
        {!targetReady && !error && (
          <p role="status" className="weekly-muted">
            正在核对目标周报…
          </p>
        )}
        {!createOnly && targetReady && emptyTodos && (
          <div className="weekly-empty-todos">
            <p role="status">{WEEKLY_EMPTY_TODOS_MESSAGE}</p>
            {onFillTodos && (
              <div className="weekly-empty-todos-actions">
                <Button variant="outline" onClick={() => onFillTodos('ali')}>
                  填写阿里待办
                </Button>
                <Button variant="outline" onClick={() => onFillTodos('local')}>
                  填写属地待办
                </Button>
              </div>
            )}
            <label className="weekly-empty-todos-confirm">
              <Checkbox
                checked={confirmedNoTodos}
                disabled={state === 'submitting'}
                onCheckedChange={(checked) => {
                  setConfirmedNoTodos(checked === true);
                  mutation.current = null;
                }}
              />
              确认本期无阿里及属地周会待办，继续生成
            </label>
          </div>
        )}
        {documentUrl && (
          <p>重新生成将更新这份周报文档，手工编辑内容可能被替换。</p>
        )}
        {creationBlockReason && (
          <div role="alert" className="weekly-error">
            <p>{creationBlockReason}</p>
            {oldTasks.map((job) => (
              <div key={job.id}>
                {job.deletion?.status === 'error' && (
                  <p>删除失败：{job.deletion.error}</p>
                )}
                {onDeleteTask && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => onDeleteTask(job)}
                  >
                    删除旧任务
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
        {error && (
          <p role="alert" className="weekly-error">
            {error}
          </p>
        )}
        {!targetReady && error && (
          <Button
            variant="outline"
            onClick={() => setReadAttempt((value) => value + 1)}
          >
            重新读取
          </Button>
        )}
        <div className="weekly-dialog-footer">
          <Button
            variant="outline"
            disabled={state === 'submitting'}
            onClick={onClose}
          >
            取消
          </Button>
          <Button
            disabled={
              !canGenerate || state === 'submitting' ||
              !targetReady ||
              (!createOnly && emptyTodos && !confirmedNoTodos) ||
              Boolean(creationBlockReason)
            }
            onClick={() => void save()}
          >
            {state === 'submitting'
              ? '正在提交…'
              : createOnly
                ? '新建条目'
                : '开始生成'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
