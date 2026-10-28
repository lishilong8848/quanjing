import { accessBuildings } from '@shared/building-access';
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ChevronLeft,
  ChevronRight,
  ClipboardPlus,
  Copy,
  FileCheck2,
  Loader2,
  PackageSearch,
  Paperclip,
  Plus,
  Save,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import { toast } from 'sonner';

import { useAccess } from '@/access/AccessProvider';
import { purchaseUiPrincipal, purchaseUiPrincipalKey } from './purchase-ui-principal';
import { businessBuildingsForAction, isProfessionalBusinessPrincipal } from '@shared/business-permissions';
import { canManageProfessionalRecord } from '@shared/professional-access';
import { hasAuthenticatedAccessIdentity } from '@/access/access-policy';
import { resolveSelfServiceApplicant } from '@shared/self-service-applicant';
import {
  getPurchaseApplicationSubmissionTaskStatus,
  getPurchaseApplicationOptions,
  searchPurchaseApplicationApplicants,
  searchPurchaseApplicationCatalog,
  submitPurchaseApplications,
} from '@/api';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
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
import type {
  PurchaseApplicationApplicant,
  PurchaseApplicationBatchRequest,
  PurchaseApplicationCatalogItem,
  PurchaseApplicationItemInput,
  PurchaseApplicationOptionsResponse,
  PurchaseApplicationSharedInput,
  PurchaseApplicationSubmitResponse,
  PurchaseApplicationValidationIssue,
} from '@shared/purchase-application.interface';
import {
  applyProcurementFormSelection,
  buildPurchaseApplicationSubmissionFingerprint,
  buildPurchaseApplicationRetryDraft,
  calculateDraftTotals,
  changePurchaseChannel,
  clearPurchaseApplicationSubmissionJournal,
  clearDraft,
  createBlankDraft,
  createBlankItem,
  duplicateItem,
  groupValidationIssues,
  isUncertainPurchaseSubmissionError,
  loadPurchaseApplicationSubmissionJournal,
  loadDraft,
  matchesPurchaseApplicationAttachmentManifest,
  normalizePurchaseQuantityInput,
  reconnectPurchaseApplicationAcceptance,
  removeItem,
  savePurchaseApplicationSubmissionJournal,
  saveDraft,
  selectPurchaseComparisonFiles,
  scopePurchaseApplicationDraft,
  validatePurchaseApplicationForUi,
  type GroupedValidationIssues,
  type PurchaseApplicationSubmissionJournal,
} from './purchase-application.logic';
import { PurchasePrincipalRequestGate } from './purchase-principal-request-gate';

const EMPTY_ERRORS: GroupedValidationIssues = {
  shared: {},
  items: {},
  general: [],
};
const SUBMISSION_TASK_POLL_INTERVAL_MS = 750;
const SUBMISSION_TASK_POLL_TIMEOUT_MS = 3 * 60 * 1000;
const SUBMISSION_TASK_SLOW_POLL_INTERVAL_MS = 15 * 1000;
const SUBMISSION_TASK_MAX_QUERY_FAILURES = 4;

interface PurchaseApplicationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmissionStarted: (
    mutationId: string,
    request: PurchaseApplicationBatchRequest,
  ) => void;
  onSubmissionSettled: (
    mutationId: string,
    result: PurchaseApplicationSubmitResponse | null,
  ) => Promise<boolean> | boolean;
}

export function PurchaseApplicationDialog({
  open,
  onOpenChange,
  onSubmissionStarted,
  onSubmissionSettled,
}: PurchaseApplicationDialogProps) {
  const access = useAccess();
  const { role, principalFingerprint, accountId, displayName } = access;
  const authenticated = hasAuthenticatedAccessIdentity(access);
  const applicantIdentity = useMemo(() => resolveSelfServiceApplicant(access, authenticated, '提交采购申请'),
    [role, accountId, displayName, authenticated, principalFingerprint]);
  const principal = useMemo(
    () => purchaseUiPrincipal(access),
    [access],
  );
  const scope = isProfessionalBusinessPrincipal({...principal,permissionContext:{module:'purchase',action:'create'}})
    ? businessBuildingsForAction(principal,{module:'purchase',action:'create'}) : accessBuildings(principal);
  const fixedBuilding = scope?.length === 1 ? scope[0] : null;
  const [draft, setDraft] = useState<PurchaseApplicationBatchRequest>(() =>
    createBlankDraft(),
  );
  const [options, setOptions] =
    useState<PurchaseApplicationOptionsResponse | null>(null);
  const [referenceLoading, setReferenceLoading] = useState(false);
  const [referenceError, setReferenceError] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [errors, setErrors] = useState<GroupedValidationIssues>(EMPTY_ERRORS);
  const [submitting, setSubmitting] = useState(false);
  const [backgroundPending, setBackgroundPending] = useState(false);
  const [recoveryJournal, setRecoveryJournal] =
    useState<PurchaseApplicationSubmissionJournal | null>(null);
  const [uncertainResolution, setUncertainResolution] = useState<
    'found' | 'missing' | null
  >(null);
  const [resolvingUncertain, setResolvingUncertain] = useState(false);
  const submissionInFlightRef = useRef(false);
  const retryMutationIdRef =
    useRef<PurchaseApplicationSubmissionJournal | null>(null);
  const recoveryJournalRef =
    useRef<PurchaseApplicationSubmissionJournal | null>(null);
  const monitoredTaskIdRef = useRef<string | null>(null);
  const acceptanceRecoveryMutationIdRef = useRef<string | null>(null);
  const onSubmissionStartedRef = useRef(onSubmissionStarted);
  const onSubmissionSettledRef = useRef(onSubmissionSettled);
  const [mobileItemIndex, setMobileItemIndex] = useState(0);
  const [catalogResults, setCatalogResults] = useState<
    Record<string, PurchaseApplicationCatalogItem[]>
  >({});
  const [catalogLoading, setCatalogLoading] = useState<Record<string, boolean>>(
    {},
  );
  const [applicantQuery, setApplicantQuery] = useState('');
  const [applicantResults, setApplicantResults] = useState<
    PurchaseApplicationApplicant[]
  >([]);
  const [applicantLoading, setApplicantLoading] = useState(false);
  const [applicantIdentityError, setApplicantIdentityError] = useState('');
  const [applicantIdentityRevision, setApplicantIdentityRevision] = useState(0);
  const singleReasonFieldId = React.useId();
  const singleReasonErrorId = `${singleReasonFieldId}-error`;
  const requirementSummaryFieldId = React.useId();
  const requirementSummaryErrorId = `${requirementSummaryFieldId}-error`;
  const notesFieldId = React.useId();
  const comparisonAttachmentFieldId = React.useId();
  const comparisonAttachmentErrorId = `${comparisonAttachmentFieldId}-error`;
  const searchTimers = useRef<Map<string, number>>(new Map());
  const searchSequence = useRef<Map<string, number>>(new Map());
  const catalogSearchKeyRef = useRef<Map<string, string>>(new Map());
  const applicantSearchTimer = useRef<number | null>(null);
  const applicantSearchSequence = useRef(0);
  onSubmissionStartedRef.current = onSubmissionStarted;
  onSubmissionSettledRef.current = onSubmissionSettled;
  recoveryJournalRef.current = recoveryJournal;
  const principalIdentityKey = `${purchaseUiPrincipalKey(principal)}:${displayName || ''}`;
  const [principalRequestGate] = useState(
    () => new PurchasePrincipalRequestGate(principalIdentityKey),
  );
  const principalGeneration =
    principalRequestGate.syncPrincipal(principalIdentityKey);
  const effectiveBuilding = fixedBuilding || draft.shared.building;
  const draftRef = useRef(draft);
  const effectiveBuildingRef = useRef(effectiveBuilding);
  draftRef.current = draft;
  effectiveBuildingRef.current = effectiveBuilding;

  const loadReferenceData = useCallback(
    async (requestGeneration = principalRequestGate.capture()) => {
      setReferenceLoading(true);
      setReferenceError('');
      try {
        const nextOptions = await getPurchaseApplicationOptions();
        if (!principalRequestGate.isCurrent(requestGeneration)) {
          return;
        }
        setOptions(nextOptions);
      } catch {
        if (!principalRequestGate.isCurrent(requestGeneration)) {
          return;
        }
        setReferenceError('采购选项加载失败，请检查网络后重试');
      } finally {
        if (principalRequestGate.isCurrent(requestGeneration)) {
          setReferenceLoading(false);
        }
      }
    },
    [principalRequestGate],
  );

  const startTaskMonitoring = useCallback(
    (
      journal: PurchaseApplicationSubmissionJournal,
      requestGeneration = principalRequestGate.capture(),
    ) => {
      if (!journal.taskId) return;
      if (monitoredTaskIdRef.current === journal.taskId) {
        toast.info('正在继续确认原采购申请，请勿重复提交');
        return;
      }
      monitoredTaskIdRef.current = journal.taskId;
      submissionInFlightRef.current = true;
      setBackgroundPending(true);
      void monitorPurchaseApplicationTask(
        journal.taskId,
        async (result) => {
          if (!principalRequestGate.isCurrent(requestGeneration)) return;
          await onSubmissionSettledRef.current(journal.mutationId, result);
          if (!principalRequestGate.isCurrent(requestGeneration)) return;
          clearPurchaseApplicationSubmissionJournal(principal);
          retryMutationIdRef.current = null;
          recoveryJournalRef.current = null;
          setRecoveryJournal(null);
          setUncertainResolution(null);
          setBackgroundPending(false);
          monitoredTaskIdRef.current = null;
          if (result.success) {
            clearDraft(principal);
            setDraft(createBlankDraft(fixedBuilding));
            setFiles([]);
            if (result.warnings.length) {
              toast.warning(result.message, {
                description: result.warnings
                  .map((item) => item.message)
                  .join('；'),
              });
            } else {
              toast.success(result.message);
            }
          } else {
            const submitIssues = [...result.failed, ...result.warnings];
            const retryDraft = buildPurchaseApplicationRetryDraft(
              journal.request,
              result.failed.map((item) => item.lineId),
            );
            setDraft(retryDraft);
            saveDraft(retryDraft, principal);
            toast.warning(result.message, {
              description: submitIssues.map((item) => item.message).join('；'),
            });
          }
          submissionInFlightRef.current = false;
          setSubmitting(false);
        },
        async (message) => {
          if (!principalRequestGate.isCurrent(requestGeneration)) return;
          await onSubmissionSettledRef.current(journal.mutationId, null);
          if (!principalRequestGate.isCurrent(requestGeneration)) return;
          clearPurchaseApplicationSubmissionJournal(principal);
          retryMutationIdRef.current = null;
          recoveryJournalRef.current = null;
          setRecoveryJournal(null);
          setUncertainResolution(null);
          toast.error(message);
          submissionInFlightRef.current = false;
          monitoredTaskIdRef.current = null;
          setBackgroundPending(false);
          setSubmitting(false);
        },
        (message) => {
          if (!principalRequestGate.isCurrent(requestGeneration)) return;
          toast.warning(message);
        },
        (message) => {
          if (!principalRequestGate.isCurrent(requestGeneration)) return;
          const uncertainJournal: PurchaseApplicationSubmissionJournal = {
            ...journal,
            status: 'uncertain',
            updatedAt: new Date().toISOString(),
          };
          savePurchaseApplicationSubmissionJournal(uncertainJournal, principal);
          retryMutationIdRef.current = uncertainJournal;
          recoveryJournalRef.current = uncertainJournal;
          setRecoveryJournal(uncertainJournal);
          setUncertainResolution(null);
          submissionInFlightRef.current = false;
          monitoredTaskIdRef.current = null;
          setBackgroundPending(false);
          setSubmitting(false);
          toast.warning(message, {
            description:
              '系统不会重复提交；请核对申请清单，或联系管理员确认飞书写入结果。',
          });
        },
        () => principalRequestGate.isCurrent(requestGeneration),
      );
    },
    [fixedBuilding, principal, principalRequestGate],
  );

  const startAcceptanceRecovery = useCallback(
    (
      journal: PurchaseApplicationSubmissionJournal,
      requestGeneration = principalRequestGate.capture(),
    ) => {
      if (journal.taskId) {
        startTaskMonitoring(journal, requestGeneration);
        return;
      }
      if (acceptanceRecoveryMutationIdRef.current === journal.mutationId) {
        toast.info('正在使用原申请编号自动找回受理任务');
        return;
      }
      acceptanceRecoveryMutationIdRef.current = journal.mutationId;
      submissionInFlightRef.current = true;
      setSubmitting(false);
      setBackgroundPending(true);
      void (async () => {
        const outcome = await reconnectPurchaseApplicationAcceptance({
          reconnect: () =>
            submitPurchaseApplications(
              journal.request,
              [],
              journal.mutationId,
              journal.fingerprint,
            ),
        });
        if (
          !principalRequestGate.isCurrent(requestGeneration) ||
          acceptanceRecoveryMutationIdRef.current !== journal.mutationId ||
          recoveryJournalRef.current?.mutationId !== journal.mutationId
        ) {
          return;
        }
        acceptanceRecoveryMutationIdRef.current = null;
        if (outcome.kind === 'accepted') {
          const acceptedJournal: PurchaseApplicationSubmissionJournal = {
            ...journal,
            status: 'accepted',
            taskId: outcome.accepted.taskId,
            updatedAt: new Date().toISOString(),
          };
          savePurchaseApplicationSubmissionJournal(acceptedJournal, principal);
          retryMutationIdRef.current = acceptedJournal;
          recoveryJournalRef.current = acceptedJournal;
          setRecoveryJournal(acceptedJournal);
          toast.info('已自动找回原采购申请任务，继续确认后台同步');
          startTaskMonitoring(acceptedJournal, requestGeneration);
          return;
        }
        if (outcome.kind === 'definitely-not-written') {
          await onSubmissionSettledRef.current(journal.mutationId, null);
          if (!principalRequestGate.isCurrent(requestGeneration)) return;
          clearPurchaseApplicationSubmissionJournal(principal);
          retryMutationIdRef.current = null;
          recoveryJournalRef.current = null;
          setRecoveryJournal(null);
          saveDraft(journal.request, principal);
          setDraft(journal.request);
          setApplicantQuery(journal.request.shared.applicantName || '');
          toast.error(outcome.message);
        } else {
          const uncertainJournal: PurchaseApplicationSubmissionJournal = {
            ...journal,
            status: 'uncertain',
            updatedAt: new Date().toISOString(),
          };
          savePurchaseApplicationSubmissionJournal(uncertainJournal, principal);
          retryMutationIdRef.current = uncertainJournal;
          recoveryJournalRef.current = uncertainJournal;
          setRecoveryJournal(uncertainJournal);
          toast.warning('原申请受理结果仍未确认，已保留原编号', {
            description: `${outcome.message}；可使用原编号再次查询，系统不会生成新编号。`,
          });
        }
        submissionInFlightRef.current = false;
        setBackgroundPending(false);
        setSubmitting(false);
      })().catch((error) => {
        if (
          !principalRequestGate.isCurrent(requestGeneration) ||
          recoveryJournalRef.current?.mutationId !== journal.mutationId
        ) {
          return;
        }
        const uncertainJournal: PurchaseApplicationSubmissionJournal = {
          ...journal,
          status: 'uncertain',
          updatedAt: new Date().toISOString(),
        };
        acceptanceRecoveryMutationIdRef.current = null;
        savePurchaseApplicationSubmissionJournal(uncertainJournal, principal);
        retryMutationIdRef.current = uncertainJournal;
        recoveryJournalRef.current = uncertainJournal;
        setRecoveryJournal(uncertainJournal);
        submissionInFlightRef.current = false;
        setBackgroundPending(false);
        setSubmitting(false);
        toast.warning('原申请自动找回未完成，已保留原编号', {
          description: readErrorMessage(error, '请使用原编号再次查询'),
        });
      });
    },
    [principal, principalRequestGate, startTaskMonitoring],
  );

  useEffect(() => {
    searchTimers.current.forEach((timer) => window.clearTimeout(timer));
    searchTimers.current.clear();
    searchSequence.current.clear();
    catalogSearchKeyRef.current.clear();
    if (applicantSearchTimer.current) {
      window.clearTimeout(applicantSearchTimer.current);
      applicantSearchTimer.current = null;
    }
    applicantSearchSequence.current += 1;
    setOptions(null);
    setReferenceError('');
    setReferenceLoading(false);
    setSubmitting(false);
    setBackgroundPending(false);
    submissionInFlightRef.current = false;
    retryMutationIdRef.current = null;
    recoveryJournalRef.current = null;
    monitoredTaskIdRef.current = null;
    acceptanceRecoveryMutationIdRef.current = null;
    setRecoveryJournal(null);
    setUncertainResolution(null);
    setResolvingUncertain(false);
    setFiles([]);
    setApplicantResults([]);
    setApplicantLoading(false);
    setCatalogResults({});
    setCatalogLoading({});
    const journal = loadPurchaseApplicationSubmissionJournal(principal);
    if (!journal) return;
    retryMutationIdRef.current = journal;
    recoveryJournalRef.current = journal;
    setRecoveryJournal(journal);
    setDraft(journal.request);
    setApplicantQuery(journal.request.shared.applicantName || '');
    onSubmissionStartedRef.current(journal.mutationId, journal.request);
    if (journal.taskId) {
      startTaskMonitoring(journal, principalGeneration);
    } else {
      startAcceptanceRecovery(journal, principalGeneration);
    }
  }, [
    principal,
    principalGeneration,
    startAcceptanceRecovery,
    startTaskMonitoring,
  ]);

  useEffect(() => {
    if (!open) return;
    const restoredDraft =
      recoveryJournalRef.current?.request ||
      loadDraft(principal) ||
      createBlankDraft(fixedBuilding);
    const scopedDraft = scopePurchaseApplicationDraft(principal, restoredDraft);
    setDraft(scopedDraft);
    setApplicantQuery(scopedDraft.shared.applicantName || '');
    setApplicantResults([]);
    setErrors(EMPTY_ERRORS);
    setMobileItemIndex(0);
    setCatalogResults({});
    void loadReferenceData(principalGeneration);
  }, [fixedBuilding, loadReferenceData, open, principal, principalGeneration]);

  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => saveDraft(draft, principal), 500);
    return () => window.clearTimeout(timer);
  }, [draft, open, principal]);

  useEffect(() => {
    if (!open || access.isLoading) return;
    setApplicantIdentityError('');
    if (applicantIdentity.mode === 'login') {
      onOpenChange(false);
      access.requestLogin(applicantIdentity.message);
      return;
    }
    if (applicantIdentity.mode !== 'automatic') return;
    const requestGeneration = principalRequestGate.capture();
    const sequence = ++applicantSearchSequence.current;
    const requestedBuilding = effectiveBuilding;
    let disposed = false;
    setApplicantLoading(true);
    void searchPurchaseApplicationApplicants({ building: requestedBuilding, query: applicantIdentity.name, limit: 1, self: true })
      .then(results => {
        if (disposed || !principalRequestGate.isCurrent(requestGeneration) || applicantSearchSequence.current !== sequence) return;
        const person = results.length === 1 ? results[0] : null;
        if (!person || person.name !== applicantIdentity.name || !person.recordId || !person.openId) {
          throw new Error('登录账号未匹配到采购申请人，请联系管理员核对');
        }
        const journal = recoveryJournalRef.current;
        if (journal) {
          if (journal.request.shared.applicantRecordId !== person.recordId || journal.request.shared.applicantOpenId !== person.openId) {
            throw new Error('恢复的采购申请人不是当前登录本人，请联系管理员处理');
          }
          return;
        }
        selectApplicant(person);
      })
      .catch(error => {
        if (!disposed && principalRequestGate.isCurrent(requestGeneration) && applicantSearchSequence.current === sequence) {
          setApplicantIdentityError(error.response?.data?.message || error.message || '申请人匹配失败，请重试');
        }
      })
      .finally(() => {
        if (!disposed && principalRequestGate.isCurrent(requestGeneration)) setApplicantLoading(false);
      });
    return () => { disposed = true; };
  }, [open, access.isLoading, applicantIdentity, effectiveBuilding, principalGeneration, principalRequestGate, access.requestLogin, onOpenChange, applicantIdentityRevision]);

  useEffect(
    () => () => {
      principalRequestGate.invalidate();
      searchTimers.current.forEach((timer) => window.clearTimeout(timer));
      if (applicantSearchTimer.current) {
        window.clearTimeout(applicantSearchTimer.current);
      }
    },
    [principalRequestGate],
  );

  useEffect(() => {
    setMobileItemIndex((current) =>
      Math.min(current, Math.max(0, draft.items.length - 1)),
    );
  }, [draft.items.length]);

  const totals = useMemo(
    () => calculateDraftTotals(draft.items),
    [draft.items],
  );
  const formLocked =
    submitting || backgroundPending || Boolean(recoveryJournal);
  const recoveryAttachmentSelectionEnabled = Boolean(
    recoveryJournal &&
    !recoveryJournal.taskId &&
    recoveryJournal.attachments.length > 0 &&
    !submitting,
  );
  const attachmentControlsLocked =
    formLocked && !recoveryAttachmentSelectionEnabled;

  function searchApplicant(query: string) {
    setApplicantQuery(query);
    setDraft((current) => ({
      ...current,
      shared: {
        ...current.shared,
        applicantRecordId: '',
        applicantOpenId: '',
        applicantName: '',
        applicantEmployeeNo: '',
        applicantPosition: '',
        applicantBuilding: '',
      },
    }));
    if (applicantSearchTimer.current) {
      window.clearTimeout(applicantSearchTimer.current);
    }
    const sequence = applicantSearchSequence.current + 1;
    applicantSearchSequence.current = sequence;
    if (!query.trim()) {
      setApplicantResults([]);
      setApplicantLoading(false);
      return;
    }

    const requestGeneration = principalRequestGate.capture();
    const requestedBuilding = effectiveBuildingRef.current;
    applicantSearchTimer.current = window.setTimeout(async () => {
      if (!principalRequestGate.isCurrent(requestGeneration)) {
        return;
      }
      setApplicantLoading(true);
      try {
        const results = await searchPurchaseApplicationApplicants({
          building: requestedBuilding,
          query: query.trim(),
          limit: 30,
        });
        if (
          principalRequestGate.isCurrent(requestGeneration) &&
          applicantSearchSequence.current === sequence &&
          effectiveBuildingRef.current === requestedBuilding
        ) {
          setApplicantResults(results);
        }
      } catch {
        if (principalRequestGate.isCurrent(requestGeneration)) {
          toast.error('在职人员搜索失败');
        }
      } finally {
        if (
          principalRequestGate.isCurrent(requestGeneration) &&
          applicantSearchSequence.current === sequence
        ) {
          setApplicantLoading(false);
        }
      }
    }, 300);
  }

  function selectApplicant(applicant: PurchaseApplicationApplicant) {
    applicantSearchSequence.current += 1;
    if (applicantSearchTimer.current) {
      window.clearTimeout(applicantSearchTimer.current);
      applicantSearchTimer.current = null;
    }
    setApplicantLoading(false);
    setApplicantQuery(applicant.name);
    setApplicantResults([]);
    setDraft((current) => ({
      ...current,
      shared: {
        ...current.shared,
        applicantRecordId: applicant.recordId,
        applicantOpenId: applicant.openId,
        applicantName: applicant.name,
        applicantEmployeeNo: applicant.employeeNo,
        applicantPosition: applicant.position,
        applicantBuilding: applicant.building || applicant.specialty,
      },
    }));
    clearSharedError('applicantName');
  }

  function clearApplicant() {
    applicantSearchSequence.current += 1;
    if (applicantSearchTimer.current) {
      window.clearTimeout(applicantSearchTimer.current);
      applicantSearchTimer.current = null;
    }
    setApplicantLoading(false);
    setApplicantQuery('');
    setApplicantResults([]);
    setDraft((current) => ({
      ...current,
      shared: {
        ...current.shared,
        applicantRecordId: '',
        applicantOpenId: '',
        applicantName: '',
        applicantEmployeeNo: '',
        applicantPosition: '',
        applicantBuilding: '',
      },
    }));
  }

  function updateShared<K extends keyof PurchaseApplicationSharedInput>(
    key: K,
    value: PurchaseApplicationSharedInput[K],
  ) {
    if (key === 'building' && fixedBuilding) return;
    setDraft((current) => ({
      ...current,
      shared: { ...current.shared, [key]: value },
    }));
    clearSharedError(key);
  }

  function updateItem<K extends keyof PurchaseApplicationItemInput>(
    lineId: string,
    key: K,
    value: PurchaseApplicationItemInput[K],
  ) {
    setDraft((current) => ({
      ...current,
      items: current.items.map((item) =>
        item.lineId === lineId ? { ...item, [key]: value } : item,
      ),
    }));
    clearItemError(lineId, key);
  }

  function clearSharedError(key: string) {
    setErrors((current) => {
      if (!current.shared[key]) return current;
      const shared = { ...current.shared };
      delete shared[key];
      return { ...current, shared };
    });
  }

  function clearItemError(
    lineId: string,
    key: keyof PurchaseApplicationItemInput,
  ) {
    setErrors((current) => {
      if (!current.items[lineId]?.[key]) return current;
      const fields = { ...current.items[lineId] };
      delete fields[key];
      return { ...current, items: { ...current.items, [lineId]: fields } };
    });
  }

  function changeItemMode(lineId: string, mode: 'existing' | 'new') {
    invalidateCatalogSearch(lineId);
    setDraft((current) => ({
      ...current,
      items: current.items.map((item) =>
        item.lineId === lineId
          ? {
              ...item,
              mode,
              catalogRecordId: '',
              sku: '',
              itemName: '',
              specification: '',
              brand: '',
              unit: '',
            }
          : item,
      ),
    }));
    setCatalogResults((current) => ({ ...current, [lineId]: [] }));
  }

  function searchCatalog(lineId: string, query: string) {
    updateItem(lineId, 'itemName', query);
    updateItem(lineId, 'catalogRecordId', '');
    updateItem(lineId, 'sku', '');
    const existingTimer = searchTimers.current.get(lineId);
    if (existingTimer) window.clearTimeout(existingTimer);
    const sequence = (searchSequence.current.get(lineId) || 0) + 1;
    searchSequence.current.set(lineId, sequence);
    if (!query.trim()) {
      setCatalogResults((current) => ({ ...current, [lineId]: [] }));
      setCatalogLoading((current) => ({ ...current, [lineId]: false }));
      catalogSearchKeyRef.current.delete(lineId);
      return;
    }
    const requestGeneration = principalRequestGate.capture();
    const timer = window.setTimeout(async () => {
      if (!principalRequestGate.isCurrent(requestGeneration)) {
        return;
      }
      const item = draftRef.current.items.find(
        (candidate) => candidate.lineId === lineId,
      );
      if (!item) return;
      const requestKey = buildCatalogSearchKey(
        effectiveBuildingRef.current,
        item,
        query,
      );
      catalogSearchKeyRef.current.set(lineId, requestKey);
      setCatalogLoading((current) => ({ ...current, [lineId]: true }));
      try {
        const result = await searchPurchaseApplicationCatalog({
          building: effectiveBuildingRef.current,
          primaryCategory: item.primaryCategory,
          secondaryCategory: item.secondaryCategory,
          query: query.trim(),
          limit: 50,
        });
        if (
          principalRequestGate.isCurrent(requestGeneration) &&
          searchSequence.current.get(lineId) === sequence &&
          catalogSearchKeyRef.current.get(lineId) === requestKey &&
          buildCatalogSearchKey(
            effectiveBuildingRef.current,
            draftRef.current.items.find(
              (candidate) => candidate.lineId === lineId,
            ),
            draftRef.current.items.find(
              (candidate) => candidate.lineId === lineId,
            )?.itemName || '',
          ) === requestKey
        ) {
          setCatalogResults((current) => ({ ...current, [lineId]: result }));
        }
      } catch {
        if (principalRequestGate.isCurrent(requestGeneration)) {
          toast.error('物品目录搜索失败');
        }
      } finally {
        if (
          principalRequestGate.isCurrent(requestGeneration) &&
          searchSequence.current.get(lineId) === sequence
        ) {
          setCatalogLoading((current) => ({ ...current, [lineId]: false }));
        }
      }
    }, 300);
    searchTimers.current.set(lineId, timer);
  }

  function selectCatalogItem(
    lineId: string,
    catalog: PurchaseApplicationCatalogItem,
  ) {
    invalidateCatalogSearch(lineId);
    setDraft((current) => ({
      ...current,
      items: current.items.map((item) =>
        item.lineId === lineId
          ? {
              ...item,
              catalogRecordId: catalog.recordId,
              sku: catalog.sku,
              primaryCategory: catalog.primaryCategory || item.primaryCategory,
              secondaryCategory:
                catalog.secondaryCategory || item.secondaryCategory,
              itemName: catalog.name,
              specification: catalog.specification,
              brand: catalog.brand,
              unit: catalog.unit,
            }
          : item,
      ),
    }));
    setCatalogResults((current) => ({ ...current, [lineId]: [] }));
    setErrors((current) => {
      const fields = { ...(current.items[lineId] || {}) };
      delete fields.itemName;
      return { ...current, items: { ...current.items, [lineId]: fields } };
    });
  }

  function invalidateCatalogSearch(lineId: string) {
    const timer = searchTimers.current.get(lineId);
    if (timer) window.clearTimeout(timer);
    searchTimers.current.delete(lineId);
    searchSequence.current.set(
      lineId,
      (searchSequence.current.get(lineId) || 0) + 1,
    );
    catalogSearchKeyRef.current.delete(lineId);
    setCatalogLoading((current) => ({ ...current, [lineId]: false }));
  }

  function addItem() {
    if (draft.items.length >= 20) {
      toast.warning('单批最多申请 20 种物品');
      return;
    }
    setDraft((current) => ({
      ...current,
      items: [...current.items, createBlankItem()],
    }));
    setMobileItemIndex(draft.items.length);
  }

  function handleFiles(selected: FileList | null) {
    if (!selected) return;
    const next = recoveryAttachmentSelectionEnabled
      ? Array.from(selected)
      : [...files, ...Array.from(selected)];
    if (next.length > 5) {
      toast.warning('三方比价附件最多上传 5 个');
      return;
    }
    const invalid = next.find(
      (file) =>
        !['application/pdf', 'image/jpeg', 'image/png', 'image/webp'].includes(
          file.type,
        ) || file.size > 20 * 1024 * 1024,
    );
    if (invalid) {
      toast.error(`${invalid.name} 格式不支持或超过 20MB`);
      return;
    }
    if (next.reduce((sum, file) => sum + file.size, 0) > 50 * 1024 * 1024) {
      toast.error('附件总大小不能超过 50MB');
      return;
    }
    setFiles(next);
    clearSharedError('comparisonAttachment');
  }

  async function handleSubmit() {
    if (access.isLoading || applicantLoading || applicantIdentityError || applicantIdentity.mode === 'login' || applicantIdentity.mode === 'error') return;
    if (submissionInFlightRef.current) return;
    const retryState = retryMutationIdRef.current;
    if (retryState?.taskId) {
      startTaskMonitoring(retryState);
      return;
    }
    const currentDraft = scopePurchaseApplicationDraft(principal, draft);
    if (
      retryState &&
      JSON.stringify(currentDraft) !== JSON.stringify(retryState.request)
    ) {
      setDraft(retryState.request);
      saveDraft(retryState.request, principal);
      toast.warning('已恢复上次未确认的原申请，请使用原编号安全重试');
      return;
    }
    const submissionDraft = retryState?.request || currentDraft;
    const selectedFiles = selectPurchaseComparisonFiles(
      submissionDraft.shared.procurementForm,
      files,
    );
    if (
      retryState &&
      !matchesPurchaseApplicationAttachmentManifest(
        selectedFiles,
        retryState.attachments,
      )
    ) {
      toast.warning('请按原顺序重新选择全部原附件后，再使用原编号安全重试', {
        description: retryState.attachments
          .map((attachment) => attachment.name)
          .join('；'),
      });
      return;
    }
    const localIssues = validatePurchaseApplicationForUi(
      submissionDraft,
      selectedFiles.length,
    );
    if (localIssues.length) {
      setErrors(groupValidationIssues(localIssues));
      revealFirstInvalidItem(
        localIssues,
        submissionDraft.items,
        setMobileItemIndex,
      );
      focusFirstInvalidPurchaseField();
      toast.warning('请先补全标红的申请信息');
      return;
    }
    if(!canManageProfessionalRecord(principal,submissionDraft.shared.specialty,submissionDraft.shared.building,{module:'purchase',action:'create'})) {
      toast.error('当前账号未获所选楼栋和专业的采购新增权限');
      return;
    }

    const mutationId =
      retryState?.mutationId || createPurchaseApplicationMutationId();
    submissionInFlightRef.current = true;
    onSubmissionStarted(mutationId, submissionDraft);
    const requestToken = principalRequestGate.capture();
    setSubmitting(true);
    let backgroundAccepted = false;
    let requestDispatched = false;
    try {
      const computed = selectedFiles.length
        ? await buildPurchaseApplicationSubmissionFingerprint(
            submissionDraft,
            selectedFiles,
          )
        : null;
      if (!principalRequestGate.isCurrent(requestToken)) return;
      if (
        retryState &&
        computed &&
        computed.fingerprint !== retryState.fingerprint
      ) {
        toast.error('重新选择的附件与原申请不一致，请选择原附件后重试');
        return;
      }
      const fingerprint =
        retryState?.fingerprint ||
        computed?.fingerprint ||
        (
          await buildPurchaseApplicationSubmissionFingerprint(
            submissionDraft,
            [],
          )
        ).fingerprint;
      if (!principalRequestGate.isCurrent(requestToken)) return;
      const now = new Date().toISOString();
      const journal: PurchaseApplicationSubmissionJournal = {
        version: 1,
        mutationId,
        fingerprint,
        request: submissionDraft,
        attachments: retryState?.attachments || computed?.attachments || [],
        status: 'submitting',
        taskId: null,
        createdAt: retryState?.createdAt || now,
        updatedAt: now,
      };
      savePurchaseApplicationSubmissionJournal(journal, principal);
      retryMutationIdRef.current = journal;
      recoveryJournalRef.current = journal;
      setRecoveryJournal(journal);
      requestDispatched = true;
      const accepted = await submitPurchaseApplications(
        submissionDraft,
        selectedFiles,
        mutationId,
        fingerprint,
      );
      if (!principalRequestGate.isCurrent(requestToken)) return;
      const acceptedJournal: PurchaseApplicationSubmissionJournal = {
        ...journal,
        status: 'accepted',
        taskId: accepted.taskId,
        updatedAt: new Date().toISOString(),
      };
      savePurchaseApplicationSubmissionJournal(acceptedJournal, principal);
      retryMutationIdRef.current = acceptedJournal;
      recoveryJournalRef.current = acceptedJournal;
      setRecoveryJournal(acceptedJournal);
      backgroundAccepted = true;
      setSubmitting(false);
      setBackgroundPending(true);
      saveDraft(submissionDraft, principal);
      toast.success(accepted.message);
      onOpenChange(false);
      startTaskMonitoring(acceptedJournal, requestToken);
    } catch (error) {
      if (!principalRequestGate.isCurrent(requestToken)) return;
      if (requestDispatched && isUncertainPurchaseSubmissionError(error)) {
        const currentJournal = retryMutationIdRef.current;
        if (currentJournal) {
          const uncertainJournal: PurchaseApplicationSubmissionJournal = {
            ...currentJournal,
            status: 'uncertain',
            updatedAt: new Date().toISOString(),
          };
          savePurchaseApplicationSubmissionJournal(uncertainJournal, principal);
          retryMutationIdRef.current = uncertainJournal;
          recoveryJournalRef.current = uncertainJournal;
          setRecoveryJournal(uncertainJournal);
          backgroundAccepted = true;
          setSubmitting(false);
          setBackgroundPending(true);
          toast.info('网络响应未确认，正在使用原申请编号自动找回');
          startAcceptanceRecovery(uncertainJournal, requestToken);
        }
      } else if (retryState && !requestDispatched) {
        toast.error(
          readErrorMessage(error, '附件指纹计算失败，请重新选择原附件'),
        );
      } else {
        await onSubmissionSettled(mutationId, null);
        if (!principalRequestGate.isCurrent(requestToken)) return;
        clearPurchaseApplicationSubmissionJournal(principal);
        retryMutationIdRef.current = null;
        recoveryJournalRef.current = null;
        setRecoveryJournal(null);
        const backendIssues = readBackendIssues(error);
        if (backendIssues.length) {
          setErrors(groupValidationIssues(backendIssues));
          revealFirstInvalidItem(
            backendIssues,
            draft.items,
            setMobileItemIndex,
          );
          focusFirstInvalidPurchaseField();
          toast.error('采购申请内容校验失败');
        } else {
          toast.error(readErrorMessage(error, '采购申请提交失败，请稍后重试'));
        }
      }
    } finally {
      if (!backgroundAccepted && principalRequestGate.isCurrent(requestToken)) {
        submissionInFlightRef.current = false;
        setSubmitting(false);
      }
    }
  }

  function handleRecoveryAction() {
    const journal = recoveryJournalRef.current;
    if (!journal) return;
    if (journal.taskId) {
      startTaskMonitoring(journal);
      return;
    }
    startAcceptanceRecovery(journal);
  }

  async function resolveUncertainSubmission(
    resolution: 'found' | 'missing',
  ): Promise<void> {
    if (resolvingUncertain) return;
    const journal = recoveryJournalRef.current;
    if (
      !journal ||
      journal.status !== 'uncertain' ||
      uncertainResolution !== resolution
    ) {
      return;
    }
    const requestGeneration = principalRequestGate.capture();
    setResolvingUncertain(true);
    clearPurchaseApplicationSubmissionJournal(principal);
    retryMutationIdRef.current = null;
    recoveryJournalRef.current = null;
    monitoredTaskIdRef.current = null;
    submissionInFlightRef.current = false;
    setRecoveryJournal(null);
    setUncertainResolution(null);
    setBackgroundPending(false);
    setSubmitting(false);
    setErrors(EMPTY_ERRORS);
    if (resolution === 'found') {
      clearDraft(principal);
      const blankDraft = createBlankDraft(fixedBuilding);
      setDraft(blankDraft);
      setApplicantQuery('');
      setFiles([]);
      setMobileItemIndex(0);
    } else {
      saveDraft(journal.request, principal);
      setDraft(journal.request);
      setApplicantQuery(journal.request.shared.applicantName || '');
    }
    try {
      await onSubmissionSettledRef.current(journal.mutationId, null);
      if (!principalRequestGate.isCurrent(requestGeneration)) return;
      if (resolution === 'found') {
        toast.success('已结束恢复，请等待采购清单自动对账', {
          description: '本地待同步项已移除，活动清单将在 60 秒内自动刷新。',
        });
      } else {
        toast.warning('已恢复为可提交草稿', {
          description:
            '再次提交会生成新编号；请确认原清单确无记录，避免重复采购。',
        });
      }
    } catch {
      if (!principalRequestGate.isCurrent(requestGeneration)) return;
      toast.error('人工结案已保存，但页面待同步标记清理失败，请刷新页面');
    } finally {
      if (principalRequestGate.isCurrent(requestGeneration)) {
        setResolvingUncertain(false);
      }
    }
  }

  function handleOpenChange(nextOpen: boolean) {
    if (!nextOpen && submitting) return;
    if (!nextOpen) saveDraft(draft, principal);
    onOpenChange(nextOpen);
  }

  const currentMobileItem = draft.items[mobileItemIndex] || draft.items[0];
  const recoveryActionLabel = recoveryJournal?.taskId
    ? recoveryJournal.status === 'uncertain'
      ? '再次查询原任务'
      : '继续确认'
    : '使用原编号安全重试';

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        showCloseButton={!submitting}
        className="h-[92vh] w-[min(96vw,1500px)] max-w-none grid-rows-[auto_minmax(0,1fr)_auto] gap-0 overflow-hidden border-slate-200 bg-slate-50 p-0 max-sm:h-dvh max-sm:w-screen max-sm:max-w-none max-sm:rounded-none"
      >
        <header className="border-b border-blue-100 bg-white px-5 py-4 pr-14 sm:px-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-blue-600 text-white shadow-sm">
                <ClipboardPlus className="h-5 w-5" />
              </span>
              <div className="min-w-0">
                <DialogTitle className="text-lg text-slate-950 sm:text-xl">
                  新建采购申请
                </DialogTitle>
                <DialogDescription className="mt-1 text-xs text-slate-500">
                  同一批次可申请多种物品，共用楼栋、供应商和交付信息
                </DialogDescription>
              </div>
            </div>
            <div className="mr-2 inline-flex h-8 items-center gap-2 rounded-md border border-slate-200 bg-slate-50 px-3 text-xs text-slate-600">
              {referenceLoading ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-500" />
              ) : (
                <ClipboardPlus className="h-3.5 w-3.5 text-emerald-500" />
              )}
              应用身份安全提交
            </div>
          </div>
        </header>

        <div className="min-h-0 overflow-y-auto max-sm:overscroll-contain">
          {referenceError && (
            <div
              role="alert"
              className="flex items-center justify-between gap-3 border-b border-amber-200 bg-amber-50 px-5 py-2.5 text-xs text-amber-800"
            >
              <span>{referenceError}</span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void loadReferenceData()}
              >
                重试
              </Button>
            </div>
          )}
          {errors.general.length > 0 && (
            <div
              role="alert"
              aria-live="polite"
              className="border-b border-rose-200 bg-rose-50 px-5 py-2.5 text-xs text-rose-700"
            >
              {errors.general.join('；')}
            </div>
          )}
          {recoveryJournal && (
            <div
              role="status"
              aria-live="polite"
              className="border-b border-amber-200 bg-amber-50 px-5 py-3 text-xs text-amber-900"
            >
              <p className="font-semibold">
                检测到结果未确认的采购申请，已锁定原申请编号
                <span className="ml-1 font-mono">
                  {recoveryJournal.mutationId.slice(-8)}
                </span>
              </p>
              <p className="mt-1 leading-5 text-amber-800">
                {recoveryJournal.taskId
                  ? recoveryJournal.status === 'uncertain'
                    ? '原任务结果未确认，系统不会重复提交；请再次查询原任务并核对申请清单。'
                    : '正在继续确认原任务，系统不会重复提交。'
                  : '可使用原编号安全重试，系统不会生成新编号。刷新后附件内容不会保存在浏览器中；如服务端未受理，请重新选择原附件。'}
              </p>
              {recoveryJournal.status === 'uncertain' && (
                <div className="mt-3 rounded-md border border-amber-300 bg-white/80 p-3">
                  {uncertainResolution ? (
                    <>
                      <p role="alert" className="font-semibold text-rose-700">
                        {uncertainResolution === 'found'
                          ? '请再次确认：如果清单实际没有记录，结束恢复可能造成采购遗漏。'
                          : '请再次确认：如果清单实际已有记录，恢复草稿后再次提交可能造成重复采购。'}
                      </p>
                      <div className="mt-2 flex flex-wrap gap-2">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={resolvingUncertain}
                          onClick={() => setUncertainResolution(null)}
                        >
                          取消
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          disabled={resolvingUncertain}
                          className="bg-rose-600 text-white hover:bg-rose-700"
                          onClick={() =>
                            void resolveUncertainSubmission(uncertainResolution)
                          }
                        >
                          {resolvingUncertain ? (
                            <Loader2 className="animate-spin" />
                          ) : null}
                          {uncertainResolution === 'found'
                            ? '确认结束恢复'
                            : '确认恢复草稿'}
                        </Button>
                      </div>
                    </>
                  ) : (
                    <>
                      <p className="text-amber-800">
                        请先在采购清单中逐项核对，再选择人工结案路径。
                      </p>
                      <div className="mt-2 flex flex-wrap gap-2">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => setUncertainResolution('found')}
                        >
                          已在采购清单找到，结束恢复
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => setUncertainResolution('missing')}
                        >
                          已确认清单无记录，恢复为可提交草稿
                        </Button>
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          )}

          <section className="border-b border-slate-200 bg-white px-4 py-5 sm:px-6">
            <div className="mb-4 flex items-center justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold text-slate-900">
                  批次信息
                </h2>
                <p className="mt-1 text-xs text-slate-500">
                  楼栋、专业、采购方式、供应商和交付日期对本批全部物品生效
                </p>
              </div>
              <span className="rounded-md bg-blue-50 px-2.5 py-1 text-xs font-semibold text-blue-600">
                共 {draft.items.length} 种物品
              </span>
            </div>
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              {applicantIdentity.mode !== 'manual' ? (
                <div>
                  <Label htmlFor="purchase-current-applicant">申请人</Label>
                  <Input id="purchase-current-applicant" className="mt-2" readOnly
                    value={applicantIdentity.mode === 'automatic' ? applicantIdentity.name : ''} />
                  {applicantLoading ? <p role="status" className="mt-1 text-xs text-muted-foreground">正在匹配申请人</p> : null}
                  {applicantIdentityError || applicantIdentity.mode === 'error' ? (
                    <div className="mt-1 text-xs text-destructive"><p role="alert">{applicantIdentityError || (applicantIdentity.mode === 'error' ? applicantIdentity.message : '')}</p>
                      {applicantIdentityError ? <Button size="sm" variant="outline" onClick={() => setApplicantIdentityRevision(value => value + 1)}>重试</Button> : null}
                    </div>
                  ) : null}
                </div>
              ) : <ApplicantField
                query={applicantQuery}
                selected={draft.shared}
                results={applicantResults}
                loading={applicantLoading}
                error={errors.shared.applicantName}
                disabled={formLocked}
                onQueryChange={searchApplicant}
                onSelect={selectApplicant}
                onClear={clearApplicant}
              />}
              {fixedBuilding ? (
                <div>
                  <span className="mb-2 block text-xs font-semibold text-slate-600">
                    申请楼栋
                  </span>
                  <div className="flex h-9 items-center rounded-lg border border-blue-200 bg-blue-50 px-3 text-sm font-semibold text-blue-700">
                    {fixedBuilding}
                  </div>
                  <p className="mt-1 text-[11px] text-slate-500">
                    当前账号固定楼栋
                  </p>
                </div>
              ) : (
                <SharedSelectField
                  label="申请楼栋"
                  value={draft.shared.building}
                  options={(options?.buildings || []).filter(value => !scope || scope.includes(value as never))}
                  error={errors.shared.building}
                  disabled={formLocked || referenceLoading}
                  onChange={(value) =>
                    updateShared(
                      'building',
                      value as PurchaseApplicationSharedInput['building'],
                    )
                  }
                />
              )}
              <SharedSelectField
                label="专业"
                value={draft.shared.specialty}
                options={options?.specialties || []}
                error={errors.shared.specialty}
                disabled={formLocked || referenceLoading}
                onChange={(value) =>
                  updateShared(
                    'specialty',
                    value as PurchaseApplicationSharedInput['specialty'],
                  )
                }
              />
              <SharedSelectField
                label="采购方式"
                value={draft.shared.purchaseMethod}
                options={options?.purchaseMethods || []}
                error={errors.shared.purchaseMethod}
                disabled={formLocked || referenceLoading}
                onChange={(value) =>
                  updateShared(
                    'purchaseMethod',
                    value as PurchaseApplicationSharedInput['purchaseMethod'],
                  )
                }
              />
              <SharedSelectField
                label="采购渠道"
                value={draft.shared.purchaseChannel}
                options={options?.purchaseChannels || []}
                error={errors.shared.purchaseChannel}
                disabled={formLocked || referenceLoading}
                onChange={(value) => {
                  const purchaseChannel =
                    value as PurchaseApplicationSharedInput['purchaseChannel'];
                  setDraft((current) => ({
                    ...current,
                    shared: changePurchaseChannel(
                      current.shared,
                      purchaseChannel,
                    ),
                    items:
                      purchaseChannel === '线上'
                        ? current.items
                        : current.items.map((item) => ({
                            ...item,
                            onlineUrls: [''],
                          })),
                  }));
                  clearSharedError('purchaseChannel');
                  clearSharedError('onlineUrl');
                  clearSharedError('comparisonAttachment');
                }}
              />
              <TextField
                label="供应商"
                value={draft.shared.supplier}
                error={errors.shared.supplier}
                disabled={formLocked}
                placeholder="填写供应商名称"
                onChange={(value) => updateShared('supplier', value)}
              />
              <TextField
                label="期望交付时间"
                type="date"
                value={draft.shared.expectedDeliveryDate}
                error={errors.shared.expectedDeliveryDate}
                disabled={formLocked}
                min={todayString()}
                onChange={(value) =>
                  updateShared('expectedDeliveryDate', value)
                }
              />
              <SharedSelectField
                label="采购形式"
                value={draft.shared.procurementForm}
                options={options?.procurementForms || []}
                error={errors.shared.procurementForm}
                disabled={formLocked || referenceLoading}
                onChange={(value) => {
                  const procurementForm =
                    value as PurchaseApplicationSharedInput['procurementForm'];
                  const selection = applyProcurementFormSelection(
                    draft.shared,
                    files,
                    procurementForm,
                  );
                  setDraft((current) => ({
                    ...current,
                    shared: selection.nextShared,
                  }));
                  setFiles(selection.nextFiles);
                  selection.clearedErrorFields.forEach(clearSharedError);
                }}
              />
              {draft.shared.procurementForm === '单一采购' && (
                <div className="md:col-span-2">
                  <Label
                    htmlFor={singleReasonFieldId}
                    className="mb-2 text-xs font-semibold text-slate-600"
                  >
                    单一原因 <span className="text-rose-600">*</span>
                  </Label>
                  <Textarea
                    id={singleReasonFieldId}
                    data-purchase-field
                    value={draft.shared.singleReason}
                    required
                    aria-required="true"
                    aria-invalid={Boolean(errors.shared.singleReason)}
                    aria-describedby={
                      errors.shared.singleReason
                        ? singleReasonErrorId
                        : undefined
                    }
                    disabled={formLocked}
                    className="min-h-20 bg-white"
                    placeholder="请说明采用单一采购的原因"
                    onChange={(event) =>
                      updateShared('singleReason', event.target.value)
                    }
                  />
                  <FieldError
                    id={singleReasonErrorId}
                    message={errors.shared.singleReason}
                  />
                </div>
              )}
              <div className="flex min-h-16 items-end pb-2">
                <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-slate-700">
                  <Checkbox
                    aria-label="到货后立即领用出库"
                    checked={draft.shared.immediateOutbound}
                    disabled={formLocked}
                    onCheckedChange={(checked) =>
                      updateShared('immediateOutbound', checked === true)
                    }
                  />
                  到货后立即领用出库
                </label>
              </div>
              <div className="md:col-span-2">
                <Label
                  htmlFor={requirementSummaryFieldId}
                  className="mb-2 text-xs font-semibold text-slate-600"
                >
                  需求简述
                </Label>
                <Textarea
                  id={requirementSummaryFieldId}
                  data-purchase-field
                  value={draft.shared.requirementSummary}
                  aria-invalid={Boolean(errors.shared.requirementSummary)}
                  aria-describedby={
                    errors.shared.requirementSummary
                      ? requirementSummaryErrorId
                      : undefined
                  }
                  disabled={formLocked}
                  className="min-h-20 bg-white"
                  placeholder="填写采购原因、用途及必要性"
                  onChange={(event) =>
                    updateShared('requirementSummary', event.target.value)
                  }
                />
                <FieldError
                  id={requirementSummaryErrorId}
                  message={errors.shared.requirementSummary}
                />
              </div>
              <div className="md:col-span-2">
                <Label
                  htmlFor={notesFieldId}
                  className="mb-2 text-xs font-semibold text-slate-600"
                >
                  其他备注
                </Label>
                <Textarea
                  id={notesFieldId}
                  value={draft.shared.notes}
                  disabled={formLocked}
                  className="min-h-20 bg-white"
                  placeholder="多楼栋申请、收货说明等补充信息"
                  onChange={(event) =>
                    updateShared('notes', event.target.value)
                  }
                />
              </div>
            </div>
          </section>

          <section className="bg-slate-50 px-4 py-5 sm:px-6">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold text-slate-900">
                  采购物品明细
                </h2>
                <p className="mt-1 text-xs text-slate-500">
                  已有物品从飞书物品类别表检索，新增物品可直接填写
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={formLocked || draft.items.length >= 20}
                onClick={addItem}
              >
                <Plus />
                添加物品
              </Button>
            </div>

            <div className="hidden overflow-x-auto rounded-lg border border-slate-200 bg-white md:block">
              <table className="min-w-[1970px] table-fixed border-collapse text-xs">
                <colgroup>
                  <col className="w-12" />
                  <col className="w-32" />
                  <col className="w-40" />
                  <col className="w-44" />
                  <col className="w-64" />
                  <col className="w-44" />
                  <col className="w-32" />
                  <col className="w-64" />
                  <col className="w-24" />
                  <col className="w-24" />
                  <col className="w-28" />
                  <col className="w-24" />
                  <col className="w-24" />
                  <col className="w-28" />
                  <col className="w-24" />
                </colgroup>
                <thead className="sticky top-0 z-10 bg-slate-100 text-left text-slate-600">
                  <tr>
                    {[
                      '序号',
                      '物品类型',
                      '一级分类',
                      '二级分类',
                      '物品名称',
                      '规格型号',
                      '品牌',
                      '采购链接',
                      '数量',
                      '单位',
                      '单价',
                      '运费',
                      '减免',
                      '行金额',
                      '操作',
                    ].map((label) => (
                      <th
                        key={label}
                        className="border-b border-slate-200 px-2 py-3 font-semibold"
                      >
                        {label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {draft.items.map((item, index) => (
                    <DesktopItemRow
                      key={item.lineId}
                      item={item}
                      index={index}
                      options={options}
                      errors={errors.items[item.lineId] || {}}
                      results={catalogResults[item.lineId] || []}
                      searching={Boolean(catalogLoading[item.lineId])}
                      disabled={formLocked}
                      showOnlineLinks={draft.shared.purchaseChannel === '线上'}
                      canDelete={draft.items.length > 1}
                      onModeChange={(mode) => changeItemMode(item.lineId, mode)}
                      onChange={(key, value) =>
                        updateItem(item.lineId, key, value)
                      }
                      onSearch={(query) => searchCatalog(item.lineId, query)}
                      onSelectCatalog={(catalog) =>
                        selectCatalogItem(item.lineId, catalog)
                      }
                      onDuplicate={() =>
                        setDraft((current) => ({
                          ...current,
                          items: duplicateItem(current.items, item.lineId),
                        }))
                      }
                      onRemove={() =>
                        setDraft((current) => ({
                          ...current,
                          items: removeItem(current.items, item.lineId),
                        }))
                      }
                    />
                  ))}
                </tbody>
              </table>
            </div>

            {currentMobileItem && (
              <div className="md:hidden">
                <div className="mb-3 flex items-center justify-between rounded-lg border border-slate-200 bg-white px-3 py-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    title="上一种物品"
                    aria-label="上一种物品"
                    disabled={mobileItemIndex === 0}
                    onClick={() => setMobileItemIndex((current) => current - 1)}
                  >
                    <ChevronLeft />
                  </Button>
                  <strong className="text-sm text-slate-800">
                    物品 {mobileItemIndex + 1} / {draft.items.length}
                  </strong>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    title="下一种物品"
                    aria-label="下一种物品"
                    disabled={mobileItemIndex >= draft.items.length - 1}
                    onClick={() => setMobileItemIndex((current) => current + 1)}
                  >
                    <ChevronRight />
                  </Button>
                </div>
                <MobileItemEditor
                  item={currentMobileItem}
                  options={options}
                  errors={errors.items[currentMobileItem.lineId] || {}}
                  results={catalogResults[currentMobileItem.lineId] || []}
                  searching={Boolean(catalogLoading[currentMobileItem.lineId])}
                  disabled={formLocked}
                  showOnlineLinks={draft.shared.purchaseChannel === '线上'}
                  canDelete={draft.items.length > 1}
                  onModeChange={(mode) =>
                    changeItemMode(currentMobileItem.lineId, mode)
                  }
                  onChange={(key, value) =>
                    updateItem(currentMobileItem.lineId, key, value)
                  }
                  onSearch={(query) =>
                    searchCatalog(currentMobileItem.lineId, query)
                  }
                  onSelectCatalog={(catalog) =>
                    selectCatalogItem(currentMobileItem.lineId, catalog)
                  }
                  onDuplicate={() =>
                    setDraft((current) => ({
                      ...current,
                      items: duplicateItem(
                        current.items,
                        currentMobileItem.lineId,
                      ),
                    }))
                  }
                  onRemove={() =>
                    setDraft((current) => ({
                      ...current,
                      items: removeItem(
                        current.items,
                        currentMobileItem.lineId,
                      ),
                    }))
                  }
                />
              </div>
            )}

            {draft.shared.procurementForm === '三方比价' && (
              <div className="mt-4 border-t border-slate-200 pt-4">
                <div className="flex flex-wrap items-center gap-3">
                  <label
                    htmlFor={comparisonAttachmentFieldId}
                    className="inline-flex h-9 cursor-pointer items-center gap-2 rounded-md border border-slate-300 bg-white px-3 text-sm font-medium text-slate-700 transition hover:border-blue-300 hover:text-blue-600 focus-within:border-blue-500 focus-within:ring-2 focus-within:ring-blue-500/20"
                  >
                    <Paperclip className="h-4 w-4" />
                    三方比价单
                    {draft.shared.purchaseChannel === '线下' ? (
                      <span className="text-rose-600">*</span>
                    ) : null}
                    <input
                      id={comparisonAttachmentFieldId}
                      data-purchase-field
                      type="file"
                      className="sr-only"
                      multiple
                      accept=".pdf,.png,.jpg,.jpeg,.webp"
                      required={draft.shared.purchaseChannel === '线下'}
                      aria-required={draft.shared.purchaseChannel === '线下'}
                      aria-invalid={Boolean(errors.shared.comparisonAttachment)}
                      aria-describedby={
                        errors.shared.comparisonAttachment
                          ? comparisonAttachmentErrorId
                          : undefined
                      }
                      disabled={attachmentControlsLocked}
                      onChange={(event) => {
                        handleFiles(event.target.files);
                        event.target.value = '';
                      }}
                    />
                  </label>
                  <span className="text-xs text-slate-500">
                    {draft.shared.purchaseChannel === '线下'
                      ? '线下采购必传；最多 5 个，单个 20MB'
                      : '线上采购附件可选；最多 5 个，单个 20MB'}
                  </span>
                </div>
                <FieldError
                  id={comparisonAttachmentErrorId}
                  message={errors.shared.comparisonAttachment}
                />
                {files.length > 0 && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {files.map((file, index) => (
                      <span
                        key={`${file.name}-${file.size}-${index}`}
                        className="inline-flex max-w-full items-center gap-2 rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-600"
                      >
                        <FileCheck2 className="h-3.5 w-3.5 shrink-0 text-blue-500" />
                        <span className="max-w-52 truncate">{file.name}</span>
                        <button
                          type="button"
                          title="移除附件"
                          aria-label={`移除附件 ${file.name}`}
                          disabled={attachmentControlsLocked}
                          onClick={() =>
                            setFiles((current) =>
                              current.filter(
                                (_, fileIndex) => fileIndex !== index,
                              ),
                            )
                          }
                          className="text-slate-400 hover:text-rose-500 disabled:opacity-50"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </span>
                    ))}
                  </div>
                )}
              </div>
            )}
          </section>
        </div>

        <footer className="border-t border-slate-200 bg-white px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-6">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-slate-500">
              <span>
                品类{' '}
                <strong className="text-slate-800">{totals.itemKinds}</strong>
              </span>
              <span>
                数量{' '}
                <strong className="text-slate-800">{totals.quantity}</strong>
              </span>
              <span>
                商品额{' '}
                <strong className="text-slate-800">
                  {formatMoney(totals.goodsAmount)}
                </strong>
              </span>
              <span>
                运费{' '}
                <strong className="text-slate-800">
                  {formatMoney(totals.shippingFee)}
                </strong>
              </span>
              <span>
                减免{' '}
                <strong className="text-emerald-600">
                  -{formatMoney(totals.discount)}
                </strong>
              </span>
              <span>
                应付{' '}
                <strong className="text-base text-blue-700">
                  {formatMoney(totals.total)}
                </strong>
              </span>
            </div>
            <div className="grid grid-cols-2 gap-2 sm:flex sm:justify-end">
              <Button
                type="button"
                variant="outline"
                className="w-full max-sm:min-h-11 sm:w-auto"
                disabled={submitting}
                onClick={() => handleOpenChange(false)}
              >
                <Save />
                保存草稿
              </Button>
              {recoveryJournal ? (
                <Button
                  type="button"
                  className="w-full bg-amber-600 text-white hover:bg-amber-700 max-sm:min-h-11 sm:w-auto"
                  disabled={submitting}
                  onClick={handleRecoveryAction}
                >
                  {backgroundPending ? (
                    <Loader2 className="animate-spin" />
                  ) : (
                    <FileCheck2 />
                  )}
                  {recoveryActionLabel}
                </Button>
              ) : (
                <Button
                  type="button"
                  className="w-full bg-blue-600 text-white hover:bg-blue-700 max-sm:min-h-11 sm:w-auto"
                  disabled={formLocked || referenceLoading || !options || access.isLoading || applicantLoading || Boolean(applicantIdentityError) || applicantIdentity.mode === 'login' || applicantIdentity.mode === 'error'}
                  onClick={() => void handleSubmit()}
                >
                  {submitting ? (
                    <Loader2 className="animate-spin" />
                  ) : (
                    <ClipboardPlus />
                  )}
                  {submitting ? '提交中' : '提交采购申请'}
                </Button>
              )}
            </div>
          </div>
        </footer>
      </DialogContent>
    </Dialog>
  );
}

interface ItemEditorProps {
  item: PurchaseApplicationItemInput;
  options: PurchaseApplicationOptionsResponse | null;
  errors: Record<string, string>;
  results: PurchaseApplicationCatalogItem[];
  searching: boolean;
  disabled: boolean;
  showOnlineLinks: boolean;
  canDelete: boolean;
  onModeChange: (mode: 'existing' | 'new') => void;
  onChange: <K extends keyof PurchaseApplicationItemInput>(
    key: K,
    value: PurchaseApplicationItemInput[K],
  ) => void;
  onSearch: (query: string) => void;
  onSelectCatalog: (item: PurchaseApplicationCatalogItem) => void;
  onDuplicate: () => void;
  onRemove: () => void;
}

function DesktopItemRow(props: ItemEditorProps & { index: number }) {
  const { item, index, options, errors, disabled } = props;
  return (
    <tr className="align-top even:bg-slate-50/60">
      <td className="border-b border-slate-100 px-2 py-3 text-center font-semibold text-slate-500">
        {index + 1}
      </td>
      <td className="border-b border-slate-100 px-2 py-3">
        <ModeControl
          item={item}
          disabled={disabled}
          onChange={props.onModeChange}
        />
      </td>
      <td className="border-b border-slate-100 px-2 py-3">
        <ItemSelect
          value={item.primaryCategory}
          options={options?.primaryCategories || []}
          error={errors.primaryCategory}
          disabled={disabled}
          placeholder="一级分类"
          onChange={(value) => props.onChange('primaryCategory', value)}
        />
      </td>
      <td className="border-b border-slate-100 px-2 py-3">
        <ItemSelect
          value={item.secondaryCategory}
          options={secondaryOptions(options, item.primaryCategory)}
          error={errors.secondaryCategory}
          disabled={disabled}
          placeholder="二级分类"
          onChange={(value) => props.onChange('secondaryCategory', value)}
        />
      </td>
      <td className="border-b border-slate-100 px-2 py-3">
        <CatalogOrNameInput {...props} />
      </td>
      <td className="border-b border-slate-100 px-2 py-3">
        <ItemInput
          value={item.specification}
          disabled={disabled}
          placeholder="规格/序列号"
          onChange={(value) => props.onChange('specification', value)}
        />
      </td>
      <td className="border-b border-slate-100 px-2 py-3">
        <ItemInput
          value={item.brand}
          disabled={disabled}
          placeholder="品牌"
          onChange={(value) => props.onChange('brand', value)}
        />
      </td>
      <td className="border-b border-slate-100 px-2 py-3">
        <PurchaseLinkInputs
          values={item.onlineUrls || []}
          active={props.showOnlineLinks}
          disabled={disabled}
          error={errors.onlineUrls}
          onChange={(values) => props.onChange('onlineUrls', values)}
        />
      </td>
      <td className="border-b border-slate-100 px-2 py-3">
        <NumberInput
          ariaLabel="数量"
          value={item.quantity}
          min={1}
          step={1}
          error={errors.quantity}
          disabled={disabled}
          onChange={(value) =>
            props.onChange('quantity', normalizePurchaseQuantityInput(value))
          }
        />
      </td>
      <td className="border-b border-slate-100 px-2 py-3">
        <ItemInput
          value={item.unit}
          error={errors.unit}
          disabled={disabled}
          placeholder="单位"
          onChange={(value) => props.onChange('unit', value)}
        />
      </td>
      <td className="border-b border-slate-100 px-2 py-3">
        <NumberInput
          ariaLabel="单价"
          value={item.unitPrice}
          min={0}
          step={0.01}
          error={errors.unitPrice}
          disabled={disabled}
          onChange={(value) => props.onChange('unitPrice', value)}
        />
      </td>
      <td className="border-b border-slate-100 px-2 py-3">
        <NumberInput
          ariaLabel="运费"
          value={item.shippingFee}
          min={0}
          step={0.01}
          error={errors.shippingFee}
          disabled={disabled}
          onChange={(value) => props.onChange('shippingFee', value)}
        />
      </td>
      <td className="border-b border-slate-100 px-2 py-3">
        <NumberInput
          ariaLabel="减免"
          value={item.discount}
          min={0}
          step={0.01}
          error={errors.discount}
          disabled={disabled}
          onChange={(value) => props.onChange('discount', value)}
        />
      </td>
      <td className="border-b border-slate-100 px-2 py-4 text-right font-semibold text-slate-800">
        {formatMoney(
          item.quantity * item.unitPrice + item.shippingFee - item.discount,
        )}
      </td>
      <td className="border-b border-slate-100 px-2 py-3">
        <ItemActions {...props} />
      </td>
    </tr>
  );
}

function MobileItemEditor(props: ItemEditorProps) {
  const { item, options, errors, disabled } = props;
  return (
    <div className="space-y-4 border-y border-slate-200 bg-white py-4">
      <ModeControl
        item={item}
        disabled={disabled}
        onChange={props.onModeChange}
      />
      <div className="grid grid-cols-2 gap-3">
        <LabeledItem label="一级分类">
          <ItemSelect
            ariaLabel="一级分类"
            value={item.primaryCategory}
            options={options?.primaryCategories || []}
            error={errors.primaryCategory}
            disabled={disabled}
            placeholder="请选择"
            onChange={(value) => props.onChange('primaryCategory', value)}
          />
        </LabeledItem>
        <LabeledItem label="二级分类">
          <ItemSelect
            ariaLabel="二级分类"
            value={item.secondaryCategory}
            options={secondaryOptions(options, item.primaryCategory)}
            error={errors.secondaryCategory}
            disabled={disabled}
            placeholder="请选择"
            onChange={(value) => props.onChange('secondaryCategory', value)}
          />
        </LabeledItem>
      </div>
      <LabeledItem label="物品名称">
        <CatalogOrNameInput {...props} />
      </LabeledItem>
      <div className="grid grid-cols-2 gap-3">
        <LabeledItem label="规格型号">
          <ItemInput
            value={item.specification}
            disabled={disabled}
            placeholder="规格/序列号"
            onChange={(value) => props.onChange('specification', value)}
          />
        </LabeledItem>
        <LabeledItem label="品牌">
          <ItemInput
            value={item.brand}
            disabled={disabled}
            placeholder="品牌"
            onChange={(value) => props.onChange('brand', value)}
          />
        </LabeledItem>
        <div className="col-span-2">
          <LabeledItem label="采购链接">
            <PurchaseLinkInputs
              values={item.onlineUrls || []}
              active={props.showOnlineLinks}
              disabled={disabled}
              error={errors.onlineUrls}
              onChange={(values) => props.onChange('onlineUrls', values)}
            />
          </LabeledItem>
        </div>
        <LabeledItem label="数量">
          <NumberInput
            ariaLabel="数量"
            value={item.quantity}
            min={1}
            step={1}
            error={errors.quantity}
            disabled={disabled}
            onChange={(value) =>
              props.onChange('quantity', normalizePurchaseQuantityInput(value))
            }
          />
        </LabeledItem>
        <LabeledItem label="单位">
          <ItemInput
            value={item.unit}
            error={errors.unit}
            disabled={disabled}
            placeholder="单位"
            onChange={(value) => props.onChange('unit', value)}
          />
        </LabeledItem>
        <LabeledItem label="单价">
          <NumberInput
            ariaLabel="单价"
            value={item.unitPrice}
            min={0}
            step={0.01}
            error={errors.unitPrice}
            disabled={disabled}
            onChange={(value) => props.onChange('unitPrice', value)}
          />
        </LabeledItem>
        <LabeledItem label="运费">
          <NumberInput
            ariaLabel="运费"
            value={item.shippingFee}
            min={0}
            step={0.01}
            error={errors.shippingFee}
            disabled={disabled}
            onChange={(value) => props.onChange('shippingFee', value)}
          />
        </LabeledItem>
        <LabeledItem label="减免">
          <NumberInput
            ariaLabel="减免"
            value={item.discount}
            min={0}
            step={0.01}
            error={errors.discount}
            disabled={disabled}
            onChange={(value) => props.onChange('discount', value)}
          />
        </LabeledItem>
        <div className="flex flex-col justify-end">
          <span className="text-xs text-slate-500">行金额</span>
          <strong className="mt-2 text-base text-blue-700">
            {formatMoney(
              item.quantity * item.unitPrice + item.shippingFee - item.discount,
            )}
          </strong>
        </div>
      </div>
      <ItemActions {...props} />
    </div>
  );
}

function PurchaseLinkInputs({
  values,
  active,
  disabled,
  error,
  onChange,
}: {
  values: string[];
  active: boolean;
  disabled: boolean;
  error?: string;
  onChange: (values: string[]) => void;
}) {
  const links = values.length ? values : [''];
  if (!active) {
    return <span className="text-xs text-slate-400">线下采购无需填写</span>;
  }
  return (
    <div className="space-y-1.5">
      {links.slice(0, 3).map((value, index) => (
        <div key={index} className="flex items-center gap-1">
          <Input
            data-purchase-field
            type="url"
            value={value}
            aria-label={`采购链接${index + 1}`}
            aria-invalid={Boolean(error)}
            disabled={disabled}
            className="h-8 bg-white px-2 text-xs"
            placeholder={`链接${index + 1}（https://）`}
            onChange={(event) => {
              const next = [...links];
              next[index] = event.target.value;
              onChange(next);
            }}
          />
          {links.length > 1 && (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              title={`删除采购链接${index + 1}`}
              aria-label={`删除采购链接${index + 1}`}
              disabled={disabled}
              onClick={() =>
                onChange(links.filter((_, linkIndex) => linkIndex !== index))
              }
            >
              <X />
            </Button>
          )}
        </div>
      ))}
      {links.length < 3 && (
        <button
          type="button"
          disabled={disabled}
          className="text-[11px] font-semibold text-blue-600 hover:text-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
          onClick={() => onChange([...links, ''])}
        >
          + 添加链接（每个物品最多 3 个）
        </button>
      )}
      <FieldError message={error} />
    </div>
  );
}

function ModeControl({
  item,
  disabled,
  onChange,
}: {
  item: PurchaseApplicationItemInput;
  disabled: boolean;
  onChange: (mode: 'existing' | 'new') => void;
}) {
  return (
    <div
      role="group"
      aria-label="物品来源"
      className="grid grid-cols-2 rounded-md bg-slate-100 p-1"
    >
      {(['existing', 'new'] as const).map((mode) => (
        <button
          key={mode}
          type="button"
          aria-pressed={item.mode === mode}
          disabled={disabled}
          onClick={() => onChange(mode)}
          className={cn(
            'h-7 rounded text-xs font-semibold transition',
            item.mode === mode
              ? 'bg-white text-blue-600 shadow-sm'
              : 'text-slate-500 hover:text-slate-800',
            disabled && 'cursor-not-allowed opacity-50',
          )}
        >
          {mode === 'existing' ? '已有' : '新增'}
        </button>
      ))}
    </div>
  );
}

function CatalogOrNameInput(props: ItemEditorProps) {
  const { item, errors, disabled, results, searching } = props;
  const fieldId = React.useId();
  const errorId = `${fieldId}-error`;
  if (item.mode === 'new') {
    return (
      <ItemInput
        value={item.itemName}
        error={errors.itemName}
        disabled={disabled}
        placeholder="填写新增物品名称"
        onChange={(value) => props.onChange('itemName', value)}
      />
    );
  }
  return (
    <div>
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
        <Input
          id={fieldId}
          data-purchase-field
          value={item.itemName}
          aria-label="物品名称"
          aria-invalid={Boolean(errors.itemName)}
          aria-describedby={errors.itemName ? errorId : undefined}
          disabled={disabled}
          className="h-8 bg-white pl-8 pr-8 text-xs"
          placeholder="搜索名称/SKU/规格"
          onChange={(event) => props.onSearch(event.target.value)}
        />
        {searching && (
          <Loader2 className="absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 animate-spin text-blue-500" />
        )}
      </div>
      <FieldError id={errorId} message={errors.itemName} />
      {results.length > 0 && (
        <div className="mt-1 max-h-32 overflow-y-auto rounded-md border border-blue-100 bg-white shadow-sm">
          {results.slice(0, 12).map((catalog) => (
            <button
              key={catalog.recordId}
              type="button"
              onClick={() => props.onSelectCatalog(catalog)}
              className="block w-full border-b border-slate-100 px-2.5 py-2 text-left last:border-0 hover:bg-blue-50"
            >
              <span className="block truncate font-semibold text-slate-800">
                {catalog.name}
              </span>
              <span className="mt-0.5 block truncate text-[11px] text-slate-400">
                {catalog.sku || '无类别号'} ·{' '}
                {catalog.specification || '无规格'} ·{' '}
                {catalog.unit || '单位待补充'}
              </span>
            </button>
          ))}
        </div>
      )}
      {!searching &&
        item.itemName.trim() &&
        !item.catalogRecordId &&
        results.length === 0 && (
          <p className="mt-1 text-[11px] text-slate-400">
            输入关键词检索飞书物品目录
          </p>
        )}
      {item.catalogRecordId && (
        <p className="mt-1 truncate text-[11px] text-emerald-600">
          已关联目录 {item.sku || item.catalogRecordId}
        </p>
      )}
    </div>
  );
}

function ItemActions(
  props: Pick<
    ItemEditorProps,
    'disabled' | 'canDelete' | 'onDuplicate' | 'onRemove'
  >,
) {
  return (
    <div className="flex items-center gap-1">
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        title="复制物品"
        aria-label="复制物品"
        disabled={props.disabled}
        onClick={props.onDuplicate}
      >
        <Copy />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        title="删除物品"
        aria-label="删除物品"
        disabled={props.disabled || !props.canDelete}
        className="text-rose-500 hover:bg-rose-50 hover:text-rose-600"
        onClick={props.onRemove}
      >
        <Trash2 />
      </Button>
    </div>
  );
}

function ApplicantField({
  query,
  selected,
  results,
  loading,
  error,
  disabled,
  onQueryChange,
  onSelect,
  onClear,
}: {
  query: string;
  selected: PurchaseApplicationSharedInput;
  results: PurchaseApplicationApplicant[];
  loading: boolean;
  error?: string;
  disabled: boolean;
  onQueryChange: (value: string) => void;
  onSelect: (applicant: PurchaseApplicationApplicant) => void;
  onClear: () => void;
}) {
  const fieldId = React.useId();
  const errorId = `${fieldId}-error`;
  return (
    <div className="relative">
      <Label
        htmlFor={fieldId}
        className="mb-2 text-xs font-semibold text-slate-600"
      >
        申请人
      </Label>
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
        <Input
          id={fieldId}
          data-purchase-field
          value={query}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? errorId : undefined}
          disabled={disabled}
          autoComplete="off"
          className="h-9 bg-white pl-9 pr-9"
          placeholder="搜索姓名、工号或岗位"
          onChange={(event) => onQueryChange(event.target.value)}
        />
        {loading ? (
          <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-blue-500" />
        ) : selected.applicantOpenId ? (
          <button
            type="button"
            title="清除申请人"
            aria-label="清除申请人"
            disabled={disabled}
            onClick={onClear}
            className="absolute right-2 top-1/2 inline-flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded text-slate-400 hover:bg-rose-50 hover:text-rose-500"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </div>
      <FieldError id={errorId} message={error} />
      {selected.applicantOpenId && (
        <p className="mt-1 truncate text-[11px] text-emerald-600">
          已选择 {selected.applicantName}
          {selected.applicantEmployeeNo
            ? ` · ${selected.applicantEmployeeNo}`
            : ''}
          {selected.applicantPosition ? ` · ${selected.applicantPosition}` : ''}
          {selected.applicantBuilding ? ` · ${selected.applicantBuilding}` : ''}
        </p>
      )}
      {results.length > 0 && !selected.applicantOpenId && (
        <div className="absolute z-30 mt-1 max-h-64 w-full overflow-y-auto rounded-md border border-blue-100 bg-white p-1 shadow-lg">
          {results.map((applicant) => (
            <button
              key={applicant.recordId}
              type="button"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onSelect(applicant)}
              className="block w-full rounded px-3 py-2 text-left transition hover:bg-blue-50 focus-visible:bg-blue-50 focus-visible:outline-none"
            >
              <span className="flex items-center justify-between gap-3">
                <strong className="truncate text-sm text-slate-800">
                  {applicant.name}
                </strong>
                <span className="shrink-0 text-[11px] text-slate-400">
                  {applicant.employeeNo || '无工号'}
                </span>
              </span>
              <span className="mt-1 block truncate text-[11px] text-slate-500">
                {[applicant.position, applicant.building, applicant.specialty]
                  .filter(Boolean)
                  .join(' · ') || '岗位信息待补充'}
              </span>
            </button>
          ))}
        </div>
      )}
      {!loading &&
        query.trim() &&
        !selected.applicantOpenId &&
        results.length === 0 && (
          <p className="mt-1 text-[11px] text-slate-400">
            输入关键词，从飞书在职人员表模糊查找
          </p>
        )}
    </div>
  );
}

function SharedSelectField({
  label,
  value,
  options,
  error,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  options: string[];
  error?: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const fieldId = React.useId();
  const errorId = `${fieldId}-error`;
  return (
    <div>
      <Label
        htmlFor={fieldId}
        className="mb-2 text-xs font-semibold text-slate-600"
      >
        {label}
      </Label>
      <Select value={value} disabled={disabled} onValueChange={onChange}>
        <SelectTrigger
          id={fieldId}
          data-purchase-field
          aria-invalid={Boolean(error)}
          aria-describedby={error ? errorId : undefined}
          className="h-9 w-full bg-white"
        >
          <SelectValue placeholder="请选择" />
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

function TextField({
  label,
  value,
  error,
  disabled,
  placeholder,
  type = 'text',
  min,
  onChange,
}: {
  label: string;
  value: string;
  error?: string;
  disabled: boolean;
  placeholder?: string;
  type?: React.HTMLInputTypeAttribute;
  min?: string;
  onChange: (value: string) => void;
}) {
  const fieldId = React.useId();
  const errorId = `${fieldId}-error`;
  return (
    <div>
      <Label
        htmlFor={fieldId}
        className="mb-2 text-xs font-semibold text-slate-600"
      >
        {label}
      </Label>
      <Input
        id={fieldId}
        data-purchase-field
        type={type}
        value={value}
        min={min}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? errorId : undefined}
        disabled={disabled}
        className="h-9 bg-white"
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
      <FieldError id={errorId} message={error} />
    </div>
  );
}

function ItemSelect({
  value,
  options,
  error,
  disabled,
  placeholder,
  ariaLabel = placeholder,
  onChange,
}: {
  value: string;
  options: string[];
  error?: string;
  disabled: boolean;
  placeholder: string;
  ariaLabel?: string;
  onChange: (value: string) => void;
}) {
  const fieldId = React.useId();
  const errorId = `${fieldId}-error`;
  return (
    <div>
      <Select value={value} disabled={disabled} onValueChange={onChange}>
        <SelectTrigger
          id={fieldId}
          data-purchase-field
          aria-label={ariaLabel}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? errorId : undefined}
          className="h-8 w-full bg-white px-2 text-xs"
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

function ItemInput({
  value,
  error,
  disabled,
  placeholder,
  onChange,
}: {
  value: string;
  error?: string;
  disabled: boolean;
  placeholder: string;
  onChange: (value: string) => void;
}) {
  const fieldId = React.useId();
  const errorId = `${fieldId}-error`;
  return (
    <div>
      <Input
        id={fieldId}
        data-purchase-field
        value={value}
        aria-label={placeholder}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? errorId : undefined}
        disabled={disabled}
        className="h-8 bg-white px-2 text-xs"
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
      <FieldError id={errorId} message={error} />
    </div>
  );
}

function NumberInput({
  value,
  error,
  disabled,
  min,
  step,
  ariaLabel,
  onChange,
}: {
  value: number;
  error?: string;
  disabled: boolean;
  min: number;
  step: number;
  ariaLabel: string;
  onChange: (value: number) => void;
}) {
  const fieldId = React.useId();
  const errorId = `${fieldId}-error`;
  return (
    <div>
      <Input
        id={fieldId}
        data-purchase-field
        type="number"
        value={Number.isFinite(value) ? value : 0}
        min={min}
        step={step}
        aria-label={ariaLabel}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? errorId : undefined}
        disabled={disabled}
        className="h-8 bg-white px-2 text-right text-xs tabular-nums"
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <FieldError id={errorId} message={error} />
    </div>
  );
}

function LabeledItem({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <span className="mb-2 block text-xs font-semibold text-slate-600">
        {label}
      </span>
      {children}
    </div>
  );
}

function FieldError({ id, message }: { id?: string; message?: string }) {
  return message ? (
    <p
      id={id}
      role="alert"
      aria-live="polite"
      className="mt-1 text-[11px] leading-4 text-rose-600"
    >
      {message}
    </p>
  ) : null;
}

function focusFirstInvalidPurchaseField(): void {
  window.requestAnimationFrame(() => {
    const invalidFields = Array.from(
      document.querySelectorAll<HTMLElement>(
        '[data-purchase-field][aria-invalid="true"]',
      ),
    );
    const firstInvalidField =
      invalidFields.find((field) => field.offsetParent !== null) ||
      invalidFields[0];
    firstInvalidField?.focus({ preventScroll: true });
    firstInvalidField?.scrollIntoView({
      behavior: 'smooth',
      block: 'center',
    });
  });
}

function revealFirstInvalidItem(
  issues: PurchaseApplicationValidationIssue[],
  items: PurchaseApplicationItemInput[],
  setMobileItemIndex: React.Dispatch<React.SetStateAction<number>>,
): void {
  const firstLineId = issues.find((issue) => issue.lineId)?.lineId;
  if (!firstLineId) return;
  const itemIndex = items.findIndex((item) => item.lineId === firstLineId);
  if (itemIndex >= 0) setMobileItemIndex(itemIndex);
}

function secondaryOptions(
  options: PurchaseApplicationOptionsResponse | null,
  primary: string,
): string[] {
  if (!options) return [];
  const prefix = primary.trim().charAt(0);
  if (!/[A-D]/.test(prefix)) return options.secondaryCategories;
  return options.secondaryCategories.filter((item) => item.includes(prefix));
}

function buildCatalogSearchKey(
  building: string,
  item: PurchaseApplicationItemInput | undefined,
  query: string,
): string {
  if (!item) return '';
  return JSON.stringify([
    building.trim(),
    item.mode,
    item.primaryCategory.trim(),
    item.secondaryCategory.trim(),
    query.trim(),
  ]);
}

function readBackendIssues(
  error: unknown,
): PurchaseApplicationValidationIssue[] {
  const response =
    isRecord(error) && isRecord(error.response) ? error.response : {};
  const data = isRecord(response.data) ? response.data : {};
  return Array.isArray(data.issues)
    ? (data.issues as PurchaseApplicationValidationIssue[])
    : [];
}

async function monitorPurchaseApplicationTask(
  taskId: string,
  onCompleted: (
    result: PurchaseApplicationSubmitResponse,
  ) => Promise<void> | void,
  onFailed: (message: string) => Promise<void> | void,
  onUncertain: (message: string) => Promise<void> | void,
  onTerminalUncertain: (message: string) => Promise<void> | void,
  shouldContinue: () => boolean,
): Promise<void> {
  const slowPollingAt = Date.now() + SUBMISSION_TASK_POLL_TIMEOUT_MS;
  let uncertaintyReported = false;
  let consecutiveQueryFailures = 0;
  while (shouldContinue()) {
    try {
      const response = await getPurchaseApplicationSubmissionTaskStatus(taskId);
      consecutiveQueryFailures = 0;
      const task = response.task;
      if (!response.success || !task) {
        await onTerminalUncertain(
          response.message || '原采购申请任务不存在或已过期，请联系管理员核对',
        );
        return;
      } else if (task.status === 'completed') {
        if (task.result) {
          await onCompleted(task.result);
          return;
        }
        await onTerminalUncertain(
          '采购申请任务已结束但结果缺失，请联系管理员核对',
        );
        return;
      } else if (task.status === 'failed') {
        if (task.definitelyNotWritten === true) {
          await onFailed(task.message || '采购申请未写入，请检查后重新提交');
        } else {
          await onTerminalUncertain(
            task.message || '采购申请任务失败，但写入结果未得到确认',
          );
        }
        return;
      } else if (task.status === 'uncertain') {
        await onTerminalUncertain(
          task.message || '原任务结果未确认，请核对申请清单或联系管理员',
        );
        return;
      }
    } catch (error) {
      consecutiveQueryFailures += 1;
      if (consecutiveQueryFailures >= SUBMISSION_TASK_MAX_QUERY_FAILURES) {
        await onTerminalUncertain(
          `采购申请任务状态连续查询失败：${readErrorMessage(error, '网络不可用')}`,
        );
        return;
      }
    }
    if (Date.now() >= slowPollingAt && !uncertaintyReported) {
      uncertaintyReported = true;
      await onUncertain('采购申请仍在后台同步，将继续自动确认，请勿重复提交');
    }
    await waitForSubmissionTask(
      Date.now() >= slowPollingAt
        ? SUBMISSION_TASK_SLOW_POLL_INTERVAL_MS
        : SUBMISSION_TASK_POLL_INTERVAL_MS,
    );
  }
}

function createPurchaseApplicationMutationId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function waitForSubmissionTask(duration: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, duration));
}

function readErrorMessage(error: unknown, fallback: string): string {
  const response =
    isRecord(error) && isRecord(error.response) ? error.response : {};
  const data = isRecord(response.data) ? response.data : {};
  const message =
    typeof data.message === 'string'
      ? data.message
      : error instanceof Error
        ? error.message
        : '';
  return message || fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function todayString(): string {
  return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function formatMoney(value: number): string {
  return new Intl.NumberFormat('zh-CN', {
    style: 'currency',
    currency: 'CNY',
    minimumFractionDigits: 2,
  }).format(value);
}
