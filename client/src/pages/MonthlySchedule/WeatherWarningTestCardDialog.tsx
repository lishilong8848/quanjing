import { logger } from '@lark-apaas/client-toolkit/logger';
import {
  AlertCircle,
  CheckCircle2,
  ExternalLink,
  Loader2,
  RefreshCw,
  Send,
  ShieldAlert,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';

import {
  getWeatherWarningTestPreview,
  sendWeatherWarningTestCard,
} from '@/api';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type {
  WeatherWarningCheckState,
  WeatherWarningDisplayWarning,
  WeatherWarningMetricSnapshot,
  WeatherWarningTestPreviewResponse,
  WeatherWarningTestSendRequest,
  WeatherWarningTestSendResponse,
} from '@shared/api.interface';
import {
  clearPendingWeatherWarningTestRequest,
  createWeatherWarningTestSubmissionGate,
  getOrCreateWeatherWarningTestRequest,
  isWeatherWarningTestResultUncertain,
  readPendingWeatherWarningTestRequest,
} from './weather-warning-test-send';

const CHECKLIST_DOWNLOAD_URL =
  'https://example.feishu.cn/wiki/PUBLIC_EXAMPLE_SOURCE';

const CHECK_ITEMS = [
  { key: 'device', label: '设备安全' },
  { key: 'environment', label: '环境安全' },
  { key: 'disaster', label: '灾害专项' },
  { key: 'materials', label: '物资清单' },
  { key: 'contacts', label: '联络清单' },
  { key: 'managerConfirmation', label: '机房经理确认' },
] as const;

type DialogPhase =
  | 'idle'
  | 'loading'
  | 'ready'
  | 'error'
  | 'uncertain'
  | 'sending'
  | 'sent';

type WeatherWarningTestDialogDismissReason = 'close' | 'escape' | 'outside';

export interface WeatherWarningTestPreviewRequestGate {
  start: () => number | null;
  invalidate: () => void;
  isCurrent: (version: number) => boolean;
  finish: (version: number) => void;
}

export interface WeatherWarningTestSendFailureState {
  phase: 'uncertain' | 'error';
  requiresPreviewRefresh: boolean;
  preservesPendingMutationId: true;
}

interface WeatherWarningTestCardDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The parent owns role resolution; this component never infers an administrator role. */
  canSendTestCard: boolean;
}

export function WeatherWarningTestCardDialog({
  open,
  onOpenChange,
  canSendTestCard,
}: WeatherWarningTestCardDialogProps) {
  const [phase, setPhase] = useState<DialogPhase>('idle');
  const [preview, setPreview] =
    useState<WeatherWarningTestPreviewResponse | null>(null);
  const [confirmationOpen, setConfirmationOpen] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [pendingMutationId, setPendingMutationId] = useState('');
  const [requiresPreviewRefresh, setRequiresPreviewRefresh] = useState(false);
  const submissionGateRef = useRef(createWeatherWarningTestSubmissionGate());
  const operationVersionRef = useRef(0);
  const previewRequestGateRef = useRef(
    createWeatherWarningTestPreviewRequestGate(),
  );
  const previewStartedForOpenRef = useRef(false);

  const resetDialogState = useCallback(() => {
    operationVersionRef.current += 1;
    previewRequestGateRef.current.invalidate();
    previewStartedForOpenRef.current = false;
    submissionGateRef.current.finish();
    setConfirmationOpen(false);
    setPreview(null);
    setErrorMessage('');
    setPendingMutationId('');
    setRequiresPreviewRefresh(false);
    setPhase('idle');
  }, []);

  const loadPreview = useCallback(async () => {
    if (
      !canSendTestCard ||
      shouldDeferWeatherWarningTestPreviewForSend(phase)
    ) {
      return;
    }

    const previewVersion = previewRequestGateRef.current.start();
    if (previewVersion === null) return;
    setConfirmationOpen(false);
    setErrorMessage('');
    setRequiresPreviewRefresh(false);
    setPhase('loading');

    try {
      const nextPreview = await getWeatherWarningTestPreview();
      if (!previewRequestGateRef.current.isCurrent(previewVersion)) return;

      if (!nextPreview?.success) {
        throw new Error('天气预警测试卡片预览不可用');
      }

      const pendingRequest = readPendingWeatherWarningTestRequest();
      setPreview(nextPreview);
      setPendingMutationId(pendingRequest?.clientMutationId || '');
      if (pendingRequest) {
        setErrorMessage(
          '检测到上次测试发送尚未获得最终确认。系统已保留原操作号；如需继续，请使用同一操作号重试。',
        );
        setPhase('uncertain');
      } else {
        setPhase('ready');
      }
    } catch (error) {
      if (!previewRequestGateRef.current.isCurrent(previewVersion)) return;
      logger.error('获取天气预警测试卡片预览失败', error);
      setPreview(null);
      setRequiresPreviewRefresh(true);
      setPendingMutationId(
        readPendingWeatherWarningTestRequest()?.clientMutationId || '',
      );
      setErrorMessage(
        getRequestErrorMessage(error, '预览加载失败，尚未发送任何飞书消息。'),
      );
      setPhase('error');
    } finally {
      previewRequestGateRef.current.finish(previewVersion);
    }
  }, [canSendTestCard, phase]);

  useEffect(() => {
    if (!open) {
      resetDialogState();
      return;
    }

    if (shouldDeferWeatherWarningTestPreviewForSend(phase)) {
      return;
    }

    if (!canSendTestCard) {
      previewRequestGateRef.current.invalidate();
      previewStartedForOpenRef.current = false;
      const revokedState =
        getWeatherWarningTestPermissionRevocationState(phase);
      if (!revokedState) return;
      setPreview(revokedState.preview);
      setConfirmationOpen(revokedState.confirmationOpen);
      setRequiresPreviewRefresh(revokedState.requiresPreviewRefresh);
      setErrorMessage(revokedState.errorMessage);
      setPhase(revokedState.phase);
      return;
    }

    if (previewStartedForOpenRef.current) return;
    previewStartedForOpenRef.current = true;
    void loadPreview();
  }, [canSendTestCard, loadPreview, open, phase, resetDialogState]);

  const canSubmit = Boolean(
    preview &&
    !requiresPreviewRefresh &&
    canSendTestCard &&
    preview.canSend &&
    preview.snapshot.canSendTest,
  );

  const allWarnings = useMemo(
    () => [
      ...(preview?.snapshot.matchedWarnings || []),
      ...(preview?.snapshot.unmatchedWarnings || []),
    ],
    [preview],
  );
  const weatherMetrics = useMemo(
    () => getWeatherWarningPreviewMetrics(preview?.snapshot.weather || null),
    [preview?.snapshot.weather],
  );

  const handleDialogOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (
        !nextOpen &&
        !canDismissWeatherWarningTestCardDialog(phase, 'close')
      ) {
        toast.info('天气预警测试卡片正在发送，请等待本次操作完成。');
        return;
      }
      if (!nextOpen) resetDialogState();
      onOpenChange(nextOpen);
    },
    [onOpenChange, phase, resetDialogState],
  );

  const requestConfirmation = useCallback(() => {
    if (!canDismissWeatherWarningTestCardDialog(phase, 'close')) return;
    if (!canSubmit) {
      setErrorMessage('当前预览不满足发送条件，请刷新预览后重试。');
      setPhase('error');
      return;
    }
    setConfirmationOpen(true);
  }, [canSubmit, phase]);

  const handleConfirmationOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (
        !nextOpen &&
        !canDismissWeatherWarningTestCardDialog(phase, 'close')
      ) {
        return;
      }
      setConfirmationOpen(nextOpen);
    },
    [phase],
  );

  const submitSend = useCallback(async () => {
    if (
      !preview ||
      !canStartWeatherWarningTestCardSend({
        confirmationOpen,
        canSubmit,
        canSendTestCard,
        isSending: phase === 'sending',
      }) ||
      !submissionGateRef.current.tryStart()
    ) {
      return;
    }

    invalidateWeatherWarningTestPreviewForSend(previewRequestGateRef.current);
    const request = getOrCreateWeatherWarningTestRequest();
    const operationVersion = operationVersionRef.current + 1;
    operationVersionRef.current = operationVersion;
    setPendingMutationId(request.clientMutationId);
    setErrorMessage('');
    setPhase('sending');
    const toastId = toast.loading('正在发送天气预警测试卡片，请勿重复操作。');

    try {
      const sendAttempt = await runConfirmedWeatherWarningTestCardSend({
        confirmationOpen: true,
        canSubmit,
        canSendTestCard,
        isSending: false,
        request,
        send: sendWeatherWarningTestCard,
      });
      if (!sendAttempt.started || !sendAttempt.result) return;

      const result = sendAttempt.result;
      if (operationVersionRef.current !== operationVersion) {
        toast.dismiss(toastId);
        return;
      }

      const confirmedSuccess = isConfirmedWeatherWarningTestCardSend(
        result,
        request,
      );
      if (confirmedSuccess) {
        clearPendingWeatherWarningTestRequest();
        setPendingMutationId('');
        setConfirmationOpen(false);
        setPhase('sent');
        toast.dismiss(toastId);
        toast.success(result.message || '天气预警测试卡片已发送给示例人员020。');
        return;
      }

      setErrorMessage(
        '服务端尚未返回已发送确认。系统将保留本次操作号，请勿新建操作，可按同一操作号安全重试。',
      );
      setPhase('uncertain');
      toast.dismiss(toastId);
      toast.warning('发送结果尚未确认，已保留原操作号。');
    } catch (error) {
      if (operationVersionRef.current !== operationVersion) {
        toast.dismiss(toastId);
        return;
      }

      logger.error('发送天气预警测试卡片失败', error);
      const failureState = getWeatherWarningTestSendFailureState(error);
      const uncertain = failureState.phase === 'uncertain';
      setRequiresPreviewRefresh(failureState.requiresPreviewRefresh);
      setErrorMessage(
        uncertain
          ? '发送结果暂未确认。系统已保留原操作号，请勿新建操作，可按同一操作号安全重试。'
          : getRequestErrorMessage(
              error,
              '发送被服务端拒绝，当前预览已保留；请刷新预览后再试。',
            ),
      );
      setPhase(failureState.phase);
      toast.dismiss(toastId);
      if (uncertain) {
        toast.warning('发送结果尚未确认，已保留原操作号。');
      } else {
        toast.error('发送未完成，当前预览已保留。');
      }
    } finally {
      submissionGateRef.current.finish();
    }
  }, [canSendTestCard, canSubmit, confirmationOpen, phase, preview]);

  const retryLabel = pendingMutationId
    ? '按同一操作号重试'
    : '确认发送测试卡片';
  const canRefreshPreview = phase !== 'loading' && phase !== 'sending';
  const isSending = phase === 'sending';

  return (
    <>
      <Dialog open={open} onOpenChange={handleDialogOpenChange}>
        <DialogContent
          className="max-h-[calc(100vh-2rem)] w-[calc(100vw-2rem)] max-w-3xl overflow-hidden p-0"
          showCloseButton={!isSending}
          onEscapeKeyDown={(event) => {
            if (!canDismissWeatherWarningTestCardDialog(phase, 'escape')) {
              event.preventDefault();
            }
          }}
          onPointerDownOutside={(event) => {
            if (!canDismissWeatherWarningTestCardDialog(phase, 'outside')) {
              event.preventDefault();
            }
          }}
          onInteractOutside={(event) => {
            if (!canDismissWeatherWarningTestCardDialog(phase, 'outside')) {
              event.preventDefault();
            }
          }}
        >
          <DialogHeader className="border-b bg-slate-50 px-5 py-4 pr-12 sm:px-6">
            <div className="flex items-center gap-2 text-blue-700">
              <ShieldAlert className="h-5 w-5" aria-hidden="true" />
              <DialogTitle>天气预警测试卡片</DialogTitle>
            </div>
            <DialogDescription>
              仅用于发送前确认。卡片内容由服务端复核生成，前端不会构造飞书卡片或暴露收件人
              open_id。
            </DialogDescription>
          </DialogHeader>

          <div className="max-h-[calc(100vh-15rem)] overflow-y-auto overscroll-contain px-5 py-4 sm:px-6">
            {phase === 'loading' && (
              <div
                className="flex min-h-52 flex-col items-center justify-center gap-3 text-center text-sm text-slate-600"
                role="status"
                aria-live="polite"
                aria-atomic="true"
              >
                <Loader2
                  className="h-6 w-6 animate-spin text-blue-600"
                  aria-hidden="true"
                />
                <p className="font-medium text-slate-800">
                  正在加载服务端预览，尚未发送任何飞书消息。
                </p>
                <p>预览完成后才能进入确认发送步骤。</p>
              </div>
            )}

            {phase !== 'loading' && !preview && (
              <div
                className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900"
                role="status"
                aria-live="assertive"
                aria-atomic="true"
              >
                <div className="flex items-start gap-2">
                  <AlertCircle
                    className="mt-0.5 h-4 w-4 shrink-0"
                    aria-hidden="true"
                  />
                  <div className="min-w-0 space-y-1">
                    <p className="font-semibold">未取得可发送预览</p>
                    <p className="break-words">
                      {errorMessage || '尚未发送任何飞书消息。'}
                    </p>
                  </div>
                </div>
              </div>
            )}

            {preview && (
              <div className="space-y-4">
                <PreviewStatus
                  phase={phase}
                  errorMessage={errorMessage}
                  canSubmit={canSubmit}
                  snapshotStatus={preview.snapshot.status}
                  sourceError={
                    preview.snapshot.sourceError ||
                    preview.snapshot.weatherSourceError
                  }
                />

                <section className="rounded-lg border border-slate-200 bg-slate-50/70 p-4">
                  <h3 className="text-sm font-semibold text-slate-900">
                    发送对象与戒备等级
                  </h3>
                  <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-3">
                    <PreviewMetric
                      label="接收人"
                      value={preview.recipientName || '示例人员020'}
                    />
                    <PreviewMetric label="发送身份" value="系统机器人" />
                    <PreviewMetric
                      label="重保戒备等级"
                      value={preview.snapshot.guardLevel || '暂未匹配'}
                    />
                  </dl>
                </section>

                <section className="rounded-lg border border-slate-200 p-4">
                  <h3 className="text-sm font-semibold text-slate-900">
                    当前天气实况
                  </h3>
                  {weatherMetrics.length > 0 ? (
                    <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
                      {weatherMetrics.map((metric) => (
                        <PreviewMetric
                          key={metric.label}
                          label={metric.label}
                          value={metric.value}
                        />
                      ))}
                    </dl>
                  ) : (
                    <p className="mt-2 text-sm text-slate-600">
                      当前暂无可用天气实况，卡片仍会按预警快照复核发送条件。
                    </p>
                  )}
                </section>

                <section className="rounded-lg border border-slate-200 p-4">
                  <h3 className="text-sm font-semibold text-slate-900">
                    天气预警
                  </h3>
                  {allWarnings.length > 0 ? (
                    <ul className="mt-3 space-y-2">
                      {allWarnings.map((warning) => (
                        <WarningRow key={warning.id} warning={warning} />
                      ))}
                    </ul>
                  ) : (
                    <p className="mt-2 text-sm text-slate-600">
                      当前没有有效天气预警。
                    </p>
                  )}
                </section>

                <section className="rounded-lg border border-slate-200 p-4">
                  <h3 className="text-sm font-semibold text-slate-900">
                    本次戒备动作
                  </h3>
                  {preview.snapshot.actions.length > 0 ? (
                    <ol className="mt-3 space-y-2 text-sm leading-6 text-slate-700">
                      {preview.snapshot.actions.map((action, index) => (
                        <li
                          key={`${index}-${action}`}
                          className="flex min-w-0 gap-2"
                        >
                          <span className="shrink-0 font-semibold text-blue-700">
                            {index + 1}.
                          </span>
                          <span className="min-w-0 break-words">{action}</span>
                        </li>
                      ))}
                    </ol>
                  ) : (
                    <p className="mt-2 text-sm text-slate-600">
                      当前预警未匹配到可执行的重保戒备动作。
                    </p>
                  )}
                </section>

                <section className="rounded-lg border border-slate-200 p-4">
                  <h3 className="text-sm font-semibold text-slate-900">
                    重保检查状态
                  </h3>
                  <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                    {CHECK_ITEMS.map((item) => {
                      const state = preview.snapshot.checkSummary[item.key];
                      return (
                        <CheckStateBadge
                          key={item.key}
                          label={item.label}
                          state={state}
                        />
                      );
                    })}
                  </div>
                  {preview.snapshot.checkSummary.abnormalSummaries.length >
                    0 && (
                    <div className="mt-3 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">
                      <p className="font-semibold">待处理异常</p>
                      <ul className="mt-1 list-disc space-y-1 pl-5">
                        {preview.snapshot.checkSummary.abnormalSummaries.map(
                          (summary) => (
                            <li key={summary} className="break-words">
                              {summary}
                            </li>
                          ),
                        )}
                      </ul>
                    </div>
                  )}
                </section>

                <section className="flex flex-col gap-2 rounded-lg border border-blue-100 bg-blue-50/70 p-4 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <h3 className="text-sm font-semibold text-slate-900">
                      卡片操作链接
                    </h3>
                    <p className="mt-1 text-sm text-slate-600">
                      下载检查单使用以下固定链接；戒备登记由服务端生成站内链接。
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button asChild size="sm" variant="outline">
                      <a
                        href={CHECKLIST_DOWNLOAD_URL}
                        target="_blank"
                        rel="noreferrer"
                      >
                        <ExternalLink className="h-4 w-4" aria-hidden="true" />
                        下载重保检查单
                      </a>
                    </Button>
                  </div>
                </section>
              </div>
            )}
          </div>

          <DialogFooter className="border-t bg-white px-5 py-4 sm:px-6">
            <Button
              type="button"
              variant="outline"
              disabled={isSending}
              onClick={() => handleDialogOpenChange(false)}
            >
              关闭
            </Button>
            {canRefreshPreview &&
              (phase === 'error' || phase === 'uncertain') && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void loadPreview()}
                >
                  <RefreshCw className="h-4 w-4" aria-hidden="true" />
                  刷新预览
                </Button>
              )}
            {phase !== 'sent' && phase !== 'loading' && (
              <Button
                type="button"
                disabled={!canSubmit || isSending}
                onClick={requestConfirmation}
              >
                {isSending ? (
                  <Loader2
                    className="h-4 w-4 animate-spin"
                    aria-hidden="true"
                  />
                ) : (
                  <Send className="h-4 w-4" aria-hidden="true" />
                )}
                {isSending ? '正在发送' : retryLabel}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={confirmationOpen}
        onOpenChange={handleConfirmationOpenChange}
      >
        <AlertDialogContent
          onEscapeKeyDown={(event) => {
            if (!canDismissWeatherWarningTestCardDialog(phase, 'escape')) {
              event.preventDefault();
            }
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>
              {isSending ? '正在发送测试卡片' : '确认发送天气预警测试卡片？'}
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div
                className="space-y-2 text-left"
                role="status"
                aria-live="polite"
                aria-atomic="true"
              >
                {isSending ? (
                  <p>正在等待服务端与飞书确认，请勿关闭或重复提交。</p>
                ) : (
                  <>
                    <p>
                      将以“系统机器人”身份，仅发送给
                      {preview?.recipientName || '示例人员020'}进行测试。
                    </p>
                    <p>
                      戒备等级：{preview?.snapshot.guardLevel || '暂未匹配'}
                      ；本次仅在服务端复核通过后才会实际发送。
                    </p>
                    {pendingMutationId && (
                      <p className="rounded-md border border-amber-200 bg-amber-50 p-2 text-amber-900">
                        当前将使用已保留的操作号重试，不会创建新的发送请求。
                      </p>
                    )}
                  </>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            {!isSending && (
              <Button
                type="button"
                variant="outline"
                onClick={() => setConfirmationOpen(false)}
              >
                取消
              </Button>
            )}
            {!isSending && (
              <Button
                type="button"
                disabled={!canSubmit}
                onClick={() => void submitSend()}
              >
                <Send className="h-4 w-4" aria-hidden="true" />
                {retryLabel}
              </Button>
            )}
            {isSending && (
              <Button type="button" disabled>
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                正在发送
              </Button>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function PreviewStatus({
  phase,
  errorMessage,
  canSubmit,
  snapshotStatus,
  sourceError,
}: {
  phase: DialogPhase;
  errorMessage: string;
  canSubmit: boolean;
  snapshotStatus: string;
  sourceError?: string;
}) {
  if (phase === 'sending') {
    return (
      <div
        className="flex min-w-0 gap-2 rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900"
        role="status"
        aria-live="assertive"
        aria-atomic="true"
      >
        <Loader2
          className="mt-0.5 h-4 w-4 shrink-0 animate-spin"
          aria-hidden="true"
        />
        <p className="min-w-0 break-words">
          正在等待服务端与飞书确认，本次请求尚未获得最终发送结果。
        </p>
      </div>
    );
  }

  if (phase === 'sent') {
    return (
      <div
        className="flex min-w-0 gap-2 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        <p className="min-w-0 break-words">
          服务端已返回飞书消息确认，本次测试发送完成。
        </p>
      </div>
    );
  }

  if (phase === 'uncertain') {
    return (
      <div
        className="flex min-w-0 gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"
        role="status"
        aria-live="assertive"
        aria-atomic="true"
      >
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        <p className="min-w-0 break-words">{errorMessage}</p>
      </div>
    );
  }

  if (phase === 'error' || !canSubmit) {
    return (
      <div
        className="flex min-w-0 gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900"
        role="status"
        aria-live="assertive"
        aria-atomic="true"
      >
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        <div className="min-w-0 space-y-1">
          <p className="font-semibold">当前预览不可发送</p>
          <p className="break-words">
            {errorMessage || sourceError || `快照状态：${snapshotStatus}`}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      className="flex min-w-0 gap-2 rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900"
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <p className="min-w-0 break-words">
        服务端预览已准备完成。确认后才会发起一次测试发送请求。
      </p>
    </div>
  );
}

function PreviewMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium text-slate-500">{label}</dt>
      <dd className="mt-1 break-words font-semibold text-slate-800">{value}</dd>
    </div>
  );
}

function WarningRow({ warning }: { warning: WeatherWarningDisplayWarning }) {
  return (
    <li className="min-w-0 rounded-md border border-slate-200 bg-slate-50 p-3 text-sm">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="min-w-0 break-words font-semibold text-slate-900">
          {warning.title}
        </span>
        {warning.color && (
          <span
            className={`rounded-full px-2 py-0.5 text-xs font-semibold ${getWarningColorClass(warning.color)}`}
          >
            {warning.color}
          </span>
        )}
        {warning.type && (
          <span className="min-w-0 break-words text-slate-600">
            {warning.type}
          </span>
        )}
      </div>
      <p className="mt-1 break-words text-xs leading-5 text-slate-600">
        开始：{warning.startTime || '未提供'}；结束：
        {warning.endTime || '未提供'}；状态：
        {warning.status || '未提供'}
      </p>
    </li>
  );
}

function CheckStateBadge({
  label,
  state,
}: {
  label: string;
  state: WeatherWarningCheckState;
}) {
  const stateMeta = getCheckStateMeta(state);
  return (
    <div
      className={`rounded-md border px-3 py-2 text-sm ${stateMeta.className}`}
    >
      <p className="font-medium">{label}</p>
      <p className="mt-0.5 text-xs">{stateMeta.label}</p>
    </div>
  );
}

function getWarningColorClass(color: string): string {
  switch (color) {
    case 'red':
      return 'bg-red-100 text-red-700';
    case 'orange':
      return 'bg-orange-100 text-orange-700';
    case 'yellow':
      return 'bg-amber-100 text-amber-800';
    default:
      return 'bg-blue-100 text-blue-700';
  }
}

function getCheckStateMeta(state: WeatherWarningCheckState): {
  label: string;
  className: string;
} {
  switch (state) {
    case 'completed':
      return {
        label: '已完成',
        className: 'border-emerald-200 bg-emerald-50 text-emerald-800',
      };
    case 'abnormal':
      return {
        label: '存在异常',
        className: 'border-red-200 bg-red-50 text-red-800',
      };
    case 'pending':
      return {
        label: '待检查',
        className: 'border-amber-200 bg-amber-50 text-amber-900',
      };
    default:
      return {
        label: '未开始',
        className: 'border-slate-200 bg-slate-50 text-slate-700',
      };
  }
}

function getRequestErrorMessage(error: unknown, fallback: string): string {
  const status = Number(
    (error as { response?: { status?: unknown } } | null)?.response?.status,
  );
  if (status === 401 || status === 403) {
    return '当前账号没有发送天气预警测试卡片的权限。';
  }
  if (status >= 400 && status < 500) {
    return '请求被服务端拒绝，当前预览已保留；请刷新预览后再试。';
  }
  return fallback;
}

export function createWeatherWarningTestPreviewRequestGate(): WeatherWarningTestPreviewRequestGate {
  let nextVersion = 0;
  let activeVersion: number | null = null;

  return {
    start: () => {
      if (activeVersion !== null) return null;
      nextVersion += 1;
      activeVersion = nextVersion;
      return activeVersion;
    },
    invalidate: () => {
      nextVersion += 1;
      activeVersion = null;
    },
    isCurrent: (version) => activeVersion === version,
    finish: (version) => {
      if (activeVersion === version) {
        activeVersion = null;
      }
    },
  };
}

export function invalidateWeatherWarningTestPreviewForSend(
  gate: Pick<WeatherWarningTestPreviewRequestGate, 'invalidate'>,
): void {
  gate.invalidate();
}

export interface WeatherWarningTestPermissionRevocationState {
  phase: 'error';
  preview: null;
  confirmationOpen: false;
  requiresPreviewRefresh: true;
  errorMessage: string;
}

export function getWeatherWarningTestPermissionRevocationState(
  phase?: DialogPhase,
): WeatherWarningTestPermissionRevocationState | null {
  if (phase === 'sending') return null;

  return {
    phase: 'error',
    preview: null,
    confirmationOpen: false,
    requiresPreviewRefresh: true,
    errorMessage: '当前账号没有发送天气预警测试卡片的权限。',
  };
}

interface WeatherWarningTestCardSendEligibility {
  confirmationOpen: boolean;
  canSubmit: boolean;
  canSendTestCard: boolean;
  isSending: boolean;
}

export function canStartWeatherWarningTestCardSend(
  input: WeatherWarningTestCardSendEligibility,
): boolean {
  return (
    input.confirmationOpen &&
    input.canSubmit &&
    input.canSendTestCard &&
    !input.isSending
  );
}

export async function runConfirmedWeatherWarningTestCardSend<
  T extends WeatherWarningTestSendResponse,
>(
  input: WeatherWarningTestCardSendEligibility & {
    request: WeatherWarningTestSendRequest;
    send: (request: WeatherWarningTestSendRequest) => Promise<T>;
  },
): Promise<{ started: false } | { started: true; result: T }> {
  if (!canStartWeatherWarningTestCardSend(input)) {
    return { started: false };
  }

  return {
    started: true,
    result: await input.send(input.request),
  };
}

export function canDismissWeatherWarningTestCardDialog(
  phase: DialogPhase,
  _reason: WeatherWarningTestDialogDismissReason,
): boolean {
  return phase !== 'sending';
}

export function shouldDeferWeatherWarningTestPreviewForSend(
  phase: DialogPhase,
): boolean {
  return phase === 'sending';
}

export function isConfirmedWeatherWarningTestCardSend(
  result: Pick<
    WeatherWarningTestSendResponse,
    'success' | 'sent' | 'clientMutationId' | 'messageId'
  >,
  request: WeatherWarningTestSendRequest,
): boolean {
  return (
    result.success === true &&
    result.sent === true &&
    typeof result.messageId === 'string' &&
    result.messageId.trim().length > 0 &&
    result.clientMutationId === request.clientMutationId
  );
}

export function getWeatherWarningTestSendFailureState(
  error: unknown,
): WeatherWarningTestSendFailureState {
  if (isWeatherWarningTestResultUncertain(error)) {
    return {
      phase: 'uncertain',
      requiresPreviewRefresh: false,
      preservesPendingMutationId: true,
    };
  }

  return {
    phase: 'error',
    requiresPreviewRefresh: true,
    preservesPendingMutationId: true,
  };
}

export function getWeatherWarningPreviewMetrics(
  weather: WeatherWarningMetricSnapshot | null,
): Array<{ label: string; value: string }> {
  if (!weather) return [];

  const temperature = normalizeWeatherMetricValue(weather.temperature);
  const feelsLike = normalizeWeatherMetricValue(weather.feelsLike);
  const humidity = normalizeWeatherMetricValue(weather.humidity);
  const windDirection = normalizeWeatherMetricValue(weather.windDirection);
  const windScale = normalizeWeatherMetricValue(weather.windScale);
  const observedAt = normalizeWeatherMetricValue(weather.observedAt);
  const wind = [windDirection, windScale].filter(Boolean).join(' · ');

  return [
    temperature && { label: '温度', value: temperature },
    feelsLike && { label: '体感温度', value: feelsLike },
    humidity && { label: '相对湿度', value: humidity },
    wind && { label: '风向风力', value: wind },
    observedAt && { label: '观测时间', value: observedAt },
  ].filter((metric): metric is { label: string; value: string } =>
    Boolean(metric),
  );
}

function normalizeWeatherMetricValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
