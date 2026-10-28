import { useCallback, useEffect, useState } from 'react';
import {
  AlertCircle,
  BellRing,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  CirclePlay,
  FlaskConical,
  Loader2,
  RefreshCw,
  ShieldCheck,
  TimerReset,
  Workflow,
} from 'lucide-react';

import { useAccess } from '@/access/AccessProvider';
import { canUsePageAction } from '../business-action-access';
import {
  getInventoryWorkflowStatus,
  runInventoryWorkflow,
  runInventoryWorkflowSelfTest,
} from '@/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import type {
  InventoryWorkflowCode,
  InventoryWorkflowRunResult,
  InventoryWorkflowSelfTestResponse,
  InventoryWorkflowStatusResponse,
} from '@shared/inventory-management.interface';

const STATUS_REFRESH_MS = 60_000;

export function WorkflowAutomationPanel({
  embedded = false,
}: {
  embedded?: boolean;
}) {
  const access = useAccess();
  const canDelete = access.role === 'admin';
  const canEdit = canUsePageAction(access, 'inventory', 'notify', access.capabilities.canEdit);
  const canForceRefresh = canUsePageAction(access, 'inventory', 'read', access.capabilities.canForceRefresh);
  const [status, setStatus] = useState<InventoryWorkflowStatusResponse | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [runningCode, setRunningCode] = useState<InventoryWorkflowCode | null>(
    null,
  );
  const [testing, setTesting] = useState(false);
  const [feedback, setFeedback] = useState<{
    tone: 'success' | 'warning' | 'error';
    message: string;
  } | null>(null);
  const [selfTest, setSelfTest] =
    useState<InventoryWorkflowSelfTestResponse | null>(null);
  const [showLogs, setShowLogs] = useState(false);

  const loadStatus = useCallback(async (showLoading = false) => {
    if (showLoading) setLoading(true);
    try {
      const response = await getInventoryWorkflowStatus();
      setStatus(response);
      setError('');
    } catch {
      setError('自动化状态读取失败，请检查服务端和飞书配置。');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadStatus();
    const timer = window.setInterval(
      () => void loadStatus(),
      STATUS_REFRESH_MS,
    );
    return () => window.clearInterval(timer);
  }, [loadStatus]);

  const handleRun = async (code: InventoryWorkflowCode) => {
    if (!canEdit) return;
    setRunningCode(code);
    setFeedback(null);
    try {
      const result = await runInventoryWorkflow(code);
      setFeedback(runFeedback(result));
      await loadStatus();
    } catch {
      setFeedback({
        tone: 'error',
        message: '工作流执行请求失败，请查看服务日志后重试。',
      });
    } finally {
      setRunningCode(null);
    }
  };

  const handleSelfTest = async () => {
    if (!canDelete) return;
    setTesting(true);
    setFeedback(null);
    try {
      const result = await runInventoryWorkflowSelfTest();
      setSelfTest(result);
      setFeedback({
        tone: result.success ? 'success' : 'error',
        message: result.success
          ? '真实 Base 自测通过，测试记录已全部清理。'
          : `自测未通过：${result.checks
              .filter((item) => !item.success)
              .map((item) => item.message)
              .join('；')}`,
      });
      await loadStatus();
    } catch {
      setFeedback({
        tone: 'error',
        message: '自测请求失败；请先确认 Base 写入和删除权限。',
      });
    } finally {
      setTesting(false);
    }
  };

  return (
    <Card
      className={cn(
        'overflow-hidden border-[#bdd2f4] bg-white/95',
        embedded
          ? 'rounded-none border-0 shadow-none'
          : 'shadow-[0_10px_30px_rgba(27,75,143,0.10)]',
      )}
    >
      <CardHeader className="border-b border-blue-100 bg-gradient-to-r from-blue-50/90 via-white to-cyan-50/70 p-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="min-w-0">
            <CardTitle className="flex flex-wrap items-center gap-2 text-base font-bold text-slate-900">
              <span className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-blue-600 text-white shadow-md shadow-blue-200">
                <Workflow className="h-5 w-5" />
              </span>
              自动化运行中心
              <AutomationBadge status={status} />
            </CardTitle>
            <p className="mt-2 text-xs text-slate-500">
              采购入库由库房管理员人工确认；程序继续处理跨楼栋物品确认和运行日志。
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                if (canForceRefresh) void loadStatus(true);
              }}
              disabled={loading || !canForceRefresh}
              className="border-blue-200 text-blue-700 hover:bg-blue-50"
            >
              <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
              刷新状态
            </Button>
            {canDelete && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => void handleSelfTest()}
                disabled={testing || Boolean(runningCode)}
                className="border-emerald-200 text-emerald-700 hover:bg-emerald-50"
              >
                {testing ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <FlaskConical className="h-4 w-4" />
                )}
                {testing ? '自测中' : '运行自测'}
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowLogs((value) => !value)}
            >
              {showLogs ? (
                <ChevronUp className="h-4 w-4" />
              ) : (
                <ChevronDown className="h-4 w-4" />
              )}
              {showLogs ? '收起日志' : '展开日志'}
            </Button>
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-4 p-5">
        <div aria-live="polite" className="space-y-3">
          {error && <StatusBanner tone="error" message={error} />}
          {status && !status.enabled && (
            <StatusBanner
              tone={status.configured ? 'warning' : 'error'}
              message={
                status.message ||
                '程序功能已就绪，自动调度尚未切换；原多维表工作流继续运行，避免业务中断。'
              }
            />
          )}
          {feedback && (
            <StatusBanner tone={feedback.tone} message={feedback.message} />
          )}
        </div>

        {loading && !status ? (
          <div className="flex min-h-36 items-center justify-center rounded-xl border border-blue-100 bg-blue-50/40 text-sm text-slate-500">
            <Loader2 className="mr-2 h-5 w-5 animate-spin text-blue-600" />
            正在读取自动化状态
          </div>
        ) : status ? (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            {status.workflows.map((workflow) => {
              const active = runningCode === workflow.code || workflow.running;
              return (
                <article
                  key={workflow.code}
                  className="flex min-w-0 flex-col justify-between rounded-xl border border-[#d8e5f7] bg-white p-4 shadow-[0_4px_16px_rgba(27,75,143,0.05)]"
                >
                  <div>
                    <div className="flex items-start justify-between gap-3">
                      <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-blue-50 text-blue-600">
                        {workflow.code === 'item_confirmation' ? (
                          <BellRing className="h-4 w-4" />
                        ) : (
                          <TimerReset className="h-4 w-4" />
                        )}
                      </span>
                      <Badge
                        className={cn(
                          'shrink-0',
                          workflow.enabled
                            ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                            : 'border-amber-200 bg-amber-50 text-amber-700',
                        )}
                      >
                        {workflow.enabled
                          ? '程序运行中'
                          : workflow.scheduleLabel === '已改为库房人工确认'
                            ? '已转人工'
                            : '待切换'}
                      </Badge>
                    </div>
                    <h3
                      className="mt-3 truncate text-sm font-semibold text-slate-900"
                      title={workflow.name}
                    >
                      {workflow.name}
                    </h3>
                    <p className="mt-1 text-xs text-slate-500">
                      {workflow.triggerLabel} · {workflow.scheduleLabel}
                    </p>
                    <p className="mt-3 min-h-8 text-xs leading-4 text-slate-500">
                      {workflow.lastRun
                        ? lastRunSummary(workflow.lastRun)
                        : workflow.nextRunAt
                          ? `下次：${formatDateTime(workflow.nextRunAt)}`
                          : '尚无程序运行记录'}
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-3 w-full border-blue-200 text-blue-700 hover:bg-blue-50"
                    disabled={
                      !canEdit ||
                      !workflow.enabled ||
                      Boolean(runningCode) ||
                      testing ||
                      active
                    }
                    onClick={() => void handleRun(workflow.code)}
                  >
                    {active ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <CirclePlay className="h-4 w-4" />
                    )}
                    {active ? '执行中' : '立即执行'}
                  </Button>
                </article>
              );
            })}
          </div>
        ) : null}

        {selfTest && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-emerald-200 bg-emerald-50/70 px-4 py-3 text-xs text-emerald-800">
            <span className="inline-flex items-center gap-2 font-semibold">
              <ShieldCheck className="h-4 w-4" />
              最近自测：{selfTest.success ? '通过' : '未通过'}
            </span>
            <span>
              创建 {selfTest.createdRecordIds.length} 条 · 清理{' '}
              {selfTest.deletedRecordIds.length} 条 · 残留{' '}
              {selfTest.remainingRecords} 条
            </span>
          </div>
        )}

        {showLogs && (
          <section
            className="border-t border-blue-100 pt-4"
            aria-labelledby="workflow-log-title"
          >
            <div className="flex items-center justify-between gap-3">
              <h3
                id="workflow-log-title"
                className="flex items-center gap-2 text-sm font-semibold text-slate-800"
              >
                <TimerReset className="h-4 w-4 text-blue-600" />
                最近执行日志
              </h3>
              <span className="text-xs text-slate-400">最多显示 8 条</span>
            </div>
            {status?.recentLogs.length ? (
              <div className="mt-3 grid gap-2 lg:grid-cols-2">
                {status.recentLogs.slice(0, 8).map((log) => (
                  <div
                    key={log.recordId}
                    className="flex min-w-0 items-center gap-3 rounded-lg border border-slate-100 px-3 py-2.5 text-xs"
                  >
                    {log.error ? (
                      <AlertCircle className="h-4 w-4 shrink-0 text-rose-500" />
                    ) : (
                      <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" />
                    )}
                    <span className="min-w-0 flex-1">
                      <strong className="block truncate text-slate-700">
                        {log.workflowName}
                      </strong>
                      <span className="mt-0.5 block truncate text-slate-400">
                        {log.error || log.result || log.stage}
                      </span>
                    </span>
                    <span className="shrink-0 text-slate-400">
                      {formatDateTime(log.lastRunAt)}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="mt-3 rounded-xl border border-dashed border-blue-200 bg-blue-50/30 py-8 text-center text-xs text-slate-400">
                暂无程序执行日志
              </div>
            )}
          </section>
        )}
      </CardContent>
    </Card>
  );
}

function AutomationBadge({
  status,
}: {
  status: InventoryWorkflowStatusResponse | null;
}) {
  if (!status) return null;
  return (
    <Badge
      className={cn(
        status.enabled
          ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
          : 'border-amber-200 bg-amber-50 text-amber-700',
      )}
    >
      {status.enabled ? '4 条程序工作流已启用' : '4 条程序工作流已就绪'}
    </Badge>
  );
}

function StatusBanner({
  tone,
  message,
}: {
  tone: 'success' | 'warning' | 'error';
  message: string;
}) {
  const Icon = tone === 'success' ? CheckCircle2 : AlertCircle;
  return (
    <div
      className={cn(
        'flex items-start gap-2 rounded-lg border px-3 py-2.5 text-xs leading-5',
        tone === 'success' &&
          'border-emerald-200 bg-emerald-50 text-emerald-800',
        tone === 'warning' && 'border-amber-200 bg-amber-50 text-amber-800',
        tone === 'error' && 'border-rose-200 bg-rose-50 text-rose-800',
      )}
    >
      <Icon className="mt-0.5 h-4 w-4 shrink-0" />
      <span>{message}</span>
    </div>
  );
}

function runFeedback(result: InventoryWorkflowRunResult) {
  if (result.failed > 0) {
    return {
      tone: 'error' as const,
      message: `${result.code} 执行完成，但 ${result.failed} 条失败；已成功处理 ${result.processed} 条。`,
    };
  }
  return {
    tone: result.processed > 0 ? ('success' as const) : ('warning' as const),
    message:
      result.processed > 0
        ? `执行完成：处理 ${result.processed} 条，通知 ${result.notified} 人，跳过 ${result.skipped} 条。`
        : `本次没有待处理记录，跳过 ${result.skipped} 条。`,
  };
}

function lastRunSummary(result: InventoryWorkflowRunResult): string {
  return `最近：处理 ${result.processed} · 跳过 ${result.skipped} · 失败 ${result.failed}`;
}

function formatDateTime(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}
