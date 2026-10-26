import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, Loader2 } from 'lucide-react';
import { createChangeRequest, getChangeRequestSyncTaskStatus } from '@/api';
import { Button } from '@/components/ui/button';
import { ChangeRequestDialog } from '../MonthlySchedule/ChangeRequestDialog';
import {
  getChangeRequestAttachmentPartialFailure,
  shouldRetainChangeRequestMutationIdAfterError,
} from '../MonthlySchedule/change-request-state';
import {
  createEmptyChangeRequestDraft,
  validateChangeRequest,
  type ChangeRequestCreateRequest,
  type ChangeRequestCreateResponse,
  type ChangeRequestDraft,
  type ChangeRequestRetryAction,
  type ChangeRequestStagedDocument,
} from '@shared/change-request';

const RECOVERY_KEY = 'change-request-direct-recovery-v1';
type Recovery = {
  request: ChangeRequestCreateRequest;
  result?: ChangeRequestCreateResponse;
};
type Phase = 'ready' | 'submitting' | 'accepted' | 'success' | 'error';

function readRecovery(): Recovery | null {
  try {
    const value = JSON.parse(
      window.sessionStorage.getItem(RECOVERY_KEY) || 'null',
    ) as Recovery | null;
    return value && !validateChangeRequest(value.request).length ? value : null;
  } catch {
    return null;
  }
}

function errorMessage(error: unknown): string {
  const response = (
    error as {
      response?: { data?: { message?: unknown; data?: { message?: unknown } } };
    }
  )?.response?.data;
  const message = response?.data?.message || response?.message;
  return typeof message === 'string'
    ? message
    : error instanceof Error
      ? error.message
      : '提交失败，请稍后重试';
}

function toDraft(request?: ChangeRequestCreateRequest): ChangeRequestDraft {
  return {
    ...createEmptyChangeRequestDraft(),
    ...request,
    meetingStartAt: request?.meetingStartAt || '',
    meetingEndAt: request?.meetingEndAt || '',
  };
}

export default function ChangeRequestApplyPage() {
  const [recovery] = useState(readRecovery);
  const [mutationId] = useState(
    () =>
      recovery?.request.clientMutationId ||
      `change-request-${crypto.randomUUID()}`,
  );
  const [draft, setDraft] = useState<ChangeRequestDraft>(() =>
    toDraft(recovery?.request),
  );
  const [result, setResult] = useState(recovery?.result);
  const [phase, setPhase] = useState<Phase>(() =>
    recovery?.result
      ? recovery.result.pendingSync
        ? 'accepted'
        : 'success'
      : recovery
        ? 'error'
        : 'ready',
  );
  const [open, setOpen] = useState(!recovery?.result);
  const [error, setError] = useState<string | null>(
    recovery && !recovery.result
      ? '上次提交结果待确认，请使用原申请标识重试'
      : null,
  );
  const [retryAction, setRetryAction] =
    useState<ChangeRequestRetryAction | null>(
      recovery && !recovery.result ? 'retry-same-mutation' : null,
    );
  const [pollVersion, setPollVersion] = useState(0);
  const [exitHint, setExitHint] = useState(false);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    document.title = '变更申请 - 世纪互联南通基地';
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (phase !== 'accepted' || !result?.taskId) return;
    let cancelled = false;
    let timer: number | undefined;
    let attempts = 0;
    const poll = async () => {
      try {
        const response = await getChangeRequestSyncTaskStatus(result.taskId!);
        if (cancelled) return;
        if (!response.success || !response.task)
          throw new Error(response.message || '暂未查到同步结果，可重试查询');
        if (response.task.status === 'completed') {
          const final = response.task.result as
            | ChangeRequestCreateResponse
            | undefined;
          if (
            !final?.success ||
            final.clientMutationId !== mutationId ||
            !final.record
          )
            throw new Error('同步结果校验失败，请重试查询');
          setResult(final);
          setPhase('success');
          setError(null);
          try {
            window.sessionStorage.setItem(
              RECOVERY_KEY,
              JSON.stringify({
                request: { ...draft, clientMutationId: mutationId },
                result: final,
              }),
            );
          } catch {
            setError('申请已成功，但当前浏览器无法保存结果；请记下申请编号。');
          }
          return;
        }
        if (response.task.status === 'failed') {
          setError(response.task.message || '附件同步失败，请使用原申请重试');
          setRetryAction('retry-same-mutation');
          setPhase('error');
          setOpen(true);
          return;
        }
        attempts += 1;
        if (attempts >= 30) {
          setError('后台仍在同步，可安全离开，稍后查询结果');
          return;
        }
        timer = window.setTimeout(() => void poll(), 1000);
      } catch (failure) {
        if (!cancelled) setError(errorMessage(failure));
      }
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [phase, result?.taskId, mutationId, pollVersion]);

  const submit = async (
    nextDraft: ChangeRequestDraft,
    documents: ChangeRequestStagedDocument[],
  ) => {
    if (inFlight.current || phase === 'success' || phase === 'accepted') return;
    const request = {
      ...nextDraft,
      stagedDocuments: documents,
      clientMutationId: mutationId,
    } as ChangeRequestCreateRequest;
    if (validateChangeRequest(request).length) {
      setError('请检查申请内容');
      return;
    }
    inFlight.current = true;
    setDraft(toDraft(request));
    setPhase('submitting');
    setError(null);
    let requestSent = false;
    try {
      window.sessionStorage.setItem(
        RECOVERY_KEY,
        JSON.stringify({ request } satisfies Recovery),
      );
      requestSent = true;
      const response = await createChangeRequest(request);
      if (
        !response.success ||
        response.clientMutationId !== mutationId ||
        !response.record ||
        (response.pendingSync && !response.taskId)
      )
        throw new Error('提交结果校验失败，请使用原申请重试');
      if (!mounted.current) return;
      setResult(response);
      setOpen(false);
      setPhase(response.pendingSync ? 'accepted' : 'success');
      try {
        window.sessionStorage.setItem(
          RECOVERY_KEY,
          JSON.stringify({ request, result: response } satisfies Recovery),
        );
      } catch {
        setError('申请已受理，但当前浏览器无法保存结果；请记下申请编号。');
      }
    } catch (failure) {
      if (!mounted.current) return;
      const partial = getChangeRequestAttachmentPartialFailure(failure);
      const status = Number(
        (failure as { response?: { status?: number } })?.response?.status,
      );
      const action =
        partial?.retryAction ||
        (requestSent &&
        (shouldRetainChangeRequestMutationIdAfterError(failure) ||
          !(status >= 400 && status < 500))
          ? 'retry-same-mutation'
          : null);
      setRetryAction(action);
      setError(
        requestSent
          ? errorMessage(failure)
          : '浏览器无法保存重试标识，请允许此站点使用本地存储后重试',
      );
      setPhase('error');
      setOpen(true);
    } finally {
      inFlight.current = false;
    }
  };

  const exit = () => {
    setExitHint(true);
    window.close();
    window.setTimeout(() => {
      if (window.history.length > 1) window.history.back();
    }, 150);
  };

  return (
    <main className="flex min-h-dvh items-center justify-center bg-background p-4">
      <section className="w-full max-w-lg space-y-4 rounded-lg border bg-card p-6 shadow-sm">
        <h1 className="flex items-center gap-2 text-xl font-semibold">
          {phase === 'success' && (
            <CheckCircle2 className="text-primary" aria-hidden="true" />
          )}
          {phase === 'success'
            ? '变更申请提交成功'
            : phase === 'accepted'
              ? '变更申请已受理'
              : '变更申请'}
        </h1>
        {(phase === 'success' || phase === 'accepted') && (
          <p className="text-sm">
            {result?.record.title}
            <br />
            申请编号：{result?.record.bitableRecordId || result?.record.id}
          </p>
        )}
        {phase === 'accepted' && (
          <p role="status" className="text-sm text-muted-foreground">
            {error || '附件正在后台同步，可安全离开。'}
          </p>
        )}
        {phase === 'submitting' && (
          <p role="status" className="flex items-center gap-2 text-sm">
            <Loader2 className="size-4 animate-spin" />
            正在提交，草稿已保留
          </p>
        )}
        {phase === 'accepted' && error && (
          <Button
            variant="outline"
            onClick={() => {
              setError(null);
              setPollVersion((current) => current + 1);
            }}
          >
            查询同步结果
          </Button>
        )}
        {phase === 'success' && error && (
          <p role="status" className="text-sm text-muted-foreground">
            {error}
          </p>
        )}
        {(phase === 'ready' || phase === 'error') && (
          <Button onClick={() => setOpen(true)}>继续填写申请</Button>
        )}
        {(phase === 'success' || phase === 'accepted') && (
          <Button onClick={exit}>完成并退出</Button>
        )}
        {phase === 'success' && (
          <Button
            variant="outline"
            className="ml-2"
            onClick={() => {
              window.sessionStorage.removeItem(RECOVERY_KEY);
              window.location.reload();
            }}
          >
            再填一份
          </Button>
        )}
        {exitHint && (
          <p role="status" className="text-sm text-muted-foreground">
            如页面未关闭，可使用飞书左上角返回或关闭此标签页。
          </p>
        )}
      </section>
      <ChangeRequestDialog
        standalone
        open={open}
        onOpenChange={setOpen}
        ownerMutationId={mutationId}
        initialDraft={draft}
        initialStagedDocuments={draft.stagedDocuments || []}
        submitting={phase === 'submitting'}
        serverError={error}
        submissionStatus={
          phase === 'submitting' ? '正在提交，草稿已保留' : undefined
        }
        attachmentRetryLocked={Boolean(retryAction)}
        retryAction={retryAction}
        onDraftChange={() => setError(null)}
        onSubmit={(nextDraft, documents) => void submit(nextDraft, documents)}
      />
    </main>
  );
}
