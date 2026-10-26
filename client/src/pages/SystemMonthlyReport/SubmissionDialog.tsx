import { useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  Check,
  CheckCircle2,
  FileSpreadsheet,
  Loader2,
  Save,
  UploadCloud,
} from 'lucide-react';
import type {
  SystemMonthlyReportRoom,
  SystemMonthlyReportStage,
  SystemMonthlyReportSubmissionOperation,
  SystemMonthlyReportTask,
} from '@shared/system-monthly-report.interface';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Progress } from '@/components/ui/progress';
import { cn } from '@/lib/utils';
import {
  retrySystemMonthlyReportTask,
  submitSystemMonthlyReportStage,
} from './api';
import {
  buildSystemMonthlyReportVersionedFileName,
  getSystemMonthlyReportSubmissionError,
  getSystemMonthlyReportTaskPresentation,
  validateSystemMonthlyReportUploadFile,
} from './system-monthly-report.logic';

type LocalSubmissionState =
  | 'idle'
  | 'ready'
  | 'submitting'
  | 'accepted'
  | 'syncing'
  | 'success'
  | 'error';

const STAGE_COPY: Record<
  SystemMonthlyReportStage,
  { title: string; attachment: string }
> = {
  initial: {
    title: '提交初版月报',
    attachment: '初版月报',
  },
  recheck: {
    title: '提交复审版月报',
    attachment: '复审月报',
  },
  final: {
    title: '归档最终版月报',
    attachment: '终版月报',
  },
};

interface SubmissionDialogProps {
  open: boolean;
  room: SystemMonthlyReportRoom | null;
  stage: SystemMonthlyReportStage;
  operation: SystemMonthlyReportSubmissionOperation;
  task: SystemMonthlyReportTask | null;
  reportYear: number;
  reportMonth: number;
  onOpenChange: (open: boolean) => void;
  onTaskChange: (task: SystemMonthlyReportTask) => void;
  onSynced: () => void;
}

export function SubmissionDialog({
  open,
  room,
  stage,
  operation,
  task,
  reportYear,
  reportMonth,
  onOpenChange,
  onTaskChange,
  onSynced,
}: SubmissionDialogProps) {
  const [file, setFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [localError, setLocalError] = useState('');
  const copy = STAGE_COPY[stage];
  const taskPresentation = task
    ? getSystemMonthlyReportTaskPresentation(task)
    : null;
  const state: LocalSubmissionState = submitting
    ? 'submitting'
    : task?.status === 'accepted'
      ? 'accepted'
      : task?.status === 'syncing'
        ? 'syncing'
        : task?.status === 'success'
          ? 'success'
          : task && ['error', 'uncertain'].includes(task.status)
            ? 'error'
            : file
              ? 'ready'
              : 'idle';
  const progress =
    state === 'success'
      ? 100
      : state === 'accepted' || state === 'syncing'
        ? 72
        : state === 'submitting'
          ? 45
          : file
            ? 30
            : 8;

  useEffect(() => {
    if (!open) return;
    setLocalError('');
    if (!task || task.status === 'success') setFile(null);
  }, [open, operation, room?.recordId, stage]);

  const suggestedName = useMemo(() => {
    if (!room) return '';
    return buildSystemMonthlyReportVersionedFileName(
      room.room,
      reportYear,
      reportMonth,
      stage,
      file?.name || '月报.xlsx',
    );
  }, [file?.name, reportMonth, reportYear, room, stage]);

  const submit = async () => {
    if (!room || !file || submitting) {
      if (!file) setLocalError('请先选择要提交的月报附件。');
      return;
    }
    const validationError = validateSystemMonthlyReportUploadFile(file);
    if (validationError) {
      setLocalError(validationError);
      return;
    }
    setSubmitting(true);
    setLocalError('');
    try {
      const response = await submitSystemMonthlyReportStage(
        {
          clientMutationId: crypto.randomUUID(),
          currentRecordId: room.recordId,
          room: room.room,
          stage,
          reportYear,
          reportMonth,
          versionedFileName: suggestedName,
          operation,
        },
        new File([file], suggestedName, {
          type: file.type || 'application/octet-stream',
          lastModified: file.lastModified,
        }),
      );
      onTaskChange(response.task);
    } catch (error) {
      setLocalError(readErrorMessage(error, '提交未受理，请检查文件后重试。'));
    } finally {
      setSubmitting(false);
    }
  };

  const retry = async () => {
    if (!task || submitting) return;
    setSubmitting(true);
    setLocalError('');
    try {
      onTaskChange(await retrySystemMonthlyReportTask(task.id));
    } catch (error) {
      setLocalError(readErrorMessage(error, '重新提交失败，请稍后再试。'));
    } finally {
      setSubmitting(false);
    }
  };

  const saveDraft = () => {
    if (!room) return;
    window.localStorage.setItem(
      `system-monthly-report:draft:${room.recordId}:${stage}`,
      JSON.stringify({
        room: room.room,
        stage,
        fileName: file?.name || '',
        savedAt: new Date().toISOString(),
      }),
    );
    setLocalError(
      file
        ? '草稿信息已保存在本机；出于安全限制，附件需下次重新选择。'
        : '草稿已保存。',
    );
  };

  useEffect(() => {
    if (task?.status === 'success') onSynced();
  }, [onSynced, task?.status]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl overflow-hidden p-0">
        <DialogHeader className="border-b border-slate-200 bg-slate-50 px-6 py-5 text-left">
          <DialogTitle className="text-xl text-slate-950">
            {operation === 'replace' ? `替换${copy.attachment}` : copy.title} ·{' '}
            {room?.room || '未选择机房'}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {room?.room || '体系月报'}
            {copy.attachment}附件提交表单
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6 px-6 py-5">
          <ol className="grid grid-cols-3 gap-2" aria-label="提交进度">
            {['选择附件', '提交月报', '完成'].map((label, index) => {
              const active = progress >= [8, 45, 72][index];
              const done = progress >= [45, 72, 100][index];
              return (
                <li
                  key={label}
                  className="flex items-center gap-2 text-xs font-medium text-slate-500"
                >
                  <span
                    className={cn(
                      'flex h-7 w-7 shrink-0 items-center justify-center rounded-full border',
                      done
                        ? 'border-emerald-600 bg-emerald-600 text-white'
                        : active
                          ? 'border-blue-600 bg-blue-50 text-blue-700'
                          : 'border-slate-200 bg-white',
                    )}
                  >
                    {done ? <Check className="h-4 w-4" /> : index + 1}
                  </span>
                  <span className={cn(active && 'text-slate-900')}>
                    {label}
                  </span>
                </li>
              );
            })}
          </ol>
          <Progress value={progress} className="h-1.5" />

          {state === 'success' ? (
            <section className="rounded-lg border border-emerald-200 bg-emerald-50 p-6 text-center">
              <CheckCircle2 className="mx-auto h-10 w-10 text-emerald-600" />
              <h3 className="mt-3 font-semibold text-emerald-950">
                月报提交完成
              </h3>
            </section>
          ) : taskPresentation &&
            ['accepted', 'syncing'].includes(task?.status || '') ? (
            <section className="rounded-lg border border-blue-200 bg-blue-50 p-5">
              <div className="flex items-start gap-3">
                <Loader2 className="mt-0.5 h-5 w-5 animate-spin text-blue-600" />
                <h3 className="font-semibold text-blue-950">正在提交月报</h3>
              </div>
            </section>
          ) : (
            <>
              <section>
                <div className="mb-2 flex items-center justify-between gap-4">
                  <label className="text-sm font-semibold text-slate-900">
                    {copy.attachment}
                  </label>
                  <span className="text-xs text-slate-500">
                    支持 XLSX、XLS、PDF，最大 150 MB
                  </span>
                </div>
                <label className="flex min-h-40 cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed border-blue-300 bg-blue-50/50 px-6 py-7 text-center transition hover:border-blue-500 hover:bg-blue-50">
                  <input
                    className="sr-only"
                    type="file"
                    accept=".xlsx,.xls,.pdf"
                    onChange={(event) => {
                      const selectedFile = event.target.files?.[0] || null;
                      if (!selectedFile) {
                        setFile(null);
                        setLocalError('');
                        return;
                      }
                      const validationError =
                        validateSystemMonthlyReportUploadFile(selectedFile);
                      if (validationError) {
                        setLocalError(validationError);
                        return;
                      }
                      setFile(selectedFile);
                      setLocalError('');
                    }}
                  />
                  {file ? (
                    <FileSpreadsheet className="h-9 w-9 text-emerald-600" />
                  ) : (
                    <UploadCloud className="h-9 w-9 text-blue-600" />
                  )}
                  <span className="mt-3 text-sm font-semibold text-slate-900">
                    {file?.name || '点击选择月报附件'}
                  </span>
                  <span className="mt-1 text-xs text-slate-500">
                    {file
                      ? `${formatBytes(file.size)} · 原文件：${file.name}`
                      : `建议文件名：${suggestedName}`}
                  </span>
                </label>
                {file ? (
                  <div className="mt-3 rounded-lg border border-blue-100 bg-blue-50/70 px-3 py-2 text-xs">
                    <span className="text-slate-500">提交版本：</span>
                    <strong className="ml-1 break-all text-blue-700">
                      {suggestedName}
                    </strong>
                  </div>
                ) : null}
              </section>

              {task && ['error', 'uncertain'].includes(task.status) ? (
                <div className="flex gap-3 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
                  <AlertCircle className="mt-0.5 h-5 w-5 shrink-0" />
                  <div>
                    <p className="font-semibold">提交未完成</p>
                    <p className="mt-1 leading-6">
                      {getSystemMonthlyReportSubmissionError(task)}
                    </p>
                  </div>
                </div>
              ) : null}
            </>
          )}

          {localError ? (
            <p
              className="flex items-start gap-2 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700"
              role="alert"
            >
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              {localError}
            </p>
          ) : null}
        </div>

        <DialogFooter className="border-t border-slate-200 bg-slate-50 px-6 py-4 sm:justify-between">
          <Button
            type="button"
            variant="ghost"
            onClick={saveDraft}
            disabled={state === 'success'}
          >
            <Save className="h-4 w-4" />
            保存草稿
          </Button>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              {state === 'success' ? '完成' : '关闭'}
            </Button>
            {task && ['error', 'uncertain'].includes(task.status) ? (
              <Button type="button" onClick={retry} disabled={submitting}>
                {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
                重新提交
              </Button>
            ) : state !== 'success' &&
              !['accepted', 'syncing'].includes(state) ? (
              <Button
                type="button"
                onClick={submit}
                disabled={!file || submitting}
              >
                {submitting ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <UploadCloud className="h-4 w-4" />
                )}
                {operation === 'replace' ? '确认替换' : '确认提交'}
              </Button>
            ) : null}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function readErrorMessage(_error: unknown, fallback: string): string {
  return fallback;
}
