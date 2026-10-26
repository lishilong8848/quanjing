import { useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Circle,
  ClipboardCheck,
  FileImage,
  FileSpreadsheet,
  Loader2,
  ShieldAlert,
  UserRound,
} from 'lucide-react';
import type {
  SystemMonthlyReportModuleKey,
  SystemMonthlyReportReviewRequest,
  SystemMonthlyReportReviewRound,
  SystemMonthlyReportRoom,
  SystemMonthlyReportStandard,
  SystemMonthlyReportTask,
} from '@shared/system-monthly-report.interface';

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import {
  retrySystemMonthlyReportTask,
  submitSystemMonthlyReportReview,
} from './api';
import { getSystemMonthlyReportTaskPresentation } from './system-monthly-report.logic';

const MODULES: Array<{
  key: SystemMonthlyReportModuleKey;
  standardKey: SystemMonthlyReportStandard['key'];
  label: string;
  shortLabel: string;
}> = [
  { key: 'event', standardKey: 'event', label: '事件管理', shortLabel: '事件' },
  {
    key: 'change',
    standardKey: 'change',
    label: '变更管理',
    shortLabel: '变更',
  },
  {
    key: 'maintenance',
    standardKey: 'maintenance',
    label: '维护管理',
    shortLabel: '维护',
  },
  { key: 'drill', standardKey: 'drill', label: '演练管理', shortLabel: '演练' },
  {
    key: 'other',
    standardKey: 'risk',
    label: '风险 / 其他问题',
    shortLabel: '其他',
  },
];

type ModuleDraft = {
  hasIssue: boolean;
  description: string;
  screenshot: File | null;
};

interface ReviewWorkbenchProps {
  open: boolean;
  room: SystemMonthlyReportRoom | null;
  round: SystemMonthlyReportReviewRound;
  standards: SystemMonthlyReportStandard[];
  task: SystemMonthlyReportTask | null;
  onOpenChange: (open: boolean) => void;
  onTaskChange: (task: SystemMonthlyReportTask) => void;
  onSynced: () => void;
}

export function ReviewWorkbench({
  open,
  room,
  round,
  standards,
  task,
  onOpenChange,
  onTaskChange,
  onSynced,
}: ReviewWorkbenchProps) {
  const [drafts, setDrafts] =
    useState<Record<SystemMonthlyReportModuleKey, ModuleDraft>>(emptyDrafts);
  const [completed, setCompleted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const prefix = round === 'initial' ? '初审' : '复审';
  const reviewer =
    round === 'initial' ? room?.initialReviewer : room?.recheckReviewer;
  const taskPresentation = task
    ? getSystemMonthlyReportTaskPresentation(task)
    : null;
  const issueCount = MODULES.filter(({ key }) => drafts[key].hasIssue).length;

  useEffect(() => {
    if (!open) return;
    setDrafts(emptyDrafts());
    setCompleted(false);
    setError('');
  }, [open, room?.recordId, round]);

  useEffect(() => {
    if (task?.status === 'success') onSynced();
  }, [onSynced, task?.status]);

  const standardMap = useMemo(
    () => new Map(standards.map((standard) => [standard.key, standard])),
    [standards],
  );

  const updateDraft = (
    key: SystemMonthlyReportModuleKey,
    patch: Partial<ModuleDraft>,
  ) => {
    setDrafts((current) => ({
      ...current,
      [key]: { ...current[key], ...patch },
    }));
    setError('');
  };

  const submit = async () => {
    if (!room || submitting) return;
    const invalid = MODULES.find(
      ({ key }) =>
        drafts[key].hasIssue &&
        (!drafts[key].description.trim() || !drafts[key].screenshot),
    );
    if (invalid) {
      setError(`${invalid.label}标记为有问题时，必须填写问题描述并上传截图。`);
      return;
    }
    if (!completed) {
      setError('请确认已完成全部审核项。');
      return;
    }

    const request: SystemMonthlyReportReviewRequest = {
      clientMutationId: crypto.randomUUID(),
      currentRecordId: room.recordId,
      room: room.room,
      round,
      completed,
      modules: Object.fromEntries(
        MODULES.map(({ key }) => [
          key,
          {
            hasIssue: drafts[key].hasIssue,
            description: drafts[key].description.trim(),
          },
        ]),
      ) as SystemMonthlyReportReviewRequest['modules'],
    };
    const screenshots = Object.fromEntries(
      MODULES.flatMap(({ key }) =>
        drafts[key].screenshot ? [[key, drafts[key].screenshot]] : [],
      ),
    );
    setSubmitting(true);
    setError('');
    try {
      const response = await submitSystemMonthlyReportReview(
        request,
        screenshots,
      );
      onTaskChange(response.task);
    } catch (submitError) {
      setError(
        readErrorMessage(submitError, '审核意见未受理，请检查内容后重试。'),
      );
    } finally {
      setSubmitting(false);
    }
  };

  const retry = async () => {
    if (!task || submitting) return;
    setSubmitting(true);
    setError('');
    try {
      onTaskChange(await retrySystemMonthlyReportTask(task.id));
    } catch (retryError) {
      setError(readErrorMessage(retryError, '重新提交失败，请稍后再试。'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[90vh] max-w-[1180px] flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="border-b border-slate-200 bg-slate-50 px-6 py-4 text-left">
          <div className="flex flex-wrap items-center justify-between gap-3 pr-8">
            <div>
              <DialogTitle className="text-xl">
                {prefix}工作台 · {room?.room || '未选择机房'}
              </DialogTitle>
              <DialogDescription className="sr-only">
                {room?.room || '体系月报'}
                {prefix}审核表单
              </DialogDescription>
            </div>
            <Badge
              variant="outline"
              className="border-blue-200 bg-blue-50 text-blue-700"
            >
              <UserRound className="mr-1 h-3.5 w-3.5" />
              审核人：{reviewer?.name || '待认领'}
            </Badge>
          </div>
        </DialogHeader>

        <div className="grid min-h-0 flex-1 lg:grid-cols-[340px_minmax(0,1fr)]">
          <aside className="border-b border-slate-200 bg-slate-50/70 lg:border-b-0 lg:border-r">
            <ScrollArea className="h-full">
              <div className="space-y-5 p-5">
                <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
                  <div className="flex items-center gap-3">
                    <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-blue-50 text-blue-700">
                      <FileSpreadsheet className="h-5 w-5" />
                    </span>
                    <div className="min-w-0">
                      <h3 className="font-semibold text-slate-950">
                        待审核月报
                      </h3>
                      <p className="truncate text-xs text-slate-500">
                        {room?.code || '月报记录'}
                      </p>
                    </div>
                  </div>
                </section>

                <section>
                  <h3 className="mb-3 text-sm font-semibold text-slate-950">
                    审核进度
                  </h3>
                  <ol className="space-y-0">
                    {room?.steps.map((step, index) => (
                      <li
                        key={step.key}
                        className="relative flex gap-3 pb-4 last:pb-0"
                      >
                        {index < room.steps.length - 1 ? (
                          <span className="absolute left-[9px] top-5 h-full w-px bg-slate-200" />
                        ) : null}
                        {step.state === 'completed' ? (
                          <CheckCircle2 className="relative z-10 h-5 w-5 shrink-0 bg-slate-50 text-emerald-600" />
                        ) : step.state === 'current' ? (
                          <Loader2 className="relative z-10 h-5 w-5 shrink-0 animate-spin bg-slate-50 text-blue-600" />
                        ) : (
                          <Circle className="relative z-10 h-5 w-5 shrink-0 bg-slate-50 text-slate-300" />
                        )}
                        <div className="min-w-0">
                          <p
                            className={cn(
                              'text-sm font-medium',
                              step.state === 'current'
                                ? 'text-blue-700'
                                : 'text-slate-700',
                            )}
                          >
                            {step.label}
                          </p>
                          <p className="mt-0.5 text-xs text-slate-400">
                            {step.date || '待排期'}
                          </p>
                        </div>
                      </li>
                    ))}
                  </ol>
                </section>

                <section className="rounded-lg border border-amber-200 bg-amber-50 p-4">
                  <div className="flex gap-2 text-amber-900">
                    <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
                    <div>
                      <h3 className="text-sm font-semibold">字段口径提醒</h3>
                      <p className="mt-1 text-xs leading-5">
                        审核表中的“其他问题”对应评分标准里的“风险管理”，请按风险标准核查。
                      </p>
                    </div>
                  </div>
                </section>
              </div>
            </ScrollArea>
          </aside>

          <main className="flex min-h-0 flex-col bg-white">
            <ScrollArea className="min-h-0 flex-1">
              <div className="space-y-4 p-5 md:p-6">
                {task && taskPresentation ? (
                  <div
                    className={cn(
                      'flex gap-3 rounded-lg border p-4 text-sm',
                      task.status === 'success'
                        ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
                        : ['accepted', 'syncing'].includes(task.status)
                          ? 'border-blue-200 bg-blue-50 text-blue-900'
                          : 'border-amber-200 bg-amber-50 text-amber-900',
                    )}
                  >
                    {taskPresentation.busy ? (
                      <Loader2 className="h-5 w-5 animate-spin" />
                    ) : (
                      <CheckCircle2 className="h-5 w-5" />
                    )}
                    <p className="font-semibold">{taskPresentation.label}</p>
                  </div>
                ) : null}

                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h2 className="font-semibold text-slate-950">模块审核表</h2>
                    <p className="mt-1 text-sm text-slate-500">
                      已标记 {issueCount} 个问题模块
                    </p>
                  </div>
                  <Badge variant="secondary">每模块权重 20%</Badge>
                </div>

                <Accordion
                  type="multiple"
                  defaultValue={MODULES.map(({ key }) => key)}
                  className="rounded-lg border border-slate-200 px-4"
                >
                  {MODULES.map((module) => {
                    const draft = drafts[module.key];
                    const standard = standardMap.get(module.standardKey);
                    return (
                      <AccordionItem key={module.key} value={module.key}>
                        <AccordionTrigger className="hover:no-underline">
                          <span className="flex min-w-0 items-center gap-3">
                            <span
                              className={cn(
                                'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg',
                                draft.hasIssue
                                  ? 'bg-rose-50 text-rose-600'
                                  : 'bg-emerald-50 text-emerald-600',
                              )}
                            >
                              {draft.hasIssue ? (
                                <AlertCircle className="h-4 w-4" />
                              ) : (
                                <CheckCircle2 className="h-4 w-4" />
                              )}
                            </span>
                            <span>
                              <span className="block font-semibold text-slate-900">
                                {module.label}
                              </span>
                              <span className="mt-0.5 block text-xs font-normal text-slate-500">
                                {standard?.rule ||
                                  '按月报审核标准核查完整性与闭环情况'}
                              </span>
                            </span>
                          </span>
                        </AccordionTrigger>
                        <AccordionContent className="space-y-4 pb-5 pl-0 md:pl-11">
                          {standard?.regionalRule ? (
                            <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs leading-5 text-slate-600">
                              区域补充：{standard.regionalRule}
                            </p>
                          ) : null}
                          <fieldset>
                            <legend className="mb-2 text-sm font-medium text-slate-800">
                              是否存在问题
                            </legend>
                            <div className="flex gap-2">
                              <Button
                                type="button"
                                variant={
                                  !draft.hasIssue ? 'default' : 'outline'
                                }
                                size="sm"
                                onClick={() =>
                                  updateDraft(module.key, {
                                    hasIssue: false,
                                    description: '',
                                    screenshot: null,
                                  })
                                }
                              >
                                无问题
                              </Button>
                              <Button
                                type="button"
                                variant={
                                  draft.hasIssue ? 'destructive' : 'outline'
                                }
                                size="sm"
                                onClick={() =>
                                  updateDraft(module.key, { hasIssue: true })
                                }
                              >
                                有问题
                              </Button>
                            </div>
                          </fieldset>

                          {draft.hasIssue ? (
                            <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_220px]">
                              <label className="space-y-2 text-sm font-medium text-slate-800">
                                问题描述{' '}
                                <span className="text-rose-600">*</span>
                                <Textarea
                                  value={draft.description}
                                  onChange={(event) =>
                                    updateDraft(module.key, {
                                      description: event.target.value,
                                    })
                                  }
                                  placeholder={`说明${module.shortLabel}问题、影响和建议修改点`}
                                  className="min-h-28 bg-white"
                                />
                              </label>
                              <label className="space-y-2 text-sm font-medium text-slate-800">
                                问题截图{' '}
                                <span className="text-rose-600">*</span>
                                <span className="flex min-h-28 cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed border-slate-300 bg-slate-50 px-3 text-center transition hover:border-blue-400">
                                  <input
                                    className="sr-only"
                                    type="file"
                                    accept=".png,.jpg,.jpeg,.webp"
                                    onChange={(event) =>
                                      updateDraft(module.key, {
                                        screenshot:
                                          event.target.files?.[0] || null,
                                      })
                                    }
                                  />
                                  <FileImage className="h-6 w-6 text-slate-400" />
                                  <span className="mt-2 max-w-full truncate text-xs text-slate-600">
                                    {draft.screenshot?.name || '上传截图'}
                                  </span>
                                </span>
                              </label>
                            </div>
                          ) : null}
                        </AccordionContent>
                      </AccordionItem>
                    );
                  })}
                </Accordion>

                <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-slate-200 bg-slate-50 p-4">
                  <Checkbox
                    checked={completed}
                    onCheckedChange={(checked) =>
                      setCompleted(checked === true)
                    }
                    className="mt-0.5"
                  />
                  <span className="block text-sm font-semibold text-slate-900">
                    我已完成全部模块审核
                  </span>
                </label>

                {error ? (
                  <p
                    className="flex gap-2 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700"
                    role="alert"
                  >
                    <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                    {error}
                  </p>
                ) : null}
              </div>
            </ScrollArea>

            <footer className="flex flex-wrap items-center justify-end gap-3 border-t border-slate-200 bg-white px-5 py-4 shadow-[0_-8px_24px_rgba(15,23,42,0.05)] md:px-6">
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => onOpenChange(false)}>
                  {task?.status === 'success' ? '完成' : '关闭'}
                </Button>
                {task && ['error', 'uncertain'].includes(task.status) ? (
                  <Button onClick={retry} disabled={submitting}>
                    {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
                    重新提交
                  </Button>
                ) : !task ||
                  !['accepted', 'syncing', 'success'].includes(task.status) ? (
                  <Button onClick={submit} disabled={submitting || !completed}>
                    {submitting ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <ClipboardCheck className="h-4 w-4" />
                    )}
                    提交{prefix}意见
                  </Button>
                ) : null}
              </div>
            </footer>
          </main>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function emptyDrafts(): Record<SystemMonthlyReportModuleKey, ModuleDraft> {
  return {
    event: { hasIssue: false, description: '', screenshot: null },
    change: { hasIssue: false, description: '', screenshot: null },
    maintenance: { hasIssue: false, description: '', screenshot: null },
    drill: { hasIssue: false, description: '', screenshot: null },
    other: { hasIssue: false, description: '', screenshot: null },
  };
}

function readErrorMessage(_error: unknown, fallback: string): string {
  return fallback;
}
