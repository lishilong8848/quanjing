import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Loader2,
  LogOut,
  RefreshCw,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { OvertimeConfirmationDialog } from './OvertimeConfirmationDialog';
import {
  beginOvertimeConfirmationDetailLoad,
  closeOvertimeConfirmationDetailLoad,
  consumeOvertimeConfirmationDeepLink,
  createOvertimeConfirmationDetailLoadState,
  rejectOvertimeConfirmationDetailLoad,
  resolveOvertimeConfirmationDetailLoad,
} from './overtime-confirmation-deep-link';
import {
  getOvertimeConfirmationDetail,
  submitOvertimeConfirmation,
} from './overtime-confirmation-api';
import {
  createOvertimeConfirmationCompletion,
  exitOvertimeConfirmationPage,
  type OvertimeConfirmationCompletion,
} from './overtime-confirmation-completion';
import type { OvertimeConfirmationSubmitRequest } from './overtime-confirmation-state';

interface OvertimeConfirmationMutationBinding {
  recordId: string;
  fingerprint: string;
  idempotencyKey: string;
}

export function OvertimeConfirmationDeepLinkHost() {
  const [loadState, setLoadState] = useState(() =>
    createOvertimeConfirmationDetailLoadState(),
  );
  const [invalidLinkMessage, setInvalidLinkMessage] = useState<string | null>(
    null,
  );
  const [completion, setCompletion] =
    useState<OvertimeConfirmationCompletion | null>(null);
  const mutationBindingRef = useRef<OvertimeConfirmationMutationBinding | null>(
    null,
  );

  const consumeCurrentLocation = useCallback(() => {
    const result = consumeOvertimeConfirmationDeepLink({
      location: window.location,
      history: window.history,
    });
    if (result.kind === 'none') return;

    mutationBindingRef.current = null;
    setCompletion(null);
    if (result.kind === 'invalid') {
      setLoadState((current) => closeOvertimeConfirmationDetailLoad(current));
      setInvalidLinkMessage(result.message);
      return;
    }

    setInvalidLinkMessage(null);
    setLoadState((current) =>
      beginOvertimeConfirmationDetailLoad(current, {
        recordId: result.recordId,
        ticket: result.ticket,
      }),
    );
  }, []);

  useLayoutEffect(() => {
    consumeCurrentLocation();
    window.addEventListener('hashchange', consumeCurrentLocation);
    return () => {
      window.removeEventListener('hashchange', consumeCurrentLocation);
    };
  }, [consumeCurrentLocation]);

  useEffect(() => {
    if (loadState.phase !== 'loading') return undefined;
    const controller = new AbortController();
    const { credentials, revision } = loadState;

    void getOvertimeConfirmationDetail(
      credentials.recordId,
      credentials.ticket,
      controller.signal,
    )
      .then((detail) => {
        if (controller.signal.aborted) return;
        setLoadState((current) =>
          resolveOvertimeConfirmationDetailLoad(
            current,
            revision,
            credentials.recordId,
            detail,
          ),
        );
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        setLoadState((current) =>
          rejectOvertimeConfirmationDetailLoad(
            current,
            revision,
            credentials.recordId,
            overtimeConfirmationLoadErrorMessage(reason),
          ),
        );
      });

    return () => controller.abort();
  }, [loadState]);

  const closeFlow = useCallback(() => {
    mutationBindingRef.current = null;
    setInvalidLinkMessage(null);
    setCompletion(null);
    setLoadState((current) => closeOvertimeConfirmationDetailLoad(current));
  }, []);

  const exitCompletedFlow = useCallback(() => {
    exitOvertimeConfirmationPage(window);
  }, []);

  useEffect(() => {
    if (!completion) return undefined;
    const timer = window.setTimeout(exitCompletedFlow, 1_200);
    return () => window.clearTimeout(timer);
  }, [completion, exitCompletedFlow]);

  const handleSubmit = useCallback(
    async (request: OvertimeConfirmationSubmitRequest) => {
      if (
        loadState.phase !== 'ready' ||
        loadState.credentials.recordId !== request.recordId
      ) {
        throw new Error('加班确认记录已切换，请重新核对后提交');
      }

      const payload = {
        actualStartAt: request.actualStartAt,
        actualEndAt: request.actualEndAt,
        actualHours: request.actualHours,
        disposition: request.disposition,
      };
      const fingerprint = JSON.stringify(payload);
      let binding = mutationBindingRef.current;
      if (
        !binding ||
        binding.recordId !== request.recordId ||
        binding.fingerprint !== fingerprint
      ) {
        binding = {
          recordId: request.recordId,
          fingerprint,
          idempotencyKey: `overtime-confirmation-${crypto.randomUUID()}`,
        };
        mutationBindingRef.current = binding;
      }

      let response;
      try {
        response = await submitOvertimeConfirmation(
          request.recordId,
          loadState.credentials.ticket,
          binding.idempotencyKey,
          payload,
        );
      } catch (reason) {
        throw new Error(overtimeConfirmationSubmitErrorMessage(reason));
      }

      if (
        response.accepted !== true ||
        response.recordId !== request.recordId ||
        response.mutationId !== binding.idempotencyKey ||
        Date.parse(response.actualStartAt) !==
          Date.parse(request.actualStartAt) ||
        Date.parse(response.actualEndAt) !== Date.parse(request.actualEndAt) ||
        response.actualHours !== request.actualHours ||
        response.disposition !== request.disposition
      ) {
        throw new Error('服务器未确认受理，请保留当前内容后重试');
      }
      mutationBindingRef.current = null;
      setCompletion(createOvertimeConfirmationCompletion(request));
    },
    [loadState],
  );

  const statusDialogOpen =
    invalidLinkMessage !== null ||
    loadState.phase === 'loading' ||
    loadState.phase === 'error';

  return (
    <>
      <Dialog
        open={statusDialogOpen}
        onOpenChange={(open) => {
          if (!open) closeFlow();
        }}
      >
        <DialogContent className="w-[min(92vw,460px)] max-w-none bg-card">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {loadState.phase === 'loading' ? (
                <Loader2 className="size-5 animate-spin text-primary" />
              ) : (
                <AlertCircle className="size-5 text-destructive" />
              )}
              {loadState.phase === 'loading'
                ? '正在读取加班记录'
                : '无法打开加班确认'}
            </DialogTitle>
            <DialogDescription>
              {invalidLinkMessage ||
                (loadState.phase === 'error' ? loadState.message : '请稍候')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={closeFlow}>
              关闭
            </Button>
            {loadState.phase === 'error' ? (
              <Button
                type="button"
                onClick={() => {
                  setLoadState((current) =>
                    current.phase === 'error'
                      ? beginOvertimeConfirmationDetailLoad(
                          current,
                          current.credentials,
                        )
                      : current,
                  );
                }}
              >
                <RefreshCw aria-hidden="true" />
                重试
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {loadState.phase === 'ready' ? (
        completion === null ? (
          <OvertimeConfirmationDialog
            open
            detail={loadState.detail}
            onOpenChange={(open) => {
              if (!open) closeFlow();
            }}
            onSubmit={handleSubmit}
          />
        ) : null
      ) : null}

      <Dialog
        open={completion !== null}
        onOpenChange={(open) => {
          if (!open) exitCompletedFlow();
        }}
      >
        <DialogContent className="w-[min(92vw,460px)] max-w-none bg-card">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-success">
              <CheckCircle2 className="size-5" aria-hidden="true" />
              {completion?.title}
            </DialogTitle>
            <DialogDescription>提交成功，即将退出。</DialogDescription>
          </DialogHeader>
          {completion ? (
            <div
              className="grid gap-3 rounded-lg border bg-muted p-4 text-sm sm:grid-cols-2"
              role="status"
              aria-live="polite"
            >
              <div>
                <p className="text-muted-foreground">处理结果</p>
                <p className="mt-1 font-medium text-foreground">
                  {completion.resultLabel}
                </p>
              </div>
              <div>
                <p className="text-muted-foreground">工时处置</p>
                <p className="mt-1 font-medium text-foreground">
                  {completion.dispositionLabel}
                </p>
              </div>
              <p className="text-muted-foreground sm:col-span-2">
                {completion.message}
              </p>
            </div>
          ) : null}
          <DialogFooter>
            <Button type="button" onClick={exitCompletedFlow}>
              <LogOut aria-hidden="true" />
              完成并退出
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function overtimeConfirmationLoadErrorMessage(reason: unknown): string {
  const status = readResponseStatus(reason);
  if (status === 401 || status === 403) {
    return '加班确认链接已失效，请从最新飞书卡片重新打开';
  }
  if (status === 404) return '未找到对应的加班记录';
  if (status === 409) return '该加班记录当前不可确认';
  return '读取加班记录失败，请检查网络后重试';
}

function overtimeConfirmationSubmitErrorMessage(reason: unknown): string {
  const status = readResponseStatus(reason);
  if (status === 401 || status === 403) {
    return '加班确认链接已失效，请从最新飞书卡片重新打开';
  }
  if (status === 409) return '该加班记录状态已变化，请重新打开卡片核对';
  if (status === 400 || status === 422) return '提交内容不符合要求，请重新核对';
  return '加班确认提交失败，请稍后重试';
}

function readResponseStatus(reason: unknown): number | null {
  if (!reason || typeof reason !== 'object') return null;
  const response = (reason as { response?: unknown }).response;
  if (!response || typeof response !== 'object') return null;
  const status = Number((response as { status?: unknown }).status);
  return Number.isInteger(status) ? status : null;
}
