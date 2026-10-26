import { useEffect, useRef, useState } from 'react';
import { CalendarCheck2, Clock3 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  beginOvertimeConfirmationSubmission,
  cancelOvertimeConfirmationDraft,
  createOvertimeConfirmationState,
  failOvertimeConfirmationSubmission,
  updateOvertimeConfirmationDraft,
  type OvertimeConfirmationDetail,
  type OvertimeConfirmationDisposition,
  type OvertimeConfirmationSubmitRequest,
  type OvertimeConfirmationValidationErrors,
} from './overtime-confirmation-state';

export interface OvertimeConfirmationDialogProps {
  open: boolean;
  detail: OvertimeConfirmationDetail;
  onOpenChange: (open: boolean) => void;
  onSubmit: (request: OvertimeConfirmationSubmitRequest) => Promise<void>;
}

export function OvertimeConfirmationDialog({
  open,
  detail,
  onOpenChange,
  onSubmit,
}: OvertimeConfirmationDialogProps) {
  const [state, setState] = useState(() =>
    createOvertimeConfirmationState(detail),
  );
  const [fieldErrors, setFieldErrors] =
    useState<OvertimeConfirmationValidationErrors>({});
  const initializedRecordIdRef = useRef(detail.recordId);
  const previousOpenRef = useRef(open);
  const submissionInFlightRef = useRef(false);
  const submissionRevisionRef = useRef(0);
  const currentRecordIdRef = useRef(detail.recordId);
  currentRecordIdRef.current = detail.recordId;

  useEffect(() => {
    const opening = open && !previousOpenRef.current;
    const recordChanged = initializedRecordIdRef.current !== detail.recordId;
    previousOpenRef.current = open;
    if (!open || (!opening && !recordChanged)) return;

    submissionRevisionRef.current += 1;
    initializedRecordIdRef.current = detail.recordId;
    submissionInFlightRef.current = false;
    setState(createOvertimeConfirmationState(detail));
    setFieldErrors({});
  }, [detail, open]);

  const submitting = state.phase === 'submitting';
  const zeroHours = /^0+$/u.test(state.draft.actualHours.trim());

  const updateDraft = (
    patch: Parameters<typeof updateOvertimeConfirmationDraft>[1],
  ) => {
    setState((current) => updateOvertimeConfirmationDraft(current, patch));
    setFieldErrors({});
  };

  const handleCancelOvertime = () => {
    setState((current) =>
      updateOvertimeConfirmationDraft(
        current,
        cancelOvertimeConfirmationDraft(current.draft),
      ),
    );
    setFieldErrors({});
  };

  const handleSubmit = () => {
    if (submissionInFlightRef.current || state.phase === 'submitting') return;
    const prepared = beginOvertimeConfirmationSubmission(state, detail);
    if ('errors' in prepared) {
      setFieldErrors(prepared.errors);
      return;
    }

    submissionInFlightRef.current = true;
    const submissionRevision = submissionRevisionRef.current + 1;
    submissionRevisionRef.current = submissionRevision;
    const submittedRecordId = detail.recordId;
    setFieldErrors({});
    setState(prepared.state);

    void Promise.resolve()
      .then(() => onSubmit(prepared.request))
      .then(() => {
        if (
          submissionRevisionRef.current !== submissionRevision ||
          currentRecordIdRef.current !== submittedRecordId
        ) {
          return;
        }
        submissionInFlightRef.current = false;
      })
      .catch((reason: unknown) => {
        if (
          submissionRevisionRef.current !== submissionRevision ||
          currentRecordIdRef.current !== submittedRecordId
        ) {
          return;
        }
        submissionInFlightRef.current = false;
        const message =
          reason instanceof Error && reason.message.trim()
            ? reason.message.trim()
            : '加班信息确认失败，请稍后重试';
        setState(failOvertimeConfirmationSubmission(prepared.state, message));
      });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!submissionInFlightRef.current && state.phase !== 'submitting') {
          onOpenChange(nextOpen);
        }
      }}
    >
      <DialogContent
        className="flex max-h-[min(92dvh,760px)] w-[min(94vw,720px)] max-w-none max-sm:max-w-[calc(100%-2rem)] flex-col gap-0 overflow-hidden p-0"
        aria-describedby="overtime-confirmation-description"
      >
        <DialogHeader className="shrink-0 border-b bg-muted/40 px-5 py-4 pr-12 text-left sm:px-6">
          <DialogTitle className="flex items-center gap-2 text-lg">
            <CalendarCheck2
              className="size-5 text-primary"
              aria-hidden="true"
            />
            确认加班信息
          </DialogTitle>
          <DialogDescription
            id="overtime-confirmation-description"
            className="sr-only"
          >
            核对实际加班开始、结束时间和工时，并选择加班工时处置方式。
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-5 sm:px-6">
          {state.error ? (
            <p
              role="alert"
              className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
            >
              {state.error}，已恢复本次填写内容。
            </p>
          ) : null}
          {submitting ? (
            <p
              role="status"
              className="rounded-lg border border-primary/25 bg-primary/5 px-3 py-2 text-sm text-primary"
            >
              正在提交加班确认，请勿重复操作。
            </p>
          ) : null}

          <section className="grid gap-3 rounded-lg border bg-card p-4 shadow-sm sm:grid-cols-2">
            <div>
              <p className="text-xs text-muted-foreground">加班人员</p>
              <p className="mt-1 font-medium text-foreground">
                {detail.staffName || '—'}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">楼栋 / 岗位</p>
              <p className="mt-1 font-medium text-foreground">
                {[detail.building, detail.position]
                  .filter(Boolean)
                  .join(' · ') || '—'}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">申请时段</p>
              <p className="mt-1 text-sm font-medium text-foreground">
                {detail.plannedStartAt.replace('T', ' ').slice(0, 16)} 至{' '}
                {detail.plannedEndAt.replace('T', ' ').slice(0, 16)}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">申请工时</p>
              <p className="mt-1 text-sm font-medium text-foreground">
                {detail.plannedHours} 小时
              </p>
            </div>
          </section>

          <section className="space-y-4 rounded-lg border bg-card p-4 shadow-sm">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <Clock3 className="size-4 text-primary" aria-hidden="true" />
              实际加班信息
            </h3>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="overtime-confirmation-start">
                  实际开始时间 *
                </Label>
                <Input
                  id="overtime-confirmation-start"
                  type="datetime-local"
                  step={3600}
                  value={state.draft.actualStartAt}
                  disabled={state.phase === 'submitting'}
                  aria-invalid={Boolean(fieldErrors.actualStartAt)}
                  aria-describedby={
                    fieldErrors.actualStartAt
                      ? 'overtime-confirmation-start-error'
                      : undefined
                  }
                  onChange={(event) =>
                    updateDraft({ actualStartAt: event.target.value })
                  }
                />
                <FieldError
                  id="overtime-confirmation-start-error"
                  message={fieldErrors.actualStartAt}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="overtime-confirmation-hours">
                  实际加班工时 *
                </Label>
                <div className="relative">
                  <Input
                    id="overtime-confirmation-hours"
                    type="number"
                    min="0"
                    max="72"
                    step="1"
                    inputMode="numeric"
                    value={state.draft.actualHours}
                    disabled={state.phase === 'submitting'}
                    aria-invalid={Boolean(fieldErrors.actualHours)}
                    aria-describedby={
                      fieldErrors.actualHours
                        ? 'overtime-confirmation-hours-error'
                        : undefined
                    }
                    className="pr-12"
                    onChange={(event) =>
                      updateDraft({ actualHours: event.target.value })
                    }
                  />
                  <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-sm text-muted-foreground">
                    小时
                  </span>
                </div>
                <FieldError
                  id="overtime-confirmation-hours-error"
                  message={fieldErrors.actualHours}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="overtime-confirmation-end">
                  实际结束时间 *
                </Label>
                <Input
                  id="overtime-confirmation-end"
                  type="datetime-local"
                  step={3600}
                  value={state.draft.actualEndAt ?? ''}
                  onChange={(event) =>
                    updateDraft({ actualEndAt: event.target.value })
                  }
                  disabled={submitting}
                  aria-invalid={Boolean(fieldErrors.actualEndAt)}
                  aria-describedby={
                    fieldErrors.actualEndAt
                      ? 'overtime-confirmation-end-error'
                      : undefined
                  }
                  className="tabular-nums"
                />
                <FieldError
                  id="overtime-confirmation-end-error"
                  message={fieldErrors.actualEndAt}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="overtime-confirmation-disposition">
                  加班工时处置{zeroHours ? '' : ' *'}
                </Label>
                {zeroHours ? (
                  <div
                    id="overtime-confirmation-disposition"
                    className="flex h-10 items-center rounded-lg border bg-muted/50 px-3 text-sm text-muted-foreground"
                  >
                    无需处置
                  </div>
                ) : (
                  <Select
                    value={state.draft.disposition}
                    disabled={state.phase === 'submitting'}
                    onValueChange={(value) =>
                      updateDraft({
                        disposition: value as OvertimeConfirmationDisposition,
                      })
                    }
                  >
                    <SelectTrigger
                      id="overtime-confirmation-disposition"
                      className="w-full"
                      aria-invalid={Boolean(fieldErrors.disposition)}
                      aria-describedby={
                        fieldErrors.disposition
                          ? 'overtime-confirmation-disposition-error'
                          : undefined
                      }
                    >
                      <SelectValue placeholder="请选择处置方式" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="compensatory_leave">调休</SelectItem>
                      <SelectItem value="overtime_pay">加班费</SelectItem>
                    </SelectContent>
                  </Select>
                )}
                <FieldError
                  id="overtime-confirmation-disposition-error"
                  message={fieldErrors.disposition}
                />
              </div>
            </div>
          </section>
        </div>

        <DialogFooter className="shrink-0 border-t bg-background px-5 py-4 sm:px-6">
          <Button
            type="button"
            variant="outline"
            disabled={state.phase === 'submitting'}
            onClick={() => onOpenChange(false)}
          >
            关闭
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={state.phase === 'submitting'}
            onClick={handleCancelOvertime}
          >
            取消加班
          </Button>
          <Button
            type="button"
            disabled={state.phase === 'submitting'}
            onClick={handleSubmit}
          >
            <CalendarCheck2 aria-hidden="true" />
            {submitting ? '正在提交' : zeroHours ? '确认取消加班' : '提交确认'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function FieldError({ id, message }: { id: string; message?: string }) {
  return message ? (
    <p id={id} role="alert" className="text-xs text-destructive">
      {message}
    </p>
  ) : null;
}
