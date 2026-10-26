import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Building2,
  ClipboardCheck,
  FileText,
  Layers3,
  Loader2,
} from 'lucide-react';
import { toast } from 'sonner';

import { deleteChangeAttachment, stageChangeAttachment } from '@/api';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { ChangeInfo } from '@shared/api.interface';
import {
  CHANGE_DRILL_REPORT_MAX_DOCUMENT_COUNT,
  CHANGE_DRILL_REPORT_MAX_DOCUMENT_SIZE,
  validateChangeDrillReport,
  type ChangeDrillReportCreateRequest,
  type ChangeDrillReportValidationError,
} from '@shared/change-drill-report';
import {
  CHANGE_REQUEST_BUILDINGS,
  isAllowedChangeRequestDocument,
  type ChangeRequestBuilding,
} from '@shared/change-request';
import { ChangeAttachmentField } from './ChangeAttachmentField';
import {
  createChangeDrillReportDraftForRecord,
  listChangeDrillReportCandidates,
} from './change-drill-report-state';
import {
  createStagedChangeAttachmentUploadItems,
  getReadyChangeAttachmentDocuments,
  isChangeAttachmentCollectionReady,
  type ChangeAttachmentUploadItem,
} from './change-attachment-staging';

interface ChangeDrillReportDialogProps {
  open: boolean;
  ownerMutationId: string;
  changes: readonly ChangeInfo[];
  submitting?: boolean;
  serverError?: string | null;
  retryBinding?: {
    request: ChangeDrillReportCreateRequest;
    original: ChangeInfo;
  } | null;
  onOpenChange: (open: boolean) => void;
  onDraftChange?: () => void;
  onSubmit: (
    request: ChangeDrillReportCreateRequest,
    original: ChangeInfo,
  ) => void;
}

export function ChangeDrillReportDialog({
  open,
  ownerMutationId,
  changes,
  submitting = false,
  serverError,
  retryBinding,
  onOpenChange,
  onDraftChange,
  onSubmit,
}: ChangeDrillReportDialogProps) {
  const candidates = useMemo(
    () => listChangeDrillReportCandidates(changes),
    [changes],
  );
  const [selectedRecordId, setSelectedRecordId] = useState('');
  const [buildings, setBuildings] = useState<ChangeRequestBuilding[]>([]);
  const [reportItems, setReportItems] = useState<ChangeAttachmentUploadItem[]>(
    [],
  );
  const [errors, setErrors] = useState<ChangeDrillReportValidationError[]>([]);
  const draftLocked = submitting || Boolean(retryBinding);
  const initializedOwnerMutationIdRef = useRef<string | null>(null);

  const selectedChange = useMemo(
    () =>
      retryBinding?.original ||
      candidates.find(
        (change) => change.bitableRecordId === selectedRecordId,
      ) ||
      null,
    [candidates, retryBinding, selectedRecordId],
  );

  useEffect(() => {
    const ownerChanged =
      initializedOwnerMutationIdRef.current !== ownerMutationId;
    initializedOwnerMutationIdRef.current = ownerMutationId;
    if (retryBinding) {
      setSelectedRecordId(retryBinding.request.changeRecordId);
      setBuildings([...retryBinding.request.buildings]);
      setReportItems(
        createStagedChangeAttachmentUploadItems(
          retryBinding.request.reportDocuments,
        ),
      );
      setErrors([]);
      return;
    }
    if (!ownerChanged) return;

    setSelectedRecordId('');
    setBuildings([]);
    setReportItems([]);
    setErrors([]);
  }, [ownerMutationId, retryBinding]);

  const errorsByField = useMemo(() => {
    const grouped = new Map<string, string>();
    errors.forEach((error) => {
      if (!grouped.has(error.field)) grouped.set(error.field, error.message);
    });
    return grouped;
  }, [errors]);

  const reportDocuments = getReadyChangeAttachmentDocuments(reportItems);
  const reportReady = isChangeAttachmentCollectionReady(
    reportItems,
    1,
    CHANGE_DRILL_REPORT_MAX_DOCUMENT_COUNT,
  );
  const attachmentBusy = reportItems.some(
    (item) => item.status === 'queued' || item.status === 'uploading',
  );

  const selectChange = (recordId: string) => {
    const change = candidates.find(
      (candidate) => candidate.bitableRecordId === recordId,
    );
    if (!change) return;

    const draft = createChangeDrillReportDraftForRecord(change);
    setSelectedRecordId(draft.changeRecordId);
    setBuildings([...draft.buildings]);
    setErrors([]);
    onDraftChange?.();
  };

  const toggleBuilding = (
    building: ChangeRequestBuilding,
    checked: boolean,
  ) => {
    setBuildings((current) =>
      checked
        ? CHANGE_REQUEST_BUILDINGS.filter(
            (candidate) =>
              candidate === building || current.includes(candidate),
          )
        : current.filter((candidate) => candidate !== building),
    );
    setErrors([]);
    onDraftChange?.();
  };

  const dismissDialog = () => {
    if (submitting || attachmentBusy) return;
    if (retryBinding) {
      onOpenChange(false);
      return;
    }

    const stagedStorageIds = Array.from(
      new Set(
        reportItems
          .map((item) => item.stagedDocument?.objectStorage.id)
          .filter((id): id is string => Boolean(id)),
      ),
    );
    setReportItems([]);
    setErrors([]);
    onOpenChange(false);
    if (stagedStorageIds.length === 0) return;

    void Promise.allSettled(
      stagedStorageIds.map((storageId) =>
        deleteChangeAttachment(storageId, ownerMutationId),
      ),
    ).then((results) => {
      if (results.some((result) => result.status === 'rejected')) {
        toast.warning('部分临时演练附件未能立即清理，将由系统定期回收');
      }
    });
  };

  const handleSubmit = () => {
    if (submitting || attachmentBusy) return;
    if (retryBinding) {
      onSubmit(retryBinding.request, retryBinding.original);
      return;
    }
    if (!selectedChange) return;

    const request: ChangeDrillReportCreateRequest = {
      clientMutationId: ownerMutationId,
      changeRecordId: selectedChange.bitableRecordId,
      buildings: [...buildings],
      reportDocuments,
    };
    const nextErrors = validateChangeDrillReport(request);
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
        if (nextOpen) {
          onOpenChange(true);
        } else {
          dismissDialog();
        }
      }}
    >
      <DialogContent className="flex max-h-[min(90dvh,760px)] w-[min(94vw,820px)] max-w-none flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="shrink-0 border-b bg-muted/40 px-5 py-4 pr-12 text-left sm:px-6">
          <DialogTitle className="flex items-center gap-2 text-lg">
            <ClipboardCheck className="size-5 text-primary" />
            演练报告提交
          </DialogTitle>
          <DialogDescription>
            选择执行中或未执行的中高风险变更，补充演练楼栋与报告。
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-5 sm:px-6">
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
              上次提交结果待确认，当前内容已锁定，可按原内容重试。
            </p>
          ) : null}

          <section className="space-y-3 rounded-lg border bg-card p-4 shadow-sm">
            <h3 className="flex items-center gap-2 text-sm font-semibold">
              <Layers3 className="size-4 text-primary" />
              关联变更
            </h3>
            {retryBinding ? (
              <ChangeSummary change={retryBinding.original} />
            ) : candidates.length > 0 ? (
              <div className="space-y-2">
                <Label htmlFor="change-drill-report-record">变更记录 *</Label>
                <Select value={selectedRecordId} onValueChange={selectChange}>
                  <SelectTrigger
                    id="change-drill-report-record"
                    aria-invalid={errorsByField.has('changeRecordId')}
                  >
                    <SelectValue placeholder="请选择执行中或未执行的中高风险变更" />
                  </SelectTrigger>
                  <SelectContent>
                    {candidates.map((change) => (
                      <SelectItem
                        key={change.bitableRecordId}
                        value={change.bitableRecordId}
                      >
                        {change.title} · {change.level}风险 ·{' '}
                        {getScheduleStatusLabel(change)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FieldError message={errorsByField.get('changeRecordId')} />
                {selectedChange ? (
                  <ChangeSummary change={selectedChange} />
                ) : null}
              </div>
            ) : (
              <p className="rounded-md bg-muted/50 px-3 py-4 text-center text-sm text-muted-foreground">
                当前没有可提交演练报告的中高风险变更
              </p>
            )}
          </section>

          {selectedChange ? (
            <>
              <section className="space-y-3 rounded-lg border bg-card p-4 shadow-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="flex items-center gap-2 text-sm font-semibold">
                    <Building2 className="size-4 text-primary" />
                    演练楼栋
                  </h3>
                  <span className="text-xs text-muted-foreground">
                    支持多选 · 已选 {buildings.length} 个
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  {CHANGE_REQUEST_BUILDINGS.map((building) => {
                    const inputId = `change-drill-building-${building}`;
                    return (
                      <Label
                        key={building}
                        htmlFor={inputId}
                        className="flex cursor-pointer items-center gap-2 rounded-lg border bg-background px-3 py-2.5 text-sm transition-colors has-[[data-state=checked]]:border-primary/50 has-[[data-state=checked]]:bg-primary/5"
                      >
                        <Checkbox
                          id={inputId}
                          checked={buildings.includes(building)}
                          disabled={draftLocked}
                          onCheckedChange={(checked) =>
                            toggleBuilding(building, checked === true)
                          }
                        />
                        {building}
                      </Label>
                    );
                  })}
                </div>
                <FieldError message={errorsByField.get('buildings')} />
              </section>

              <section className="space-y-3 rounded-lg border bg-card p-4 shadow-sm">
                <h3 className="flex items-center gap-2 text-sm font-semibold">
                  <FileText className="size-4 text-primary" />
                  演练报告
                </h3>
                <ChangeAttachmentField
                  id="change-drill-report-documents"
                  title="报告附件"
                  help="支持 PDF、Word、Excel、PNG、JPG、JPEG；1–5 个，单个不超过 200 MiB。"
                  accept=".pdf,.doc,.docx,.xls,.xlsx,.png,.jpg,.jpeg"
                  ownerMutationId={ownerMutationId}
                  items={reportItems}
                  setItems={setReportItems}
                  minCount={1}
                  maxCount={CHANGE_DRILL_REPORT_MAX_DOCUMENT_COUNT}
                  maxSize={CHANGE_DRILL_REPORT_MAX_DOCUMENT_SIZE}
                  required
                  disabled={draftLocked}
                  error={errorsByField.get('reportDocuments')}
                  isAllowed={isAllowedChangeRequestDocument}
                  stageAttachment={stageChangeAttachment}
                  deleteAttachment={deleteChangeAttachment}
                  onChanged={() => {
                    setErrors([]);
                    onDraftChange?.();
                  }}
                />
              </section>
            </>
          ) : null}
        </div>

        <DialogFooter className="shrink-0 border-t bg-muted/30 px-5 py-3 sm:px-6">
          <Button
            type="button"
            variant="outline"
            disabled={submitting || attachmentBusy}
            onClick={dismissDialog}
          >
            {retryBinding ? '稍后处理' : '取消'}
          </Button>
          <Button
            type="button"
            disabled={
              submitting ||
              attachmentBusy ||
              (!retryBinding && (!selectedChange || !reportReady))
            }
            onClick={handleSubmit}
          >
            {submitting ? (
              <Loader2 className="animate-spin" />
            ) : (
              <ClipboardCheck />
            )}
            {retryBinding ? '安全重试' : '提交演练报告'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ChangeSummary({ change }: { change: ChangeInfo }) {
  return (
    <div className="grid gap-3 rounded-lg border bg-muted/25 p-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
      <div className="min-w-0">
        <p className="truncate text-sm font-semibold">{change.title}</p>
        <p className="mt-1 text-xs text-muted-foreground">
          {formatChangePeriod(change)}
        </p>
      </div>
      <div className="flex flex-wrap gap-2 text-xs">
        <span className="rounded-md border border-amber-300 bg-amber-50 px-2 py-1 font-medium text-amber-800">
          {change.level}风险
        </span>
        <span className="rounded-md border bg-background px-2 py-1 text-muted-foreground">
          {getScheduleStatusLabel(change)}
        </span>
      </div>
    </div>
  );
}

function FieldError({ message }: { message?: string }) {
  return message ? (
    <p role="alert" className="text-xs text-destructive">
      {message}
    </p>
  ) : null;
}

function getScheduleStatusLabel(change: ChangeInfo): string {
  if (change.actualStartDate || change.scheduleStatus === 'in-progress') {
    return '执行中';
  }
  return '未执行';
}

function formatChangePeriod(change: ChangeInfo): string {
  return `${formatDateTime(change.plannedDelayStartDate || change.startDate)} 至 ${formatDateTime(change.plannedDelayEndDate || change.endDate)}`;
}

function formatDateTime(value: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(parsed);
}
