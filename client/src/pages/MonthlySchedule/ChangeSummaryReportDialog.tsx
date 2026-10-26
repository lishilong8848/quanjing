import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { ClipboardList, FileCheck2, Loader2, UserRound } from 'lucide-react';
import { toast } from 'sonner';
import { useAccess } from '@/access/AccessProvider';
import { hasAuthenticatedAccessIdentity } from '@/access/access-policy';
import { resolveSelfServiceApplicant } from '@shared/self-service-applicant';

import { deleteChangeAttachment, stageChangeAttachment } from '@/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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
  CHANGE_SUMMARY_REPORT_MAX_DOCUMENT_COUNT,
  CHANGE_SUMMARY_REPORT_MAX_DOCUMENT_SIZE,
  validateChangeSummaryReport,
  type ChangeSummaryReportCreateRequest,
  type ChangeSummaryReportValidationError,
} from '@shared/change-summary-report';
import { isAllowedChangeRequestDocument } from '@shared/change-request';
import { ChangeAttachmentField } from './ChangeAttachmentField';
import {
  createStagedChangeAttachmentUploadItems,
  getReadyChangeAttachmentDocuments,
  isChangeAttachmentCollectionReady,
  type ChangeAttachmentUploadItem,
} from './change-attachment-staging';
import {
  createChangeSummaryReportRecoveryOriginal,
  type ChangeSummaryReportRecoveryBinding,
  type ChangeSummaryReportRecoveryOriginal,
} from './change-summary-report-recovery';
import {
  filterChangeSummaryReportPersonOptions,
  listEligibleChangeSummaryRecords,
  resolveChangeSummaryReportCachePresentation,
} from './change-summary-report-state';

type CacheStatus = 'loading' | 'ready' | 'error';

interface ChangeSummaryReportDialogProps {
  open: boolean;
  ownerMutationId: string;
  changes: readonly ChangeInfo[];
  personOptions: readonly string[];
  changesStatus: CacheStatus;
  personOptionsStatus: CacheStatus;
  pendingChangeRecordIds: ReadonlySet<string>;
  submitting?: boolean;
  abandoning?: boolean;
  serverError?: string | null;
  retryBinding?: ChangeSummaryReportRecoveryBinding | null;
  onOpenChange: (open: boolean) => void;
  onDraftChange?: () => void;
  onSubmit: (
    request: ChangeSummaryReportCreateRequest,
    original: ChangeSummaryReportRecoveryOriginal,
  ) => void;
  onAbandonFailed: (binding: ChangeSummaryReportRecoveryBinding) => void;
}

export function ChangeSummaryReportDialog({
  open,
  ownerMutationId,
  changes,
  personOptions,
  changesStatus,
  personOptionsStatus,
  pendingChangeRecordIds,
  submitting = false,
  abandoning = false,
  serverError,
  retryBinding,
  onOpenChange,
  onDraftChange,
  onSubmit,
  onAbandonFailed,
}: ChangeSummaryReportDialogProps) {
  const access = useAccess();
  const applicant = useMemo(() => resolveSelfServiceApplicant(access, hasAuthenticatedAccessIdentity(access), '提交变更总结'),
    [access.role, access.accountId, access.displayName, access.expiresAt, access.principalFingerprint]);
  const [manualSubmitterName, setSubmitterName] = useState('');
  const submitterName = applicant.mode === 'automatic' ? applicant.name : manualSubmitterName;
  const identityError = applicant.mode === 'login' || applicant.mode === 'error' ? applicant.message
    : applicant.mode === 'automatic' && retryBinding && retryBinding.request.submitterName !== applicant.name
      ? '恢复的变更提交人不是当前登录本人，请联系管理员处理' : '';
  useEffect(() => {
    if (open && !access.isLoading && applicant.mode === 'login') {
      onOpenChange(false);
      access.requestLogin(applicant.message);
    }
  }, [open, access.isLoading, applicant, onOpenChange, access.requestLogin]);
  const [selectedRecordId, setSelectedRecordId] = useState('');
  const [changeSearch, setChangeSearch] = useState('');
  const [summaryItems, setSummaryItems] = useState<
    ChangeAttachmentUploadItem[]
  >([]);
  const [errors, setErrors] = useState<ChangeSummaryReportValidationError[]>(
    [],
  );
  const initializedOwnerMutationIdRef = useRef<string | null>(null);
  const draftLocked = submitting || Boolean(retryBinding);
  const deferredSubmitterName = useDeferredValue(submitterName);
  const deferredChangeSearch = useDeferredValue(changeSearch);
  const allPersonOptions = useMemo(
    () => filterChangeSummaryReportPersonOptions(personOptions, ''),
    [personOptions],
  );
  const normalizedPersonOptions = useMemo(
    () =>
      filterChangeSummaryReportPersonOptions(
        personOptions,
        deferredSubmitterName,
      ),
    [deferredSubmitterName, personOptions],
  );
  const candidates = useMemo(
    () =>
      listEligibleChangeSummaryRecords(changes, submitterName).filter(
        (change) => !pendingChangeRecordIds.has(change.bitableRecordId),
      ),
    [changes, pendingChangeRecordIds, submitterName],
  );
  const selectedChange = useMemo(
    () =>
      retryBinding?.original ||
      candidates.find(
        (change) => change.bitableRecordId === selectedRecordId,
      ) ||
      null,
    [candidates, retryBinding, selectedRecordId],
  );
  const displayedCandidates = useMemo(() => {
    const query = deferredChangeSearch.normalize('NFKC').trim().toLowerCase();
    return candidates
      .filter((change) => {
        if (!query) return true;
        return `${getChangeNumber(change)} ${change.title} ${change.level || ''}`
          .normalize('NFKC')
          .toLowerCase()
          .includes(query);
      })
      .slice(0, 100);
  }, [candidates, deferredChangeSearch]);
  const personCachePresentation = resolveChangeSummaryReportCachePresentation(
    personOptionsStatus,
    allPersonOptions.length,
  );
  const changeCachePresentation = resolveChangeSummaryReportCachePresentation(
    changesStatus,
    changes.length,
  );

  useEffect(() => {
    const ownerChanged =
      initializedOwnerMutationIdRef.current !== ownerMutationId;
    initializedOwnerMutationIdRef.current = ownerMutationId;
    if (retryBinding) {
      setSubmitterName(retryBinding.request.submitterName);
      setSelectedRecordId(retryBinding.request.changeRecordId);
      setChangeSearch('');
      setSummaryItems(
        createStagedChangeAttachmentUploadItems(
          retryBinding.request.summaryDocuments,
        ),
      );
      setErrors([]);
      return;
    }
    if (!ownerChanged) return;
    setSubmitterName('');
    setSelectedRecordId('');
    setChangeSearch('');
    setSummaryItems([]);
    setErrors([]);
  }, [ownerMutationId, retryBinding]);

  const errorsByField = useMemo(() => {
    const grouped = new Map<string, string>();
    errors.forEach((error) => {
      if (!grouped.has(error.field)) grouped.set(error.field, error.message);
    });
    return grouped;
  }, [errors]);
  const summaryDocuments = getReadyChangeAttachmentDocuments(summaryItems);
  const attachmentsReady = isChangeAttachmentCollectionReady(
    summaryItems,
    1,
    CHANGE_SUMMARY_REPORT_MAX_DOCUMENT_COUNT,
  );
  const attachmentBusy = summaryItems.some(
    (item) => item.status === 'queued' || item.status === 'uploading',
  );

  const markDraftChanged = () => {
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
        summaryItems
          .map((item) => item.stagedDocument?.objectStorage.id)
          .filter((id): id is string => Boolean(id)),
      ),
    );
    setSummaryItems([]);
    setErrors([]);
    onOpenChange(false);
    void Promise.allSettled(
      stagedStorageIds.map((storageId) =>
        deleteChangeAttachment(storageId, ownerMutationId),
      ),
    ).then((results) => {
      if (results.some((result) => result.status === 'rejected')) {
        toast.warning('部分临时附件未能立即清理，将由系统定期回收');
      }
    });
  };

  const handleSubmit = () => {
    if (submitting || attachmentBusy || access.isLoading || identityError) return;
    if (retryBinding) {
      if (retryBinding.state === 'cleanup-required') return;
      onSubmit(retryBinding.request, retryBinding.original);
      return;
    }
    if (!selectedChange) return;
    const request: ChangeSummaryReportCreateRequest = {
      clientMutationId: ownerMutationId,
      submitterName,
      changeRecordId: selectedChange.bitableRecordId,
      summaryDocuments,
    };
    const nextErrors = validateChangeSummaryReport(request);
    if (nextErrors.length > 0) {
      setErrors(nextErrors);
      return;
    }
    setErrors([]);
    onSubmit(
      request,
      createChangeSummaryReportRecoveryOriginal(selectedChange),
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen) onOpenChange(true);
        else dismissDialog();
      }}
    >
      <DialogContent
        className="flex max-h-[min(90dvh,760px)] w-[min(94vw,820px)] max-w-none flex-col gap-0 overflow-hidden p-0"
        aria-describedby="change-summary-report-description"
      >
        <DialogHeader className="shrink-0 border-b bg-muted/40 px-5 py-4 pr-12 text-left sm:px-6">
          <DialogTitle className="flex items-center gap-2 text-lg">
            <ClipboardList className="size-5 text-primary" aria-hidden="true" />
            变更总结
          </DialogTitle>
          <DialogDescription
            id="change-summary-report-description"
            className="sr-only"
          >
            选择已结束的变更项目，上传总结材料后提交。
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
              {retryBinding.state === 'cleanup-required'
                ? '清理尚未完成，仅可继续清理，完成后才能重新填写。'
                : retryBinding.state === 'failed'
                  ? '上次提交失败，可重试或清理后重新填写。'
                  : '上次提交结果尚未确认，内容已保留。'}
            </p>
          ) : null}

          <section className="space-y-3 rounded-lg border bg-card p-4 shadow-sm">
            <h3 className="flex items-center gap-2 text-sm font-semibold">
              <UserRound className="size-4 text-primary" aria-hidden="true" />
              变更提交人
            </h3>
            {applicant.mode !== 'manual' ? (
              <>
                <Input id="change-summary-submitter" aria-label="变更提交人" readOnly
                  value={applicant.mode === 'automatic' ? applicant.name : ''} />
                {identityError ? <p role="alert" className="text-sm text-destructive">{identityError}</p> : null}
              </>
            ) : personCachePresentation.blocking ? (
              <CacheMessage loading>正在加载人员</CacheMessage>
            ) : !personCachePresentation.hasUsableData &&
              personOptionsStatus === 'error' ? (
              <CacheMessage>人员加载失败，请稍后重试</CacheMessage>
            ) : !personCachePresentation.hasUsableData ? (
              <CacheMessage>暂无可选人员</CacheMessage>
            ) : (
              <>
                <CacheRefreshNotice
                  refreshing={personCachePresentation.refreshing}
                  failed={personCachePresentation.refreshFailed}
                />
                <Input
                  id="change-summary-submitter"
                  list="change-summary-submitter-options"
                  value={submitterName}
                  placeholder="输入姓名快速匹配"
                  autoComplete="off"
                  disabled={draftLocked}
                  aria-label="变更提交人"
                  aria-required="true"
                  aria-invalid={errorsByField.has('submitterName')}
                  aria-describedby={
                    errorsByField.has('submitterName')
                      ? 'change-summary-submitter-error'
                      : undefined
                  }
                  onChange={(event) => {
                    setSubmitterName(event.target.value);
                    setSelectedRecordId('');
                    setChangeSearch('');
                    markDraftChanged();
                  }}
                />
                <datalist id="change-summary-submitter-options">
                  {normalizedPersonOptions.map((name) => (
                    <option key={name} value={name} />
                  ))}
                </datalist>
                {submitterName && normalizedPersonOptions.length === 0 ? (
                  <CacheMessage>没有匹配的人员</CacheMessage>
                ) : null}
                <FieldError
                  id="change-summary-submitter-error"
                  message={errorsByField.get('submitterName')}
                />
              </>
            )}
          </section>

          <section className="space-y-3 rounded-lg border bg-card p-4 shadow-sm">
            <h3 className="flex items-center gap-2 text-sm font-semibold">
              <FileCheck2 className="size-4 text-primary" aria-hidden="true" />
              变更项目
            </h3>
            {retryBinding ? (
              <ChangeSummary change={retryBinding.original} />
            ) : changeCachePresentation.blocking ? (
              <CacheMessage loading>正在加载变更项目</CacheMessage>
            ) : !changeCachePresentation.hasUsableData &&
              changesStatus === 'error' ? (
              <CacheMessage>变更项目加载失败，请稍后重试</CacheMessage>
            ) : !submitterName ? (
              <CacheMessage>请先选择变更提交人</CacheMessage>
            ) : candidates.length === 0 ? (
              changeCachePresentation.refreshing ? (
                <CacheMessage loading>正在刷新可提交的变更项目</CacheMessage>
              ) : changeCachePresentation.refreshFailed ? (
                <CacheMessage>变更项目刷新失败，请重新打开弹窗重试</CacheMessage>
              ) : (
                <CacheMessage>该人员当前没有可提交总结的变更项目</CacheMessage>
              )
            ) : (
              <>
                <CacheRefreshNotice
                  refreshing={changeCachePresentation.refreshing}
                  failed={changeCachePresentation.refreshFailed}
                />
                {candidates.length > 20 ? (
                  <Input
                    value={changeSearch}
                    onChange={(event) => setChangeSearch(event.target.value)}
                    placeholder="搜索编号或项目名称"
                    aria-label="搜索变更项目"
                    disabled={draftLocked}
                  />
                ) : null}
                <Label htmlFor="change-summary-record">变更项目 *</Label>
                {displayedCandidates.length === 0 ? (
                  <CacheMessage>没有匹配的变更项目</CacheMessage>
                ) : (
                  <Select
                    value={selectedRecordId}
                    disabled={draftLocked}
                    onValueChange={(value) => {
                      setSelectedRecordId(value);
                      markDraftChanged();
                    }}
                  >
                    <SelectTrigger
                      id="change-summary-record"
                      aria-invalid={errorsByField.has('changeRecordId')}
                      aria-describedby={
                        errorsByField.has('changeRecordId')
                          ? 'change-summary-record-error'
                          : undefined
                      }
                    >
                      <SelectValue placeholder="请选择变更项目" />
                    </SelectTrigger>
                    <SelectContent>
                      {displayedCandidates.map((change) => (
                        <SelectItem
                          key={change.bitableRecordId}
                          value={change.bitableRecordId}
                        >
                          {getChangeNumber(change)} · {change.title} ·{' '}
                          {change.level}风险
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
                <FieldError
                  id="change-summary-record-error"
                  message={errorsByField.get('changeRecordId')}
                />
                {selectedChange ? (
                  <ChangeSummary change={selectedChange} />
                ) : null}
              </>
            )}
          </section>

          <ChangeAttachmentField
            id="change-summary-documents"
            title="变更总结材料"
            help="支持 PDF、Word、Excel 或图片；1-5 个，单个不超过 200 MB。"
            accept=".pdf,.doc,.docx,.xls,.xlsx,.png,.jpg,.jpeg"
            ownerMutationId={ownerMutationId}
            items={summaryItems}
            setItems={setSummaryItems}
            minCount={1}
            maxCount={CHANGE_SUMMARY_REPORT_MAX_DOCUMENT_COUNT}
            maxSize={CHANGE_SUMMARY_REPORT_MAX_DOCUMENT_SIZE}
            disabled={draftLocked}
            required
            error={errorsByField.get('summaryDocuments')}
            isAllowed={isAllowedChangeRequestDocument}
            stageAttachment={stageChangeAttachment}
            deleteAttachment={deleteChangeAttachment}
            onChanged={markDraftChanged}
          />
        </div>

        <DialogFooter className="shrink-0 border-t bg-background px-5 py-4 sm:px-6">
          <Button
            type="button"
            variant="outline"
            disabled={submitting || attachmentBusy}
            onClick={dismissDialog}
          >
            {retryBinding ? '稍后处理' : '取消'}
          </Button>
          {retryBinding?.state === 'failed' ||
          retryBinding?.state === 'cleanup-required' ? (
            <Button
              type="button"
              variant="destructive"
              disabled={submitting || abandoning || Boolean(identityError) || access.isLoading}
              onClick={() => onAbandonFailed(retryBinding)}
            >
              {abandoning ? (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              ) : null}
              {retryBinding.state === 'cleanup-required'
                ? '继续清理'
                : '放弃并重新填写'}
            </Button>
          ) : null}
          {retryBinding?.state !== 'cleanup-required' ? (
            <Button
              type="button"
              disabled={
                submitting ||
                access.isLoading || Boolean(identityError) ||
                attachmentBusy ||
                !submitterName ||
                !selectedChange ||
                !attachmentsReady
              }
              onClick={handleSubmit}
            >
              {submitting ? (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              ) : null}
              {retryBinding
                ? retryBinding.state === 'failed'
                  ? '重新提交'
                  : '重试'
                : '提交变更总结'}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ChangeSummary({
  change,
}: {
  change: ChangeSummaryReportRecoveryOriginal;
}) {
  return (
    <div className="grid gap-2 rounded-md bg-muted/50 px-3 py-3 text-sm sm:grid-cols-2">
      <p className="sm:col-span-2">
        <span className="text-muted-foreground">编号与项目：</span>
        {getChangeNumber(change)} · {change.title}
      </p>
      <p>
        <span className="text-muted-foreground">变更等级：</span>
        {change.level || '-'}
      </p>
      <p>
        <span className="text-muted-foreground">变更提交人：</span>
        {change.submitterName || '-'}
      </p>
      <p>
        <span className="text-muted-foreground">计划开始：</span>
        {formatDateTime(change.startDate)}
      </p>
      <p>
        <span className="text-muted-foreground">计划结束：</span>
        {formatDateTime(change.endDate)}
      </p>
    </div>
  );
}

function CacheMessage({
  children,
  loading = false,
}: {
  children: React.ReactNode;
  loading?: boolean;
}) {
  return (
    <p
      role="status"
      className="flex items-center justify-center gap-2 rounded-md bg-muted/50 px-3 py-4 text-center text-sm text-muted-foreground"
    >
      {loading ? (
        <Loader2 className="size-4 animate-spin" aria-hidden="true" />
      ) : null}
      {children}
    </p>
  );
}

function CacheRefreshNotice({
  refreshing,
  failed,
}: {
  refreshing: boolean;
  failed: boolean;
}) {
  if (!refreshing && !failed) return null;
  return (
    <p className="text-xs text-muted-foreground" role="status">
      {refreshing
        ? '数据正在更新，当前内容仍可使用。'
        : '更新失败，已保留现有内容。'}
    </p>
  );
}

function FieldError({ id, message }: { id: string; message?: string }) {
  return message ? (
    <p id={id} role="alert" className="text-xs text-destructive">
      {message}
    </p>
  ) : null;
}

function getChangeNumber(
  change: Pick<ChangeInfo, 'title' | 'bitableRecordId'>,
): string {
  const prefix = change.title.match(/^BG-\d+/u)?.[0];
  return prefix || change.bitableRecordId;
}

function formatDateTime(value: string): string {
  return (
    value
      .trim()
      .replace('T', ' ')
      .replace(/(?:\+08:00|Z)$/u, '') || '-'
  );
}
