import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type InputHTMLAttributes,
} from 'react';
import {
  BriefcaseBusiness,
  Check,
  ChevronsUpDown,
  Eye,
  EyeOff,
  Sparkles,
  FileCheck2,
  GraduationCap,
  IdCard,
  Loader2,
  RefreshCw,
  Trash2,
  Upload,
  UserPlus,
} from 'lucide-react';
import { toast } from 'sonner';

import { createEmployeeOnboarding } from '@/api';
import AttachedBankAssessment from '@/pages/MbtiAssessment/AttachedBankAssessment';
import type { MbtiPreviewSelection } from '@/pages/MbtiAssessment';
import '@/pages/MbtiAssessment/styles.css';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
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
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  EMPLOYEE_ONBOARDING_COMPANIES,
  EMPLOYEE_ONBOARDING_EDUCATIONS,
  EMPLOYEE_ONBOARDING_HOBBIES,
  EMPLOYEE_ONBOARDING_PHOTO_FILE_RULE,
  EMPLOYEE_ONBOARDING_POSITIONS,
  type EmployeeOnboardingMbtiAssessment,
  type EmployeeOnboardingCreateResponse,
} from '@shared/employee-onboarding';
import { validateOnboardingMbtiAssessment } from '@shared/employee-onboarding-mbti';
import {
  createEmployeeOnboardingCoordinator,
  type EmployeeOnboardingCoordinator,
  type EmployeeOnboardingDraft,
  type EmployeeOnboardingResolution,
  type EmployeeOnboardingSubmissionSnapshot,
  type EmployeeOnboardingValidationErrors,
  type EmployeeOnboardingValidationField,
} from './employee-onboarding-state';

const PHOTO_FILE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp'] as const;
const PHOTO_ACCEPT = [
  ...PHOTO_FILE_EXTENSIONS,
  ...EMPLOYEE_ONBOARDING_PHOTO_FILE_RULE.mimeTypes,
].join(',');
const VALIDATION_ORDER: readonly EmployeeOnboardingValidationField[] = [
  'name',
  'companyName',
  'position',
  'identityNumber',
  'phone',
  'entryDate',
  'education',
  'graduateSchool',
  'major',
  'graduationDate',
  'hobbies',
  'vehiclePlate',
  'photo',
  'mbtiAssessment',
];

type DraftStatus = 'unsaved' | 'retained' | 'syncing' | 'retry' | 'confirmed';

type AttachmentStage = 'local' | 'syncing' | 'retry';

const DRAFT_STATUS_LABELS: Readonly<Record<DraftStatus, string>> = {
  unsaved: '未保存',
  retained: '已保留',
  syncing: '同步中',
  retry: '待重试',
  confirmed: '已确认',
};

const ATTACHMENT_STAGE_LABELS: Readonly<Record<AttachmentStage, string>> = {
  local: '本地待提交',
  syncing: '同步中',
  retry: '待重试',
};

const PENDING_LEDGER_REFILL_MESSAGE =
  '结果待确认，字段/附件未保存，请重新填写同一内容和重新选附件后安全重试';

export type EmployeeOnboardingSubmissionState =
  | { status: 'ready' | 'syncing' }
  | {
      status: 'confirmed';
      result: EmployeeOnboardingCreateResponse;
      cleanupWarning?: boolean;
    };

export interface NewEmployeeOnboardingDialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  onSubmissionStateChange?(state: EmployeeOnboardingSubmissionState): void;
}

export function NewEmployeeOnboardingDialog({
  open,
  onOpenChange,
  onSubmissionStateChange,
}: NewEmployeeOnboardingDialogProps) {
  const coordinatorRef = useRef<EmployeeOnboardingCoordinator | null>(null);
  if (coordinatorRef.current === null) {
    coordinatorRef.current = createEmployeeOnboardingCoordinator();
  }
  const coordinator = coordinatorRef.current;
  const [draft, setDraft] = useState<EmployeeOnboardingDraft>(() =>
    createInitialDraft(),
  );
  const [photo, setPhoto] = useState<File | null>(null);
  const [mbtiVersion, setMbtiVersion] = useState<'short' | 'full'>('short');
  const [quizSelection, setQuizSelection] = useState<MbtiPreviewSelection | null>(null);
  const quizDraftIdRef = useRef(crypto.randomUUID());
  const [errors, setErrors] = useState<EmployeeOnboardingValidationErrors>({});
  const [submitting, setSubmitting] = useState(false);
  const [confirmedCleanupError, setConfirmedCleanupError] = useState(false);
  const [conflictBlocked, setConflictBlocked] = useState(
    () => coordinator.getLedger()?.stage === 'conflict',
  );
  const [identityNumberVisible, setIdentityNumberVisible] = useState(false);
  const [pendingLedgerWithoutSnapshot, setPendingLedgerWithoutSnapshot] =
    useState(() => hasPendingLedgerWithoutSnapshot(coordinator));
  const [draftStatus, setDraftStatus] = useState<DraftStatus>(() =>
    hasPendingLedgerWithoutSnapshot(coordinator) ? 'retry' : 'unsaved',
  );
  const photoInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const pending = hasPendingLedgerWithoutSnapshot(coordinator);
    setPendingLedgerWithoutSnapshot(pending);
    if (pending) setDraftStatus('retry');
    if (coordinator.getLedger()?.stage === 'conflict') {
      setConflictBlocked(true);
    }
  }, [coordinator, open]);

  const clearFieldError = useCallback(
    (field: EmployeeOnboardingValidationField) => {
      setErrors((current) => {
        if (!current[field]) return current;
        const next = { ...current };
        delete next[field];
        return next;
      });
    },
    [],
  );

  const markDraftEdited = useCallback(() => {
    setDraftStatus(pendingLedgerWithoutSnapshot ? 'retry' : 'unsaved');
  }, [pendingLedgerWithoutSnapshot]);

  const updateDraft = useCallback(
    <Field extends keyof EmployeeOnboardingDraft>(
      field: Field,
      value: EmployeeOnboardingDraft[Field],
    ) => {
      if (field === 'name') quizDraftIdRef.current = crypto.randomUUID();
      setDraft((current) => ({
        ...current,
        [field]: value,
        ...(field === 'name' && current.name.trim() !== String(value).trim()
          ? { mbtiAssessment: null }
          : {}),
      }));
      clearFieldError(field);
      markDraftEdited();
    },
    [clearFieldError, markDraftEdited],
  );

  const restoreRecovery = useCallback(
    (recovery: EmployeeOnboardingSubmissionSnapshot) => {
      setDraft({
        ...recovery.values,
        hobbies: [...recovery.values.hobbies],
        vehiclePlate: recovery.values.vehiclePlate ?? '',
      });
      setPhoto(recovery.photo);
      setMbtiVersion(recovery.values.mbtiAssessment.version);
      setErrors({});
      setIdentityNumberVisible(false);
      setPendingLedgerWithoutSnapshot(false);
      setDraftStatus('retry');
    },
    [],
  );

  const clearFormMemory = useCallback(() => {
    setDraft(createInitialDraft());
    setMbtiVersion('short');
    quizDraftIdRef.current = crypto.randomUUID();
    setQuizSelection(null);
    setPhoto(null);
    setErrors({});
    setIdentityNumberVisible(false);
    if (photoInputRef.current) photoInputRef.current.value = '';
  }, []);

  const resetForm = useCallback(() => {
    clearFormMemory();
    setConfirmedCleanupError(false);
    setConflictBlocked(false);
    setPendingLedgerWithoutSnapshot(false);
    setDraftStatus('unsaved');
  }, [clearFormMemory]);

  const startMbtiAssessment = useCallback(() => {
    const name = draft.name.trim();
    if (!name) {
      setErrors((current) => ({ ...current, name: '请先填写姓名' }));
      document.getElementById('employee-onboarding-name')?.focus();
      return;
    }
    if (draft.mbtiAssessment) quizDraftIdRef.current = crypto.randomUUID();
    setQuizSelection({ audience: 'new', name, version: mbtiVersion, draftId: quizDraftIdRef.current });
    onOpenChange(false);
  }, [draft.name, draft.mbtiAssessment, mbtiVersion, onOpenChange]);

  const useMbtiResult = useCallback((assessment: EmployeeOnboardingMbtiAssessment) => {
    setDraft((current) => ({ ...current, mbtiAssessment: assessment }));
    clearFieldError('mbtiAssessment');
    markDraftEdited();
    setQuizSelection(null);
    onOpenChange(true);
  }, [clearFieldError, markDraftEdited, onOpenChange]);

  const handleDialogOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen) setIdentityNumberVisible(false);
      if (
        !nextOpen &&
        !submitting &&
        !confirmedCleanupError &&
        draftStatus !== 'retry'
      ) {
        if (hasMeaningfulDraft(draft, photo)) {
          setDraftStatus('retained');
        } else {
          setDraftStatus('unsaved');
        }
      }
      onOpenChange(nextOpen);
    },
    [
      confirmedCleanupError,
      draft,
      draftStatus,
      onOpenChange,
      photo,
      submitting,
    ],
  );

  const focusFirstInvalid = useCallback(
    (validationErrors: EmployeeOnboardingValidationErrors) => {
      const firstInvalid = VALIDATION_ORDER.find(
        (field) => validationErrors[field],
      );
      if (!firstInvalid) return;
      window.requestAnimationFrame(() => {
        document
          .querySelector<HTMLElement>(
            `[data-onboarding-field="${firstInvalid}"]`,
          )
          ?.focus();
      });
    },
    [],
  );

  const recoverAndReopen = useCallback(
    (
      resolution: Exclude<
        EmployeeOnboardingResolution,
        { status: 'stale' } | { status: 'confirmed' }
      >,
      message: string,
    ) => {
      restoreRecovery(resolution.recovery);
      setSubmitting(false);
      onSubmissionStateChange?.({ status: 'ready' });
      onOpenChange(true);
      toast.error(message);
    },
    [onOpenChange, onSubmissionStateChange, restoreRecovery],
  );

  const handleAbandonConflict = useCallback(() => {
    const result = coordinator.abandonConflict();
    if (result.status !== 'cleared') {
      toast.error('冲突状态已变化或本地状态不可用，未解除提交阻断');
      return;
    }
    setConflictBlocked(false);
    setPendingLedgerWithoutSnapshot(false);
    setDraftStatus(
      hasMeaningfulDraft(draft, photo) ? 'retained' : 'unsaved',
    );
    toast.success('冲突阻断已解除；下次提交将使用新的提交标识');
  }, [coordinator, draft, photo]);

  const handleSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (confirmedCleanupError) {
        toast.error('记录已写入，请勿重复提交');
        return;
      }

      const begin = coordinator.begin(draft, { photo });
      if (begin.status === 'validation') {
        setErrors(begin.errors);
        focusFirstInvalid(begin.errors);
        return;
      }
      if (begin.status === 'storage-error') {
        toast.error('本地提交状态不可用，未发送请求，请刷新页面后重试');
        return;
      }
      if (begin.status === 'duplicate') {
        setSubmitting(true);
        setDraftStatus('syncing');
        toast.info('当前新员工入职信息正在同步，请勿重复提交');
        return;
      }
      if (begin.status === 'blocked-conflict') {
        if (begin.recovery) restoreRecovery(begin.recovery);
        setConflictBlocked(true);
        setPendingLedgerWithoutSnapshot(!begin.recovery);
        setDraftStatus('retry');
        toast.error(
          '检测到提交标识冲突，系统已阻止重复提交；请先核对员工信息池中的上次记录',
        );
        return;
      }
      if (begin.status === 'blocked-unknown-change') {
        if (begin.recovery) {
          restoreRecovery(begin.recovery);
          toast.error('上次提交结果暂未确认，请保持恢复内容直接重试');
        } else {
          setPendingLedgerWithoutSnapshot(true);
          setDraftStatus('retry');
          toast.error(PENDING_LEDGER_REFILL_MESSAGE);
        }
        return;
      }

      setErrors({});
      setSubmitting(true);
      setPendingLedgerWithoutSnapshot(false);
      setDraftStatus('syncing');
      setIdentityNumberVisible(false);
      onOpenChange(false);
      onSubmissionStateChange?.({ status: 'syncing' });
      toast.info('新员工入职信息已受理，正在后台同步');

      void createEmployeeOnboarding(
        begin.request,
        begin.snapshot.photo,
      )
        .then((response) => {
          const resolution = coordinator.resolveSuccess(begin.token, response);
          if (resolution.status === 'stale') return;
          if (resolution.status === 'confirmed') {
            setSubmitting(false);
            resetForm();
            onSubmissionStateChange?.({ status: 'confirmed', result: response });
            toast.success('新员工入职信息及 MBTI 结果已同步至员工信息池');
            return;
          }
          if (
            resolution.status === 'storage-error' &&
            resolution.confirmedResponse
          ) {
            setSubmitting(false);
            clearFormMemory();
            coordinatorRef.current = createEmployeeOnboardingCoordinator({
              storage: null,
            });
            setConfirmedCleanupError(true);
            setPendingLedgerWithoutSnapshot(false);
            setDraftStatus('confirmed');
            onSubmissionStateChange?.({
              status: 'confirmed',
              result: resolution.confirmedResponse,
              cleanupWarning: true,
            });
            onOpenChange(false);
            toast.error('记录已写入，但本地状态未清理，请勿重复提交');
            return;
          }

          recoverAndReopen(resolution, '结果暂未确认，请保持原内容直接重试');
        })
        .catch((reason: unknown) => {
          const resolution = coordinator.resolveFailure(begin.token, reason);
          if (resolution.status === 'stale') return;
          if (resolution.status === 'confirmed') return;
          if (resolution.status === 'conflict') setConflictBlocked(true);
          recoverAndReopen(
            resolution,
            employeeOnboardingFailureMessage(reason, resolution.status),
          );
        });
    },
    [
      clearFormMemory,
      confirmedCleanupError,
      coordinator,
      draft,
      focusFirstInvalid,
      onOpenChange,
      onSubmissionStateChange,
      photo,
      recoverAndReopen,
      resetForm,
      restoreRecovery,
    ],
  );

  const formDisabled = submitting || confirmedCleanupError;
  const attachmentStage: AttachmentStage =
    draftStatus === 'syncing'
      ? 'syncing'
      : draftStatus === 'retry'
        ? 'retry'
        : 'local';

  const completedMbti = validateOnboardingMbtiAssessment(draft.mbtiAssessment, draft.name);

  return (<>
    <Dialog open={open} onOpenChange={handleDialogOpenChange}>
      <DialogContent
        className="flex max-h-[90dvh] w-[calc(100vw-2rem)] max-w-4xl flex-col gap-0 overflow-hidden p-0"
        showCloseButton={!submitting}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          document.getElementById('employee-onboarding-name')?.focus();
        }}
      >
        <DialogHeader className="shrink-0 border-b border-border px-5 py-5 pr-14 sm:px-6">
          <div className="flex items-start gap-3 text-left">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <UserPlus className="size-5" aria-hidden="true" />
            </span>
            <span className="space-y-1">
              <span className="flex flex-wrap items-center gap-2">
                <DialogTitle>新员工入职</DialogTitle>
                <DraftStatusBadge status={draftStatus} />
              </span>
              <DialogDescription>
                填写基础资料，提交后同步至员工信息池
              </DialogDescription>
            </span>
          </div>
        </DialogHeader>

        <form className="contents" noValidate onSubmit={handleSubmit}>
          <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-5 py-5 sm:px-6">
            {submitting ? (
              <div
                className="mb-5 flex items-center gap-2 rounded-lg border border-primary/20 bg-primary/5 px-4 py-3 text-sm text-foreground"
                role="status"
                aria-live="polite"
              >
                <Loader2
                  className="size-4 animate-spin text-primary"
                  aria-hidden="true"
                />
                正在后台同步，当前内容暂不可修改
              </div>
            ) : null}
            {pendingLedgerWithoutSnapshot ? (
              <div
                className="mb-5 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive"
                role="alert"
              >
                {PENDING_LEDGER_REFILL_MESSAGE}
              </div>
            ) : null}
            {conflictBlocked ? (
              <div
                className="mb-5 flex flex-col gap-3 rounded-lg border border-warning/50 bg-warning px-4 py-3 text-sm text-warning-foreground sm:flex-row sm:items-center sm:justify-between"
                role="alert"
              >
                <div className="space-y-1">
                  <p className="font-medium">已阻止重复提交</p>
                  <p className="text-warning-foreground/90">
                    请先在员工信息池核对上次记录；仅确认当前员工尚未创建后，才能解除阻断。
                  </p>
                </div>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="shrink-0 bg-card text-foreground"
                    >
                      核对后解除阻断
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent className="max-w-md">
                    <AlertDialogHeader>
                      <AlertDialogTitle>确认员工尚未创建？</AlertDialogTitle>
                      <AlertDialogDescription>
                        解除后，下一次提交将使用新的提交标识并可能新增一条员工记录。若员工信息池已存在该员工，请取消并联系管理员核对。
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel type="button">取消</AlertDialogCancel>
                      <AlertDialogAction
                        type="button"
                        onClick={handleAbandonConflict}
                      >
                        确认未创建，解除阻断
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            ) : null}
            {confirmedCleanupError ? (
              <div
                className="mb-5 flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive"
                role="alert"
              >
                <FileCheck2 className="size-4" aria-hidden="true" />
                记录已写入，但本地状态未清理，请勿重复提交
              </div>
            ) : null}

            <fieldset disabled={formDisabled} className="space-y-7">
              <FormSection
                title="任职信息"
                icon={<BriefcaseBusiness className="size-4" />}
              >
                <TextField
                  id="employee-onboarding-name"
                  field="name"
                  label="姓名"
                  value={draft.name}
                  error={errors.name}
                  required
                  autoComplete="name"
                  onChange={(value) => updateDraft('name', value)}
                />
                <SearchableSelectField
                  id="employee-onboarding-company-name"
                  field="companyName"
                  label="公司名称"
                  value={draft.companyName}
                  placeholder="请选择公司名称"
                  options={EMPLOYEE_ONBOARDING_COMPANIES}
                  error={errors.companyName}
                  required
                  onChange={(value) => updateDraft('companyName', value)}
                />
                <SearchableSelectField
                  id="employee-onboarding-position"
                  field="position"
                  label="岗位"
                  value={draft.position}
                  placeholder="请选择岗位"
                  options={EMPLOYEE_ONBOARDING_POSITIONS}
                  error={errors.position}
                  required
                  onChange={(value) => updateDraft('position', value)}
                />
              </FormSection>

              <FormSection
                title="身份与入职"
                icon={<IdCard className="size-4" />}
              >
                <div className="space-y-2">
                  <Label htmlFor="employee-onboarding-identity-number">
                    身份证号 <RequiredMark />
                  </Label>
                  <div className="relative">
                    <Input
                      id="employee-onboarding-identity-number"
                      data-onboarding-field="identityNumber"
                      className="h-11 pr-12"
                      type={identityNumberVisible ? 'text' : 'password'}
                      value={draft.identityNumber}
                      required
                      autoComplete="off"
                      aria-invalid={Boolean(errors.identityNumber)}
                      aria-describedby={
                        errors.identityNumber
                          ? 'employee-onboarding-identity-number-error'
                          : undefined
                      }
                      onChange={(event) =>
                        updateDraft('identityNumber', event.currentTarget.value)
                      }
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="absolute top-1/2 right-1 -translate-y-1/2"
                      aria-label={
                        identityNumberVisible ? '隐藏身份证号' : '显示身份证号'
                      }
                      aria-pressed={identityNumberVisible}
                      onClick={() =>
                        setIdentityNumberVisible((visible) => !visible)
                      }
                    >
                      {identityNumberVisible ? (
                        <EyeOff aria-hidden="true" />
                      ) : (
                        <Eye aria-hidden="true" />
                      )}
                    </Button>
                  </div>
                  <FieldError
                    id="employee-onboarding-identity-number-error"
                    message={errors.identityNumber}
                  />
                </div>
                <TextField
                  id="employee-onboarding-phone"
                  field="phone"
                  label="联系方式"
                  value={draft.phone}
                  error={errors.phone}
                  required
                  type="tel"
                  inputMode="tel"
                  autoComplete="tel"
                  onChange={(value) => updateDraft('phone', value)}
                />
                <TextField
                  id="employee-onboarding-entry-date"
                  field="entryDate"
                  label="入职日期"
                  value={draft.entryDate}
                  error={errors.entryDate}
                  required
                  type="date"
                  onChange={(value) => updateDraft('entryDate', value)}
                />
                <TextField
                  id="employee-onboarding-vehicle-plate"
                  field="vehiclePlate"
                  label="车牌号"
                  optional
                  value={draft.vehiclePlate ?? ''}
                  error={errors.vehiclePlate}
                  placeholder="选填"
                  onChange={(value) => updateDraft('vehiclePlate', value)}
                />
              </FormSection>

              <FormSection
                title="教育与兴趣"
                icon={<GraduationCap className="size-4" />}
              >
                <SelectField
                  id="employee-onboarding-education"
                  field="education"
                  label="学历"
                  value={draft.education}
                  placeholder="请选择学历"
                  options={EMPLOYEE_ONBOARDING_EDUCATIONS}
                  error={errors.education}
                  required
                  onChange={(value) => updateDraft('education', value)}
                />
                <TextField
                  id="employee-onboarding-graduate-school"
                  field="graduateSchool"
                  label="毕业院校"
                  value={draft.graduateSchool}
                  error={errors.graduateSchool}
                  required
                  onChange={(value) => updateDraft('graduateSchool', value)}
                />
                <TextField
                  id="employee-onboarding-major"
                  field="major"
                  label="所学专业"
                  value={draft.major}
                  error={errors.major}
                  required
                  onChange={(value) => updateDraft('major', value)}
                />
                <TextField
                  id="employee-onboarding-graduation-date"
                  field="graduationDate"
                  label="毕业日期"
                  value={draft.graduationDate}
                  error={errors.graduationDate}
                  required
                  type="date"
                  onChange={(value) => updateDraft('graduationDate', value)}
                />

                <div className="space-y-2 md:col-span-2">
                  <Label
                    id="employee-onboarding-hobbies-label"
                    htmlFor="employee-onboarding-hobby-0"
                  >
                    兴趣爱好 <RequiredMark />
                  </Label>
                  <div
                    className="flex flex-wrap gap-2"
                    role="group"
                    aria-labelledby="employee-onboarding-hobbies-label"
                    aria-describedby={
                      errors.hobbies
                        ? 'employee-onboarding-hobbies-error'
                        : undefined
                    }
                    aria-invalid={Boolean(errors.hobbies)}
                    aria-required="true"
                  >
                    {EMPLOYEE_ONBOARDING_HOBBIES.map((hobby, index) => {
                      const checked = draft.hobbies.includes(hobby);
                      const id = `employee-onboarding-hobby-${index}`;
                      return (
                        <Label
                          key={hobby}
                          htmlFor={id}
                          className="flex min-h-11 cursor-pointer items-center gap-2 rounded-full border border-border bg-background px-3 py-2 text-sm transition-colors hover:bg-muted has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-primary/5"
                        >
                          <Checkbox
                            id={id}
                            data-onboarding-field={
                              index === 0 ? 'hobbies' : undefined
                            }
                            checked={checked}
                            aria-invalid={Boolean(errors.hobbies)}
                            onCheckedChange={(nextChecked) => {
                              updateDraft(
                                'hobbies',
                                nextChecked === true
                                  ? [...draft.hobbies, hobby]
                                  : draft.hobbies.filter(
                                      (selected) => selected !== hobby,
                                    ),
                              );
                            }}
                          />
                          {hobby}
                        </Label>
                      );
                    })}
                  </div>
                  <FieldError
                    id="employee-onboarding-hobbies-error"
                    message={errors.hobbies}
                  />
                </div>
              </FormSection>

              <FormSection title="MBTI 测试" icon={<Sparkles className="size-4" />}>
                <div className="space-y-3 md:col-span-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <Label>16 型人格测试 <RequiredMark /></Label>
                    {completedMbti && <span className="rounded-full bg-emerald-50 px-3 py-1 text-sm font-semibold text-emerald-700">已完成 · {completedMbti.type}</span>}
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2" role="group" aria-label="选择测试版本">
                    {(['short', 'full'] as const).map((version) => <button key={version} type="button" aria-pressed={mbtiVersion === version} onClick={() => setMbtiVersion(version)} className={`rounded-lg border px-4 py-3 text-left transition-colors ${mbtiVersion === version ? 'border-primary bg-primary/5 text-primary' : 'border-border bg-card text-foreground hover:border-primary/50'}`}><strong className="block text-base">{version === 'short' ? '轻量版 · 60 题' : '完整版 · 93 题'}</strong><span className="text-sm text-muted-foreground">{version === 'short' ? '约 10 分钟' : '约 15 分钟'}</span></button>)}
                  </div>
                  <Button type="button" variant={completedMbti ? 'outline' : 'default'} data-onboarding-field="mbtiAssessment" aria-invalid={Boolean(errors.mbtiAssessment)} aria-describedby={errors.mbtiAssessment ? 'employee-onboarding-mbti-error' : undefined} onClick={startMbtiAssessment} className="h-11">{completedMbti ? '重新测试' : '开始 MBTI 测试'}</Button>
                  <FieldError id="employee-onboarding-mbti-error" message={errors.mbtiAssessment} />
                </div>
              </FormSection>

              <FormSection title="证件照" icon={<IdCard className="size-4" />}>
                <div className="space-y-3 md:col-span-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <Label htmlFor="employee-onboarding-photo">
                      证件照 <RequiredMark />
                    </Label>
                    <AttachmentStageBadge
                      label="证件照"
                      stage={attachmentStage}
                    />
                  </div>
                  <div className="grid gap-3 rounded-xl border border-blue-100 bg-blue-50/40 p-3 sm:grid-cols-[104px_minmax(0,1fr)] sm:items-center">
                    <img
                      src="/assets/employee-onboarding-blue-id-photo-example.jpg"
                      alt="蓝底半身照示例"
                      className="h-32 w-24 rounded-lg border border-blue-100 bg-blue-100 object-cover object-top shadow-sm"
                    />
                    <div className="min-w-0 space-y-1.5">
                      <p className="text-sm font-semibold text-slate-800">
                        蓝底半身照示例
                      </p>
                      <p className="text-sm leading-5 text-slate-600">
                        请上传正面、清晰、蓝色纯背景的半身证件照，头像和肩部需完整可见。
                      </p>
                      <p className="text-xs text-slate-500">
                        支持 PNG、JPG、JPEG、WEBP，必传 1 张，单张不超过 10 MiB。
                      </p>
                    </div>
                  </div>
                  <Input
                    ref={photoInputRef}
                    id="employee-onboarding-photo"
                    className="sr-only !h-px !w-px !border-0 !p-0"
                    type="file"
                    required
                    accept={PHOTO_ACCEPT}
                    aria-invalid={Boolean(errors.photo)}
                    aria-describedby={
                      errors.photo
                        ? 'employee-onboarding-photo-error'
                        : undefined
                    }
                    onClick={(event) => {
                      event.currentTarget.value = '';
                    }}
                    onChange={(event) => {
                      const selected = event.currentTarget.files?.[0] ?? null;
                      setPhoto(selected);
                      clearFieldError('photo');
                      markDraftEdited();
                    }}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    className="h-11 w-full justify-center sm:w-auto"
                    data-onboarding-field="photo"
                    aria-invalid={Boolean(errors.photo)}
                    aria-describedby={
                      errors.photo
                        ? 'employee-onboarding-photo-error'
                        : undefined
                    }
                    onClick={() => photoInputRef.current?.click()}
                  >
                    {photo ? (
                      <RefreshCw aria-hidden="true" />
                    ) : (
                      <Upload aria-hidden="true" />
                    )}
                    {photo ? '替换证件照' : '选择证件照'}
                  </Button>
                  {photo ? (
                    <SelectedFileRow
                      file={photo}
                      onRemove={() => {
                        setPhoto(null);
                        if (photoInputRef.current) {
                          photoInputRef.current.value = '';
                        }
                        clearFieldError('photo');
                        markDraftEdited();
                      }}
                    />
                  ) : null}
                  <FieldError
                    id="employee-onboarding-photo-error"
                    message={errors.photo}
                  />
                </div>
              </FormSection>
            </fieldset>
          </div>

          <DialogFooter className="shrink-0 border-t border-border bg-background px-5 py-4 sm:px-6">
            <Button
              type="button"
              variant="outline"
              disabled={submitting}
              onClick={() => handleDialogOpenChange(false)}
            >
              取消
            </Button>
            {!completedMbti && <span className="text-sm text-muted-foreground">请先完成 MBTI 测试</span>}
            <Button type="submit" disabled={formDisabled || !completedMbti}>
              {submitting ? (
                <Loader2 className="animate-spin" aria-hidden="true" />
              ) : (
                <UserPlus aria-hidden="true" />
              )}
              {submitting ? '后台同步中' : '提交入职信息'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
    {quizSelection && <div className="fixed inset-0 z-[100] overflow-y-auto bg-background" role="region" aria-label="新员工 MBTI 测试"><AttachedBankAssessment key={`${quizSelection.draftId}:${quizSelection.version}`} selection={quizSelection} onExit={() => { setQuizSelection(null); onOpenChange(true); }} onUseResult={useMbtiResult} /></div>}
    </>
  );
}

interface FormSectionProps {
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}

function FormSection({ title, icon, children }: FormSectionProps) {
  return (
    <section className="space-y-4 border-b border-border/70 pb-7 last:border-b-0 last:pb-0">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
        <span className="text-primary" aria-hidden="true">
          {icon}
        </span>
        {title}
      </h3>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">{children}</div>
    </section>
  );
}

interface TextFieldProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'id' | 'value' | 'onChange'
> {
  id: string;
  field: EmployeeOnboardingValidationField;
  label: string;
  value: string;
  error?: string;
  optional?: boolean;
  onChange(value: string): void;
}

function TextField({
  id,
  field,
  label,
  value,
  error,
  optional,
  required,
  onChange,
  ...inputProps
}: TextFieldProps) {
  const errorId = `${id}-error`;
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>
        {label}
        {required ? <RequiredMark /> : null}
        {optional ? (
          <span className="ml-1 text-xs font-normal text-muted-foreground">
            （选填）
          </span>
        ) : null}
      </Label>
      <Input
        {...inputProps}
        id={id}
        data-onboarding-field={field}
        className="h-11"
        value={value}
        required={required}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? errorId : undefined}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
      <FieldError id={errorId} message={error} />
    </div>
  );
}

interface SelectFieldProps {
  id: string;
  field: EmployeeOnboardingValidationField;
  label: string;
  value: string;
  placeholder: string;
  options: readonly string[];
  error?: string;
  required?: boolean;
  onChange(value: string): void;
}

function SelectField({
  id,
  field,
  label,
  value,
  placeholder,
  options,
  error,
  required,
  onChange,
}: SelectFieldProps) {
  const errorId = `${id}-error`;
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>
        {label}
        {required ? <RequiredMark /> : null}
      </Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger
          id={id}
          className="h-11 w-full"
          data-onboarding-field={field}
          aria-invalid={Boolean(error)}
          aria-required={required}
          aria-describedby={error ? errorId : undefined}
        >
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
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

interface SearchableSelectFieldProps {
  id: string;
  field: EmployeeOnboardingValidationField;
  label: string;
  value: string;
  placeholder: string;
  options: readonly string[];
  error?: string;
  required?: boolean;
  onChange(value: string): void;
}

function SearchableSelectField({
  id,
  field,
  label,
  value,
  placeholder,
  options,
  error,
  required,
  onChange,
}: SearchableSelectFieldProps) {
  const [open, setOpen] = useState(false);
  const errorId = `${id}-error`;
  const listboxId = `${id}-options`;

  return (
    <div className="space-y-2">
      <Label htmlFor={id}>
        {label}
        {required ? <RequiredMark /> : null}
      </Label>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            id={id}
            type="button"
            variant="outline"
            className="h-11 w-full justify-between px-3 font-normal"
            data-onboarding-field={field}
            role="combobox"
            aria-haspopup="listbox"
            aria-expanded={open}
            aria-controls={listboxId}
            aria-required={required}
            aria-invalid={Boolean(error)}
            aria-describedby={error ? errorId : undefined}
          >
            <span
              className={value ? 'truncate' : 'truncate text-muted-foreground'}
            >
              {value || placeholder}
            </span>
            <ChevronsUpDown
              className="size-4 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          className="z-[60] w-[var(--radix-popover-trigger-width)] p-0"
          align="start"
        >
          <Command>
            <CommandInput
              placeholder={`搜索${label}`}
              aria-label={`搜索${label}`}
            />
            <CommandList id={listboxId} role="listbox">
              <CommandEmpty>未找到匹配项</CommandEmpty>
              {options.map((option) => (
                <CommandItem
                  key={option}
                  value={option}
                  role="option"
                  aria-selected={option === value}
                  onSelect={() => {
                    onChange(option);
                    setOpen(false);
                  }}
                >
                  <Check
                    className={`size-4 ${option === value ? 'opacity-100' : 'opacity-0'}`}
                    aria-hidden="true"
                  />
                  {option}
                </CommandItem>
              ))}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      <FieldError id={errorId} message={error} />
    </div>
  );
}

function DraftStatusBadge({ status }: { status: DraftStatus }) {
  return (
    <span
      className={
        status === 'retry'
          ? 'rounded-full bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive'
          : status === 'syncing'
            ? 'rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary'
            : 'rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground'
      }
      role="status"
      aria-live="polite"
    >
      {DRAFT_STATUS_LABELS[status]}
    </span>
  );
}

function AttachmentStageBadge({
  label,
  stage,
}: {
  label: string;
  stage: AttachmentStage;
}) {
  return (
    <span
      className={
        stage === 'retry'
          ? 'rounded-full bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive'
          : stage === 'syncing'
            ? 'rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary'
            : 'rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground'
      }
      role="status"
      aria-label={`${label}：${ATTACHMENT_STAGE_LABELS[stage]}`}
    >
      {label}：{ATTACHMENT_STAGE_LABELS[stage]}
    </span>
  );
}

function RequiredMark() {
  return (
    <>
      <span className="ml-1 text-destructive" aria-hidden="true">
        *
      </span>
      <span className="sr-only">（必填）</span>
    </>
  );
}

function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <p id={id} className="text-sm text-destructive" role="alert">
      {message}
    </p>
  );
}

function SelectedFileRow({ file, onRemove }: { file: File; onRemove(): void }) {
  return (
    <div className="flex min-w-0 items-center gap-3 rounded-lg border border-border bg-muted/40 px-3 py-2">
      <LocalFilePreview file={file} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-foreground">
          {file.name}
        </span>
        <span className="block text-xs text-muted-foreground">
          {formatFileSize(file.size)} · {file.type || '未知类型'}
        </span>
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="shrink-0"
        aria-label={`移除 ${file.name}`}
        onClick={onRemove}
      >
        <Trash2 aria-hidden="true" />
      </Button>
    </div>
  );
}

function LocalFilePreview({ file }: { file: File }) {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  useEffect(() => {
    setPreviewUrl(null);
    if (!file.type.startsWith('image/')) return undefined;
    const objectUrl = URL.createObjectURL(file);
    setPreviewUrl(objectUrl);
    return () => {
      URL.revokeObjectURL(objectUrl);
    };
  }, [file]);

  if (!previewUrl) {
    return (
      <span className="flex size-12 shrink-0 items-center justify-center rounded-md border border-border bg-background text-primary">
        <FileCheck2 className="size-5" aria-hidden="true" />
      </span>
    );
  }

  return (
    <img
      src={previewUrl}
      alt={`${file.name} 本地预览`}
      className="size-12 shrink-0 rounded-md border border-border object-cover"
    />
  );
}

function hasPendingLedgerWithoutSnapshot(
  coordinator: EmployeeOnboardingCoordinator,
): boolean {
  const ledger = coordinator.getLedger();
  return (
    ledger !== null &&
    coordinator.getRecovery() === null &&
    (ledger.stage === 'in-flight' || ledger.stage === 'unknown-result')
  );
}

function createInitialDraft(): EmployeeOnboardingDraft {
  return {
    name: '',
    companyName: '南通承宏云计算有限公司',
    position: '',
    identityNumber: '',
    phone: '',
    entryDate: '',
    education: '',
    graduateSchool: '',
    major: '',
    graduationDate: '',
    hobbies: [],
    vehiclePlate: '',
    mbtiAssessment: null,
  };
}

function hasMeaningfulDraft(
  draft: EmployeeOnboardingDraft,
  photo: File | null,
): boolean {
  return (
    draft.companyName !== '南通承宏云计算有限公司' ||
    Boolean(
      draft.name.trim() ||
      draft.position ||
      draft.identityNumber.trim() ||
      draft.phone.trim() ||
      draft.entryDate ||
      draft.education ||
      draft.graduateSchool.trim() ||
      draft.major.trim() ||
      draft.graduationDate ||
      draft.hobbies.length > 0 ||
      draft.vehiclePlate?.trim() ||
      draft.mbtiAssessment ||
          photo,
    )
  );
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function employeeOnboardingFailureMessage(
  reason: unknown,
  resolutionStatus: EmployeeOnboardingResolution['status'],
): string {
  if (resolutionStatus === 'storage-error') {
    return '本地恢复状态保存失败，已恢复当前内容，请勿关闭页面并稍后重试';
  }

  const status = readResponseStatus(reason);
  if (status === 401) {
    return '提交凭证已失效，请稍后使用已恢复内容重试';
  }
  if (status === 403) {
    return '当前提交未获授权，请保留已恢复内容并联系管理员';
  }
  if (status === 409) {
    return '检测到提交标识冲突，系统已阻止重复提交；请先核对员工信息池中的上次记录';
  }
  if (status === 429) {
    return '提交过于频繁，请稍后使用已恢复内容重试';
  }
  if (status === 413) {
    return '附件大小不符合要求，请调整已恢复的附件后重试';
  }
  if (status === 400 || status === 422) {
    return '提交内容不符合要求，请核对已恢复内容后重试';
  }
  if (isTimeoutFailure(reason)) {
    return '请求超时，结果暂未确认，请保持原内容直接重试';
  }
  if (isNetworkFailure(reason)) {
    return '网络异常，结果暂未确认，请保持原内容直接重试';
  }
  if (resolutionStatus === 'unknown-result') {
    return '结果暂未确认，请保持原内容直接重试';
  }
  return '提交未完成，请核对已恢复内容后重试';
}

function readResponseStatus(reason: unknown): number | null {
  if (!reason || typeof reason !== 'object') return null;
  const response = (reason as { response?: unknown }).response;
  if (!response || typeof response !== 'object') return null;
  const status = Number((response as { status?: unknown }).status);
  return Number.isInteger(status) ? status : null;
}

function isTimeoutFailure(reason: unknown): boolean {
  if (!reason || typeof reason !== 'object') return false;
  const candidate = reason as {
    code?: unknown;
    message?: unknown;
    name?: unknown;
  };
  return (
    candidate.code === 'ECONNABORTED' ||
    candidate.code === 'ETIMEDOUT' ||
    candidate.name === 'AbortError' ||
    (typeof candidate.message === 'string' &&
      candidate.message.toLowerCase().includes('timeout'))
  );
}

function isNetworkFailure(reason: unknown): boolean {
  if (!reason || typeof reason !== 'object') return false;
  const candidate = reason as { code?: unknown; request?: unknown };
  return candidate.code === 'ERR_NETWORK' || Boolean(candidate.request);
}

export default NewEmployeeOnboardingDialog;
