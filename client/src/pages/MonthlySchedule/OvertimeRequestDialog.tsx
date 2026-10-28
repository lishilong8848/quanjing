import { useAccess } from '@/access/AccessProvider';
import { hasAuthenticatedAccessIdentity } from '@/access/access-policy';
import { canSelectWorkforcePerson, resolveWorkforceRequestApplicant } from '@shared/workforce-request-applicant';
import type { SelfServiceApplicant } from '@shared/self-service-applicant';
import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal, flushSync } from 'react-dom';
import { CalendarClock, Check, Search, X } from 'lucide-react';
import { logger } from '@lark-apaas/client-toolkit/logger';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { createOvertimeRequest } from '@/api';
import type { MonthlySchedule } from '@shared/api.interface';
import {
  calculateOvertimeRequestImpact,
  type OvertimeRequestImpact,
  type OvertimeRequestInvalidRangeReason,
} from '@shared/overtime-request-impact';
import { LeaveRequestScreenshotField } from './LeaveRequestScreenshotField';
import {
  clearOvertimeRequestRecoveryCredential,
  coordinateOvertimeRequestPreparation,
  createOvertimeRequestMutationId,
  createOvertimeRequestPreparationLifecycle,
  createOvertimeRequestSnapshotDigest,
  createOvertimeRequestSubmissionSequence,
  createShanghaiOvertimeDateTime,
  getLatestOvertimeImpactFromError,
  getOvertimeRequestErrorMessage,
  getShanghaiTodayDate,
  isOvertimeRangeSelectable,
  isOvertimeScheduleRangeCovered,
  listOvertimeEndDates,
  listOvertimeEndTimes,
  listOvertimeHistoryScheduleCoverageDates,
  listOvertimeScheduleDates,
  markOvertimeRequestMutationFailure,
  persistOvertimeRequestRecoveryCredential,
  primeOvertimeRequestScreenshotDigest,
  readOvertimeRequestRecoveryCredential,
  reconcileOvertimeRangeAfterStartChange,
  reconcileOvertimeRangeWithAvailability,
  resolveOvertimeAuthoritativeImpactAfterSchedulesChange,
  resolveOvertimeRequestMutationBinding,
  resolveOvertimeRequestSuccessResponse,
  type OvertimeRequestMutationBinding,
  type OvertimeRequestMutationResolution,
} from './overtime-request-submit';

interface OvertimePersonProfile {
  supervisorText: string | null;
  position: string;
  buildingsSpecialties: string[];
  shift?: string | null;
}

interface OvertimeRequestDialogFocusCoordinator {
  returnElementRef: React.MutableRefObject<HTMLElement | null>;
  restoreFrameRef: React.MutableRefObject<number | null>;
  openRef: React.MutableRefObject<boolean>;
}

interface OvertimeRequestDialogProps {
  applicantOverride?: SelfServiceApplicant;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onBackgroundSyncChange: (syncing: boolean) => void;
  canUseSelfServiceTools: boolean;
  personProfiles: OvertimePersonProfile[];
  personProfilesStatus: 'loading' | 'ready' | 'error';
  onRetryPersonProfiles: () => Promise<void>;
  schedules: MonthlySchedule[];
  ensureSchedulesForDateRange: (dateKeys: string[]) => Promise<boolean>;
  focusCoordinator: OvertimeRequestDialogFocusCoordinator;
}

type OvertimeRequestPreparedSubmission =
  | {
      status: 'resolution';
      resolution: OvertimeRequestMutationResolution;
    }
  | { status: 'digest-unavailable' }
  | { status: 'recovery-mismatch' };

const OVERTIME_REASON_MAX_LENGTH = 2000;
const HOUR_OPTIONS = Array.from(
  { length: 24 },
  (_, hour) => `${String(hour).padStart(2, '0')}:00`,
);
const OVERTIME_DIALOG_FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not(:disabled)',
  'input:not([type="file"]):not(:disabled)',
  'select:not(:disabled)',
  'textarea:not(:disabled)',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function cancelOvertimeDialogFocusRestore(
  focusCoordinator: OvertimeRequestDialogFocusCoordinator,
): void {
  if (focusCoordinator.restoreFrameRef.current === null) return;
  window.cancelAnimationFrame(focusCoordinator.restoreFrameRef.current);
  focusCoordinator.restoreFrameRef.current = null;
}

function scheduleOvertimeDialogFocusRestore(
  focusCoordinator: OvertimeRequestDialogFocusCoordinator,
): void {
  cancelOvertimeDialogFocusRestore(focusCoordinator);
  focusCoordinator.restoreFrameRef.current = window.requestAnimationFrame(
    () => {
      focusCoordinator.restoreFrameRef.current = null;
      if (focusCoordinator.openRef.current) return;

      const returnElement = focusCoordinator.returnElementRef.current;
      focusCoordinator.returnElementRef.current = null;
      if (!returnElement?.isConnected) return;
      try {
        returnElement.focus({ preventScroll: true });
      } catch {
        // Focus restoration is best-effort when the trigger becomes inert.
      }
    },
  );
}

function isOvertimeDialogFocusableElementVisible(
  element: HTMLElement,
): boolean {
  if (element.matches(':disabled')) return false;
  if (element.closest('[hidden], [aria-hidden="true"], [inert]')) return false;

  const computedStyle = window.getComputedStyle(element);
  if (
    computedStyle.display === 'none' ||
    computedStyle.visibility === 'hidden' ||
    computedStyle.visibility === 'collapse' ||
    computedStyle.opacity === '0'
  ) {
    return false;
  }
  return element.getClientRects().length > 0;
}

function getSessionStorage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function isBackendStatus(error: unknown, status: number): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as {
    status?: unknown;
    statusCode?: unknown;
    response?: { status?: unknown };
  };
  return (
    Number(
      candidate.status ?? candidate.statusCode ?? candidate.response?.status,
    ) === status
  );
}

function createEmptyImpact(): OvertimeRequestImpact {
  return {
    rawHours: 0,
    payableHours: 0,
    conflictingSchedules: [],
    isWholeHour: false,
    invalidRangeReason: 'invalid_start_at',
    canSubmit: false,
  };
}

function getOvertimeInvalidRangeMessage(
  reason: OvertimeRequestInvalidRangeReason | null,
): string | null {
  switch (reason) {
    case null:
      return null;
    case 'long_white_workday_hours':
      return '长白班工作日加班仅可选择 09:00 前或 18:00 后';
    case 'continuous_duty_24_hours':
      return '所选加班与本人排班连续值守达到 24 小时，请缩短或调整时段';
    case 'calendar_data_missing':
      return '法定工作日历数据不完整，暂不能提交该时段';
    default:
      return '每次加班至少 1 小时，开始和结束时间必须为整点';
  }
}

function normalizeProfileName(profile: OvertimePersonProfile): string {
  return profile.supervisorText?.trim() || '';
}

export function OvertimeRequestDialog({
  applicantOverride,
  open,
  onOpenChange,
  onBackgroundSyncChange,
  canUseSelfServiceTools,
  personProfiles,
  personProfilesStatus,
  onRetryPersonProfiles,
  schedules,
  ensureSchedulesForDateRange,
  focusCoordinator,
}: OvertimeRequestDialogProps) {
  const access = useAccess();
  const applicant = useMemo(() => applicantOverride || resolveWorkforceRequestApplicant(access, hasAuthenticatedAccessIdentity(access), '提交加班申请'),
    [applicantOverride, access.accountId, access.displayName, access.expiresAt, access.principalFingerprint, access.role]);
  const memberName = applicant.mode === 'automatic' ? applicant.name : undefined;
  const [rangeClockMs, setRangeClockMs] = useState(() => Date.now());
  const todayDate = getShanghaiTodayDate(new Date(rangeClockMs));
  const availableDates = useMemo(
    () => listOvertimeScheduleDates(schedules, todayDate),
    [schedules, todayDate],
  );
  const [manualStaffName, setStaffName] = useState('');
  const staffName = memberName ?? manualStaffName;
  const [staffSearch, setStaffSearch] = useState('');
  const [staffPickerOpen, setStaffPickerOpen] = useState(false);
  useEffect(() => {
    if (open && memberName !== undefined) { setStaffName(memberName); setStaffSearch(memberName); setStaffPickerOpen(false); }
  }, [open, memberName]);
  useEffect(() => {
    if (!open || access.isLoading || (applicant.mode !== 'login' && applicant.mode !== 'error')) return;
    onOpenChange(false);
    if (applicant.mode === 'login') access.requestLogin(applicant.message, '/monthly-schedule');
    else toast.error(applicant.message);
  }, [open, access.isLoading, access.requestLogin, applicant, onOpenChange]);
  useEffect(() => { setStaffName(''); setStaffSearch(''); setStaffPickerOpen(false); }, [access.principalFingerprint]);
  const [startDate, setStartDate] = useState('');
  const [startTime, setStartTime] = useState('');
  const [endDate, setEndDate] = useState('');
  const [endTime, setEndTime] = useState('');
  const [reason, setReason] = useState('');
  const [screenshot, setScreenshot] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [preparingSubmission, setPreparingSubmission] = useState(false);
  const [optimisticallyClosed, setOptimisticallyClosed] = useState(false);
  const [recoveryState, setRecoveryState] = useState<
    'editable-error' | 'unknown-result' | null
  >(null);
  const [historyScheduleLoadStatus, setHistoryScheduleLoadStatus] = useState<
    'idle' | 'loading' | 'ready' | 'error'
  >('idle');
  const [authoritativeImpact, setAuthoritativeImpact] =
    useState<OvertimeRequestImpact | null>(null);
  const [recoveryCredential, setRecoveryCredential] = useState(() =>
    readOvertimeRequestRecoveryCredential(getSessionStorage()),
  );
  const submissionBindingRef = useRef<OvertimeRequestMutationBinding | null>(
    null,
  );
  const submissionSequenceRef = useRef(
    createOvertimeRequestSubmissionSequence(),
  );
  const submissionPreparationLifecycleRef = useRef(
    createOvertimeRequestPreparationLifecycle(),
  );
  const previousSchedulesRef = useRef(schedules);
  const requestInFlightRef = useRef(false);
  const submissionPreparationRef = useRef(false);
  const submissionPreparationFrameRef = useRef<number | null>(null);
  const submissionPreparationTimerRef = useRef<number | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const previouslyFocusedElementRef = useRef<HTMLElement | null>(null);
  const historyScheduleLoadSequenceRef = useRef(0);

  useEffect(
    () => () => {
      if (submissionPreparationFrameRef.current !== null) {
        window.cancelAnimationFrame(submissionPreparationFrameRef.current);
        submissionPreparationFrameRef.current = null;
      }
      if (submissionPreparationTimerRef.current !== null) {
        window.clearTimeout(submissionPreparationTimerRef.current);
        submissionPreparationTimerRef.current = null;
      }
      submissionPreparationLifecycleRef.current.invalidate();
      submissionSequenceRef.current.invalidate();
    },
    [],
  );

  useEffect(() => {
    if (!open) return undefined;
    setRangeClockMs(Date.now());
    const intervalId = window.setInterval(() => {
      setRangeClockMs(Date.now());
    }, 60_000);
    return () => window.clearInterval(intervalId);
  }, [open]);

  const loadHistorySchedules = useCallback(async () => {
    const requestId = historyScheduleLoadSequenceRef.current + 1;
    historyScheduleLoadSequenceRef.current = requestId;
    setHistoryScheduleLoadStatus('loading');
    try {
      const loaded = await ensureSchedulesForDateRange(
        listOvertimeHistoryScheduleCoverageDates(todayDate),
      );
      if (historyScheduleLoadSequenceRef.current !== requestId) return;
      setHistoryScheduleLoadStatus(loaded ? 'ready' : 'error');
    } catch {
      if (historyScheduleLoadSequenceRef.current === requestId) {
        setHistoryScheduleLoadStatus('error');
      }
    }
  }, [ensureSchedulesForDateRange, todayDate]);

  useEffect(() => {
    if (!open) return undefined;
    void loadHistorySchedules();
    return () => {
      historyScheduleLoadSequenceRef.current += 1;
    };
  }, [loadHistorySchedules, open]);

  const uniqueProfiles = useMemo(() => {
    const byName = new Map<string, OvertimePersonProfile>();
    personProfiles.forEach((profile) => {
      if (!canSelectWorkforcePerson(access, profile.buildingsSpecialties)) return;
      const name = normalizeProfileName(profile);
      if (name && !byName.has(name)) byName.set(name, profile);
    });
    return Array.from(byName.values()).sort((left, right) =>
      normalizeProfileName(left).localeCompare(
        normalizeProfileName(right),
        'zh-CN',
      ),
    );
  }, [personProfiles, access.accountId, access.displayName]);

  const filteredProfiles = useMemo(() => {
    const keyword = staffSearch.trim().toLocaleLowerCase('zh-CN');
    return uniqueProfiles
      .filter((profile) => {
        if (!keyword) return true;
        const name = normalizeProfileName(profile).toLocaleLowerCase('zh-CN');
        return name.includes(keyword);
      })
      .slice(0, 20);
  }, [staffSearch, uniqueProfiles]);

  const selectedProfile = useMemo(
    () =>
      uniqueProfiles.find(
        (profile) => normalizeProfileName(profile) === staffName,
      ) || null,
    [staffName, uniqueProfiles],
  );

  const [personProfileRetryCount, setPersonProfileRetryCount] = useState(0);
  useEffect(() => {
    setPersonProfileRetryCount(0);
  }, [open, access.principalFingerprint]);

  useEffect(() => {
    if (
      !open || access.isLoading || selectedProfile ||
      personProfilesStatus === 'loading'
    ) return;
    if (personProfilesStatus !== 'error' && !memberName) return;
    if (personProfileRetryCount >= 2) return;
    const timer = window.setTimeout(() => {
      setPersonProfileRetryCount((count) => count + 1);
      void onRetryPersonProfiles();
    }, 1000 * 2 ** personProfileRetryCount);
    return () => window.clearTimeout(timer);
  }, [
    open, access.isLoading, access.principalFingerprint, memberName,
    selectedProfile, personProfilesStatus, onRetryPersonProfiles, personProfileRetryCount,
  ]);

  const startAt = createShanghaiOvertimeDateTime(startDate, startTime);
  const endAt = createShanghaiOvertimeDateTime(endDate, endTime);
  const rangeCovered = isOvertimeScheduleRangeCovered(
    schedules,
    startDate,
    endDate,
  );
  const endAfterStart = Boolean(
    startAt && endAt && Date.parse(endAt) > Date.parse(startAt),
  );
  const calculatedImpact = useMemo(() => {
    if (!startAt || !endAt) return createEmptyImpact();
    return calculateOvertimeRequestImpact(schedules, {
      staffName,
      startAt,
      endAt,
      staffShift: selectedProfile?.shift || null,
    });
  }, [endAt, schedules, selectedProfile?.shift, staffName, startAt]);
  const displayedImpact = authoritativeImpact || calculatedImpact;
  const invalidRangeMessage = getOvertimeInvalidRangeMessage(
    displayedImpact.invalidRangeReason,
  );
  const isLocked =
    recoveryState === 'unknown-result' &&
    submissionBindingRef.current?.state === 'unknown-result';
  const currentRange = {
    startDate,
    startTime,
    endDate,
    endTime,
  };
  const currentRangeRef = useRef(currentRange);
  currentRangeRef.current = currentRange;
  const endDateOptions = useMemo(
    () => listOvertimeEndDates(availableDates, startDate),
    [availableDates, startDate],
  );
  const endTimeOptions = useMemo(
    () => listOvertimeEndTimes(HOUR_OPTIONS, startDate, startTime, endDate),
    [endDate, startDate, startTime],
  );
  const rangeSelectable = isOvertimeRangeSelectable(
    availableDates,
    currentRange,
    new Date(rangeClockMs),
  );
  const formBusy = submitting || preparingSubmission;
  const canSubmitCurrentDraft =
    canUseSelfServiceTools &&
    (memberName === undefined || (!!memberName && staffName === memberName)) &&
    Boolean(selectedProfile) &&
    Boolean(selectedProfile?.shift?.trim()) &&
    Boolean(startAt && endAt) &&
    rangeSelectable &&
    rangeCovered &&
    endAfterStart &&
    displayedImpact.canSubmit &&
    displayedImpact.rawHours >= 1 &&
    reason.trim().length > 0 &&
    reason.trim().length <= OVERTIME_REASON_MAX_LENGTH &&
    Boolean(screenshot);

  const clearAuthoritativeImpact = useCallback(() => {
    setAuthoritativeImpact(null);
    if (recoveryState === 'editable-error') {
      setRecoveryState(null);
    }
  }, [recoveryState]);

  const applyStartRangeChange = useCallback(
    (change: { startDate?: string; startTime?: string }) => {
      const next = reconcileOvertimeRangeAfterStartChange(
        currentRangeRef.current,
        change,
      );
      setStartDate(next.startDate);
      setStartTime(next.startTime);
      setEndDate(next.endDate);
      setEndTime(next.endTime);
      clearAuthoritativeImpact();
    },
    [clearAuthoritativeImpact],
  );

  useEffect(() => {
    if (previousSchedulesRef.current === schedules) return;
    previousSchedulesRef.current = schedules;
    setAuthoritativeImpact((current) =>
      resolveOvertimeAuthoritativeImpactAfterSchedulesChange(
        current,
        recoveryState,
      ),
    );
  }, [recoveryState, schedules]);

  useEffect(() => {
    if (!open || isLocked) return;
    const current = currentRangeRef.current;
    const next = reconcileOvertimeRangeWithAvailability(
      availableDates,
      current,
      new Date(rangeClockMs),
    );
    if (
      next.startDate === current.startDate &&
      next.startTime === current.startTime &&
      next.endDate === current.endDate &&
      next.endTime === current.endTime
    ) {
      return;
    }
    setStartDate(next.startDate);
    setStartTime(next.startTime);
    setEndDate(next.endDate);
    setEndTime(next.endTime);
    setAuthoritativeImpact(null);
    if (recoveryState === 'editable-error') setRecoveryState(null);
  }, [availableDates, isLocked, open, rangeClockMs, recoveryState]);

  const invalidateSubmissionPreparation = useCallback(() => {
    if (submissionPreparationFrameRef.current !== null) {
      window.cancelAnimationFrame(submissionPreparationFrameRef.current);
      submissionPreparationFrameRef.current = null;
    }
    if (submissionPreparationTimerRef.current !== null) {
      window.clearTimeout(submissionPreparationTimerRef.current);
      submissionPreparationTimerRef.current = null;
    }
    submissionPreparationLifecycleRef.current.invalidate();
    submissionPreparationRef.current = false;
    setPreparingSubmission(false);
  }, []);

  const handleDialogOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (nextOpen) setOptimisticallyClosed(false);
      if (
        !nextOpen &&
        !submissionPreparationRef.current &&
        !requestInFlightRef.current
      ) {
        invalidateSubmissionPreparation();
      }
      onOpenChange(nextOpen);
    },
    [invalidateSubmissionPreparation, onOpenChange],
  );

  const dialogVisible = open && !optimisticallyClosed;
  const requestDialogClose = useCallback(() => {
    if (formBusy) return;
    handleDialogOpenChange(false);
  }, [formBusy, handleDialogOpenChange]);

  const handleBackdropClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (event.target !== event.currentTarget) return;
      requestDialogClose();
    },
    [requestDialogClose],
  );

  useLayoutEffect(() => {
    if (!dialogVisible || typeof document === 'undefined') return undefined;

    cancelOvertimeDialogFocusRestore(focusCoordinator);
    const activeElement = document.activeElement;
    if (!focusCoordinator.returnElementRef.current?.isConnected) {
      focusCoordinator.returnElementRef.current =
        activeElement instanceof HTMLElement ? activeElement : null;
    }
    previouslyFocusedElementRef.current =
      focusCoordinator.returnElementRef.current;
    const previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeButtonRef.current?.focus({ preventScroll: true });
    const focusFrame = window.requestAnimationFrame(() => {
      if (!focusCoordinator.openRef.current) return;
      closeButtonRef.current?.focus({ preventScroll: true });
    });

    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.body.style.overflow = previousBodyOverflow;
      const previouslyFocusedElement = previouslyFocusedElementRef.current;
      previouslyFocusedElementRef.current = null;
      if (previouslyFocusedElement?.isConnected) {
        focusCoordinator.returnElementRef.current = previouslyFocusedElement;
      }
      scheduleOvertimeDialogFocusRestore(focusCoordinator);
    };
  }, [dialogVisible, focusCoordinator]);

  useEffect(() => {
    if (!dialogVisible || typeof document === 'undefined') return undefined;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (formBusy) return;
        event.preventDefault();
        event.stopPropagation();
        handleDialogOpenChange(false);
        return;
      }

      if (event.key !== 'Tab') return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusableElements = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          OVERTIME_DIALOG_FOCUSABLE_SELECTOR,
        ),
      ).filter(isOvertimeDialogFocusableElementVisible);

      if (focusableElements.length === 0) {
        event.preventDefault();
        dialog.focus({ preventScroll: true });
        return;
      }

      const firstFocusableElement = focusableElements[0];
      const lastFocusableElement =
        focusableElements[focusableElements.length - 1];
      const activeElement = document.activeElement;

      if (event.shiftKey) {
        if (
          !dialog.contains(activeElement) ||
          activeElement === firstFocusableElement
        ) {
          event.preventDefault();
          lastFocusableElement.focus({ preventScroll: true });
        }
        return;
      }

      if (
        !dialog.contains(activeElement) ||
        activeElement === lastFocusableElement
      ) {
        event.preventDefault();
        firstFocusableElement.focus({ preventScroll: true });
      }
    };

    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [dialogVisible, formBusy, handleDialogOpenChange]);

  const resetDraft = useCallback(() => {
    setOptimisticallyClosed(false);
    setStaffName('');
    setStaffSearch('');
    setStaffPickerOpen(false);
    setStartDate('');
    setStartTime('');
    setEndDate('');
    setEndTime('');
    setReason('');
    setScreenshot(null);
    setAuthoritativeImpact(null);
    setRecoveryState(null);
    setRecoveryCredential(null);
  }, []);

  const validateCurrentDraft = useCallback((): string | null => {
    if (applicant.mode === 'login' || applicant.mode === 'error') return applicant.message;
    if (!canUseSelfServiceTools) return '当前身份不能提交加班申请';
    if (memberName !== undefined && (!memberName || staffName !== memberName)) return '加班申请人员必须为当前登录本人';
    if (!staffName.trim()) return '请选择加班人员';
    if (!selectedProfile) return '请从人员名单中选择加班人员';
    if (!selectedProfile.shift?.trim()) {
      return '加班人员班次信息缺失，请先在人员表维护';
    }
    if (!startAt || !endAt) return '请选择有效的整点开始和结束时间';
    if (!isOvertimeRangeSelectable(availableDates, currentRangeRef.current)) {
      return '所选时间已过期或不在当前可选日期内，请重新选择';
    }
    if (!rangeCovered) return '请先切换到对应排班月份后再申请';
    if (!endAfterStart) return '结束时间必须晚于开始时间';
    if (invalidRangeMessage) return invalidRangeMessage;
    if (displayedImpact.rawHours < 1) {
      return '每次加班至少 1 小时，开始和结束时间必须为整点';
    }
    if (displayedImpact.conflictingSchedules.length > 0) {
      return '所选时间与本人正常排班冲突，请调整加班时段';
    }
    if (!displayedImpact.canSubmit) return '当前加班时段不可提交';
    if (!reason.trim()) return '请填写加班原因';
    if (reason.trim().length > OVERTIME_REASON_MAX_LENGTH) {
      return '加班原因不能超过 2000 字';
    }
    if (!screenshot) return '请上传加班举证';
    return null;
  }, [
    applicant,
    memberName,
    availableDates,
    canUseSelfServiceTools,
    displayedImpact,
    endAfterStart,
    endAt,
    invalidRangeMessage,
    rangeCovered,
    reason,
    screenshot,
    selectedProfile,
    staffName,
    startAt,
  ]);

  const handleSubmit = useCallback(() => {
    if (
      requestInFlightRef.current ||
      submissionPreparationRef.current ||
      submitting
    ) {
      return;
    }
    const lockedBinding =
      submissionBindingRef.current?.state === 'unknown-result'
        ? submissionBindingRef.current
        : null;
    if (applicant.mode === 'login' || applicant.mode === 'error') {
      if (applicant.mode === 'login') access.requestLogin(applicant.message, '/monthly-schedule');
      else toast.error(applicant.message);
      return;
    }
    if (lockedBinding && memberName !== undefined && lockedBinding.snapshot.staffName !== memberName) {
      toast.error('上次申请属于其他账号，请使用原账号登录后核对结果');
      return;
    }
    if (!lockedBinding) {
      const validationError = validateCurrentDraft();
      if (validationError) {
        toast.warning(validationError);
        return;
      }
    }
    if (!lockedBinding && (!startAt || !endAt || !screenshot)) return;

    const snapshot = lockedBinding
      ? null
      : Object.freeze({
          staffName: staffName.trim(),
          startAt: startAt as string,
          endAt: endAt as string,
          reason: reason.trim(),
          expectedImpact: displayedImpact,
          screenshot: screenshot as File,
        });
    submissionPreparationRef.current = true;
    flushSync(() => {
      setPreparingSubmission(true);
      setOptimisticallyClosed(true);
    });
    submissionPreparationFrameRef.current = window.requestAnimationFrame(() => {
      submissionPreparationFrameRef.current = null;
      submissionPreparationTimerRef.current = window.setTimeout(() => {
        submissionPreparationTimerRef.current = null;
        onBackgroundSyncChange(true);
        onOpenChange(false);
        const toastId = toast.info('加班申请已受理，正在后台同步');

        void coordinateOvertimeRequestPreparation<OvertimeRequestPreparedSubmission>(
          {
            lifecycle: submissionPreparationLifecycleRef.current,
            prepare: async () => {
              if (lockedBinding) {
                return {
                  status: 'resolution',
                  resolution: {
                    status: 'ready',
                    binding: lockedBinding,
                    reused: true,
                  },
                };
              }
              if (!snapshot) throw new Error('missing overtime snapshot');
              const snapshotDigest =
                await createOvertimeRequestSnapshotDigest(snapshot);
              if (!snapshotDigest) return { status: 'digest-unavailable' };
              if (
                recoveryCredential &&
                recoveryCredential.snapshotDigest !== snapshotDigest
              ) {
                return { status: 'recovery-mismatch' };
              }
              const recoveredBinding = recoveryCredential
                ? {
                    clientMutationId: recoveryCredential.clientMutationId,
                    snapshotDigest,
                    snapshot,
                    state: 'unknown-result' as const,
                  }
                : null;
              return {
                status: 'resolution',
                resolution: resolveOvertimeRequestMutationBinding(
                  submissionBindingRef.current || recoveredBinding,
                  snapshot,
                  snapshotDigest,
                  createOvertimeRequestMutationId,
                ),
              };
            },
            persist: (prepared) => {
              if (
                prepared.status !== 'resolution' ||
                prepared.resolution.status !== 'ready'
              ) {
                return true;
              }
              const binding = prepared.resolution.binding;
              return persistOvertimeRequestRecoveryCredential(
                getSessionStorage(),
                {
                  clientMutationId: binding.clientMutationId,
                  snapshotDigest: binding.snapshotDigest,
                },
              );
            },
            commit: (prepared) => {
              if (prepared.status === 'digest-unavailable') {
                setOptimisticallyClosed(false);
                toast.error(
                  '无法安全校验本次加班申请，请保持弹窗并重新上传附件',
                  {
                    id: toastId,
                  },
                );
                onOpenChange(true);
                onBackgroundSyncChange(false);
                return;
              }
              if (prepared.status === 'recovery-mismatch') {
                setOptimisticallyClosed(false);
                toast.warning(
                  '检测到待确认的加班申请，请恢复原申请内容和同一附件后安全重试',
                  { id: toastId },
                );
                onOpenChange(true);
                onBackgroundSyncChange(false);
                return;
              }
              const { resolution } = prepared;
              if (resolution.status === 'blocked') {
                setOptimisticallyClosed(false);
                setRecoveryState('unknown-result');
                setAuthoritativeImpact(
                  resolution.binding.snapshot.expectedImpact,
                );
                toast.warning(
                  '原加班申请结果仍待确认，请保持原内容并安全重试',
                  {
                    id: toastId,
                  },
                );
                onOpenChange(true);
                onBackgroundSyncChange(false);
                return;
              }

              const binding = resolution.binding;
              submissionBindingRef.current = binding;
              const sequence = submissionSequenceRef.current.next();
              requestInFlightRef.current = true;
              setSubmitting(true);
              setRecoveryState(null);
              setRecoveryCredential(null);
              submissionPreparationRef.current = false;
              setPreparingSubmission(false);
              const draft = Object.freeze({
                ...binding.snapshot,
                clientMutationId: binding.clientMutationId,
              });

              void createOvertimeRequest(
                {
                  clientMutationId: draft.clientMutationId,
                  staffName: draft.staffName,
                  startAt: draft.startAt,
                  endAt: draft.endAt,
                  reason: draft.reason,
                  expectedImpact: draft.expectedImpact,
                },
                draft.screenshot,
              )
                .then((result) => {
                  if (
                    !submissionSequenceRef.current.isCurrent(sequence) ||
                    submissionBindingRef.current?.clientMutationId !==
                      draft.clientMutationId
                  ) {
                    return;
                  }
                  const response = resolveOvertimeRequestSuccessResponse(
                    result,
                    draft,
                  );
                  submissionBindingRef.current = null;
                  clearOvertimeRequestRecoveryCredential(getSessionStorage());
                  resetDraft();
                  toast.success(
                    `加班申请已提交，共 ${response.impact.payableHours} 小时，待审批通过后生效`,
                    { id: toastId },
                  );
                })
                .catch((error: unknown) => {
                  if (
                    !submissionSequenceRef.current.isCurrent(sequence) ||
                    submissionBindingRef.current?.clientMutationId !==
                      draft.clientMutationId
                  ) {
                    return;
                  }
                  const failedBinding = markOvertimeRequestMutationFailure(
                    submissionBindingRef.current,
                    error,
                  );
                  submissionBindingRef.current = failedBinding;
                  const unknownResult =
                    failedBinding.state === 'unknown-result';
                  setRecoveryState(
                    unknownResult ? 'unknown-result' : 'editable-error',
                  );
                  if (unknownResult) {
                    setAuthoritativeImpact(draft.expectedImpact);
                  } else {
                    clearOvertimeRequestRecoveryCredential(getSessionStorage());
                    setRecoveryCredential(null);
                    if (isBackendStatus(error, 409)) {
                      const latestImpact =
                        getLatestOvertimeImpactFromError(error);
                      if (latestImpact) setAuthoritativeImpact(latestImpact);
                    }
                  }
                  logger.error('提交加班失败', {
                    code: 'OVERTIME_REQUEST_SYNC_FAILED',
                  });
                  const message = getOvertimeRequestErrorMessage(
                    error,
                    '加班申请提交失败，请稍后重试',
                  );
                  toast.error(
                    unknownResult
                      ? `${message}；提交结果待确认，草稿已锁定，请安全重试`
                      : `${message}；草稿已保留，可修改后重试`,
                    { id: toastId },
                  );
                  setOptimisticallyClosed(false);
                  onOpenChange(true);
                })
                .finally(() => {
                  if (submissionSequenceRef.current.isCurrent(sequence)) {
                    requestInFlightRef.current = false;
                    setSubmitting(false);
                    onBackgroundSyncChange(false);
                  }
                });
            },
            onPersistFailure: () => {
              setOptimisticallyClosed(false);
              toast.error('浏览器无法保存本次申请凭据，请检查存储设置后重试', {
                id: toastId,
              });
              onOpenChange(true);
              onBackgroundSyncChange(false);
            },
            onPrepareFailure: () => {
              setOptimisticallyClosed(false);
              toast.error('无法安全校验本次加班申请，请保持弹窗后重试', {
                id: toastId,
              });
              onOpenChange(true);
              onBackgroundSyncChange(false);
            },
            onSettled: () => {
              submissionPreparationRef.current = false;
              setPreparingSubmission(false);
            },
          },
        );
      }, 0);
    });
  }, [
    applicant,
    access.requestLogin,
    memberName,
    displayedImpact,
    endAt,
    onBackgroundSyncChange,
    onOpenChange,
    reason,
    recoveryCredential,
    resetDraft,
    screenshot,
    staffName,
    startAt,
    submitting,
    validateCurrentDraft,
  ]);

  if (!dialogVisible || typeof document === 'undefined') return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-slate-950/45 p-4"
      onClick={handleBackdropClick}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="overtime-request-dialog-title"
        tabIndex={-1}
        className="flex max-h-[90vh] w-full max-w-4xl flex-col overflow-hidden rounded-lg border border-blue-100 bg-white shadow-xl"
      >
        <div className="flex items-center justify-between border-b border-slate-100 px-6 py-5">
          <h2
            id="overtime-request-dialog-title"
            className="flex items-center gap-2 text-xl font-semibold text-slate-900"
          >
            <CalendarClock className="h-5 w-5 text-blue-600" />
            加班申请
          </h2>
          <button
            ref={closeButtonRef}
            type="button"
            aria-label="关闭加班申请"
            disabled={formBusy}
            onClick={requestDialogClose}
            className="rounded-lg p-2 text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 py-5">
          <div className="grid gap-2">
            <label
              htmlFor="overtime-staff-search"
              className="text-sm font-semibold text-slate-600"
            >
              加班人员 <span className="text-rose-600">*</span>
            </label>
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-3.5 h-4 w-4 text-slate-400" />
              <Input
                id="overtime-staff-search"
                value={memberName ?? staffSearch}
                readOnly={memberName !== undefined}
                disabled={formBusy || isLocked}
                onFocus={() => { if (memberName === undefined) setStaffPickerOpen(true); }}
                onChange={(event) => {
                  const value = event.target.value;
                  setStaffSearch(value);
                  if (value.trim() !== staffName) setStaffName('');
                  setStaffPickerOpen(true);
                  clearAuthoritativeImpact();
                }}
                placeholder="输入姓名快速匹配"
                autoComplete="off"
                className="h-11 pl-9"
              />
              {memberName === undefined && staffPickerOpen && !isLocked && (
                <div className="absolute z-20 mt-1 max-h-56 w-full overflow-y-auto rounded-lg border border-blue-100 bg-white p-1 shadow-lg">
                  {filteredProfiles.length > 0 ? (
                    filteredProfiles.map((profile) => {
                      const name = normalizeProfileName(profile);
                      return (
                        <button
                          key={name}
                          type="button"
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() => {
                            setStaffName(name);
                            setStaffSearch(name);
                            setStaffPickerOpen(false);
                            clearAuthoritativeImpact();
                          }}
                          className="flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-sm text-slate-700 hover:bg-blue-50 hover:text-blue-700"
                        >
                          <span className="font-medium">{name}</span>
                          {staffName === name && (
                            <Check className="h-4 w-4 text-blue-600" />
                          )}
                        </button>
                      );
                    })
                  ) : (
                    <div className="px-3 py-4 text-center text-sm text-slate-400">
                      未找到匹配人员
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          {!selectedProfile && (memberName || personProfilesStatus !== 'ready') && (
            <div
              className="flex items-center justify-between gap-3 text-sm text-amber-700"
              role={personProfilesStatus === 'loading' ? 'status' : 'alert'}
            >
              <span>
                {personProfilesStatus === 'loading'
                  ? '正在读取人员资料…'
                  : personProfilesStatus === 'error'
                    ? '人员资料读取失败，请重试。'
                    : '未匹配到登录人员，请重试；仍未匹配时请联系管理员核对人员资料。'}
              </span>
              <Button
                type="button"
                variant="outline"
                className="shrink-0"
                disabled={personProfilesStatus === 'loading' || formBusy || isLocked}
                onClick={() => void onRetryPersonProfiles()}
              >
                {personProfilesStatus === 'loading' ? '读取中' : '重试'}
              </Button>
            </div>
          )}
          {selectedProfile && (
            <>
              <div className="grid gap-3 rounded-lg border border-blue-100 bg-blue-50/50 p-4 sm:grid-cols-3">
                <div>
                  <div className="text-xs text-slate-500">所属楼栋</div>
                  <div className="mt-1 text-sm font-medium text-slate-800">
                    {selectedProfile.buildingsSpecialties.join('、') || '—'}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-slate-500">岗位</div>
                  <div className="mt-1 text-sm font-medium text-slate-800">
                    {selectedProfile.position || '—'}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-slate-500">默认班次</div>
                  <div className="mt-1 text-sm font-medium text-slate-800">
                    {selectedProfile.shift || '—'}
                  </div>
                </div>
              </div>
              {!selectedProfile.shift?.trim() && (
                <div
                  role="alert"
                  className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700"
                >
                  加班人员班次信息缺失，请先在人员表维护
                </div>
              )}
            </>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <fieldset className="grid gap-2" disabled={formBusy || isLocked}>
              <legend className="mb-1 text-sm font-semibold text-slate-600">
                开始时间
              </legend>
              <div className="grid grid-cols-[minmax(0,1.65fr)_minmax(0,1fr)] gap-2">
                <select
                  aria-label="加班开始日期"
                  value={startDate}
                  onChange={(event) => {
                    applyStartRangeChange({ startDate: event.target.value });
                  }}
                  className="h-11 min-w-0 rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-800 outline-none focus:border-blue-500"
                >
                  <option value="">选择日期</option>
                  {availableDates.map((date) => (
                    <option key={date} value={date}>
                      {date}
                    </option>
                  ))}
                </select>
                <select
                  aria-label="加班开始时刻"
                  value={startTime}
                  onChange={(event) => {
                    applyStartRangeChange({ startTime: event.target.value });
                  }}
                  className="h-11 min-w-0 rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-800 outline-none focus:border-blue-500"
                >
                  <option value="">整点</option>
                  {HOUR_OPTIONS.map((time) => (
                    <option key={time} value={time}>
                      {time}
                    </option>
                  ))}
                </select>
              </div>
            </fieldset>

            <fieldset className="grid gap-2" disabled={formBusy || isLocked}>
              <legend className="mb-1 text-sm font-semibold text-slate-600">
                结束时间
              </legend>
              <div className="grid grid-cols-[minmax(0,1.65fr)_minmax(0,1fr)] gap-2">
                <select
                  aria-label="加班结束日期"
                  value={endDate}
                  onChange={(event) => {
                    setEndDate(event.target.value);
                    clearAuthoritativeImpact();
                  }}
                  className="h-11 min-w-0 rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-800 outline-none focus:border-blue-500"
                >
                  <option value="">选择日期</option>
                  {endDateOptions.map((date) => (
                    <option key={date} value={date}>
                      {date}
                    </option>
                  ))}
                </select>
                <select
                  aria-label="加班结束时刻"
                  value={endTime}
                  onChange={(event) => {
                    setEndTime(event.target.value);
                    clearAuthoritativeImpact();
                  }}
                  className="h-11 min-w-0 rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-800 outline-none focus:border-blue-500"
                >
                  <option value="">整点</option>
                  {endTimeOptions.map((time) => (
                    <option key={time} value={time}>
                      {time}
                    </option>
                  ))}
                </select>
              </div>
            </fieldset>
          </div>

          {historyScheduleLoadStatus === 'loading' ? (
            <div
              role="status"
              className="rounded-lg border border-blue-100 bg-blue-50 px-4 py-3 text-sm text-blue-700"
            >
              正在加载过去 30 天的排班…
            </div>
          ) : historyScheduleLoadStatus === 'error' ? (
            <div
              role="alert"
              className="flex items-center justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700"
            >
              <span>加载过去 30 天排班失败，已保留当前可用日期。</span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => void loadHistorySchedules()}
              >
                重新加载
              </Button>
            </div>
          ) : availableDates.length === 0 || !rangeCovered ? (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700">
              当前可用排班不完整，请重新加载后再申请。
            </div>
          ) : startAt && endAt && !endAfterStart ? (
            <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
              结束时间必须晚于开始时间。
            </div>
          ) : startAt && endAt && invalidRangeMessage ? (
            <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
              {invalidRangeMessage}
            </div>
          ) : displayedImpact.conflictingSchedules.length > 0 ? (
            <div className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">
              <div className="font-semibold">所选时间与本人正常排班冲突</div>
              <div className="mt-2 space-y-1">
                {displayedImpact.conflictingSchedules.map((schedule) => (
                  <div key={`${schedule.recordId}-${schedule.date}`}>
                    {schedule.date} · {schedule.building || '未标楼栋'} ·{' '}
                    {schedule.shift || '未标班次'} · 重叠{' '}
                    {schedule.overlapHours} 小时
                  </div>
                ))}
              </div>
            </div>
          ) : displayedImpact.rawHours > 0 ? (
            <div className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-4 text-blue-800">
              <span className="text-sm font-medium">加班工时：</span>
              <span className="text-xl font-bold">
                {displayedImpact.payableHours} 小时
              </span>
            </div>
          ) : null}

          <div className="grid gap-2">
            <label
              htmlFor="overtime-reason"
              className="text-sm font-semibold text-slate-600"
            >
              加班原因 <span className="text-rose-600">*</span>
            </label>
            <Textarea
              id="overtime-reason"
              value={reason}
              disabled={formBusy || isLocked}
              onChange={(event) => setReason(event.target.value)}
              maxLength={2000}
              placeholder="填写加班原因"
              className="min-h-28 resize-none"
            />
            <div className="text-right text-xs text-slate-400">
              {reason.length}/{OVERTIME_REASON_MAX_LENGTH}
            </div>
          </div>

          <LeaveRequestScreenshotField
            file={screenshot}
            disabled={formBusy || isLocked}
            active={open}
            inputId="overtime-evidence"
            label="加班举证"
            previewAlt="加班举证预览"
            stableClipboardName="overtime-evidence"
            onChange={(file) => {
              setScreenshot(file);
              primeOvertimeRequestScreenshotDigest(file);
            }}
            onRemove={() => setScreenshot(null)}
            onError={(message) => toast.warning(message)}
          />

          {isLocked && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700">
              上次提交结果待确认，当前内容已锁定，请使用原申请标识安全重试。
            </div>
          )}
          {recoveryCredential && !isLocked && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700">
              检测到上次提交结果待确认，请恢复原申请内容和同一附件后安全重试。
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-slate-100 bg-white px-6 py-4">
          <Button
            type="button"
            variant="outline"
            disabled={formBusy}
            onClick={requestDialogClose}
          >
            取消
          </Button>
          <Button
            type="button"
            disabled={
              formBusy ||
              !canUseSelfServiceTools ||
              (!isLocked && !canSubmitCurrentDraft)
            }
            onClick={() => {
              void handleSubmit();
            }}
            className="bg-blue-600 text-white hover:bg-blue-700"
          >
            <CalendarClock className="mr-1.5 h-4 w-4" />
            {isLocked || recoveryCredential ? '安全重试' : '提交'}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
