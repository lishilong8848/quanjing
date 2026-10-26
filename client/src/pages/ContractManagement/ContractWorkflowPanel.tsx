import { useCallback, useEffect, useState } from 'react';
import {
  CheckCircle2,
  FlaskConical,
  Loader2,
  Play,
  ShieldCheck,
  Workflow,
  X,
} from 'lucide-react';
import {
  getContractWorkflowStatus,
  runContractWorkflow,
  runContractWorkflowSelfTest,
} from '@/api';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import type {
  ContractWorkflowCode,
  ContractWorkflowStatusResponse,
} from '@shared/contract-management.interface';

export function ContractWorkflowPanel({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [status, setStatus] = useState<ContractWorkflowStatusResponse | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [runningCode, setRunningCode] = useState<ContractWorkflowCode | null>(
    null,
  );
  const [selfTesting, setSelfTesting] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [pendingWorkflow, setPendingWorkflow] = useState<{
    code: ContractWorkflowCode;
    name: string;
  } | null>(null);

  const loadStatus = useCallback(async () => {
    try {
      setStatus(await getContractWorkflowStatus());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void loadStatus();
    const timer = window.setInterval(() => void loadStatus(), 30_000);
    return () => window.clearInterval(timer);
  }, [loadStatus, open]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose, open]);

  const handleRun = async (code: ContractWorkflowCode) => {
    setRunningCode(code);
    setFeedback('');
    try {
      const result = await runContractWorkflow(code);
      setFeedback(result.message);
      void loadStatus().catch(() => {
        toast.warning('工作流已执行，但状态刷新失败，请手动刷新');
      });
    } catch {
      setFeedback('执行失败，请查看服务端日志或稍后重试。');
    } finally {
      setRunningCode(null);
    }
  };

  const handleSelfTest = async () => {
    setSelfTesting(true);
    setFeedback('');
    try {
      const result = await runContractWorkflowSelfTest();
      setFeedback(
        `${result.message}；合同 ${result.contracts}、付款计划 ${result.payments}、管理接收人 ${result.managerReceivers}`,
      );
    } catch {
      setFeedback('自检失败，请检查飞书数据源权限。');
    } finally {
      setSelfTesting(false);
    }
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-slate-950/35 px-4 py-16 backdrop-blur-[2px] sm:items-center sm:py-6"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="contract-workflow-dialog-title"
        className="max-h-[calc(100vh-5rem)] w-full max-w-4xl overflow-y-auto rounded-xl border border-blue-100 bg-white p-5 shadow-2xl shadow-slate-950/20 sm:p-6"
      >
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="flex items-start gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-blue-600 text-white shadow-md shadow-blue-200">
              <Workflow className="h-5 w-5" />
            </span>
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h2
                  id="contract-workflow-dialog-title"
                  className="text-base font-bold text-slate-950"
                >
                  合同执行工作流
                </h2>
                <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2.5 py-1 text-[11px] font-semibold text-emerald-700">
                  <ShieldCheck className="h-3.5 w-3.5" />
                  多维原工作流未停用
                </span>
              </div>
              <p className="mt-1 text-xs leading-5 text-slate-500">
                付款日前一天提醒、合同结束日前一天提醒
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void handleSelfTest()}
              disabled={selfTesting}
              className="inline-flex h-9 items-center justify-center gap-2 rounded-lg border border-blue-200 bg-blue-50 px-3 text-xs font-semibold text-blue-700 transition hover:bg-blue-100 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {selfTesting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <FlaskConical className="h-4 w-4" />
              )}
              只读自检
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="关闭合同执行工作流"
              className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200 text-slate-500 transition hover:bg-slate-100 hover:text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {loading ? (
          <div className="mt-5 flex h-24 items-center justify-center text-slate-400">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : (
          <div className="mt-5 grid gap-3 md:grid-cols-2">
            {status?.workflows.map((workflow) => {
              const running = runningCode === workflow.code || workflow.running;
              return (
                <article
                  key={workflow.code}
                  className="rounded-lg border border-slate-200 bg-slate-50/70 p-4"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p
                        className="truncate text-sm font-bold text-slate-900"
                        title={workflow.name}
                      >
                        {workflow.name}
                      </p>
                      <p className="mt-1 text-xs text-slate-500">
                        {workflow.triggerLabel} · {workflow.scheduleLabel}
                      </p>
                    </div>
                    <span
                      className={cn(
                        'shrink-0 rounded-full px-2 py-1 text-[11px] font-semibold',
                        workflow.enabled
                          ? 'bg-emerald-50 text-emerald-700'
                          : 'bg-slate-200 text-slate-600',
                      )}
                    >
                      {workflow.enabled ? '程序运行中' : '程序已关闭'}
                    </span>
                  </div>
                  <p className="mt-3 text-xs text-slate-500">
                    {workflow.lastRun
                      ? `最近：${workflow.lastRun.message}`
                      : workflow.nextRunAt
                        ? `下次：${formatDateTime(workflow.nextRunAt)}`
                        : '等待首次调度'}
                  </p>
                  <button
                    type="button"
                    onClick={() =>
                      setPendingWorkflow({
                        code: workflow.code,
                        name: workflow.name,
                      })
                    }
                    disabled={running || !workflow.enabled}
                    className="mt-4 inline-flex h-8 w-full items-center justify-center gap-2 rounded-lg bg-blue-600 px-3 text-xs font-semibold text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-slate-300"
                  >
                    {running ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Play className="h-3.5 w-3.5" />
                    )}
                    {running ? '执行中' : '手动执行'}
                  </button>
                </article>
              );
            })}
          </div>
        )}

        {(feedback || status?.message) && (
          <div className="mt-4 flex items-start gap-2 rounded-lg border border-blue-100 bg-blue-50/70 px-3 py-2.5 text-xs leading-5 text-blue-800">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{feedback || status?.message}</span>
          </div>
        )}
      </section>

      <AlertDialog
        open={Boolean(pendingWorkflow)}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setPendingWorkflow(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              确认执行“{pendingWorkflow?.name}”吗？
            </AlertDialogTitle>
            <AlertDialogDescription>
              手动执行会按当前命中数据真实发送飞书消息。确认后立即开始执行。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const workflow = pendingWorkflow;
                setPendingWorkflow(null);
                if (workflow) void handleRun(workflow.code);
              }}
            >
              确认执行
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? '待定'
    : date.toLocaleString('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      });
}
