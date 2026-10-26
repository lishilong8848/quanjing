import { logger } from '@lark-apaas/client-toolkit/logger';
import { AlertTriangle, Loader2, RotateCcw, Send } from 'lucide-react';
import { useCallback, useRef, useState } from 'react';
import { toast } from 'sonner';

import {
  getTyphoonPathScreenshotPreview,
  sendTyphoonPathGroupScreenshot,
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
  DialogTitle,
} from '@/components/ui/dialog';
import type { TyphoonPathScreenshotPreviewResponse } from '@shared/api.interface';
import {
  clearPendingTyphoonPathMutationId,
  createTyphoonPathSubmissionGate,
  getTyphoonPathConfirmationMode,
  isTyphoonPathSendResultUncertain,
  readPendingTyphoonPathMutationId,
  readPendingTyphoonPathRequest,
  savePendingTyphoonPathRequest,
} from './typhoon-path-send';

const TYPHOON_PATH_URL = 'https://typhoon.slt.zj.gov.cn/#/';
const FORCE_SEND_CONFIRMATION = 'FORCE_SEND_TYPHOON_PATH' as const;

type SendPhase =
  | 'idle'
  | 'checking'
  | 'confirming'
  | 'sending'
  | 'error'
  | 'uncertain';
type ErrorStage = 'preview' | 'send';

interface TyphoonPathDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  canManageMonthlySchedule: boolean;
  canForceSend: boolean;
}

export function TyphoonPathDialog({
  open,
  onOpenChange,
  canManageMonthlySchedule,
  canForceSend,
}: TyphoonPathDialogProps) {
  const [phase, setPhase] = useState<SendPhase>('idle');
  const [confirmationOpen, setConfirmationOpen] = useState(false);
  const [preview, setPreview] =
    useState<TyphoonPathScreenshotPreviewResponse | null>(null);
  const [errorMessage, setErrorMessage] = useState('');
  const [errorStage, setErrorStage] = useState<ErrorStage>('preview');
  const submissionGateRef = useRef(createTyphoonPathSubmissionGate());
  const operationVersionRef = useRef(0);
  const clientMutationIdRef = useRef('');

  const resetSendFlow = useCallback(() => {
    operationVersionRef.current += 1;
    submissionGateRef.current.finish();
    setConfirmationOpen(false);
    setPreview(null);
    setErrorMessage('');
    setErrorStage('preview');
    setPhase('idle');
    clientMutationIdRef.current = readPendingTyphoonPathMutationId();
  }, []);

  const completeSendFlow = useCallback(() => {
    clearPendingTyphoonPathMutationId();
    clientMutationIdRef.current = '';
    resetSendFlow();
  }, [resetSendFlow]);

  const handleDialogOpenChange = useCallback((nextOpen: boolean) => {
    if (!nextOpen && phase === 'sending') {
      toast.info('台风路径图正在发送，请等待本次操作完成');
      return;
    }
    if (!nextOpen) resetSendFlow();
    onOpenChange(nextOpen);
  }, [onOpenChange, phase, resetSendFlow]);

  const checkWarning = useCallback(async (reuseMutationId = false) => {
    if (!canManageMonthlySchedule) {
      toast.info('当前为只读模式，不能发送台风路径图');
      return;
    }
    if (!submissionGateRef.current.tryStart()) return;

    const operationVersion = operationVersionRef.current + 1;
    operationVersionRef.current = operationVersion;
    const pendingRequest = readPendingTyphoonPathRequest();
    if (pendingRequest) {
      clientMutationIdRef.current = pendingRequest.clientMutationId;
    } else if (!reuseMutationId || !clientMutationIdRef.current) {
      clientMutationIdRef.current = createClientMutationId();
    }
    setErrorMessage('');
    setErrorStage('preview');
    setPhase('checking');
    setConfirmationOpen(true);

    try {
      const nextPreview = await getTyphoonPathScreenshotPreview();
      if (operationVersionRef.current !== operationVersion) return;
      setPreview(nextPreview);
      if (pendingRequest) {
        setErrorMessage(
          '检测到上次发送结果尚未确认。系统已保留原操作号，请按同一操作号重试，避免重复群发。',
        );
        setErrorStage('send');
        setPhase('uncertain');
      } else {
        setPhase('confirming');
      }
    } catch (error) {
      if (operationVersionRef.current !== operationVersion) return;
      logger.error('检查台风路径图发送条件失败', error);
      setErrorMessage(
        getRequestErrorMessage(error, '预警检查失败，未发送任何群消息'),
      );
      setErrorStage('preview');
      setPhase('error');
    } finally {
      submissionGateRef.current.finish();
    }
  }, [canManageMonthlySchedule]);

  const submitSend = useCallback(async () => {
    if (!preview || !submissionGateRef.current.tryStart()) return;

    const mode = getTyphoonPathConfirmationMode(preview);
    const pendingRequest = readPendingTyphoonPathRequest();
    if (mode === 'already-sent' && !pendingRequest) {
      toast.info(preview.message || '本轮台风路径图已经发送，无需重复发送');
      completeSendFlow();
      return;
    }
    const force = pendingRequest?.force === true
      || (!pendingRequest && mode === 'force-send');
    if (force && !canForceSend) {
      setErrorMessage('当前没有有效台风预警；仅管理员可以强制发送');
      setErrorStage('send');
      setPhase('error');
      submissionGateRef.current.finish();
      return;
    }
    const request = pendingRequest || {
      clientMutationId: clientMutationIdRef.current,
      expectedWarningKey: preview.warning?.warningKey,
      ...(force
        ? {
            force: true,
            confirmation: FORCE_SEND_CONFIRMATION,
          }
        : {}),
    };
    savePendingTyphoonPathRequest(request);

    const operationVersion = operationVersionRef.current + 1;
    operationVersionRef.current = operationVersion;
    setErrorMessage('');
    setErrorStage('send');
    setPhase('sending');

    try {
      const result = await sendTyphoonPathGroupScreenshot(request);
      if (operationVersionRef.current !== operationVersion) return;

      if (!result.success) {
        setErrorMessage(result.message || '后台未完成台风路径图发送');
        setErrorStage('send');
        setPhase('error');
        return;
      }
      if (result.reason === 'monitor-in-flight') {
        setErrorMessage(
          `${result.message || '后台已有发送任务正在执行'}。原操作号已保留，请稍后按同一操作号重试核对结果。`,
        );
        setErrorStage('send');
        setPhase('uncertain');
        return;
      }
      if (result.sent) {
        toast.success(result.message || '台风路径图已发送到飞书群');
      } else {
        toast.info(result.message || '本轮无需重复发送台风路径图');
      }
      completeSendFlow();
    } catch (error) {
      if (operationVersionRef.current !== operationVersion) return;
      logger.error('发送台风路径图失败', error);
      const uncertain = isTyphoonPathSendResultUncertain(error);
      setErrorMessage(
        uncertain
          ? '已停止等待后台响应，发送结果暂未确认。请勿发起新操作，可使用下方按钮按同一操作号安全重试。'
          : getRequestErrorMessage(error, '台风路径图发送失败，未确认成功'),
      );
      setErrorStage('send');
      setPhase(uncertain ? 'uncertain' : 'error');
    } finally {
      submissionGateRef.current.finish();
    }
  }, [canForceSend, completeSendFlow, preview]);

  const handleConfirmationOpenChange = useCallback((nextOpen: boolean) => {
    if (nextOpen) {
      setConfirmationOpen(true);
      return;
    }
    if (phase === 'checking' || phase === 'sending') return;
    resetSendFlow();
  }, [phase, resetSendFlow]);

  const mode = preview ? getTyphoonPathConfirmationMode(preview) : null;
  const actionLabel = phase === 'checking'
    ? '正在检查预警'
    : phase === 'sending'
      ? '正在发送'
      : '发送台风路径图';

  return (
    <>
      <Dialog open={open} onOpenChange={handleDialogOpenChange}>
        <DialogContent className="h-[calc(100vh-1rem)] max-h-[calc(100vh-1rem)] w-[calc(100vw-1rem)] max-w-[calc(100vw-1rem)] gap-0 overflow-hidden p-0">
          <DialogTitle className="sr-only">台风路径</DialogTitle>
          <div className="relative h-full bg-slate-50">
            <button
              type="button"
              aria-label="发送台风路径图到飞书群"
              disabled={phase !== 'idle'}
              onClick={() => void checkWarning()}
              className="absolute bottom-6 left-1/2 z-20 inline-flex h-8 -translate-x-1/2 items-center gap-1.5 rounded-md border border-white/40 bg-white/95 px-3 text-xs font-semibold text-blue-700 shadow-md transition-colors hover:bg-blue-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white disabled:cursor-not-allowed disabled:opacity-70"
            >
              {phase === 'checking' || phase === 'sending' ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Send className="h-3.5 w-3.5" />
              )}
              {actionLabel}
            </button>
            <iframe
              title="台风路径"
              src={TYPHOON_PATH_URL}
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
              referrerPolicy="no-referrer-when-downgrade"
              className="h-full w-full border-0"
            />
          </div>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={confirmationOpen}
        onOpenChange={handleConfirmationOpenChange}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {getConfirmationTitle(phase, mode)}
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-left">
                {phase === 'checking' && (
                  <p>正在获取最新天气预警，尚未截图、上传或发送群消息。</p>
                )}
                {phase === 'sending' && (
                  <p>正在截图并同步到飞书群，请勿重复点击或关闭页面。</p>
                )}
                {phase === 'confirming' && preview?.warning && (
                  <>
                    <p className="font-medium text-slate-800">
                      {preview.warning.title}
                    </p>
                    <p>
                      等级：{preview.warning.levelText}
                      {preview.nextSendAt
                        ? `；下次允许时间：${formatDateTime(preview.nextSendAt)}`
                        : ''}
                    </p>
                  </>
                )}
                {phase === 'confirming' && mode === 'force-send' && (
                  <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-amber-800">
                    <div className="flex items-start gap-2 font-medium">
                      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                      <span>当前没有有效台风预警。</span>
                    </div>
                    <p className="mt-1">
                      强制发送不会改变自动预警的发送周期，且仅管理员可执行。
                    </p>
                  </div>
                )}
                {phase === 'confirming' && mode === 'already-sent' && (
                  <p>本轮预警截图已经发送，系统不会重复发送。</p>
                )}
                {(phase === 'error' || phase === 'uncertain') && (
                  <div className="rounded-md border border-red-200 bg-red-50 p-3 text-red-700">
                    {errorMessage}
                  </div>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>

          <AlertDialogFooter>
            {phase !== 'checking' && phase !== 'sending' && (
              <Button
                type="button"
                variant="outline"
                onClick={resetSendFlow}
              >
                {mode === 'already-sent' ? '关闭' : '取消'}
              </Button>
            )}
            {phase === 'confirming' && mode === 'warning-send' && (
              <Button type="button" onClick={() => void submitSend()}>
                确认发送
              </Button>
            )}
            {phase === 'confirming' && mode === 'force-send' && canForceSend && (
              <Button
                type="button"
                variant="destructive"
                onClick={() => void submitSend()}
              >
                确认强制发送
              </Button>
            )}
            {phase === 'confirming' && (
              mode === 'already-sent'
              || (mode === 'force-send' && !canForceSend)
            ) && (
              <Button type="button" onClick={resetSendFlow}>
                知道了
              </Button>
            )}
            {(phase === 'error' || phase === 'uncertain') && (
              <Button
                type="button"
                onClick={() => {
                  if (errorStage === 'preview') {
                    void checkWarning(true);
                  } else {
                    void submitSend();
                  }
                }}
              >
                <RotateCcw className="h-4 w-4" />
                {errorStage === 'preview' ? '重新检查' : '按同一操作号重试'}
              </Button>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function createClientMutationId(): string {
  if (
    typeof globalThis.crypto !== 'undefined'
    && typeof globalThis.crypto.randomUUID === 'function'
  ) {
    return globalThis.crypto.randomUUID();
  }
  return `typhoon-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

function getConfirmationTitle(
  phase: SendPhase,
  mode: ReturnType<typeof getTyphoonPathConfirmationMode> | null,
): string {
  if (phase === 'checking') return '正在检查台风预警';
  if (phase === 'sending') return '正在发送台风路径图';
  if (phase === 'uncertain') return '发送结果暂未确认';
  if (phase === 'error') return '操作未完成';
  if (mode === 'force-send') return '无预警强制发送确认';
  if (mode === 'already-sent') return '无需重复发送';
  return '发送台风路径图确认';
}

function getRequestErrorMessage(error: unknown, fallback: string): string {
  if (!error || typeof error !== 'object') return fallback;
  const candidate = error as {
    message?: unknown;
    response?: {
      data?: {
        message?: unknown;
      };
    };
  };
  const backendMessage = candidate.response?.data?.message;
  if (typeof backendMessage === 'string' && backendMessage.trim()) {
    return backendMessage.trim();
  }
  if (typeof candidate.message === 'string' && candidate.message.trim()) {
    return candidate.message.trim();
  }
  return fallback;
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString('zh-CN', { hour12: false });
}
