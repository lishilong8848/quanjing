import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from 'react';
import { flushSync } from 'react-dom';
import {
  AlertCircle,
  CheckCircle2,
  Clock3,
  FileImage,
  FileText,
  FileUp,
  Loader2,
  RotateCcw,
  Search,
  ShieldAlert,
  Trash2,
  UserCheck,
  Users,
} from 'lucide-react';
import { toast } from 'sonner';
import type {
  WeatherGuardRegistrationOptions,
  WeatherGuardRegistrationPersonOption,
  WeatherGuardRegistrationResponse,
  WeatherGuardRegistrationStatus,
  WeatherWarningBuilding,
} from '@shared/api.interface';
import {
  getWeatherGuardRegistrationOptions,
  submitWeatherGuardRegistration,
} from '@/api';
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
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import {
  buildWeatherGuardRegistrationFormData,
  clearWeatherGuardRegistrationDraft,
  clearWeatherGuardRegistrationPending,
  createWeatherGuardRegistrationDraft,
  createWeatherGuardRegistrationSubmissionGate,
  getWeatherGuardRegistrationErrorMessage as getRegistrationErrorMessage,
  isCurrentWeatherGuardRegistrationSubmission,
  readWeatherGuardRegistrationDraft,
  readWeatherGuardRegistrationPending,
  saveWeatherGuardRegistrationDraft,
  saveWeatherGuardRegistrationPending,
  validateWeatherGuardRegistrationDraft,
  validateWeatherGuardRegistrationEvidence,
  type WeatherGuardRegistrationDraft,
  type WeatherGuardRegistrationDeepLink,
  type WeatherGuardRegistrationEvidence,
  type WeatherGuardRegistrationEvidenceConstraints,
  type WeatherGuardRegistrationEvidenceField,
  type WeatherGuardRegistrationEvidenceIssue,
  type WeatherGuardRegistrationSubmissionGate,
  type WeatherGuardRegistrationValidationIssue,
} from './weather-warning-registration';

export interface WeatherWarningGuardRegistrationDialogProps {
  open: boolean;
  warningId: string | null;
  source: WeatherGuardRegistrationDeepLink['source'];
  onOpenChange: (open: boolean) => void;
  onBackgroundSyncChange?: (syncing: boolean) => void;
  onSubmitted: (result: WeatherGuardRegistrationResponse) => void;
}

type DialogPhase =
  | 'idle'
  | 'loading'
  | 'ready'
  | 'submitting'
  | 'failed'
  | 'succeeded';

type RegistrationStatusField =
  | 'deviceStatus'
  | 'disasterStatus'
  | 'environmentStatus'
  | 'materialsStatus'
  | 'contactsStatus';

type RegistrationDescriptionField =
  | 'deviceAbnormalDescription'
  | 'disasterAbnormalDescription'
  | 'environmentAbnormalDescription'
  | 'materialsAbnormalDescription'
  | 'contactsAbnormalDescription';

type RegistrationField =
  | keyof WeatherGuardRegistrationDraft
  | WeatherGuardRegistrationEvidenceField;

type RegistrationFieldErrors = Partial<Record<RegistrationField, string>>;

interface WeatherGuardCheckDefinition {
  key: 'device' | 'disaster' | 'environment' | 'materials' | 'contacts';
  title: string;
  description: string;
  statusField: RegistrationStatusField;
  abnormalDescriptionField: RegistrationDescriptionField;
  evidenceField?: WeatherGuardRegistrationEvidenceField;
}

interface WeatherGuardEvidencePreviews {
  deviceEvidence: string | null;
  disasterEvidence: string | null;
  environmentEvidence: string | null;
}

const IMAGE_TYPE_LABELS: Readonly<Record<string, string>> = {
  'image/png': 'PNG',
  'image/jpeg': 'JPEG',
  'image/webp': 'WebP',
  'application/pdf': 'PDF',
};

const EMPTY_EVIDENCE: WeatherGuardRegistrationEvidence = {
  deviceEvidence: null,
  disasterEvidence: null,
  environmentEvidence: null,
};

const EMPTY_EVIDENCE_PREVIEWS: WeatherGuardEvidencePreviews = {
  deviceEvidence: null,
  disasterEvidence: null,
  environmentEvidence: null,
};

const CHECK_DEFINITIONS: readonly WeatherGuardCheckDefinition[] = [
  {
    key: 'device',
    title: '设备安全',
    description: '确认关键设备、运行状态和现场安全条件。',
    statusField: 'deviceStatus',
    abnormalDescriptionField: 'deviceAbnormalDescription',
    evidenceField: 'deviceEvidence',
  },
  {
    key: 'disaster',
    title: '灾害专项',
    description: '确认本次天气风险专项检查已完成。',
    statusField: 'disasterStatus',
    abnormalDescriptionField: 'disasterAbnormalDescription',
    evidenceField: 'disasterEvidence',
  },
  {
    key: 'environment',
    title: '环境安全',
    description: '确认机房温湿度、渗漏和环境条件。',
    statusField: 'environmentStatus',
    abnormalDescriptionField: 'environmentAbnormalDescription',
    evidenceField: 'environmentEvidence',
  },
  {
    key: 'materials',
    title: '重保物资清单',
    description: '确认应急物资数量、状态和可用性。',
    statusField: 'materialsStatus',
    abnormalDescriptionField: 'materialsAbnormalDescription',
  },
  {
    key: 'contacts',
    title: '重保联络清单',
    description: '确认戒备期间人员与供应商联络信息。',
    statusField: 'contactsStatus',
    abnormalDescriptionField: 'contactsAbnormalDescription',
  },
];

export interface WeatherGuardRegistrationDialogRequestToken {
  revision: number;
  signal: AbortSignal;
}

export interface WeatherGuardRegistrationDialogRequestCoordinator {
  begin: () => WeatherGuardRegistrationDialogRequestToken;
  invalidate: () => void;
  isCurrent: (token: WeatherGuardRegistrationDialogRequestToken) => boolean;
}

export interface WeatherGuardRegistrationEvidencePreviewRegistry {
  replace: (
    field: WeatherGuardRegistrationEvidenceField,
    file: File,
  ) => string | null;
  remove: (field: WeatherGuardRegistrationEvidenceField) => void;
  clear: () => void;
  get: (field: WeatherGuardRegistrationEvidenceField) => string | null;
  snapshot: () => Record<WeatherGuardRegistrationEvidenceField, string | null>;
}

export function createWeatherGuardRegistrationEvidencePreviewRegistry(
  createObjectUrl: (file: File) => string = (file) => URL.createObjectURL(file),
  revokeObjectUrl: (url: string) => void = (url) => URL.revokeObjectURL(url),
): WeatherGuardRegistrationEvidencePreviewRegistry {
  const previews: Record<WeatherGuardRegistrationEvidenceField, string | null> =
    {
      ...EMPTY_EVIDENCE_PREVIEWS,
    };

  const remove = (field: WeatherGuardRegistrationEvidenceField) => {
    const current = previews[field];
    try {
      if (current) revokeObjectUrl(current);
    } finally {
      previews[field] = null;
    }
  };

  return {
    replace: (field, file) => {
      try {
        remove(field);
      } catch {
        // A revoked or unavailable object URL must not block selecting a new file.
      }
      try {
        previews[field] = isPreviewableImageEvidence(file)
          ? createObjectUrl(file)
          : null;
      } catch {
        previews[field] = null;
      }
      return previews[field];
    },
    remove,
    clear: () => {
      for (const field of EVIDENCE_FIELDS) {
        try {
          remove(field);
        } catch {
          // Cleanup is best-effort; every field is still reset by remove's finally.
        }
      }
    },
    get: (field) => previews[field],
    snapshot: () => ({ ...previews }),
  };
}

function isPreviewableImageEvidence(file: File): boolean {
  return ['image/png', 'image/jpeg', 'image/webp'].includes(
    file.type.trim().toLowerCase(),
  );
}

export function createWeatherGuardRegistrationDialogRequestCoordinator(): WeatherGuardRegistrationDialogRequestCoordinator {
  let revision = 0;
  let activeController: AbortController | null = null;

  return {
    begin: () => {
      activeController?.abort();
      const controller = new AbortController();
      activeController = controller;
      revision += 1;
      return { revision, signal: controller.signal };
    },
    invalidate: () => {
      revision += 1;
      activeController?.abort();
      activeController = null;
    },
    isCurrent: (token) =>
      token.revision === revision &&
      token.signal === activeController?.signal &&
      !token.signal.aborted,
  };
}

export function filterWeatherGuardRegistrationCandidates(
  candidates: readonly WeatherGuardRegistrationPersonOption[],
  query: string,
  _building: WeatherWarningBuilding | null,
): WeatherGuardRegistrationPersonOption[] {
  const normalizedQuery = query.trim().toLocaleLowerCase('zh-CN');
  return candidates.filter(({ name, position, buildings }) => {
    if (!normalizedQuery) return true;
    return `${name}\n${position}\n${formatWeatherGuardCandidateBuildings(buildings)}`
      .toLocaleLowerCase('zh-CN')
      .includes(normalizedQuery);
  });
}

export function toggleWeatherGuardRegistrationCandidateKey(
  currentKeys: readonly string[],
  candidateKey: string,
  candidates: readonly WeatherGuardRegistrationPersonOption[],
): string[] {
  const allowedKeys = new Set(candidates.map(({ key }) => key));
  const sanitizedKeys = [...new Set(currentKeys)].filter((key) =>
    allowedKeys.has(key),
  );
  if (!allowedKeys.has(candidateKey)) return sanitizedKeys;
  return sanitizedKeys.includes(candidateKey)
    ? sanitizedKeys.filter((key) => key !== candidateKey)
    : [...sanitizedKeys, candidateKey];
}

export type WeatherGuardRegistrationDialogSubmissionOutcome =
  | { kind: 'duplicate' }
  | { kind: 'stale' }
  | { kind: 'failed'; error: unknown }
  | { kind: 'succeeded'; result: WeatherGuardRegistrationResponse };

export interface WeatherGuardRegistrationDialogSubmissionInput {
  draft: WeatherGuardRegistrationDraft;
  environmentRequired: boolean;
  evidence: WeatherGuardRegistrationEvidence;
  evidenceConstraints?: WeatherGuardRegistrationEvidenceConstraints;
  revision: number;
  submissionGate: WeatherGuardRegistrationSubmissionGate;
  requestCoordinator: WeatherGuardRegistrationDialogRequestCoordinator;
  submit: (
    formData: FormData,
    signal: AbortSignal,
  ) => Promise<WeatherGuardRegistrationResponse>;
  clearDraft: () => void;
  onAccepted?: (input: { clientMutationId: string }) => void;
  onSubmitted: (result: WeatherGuardRegistrationResponse) => void;
}

export async function runWeatherGuardRegistrationDialogSubmission({
  draft,
  environmentRequired,
  evidence,
  evidenceConstraints,
  revision,
  submissionGate,
  requestCoordinator,
  submit,
  clearDraft,
  onAccepted,
  onSubmitted,
}: WeatherGuardRegistrationDialogSubmissionInput): Promise<WeatherGuardRegistrationDialogSubmissionOutcome> {
  let formData: FormData;
  try {
    formData = buildWeatherGuardRegistrationFormData(
      draft,
      environmentRequired,
      evidence,
      evidenceConstraints,
    );
  } catch (error) {
    return { kind: 'failed', error };
  }

  const submissionToken = submissionGate.tryStart(draft, revision);
  if (!submissionToken) return { kind: 'duplicate' };
  const requestToken = requestCoordinator.begin();

  try {
    onAccepted?.({ clientMutationId: draft.clientMutationId });
    const result = await submit(formData, requestToken.signal);
    if (
      !requestCoordinator.isCurrent(requestToken) ||
      !isCurrentWeatherGuardRegistrationSubmission(
        submissionToken,
        draft,
        revision,
      )
    ) {
      return { kind: 'stale' };
    }
    if (!isConfirmedWeatherGuardRegistrationResponse(result, draft)) {
      return {
        kind: 'failed',
        error: new Error('服务端未确认本次戒备登记及楼栋写入结果'),
      };
    }
    clearDraft();
    onSubmitted(result);
    return { kind: 'succeeded', result };
  } catch (error) {
    return requestCoordinator.isCurrent(requestToken)
      ? { kind: 'failed', error }
      : { kind: 'stale' };
  } finally {
    submissionGate.finish(submissionToken);
  }
}

function isConfirmedWeatherGuardRegistrationResponse(
  result: WeatherGuardRegistrationResponse,
  expected: Pick<
    WeatherGuardRegistrationDraft,
    'clientMutationId' | 'building'
  >,
): boolean {
  return (
    result?.success === true &&
    result.clientMutationId === expected.clientMutationId &&
    result.syncStatus === 'confirmed' &&
    result.building === expected.building &&
    typeof result.recordId === 'string' &&
    result.recordId.length > 0 &&
    result.recordId === result.recordId.trim()
  );
}

export function WeatherWarningGuardRegistrationDialog({
  open,
  warningId,
  source,
  onOpenChange,
  onBackgroundSyncChange,
  onSubmitted,
}: WeatherWarningGuardRegistrationDialogProps) {
  const optionsRequestCoordinatorRef = useRef(
    createWeatherGuardRegistrationDialogRequestCoordinator(),
  );
  const submissionRequestCoordinatorRef = useRef(
    createWeatherGuardRegistrationDialogRequestCoordinator(),
  );
  const submissionGateRef = useRef(
    createWeatherGuardRegistrationSubmissionGate(),
  );
  const acceptedMutationIdRef = useRef<string | null>(null);
  const activeWarningIdRef = useRef<string | null>(null);
  const draftRef = useRef<WeatherGuardRegistrationDraft | null>(null);
  const evidenceRef = useRef<WeatherGuardRegistrationEvidence>({
    ...EMPTY_EVIDENCE,
  });
  const previewRegistryRef =
    useRef<WeatherGuardRegistrationEvidencePreviewRegistry | null>(null);
  if (!previewRegistryRef.current) {
    previewRegistryRef.current =
      createWeatherGuardRegistrationEvidencePreviewRegistry();
  }
  const revisionRef = useRef(0);
  const summaryRef = useRef<HTMLDivElement | null>(null);

  const [phase, setPhase] = useState<DialogPhase>('idle');
  const [optimisticallyClosed, setOptimisticallyClosed] = useState(false);
  const [submissionLocked, setSubmissionLocked] = useState(false);
  const [submissionLockConflict, setSubmissionLockConflict] = useState(false);
  const [recoveringLockedEvidence, setRecoveringLockedEvidence] =
    useState(false);
  const [options, setOptions] =
    useState<WeatherGuardRegistrationOptions | null>(null);
  const [draft, setDraft] = useState<WeatherGuardRegistrationDraft | null>(
    null,
  );
  const [evidence, setEvidence] = useState<WeatherGuardRegistrationEvidence>({
    ...EMPTY_EVIDENCE,
  });
  const [previews, setPreviews] = useState<WeatherGuardEvidencePreviews>({
    ...EMPTY_EVIDENCE_PREVIEWS,
  });
  const [fieldErrors, setFieldErrors] = useState<RegistrationFieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [checkerSearch, setCheckerSearch] = useState('');
  const [evidenceMustBeReselected, setEvidenceMustBeReselected] =
    useState(false);
  const [loadRevision, setLoadRevision] = useState(0);
  const [submittedResult, setSubmittedResult] =
    useState<WeatherGuardRegistrationResponse | null>(null);
  const [draftPersistenceMessage, setDraftPersistenceMessage] = useState<
    string | null
  >(null);

  const releasePreviewUrls = useCallback((updateState = true) => {
    previewRegistryRef.current?.clear();
    if (updateState) setPreviews({ ...EMPTY_EVIDENCE_PREVIEWS });
  }, []);

  const ensureEvidencePreviews = useCallback(() => {
    let changed = false;
    for (const field of EVIDENCE_FIELDS) {
      const file = evidenceRef.current[field];
      if (file && !previewRegistryRef.current?.get(field)) {
        const preview = previewRegistryRef.current?.replace(field, file);
        changed = changed || Boolean(preview);
      }
    }
    if (changed) {
      setPreviews({
        ...EMPTY_EVIDENCE_PREVIEWS,
        ...previewRegistryRef.current?.snapshot(),
      });
    }
  }, []);

  const commitDraft = useCallback(
    (nextDraft: WeatherGuardRegistrationDraft, persist = true) => {
      draftRef.current = nextDraft;
      setDraft(nextDraft);
      revisionRef.current += 1;
      if (persist) {
        const draftSaved = saveWeatherGuardRegistrationDraft(nextDraft);
        if (!draftSaved) {
          setDraftPersistenceMessage(
            '草稿仅保留在当前页面；关闭或刷新后可能丢失。',
          );
        } else {
          setDraftPersistenceMessage(null);
        }
      }
    },
    [],
  );

  const clearFieldErrors = useCallback((...fields: RegistrationField[]) => {
    setFieldErrors((current) => {
      const next = { ...current };
      for (const field of fields) delete next[field];
      return next;
    });
    setFormError(null);
    setPhase((current) => (current === 'failed' ? 'ready' : current));
  }, []);

  const updateDraft = useCallback(
    (
      update: (
        current: WeatherGuardRegistrationDraft,
      ) => WeatherGuardRegistrationDraft,
      ...clearedFields: RegistrationField[]
    ) => {
      const current = draftRef.current;
      if (!current) return;
      commitDraft(update(current));
      clearFieldErrors(...clearedFields);
    },
    [clearFieldErrors, commitDraft],
  );

  const clearEnvironmentEvidence = useCallback(() => {
    previewRegistryRef.current?.remove('environmentEvidence');
    const nextEvidence = {
      ...evidenceRef.current,
      environmentEvidence: null,
    };
    const nextPreviews = previewRegistryRef.current?.snapshot() ?? {
      ...EMPTY_EVIDENCE_PREVIEWS,
    };
    evidenceRef.current = nextEvidence;
    setEvidence(nextEvidence);
    setPreviews(nextPreviews);
  }, []);

  useEffect(() => {
    const coordinator = optionsRequestCoordinatorRef.current;
    coordinator.invalidate();

    if (!open) {
      setOptimisticallyClosed(false);
      releasePreviewUrls();
      setPhase('idle');
      return;
    }
    if (!warningId || warningId !== warningId.trim()) {
      releasePreviewUrls();
      evidenceRef.current = { ...EMPTY_EVIDENCE };
      setEvidence({ ...EMPTY_EVIDENCE });
      activeWarningIdRef.current = null;
      setOptions(null);
      setSubmissionLocked(false);
      setSubmissionLockConflict(false);
      setRecoveringLockedEvidence(false);
      setPhase('failed');
      setFormError('未找到可登记的天气预警，请返回排班页重新选择。');
      return;
    }

    try {
      const shouldInitializeDraft =
        activeWarningIdRef.current !== warningId || !draftRef.current;
      let restoredWithoutEvidence = false;
      if (shouldInitializeDraft) {
        setOptimisticallyClosed(false);
        releasePreviewUrls();
        setDraftPersistenceMessage(null);
        evidenceRef.current = { ...EMPTY_EVIDENCE };
        setEvidence({ ...EMPTY_EVIDENCE });
        activeWarningIdRef.current = warningId;
        const restored = readWeatherGuardRegistrationDraft(warningId);
        const initialDraft =
          restored?.draft ?? createWeatherGuardRegistrationDraft(warningId);
        commitDraft(initialDraft, !restored);
        restoredWithoutEvidence = restored?.evidenceMustBeReselected === true;
        setEvidenceMustBeReselected(restoredWithoutEvidence);
        setCheckerSearch('');
        setFieldErrors({});
        setSubmittedResult(null);
      } else {
        ensureEvidencePreviews();
      }
      const currentDraft = draftRef.current;
      const pendingMutationId =
        readWeatherGuardRegistrationPending(warningId) ??
        acceptedMutationIdRef.current;
      const submissionIsLocked = Boolean(pendingMutationId);
      const lockConflictsWithDraft = Boolean(
        currentDraft &&
        pendingMutationId &&
        pendingMutationId !== currentDraft.clientMutationId,
      );
      setSubmissionLocked(submissionIsLocked);
      setSubmissionLockConflict(lockConflictsWithDraft);
      if (shouldInitializeDraft) {
        const needsLockedEvidenceRecovery = Boolean(
          submissionIsLocked &&
          !lockConflictsWithDraft &&
          restoredWithoutEvidence,
        );
        setRecoveringLockedEvidence(needsLockedEvidenceRecovery);
        if (needsLockedEvidenceRecovery) {
          setDraftPersistenceMessage(
            '上一笔登记尚待确认；业务信息已锁定，请重新选择原检查附件后按同一操作号重试。',
          );
        }
      }
    } catch (error) {
      setOptions(null);
      setPhase('failed');
      setFormError(getRegistrationErrorMessage(error));
      return;
    }

    setOptions(null);
    setPhase('loading');
    setFormError(null);
    const requestToken = coordinator.begin();

    void getWeatherGuardRegistrationOptions(warningId, requestToken.signal)
      .then((nextOptions) => {
        if (!coordinator.isCurrent(requestToken)) return;
        assertRegistrationOptions(nextOptions, warningId);

        const currentDraft = draftRef.current;
        if (!currentDraft || currentDraft.warningId !== warningId) return;
        const pendingMutationId =
          readWeatherGuardRegistrationPending(warningId) ??
          acceptedMutationIdRef.current;
        const submissionIsLocked = Boolean(pendingMutationId);
        const lockConflictsWithDraft = Boolean(
          pendingMutationId &&
          pendingMutationId !== currentDraft.clientMutationId,
        );
        setSubmissionLocked(submissionIsLocked);
        setSubmissionLockConflict(lockConflictsWithDraft);
        const sanitizedDraft = submissionIsLocked
          ? currentDraft
          : sanitizeDraftForOptions(currentDraft, nextOptions);
        if (!areRegistrationDraftsEqual(currentDraft, sanitizedDraft)) {
          commitDraft(sanitizedDraft);
        }
        if (!submissionIsLocked && !nextOptions.environmentRequired) {
          clearEnvironmentEvidence();
        }
        const effectiveEnvironmentRequired = submissionIsLocked
          ? currentDraft.environmentStatus !== null
          : nextOptions.environmentRequired;
        const selectedEvidenceIssues =
          getSelectedWeatherGuardRegistrationEvidenceIssues(
            evidenceRef.current,
            effectiveEnvironmentRequired,
            getWeatherGuardRegistrationEvidenceConstraints(nextOptions),
          );
        setFieldErrors((current) => {
          const next = { ...current };
          for (const field of EVIDENCE_FIELDS) delete next[field];
          for (const issue of selectedEvidenceIssues) {
            if (!next[issue.field]) next[issue.field] = issue.message;
          }
          return next;
        });
        if (lockConflictsWithDraft) {
          setFormError(
            '检测到上一笔未确认的登记操作号，但对应草稿已丢失。为避免重复登记，本次提交已锁定。',
          );
        } else if (selectedEvidenceIssues.length > 0) {
          setFormError(
            '服务端附件要求已更新，请重新选择未通过校验的检查附件。',
          );
        }
        setOptions(nextOptions);
        setPhase('ready');
      })
      .catch((error: unknown) => {
        if (!coordinator.isCurrent(requestToken) || isAbortError(error)) return;
        setOptions(null);
        setPhase('failed');
        setFormError(getRegistrationErrorMessage(error));
      });

    return () => {
      if (coordinator.isCurrent(requestToken)) coordinator.invalidate();
    };
  }, [
    clearEnvironmentEvidence,
    commitDraft,
    ensureEvidencePreviews,
    loadRevision,
    open,
    releasePreviewUrls,
    warningId,
  ]);

  useEffect(
    () => () => {
      optionsRequestCoordinatorRef.current.invalidate();
      releasePreviewUrls(false);
    },
    [releasePreviewUrls],
  );

  useEffect(() => {
    const hasSelectedEvidence = EVIDENCE_FIELDS.some(
      (field) => evidence[field] !== null,
    );
    if (!hasSelectedEvidence || phase === 'succeeded') return;

    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, [evidence, phase]);

  const eligibleCheckers = useMemo(
    () => options?.checkers ?? [],
    [options?.checkers],
  );
  const visibleCheckers = useMemo(
    () =>
      filterWeatherGuardRegistrationCandidates(
        eligibleCheckers,
        checkerSearch,
        draft?.building ?? null,
      ),
    [checkerSearch, draft?.building, eligibleCheckers],
  );

  const isSubmitting = phase === 'submitting';
  const controlsDisabled =
    isSubmitting || phase === 'succeeded' || submissionLocked;
  const evidenceControlsDisabled =
    isSubmitting ||
    phase === 'succeeded' ||
    submissionLockConflict ||
    (submissionLocked && !recoveringLockedEvidence);

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen) {
        optionsRequestCoordinatorRef.current.invalidate();
        releasePreviewUrls();
      }
      onOpenChange(nextOpen);
    },
    [onOpenChange, releasePreviewUrls],
  );

  const handleStatusChange = useCallback(
    (
      definition: WeatherGuardCheckDefinition,
      status: WeatherGuardRegistrationStatus,
    ) => {
      updateDraft(
        (current) =>
          ({
            ...current,
            [definition.statusField]: status,
            [definition.abnormalDescriptionField]:
              status === '正常'
                ? ''
                : current[definition.abnormalDescriptionField],
          }) as WeatherGuardRegistrationDraft,
        definition.statusField,
        definition.abnormalDescriptionField,
      );
    },
    [updateDraft],
  );

  const handleEvidenceChange = useCallback(
    (
      field: WeatherGuardRegistrationEvidenceField,
      event: ChangeEvent<HTMLInputElement>,
    ) => {
      const file = event.currentTarget.files?.[0] ?? null;
      event.currentTarget.value = '';
      if (!file || !options) return;

      const candidateEvidence = { ...evidenceRef.current, [field]: file };
      const issue = validateWeatherGuardRegistrationEvidence(
        candidateEvidence,
        options.environmentRequired,
        getWeatherGuardRegistrationEvidenceConstraints(options),
      ).find((candidate) => candidate.field === field);
      if (issue) {
        setFieldErrors((current) => ({
          ...current,
          [field]: issue.message,
        }));
        setFormError('所选附件未通过校验，请按提示重新选择。');
        return;
      }

      previewRegistryRef.current?.replace(field, file);
      const nextPreviews = previewRegistryRef.current?.snapshot() ?? {
        ...EMPTY_EVIDENCE_PREVIEWS,
      };
      evidenceRef.current = candidateEvidence;
      setEvidence(candidateEvidence);
      setPreviews(nextPreviews);
      revisionRef.current += 1;
      clearFieldErrors(field);
      if (
        validateWeatherGuardRegistrationEvidence(
          candidateEvidence,
          options.environmentRequired,
          getWeatherGuardRegistrationEvidenceConstraints(options),
        ).length === 0
      ) {
        setEvidenceMustBeReselected(false);
      }
    },
    [clearFieldErrors, options],
  );

  const handleEvidenceRemove = useCallback(
    (field: WeatherGuardRegistrationEvidenceField) => {
      previewRegistryRef.current?.remove(field);
      const nextEvidence = { ...evidenceRef.current, [field]: null };
      const nextPreviews = previewRegistryRef.current?.snapshot() ?? {
        ...EMPTY_EVIDENCE_PREVIEWS,
      };
      evidenceRef.current = nextEvidence;
      setEvidence(nextEvidence);
      setPreviews(nextPreviews);
      revisionRef.current += 1;
      setFieldErrors((current) => ({
        ...current,
        [field]: '请选择一份检查附件',
      }));
    },
    [],
  );

  const handleClearDraft = useCallback(() => {
    const currentWarningId = activeWarningIdRef.current;
    if (!currentWarningId || controlsDisabled) return;

    const draftCleared = clearWeatherGuardRegistrationDraft(currentWarningId);
    const pendingCleared =
      clearWeatherGuardRegistrationPending(currentWarningId);
    setDraftPersistenceMessage(
      draftCleared && pendingCleared
        ? null
        : '未能清理浏览器草稿；当前页面已清空，下次打开时请核对恢复内容。',
    );
    releasePreviewUrls();
    evidenceRef.current = { ...EMPTY_EVIDENCE };
    setEvidence({ ...EMPTY_EVIDENCE });
    setEvidenceMustBeReselected(false);
    acceptedMutationIdRef.current = null;
    setSubmissionLockConflict(false);
    setRecoveringLockedEvidence(false);
    setFieldErrors({});
    setFormError(null);
    setCheckerSearch('');
    try {
      commitDraft(createWeatherGuardRegistrationDraft(currentWarningId), false);
      setPhase('ready');
    } catch (error) {
      setPhase('failed');
      setFormError(getRegistrationErrorMessage(error));
    }
  }, [commitDraft, controlsDisabled, releasePreviewUrls]);

  const handleSubmit = useCallback(async () => {
    const currentDraft = draftRef.current;
    if (
      !currentDraft ||
      !options ||
      phase === 'submitting' ||
      phase === 'succeeded' ||
      submissionLockConflict
    ) {
      return;
    }

    const effectiveEnvironmentRequired = submissionLocked
      ? currentDraft.environmentStatus !== null
      : options.environmentRequired;
    const draftIssues = validateDraftAgainstOptions(
      currentDraft,
      options,
      effectiveEnvironmentRequired,
    );
    const evidenceIssues = validateWeatherGuardRegistrationEvidence(
      evidenceRef.current,
      effectiveEnvironmentRequired,
      getWeatherGuardRegistrationEvidenceConstraints(options),
    );
    if (draftIssues.length > 0 || evidenceIssues.length > 0) {
      setFieldErrors(
        createRegistrationFieldErrors(draftIssues, evidenceIssues),
      );
      setFormError('请完成下方必填项后再提交。');
      window.requestAnimationFrame(() => {
        summaryRef.current?.focus();
        focusRegistrationField(
          draftIssues[0]?.field ?? evidenceIssues[0]?.field,
        );
      });
      return;
    }

    const submissionWarningId = currentDraft.warningId;
    setFormError(null);
    let acceptedForBackgroundSync = false;
    let confirmedCleanupSucceeded = false;
    const outcome = await runWeatherGuardRegistrationDialogSubmission({
      draft: currentDraft,
      environmentRequired: effectiveEnvironmentRequired,
      evidence: evidenceRef.current,
      evidenceConstraints: {
        acceptedImageTypes: options.acceptedImageTypes,
        maxImageBytes: options.maxImageBytes,
      },
      revision: revisionRef.current,
      submissionGate: submissionGateRef.current,
      requestCoordinator: submissionRequestCoordinatorRef.current,
      submit: submitWeatherGuardRegistration,
      clearDraft: () => {
        const draftCleared =
          clearWeatherGuardRegistrationDraft(submissionWarningId);
        const pendingCleared = draftCleared
          ? clearWeatherGuardRegistrationPending(submissionWarningId)
          : false;
        confirmedCleanupSucceeded = draftCleared && pendingCleared;
        setDraftPersistenceMessage(
          confirmedCleanupSucceeded
            ? null
            : '登记已提交，但未能清理浏览器草稿；下次打开时请不要重复提交。',
        );
      },
      onAccepted: ({ clientMutationId }) => {
        const pendingSaved = saveWeatherGuardRegistrationPending(currentDraft);
        acceptedMutationIdRef.current = clientMutationId;
        acceptedForBackgroundSync = true;
        flushSync(() => {
          setPhase('submitting');
          setOptimisticallyClosed(true);
          setSubmissionLocked(true);
          setSubmissionLockConflict(false);
          setRecoveringLockedEvidence(false);
          onBackgroundSyncChange?.(true);
        });
        if (!pendingSaved) {
          setDraftPersistenceMessage(
            '后台同步锁仅保留在当前页面；请勿刷新，并按同一操作号重试。',
          );
        }
        toast.loading('戒备登记已受理，正在后台同步', {
          id: clientMutationId,
        });
      },
      onSubmitted,
    });

    if (outcome.kind === 'duplicate') return;
    if (acceptedForBackgroundSync) onBackgroundSyncChange?.(false);
    if (outcome.kind === 'stale') {
      setOptimisticallyClosed(false);
      setPhase('failed');
      setFormError(
        '后台同步状态已失效，已锁定原填写内容和附件，请按同一操作号重试。',
      );
      toast.error('戒备登记后台同步未确认，请重试', {
        id: currentDraft.clientMutationId,
      });
      return;
    }
    if (outcome.kind === 'failed') {
      setOptimisticallyClosed(false);
      setPhase('failed');
      setFormError(
        `${getRegistrationErrorMessage(outcome.error)} 已锁定原填写内容和附件，请按同一操作号重试。`,
      );
      toast.error('戒备登记同步失败，已恢复原填写内容', {
        id: currentDraft.clientMutationId,
      });
      return;
    }

    toast.success(`${outcome.result.building}戒备登记已同步`, {
      id: currentDraft.clientMutationId,
    });
    releasePreviewUrls();
    evidenceRef.current = { ...EMPTY_EVIDENCE };
    setEvidence({ ...EMPTY_EVIDENCE });
    draftRef.current = null;
    acceptedMutationIdRef.current = null;
    setDraft(null);
    setFieldErrors({});
    setEvidenceMustBeReselected(false);
    setSubmissionLocked(!confirmedCleanupSucceeded);
    setSubmissionLockConflict(!confirmedCleanupSucceeded);
    setRecoveringLockedEvidence(false);
    setSubmittedResult(outcome.result);
    setPhase('succeeded');
    onOpenChange(false);
  }, [
    onBackgroundSyncChange,
    onOpenChange,
    onSubmitted,
    options,
    phase,
    releasePreviewUrls,
    submissionLockConflict,
    submissionLocked,
  ]);

  const checkDefinitions =
    options &&
    (submissionLocked
      ? draft?.environmentStatus !== null
      : options.environmentRequired)
      ? CHECK_DEFINITIONS
      : CHECK_DEFINITIONS.filter(({ key }) => key !== 'environment');

  return (
    <Dialog
      open={open && !optimisticallyClosed}
      onOpenChange={handleOpenChange}
    >
      <DialogContent
        className="flex max-h-[min(92dvh,52rem)] w-[min(96vw,56rem)] max-w-none flex-col gap-0 overflow-hidden overscroll-contain p-0"
        aria-busy={isSubmitting}
        showCloseButton={!isSubmitting}
        onEscapeKeyDown={(event) => {
          if (isSubmitting) event.preventDefault();
        }}
        onPointerDownOutside={(event) => {
          if (isSubmitting) event.preventDefault();
        }}
        onInteractOutside={(event) => {
          if (isSubmitting) event.preventDefault();
        }}
      >
        <DialogHeader className="shrink-0 border-b border-slate-100 bg-slate-50/70 px-5 py-4 pr-12 text-left">
          <div className="flex items-center gap-2 text-blue-700">
            <ShieldAlert className="h-5 w-5" aria-hidden="true" />
            <DialogTitle>提交戒备登记</DialogTitle>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <DialogDescription className="min-w-0 break-words [overflow-wrap:anywhere]">
              {options
                ? `${options.warning.title} · ${options.guardLevel}`
                : '正在读取当前预警与戒备信息…'}
              {' · '}
              {source === 'test-card'
                ? '来自飞书测试卡片'
                : source === 'feishu-card'
                  ? '来自飞书卡片'
                  : '来自排班页'}
            </DialogDescription>
            {options && (
              <span className="inline-flex items-center gap-1 text-xs text-slate-500">
                <Clock3 className="h-3.5 w-3.5" aria-hidden="true" />
                数据更新{' '}
                {formatRegistrationDataUpdatedAt(options.dataUpdatedAt)}
              </span>
            )}
            {draft && phase !== 'succeeded' && (
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 text-xs text-slate-500"
                    disabled={controlsDisabled}
                  >
                    <RotateCcw
                      className="mr-1 h-3.5 w-3.5"
                      aria-hidden="true"
                    />
                    清空本次填写
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent className="max-w-md">
                  <AlertDialogHeader>
                    <AlertDialogTitle>清空本次填写？</AlertDialogTitle>
                    <AlertDialogDescription>
                      当前文字、人员选择和已选附件都会清空，此操作无法撤销。
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>取消</AlertDialogCancel>
                    <AlertDialogAction onClick={handleClearDraft}>
                      确认清空
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            )}
          </div>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4">
          {draftPersistenceMessage && (
            <div
              className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900"
              role="status"
              aria-live="polite"
              aria-atomic="true"
            >
              {draftPersistenceMessage}
            </div>
          )}
          {phase === 'loading' && (
            <div
              className="flex min-h-56 flex-col items-center justify-center gap-3 text-center text-sm text-slate-600"
              role="status"
              aria-live="polite"
            >
              <Loader2
                className="h-6 w-6 animate-spin motion-reduce:animate-none text-blue-600"
                aria-hidden="true"
              />
              <p className="font-medium text-slate-800">
                正在读取当前预警与戒备信息…
              </p>
              <p>表单框架已打开，服务端候选项返回后即可填写。</p>
            </div>
          )}

          {phase === 'failed' && !options && (
            <div
              className="flex min-h-56 flex-col items-center justify-center gap-3 rounded-lg border border-amber-200 bg-amber-50 p-5 text-center text-sm text-amber-950"
              role="alert"
            >
              <AlertCircle className="h-6 w-6" aria-hidden="true" />
              <p className="font-semibold">戒备登记信息加载失败</p>
              <p>{formError}</p>
              <Button
                type="button"
                variant="outline"
                onClick={() => setLoadRevision((current) => current + 1)}
              >
                重新加载
              </Button>
            </div>
          )}

          {phase === 'succeeded' && submittedResult && (
            <div
              className="flex min-h-56 flex-col items-center justify-center gap-3 rounded-lg border border-emerald-200 bg-emerald-50 p-5 text-center"
              role="status"
              aria-live="polite"
            >
              <CheckCircle2
                className="h-9 w-9 text-emerald-600"
                aria-hidden="true"
              />
              <div>
                <p className="font-semibold text-emerald-950">戒备登记已提交</p>
                <p className="mt-1 text-sm text-emerald-800">
                  {submittedResult.building} · {submittedResult.guardLevel}
                </p>
              </div>
            </div>
          )}

          {options && draft && phase !== 'succeeded' && (
            <div className="space-y-4">
              {formError && (
                <div
                  ref={summaryRef}
                  tabIndex={-1}
                  className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800 outline-none focus:ring-2 focus:ring-red-300"
                  role="alert"
                  aria-live="assertive"
                >
                  <div className="flex items-start gap-2">
                    <AlertCircle
                      className="mt-0.5 h-4 w-4 shrink-0"
                      aria-hidden="true"
                    />
                    <div>
                      <p className="font-semibold">本次登记尚未提交</p>
                      <p className="mt-0.5">{formError}</p>
                    </div>
                  </div>
                </div>
              )}

              {evidenceMustBeReselected && (
                <div
                  className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900"
                  role="status"
                >
                  已恢复上次文字草稿；为保护本地文件，检查附件不会存储，必须重新选择。
                </div>
              )}

              <section className="rounded-lg border border-blue-100 bg-blue-50/40 p-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <ShieldAlert
                      className="h-4 w-4 text-blue-600"
                      aria-hidden="true"
                    />
                    <h3 className="text-sm font-semibold text-slate-900">
                      基本信息
                    </h3>
                  </div>
                  <span className="rounded-full border border-blue-200 bg-white/80 px-2 py-0.5 text-[11px] text-blue-700">
                    只读摘要
                  </span>
                </div>
                <dl className="mt-2 grid gap-2 text-sm sm:grid-cols-2">
                  <div className="rounded-md border border-blue-100 bg-white/80 px-3 py-2 sm:col-span-2">
                    <dt className="text-xs text-slate-500">天气预警</dt>
                    <dd className="mt-0.5 font-medium text-slate-900 break-words [overflow-wrap:anywhere]">
                      {options.warning.title}
                    </dd>
                  </div>
                  <div className="rounded-md border border-slate-200 bg-white/80 px-3 py-2">
                    <dt className="text-xs text-slate-500">预警类型</dt>
                    <dd className="mt-0.5 font-medium text-slate-900">
                      {options.warning.type || '未标注类型'}
                      {options.warning.color
                        ? ` · ${getWarningColorLabel(options.warning.color)}色`
                        : ''}
                    </dd>
                  </div>
                  <div className="rounded-md border border-amber-200 bg-amber-50/80 px-3 py-2">
                    <dt className="text-xs text-amber-700">戒备等级</dt>
                    <dd className="mt-0.5 font-semibold text-amber-900">
                      {options.guardLevel}
                    </dd>
                  </div>
                </dl>
              </section>

              <section className="rounded-lg border border-slate-200 bg-white p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <Users
                      className="h-4 w-4 text-blue-600"
                      aria-hidden="true"
                    />
                    <h3 className="text-sm font-semibold text-slate-900">
                      检查人与楼栋
                    </h3>
                  </div>
                  <span
                    className={cn(
                      'text-xs',
                      options.personnelStale
                        ? 'text-amber-700'
                        : 'text-slate-500',
                    )}
                  >
                    全部在职人员 · 缓存{' '}
                    {formatRegistrationDataUpdatedAt(options.personnelSyncedAt)}
                    {options.personnelStale ? '（缓存已过期）' : ''}
                  </span>
                </div>
                <div className="mt-3 grid gap-3 lg:grid-cols-[13rem_minmax(0,1fr)]">
                  <div
                    className="space-y-2"
                    data-registration-field="building"
                    tabIndex={-1}
                  >
                    <Label htmlFor="weather-guard-building">楼栋</Label>
                    <Select
                      name="weather-guard-building"
                      value={draft.building ?? ''}
                      disabled={controlsDisabled}
                      onValueChange={(value) => {
                        const building = options.buildings.includes(
                          value as WeatherWarningBuilding,
                        )
                          ? (value as WeatherWarningBuilding)
                          : null;
                        updateDraft(
                          (current) => ({
                            ...current,
                            building,
                          }),
                          'building',
                        );
                      }}
                    >
                      <SelectTrigger
                        id="weather-guard-building"
                        data-registration-control="building"
                        aria-invalid={Boolean(fieldErrors.building)}
                      >
                        <SelectValue placeholder="选择楼栋…" />
                      </SelectTrigger>
                      <SelectContent>
                        {options.buildings.map((building) => (
                          <SelectItem key={building} value={building}>
                            {building}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {options.buildings.length === 0 && (
                      <p className="text-xs text-amber-700">暂无可选楼栋</p>
                    )}
                    <RegistrationFieldError message={fieldErrors.building} />
                  </div>

                  <fieldset
                    className="space-y-2 lg:row-span-2"
                    data-registration-field="checkerKeys"
                    tabIndex={-1}
                  >
                    <legend className="sr-only">检查人候选项</legend>
                    <div className="flex items-center justify-between gap-2">
                      <Label htmlFor="weather-guard-checker-search">
                        检查人（可多选）
                      </Label>
                      <span className="text-xs text-slate-500">
                        已选 {draft.checkerKeys.length} 人
                      </span>
                    </div>
                    <div className="relative">
                      <Search
                        className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-slate-400"
                        aria-hidden="true"
                      />
                      <Input
                        id="weather-guard-checker-search"
                        name="weather-guard-checker-search"
                        autoComplete="off"
                        data-registration-control="checkerKeys"
                        value={checkerSearch}
                        className="pl-9"
                        placeholder="搜索检查人…"
                        disabled={controlsDisabled}
                        onChange={(event) =>
                          setCheckerSearch(event.target.value)
                        }
                        aria-invalid={Boolean(fieldErrors.checkerKeys)}
                      />
                    </div>
                    <div className="max-h-40 space-y-1 overflow-y-auto rounded-md border border-slate-200 p-1">
                      {visibleCheckers.length === 0 ? (
                        <p className="px-2 py-4 text-center text-xs text-slate-500">
                          {checkerSearch
                            ? '未找到匹配的在职人员'
                            : '暂无可选在职人员'}
                        </p>
                      ) : (
                        visibleCheckers.map((candidate, candidateIndex) => {
                          const checked = draft.checkerKeys.includes(
                            candidate.key,
                          );
                          const checkboxId = `weather-guard-checker-${candidateIndex}`;
                          return (
                            <Label
                              key={candidate.key}
                              htmlFor={checkboxId}
                              className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-sm font-normal hover:bg-slate-50"
                            >
                              <Checkbox
                                id={checkboxId}
                                name="weather-guard-checkers"
                                checked={checked}
                                disabled={controlsDisabled}
                                onCheckedChange={() => {
                                  updateDraft(
                                    (current) => ({
                                      ...current,
                                      checkerKeys:
                                        toggleWeatherGuardRegistrationCandidateKey(
                                          current.checkerKeys,
                                          candidate.key,
                                          eligibleCheckers,
                                        ),
                                    }),
                                    'checkerKeys',
                                  );
                                }}
                              />
                              <span className="min-w-0 flex-1 break-words [overflow-wrap:anywhere]">
                                <span className="block">{candidate.name}</span>
                                <span className="block text-xs text-slate-500">
                                  {candidate.position || '岗位未标注'} ·{' '}
                                  {formatWeatherGuardCandidateBuildings(
                                    candidate.buildings,
                                  )}
                                </span>
                              </span>
                            </Label>
                          );
                        })
                      )}
                    </div>
                    <RegistrationFieldError message={fieldErrors.checkerKeys} />
                  </fieldset>
                  <p className="self-start rounded-md bg-slate-50 px-2.5 py-2 text-xs leading-5 text-slate-500">
                    机房经理由系统按在职人员角色自动关联，无需选择。
                  </p>
                </div>
              </section>

              <div className="grid gap-3 md:grid-cols-2">
                {checkDefinitions.map((definition) => (
                  <RegistrationCheckCard
                    key={definition.key}
                    definition={definition}
                    draft={draft}
                    evidence={evidence}
                    preview={
                      definition.evidenceField
                        ? previews[definition.evidenceField]
                        : null
                    }
                    errors={fieldErrors}
                    disabled={controlsDisabled}
                    evidenceDisabled={evidenceControlsDisabled}
                    acceptedImageTypes={options.acceptedImageTypes}
                    maxImageBytes={options.maxImageBytes}
                    onStatusChange={(status) =>
                      handleStatusChange(definition, status)
                    }
                    onDescriptionChange={(description) =>
                      updateDraft(
                        (current) => ({
                          ...current,
                          [definition.abnormalDescriptionField]: description,
                        }),
                        definition.abnormalDescriptionField,
                      )
                    }
                    onEvidenceChange={handleEvidenceChange}
                    onEvidenceRemove={handleEvidenceRemove}
                  />
                ))}
              </div>
            </div>
          )}
        </div>

        <DialogFooter className="sticky bottom-0 shrink-0 border-t border-slate-100 bg-white px-5 py-3">
          {phase === 'succeeded' ? (
            <Button type="button" onClick={() => handleOpenChange(false)}>
              完成
            </Button>
          ) : (
            <>
              <Button
                type="button"
                variant="outline"
                onClick={() => handleOpenChange(false)}
              >
                取消
              </Button>
              <Button
                type="button"
                disabled={
                  !options || !draft || isSubmitting || submissionLockConflict
                }
                onClick={() => void handleSubmit()}
              >
                {(phase === 'failed' || submissionLocked) && options
                  ? '按同一操作号重试'
                  : '提交登记'}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const EVIDENCE_FIELDS: readonly WeatherGuardRegistrationEvidenceField[] = [
  'deviceEvidence',
  'disasterEvidence',
  'environmentEvidence',
];

export function getSelectedWeatherGuardRegistrationEvidenceIssues(
  evidence: WeatherGuardRegistrationEvidence,
  environmentRequired: boolean,
  constraints: WeatherGuardRegistrationEvidenceConstraints,
): WeatherGuardRegistrationEvidenceIssue[] {
  const selectedFields = new Set(
    EVIDENCE_FIELDS.filter((field) => evidence[field] !== null),
  );
  return validateWeatherGuardRegistrationEvidence(
    evidence,
    environmentRequired,
    constraints,
  ).filter(({ field }) => selectedFields.has(field));
}

function RegistrationFieldError({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <p className="text-xs text-red-600" role="alert">
      {message}
    </p>
  );
}

interface RegistrationCheckCardProps {
  definition: WeatherGuardCheckDefinition;
  draft: WeatherGuardRegistrationDraft;
  evidence: WeatherGuardRegistrationEvidence;
  preview: string | null;
  errors: RegistrationFieldErrors;
  disabled: boolean;
  evidenceDisabled: boolean;
  acceptedImageTypes: readonly string[];
  maxImageBytes: number;
  onStatusChange: (status: WeatherGuardRegistrationStatus) => void;
  onDescriptionChange: (description: string) => void;
  onEvidenceChange: (
    field: WeatherGuardRegistrationEvidenceField,
    event: ChangeEvent<HTMLInputElement>,
  ) => void;
  onEvidenceRemove: (field: WeatherGuardRegistrationEvidenceField) => void;
}

function RegistrationCheckCard({
  definition,
  draft,
  evidence,
  preview,
  errors,
  disabled,
  evidenceDisabled,
  acceptedImageTypes,
  maxImageBytes,
  onStatusChange,
  onDescriptionChange,
  onEvidenceChange,
  onEvidenceRemove,
}: RegistrationCheckCardProps) {
  const status = draft[definition.statusField];
  const description = draft[definition.abnormalDescriptionField];
  const file = definition.evidenceField
    ? evidence[definition.evidenceField]
    : null;
  const statusError = errors[definition.statusField];
  const descriptionError = errors[definition.abnormalDescriptionField];
  const evidenceError = definition.evidenceField
    ? errors[definition.evidenceField]
    : undefined;
  const descriptionId = `weather-guard-${definition.key}-abnormal-description`;
  const evidenceInputId = `weather-guard-${definition.key}-evidence`;

  return (
    <section
      className="rounded-lg border border-slate-200 bg-white p-4"
      data-registration-field={definition.statusField}
      tabIndex={-1}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-slate-900">
            {definition.title}
          </h3>
          <p className="mt-0.5 text-xs text-slate-500">
            {definition.description}
          </p>
        </div>
        {definition.evidenceField ? (
          <FileImage
            className="h-4 w-4 shrink-0 text-blue-600"
            aria-hidden="true"
          />
        ) : (
          <UserCheck
            className="h-4 w-4 shrink-0 text-blue-600"
            aria-hidden="true"
          />
        )}
      </div>

      <div
        className="mt-3 grid grid-cols-2 gap-2"
        role="group"
        aria-label={`${definition.title}检查状态`}
      >
        {(['正常', '异常'] as const).map((candidate) => {
          const selected = status === candidate;
          return (
            <Button
              key={candidate}
              type="button"
              data-registration-control={
                candidate === '正常' ? definition.statusField : undefined
              }
              size="sm"
              variant="outline"
              disabled={disabled}
              aria-pressed={selected}
              className={cn(
                selected && candidate === '正常'
                  ? 'border-emerald-300 bg-emerald-50 text-emerald-800 hover:bg-emerald-50'
                  : '',
                selected && candidate === '异常'
                  ? 'border-red-300 bg-red-50 text-red-800 hover:bg-red-50'
                  : '',
              )}
              onClick={() => onStatusChange(candidate)}
            >
              {candidate}
            </Button>
          );
        })}
      </div>
      <RegistrationFieldError message={statusError} />

      {status === '异常' && (
        <div
          className="mt-3 space-y-1.5"
          data-registration-field={definition.abnormalDescriptionField}
          tabIndex={-1}
        >
          <Label htmlFor={descriptionId}>{definition.title}异常说明</Label>
          <Textarea
            id={descriptionId}
            name={descriptionId}
            autoComplete="off"
            data-registration-control={definition.abnormalDescriptionField}
            value={description}
            disabled={disabled}
            rows={3}
            placeholder="说明异常位置、现象与已采取措施…"
            aria-label={`${definition.title}异常说明`}
            aria-invalid={Boolean(descriptionError)}
            onChange={(event) => onDescriptionChange(event.target.value)}
          />
          <RegistrationFieldError message={descriptionError} />
        </div>
      )}

      {definition.evidenceField && (
        <div
          className="mt-3 space-y-2"
          data-registration-field={definition.evidenceField}
          tabIndex={-1}
        >
          <div className="flex items-center justify-between gap-2">
            <Label htmlFor={evidenceInputId}>{definition.title}检查附件</Label>
            <span className="text-[11px] text-slate-500">
              {formatAcceptedImageTypes(acceptedImageTypes)} · 不超过{' '}
              {formatFileSize(maxImageBytes)}
            </span>
          </div>
          <label
            htmlFor={evidenceInputId}
            className={cn(
              'flex min-h-20 cursor-pointer items-center justify-center rounded-md border border-dashed border-slate-300 bg-slate-50 px-3 py-3 text-center text-sm text-slate-600 transition-colors hover:border-blue-300 hover:bg-blue-50/40 focus-within:border-blue-400 focus-within:ring-2 focus-within:ring-blue-500 focus-within:ring-offset-2 motion-reduce:transition-none',
              evidenceDisabled && 'cursor-not-allowed opacity-60',
            )}
          >
            <input
              id={evidenceInputId}
              name={definition.evidenceField}
              data-registration-control={definition.evidenceField}
              className="sr-only"
              type="file"
              accept={acceptedImageTypes.join(',')}
              disabled={evidenceDisabled}
              aria-label={`选择${definition.title}检查附件`}
              onChange={(event) =>
                onEvidenceChange(definition.evidenceField!, event)
              }
            />
            <span className="flex flex-col items-center gap-1">
              <FileUp className="h-5 w-5 text-blue-600" aria-hidden="true" />
              {file ? '替换检查附件' : '选择一份检查附件'}
            </span>
          </label>

          {file && (
            <div className="flex items-center gap-3 rounded-md border border-slate-200 p-2">
              {preview ? (
                <img
                  src={preview}
                  alt={`${definition.title}检查图片预览`}
                  width={56}
                  height={56}
                  loading="lazy"
                  className="h-14 w-14 shrink-0 rounded-md object-cover"
                />
              ) : (
                <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-md bg-slate-100">
                  {file.type === 'application/pdf' ? (
                    <FileText
                      className="h-5 w-5 text-red-500"
                      aria-hidden="true"
                    />
                  ) : (
                    <FileImage
                      className="h-5 w-5 text-slate-500"
                      aria-hidden="true"
                    />
                  )}
                </div>
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-slate-800">
                  {file.name}
                </p>
                <p className="text-xs text-slate-500">
                  {formatFileSize(file.size)}
                </p>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                disabled={evidenceDisabled}
                aria-label={`删除${definition.title}检查附件`}
                onClick={() => onEvidenceRemove(definition.evidenceField!)}
              >
                <Trash2 className="h-4 w-4" aria-hidden="true" />
              </Button>
            </div>
          )}
          <RegistrationFieldError message={evidenceError} />
        </div>
      )}
    </section>
  );
}

function validateDraftAgainstOptions(
  draft: WeatherGuardRegistrationDraft,
  options: WeatherGuardRegistrationOptions,
  environmentRequired = options.environmentRequired,
): WeatherGuardRegistrationValidationIssue[] {
  const issues = validateWeatherGuardRegistrationDraft(
    draft,
    environmentRequired,
  );
  const allowedCheckerKeys = new Set(
    filterWeatherGuardRegistrationCandidates(
      options.checkers,
      '',
      draft.building,
    ).map(({ key }) => key),
  );
  if (
    draft.checkerKeys.some(
      (candidateKey) => !allowedCheckerKeys.has(candidateKey),
    )
  ) {
    issues.push({
      field: 'checkerKeys',
      message: '检查人候选项已变更，请重新选择',
    });
  }
  if (!draft.building || !options.buildings.includes(draft.building)) {
    issues.push({
      field: 'building',
      message: '楼栋候选项已变更，请重新选择',
    });
  }
  return deduplicateValidationIssues(issues);
}

function createRegistrationFieldErrors(
  draftIssues: readonly WeatherGuardRegistrationValidationIssue[],
  evidenceIssues: readonly WeatherGuardRegistrationEvidenceIssue[],
): RegistrationFieldErrors {
  const errors: RegistrationFieldErrors = {};
  for (const issue of [...draftIssues, ...evidenceIssues]) {
    if (!errors[issue.field]) errors[issue.field] = issue.message;
  }
  return errors;
}

function sanitizeDraftForOptions(
  draft: WeatherGuardRegistrationDraft,
  options: WeatherGuardRegistrationOptions,
): WeatherGuardRegistrationDraft {
  const building =
    draft.building && options.buildings.includes(draft.building)
      ? draft.building
      : null;
  const eligibleCheckers = filterWeatherGuardRegistrationCandidates(
    options.checkers,
    '',
    building,
  );
  const checkerKeys = toggleWeatherGuardRegistrationCandidateKey(
    draft.checkerKeys,
    '',
    eligibleCheckers,
  );
  return {
    ...draft,
    building,
    checkerKeys,
    ...(options.environmentRequired
      ? {}
      : {
          environmentStatus: null,
          environmentAbnormalDescription: '',
        }),
  };
}

function assertRegistrationOptions(
  options: WeatherGuardRegistrationOptions,
  expectedWarningId: string,
): void {
  if (
    !options ||
    options.warning?.id !== expectedWarningId ||
    options.warning.guardLevel !== options.guardLevel ||
    !isCanonicalIsoTimestamp(options.dataUpdatedAt) ||
    typeof options.environmentRequired !== 'boolean' ||
    !Array.isArray(options.buildings) ||
    !Array.isArray(options.checkers) ||
    !options.checkers.every((candidate) =>
      isRegistrationPersonOption(candidate, options.buildings),
    ) ||
    new Set(options.checkers.map(({ key }) => key)).size !==
      options.checkers.length ||
    !isCanonicalIsoTimestamp(options.personnelSyncedAt) ||
    typeof options.personnelStale !== 'boolean' ||
    !Array.isArray(options.acceptedImageTypes) ||
    options.acceptedImageTypes.length === 0 ||
    !options.acceptedImageTypes.every(
      (type) =>
        typeof type === 'string' &&
        Object.prototype.hasOwnProperty.call(IMAGE_TYPE_LABELS, type),
    ) ||
    !Number.isSafeInteger(options.maxImageBytes) ||
    options.maxImageBytes <= 0
  ) {
    throw new Error('服务端返回的预警与戒备信息不一致，请重试。');
  }
}

function isRegistrationPersonOption(
  value: unknown,
  allowedBuildings: readonly WeatherWarningBuilding[],
): value is WeatherGuardRegistrationPersonOption {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<WeatherGuardRegistrationPersonOption>;
  return (
    typeof candidate.key === 'string' &&
    candidate.key.length > 0 &&
    candidate.key === candidate.key.trim() &&
    typeof candidate.name === 'string' &&
    candidate.name.trim().length > 0 &&
    typeof candidate.position === 'string' &&
    Array.isArray(candidate.buildings) &&
    candidate.buildings.every((building) => allowedBuildings.includes(building))
  );
}

function isCanonicalIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;
  const milliseconds = Date.parse(value);
  return (
    Number.isFinite(milliseconds) &&
    new Date(milliseconds).toISOString() === value
  );
}

function formatRegistrationDataUpdatedAt(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(value));
}

function formatWeatherGuardCandidateBuildings(
  buildings: readonly WeatherWarningBuilding[],
): string {
  return buildings.length > 0 ? buildings.join('、') : '未标注机楼';
}

function areRegistrationDraftsEqual(
  first: WeatherGuardRegistrationDraft,
  second: WeatherGuardRegistrationDraft,
): boolean {
  return JSON.stringify(first) === JSON.stringify(second);
}

function deduplicateValidationIssues(
  issues: readonly WeatherGuardRegistrationValidationIssue[],
): WeatherGuardRegistrationValidationIssue[] {
  const fields = new Set<string>();
  return issues.filter(({ field }) => {
    if (fields.has(field)) return false;
    fields.add(field);
    return true;
  });
}

function focusRegistrationField(field?: RegistrationField): void {
  if (!field || typeof document === 'undefined') return;
  const target = document.querySelector<HTMLElement>(
    `[data-registration-control="${field}"]`,
  );
  if (!target) return;
  const reducedMotion =
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  target.focus({ preventScroll: true });
  target.scrollIntoView({
    behavior: reducedMotion ? 'auto' : 'smooth',
    block: 'center',
  });
}

function formatFileSize(size: number): string {
  if (!Number.isFinite(size) || size <= 0) return '未知大小';
  if (size >= 1024 * 1024) {
    return `${(size / (1024 * 1024)).toFixed(1)} MiB`;
  }
  return `${Math.max(1, Math.ceil(size / 1024))} KiB`;
}

function formatAcceptedImageTypes(
  acceptedImageTypes: readonly string[],
): string {
  return acceptedImageTypes
    .map((type) => IMAGE_TYPE_LABELS[type] ?? type)
    .join('/');
}

function getWeatherGuardRegistrationEvidenceConstraints(
  options: WeatherGuardRegistrationOptions,
): WeatherGuardRegistrationEvidenceConstraints {
  return {
    acceptedImageTypes: options.acceptedImageTypes,
    maxImageBytes: options.maxImageBytes,
  };
}

function getWarningColorLabel(color: string): string {
  return (
    {
      red: '红',
      orange: '橙',
      yellow: '黄',
      blue: '蓝',
    }[color] ?? color
  );
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}
