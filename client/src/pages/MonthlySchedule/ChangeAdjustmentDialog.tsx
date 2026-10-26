import { useEffect, useMemo, useState } from 'react';
import { CalendarClock, FileText, Layers3, Loader2 } from 'lucide-react';

import { deleteChangeAttachment, stageChangeAttachment } from '@/api';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
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
import { Textarea } from '@/components/ui/textarea';
import type { ChangeInfo } from '@shared/api.interface';
import {
  CHANGE_ADJUSTMENT_EVIDENCE_MAX_COUNT,
  CHANGE_ADJUSTMENT_EVIDENCE_MAX_SIZE,
  CHANGE_ADJUSTMENT_REASON_MAX_LENGTH,
  validateChangeAdjustment,
  type ChangeAdjustmentRequest,
  type ChangeAdjustmentValidationError,
} from '@shared/change-adjustment';
import {
  CHANGE_REQUEST_MAX_DOCUMENT_COUNT,
  CHANGE_REQUEST_MAX_DOCUMENT_SIZE,
  isAllowedChangeRequestDocument,
} from '@shared/change-request';
import { ChangeAttachmentField } from './ChangeAttachmentField';
import {
  createChangeAdjustmentDraftForRecord,
  listAdjustableChanges,
} from './change-adjustment-state';
import {
  getReadyChangeAttachmentDocuments,
  isChangeAttachmentFileAllowedByExtension,
  isChangeAttachmentCollectionReady,
  type ChangeAttachmentFile,
  type ChangeAttachmentUploadItem,
} from './change-attachment-staging';

interface ChangeAdjustmentDialogProps {
  open: boolean;
  ownerMutationId: string;
  changes: readonly ChangeInfo[];
  initialRecordId?: string | null;
  submitting?: boolean;
  serverError?: string | null;
  retryBinding?: {
    request: ChangeAdjustmentRequest;
    original: ChangeInfo;
  } | null;
  onOpenChange: (open: boolean) => void;
  onSubmit: (request: ChangeAdjustmentRequest, original: ChangeInfo) => void;
}

export function ChangeAdjustmentDialog({
  open,
  ownerMutationId,
  changes,
  initialRecordId,
  submitting = false,
  serverError,
  retryBinding,
  onOpenChange,
  onSubmit,
}: ChangeAdjustmentDialogProps) {
  const adjustableChanges = useMemo(
    () =>
      listAdjustableChanges(changes).filter(
        (change) =>
          Boolean(change.bitableRecordId || change.id) &&
          !change.id.startsWith('change-request-pending-') &&
          change.progress !== '同步中' &&
          change.progress !== '调整同步中',
      ),
    [changes],
  );
  const [selectedRecordId, setSelectedRecordId] = useState('');
  const [startAt, setStartAt] = useState('');
  const [endAt, setEndAt] = useState('');
  const [reason, setReason] = useState('');
  const [retainedTokens, setRetainedTokens] = useState<string[]>([]);
  const [newSchemeItems, setNewSchemeItems] = useState<
    ChangeAttachmentUploadItem[]
  >([]);
  const [evidenceItems, setEvidenceItems] = useState<
    ChangeAttachmentUploadItem[]
  >([]);
  const [errors, setErrors] = useState<ChangeAdjustmentValidationError[]>([]);
  const draftLocked = submitting || Boolean(retryBinding);

  const selectedChange = useMemo(
    () =>
      adjustableChanges.find(
        (change) => (change.bitableRecordId || change.id) === selectedRecordId,
      ) || null,
    [adjustableChanges, selectedRecordId],
  );
  const prepared = useMemo(
    () =>
      selectedChange
        ? createChangeAdjustmentDraftForRecord(selectedChange)
        : null,
    [selectedChange],
  );

  const resetForChange = (change: ChangeInfo | null) => {
    if (!change) {
      setSelectedRecordId('');
      setStartAt('');
      setEndAt('');
      setReason('');
      setRetainedTokens([]);
      setNewSchemeItems([]);
      setEvidenceItems([]);
      setErrors([]);
      return;
    }
    const next = createChangeAdjustmentDraftForRecord(change);
    setSelectedRecordId(change.bitableRecordId || change.id);
    setStartAt(next.request.plannedDelayStartDate || next.effectiveStartDate);
    setEndAt(next.request.plannedDelayEndDate || next.effectiveEndDate);
    setReason('');
    setRetainedTokens([...next.request.retainedDocumentTokens]);
    setNewSchemeItems([]);
    setEvidenceItems([]);
    setErrors([]);
  };

  useEffect(() => {
    if (!open || selectedRecordId) return;
    const requested = adjustableChanges.find(
      (change) => (change.bitableRecordId || change.id) === initialRecordId,
    );
    const current = adjustableChanges.find(
      (change) => (change.bitableRecordId || change.id) === selectedRecordId,
    );
    resetForChange(requested || current || adjustableChanges[0] || null);
    // The parent remounts this dialog for a fresh owner mutation ID. Keeping
    // the populated state on a same-ID reopen preserves a failed draft.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, ownerMutationId, initialRecordId, selectedRecordId]);

  const errorsByField = useMemo(() => {
    const grouped = new Map<string, string>();
    errors.forEach((error) => {
      if (!grouped.has(error.field)) grouped.set(error.field, error.message);
    });
    return grouped;
  }, [errors]);

  const availableTokens = useMemo(
    () =>
      (selectedChange?.planDocuments || [])
        .map((document) => document.fileToken.trim())
        .filter(Boolean),
    [selectedChange],
  );
  const removedTokens = availableTokens.filter(
    (token) => !retainedTokens.includes(token),
  );
  const newSchemes = getReadyChangeAttachmentDocuments(newSchemeItems);
  const evidence = getReadyChangeAttachmentDocuments(evidenceItems);
  const maxNewSchemes = Math.max(
    0,
    CHANGE_REQUEST_MAX_DOCUMENT_COUNT - retainedTokens.length,
  );
  const schemeReady =
    retainedTokens.length + newSchemes.length >= 1 &&
    retainedTokens.length + newSchemes.length <=
      CHANGE_REQUEST_MAX_DOCUMENT_COUNT &&
    newSchemeItems.every((item) => item.status === 'staged');
  const evidenceReady = isChangeAttachmentCollectionReady(
    evidenceItems,
    1,
    CHANGE_ADJUSTMENT_EVIDENCE_MAX_COUNT,
  );
  const attachmentBusy = [...newSchemeItems, ...evidenceItems].some(
    (item) => item.status === 'queued' || item.status === 'uploading',
  );

  const handleSubmit = () => {
    if (submitting || attachmentBusy) return;
    if (retryBinding) {
      onSubmit(retryBinding.request, retryBinding.original);
      return;
    }
    if (!selectedChange || !prepared) return;
    const request: ChangeAdjustmentRequest = {
      ...prepared.request,
      clientMutationId: ownerMutationId,
      plannedDelayStartDate:
        prepared.lifecycleStatus === 'not-started' ? startAt : null,
      plannedDelayEndDate: endAt,
      reason: reason.trim(),
      retainedDocumentTokens: [...retainedTokens],
      removedDocumentTokens: removedTokens,
      newSchemeDocuments: newSchemes,
      evidenceDocuments: evidence,
    };
    const nextErrors = validateChangeAdjustment(request, {
      lifecycleStatus: prepared.lifecycleStatus,
      effectiveStartDate: prepared.effectiveStartDate,
      effectiveEndDate: prepared.effectiveEndDate,
      availableDocumentTokens: availableTokens,
    });
    if (nextErrors.length > 0) {
      setErrors(nextErrors);
      return;
    }
    setErrors([]);
    onSubmit(request, selectedChange);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!submitting) onOpenChange(nextOpen);
      }}
    >
      <DialogContent className="flex h-[min(92dvh,820px)] max-h-[92dvh] w-[min(96vw,980px)] max-w-none flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="shrink-0 border-b bg-muted/40 px-5 py-4 pr-12 text-left sm:px-6">
          <DialogTitle className="flex items-center gap-2 text-lg">
            <CalendarClock className="size-5 text-primary" />
            变更调整
          </DialogTitle>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-5 sm:px-6">
          {serverError ? (
            <p
              role="alert"
              className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
            >
              {serverError}
            </p>
          ) : null}
          {retryBinding ? (
            <p
              role="status"
              className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800"
            >
              上次提交结果待确认，当前内容已锁定，仅可使用原内容重试。
            </p>
          ) : null}

          <section className="space-y-4 rounded-lg border bg-card p-4 shadow-sm">
            <h3 className="flex items-center gap-2 text-sm font-semibold">
              <Layers3 className="size-4 text-primary" />
              选择变更
            </h3>
            {adjustableChanges.length > 0 ? (
              <div className="space-y-2">
                <Label htmlFor="change-adjustment-record">变更记录 *</Label>
                <Select
                  value={selectedRecordId}
                  disabled={draftLocked}
                  onValueChange={(recordId) => {
                    const change = adjustableChanges.find(
                      (candidate) =>
                        (candidate.bitableRecordId || candidate.id) ===
                        recordId,
                    );
                    resetForChange(change || null);
                  }}
                >
                  <SelectTrigger id="change-adjustment-record">
                    <SelectValue placeholder="请选择变更" />
                  </SelectTrigger>
                  <SelectContent>
                    {adjustableChanges.map((change) => {
                      const recordId = change.bitableRecordId || change.id;
                      const lifecycle =
                        createChangeAdjustmentDraftForRecord(
                          change,
                        ).lifecycleStatus;
                      return (
                        <SelectItem key={recordId} value={recordId}>
                          {change.title} ·{' '}
                          {lifecycle === 'in-progress' ? '进行中' : '未开始'}
                        </SelectItem>
                      );
                    })}
                  </SelectContent>
                </Select>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">暂无可调整的变更</p>
            )}
          </section>

          {selectedChange && prepared ? (
            <>
              <section className="space-y-4 rounded-lg border bg-card p-4 shadow-sm">
                <h3 className="flex items-center gap-2 text-sm font-semibold">
                  <CalendarClock className="size-4 text-primary" />
                  调整时间
                </h3>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="change-adjustment-start">
                      调整后开始时间 *
                    </Label>
                    <Input
                      id="change-adjustment-start"
                      type="datetime-local"
                      value={startAt}
                      disabled={
                        draftLocked ||
                        prepared.lifecycleStatus === 'in-progress'
                      }
                      aria-invalid={errorsByField.has('plannedDelayStartDate')}
                      onChange={(event) => {
                        setStartAt(event.target.value);
                        setErrors([]);
                      }}
                    />
                    {prepared.lifecycleStatus === 'in-progress' ? (
                      <p className="text-xs text-muted-foreground">
                        进行中的变更仅可调整结束时间
                      </p>
                    ) : null}
                    <FieldError
                      message={errorsByField.get('plannedDelayStartDate')}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="change-adjustment-end">
                      调整后结束时间 *
                    </Label>
                    <Input
                      id="change-adjustment-end"
                      type="datetime-local"
                      value={endAt}
                      disabled={draftLocked}
                      min={
                        prepared.lifecycleStatus === 'not-started'
                          ? startAt
                          : prepared.effectiveStartDate
                      }
                      aria-invalid={errorsByField.has('plannedDelayEndDate')}
                      onChange={(event) => {
                        setEndAt(event.target.value);
                        setErrors([]);
                      }}
                    />
                    <FieldError
                      message={errorsByField.get('plannedDelayEndDate')}
                    />
                  </div>
                </div>
              </section>

              <section className="space-y-4 rounded-lg border bg-card p-4 shadow-sm">
                <h3 className="flex items-center gap-2 text-sm font-semibold">
                  <FileText className="size-4 text-primary" />
                  变更方案
                </h3>
                {(selectedChange.planDocuments || []).length > 0 ? (
                  <ul className="grid gap-2 sm:grid-cols-2">
                    {(selectedChange.planDocuments || []).map((document) => {
                      const removed = !retainedTokens.includes(
                        document.fileToken,
                      );
                      return (
                        <li
                          key={document.fileToken}
                          className="flex items-center gap-3 rounded-md border px-3 py-2"
                        >
                          <Checkbox
                            id={`remove-${document.fileToken}`}
                            checked={removed}
                            disabled={draftLocked}
                            onCheckedChange={(checked) => {
                              setRetainedTokens((current) =>
                                checked === true
                                  ? current.filter(
                                      (token) => token !== document.fileToken,
                                    )
                                  : [
                                      ...new Set([
                                        ...current,
                                        document.fileToken,
                                      ]),
                                    ],
                              );
                              setErrors([]);
                            }}
                          />
                          <span className="min-w-0 flex-1">
                            {document.url ? (
                              <a
                                className="block truncate text-sm font-medium text-primary hover:underline"
                                href={document.url}
                                target="_blank"
                                rel="noreferrer"
                              >
                                {document.name}
                              </a>
                            ) : (
                              <span className="block truncate text-sm font-medium">
                                {document.name}
                              </span>
                            )}
                            <Label
                              className="text-xs text-muted-foreground"
                              htmlFor={`remove-${document.fileToken}`}
                            >
                              删除此方案
                            </Label>
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                ) : null}
                <ChangeAttachmentField
                  id="change-adjustment-schemes"
                  title="上传最新方案"
                  help="可上传 PDF、Word、Excel 或图片；调整后最多 5 个，单个不超过 200 MB。"
                  accept=".pdf,.doc,.docx,.xls,.xlsx,.png,.jpg,.jpeg"
                  ownerMutationId={ownerMutationId}
                  items={newSchemeItems}
                  setItems={setNewSchemeItems}
                  minCount={0}
                  maxCount={maxNewSchemes}
                  maxSize={CHANGE_REQUEST_MAX_DOCUMENT_SIZE}
                  disabled={draftLocked}
                  error={errorsByField.get('newSchemeDocuments')}
                  isAllowed={isAllowedChangeRequestDocument}
                  stageAttachment={stageChangeAttachment}
                  deleteAttachment={deleteChangeAttachment}
                  onChanged={() => setErrors([])}
                />
              </section>

              <section className="space-y-4 rounded-lg border bg-card p-4 shadow-sm">
                <div className="space-y-2">
                  <Label htmlFor="change-adjustment-reason">调整理由 *</Label>
                  <Textarea
                    id="change-adjustment-reason"
                    value={reason}
                    maxLength={CHANGE_ADJUSTMENT_REASON_MAX_LENGTH}
                    disabled={draftLocked}
                    className="min-h-24"
                    aria-invalid={errorsByField.has('reason')}
                    onChange={(event) => {
                      setReason(event.target.value);
                      setErrors([]);
                    }}
                  />
                  <div className="flex justify-between text-xs text-muted-foreground">
                    <FieldError message={errorsByField.get('reason')} />
                    <span>
                      {Array.from(reason).length}/
                      {CHANGE_ADJUSTMENT_REASON_MAX_LENGTH}
                    </span>
                  </div>
                </div>
                <ChangeAttachmentField
                  id="change-adjustment-evidence"
                  title="延期举证"
                  help="支持图片或 PDF；最多 5 个，单个不超过 20 MB。"
                  accept=".pdf,.png,.jpg,.jpeg"
                  ownerMutationId={ownerMutationId}
                  items={evidenceItems}
                  setItems={setEvidenceItems}
                  minCount={1}
                  maxCount={CHANGE_ADJUSTMENT_EVIDENCE_MAX_COUNT}
                  maxSize={CHANGE_ADJUSTMENT_EVIDENCE_MAX_SIZE}
                  required
                  disabled={draftLocked}
                  error={errorsByField.get('evidenceDocuments')}
                  isAllowed={isAllowedChangeAdjustmentEvidence}
                  stageAttachment={stageChangeAttachment}
                  deleteAttachment={deleteChangeAttachment}
                  onChanged={() => setErrors([])}
                />
              </section>
            </>
          ) : null}
        </div>

        <DialogFooter className="shrink-0 border-t bg-muted/30 px-5 py-3 sm:px-6">
          <Button
            type="button"
            variant="outline"
            disabled={submitting}
            onClick={() => onOpenChange(false)}
          >
            取消
          </Button>
          <Button
            type="button"
            disabled={
              !selectedChange ||
              submitting ||
              attachmentBusy ||
              !schemeReady ||
              !evidenceReady
            }
            onClick={handleSubmit}
          >
            {submitting ? (
              <Loader2 className="animate-spin" />
            ) : (
              <CalendarClock />
            )}
            提交调整
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function FieldError({ message }: { message?: string }) {
  return message ? (
    <span role="alert" className="text-xs text-destructive">
      {message}
    </span>
  ) : null;
}

function isAllowedChangeAdjustmentEvidence(
  file: ChangeAttachmentFile,
): boolean {
  const allowed: Record<string, readonly string[]> = {
    '.pdf': ['application/pdf'],
    '.png': ['image/png'],
    '.jpg': ['image/jpeg'],
    '.jpeg': ['image/jpeg'],
  };
  return isChangeAttachmentFileAllowedByExtension(file, allowed);
}
