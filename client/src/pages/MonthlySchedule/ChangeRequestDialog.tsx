import { useEffect, useMemo, useRef, useState } from 'react';
import { useAccess } from '@/access/AccessProvider';
import { hasAuthenticatedAccessIdentity } from '@/access/access-policy';
import { resolveSelfServiceApplicant } from '@shared/self-service-applicant';
import {
  AlertCircle,
  Building2,
  Clock3,
  FileText,
  Layers3,
  Loader2,
  ShieldAlert,
  type LucideIcon,
} from 'lucide-react';

import { Alert, AlertDescription } from '@/components/ui/alert';
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
import {
  CHANGE_REQUEST_BUILDINGS,
  CHANGE_REQUEST_DISCIPLINES,
  CHANGE_REQUEST_LEVELS,
  CHANGE_REQUEST_MAX_DOCUMENT_COUNT,
  CHANGE_REQUEST_MAX_DOCUMENT_SIZE,
  CHANGE_REQUEST_NATURES,
  CHANGE_REQUEST_RISK_SUMMARY_MAX_LENGTH,
  CHANGE_REQUEST_SUMMARY_MAX_LENGTH,
  CHANGE_REQUEST_TYPES,
  CHANGE_REQUEST_WORK_TYPES,
  createEmptyChangeRequestDraft,
  isAllowedChangeRequestDocument,
  validateChangeRequest,
  type ChangeRequestBuilding,
  type ChangeRequestCreateRequest,
  type ChangeRequestDraft,
  type ChangeRequestNature,
  type ChangeRequestRetryAction,
  type ChangeRequestStagedDocument,
  type ChangeRequestValidationError,
  type ChangeRequestValidationField,
} from '@shared/change-request';
import { deleteChangeAttachment, stageChangeAttachment } from '@/api';
import { ChangeAttachmentField } from './ChangeAttachmentField';
import { ChangeRequestPersonPicker } from './ChangeRequestPersonPicker';
import { getChangeRequestDirectHref } from '@/navigation/change-request-route';
import {
  createStagedChangeAttachmentUploadItems,
  getReadyChangeAttachmentDocuments,
  isChangeAttachmentCollectionReady,
  type ChangeAttachmentUploadItem,
} from './change-attachment-staging';
import {
  reconcileChangeRequestEndAfterStart,
  reconcileChangeRequestRangeAfterStartChange,
} from './change-request-state';

const VALIDATION_MUTATION_ID =
  'change-request-00000000-0000-4000-8000-000000000000';
const EMPTY_STAGED_DOCUMENTS: readonly ChangeRequestStagedDocument[] = [];

export interface ChangeRequestDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  ownerMutationId: string;
  standalone?: boolean;
  initialDraft?: ChangeRequestDraft;
  initialStagedDocuments?: readonly ChangeRequestStagedDocument[];
  attachmentRetryLocked?: boolean;
  retryAction?: ChangeRequestRetryAction | null;
  resetKey?: string | number;
  submitting?: boolean;
  serverError?: string | null;
  submissionStatus?: string;
  onDraftChange?: () => void;
  onSubmit: (
    draft: ChangeRequestDraft,
    stagedDocuments: ChangeRequestStagedDocument[],
  ) => void;
}

export function ChangeRequestDialog({
  open,
  onOpenChange,
  ownerMutationId,
  standalone = false,
  initialDraft,
  initialStagedDocuments = EMPTY_STAGED_DOCUMENTS,
  attachmentRetryLocked = false,
  retryAction = null,
  submitting = false,
  serverError,
  submissionStatus,
  onDraftChange,
  onSubmit,
}: ChangeRequestDialogProps) {
  const access = useAccess();
  const applicant = useMemo(() => resolveSelfServiceApplicant(access, hasAuthenticatedAccessIdentity(access), '提交变更申请'),
    [access.accountId, access.displayName, access.expiresAt, access.principalFingerprint, access.role]);
  const [manualDraft, setDraft] = useState<ChangeRequestDraft>(() =>
    cloneDraft(initialDraft),
  );
  const draft = applicant.mode === 'automatic'
    ? { ...manualDraft, submitterName: applicant.name, submitterId: undefined }
    : manualDraft;
  useEffect(() => {
    if (!open || access.isLoading || (applicant.mode !== 'login' && applicant.mode !== 'error')) return;
    if (applicant.mode === 'login') {
      onOpenChange(false);
      access.requestLogin(applicant.message, '/change-request/apply');
    } else setErrors([{ field: 'submitterName', message: applicant.message }]);
  }, [open, access.isLoading, access.requestLogin, applicant, onOpenChange]);
  const [attachmentItems, setAttachmentItems] = useState<
    ChangeAttachmentUploadItem[]
  >(() => createStagedChangeAttachmentUploadItems(initialStagedDocuments));
  const [errors, setErrors] = useState<ChangeRequestValidationError[]>([]);
  const [secondaryFieldsReady, setSecondaryFieldsReady] = useState(false);
  const fieldRefs = useRef<
    Partial<Record<ChangeRequestValidationField, HTMLElement | null>>
  >({});

  useEffect(() => {
    if (!open) {
      setSecondaryFieldsReady(false);
      return;
    }
    let secondFrame: number | undefined;
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() =>
        setSecondaryFieldsReady(true),
      );
    });
    return () => {
      window.cancelAnimationFrame(firstFrame);
      if (secondFrame !== undefined) {
        window.cancelAnimationFrame(secondFrame);
      }
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() =>
      fieldRefs.current.submitterName?.focus(),
    );
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  const formDisabled = submitting || attachmentRetryLocked;

  const errorsByField = useMemo(() => {
    const grouped = new Map<
      ChangeRequestValidationField,
      ChangeRequestValidationError[]
    >();
    errors.forEach((error) => {
      grouped.set(error.field, [...(grouped.get(error.field) || []), error]);
    });
    return grouped;
  }, [errors]);

  const setFieldRef =
    (field: ChangeRequestValidationField) => (element: HTMLElement | null) => {
      fieldRefs.current[field] = element;
    };

  const clearFieldErrors = (...fields: ChangeRequestValidationField[]) => {
    setErrors((current) =>
      current.filter((error) => !fields.includes(error.field)),
    );
  };

  const updateDraft = <Field extends keyof ChangeRequestDraft>(
    field: Field,
    value: ChangeRequestDraft[Field],
  ) => {
    setDraft((current) => ({ ...current, [field]: value }));
    if (field === 'plannedStartAt' || field === 'plannedEndAt') {
      clearFieldErrors('plannedStartAt', 'plannedEndAt');
    } else if (field === 'meetingStartAt' || field === 'meetingEndAt') {
      clearFieldErrors('meetingStartAt', 'meetingEndAt');
    } else {
      clearFieldErrors(field);
    }
    onDraftChange?.();
  };

  const updatePlannedStartAt = (value: string) => {
    setDraft((current) => ({
      ...current,
      plannedStartAt: value,
      plannedEndAt: reconcileChangeRequestRangeAfterStartChange(
        current.plannedStartAt,
        current.plannedEndAt,
        value,
      ),
    }));
    clearFieldErrors('plannedStartAt', 'plannedEndAt');
    onDraftChange?.();
  };

  const updatePlannedEndAt = (value: string) => {
    setDraft((current) => ({
      ...current,
      plannedEndAt: reconcileChangeRequestEndAfterStart(
        current.plannedStartAt,
        value,
      ),
    }));
    clearFieldErrors('plannedStartAt', 'plannedEndAt');
    onDraftChange?.();
  };

  const updateNature = (nature: ChangeRequestNature | undefined) => {
    setDraft((current) => ({
      ...current,
      nature,
      ...(nature === '非标准变更'
        ? null
        : { meetingStartAt: '', meetingEndAt: '' }),
    }));
    clearFieldErrors('nature', 'meetingStartAt', 'meetingEndAt');
    onDraftChange?.();
  };

  const toggleBuilding = (
    building: ChangeRequestBuilding,
    checked: boolean,
  ) => {
    setDraft((current) => ({
      ...current,
      buildings: checked
        ? [...new Set([...current.buildings, building])]
        : current.buildings.filter((item) => item !== building),
    }));
    clearFieldErrors('buildings');
    onDraftChange?.();
  };

  const focusFirstError = (
    validationErrors: ChangeRequestValidationError[],
  ) => {
    const target = validationErrors
      .map((error) => fieldRefs.current[error.field])
      .find((element): element is HTMLElement => Boolean(element));
    window.requestAnimationFrame(() => target?.focus());
  };

  const handleSubmit = () => {
    if (submitting || retryAction === 'manual-reconcile') return;
    if (applicant.mode === 'login' || applicant.mode === 'error') {
      if (applicant.mode === 'login') access.requestLogin(applicant.message, '/change-request/apply');
      setErrors([{ field: 'submitterName', message: applicant.message }]);
      return;
    }
    if (applicant.mode === 'automatic' && attachmentRetryLocked && initialDraft?.submitterName && initialDraft.submitterName !== applicant.name) {
      setErrors([{ field: 'submitterName', message: '上次申请属于其他账号，请使用原账号登录后核对结果' }]);
      return;
    }
    const stagedDocuments = getReadyChangeAttachmentDocuments(attachmentItems);
    const validationErrors = validateChangeRequest(
      toValidationRequest({ ...draft, stagedDocuments }),
    );
    const normalizedSubmitter = draft.submitterName?.trim() || '';
    if (applicant.mode === 'manual' && normalizedSubmitter && !draft.submitterId) {
      validationErrors.unshift({
        field: 'submitterName',
        message: '请从人员名单中选择提交人',
      });
    }
    if (validationErrors.length) {
      setErrors(validationErrors);
      focusFirstError(validationErrors);
      return;
    }

    if (errors.length > 0) setErrors([]);
    const snapshot: ChangeRequestDraft = {
      ...draft,
      submitterName: normalizedSubmitter,
      stagedDocuments,
      buildings: [...draft.buildings],
    };
    onSubmit(snapshot, stagedDocuments);
  };

  const attachmentsReady = isChangeAttachmentCollectionReady(
    attachmentItems,
    1,
    CHANGE_REQUEST_MAX_DOCUMENT_COUNT,
  );

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen && submitting) return;
    onOpenChange(nextOpen);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="flex h-[min(92dvh,760px)] max-h-[92dvh] w-[min(96vw,960px)] max-w-none flex-col gap-0 overflow-hidden p-0 [animation-duration:0ms]"
        style={{ animation: 'none', opacity: 1 }}
        showCloseButton={!submitting}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
        }}
      >
        <DialogHeader className="shrink-0 border-b bg-muted/40 px-5 py-4 pr-12 text-left sm:px-6">
          <DialogTitle className="flex items-center gap-2 text-lg">
            <Layers3 className="size-5 text-primary" aria-hidden="true" />
            变更申请
          </DialogTitle>
          {!standalone && (
            <a
              className="text-sm text-primary underline"
              href={getChangeRequestDirectHref()}
              target="_blank"
              rel="noreferrer"
            >
              独立填写
            </a>
          )}
        </DialogHeader>

        <>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5 sm:px-6">
            <div className="space-y-5">
              {attachmentRetryLocked && (
                <Alert>
                  <AlertCircle aria-hidden="true" />
                  <AlertDescription>
                    {retryAction === 'manual-reconcile'
                      ? '提交结果待确认，请人工核查飞书多维表；当前已禁止自动重试。'
                      : retryAction === 'retry-same-mutation'
                        ? '为避免重复记录，本次将使用原申请标识重试，暂不可修改申请内容或附件。'
                        : '正式记录尚未建立，为保证本次重试幂等，暂不可修改申请内容或附件。'}
                  </AlertDescription>
                </Alert>
              )}
              <FormSection icon={Layers3} title="基础分类">
                <div className="space-y-2">
                  <Label htmlFor="change-request-submitter">
                    提交人 <RequiredMark />
                  </Label>
                  {applicant.mode !== 'manual' ? (
                    <Input id="change-request-submitter" ref={setFieldRef('submitterName')} value={applicant.mode === 'automatic' ? applicant.name : ''} readOnly aria-readonly="true" />
                  ) : <ChangeRequestPersonPicker
                    inputRef={setFieldRef('submitterName')}
                    name={draft.submitterName || ''}
                    value={draft.submitterId}
                    disabled={formDisabled}
                    error={errorsByField.get('submitterName')?.[0]?.message}
                    onChange={(name, id) => {
                      setDraft((current) => ({
                        ...current,
                        submitterName: name,
                        submitterId: id,
                      }));
                      clearFieldErrors('submitterName');
                      onDraftChange?.();
                    }}
                  />}
                  <FieldError
                    id="change-request-submitter-error"
                    message={errorsByField.get('submitterName')?.[0]?.message}
                  />
                </div>
                <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                  <SelectField
                    id="change-request-nature"
                    label="变更性质"
                    required
                    value={draft.nature}
                    options={CHANGE_REQUEST_NATURES}
                    placeholder="请选择变更性质"
                    error={errorsByField.get('nature')?.[0]?.message}
                    triggerRef={setFieldRef('nature')}
                    disabled={formDisabled}
                    onValueChange={(value) =>
                      updateNature(value as ChangeRequestNature | undefined)
                    }
                  />
                  {secondaryFieldsReady && (
                    <>
                      <SelectField
                        id="change-request-type"
                        label="变更类型"
                        required
                        value={draft.changeType}
                        options={CHANGE_REQUEST_TYPES}
                        placeholder="请选择变更类型"
                        error={errorsByField.get('changeType')?.[0]?.message}
                        triggerRef={setFieldRef('changeType')}
                        disabled={formDisabled}
                        onValueChange={(value) =>
                          updateDraft(
                            'changeType',
                            value as ChangeRequestDraft['changeType'],
                          )
                        }
                      />
                      <SelectField
                        id="change-request-work-type"
                        label="作业类型"
                        required
                        value={draft.workType}
                        options={CHANGE_REQUEST_WORK_TYPES}
                        placeholder="请选择作业类型"
                        error={errorsByField.get('workType')?.[0]?.message}
                        triggerRef={setFieldRef('workType')}
                        disabled={formDisabled}
                        onValueChange={(value) =>
                          updateDraft(
                            'workType',
                            value as ChangeRequestDraft['workType'],
                          )
                        }
                      />
                      <SelectField
                        id="change-request-discipline"
                        label="专业"
                        required
                        value={draft.discipline}
                        options={CHANGE_REQUEST_DISCIPLINES}
                        placeholder="请选择专业"
                        error={errorsByField.get('discipline')?.[0]?.message}
                        triggerRef={setFieldRef('discipline')}
                        disabled={formDisabled}
                        onValueChange={(value) =>
                          updateDraft(
                            'discipline',
                            value as ChangeRequestDraft['discipline'],
                          )
                        }
                      />
                      <SelectField
                        id="change-request-level"
                        label="变更等级（阿里）"
                        required
                        value={draft.level}
                        options={CHANGE_REQUEST_LEVELS}
                        placeholder="请选择变更等级"
                        error={errorsByField.get('level')?.[0]?.message}
                        triggerRef={setFieldRef('level')}
                        disabled={formDisabled}
                        onValueChange={(value) =>
                          updateDraft(
                            'level',
                            value as ChangeRequestDraft['level'],
                          )
                        }
                      />
                    </>
                  )}
                </div>

                {secondaryFieldsReady && (
                  <div className="space-y-2">
                    <Label id="change-request-buildings-label">
                      变更楼栋 <RequiredMark />
                    </Label>
                    <div
                      className="grid gap-2 sm:grid-cols-4 lg:grid-cols-7"
                      role="group"
                      aria-labelledby="change-request-buildings-label"
                      aria-invalid={Boolean(errorsByField.get('buildings'))}
                      aria-describedby={
                        errorsByField.has('buildings')
                          ? 'change-request-buildings-error'
                          : undefined
                      }
                    >
                      {CHANGE_REQUEST_BUILDINGS.map((building, index) => (
                        <label
                          key={building}
                          className="flex min-h-10 cursor-pointer items-center gap-2 rounded-md border bg-card px-3 text-sm transition-colors hover:border-primary/50 hover:bg-primary/5 has-data-[state=checked]:border-primary has-data-[state=checked]:bg-primary/5"
                        >
                          <Checkbox
                            ref={
                              index === 0 ? setFieldRef('buildings') : undefined
                            }
                            checked={draft.buildings.includes(building)}
                            disabled={formDisabled}
                            onCheckedChange={(checked) =>
                              toggleBuilding(building, checked === true)
                            }
                          />
                          {building}
                        </label>
                      ))}
                    </div>
                    <FieldError
                      id="change-request-buildings-error"
                      message={errorsByField.get('buildings')?.[0]?.message}
                    />
                  </div>
                )}
              </FormSection>

              {secondaryFieldsReady ? (
                <>
                  <FormSection icon={Clock3} title="时间安排">
                    <div className="grid gap-4 sm:grid-cols-2">
                      <InputField
                        id="change-request-planned-start"
                        label="计划开始日期（阿里）"
                        type="datetime-local"
                        required
                        value={draft.plannedStartAt}
                        disabled={formDisabled}
                        error={
                          errorsByField.get('plannedStartAt')?.[0]?.message
                        }
                        inputRef={setFieldRef('plannedStartAt')}
                        onChange={updatePlannedStartAt}
                      />
                      <InputField
                        id="change-request-planned-end"
                        label="计划结束日期（阿里）"
                        type="datetime-local"
                        required
                        value={draft.plannedEndAt}
                        min={draft.plannedStartAt || undefined}
                        disabled={formDisabled}
                        error={errorsByField.get('plannedEndAt')?.[0]?.message}
                        inputRef={setFieldRef('plannedEndAt')}
                        onChange={updatePlannedEndAt}
                      />
                      {draft.nature === '非标准变更' && (
                        <>
                          <InputField
                            id="change-request-meeting-start"
                            label="会议开始时间"
                            type="datetime-local"
                            required
                            value={draft.meetingStartAt}
                            disabled={formDisabled}
                            error={
                              errorsByField.get('meetingStartAt')?.[0]?.message
                            }
                            inputRef={setFieldRef('meetingStartAt')}
                            onChange={(value) =>
                              updateDraft('meetingStartAt', value)
                            }
                          />
                          <InputField
                            id="change-request-meeting-end"
                            label="会议结束时间"
                            type="datetime-local"
                            value={draft.meetingEndAt}
                            disabled={formDisabled}
                            error={
                              errorsByField.get('meetingEndAt')?.[0]?.message
                            }
                            inputRef={setFieldRef('meetingEndAt')}
                            onChange={(value) =>
                              updateDraft('meetingEndAt', value)
                            }
                          />
                        </>
                      )}
                    </div>
                  </FormSection>

                  <FormSection icon={ShieldAlert} title="内容与风险">
                    <TextField
                      id="change-request-summary"
                      label="变更简述"
                      hint="对应阿里变更通报内容"
                      required
                      maxLength={CHANGE_REQUEST_SUMMARY_MAX_LENGTH}
                      value={draft.summary}
                      disabled={formDisabled}
                      error={errorsByField.get('summary')?.[0]?.message}
                      textareaRef={setFieldRef('summary')}
                      onChange={(value) => updateDraft('summary', value)}
                    />
                    <TextField
                      id="change-request-risk"
                      label="变更重要风险点（简述）"
                      required
                      maxLength={CHANGE_REQUEST_RISK_SUMMARY_MAX_LENGTH}
                      value={draft.riskSummary}
                      disabled={formDisabled}
                      error={errorsByField.get('riskSummary')?.[0]?.message}
                      textareaRef={setFieldRef('riskSummary')}
                      onChange={(value) => updateDraft('riskSummary', value)}
                    />
                  </FormSection>

                  <FormSection icon={FileText} title="变更文档">
                    <div ref={setFieldRef('documents')} tabIndex={-1}>
                      <ChangeAttachmentField
                        id="change-request-documents"
                        title="上传变更文档"
                        help={`支持 PDF、Word、Excel 或图片；1-${CHANGE_REQUEST_MAX_DOCUMENT_COUNT} 个，单个不超过 200 MB。`}
                        accept=".pdf,.doc,.docx,.xls,.xlsx,.png,.jpg,.jpeg"
                        ownerMutationId={ownerMutationId}
                        items={attachmentItems}
                        setItems={setAttachmentItems}
                        minCount={1}
                        maxCount={CHANGE_REQUEST_MAX_DOCUMENT_COUNT}
                        maxSize={CHANGE_REQUEST_MAX_DOCUMENT_SIZE}
                        required
                        disabled={formDisabled}
                        error={errorsByField.get('documents')?.[0]?.message}
                        isAllowed={isAllowedChangeRequestDocument}
                        stageAttachment={stageChangeAttachment}
                        deleteAttachment={deleteChangeAttachment}
                        onChanged={() => {
                          clearFieldErrors('documents');
                          onDraftChange?.();
                        }}
                      />
                    </div>
                  </FormSection>
                </>
              ) : (
                <div
                  className="flex min-h-24 items-center justify-center gap-2 rounded-lg border bg-muted/25 text-sm text-muted-foreground"
                  role="status"
                  aria-live="polite"
                >
                  <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                  正在加载其余字段…
                </div>
              )}
            </div>
          </div>

          {(submissionStatus || serverError) && (
            <div className="shrink-0 space-y-2 px-5 pb-3 sm:px-6">
              {submissionStatus && (
                <Alert>
                  <AlertDescription role="status">
                    {submissionStatus}
                  </AlertDescription>
                </Alert>
              )}
              {serverError && (
                <Alert variant="destructive">
                  <AlertCircle aria-hidden="true" />
                  <AlertDescription>{serverError}</AlertDescription>
                </Alert>
              )}
            </div>
          )}
          <DialogFooter className="shrink-0 border-t bg-muted/30 px-5 py-3 sm:px-6">
            <Button
              type="button"
              variant="outline"
              disabled={submitting}
              onClick={() => handleOpenChange(false)}
            >
              取消
            </Button>
            <Button
              type="button"
              disabled={
                !secondaryFieldsReady ||
                access.isLoading || applicant.mode === 'login' || applicant.mode === 'error' ||
                submitting ||
                !attachmentsReady ||
                retryAction === 'manual-reconcile'
              }
              onClick={handleSubmit}
            >
              {submitting ? (
                <>
                  <Loader2 className="animate-spin" aria-hidden="true" />
                  正在提交
                </>
              ) : retryAction === 'manual-reconcile' ? (
                '提交结果待确认'
              ) : retryAction === 'retry-same-mutation' ? (
                '使用原申请标识重试'
              ) : attachmentRetryLocked ? (
                '重试附件同步'
              ) : (
                '提交变更申请'
              )}
            </Button>
          </DialogFooter>
        </>
      </DialogContent>
    </Dialog>
  );
}

function FormSection({
  icon: Icon,
  title,
  children,
}: {
  icon: LucideIcon;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-4 rounded-lg border bg-card p-4 shadow-sm">
      <h3 className="flex items-center gap-2 text-sm font-semibold">
        <span className="grid size-7 place-items-center rounded-md bg-primary/10 text-primary">
          <Icon className="size-4" aria-hidden="true" />
        </span>
        {title}
      </h3>
      {children}
    </section>
  );
}

function SelectField({
  id,
  label,
  value,
  options,
  placeholder,
  required,
  disabled,
  error,
  triggerRef,
  onValueChange,
}: {
  id: string;
  label: string;
  value?: string;
  options: readonly string[];
  placeholder: string;
  required?: boolean;
  disabled?: boolean;
  error?: string;
  triggerRef: (element: HTMLElement | null) => void;
  onValueChange: (value: string | undefined) => void;
}) {
  const errorId = `${id}-error`;
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>
        {label} {required && <RequiredMark />}
      </Label>
      <Select
        value={value || ''}
        disabled={disabled}
        onValueChange={(nextValue) => onValueChange(nextValue || undefined)}
      >
        <SelectTrigger
          ref={triggerRef}
          id={id}
          className="w-full"
          aria-required={required}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? errorId : undefined}
        >
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent align="start">
          {options.map((option) => (
            <SelectItem key={option} value={option}>
              {option}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <FieldError id={errorId} message={error} />
    </div>
  );
}

function InputField({
  id,
  label,
  type,
  required,
  value,
  min,
  disabled,
  error,
  inputRef,
  onChange,
}: {
  id: string;
  label: string;
  type: 'datetime-local';
  required?: boolean;
  value: string;
  min?: string;
  disabled?: boolean;
  error?: string;
  inputRef: (element: HTMLElement | null) => void;
  onChange: (value: string) => void;
}) {
  const errorId = `${id}-error`;
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>
        {label} {required && <RequiredMark />}
      </Label>
      <Input
        ref={inputRef}
        id={id}
        type={type}
        required={required}
        value={value}
        min={min}
        disabled={disabled}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? errorId : undefined}
        onChange={(event) => onChange(event.target.value)}
      />
      <FieldError id={errorId} message={error} />
    </div>
  );
}

function TextField({
  id,
  label,
  hint,
  required,
  maxLength,
  value,
  disabled,
  error,
  textareaRef,
  onChange,
}: {
  id: string;
  label: string;
  hint?: string;
  required?: boolean;
  maxLength: number;
  value: string;
  disabled?: boolean;
  error?: string;
  textareaRef: (element: HTMLElement | null) => void;
  onChange: (value: string) => void;
}) {
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;
  return (
    <div className="space-y-2">
      <div className="flex items-end justify-between gap-3">
        <span>
          <Label htmlFor={id}>
            {label} {required && <RequiredMark />}
          </Label>
          {hint && (
            <span
              id={hintId}
              className="mt-1 block text-xs text-muted-foreground"
            >
              {hint}
            </span>
          )}
        </span>
        <span className="text-xs tabular-nums text-muted-foreground">
          {Array.from(value).length}/{maxLength}
        </span>
      </div>
      <Textarea
        ref={textareaRef}
        id={id}
        required={required}
        maxLength={maxLength}
        value={value}
        disabled={disabled}
        className="min-h-24 resize-y"
        aria-invalid={Boolean(error)}
        aria-describedby={
          [hint ? hintId : '', error ? errorId : '']
            .filter(Boolean)
            .join(' ') || undefined
        }
        onChange={(event) => onChange(event.target.value)}
      />
      <FieldError id={errorId} message={error} />
    </div>
  );
}

function FieldError({
  id,
  message,
  className,
}: {
  id: string;
  message?: string;
  className?: string;
}) {
  if (!message) return null;
  return (
    <p
      id={id}
      role="alert"
      className={`text-sm text-destructive ${className || ''}`}
    >
      {message}
    </p>
  );
}

function RequiredMark() {
  return (
    <span className="text-destructive" aria-hidden="true">
      *
    </span>
  );
}

function cloneDraft(initialDraft?: ChangeRequestDraft): ChangeRequestDraft {
  const draft = initialDraft || createEmptyChangeRequestDraft();
  return {
    ...draft,
    buildings: [...draft.buildings],
    stagedDocuments: [...(draft.stagedDocuments || [])],
  };
}

function toValidationRequest(
  draft: ChangeRequestDraft,
): ChangeRequestCreateRequest {
  return {
    clientMutationId: VALIDATION_MUTATION_ID,
    ...draft,
  } as ChangeRequestCreateRequest;
}
