import React, {
  useEffect,
  useState,
  useRef,
  useCallback,
  useMemo,
} from 'react';
import { createPortal, flushSync } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { logger } from '@lark-apaas/client-toolkit/logger';
import { useAccess } from '@/access/AccessProvider';
import { canUsePageAction } from '../business-action-access';
import { readSelfServiceSchedules } from './self-service-schedule-reader';
import type { SelfServiceScheduleResponse } from '@shared/self-service-schedule.interface';
import type { SelfServiceApplicant } from '@shared/self-service-applicant';
import { createScheduleReadCache } from './schedule-read-cache';
import { hasAuthenticatedAccessIdentity } from '@/access/access-policy';
import { resolveLeaveRequestApplicant } from '@shared/leave-request-applicant';
import { canSelectWorkforcePerson } from '@shared/workforce-request-applicant';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Calendar, CalendarDayButton } from '@/components/ui/calendar';
import { StableScheduleCalendarRoot } from './calendar-root';
import { CalendarDayPreview } from './calendar-day-preview';
import { CalendarDayDialogHost, createCalendarDayDialogController, restoreCalendarDayDialogFocus } from './calendar-day-dialog';
import { projectCalendarChangeFollowUp } from './calendar-change-follow-up';
import { createCalendarDaySummaryCache, reuseSameDateValue } from './calendar-change-summary-cache';
import { calendarFollowUpRange, useCalendarFollowUps } from './use-calendar-follow-ups';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from '@/components/ui/hover-card';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Bell,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Sun,
  Moon,
  Cloud,
  Wind,
  Droplets,
  Thermometer,
  Clock,
  RefreshCw,
  Loader2,
  Camera,
  Wrench,
  UserPlus,
  UserCog,
  PencilLine,
  ClipboardPlus,
  CalendarClock,
  Undo2,
  Search,
  Check,
  RotateCcw,
  Trash2,
  ShieldAlert,
  AlertTriangle,
  FileSpreadsheet,
  BarChart3,
  ClipboardCheck,
  ClipboardList,
  X,
} from 'lucide-react';
import ReactECharts from 'echarts-for-react';
import type { EChartsOption } from 'echarts';
import {
  getMonthlySchedules,
  getScheduleSnapshotRevision,
  getEmergencyDutySchedules,
  getEmergencyDutyOptions,
  upsertEmergencyDutySchedule,
  getChinaWorkCalendar,
  getYearlyChangeInfo,
  getYearlySealingInfo,
  getFestivalSchedules,
  getTodayLeaveStaff,
  getPersonProfiles,
  getPersonProfileDetails,
  syncDutyScheduleToLocalFast,
  sendDutyOverviewScreenshot,
  updateVacancySubstitutes,
  updateDutyStaffAdjustment,
  updateTravelStaff,
  getTravelStaffDetails,
  getLongWhiteDutyStaff,
  adjustTravelStaff,
  revokeTravelStaff,
  createPersonnelMovement,
  createAdditionalMatter,
  createSealingRegistration,
  createLeaveRequest,
  createChangeRequest,
  getChangeRequestSyncTaskStatus,
  createChangeAdjustment,
  createChangeDrillReport,
  createChangeSummaryReport,
  abandonChangeSummaryReport,
  getChangeSummaryReportSyncTaskStatus,
  createExceptionFollowUp,
  getExceptionFollowUps,
  updateExceptionFollowUp,
  deleteExceptionFollowUp,
  getTodayFocusChecklist,
  updateChangeScheduleAdjustment,
  checkMonthlyScheduleScreenshotAccess,
} from '@/api';
import type { QWeatherHourly } from '@/api';
import type { EmergencyDutyPersonOption } from '@shared/emergency-duty.interface';
import {
  canSubmitChangeDrillReportForRole,
  canSubmitChangeSummaryReportForRole,
} from '@shared/access-control.interface';
import type {
  ChangeInfo,
  MonthlySchedule,
  SealingInfo,
  FestivalSchedule,
  LongWhiteDutyStaffByBuilding,
  TodayLeaveStaffByBuilding,
  NantongOrganization,
  PersonProfileDetail,
  PersonnelMovementType,
  TravelStaffDetail,
  ExceptionFollowUpItem,
  ExceptionFollowUpType,
  LeaveRequestType,
  SyncTaskStatusResponse,
} from '@shared/api.interface';
import { LEAVE_REQUEST_REASON_MAX_LENGTH } from '@shared/api.interface';
import {
  calculateLeaveRequestImpact,
  createLeaveRequestTimeCandidates,
  parseShanghaiLocalDateTime,
  selectDefaultLeaveEndAt,
  selectDefaultLeaveTimeRange,
  type LeaveRequestImpact,
} from '@shared/leave-request-impact';
import { installChinaWorkCalendarSnapshot } from '@shared/china-work-calendar';
import { canViewPersonProfileDetails } from '@shared/person-profile-access';
import {
  createEmptyChangeRequestDraft,
  validateChangeRequest,
  type ChangeRequestCreateResponse,
  type ChangeRequestCreateRequest,
  type ChangeRequestDraft,
  type ChangeRequestRetryAction,
  type ChangeRequestStagedDocument,
} from '@shared/change-request';
import type { ChangeAdjustmentRequest } from '@shared/change-adjustment';
import type { ChangeDrillReportCreateRequest } from '@shared/change-drill-report';
import type { ChangeSummaryReportCreateRequest } from '@shared/change-summary-report';
import {
  buildExceptionFollowUpTargetKeys,
  removeExceptionFollowUpItemFromIndex,
  selectExceptionFollowUpsByTarget,
  upsertExceptionFollowUpItemInIndex,
} from '@shared/exception-follow-up-match';
import { toast } from 'sonner';
import { getHolidayInfo, getLongWhiteRestInfo } from '@/utils/holidays';
import { UniversalLink } from '@lark-apaas/client-toolkit/components/UniversalLink';
import { buildTravelStaffGroups } from './travel-staff-groups';
import { OvertimeConfirmationDeepLinkHost } from './OvertimeConfirmationDeepLinkHost';
import {
  NewEmployeeOnboardingDialogHost,
  type NewEmployeeOnboardingDialogHandle,
} from './NewEmployeeOnboardingDialogHost';
import {
  applyDutyStaffActualUpdates,
  buildLeaveSubstitutionGroupsByBuilding,
  buildPersonnelMovementOverview,
} from './personnel-movements';
import type { DutyStaffActualUpdate } from './personnel-movements';
import {
  appendOptimisticDutyStaff,
  removeOptimisticDutyStaff,
  replaceScheduleMonthsFromAuthoritative,
  replaceOptimisticDutyStaff,
  restoreOptimisticSchedules,
} from './optimistic-schedule';
import {
  beginLatestDutyOverviewRequest,
  createDutyOverviewScreenshotReadiness,
  isDutyOverviewScreenshotReady,
  resetDutyOverviewScreenshotReadinessForDate,
  type DutyOverviewScreenshotLoadState,
  type DutyOverviewScreenshotSection,
} from './screenshot-readiness';
import {
  beginEmergencyDutyMutation,
  buildEmergencyDutyIndex,
  classifyEmergencyDutyMutationError,
  formatEmergencyDutySummary,
  getEmergencyDutyByDate as getEmergencyDutyViewByDate,
  getEmergencyDutySubmissionIssue,
  mergeEmergencyDutySnapshot,
  resolveEmergencyDutyMutationFailure,
  resolveEmergencyDutyMutationSuccess,
  retryEmergencyDutyMutation,
  type EmergencyDutyIndex,
  type EmergencyDutyDayView,
  type EmergencyDutyLoadedRange,
  type EmergencyDutyLoadState,
  type EmergencyDutyMutationBinding,
  type EmergencyDutyPendingState,
} from './emergency-duty-state';
import { EmergencyDutyOptionList } from './emergency-duty-option-list';
import { buildTelephoneHref } from './personnel-contact-links';
import {
  useWeatherSnapshot,
  type UseWeatherSnapshotResult,
} from './use-weather-snapshot';
import { WeatherWarningInfoPopover } from './WeatherWarningInfoPopover';
import { WeatherWarningSnapshotSummary } from './WeatherWarningSnapshotSummary';
import { TodayAttendanceAnomalyList } from '@/components/attendance/TodayAttendanceAnomalyList';
import { useTodayAttendanceSnapshot } from '@/components/attendance/use-today-attendance';
import { WeatherWarningGuardRegistrationDialog } from './WeatherWarningGuardRegistrationDialog';
import {
  clearWeatherGuardRegistrationDeepLink,
  readWeatherGuardRegistrationDeepLink,
  type WeatherGuardRegistrationDeepLink,
} from './weather-warning-registration';
import { TyphoonPathDialog } from './TyphoonPathDialog';
import { SealingDetailDialog } from '../TodayOperationsPanorama/SealingDetailDialog';
import { buildNetworkFreezeDetailModel } from '../TodayOperationsPanorama/overview-model';
import { ChangeRequestDialog } from './ChangeRequestDialog';
import { ChangeAdjustmentDialog } from './ChangeAdjustmentDialog';
import { ChangeDrillReportDialog } from './ChangeDrillReportDialog';
import { ChangeSummaryReportDialog } from './ChangeSummaryReportDialog';
import { ThresholdAdjustmentDialog } from './ThresholdAdjustmentDialog';
import { PersonnelTimeInsightsDialog } from '@/components/personnel-time-insights/PersonnelTimeInsightsDialog';
import { LeaveRequestHoursSummary } from './LeaveRequestHoursSummary';
import { LeaveRequestScheduleTimeFields } from './LeaveRequestScheduleTimeFields';
import { LeaveRequestScreenshotField } from './LeaveRequestScreenshotField';
import {
  clearLeaveRequestUnknownMutationId,
  coordinateLeaveRequestSubmit,
  markLeaveRequestMutationFailure,
  persistLeaveRequestUnknownMutationId,
  readLeaveRequestUnknownMutationId,
  resolveLeaveRequestMutationBinding,
  resolveLeaveRequestSuccessResponse,
  type LeaveRequestMutationBinding,
} from './leave-request-submit';
import {
  deduplicateScheduleDateKeysByMonth,
  getAdjacentScheduleMonthDateKeys,
  getLeaveScheduleCoverageDateKeys,
  resolveLeaveScheduleForceRefresh,
} from './leave-request-schedule-coverage';
import { readMonthlyScheduleFormDeepLink } from './monthly-schedule-form-deep-link';
import {
  createScheduleSnapshotRefreshCoordinator,
  getScheduleSnapshotRevalidationDateKeys,
  shouldPreserveLocalSnapshotData,
} from './schedule-snapshot-refresh';
import { getShanghaiBusinessDateKey } from './business-date';
import {
  createPendingChangeInfo,
  getChangeRequestAttachmentPartialFailure,
  getChangeInfoScheduleYear,
  resolveChangeInfoOverlayResponse,
  reconcilePendingChange,
  rollbackPendingChange,
  shouldRetainChangeRequestMutationIdAfterError,
} from './change-request-state';
import { applyPendingChangeAdjustment } from './change-adjustment-state';
import {
  clearChangeDrillReportRecovery,
  persistChangeDrillReportRecovery,
  readChangeDrillReportRecovery,
  type ChangeDrillReportRetryBinding,
} from './change-drill-report-recovery';
import {
  consumeChangeSummaryReportRecoveryAuthorization,
  getPendingChangeSummaryReportRecordIds,
  persistChangeSummaryReportRecovery,
  readChangeSummaryReportRecoveries,
  removeChangeSummaryReportRecovery,
  removeChangeSummaryReportRecoveryBinding,
  upsertChangeSummaryReportRecoveryBinding,
  type ChangeSummaryReportRecoveryBinding,
  type ChangeSummaryReportRecoveryOriginal,
} from './change-summary-report-recovery';
import { createChangeSummaryReportMutationId } from './change-summary-report-state';
import {
  abandonFailedChangeSummaryReport,
  ChangeSummaryReportCleanupPendingError,
  ChangeSummaryReportTaskFailedError,
  ChangeSummaryReportTaskIdentityError,
  coordinateChangeSummaryReportAcceptance,
  disposeChangeSummaryReportTaskRuntimes,
  isCurrentChangeSummaryReportAbandonOperation,
  isCurrentChangeSummaryReportTaskRuntime,
  pollChangeSummaryReportTask,
  type ChangeSummaryReportAbandonOperation,
} from './change-summary-report-task';
import { LeaveRequestPersonPicker } from './LeaveRequestPersonPicker';
import { cn } from '@/lib/utils';

type OvertimeRequestDialogModule = typeof import('./OvertimeRequestDialog');

let overtimeRequestDialogModulePromise: Promise<OvertimeRequestDialogModule> | null =
  null;

function loadOvertimeRequestDialogModule() {
  if (!overtimeRequestDialogModulePromise) {
    overtimeRequestDialogModulePromise =
      import('./OvertimeRequestDialog').catch((error) => {
        overtimeRequestDialogModulePromise = null;
        throw error;
      });
  }
  return overtimeRequestDialogModulePromise;
}

function OvertimeRequestDialogPreloader({ onReady }: { onReady: () => void }) {
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;

    let active = true;
    const preload = () => {
      void loadOvertimeRequestDialogModule()
        .then(() => {
          if (active) onReady();
        })
        .catch(() => undefined);
    };

    const idleWindow = window as Window & {
      requestIdleCallback?: (
        callback: () => void,
        options?: { timeout: number },
      ) => number;
      cancelIdleCallback?: (handle: number) => void;
    };
    if (typeof idleWindow.requestIdleCallback === 'function') {
      const idleHandle = idleWindow.requestIdleCallback(preload, {
        timeout: 1_000,
      });
      return () => {
        active = false;
        idleWindow.cancelIdleCallback?.(idleHandle);
      };
    }

    const timeoutHandle = window.setTimeout(preload, 0);
    return () => {
      active = false;
      window.clearTimeout(timeoutHandle);
    };
  }, [onReady]);

  return null;
}

const LazyOvertimeRequestDialog = React.lazy(async () => {
  const module = await loadOvertimeRequestDialogModule();
  return { default: module.OvertimeRequestDialog };
});

interface OvertimeRequestDialogHostHandle {
  open: () => void;
  setOpen: (open: boolean) => void;
}

interface OvertimeRequestDialogFocusCoordinator {
  returnElementRef: React.MutableRefObject<HTMLElement | null>;
  restoreFrameRef: React.MutableRefObject<number | null>;
  openRef: React.MutableRefObject<boolean>;
}

type OvertimeRequestDialogHostProps = Omit<
  React.ComponentProps<typeof LazyOvertimeRequestDialog>,
  'open' | 'onOpenChange' | 'onBackgroundSyncChange' | 'focusCoordinator'
>;

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

function OvertimeRequestDialogLoadingFallback({
  onClose,
  focusCoordinator,
}: {
  onClose: () => void;
  focusCoordinator: OvertimeRequestDialogFocusCoordinator;
}) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (typeof document === 'undefined') return undefined;

    cancelOvertimeDialogFocusRestore(focusCoordinator);
    const activeElement = document.activeElement;
    if (!focusCoordinator.returnElementRef.current?.isConnected) {
      focusCoordinator.returnElementRef.current =
        activeElement instanceof HTMLElement ? activeElement : null;
    }
    const previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeButtonRef.current?.focus({ preventScroll: true });
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key === 'Tab') {
        event.preventDefault();
        event.stopPropagation();
        closeButtonRef.current?.focus({ preventScroll: true });
      }
    };

    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      document.removeEventListener('keydown', handleKeyDown, true);
      document.body.style.overflow = previousBodyOverflow;
      if (!focusCoordinator.openRef.current) {
        scheduleOvertimeDialogFocusRestore(focusCoordinator);
      }
    };
  }, [focusCoordinator, onClose]);

  if (typeof document === 'undefined') return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-slate-950/45 p-4"
      onClick={(event) => {
        if (event.target !== event.currentTarget) return;
        onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="overtime-request-loading-title"
        className="w-full max-w-md overflow-hidden rounded-lg border border-blue-100 bg-white shadow-xl"
      >
        <div className="flex items-center justify-between border-b border-slate-100 px-6 py-5">
          <h2
            id="overtime-request-loading-title"
            className="flex items-center gap-2 text-xl font-semibold text-slate-900"
          >
            <CalendarClock className="h-5 w-5 text-blue-600" />
            加班申请
          </h2>
          <button
            ref={closeButtonRef}
            type="button"
            aria-label="关闭加班申请"
            onClick={onClose}
            className="rounded-lg p-2 text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>
        <div
          className="flex items-center gap-2 px-6 py-5 text-sm text-slate-600"
          role="status"
          aria-live="polite"
        >
          <Loader2 className="h-4 w-4 animate-spin text-blue-600" />
          正在打开加班申请...
        </div>
      </div>
    </div>,
    document.body,
  );
}

const OvertimeRequestDialogHost = React.memo(
  React.forwardRef<
    OvertimeRequestDialogHostHandle,
    OvertimeRequestDialogHostProps
  >(function OvertimeRequestDialogHost(dialogProps, ref) {
    const [open, setOpen] = useState(false);
    const [backgroundSyncing, setBackgroundSyncing] = useState(false);
    const [prewarmed, setPrewarmed] = useState(false);
    const focusCoordinatorRef = useRef<OvertimeRequestDialogFocusCoordinator>({
      returnElementRef: { current: null },
      restoreFrameRef: { current: null },
      openRef: { current: false },
    });
    const focusCoordinator = focusCoordinatorRef.current;
    focusCoordinator.openRef.current = open;
    const openDialog = useCallback(() => {
      if (backgroundSyncing) return;
      cancelOvertimeDialogFocusRestore(focusCoordinator);
      setOpen(true);
    }, [backgroundSyncing, focusCoordinator]);
    const closeDialog = useCallback(() => setOpen(false), []);
    const markPrewarmed = useCallback(() => setPrewarmed(true), []);

    React.useImperativeHandle(
      ref,
      () => ({
        open: openDialog,
        setOpen,
      }),
      [openDialog],
    );

    return (
      <>
        <OvertimeRequestDialogPreloader onReady={markPrewarmed} />
        {open || backgroundSyncing || prewarmed ? (
          <React.Suspense
            fallback={
              open ? (
                <OvertimeRequestDialogLoadingFallback
                  onClose={closeDialog}
                  focusCoordinator={focusCoordinatorRef.current}
                />
              ) : null
            }
          >
            <LazyOvertimeRequestDialog
              {...dialogProps}
              open={open}
              onOpenChange={setOpen}
              onBackgroundSyncChange={setBackgroundSyncing}
              focusCoordinator={focusCoordinatorRef.current}
            />
          </React.Suspense>
        ) : null}
      </>
    );
  }),
);

const BUILDING_MAP: Record<string, string> = {
  building_a: 'A栋',
  building_b: 'B栋',
  building_c: 'C栋',
  building_d: 'D栋',
  building_e: 'E栋',
  building_h: 'H栋',
  station_110: '110站',
};

const BUILDING_ORDER = [
  'building_h',
  'building_a',
  'building_b',
  'building_c',
  'building_d',
  'building_e',
  'station_110',
];
const VACANCY_BUILDING_ORDER = [
  'building_a',
  'building_b',
  'building_c',
  'building_d',
  'building_e',
  'building_h',
  'station_110',
];
const VACANCY_SHIFT_LABELS: Record<string, string> = {
  white: '白班',
  night: '夜班',
  long_white: '长白班',
};
const CALENDAR_WEEKDAY_LABELS = ['日', '一', '二', '三', '四', '五', '六'];
const CHINESE_CALENDAR_FORMATTERS = {
  formatCaption: (month: Date) =>
    `${month.getFullYear()}年${month.getMonth() + 1}月`,
  formatWeekdayName: (weekday: Date) =>
    CALENDAR_WEEKDAY_LABELS[weekday.getDay()],
};
const LOCAL_DATA_CACHE_TTL_MS = 4 * 60 * 60 * 1000;
const MONTHLY_SCHEDULE_CACHE_TTL_MS = LOCAL_DATA_CACHE_TTL_MS;
const SEALING_INFO_CACHE_TTL_MS = 5 * 60 * 1000;
const SEALING_INFO_REVALIDATE_INTERVAL_MS = 60 * 1000;
const EMERGENCY_DUTY_REVALIDATE_INTERVAL_MS = 60 * 1000;
const SCHEDULE_SNAPSHOT_REVALIDATE_INTERVAL_MS = 15 * 1000;
const TODAY_FOCUS_REFRESH_EVENT = 'today-focus-checklist-refresh';

interface LoadSchedulesOptions {
  silent?: boolean;
  preserveExistingOnError?: boolean;
  signal?: AbortSignal;
  additionalDateKeys?: readonly string[];
}
const PERSONNEL_MOVEMENT_TYPES: PersonnelMovementType[] = [
  '差旅',
  '异动',
  '离职',
];
const selectMonthlyScheduleReadScope = createScheduleReadCache(getMonthlySchedules);
const selectSelfServiceScheduleReadScope = createScheduleReadCache(readSelfServiceSchedules);

const yearlySealingCache = new Map<
  number,
  { sealings: SealingInfo[]; fetchedAt: number }
>();
const yearlyChangeCache = new Map<
  number,
  { changes: ChangeInfo[]; fetchedAt: number }
>();
const longWhiteScheduleCache = new Map<
  string,
  {
    longWhiteDutyBuildings: LongWhiteDutyStaffByBuilding[];
    festivalSchedules: FestivalSchedule[];
    leaveStaffData: TodayLeaveStaffByBuilding[];
    fetchedAt: number;
  }
>();

function formatDateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function getTodayDateKey(): string {
  return getShanghaiBusinessDateKey();
}

function createLeaveRequestMutationId(): string {
  return `leave-request-${crypto.randomUUID()}`;
}

function getLeaveRequestSessionStorage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function createChangeRequestMutationId(): string {
  return `change-request-${crypto.randomUUID()}`;
}

function createChangeAdjustmentMutationId(): string {
  return `change-adjustment-${crypto.randomUUID()}`;
}

function createChangeDrillReportMutationId(): string {
  return `change-drill-report-${crypto.randomUUID()}`;
}

interface ChangeAdjustmentRequestRetryBinding {
  request: ChangeAdjustmentRequest;
  original: ChangeInfo;
}

function cloneChangeRequestDraft(
  draft: ChangeRequestDraft,
): ChangeRequestDraft {
  return {
    ...draft,
    buildings: [...draft.buildings],
    stagedDocuments: [...(draft.stagedDocuments || [])],
  };
}

function updateCachedChanges(
  year: number,
  updater: (changes: ChangeInfo[]) => ChangeInfo[],
): void {
  const cached = yearlyChangeCache.get(year);
  if (!cached) return;
  yearlyChangeCache.set(year, {
    ...cached,
    changes: updater(cached.changes),
  });
}

function getDateTimeLocalValue(dateKey: string, time: string): string {
  const normalizedDate = /^\d{4}-\d{2}-\d{2}$/.test(dateKey)
    ? dateKey
    : getTodayDateKey();
  return `${normalizedDate}T${time}`;
}

function createChangeRequestDraftForDate(dateKey: string): ChangeRequestDraft {
  return {
    ...createEmptyChangeRequestDraft(),
    plannedStartAt: getDateTimeLocalValue(dateKey, '09:00'),
    plannedEndAt: getDateTimeLocalValue(dateKey, '18:00'),
  };
}

const CHANGE_REQUEST_SYNC_POLL_INTERVAL_MS = 1000;
const CHANGE_REQUEST_SYNC_POLL_MAX_ATTEMPTS = 360;

async function monitorChangeRequestSyncTask(
  taskId: string,
  shouldContinue: () => boolean,
): Promise<NonNullable<SyncTaskStatusResponse['task']> | null> {
  let missingCount = 0;
  for (
    let attempt = 0;
    attempt < CHANGE_REQUEST_SYNC_POLL_MAX_ATTEMPTS;
    attempt += 1
  ) {
    if (!shouldContinue()) return null;
    try {
      const response = await getChangeRequestSyncTaskStatus(taskId);
      if (response.success && response.task) {
        missingCount = 0;
        if (
          response.task.status === 'completed' ||
          response.task.status === 'failed'
        ) {
          return response.task;
        }
      } else {
        missingCount += 1;
        if (missingCount >= 3) {
          throw new Error(response.message || '变更申请后台任务不存在');
        }
      }
    } catch (error) {
      missingCount += 1;
      if (missingCount >= 3) throw error;
    }
    await new Promise<void>((resolve) => {
      window.setTimeout(resolve, CHANGE_REQUEST_SYNC_POLL_INTERVAL_MS);
    });
  }
  throw new Error('变更附件后台同步超时，请使用原申请重试附件');
}

interface ChangeRequestDialogHandle {
  setOpen: (open: boolean) => void;
}

interface ChangeRequestDialogHostProps extends Omit<
  React.ComponentProps<typeof ChangeRequestDialog>,
  'open' | 'onOpenChange'
> {
  onOpenStateChange: (open: boolean) => void;
}

const ChangeRequestDialogHost = React.memo(
  React.forwardRef<ChangeRequestDialogHandle, ChangeRequestDialogHostProps>(
    function ChangeRequestDialogHost(
      { onOpenStateChange, ...dialogProps },
      ref,
    ) {
      const [open, setDialogOpen] = useState(false);
      const applyOpenState = useCallback(
        (nextOpen: boolean) => {
          setDialogOpen(nextOpen);
          onOpenStateChange(nextOpen);
        },
        [onOpenStateChange],
      );
      const handleOpenChange = useCallback(
        (nextOpen: boolean) => applyOpenState(nextOpen),
        [applyOpenState],
      );

      React.useImperativeHandle(
        ref,
        () => ({
          setOpen: applyOpenState,
        }),
        [applyOpenState],
      );

      return (
        <ChangeRequestDialog
          key={dialogProps.resetKey}
          {...dialogProps}
          open={open}
          onOpenChange={handleOpenChange}
        />
      );
    },
  ),
);

type SealingRegistrationDraftRow = {
  id: string;
  sealingInfo: string;
  startTime: string;
  endTime: string;
};

function createSealingRegistrationDraftRow(
  dateKey: string,
  defaults: Partial<Omit<SealingRegistrationDraftRow, 'id'>> = {},
): SealingRegistrationDraftRow {
  return {
    id: `sealing-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    sealingInfo: defaults.sealingInfo || '',
    startTime: defaults.startTime || getDateTimeLocalValue(dateKey, '00:00'),
    endTime: defaults.endTime || getDateTimeLocalValue(dateKey, '23:59'),
  };
}

function getScheduleMonthKey(dateKey: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) {
    return null;
  }
  const [year, month] = dateKey.split('-').map(Number);
  return `${year}-${month}`;
}

function mergeSchedulesByRecord(
  currentSchedules: MonthlySchedule[],
  incomingSchedules: MonthlySchedule[],
): MonthlySchedule[] {
  const merged = new Map<string, MonthlySchedule>();
  [...currentSchedules, ...incomingSchedules].forEach((schedule) => {
    const key =
      schedule.recordId ||
      schedule.id ||
      [
        schedule.scheduleDate,
        schedule.building,
        schedule.team,
        schedule.shift,
      ].join('|');
    merged.set(key, schedule);
  });
  const result = Array.from(merged.values());
  return result.length === currentSchedules.length &&
    result.every((schedule, index) => schedule === currentSchedules[index])
    ? currentSchedules
    : result;
}

function getMonthEndDateKey(dateKey: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) {
    return dateKey;
  }
  const [year, month] = dateKey.split('-').map(Number);
  return formatDateKey(new Date(year, month, 0));
}

function getInclusiveDateRangeDays(startDate: string, endDate: string): number {
  const start = new Date(`${startDate}T00:00:00+08:00`);
  const end = new Date(`${endDate}T00:00:00+08:00`);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) {
    return 0;
  }
  return (
    Math.floor((end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000)) + 1
  );
}

function normalizeStaffSearchText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, '');
}

function isFuzzyStaffNameMatch(name: string, keyword: string): boolean {
  const normalizedName = normalizeStaffSearchText(name);
  const normalizedKeyword = normalizeStaffSearchText(keyword);
  if (!normalizedKeyword) {
    return true;
  }
  if (normalizedName.includes(normalizedKeyword)) {
    return true;
  }

  let keywordIndex = 0;
  for (const char of normalizedName) {
    if (char === normalizedKeyword[keywordIndex]) {
      keywordIndex += 1;
    }
    if (keywordIndex >= normalizedKeyword.length) {
      return true;
    }
  }
  return false;
}

function addDaysToDateKey(dateKey: string, days: number): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) {
    return null;
  }
  const [year, month, day] = dateKey.split('-').map(Number);
  const date = new Date(year, month - 1, day + days);
  return formatDateKey(date);
}

function formatDutyDateLabel(dateKey: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) {
    return dateKey;
  }
  const [, month, day] = dateKey.split('-').map(Number);
  return `${month}月${day}日`;
}

function notifyTodayFocusChecklistRefresh(detail: {
  date: string;
  type: 'focus' | 'customer';
  recordId: string;
  updatedAt: number;
}) {
  if (typeof window === 'undefined') return;

  window.dispatchEvent(new CustomEvent(TODAY_FOCUS_REFRESH_EVENT, { detail }));
  try {
    window.localStorage.setItem(
      TODAY_FOCUS_REFRESH_EVENT,
      JSON.stringify(detail),
    );
  } catch (error) {
    logger.warn('Failed to write today focus refresh signal', error);
  }
}

function getHasScreenshotModeRequest(): boolean {
  if (typeof window === 'undefined') return false;
  return new URLSearchParams(window.location.search).get('screenshot') === '1';
}

function getIsScreenshotMode(): boolean {
  if (typeof window === 'undefined') return false;
  return Boolean(
    getHasScreenshotModeRequest() &&
    (window as unknown as { __monthlyScheduleScreenshotAuthorized?: boolean })
      .__monthlyScheduleScreenshotAuthorized,
  );
}

function setMonthlyScheduleScreenshotAuthorized(authorized: boolean) {
  if (typeof window === 'undefined') return;
  (
    window as unknown as { __monthlyScheduleScreenshotAuthorized?: boolean }
  ).__monthlyScheduleScreenshotAuthorized = authorized;
}

function getInitialSelectedDate(): Date {
  const fallbackDateKey = getShanghaiBusinessDateKey();
  const value =
    typeof window === 'undefined'
      ? null
      : new URLSearchParams(window.location.search).get('screenshotDate');
  const dateKey =
    value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : fallbackDateKey;
  const [year, month, day] = dateKey.split('-').map(Number);
  return new Date(year, month - 1, day);
}

function formatSealingDateTime(value: string): string {
  return new Date(value).toLocaleString('zh-CN', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function toDateTimeLocalValue(value?: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';

  const pad = (input: number) => String(input).padStart(2, '0');
  return (
    [date.getFullYear(), pad(date.getMonth() + 1), pad(date.getDate())].join(
      '-',
    ) + `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

function formatChangeAdjustmentMessage(
  startDate: string | null | undefined,
  endDate: string | null | undefined,
): string {
  if (!startDate && !endDate) {
    return '已确认，封网不影响变更执行';
  }
  return `计划已调整，调整至：${startDate ? formatSealingDateTime(startDate) : '无调整'}开始 ${endDate ? formatSealingDateTime(endDate) : '无调整'}结束`;
}

function getBackendErrorMessage(error: unknown, fallback: string): string {
  const responseData = (error as { response?: { data?: unknown } })?.response
    ?.data;
  if (responseData && typeof responseData === 'object') {
    const data = responseData as Record<string, unknown>;
    const errorPayload = data.error;
    if (errorPayload && typeof errorPayload === 'object') {
      const message = (errorPayload as Record<string, unknown>).message;
      if (typeof message === 'string' && message.trim()) {
        return message;
      }
    }
    const message = data.message;
    if (typeof message === 'string' && message.trim()) {
      return message;
    }
  }

  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  return fallback;
}

function isBackendStatus(error: unknown, status: number): boolean {
  return (
    (error as { response?: { status?: unknown } })?.response?.status === status
  );
}

function getProtectedActionErrorMessage(
  error: unknown,
  fallback: string,
): string {
  const responseData = (error as { response?: { data?: unknown } })?.response
    ?.data;
  const responseText =
    typeof responseData === 'string'
      ? responseData
      : getBackendErrorMessage(error, '');
  if (isBackendStatus(error, 403) && /csrf/i.test(responseText)) {
    return '页面安全状态已过期，请刷新页面后重试';
  }
  if (isBackendStatus(error, 401) || isBackendStatus(error, 403)) {
    return '登录已过期，请重新登录后再试';
  }
  return getBackendErrorMessage(error, fallback);
}

function getBackendLatestLeaveImpact(
  error: unknown,
): LeaveRequestImpact | null {
  const responseData = (error as { response?: { data?: unknown } })?.response
    ?.data;
  if (!responseData || typeof responseData !== 'object') {
    return null;
  }

  const data = responseData as Record<string, unknown>;
  const errorPayload =
    data.error && typeof data.error === 'object'
      ? (data.error as Record<string, unknown>)
      : null;
  let candidate = data.latestImpact ?? errorPayload?.latestImpact;
  if (!candidate && typeof errorPayload?.details === 'string') {
    try {
      const details = JSON.parse(errorPayload.details) as unknown;
      if (details && typeof details === 'object') {
        candidate = (details as Record<string, unknown>).latestImpact;
      }
    } catch {
      return null;
    }
  }
  if (!candidate || typeof candidate !== 'object') {
    return null;
  }

  const impact = candidate as Partial<LeaveRequestImpact>;
  return Array.isArray(impact.affectedSchedules) &&
    Array.isArray(impact.excludedSchedules) &&
    typeof impact.rawHours === 'number' &&
    typeof impact.minimumHours === 'number' &&
    Array.isArray(impact.unrecognizedShifts) &&
    Array.isArray(impact.missingCalendarYears) &&
    typeof impact.invalidRange === 'boolean'
    ? (candidate as LeaveRequestImpact)
    : null;
}

function getExceptionFollowUpTime(item: ExceptionFollowUpItem): number {
  const updatedAt = item.updatedAt ? new Date(item.updatedAt).getTime() : 0;
  const createdAt = item.createdAt ? new Date(item.createdAt).getTime() : 0;
  return (
    (Number.isFinite(updatedAt) ? updatedAt : 0) ||
    (Number.isFinite(createdAt) ? createdAt : 0) ||
    0
  );
}

function formatExceptionFollowUpTime(item: ExceptionFollowUpItem): string {
  const value = item.updatedAt || item.createdAt;
  if (!value) return '';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';

  return date.toLocaleString('zh-CN', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function isSealingActiveOnDate(sealing: SealingInfo, dateStr: string): boolean {
  const dateParts = dateStr.split('-').map(Number);
  if (
    dateParts.length !== 3 ||
    dateParts.some((part) => !Number.isFinite(part))
  ) {
    return false;
  }

  const dayStart = new Date(dateParts[0], dateParts[1] - 1, dateParts[2]);
  const dayEnd = new Date(dateParts[0], dateParts[1] - 1, dateParts[2] + 1);
  const start = new Date(sealing.startDate);
  const end = new Date(sealing.endDate);

  return (
    Number.isFinite(start.getTime()) &&
    Number.isFinite(end.getTime()) &&
    start < dayEnd &&
    end > dayStart
  );
}

function getLocalDayWindow(dateStr: string): { start: Date; end: Date } | null {
  const dateParts = dateStr.split('-').map(Number);
  if (
    dateParts.length !== 3 ||
    dateParts.some((part) => !Number.isFinite(part))
  ) {
    return null;
  }

  return {
    start: new Date(dateParts[0], dateParts[1] - 1, dateParts[2]),
    end: new Date(dateParts[0], dateParts[1] - 1, dateParts[2] + 1),
  };
}

function doDateTimeRangesOverlap(
  aStart: Date,
  aEnd: Date,
  bStart: Date,
  bEnd: Date,
): boolean {
  return (
    Number.isFinite(aStart.getTime()) &&
    Number.isFinite(aEnd.getTime()) &&
    Number.isFinite(bStart.getTime()) &&
    Number.isFinite(bEnd.getTime()) &&
    aStart < bEnd &&
    aEnd > bStart
  );
}

type ChangeWindowMode = 'display' | 'conflict';

type ChangeWindowOnDate = {
  start: Date;
  end: Date;
  source: 'actual' | 'planned';
};

function parseValidDateTime(value?: string | null): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function getDateAtHour(dateStr: string, hour: number): Date | null {
  const dateParts = dateStr.split('-').map(Number);
  if (
    dateParts.length !== 3 ||
    dateParts.some((part) => !Number.isFinite(part))
  ) {
    return null;
  }

  return new Date(dateParts[0], dateParts[1] - 1, dateParts[2], hour, 0, 0, 0);
}

function getChangeWindowsOnDate(
  change: ChangeInfo,
  dateStr: string,
  mode: ChangeWindowMode = 'display',
): ChangeWindowOnDate[] {
  const dayWindow = getLocalDayWindow(dateStr);
  if (!dayWindow) {
    return [];
  }

  const isPastOrToday = dateStr <= getTodayDateKey();
  const actualStart = parseValidDateTime(change.actualStartDate);
  const actualEnd = parseValidDateTime(change.actualEndDate);
  const effectivePlanStart = change.plannedDelayStartDate || change.startDate;
  const effectivePlanEnd =
    change.plannedDelayEndDate || change.endDate || effectivePlanStart;
  const planStart = parseValidDateTime(effectivePlanStart);
  const planEnd = parseValidDateTime(effectivePlanEnd);

  if (mode === 'conflict' && isPastOrToday && !actualStart) {
    return [];
  }

  const source = isPastOrToday && actualStart ? 'actual' : 'planned';
  const rawStart = source === 'actual' ? actualStart : planStart;
  const rawEnd =
    source === 'actual' ? actualEnd || planEnd || actualStart : planEnd;

  if (!rawStart || !rawEnd) {
    return [];
  }

  const normalizedEnd =
    rawEnd > rawStart ? rawEnd : new Date(rawStart.getTime() + 60 * 1000);
  const dayStart = rawStart > dayWindow.start ? rawStart : dayWindow.start;
  const dayEnd = normalizedEnd < dayWindow.end ? normalizedEnd : dayWindow.end;
  if (dayStart >= dayEnd) {
    return [];
  }

  const durationMs = normalizedEnd.getTime() - rawStart.getTime();
  const shouldUseWorkWindow =
    source === 'planned' ||
    (mode === 'conflict' &&
      source === 'actual' &&
      durationMs > 12 * 60 * 60 * 1000);

  if (!shouldUseWorkWindow) {
    return [{ start: dayStart, end: dayEnd, source }];
  }

  const workStart = getDateAtHour(dateStr, 9);
  const workEnd = getDateAtHour(dateStr, 18);
  if (!workStart || !workEnd) {
    return [];
  }

  const start = dayStart > workStart ? dayStart : workStart;
  const end = dayEnd < workEnd ? dayEnd : workEnd;
  return start < end ? [{ start, end, source }] : [];
}

function isChangeActiveOnDate(change: ChangeInfo, dateStr: string): boolean {
  return getChangeWindowsOnDate(change, dateStr, 'display').length > 0;
}

function formatCalendarDateTitle(date: Date): string {
  return date.toLocaleDateString('zh-CN', {
    month: 'long',
    day: 'numeric',
    weekday: 'short',
  });
}

function resolveDutyConflictShift(
  schedule: MonthlySchedule,
): DutyConflictShift | null {
  const shift = resolveScheduleShift(schedule);
  if (shift === 'white' || shift === 'night') {
    return shift;
  }
  return null;
}

function resolveScheduleShift(
  schedule: MonthlySchedule,
): ShiftInfo['shift'] | null {
  const text = [
    schedule.shift,
    schedule.shiftText,
    schedule.team,
    schedule.teamText,
  ]
    .filter(Boolean)
    .join(' ');

  if (/long_white|长白/.test(text)) {
    return 'long_white';
  }
  if (/night|夜/.test(text)) {
    return 'night';
  }
  if (/white|白/.test(text)) {
    return 'white';
  }
  return null;
}

function formatChangeRelationList(
  items: Array<{ title?: string; sealingName?: string }>,
): string {
  return items
    .map((item) => item.title || item.sealingName)
    .filter((value): value is string => Boolean(value))
    .join('、');
}

function getDutyConflictStaffNames(schedule: MonthlySchedule): string[] {
  const source =
    schedule.dutyStaffActual && schedule.dutyStaffActual.length > 0
      ? schedule.dutyStaffActual
      : schedule.personText
        ? [schedule.personText]
        : [];

  return Array.from(
    new Set(source.flatMap((name) => splitStaffDisplayNames(name))),
  );
}

const CHANGE_LEVEL_PRIORITY = ['I1', 'I2', 'I3', 'I4', 'P1', 'P2', 'P3'];

function normalizeChangeLevelLabel(level?: string | null): string | null {
  const raw = level?.trim();
  if (!raw) return null;

  const compact = raw.toUpperCase().replace(/\s+/g, '');
  const matchedLevel = compact.match(/[IP][1-4]/)?.[0];
  if (matchedLevel && CHANGE_LEVEL_PRIORITY.includes(matchedLevel)) {
    return matchedLevel;
  }

  return raw;
}

function getChangeLevelPriority(label: string): number {
  const priority = CHANGE_LEVEL_PRIORITY.indexOf(label.toUpperCase());
  return priority === -1 ? Number.POSITIVE_INFINITY : priority;
}

function getTopChangeLevelLabel(changes: ChangeInfo[]): string | null {
  const labels = changes
    .map((change) => normalizeChangeLevelLabel(change.level))
    .filter((label): label is string => Boolean(label));

  if (labels.length === 0) {
    return null;
  }

  return labels.sort(
    (a, b) => getChangeLevelPriority(a) - getChangeLevelPriority(b),
  )[0];
}

function isMediumRiskOrAboveChange(change: ChangeInfo): boolean {
  const signal = [
    change.level,
    change.type,
    change.title,
    change.riskSummary,
    ...change.buildings,
  ]
    .filter((value): value is string => Boolean(value))
    .join(' ');
  const compact = signal.toUpperCase().replace(/\s+/g, '');

  if (
    /(中风险|中等风险|中级|较高风险|高风险|重大风险|重大|严重|高危)/.test(
      signal,
    )
  ) {
    return true;
  }
  if (/(MEDIUM|HIGH|CRITICAL)/i.test(signal)) {
    return true;
  }
  if (/(I|L|P)[12](?![A-Z0-9])/.test(compact)) {
    return true;
  }

  const tokens = signal
    .split(/[\s,，、/|;；]+/)
    .map((token) => token.trim().toUpperCase())
    .filter(Boolean);

  return tokens.some((token) =>
    [
      '中',
      '中等',
      '中级',
      '较高',
      '高',
      '重大',
      '严重',
      '高危',
      'MEDIUM',
      'HIGH',
      'CRITICAL',
    ].includes(token),
  );
}

function doChangeWindowsOverlap(
  currentWindows: ChangeWindowOnDate[],
  otherWindows: ChangeWindowOnDate[],
): boolean {
  return currentWindows.some((currentWindow) =>
    otherWindows.some((otherWindow) =>
      doDateTimeRangesOverlap(
        currentWindow.start,
        currentWindow.end,
        otherWindow.start,
        otherWindow.end,
      ),
    ),
  );
}

function processHourlyWeatherData(
  hourlyData: QWeatherHourly['hourly'],
): HourlyWeather[] {
  const currentHourStart = new Date();
  currentHourStart.setMinutes(0, 0, 0);
  const currentHourStartTime = currentHourStart.getTime();

  return hourlyData
    .map((item) => {
      const fxTime = new Date(item.fxTime);
      const temp = Number.parseInt(item.temp, 10);
      if (Number.isNaN(fxTime.getTime()) || !Number.isFinite(temp)) return null;

      return {
        timestamp: fxTime.getTime(),
        time: fxTime.toLocaleTimeString('zh-CN', {
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        }),
        temp,
        icon: item.icon,
        text: item.text,
        aqi: '良',
      };
    })
    .filter(
      (item): item is HourlyWeather & { timestamp: number } =>
        item !== null && item.timestamp >= currentHourStartTime,
    )
    .slice(0, 12)
    .map(({ time, temp, icon, text, aqi }) => ({
      time,
      temp,
      icon,
      text,
      aqi,
    }));
}

function buildTemperatureTrendOption(
  hourlyData: HourlyWeather[],
  compact = false,
): EChartsOption {
  const temperatures = hourlyData
    .map((item) => item.temp)
    .filter((value) => Number.isFinite(value));
  const minTemp =
    temperatures.length > 0 ? Math.floor(Math.min(...temperatures) - 2) : 0;
  const maxTemp =
    temperatures.length > 0 ? Math.ceil(Math.max(...temperatures) + 2) : 45;

  return {
    tooltip: {
      trigger: 'axis',
      formatter: '{b}: {c}℃',
      textStyle: { fontSize: 10 },
      confine: true,
    },
    grid: {
      left: compact ? 8 : 20,
      right: compact ? 12 : 18,
      top: compact ? 24 : 34,
      bottom: compact ? 16 : 26,
    },
    xAxis: {
      type: 'category',
      data: hourlyData.map((item) => item.time),
      axisLine: { show: true, lineStyle: { color: '#e5e7eb' } },
      axisTick: { show: false },
      axisLabel: {
        fontSize: compact ? 9 : 10,
        color: '#64748b',
        interval: compact ? 1 : 0,
      },
      boundaryGap: false,
    },
    yAxis: {
      type: 'value',
      min: minTemp,
      max: maxTemp,
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: {
        show: false,
        fontSize: compact ? 9 : 10,
        color: 'transparent',
        formatter: '{value}°',
        margin: 4,
      },
      splitLine: {
        show: true,
        lineStyle: { color: '#eef2ff', type: 'dashed' },
      },
    },
    series: [
      {
        type: 'line',
        data: hourlyData.map((item) => item.temp),
        smooth: 0.35,
        symbol: 'circle',
        symbolSize: compact ? 5 : 6,
        lineStyle: { color: '#2563eb', width: compact ? 2 : 3 },
        itemStyle: { color: '#2563eb', borderColor: '#ffffff', borderWidth: 2 },
        label: {
          show: true,
          position: 'top',
          formatter: '{c}°',
          fontSize: compact ? 9 : 10,
          color: '#2563eb',
          distance: compact ? 6 : 8,
        },
        areaStyle: {
          color: {
            type: 'linear',
            x: 0,
            y: 0,
            x2: 0,
            y2: 1,
            colorStops: [
              { offset: 0, color: 'rgba(37,99,235,0.18)' },
              { offset: 1, color: 'rgba(20,184,166,0.03)' },
            ],
          },
        },
      },
    ],
  };
}

function renderAlignedDutyName(name: string, index: number): React.ReactNode {
  const chars = Array.from(name);
  if (chars.length >= 1 && chars.length <= 3) {
    return (
      <span
        key={`${name}-${index}`}
        className="inline-flex w-[3.05em] justify-between whitespace-nowrap text-center"
      >
        {chars.map((char, charIndex) => (
          <span key={`${char}-${charIndex}`}>{char}</span>
        ))}
      </span>
    );
  }

  return (
    <span
      key={`${name}-${index}`}
      className="inline-block min-w-[3.05em] whitespace-nowrap text-center"
    >
      {name}
    </span>
  );
}

// 格式化姓名，2个字和3个字姓名按同一宽度两端对齐
function formatNameWithSpacing(nameStr?: string | null): React.ReactNode {
  if (!nameStr || nameStr === '-') return '-';

  const names = nameStr
    .split(/[，,、\s]+/)
    .map((n) => n.trim())
    .filter(Boolean);
  if (names.length === 0) return '-';

  return (
    <span className="inline-flex flex-wrap items-center justify-center gap-y-0.5 whitespace-normal">
      {names.map((name, index) => (
        <span key={`${name}-${index}`} className="contents">
          {renderAlignedDutyName(name, index)}
          {index < names.length - 1 && (
            <span
              className="mx-1 h-3 w-px flex-shrink-0 bg-slate-300/55"
              aria-hidden="true"
            />
          )}
        </span>
      ))}
    </span>
  );
}

type StaffProfileMap = Map<string, NantongOrganization>;

interface VacancySubstituteCandidate {
  key: string;
  recordId: string;
  scheduleDate: string;
  building: string;
  buildingLabel: string;
  shift: string;
  shiftLabel: string;
  staffNames: string[];
}

type DutyStaffAdjustmentCandidate = VacancySubstituteCandidate;

type StaffAdjustmentMode = 'vacancy' | 'repair' | 'travel' | 'emergency';
type AdditionalMatterMode = 'focus' | 'customer';
type ChangeAdjustmentDraft = {
  startNoAdjustment: boolean;
  endNoAdjustment: boolean;
  startValue: string;
  endValue: string;
};
type ChangeAdjustmentTarget = {
  change: ChangeInfo;
  conflictSealings: SealingInfo[];
  sourceLabel: string;
  timeLabel: string;
};
type ExceptionFollowUpTarget = {
  type: ExceptionFollowUpType;
  abnormalLabel: string;
  date: string;
  title: string;
  detail: string;
  matchKey: string;
  existingFollowUp?: ExceptionFollowUpItem | null;
};

function splitStaffDisplayNames(value?: string | null): string[] {
  return String(value || '')
    .split(/[，,、\s]+/)
    .map((name) => name.trim())
    .filter(Boolean);
}

function normalizeStaffProfileKey(value?: string | null): string {
  return String(value || '')
    .replace(/\s+/g, '')
    .trim();
}

function putStaffProfile(
  profileMap: StaffProfileMap,
  profile: NantongOrganization,
) {
  const name = profile.supervisorText?.trim();
  if (!name) return;
  profileMap.set(name, profile);
  const normalized = normalizeStaffProfileKey(name);
  if (normalized) {
    profileMap.set(normalized, profile);
  }
}

function getStaffProfile(
  profileMap: StaffProfileMap,
  name: string,
): NantongOrganization | undefined {
  return profileMap.get(name) || profileMap.get(normalizeStaffProfileKey(name));
}

function getDutyRoleRank(profile?: NantongOrganization): number {
  const position = profile?.position || '';
  if (
    position.includes('值班长') ||
    position.includes('站长') ||
    position.includes('主管')
  )
    return 0;
  if (position.includes('值班员')) return 1;
  if (position.includes('实习')) return 2;
  return 3;
}

function orderStaffNames(
  names: string[],
  profileMap: StaffProfileMap,
  sortByDutyRole = false,
): string[] {
  const uniqueNames = names.filter(
    (name, index, array) => array.indexOf(name) === index,
  );
  if (!sortByDutyRole) {
    return uniqueNames;
  }

  return uniqueNames
    .map((name, index) => ({
      name,
      index,
      rank: getDutyRoleRank(getStaffProfile(profileMap, name)),
    }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((item) => item.name);
}

interface StaffProfilePopoverProps {
  name: string;
  profile?: NantongOrganization;
  className?: string;
}

function StaffProfilePopover({
  name,
  profile,
  className,
}: StaffProfilePopoverProps) {
  const access = useAccess();
  const canViewPrivateProfile = canViewPersonProfileDetails(access);
  const [open, setOpen] = useState(false);
  const [photoFailed, setPhotoFailed] = useState(false);
  const photoUrl =
    canViewPrivateProfile && !photoFailed ? profile?.photoUrl : null;
  const phoneHref = canViewPrivateProfile
    ? buildTelephoneHref(profile?.phone)
    : null;

  useEffect(() => {
    setPhotoFailed(false);
  }, [profile?.photoUrl]);

  return (
    <HoverCard
      open={open}
      onOpenChange={setOpen}
      openDelay={120}
      closeDelay={120}
    >
      <HoverCardTrigger asChild>
        <button
          type="button"
          className={cn(
            'inline-flex min-w-0 items-center justify-center rounded px-0.5 text-current transition-colors hover:bg-blue-50 hover:text-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-200',
            className,
          )}
          title={`${name}资料`}
          aria-expanded={open}
          onClick={() => setOpen((current) => !current)}
        >
          {renderAlignedDutyName(name, 0)}
        </button>
      </HoverCardTrigger>
      <HoverCardContent
        className="w-72 border-blue-100 p-3 shadow-lg"
        side="top"
        align="center"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex gap-3">
          <div className="flex h-14 w-14 flex-shrink-0 items-center justify-center overflow-hidden rounded-lg border border-blue-100 bg-blue-50 text-lg font-semibold text-blue-600">
            {photoUrl ? (
              <img
                src={photoUrl}
                alt={name}
                loading="lazy"
                className="h-full w-full object-cover"
                onError={() => setPhotoFailed(true)}
              />
            ) : (
              <span>{Array.from(name).slice(-2).join('')}</span>
            )}
          </div>
          <div className="min-w-0 flex-1">
            {canViewPrivateProfile && profile?.feishuChatUrl ? (
              <a
                href={profile.feishuChatUrl}
                className="block truncate text-sm font-semibold text-blue-700 underline-offset-2 hover:underline"
                aria-label={`打开与${name}的飞书会话`}
                onClick={(event) => event.stopPropagation()}
              >
                {name}
              </a>
            ) : (
              <div className="truncate text-sm font-semibold text-slate-800">
                {name}
              </div>
            )}
            <div className="mt-1 rounded bg-blue-50 px-2 py-1 text-xs font-medium text-blue-700">
              {profile?.position || '岗位未维护'}
            </div>
            <div className="mt-2 space-y-1 text-xs text-slate-600">
              {canViewPrivateProfile ? (
                <div className="flex justify-between gap-3">
                  <span className="text-slate-400">手机号码</span>
                  {phoneHref ? (
                    <a
                      href={phoneHref}
                      className="font-medium text-blue-700 underline-offset-2 hover:underline"
                      onClick={(event) => event.stopPropagation()}
                    >
                      {profile?.phone}
                    </a>
                  ) : (
                    <span className="font-medium text-slate-700">
                      {profile?.phone || '未维护'}
                    </span>
                  )}
                </div>
              ) : null}
              {profile?.shift && (
                <div className="flex justify-between gap-3">
                  <span className="text-slate-400">班组</span>
                  <span className="font-medium text-slate-700">
                    {profile.shift}
                  </span>
                </div>
              )}
            </div>
          </div>
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}

function EmergencyDutyProfileSummary({
  view,
  profileMap,
  visiblePeople = 2,
  className,
}: {
  view: EmergencyDutyDayView;
  profileMap: StaffProfileMap;
  visiblePeople?: number;
  className?: string;
}) {
  if (view.people.length === 0) {
    return (
      <span className={className}>{formatEmergencyDutySummary(view)}</span>
    );
  }

  const visible = view.people.slice(0, visiblePeople);
  const visibleNames = visible.map((person) => person.name).join(' ');
  const formatted = formatEmergencyDutySummary(view, visiblePeople);
  const formattedPrefix = `应急：${visibleNames}`;
  const suffix = formatted.startsWith(formattedPrefix)
    ? formatted.slice(formattedPrefix.length)
    : '';

  return (
    <span className={cn('inline-flex min-w-0 items-center', className)}>
      <span className="flex-shrink-0">应急：</span>
      {visible.map((person, index) => (
        <span key={person.key} className="contents">
          {index > 0 ? <span aria-hidden="true">&nbsp;</span> : null}
          <StaffProfilePopover
            name={person.name}
            profile={getStaffProfile(profileMap, person.name)}
            className="min-w-0 truncate"
          />
        </span>
      ))}
      {suffix ? <span className="flex-shrink-0">{suffix}</span> : null}
    </span>
  );
}

interface StaffNameListProps {
  value?: string | null;
  names?: string[];
  profileMap: StaffProfileMap;
  sortByDutyRole?: boolean;
  className?: string;
  nameClassName?: string;
  separatorClassName?: string;
}

function StaffNameList({
  value,
  names,
  profileMap,
  sortByDutyRole = false,
  className,
  nameClassName,
  separatorClassName,
}: StaffNameListProps) {
  const orderedNames = orderStaffNames(
    names || splitStaffDisplayNames(value),
    profileMap,
    sortByDutyRole,
  );
  if (orderedNames.length === 0) {
    return <span className={cn('text-gray-400', className)}>-</span>;
  }

  return (
    <span
      className={cn(
        'inline-flex flex-wrap items-center justify-center gap-y-0.5 whitespace-normal',
        className,
      )}
    >
      {orderedNames.map((name, index) => (
        <span key={`${name}-${index}`} className="contents">
          <StaffProfilePopover
            name={name}
            profile={getStaffProfile(profileMap, name)}
            className={nameClassName}
          />
          {index < orderedNames.length - 1 && (
            <span
              className={cn(
                'mx-1 h-3 w-px flex-shrink-0 bg-slate-300/55',
                separatorClassName,
              )}
              aria-hidden="true"
            />
          )}
        </span>
      ))}
    </span>
  );
}

interface ShiftInfo {
  shift: 'white' | 'night' | 'long_white';
  person?: string;
}

type DutyConflictShift = 'white' | 'night';

interface DutyStaffConsecutiveConflict {
  id: string;
  date: string;
  staffName: string;
  previousDate: string;
  previousShift: DutyConflictShift;
  previousShiftLabel: string;
  previousBuilding: string;
  previousBuildingLabel: string;
  currentDate: string;
  currentShift: DutyConflictShift;
  currentShiftLabel: string;
  currentBuilding: string;
  currentBuildingLabel: string;
  reason: string;
}

interface DailySchedule {
  shiftInfo: ShiftInfo[];
}

// 逐小时天气数据接口
interface HourlyWeather {
  time: string;
  temp: number;
  icon: string;
  text: string;
  aqi: string;
}

// 天气组件
function WeatherWidget({
  weatherSnapshot,
  onLoadStateChange,
}: {
  weatherSnapshot: UseWeatherSnapshotResult;
  onLoadStateChange: (state: DutyOverviewScreenshotLoadState) => void;
}) {
  const { weather, hourlyWeather } = weatherSnapshot;
  const [dialogOpen, setDialogOpen] = useState(false);

  // 计算湿球温度（Stull公式）
  // T: 干球温度(°C), RH: 相对湿度(%)
  const calculateWetBulbTemp = (T: number, RH: number): number => {
    const tw =
      T * Math.atan(0.151977 * Math.pow(RH + 8.313659, 0.5)) +
      Math.atan(T + RH) -
      Math.atan(RH - 1.676331) +
      0.00391838 * Math.pow(RH, 1.5) * Math.atan(0.023101 * RH) -
      4.686035;
    return Math.round(tw * 10) / 10;
  };

  const hourlyData = hourlyWeather?.hourly
    ? processHourlyWeatherData(hourlyWeather.hourly)
    : [];

  useEffect(() => {
    onLoadStateChange(weatherSnapshot.screenshotReadiness);
  }, [onLoadStateChange, weatherSnapshot.screenshotReadiness]);

  if (weatherSnapshot.screenshotReadiness === 'loading') {
    return (
      <div className="flex items-center gap-2 rounded-lg px-4 py-2 text-sm text-blue-600">
        <span>加载中...</span>
      </div>
    );
  }

  const weatherUnavailable =
    !weather || weather.code !== '200' || weather.now?.temp === '--';

  if (weatherUnavailable) {
    return (
      <div className="rounded-lg px-4 py-2 text-sm text-gray-500">
        <div className="flex items-center gap-2">
          <Cloud className="h-5 w-5 text-slate-400" />
          <div className="flex flex-col leading-tight">
            <span className="font-medium text-gray-600">
              &#x5357;&#x901A;&#x5F00;&#x53D1;&#x533A;
            </span>
            <span className="text-xs text-gray-400">
              &#x5929;&#x6C14;&#x5F85;&#x66F4;&#x65B0;
            </span>
          </div>
        </div>
      </div>
    );
  }

  // 获取天气图标
  const getWeatherIcon = (iconCode: string, size: 'sm' | 'lg' = 'sm') => {
    const sizeClass = size === 'lg' ? 'h-8 w-8' : 'h-5 w-5';
    switch (iconCode) {
      case '100':
      case '150':
        return <Sun className={`${sizeClass} text-amber-500`} />;
      case '101':
      case '102':
      case '103':
      case '151':
      case '152':
      case '153':
        return <Cloud className={`${sizeClass} text-blue-400`} />;
      default:
        return <Cloud className={`${sizeClass} text-gray-400`} />;
    }
  };

  // 获取空气质量样式
  const getAqiStyle = (aqi: string) => {
    switch (aqi) {
      case '优':
        return 'text-emerald-600 bg-emerald-50';
      case '良':
        return 'text-amber-600 bg-amber-50';
      default:
        return 'text-gray-600 bg-gray-50';
    }
  };

  return (
    <>
      <button
        type="button"
        aria-label="查看南通开发区天气详情"
        onClick={() => setDialogOpen(true)}
        className="flex flex-col gap-1 rounded-lg text-left transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2"
      >
        <div className="flex items-center gap-3 rounded-lg px-4 py-2">
          <div className="flex items-center gap-2">
            <span className="text-2xl">{getWeatherIcon(weather.now.icon)}</span>
            <div className="flex flex-col">
              <span className="text-sm font-medium text-gray-700">
                南通开发区
              </span>
              <span className="text-xs text-gray-500">{weather.now.text}</span>
            </div>
          </div>
          <div className="h-8 w-px bg-blue-200" />
          <div className="flex items-center gap-3">
            <div className="flex flex-col items-center">
              <span className="text-lg font-bold text-blue-600">
                {weather.now.temp}°
              </span>
              <span className="text-[10px] text-gray-400">温度</span>
            </div>
            <div className="flex flex-col items-center">
              <span className="text-sm font-medium text-blue-600">
                {weather.now.humidity}%
              </span>
              <span className="text-[10px] text-gray-400">湿度</span>
            </div>
            <div className="flex flex-col items-center">
              <span className="text-sm font-medium text-blue-600">
                {weather.now.windScale}级
              </span>
              <span className="text-[10px] text-gray-400">
                {weather.now.windDir}
              </span>
            </div>
          </div>
        </div>
      </button>

      {/* 天气详情弹窗 */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent
          className="w-[92vw] max-w-md p-4 [&>button]:hidden"
          onPointerDownOutside={() => setDialogOpen(false)}
        >
          <DialogHeader className="pb-2">
            <DialogTitle className="text-center text-base font-semibold text-gray-800">
              南通开发区 · 今日天气趋势
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-3">
            {/* 当前概览 - 三列布局 */}
            <div className="rounded-lg bg-gradient-to-r from-blue-50 to-cyan-50 p-3">
              <div className="grid grid-cols-3 gap-2 text-center">
                <div className="flex flex-col items-center">
                  <div className="flex items-center gap-1">
                    <Thermometer className="h-4 w-4 text-blue-500" />
                    <span className="text-base font-bold text-gray-800">
                      {weather.now.temp}℃
                    </span>
                  </div>
                  <span className="text-xs text-gray-500">气温</span>
                </div>
                <div className="flex flex-col items-center border-x border-blue-200">
                  <div className="flex items-center gap-1">
                    <Droplets className="h-4 w-4 text-cyan-500" />
                    <span className="text-base font-bold text-gray-800">
                      {calculateWetBulbTemp(
                        parseInt(weather.now.temp),
                        parseInt(weather.now.humidity),
                      )}
                      ℃
                    </span>
                  </div>
                  <span className="text-xs text-gray-500">湿球温度</span>
                </div>
                <div className="flex flex-col items-center">
                  <div className="flex items-center gap-1">
                    <Cloud className="h-4 w-4 text-blue-400" />
                    <span className="text-base font-bold text-gray-800">
                      {weather.now.text}
                    </span>
                  </div>
                  <span className="text-xs text-gray-500">天气</span>
                </div>
              </div>
              <div className="mt-2 flex items-center justify-center gap-4 text-center">
                <div className="flex items-center gap-1">
                  <Wind className="h-3.5 w-3.5 text-teal-500" />
                  <span className="text-xs text-gray-700">
                    {weather.now.windDir}
                    {weather.now.windScale}级
                  </span>
                </div>
                <div className="flex items-center gap-1">
                  <span className="rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700">
                    {weather.now.humidity}%
                  </span>
                  <span className="text-xs text-gray-700">相对湿度</span>
                </div>
              </div>
            </div>

            {/* 气温趋势折线图 + 逐小时预报 合并模块 */}
            <div className="rounded-lg bg-white border border-gray-100 p-3">
              <h3 className="mb-2 flex items-center gap-1.5 text-xs font-medium text-gray-600">
                <Thermometer className="h-3 w-3" />
                气温趋势（未来12小时）
              </h3>

              {/* 折线图 - 确保在卡片内 */}
              <div className="h-[120px] w-full overflow-hidden">
                <ReactECharts
                  option={buildTemperatureTrendOption(hourlyData, true)}
                  theme="ud"
                  style={{ height: '100%', width: '100%' }}
                />
              </div>
            </div>

            {/* 趋势总结 */}
            <div className="rounded-lg bg-amber-50/80 p-2.5 text-center">
              <p className="text-xs leading-5 text-amber-800">
                气温先升至
                <span className="font-semibold text-amber-900">14℃</span>维持至
                <span className="font-semibold text-amber-900">15:00</span>
                ，后回落至
                <span className="font-semibold text-amber-900">11℃</span>
                。空气质量
                <span className="font-semibold text-amber-900">良→优</span>。
              </p>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

function WeatherRefreshIndicator({ isRefreshing }: { isRefreshing: boolean }) {
  if (!isRefreshing) return null;

  return (
    <span
      className="inline-flex items-center gap-1 rounded-md border border-blue-200 bg-blue-50 px-2 py-1 text-xs font-medium text-blue-700"
      role="status"
      aria-live="polite"
    >
      <RefreshCw className="h-3 w-3 animate-spin" aria-hidden="true" />
      更新中
    </span>
  );
}

function WeatherTrendPanel({
  weatherSnapshot,
  onLoadStateChange,
  onRegisterGuard,
}: {
  weatherSnapshot: UseWeatherSnapshotResult;
  onLoadStateChange: (state: DutyOverviewScreenshotLoadState) => void;
  onRegisterGuard?: (warningId: string) => void;
}) {
  const { weather, hourlyWeather, warningSnapshot } = weatherSnapshot;
  const [typhoonDialogOpen, setTyphoonDialogOpen] = useState(false);
  const { capabilities, role } = useAccess();
  const canManageMonthlySchedule = capabilities.canEdit;

  useEffect(() => {
    onLoadStateChange(weatherSnapshot.screenshotReadiness);
  }, [onLoadStateChange, weatherSnapshot.screenshotReadiness]);

  const hourlyData = hourlyWeather?.hourly
    ? processHourlyWeatherData(hourlyWeather.hourly)
    : [];
  const weatherReady =
    weather && weather.code === '200' && weather.now?.temp !== '--';
  const typhoonPathButton = (
    <button
      type="button"
      aria-label="打开台风路径"
      onClick={() => setTyphoonDialogOpen(true)}
      className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-blue-200 bg-white px-2.5 text-xs font-semibold text-blue-700 shadow-sm transition-colors hover:bg-blue-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2"
    >
      <Wind className="h-3.5 w-3.5" />
      台风路径
    </button>
  );
  const typhoonPathDialog = (
    <TyphoonPathDialog
      open={typhoonDialogOpen}
      onOpenChange={setTyphoonDialogOpen}
      canManageMonthlySchedule={canManageMonthlySchedule}
      canForceSend={role === 'admin'}
    />
  );

  if (weatherSnapshot.screenshotReadiness === 'loading') {
    return (
      <>
        <div className="duty-weather-trend-panel flex min-h-[224px] w-full self-start flex-col rounded-xl border border-slate-100 bg-white/80 p-2.5 text-sm text-slate-500">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <span className="font-medium text-slate-600">
              天气趋势加载中...
            </span>
            <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
              <WeatherRefreshIndicator
                isRefreshing={weatherSnapshot.isRefreshing}
              />
              <WeatherWarningInfoPopover
                warningSnapshot={warningSnapshot}
                warningStatus={weatherSnapshot.warningStatus}
                warningError={weatherSnapshot.warningError}
                warningFailureKind={weatherSnapshot.warningFailureKind}
                onRegisterGuard={onRegisterGuard}
              />
              {typhoonPathButton}
            </div>
          </div>
          <div className="flex flex-1 items-center justify-center">
            天气趋势加载中...
          </div>
        </div>
        {typhoonPathDialog}
      </>
    );
  }

  if (!weatherReady && hourlyData.length === 0) {
    return (
      <>
        <div className="duty-weather-trend-panel flex min-h-[224px] w-full self-start flex-col rounded-xl border border-slate-100 bg-white/80 p-2.5 text-sm text-slate-500">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm font-semibold text-slate-800">
                南通开发区天气暂无数据
              </div>
              <div className="mt-1 text-xs text-slate-400">
                趋势图将在天气接口恢复后显示
              </div>
            </div>
            <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
              <WeatherRefreshIndicator
                isRefreshing={weatherSnapshot.isRefreshing}
              />
              <WeatherWarningInfoPopover
                warningSnapshot={warningSnapshot}
                warningStatus={weatherSnapshot.warningStatus}
                warningError={weatherSnapshot.warningError}
                warningFailureKind={weatherSnapshot.warningFailureKind}
                onRegisterGuard={onRegisterGuard}
              />
              {typhoonPathButton}
            </div>
          </div>
          <div className="flex flex-1 flex-col items-center justify-center">
            <Cloud className="mb-2 h-8 w-8 text-slate-300" />
            <span className="font-medium text-slate-600">
              南通开发区天气暂无数据
            </span>
          </div>
        </div>
        {typhoonPathDialog}
      </>
    );
  }

  return (
    <>
      <div className="duty-weather-trend-panel flex min-h-[224px] w-full self-start flex-col rounded-xl border border-blue-100 bg-gradient-to-br from-white via-blue-50/55 to-emerald-50/45 p-2.5 shadow-sm">
        <div className="mb-1.5 flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
              <Thermometer className="h-4 w-4 text-blue-600" />
              12小时天气趋势
            </div>
            <div className="mt-1 text-xs text-slate-500">
              南通开发区 · 当前至未来 12 小时
            </div>
          </div>
          <div className="ml-auto flex flex-wrap items-start justify-end gap-2">
            <WeatherRefreshIndicator
              isRefreshing={weatherSnapshot.isRefreshing}
            />
            <WeatherWarningInfoPopover
              warningSnapshot={warningSnapshot}
              warningStatus={weatherSnapshot.warningStatus}
              warningError={weatherSnapshot.warningError}
              warningFailureKind={weatherSnapshot.warningFailureKind}
              onRegisterGuard={onRegisterGuard}
            />
            {typhoonPathButton}
            {weatherReady && (
              <div className="rounded-lg bg-white/80 px-2.5 py-1.5 text-right shadow-sm">
                <div className="text-lg font-semibold leading-none text-blue-600">
                  {weather.now.temp}°
                </div>
                <div className="mt-1 text-[11px] text-slate-500">
                  {weather.now.text}
                </div>
              </div>
            )}
          </div>
        </div>

        {weatherReady && (
          <div className="mb-1.5 grid grid-cols-3 gap-2 text-center text-xs">
            <div className="rounded-lg bg-white/75 px-2 py-1">
              <Droplets className="mx-auto mb-0.5 h-3.5 w-3.5 text-cyan-500" />
              <div className="font-semibold text-slate-800">
                {weather.now.humidity}%
              </div>
              <div className="text-[10px] text-slate-500">湿度</div>
            </div>
            <div className="rounded-lg bg-white/75 px-2 py-1">
              <Wind className="mx-auto mb-0.5 h-3.5 w-3.5 text-emerald-500" />
              <div className="font-semibold text-slate-800">
                {weather.now.windScale}级
              </div>
              <div className="text-[10px] text-slate-500">
                {weather.now.windDir}
              </div>
            </div>
            <div className="rounded-lg bg-white/75 px-2 py-1">
              <Clock className="mx-auto mb-0.5 h-3.5 w-3.5 text-blue-500" />
              <div className="font-semibold text-slate-800">12h</div>
              <div className="text-[10px] text-slate-500">趋势</div>
            </div>
          </div>
        )}

        <div className="h-[96px] rounded-lg border border-white/80 bg-white/85 p-1.5">
          {hourlyData.length > 0 ? (
            <ReactECharts
              option={buildTemperatureTrendOption(hourlyData, true)}
              theme="ud"
              style={{ height: '100%', width: '100%' }}
            />
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-slate-400">
              暂无逐小时趋势
            </div>
          )}
        </div>
      </div>
      {typhoonPathDialog}
    </>
  );
}

function EmergencyDutyAdjustmentPanel({
  date,
  onDateChange,
  editableRange,
  loadStatus,
  loadError,
  snapshotStale,
  currentPeople,
  syncState,
  recoveryBinding,
  onRetrySchedules,
  options,
  filteredOptions,
  optionsStatus,
  selectedKeys,
  selectedKeySet,
  search,
  onSearchChange,
  onTogglePerson,
  onRetryOptions,
}: {
  date: string;
  onDateChange: (date: string) => void;
  editableRange: EmergencyDutyLoadedRange | null;
  loadStatus: EmergencyDutyLoadState;
  loadError: string;
  snapshotStale: boolean;
  currentPeople: EmergencyDutyPersonOption[];
  syncState: EmergencyDutyPendingState | null;
  recoveryBinding: EmergencyDutyMutationBinding | null;
  onRetrySchedules: () => void;
  options: EmergencyDutyPersonOption[];
  filteredOptions: EmergencyDutyPersonOption[];
  optionsStatus: 'idle' | 'loading' | 'ready' | 'error';
  selectedKeys: string[];
  selectedKeySet: ReadonlySet<string>;
  search: string;
  onSearchChange: (value: string) => void;
  onTogglePerson: (key: string) => void;
  onRetryOptions: () => void;
}) {
  const selectionLocked =
    syncState === 'pending' || syncState === 'unknown-result';
  const currentLabel =
    loadStatus === 'loading' && currentPeople.length === 0
      ? '正在读取本地快照'
      : loadStatus === 'error' && currentPeople.length === 0
        ? '应急值班加载失败'
        : currentPeople.length > 0
          ? currentPeople.map((person) => person.name).join('、')
          : '未安排';

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-blue-100 bg-blue-50/60 px-4 py-3 text-sm leading-6 text-blue-700">
        应急值班按日期覆盖全基地；人员来自服务端在职缓存，调整后页面立即显示同步状态。
      </div>
      <div className="grid gap-3 md:grid-cols-[190px_minmax(0,1fr)]">
        <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
          <label
            className="mb-2 block text-xs font-semibold text-slate-500"
            htmlFor="emergency-duty-date"
          >
            值班日期
          </label>
          <div className="relative">
            <CalendarClock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <Input
              id="emergency-duty-date"
              type="date"
              value={date}
              min={editableRange?.startDate}
              max={editableRange?.endDate}
              disabled={
                selectionLocked || loadStatus !== 'ready' || !editableRange
              }
              onChange={(event) => onDateChange(event.target.value)}
              className="h-9 border-slate-200 bg-slate-50 pl-9 focus-visible:ring-blue-200"
            />
          </div>
        </div>
        <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="text-xs font-semibold text-slate-500">
                当前安排
              </div>
              <div className="mt-1 text-sm font-semibold text-slate-800">
                {currentLabel}
              </div>
            </div>
            {syncState ? (
              <span
                className={cn(
                  'rounded-md border px-2 py-1 text-xs font-semibold',
                  syncState === 'unknown-result'
                    ? 'border-amber-200 bg-amber-50 text-amber-700'
                    : syncState === 'cache_refresh_pending'
                      ? 'border-blue-200 bg-blue-50 text-blue-700'
                      : 'border-emerald-200 bg-emerald-50 text-emerald-700',
                )}
              >
                {syncState === 'pending'
                  ? '同步中'
                  : syncState === 'cache_refresh_pending'
                    ? '缓存待刷新'
                    : '结果待确认'}
              </span>
            ) : snapshotStale ? (
              <span className="rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-xs font-semibold text-amber-700">
                缓存已过期
              </span>
            ) : null}
          </div>
          {loadStatus === 'error' ? (
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-md bg-rose-50 px-3 py-2 text-xs text-rose-700">
              <span>{loadError}</span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={onRetrySchedules}
                className="h-7 border-rose-200 bg-white text-rose-700"
              >
                重新加载
              </Button>
            </div>
          ) : null}
        </div>
      </div>

      {recoveryBinding ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          上次写入结果待确认。为防止重复或覆盖，本次人员选择已锁定；点击“安全重试”将复用同一操作标识。
        </div>
      ) : null}

      <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="text-sm font-semibold text-slate-800">在职人员</div>
            <div className="mt-0.5 text-xs text-slate-500">
              已选 {selectedKeys.length} 人 · 仅传递安全人员标识
            </div>
          </div>
          <div className="relative w-full sm:w-64">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <Input
              value={search}
              onChange={(event) => onSearchChange(event.target.value)}
              placeholder="搜索姓名或角色"
              className="h-9 border-slate-200 bg-slate-50 pl-9 focus-visible:ring-blue-200"
            />
          </div>
        </div>

        {optionsStatus === 'loading' || optionsStatus === 'idle' ? (
          <div className="flex items-center justify-center gap-2 rounded-lg border border-dashed border-slate-200 bg-slate-50 px-4 py-8 text-sm text-slate-500">
            <Loader2 className="h-4 w-4 animate-spin" />
            正在读取在职人员缓存
          </div>
        ) : optionsStatus === 'error' ? (
          <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-6 text-center">
            <div className="text-sm font-medium text-rose-700">
              在职人员缓存加载失败
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onRetryOptions}
              className="mt-3 border-rose-200 bg-white text-rose-700"
            >
              重新加载
            </Button>
          </div>
        ) : options.length === 0 ? (
          <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50 px-4 py-8 text-center text-sm text-slate-500">
            当前在职人员缓存为空
          </div>
        ) : filteredOptions.length === 0 ? (
          <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50 px-4 py-8 text-center text-sm text-slate-500">
            未匹配到在职人员
          </div>
        ) : (
          <EmergencyDutyOptionList
            options={filteredOptions}
            selectedKeys={selectedKeySet}
            disabled={selectionLocked}
            onToggle={onTogglePerson}
          />
        )}
      </div>
    </div>
  );
}

// 今日前后日期值班信息组件 - 磨玻璃效果
interface TodayAndNearbySchedulesProps {
  selectedDate: Date;
  schedules: MonthlySchedule[];
  getScheduleByDateAndBuilding: (
    date: string,
    building: string,
  ) => DailySchedule;
  getEmergencyDutyByDate: (date: string) => EmergencyDutyDayView;
  getHolidayInfo: (dateStr: string) => { isHoliday: boolean; name?: string };
  getSealingInfoByDate: (dateStr: string) => SealingInfo | null;
  onOpenSealingDetails: (dateStr: string, trigger: HTMLElement) => void;
  BUILDING_ORDER: string[];
  BUILDING_MAP: Record<string, string>;
  personProfileMap: StaffProfileMap;
  refreshToken: number;
  localSnapshotRefreshToken: number;
  onPersonnelMovementsLoadStateChange: (
    state: DutyOverviewScreenshotLoadState,
  ) => void;
}

function TodayAndNearbySchedules({
  selectedDate,
  schedules,
  getScheduleByDateAndBuilding,
  getEmergencyDutyByDate,
  getHolidayInfo,
  getSealingInfoByDate,
  onOpenSealingDetails,
  BUILDING_ORDER,
  BUILDING_MAP,
  personProfileMap,
  refreshToken,
  localSnapshotRefreshToken,
  onPersonnelMovementsLoadStateChange,
}: TodayAndNearbySchedulesProps) {
  const today = new Date();
  const currentYear = today.getFullYear();
  const currentMonth = today.getMonth();
  const currentDay = today.getDate();

  // 基于 selectedDate 计算前后1天的日期
  const nearbyDays: { date: Date; isToday: boolean; label: string }[] = [];
  const selectedYear = selectedDate.getFullYear();
  const selectedMonth = selectedDate.getMonth();
  const selectedDay = selectedDate.getDate();

  // 前一天
  const prevDay = new Date(selectedYear, selectedMonth, selectedDay - 1);
  nearbyDays.push({ date: prevDay, isToday: false, label: '前一天' });

  // 当天
  const currentDayObj = new Date(selectedYear, selectedMonth, selectedDay);
  const isToday =
    currentYear === selectedYear &&
    currentMonth === selectedMonth &&
    currentDay === selectedDay;
  nearbyDays.push({ date: currentDayObj, isToday, label: '当天' });

  // 后一天
  const nextDay = new Date(selectedYear, selectedMonth, selectedDay + 1);
  nearbyDays.push({ date: nextDay, isToday: false, label: '后一天' });

  const relevantDays = nearbyDays;

  return (
    <div className="duty-nearby-section mb-6 rounded-xl border p-4 shadow-sm">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="duty-nearby-title-marker h-4 w-1 rounded-full" />
          <span className="duty-nearby-title text-sm font-semibold">
            近期值班概览
          </span>
        </div>
      </div>
      <div className="grid duty-nearby-grid gap-3">
        {relevantDays.map(({ date, isToday, label }) => {
          const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
          const holidayInfo = getHolidayInfo(dateStr);
          const emergencyDuty = getEmergencyDutyByDate(dateStr);
          const sealing = getSealingInfoByDate(dateStr);

          return (
            <div
              key={dateStr}
              data-nearby-today={isToday ? 'true' : 'false'}
              data-nearby-sealing={sealing ? 'true' : 'false'}
              className="duty-nearby-card rounded-lg border p-3"
            >
              {/* 日期头部 + 应急人员 - 水平对齐 */}
              <div className="mb-2 flex items-center justify-between">
                {/* 左侧：封网标记 */}
                <div className="w-16 flex-shrink-0 h-7 flex items-center">
                  {sealing && (
                    <button
                      type="button"
                      className="flex h-7 w-7 items-center justify-center rounded-full border-2 border-red-500 bg-white shadow-sm transition-colors hover:bg-red-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2"
                      aria-label={`查看 ${dateStr} 封网安排清单`}
                      onClick={(event) =>
                        onOpenSealingDetails(dateStr, event.currentTarget)
                      }
                    >
                      <span
                        className="text-xs font-black text-red-600/60"
                        style={{ fontFamily: 'KaiTi, STKaiti, serif' }}
                      >
                        封
                      </span>
                    </button>
                  )}
                </div>
                {/* 日期信息居中 */}
                <div className="flex items-center justify-center gap-2">
                  <span
                    className="duty-nearby-day-badge rounded px-1.5 py-0.5 text-xs font-medium"
                    data-current={isToday ? 'true' : 'false'}
                  >
                    {label}
                  </span>
                  <span className="text-sm font-semibold text-gray-700">
                    {date.getMonth() + 1}月{date.getDate()}日
                  </span>
                  <span className="text-xs text-gray-500">
                    {date.toLocaleDateString('zh-CN', { weekday: 'short' })}
                  </span>
                  {holidayInfo.isHoliday && (
                    <span className="text-[10px] px-1 py-0.5 rounded bg-red-100 text-red-600">
                      {holidayInfo.name}
                    </span>
                  )}
                </div>
                {/* 应急人员右侧 */}
                <div
                  data-emergency-duty-state={
                    emergencyDuty.loadState === 'error' &&
                    emergencyDuty.people.length === 0
                      ? 'error'
                      : emergencyDuty.state
                  }
                  className={cn(
                    'w-24 flex-shrink-0 text-right text-[10px] font-semibold leading-4',
                    emergencyDuty.people.length > 0
                      ? 'text-emerald-700'
                      : emergencyDuty.loadState === 'error'
                        ? 'text-rose-600'
                        : 'text-slate-400',
                  )}
                >
                  <EmergencyDutyProfileSummary
                    view={emergencyDuty}
                    profileMap={personProfileMap}
                  />
                </div>
              </div>

              {/* 楼栋值班信息 */}
              <div className="duty-nearby-roster space-y-1.5">
                {BUILDING_ORDER.map((building) => {
                  const { shiftInfo } = getScheduleByDateAndBuilding(
                    dateStr,
                    building,
                  );
                  const whiteShift = shiftInfo.find((s) => s.shift === 'white');
                  const nightShift = shiftInfo.find((s) => s.shift === 'night');

                  if (!whiteShift && !nightShift) return null;

                  return (
                    <div
                      key={building}
                      className="grid grid-cols-[2.5rem_minmax(0,1fr)_minmax(0,1fr)] items-center gap-2 text-xs"
                    >
                      <span className="duty-building-badge w-10 flex-shrink-0 rounded px-1 py-0.5 text-center text-[10px] font-medium text-white">
                        {BUILDING_MAP[building]}
                      </span>
                      {/* 白班 - 水平布局 */}
                      <div className="flex min-w-0 items-center gap-1">
                        {whiteShift ? (
                          <>
                            <span className="duty-shift-badge duty-shift-badge-white inline-flex flex-shrink-0 items-center gap-0.5 rounded px-1 py-0.5">
                              <span className="text-[10px]">☀️</span>
                              <span className="font-medium">白</span>
                            </span>
                            <StaffNameList
                              value={whiteShift.person}
                              profileMap={personProfileMap}
                              sortByDutyRole
                              className="min-w-[6.7em] flex-1 justify-start text-orange-800"
                            />
                          </>
                        ) : (
                          <>
                            <span className="inline-flex items-center gap-0.5 rounded bg-gray-100 px-1 py-0.5 text-gray-400 flex-shrink-0">
                              <span className="text-[10px]">☀️</span>
                              <span>-</span>
                            </span>
                            <span className="text-gray-400">-</span>
                          </>
                        )}
                      </div>
                      {/* 夜班 - 水平布局 */}
                      <div className="flex min-w-0 items-center gap-1">
                        {nightShift ? (
                          <>
                            <span className="duty-shift-badge duty-shift-badge-night inline-flex flex-shrink-0 items-center gap-0.5 rounded px-1 py-0.5">
                              <span className="text-[10px]">🌙</span>
                              <span className="font-medium">夜</span>
                            </span>
                            <StaffNameList
                              value={nightShift.person}
                              profileMap={personProfileMap}
                              sortByDutyRole
                              className="min-w-[6.7em] flex-1 justify-start text-blue-800"
                            />
                          </>
                        ) : (
                          <>
                            <span className="inline-flex items-center gap-0.5 rounded bg-gray-100 px-1 py-0.5 text-gray-400 flex-shrink-0">
                              <span className="text-[10px]">🌙</span>
                              <span>-</span>
                            </span>
                            <span className="text-gray-400">-</span>
                          </>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* 封网信息 - 所有日期卡片显示 */}
              <div
                className={`duty-sealing-footer mt-2 pt-2 border-t-2 -mx-3 px-3 pb-2 ${
                  sealing
                    ? 'duty-sealing-footer-active border-red-200/60 bg-gradient-to-r from-red-50/50 to-orange-50/30'
                    : 'duty-sealing-footer-empty border-gray-200/60 bg-gray-50/30'
                }`}
              >
                {sealing ? (
                  <button
                    type="button"
                    className="flex w-full items-stretch gap-1.5 rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2"
                    aria-label={`查看 ${dateStr} 封网安排清单`}
                    onClick={(event) =>
                      onOpenSealingDetails(dateStr, event.currentTarget)
                    }
                  >
                    {/* 左侧：封网信息标签框 */}
                    <div
                      className={`flex-shrink-0 flex flex-col items-center justify-center px-2 py-1.5 bg-white border rounded ${
                        label === '昨日' ? 'border-gray-400' : 'border-red-500'
                      }`}
                    >
                      <span
                        className={`text-[10px] font-bold ${label === '昨日' ? 'text-gray-500' : 'text-red-600'}`}
                      >
                        今日具体
                      </span>
                      <span
                        className={`text-[10px] font-bold ${label === '昨日' ? 'text-gray-500' : 'text-red-600'}`}
                      >
                        封网信息
                      </span>
                    </div>
                    {/* 中间：艺术感渐变箭头 */}
                    <div className="flex-shrink-0 flex items-center">
                      <svg
                        width="20"
                        height="24"
                        viewBox="0 0 20 24"
                        fill="none"
                        xmlns="http://www.w3.org/2000/svg"
                      >
                        <defs>
                          <linearGradient
                            id={`arrowGradient-${dateStr}`}
                            x1="0%"
                            y1="50%"
                            x2="100%"
                            y2="50%"
                          >
                            <stop
                              offset="0%"
                              stopColor={
                                label === '昨日' ? '#9ca3af' : '#f87171'
                              }
                            />
                            <stop
                              offset="100%"
                              stopColor={
                                label === '昨日' ? '#6b7280' : '#dc2626'
                              }
                            />
                          </linearGradient>
                        </defs>
                        <path
                          d="M4 8L12 12L4 16"
                          stroke={`url(#arrowGradient-${dateStr})`}
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                        <path
                          d="M12 8L20 12L12 16"
                          stroke={`url(#arrowGradient-${dateStr})`}
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    </div>
                    {/* 右侧：封网名称和时间 */}
                    <div className="flex-1 min-w-0 flex flex-col justify-center gap-0.5">
                      <div
                        className={`text-[11px] font-medium truncate ${label === '昨日' ? 'text-gray-500' : 'text-red-700'}`}
                        title={sealing.sealingName}
                      >
                        {sealing.sealingName.length > 30
                          ? sealing.sealingName.substring(0, 30) + '...'
                          : sealing.sealingName}
                      </div>
                      <div
                        className={`text-[10px] flex items-center gap-1 ${label === '昨日' ? 'text-gray-400' : 'text-red-600'}`}
                      >
                        <span>
                          {new Date(sealing.startDate).getMonth() + 1}月
                          {new Date(sealing.startDate).getDate()}日{' '}
                          {String(
                            new Date(sealing.startDate).getHours(),
                          ).padStart(2, '0')}
                          :
                          {String(
                            new Date(sealing.startDate).getMinutes(),
                          ).padStart(2, '0')}
                        </span>
                        <span
                          className={
                            label === '昨日' ? 'text-gray-300' : 'text-red-400'
                          }
                        >
                          ~
                        </span>
                        <span>
                          {new Date(sealing.endDate).getMonth() + 1}月
                          {new Date(sealing.endDate).getDate()}日{' '}
                          {String(
                            new Date(sealing.endDate).getHours(),
                          ).padStart(2, '0')}
                          :
                          {String(
                            new Date(sealing.endDate).getMinutes(),
                          ).padStart(2, '0')}
                        </span>
                      </div>
                    </div>
                  </button>
                ) : (
                  <div className="duty-sealing-empty flex items-center justify-center gap-2">
                    <div className="duty-sealing-empty-icon w-5 h-5 rounded-full bg-green-100/50 border border-green-300/50 flex items-center justify-center">
                      <span
                        className="text-[10px] font-black text-green-600/50"
                        style={{ fontFamily: 'KaiTi, STKaiti, serif' }}
                      >
                        无
                      </span>
                    </div>
                    <span className="duty-sealing-empty-text text-[11px] text-green-600/50">
                      无封网信息
                    </span>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* 今日人员变动一览卡片 - 横跨整行 */}
      <TodayPersonnelMovementCard
        selectedDate={selectedDate}
        schedules={schedules}
        personProfileMap={personProfileMap}
        refreshToken={refreshToken}
        localSnapshotRefreshToken={localSnapshotRefreshToken}
        onLoadStateChange={onPersonnelMovementsLoadStateChange}
      />
    </div>
  );
}

// 今日人员变动一览卡片组件
function TodayPersonnelMovementCard({
  selectedDate,
  schedules,
  personProfileMap,
  refreshToken,
  localSnapshotRefreshToken,
  onLoadStateChange,
}: {
  selectedDate: Date;
  schedules: MonthlySchedule[];
  personProfileMap: StaffProfileMap;
  refreshToken: number;
  localSnapshotRefreshToken: number;
  onLoadStateChange: (state: DutyOverviewScreenshotLoadState) => void;
}) {
  const today = selectedDate;
  const todayStr = formatDateKey(today);
  const isToday = todayStr === formatDateKey(new Date());

  const [leaveData, setLeaveData] = useState<TodayLeaveStaffByBuilding[]>([]);
  const [travelData, setTravelData] = useState<TravelStaffDetail[]>([]);
  const [loading, setLoading] = useState(true);
  const lastSuccessfulRefreshTokenRef = useRef(0);
  const lastObservedLocalSnapshotRefreshTokenRef = useRef(
    localSnapshotRefreshToken,
  );

  // 从 API 获取今日人员变动数据
  useEffect(() => {
    let active = true;
    const localSnapshotRefresh =
      localSnapshotRefreshToken >
      lastObservedLocalSnapshotRefreshTokenRef.current;
    lastObservedLocalSnapshotRefreshTokenRef.current =
      localSnapshotRefreshToken;

    const fetchTodayPersonnelMovements = async () => {
      const forceRefresh = refreshToken > lastSuccessfulRefreshTokenRef.current;
      const preserveExistingOnError = shouldPreserveLocalSnapshotData(
        localSnapshotRefresh,
        forceRefresh,
      );
      onLoadStateChange('loading');
      try {
        if (!preserveExistingOnError) setLoading(true);
        const [leaveResponse, travelResponse] = await Promise.all([
          getTodayLeaveStaff(todayStr, forceRefresh),
          getTravelStaffDetails({
            startDate: todayStr,
            endDate: todayStr,
            refresh: forceRefresh,
          }),
        ]);
        if (!active) {
          return;
        }
        if (forceRefresh) {
          lastSuccessfulRefreshTokenRef.current = refreshToken;
        }
        setLeaveData(leaveResponse.buildings || []);
        setTravelData(travelResponse.details || []);
        onLoadStateChange('ready');
      } catch (error) {
        logger.error('获取今日人员变动数据失败', error);
        if (active) {
          if (!preserveExistingOnError) {
            setLeaveData([]);
            setTravelData([]);
          }
          onLoadStateChange('error');
        }
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    };

    fetchTodayPersonnelMovements();
    return () => {
      active = false;
    };
  }, [localSnapshotRefreshToken, onLoadStateChange, refreshToken, todayStr]);

  const movementData = useMemo(
    () =>
      buildPersonnelMovementOverview({
        leaveData,
        travelDetails: travelData,
        buildingOrder: BUILDING_ORDER,
        buildingNameMap: BUILDING_MAP,
      }),
    [leaveData, travelData],
  );
  const leaveSubstitutionGroupsByBuilding = useMemo(
    () => buildLeaveSubstitutionGroupsByBuilding(schedules, todayStr),
    [schedules, todayStr],
  );
  const hasData = movementData.length > 0;
  const movementSummary = useMemo(
    () =>
      movementData.reduce(
        (summary, item) => {
          summary.leave += item.leaveStaff.length;
          summary.substitute += new Set([
            ...item.substituteStaff,
            ...item.temporarySubstituteStaff,
          ]).size;
          summary.travel += item.travelStaff.length;
          return summary;
        },
        { leave: 0, substitute: 0, travel: 0 },
      ),
    [movementData],
  );

  const renderStaffNames = (
    names: string[],
    keyPrefix: string,
    className = 'text-xs text-gray-700',
  ) => (
    <span className="duty-leave-name inline-flex min-w-0 flex-wrap items-center gap-x-1 text-xs text-gray-700">
      {names.map((name, index) => (
        <span key={`${keyPrefix}-${name}-${index}`} className="contents">
          <StaffProfilePopover
            name={name}
            profile={getStaffProfile(personProfileMap, name)}
            className={className}
          />
          {index < names.length - 1 && (
            <span className="text-gray-400" aria-hidden="true">
              、
            </span>
          )}
        </span>
      ))}
    </span>
  );

  return (
    <div className="duty-leave-panel mt-3 rounded-lg border border-gray-200 bg-white p-3 shadow-sm">
      {/* 标题 */}
      <div className="duty-leave-header mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <div className="duty-leave-title-marker h-4 w-1 rounded-full bg-gray-400" />
          <span className="text-sm font-semibold text-gray-800">
            {isToday ? '今日' : `${today.getMonth() + 1}月${today.getDate()}日`}
            人员变动一览
          </span>
          <span className="text-xs text-gray-500">
            {today.getMonth() + 1}月{today.getDate()}日
          </span>
        </div>
        {hasData && (
          <div className="duty-personnel-summary" aria-label="人员变动汇总">
            <span data-tone="absence">
              请假 <strong>{movementSummary.leave}</strong>
            </span>
            <span data-tone="substitute">
              替班 <strong>{movementSummary.substitute}</strong>
            </span>
            <span data-tone="travel">
              差旅 <strong>{movementSummary.travel}</strong>
            </span>
          </div>
        )}
      </div>

      {/* 内容区域 - 自适应等宽网格展示各楼栋 */}
      <div>
        {loading ? (
          <div className="flex items-center justify-center gap-3 py-2 text-center">
            <span className="text-xs text-gray-400">加载中...</span>
          </div>
        ) : hasData ? (
          <div className="duty-leave-grid grid grid-cols-1 gap-3 md:grid-cols-2">
            {movementData.map(
              ({
                building,
                buildingName,
                leaveStaff,
                substituteStaff,
                temporarySubstituteStaff,
                temporarySubstitutes,
                travelStaff,
              }) => {
                const leaveSubstitutionGroups =
                  leaveSubstitutionGroupsByBuilding.get(building) || [];
                const groupedLeaveStaff = new Set(
                  leaveSubstitutionGroups.flatMap((group) => group.leaveStaff),
                );
                const groupedSubstituteStaff = new Set(
                  leaveSubstitutionGroups.flatMap(
                    (group) => group.substituteStaff,
                  ),
                );
                const ungroupedLeaveStaff = leaveStaff.filter(
                  (name) => !groupedLeaveStaff.has(name),
                );
                const ungroupedSubstituteStaff = substituteStaff.filter(
                  (name) => !groupedSubstituteStaff.has(name),
                );

                return (
                  <div
                    key={building}
                    className="duty-leave-item grid w-full min-w-0 max-w-full gap-2 rounded-md bg-gray-50 px-3 py-2"
                  >
                    <span className="duty-leave-building w-10 flex-shrink-0 rounded bg-blue-500 px-1 py-0.5 text-center text-[10px] font-medium text-white">
                      {buildingName}
                    </span>

                    <div className="duty-leave-content flex min-w-0 flex-col items-start gap-1">
                    {leaveSubstitutionGroups.length > 0 && (
                      <>
                        <span className="duty-leave-tag duty-leave-tag-absence flex-shrink-0 rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-medium text-red-700">
                          请假
                        </span>
                        {leaveSubstitutionGroups.map((group) => (
                          <div
                            key={`${building}-leave-relation-${group.shift}`}
                            className="contents"
                          >
                            {group.assignments?.length ? (
                              group.assignments.map((assignment) => (
                                <div
                                  key={`${building}-${group.shift}-${assignment.requestRecordId}-${assignment.leaveStaffName}`}
                                  className="duty-leave-relation inline-flex min-w-0 flex-nowrap items-center gap-1 rounded-md border border-gray-200 bg-white px-2 py-1"
                                  title={
                                    assignment.startAt && assignment.endAt
                                      ? `请假时段：${assignment.startAt.replace('T', ' ')} 至 ${assignment.endAt.replace('T', ' ')}`
                                      : undefined
                                  }
                                >
                                  <span className="duty-leave-shift-tag flex-shrink-0 rounded bg-blue-100 px-1.5 py-0.5 text-[10px] font-medium text-blue-700">
                                    {group.shiftLabel}
                                  </span>
                                  {renderStaffNames(
                                    [assignment.leaveStaffName],
                                    `${building}-${group.shift}-${assignment.requestRecordId}-leave`,
                                    'text-xs font-medium text-gray-800',
                                  )}
                                  {assignment.leaveHours !== null && (
                                    <span className="flex-shrink-0 text-[10px] font-semibold tabular-nums text-red-600">
                                      {Number.isInteger(assignment.leaveHours)
                                        ? assignment.leaveHours
                                        : assignment.leaveHours.toFixed(1)}
                                      h
                                    </span>
                                  )}
                                  {assignment.substituteStaff.length > 0 && (
                                    <>
                                      <span
                                        className="flex-shrink-0 text-[11px] text-gray-400"
                                        aria-hidden="true"
                                      >
                                        →
                                      </span>
                                      {renderStaffNames(
                                        assignment.substituteStaff,
                                        `${building}-${group.shift}-${assignment.requestRecordId}-substitute`,
                                        'text-xs font-medium text-green-700',
                                      )}
                                    </>
                                  )}
                                </div>
                              ))
                            ) : (
                              <div className="duty-leave-relation flex min-w-0 flex-wrap items-center gap-1 rounded-md border border-gray-200 bg-white px-2 py-1">
                                <span className="duty-leave-shift-tag flex-shrink-0 rounded bg-blue-100 px-1.5 py-0.5 text-[10px] font-medium text-blue-700">
                                  {group.shiftLabel}
                                </span>
                                {renderStaffNames(
                                  group.leaveStaff,
                                  `${building}-${group.shift}-leave`,
                                )}
                                {group.substituteStaff.length > 0 && (
                                  <>
                                    <span className="duty-leave-tag duty-leave-tag-substitute flex-shrink-0 rounded bg-green-100 px-1.5 py-0.5 text-[10px] font-medium text-green-700">
                                      替班
                                    </span>
                                    {renderStaffNames(
                                      group.substituteStaff,
                                      `${building}-${group.shift}-substitute`,
                                    )}
                                  </>
                                )}
                              </div>
                            )}
                          </div>
                        ))}
                      </>
                    )}

                    {/* 无法按排班记录确定关系的数据单独展示，避免错误配对 */}
                    {ungroupedLeaveStaff.length > 0 && (
                      <div className="flex min-w-0 flex-wrap items-center gap-1">
                        <span className="duty-leave-tag duty-leave-tag-absence flex-shrink-0 rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-medium text-red-700">
                          请假
                        </span>
                        {renderStaffNames(
                          ungroupedLeaveStaff,
                          `${building}-leave-ungrouped`,
                        )}
                      </div>
                    )}

                    {ungroupedSubstituteStaff.length > 0 && (
                      <div className="flex min-w-0 flex-wrap items-center gap-1">
                        <span className="duty-leave-tag duty-leave-tag-substitute flex-shrink-0 rounded bg-green-100 px-1.5 py-0.5 text-[10px] font-medium text-green-700">
                          替班
                        </span>
                        {renderStaffNames(
                          ungroupedSubstituteStaff,
                          `${building}-substitute-ungrouped`,
                        )}
                      </div>
                    )}

                    {temporarySubstitutes.length > 0 &&
                      temporarySubstitutes.map((group) => (
                        <div
                          key={`${building}-temporary-${group.shift || group.shiftLabel}`}
                          className="flex min-w-0 flex-wrap items-center gap-1"
                        >
                          <span className="duty-leave-tag flex-shrink-0 rounded bg-cyan-100 px-1.5 py-0.5 text-[10px] font-medium text-cyan-700">
                            临时
                          </span>
                          {group.shiftLabel && group.shiftLabel !== '临时' && (
                            <span className="duty-leave-shift-tag flex-shrink-0 rounded bg-blue-100 px-1.5 py-0.5 text-[10px] font-medium text-blue-700">
                              {group.shiftLabel}
                            </span>
                          )}
                          {renderStaffNames(
                            group.staff,
                            `${building}-temporary-${group.shift || group.shiftLabel}`,
                            'text-xs font-medium text-cyan-800',
                          )}
                        </div>
                      ))}

                    {temporarySubstitutes.length === 0 &&
                      temporarySubstituteStaff.length > 0 && (
                        <div className="flex min-w-0 flex-wrap items-center gap-1">
                          <span className="duty-leave-tag flex-shrink-0 rounded bg-cyan-100 px-1.5 py-0.5 text-[10px] font-medium text-cyan-700">
                            临时
                          </span>
                          {renderStaffNames(
                            temporarySubstituteStaff,
                            `${building}-temporary`,
                            'text-xs font-medium text-cyan-800',
                          )}
                        </div>
                      )}

                    {/* 差旅人员 */}
                    {travelStaff.length > 0 && (
                      <div className="flex min-w-0 flex-wrap items-center gap-1">
                        <span className="duty-leave-tag duty-leave-tag-travel flex-shrink-0 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700">
                          差旅
                        </span>
                        {renderStaffNames(
                          travelStaff,
                          `${building}-travel`,
                          'text-xs font-medium text-amber-800',
                        )}
                      </div>
                    )}
                    </div>
                  </div>
                );
              },
            )}
          </div>
        ) : (
          <div className="flex items-center justify-center gap-3 py-2 text-center">
            <span className="duty-leave-empty-icon flex h-6 w-6 items-center justify-center rounded-full border border-green-400 bg-green-50 text-xs font-medium text-green-600">
              无
            </span>
            <span className="duty-leave-empty-text text-sm text-green-600">
              当日无请假及差旅安排
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

// 今日长白班在岗一览组件
interface TodayEngineersOnDutyProps {
  selectedDate: Date;
  personProfileMap: StaffProfileMap;
  refreshToken: number;
  localSnapshotRefreshToken: number;
  workCalendarRevision: number;
  canRefresh?: boolean;
  canRefreshRelated?: boolean;
}

function TodayEngineersOnDuty({
  selectedDate,
  personProfileMap,
  refreshToken,
  localSnapshotRefreshToken,
  workCalendarRevision,
  canRefresh = false,
  canRefreshRelated = false,
}: TodayEngineersOnDutyProps) {
  const [longWhiteDutyBuildings, setLongWhiteDutyBuildings] = useState<
    LongWhiteDutyStaffByBuilding[]
  >([]);
  const [festivalSchedules, setFestivalSchedules] = useState<
    FestivalSchedule[]
  >([]);
  const [leaveStaffData, setLeaveStaffData] = useState<
    TodayLeaveStaffByBuilding[]
  >([]);
  const [loading, setLoading] = useState(true);
  const loadSeqRef = useRef(0);
  const lastSuccessfulRefreshTokenRef = useRef(0);
  const lastObservedLocalSnapshotRefreshTokenRef = useRef(
    localSnapshotRefreshToken,
  );

  // 获取节假日信息
  const holidayInfo = useMemo(() => {
    const year = selectedDate.getFullYear();
    const month = String(selectedDate.getMonth() + 1).padStart(2, '0');
    const day = String(selectedDate.getDate()).padStart(2, '0');
    return getHolidayInfo(`${year}-${month}-${day}`);
  }, [selectedDate, workCalendarRevision]);

  const longWhiteRestInfo = useMemo(
    () => getLongWhiteRestInfo(selectedDate),
    [selectedDate, workCalendarRevision],
  );
  const isLongWhiteWorkday = !longWhiteRestInfo.isRestDay;
  const longWhiteRestReason = longWhiteRestInfo.reason;

  const loadLongWhiteDutyStaff = useCallback(async () => {
    const year = selectedDate.getFullYear();
    const month = selectedDate.getMonth();
    const day = selectedDate.getDate();
    const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const requestId = loadSeqRef.current + 1;
    loadSeqRef.current = requestId;
    const forceRefresh = canRefresh && refreshToken > lastSuccessfulRefreshTokenRef.current;
    const localSnapshotRefresh =
      localSnapshotRefreshToken >
      lastObservedLocalSnapshotRefreshTokenRef.current;
    lastObservedLocalSnapshotRefreshTokenRef.current =
      localSnapshotRefreshToken;
    const preserveExistingOnError = shouldPreserveLocalSnapshotData(
      localSnapshotRefresh,
      forceRefresh,
    );
    const cacheKey = `${dateStr}|calendar:${workCalendarRevision}`;
    const cached = longWhiteScheduleCache.get(cacheKey);
    const now = Date.now();

    if (!forceRefresh && cached) {
      setLongWhiteDutyBuildings(cached.longWhiteDutyBuildings);
      setFestivalSchedules(cached.festivalSchedules);
      setLeaveStaffData(cached.leaveStaffData);
      setLoading(false);

      if (now - cached.fetchedAt < LOCAL_DATA_CACHE_TTL_MS) {
        return;
      }
    } else {
      if (!preserveExistingOnError) setLoading(true);
    }

    let festivalScheduleLoadFailed = false;
    const fetchFestivalSchedulesForDate = async (): Promise<
      FestivalSchedule[]
    > => {
      try {
        const festivalData = await getFestivalSchedules(dateStr, dateStr);
        return festivalData.schedules || [];
      } catch (festivalError) {
        logger.error('加载节日重保排班数据失败', festivalError);
        festivalScheduleLoadFailed = true;
        return [];
      }
    };

    try {
      if (!isLongWhiteWorkday) {
        const festivalSchedulesForDate = await fetchFestivalSchedulesForDate();

        if (requestId !== loadSeqRef.current) {
          return;
        }
        if (festivalScheduleLoadFailed && preserveExistingOnError) {
          return;
        }

        longWhiteScheduleCache.set(cacheKey, {
          longWhiteDutyBuildings: [],
          festivalSchedules: festivalSchedulesForDate,
          leaveStaffData: [],
          fetchedAt: Date.now(),
        });
        setLongWhiteDutyBuildings([]);
        setLeaveStaffData([]);
        setFestivalSchedules(festivalSchedulesForDate);
        return;
      }

      // 同时获取排班数据和请假数据
      const [dutyData, leaveData, festivalSchedulesForDate] = await Promise.all(
        [
          getLongWhiteDutyStaff(dateStr, forceRefresh),
          getTodayLeaveStaff(dateStr, forceRefresh && canRefreshRelated),
          fetchFestivalSchedulesForDate(),
        ],
      );
      if (festivalScheduleLoadFailed && preserveExistingOnError) {
        return;
      }

      const buildings = dutyData.buildings || [];
      const leaveStaffDataForDate = leaveData.buildings || [];

      if (requestId !== loadSeqRef.current) {
        return;
      }
      if (forceRefresh) {
        lastSuccessfulRefreshTokenRef.current = refreshToken;
      }

      longWhiteScheduleCache.set(cacheKey, {
        longWhiteDutyBuildings: buildings,
        festivalSchedules: festivalSchedulesForDate,
        leaveStaffData: leaveStaffDataForDate,
        fetchedAt: Date.now(),
      });
      setLongWhiteDutyBuildings(buildings);
      setLeaveStaffData(leaveStaffDataForDate);
      setFestivalSchedules(festivalSchedulesForDate);
    } catch (error) {
      logger.error('加载长白班在岗人员失败', error);
      // 出错时清空数据，避免显示旧数据
      if (requestId === loadSeqRef.current && !preserveExistingOnError) {
        setLongWhiteDutyBuildings([]);
        setFestivalSchedules([]);
        setLeaveStaffData([]);
      }
    } finally {
      if (requestId === loadSeqRef.current) {
        setLoading(false);
      }
    }
  }, [
    canRefresh,
    canRefreshRelated,
    holidayInfo.isHoliday,
    isLongWhiteWorkday,
    localSnapshotRefreshToken,
    refreshToken,
    selectedDate,
    workCalendarRevision,
  ]);

  // 加载本地长白班数据
  useEffect(() => {
    loadLongWhiteDutyStaff();
  }, [loadLongWhiteDutyStaff]);

  const longWhiteStaffByBuilding = useMemo(() => {
    const grouped = new Map<string, string[]>();
    longWhiteDutyBuildings.forEach((item) => {
      grouped.set(item.building, item.staff);
    });
    return grouped;
  }, [longWhiteDutyBuildings]);

  const leaveStaffSet = useMemo(() => {
    const names = new Set<string>();
    leaveStaffData.forEach((building) => {
      building.leaveStaff.forEach((name) => names.add(name));
    });
    return names;
  }, [leaveStaffData]);

  // 计算总人员数（排除请假人员）
  const totalEngineers = useMemo(() => {
    return longWhiteDutyBuildings
      .filter((building) => building.building !== 'station_110')
      .reduce(
        (count, building) =>
          count +
          building.staff.filter((name) => !leaveStaffSet.has(name)).length,
        0,
      );
  }, [leaveStaffSet, longWhiteDutyBuildings]);

  if (loading) {
    return (
      <div className="mb-6 rounded-xl border border-blue-200/50 bg-gradient-to-br from-blue-50/90 via-sky-50/80 to-indigo-50/90 p-4 shadow-sm">
        <div className="mb-3 flex items-center gap-2">
          <div className="h-4 w-1 rounded-full bg-gradient-to-b from-blue-400 to-blue-500" />
          <span className="text-sm font-semibold text-blue-800">
            今日长白班在岗一览
          </span>
        </div>
        <div className="py-4 text-center text-sm text-gray-400">加载中...</div>
      </div>
    );
  }

  const today = new Date();
  const isToday =
    selectedDate.getFullYear() === today.getFullYear() &&
    selectedDate.getMonth() === today.getMonth() &&
    selectedDate.getDate() === today.getDate();

  return (
    <div className="mb-6 rounded-xl border border-blue-200/50 bg-gradient-to-br from-blue-50/90 via-sky-50/80 to-indigo-50/90 p-4 shadow-sm">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="h-4 w-1 rounded-full bg-gradient-to-b from-blue-400 to-blue-500" />
          <span className="text-sm font-semibold text-blue-800">
            {isToday
              ? '今日'
              : `${selectedDate.getMonth() + 1}月${selectedDate.getDate()}日`}
            长白班在岗一览
          </span>
          {holidayInfo.isHoliday && (
            <span className="ml-2 rounded-full bg-red-500 px-2 py-0.5 text-xs font-medium text-white">
              {holidayInfo.name}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          {festivalSchedules.length > 0 ? (
            <span className="rounded-full bg-purple-100 px-2 py-0.5 text-xs font-medium text-purple-700">
              节日重保
            </span>
          ) : isLongWhiteWorkday ? (
            <span className="text-xs text-blue-700">
              共{' '}
              <span className="font-bold text-blue-800">{totalEngineers}</span>{' '}
              人
            </span>
          ) : (
            <span className="rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-700">
              长白班休息
            </span>
          )}
        </div>
      </div>

      {/* 如果有非值班排班数据，显示楼栋分组 */}
      {!isLongWhiteWorkday && festivalSchedules.length === 0 ? (
        <div
          className="flex min-h-[92px] items-center justify-center rounded-lg border border-dashed border-emerald-200/60 bg-emerald-50/35 px-4 py-5 text-center"
          title={`${longWhiteRestReason}不上班`}
        >
          <div className="relative select-none">
            <span
              className="absolute inset-0 text-5xl font-semibold italic leading-none text-emerald-200/45 blur-sm"
              aria-hidden="true"
            >
              无
            </span>
            <span className="relative bg-gradient-to-br from-emerald-400/85 via-teal-500/75 to-blue-400/60 bg-clip-text text-5xl font-semibold italic leading-none text-transparent drop-shadow-sm">
              无
            </span>
          </div>
        </div>
      ) : longWhiteDutyBuildings.length > 0 &&
        festivalSchedules.length === 0 ? (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-6 lg:grid-cols-7">
          {BUILDING_ORDER.filter((key) => key !== 'station_110').map(
            (buildingKey) => {
              const buildingName = BUILDING_MAP[buildingKey];
              const isHBuilding = buildingKey === 'building_h';
              const isCompactTwoColumnBuilding =
                buildingKey === 'building_d' || buildingKey === 'building_e';

              // 合并当前楼栋的长白班在岗人员
              const allPersons =
                longWhiteStaffByBuilding.get(buildingKey) || [];
              const uniquePersons = [...new Set(allPersons)];
              // 过滤掉请假人员：从在岗列表中移除同时在请假列表中的人员
              const availablePersons = uniquePersons.filter(
                (name) => !leaveStaffSet.has(name),
              );

              // 各楼栋置顶人员配置
              const pinnedNames: Record<string, string[]> = {
                building_h: ['梅冰冰', '马进宇'],
                building_a: ['施小东'],
                building_b: ['陈继猛'],
                building_c: ['杨占山'],
                building_d: ['陶必亮'],
                building_e: ['陈凯'],
              };

              const pinned = pinnedNames[buildingKey] || [];
              const pinnedPersons = availablePersons.filter((n) =>
                pinned.includes(n),
              );
              const otherPersons = availablePersons.filter(
                (n) => !pinned.includes(n),
              );

              return (
                <div
                  key={buildingKey}
                  className={`rounded-lg border border-blue-200/50 bg-white/70 p-3 ${isHBuilding ? 'col-span-2' : ''}`}
                >
                  <div className="mb-2 flex items-center justify-center">
                    <span className="rounded bg-blue-400/80 px-2 py-0.5 text-xs font-medium text-white">
                      {buildingName}
                    </span>
                  </div>

                  {availablePersons.length > 0 ? (
                    <div
                      className={`grid gap-x-2 gap-y-1 ${
                        isHBuilding
                          ? 'grid-cols-3'
                          : isCompactTwoColumnBuilding
                            ? 'grid-cols-1 xl:grid-cols-2'
                            : 'grid-cols-1'
                      }`}
                    >
                      {/* 置顶人员 - 加粗蓝色 */}
                      {pinnedPersons.map((name, index) => (
                        <div
                          key={`pinned-${index}`}
                          className="text-center text-sm font-bold text-blue-600"
                        >
                          <StaffProfilePopover
                            name={name}
                            profile={getStaffProfile(personProfileMap, name)}
                            className="font-bold text-blue-600"
                          />
                        </div>
                      ))}
                      {/* 其他人员 */}
                      {otherPersons.map((name, index) => (
                        <div
                          key={index}
                          className="text-center text-sm text-gray-700"
                        >
                          <StaffProfilePopover
                            name={name}
                            profile={getStaffProfile(personProfileMap, name)}
                            className="text-gray-700"
                          />
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="py-2 text-center text-xs text-gray-400">
                      -
                    </div>
                  )}
                </div>
              );
            },
          )}
        </div>
      ) : festivalSchedules.length > 0 ? (
        <div className="flex min-h-[92px] items-center rounded-lg border border-blue-100/70 bg-white/70 px-4 py-4">
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
            <span className="border-l-2 border-blue-400 pl-2 text-xs font-semibold text-blue-700">
              节日重保
            </span>
            {orderStaffNames(
              festivalSchedules.flatMap((schedule) =>
                splitStaffDisplayNames(schedule.appStaffText),
              ),
              personProfileMap,
              true,
            ).map((name, index) => (
              <StaffProfilePopover
                key={`${name}-${index}`}
                name={name}
                profile={getStaffProfile(personProfileMap, name)}
                className="text-sm font-medium text-slate-700"
              />
            ))}
          </div>
        </div>
      ) : (
        <div className="py-4 text-center text-sm text-gray-400">
          今日无长白班排班数据
        </div>
      )}
    </div>
  );
}

function MonthlySchedulePageContent() {
  const navigate = useNavigate();
  const access = useAccess();
  const { capabilities, principalFingerprint, role, requestLogin } = access;
  const canReadMonthlySchedule = canUsePageAction(access, 'monthly_schedule', 'read', true);
  const legacySelfService = capabilities.canEdit || role === 'guest' || role === 'site_member';
  const canCreateLeaveRequest = canUsePageAction(access, 'leave_requests', 'create', legacySelfService);
  const canCreateOvertimeRequest = canUsePageAction(access, 'overtime_requests', 'create', legacySelfService);
  const selfServiceOnly = Boolean(access.effectiveAuthorization && !canReadMonthlySchedule && (canCreateLeaveRequest || canCreateOvertimeRequest));
  const [selfServiceIdentity, setSelfServiceIdentity] = useState<{ scope: string; status: 'loading' | 'ready' | 'error'; name: string; error: string } | null>(null);
  const [selfServiceRetry, setSelfServiceRetry] = useState(0);
  const scheduleReadScope = useMemo(
    () => selfServiceOnly ? selectSelfServiceScheduleReadScope(`self:${principalFingerprint || 'anonymous'}`) : selectMonthlyScheduleReadScope(principalFingerprint || 'anonymous'),
    [principalFingerprint, selfServiceOnly],
  );
  const {
    cache: monthlyScheduleCache,
    inFlight: monthlyScheduleReadInFlight,
    read: getMonthlySchedulesWithInFlightDeduplication,
  } = scheduleReadScope;
  const activeScheduleReadScopeRef = useRef(scheduleReadScope);
  activeScheduleReadScopeRef.current = scheduleReadScope;
  const selfServiceIdentityReady = selfServiceIdentity?.scope === scheduleReadScope.identity && selfServiceIdentity.status === 'ready';
  const selfServiceApplicant = useMemo<SelfServiceApplicant | undefined>(() => selfServiceOnly ? { mode: 'automatic', name: selfServiceIdentityReady ? selfServiceIdentity!.name : '' } : undefined, [selfServiceOnly, selfServiceIdentityReady, selfServiceIdentity?.name]);
  const leaveApplicant = useMemo(
    () => selfServiceApplicant || resolveLeaveRequestApplicant(access, hasAuthenticatedAccessIdentity(access)),
    [selfServiceApplicant, access.accountId, access.displayName, access.expiresAt, principalFingerprint, role],
  );
  const weatherSnapshot = useWeatherSnapshot();
  const canReadAttendance = canUsePageAction(access, 'attendance', 'read', role !== 'guest');
  const todayAttendance = useTodayAttendanceSnapshot(canReadAttendance);
  const weatherGuardRegistrationEnabled =
    weatherSnapshot.warningStatus !== 'error' &&
    weatherSnapshot.warningSnapshot?.features?.registrationEnabled === true;
  const weatherGuardRegistrationReturnFocusRef = useRef<HTMLElement | null>(
    null,
  );
  const weatherGuardRegistrationFallbackRef = useRef<HTMLElement | null>(null);
  const weatherGuardRegistrationSyncingRef = useRef(false);
  const [weatherGuardRegistration, setWeatherGuardRegistration] =
    useState<WeatherGuardRegistrationDeepLink | null>(null);
  const handleWeatherGuardRegistrationOpen = useCallback(
    (warningId: string, returnFocusTarget?: HTMLElement | null) => {
      if (!weatherGuardRegistrationEnabled) return;
      if (!warningId || warningId !== warningId.trim()) return;
      if (weatherGuardRegistrationSyncingRef.current) {
        toast.info('戒备登记正在后台同步，请等待当前结果');
        return;
      }
      const activeElement =
        typeof document !== 'undefined' &&
        typeof HTMLElement !== 'undefined' &&
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      weatherGuardRegistrationReturnFocusRef.current =
        returnFocusTarget?.isConnected === true
          ? returnFocusTarget
          : activeElement?.isConnected === true
            ? activeElement
            : null;
      setWeatherGuardRegistration({ warningId, source: 'page' });
    },
    [weatherGuardRegistrationEnabled],
  );
  const handleWeatherGuardRegistrationClose = useCallback(() => {
    const returnFocusTarget = weatherGuardRegistrationReturnFocusRef.current;
    weatherGuardRegistrationReturnFocusRef.current = null;
    setWeatherGuardRegistration(null);
    if (typeof window === 'undefined') return;

    const currentSearchParams = new URLSearchParams(window.location.search);
    const nextSearchParams =
      clearWeatherGuardRegistrationDeepLink(currentSearchParams);
    const nextQuery = nextSearchParams.toString();
    const nextUrl = `${window.location.pathname}${nextQuery ? `?${nextQuery}` : ''}${window.location.hash}`;
    window.history.replaceState(window.history.state, '', nextUrl);
    window.requestAnimationFrame(() => {
      const focusTarget = returnFocusTarget?.isConnected
        ? returnFocusTarget
        : weatherGuardRegistrationFallbackRef.current?.isConnected
          ? weatherGuardRegistrationFallbackRef.current
          : null;
      focusTarget?.focus({ preventScroll: true });
    });
  }, []);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (
      weatherSnapshot.warningStatus !== 'ready' &&
      weatherSnapshot.warningStatus !== 'error'
    ) {
      return;
    }

    const currentSearchParams = new URLSearchParams(window.location.search);
    const deepLink = readWeatherGuardRegistrationDeepLink(currentSearchParams);
    if (
      weatherSnapshot.warningStatus === 'ready' &&
      weatherGuardRegistrationEnabled
    ) {
      if (deepLink) setWeatherGuardRegistration(deepLink);
      return;
    }

    setWeatherGuardRegistration(null);
    const nextSearchParams =
      clearWeatherGuardRegistrationDeepLink(currentSearchParams);
    if (nextSearchParams.toString() === currentSearchParams.toString()) return;
    const nextQuery = nextSearchParams.toString();
    const nextUrl = `${window.location.pathname}${nextQuery ? `?${nextQuery}` : ''}${window.location.hash}`;
    window.history.replaceState(window.history.state, '', nextUrl);
  }, [weatherGuardRegistrationEnabled, weatherSnapshot.warningStatus]);
  const weatherScreenshotReadinessRef = useRef(
    weatherSnapshot.screenshotReadiness,
  );
  weatherScreenshotReadinessRef.current = weatherSnapshot.screenshotReadiness;
  const canManageMonthlySchedule = canUsePageAction(access, 'schedule_assignments', 'update', capabilities.canEdit);
  const canViewScheduleDetails = canUsePageAction(access, 'monthly_schedule', 'read', role !== 'guest');
  const canReadPersonnelSchedule = canUsePageAction(access, 'personnel_schedule', 'read', role !== 'guest');
  const canRefreshPersonnelSchedule = canUsePageAction(access, 'personnel_schedule', 'refresh', capabilities.canForceRefresh);
  const canReadAssignments = canUsePageAction(access, 'schedule_assignments', 'read', true);
  const canCreateMonthlySchedule = canUsePageAction(access, 'schedule_assignments', 'create', capabilities.canEdit);
  const canRefreshMonthlySchedule = canUsePageAction(access, 'monthly_schedule', 'refresh', capabilities.canForceRefresh);
  const canSendMonthlySchedule = canUsePageAction(access, 'monthly_schedule', 'notify', capabilities.canEdit);
  const canCreateChange = canUsePageAction(access, 'change_requests', 'create', legacySelfService);
  const canUpdateChange = canUsePageAction(access, 'change_management', 'update', capabilities.canEdit);
  const canDeleteChange = canUsePageAction(access, 'change_management', 'delete', capabilities.canDelete);
  const canCreateException = canUsePageAction(access, 'exception_followup', 'create', capabilities.canEdit);
  const canUpdateException = canUsePageAction(access, 'exception_followup', 'update', capabilities.canEdit);
  const canDeleteException = canUsePageAction(access, 'exception_followup', 'delete', capabilities.canDelete);
  const canRefreshException = canUsePageAction(access, 'exception_followup', 'refresh', capabilities.canForceRefresh);
  const canRefreshChange = canUsePageAction(access, 'change_management', 'refresh', capabilities.canForceRefresh);
  const canRefreshPrivateProfile = canUsePageAction(access, 'personnel_profile', 'refresh', capabilities.canForceRefresh);
  const canCreateAdditionalMatter = canCreateMonthlySchedule;
  const canReadChanges = canUsePageAction(access, 'change_management', 'read', true);
  const canReadExceptions = canUsePageAction(access, 'exception_followup', 'read', true);
  const canReadTimeInsights = canUsePageAction(access, 'personnel_time_insights', 'read', role === 'admin');
  const canReadPublicProfiles = canReadMonthlySchedule || canReadAssignments || canCreateMonthlySchedule || canManageMonthlySchedule || canCreateLeaveRequest || canCreateOvertimeRequest || canCreateChange || canUsePageAction(access, 'organization', 'read', true);
  const canRefreshPublicProfiles = canUsePageAction(access, 'organization', 'refresh', capabilities.canForceRefresh);
  const canCreateThresholdAdjustment = canUsePageAction(access, 'thresholds', 'create', legacySelfService);
  const canCreatePersonality = canUsePageAction(access, 'personality', 'create', legacySelfService);
  const canSubmitChangeDrillReport = canUsePageAction(access, 'change_management', 'create', canSubmitChangeDrillReportForRole(role));
  const canSubmitChangeSummaryReport = canUsePageAction(access, 'change_management', 'create', canSubmitChangeSummaryReportForRole(role)) && Boolean(principalFingerprint);
  const canUseSelfServiceTools = legacySelfService || canCreateLeaveRequest || canCreateOvertimeRequest || canCreateChange || canUpdateChange || canManageMonthlySchedule || canCreateMonthlySchedule || canReadTimeInsights || canCreateThresholdAdjustment || canCreatePersonality || canRefreshMonthlySchedule || canSendMonthlySchedule;
  const canViewPrivateProfile = canViewPersonProfileDetails(access);
  const canDeleteMonthlySchedule = canUsePageAction(access, 'schedule_assignments', 'delete', capabilities.canDelete);
  const [selectedDate, setSelectedDate] = useState<Date>(() =>
    getInitialSelectedDate(),
  );
  const selectedDateKey = formatDateKey(selectedDate);
  const [businessDateKey, setBusinessDateKey] = useState(() =>
    getShanghaiBusinessDateKey(),
  );
  const refreshBusinessClock = useCallback(() => {
    const nextBusinessDateKey = getShanghaiBusinessDateKey();
    setBusinessDateKey((current) =>
      current === nextBusinessDateKey ? current : nextBusinessDateKey,
    );
  }, []);
  useEffect(() => {
    const intervalId = window.setInterval(refreshBusinessClock, 60_000);
    window.addEventListener('focus', refreshBusinessClock);
    document.addEventListener('visibilitychange', refreshBusinessClock);
    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener('focus', refreshBusinessClock);
      document.removeEventListener('visibilitychange', refreshBusinessClock);
    };
  }, [refreshBusinessClock]);
  const [schedules, setSchedules] = useState<MonthlySchedule[]>([]);
  const selfServiceMonth = businessDateKey.slice(0, 7);
  useEffect(() => {
    if (!selfServiceOnly || access.isLoading) return;
    let active = true;
    const scope = scheduleReadScope;
    const [year, month] = selfServiceMonth.split('-').map(Number);
    setSelfServiceIdentity({ scope: scope.identity, status: 'loading', name: '', error: '' });
    void scope.read(year, month).then((value) => {
      if (!active || activeScheduleReadScopeRef.current !== scope) return;
      const own = value as SelfServiceScheduleResponse;
      scope.cache.set(`${year}-${month}`, { schedules: own.schedules, fetchedAt: Date.now() });
      setSchedules(current => mergeSchedulesByRecord(current, own.schedules));
      setSelfServiceIdentity({ scope: scope.identity, status: 'ready', name: own.applicantName, error: '' });
    }).catch((error) => {
      if (!active || activeScheduleReadScopeRef.current !== scope) return;
      setSelfServiceIdentity({ scope: scope.identity, status: 'error', name: '', error: getBackendErrorMessage(error, '本人班次暂时无法读取，请重试') });
    });
    return () => { active = false; };
  }, [selfServiceOnly, access.isLoading, scheduleReadScope, selfServiceMonth, selfServiceRetry]);
  const schedulesRef = useRef(schedules);
  schedulesRef.current = schedules;
  const [loading, setLoading] = useState(false);
  const [emergencyDutyIndex, setEmergencyDutyIndex] =
    useState<EmergencyDutyIndex>(() => buildEmergencyDutyIndex([]));
  const emergencyDutyIndexRef = useRef(emergencyDutyIndex);
  emergencyDutyIndexRef.current = emergencyDutyIndex;
  const [emergencyDutyLoadStatus, setEmergencyDutyLoadStatus] =
    useState<EmergencyDutyLoadState>('loading');
  const [emergencyDutyLoadError, setEmergencyDutyLoadError] = useState('');
  const [emergencyDutySnapshotStale, setEmergencyDutySnapshotStale] =
    useState(false);
  const [emergencyDutyLoadedRange, setEmergencyDutyLoadedRange] =
    useState<EmergencyDutyLoadedRange | null>(null);
  const [emergencyDutyOptions, setEmergencyDutyOptions] = useState<
    EmergencyDutyPersonOption[]
  >([]);
  const [emergencyDutyOptionsStatus, setEmergencyDutyOptionsStatus] = useState<
    'idle' | 'loading' | 'ready' | 'error'
  >('idle');
  const [emergencyDutyDate, setEmergencyDutyDate] = useState(selectedDateKey);
  const [emergencyDutySelectedKeys, setEmergencyDutySelectedKeys] = useState<
    string[]
  >([]);
  const [emergencyDutySearch, setEmergencyDutySearch] = useState('');
  const [screenshotReadiness, setScreenshotReadiness] = useState(
    createDutyOverviewScreenshotReadiness,
  );
  const [sealings, setSealings] = useState<SealingInfo[]>([]);
  const [sealingDetailDate, setSealingDetailDate] = useState<string | null>(
    null,
  );
  const sealingDetailTriggerRef = useRef<HTMLElement | null>(null);
  const [changes, setChanges] = useState<ChangeInfo[]>([]);
  const [calendarDayDialogController] = useState(createCalendarDayDialogController);
  const [personProfiles, setPersonProfiles] = useState<NantongOrganization[]>(
    [],
  );
  const [changeRequestSubmitterOptions, setChangeRequestSubmitterOptions] =
    useState<string[]>([]);
  const [personProfileDetails, setPersonProfileDetails] = useState<
    PersonProfileDetail[]
  >([]);
  const [manualSyncing, setManualSyncing] = useState(false);
  const [manualScreenshotSending, setManualScreenshotSending] = useState(false);
  const [vacancyDialogOpen, setVacancyDialogOpen] = useState(false);
  const [staffAdjustmentMode, setStaffAdjustmentMode] =
    useState<StaffAdjustmentMode>('vacancy');
  const [vacancyInputs, setVacancyInputs] = useState<Record<string, string>>(
    {},
  );
  const [vacancySubmitting, setVacancySubmitting] = useState(false);
  const [repairBuilding, setRepairBuilding] = useState(
    VACANCY_BUILDING_ORDER[0],
  );
  const [repairShift, setRepairShift] = useState('white');
  const [repairDate, setRepairDate] = useState(() => selectedDateKey);
  const [repairDateLoading, setRepairDateLoading] = useState(false);
  const [repairTargetName, setRepairTargetName] = useState('');
  const [repairReplacementName, setRepairReplacementName] = useState('');
  const [repairReplacementSearch, setRepairReplacementSearch] = useState('');
  const [repairReplacementPickerOpen, setRepairReplacementPickerOpen] =
    useState(false);
  const [repairSubmitting, setRepairSubmitting] = useState(false);
  const [travelPersonProfiles, setTravelPersonProfiles] = useState<
    NantongOrganization[]
  >([]);
  const [travelProfilesStatus, setTravelProfilesStatus] = useState<
    'idle' | 'loading' | 'ready' | 'error'
  >('idle');
  const travelProfilesLoading = travelProfilesStatus === 'loading';
  const [travelStaffName, setTravelStaffName] = useState('');
  const [travelStaffSearch, setTravelStaffSearch] = useState('');
  const [travelStaffPickerOpen, setTravelStaffPickerOpen] = useState(false);
  const [travelStartDate, setTravelStartDate] = useState(() =>
    getTodayDateKey(),
  );
  const [travelEndDate, setTravelEndDate] = useState(() => getTodayDateKey());
  const [travelSubmitting, setTravelSubmitting] = useState(false);
  const [travelDetails, setTravelDetails] = useState<TravelStaffDetail[]>([]);
  const [travelDetailsLoading, setTravelDetailsLoading] = useState(false);
  const [travelActionSubmitting, setTravelActionSubmitting] = useState(false);
  const [editingTravelDetail, setEditingTravelDetail] =
    useState<TravelStaffDetail | null>(null);
  const [editingTravelRecordIds, setEditingTravelRecordIds] = useState<
    string[]
  >([]);
  const [pendingTravelRevoke, setPendingTravelRevoke] = useState<{
    detail: TravelStaffDetail;
    recordIds: string[];
  } | null>(null);
  const [expandedTravelStaffNames, setExpandedTravelStaffNames] = useState<
    Record<string, boolean>
  >({});
  const [expandedTravelDetailId, setExpandedTravelDetailId] = useState<
    string | null
  >(null);
  const [selectedTravelRecordIds, setSelectedTravelRecordIds] = useState<
    Record<string, string[]>
  >({});
  const [travelEditStartDate, setTravelEditStartDate] = useState('');
  const [travelEditEndDate, setTravelEditEndDate] = useState('');
  const [personnelMovementDialogOpen, setPersonnelMovementDialogOpen] =
    useState(false);
  const [personnelMovementStaffName, setPersonnelMovementStaffName] =
    useState('');
  const [personnelMovementStaffSearch, setPersonnelMovementStaffSearch] =
    useState('');
  const [
    personnelMovementStaffPickerOpen,
    setPersonnelMovementStaffPickerOpen,
  ] = useState(false);
  const [personnelMovementType, setPersonnelMovementType] =
    useState<PersonnelMovementType>('异动');
  const [personnelMovementDate, setPersonnelMovementDate] = useState(() =>
    getTodayDateKey(),
  );
  const [personnelMovementSubmitting, setPersonnelMovementSubmitting] =
    useState(false);
  const [thresholdAdjustmentDialogOpen, setThresholdAdjustmentDialogOpen] =
    useState(false);
  const [personnelTimeInsightsDialogOpen, setPersonnelTimeInsightsDialogOpen] =
    useState(false);
  const [changeRequestSubmitting, setChangeRequestSubmitting] = useState(false);
  const [changeRequestDraft, setChangeRequestDraft] =
    useState<ChangeRequestDraft>(() =>
      createChangeRequestDraftForDate(selectedDateKey),
    );
  const [changeRequestStagedDocuments, setChangeRequestStagedDocuments] =
    useState<ChangeRequestStagedDocument[]>([]);
  const [changeRequestOwnerMutationId, setChangeRequestOwnerMutationId] =
    useState(() => createChangeRequestMutationId());
  const [changeRequestPartialRecord, setChangeRequestPartialRecord] =
    useState<ChangeInfo | null>(null);
  const [changeRequestRetryAction, setChangeRequestRetryAction] =
    useState<ChangeRequestRetryAction | null>(null);
  const [changeRequestResetKey, setChangeRequestResetKey] = useState(0);
  const [changeRequestServerError, setChangeRequestServerError] = useState<
    string | null
  >(null);
  const [changeAdjustmentRequestOpen, setChangeAdjustmentRequestOpen] =
    useState(false);
  const [
    changeAdjustmentRequestSubmitting,
    setChangeAdjustmentRequestSubmitting,
  ] = useState(false);
  const [
    changeAdjustmentRequestOwnerMutationId,
    setChangeAdjustmentRequestOwnerMutationId,
  ] = useState(() => createChangeAdjustmentMutationId());
  const [
    changeAdjustmentRequestInitialRecordId,
    setChangeAdjustmentRequestInitialRecordId,
  ] = useState<string | null>(null);
  const [
    changeAdjustmentRequestServerError,
    setChangeAdjustmentRequestServerError,
  ] = useState<string | null>(null);
  const [
    changeAdjustmentRequestRetryBinding,
    setChangeAdjustmentRequestRetryBinding,
  ] = useState<ChangeAdjustmentRequestRetryBinding | null>(null);
  const [changeDrillReportOpen, setChangeDrillReportOpen] = useState(false);
  const [changeDrillReportSubmitting, setChangeDrillReportSubmitting] =
    useState(false);
  const [initialChangeDrillReportRecovery] = useState(() =>
    readChangeDrillReportRecovery(),
  );
  const [
    changeDrillReportOwnerMutationId,
    setChangeDrillReportOwnerMutationId,
  ] = useState(
    () =>
      initialChangeDrillReportRecovery?.request.clientMutationId ||
      createChangeDrillReportMutationId(),
  );
  const [changeDrillReportServerError, setChangeDrillReportServerError] =
    useState<string | null>(() =>
      initialChangeDrillReportRecovery
        ? '上次提交结果尚未确认，已恢复原请求，可安全重试'
        : null,
    );
  const [changeDrillReportRetryBinding, setChangeDrillReportRetryBinding] =
    useState<ChangeDrillReportRetryBinding | null>(
      initialChangeDrillReportRecovery,
    );
  const [changeSummaryReportOpen, setChangeSummaryReportOpen] = useState(false);
  const [changeSummaryReportSubmitting, setChangeSummaryReportSubmitting] =
    useState(false);
  const [
    changeSummaryReportAbandonOperation,
    setChangeSummaryReportAbandonOperation,
  ] = useState<ChangeSummaryReportAbandonOperation | null>(null);
  const [
    changeSummaryReportOwnerMutationId,
    setChangeSummaryReportOwnerMutationId,
  ] = useState(() => createChangeSummaryReportMutationId());
  const [changeSummaryReportServerError, setChangeSummaryReportServerError] =
    useState<string | null>(null);
  const [
    changeSummaryReportRecoveryBindings,
    setChangeSummaryReportRecoveryBindings,
  ] = useState<ChangeSummaryReportRecoveryBinding[]>([]);
  const changeSummaryReportRecoveryBindingsRef = useRef<
    ChangeSummaryReportRecoveryBinding[]
  >([]);
  changeSummaryReportRecoveryBindingsRef.current =
    changeSummaryReportRecoveryBindings;
  const [
    activeChangeSummaryReportRetryBinding,
    setActiveChangeSummaryReportRetryBinding,
  ] = useState<ChangeSummaryReportRecoveryBinding | null>(null);
  const pendingChangeSummaryReportRecordIds = useMemo(
    () =>
      getPendingChangeSummaryReportRecordIds(
        changeSummaryReportRecoveryBindings,
      ),
    [changeSummaryReportRecoveryBindings],
  );
  const [leaveRequestDialogOpen, setLeaveRequestDialogOpen] = useState(false);
  const [leaveRequestSubmitting, setLeaveRequestSubmitting] = useState(false);
  const [manualLeaveStaffName, setLeaveStaffName] = useState('');
  const leaveStaffName = leaveApplicant.mode === 'automatic'
    ? leaveApplicant.name
    : leaveApplicant.mode === 'manual' ? manualLeaveStaffName : '';
  useEffect(() => {
    setLeaveRequestDialogOpen(false);
    setLeaveStaffName('');
  }, [principalFingerprint]);
  const [leaveStartAt, setLeaveStartAt] = useState('');
  const [leaveEndAt, setLeaveEndAt] = useState('');
  const [leaveType, setLeaveType] = useState<LeaveRequestType>('年假');
  const [leaveReason, setLeaveReason] = useState('');
  const [leaveRequestScreenshot, setLeaveRequestScreenshot] =
    useState<File | null>(null);
  const [leaveRequestSyncStatus, setLeaveRequestSyncStatus] = useState<
    'idle' | 'syncing' | 'error'
  >('idle');
  const [recoveredLeaveRequestMutationId, setRecoveredLeaveRequestMutationId] =
    useState<string | null>(() =>
      readLeaveRequestUnknownMutationId(getLeaveRequestSessionStorage()),
    );
  const [leaveRequestRecoveryState, setLeaveRequestRecoveryState] = useState<
    'editable-error' | 'unknown-result' | null
  >(() => (recoveredLeaveRequestMutationId ? 'unknown-result' : null));
  const leaveRequestDraftLocked =
    leaveRequestSubmitting ||
    (leaveRequestRecoveryState === 'unknown-result' &&
      !recoveredLeaveRequestMutationId);
  const [leaveAuthoritativeImpact, setLeaveAuthoritativeImpact] =
    useState<LeaveRequestImpact | null>(null);
  const [leaveScheduleCoverageStatus, setLeaveScheduleCoverageStatus] =
    useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [leaveScheduleCoverageReadyKey, setLeaveScheduleCoverageReadyKey] =
    useState<string | null>(null);
  const [additionalMatterDialogOpen, setAdditionalMatterDialogOpen] =
    useState(false);
  const [additionalMatterMode, setAdditionalMatterMode] =
    useState<AdditionalMatterMode>('focus');
  const [additionalMatterContent, setAdditionalMatterContent] = useState('');
  const [additionalMatterDate, setAdditionalMatterDate] = useState(() =>
    getTodayDateKey(),
  );
  const [additionalMatterSubmitting, setAdditionalMatterSubmitting] =
    useState(false);
  const [sealingRegistrationDialogOpen, setSealingRegistrationDialogOpen] =
    useState(false);
  const [sealingRegistrationRows, setSealingRegistrationRows] = useState<
    SealingRegistrationDraftRow[]
  >(() => [createSealingRegistrationDraftRow(selectedDateKey)]);
  const [sealingRegistrationSubmitting, setSealingRegistrationSubmitting] =
    useState(false);
  const [changeAdjustmentTarget, setChangeAdjustmentTarget] =
    useState<ChangeAdjustmentTarget | null>(null);
  const [changeAdjustmentDraft, setChangeAdjustmentDraft] =
    useState<ChangeAdjustmentDraft>({
      startNoAdjustment: true,
      endNoAdjustment: true,
      startValue: '',
      endValue: '',
    });
  const [changeAdjustmentSubmitting, setChangeAdjustmentSubmitting] =
    useState(false);
  const [changeAdjustmentMessages, setChangeAdjustmentMessages] = useState<
    Record<string, string>
  >({});
  const [exceptionFollowUpTarget, setExceptionFollowUpTarget] =
    useState<ExceptionFollowUpTarget | null>(null);
  const [exceptionFollowUpHandling, setExceptionFollowUpHandling] =
    useState('');
  const [exceptionFollowUpSubmitting, setExceptionFollowUpSubmitting] =
    useState(false);
  const [calendarFollowUpMonth, setCalendarFollowUpMonth] = useState(selectedDate);
  const [dataRefreshToken, setDataRefreshToken] = useState(0);
  const [localSnapshotRefreshToken, setLocalSnapshotRefreshToken] = useState(0);
  const [workCalendarRevision, setWorkCalendarRevision] = useState(0);
  const effectiveDataRefreshToken = canRefreshMonthlySchedule
    ? dataRefreshToken
    : 0;
  const fetchCalendarFollowUps = useCallback(
    (range: {start:string;end:string}, force: boolean) =>
      canReadExceptions ? getExceptionFollowUps(range.start, force && canRefreshException, range.end) : Promise.resolve({ date: range.start, range, items: [], total: 0 }),
    [canRefreshException, canReadExceptions],
  );
  const calendarFollowUps = useCalendarFollowUps(
    calendarFollowUpRange(calendarFollowUpMonth), fetchCalendarFollowUps, effectiveDataRefreshToken,
  );
  const exceptionFollowUpsByKey = calendarFollowUps.index;
  const setExceptionFollowUpsByKey = calendarFollowUps.setIndex;
  const exceptionFollowUpsLoading = calendarFollowUps.loading;
  useEffect(() => {setCalendarFollowUpMonth(selectedDate);}, [selectedDate]);
  const isScreenshotMode = getIsScreenshotMode();
  const scheduleLoadSeqRef = useRef(0);
  const emergencyDutyLoadSeqRef = useRef(0);
  const emergencyDutyOptionsLoadSeqRef = useRef(0);
  const emergencyDutyLoadAbortRef = useRef<AbortController | null>(null);
  const emergencyDutyOptionsAbortRef = useRef<AbortController | null>(null);
  const emergencyDutyMutationBindingsRef = useRef(
    new Map<string, EmergencyDutyMutationBinding>(),
  );
  const emergencyDutyMutationRevisionRef = useRef(0);
  const repairScheduleLoadSeqRef = useRef(0);
  const sealingLoadSeqRef = useRef(0);
  const changeLoadSeqRef = useRef(0);
  const changeLoadAbortRef = useRef<AbortController | null>(null);
  const personProfileLoadSeqRef = useRef(0);
  const personProfileLoadAbortRef = useRef<AbortController | null>(null);
  const travelProfileLoadSeqRef = useRef(0);
  const changeRequestSubmittingRef = useRef(false);
  const changeRequestDialogRef = useRef<ChangeRequestDialogHandle>(null);
  const overtimeRequestDialogRef =
    useRef<OvertimeRequestDialogHostHandle>(null);
  const monthlyScheduleFormDeepLinkConsumedRef = useRef(false);
  const commonToolsTriggerRef = useRef<HTMLButtonElement>(null);
  const leaveRequestMenuHandoffRef = useRef(false);
  const leaveRequestReturnFocusRef = useRef<HTMLButtonElement | null>(null);
  const employeeOnboardingDialogRef =
    useRef<NewEmployeeOnboardingDialogHandle>(null);
  const changeRequestDialogOpenRef = useRef(false);
  const changeRequestMutationIdRef = useRef<string>(
    changeRequestOwnerMutationId,
  );
  const changeRequestSubmitSeqRef = useRef(0);
  const changeAdjustmentRequestSubmittingRef = useRef(false);
  const changeAdjustmentRequestSubmitSeqRef = useRef(0);
  const changeDrillReportSubmittingRef = useRef(false);
  const changeDrillReportSubmitSeqRef = useRef(0);
  const changeSummaryReportSubmittingRef = useRef(false);
  const changeSummaryReportOpenRef = useRef(false);
  changeSummaryReportOpenRef.current = changeSummaryReportOpen;
  const changeSummaryReportRecoveryConsumedRef = useRef<string | null>(null);
  const previousChangeSummaryReportPrincipalFingerprintRef = useRef<
    string | null
  >(null);
  const changeSummaryReportPrincipalFingerprintRef =
    useRef(principalFingerprint);
  changeSummaryReportPrincipalFingerprintRef.current = principalFingerprint;
  const changeSummaryReportTaskSeqRef = useRef(0);
  const changeSummaryReportTaskRuntimesRef = useRef(
    new Map<string, { seq: number; controller: AbortController }>(),
  );
  const changeSummaryReportAbandonOperationRef =
    useRef<ChangeSummaryReportAbandonOperation | null>(null);
  const changeSummaryReportAbandonTokenRef = useRef(0);
  useEffect(() => {
    if (!changeDrillReportRetryBinding || changeDrillReportSubmitting) return;
    toast.warning('上次演练报告提交结果待确认，可从“演练提交”安全重试', {
      id: changeDrillReportRetryBinding.request.clientMutationId,
      duration: Number.POSITIVE_INFINITY,
    });
  }, [changeDrillReportRetryBinding, changeDrillReportSubmitting]);
  const changeRequestOverlayRef = useRef(new Map<string, ChangeInfo>());
  const changeRequestOverlayVersionRef = useRef(new Map<string, number>());
  const changeRequestOverlayGenerationRef = useRef(0);
  const selectedYearRef = useRef(selectedDate.getFullYear());
  selectedYearRef.current = selectedDate.getFullYear();
  const leaveRequestSubmittingRef = useRef(false);
  const leaveRequestMutationBindingRef =
    useRef<LeaveRequestMutationBinding | null>(null);
  const leaveRequestSubmitSeqRef = useRef(0);
  const leaveTimeRangeStaffKeyRef = useRef<string | null>(null);
  const leaveScheduleCoverageLoadSeqRef = useRef(0);
  const leaveScheduleForceRefreshPendingRef = useRef(false);
  const pendingScheduleRecordIdsRef = useRef(new Set<string>());
  const scheduleMonthRequestGenerationRef = useRef(new Map<string, number>());
  const scheduleMonthForceRefreshGenerationRef = useRef(
    new Map<string, number>(),
  );
  const lockedLeaveRequestRetryBinding =
    leaveRequestRecoveryState === 'unknown-result' &&
    !recoveredLeaveRequestMutationId &&
    leaveRequestMutationBindingRef.current?.state === 'unknown-result'
      ? leaveRequestMutationBindingRef.current
      : null;
  const hasLockedLeaveRequestRetry = Boolean(lockedLeaveRequestRetryBinding);

  useEffect(() => {
    if (
      typeof window === 'undefined' ||
      access.isLoading ||
      (selfServiceOnly && !selfServiceIdentityReady) ||
      !canUseSelfServiceTools ||
      getHasScreenshotModeRequest() ||
      monthlyScheduleFormDeepLinkConsumedRef.current
    ) {
      return;
    }

    const currentSearchParams = new URLSearchParams(window.location.search);
    const directForm = readMonthlyScheduleFormDeepLink(
      currentSearchParams,
      window.location.pathname,
    );
    if (!directForm) return;
    monthlyScheduleFormDeepLinkConsumedRef.current = true;

    if (directForm === 'leave' && canCreateLeaveRequest) {
      if (leaveApplicant.mode === 'login') {
        requestLogin(leaveApplicant.message, '/monthly-schedule');
        return;
      }
      if (leaveApplicant.mode === 'error') {
        toast.error(leaveApplicant.message);
        return;
      }
      if (
        !leaveRequestMutationBindingRef.current &&
        !recoveredLeaveRequestMutationId
      ) {
        setLeaveStartAt('');
        setLeaveEndAt('');
        setLeaveRequestSyncStatus('idle');
        setLeaveRequestRecoveryState(null);
        setLeaveScheduleCoverageReadyKey(null);
      }
      refreshBusinessClock();
      setLeaveRequestDialogOpen(true);
    }
    if (directForm === 'overtime' && canCreateOvertimeRequest) {
      refreshBusinessClock();
      overtimeRequestDialogRef.current?.open();
    }
  }, [
    access.isLoading,
    selfServiceOnly,
    selfServiceIdentityReady,
    canUseSelfServiceTools,
    canCreateLeaveRequest,
    canCreateOvertimeRequest,
    leaveApplicant,
    requestLogin,
    recoveredLeaveRequestMutationId,
    refreshBusinessClock,
  ]);

  const resetChangeRequestDraft = useCallback(() => {
    const nextMutationId = createChangeRequestMutationId();
    changeRequestMutationIdRef.current = nextMutationId;
    setChangeRequestOwnerMutationId(nextMutationId);
    setChangeRequestDraft(createChangeRequestDraftForDate(selectedDateKey));
    setChangeRequestStagedDocuments([]);
    setChangeRequestPartialRecord(null);
    setChangeRequestRetryAction(null);
    setChangeRequestServerError(null);
    setChangeRequestResetKey((current) => current + 1);
  }, [selectedDateKey]);

  const handleChangeRequestDialogOpenStateChange = useCallback(
    (open: boolean) => {
      changeRequestDialogOpenRef.current = open;
      if (
        !open &&
        !changeRequestSubmittingRef.current &&
        !changeRequestPartialRecord &&
        !changeRequestRetryAction
      ) {
        resetChangeRequestDraft();
      }
    },
    [
      changeRequestPartialRecord,
      changeRequestRetryAction,
      resetChangeRequestDraft,
    ],
  );

  useEffect(() => {
    if (
      changeRequestDialogOpenRef.current ||
      changeRequestSubmittingRef.current
    ) {
      return;
    }
    resetChangeRequestDraft();
  }, [resetChangeRequestDraft]);

  const setScreenshotSectionState = useCallback(
    (
      section: DutyOverviewScreenshotSection,
      state: DutyOverviewScreenshotLoadState,
    ) => {
      setScreenshotReadiness((current) =>
        current[section] === state ? current : { ...current, [section]: state },
      );
    },
    [],
  );
  const handleWeatherWidgetLoadStateChange = useCallback(
    (state: DutyOverviewScreenshotLoadState) => {
      setScreenshotSectionState('weatherWidget', state);
    },
    [setScreenshotSectionState],
  );

  const setChangeRequestOverlay = useCallback(
    (key: string, change: ChangeInfo) => {
      const generation = changeRequestOverlayGenerationRef.current + 1;
      changeRequestOverlayGenerationRef.current = generation;
      changeRequestOverlayRef.current.set(key, change);
      changeRequestOverlayVersionRef.current.set(key, generation);
    },
    [],
  );

  const deleteChangeRequestOverlay = useCallback((key: string) => {
    changeRequestOverlayRef.current.delete(key);
    changeRequestOverlayVersionRef.current.delete(key);
  }, []);
  const handleWeatherTrendLoadStateChange = useCallback(
    (state: DutyOverviewScreenshotLoadState) => {
      setScreenshotSectionState('weatherTrend', state);
    },
    [setScreenshotSectionState],
  );
  const handlePersonnelMovementsLoadStateChange = useCallback(
    (state: DutyOverviewScreenshotLoadState) => {
      setScreenshotSectionState('personnelMovements', state);
    },
    [setScreenshotSectionState],
  );

  useEffect(() => {
    setScreenshotReadiness((current) =>
      resetDutyOverviewScreenshotReadinessForDate(
        current,
        weatherScreenshotReadinessRef.current,
      ),
    );
  }, [selectedDateKey]);

  const loadEmergencyDutySchedules = useCallback(
    async ({ silent = false }: { silent?: boolean } = {}) => {
      if (!canReadMonthlySchedule) return;
      const startDate = addDaysToDateKey(selectedDateKey, -5);
      const endDate = addDaysToDateKey(selectedDateKey, 5);
      if (!startDate || !endDate) {
        if (silent) return;
        setEmergencyDutyLoadStatus('error');
        setEmergencyDutyLoadError('应急值班日期范围无效');
        setEmergencyDutyLoadedRange(null);
        setScreenshotSectionState('emergencyDuty', 'error');
        return;
      }

      if (silent && emergencyDutyLoadAbortRef.current) return;
      emergencyDutyLoadAbortRef.current?.abort();
      const controller = new AbortController();
      emergencyDutyLoadAbortRef.current = controller;
      const requestId = emergencyDutyLoadSeqRef.current + 1;
      emergencyDutyLoadSeqRef.current = requestId;
      const requestMutationRevision = emergencyDutyMutationRevisionRef.current;
      if (!silent) {
        setEmergencyDutyLoadStatus('loading');
        setEmergencyDutyLoadError('');
        setScreenshotSectionState('emergencyDuty', 'loading');
      }

      try {
        const response = await getEmergencyDutySchedules(
          startDate,
          endDate,
          controller.signal,
        );
        if (
          requestId !== emergencyDutyLoadSeqRef.current ||
          controller.signal.aborted
        ) {
          return;
        }
        setEmergencyDutyIndex((current) => {
          const next = mergeEmergencyDutySnapshot(
            current,
            response.schedules || [],
            { snapshotRevision: requestMutationRevision },
          );
          emergencyDutyIndexRef.current = next;
          return next;
        });
        setEmergencyDutySnapshotStale(Boolean(response.snapshot?.stale));
        setEmergencyDutyLoadedRange({ startDate, endDate });
        setEmergencyDutyLoadStatus('ready');
        setScreenshotSectionState('emergencyDuty', 'ready');
      } catch (error) {
        if (
          requestId !== emergencyDutyLoadSeqRef.current ||
          controller.signal.aborted
        ) {
          return;
        }
        if (silent) {
          logger.warn('静默刷新应急值班本地快照失败，继续展示现有数据', error);
          return;
        }
        logger.warn('加载应急值班本地快照失败', error);
        setEmergencyDutyLoadStatus('error');
        setEmergencyDutyLoadError('应急值班加载失败，请重试');
        setScreenshotSectionState('emergencyDuty', 'error');
      } finally {
        if (emergencyDutyLoadAbortRef.current === controller) {
          emergencyDutyLoadAbortRef.current = null;
        }
      }
    },
    [canReadMonthlySchedule, selectedDateKey, setScreenshotSectionState],
  );

  const loadEmergencyDutyOptions = useCallback(
    async (force = false) => {
      if (!canReadAssignments) return;
      if (
        !force &&
        (emergencyDutyOptionsStatus === 'loading' ||
          emergencyDutyOptionsStatus === 'ready')
      ) {
        return;
      }

      emergencyDutyOptionsAbortRef.current?.abort();
      const controller = new AbortController();
      emergencyDutyOptionsAbortRef.current = controller;
      const requestId = emergencyDutyOptionsLoadSeqRef.current + 1;
      emergencyDutyOptionsLoadSeqRef.current = requestId;
      setEmergencyDutyOptionsStatus('loading');
      try {
        const response = await getEmergencyDutyOptions(controller.signal);
        if (
          requestId !== emergencyDutyOptionsLoadSeqRef.current ||
          controller.signal.aborted
        ) {
          return;
        }
        setEmergencyDutyOptions(
          (response.options || [])
            .slice()
            .sort((left, right) =>
              left.name.localeCompare(right.name, 'zh-CN'),
            ),
        );
        setEmergencyDutyOptionsStatus('ready');
      } catch (error) {
        if (
          requestId !== emergencyDutyOptionsLoadSeqRef.current ||
          controller.signal.aborted
        ) {
          return;
        }
        logger.warn('加载应急值班在职人员缓存失败', error);
        setEmergencyDutyOptionsStatus('error');
      } finally {
        if (emergencyDutyOptionsAbortRef.current === controller) {
          emergencyDutyOptionsAbortRef.current = null;
        }
      }
    },
    [canReadAssignments, emergencyDutyOptionsStatus],
  );

  const prepareEmergencyDutyDraft = useCallback((date: string) => {
    setEmergencyDutyDate(date);
    const binding = emergencyDutyMutationBindingsRef.current.get(date);
    const record = emergencyDutyIndexRef.current.get(date);
    setEmergencyDutySelectedKeys(
      binding?.draft.personKeys ||
        record?.people.map((person) => person.key) ||
        [],
    );
    setEmergencyDutySearch('');
  }, []);

  const loadSchedules = useCallback(
    async (options: LoadSchedulesOptions = {}): Promise<boolean> => {
      if (!canReadMonthlySchedule || access.isLoading || options.signal?.aborted) return false;
      if (!selectedDate) {
        setScreenshotSectionState('schedules', 'error');
        return false;
      }
      setScreenshotSectionState('schedules', 'loading');
      const requestId = scheduleLoadSeqRef.current + 1;
      scheduleLoadSeqRef.current = requestId;

      const monthMap = new Map<
        string,
        { year: number; month: number; key: string }
      >();
      for (let offset = -5; offset <= 5; offset += 1) {
        const date = new Date(
          selectedDate.getFullYear(),
          selectedDate.getMonth(),
          selectedDate.getDate() + offset,
        );
        const year = date.getFullYear();
        const month = date.getMonth() + 1;
        const key = `${year}-${month}`;
        monthMap.set(key, { year, month, key });
      }
      // Leave options always cover three months, independent of the viewed date.
      for (const dateKey of [
        ...getAdjacentScheduleMonthDateKeys(businessDateKey),
        ...(options.additionalDateKeys || []),
      ]) {
        const match = /^(\d{4})-(\d{2})-\d{2}$/.exec(dateKey);
        if (!match) continue;
        const year = Number(match[1]);
        const month = Number(match[2]);
        if (month < 1 || month > 12) continue;
        const additionalMonthKey = `${year}-${month}`;
        monthMap.set(additionalMonthKey, {
          year,
          month,
          key: additionalMonthKey,
        });
      }

      const monthsForWindow = Array.from(monthMap.values());
      const cachedSchedules = monthsForWindow.flatMap(
        (item) => monthlyScheduleCache.get(item.key)?.schedules || [],
      );
      const now = Date.now();
      const monthsToFetch = monthsForWindow.filter((item) => {
        const cached = monthlyScheduleCache.get(item.key);
        return (
          !cached || now - cached.fetchedAt >= MONTHLY_SCHEDULE_CACHE_TTL_MS
        );
      });

      if (
        cachedSchedules.length > 0 &&
        (!options.preserveExistingOnError || monthsToFetch.length === 0)
      ) {
        setSchedules(cachedSchedules);
        setLoading(false);
      }

      if (monthsToFetch.length === 0) {
        setSchedules(cachedSchedules);
        setLoading(false);
        setScreenshotSectionState('schedules', 'ready');
        return true;
      }

      if (cachedSchedules.length === 0 && !options.preserveExistingOnError) {
        setLoading(true);
      }

      try {
        const monthRequests = monthsToFetch
          .filter(
            (item) =>
              !scheduleMonthForceRefreshGenerationRef.current.has(item.key),
          )
          .map((item) => {
            const generation =
              (scheduleMonthRequestGenerationRef.current.get(item.key) || 0) +
              1;
            scheduleMonthRequestGenerationRef.current.set(item.key, generation);
            return { ...item, generation };
          });
        const results = await Promise.allSettled(
          monthRequests.map((item) =>
            getMonthlySchedulesWithInFlightDeduplication(item.year, item.month),
          ),
        );
        if (
          options.signal?.aborted ||
          activeScheduleReadScopeRef.current !== scheduleReadScope ||
          requestId !== scheduleLoadSeqRef.current
        ) {
          return false;
        }

        let successfulFetchCount = 0;
        results.forEach((result, index) => {
          const monthInfo = monthRequests[index];
          if (result.status === 'rejected') {
            if (!options.silent) {
              logger.warn(
                `加载 ${monthInfo.year}-${String(monthInfo.month).padStart(2, '0')} 值班数据失败`,
                result.reason,
              );
            }
            return;
          }
          if (
            scheduleMonthRequestGenerationRef.current.get(monthInfo.key) !==
              monthInfo.generation ||
            scheduleMonthForceRefreshGenerationRef.current.has(monthInfo.key)
          ) {
            return;
          }
          successfulFetchCount += 1;
          monthlyScheduleCache.set(monthInfo.key, {
            schedules: result.value.schedules || [],
            fetchedAt: Date.now(),
          });
        });

        if (
          options.signal?.aborted ||
          activeScheduleReadScopeRef.current !== scheduleReadScope ||
          requestId !== scheduleLoadSeqRef.current
        ) {
          return false;
        }

        const mergedSchedules = monthsForWindow.flatMap(
          (item) => monthlyScheduleCache.get(item.key)?.schedules || [],
        );
        const hasCompleteScheduleWindow = monthsForWindow.every((item) =>
          monthlyScheduleCache.has(item.key),
        );
        if (!options.preserveExistingOnError || hasCompleteScheduleWindow) {
          setSchedules(mergedSchedules);
        }
        setScreenshotSectionState(
          'schedules',
          hasCompleteScheduleWindow ? 'ready' : 'error',
        );
        if (
          !hasCompleteScheduleWindow &&
          successfulFetchCount === 0 &&
          cachedSchedules.length === 0
        ) {
          if (!options.silent) toast.error('加载排班数据失败，请稍后重试');
        }
        return hasCompleteScheduleWindow;
      } catch (error) {
        if (options.signal?.aborted || activeScheduleReadScopeRef.current !== scheduleReadScope) return false;
        if (!options.silent) logger.error('加载排班数据失败', error);
        if (requestId === scheduleLoadSeqRef.current) {
          setScreenshotSectionState('schedules', 'error');
          if (cachedSchedules.length === 0 && !options.silent) {
            toast.error('加载排班数据失败，请稍后重试');
          }
        }
        return false;
      } finally {
        if (
          !options.signal?.aborted &&
          activeScheduleReadScopeRef.current === scheduleReadScope &&
          requestId === scheduleLoadSeqRef.current
        ) {
          setLoading(false);
        }
      }
    },
    [canReadMonthlySchedule, access.isLoading, businessDateKey, getMonthlySchedulesWithInFlightDeduplication, monthlyScheduleCache, scheduleReadScope, selectedDate, setScreenshotSectionState],
  );

  const loadSchedulesRef = useRef(loadSchedules);
  loadSchedulesRef.current = loadSchedules;

  const invalidateScheduleLoads = useCallback(() => {
    scheduleLoadSeqRef.current += 1;
    for (const [
      monthKey,
      generation,
    ] of scheduleMonthRequestGenerationRef.current.entries()) {
      scheduleMonthRequestGenerationRef.current.set(monthKey, generation + 1);
    }
    monthlyScheduleReadInFlight.clear();
  }, [monthlyScheduleReadInFlight]);

  const revalidateLocalScheduleSnapshot = useCallback(
    async (signal: AbortSignal): Promise<boolean> => {
      const scheduleSnapshotDateKeys = getScheduleSnapshotRevalidationDateKeys(
        schedulesRef.current,
      );
      invalidateScheduleLoads();
      monthlyScheduleCache.clear();
      longWhiteScheduleCache.clear();
      const loaded = await loadSchedulesRef.current({
        additionalDateKeys: scheduleSnapshotDateKeys,
        silent: true,
        preserveExistingOnError: true,
        signal,
      });
      if (signal.aborted || !loaded) return false;
      setLocalSnapshotRefreshToken((token) => token + 1);
      return true;
    },
    [invalidateScheduleLoads, monthlyScheduleCache],
  );

  useEffect(() => {
    if (!canReadMonthlySchedule || isScreenshotMode || access.isLoading) return undefined;

    const snapshotRefreshCoordinator = createScheduleSnapshotRefreshCoordinator(
      {
        readRevision: (signal) => getScheduleSnapshotRevision(signal),
        revalidate: revalidateLocalScheduleSnapshot,
        onError: (error) => {
          logger.warn('检查本地排班快照版本失败，将稍后重试', error);
        },
      },
    );
    const checkScheduleSnapshotRevision = (): Promise<void> => {
      if (document.visibilityState === 'hidden') return Promise.resolve();
      return snapshotRefreshCoordinator.check().then(() => undefined);
    };

    const handleSnapshotVisibilityChange = () => {
      if (document.visibilityState !== 'visible') return;
      void checkScheduleSnapshotRevision();
    };

    void checkScheduleSnapshotRevision();
    const refreshInterval = window.setInterval(() => {
      void checkScheduleSnapshotRevision();
    }, SCHEDULE_SNAPSHOT_REVALIDATE_INTERVAL_MS);
    window.addEventListener('focus', checkScheduleSnapshotRevision);
    document.addEventListener(
      'visibilitychange',
      handleSnapshotVisibilityChange,
    );

    return () => {
      snapshotRefreshCoordinator.stop();
      invalidateScheduleLoads();
      window.clearInterval(refreshInterval);
      window.removeEventListener('focus', checkScheduleSnapshotRevision);
      document.removeEventListener(
        'visibilitychange',
        handleSnapshotVisibilityChange,
      );
    };
  }, [
    canReadMonthlySchedule,
    access.isLoading,
    invalidateScheduleLoads,
    isScreenshotMode,
    revalidateLocalScheduleSnapshot,
  ]);

  const loadSchedulesForDate = useCallback(
    async (
      dateKey: string,
      forceRefresh = false,
    ): Promise<MonthlySchedule[] | null> => {
      if (!canReadMonthlySchedule && !selfServiceOnly) return null;
      const monthKey = getScheduleMonthKey(dateKey);
      if (!monthKey) {
        return null;
      }

      const cached = monthlyScheduleCache.get(monthKey);
      const now = Date.now();
      if (
        !forceRefresh &&
        cached &&
        now - cached.fetchedAt < MONTHLY_SCHEDULE_CACHE_TTL_MS
      ) {
        return cached.schedules;
      }

      const [year, month] = monthKey.split('-').map(Number);
      if (
        !forceRefresh &&
        scheduleMonthForceRefreshGenerationRef.current.has(monthKey)
      ) {
        return cached?.schedules || null;
      }
      const requestGeneration =
        (scheduleMonthRequestGenerationRef.current.get(monthKey) || 0) + 1;
      scheduleMonthRequestGenerationRef.current.set(
        monthKey,
        requestGeneration,
      );
      if (forceRefresh) {
        scheduleMonthForceRefreshGenerationRef.current.set(
          monthKey,
          requestGeneration,
        );
      }
      try {
        const data = await getMonthlySchedulesWithInFlightDeduplication(
          year,
          month,
          forceRefresh,
        );
        if (activeScheduleReadScopeRef.current !== scheduleReadScope) return null;
        const authoritativeSchedules = data.schedules || [];
        if (
          scheduleMonthRequestGenerationRef.current.get(monthKey) !==
            requestGeneration ||
          (forceRefresh
            ? scheduleMonthForceRefreshGenerationRef.current.get(monthKey) !==
              requestGeneration
            : scheduleMonthForceRefreshGenerationRef.current.has(monthKey))
        ) {
          return forceRefresh
            ? null
            : monthlyScheduleCache.get(monthKey)?.schedules || null;
        }
        const cacheSchedules = forceRefresh
          ? replaceScheduleMonthsFromAuthoritative(
              cached?.schedules || [],
              authoritativeSchedules,
              [dateKey],
              pendingScheduleRecordIdsRef.current,
            )
          : authoritativeSchedules;
        monthlyScheduleCache.set(monthKey, {
          schedules: cacheSchedules,
          fetchedAt: Date.now(),
        });
        return authoritativeSchedules;
      } catch (error) {
        logger.error('加载月份排班数据失败', error);
        return null;
      }
    },
    [canReadMonthlySchedule, selfServiceOnly, getMonthlySchedulesWithInFlightDeduplication, monthlyScheduleCache, scheduleReadScope],
  );

  // 加载人员修正所选日期所在月份排班，避免弹窗日期跨月时无候选数据。
  const ensureSchedulesForRepairDate = useCallback(
    async (dateKey: string) => {
      const monthKey = getScheduleMonthKey(dateKey);
      if (!monthKey) {
        return false;
      }

      const requestId = repairScheduleLoadSeqRef.current + 1;
      repairScheduleLoadSeqRef.current = requestId;
      setRepairDateLoading(true);

      try {
        const monthSchedules = await loadSchedulesForDate(dateKey);
        if (requestId !== repairScheduleLoadSeqRef.current) {
          return false;
        }
        if (!monthSchedules) {
          toast.error('加载人员修正日期排班数据失败，请稍后重试');
          return false;
        }
        setSchedules((current) =>
          mergeSchedulesByRecord(current, monthSchedules),
        );
        return true;
      } finally {
        if (requestId === repairScheduleLoadSeqRef.current) {
          setRepairDateLoading(false);
        }
      }
    },
    [loadSchedulesForDate],
  );

  const ensureSchedulesForLeaveDateRange = useCallback(
    async (dateKeys: string[], forceRefresh = false): Promise<boolean> => {
      const uniqueDateKeys = deduplicateScheduleDateKeysByMonth(dateKeys);
      if (uniqueDateKeys.length === 0) {
        return false;
      }

      const scheduleRequests = uniqueDateKeys.map((dateKey) =>
        loadSchedulesForDate(dateKey, forceRefresh),
      );
      const forceRefreshGenerations = forceRefresh
        ? new Map(
            uniqueDateKeys.flatMap((dateKey) => {
              const monthKey = getScheduleMonthKey(dateKey);
              const generation = monthKey
                ? scheduleMonthForceRefreshGenerationRef.current.get(monthKey)
                : undefined;
              return monthKey && generation !== undefined
                ? [[monthKey, generation] as const]
                : [];
            }),
          )
        : null;

      try {
        const monthSchedules = await Promise.all(scheduleRequests);
        if (monthSchedules.some((schedulesForMonth) => !schedulesForMonth)) {
          return false;
        }

        setSchedules((current) =>
          forceRefresh
            ? replaceScheduleMonthsFromAuthoritative(
                current,
                monthSchedules.flat(),
                uniqueDateKeys,
                pendingScheduleRecordIdsRef.current,
              )
            : mergeSchedulesByRecord(current, monthSchedules.flat()),
        );
        return true;
      } finally {
        forceRefreshGenerations?.forEach((generation, monthKey) => {
          if (
            scheduleMonthForceRefreshGenerationRef.current.get(monthKey) ===
            generation
          ) {
            scheduleMonthForceRefreshGenerationRef.current.delete(monthKey);
          }
        });
      }
    },
    [loadSchedulesForDate],
  );

  // 加载封网信息
  const loadSealingInfo = useCallback(
    async (forceRefresh = false): Promise<boolean> => {
      if (!canReadMonthlySchedule) return false;
      forceRefresh = forceRefresh && canRefreshMonthlySchedule;
      const year = selectedDate.getFullYear();
      const requestId = sealingLoadSeqRef.current + 1;
      sealingLoadSeqRef.current = requestId;
      const cached = yearlySealingCache.get(year);
      const now = Date.now();

      if (!forceRefresh && cached) {
        setSealings(cached.sealings);
        if (now - cached.fetchedAt < SEALING_INFO_CACHE_TTL_MS) {
          setScreenshotSectionState('sealings', 'ready');
          return true;
        }
      }

      setScreenshotSectionState('sealings', 'loading');

      try {
        const data = await getYearlySealingInfo(year, forceRefresh);
        const validSealings = data.sealings
          .filter((s) => s.sealingName && s.sealingName.trim() !== '')
          .sort(
            (a, b) =>
              new Date(a.startDate).getTime() - new Date(b.startDate).getTime(),
          );
        if (requestId !== sealingLoadSeqRef.current) {
          return false;
        }
        yearlySealingCache.set(year, {
          sealings: validSealings,
          fetchedAt: Date.now(),
        });
        setSealings(validSealings);
        setScreenshotSectionState('sealings', 'ready');
        return true;
      } catch (error) {
        logger.error('加载封网信息失败', error);
        if (requestId === sealingLoadSeqRef.current) {
          setScreenshotSectionState('sealings', 'error');
        }
        return false;
      }
    },
    [canReadMonthlySchedule, canRefreshMonthlySchedule, selectedDate, setScreenshotSectionState],
  );

  const loadChangeInfo = useCallback(
    async (forceRefresh = false) => {
      if (!canReadChanges) {
        setChanges([]);
        setScreenshotSectionState('changes', 'ready');
        return;
      }
      forceRefresh = forceRefresh && canRefreshChange;
      const controller = beginLatestDutyOverviewRequest(changeLoadAbortRef);
      setScreenshotSectionState('changes', 'loading');
      const year = selectedDate.getFullYear();
      const requestStartedAtOverlayGeneration =
        changeRequestOverlayGenerationRef.current;
      const mergeLocalOverlay = (
        authoritative: ChangeInfo[],
        canConfirmOverlay: boolean,
      ) => {
        const overlaySnapshot = Array.from(
          changeRequestOverlayRef.current.entries(),
        )
          .filter(
            ([, change]) =>
              getChangeInfoScheduleYear(change.startDate) === year,
          )
          .map(([key, change]) => ({
            key,
            change,
            generation: changeRequestOverlayVersionRef.current.get(key) || 0,
          }));
        const resolved = resolveChangeInfoOverlayResponse(
          authoritative,
          overlaySnapshot,
          canConfirmOverlay ? requestStartedAtOverlayGeneration : -1,
        );

        if (canConfirmOverlay) {
          for (const overlayKey of resolved.confirmedOverlayKeys) {
            const snapshot = overlaySnapshot.find(
              (entry) => entry.key === overlayKey,
            );
            if (
              snapshot &&
              changeRequestOverlayVersionRef.current.get(overlayKey) ===
                snapshot.generation
            ) {
              deleteChangeRequestOverlay(overlayKey);
            }
          }
        }
        return resolved.changes;
      };
      const requestId = changeLoadSeqRef.current + 1;
      changeLoadSeqRef.current = requestId;
      const cached = yearlyChangeCache.get(year);
      const now = Date.now();

      if (cached && !forceRefresh) {
        setChanges(mergeLocalOverlay(cached.changes, false));
        if (now - cached.fetchedAt < LOCAL_DATA_CACHE_TTL_MS) {
          setScreenshotSectionState('changes', 'ready');
          if (changeLoadAbortRef.current === controller) {
            changeLoadAbortRef.current = null;
          }
          return;
        }
      }

      try {
        const data = await getYearlyChangeInfo(
          year,
          forceRefresh,
          controller.signal,
        );
        const validChanges = data.changes
          .filter((item) => item.title && item.startDate)
          .sort(
            (a, b) =>
              new Date(a.startDate).getTime() - new Date(b.startDate).getTime(),
          );
        if (requestId !== changeLoadSeqRef.current) {
          return;
        }
        const visibleChanges = mergeLocalOverlay(validChanges, true);
        yearlyChangeCache.set(year, {
          changes: visibleChanges,
          fetchedAt: Date.now(),
        });
        setChanges(visibleChanges);
        setScreenshotSectionState('changes', 'ready');
      } catch (error) {
        if (controller.signal.aborted) return;
        logger.error('加载计划变更信息失败', error);
        if (requestId === changeLoadSeqRef.current) {
          setScreenshotSectionState('changes', 'error');
        }
      } finally {
        if (changeLoadAbortRef.current === controller) {
          changeLoadAbortRef.current = null;
        }
      }
    },
    [canReadChanges, canRefreshChange, deleteChangeRequestOverlay, selectedDate, setScreenshotSectionState],
  );

  const loadPersonProfiles = useCallback(
    async (forceRefresh = false) => {
      if (!canReadPublicProfiles && !canViewPrivateProfile) return;
      const controller = beginLatestDutyOverviewRequest(
        personProfileLoadAbortRef,
      );
      const requestId = personProfileLoadSeqRef.current + 1;
      personProfileLoadSeqRef.current = requestId;
      setScreenshotSectionState('personProfiles', 'loading');
      try {
        await Promise.all([
          canReadPublicProfiles ? getPersonProfiles(forceRefresh && canRefreshPublicProfiles, 'leave', controller.signal)
            .then((data) => {
              if (
                controller.signal.aborted ||
                requestId !== personProfileLoadSeqRef.current
              ) return;
              setPersonProfiles(data.organizations || []);
              setChangeRequestSubmitterOptions(data.changeRequestSubmitters || []);
              setScreenshotSectionState('personProfiles', 'ready');
            })
            .catch((error) => {
              if (controller.signal.aborted) return;
              logger.error('加载人员资料失败', error);
              if (requestId === personProfileLoadSeqRef.current) {
                setPersonProfileDetails([]);
                setScreenshotSectionState('personProfiles', 'error');
              }
            }) : Promise.resolve(null),
          canViewPrivateProfile
            ? getPersonProfileDetails(
                forceRefresh && canRefreshPrivateProfile,
                'leave',
                controller.signal,
              )
                .then((detailData) => {
                  if (
                    !controller.signal.aborted &&
                    requestId === personProfileLoadSeqRef.current
                  ) {
                    setPersonProfileDetails(detailData.organizations || []);
                  }
                })
                .catch((error) => {
                  if (!controller.signal.aborted) {
                    logger.warn('加载人员详细资料失败，继续使用公开资料', error);
                  }
                  if (
                    !controller.signal.aborted &&
                    requestId === personProfileLoadSeqRef.current
                  ) {
                    setPersonProfileDetails([]);
                  }
                })
            : Promise.resolve(null),
        ]);
      } finally {
        if (personProfileLoadAbortRef.current === controller) {
          personProfileLoadAbortRef.current = null;
        }
      }
    },
    [canReadPublicProfiles, canRefreshPublicProfiles, canViewPrivateProfile, canRefreshPrivateProfile, setScreenshotSectionState],
  );

  const loadTravelPersonProfiles = useCallback(async (forceRefresh = false) => {
    if (!canReadPublicProfiles) return;
    forceRefresh = forceRefresh && canRefreshPublicProfiles;
    const requestId = travelProfileLoadSeqRef.current + 1;
    travelProfileLoadSeqRef.current = requestId;
    setTravelProfilesStatus('loading');
    try {
      const data = await getPersonProfiles(forceRefresh, 'travel');
      if (requestId === travelProfileLoadSeqRef.current) {
        setTravelPersonProfiles(data.organizations || []);
        setTravelProfilesStatus('ready');
      }
    } catch (error) {
      logger.error('加载差旅人员列表失败', error);
      if (requestId === travelProfileLoadSeqRef.current) {
        setTravelPersonProfiles([]);
        setTravelProfilesStatus('error');
      }
    }
  }, [canReadPublicProfiles, canRefreshPublicProfiles]);

  useEffect(() => {
    if (!canViewPrivateProfile) {
      setPersonProfileDetails([]);
    }
  }, [canViewPrivateProfile]);

  const personProfileMap = useMemo(() => {
    const profileMap: StaffProfileMap = new Map();
    const detailsByName = new Map(
      personProfileDetails.map((profile) => [
        normalizeStaffProfileKey(profile.supervisorText),
        profile,
      ]),
    );
    personProfiles.forEach((profile) => {
      const detail = canViewPrivateProfile
        ? detailsByName.get(
            normalizeStaffProfileKey(profile.supervisorText || ''),
          )
        : undefined;
      putStaffProfile(profileMap, {
        ...profile,
        id: detail?.recordId || profile.id,
        recordId: detail?.recordId || profile.recordId,
        photoUrl: detail?.photoUrl || null,
        phone: detail?.phone || null,
        feishuChatUrl: detail?.feishuChatUrl || null,
      });
    });
    return profileMap;
  }, [canViewPrivateProfile, personProfileDetails, personProfiles]);

  const travelStaffOptions = useMemo(() => {
    const names = travelPersonProfiles
      .map((profile) => profile.supervisorText || profile.code || '')
      .map((name) => name.trim())
      .filter(Boolean);
    return Array.from(new Set(names)).sort((a, b) =>
      a.localeCompare(b, 'zh-CN'),
    );
  }, [travelPersonProfiles]);

  const filteredTravelStaffOptions = useMemo(() => {
    return travelStaffOptions
      .filter((name) => isFuzzyStaffNameMatch(name, travelStaffSearch))
      .slice(0, 30);
  }, [travelStaffOptions, travelStaffSearch]);

  const filteredPersonnelMovementStaffOptions = useMemo(() => {
    return travelStaffOptions
      .filter((name) =>
        isFuzzyStaffNameMatch(name, personnelMovementStaffSearch),
      )
      .slice(0, 30);
  }, [personnelMovementStaffSearch, travelStaffOptions]);

  const leaveStaffOptions = useMemo(() => {
    const names = personProfiles
      .filter((profile) => canSelectWorkforcePerson(access, profile.buildingsSpecialties))
      .map((profile) => profile.supervisorText || profile.code || '')
      .map((name) => name.trim())
      .filter(Boolean);
    return Array.from(new Set(names)).sort((a, b) =>
      a.localeCompare(b, 'zh-CN'),
    );
  }, [personProfiles, access.accountId, access.displayName]);

  const selectedLeaveStaffProfile = useMemo(
    () => getStaffProfile(personProfileMap, leaveStaffName),
    [leaveStaffName, personProfileMap],
  );

  const leaveScheduleMonthDateKeys = useMemo(() => {
    return getLeaveScheduleCoverageDateKeys(
      businessDateKey,
      leaveStartAt,
      leaveEndAt,
    );
  }, [businessDateKey, leaveEndAt, leaveStartAt]);
  const leaveScheduleCoverageKey = leaveScheduleMonthDateKeys.join('|');
  const isLeaveScheduleCoverageReady =
    Boolean(leaveScheduleCoverageKey) &&
    leaveScheduleCoverageStatus === 'ready' &&
    leaveScheduleCoverageReadyKey === leaveScheduleCoverageKey;

  const handleRetryLeaveScheduleCoverage = useCallback(async () => {
    if (!leaveScheduleCoverageKey || leaveRequestDraftLocked) {
      return;
    }

    const requestId = leaveScheduleCoverageLoadSeqRef.current + 1;
    leaveScheduleCoverageLoadSeqRef.current = requestId;
    setLeaveScheduleCoverageStatus('loading');
    setLeaveScheduleCoverageReadyKey(null);
    const loaded = await ensureSchedulesForLeaveDateRange(
      leaveScheduleCoverageKey.split('|'),
      resolveLeaveScheduleForceRefresh(true, canRefreshMonthlySchedule || selfServiceOnly),
    );
    if (requestId !== leaveScheduleCoverageLoadSeqRef.current) {
      return;
    }

    if (!loaded) {
      setLeaveScheduleCoverageStatus('error');
      toast.error('重新加载排班失败，当前填写内容已保留');
      return;
    }

    setLeaveScheduleCoverageStatus('ready');
    setLeaveScheduleCoverageReadyKey(leaveScheduleCoverageKey);
    setLeaveAuthoritativeImpact(null);
  }, [
    canRefreshMonthlySchedule,
    selfServiceOnly,
    ensureSchedulesForLeaveDateRange,
    leaveRequestDraftLocked,
    leaveScheduleCoverageKey,
  ]);

  const leaveRequestImpactSchedules = useMemo(
    () =>
      schedules.map((schedule) => ({
        recordId: schedule.recordId,
        scheduleDate: schedule.scheduleDate,
        building: schedule.building,
        buildingText: schedule.buildingText,
        team: schedule.team,
        teamText: schedule.teamText,
        shift: schedule.shift,
        shiftText: schedule.shiftText,
        dutyStaffActual: schedule.dutyStaffActual,
      })),
    [schedules],
  );
  const leaveTimeCandidates = useMemo(
    () =>
      createLeaveRequestTimeCandidates(leaveRequestImpactSchedules, {
        leaveStaffName,
      }),
    [leaveRequestImpactSchedules, leaveStaffName, workCalendarRevision],
  );
  const leaveEndTimeCandidates = useMemo(
    () =>
      createLeaveRequestTimeCandidates(leaveRequestImpactSchedules, {
        leaveStaffName,
        selectedStartAt: leaveStartAt,
      }),
    [
      leaveRequestImpactSchedules,
      leaveStaffName,
      leaveStartAt,
      workCalendarRevision,
    ],
  );
  const handleLeaveStartAtChange = useCallback(
    (nextStartAt: string) => {
      const nextEndCandidates = createLeaveRequestTimeCandidates(
        leaveRequestImpactSchedules,
        {
          leaveStaffName,
          selectedStartAt: nextStartAt,
        },
      );
      setLeaveStartAt(nextStartAt);
      setLeaveEndAt(
        selectDefaultLeaveEndAt(
          leaveTimeCandidates.shiftRanges,
          nextStartAt,
          nextEndCandidates.endOptions,
        ),
      );
    },
    [
      leaveRequestImpactSchedules,
      leaveStaffName,
      leaveTimeCandidates.shiftRanges,
      workCalendarRevision,
    ],
  );
  const defaultLeaveTimeRange = useMemo(() => {
    return selectDefaultLeaveTimeRange(
      leaveTimeCandidates.fullShiftRanges,
      businessDateKey,
    );
  }, [businessDateKey, leaveTimeCandidates.fullShiftRanges]);

  const calculatedLeaveImpact = useMemo(
    () =>
      calculateLeaveRequestImpact(leaveRequestImpactSchedules, {
        leaveStaffName,
        startAt: leaveStartAt,
        endAt: leaveEndAt,
      }),
    [
      leaveEndAt,
      leaveRequestImpactSchedules,
      leaveStaffName,
      leaveStartAt,
      workCalendarRevision,
    ],
  );
  const leaveImpact = leaveAuthoritativeImpact ?? calculatedLeaveImpact;

  useEffect(() => {
    if (leaveRequestDraftLocked) {
      return;
    }
    setLeaveAuthoritativeImpact(null);
  }, [leaveEndAt, leaveRequestDraftLocked, leaveStaffName, leaveStartAt]);

  const nextLeaveTimeRangeStaffKey = selectedLeaveStaffProfile
    ? selectedLeaveStaffProfile.recordId || selectedLeaveStaffProfile.id
    : '';
  const leaveTimeRangeStaffChanged = Boolean(
    nextLeaveTimeRangeStaffKey &&
    leaveTimeRangeStaffKeyRef.current !== nextLeaveTimeRangeStaffKey,
  );

  useEffect(() => {
    if (
      !leaveRequestDialogOpen ||
      leaveRequestDraftLocked ||
      !selectedLeaveStaffProfile ||
      !isLeaveScheduleCoverageReady ||
      !nextLeaveTimeRangeStaffKey
    ) {
      return;
    }

    const staffChanged = leaveTimeRangeStaffChanged;
    leaveTimeRangeStaffKeyRef.current = nextLeaveTimeRangeStaffKey;
    if (
      !(
        staffChanged || !leaveTimeCandidates.startOptions.includes(leaveStartAt)
      )
    ) {
      return;
    }

    setLeaveStartAt(defaultLeaveTimeRange?.startAt || '');
    setLeaveEndAt(defaultLeaveTimeRange?.endAt || '');
  }, [
    defaultLeaveTimeRange,
    isLeaveScheduleCoverageReady,
    leaveRequestDialogOpen,
    leaveRequestDraftLocked,
    leaveStartAt,
    leaveTimeRangeStaffChanged,
    leaveTimeCandidates.startOptions,
    nextLeaveTimeRangeStaffKey,
    selectedLeaveStaffProfile,
  ]);

  useEffect(() => {
    if (
      !leaveRequestDialogOpen ||
      leaveRequestDraftLocked ||
      !selectedLeaveStaffProfile ||
      !isLeaveScheduleCoverageReady ||
      leaveTimeRangeStaffChanged ||
      !leaveStartAt ||
      leaveEndTimeCandidates.endOptions.includes(leaveEndAt)
    ) {
      return;
    }

    setLeaveEndAt(
      selectDefaultLeaveEndAt(
        leaveTimeCandidates.shiftRanges,
        leaveStartAt,
        leaveEndTimeCandidates.endOptions,
      ),
    );
  }, [
    isLeaveScheduleCoverageReady,
    leaveEndAt,
    leaveEndTimeCandidates.endOptions,
    leaveRequestDialogOpen,
    leaveRequestDraftLocked,
    leaveStartAt,
    leaveTimeRangeStaffChanged,
    leaveTimeCandidates.shiftRanges,
    selectedLeaveStaffProfile,
  ]);

  const repairStaffOptions = useMemo(() => {
    const names = personProfiles
      .map((profile) => profile.supervisorText || profile.code || '')
      .map((name) => name.trim())
      .filter(Boolean);
    return Array.from(new Set(names)).sort((a, b) =>
      a.localeCompare(b, 'zh-CN'),
    );
  }, [personProfiles]);

  const filteredRepairStaffOptions = useMemo(() => {
    const targetKey = normalizeStaffProfileKey(repairTargetName);
    return repairStaffOptions
      .filter((name) => normalizeStaffProfileKey(name) !== targetKey)
      .filter((name) => isFuzzyStaffNameMatch(name, repairReplacementSearch))
      .slice(0, 30);
  }, [repairReplacementSearch, repairStaffOptions, repairTargetName]);

  const filteredEmergencyDutyOptions = useMemo(() => {
    const query =
      normalizeStaffProfileKey(emergencyDutySearch).toLocaleLowerCase('zh-CN');
    return emergencyDutyOptions.filter((person) => {
      if (!query) return true;
      return `${person.name} ${person.role}`
        .toLocaleLowerCase('zh-CN')
        .includes(query);
    });
  }, [emergencyDutyOptions, emergencyDutySearch]);

  const emergencyDutySelectedKeySet = useMemo(
    () => new Set(emergencyDutySelectedKeys),
    [emergencyDutySelectedKeys],
  );

  const emergencyDutyDraftView = getEmergencyDutyViewByDate(
    emergencyDutyIndex,
    emergencyDutyDate,
  );
  const emergencyDutyDraftSyncState = emergencyDutyDraftView.syncState;
  const emergencyDutyRecoveryBinding =
    emergencyDutyDraftSyncState === 'unknown-result'
      ? emergencyDutyMutationBindingsRef.current.get(emergencyDutyDate) || null
      : null;
  const emergencyDutySubmissionIssue = getEmergencyDutySubmissionIssue({
    date: emergencyDutyDate,
    loadedRange: emergencyDutyLoadedRange,
    loadState: emergencyDutyLoadStatus,
    syncState: emergencyDutyDraftSyncState,
    selectedCount:
      emergencyDutyRecoveryBinding?.draft.personKeys.length ||
      emergencyDutySelectedKeys.length,
    optionsReady: emergencyDutyOptionsStatus === 'ready',
    isRecovery: Boolean(emergencyDutyRecoveryBinding),
  });

  const travelStaffGroups = useMemo(
    () => buildTravelStaffGroups(travelDetails),
    [travelDetails],
  );

  const loadTravelDetails = useCallback(async (forceRefresh = false) => {
    if (!canReadMonthlySchedule) return;
    forceRefresh = forceRefresh && canRefreshMonthlySchedule;
    setTravelDetailsLoading(true);
    try {
      const startDate = getTodayDateKey();
      const endDate = getMonthEndDateKey(startDate);
      const response = await getTravelStaffDetails({
        startDate,
        endDate,
        refresh: forceRefresh,
      });
      const details = response.details || [];
      const groups = buildTravelStaffGroups(details);
      setTravelDetails(details);
      setExpandedTravelStaffNames((current) => {
        const groupIds = new Set(groups.map((group) => group.id));
        const next: Record<string, boolean> = {};
        Object.entries(current).forEach(([groupId, expanded]) => {
          if (expanded && groupIds.has(groupId)) {
            next[groupId] = true;
          }
        });
        if (Object.keys(next).length > 0) {
          return next;
        }
        return groups[0] ? { [groups[0].id]: true } : {};
      });
      setExpandedTravelDetailId((current) =>
        current && details.some((detail) => detail.id === current)
          ? current
          : groups[0]?.details[0]?.id || null,
      );
      setSelectedTravelRecordIds((current) => {
        const detailIds = new Set(details.map((detail) => detail.id));
        const next: Record<string, string[]> = {};
        Object.entries(current).forEach(([detailId, recordIds]) => {
          if (detailIds.has(detailId)) {
            next[detailId] = recordIds.filter((recordId) =>
              details.some(
                (detail) =>
                  detail.id === detailId &&
                  detail.records.some((record) => record.recordId === recordId),
              ),
            );
          }
        });
        return next;
      });
    } catch (error) {
      logger.error('加载差旅人员详情失败', error);
      setTravelDetails([]);
      setExpandedTravelStaffNames({});
      setExpandedTravelDetailId(null);
      setSelectedTravelRecordIds({});
    } finally {
      setTravelDetailsLoading(false);
    }
  }, [canReadMonthlySchedule, canRefreshMonthlySchedule]);

  const getSealingsByDate = useCallback(
    (dateStr: string): SealingInfo[] =>
      sealings.filter((s) => isSealingActiveOnDate(s, dateStr)),
    [sealings],
  );

  const getSealingInfoByDate = useCallback(
    (dateStr: string): SealingInfo | null => {
      const sealing = getSealingsByDate(dateStr)[0];
      return sealing || null;
    },
    [getSealingsByDate],
  );

  const sealingDetailModel = useMemo(
    () =>
      buildNetworkFreezeDetailModel(
        sealings,
        sealingDetailDate ?? selectedDateKey,
      ),
    [sealingDetailDate, sealings, selectedDateKey],
  );

  const handleOpenSealingDetails = useCallback(
    (dateStr: string, trigger: HTMLElement) => {
      sealingDetailTriggerRef.current = trigger;
      setSealingDetailDate(dateStr);
    },
    [],
  );

  const staffConsecutiveConflictIndex = useMemo(() => {
    type DutyShiftEntry = {
      date: string;
      shift: DutyConflictShift;
      staffName: string;
      building: string;
      buildingLabel: string;
    };

    const entriesByDateShiftStaff = new Map<string, DutyShiftEntry[]>();
    const conflictsByDate = new Map<string, DutyStaffConsecutiveConflict[]>();
    const conflictKeys = new Set<string>();

    const pushEntry = (entry: DutyShiftEntry) => {
      const key = `${entry.date}|${entry.shift}|${entry.staffName}`;
      if (!entriesByDateShiftStaff.has(key)) {
        entriesByDateShiftStaff.set(key, []);
      }
      entriesByDateShiftStaff.get(key)!.push(entry);
    };

    const pushConflict = (
      date: string,
      previous: DutyShiftEntry,
      current: DutyShiftEntry,
      reason: string,
    ) => {
      const key = [
        date,
        previous.staffName,
        previous.date,
        previous.shift,
        previous.building,
        current.date,
        current.shift,
        current.building,
      ].join('|');
      if (conflictKeys.has(key)) {
        return;
      }
      conflictKeys.add(key);

      const conflict: DutyStaffConsecutiveConflict = {
        id: key,
        date,
        staffName: current.staffName,
        previousDate: previous.date,
        previousShift: previous.shift,
        previousShiftLabel:
          VACANCY_SHIFT_LABELS[previous.shift] || previous.shift,
        previousBuilding: previous.building,
        previousBuildingLabel: previous.buildingLabel,
        currentDate: current.date,
        currentShift: current.shift,
        currentShiftLabel: VACANCY_SHIFT_LABELS[current.shift] || current.shift,
        currentBuilding: current.building,
        currentBuildingLabel: current.buildingLabel,
        reason,
      };

      if (!conflictsByDate.has(date)) {
        conflictsByDate.set(date, []);
      }
      conflictsByDate.get(date)!.push(conflict);
    };

    schedules.forEach((schedule) => {
      if (!schedule.scheduleDate || !schedule.building) {
        return;
      }

      const shift = resolveDutyConflictShift(schedule);
      if (!shift) {
        return;
      }

      const staffNames = orderStaffNames(
        getDutyConflictStaffNames(schedule),
        personProfileMap,
        true,
      );

      staffNames.forEach((staffName) => {
        pushEntry({
          date: schedule.scheduleDate!,
          shift,
          staffName,
          building: schedule.building,
          buildingLabel: BUILDING_MAP[schedule.building] || schedule.building,
        });
      });
    });

    entriesByDateShiftStaff.forEach((whiteEntries, key) => {
      const [date, shift, staffName] = key.split('|');
      if (shift !== 'white') {
        return;
      }

      const sameDayNightEntries =
        entriesByDateShiftStaff.get(`${date}|night|${staffName}`) || [];
      whiteEntries.forEach((whiteEntry) => {
        sameDayNightEntries.forEach((nightEntry) => {
          pushConflict(date, whiteEntry, nightEntry, '白班后接夜班');
        });
      });

      const previousDate = addDaysToDateKey(date, -1);
      if (!previousDate) {
        return;
      }
      const previousNightEntries =
        entriesByDateShiftStaff.get(`${previousDate}|night|${staffName}`) || [];
      previousNightEntries.forEach((nightEntry) => {
        whiteEntries.forEach((whiteEntry) => {
          pushConflict(date, nightEntry, whiteEntry, '夜班后接白班');
        });
      });
    });

    conflictsByDate.forEach((items) => {
      items.sort(
        (a, b) =>
          a.staffName.localeCompare(b.staffName, 'zh-CN') ||
          a.previousBuildingLabel.localeCompare(
            b.previousBuildingLabel,
            'zh-CN',
          ) ||
          a.currentBuildingLabel.localeCompare(b.currentBuildingLabel, 'zh-CN'),
      );
    });

    return conflictsByDate;
  }, [personProfileMap, schedules]);

  const getStaffConsecutiveConflictsByDate = useCallback(
    (dateStr: string) => staffConsecutiveConflictIndex.get(dateStr) || [],
    [staffConsecutiveConflictIndex],
  );

  const getCalendarChangeInfoByDate = useMemo(
    () => createCalendarDaySummaryCache((dateStr: string) => {
      const dayChanges = changes.filter((change) =>
        isChangeActiveOnDate(change, dateStr),
      );
      const daySealings = getSealingsByDate(dateStr);
      const staffConflicts = getStaffConsecutiveConflictsByDate(dateStr);
      const primarySealing = daySealings[0];
      const baseDetail = dayChanges.map((change) => {
        const windows = getChangeWindowsOnDate(change, dateStr, 'display');
        const conflictWindows = getChangeWindowsOnDate(
          change,
          dateStr,
          'conflict',
        );
        const conflictSealings =
          primarySealing &&
          conflictWindows.some((window) =>
            doDateTimeRangesOverlap(
              window.start,
              window.end,
              new Date(primarySealing.startDate),
              new Date(primarySealing.endDate),
            ),
          )
            ? [primarySealing]
            : [];
        const reminderSealings =
          conflictSealings.length === 0 ? daySealings : [];

        return {
          change,
          conflictSealings,
          reminderSealings,
          windows,
          overlapChanges: [] as ChangeInfo[],
        };
      });
      const detail = baseDetail
        .map((item, index) => {
          const overlapChanges = isMediumRiskOrAboveChange(item.change)
            ? baseDetail
                .filter(
                  (candidate, candidateIndex) =>
                    candidateIndex !== index &&
                    isMediumRiskOrAboveChange(candidate.change) &&
                    doChangeWindowsOverlap(item.windows, candidate.windows),
                )
                .map((candidate) => candidate.change)
            : [];

          const detailItem = { ...item, overlapChanges };
          return { ...detailItem, followUp: projectCalendarChangeFollowUp(dateStr, detailItem, exceptionFollowUpsByKey) };
        })
        .sort((a, b) => {
          const conflictCompare =
            Number(b.followUp.hasConflict) - Number(a.followUp.hasConflict);
          if (conflictCompare !== 0) return conflictCompare;
          const aHasReminder =
            a.reminderSealings.length > 0 || a.overlapChanges.length > 0;
          const bHasReminder =
            b.reminderSealings.length > 0 || b.overlapChanges.length > 0;
          const reminderCompare = Number(bHasReminder) - Number(aHasReminder);
          if (reminderCompare !== 0) return reminderCompare;
          const keyCompare = Number(b.change.isKey) - Number(a.change.isKey);
          if (keyCompare !== 0) return keyCompare;
          return (
            new Date(a.change.startDate).getTime() -
            new Date(b.change.startDate).getTime()
          );
        });

      return {
        all: dayChanges,
        detail,
        staffConflicts,
        conflictCount: detail.filter((item) => item.followUp.hasConflict)
          .length,
        followedUpCount: detail.filter((item) => item.followUp.status === 'followed-up').length,
        riskCount: staffConflicts.length,
        reminderCount: detail.filter(
          (item) =>
            item.followUp.hasReminder,
        ).length,
        keyCount: dayChanges.filter((change) => change.isKey).length,
      };
    }),
    [changes, getSealingsByDate, getStaffConsecutiveConflictsByDate, exceptionFollowUpsByKey],
  );

  useEffect(() => {
    if (!canReadMonthlySchedule && !selfServiceOnly) return;
    let active = true;
    void getChinaWorkCalendar()
      .then((response) => {
        if (active && installChinaWorkCalendarSnapshot(response.snapshot)) {
          setWorkCalendarRevision((current) => current + 1);
        }
      })
      .catch((error) => {
        logger.warn('加载法定工作日历快照失败，继续使用内置数据', error);
      });
    return () => {
      active = false;
    };
  }, [canReadMonthlySchedule, selfServiceOnly]);

  useEffect(() => {
    if (access.isLoading) return;
    const controller = new AbortController();
    void loadSchedules({ signal: controller.signal });
    loadSealingInfo();
    loadChangeInfo();
    return () => { controller.abort(); changeLoadAbortRef.current?.abort(); };
  }, [access.isLoading, loadSchedules, loadSealingInfo, loadChangeInfo]);

  useEffect(() => {
    void loadEmergencyDutySchedules();
    return () => emergencyDutyLoadAbortRef.current?.abort();
  }, [loadEmergencyDutySchedules]);

  useEffect(() => {
    const refreshEmergencyDutySchedules = () => {
      if (document.visibilityState === 'hidden') return;
      void loadEmergencyDutySchedules({ silent: true });
    };

    const refreshInterval = window.setInterval(
      refreshEmergencyDutySchedules,
      EMERGENCY_DUTY_REVALIDATE_INTERVAL_MS,
    );
    window.addEventListener('focus', refreshEmergencyDutySchedules);
    document.addEventListener(
      'visibilitychange',
      refreshEmergencyDutySchedules,
    );

    return () => {
      window.clearInterval(refreshInterval);
      window.removeEventListener('focus', refreshEmergencyDutySchedules);
      document.removeEventListener(
        'visibilitychange',
        refreshEmergencyDutySchedules,
      );
    };
  }, [loadEmergencyDutySchedules]);

  useEffect(() => () => emergencyDutyOptionsAbortRef.current?.abort(), []);

  useEffect(() => {
    loadPersonProfiles();
    return () => personProfileLoadAbortRef.current?.abort();
  }, [loadPersonProfiles]);

  useEffect(() => {
    const refreshSealingInfo = () => {
      if (document.visibilityState === 'hidden') {
        return;
      }
      void loadSealingInfo();
    };

    const sealingRefreshInterval = window.setInterval(
      refreshSealingInfo,
      SEALING_INFO_REVALIDATE_INTERVAL_MS,
    );
    window.addEventListener('focus', refreshSealingInfo);
    document.addEventListener('visibilitychange', refreshSealingInfo);

    return () => {
      window.clearInterval(sealingRefreshInterval);
      window.removeEventListener('focus', refreshSealingInfo);
      document.removeEventListener('visibilitychange', refreshSealingInfo);
    };
  }, [loadSealingInfo]);

  useEffect(() => {
    document.body.classList.toggle('duty-screenshot-capture', isScreenshotMode);
    return () => document.body.classList.remove('duty-screenshot-capture');
  }, [isScreenshotMode]);

  const scheduleIndex = useMemo(() => {
    const rawByDateBuilding = new Map<
      string,
      { shiftMap: Map<string, string[]> }
    >();

    schedules.forEach((s) => {
      const key = `${s.scheduleDate}|${s.building}`;
      if (!rawByDateBuilding.has(key)) {
        rawByDateBuilding.set(key, {
          shiftMap: new Map<string, string[]>(),
        });
      }

      const raw = rawByDateBuilding.get(key)!;
      const shift = resolveScheduleShift(s);
      if (!shift) {
        return;
      }
      const dutyStaff =
        s.dutyStaffActual && s.dutyStaffActual.length > 0
          ? s.dutyStaffActual
          : s.personText
            ? [s.personText]
            : [];

      if (!raw.shiftMap.has(shift)) {
        raw.shiftMap.set(shift, []);
      }
      raw.shiftMap.get(shift)!.push(...dutyStaff);
    });

    const byDateBuilding = new Map<string, DailySchedule>();
    rawByDateBuilding.forEach((raw, key) => {
      const shiftInfo: ShiftInfo[] = Array.from(raw.shiftMap.entries()).map(
        ([shift, persons]) => ({
          shift: shift as 'white' | 'night' | 'long_white',
          person:
            orderStaffNames(
              persons.flatMap((person) => splitStaffDisplayNames(person)),
              personProfileMap,
              true,
            ).join(', ') || undefined,
        }),
      );

      byDateBuilding.set(key, {
        shiftInfo,
      });
    });
    return { byDateBuilding };
  }, [schedules, personProfileMap]);

  const getEmergencyDutyByDate = useCallback(
    (date: string): EmergencyDutyDayView => ({
      ...getEmergencyDutyViewByDate(emergencyDutyIndex, date),
      loadState: emergencyDutyLoadStatus,
      stale: emergencyDutySnapshotStale,
    }),
    [emergencyDutyIndex, emergencyDutyLoadStatus, emergencyDutySnapshotStale],
  );

  const getScheduleByDateAndBuilding = useCallback(
    (date: string, building: string): DailySchedule =>
      scheduleIndex.byDateBuilding.get(`${date}|${building}`) || {
        shiftInfo: [],
      },
    [scheduleIndex],
  );

  const getWhiteShiftInfo = (shiftInfo: ShiftInfo[]): ShiftInfo | undefined => {
    return shiftInfo.find((s) => s.shift === 'white');
  };

  const getNightShiftInfo = (shiftInfo: ShiftInfo[]): ShiftInfo | undefined => {
    return shiftInfo.find((s) => s.shift === 'night');
  };

  const repairDateKey = /^\d{4}-\d{2}-\d{2}$/.test(repairDate)
    ? repairDate
    : selectedDateKey;

  const staffAdjustmentCandidates = useMemo<
    DutyStaffAdjustmentCandidate[]
  >(() => {
    const allowedBuildings = new Set(VACANCY_BUILDING_ORDER);
    const shiftRank: Record<string, number> = {
      white: 0,
      long_white: 1,
      night: 2,
    };
    const buildingRank = new Map(
      VACANCY_BUILDING_ORDER.map((building, index) => [building, index]),
    );
    const groups = new Map<
      string,
      {
        recordId: string;
        scheduleDate: string;
        building: string;
        shift: string;
        names: Set<string>;
      }
    >();

    schedules.forEach((schedule) => {
      if (
        schedule.scheduleDate !== repairDateKey ||
        !allowedBuildings.has(schedule.building)
      ) {
        return;
      }
      const shift = resolveScheduleShift(schedule);
      if (!shift || !VACANCY_SHIFT_LABELS[shift]) {
        return;
      }

      const names = (
        schedule.dutyStaffActual && schedule.dutyStaffActual.length > 0
          ? schedule.dutyStaffActual
          : schedule.personText
            ? [schedule.personText]
            : []
      ).flatMap((name) => splitStaffDisplayNames(name));
      if (names.length === 0) {
        return;
      }

      const key = `${schedule.scheduleDate}|${schedule.building}|${shift}`;
      if (!groups.has(key)) {
        groups.set(key, {
          recordId: schedule.recordId || schedule.id,
          scheduleDate: schedule.scheduleDate || repairDateKey,
          building: schedule.building,
          shift,
          names: new Set<string>(),
        });
      }
      const group = groups.get(key)!;
      names.forEach((name) => group.names.add(name));
    });

    return Array.from(groups.entries())
      .map(([key, group]) => {
        const staffNames = orderStaffNames(
          Array.from(group.names),
          personProfileMap,
          true,
        );
        if (!group.recordId || staffNames.length === 0) {
          return null;
        }
        return {
          key,
          recordId: group.recordId,
          scheduleDate: group.scheduleDate,
          building: group.building,
          buildingLabel: BUILDING_MAP[group.building] || group.building,
          shift: group.shift,
          shiftLabel: VACANCY_SHIFT_LABELS[group.shift] || group.shift,
          staffNames,
        };
      })
      .filter((candidate): candidate is DutyStaffAdjustmentCandidate =>
        Boolean(candidate),
      )
      .sort((a, b) => {
        const buildingCompare =
          (buildingRank.get(a.building) ?? 99) -
          (buildingRank.get(b.building) ?? 99);
        if (buildingCompare !== 0) {
          return buildingCompare;
        }
        return (shiftRank[a.shift] ?? 99) - (shiftRank[b.shift] ?? 99);
      });
  }, [personProfileMap, repairDateKey, schedules]);

  const vacancyCandidates = useMemo<VacancySubstituteCandidate[]>(
    () =>
      staffAdjustmentCandidates.filter(
        (candidate) => candidate.staffNames.length === 1,
      ),
    [staffAdjustmentCandidates],
  );

  const selectedRepairCandidate = useMemo(
    () =>
      staffAdjustmentCandidates.find(
        (candidate) =>
          candidate.building === repairBuilding &&
          candidate.shift === repairShift,
      ) || null,
    [repairBuilding, repairShift, staffAdjustmentCandidates],
  );

  useEffect(() => {
    setVacancyInputs((current) => {
      const validKeys = new Set(
        vacancyCandidates.map((candidate) => candidate.key),
      );
      const nextEntries = Object.entries(current).filter(([key]) =>
        validKeys.has(key),
      );
      return nextEntries.length === Object.keys(current).length
        ? current
        : Object.fromEntries(nextEntries);
    });
  }, [vacancyCandidates]);

  useEffect(() => {
    setRepairTargetName('');
    setRepairReplacementName('');
    setRepairReplacementSearch('');
    setRepairReplacementPickerOpen(false);
  }, [repairBuilding, repairDateKey, repairShift]);

  useEffect(() => {
    if (!vacancyDialogOpen) {
      setRepairDate(selectedDateKey);
      return;
    }
    if (staffAdjustmentMode === 'repair') {
      void ensureSchedulesForRepairDate(repairDateKey);
    }
  }, [
    ensureSchedulesForRepairDate,
    repairDateKey,
    selectedDateKey,
    staffAdjustmentMode,
    vacancyDialogOpen,
  ]);

  useEffect(() => {
    if (!leaveRequestDialogOpen) {
      leaveScheduleCoverageLoadSeqRef.current += 1;
      leaveScheduleForceRefreshPendingRef.current = false;
      setLeaveScheduleCoverageStatus('idle');
      setLeaveScheduleCoverageReadyKey(null);
      return;
    }

    if (!selectedLeaveStaffProfile) {
      leaveScheduleCoverageLoadSeqRef.current += 1;
      setLeaveScheduleCoverageStatus('idle');
      setLeaveScheduleCoverageReadyKey(null);
      return;
    }

    if (!leaveScheduleCoverageKey) {
      setLeaveScheduleCoverageStatus('idle');
      setLeaveScheduleCoverageReadyKey(null);
      return;
    }

    const monthDateKeys = leaveScheduleCoverageKey.split('|');
    const forceRefresh = resolveLeaveScheduleForceRefresh(
      leaveScheduleForceRefreshPendingRef.current,
      canRefreshMonthlySchedule || selfServiceOnly,
    );
    leaveScheduleForceRefreshPendingRef.current = false;
    let active = true;
    const requestId = leaveScheduleCoverageLoadSeqRef.current + 1;
    leaveScheduleCoverageLoadSeqRef.current = requestId;
    setLeaveScheduleCoverageStatus('loading');
    setLeaveScheduleCoverageReadyKey(null);
    void ensureSchedulesForLeaveDateRange(monthDateKeys, forceRefresh).then(
      (loaded) => {
        if (!active || requestId !== leaveScheduleCoverageLoadSeqRef.current) {
          return;
        }
        setLeaveScheduleCoverageStatus(loaded ? 'ready' : 'error');
        setLeaveScheduleCoverageReadyKey(
          loaded ? leaveScheduleCoverageKey : null,
        );
      },
    );

    return () => {
      active = false;
    };
  }, [
    canRefreshMonthlySchedule,
    selfServiceOnly,
    ensureSchedulesForLeaveDateRange,
    leaveScheduleCoverageKey,
    leaveRequestDialogOpen,
    selectedLeaveStaffProfile,
  ]);

  useEffect(() => {
    if (
      !vacancyDialogOpen ||
      staffAdjustmentMode !== 'emergency' ||
      emergencyDutyOptionsStatus !== 'idle'
    ) {
      return;
    }
    void loadEmergencyDutyOptions();
  }, [
    emergencyDutyOptionsStatus,
    loadEmergencyDutyOptions,
    staffAdjustmentMode,
    vacancyDialogOpen,
  ]);

  useEffect(() => {
    if (!vacancyDialogOpen || staffAdjustmentMode !== 'travel') {
      return;
    }

    setTravelStartDate((current) => current || selectedDateKey);
    setTravelEndDate((current) => current || selectedDateKey);
    void loadTravelDetails();
  }, [
    loadTravelDetails,
    selectedDateKey,
    staffAdjustmentMode,
    vacancyDialogOpen,
  ]);

  useEffect(() => {
    if (!personnelMovementDialogOpen) {
      return;
    }

    setPersonnelMovementDate((current) => current || selectedDateKey);
  }, [personnelMovementDialogOpen, selectedDateKey]);

  useEffect(() => {
    const profilePickerOpen =
      (vacancyDialogOpen && staffAdjustmentMode === 'travel') ||
      personnelMovementDialogOpen;
    if (!profilePickerOpen || travelProfilesStatus !== 'idle') {
      return;
    }
    void loadTravelPersonProfiles(false);
  }, [
    loadTravelPersonProfiles,
    personnelMovementDialogOpen,
    staffAdjustmentMode,
    travelProfilesStatus,
    vacancyDialogOpen,
  ]);

  useEffect(() => {
    const profilePickerOpen =
      (vacancyDialogOpen && staffAdjustmentMode === 'travel') ||
      personnelMovementDialogOpen;
    if (!profilePickerOpen && travelProfilesStatus === 'error') {
      setTravelProfilesStatus('idle');
    }
  }, [
    personnelMovementDialogOpen,
    staffAdjustmentMode,
    travelProfilesStatus,
    vacancyDialogOpen,
  ]);

  const handlePrevMonth = () => {
    setSelectedDate(
      new Date(selectedDate.getFullYear(), selectedDate.getMonth() - 1, 1),
    );
  };

  const handleNextMonth = () => {
    setSelectedDate(
      new Date(selectedDate.getFullYear(), selectedDate.getMonth() + 1, 1),
    );
  };

  const handleDateClick = useCallback((date: Date) => {
    setSelectedDate(current => reuseSameDateValue(current, date));
    calendarDayDialogController.openDate(date);
  }, [calendarDayDialogController]);

  const handleToday = () => {
    setSelectedDate(new Date());
  };

  const handleManualSync = useCallback(async () => {
    if (!canRefreshMonthlySchedule) {
      toast.info('当前为只读模式，不能同步或写入数据');
      return;
    }
    if (manualSyncing) {
      return;
    }

    const toastId = toast.loading('正在同步飞书数据到本地库...');
    setManualSyncing(true);

    try {
      const result = await syncDutyScheduleToLocalFast();
      monthlyScheduleCache.clear();
      longWhiteScheduleCache.clear();
      yearlySealingCache.clear();
      setDataRefreshToken((token) => token + 1);
      const [, sealingInfoLoaded] = await Promise.all([
        loadSchedules(),
        loadSealingInfo(true),
      ]);

      if (result.success && sealingInfoLoaded) {
        toast.success('本地库已同步，页面数据已刷新', { id: toastId });
      } else if (result.success) {
        toast.warning('本地库已同步，封网信息暂未刷新，将自动重试', {
          id: toastId,
        });
      } else {
        toast.warning(result.message || '部分数据同步失败，页面已刷新', {
          id: toastId,
        });
      }
    } catch (error) {
      logger.error('手动同步飞书数据失败', error);
      toast.error(
        getProtectedActionErrorMessage(error, '同步失败，请稍后重试'),
        {
          id: toastId,
        },
      );
    } finally {
      setManualSyncing(false);
    }
  }, [canRefreshMonthlySchedule, loadSchedules, loadSealingInfo, manualSyncing]);

  const handleManualScreenshot = useCallback(async () => {
    if (!canSendMonthlySchedule) {
      toast.info('当前为只读模式，不能发送截图');
      return;
    }
    if (manualScreenshotSending) {
      return;
    }

    const toastId = toast.loading('正在生成今日值班截图并发送到飞书群...');
    setManualScreenshotSending(true);

    try {
      const result = await sendDutyOverviewScreenshot();
      toast.success(result.message || '值班概览截图已发送到飞书群', {
        id: toastId,
      });
    } catch (error) {
      logger.error('手动发送值班概览截图失败', error);
      toast.error(
        getProtectedActionErrorMessage(error, '截图发送失败，请稍后重试'),
        { id: toastId },
      );
    } finally {
      setManualScreenshotSending(false);
    }
  }, [canSendMonthlySchedule, manualScreenshotSending]);

  const updateDisplayedSchedules = useCallback(
    (updater: (current: MonthlySchedule[]) => MonthlySchedule[]) => {
      if (activeScheduleReadScopeRef.current !== scheduleReadScope) return;
      for (const [monthKey, cached] of monthlyScheduleCache.entries()) {
        const nextSchedules = updater(cached.schedules);
        if (nextSchedules !== cached.schedules) {
          monthlyScheduleCache.set(monthKey, {
            ...cached,
            schedules: nextSchedules,
          });
        }
      }
      setSchedules((current) => updater(current));
    },
    [monthlyScheduleCache, scheduleReadScope],
  );

  const updateDisplayedDutyStaff = useCallback(
    (updates: DutyStaffActualUpdate[]) => {
      updateDisplayedSchedules((current) =>
        applyDutyStaffActualUpdates(current, updates),
      );
    },
    [updateDisplayedSchedules],
  );

  const beginOptimisticScheduleMutation = useCallback(
    (
      recordIds: string[],
      updater: (current: MonthlySchedule[]) => MonthlySchedule[],
    ) => {
      const uniqueRecordIds = [...new Set(recordIds.filter(Boolean))];
      if (
        uniqueRecordIds.some((recordId) =>
          pendingScheduleRecordIdsRef.current.has(recordId),
        )
      ) {
        return null;
      }
      const recordIdSet = new Set(uniqueRecordIds);
      const snapshots = schedules.filter((schedule) =>
        recordIdSet.has(schedule.recordId),
      );
      uniqueRecordIds.forEach((recordId) =>
        pendingScheduleRecordIdsRef.current.add(recordId),
      );
      updateDisplayedSchedules(updater);

      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        uniqueRecordIds.forEach((recordId) =>
          pendingScheduleRecordIdsRef.current.delete(recordId),
        );
      };
      return {
        finish,
        reconcile: (
          reconciler: (current: MonthlySchedule[]) => MonthlySchedule[],
        ) => {
          if (settled) return;
          updateDisplayedSchedules((current) =>
            reconciler(restoreOptimisticSchedules(current, snapshots)),
          );
          finish();
        },
        rollback: () => {
          if (settled) return;
          updateDisplayedSchedules((current) =>
            restoreOptimisticSchedules(current, snapshots),
          );
          finish();
        },
      };
    },
    [schedules, updateDisplayedSchedules],
  );

  const filledVacancyCount = vacancyCandidates.filter((candidate) =>
    Boolean(vacancyInputs[candidate.key]?.trim()),
  ).length;

  const handleSubmitVacancySubstitutes = useCallback(async () => {
    if (!canManageMonthlySchedule) {
      toast.info('当前为只读模式，不能写入人员调整');
      return;
    }
    if (vacancySubmitting) {
      return;
    }

    const updates = vacancyCandidates
      .map((candidate) => ({
        recordId: candidate.recordId,
        substituteName: vacancyInputs[candidate.key]?.trim() || '',
      }))
      .filter((item) => item.substituteName);

    if (updates.length === 0) {
      toast.warning('请先填写至少 1 名替班人员');
      return;
    }

    const toastId = toast.loading('正在写入缺岗替班...');
    setVacancySubmitting(true);
    const previousInputs = vacancyInputs;
    const optimisticMutation = beginOptimisticScheduleMutation(
      updates.map((item) => item.recordId),
      (current) =>
        appendOptimisticDutyStaff(
          current,
          updates.map((item) => ({
            recordId: item.recordId,
            staffName: item.substituteName,
          })),
        ),
    );
    if (!optimisticMutation) {
      setVacancySubmitting(false);
      toast.info('相关排班正在同步，请稍后再试', { id: toastId });
      return;
    }
    setVacancyDialogOpen(false);
    setVacancyInputs({});

    try {
      const result = await updateVacancySubstitutes({ updates });
      if (result.failed > 0) {
        optimisticMutation.rollback();
        setVacancyDialogOpen(true);
        setVacancyInputs(previousInputs);
      } else {
        optimisticMutation.finish();
      }
      updateDisplayedDutyStaff(result.results);
      if (result.failed > 0) {
        toast.warning(
          result.message || '缺岗替班部分写入失败，成功记录已更新',
          { id: toastId },
        );
      } else {
        toast.success(result.message || '缺岗替班已写入，页面已更新', {
          id: toastId,
        });
      }
    } catch (error) {
      optimisticMutation.rollback();
      setVacancyDialogOpen(true);
      setVacancyInputs(previousInputs);
      logger.error('提交缺岗替班失败', error);
      toast.error('缺岗替班提交失败，请稍后重试', { id: toastId });
    } finally {
      setVacancySubmitting(false);
    }
  }, [
    beginOptimisticScheduleMutation,
    canManageMonthlySchedule,
    updateDisplayedDutyStaff,
    vacancyCandidates,
    vacancyInputs,
    vacancySubmitting,
  ]);

  const handleSubmitStaffRepair = useCallback(async () => {
    if (!canManageMonthlySchedule) {
      toast.info('当前为只读模式，不能写入人员修正');
      return;
    }
    if (repairSubmitting) {
      return;
    }
    if (!selectedRepairCandidate) {
      toast.warning('当前楼栋班次没有可修正的值班人员');
      return;
    }
    if (!repairTargetName) {
      toast.warning('请选择需要修正的人员');
      return;
    }
    const replacementName = repairReplacementName.trim();
    if (!replacementName || !repairStaffOptions.includes(replacementName)) {
      toast.warning('请从在职人员名单选择修正后的人员');
      return;
    }

    const toastId = toast.loading('正在写入人员修正...');
    setRepairSubmitting(true);
    const optimisticMutation = beginOptimisticScheduleMutation(
      [selectedRepairCandidate.recordId],
      (current) =>
        replaceOptimisticDutyStaff(
          current,
          selectedRepairCandidate.recordId,
          repairTargetName,
          replacementName,
        ),
    );
    if (!optimisticMutation) {
      setRepairSubmitting(false);
      toast.info('相关排班正在同步，请稍后再试', { id: toastId });
      return;
    }
    setVacancyDialogOpen(false);

    try {
      const result = await updateDutyStaffAdjustment({
        recordId: selectedRepairCandidate.recordId,
        targetName: repairTargetName,
        replacementName,
      });
      optimisticMutation.finish();
      updateDisplayedDutyStaff([result]);
      toast.success(result.message || '人员已修正，页面已更新', {
        id: toastId,
      });
      setVacancyDialogOpen(false);
      setRepairTargetName('');
      setRepairReplacementName('');
      setRepairReplacementSearch('');
      setRepairReplacementPickerOpen(false);
    } catch (error) {
      optimisticMutation.rollback();
      setVacancyDialogOpen(true);
      logger.error('提交值班人员修正失败', error);
      toast.error('人员修正失败，请确认多维表字段和人员姓名后重试', {
        id: toastId,
      });
    } finally {
      setRepairSubmitting(false);
    }
  }, [
    beginOptimisticScheduleMutation,
    canManageMonthlySchedule,
    repairReplacementName,
    repairStaffOptions,
    repairSubmitting,
    repairTargetName,
    selectedRepairCandidate,
    updateDisplayedDutyStaff,
  ]);

  const handleSubmitEmergencyDuty = useCallback(async () => {
    const currentRecord = emergencyDutyIndexRef.current.get(emergencyDutyDate);
    const requiresUpdate = Boolean(currentRecord?.recordId && !currentRecord.recordId.startsWith('optimistic-'));
    if (requiresUpdate ? !canManageMonthlySchedule : !canCreateMonthlySchedule) {
      toast.info('当前为只读模式，不能调整应急值班');
      return;
    }

    const recoveryBinding =
      currentRecord?.syncState === 'unknown-result'
        ? emergencyDutyMutationBindingsRef.current.get(emergencyDutyDate)
        : undefined;
    const personKeys = recoveryBinding
      ? recoveryBinding.draft.personKeys
      : emergencyDutySelectedKeys;
    const submissionIssue = getEmergencyDutySubmissionIssue({
      date: emergencyDutyDate,
      loadedRange: emergencyDutyLoadedRange,
      loadState: emergencyDutyLoadStatus,
      syncState: currentRecord?.syncState || null,
      selectedCount: personKeys.length,
      optionsReady: emergencyDutyOptionsStatus === 'ready',
      isRecovery: Boolean(recoveryBinding),
    });
    if (submissionIssue) {
      const messageByIssue = {
        'invalid-date': '请选择有效的应急值班日期',
        'schedules-unavailable': '应急值班快照尚未加载完成，请重试加载后再提交',
        'outside-loaded-range': '仅可调整当前已加载日期范围内的应急值班',
        pending: '该日期应急值班正在同步，请等待本次结果',
        'empty-selection': '至少选择一名应急值班人员',
        'options-unavailable': '在职人员缓存尚未加载完成，请稍后重试',
      } as const;
      toast.warning(messageByIssue[submissionIssue]);
      return;
    }

    const optionByKey = new Map(
      emergencyDutyOptions.map((person) => [person.key, person]),
    );
    const currentPeopleByKey = new Map(
      (currentRecord?.people || []).map((person) => [person.key, person]),
    );
    const selectedPeople = personKeys
      .map((key) => optionByKey.get(key) || currentPeopleByKey.get(key))
      .filter((person): person is EmergencyDutyPersonOption => Boolean(person));
    if (selectedPeople.length !== personKeys.length) {
      toast.error('人员缓存已更新，请重新加载并选择在职人员');
      return;
    }

    const mutationRevision = recoveryBinding
      ? recoveryBinding.revision
      : emergencyDutyMutationRevisionRef.current + 1;
    if (!recoveryBinding) {
      emergencyDutyMutationRevisionRef.current = mutationRevision;
    }
    const started = recoveryBinding
      ? retryEmergencyDutyMutation(
          emergencyDutyIndexRef.current,
          recoveryBinding,
        )
      : beginEmergencyDutyMutation(emergencyDutyIndexRef.current, {
          date: emergencyDutyDate,
          people: selectedPeople,
          clientMutationId: crypto.randomUUID(),
          revision: mutationRevision,
        });
    const { binding } = started;
    emergencyDutyMutationBindingsRef.current.set(binding.date, binding);
    emergencyDutyIndexRef.current = started.index;
    setEmergencyDutyIndex(started.index);
    setVacancyDialogOpen(false);

    const toastId = `emergency-duty-${binding.clientMutationId}`;
    toast.loading(`${binding.date} 应急值班正在同步`, { id: toastId });
    try {
      const response = await upsertEmergencyDutySchedule({
        date: binding.date,
        personKeys: binding.draft.personKeys,
        clientMutationId: binding.clientMutationId,
      });
      const activeBinding = emergencyDutyMutationBindingsRef.current.get(
        binding.date,
      );
      if (activeBinding?.clientMutationId !== binding.clientMutationId) {
        return;
      }
      const successRevision = emergencyDutyMutationRevisionRef.current + 1;
      emergencyDutyMutationRevisionRef.current = successRevision;
      const next = resolveEmergencyDutyMutationSuccess(
        emergencyDutyIndexRef.current,
        { ...binding, revision: successRevision },
        response,
      );
      emergencyDutyIndexRef.current = next;
      setEmergencyDutyIndex(next);
      emergencyDutyMutationBindingsRef.current.delete(binding.date);
      if (response.syncStatus === 'cache_refresh_pending') {
        toast.warning('应急值班已写入，页面缓存将在后台刷新', {
          id: toastId,
        });
      } else {
        toast.success('应急值班已更新', { id: toastId });
      }
    } catch (error) {
      const activeBinding = emergencyDutyMutationBindingsRef.current.get(
        binding.date,
      );
      if (activeBinding?.clientMutationId !== binding.clientMutationId) {
        return;
      }
      const disposition = classifyEmergencyDutyMutationError(error);
      const resolved = resolveEmergencyDutyMutationFailure(
        emergencyDutyIndexRef.current,
        binding,
        disposition,
      );
      emergencyDutyIndexRef.current = resolved.index;
      setEmergencyDutyIndex(resolved.index);
      if (resolved.restoreDraft) {
        emergencyDutyMutationBindingsRef.current.delete(binding.date);
        setEmergencyDutyDate(resolved.restoreDraft.date);
        setEmergencyDutySelectedKeys(resolved.restoreDraft.personKeys);
        setEmergencyDutySearch('');
        setStaffAdjustmentMode('emergency');
        setVacancyDialogOpen(true);
        toast.error('应急值班未写入，已恢复本次选择，请直接重试', {
          id: toastId,
        });
      } else {
        if (resolved.retryBinding) {
          emergencyDutyMutationBindingsRef.current.set(
            binding.date,
            resolved.retryBinding,
          );
        }
        logger.warn('应急值班写入结果待确认', error);
        toast.error('写入结果暂无法确认；请重新打开应急值班并安全重试', {
          id: toastId,
        });
      }
    }
  }, [
    canCreateMonthlySchedule,
    canManageMonthlySchedule,
    emergencyDutyDate,
    emergencyDutyLoadedRange,
    emergencyDutyLoadStatus,
    emergencyDutyOptions,
    emergencyDutyOptionsStatus,
    emergencyDutySelectedKeys,
  ]);

  const handleSubmitTravelStaff = useCallback(async () => {
    if (!canCreateMonthlySchedule) {
      toast.info('当前为只读模式，不能写入差旅人员');
      return;
    }
    if (travelSubmitting) {
      return;
    }

    const staffName = travelStaffName.trim();
    if (!staffName) {
      toast.warning('请选择差旅人员');
      return;
    }
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(travelStartDate) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(travelEndDate)
    ) {
      toast.warning('请选择有效的差旅日期');
      return;
    }
    if (travelEndDate < travelStartDate) {
      toast.warning('差旅结束日期不能早于开始日期');
      return;
    }
    if (travelStartDate.slice(0, 7) !== travelEndDate.slice(0, 7)) {
      toast.warning('差旅日期不能跨月');
      return;
    }
    if (getInclusiveDateRangeDays(travelStartDate, travelEndDate) > 31) {
      toast.warning('差旅日期最长只允许 1 个月');
      return;
    }

    const toastId = toast.loading('正在写入差旅人员...');
    setTravelSubmitting(true);
    const affectedRecordIds = schedules
      .filter((schedule) => {
        const scheduleDate = schedule.scheduleDate;
        return Boolean(
          scheduleDate &&
          scheduleDate >= travelStartDate &&
          scheduleDate <= travelEndDate &&
          schedule.dutyStaffActual.some((name) => name.trim() === staffName),
        );
      })
      .map((schedule) => schedule.recordId);
    const optimisticMutation = beginOptimisticScheduleMutation(
      affectedRecordIds,
      (current) =>
        removeOptimisticDutyStaff(current, staffName, {
          startDate: travelStartDate,
          endDate: travelEndDate,
        }),
    );
    if (!optimisticMutation) {
      setTravelSubmitting(false);
      toast.info('相关排班正在同步，请稍后再试', { id: toastId });
      return;
    }
    setVacancyDialogOpen(false);

    try {
      const result = await updateTravelStaff({
        staffName,
        startDate: travelStartDate,
        endDate: travelEndDate,
      });
      if (result.failed > 0 || result.total === 0) {
        optimisticMutation.rollback();
        setVacancyDialogOpen(true);
      } else {
        optimisticMutation.finish();
      }
      updateDisplayedDutyStaff(result.results);
      void loadTravelDetails(true);

      if (result.failed > 0) {
        toast.warning(result.message || '差旅人员部分写入失败，页面已刷新', {
          id: toastId,
        });
      } else if (result.total === 0) {
        toast.warning(
          result.message || '未找到需要更新的值班记录，页面已刷新',
          { id: toastId },
        );
      } else {
        toast.success(result.message || '差旅人员已写入，页面已刷新', {
          id: toastId,
        });
        setTravelStaffSearch(staffName);
      }
    } catch (error) {
      optimisticMutation.rollback();
      setVacancyDialogOpen(true);
      logger.error('提交差旅人员失败', error);
      toast.error('差旅人员提交失败，请确认多维表字段和日期后重试', {
        id: toastId,
      });
    } finally {
      setTravelSubmitting(false);
    }
  }, [
    beginOptimisticScheduleMutation,
    canCreateMonthlySchedule,
    loadTravelDetails,
    schedules,
    travelEndDate,
    travelStaffName,
    travelStartDate,
    travelSubmitting,
    updateDisplayedDutyStaff,
  ]);

  const handleSubmitPersonnelMovement = useCallback(async () => {
    if (!canManageMonthlySchedule) {
      toast.info('当前为只读模式，不能提交人员异动');
      return;
    }
    if (personnelMovementSubmitting) {
      return;
    }

    const staffName = (
      personnelMovementStaffName || personnelMovementStaffSearch
    ).trim();
    if (!staffName) {
      toast.warning('请选择或输入人员');
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(personnelMovementDate)) {
      toast.warning('请选择有效的异动时间');
      return;
    }

    const toastId = toast.loading('正在提交人员异动...');
    setPersonnelMovementSubmitting(true);
    const previousPersonProfiles = personProfiles;
    const affectedRecordIds = schedules
      .filter((schedule) =>
        Boolean(
          schedule.scheduleDate &&
          schedule.scheduleDate >= personnelMovementDate &&
          schedule.dutyStaffActual.some((name) => name.trim() === staffName),
        ),
      )
      .map((schedule) => schedule.recordId);
    const optimisticMutation = beginOptimisticScheduleMutation(
      affectedRecordIds,
      (current) =>
        removeOptimisticDutyStaff(current, staffName, {
          startDate: personnelMovementDate,
          endDate: '9999-12-31',
        }),
    );
    if (!optimisticMutation) {
      setPersonnelMovementSubmitting(false);
      toast.info('相关排班正在同步，请稍后再试', { id: toastId });
      return;
    }
    if (personnelMovementType === '离职') {
      setPersonProfiles((current) =>
        current.filter(
          (profile) => profile.supervisorText?.trim() !== staffName,
        ),
      );
    }
    setPersonnelMovementDialogOpen(false);

    try {
      const result = await createPersonnelMovement({
        staffName,
        movementType: personnelMovementType,
        movementDate: personnelMovementDate,
      });
      if (result.failed > 0 || result.total === 0) {
        optimisticMutation.rollback();
        setPersonProfiles(previousPersonProfiles);
        setPersonnelMovementDialogOpen(true);
      } else {
        optimisticMutation.finish();
      }
      updateDisplayedDutyStaff(
        result.results.map((item) => ({
          recordId: item.recordId,
          dutyStaffActual: splitStaffDisplayNames(item.nextValue),
        })),
      );
      void loadPersonProfiles(true);
      void loadTravelPersonProfiles(true);

      if (result.failed > 0) {
        toast.warning(result.message || '人员异动部分写入失败，页面已刷新', {
          id: toastId,
        });
      } else if (result.total === 0) {
        toast.warning(
          result.message || '未找到需要修改的排班记录，页面已刷新',
          { id: toastId },
        );
      } else {
        toast.success(result.message || '人员异动已完成，页面已刷新', {
          id: toastId,
        });
        setPersonnelMovementStaffName('');
        setPersonnelMovementStaffSearch('');
        setPersonnelMovementStaffPickerOpen(false);
      }
    } catch (error) {
      optimisticMutation.rollback();
      setPersonProfiles(previousPersonProfiles);
      setPersonnelMovementDialogOpen(true);
      logger.error('提交人员异动失败', error);
      toast.error('人员异动提交失败，请确认人员、字段配置和异动时间后重试', {
        id: toastId,
      });
    } finally {
      setPersonnelMovementSubmitting(false);
    }
  }, [
    beginOptimisticScheduleMutation,
    canManageMonthlySchedule,
    loadPersonProfiles,
    loadTravelPersonProfiles,
    personProfiles,
    personnelMovementDate,
    personnelMovementStaffName,
    personnelMovementStaffSearch,
    personnelMovementSubmitting,
    personnelMovementType,
    schedules,
    updateDisplayedDutyStaff,
  ]);

  const startTravelDetailEdit = useCallback(
    (detail: TravelStaffDetail, recordIds: string[] = []) => {
      if (!canManageMonthlySchedule) {
        toast.info('当前为只读模式，不能调整差旅人员');
        return;
      }
      setExpandedTravelStaffNames((current) => ({
        ...current,
        [detail.staffName]: true,
      }));
      setExpandedTravelDetailId(detail.id);
      setEditingTravelDetail(detail);
      setEditingTravelRecordIds(recordIds);
      setTravelEditStartDate(detail.startDate);
      setTravelEditEndDate(detail.endDate);
    },
    [canManageMonthlySchedule],
  );

  const handleSubmitTravelAdjustment = useCallback(async () => {
    if (!canManageMonthlySchedule) {
      toast.info('当前为只读模式，不能调整差旅人员');
      return;
    }
    if (!editingTravelDetail || travelActionSubmitting) {
      return;
    }
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(travelEditStartDate) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(travelEditEndDate)
    ) {
      toast.warning('请选择有效的调整日期');
      return;
    }
    if (travelEditEndDate < travelEditStartDate) {
      toast.warning('调整结束日期不能早于开始日期');
      return;
    }
    if (travelEditStartDate.slice(0, 7) !== travelEditEndDate.slice(0, 7)) {
      toast.warning('差旅日期不能跨月');
      return;
    }
    if (
      getInclusiveDateRangeDays(travelEditStartDate, travelEditEndDate) > 31
    ) {
      toast.warning('差旅日期最长只允许 1 个月');
      return;
    }

    const toastId = toast.loading('正在调整差旅人员...');
    setTravelActionSubmitting(true);
    const detail = editingTravelDetail;
    const previousTravelDetails = travelDetails;
    const originalRecordIds =
      editingTravelRecordIds.length > 0
        ? editingTravelRecordIds
        : detail.records.map((record) => record.recordId);
    const affectedRecordIds = [
      ...new Set([
        ...originalRecordIds,
        ...schedules
          .filter((schedule) =>
            Boolean(
              schedule.scheduleDate &&
              schedule.scheduleDate >= travelEditStartDate &&
              schedule.scheduleDate <= travelEditEndDate &&
              schedule.dutyStaffActual.some(
                (name) => name.trim() === detail.staffName,
              ),
            ),
          )
          .map((schedule) => schedule.recordId),
      ]),
    ];
    const optimisticMutation = beginOptimisticScheduleMutation(
      affectedRecordIds,
      (current) =>
        removeOptimisticDutyStaff(
          appendOptimisticDutyStaff(
            current,
            originalRecordIds.map((recordId) => ({
              recordId,
              staffName: detail.staffName,
            })),
          ),
          detail.staffName,
          { startDate: travelEditStartDate, endDate: travelEditEndDate },
        ),
    );
    if (!optimisticMutation) {
      setTravelActionSubmitting(false);
      toast.info('相关排班正在同步，请稍后再试', { id: toastId });
      return;
    }
    setTravelDetails((current) =>
      current.map((item) =>
        item.id === detail.id
          ? {
              ...item,
              startDate: travelEditStartDate,
              endDate: travelEditEndDate,
            }
          : item,
      ),
    );
    setEditingTravelDetail(null);
    setEditingTravelRecordIds([]);
    setSelectedTravelRecordIds({});
    try {
      const result = await adjustTravelStaff({
        staffName: detail.staffName,
        originalStartDate: detail.startDate,
        originalEndDate: detail.endDate,
        startDate: travelEditStartDate,
        endDate: travelEditEndDate,
        recordIds:
          editingTravelRecordIds.length > 0
            ? editingTravelRecordIds
            : undefined,
      });
      if (result.failed > 0) {
        optimisticMutation.rollback();
      } else {
        optimisticMutation.finish();
      }
      updateDisplayedDutyStaff(result.results);
      setTravelDetails(result.details);
      setTravelStaffName(detail.staffName);
      setTravelStaffSearch(detail.staffName);
      setTravelStartDate(travelEditStartDate);
      setTravelEndDate(travelEditEndDate);

      if (result.failed > 0) {
        toast.warning(result.message || '差旅人员部分调整失败，页面已刷新', {
          id: toastId,
        });
      } else {
        toast.success(result.message || '差旅人员已调整，页面已刷新', {
          id: toastId,
        });
      }
    } catch (error) {
      optimisticMutation.rollback();
      setTravelDetails(previousTravelDetails);
      setEditingTravelDetail(detail);
      setEditingTravelRecordIds(originalRecordIds);
      logger.error('调整差旅人员失败', error);
      toast.error('差旅人员调整失败，请确认多维表字段和日期后重试', {
        id: toastId,
      });
    } finally {
      setTravelActionSubmitting(false);
    }
  }, [
    beginOptimisticScheduleMutation,
    canManageMonthlySchedule,
    editingTravelDetail,
    schedules,
    travelDetails,
    travelActionSubmitting,
    travelEditEndDate,
    editingTravelRecordIds,
    travelEditStartDate,
    updateDisplayedDutyStaff,
  ]);

  const handleRevokeTravelDetail = useCallback(
    (detail: TravelStaffDetail, recordIds: string[] = []) => {
      if (!canDeleteMonthlySchedule) {
        toast.info('当前权限不能撤回差旅记录');
        return;
      }
      if (travelActionSubmitting) {
        return;
      }
      setPendingTravelRevoke({ detail, recordIds });
    },
    [canDeleteMonthlySchedule, travelActionSubmitting],
  );

  const confirmRevokeTravelDetail = useCallback(async () => {
    if (!canDeleteMonthlySchedule) {
      toast.info('当前权限不能撤回差旅记录');
      return;
    }
    if (!pendingTravelRevoke || travelActionSubmitting) {
      return;
    }

    const { detail, recordIds } = pendingTravelRevoke;
    const toastId = toast.loading('正在撤回差旅人员...');
    setTravelActionSubmitting(true);
    const previousTravelDetails = travelDetails;
    const targetRecordIds =
      recordIds.length > 0
        ? recordIds
        : detail.records.map((record) => record.recordId);
    const optimisticMutation = beginOptimisticScheduleMutation(
      targetRecordIds,
      (current) =>
        appendOptimisticDutyStaff(
          current,
          targetRecordIds.map((recordId) => ({
            recordId,
            staffName: detail.staffName,
          })),
        ),
    );
    if (!optimisticMutation) {
      setTravelActionSubmitting(false);
      toast.info('相关排班正在同步，请稍后再试', { id: toastId });
      return;
    }
    setPendingTravelRevoke(null);
    setTravelDetails((current) =>
      current.filter((item) => item.id !== detail.id),
    );
    try {
      const result = await revokeTravelStaff({
        staffName: detail.staffName,
        startDate: detail.startDate,
        endDate: detail.endDate,
        recordIds: recordIds.length > 0 ? recordIds : undefined,
      });
      if (result.failed > 0) {
        optimisticMutation.rollback();
      } else {
        optimisticMutation.finish();
      }
      updateDisplayedDutyStaff(result.results);
      setTravelDetails(result.details);
      setEditingTravelDetail(null);
      setEditingTravelRecordIds([]);
      setSelectedTravelRecordIds({});

      if (result.failed > 0) {
        toast.warning(result.message || '差旅人员部分撤回失败，页面已刷新', {
          id: toastId,
        });
      } else {
        toast.success(result.message || '差旅人员已撤回，页面已刷新', {
          id: toastId,
        });
      }
    } catch (error) {
      optimisticMutation.rollback();
      setTravelDetails(previousTravelDetails);
      setPendingTravelRevoke({ detail, recordIds });
      logger.error('撤回差旅人员失败', error);
      toast.error('差旅人员撤回失败，请确认多维表字段和日期后重试', {
        id: toastId,
      });
    } finally {
      setTravelActionSubmitting(false);
    }
  }, [
    beginOptimisticScheduleMutation,
    canDeleteMonthlySchedule,
    pendingTravelRevoke,
    travelActionSubmitting,
    travelDetails,
    updateDisplayedDutyStaff,
  ]);

  const handleSubmitLeaveRequest = useCallback(() => {
    if (leaveApplicant.mode === 'login') {
      requestLogin(leaveApplicant.message, '/monthly-schedule');
      return;
    }
    if (leaveApplicant.mode === 'error') {
      toast.error(leaveApplicant.message);
      return;
    }
    if (lockedLeaveRequestRetryBinding && leaveApplicant.mode === 'automatic' &&
      lockedLeaveRequestRetryBinding.snapshot.staffName !== leaveApplicant.name) {
      toast.error('请使用原申请人的账号登录后重试');
      return;
    }
    if (!canCreateLeaveRequest) {
      toast.info('当前身份不能登记请休假');
      return;
    }
    if (leaveRequestSubmittingRef.current || leaveRequestSubmitting) {
      return;
    }

    let mutationResolution: ReturnType<
      typeof resolveLeaveRequestMutationBinding
    >;
    if (lockedLeaveRequestRetryBinding) {
      mutationResolution = {
        status: 'ready',
        binding: lockedLeaveRequestRetryBinding,
        reused: true,
      };
    } else {
      const staffName = leaveStaffName.trim();
      const reason = leaveReason.trim();
      if (!staffName) {
        toast.warning('请填写请休假人员');
        return;
      }
      if (!selectedLeaveStaffProfile) {
        toast.warning('请从人员表中选择请休假人员');
        return;
      }
      const parsedStartAt = parseShanghaiLocalDateTime(leaveStartAt);
      const parsedEndAt = parseShanghaiLocalDateTime(leaveEndAt);
      if (!parsedStartAt || !parsedEndAt) {
        toast.warning('请按整点选择有效的开始和结束时间（分钟必须为 00）');
        return;
      }
      if (parsedEndAt.wallClockHourIndex <= parsedStartAt.wallClockHourIndex) {
        toast.warning('请休假结束时间必须晚于开始时间');
        return;
      }
      if (!leaveTimeCandidates.startOptions.includes(leaveStartAt)) {
        toast.warning('请选择该人员实际排班内的开始时间');
        return;
      }
      if (!leaveEndTimeCandidates.endOptions.includes(leaveEndAt)) {
        toast.warning('请选择该人员实际排班内的结束时间');
        return;
      }
      if (!isLeaveScheduleCoverageReady) {
        toast.warning(
          leaveScheduleCoverageStatus === 'error'
            ? '日期范围内的排班加载失败，请稍后重试'
            : '正在加载日期范围内的排班，请稍候再提交',
        );
        return;
      }
      if (leaveImpact.invalidRange) {
        toast.warning('请核对请休假时间，开始和结束时间必须为有效整点');
        return;
      }
      if (leaveImpact.unrecognizedShifts.length > 0) {
        toast.warning(
          `存在未识别班次：${leaveImpact.unrecognizedShifts.join('、')}，请先核对排班`,
        );
        return;
      }
      if (leaveImpact.missingCalendarYears.length > 0) {
        toast.warning(
          `缺少 ${leaveImpact.missingCalendarYears.join('、')} 年法定节假日数据，暂不能计算长白班工时`,
        );
        return;
      }
      if (leaveImpact.rawHours < 4) {
        toast.warning('每次请休假的实际工时至少 4 小时，请调整时间范围');
        return;
      }
      if (!leaveType) {
        toast.warning('请选择休假类型');
        return;
      }
      if (!reason) {
        toast.warning('请填写请假原因');
        return;
      }
      if (!leaveRequestScreenshot) {
        toast.warning('请上传流程截图');
        return;
      }

      const submissionSnapshot = Object.freeze({
        staffName,
        startAt: leaveStartAt,
        endAt: leaveEndAt,
        expectedImpact: leaveImpact,
        leaveType,
        reason,
        screenshot: leaveRequestScreenshot,
        needSubstitute: false,
        substituteName: '',
      });
      const recoveredMutationBinding = recoveredLeaveRequestMutationId
        ? {
            clientMutationId: recoveredLeaveRequestMutationId,
            snapshot: submissionSnapshot,
            state: 'unknown-result' as const,
          }
        : null;
      mutationResolution = resolveLeaveRequestMutationBinding(
        leaveRequestMutationBindingRef.current || recoveredMutationBinding,
        submissionSnapshot,
        createLeaveRequestMutationId,
      );
    }
    if (mutationResolution.status === 'blocked') {
      setLeaveRequestRecoveryState('unknown-result');
      setLeaveAuthoritativeImpact(
        mutationResolution.binding.snapshot.expectedImpact,
      );
      toast.warning(
        '原请休假提交结果仍待确认，当前草稿已锁定，请使用原申请标识安全重试',
      );
      return;
    }

    const mutationBinding = mutationResolution.binding;
    const boundSnapshot = mutationBinding.snapshot;
    const clientMutationId = mutationBinding.clientMutationId;
    const mutationIdPersisted = persistLeaveRequestUnknownMutationId(
      getLeaveRequestSessionStorage(),
      clientMutationId,
    );
    if (!mutationIdPersisted) {
      toast.error('浏览器无法保存本次申请标识，请检查存储设置后重试');
      return;
    }
    leaveRequestMutationBindingRef.current = mutationBinding;

    const submitSeq = leaveRequestSubmitSeqRef.current + 1;
    leaveRequestSubmitSeqRef.current = submitSeq;
    const submittedDraft = Object.freeze({
      ...boundSnapshot,
      clientMutationId,
      staffSearch: boundSnapshot.staffName,
      coverageKey: leaveScheduleCoverageKey,
    });
    const toastId = toast.info('请休假申请已受理，正在后台同步');

    void coordinateLeaveRequestSubmit({
      draft: submittedDraft,
      onStart: () => {
        leaveRequestSubmittingRef.current = true;
        setLeaveRequestSubmitting(true);
        setLeaveRequestSyncStatus('syncing');
        setLeaveRequestRecoveryState(null);
        setRecoveredLeaveRequestMutationId(null);
        setLeaveRequestDialogOpen(false);
      },
      request: async (draft) =>
        await createLeaveRequest(
          {
            clientMutationId: draft.clientMutationId,
            leaveStaffName: draft.staffName,
            startAt: draft.startAt,
            endAt: draft.endAt,
            expectedImpact: draft.expectedImpact,
            leaveType: draft.leaveType,
            leaveReason: draft.reason,
            needSubstitute: draft.needSubstitute,
            substituteStaffName: draft.substituteName || null,
          },
          draft.screenshot,
        ),
      onSuccess: (result, draft) => {
        if (
          leaveRequestSubmitSeqRef.current !== submitSeq ||
          leaveRequestMutationBindingRef.current?.clientMutationId !==
            draft.clientMutationId
        ) {
          return;
        }
        const response = resolveLeaveRequestSuccessResponse(result, draft);
        setLeaveRequestSyncStatus('idle');
        setLeaveAuthoritativeImpact(null);
        setLeaveRequestDialogOpen(false);
        setLeaveStaffName('');
        setLeaveType('年假');
        setLeaveReason('');
        setLeaveRequestScreenshot(null);
        leaveRequestMutationBindingRef.current = null;
        setLeaveRequestRecoveryState(null);
        setRecoveredLeaveRequestMutationId(null);
        clearLeaveRequestUnknownMutationId(getLeaveRequestSessionStorage());
        toast.success(
          `请休假申请已提交，共 ${response.rawHours} 小时，待审批通过后生效`,
          { id: toastId },
        );
      },
      onRollback: (error, draft) => {
        if (
          leaveRequestSubmitSeqRef.current !== submitSeq ||
          leaveRequestMutationBindingRef.current?.clientMutationId !==
            draft.clientMutationId
        ) {
          return;
        }
        const failedBinding = markLeaveRequestMutationFailure(
          leaveRequestMutationBindingRef.current,
          error,
        );
        leaveRequestMutationBindingRef.current = failedBinding;
        const recoveryState =
          failedBinding.state === 'unknown-result'
            ? 'unknown-result'
            : 'editable-error';
        setLeaveRequestRecoveryState(recoveryState);
        if (recoveryState === 'unknown-result') {
          persistLeaveRequestUnknownMutationId(
            getLeaveRequestSessionStorage(),
            failedBinding.clientMutationId,
          );
          setLeaveAuthoritativeImpact(draft.expectedImpact);
        } else {
          clearLeaveRequestUnknownMutationId(getLeaveRequestSessionStorage());
          setRecoveredLeaveRequestMutationId(null);
        }
      },
      onReopen: () => {
        if (
          leaveRequestSubmitSeqRef.current === submitSeq &&
          leaveRequestMutationBindingRef.current?.clientMutationId ===
            clientMutationId
        ) {
          refreshBusinessClock();
          setLeaveRequestDialogOpen(true);
        }
      },
      onFailure: async (error, draft) => {
        if (
          leaveRequestSubmitSeqRef.current !== submitSeq ||
          leaveRequestMutationBindingRef.current?.clientMutationId !==
            clientMutationId
        ) {
          return;
        }
        setLeaveRequestSyncStatus('error');
        logger.error('提交请休假失败', error);
        const staleImpactConflict = isBackendStatus(error, 409);
        const latestImpact = staleImpactConflict
          ? getBackendLatestLeaveImpact(error)
          : null;
        if (latestImpact) {
          setLeaveAuthoritativeImpact(latestImpact);
        }
        let scheduleRefreshResult: boolean | null = null;
        if (staleImpactConflict && leaveScheduleCoverageKey) {
          const coverageKey = draft.coverageKey || leaveScheduleCoverageKey;
          const coverageRequestId = leaveScheduleCoverageLoadSeqRef.current + 1;
          leaveScheduleCoverageLoadSeqRef.current = coverageRequestId;
          setLeaveScheduleCoverageStatus('loading');
          setLeaveScheduleCoverageReadyKey(null);
          const loaded = await ensureSchedulesForLeaveDateRange(
            coverageKey.split('|'),
            resolveLeaveScheduleForceRefresh(
              true,
              canRefreshMonthlySchedule || selfServiceOnly,
            ),
          );
          if (
            leaveRequestSubmitSeqRef.current === submitSeq &&
            leaveScheduleCoverageLoadSeqRef.current === coverageRequestId
          ) {
            scheduleRefreshResult = loaded;
            setLeaveScheduleCoverageStatus(loaded ? 'ready' : 'error');
            setLeaveScheduleCoverageReadyKey(loaded ? coverageKey : null);
            if (loaded) {
              setLeaveAuthoritativeImpact(null);
            }
          }
        }
        const backendMessage = getBackendErrorMessage(
          error,
          '请休假提交失败，请稍后重试',
        );
        const unknownResult =
          leaveRequestMutationBindingRef.current?.state === 'unknown-result';
        toast.error(
          unknownResult
            ? `${backendMessage}；提交结果待确认，草稿已锁定，请使用原申请标识安全重试`
            : staleImpactConflict
              ? scheduleRefreshResult
                ? `${backendMessage}；排班和可选时段已刷新，请确认后重试`
                : scheduleRefreshResult === false
                  ? `${backendMessage}；排班刷新失败，草稿已保留，请稍后重试`
                  : `${backendMessage}；未取得最新排班，请稍后重试`
              : backendMessage,
          { id: toastId },
        );
      },
      onSettled: () => {
        if (leaveRequestSubmitSeqRef.current === submitSeq) {
          leaveRequestSubmittingRef.current = false;
          setLeaveRequestSubmitting(false);
        }
      },
    }).catch((error) => {
      logger.error('请休假后台同步处理失败', error);
    });
  }, [
    canRefreshMonthlySchedule,
    canCreateLeaveRequest,
    selfServiceOnly,
    ensureSchedulesForLeaveDateRange,
    leaveApplicant.mode,
    leaveApplicant.mode === 'automatic' ? leaveApplicant.name : '',
    leaveApplicant.mode === 'login' || leaveApplicant.mode === 'error' ? leaveApplicant.message : '',
    requestLogin,
    leaveEndAt,
    leaveImpact,
    leaveRequestSubmitting,
    lockedLeaveRequestRetryBinding,
    leaveScheduleCoverageStatus,
    leaveScheduleCoverageKey,
    isLeaveScheduleCoverageReady,
    leaveStaffName,
    leaveStartAt,
    leaveEndTimeCandidates.endOptions,
    leaveTimeCandidates.startOptions,
    leaveType,
    leaveReason,
    leaveRequestScreenshot,
    recoveredLeaveRequestMutationId,
    refreshBusinessClock,
    selectedLeaveStaffProfile,
  ]);

  const handleSubmitChangeRequest = useCallback(
    async (
      draft: ChangeRequestDraft,
      stagedDocuments: ChangeRequestStagedDocument[],
    ) => {
      if (!canCreateChange) {
        toast.info('当前身份不能提交变更申请');
        return;
      }
      if (changeRequestSubmittingRef.current || changeRequestSubmitting) {
        return;
      }
      if (changeRequestRetryAction === 'manual-reconcile') {
        toast.warning(
          '提交结果待确认，请先人工核查飞书多维表，当前不会自动重试',
        );
        return;
      }

      const submittedDraft = cloneChangeRequestDraft(draft);
      const submittedStagedDocuments = [...stagedDocuments];
      const clientMutationId = changeRequestMutationIdRef.current;
      const requestCandidate = {
        clientMutationId,
        submitterName: submittedDraft.submitterName?.trim(),
        submitterId: submittedDraft.submitterId,
        stagedDocuments: submittedStagedDocuments,
        nature: submittedDraft.nature,
        ...(submittedDraft.meetingStartAt
          ? { meetingStartAt: submittedDraft.meetingStartAt }
          : {}),
        ...(submittedDraft.meetingEndAt
          ? { meetingEndAt: submittedDraft.meetingEndAt }
          : {}),
        summary: submittedDraft.summary.trim(),
        changeType: submittedDraft.changeType,
        workType: submittedDraft.workType,
        buildings: [...submittedDraft.buildings],
        plannedStartAt: submittedDraft.plannedStartAt,
        plannedEndAt: submittedDraft.plannedEndAt,
        discipline: submittedDraft.discipline,
        level: submittedDraft.level,
        riskSummary: submittedDraft.riskSummary.trim(),
      };
      const validationErrors = validateChangeRequest(requestCandidate);
      if (validationErrors.length > 0) {
        const message = validationErrors[0].message;
        setChangeRequestDraft(submittedDraft);
        setChangeRequestStagedDocuments(submittedStagedDocuments);
        setChangeRequestServerError(message);
        setChangeRequestResetKey((current) => current + 1);
        changeRequestDialogRef.current?.setOpen(true);
        toast.warning(message);
        return;
      }
      const request = requestCandidate as ChangeRequestCreateRequest;
      const partialRecordAtSubmit =
        changeRequestPartialRecord &&
        changeRequestMutationIdRef.current === clientMutationId
          ? changeRequestPartialRecord
          : null;
      const temporaryId =
        partialRecordAtSubmit?.id ||
        `change-request-pending-${clientMutationId}`;
      const pendingChange = partialRecordAtSubmit
        ? {
            ...partialRecordAtSubmit,
            progress: '附件同步中',
            updatedAt: new Date().toISOString(),
          }
        : createPendingChangeInfo(request, temporaryId);
      const changeYear = Number.parseInt(
        request.plannedStartAt.slice(0, 4),
        10,
      );
      const submitSeq = changeRequestSubmitSeqRef.current + 1;

      changeRequestMutationIdRef.current = clientMutationId;
      changeRequestSubmitSeqRef.current = submitSeq;
      changeRequestSubmittingRef.current = true;
      const toastId = clientMutationId;
      flushSync(() => {
        changeRequestDialogRef.current?.setOpen(false);
      });
      setChangeRequestSubmitting(true);
      setChangeRequestServerError(null);
      setChangeRequestDraft(submittedDraft);
      setChangeRequestStagedDocuments(submittedStagedDocuments);
      setChangeRequestOverlay(temporaryId, pendingChange);
      if (selectedYearRef.current === changeYear) {
        setChanges((current) =>
          partialRecordAtSubmit
            ? reconcilePendingChange(current, temporaryId, pendingChange)
            : [pendingChange, ...current],
        );
      }
      updateCachedChanges(changeYear, (current) =>
        partialRecordAtSubmit
          ? reconcilePendingChange(current, temporaryId, pendingChange)
          : [pendingChange, ...current],
      );
      toast.loading('正在提交变更申请，草稿已保留', { id: toastId });
      try {
        const result = await createChangeRequest(request);
        if (result.clientMutationId !== clientMutationId) {
          throw new Error('服务端返回了不匹配的变更申请标识');
        }
        if (changeRequestSubmitSeqRef.current !== submitSeq) return;

        const acceptedRecord = result.pendingSync
          ? {
              ...result.record,
              progress: '附件同步中',
              submitterName:
                result.record.submitterName || request.submitterName || null,
              planDocuments: result.record.planDocuments?.length
                ? result.record.planDocuments
                : pendingChange.planDocuments,
            }
          : result.record;
        deleteChangeRequestOverlay(temporaryId);
        setChangeRequestOverlay(
          acceptedRecord.bitableRecordId || acceptedRecord.id,
          acceptedRecord,
        );
        if (selectedYearRef.current === changeYear) {
          setChanges((current) =>
            reconcilePendingChange(current, temporaryId, acceptedRecord),
          );
        }
        updateCachedChanges(changeYear, (current) =>
          reconcilePendingChange(current, temporaryId, acceptedRecord),
        );
        if (result.pendingSync && result.taskId) {
          toast.success(result.message || '变更申请已提交，附件后台同步中', {
            id: toastId,
          });
          void monitorChangeRequestSyncTask(
            result.taskId,
            () => changeRequestSubmitSeqRef.current === submitSeq,
          )
            .then((task) => {
              if (!task || changeRequestSubmitSeqRef.current !== submitSeq) {
                return;
              }
              if (task.status === 'completed') {
                const taskResult = task.result as
                  | ChangeRequestCreateResponse
                  | undefined;
                const finalRecord =
                  taskResult?.clientMutationId === clientMutationId &&
                  taskResult.record
                    ? taskResult.record
                    : { ...acceptedRecord, progress: null };
                setChangeRequestOverlay(
                  finalRecord.bitableRecordId || finalRecord.id,
                  finalRecord,
                );
                if (selectedYearRef.current === changeYear) {
                  setChanges((current) =>
                    reconcilePendingChange(
                      current,
                      acceptedRecord.id,
                      finalRecord,
                    ),
                  );
                }
                updateCachedChanges(changeYear, (current) =>
                  reconcilePendingChange(
                    current,
                    acceptedRecord.id,
                    finalRecord,
                  ),
                );
                const nextMutationId = createChangeRequestMutationId();
                changeRequestMutationIdRef.current = nextMutationId;
                setChangeRequestOwnerMutationId(nextMutationId);
                setChangeRequestDraft(
                  createChangeRequestDraftForDate(selectedDateKey),
                );
                setChangeRequestStagedDocuments([]);
                setChangeRequestPartialRecord(null);
                setChangeRequestRetryAction(null);
                setChangeRequestResetKey((current) => current + 1);
                toast.success(task.message || '变更申请及附件已同步飞书', {
                  id: toastId,
                });
                return;
              }

              const failedRecord = {
                ...acceptedRecord,
                progress: '附件待补传',
                updatedAt: new Date().toISOString(),
              };
              setChangeRequestOverlay(
                failedRecord.bitableRecordId || failedRecord.id,
                failedRecord,
              );
              if (selectedYearRef.current === changeYear) {
                setChanges((current) =>
                  reconcilePendingChange(
                    current,
                    acceptedRecord.id,
                    failedRecord,
                  ),
                );
              }
              updateCachedChanges(changeYear, (current) =>
                reconcilePendingChange(
                  current,
                  acceptedRecord.id,
                  failedRecord,
                ),
              );
              setChangeRequestDraft(submittedDraft);
              setChangeRequestStagedDocuments(submittedStagedDocuments);
              setChangeRequestPartialRecord(failedRecord);
              setChangeRequestRetryAction('retry-same-mutation');
              setChangeRequestServerError(
                task.message || '正式记录已建立，但附件同步失败，请重试附件',
              );
              setChangeRequestResetKey((current) => current + 1);
              changeRequestDialogRef.current?.setOpen(true);
              toast.error(
                task.message || '正式记录已建立，但附件同步失败，请重试附件',
                { id: toastId },
              );
            })
            .catch((error) => {
              if (changeRequestSubmitSeqRef.current !== submitSeq) return;
              const failedRecord = {
                ...acceptedRecord,
                progress: '附件待补传',
                updatedAt: new Date().toISOString(),
              };
              setChangeRequestOverlay(
                failedRecord.bitableRecordId || failedRecord.id,
                failedRecord,
              );
              if (selectedYearRef.current === changeYear) {
                setChanges((current) =>
                  reconcilePendingChange(
                    current,
                    acceptedRecord.id,
                    failedRecord,
                  ),
                );
              }
              updateCachedChanges(changeYear, (current) =>
                reconcilePendingChange(
                  current,
                  acceptedRecord.id,
                  failedRecord,
                ),
              );
              const message = getBackendErrorMessage(
                error,
                '正式记录已建立，但附件状态读取失败，请使用原申请重试附件',
              );
              setChangeRequestDraft(submittedDraft);
              setChangeRequestStagedDocuments(submittedStagedDocuments);
              setChangeRequestPartialRecord(failedRecord);
              setChangeRequestRetryAction('retry-same-mutation');
              setChangeRequestServerError(message);
              setChangeRequestResetKey((current) => current + 1);
              changeRequestDialogRef.current?.setOpen(true);
              toast.error(message, { id: toastId });
            });
          return;
        }
        const nextMutationId = createChangeRequestMutationId();
        changeRequestMutationIdRef.current = nextMutationId;
        setChangeRequestOwnerMutationId(nextMutationId);
        setChangeRequestDraft(createChangeRequestDraftForDate(selectedDateKey));
        setChangeRequestStagedDocuments([]);
        setChangeRequestPartialRecord(null);
        setChangeRequestRetryAction(null);
        setChangeRequestResetKey((current) => current + 1);
        toast.success(result.message || '变更申请已同步飞书', { id: toastId });
      } catch (error) {
        if (changeRequestSubmitSeqRef.current !== submitSeq) return;

        const partialFailure = getChangeRequestAttachmentPartialFailure(error);
        if (
          partialFailure &&
          partialFailure.clientMutationId === clientMutationId
        ) {
          const partialRecord = {
            ...partialFailure.record,
            progress:
              partialFailure.recordState === 'unknown'
                ? '提交结果待确认'
                : partialFailure.recordState === 'created'
                  ? '已提交待确认'
                  : '附件待补传',
          };
          deleteChangeRequestOverlay(temporaryId);
          setChangeRequestOverlay(
            partialRecord.bitableRecordId || partialRecord.id,
            partialRecord,
          );
          if (selectedYearRef.current === changeYear) {
            setChanges((current) =>
              reconcilePendingChange(current, temporaryId, partialRecord),
            );
          }
          updateCachedChanges(changeYear, (current) =>
            reconcilePendingChange(current, temporaryId, partialRecord),
          );
          setChangeRequestDraft(submittedDraft);
          setChangeRequestStagedDocuments(submittedStagedDocuments);
          setChangeRequestPartialRecord(partialRecord);
          setChangeRequestRetryAction(partialFailure.retryAction);
          setChangeRequestResetKey((current) => current + 1);
          setChangeRequestServerError(partialFailure.message);
          changeRequestDialogRef.current?.setOpen(true);
          toast.error(partialFailure.message, { id: toastId });
          return;
        }

        if (shouldRetainChangeRequestMutationIdAfterError(error)) {
          const partialRecord = {
            ...pendingChange,
            progress: '提交结果待确认',
            updatedAt: new Date().toISOString(),
          };
          deleteChangeRequestOverlay(temporaryId);
          setChangeRequestOverlay(temporaryId, partialRecord);
          if (selectedYearRef.current === changeYear) {
            setChanges((current) =>
              reconcilePendingChange(current, temporaryId, partialRecord),
            );
          }
          updateCachedChanges(changeYear, (current) =>
            reconcilePendingChange(current, temporaryId, partialRecord),
          );
          const message = getBackendErrorMessage(
            error,
            '网络响应不明确，已保留草稿和原申请标识；请使用原申请标识重试',
          );
          setChangeRequestDraft(submittedDraft);
          setChangeRequestStagedDocuments(submittedStagedDocuments);
          setChangeRequestPartialRecord(partialRecord);
          setChangeRequestRetryAction('retry-same-mutation');
          setChangeRequestResetKey((current) => current + 1);
          setChangeRequestServerError(message);
          changeRequestDialogRef.current?.setOpen(true);
          toast.error(message, { id: toastId });
          return;
        }

        deleteChangeRequestOverlay(temporaryId);
        if (
          partialRecordAtSubmit &&
          !partialRecordAtSubmit.id.startsWith('change-request-pending-')
        ) {
          setChangeRequestOverlay(
            partialRecordAtSubmit.bitableRecordId || partialRecordAtSubmit.id,
            partialRecordAtSubmit,
          );
          if (selectedYearRef.current === changeYear) {
            setChanges((current) =>
              reconcilePendingChange(
                current,
                temporaryId,
                partialRecordAtSubmit,
              ),
            );
          }
          updateCachedChanges(changeYear, (current) =>
            reconcilePendingChange(current, temporaryId, partialRecordAtSubmit),
          );
        } else {
          if (selectedYearRef.current === changeYear) {
            setChanges((current) =>
              rollbackPendingChange(current, temporaryId),
            );
          }
          updateCachedChanges(changeYear, (current) =>
            rollbackPendingChange(current, temporaryId),
          );
        }
        setChangeRequestPartialRecord(null);
        setChangeRequestRetryAction(null);
        const message = getBackendErrorMessage(
          error,
          '变更申请同步失败，已恢复草稿，请检查网络后重试',
        );
        setChangeRequestDraft(submittedDraft);
        setChangeRequestStagedDocuments(submittedStagedDocuments);
        setChangeRequestResetKey((current) => current + 1);
        setChangeRequestServerError(message);
        changeRequestDialogRef.current?.setOpen(true);
        toast.error(message, { id: toastId });
      } finally {
        if (changeRequestSubmitSeqRef.current === submitSeq) {
          changeRequestSubmittingRef.current = false;
          setChangeRequestSubmitting(false);
        }
      }
    },
    [
      canCreateChange,
      changeRequestPartialRecord,
      changeRequestRetryAction,
      changeRequestSubmitting,
      deleteChangeRequestOverlay,
      setChangeRequestOverlay,
    ],
  );

  const openChangeAdjustmentRequest = useCallback(
    (recordId: string | null = null) => {
      if (!canUpdateChange) {
        toast.info('当前为只读模式，不能调整变更');
        return;
      }
      if (!changeAdjustmentRequestRetryBinding) {
        setChangeAdjustmentRequestInitialRecordId(recordId);
        setChangeAdjustmentRequestServerError(null);
      }
      setChangeAdjustmentRequestOpen(true);
    },
    [canUpdateChange, changeAdjustmentRequestRetryBinding],
  );

  const handleSubmitChangeAdjustmentRequest = useCallback(
    async (request: ChangeAdjustmentRequest, original: ChangeInfo) => {
      if (!canUpdateChange) {
        toast.info('当前为只读模式，不能提交变更调整');
        return;
      }
      if (
        changeAdjustmentRequestSubmittingRef.current ||
        changeAdjustmentRequestSubmitting
      ) {
        return;
      }

      const submitSeq = changeAdjustmentRequestSubmitSeqRef.current + 1;
      changeAdjustmentRequestSubmitSeqRef.current = submitSeq;
      changeAdjustmentRequestSubmittingRef.current = true;
      const pending = applyPendingChangeAdjustment(original, request);
      const changeYear =
        getChangeInfoScheduleYear(
          request.plannedDelayStartDate ||
            original.plannedDelayStartDate ||
            original.startDate,
        ) || selectedYearRef.current;
      const toastId = request.clientMutationId;

      flushSync(() => setChangeAdjustmentRequestOpen(false));
      setChangeAdjustmentRequestSubmitting(true);
      setChangeAdjustmentRequestServerError(null);
      setChanges((current) =>
        reconcilePendingChange(current, original.id, pending),
      );
      updateCachedChanges(changeYear, (current) =>
        reconcilePendingChange(current, original.id, pending),
      );
      toast.loading('变更调整正在后台同步…', { id: toastId });

      try {
        const result = await createChangeAdjustment(request);
        if (result.clientMutationId !== request.clientMutationId) {
          throw new Error('服务端返回了不匹配的变更调整标识');
        }
        if (changeAdjustmentRequestSubmitSeqRef.current !== submitSeq) return;

        setChanges((current) =>
          reconcilePendingChange(current, original.id, result.record),
        );
        updateCachedChanges(changeYear, (current) =>
          reconcilePendingChange(current, original.id, result.record),
        );
        const nextMutationId = createChangeAdjustmentMutationId();
        setChangeAdjustmentRequestRetryBinding(null);
        setChangeAdjustmentRequestOwnerMutationId(nextMutationId);
        setChangeAdjustmentRequestInitialRecordId(null);
        toast.success(result.message || '变更调整已完成', { id: toastId });
      } catch (error) {
        if (changeAdjustmentRequestSubmitSeqRef.current !== submitSeq) return;
        const unknownResult =
          shouldRetainChangeRequestMutationIdAfterError(error);
        if (unknownResult) {
          setChangeAdjustmentRequestRetryBinding({ request, original });
        } else {
          setChangeAdjustmentRequestRetryBinding(null);
        }
        const restored = unknownResult
          ? {
              ...pending,
              progress: '调整结果待确认',
              updatedAt: new Date().toISOString(),
            }
          : original;
        setChanges((current) =>
          reconcilePendingChange(current, original.id, restored),
        );
        updateCachedChanges(changeYear, (current) =>
          reconcilePendingChange(current, original.id, restored),
        );
        const message = getBackendErrorMessage(
          error,
          unknownResult
            ? '网络响应不明确，已保留原调整标识和草稿，可安全重试'
            : '变更调整失败，已恢复原记录和当前草稿',
        );
        setChangeAdjustmentRequestServerError(message);
        setChangeAdjustmentRequestInitialRecordId(
          original.bitableRecordId || original.id,
        );
        setChangeAdjustmentRequestOpen(true);
        toast.error(message, { id: toastId });
      } finally {
        if (changeAdjustmentRequestSubmitSeqRef.current === submitSeq) {
          changeAdjustmentRequestSubmittingRef.current = false;
          setChangeAdjustmentRequestSubmitting(false);
        }
      }
    },
    [canUpdateChange, changeAdjustmentRequestSubmitting],
  );

  const handleSubmitChangeDrillReport = useCallback(
    async (request: ChangeDrillReportCreateRequest, original: ChangeInfo) => {
      if (!canSubmitChangeDrillReport) {
        toast.info('当前身份不能提交演练报告');
        return;
      }
      if (
        changeDrillReportSubmittingRef.current ||
        changeDrillReportSubmitting
      ) {
        return;
      }

      const submitSeq = changeDrillReportSubmitSeqRef.current + 1;
      changeDrillReportSubmitSeqRef.current = submitSeq;
      changeDrillReportSubmittingRef.current = true;
      const toastId = request.clientMutationId;

      persistChangeDrillReportRecovery({ request, original });
      flushSync(() => setChangeDrillReportOpen(false));
      setChangeDrillReportSubmitting(true);
      setChangeDrillReportServerError(null);
      toast.loading('演练报告正在后台同步…', { id: toastId });

      try {
        const result = await createChangeDrillReport(request);
        if (result.clientMutationId !== request.clientMutationId) {
          throw new Error('服务端返回了不匹配的演练报告请求标识');
        }
        if (changeDrillReportSubmitSeqRef.current !== submitSeq) return;

        setChangeDrillReportRetryBinding(null);
        clearChangeDrillReportRecovery();
        setChangeDrillReportOwnerMutationId(
          createChangeDrillReportMutationId(),
        );
        toast.success(result.message || '演练报告已同步飞书多维表', {
          id: toastId,
        });
      } catch (error) {
        if (changeDrillReportSubmitSeqRef.current !== submitSeq) return;
        const unknownResult =
          shouldRetainChangeRequestMutationIdAfterError(error);
        const message = getBackendErrorMessage(
          error,
          unknownResult
            ? '网络响应不明确，已保留原请求和附件，可安全重试'
            : '演练报告同步失败，已恢复当前填写内容',
        );
        if (unknownResult) {
          setChangeDrillReportRetryBinding({ request, original });
        } else {
          setChangeDrillReportRetryBinding(null);
          clearChangeDrillReportRecovery();
        }
        setChangeDrillReportServerError(message);
        setChangeDrillReportOpen(true);
        if (unknownResult) {
          toast.warning(message, {
            id: toastId,
            duration: Number.POSITIVE_INFINITY,
          });
        } else {
          toast.error(message, { id: toastId });
        }
      } finally {
        if (changeDrillReportSubmitSeqRef.current === submitSeq) {
          changeDrillReportSubmittingRef.current = false;
          setChangeDrillReportSubmitting(false);
        }
      }
    },
    [canSubmitChangeDrillReport, changeDrillReportSubmitting],
  );

  const upsertChangeSummaryReportBinding = useCallback(
    (binding: ChangeSummaryReportRecoveryBinding) => {
      setChangeSummaryReportRecoveryBindings((current) =>
        upsertChangeSummaryReportRecoveryBinding(current, binding),
      );
    },
    [],
  );

  const removeChangeSummaryReportBinding = useCallback(
    (clientMutationId: string) => {
      setChangeSummaryReportRecoveryBindings((current) =>
        removeChangeSummaryReportRecoveryBinding(current, clientMutationId),
      );
    },
    [],
  );

  const openChangeSummaryReportRecovery = useCallback(
    (binding: ChangeSummaryReportRecoveryBinding) => {
      changeSummaryReportOpenRef.current = true;
      setActiveChangeSummaryReportRetryBinding(binding);
      setChangeSummaryReportOwnerMutationId(binding.request.clientMutationId);
      setChangeSummaryReportServerError(
        binding.error ||
          (binding.state === 'cleanup-required'
            ? '清理尚未完成，请继续清理'
            : binding.state === 'failed'
              ? '上次变更总结提交失败，请重试或重新填写'
              : '上次变更总结结果尚未确认，请重试'),
      );
      setChangeSummaryReportOpen(true);
    },
    [],
  );

  const trackChangeSummaryReportTask = useCallback(
    async (binding: ChangeSummaryReportRecoveryBinding) => {
      const taskId = binding.taskId;
      const taskPrincipalFingerprint = principalFingerprint;
      if (!taskId || !taskPrincipalFingerprint) return;

      const clientMutationId = binding.request.clientMutationId;
      changeSummaryReportTaskRuntimesRef.current
        .get(clientMutationId)
        ?.controller.abort();
      const runtime = {
        seq: changeSummaryReportTaskSeqRef.current + 1,
        controller: new AbortController(),
      };
      changeSummaryReportTaskSeqRef.current = runtime.seq;
      changeSummaryReportTaskRuntimesRef.current.set(clientMutationId, runtime);
      upsertChangeSummaryReportBinding(binding);
      toast.loading('变更总结已提交，后台同步中…', {
        id: clientMutationId,
      });

      try {
        const completed = await pollChangeSummaryReportTask(
          {
            taskId,
            clientMutationId,
            changeRecordId: binding.request.changeRecordId,
          },
          getChangeSummaryReportSyncTaskStatus,
          { signal: runtime.controller.signal },
        );
        if (
          !isCurrentChangeSummaryReportTaskRuntime(
            changeSummaryReportPrincipalFingerprintRef.current,
            taskPrincipalFingerprint,
            changeSummaryReportTaskRuntimesRef.current,
            clientMutationId,
            runtime,
          )
        ) {
          return;
        }

        const markCompleted = (current: ChangeInfo[]) =>
          current.map((change) =>
            change.bitableRecordId === binding.request.changeRecordId
              ? { ...change, hasSummaryReport: true }
              : change,
          );
        setChanges((current) => markCompleted(current));
        const cacheYear = Number(binding.original.startDate.slice(0, 4));
        if (Number.isInteger(cacheYear)) {
          updateCachedChanges(cacheYear, markCompleted);
        }
        const recoveryRemoved = removeChangeSummaryReportRecovery(
          clientMutationId,
          taskPrincipalFingerprint,
        );
        removeChangeSummaryReportBinding(clientMutationId);
        setActiveChangeSummaryReportRetryBinding((current) =>
          current?.request.clientMutationId === clientMutationId
            ? null
            : current,
        );
        if (!recoveryRemoved) {
          toast.warning('变更总结已同步，页面状态未能及时更新，请刷新页面', {
            id: `${clientMutationId}-recovery-warning`,
          });
        }
        toast.success(completed.message || '变更总结已同步', {
          id: clientMutationId,
        });
      } catch (error) {
        if (
          runtime.controller.signal.aborted ||
          !isCurrentChangeSummaryReportTaskRuntime(
            changeSummaryReportPrincipalFingerprintRef.current,
            taskPrincipalFingerprint,
            changeSummaryReportTaskRuntimesRef.current,
            clientMutationId,
            runtime,
          )
        ) {
          return;
        }
        const explicitlyFailed =
          error instanceof ChangeSummaryReportTaskFailedError;
        const message = getBackendErrorMessage(
          error,
          explicitlyFailed
            ? '变更总结同步失败'
            : '变更总结结果暂时无法确认，请安全重试',
        );
        const recoveryBinding: ChangeSummaryReportRecoveryBinding = {
          ...binding,
          state: explicitlyFailed ? 'failed' : 'unknown',
          error: message,
        };
        const recoveryPersisted = persistChangeSummaryReportRecovery(
          recoveryBinding,
          taskPrincipalFingerprint,
        );
        upsertChangeSummaryReportBinding(recoveryBinding);
        const visibleMessage = recoveryPersisted
          ? message
          : `${message}；当前内容未能安全保存，请勿刷新页面`;
        if (!changeSummaryReportOpenRef.current) {
          openChangeSummaryReportRecovery({
            ...recoveryBinding,
            error: visibleMessage,
          });
        }
        if (explicitlyFailed) {
          toast.error(visibleMessage, { id: clientMutationId });
        } else {
          toast.warning(visibleMessage, {
            id: clientMutationId,
            duration: Number.POSITIVE_INFINITY,
          });
        }
      } finally {
        if (
          changeSummaryReportTaskRuntimesRef.current.get(clientMutationId) ===
          runtime
        ) {
          changeSummaryReportTaskRuntimesRef.current.delete(clientMutationId);
        }
      }
    },
    [
      openChangeSummaryReportRecovery,
      principalFingerprint,
      removeChangeSummaryReportBinding,
      upsertChangeSummaryReportBinding,
    ],
  );

  const handleSubmitChangeSummaryReport = useCallback(
    async (
      request: ChangeSummaryReportCreateRequest,
      original: ChangeSummaryReportRecoveryOriginal,
    ) => {
      const submitPrincipalFingerprint = principalFingerprint;
      if (!canSubmitChangeSummaryReport || !submitPrincipalFingerprint) {
        toast.info('当前身份不能提交变更总结');
        return;
      }
      if (changeSummaryReportSubmittingRef.current) return;

      changeSummaryReportSubmittingRef.current = true;
      setChangeSummaryReportSubmitting(true);
      setChangeSummaryReportServerError(null);
      let prepared = false;
      const unknownBinding: ChangeSummaryReportRecoveryBinding = {
        request,
        original,
        state: 'unknown',
      };

      try {
        const accepted = await coordinateChangeSummaryReportAcceptance(
          unknownBinding,
          {
            persist: (binding) =>
              persistChangeSummaryReportRecovery(
                binding,
                submitPrincipalFingerprint,
              ),
            onPrepared: () => {
              prepared = true;
              upsertChangeSummaryReportBinding(unknownBinding);
              changeSummaryReportSubmittingRef.current = false;
              changeSummaryReportOpenRef.current = false;
              flushSync(() => {
                setChangeSummaryReportSubmitting(false);
                setChangeSummaryReportOpen(false);
              });
              setActiveChangeSummaryReportRetryBinding(null);
              setChangeSummaryReportOwnerMutationId(
                createChangeSummaryReportMutationId(),
              );
              toast.loading('变更总结已提交，后台同步中…', {
                id: request.clientMutationId,
              });
            },
            create: createChangeSummaryReport,
          },
        );
        if (
          changeSummaryReportPrincipalFingerprintRef.current !==
          submitPrincipalFingerprint
        ) {
          return;
        }
        upsertChangeSummaryReportBinding(accepted.binding);
        if (!accepted.recoveryPersisted) {
          toast.warning('提交已受理，当前页面将继续跟踪结果，请勿关闭页面', {
            id: `${request.clientMutationId}-recovery-warning`,
            duration: Number.POSITIVE_INFINITY,
          });
        }
        void trackChangeSummaryReportTask(accepted.binding);
      } catch (error) {
        if (
          changeSummaryReportPrincipalFingerprintRef.current !==
          submitPrincipalFingerprint
        ) {
          return;
        }
        const message = getBackendErrorMessage(
          error,
          '变更总结提交失败，请稍后重试',
        );
        if (!prepared) {
          changeSummaryReportSubmittingRef.current = false;
          setChangeSummaryReportSubmitting(false);
          setChangeSummaryReportServerError(message);
          toast.error(message, { id: request.clientMutationId });
          return;
        }

        const outcomeUnknown =
          error instanceof ChangeSummaryReportTaskIdentityError ||
          shouldRetainChangeRequestMutationIdAfterError(error);
        const recoveryBinding: ChangeSummaryReportRecoveryBinding = {
          ...unknownBinding,
          state: outcomeUnknown ? 'unknown' : 'failed',
          error: message,
        };
        const recoveryPersisted = persistChangeSummaryReportRecovery(
          recoveryBinding,
          submitPrincipalFingerprint,
        );
        upsertChangeSummaryReportBinding(recoveryBinding);
        const visibleMessage = recoveryPersisted
          ? message
          : `${message}；当前内容未能安全保存，请勿刷新页面`;
        if (!changeSummaryReportOpenRef.current) {
          openChangeSummaryReportRecovery({
            ...recoveryBinding,
            error: visibleMessage,
          });
        }
        if (outcomeUnknown) {
          toast.warning(visibleMessage, {
            id: request.clientMutationId,
            duration: Number.POSITIVE_INFINITY,
          });
        } else {
          toast.error(visibleMessage, { id: request.clientMutationId });
        }
      }
    },
    [
      canSubmitChangeSummaryReport,
      openChangeSummaryReportRecovery,
      principalFingerprint,
      trackChangeSummaryReportTask,
      upsertChangeSummaryReportBinding,
    ],
  );

  const handleAbandonFailedChangeSummaryReport = useCallback(
    async (binding: ChangeSummaryReportRecoveryBinding) => {
      const abandonPrincipalFingerprint = principalFingerprint;
      if (
        changeSummaryReportAbandonOperationRef.current ||
        !abandonPrincipalFingerprint ||
        (binding.state !== 'failed' && binding.state !== 'cleanup-required')
      ) {
        return;
      }
      const operation: ChangeSummaryReportAbandonOperation = {
        fingerprint: abandonPrincipalFingerprint,
        mutationId: binding.request.clientMutationId,
        token: changeSummaryReportAbandonTokenRef.current + 1,
      };
      changeSummaryReportAbandonTokenRef.current = operation.token;
      changeSummaryReportAbandonOperationRef.current = operation;
      setChangeSummaryReportAbandonOperation(operation);
      try {
        const nextMutationId = await abandonFailedChangeSummaryReport(binding, {
          abandon: abandonChangeSummaryReport,
          removeRecovery: (clientMutationId) =>
            removeChangeSummaryReportRecovery(
              clientMutationId,
              abandonPrincipalFingerprint,
            ),
          createMutationId: createChangeSummaryReportMutationId,
        });
        if (
          !isCurrentChangeSummaryReportAbandonOperation(
            changeSummaryReportPrincipalFingerprintRef.current,
            changeSummaryReportAbandonOperationRef.current,
            operation,
          )
        ) {
          return;
        }
        removeChangeSummaryReportBinding(binding.request.clientMutationId);
        setActiveChangeSummaryReportRetryBinding(null);
        setChangeSummaryReportOwnerMutationId(nextMutationId);
        setChangeSummaryReportServerError(null);
        toast.success('原失败草稿和临时附件已清理，可重新填写');
      } catch (error) {
        if (
          !isCurrentChangeSummaryReportAbandonOperation(
            changeSummaryReportPrincipalFingerprintRef.current,
            changeSummaryReportAbandonOperationRef.current,
            operation,
          )
        ) {
          return;
        }
        const message = getBackendErrorMessage(
          error,
          '清理失败，原草稿已保留，请稍后重试',
        );
        if (error instanceof ChangeSummaryReportCleanupPendingError) {
          const cleanupBinding: ChangeSummaryReportRecoveryBinding = {
            ...binding,
            state: 'cleanup-required',
            error: message,
          };
          persistChangeSummaryReportRecovery(
            cleanupBinding,
            abandonPrincipalFingerprint,
          );
          upsertChangeSummaryReportBinding(cleanupBinding);
          setActiveChangeSummaryReportRetryBinding(cleanupBinding);
        }
        setChangeSummaryReportServerError(message);
        toast.error(message);
      } finally {
        if (
          isCurrentChangeSummaryReportAbandonOperation(
            changeSummaryReportPrincipalFingerprintRef.current,
            changeSummaryReportAbandonOperationRef.current,
            operation,
          )
        ) {
          changeSummaryReportAbandonOperationRef.current = null;
          setChangeSummaryReportAbandonOperation((current) =>
            isCurrentChangeSummaryReportAbandonOperation(
              changeSummaryReportPrincipalFingerprintRef.current,
              current,
              operation,
            )
              ? null
              : current,
          );
        }
      }
    },
    [
      principalFingerprint,
      removeChangeSummaryReportBinding,
      upsertChangeSummaryReportBinding,
    ],
  );

  useEffect(() => {
    const activePrincipalFingerprint = canSubmitChangeSummaryReport
      ? principalFingerprint
      : null;
    if (
      previousChangeSummaryReportPrincipalFingerprintRef.current ===
      activePrincipalFingerprint
    ) {
      return;
    }
    previousChangeSummaryReportPrincipalFingerprintRef.current =
      activePrincipalFingerprint;
    changeSummaryReportRecoveryConsumedRef.current = null;
    changeSummaryReportSubmittingRef.current = false;
    changeSummaryReportOpenRef.current = false;
    disposeChangeSummaryReportTaskRuntimes(
      changeSummaryReportTaskRuntimesRef.current,
      (clientMutationId) => toast.dismiss(clientMutationId),
    );
    changeSummaryReportRecoveryBindingsRef.current.forEach((binding) => {
      const clientMutationId = binding.request.clientMutationId;
      toast.dismiss(clientMutationId);
      toast.dismiss(`${clientMutationId}-recovery-warning`);
    });
    setChangeSummaryReportSubmitting(false);
    changeSummaryReportAbandonOperationRef.current = null;
    setChangeSummaryReportAbandonOperation(null);
    setChangeSummaryReportOpen(false);
    setChangeSummaryReportRecoveryBindings([]);
    setActiveChangeSummaryReportRetryBinding(null);
    setChangeSummaryReportServerError(null);
    setChangeSummaryReportOwnerMutationId(
      createChangeSummaryReportMutationId(),
    );
  }, [canSubmitChangeSummaryReport, principalFingerprint]);

  useEffect(() => {
    const recovery = consumeChangeSummaryReportRecoveryAuthorization(
      canSubmitChangeSummaryReport,
      principalFingerprint || '',
      changeSummaryReportRecoveryConsumedRef.current,
      (fingerprint) => readChangeSummaryReportRecoveries(fingerprint),
    );
    changeSummaryReportRecoveryConsumedRef.current =
      recovery.consumedPrincipalFingerprint;
    if (recovery.bindings.length === 0) return;

    const normalized = recovery.bindings.map((binding) =>
      binding.state === 'pending' && !binding.taskId
        ? {
            ...binding,
            state: 'unknown' as const,
            error: '上次提交结果待确认，请使用原请求安全重试',
          }
        : binding,
    );
    normalized.forEach((binding) => {
      upsertChangeSummaryReportBinding(binding);
      if (binding.state === 'unknown' && !binding.taskId) {
        persistChangeSummaryReportRecovery(binding, principalFingerprint || '');
      }
    });

    const retry =
      normalized.find((binding) => binding.state === 'cleanup-required') ||
      normalized.find((binding) => binding.state === 'failed') ||
      normalized.find(
        (binding) => binding.state === 'unknown' && !binding.taskId,
      );
    if (retry && !changeSummaryReportOpenRef.current) {
      openChangeSummaryReportRecovery(retry);
    }
    normalized
      .filter(
        (binding) =>
          Boolean(binding.taskId) &&
          (binding.state === 'pending' || binding.state === 'unknown'),
      )
      .forEach((binding) => {
        void trackChangeSummaryReportTask(binding);
      });
  }, [
    canSubmitChangeSummaryReport,
    openChangeSummaryReportRecovery,
    principalFingerprint,
    trackChangeSummaryReportTask,
    upsertChangeSummaryReportBinding,
  ]);

  useEffect(
    () => () => {
      changeSummaryReportSubmittingRef.current = false;
      disposeChangeSummaryReportTaskRuntimes(
        changeSummaryReportTaskRuntimesRef.current,
        (clientMutationId) => toast.dismiss(clientMutationId),
      );
      changeSummaryReportRecoveryBindingsRef.current.forEach((binding) => {
        const clientMutationId = binding.request.clientMutationId;
        toast.dismiss(clientMutationId);
        toast.dismiss(`${clientMutationId}-recovery-warning`);
      });
    },
    [],
  );

  const handleSubmitAdditionalMatter = useCallback(async () => {
    if (!canCreateAdditionalMatter) {
      toast.info('当前为只读模式，不能登记其他事宜');
      return;
    }
    if (additionalMatterSubmitting) {
      return;
    }

    const content = additionalMatterContent.trim();
    if (!content) {
      toast.warning('请填写事项内容');
      return;
    }

    const toastId = toast.loading('正在写入其他事宜...');
    setAdditionalMatterSubmitting(true);
    const previousContent = additionalMatterContent;
    setAdditionalMatterContent('');
    setAdditionalMatterDialogOpen(false);

    try {
      const result = await createAdditionalMatter({
        type: additionalMatterMode,
        content,
        date: additionalMatterDate || getTodayDateKey(),
      });
      try {
        await getTodayFocusChecklist(result.date, true);
      } catch (refreshError) {
        logger.warn(
          'Additional matter saved, but today focus checklist pre-refresh failed',
          refreshError,
        );
      }
      notifyTodayFocusChecklistRefresh({
        date: result.date,
        type: result.type,
        recordId: result.recordId,
        updatedAt: Date.now(),
      });
      toast.success(result.message || '其他事宜已登记', { id: toastId });
    } catch (error) {
      setAdditionalMatterContent(previousContent);
      setAdditionalMatterDialogOpen(true);
      logger.error('提交其他事宜补充失败', error);
      toast.error('其他事宜写入失败，请确认多维表权限后重试', { id: toastId });
    } finally {
      setAdditionalMatterSubmitting(false);
    }
  }, [
    additionalMatterContent,
    additionalMatterDate,
    additionalMatterMode,
    additionalMatterSubmitting,
    canCreateAdditionalMatter,
  ]);

  const handleAddSealingRegistrationRow = useCallback(() => {
    setSealingRegistrationRows((current) => {
      const previous = current[current.length - 1];
      return [
        ...current,
        createSealingRegistrationDraftRow(selectedDateKey, {
          startTime: previous?.startTime,
          endTime: previous?.endTime,
        }),
      ];
    });
  }, [selectedDateKey]);

  const handleRemoveSealingRegistrationRow = useCallback((rowId: string) => {
    setSealingRegistrationRows((current) => {
      if (current.length <= 1) {
        return current;
      }
      return current.filter((row) => row.id !== rowId);
    });
  }, []);

  const updateSealingRegistrationRow = useCallback(
    (
      rowId: string,
      patch: Partial<Omit<SealingRegistrationDraftRow, 'id'>>,
    ) => {
      setSealingRegistrationRows((current) =>
        current.map((row) => (row.id === rowId ? { ...row, ...patch } : row)),
      );
    },
    [],
  );

  const handleUpdateSealingRegistrationStartTime = useCallback(
    (rowId: string, value: string) => {
      setSealingRegistrationRows((current) =>
        current.map((row) => {
          if (row.id !== rowId) {
            return row;
          }
          return {
            ...row,
            startTime: value,
            endTime: row.endTime && row.endTime < value ? value : row.endTime,
          };
        }),
      );
    },
    [],
  );

  const handleSubmitSealingRegistration = useCallback(async () => {
    if (!canCreateMonthlySchedule) {
      toast.info('当前为只读模式，不能登记封网信息');
      return;
    }
    if (sealingRegistrationSubmitting) {
      return;
    }

    if (sealingRegistrationRows.length <= 0) {
      toast.warning('请至少添加一条封网信息');
      return;
    }
    const dateTimePattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
    const payloads = sealingRegistrationRows.map((row, index) => ({
      index,
      sealingInfo: row.sealingInfo.trim(),
      startTime: row.startTime,
      endTime: row.endTime,
    }));
    for (const payload of payloads) {
      const displayIndex = payload.index + 1;
      if (!payload.sealingInfo) {
        toast.warning(`请填写第 ${displayIndex} 条封网信息`);
        return;
      }
      if (
        !dateTimePattern.test(payload.startTime) ||
        !dateTimePattern.test(payload.endTime)
      ) {
        toast.warning(`请选择第 ${displayIndex} 条有效的封网开始和结束时间`);
        return;
      }
      if (payload.endTime < payload.startTime) {
        toast.warning(`第 ${displayIndex} 条封网结束时间不能早于开始时间`);
        return;
      }
    }

    const toastId = toast.loading(`正在登记 ${payloads.length} 条封网信息...`);
    setSealingRegistrationSubmitting(true);
    const previousRows = sealingRegistrationRows;
    const optimisticIds = payloads.map(
      (payload) => `optimistic-sealing-${Date.now()}-${payload.index}`,
    );
    const optimisticSealings: SealingInfo[] = payloads.map(
      (payload, index) => ({
        id: optimisticIds[index],
        bitableRecordId: optimisticIds[index],
        sealingCode: '',
        sealingName: payload.sealingInfo,
        startDate: new Date(payload.startTime).toISOString(),
        endDate: new Date(payload.endTime).toISOString(),
        sealingType: payload.sealingInfo.includes('强管控')
          ? '强管控'
          : payload.sealingInfo.includes('弱管控')
            ? '弱管控'
            : null,
        autoNumber: null,
        isToday:
          selectedDateKey >= payload.startTime.slice(0, 10) &&
          selectedDateKey <= payload.endTime.slice(0, 10),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    );
    setSealings((current) => [...current, ...optimisticSealings]);
    setSealingRegistrationRows([
      createSealingRegistrationDraftRow(selectedDateKey),
    ]);
    setSealingRegistrationDialogOpen(false);

    try {
      const results = await Promise.all(
        payloads.map((payload) =>
          createSealingRegistration({
            sealingInfo: payload.sealingInfo,
            startTime: payload.startTime,
            endTime: payload.endTime,
          }),
        ),
      );
      setSealings((current) =>
        current.map((sealing) => {
          const optimisticIndex = optimisticIds.indexOf(sealing.id);
          if (optimisticIndex < 0) return sealing;
          const result = results[optimisticIndex];
          return {
            ...sealing,
            id: result.recordId,
            bitableRecordId: result.recordId,
            sealingName: result.sealingInfo,
            startDate: result.startTime,
            endDate: result.endTime,
            updatedAt: new Date().toISOString(),
          };
        }),
      );
      yearlySealingCache.clear();
      void loadSealingInfo(true);
      toast.success(`已登记 ${payloads.length} 条封网信息，页面已即时更新`, {
        id: toastId,
      });
    } catch (error) {
      const optimisticIdSet = new Set(optimisticIds);
      setSealings((current) =>
        current.filter((sealing) => !optimisticIdSet.has(sealing.id)),
      );
      setSealingRegistrationRows(previousRows);
      setSealingRegistrationDialogOpen(true);
      logger.error('提交封网登记失败', error);
      toast.error('封网登记失败，请确认多维表权限和字段后重试', {
        id: toastId,
      });
    } finally {
      setSealingRegistrationSubmitting(false);
    }
  }, [
    canCreateMonthlySchedule,
    loadSealingInfo,
    sealingRegistrationRows,
    sealingRegistrationSubmitting,
    selectedDateKey,
  ]);

  const upsertExceptionFollowUpItem = useCallback(
    (item: ExceptionFollowUpItem) => {
      setExceptionFollowUpsByKey((current) =>
        upsertExceptionFollowUpItemInIndex(current, item),
      );
    },
    [setExceptionFollowUpsByKey],
  );

  const removeExceptionFollowUpItem = useCallback(
    (item: ExceptionFollowUpItem) => {
      setExceptionFollowUpsByKey((current) =>
        removeExceptionFollowUpItemFromIndex(current, item),
      );
    },
    [setExceptionFollowUpsByKey],
  );

  const openCreateExceptionFollowUpDialog = useCallback(
    (target: ExceptionFollowUpTarget) => {
      if (!canCreateException) {
        toast.info('当前为只读模式，不能登记异常跟进');
        return;
      }
      setExceptionFollowUpTarget({
        ...target,
        existingFollowUp: null,
      });
      setExceptionFollowUpHandling('');
    },
    [canCreateException],
  );

  const openEditExceptionFollowUpDialog = useCallback(
    (target: ExceptionFollowUpTarget, item: ExceptionFollowUpItem) => {
      if (!canUpdateException) {
        toast.info('当前为只读模式，不能修改异常跟进');
        return;
      }
      setExceptionFollowUpTarget({
        ...target,
        existingFollowUp: item,
      });
      setExceptionFollowUpHandling(item.handling || '');
    },
    [canUpdateException],
  );

  const handleSubmitExceptionFollowUp = useCallback(async () => {
    if (!(exceptionFollowUpTarget?.existingFollowUp ? canUpdateException : canCreateException)) {
      toast.info('当前为只读模式，不能写入异常跟进');
      return;
    }
    if (!exceptionFollowUpTarget || exceptionFollowUpSubmitting) {
      return;
    }

    const handling = exceptionFollowUpHandling.trim();
    if (!handling) {
      toast.warning('请填写处理方式和措施');
      return;
    }

    const existingRecordId = exceptionFollowUpTarget.existingFollowUp?.recordId;
    const toastId = toast.loading(
      existingRecordId ? '正在更新异常跟进...' : '正在登记异常跟进...',
    );
    setExceptionFollowUpSubmitting(true);
    const previousTarget = exceptionFollowUpTarget;
    const previousItem = previousTarget.existingFollowUp || null;
    const optimisticRecordId =
      existingRecordId || `optimistic-follow-up-${Date.now()}`;
    const optimisticItem: ExceptionFollowUpItem = {
      recordId: optimisticRecordId,
      type: previousTarget.type,
      typeLabel:
        previousItem?.typeLabel ||
        (previousTarget.type === 'schedule' ? '排班' : '封网/变更'),
      abnormalLabel: previousTarget.abnormalLabel,
      date: previousTarget.date,
      detail: previousTarget.detail,
      detailedContent: previousTarget.detail,
      handling,
      matchKey: previousTarget.matchKey,
      createdAt: previousItem?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    upsertExceptionFollowUpItem(optimisticItem);
    setExceptionFollowUpTarget(null);
    setExceptionFollowUpHandling('');

    try {
      const payload = {
        type: previousTarget.type,
        abnormalLabel: previousTarget.abnormalLabel,
        date: previousTarget.date,
        detail: previousTarget.detail,
        handling,
      };
      const result = existingRecordId
        ? await updateExceptionFollowUp({
            ...payload,
            recordId: existingRecordId,
            previousHandling: previousItem?.handling,
          })
        : await createExceptionFollowUp(payload);

      toast.success(result.message || '异常跟进已保存', { id: toastId });
      if (!existingRecordId) {
        removeExceptionFollowUpItem(optimisticItem);
      }
      upsertExceptionFollowUpItem(result.item);
    } catch (error) {
      removeExceptionFollowUpItem(optimisticItem);
      if (previousItem) {
        upsertExceptionFollowUpItem(previousItem);
      }
      setExceptionFollowUpTarget(previousTarget);
      setExceptionFollowUpHandling(handling);
      logger.error('提交异常跟进失败', error);
      toast.error(
        getBackendErrorMessage(
          error,
          '异常跟进提交失败，请确认多维表权限后重试',
        ),
        { id: toastId },
      );
    } finally {
      setExceptionFollowUpSubmitting(false);
    }
  }, [
    canUpdateException,
    canCreateException,
    exceptionFollowUpHandling,
    exceptionFollowUpSubmitting,
    exceptionFollowUpTarget,
    removeExceptionFollowUpItem,
    upsertExceptionFollowUpItem,
  ]);

  const handleDeleteExceptionFollowUpItem = useCallback(
    async (target: ExceptionFollowUpTarget, item: ExceptionFollowUpItem) => {
      if (!canDeleteException) {
        toast.info('当前权限不能删除异常跟进');
        return;
      }
      if (exceptionFollowUpSubmitting) {
        return;
      }
      if (!window.confirm('确定删除这条异常跟进记录吗？')) {
        return;
      }

      const toastId = toast.loading('正在删除异常跟进...');
      setExceptionFollowUpSubmitting(true);
      removeExceptionFollowUpItem(item);
      if (
        exceptionFollowUpTarget?.existingFollowUp?.recordId === item.recordId
      ) {
        setExceptionFollowUpTarget(null);
        setExceptionFollowUpHandling('');
      }

      try {
        const result = await deleteExceptionFollowUp({
          recordId: item.recordId,
          type: target.type,
          abnormalLabel: target.abnormalLabel,
          date: target.date,
          detail: target.detail,
          handling: item.handling,
        });

        toast.success(result.message || '异常跟进已删除', { id: toastId });
      } catch (error) {
        upsertExceptionFollowUpItem(item);
        setExceptionFollowUpTarget(target);
        setExceptionFollowUpHandling(item.handling);
        logger.error('删除异常跟进失败', error);
        toast.error(
          getBackendErrorMessage(
            error,
            '异常跟进删除失败，请确认多维表权限后重试',
          ),
          { id: toastId },
        );
      } finally {
        setExceptionFollowUpSubmitting(false);
      }
    },
    [
      canDeleteException,
      exceptionFollowUpSubmitting,
      exceptionFollowUpTarget,
      removeExceptionFollowUpItem,
      upsertExceptionFollowUpItem,
    ],
  );

  const handleDeleteExceptionFollowUp = useCallback(async () => {
    const target = exceptionFollowUpTarget;
    const existingFollowUp = target?.existingFollowUp;

    if (!target || !existingFollowUp) {
      return;
    }
    await handleDeleteExceptionFollowUpItem(target, existingFollowUp);
  }, [exceptionFollowUpTarget, handleDeleteExceptionFollowUpItem]);

  const openChangeAdjustmentDialog = useCallback(
    (target: ChangeAdjustmentTarget) => {
      openChangeAdjustmentRequest(
        target.change.bitableRecordId || target.change.id,
      );
    },
    [openChangeAdjustmentRequest],
  );

  const handleSubmitChangeAdjustment = useCallback(async () => {
    if (!canUpdateChange) {
      toast.info('当前为只读模式，不能提交变更调整');
      return;
    }
    if (!changeAdjustmentTarget || changeAdjustmentSubmitting) {
      return;
    }

    const startValue = changeAdjustmentDraft.startNoAdjustment
      ? null
      : changeAdjustmentDraft.startValue.trim();
    const endValue = changeAdjustmentDraft.endNoAdjustment
      ? null
      : changeAdjustmentDraft.endValue.trim();

    if (!changeAdjustmentDraft.startNoAdjustment && !startValue) {
      toast.warning('请选择延期开始时间，或勾选无调整');
      return;
    }
    if (!changeAdjustmentDraft.endNoAdjustment && !endValue) {
      toast.warning('请选择延期结束时间，或勾选无调整');
      return;
    }
    if (
      startValue &&
      endValue &&
      new Date(endValue).getTime() < new Date(startValue).getTime()
    ) {
      toast.warning('延期结束不能早于延期开始');
      return;
    }

    const recordId =
      changeAdjustmentTarget.change.bitableRecordId ||
      changeAdjustmentTarget.change.id;
    const toastId = toast.loading('正在提交变更计划调整...');
    setChangeAdjustmentSubmitting(true);
    const previousTarget = changeAdjustmentTarget;
    const previousMessage = changeAdjustmentMessages[recordId];
    const optimisticMessage =
      startValue || endValue
        ? formatChangeAdjustmentMessage(startValue, endValue)
        : '变更计划无需调整';
    setChangeAdjustmentMessages((current) => ({
      ...current,
      [recordId]: optimisticMessage,
    }));
    setChanges((current) =>
      current.map((change) =>
        (change.bitableRecordId || change.id) === recordId
          ? {
              ...change,
              plannedDelayStartDate: startValue || change.plannedDelayStartDate,
              plannedDelayEndDate: endValue || change.plannedDelayEndDate,
            }
          : change,
      ),
    );
    setChangeAdjustmentTarget(null);

    try {
      const result = await updateChangeScheduleAdjustment({
        recordId,
        plannedDelayStartDate: startValue,
        plannedDelayEndDate: endValue,
      });
      const message =
        startValue || endValue
          ? formatChangeAdjustmentMessage(
              result.plannedDelayStartDate,
              result.plannedDelayEndDate,
            )
          : result.message;

      setChangeAdjustmentMessages((current) => ({
        ...current,
        [recordId]: message,
      }));
      setChanges((current) =>
        current.map((change) => {
          if ((change.bitableRecordId || change.id) !== recordId) {
            return change;
          }
          return {
            ...change,
            plannedDelayStartDate: result.plannedDelayStartDate,
            plannedDelayEndDate: result.plannedDelayEndDate,
          };
        }),
      );

      if (startValue || endValue) {
        yearlyChangeCache.delete(selectedDate.getFullYear());
        void loadChangeInfo(true);
      }

      toast.success(message, { id: toastId });
    } catch (error) {
      setChanges((current) =>
        current.map((change) =>
          (change.bitableRecordId || change.id) === recordId
            ? previousTarget.change
            : change,
        ),
      );
      setChangeAdjustmentMessages((current) => {
        const next = { ...current };
        if (previousMessage === undefined) {
          delete next[recordId];
        } else {
          next[recordId] = previousMessage;
        }
        return next;
      });
      setChangeAdjustmentTarget(previousTarget);
      logger.error('提交变更计划调整失败', error);
      toast.error(
        getBackendErrorMessage(error, '变更计划调整失败，请稍后重试'),
        { id: toastId },
      );
    } finally {
      setChangeAdjustmentSubmitting(false);
    }
  }, [
    canUpdateChange,
    changeAdjustmentMessages,
    changeAdjustmentDraft,
    changeAdjustmentSubmitting,
    changeAdjustmentTarget,
    loadChangeInfo,
    selectedDate,
  ]);

  const handleClearChangeAdjustment = useCallback(
    async (change: ChangeInfo) => {
      if (!canDeleteChange) {
        toast.info('当前权限不能撤销变更调整');
        return;
      }
      if (changeAdjustmentSubmitting) {
        return;
      }

      const recordId = change.bitableRecordId || change.id;
      const toastId = toast.loading('正在撤销变更计划调整...');
      setChangeAdjustmentSubmitting(true);
      const previousMessage = changeAdjustmentMessages[recordId];
      setChangeAdjustmentMessages((current) => {
        const next = { ...current };
        delete next[recordId];
        return next;
      });
      setChanges((current) =>
        current.map((item) =>
          (item.bitableRecordId || item.id) === recordId
            ? {
                ...item,
                plannedDelayStartDate: null,
                plannedDelayEndDate: null,
              }
            : item,
        ),
      );

      try {
        const result = await updateChangeScheduleAdjustment({
          recordId,
          clearAdjustment: true,
        });

        setChangeAdjustmentMessages((current) => {
          const next = { ...current };
          delete next[recordId];
          return next;
        });
        setChanges((current) =>
          current.map((item) =>
            (item.bitableRecordId || item.id) === recordId
              ? {
                  ...item,
                  plannedDelayStartDate: null,
                  plannedDelayEndDate: null,
                }
              : item,
          ),
        );
        yearlyChangeCache.delete(selectedDate.getFullYear());
        void loadChangeInfo(true);
        toast.success(result.message || '已撤销变更计划调整', { id: toastId });
      } catch (error) {
        setChanges((current) =>
          current.map((item) =>
            (item.bitableRecordId || item.id) === recordId ? change : item,
          ),
        );
        if (previousMessage !== undefined) {
          setChangeAdjustmentMessages((current) => ({
            ...current,
            [recordId]: previousMessage,
          }));
        }
        logger.error('撤销变更计划调整失败', error);
        toast.error(
          getBackendErrorMessage(error, '撤销变更计划调整失败，请稍后重试'),
          { id: toastId },
        );
      } finally {
        setChangeAdjustmentSubmitting(false);
      }
    },
    [
      canDeleteChange,
      changeAdjustmentMessages,
      changeAdjustmentSubmitting,
      loadChangeInfo,
      selectedDate,
    ],
  );

  const currentMonthLabel = `${selectedDate.getFullYear()}年${selectedDate.getMonth() + 1}月`;

  const renderExceptionFollowUpBadge = useCallback(
    (
      items: ExceptionFollowUpItem[],
      target: ExceptionFollowUpTarget,
      className = '',
    ) => {
      const latest = items[0];
      if (!latest) {
        return null;
      }
      const syncing = items.some(item => item.recordId.startsWith('optimistic-follow-up-'));

      return (
        <HoverCard openDelay={120} closeDelay={120}>
          <HoverCardTrigger asChild>
            <button
              type="button"
              onClick={() => {
                if (canUpdateException) {
                  openEditExceptionFollowUpDialog(target, latest);
                }
              }}
              className={cn(
                'shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold transition-colors',
                'bg-blue-50 text-blue-700 border border-blue-200',
                canUpdateException
                  ? 'hover:bg-blue-100'
                  : 'cursor-default',
                className,
              )}
            >
              {syncing ? '同步中' : items.length > 1 ? `已跟进 ${items.length}` : '已跟进'}
            </button>
          </HoverCardTrigger>
          <HoverCardContent
            className="w-96 max-w-[calc(100vw-2rem)] border-blue-100 p-3 text-sm shadow-lg"
            side="top"
            align="end"
          >
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-3">
                <span className="font-semibold text-blue-700">
                  {syncing ? '跟进同步中' : '已跟进处理'}
                </span>
                <span className="text-xs text-slate-400">
                  {items.length} 条
                </span>
              </div>
              <div className="max-h-64 space-y-2 overflow-y-auto pr-1">
                {items.map((item, index) => (
                  <div
                    key={item.recordId}
                    className="rounded-lg bg-slate-50 px-2.5 py-2 text-xs leading-5 text-slate-600"
                  >
                    <div className="mb-1 flex items-center justify-between gap-2">
                      <span className="font-semibold text-emerald-700">
                        跟进 {index + 1}
                      </span>
                      <span className="text-slate-400">
                        {formatExceptionFollowUpTime(item)}
                      </span>
                    </div>
                    <div className="whitespace-pre-wrap">{item.handling}</div>
                    {canUpdateException && (
                      <div className="mt-2 flex justify-end">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={exceptionFollowUpSubmitting}
                          onClick={() =>
                            openEditExceptionFollowUpDialog(target, item)
                          }
                          className="h-7 border-emerald-200 bg-white px-2 text-xs font-semibold text-emerald-700 hover:bg-emerald-50 hover:text-emerald-800"
                        >
                          <PencilLine className="mr-1 h-3 w-3" />
                          修改
                        </Button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </HoverCardContent>
        </HoverCard>
      );
    },
    [
      canUpdateException,
      exceptionFollowUpSubmitting,
      openEditExceptionFollowUpDialog,
    ],
  );

  const renderExceptionFollowUpRecords = useCallback(
    (items: ExceptionFollowUpItem[], target: ExceptionFollowUpTarget) => {
      if (items.length === 0) {
        return null;
      }

      return (
        <div className="mt-2 rounded-lg border border-blue-100 bg-blue-50/60 px-2.5 py-2">
          <div className="mb-2 flex items-center justify-between gap-2 text-xs font-semibold text-blue-700">
            <span>{items.some(item => item.recordId.startsWith('optimistic-follow-up-')) ? '跟进同步中' : '已跟进处理'}</span>
            <span>{items.length} 条</span>
          </div>
          <div className="space-y-2">
            {items.map((item, index) => (
              <div
                key={item.recordId}
                className="rounded-md border border-emerald-100 bg-white px-2.5 py-2"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0 flex-1 whitespace-pre-wrap text-xs leading-5 text-emerald-800">
                    <span className="mr-1 font-semibold">
                      跟进 {index + 1}：
                    </span>
                    {item.handling}
                  </div>
                  {(canUpdateException || canDeleteException) && (
                    <div className="flex shrink-0 items-center gap-1">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={exceptionFollowUpSubmitting || !canUpdateException}
                        onClick={() =>
                          openEditExceptionFollowUpDialog(target, item)
                        }
                        className="h-7 border-emerald-200 px-2 text-xs font-semibold text-emerald-700 hover:bg-emerald-50 hover:text-emerald-800"
                      >
                        <PencilLine className="mr-1 h-3 w-3" />
                        修改
                      </Button>
                      {canDeleteException && (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={exceptionFollowUpSubmitting}
                          onClick={() =>
                            handleDeleteExceptionFollowUpItem(target, item)
                          }
                          className="h-7 border-red-200 px-2 text-xs font-semibold text-red-600 hover:bg-red-50 hover:text-red-700"
                        >
                          <Trash2 className="mr-1 h-3 w-3" />
                          删除
                        </Button>
                      )}
                    </div>
                  )}
                </div>
                {formatExceptionFollowUpTime(item) && (
                  <div className="mt-1 text-[11px] text-emerald-500">
                    {formatExceptionFollowUpTime(item)}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      );
    },
    [
      canDeleteException,
      canUpdateException,
      exceptionFollowUpSubmitting,
      handleDeleteExceptionFollowUpItem,
      openEditExceptionFollowUpDialog,
    ],
  );

  const visibleScheduleDates = useMemo(() => {
    const center = new Date(
      selectedDate.getFullYear(),
      selectedDate.getMonth(),
      selectedDate.getDate(),
    );

    return Array.from(
      { length: 11 },
      (_, index) =>
        new Date(
          center.getFullYear(),
          center.getMonth(),
          center.getDate() + index - 5,
        ),
    );
  }, [selectedDate]);

  const StatusCalendarDayButton = useCallback(
    (props: React.ComponentProps<typeof CalendarDayButton>) => {
      const date = props.day.date;
      const dateStr = formatDateKey(date);
      const sealing = getSealingInfoByDate(dateStr);
      const holiday = getHolidayInfo(dateStr);
      const isWeekend = date.getDay() === 0 || date.getDay() === 6;
      const isSelected = Boolean(props.modifiers?.selected);
      const isTodayDate = dateStr === formatDateKey(new Date());
      const isRestDay =
        holiday.isHoliday || (isWeekend && !holiday.isAdjustedWorkday);
      const isAdjustedWorkday = holiday.isAdjustedWorkday;
      const statusClassName = sealing
        ? 'border-rose-200 bg-rose-50/80 text-rose-700 hover:bg-rose-50'
        : holiday.isHoliday
          ? 'border-rose-200/80 bg-rose-50/70 text-rose-600 hover:bg-rose-50'
          : isAdjustedWorkday
            ? 'border-blue-200/80 bg-blue-50/55 text-blue-700 hover:bg-blue-50/75'
            : isWeekend
              ? 'border-emerald-200/60 bg-emerald-50/45 text-emerald-700 hover:bg-emerald-50/70'
              : '';
      const selectedClassName = isSelected
        ? 'border-blue-300 bg-gradient-to-br from-blue-50 via-white to-emerald-50 text-blue-700 shadow-[inset_0_0_0_1px_rgba(37,99,235,0.24),0_8px_20px_rgba(37,99,235,0.10)] data-[selected-single=true]:!bg-blue-50 data-[selected-single=true]:!text-blue-700 hover:from-blue-50 hover:to-emerald-50'
        : '';
      const restWorkBadge = isAdjustedWorkday
        ? { label: '班', className: 'text-blue-600' }
        : isRestDay
          ? { label: '休', className: 'text-rose-500' }
          : null;
      const badges = [
        sealing
          ? { key: 'sealing', label: '封网', className: 'text-rose-600' }
          : null,
        holiday.isHoliday
          ? {
              key: 'holiday',
              label: holiday.name || '节假日',
              className: 'text-amber-700',
            }
          : null,
        isAdjustedWorkday
          ? {
              key: 'adjusted-workday',
              label: '调休上班',
              className: 'text-blue-600',
            }
          : null,
      ].filter(
        (item): item is { key: string; label: string; className: string } =>
          Boolean(item),
      );

      const title = [
        sealing?.sealingName,
        holiday.isHoliday ? holiday.name : null,
        isAdjustedWorkday ? '调休上班' : null,
        !holiday.isHoliday && isWeekend ? '周末' : null,
      ]
        .filter(Boolean)
        .join(' · ');

      const handleDayButtonClick: React.MouseEventHandler<HTMLButtonElement> = (
        event,
      ) => {
        props.onClick?.(event);
        if (!props.modifiers?.disabled) {
          handleDateClick(date);
        }
      };

      const dayButton = (
        <CalendarDayButton
          {...props}
          onClick={handleDayButtonClick}
          title={title || props.title}
          className={cn(
            'relative min-h-9 rounded-md border border-transparent px-1 text-slate-700 [&>span]:!opacity-100',
            statusClassName,
            selectedClassName,
            props.className,
          )}
        >
          {restWorkBadge && (
            <span
              className={cn(
                'absolute right-1 top-0.5 !text-[10px] font-bold leading-none',
                restWorkBadge.className,
              )}
            >
              {restWorkBadge.label}
            </span>
          )}
          {isTodayDate && (
            <span className="absolute left-1 top-0.5 !text-[10px] font-bold leading-none text-blue-600">
              今
            </span>
          )}
          <span
            className={cn(
              'mt-0.5 !text-[17px] font-semibold leading-none',
              isRestDay && 'text-rose-500',
              isAdjustedWorkday && 'text-blue-700',
              isWeekend && !isRestDay && !isAdjustedWorkday && 'text-slate-700',
            )}
          >
            {date.getDate()}
          </span>
          {badges.length > 0 && (
            <span className="mt-0.5 flex flex-col items-center gap-0">
              {badges.map((badge) => (
                <span
                  key={badge.key}
                  className={cn(
                    'text-[9.5px] font-semibold leading-none whitespace-nowrap',
                    badge.className,
                  )}
                >
                  {badge.label}
                </span>
              ))}
            </span>
          )}
        </CalendarDayButton>
      );

      if (!sealing) {
        return dayButton;
      }

      return (
        <div className="group relative h-full">
          {dayButton}
          <div className="pointer-events-none absolute bottom-[calc(100%+8px)] left-1/2 z-30 hidden w-72 -translate-x-1/2 rounded-xl border border-rose-100 bg-white p-3 text-left shadow-xl shadow-rose-100/50 group-hover:block group-focus-within:block">
            <div className="mb-2 flex items-center gap-2 border-b border-rose-100 pb-2">
              <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-rose-50 text-xs font-bold text-rose-600">
                封
              </span>
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold text-rose-700">
                  {sealing.sealingName}
                </div>
                <div className="mt-0.5 text-[11px] text-slate-400">
                  封网信息
                </div>
              </div>
            </div>
            <div className="space-y-1.5 text-xs text-slate-600">
              <div className="flex justify-between gap-3">
                <span className="text-slate-400">开始</span>
                <span className="font-medium text-slate-700">
                  {formatSealingDateTime(sealing.startDate)}
                </span>
              </div>
              <div className="flex justify-between gap-3">
                <span className="text-slate-400">结束</span>
                <span className="font-medium text-slate-700">
                  {formatSealingDateTime(sealing.endDate)}
                </span>
              </div>
              {sealing.sealingType && (
                <div className="flex justify-between gap-3">
                  <span className="text-slate-400">类型</span>
                  <span className="rounded bg-rose-50 px-1.5 py-0.5 font-medium text-rose-600">
                    {sealing.sealingType}
                  </span>
                </div>
              )}
              {sealing.autoNumber && (
                <div className="flex justify-between gap-3">
                  <span className="text-slate-400">编号</span>
                  <span className="font-medium text-slate-700">
                    {sealing.autoNumber}
                  </span>
                </div>
              )}
            </div>
            <div className="absolute left-1/2 top-full h-3 w-3 -translate-x-1/2 -translate-y-1/2 rotate-45 border-b border-r border-rose-100 bg-white" />
          </div>
        </div>
      );
    },
    [getSealingInfoByDate],
  );

  const calendarDayDataRef = useRef({getCalendarChangeInfoByDate, getSealingInfoByDate});
  calendarDayDataRef.current = {getCalendarChangeInfoByDate, getSealingInfoByDate};
  const StatusCalendarDayButtonWithChanges = useCallback(
    (props: React.ComponentProps<typeof CalendarDayButton>) => {
      const {getCalendarChangeInfoByDate, getSealingInfoByDate} = calendarDayDataRef.current;
      const date = props.day.date;
      const dateStr = formatDateKey(date);
      const sealing = getSealingInfoByDate(dateStr);
      const changeSummary = getCalendarChangeInfoByDate(dateStr);
      const holiday = getHolidayInfo(dateStr);
      const isWeekend = date.getDay() === 0 || date.getDay() === 6;
      const isSelected = Boolean(props.modifiers?.selected);
      const isTodayDate = dateStr === formatDateKey(new Date());
      const isRestDay =
        holiday.isHoliday || (isWeekend && !holiday.isAdjustedWorkday);
      const isAdjustedWorkday = holiday.isAdjustedWorkday;
      const hasChange = changeSummary.all.length > 0;
      const hasKeyChange = changeSummary.keyCount > 0;
      const riskCount = changeSummary.riskCount;
      const hasConflict = changeSummary.conflictCount > 0;
      const hasFollowedUp = changeSummary.followedUpCount > 0;
      const hasAnyReminder = changeSummary.reminderCount > 0;
      const hasReminder = !hasConflict && hasAnyReminder;
      const hasRisk = !hasConflict && !hasAnyReminder && riskCount > 0;
      const changeLevelLabel = getTopChangeLevelLabel(changeSummary.all);
      const statusClassName = hasConflict
        ? 'border-slate-200 bg-red-50/40 text-slate-800 hover:bg-red-50/55'
        : hasFollowedUp
          ? 'border-blue-200 bg-blue-50/40 text-blue-700 hover:bg-blue-50/60'
        : sealing
          ? 'border-rose-200 bg-rose-50/75 text-rose-700 hover:bg-rose-50/90'
          : hasReminder
            ? 'border-amber-300 bg-amber-50/85 text-amber-700 shadow-[0_0_0_2px_rgba(245,158,11,0.08)] hover:bg-amber-50'
            : hasRisk
              ? 'border-orange-200 bg-orange-50/75 text-orange-700 shadow-[0_0_0_2px_rgba(249,115,22,0.08)] hover:bg-orange-50'
              : hasKeyChange
                ? 'border-blue-200 bg-blue-50/60 text-blue-700 hover:bg-blue-50/75'
                : hasChange
                  ? 'border-sky-100 bg-sky-50/45 text-sky-700 hover:bg-sky-50/65'
                  : holiday.isHoliday
                    ? 'border-rose-100 bg-rose-50/55 text-rose-600 hover:bg-rose-50/70'
                    : isAdjustedWorkday
                      ? 'border-blue-100 bg-blue-50/45 text-blue-700 hover:bg-blue-50/65'
                      : isWeekend
                        ? 'border-emerald-100 bg-emerald-50/35 text-emerald-700 hover:bg-emerald-50/55'
                        : '';
      const selectedClassName = isSelected
        ? hasConflict
          ? 'border-blue-300 bg-gradient-to-br from-blue-50 via-white to-rose-50 text-blue-800 shadow-[inset_0_0_0_1px_rgba(37,99,235,0.20),0_8px_20px_rgba(37,99,235,0.10)] data-[selected-single=true]:!bg-blue-50 data-[selected-single=true]:!text-blue-800 hover:from-blue-50 hover:to-rose-50'
          : hasFollowedUp
            ? 'border-blue-300 bg-blue-50 text-blue-700 data-[selected-single=true]:!bg-blue-50 data-[selected-single=true]:!text-blue-700'
          : sealing
            ? 'border-rose-300 bg-rose-50 text-rose-700 shadow-[inset_0_0_0_1px_rgba(244,63,94,0.24),0_8px_20px_rgba(244,63,94,0.10)] data-[selected-single=true]:!bg-rose-50 data-[selected-single=true]:!text-rose-700 hover:bg-rose-50'
            : hasReminder
              ? 'border-amber-400 bg-amber-50 text-amber-700 shadow-[inset_0_0_0_1px_rgba(245,158,11,0.30),0_8px_20px_rgba(245,158,11,0.12)] data-[selected-single=true]:!bg-amber-50 data-[selected-single=true]:!text-amber-700 hover:bg-amber-50'
              : hasRisk
                ? 'border-orange-300 bg-orange-50 text-orange-700 shadow-[inset_0_0_0_1px_rgba(249,115,22,0.26),0_8px_20px_rgba(249,115,22,0.10)] data-[selected-single=true]:!bg-orange-50 data-[selected-single=true]:!text-orange-700 hover:bg-orange-50'
                : 'border-blue-300 bg-gradient-to-br from-blue-50 via-white to-emerald-50 text-blue-700 shadow-[inset_0_0_0_1px_rgba(37,99,235,0.24),0_8px_20px_rgba(37,99,235,0.10)] data-[selected-single=true]:!bg-blue-50 data-[selected-single=true]:!text-blue-700 hover:from-blue-50 hover:to-emerald-50'
        : '';
      const todayClassName = isTodayDate
        ? 'ring-2 ring-blue-400/75 ring-offset-1 ring-offset-white'
        : '';
      const restWorkBadge = isAdjustedWorkday
        ? { label: '班', className: 'text-blue-600' }
        : isRestDay
          ? { label: '休', className: 'text-rose-500' }
          : null;
      const badges = [
        hasConflict
          ? { key: 'change-conflict', label: '冲突', className: 'text-red-600' }
          : null,
        hasReminder
          ? {
              key: 'change-reminder',
              label: '提醒',
              className: 'text-amber-600',
            }
          : null,
        hasRisk
          ? { key: 'staff-risk', label: '风险', className: 'text-orange-600' }
          : null,
        sealing
          ? { key: 'sealing', label: '封网', className: 'text-rose-600' }
          : null,
        hasChange
          ? {
              key: 'change',
              label: changeLevelLabel || '变更',
              className: hasKeyChange ? 'text-blue-700' : 'text-sky-700',
            }
          : null,
        holiday.isHoliday
          ? {
              key: 'holiday',
              label: holiday.name || '节假日',
              className: 'text-amber-700',
            }
          : null,
        isAdjustedWorkday
          ? {
              key: 'adjusted-workday',
              label: '调休上班',
              className: 'text-blue-600',
            }
          : null,
      ].filter(
        (item): item is { key: string; label: string; className: string } =>
          Boolean(item),
      );
      const primaryDayBadge = hasConflict
        ? {
            label: '冲突',
            className:
              'border border-red-200 bg-red-50 text-red-700 shadow-none',
          }
        : hasReminder
          ? {
              label: '提醒',
              className: 'bg-amber-500 text-white shadow-amber-100',
            }
          : hasRisk
            ? {
                label: '风险',
                className: 'bg-orange-500 text-white shadow-orange-100',
              }
            : hasFollowedUp
              ? {label: '已跟进', className: 'border border-blue-200 bg-blue-50 text-blue-700 shadow-none'}
            : hasChange
              ? {
                  label: changeLevelLabel || '变更',
                  className: hasKeyChange
                    ? 'bg-blue-600 text-white shadow-blue-100'
                    : 'bg-sky-600 text-white shadow-sky-100',
                }
              : null;
      const statusDots = [
        sealing ? { key: 'sealing', className: 'bg-rose-500' } : null,
        holiday.isHoliday
          ? { key: 'holiday', className: 'bg-amber-400' }
          : null,
      ].filter((item): item is { key: string; className: string } =>
        Boolean(item),
      );
      const title = [
        hasConflict ? `冲突 ${changeSummary.conflictCount} 项` : null,
        hasFollowedUp ? `已跟进 ${changeSummary.followedUpCount} 项` : null,
        hasAnyReminder
          ? `封网或变更重叠提醒 ${changeSummary.reminderCount} 项`
          : null,
        riskCount > 0 ? `排班连班风险 ${riskCount} 项` : null,
        hasChange ? `计划变更 ${changeSummary.all.length} 项` : null,
        sealing?.sealingName,
        holiday.isHoliday ? holiday.name : null,
        isAdjustedWorkday ? '调休上班' : null,
        !holiday.isHoliday && isWeekend ? '周末' : null,
      ]
        .filter(Boolean)
        .join(' · ');

      const handleDayButtonClick: React.MouseEventHandler<HTMLButtonElement> = (
        event,
      ) => {
        props.onClick?.(event);
        if (!props.modifiers?.disabled) {
          handleDateClick(date);
        }
      };

      const dayButton = (
        <CalendarDayButton
          {...props}
          onClick={handleDayButtonClick}
          title={title || props.title}
          className={cn(
            'relative grid !h-full min-h-[4.1rem] !min-w-0 !aspect-auto grid-rows-[0.85rem_1fr_1.05rem] items-center justify-items-center overflow-hidden rounded-lg border border-transparent px-1 py-1 text-slate-700 [&>span]:!opacity-100',
            statusClassName,
            selectedClassName,
            todayClassName,
            props.className,
          )}
        >
          {hasConflict && (
            <span
              aria-hidden="true"
              className="pointer-events-none absolute right-1 top-1 z-10 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-red-500 text-[10px] font-bold leading-none text-white shadow-sm"
            >
              !
            </span>
          )}
          <span className="flex h-[0.85rem] w-full items-start justify-center leading-none">
            {restWorkBadge && (
              <span
                className={cn(
                  '!text-[10px] font-bold leading-none',
                  restWorkBadge.className,
                )}
              >
                {restWorkBadge.label}
              </span>
            )}
          </span>
          <span
            className={cn(
              '!text-[18px] font-semibold leading-none',
              isRestDay && 'text-rose-500',
              isAdjustedWorkday && 'text-blue-700',
              isWeekend && !isRestDay && !isAdjustedWorkday && 'text-slate-700',
            )}
          >
            {date.getDate()}
          </span>
          {primaryDayBadge ? (
            <span
              className={cn(
                'flex h-4 max-w-full items-center rounded-full px-1.5 text-[9px] font-semibold leading-none shadow-sm',
                primaryDayBadge.className,
              )}
            >
              {primaryDayBadge.label}
            </span>
          ) : statusDots.length > 0 ? (
            <span className="flex h-4 items-center justify-center gap-1">
              {statusDots.map((dot) => (
                <span
                  key={dot.key}
                  className={cn('h-1.5 w-1.5 rounded-full', dot.className)}
                />
              ))}
            </span>
          ) : (
            <span className="h-4" />
          )}
          {false && badges.length > 0 && (
            <span className="mt-0.5 flex flex-col items-center gap-0">
              {badges.map((badge) => (
                <span
                  key={badge.key}
                  className={cn(
                    'text-[9.5px] font-semibold leading-none whitespace-nowrap',
                    badge.className,
                  )}
                >
                  {badge.label}
                </span>
              ))}
            </span>
          )}
        </CalendarDayButton>
      );

      if (!sealing && changeSummary.detail.length === 0 && riskCount === 0) {
        return dayButton;
      }

      const previewStaffConflicts = changeSummary.staffConflicts.slice(0, 2);
      const previewChangeItems = changeSummary.detail.slice(0, 2);
      const remainingPreviewCount =
        changeSummary.detail.length - previewChangeItems.length;

      return (
        <CalendarDayPreview renderPreview={() => (
          <div
            className={cn(
              'pointer-events-none absolute bottom-[calc(100%+8px)] left-1/2 z-[90] hidden w-72 -translate-x-1/2 rounded-xl border bg-white p-3 text-left shadow-xl group-hover:block group-focus-within:block',
              hasConflict
                ? 'border-red-200 shadow-red-100/70'
                : hasReminder
                  ? 'border-amber-200 shadow-amber-100/70'
                  : hasRisk
                    ? 'border-orange-200 shadow-orange-100/70'
                    : 'border-blue-100 shadow-blue-100/60',
            )}
          >
            {sealing && (
              <div className="rounded-lg border border-rose-100 bg-rose-50/70 p-2">
                <div className="flex items-center gap-2">
                  <span className="shrink-0 rounded bg-rose-600 px-1.5 py-0.5 text-[10px] font-semibold text-white">
                    封
                  </span>
                  <div className="min-w-0 truncate text-xs font-semibold text-rose-700">
                    {sealing.sealingName}
                  </div>
                </div>
                <div className="mt-1 truncate text-[11px] text-rose-600">
                  {formatSealingDateTime(sealing.startDate)} -{' '}
                  {formatSealingDateTime(sealing.endDate)}
                </div>
              </div>
            )}
            {previewStaffConflicts.length > 0 && (
              <div
                className={cn(
                  'space-y-1.5',
                  (sealing || previewChangeItems.length > 0) && 'mt-2',
                )}
              >
                {previewStaffConflicts.map((conflict) => (
                  <div
                    key={conflict.id}
                    className="rounded-lg border border-orange-100 bg-orange-50/80 p-2 text-xs"
                  >
                    <div className="flex items-center gap-2">
                      <span className="shrink-0 rounded bg-orange-500 px-1.5 py-0.5 text-[10px] font-semibold text-white">
                        风
                      </span>
                      <div className="min-w-0 truncate font-semibold text-slate-800">
                        {conflict.staffName} 连班
                      </div>
                    </div>
                    <div className="mt-1 truncate text-[11px] text-orange-600">
                      {conflict.previousBuildingLabel}
                      {conflict.previousShiftLabel} →{' '}
                      {conflict.currentBuildingLabel}
                      {conflict.currentShiftLabel}
                    </div>
                  </div>
                ))}
              </div>
            )}
            {previewChangeItems.length > 0 && (
              <div
                className={cn(
                  'space-y-1.5',
                  (sealing || previewStaffConflicts.length > 0) && 'mt-2',
                )}
              >
                {previewChangeItems.map(
                  ({
                    change,
                    conflictSealings,
                    reminderSealings,
                    overlapChanges,
                    followUp,
                  }) => {
                    const itemHasConflict = followUp.hasConflict;
                    const itemHasReminder = followUp.hasReminder;
                    return (
                      <div
                        key={change.id}
                        className={cn(
                          'rounded-lg border p-2 text-xs',
                          itemHasConflict
                            ? 'border-red-100 bg-red-50/80'
                            : itemHasReminder
                              ? 'border-amber-100 bg-amber-50/80'
                              : 'border-blue-100 bg-blue-50/70',
                        )}
                      >
                        <div className="flex items-center gap-2">
                          <span
                            className={cn(
                              'shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold text-white',
                              itemHasConflict
                                ? 'bg-red-600'
                                : itemHasReminder
                                  ? 'bg-amber-500'
                                  : 'bg-blue-600',
                            )}
                          >
                            {followUp.status === 'followed-up'
                              ? '已跟进'
                              : itemHasConflict
                              ? '冲'
                              : itemHasReminder
                                ? '提'
                                : '变'}
                          </span>
                          <div className="min-w-0 truncate font-semibold text-slate-800">
                            {change.title}
                          </div>
                        </div>
                        <div className="mt-1 truncate text-[11px] text-slate-500">
                          {formatSealingDateTime(change.startDate)} -{' '}
                          {formatSealingDateTime(change.endDate)}
                        </div>
                        {itemHasConflict && (
                          <div className="mt-1 truncate text-[11px] font-medium text-red-600">
                            与封网「{formatChangeRelationList(conflictSealings)}
                            」时间冲突
                          </div>
                        )}
                        {itemHasReminder && reminderSealings.length > 0 && (
                          <div className="mt-1 truncate text-[11px] font-medium text-amber-600">
                            当日有封网「
                            {formatChangeRelationList(reminderSealings)}
                            」，注意执行窗口
                          </div>
                        )}
                        {itemHasReminder && overlapChanges.length > 0 && (
                          <div className="mt-1 truncate text-[11px] font-medium text-amber-600">
                            与变更「{formatChangeRelationList(overlapChanges)}
                            」时间重叠
                          </div>
                        )}
                      </div>
                    );
                  },
                )}
              </div>
            )}
            {remainingPreviewCount > 0 && (
              <div className="mt-2 rounded-lg bg-slate-50 px-2 py-1.5 text-center text-[11px] font-medium text-slate-500">
                另有 {remainingPreviewCount} 项，点击日期查看详情
              </div>
            )}
            {hasConflict && (
              <div className="mt-2 rounded-lg bg-red-600 px-2 py-1.5 text-center text-[11px] font-semibold text-white">
                存在冲突，点击日期查看详情
              </div>
            )}
            {hasFollowedUp && (
              <div className="mt-2 rounded-lg border border-blue-100 bg-blue-50 px-2 py-1.5 text-center text-[11px] font-semibold text-blue-700">
                已跟进 {changeSummary.followedUpCount} 项
              </div>
            )}
            {hasReminder && (
              <div className="mt-2 rounded-lg bg-amber-500 px-2 py-1.5 text-center text-[11px] font-semibold text-white">
                封网或变更重叠提醒
              </div>
            )}
            {hasRisk && (
              <div className="mt-2 rounded-lg bg-orange-500 px-2 py-1.5 text-center text-[11px] font-semibold text-white">
                存在排班连班风险
              </div>
            )}
            <div
              className={cn(
                'absolute left-1/2 top-full h-3 w-3 -translate-x-1/2 -translate-y-1/2 rotate-45 border-b border-r bg-white',
                hasConflict
                  ? 'border-red-100'
                  : hasReminder
                    ? 'border-amber-100'
                    : hasRisk
                      ? 'border-orange-100'
                      : 'border-blue-100',
              )}
            />
          </div>
        )}>
          {dayButton}
        </CalendarDayPreview>
      );
    },
    [handleDateClick],
  );

  const calendarTodayKey = formatDateKey(new Date());
  const mainScheduleCalendar = useMemo(() => (
    <Calendar
      key={`${selectedDate.getFullYear()}-${selectedDate.getMonth()}`}
      onMonthChange={setCalendarFollowUpMonth}
      mode="single"
      selected={selectedDate}
      onSelect={(date) => {
        if (date) {
          handleDateClick(date);
        }
      }}
      defaultMonth={selectedDate}
      formatters={CHINESE_CALENDAR_FORMATTERS}
      components={{ Root: StableScheduleCalendarRoot, DayButton: StatusCalendarDayButtonWithChanges }}
      data-schedule-main-calendar="true"
      className="w-full rounded-lg bg-transparent p-1"
      style={{ '--cell-size': '4.1rem' } as React.CSSProperties}
      classNames={{
        root: 'w-full',
          months: 'relative w-full',
        month: 'w-full gap-2',
        month_grid: 'w-full border-collapse',
        table: 'w-full border-collapse',
        weekdays: 'grid grid-cols-7 gap-1',
        weekday:
          'text-center text-xs font-semibold text-slate-500 [&:first-child]:text-rose-500 [&:last-child]:text-rose-500',
        week: 'grid grid-cols-7 gap-1',
        day: 'min-h-[4.1rem] min-w-0 p-0',
        caption_label: 'text-base font-semibold text-slate-800',
      }}
    />
  ), [selectedDate, handleDateClick, StatusCalendarDayButtonWithChanges,
    getCalendarChangeInfoByDate, getSealingInfoByDate, setCalendarFollowUpMonth,
    calendarTodayKey, workCalendarRevision]);

  const scheduleRangeLabel = `${visibleScheduleDates[0].getMonth() + 1}月${visibleScheduleDates[0].getDate()}日 - ${
    visibleScheduleDates[10].getMonth() + 1
  }月${visibleScheduleDates[10].getDate()}日`;

  const CompactCalendarDayButton = useCallback(
    (props: React.ComponentProps<typeof CalendarDayButton>) => {
      const {getCalendarChangeInfoByDate, getSealingInfoByDate} = calendarDayDataRef.current;
      const date = props.day.date;
      const summary = getCalendarChangeInfoByDate(formatDateKey(date));
      const sealing = getSealingInfoByDate(formatDateKey(date));
      const status = summary.conflictCount > 0 ? {label:`待跟进冲突 ${summary.conflictCount} 项`,color:'bg-red-500'}
        : summary.reminderCount > 0 ? {label:`提醒 ${summary.reminderCount} 项`,color:'bg-amber-500'}
        : summary.riskCount > 0 ? {label:`风险 ${summary.riskCount} 项`,color:'bg-orange-500'}
        : summary.followedUpCount > 0 ? {label:`已跟进 ${summary.followedUpCount} 项`,color:'bg-blue-500'}
        : sealing ? {label:'封网',color:'bg-rose-400'}
        : summary.all.length > 0 ? {label:`变更 ${summary.all.length} 项`,color:'bg-sky-400'} : null;
      return <CalendarDayButton {...props}
        title={`${formatDateKey(date)}${status ? ` · ${status.label}` : ''}`}
        className={cn('relative !h-10 !min-w-0 !w-full !aspect-auto !gap-0 rounded-md !p-0 !font-medium data-[selected-single=true]:!bg-blue-600 data-[selected-single=true]:!text-white',props.className)}
      >
        <span className="!text-sm !opacity-100">{date.getDate()}</span>
        {status && <span aria-hidden="true" className={cn('absolute bottom-1 h-1 w-1 rounded-full',props.modifiers.selected ? 'bg-white' : status.color)} />}
      </CalendarDayButton>;
    }, [],
  );

  const calendarWeatherSection = (
    <section className="duty-calendar-weather-section mb-5 rounded-xl border border-blue-100 bg-white p-2.5 shadow-sm">
      <div className="mb-2 flex justify-start">
        <div className="flex flex-wrap items-center justify-start gap-2 text-[11px]">
          <span className="duty-status-pill duty-status-pill-sealing rounded-md border border-rose-200 bg-rose-50 px-2.5 py-1 text-center font-semibold text-rose-700">
            封网
          </span>
          <span className="duty-status-pill rounded-md border border-sky-200 bg-sky-50 px-2.5 py-1 text-center font-semibold text-sky-700">
            变更
          </span>
          <span className="duty-status-pill rounded-md border border-red-600 bg-red-600 px-2.5 py-1 text-center font-semibold text-white shadow-sm">
            冲突
          </span>
          <span className="duty-status-pill rounded-md border border-amber-300 bg-amber-50 px-2.5 py-1 text-center font-semibold text-amber-700">
            提醒
          </span>
          <span className="duty-status-pill rounded-md border border-orange-200 bg-orange-50 px-2.5 py-1 text-center font-semibold text-orange-700">
            风险
          </span>
          <span className="duty-status-pill duty-status-pill-holiday rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1 text-center font-semibold text-amber-700">
            节假日
          </span>
          <span className="duty-status-pill duty-status-pill-rest rounded-md border border-rose-200 bg-rose-50 px-2.5 py-1 text-center font-semibold text-rose-700">
            休
          </span>
          <span className="duty-status-pill duty-status-pill-work rounded-md border border-blue-200 bg-blue-50 px-2.5 py-1 text-center font-semibold text-blue-700">
            班
          </span>
          <span className="duty-status-pill duty-status-pill-weekend rounded-md border border-emerald-200/70 bg-emerald-50/60 px-2.5 py-1 text-center font-semibold text-emerald-700">
            周末
          </span>
          <span className="duty-status-pill duty-status-pill-current rounded-md bg-blue-50 px-3 py-1 text-xs font-medium text-blue-700">
            当前中心日：{selectedDate.getFullYear()}年
            {selectedDate.getMonth() + 1}月{selectedDate.getDate()}日
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={handleToday}
            className="duty-calendar-action-button duty-calendar-action-button-today h-8"
          >
            回到今天
          </Button>
          {canUseSelfServiceTools && (
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger asChild>
                <Button
                  ref={commonToolsTriggerRef}
                  variant="outline"
                  size="sm"
                  data-screenshot-hidden="true"
                  className="duty-calendar-action-button h-8 border-blue-200 bg-white text-blue-700 hover:bg-blue-50"
                >
                  <Wrench className="mr-1.5 h-3.5 w-3.5" />
                  常用工具
                </Button>
              </DropdownMenuTrigger>
              {!leaveRequestDialogOpen && (
              <DropdownMenuContent
                align="start"
                sideOffset={6}
                className="min-w-44 rounded-lg border-blue-100 bg-white p-1 shadow-lg"
                data-screenshot-hidden="true"
                onCloseAutoFocus={(event) => {
                  if (leaveRequestMenuHandoffRef.current) {
                    event.preventDefault();
                    leaveRequestMenuHandoffRef.current = false;
                  }
                }}
              >
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger className="gap-2 rounded-md px-3 py-2 text-sm text-blue-700 focus:bg-blue-50 focus:text-blue-700 data-[state=open]:bg-blue-50 data-[state=open]:text-blue-700">
                    <UserCog className="h-3.5 w-3.5" />
                    人员相关
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent className="min-w-48 rounded-lg border-blue-100 bg-white p-1 shadow-lg">
                    {canCreateLeaveRequest && (<DropdownMenuItem
                      onSelect={() => {
                        if (selfServiceOnly && !selfServiceIdentityReady) { toast.info(selfServiceIdentity?.error || '正在核对本人身份与班次，请稍候'); return; }
                        if (access.isLoading) {
                          toast.info('正在确认登录状态，请稍候');
                          return;
                        }
                        if (leaveApplicant.mode === 'login') {
                          requestLogin(leaveApplicant.message, '/monthly-schedule');
                          return;
                        }
                        if (leaveApplicant.mode === 'error') {
                          toast.error(leaveApplicant.message);
                          return;
                        }
                        if (
                          !leaveRequestMutationBindingRef.current &&
                          !recoveredLeaveRequestMutationId
                        ) {
                          setLeaveStartAt('');
                          setLeaveEndAt('');
                          setLeaveRequestSyncStatus('idle');
                          setLeaveRequestRecoveryState(null);
                          setLeaveScheduleCoverageReadyKey(null);
                        }
                        refreshBusinessClock();
                        leaveRequestMenuHandoffRef.current = true;
                        leaveRequestReturnFocusRef.current = commonToolsTriggerRef.current;
                        setLeaveRequestDialogOpen(true);
                      }}
                      className="flex cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-sm text-blue-700 focus:bg-blue-50 focus:text-blue-700"
                    >
                      <CalendarClock className="h-3.5 w-3.5" />
                      请休假&差旅申请
                    </DropdownMenuItem>)}
                    {canCreateOvertimeRequest && (<DropdownMenuItem
                      onSelect={() => {
                        if (selfServiceOnly && !selfServiceIdentityReady) { toast.info(selfServiceIdentity?.error || '正在核对本人身份与班次，请稍候'); return; }
                        refreshBusinessClock();
                        overtimeRequestDialogRef.current?.open();
                      }}
                      className="flex cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-sm text-blue-700 focus:bg-blue-50 focus:text-blue-700"
                    >
                      <CalendarClock className="h-3.5 w-3.5" />
                      加班申请
                    </DropdownMenuItem>)}
                    <DropdownMenuItem
                      onSelect={() =>
                        employeeOnboardingDialogRef.current?.open(
                          commonToolsTriggerRef.current,
                        )
                      }
                      className="flex cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-sm text-blue-700 focus:bg-blue-50 focus:text-blue-700"
                    >
                      <UserPlus className="h-3.5 w-3.5" />
                      新员工入职
                    </DropdownMenuItem>
                    {canCreatePersonality && (<DropdownMenuItem
                      onSelect={() => navigate('/mbti-assessment')}
                      className="flex cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-sm text-blue-700 focus:bg-blue-50 focus:text-blue-700"
                    >
                      <ClipboardList className="h-3.5 w-3.5" />
                      MBTI 测试
                    </DropdownMenuItem>)}
                    {(canManageMonthlySchedule || canCreateMonthlySchedule || canReadTimeInsights) && (
                      <>
                        {canReadTimeInsights && (<DropdownMenuItem
                          onSelect={() => setPersonnelTimeInsightsDialogOpen(true)}
                          className="flex cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-sm text-blue-700 focus:bg-blue-50 focus:text-blue-700"
                        >
                          <BarChart3 className="h-3.5 w-3.5" />
                          人员工时与休假分析
                        </DropdownMenuItem>)}
                        {(canManageMonthlySchedule || canCreateMonthlySchedule) && (<DropdownMenuItem
                          onSelect={() => {
                            setStaffAdjustmentMode(canManageMonthlySchedule ? 'vacancy' : 'emergency');
                            setRepairDate(selectedDateKey);
                            setVacancyDialogOpen(true);
                          }}
                          className="flex cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-sm text-blue-700 focus:bg-blue-50 focus:text-blue-700"
                        >
                          <UserCog className="h-3.5 w-3.5" />
                          排班人员调整
                        </DropdownMenuItem>)}
                        {canManageMonthlySchedule && (<DropdownMenuItem
                          onSelect={() => {
                            setPersonnelMovementDate(selectedDateKey);
                            setPersonnelMovementDialogOpen(true);
                          }}
                          className="flex cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-sm text-blue-700 focus:bg-blue-50 focus:text-blue-700"
                        >
                          <UserCog className="h-3.5 w-3.5" />
                          人员异动
                        </DropdownMenuItem>)}
                      </>
                    )}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger className="gap-2 rounded-md px-3 py-2 text-sm text-blue-700 focus:bg-blue-50 focus:text-blue-700 data-[state=open]:bg-blue-50 data-[state=open]:text-blue-700">
                    <Wrench className="h-3.5 w-3.5" />
                    运维相关
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent className="min-w-48 rounded-lg border-blue-100 bg-white p-1 shadow-lg">
                    <DropdownMenuSub>
                      <DropdownMenuSubTrigger className="gap-2 rounded-md px-3 py-2 text-sm text-blue-700 focus:bg-blue-50 focus:text-blue-700 data-[state=open]:bg-blue-50 data-[state=open]:text-blue-700">
                        <Wrench className="h-3.5 w-3.5" />
                        变更相关
                      </DropdownMenuSubTrigger>
                      <DropdownMenuSubContent className="min-w-48 rounded-lg border-blue-100 bg-white p-1 shadow-lg">
                        {canCreateChange && (<DropdownMenuItem
                          disabled={changeRequestSubmitting}
                          onSelect={() => {
                            changeRequestDialogRef.current?.setOpen(true);
                          }}
                          className="flex cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-sm text-blue-700 focus:bg-blue-50 focus:text-blue-700"
                        >
                          <Wrench className="h-3.5 w-3.5" />
                          变更申请
                        </DropdownMenuItem>)}
                        {canUpdateChange && (
                          <DropdownMenuItem
                            disabled={changeAdjustmentRequestSubmitting}
                            onSelect={() => openChangeAdjustmentRequest()}
                            className="flex cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-sm text-blue-700 focus:bg-blue-50 focus:text-blue-700"
                          >
                            <CalendarClock className="h-3.5 w-3.5" />
                            变更调整
                          </DropdownMenuItem>
                        )}
                        {canSubmitChangeDrillReport && (
                          <DropdownMenuItem
                            disabled={changeDrillReportSubmitting}
                            onSelect={() => {
                              if (!changeDrillReportRetryBinding) {
                                setChangeDrillReportServerError(null);
                              }
                              setChangeDrillReportOpen(true);
                            }}
                            className="flex cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-sm text-blue-700 focus:bg-blue-50 focus:text-blue-700"
                          >
                            <ClipboardCheck className="h-3.5 w-3.5" />
                            {changeDrillReportRetryBinding
                              ? '演练提交（待确认）'
                              : '演练提交'}
                          </DropdownMenuItem>
                        )}
                        {canSubmitChangeSummaryReport && (
                          <DropdownMenuItem
                            onSelect={() => {
                              const retryBinding =
                                changeSummaryReportRecoveryBindings.find(
                                  (binding) =>
                                    binding.state === 'cleanup-required',
                                ) ||
                                changeSummaryReportRecoveryBindings.find(
                                  (binding) => binding.state === 'failed',
                                ) ||
                                changeSummaryReportRecoveryBindings.find(
                                  (binding) =>
                                    binding.state === 'unknown' &&
                                    !changeSummaryReportTaskRuntimesRef.current.has(
                                      binding.request.clientMutationId,
                                    ),
                                );
                              if (retryBinding) {
                                openChangeSummaryReportRecovery(retryBinding);
                                return;
                              }
                              changeSummaryReportOpenRef.current = true;
                              setActiveChangeSummaryReportRetryBinding(null);
                              setChangeSummaryReportServerError(null);
                              setChangeSummaryReportOwnerMutationId(
                                createChangeSummaryReportMutationId(),
                              );
                              setChangeSummaryReportOpen(true);
                              void loadChangeInfo(true);
                            }}
                            className="flex cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-sm text-blue-700 focus:bg-blue-50 focus:text-blue-700"
                          >
                            <ClipboardList className="h-3.5 w-3.5" />
                            {changeSummaryReportRecoveryBindings.some(
                              (binding) =>
                                binding.state === 'failed' ||
                                binding.state === 'cleanup-required',
                            )
                              ? '变更总结（待重试）'
                              : '变更总结'}
                          </DropdownMenuItem>
                        )}
                      </DropdownMenuSubContent>
                    </DropdownMenuSub>
                    {canCreateThresholdAdjustment && (<DropdownMenuItem
                      onSelect={() => {
                        setThresholdAdjustmentDialogOpen(true);
                      }}
                      className="flex cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-sm text-blue-700 focus:bg-blue-50 focus:text-blue-700"
                    >
                      <Bell className="h-3.5 w-3.5" />
                      阈值调整
                    </DropdownMenuItem>)}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
                {(canCreateMonthlySchedule || canCreateAdditionalMatter || canRefreshMonthlySchedule || canSendMonthlySchedule || canUsePageAction(access, 'monthly_reports', 'read', capabilities.canEdit)) && (
                  <>
                    <DropdownMenuSub>
                      <DropdownMenuSubTrigger className="gap-2 rounded-md px-3 py-2 text-sm text-blue-700 focus:bg-blue-50 focus:text-blue-700 data-[state=open]:bg-blue-50 data-[state=open]:text-blue-700">
                        <ClipboardPlus className="h-3.5 w-3.5" />
                        其他事宜
                      </DropdownMenuSubTrigger>
                      <DropdownMenuSubContent className="min-w-48 rounded-lg border-blue-100 bg-white p-1 shadow-lg">
                        {canCreateMonthlySchedule && (<DropdownMenuItem
                          onSelect={() => {
                            setSealingRegistrationRows([
                              createSealingRegistrationDraftRow(
                                selectedDateKey,
                              ),
                            ]);
                            setSealingRegistrationDialogOpen(true);
                          }}
                          className="flex cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-sm text-blue-700 focus:bg-blue-50 focus:text-blue-700"
                        >
                          <ShieldAlert className="h-3.5 w-3.5" />
                          封网登记
                        </DropdownMenuItem>)}
                        {canUsePageAction(access, 'monthly_reports', 'read', capabilities.canEdit) && (<DropdownMenuItem
                          onSelect={() => {
                            navigate('/ali-monthly-report');
                          }}
                          className="flex cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-sm text-blue-700 focus:bg-blue-50 focus:text-blue-700"
                        >
                          <FileSpreadsheet className="h-3.5 w-3.5" />
                          阿里月报生成
                        </DropdownMenuItem>)}
                        {canCreateAdditionalMatter && (<DropdownMenuItem
                          onSelect={() => {
                            setAdditionalMatterDate(getTodayDateKey());
                            setAdditionalMatterDialogOpen(true);
                          }}
                          className="flex cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-sm text-blue-700 focus:bg-blue-50 focus:text-blue-700"
                        >
                          <ClipboardPlus className="h-3.5 w-3.5" />
                          其他事宜
                        </DropdownMenuItem>)}
                      </DropdownMenuSubContent>
                    </DropdownMenuSub>
                    <DropdownMenuSub>
                      <DropdownMenuSubTrigger className="gap-2 rounded-md px-3 py-2 text-sm text-blue-700 focus:bg-blue-50 focus:text-blue-700 data-[state=open]:bg-blue-50 data-[state=open]:text-blue-700">
                        <RefreshCw className="h-3.5 w-3.5" />
                        同步相关
                      </DropdownMenuSubTrigger>
                      <DropdownMenuSubContent className="min-w-48 rounded-lg border-blue-100 bg-white p-1 shadow-lg">
                        {canRefreshMonthlySchedule && (<DropdownMenuItem
                          disabled={manualSyncing}
                          onSelect={() => {
                            void handleManualSync();
                          }}
                          className="flex cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-sm text-blue-700 focus:bg-blue-50 focus:text-blue-700"
                        >
                          {manualSyncing ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <RefreshCw className="h-3.5 w-3.5" />
                          )}
                          {manualSyncing ? '同步中...' : '同步本地库'}
                        </DropdownMenuItem>)}
                        {canSendMonthlySchedule && (<DropdownMenuItem
                          disabled={manualScreenshotSending}
                          onSelect={() => {
                            void handleManualScreenshot();
                          }}
                          className="flex cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-sm text-blue-700 focus:bg-blue-50 focus:text-blue-700"
                        >
                          {manualScreenshotSending ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Camera className="h-3.5 w-3.5" />
                          )}
                          {manualScreenshotSending
                            ? '发送中...'
                            : '发送今日截图'}
                        </DropdownMenuItem>)}
                      </DropdownMenuSubContent>
                    </DropdownMenuSub>
                  </>
                )}
              </DropdownMenuContent>
              )}
            </DropdownMenu>
          )}
        </div>
      </div>
      <div className="grid duty-calendar-weather-grid items-stretch gap-3">
        <div className="duty-calendar-panel h-full w-full min-w-0 rounded-xl border border-slate-100 bg-slate-50/40 p-2">
          {calendarFollowUps.error && <div role="alert" className="mb-2 flex items-center justify-between gap-2 rounded-md border border-red-100 bg-red-50 px-2 py-1 text-xs text-red-700"><span>{calendarFollowUps.error}</span><button type="button" className="shrink-0 underline" onClick={()=>void calendarFollowUps.reload()}>重新读取</button></div>}
          {mainScheduleCalendar}
        </div>
        <section
          ref={weatherGuardRegistrationFallbackRef}
          tabIndex={-1}
          aria-label="天气预警与戒备区域"
          className="duty-calendar-weather-side flex h-full min-w-0 self-stretch flex-col gap-3 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2"
        >
          <WeatherTrendPanel
            weatherSnapshot={weatherSnapshot}
            onLoadStateChange={handleWeatherTrendLoadStateChange}
            onRegisterGuard={
              weatherGuardRegistrationEnabled
                ? handleWeatherGuardRegistrationOpen
                : undefined
            }
          />
          <WeatherWarningSnapshotSummary
            warningSnapshot={weatherSnapshot.warningSnapshot}
            warningStatus={weatherSnapshot.warningStatus}
            warningError={weatherSnapshot.warningError}
            warningFailureKind={weatherSnapshot.warningFailureKind}
            onRegisterGuard={
              weatherGuardRegistrationEnabled
                ? handleWeatherGuardRegistrationOpen
                : undefined
            }
          />
        </section>
      </div>
    </section>
  );

  return (
    <div
      className={cn(
        'container mx-auto max-w-7xl space-y-6 p-4',
        isScreenshotMode && 'duty-screenshot-mode',
      )}
    >
      <Card
        data-screenshot-target="duty-overview"
        data-screenshot-ready={
          isDutyOverviewScreenshotReady(screenshotReadiness) ? 'true' : 'false'
        }
      >
        <CardHeader>
          <div className="duty-overview-header relative flex flex-col items-center gap-4 md:flex-row md:items-center md:justify-center">
            {/* 左侧：VNET Logo - 绝对定位 */}
            <div className="duty-overview-logo md:absolute md:left-0 flex items-center">
              <UniversalLink
                to="/"
                className="flex-shrink-0 transition-opacity hover:opacity-80"
              >
                <img
                  src="https://miaoda.feishu.cn/aily/api/v1/feisuda/attachments/24f756a2-a583-4438-b8b8-6f4cdb736595/raw"
                  alt="VNET"
                  className="h-10 w-auto"
                />
              </UniversalLink>
            </div>

            {/* 中间：月份选择控件 - 居中 */}
            <div className="flex items-center gap-2">
              <Button variant="outline" size="icon" onClick={handlePrevMonth}>
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline" className="w-[140px]">
                    {currentMonthLabel}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <Calendar
                    mode="single"
                    required
                    selected={selectedDate}
                    onSelect={handleDateClick}
                    onMonthChange={setCalendarFollowUpMonth}
                    defaultMonth={selectedDate}
                    className="w-[min(20rem,calc(100vw-2rem))] p-3"
                    style={{'--cell-size':'2.5rem'} as React.CSSProperties}
                    classNames={{root:'w-full',months:'relative w-full',month:'flex w-full flex-col gap-2',weekdays:'grid grid-cols-7 gap-1',weekday:'text-center text-xs font-normal text-slate-500',week:'mt-1 grid grid-cols-7 gap-1',day:'relative h-10 w-full !aspect-auto p-0 text-center',month_caption:'flex h-10 items-center justify-center px-10',caption_label:'text-sm font-semibold',button_previous:'h-8 w-8 p-0',button_next:'h-8 w-8 p-0'}}
                    formatters={CHINESE_CALENDAR_FORMATTERS}
                    components={{
                      Root: StableScheduleCalendarRoot,
                      DayButton: CompactCalendarDayButton,
                    }}
                    initialFocus
                  />
                </PopoverContent>
              </Popover>
              <Button variant="outline" size="icon" onClick={handleNextMonth}>
                <ChevronRight className="h-4 w-4" />
              </Button>
              <Button
                variant="default"
                size="sm"
                onClick={handleToday}
                className="ml-2"
              >
                今日
              </Button>
            </div>

            {/* 右侧：天气组件 - 绝对定位 */}
            <div className="duty-overview-weather-widget md:absolute md:right-0 flex-shrink-0">
              <WeatherWidget
                weatherSnapshot={weatherSnapshot}
                onLoadStateChange={handleWeatherWidgetLoadStateChange}
              />
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {calendarWeatherSection}
          {selfServiceOnly && (
            <div role={selfServiceIdentity?.status === 'error' ? 'alert' : 'status'} className="mb-4 flex items-center justify-between gap-3 rounded-lg border border-blue-100 bg-blue-50 px-3 py-2 text-sm text-blue-800">
              <span>{selfServiceIdentityReady ? `仅可为本人 ${selfServiceIdentity!.name} 申请；代申请需原职责和排班总览权限。` : selfServiceIdentity?.status === 'error' ? selfServiceIdentity.error : '正在核对本人身份与班次…'}</span>
              {selfServiceIdentity?.status === 'error' && <Button size="sm" variant="outline" onClick={() => setSelfServiceRetry(value => value + 1)}>重试读取</Button>}
            </div>
          )}
          {!canReadMonthlySchedule && (
            <p role="status" className="mb-4 rounded-lg border border-blue-100 bg-blue-50 px-3 py-2 text-sm text-blue-800">
              当前未开放排班总览，仅展示已授权功能。请休假、加班等申请可从常用工具进入。
            </p>
          )}

          {/* 今日前后日期值班信息 - 磨玻璃效果展示区 */}
          {canReadMonthlySchedule && <TodayAndNearbySchedules
            selectedDate={selectedDate}
            schedules={schedules}
            getScheduleByDateAndBuilding={getScheduleByDateAndBuilding}
            getEmergencyDutyByDate={getEmergencyDutyByDate}
            getHolidayInfo={getHolidayInfo}
            getSealingInfoByDate={getSealingInfoByDate}
            onOpenSealingDetails={handleOpenSealingDetails}
            BUILDING_ORDER={BUILDING_ORDER}
            BUILDING_MAP={BUILDING_MAP}
            personProfileMap={personProfileMap}
            refreshToken={effectiveDataRefreshToken}
            localSnapshotRefreshToken={localSnapshotRefreshToken}
            onPersonnelMovementsLoadStateChange={
              handlePersonnelMovementsLoadStateChange
            }
          />}

          {canReadAttendance && <>
          <div className="mb-6" data-screenshot-extra="true">
            <TodayAttendanceAnomalyList
              {...todayAttendance}
              canManualSync={role === 'admin'}
              canViewCorrectionEvidence={role === 'admin'}
            />
          </div>
          </>}

          {/* 今日长白班在岗一览 */}
          {canReadPersonnelSchedule && (
          <div data-screenshot-extra="true">
            <TodayEngineersOnDuty
              selectedDate={selectedDate}
              personProfileMap={personProfileMap}
              refreshToken={effectiveDataRefreshToken}
              localSnapshotRefreshToken={localSnapshotRefreshToken}
              workCalendarRevision={workCalendarRevision}
              canRefresh={canRefreshPersonnelSchedule}
              canRefreshRelated={canRefreshMonthlySchedule}
            />
          </div>
          )}

          {canViewScheduleDetails && <>
          <div
            data-screenshot-extra="true"
            className="overflow-x-auto rounded-xl border border-slate-200 bg-slate-50/70 p-3"
          >
            <div className="mb-3 flex min-w-[980px] items-center justify-between gap-3">
              <div>
                <div className="text-sm font-semibold text-slate-900">
                  排班明细
                </div>
                <div className="mt-0.5 text-xs text-slate-500">
                  以选中日期为中心，展示前后 5 天数据（{scheduleRangeLabel}）
                </div>
              </div>
              <div className="flex items-center gap-2 text-xs text-slate-500">
                <span className="inline-flex items-center gap-1 rounded-md border border-amber-200 bg-white px-2 py-1 text-amber-700">
                  <Sun className="h-3 w-3" />
                  白班
                </span>
                <span className="inline-flex items-center gap-1 rounded-md border border-sky-200 bg-white px-2 py-1 text-sky-700">
                  <Moon className="h-3 w-3" />
                  夜班
                </span>
                <span className="inline-flex items-center rounded-md border border-rose-200 bg-white px-2 py-1 text-rose-700">
                  封网
                </span>
              </div>
            </div>
            <div className="mb-2 flex min-w-[980px] overflow-hidden rounded-lg border border-blue-200 bg-blue-600 shadow-sm">
              <div className="flex w-20 flex-shrink-0 items-center justify-center border-r border-blue-400/60 px-3 py-3 text-xs font-semibold text-blue-50">
                日期
              </div>
              {BUILDING_ORDER.map((building) => (
                <div
                  key={building}
                  className="flex min-w-[104px] flex-1 flex-shrink-0 items-center justify-center border-r border-blue-400/60 px-3 py-3 text-center text-xs font-semibold text-blue-50 last:border-r-0"
                >
                  {BUILDING_MAP[building]}
                </div>
              ))}
            </div>

            {loading ? (
              <div className="py-8 text-center text-muted-foreground">
                加载中...
              </div>
            ) : (
              <div className="min-w-[980px]">
                {visibleScheduleDates.map((date) => {
                  const day = date.getDate();
                  const dateStr = `${date.getFullYear()}-${String(
                    date.getMonth() + 1,
                  ).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
                  const holidayInfo = getHolidayInfo(dateStr);
                  const isHoliday = holidayInfo.isHoliday;
                  const isWeekend = date.getDay() === 0 || date.getDay() === 6;
                  const emergencyDuty = getEmergencyDutyByDate(dateStr);
                  const sealing = getSealingInfoByDate(dateStr);
                  const hasSealing = !!sealing;

                  const isToday =
                    date.getFullYear() === selectedDate.getFullYear() &&
                    date.getMonth() === selectedDate.getMonth() &&
                    date.getDate() === selectedDate.getDate();

                  return (
                    <div
                      key={dateStr}
                      className={`mb-1 flex min-w-[980px] rounded-lg transition-colors ${
                        isToday
                          ? 'bg-blue-50/70 ring-1 ring-blue-200'
                          : hasSealing
                            ? 'bg-rose-50/60 ring-1 ring-rose-100'
                            : 'hover:bg-slate-50'
                      }`}
                    >
                      <div
                        className={`relative mr-1 flex min-h-[72px] w-20 flex-shrink-0 flex-col justify-center rounded-lg border p-2 text-center ${
                          isToday
                            ? 'border-blue-600 bg-blue-600 shadow-sm'
                            : isHoliday
                              ? 'border-rose-200 bg-rose-50'
                              : isWeekend
                                ? 'border-slate-200 bg-slate-50'
                                : 'border-slate-200 bg-white'
                        }`}
                      >
                        <div className="flex flex-col items-center">
                          <div
                            className={`mb-0.5 text-base font-semibold leading-none ${
                              isToday ? 'text-white' : 'text-foreground'
                            }`}
                          >
                            {day}日
                          </div>
                          <div
                            className={`text-xs leading-none ${
                              isToday
                                ? 'text-blue-50'
                                : isHoliday
                                  ? 'text-rose-600'
                                  : isWeekend
                                    ? 'text-slate-600'
                                    : 'text-slate-500'
                            }`}
                          >
                            {date.toLocaleDateString('zh-CN', {
                              weekday: 'short',
                            })}
                          </div>
                          {isToday && (
                            <div className="mt-1 rounded border border-white/20 bg-white/15 px-1.5 py-0.5 text-[10px] font-medium leading-none text-white">
                              当天
                            </div>
                          )}
                          {isHoliday && (
                            <div
                              className={`mt-1 max-w-[68px] truncate rounded border px-1.5 py-0.5 text-[10px] font-medium leading-none ${
                                isToday
                                  ? 'border-white/20 bg-white/10 text-white'
                                  : 'border-rose-200 bg-white/80 text-rose-700'
                              }`}
                            >
                              {holidayInfo.name}
                            </div>
                          )}
                          {!isHoliday && isWeekend && (
                            <div
                              className={`mt-1 max-w-[68px] truncate rounded border px-1.5 py-0.5 text-[10px] font-medium leading-none ${
                                isToday
                                  ? 'border-white/20 bg-white/10 text-white'
                                  : 'border-slate-200 bg-white/80 text-slate-600'
                              }`}
                            >
                              周末
                            </div>
                          )}
                          <div
                            data-emergency-duty-state={
                              emergencyDuty.loadState === 'error' &&
                              emergencyDuty.people.length === 0
                                ? 'error'
                                : emergencyDuty.state
                            }
                            title={formatEmergencyDutySummary(emergencyDuty, 3)}
                            className={cn(
                              'mt-1 max-w-[68px] truncate rounded border px-1.5 py-0.5 text-center text-[10px] font-medium leading-none',
                              isToday
                                ? 'border-white/20 bg-white/10 text-white'
                                : emergencyDuty.people.length > 0
                                  ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                                  : emergencyDuty.loadState === 'error'
                                    ? 'border-rose-200 bg-rose-50 text-rose-600'
                                    : 'border-slate-200 bg-slate-50 text-slate-500',
                            )}
                          >
                            <EmergencyDutyProfileSummary
                              view={emergencyDuty}
                              profileMap={personProfileMap}
                              visiblePeople={1}
                            />
                          </div>
                          {/* 封网信息 */}
                          {sealing && (
                            <Popover>
                              <PopoverTrigger asChild>
                                <div className="absolute left-1 top-1 rounded border border-rose-200 bg-rose-50 px-1.5 py-0.5 text-center text-[9px] font-semibold leading-none text-rose-700 shadow-sm transition-all hover:border-rose-300 hover:bg-white">
                                  封网
                                </div>
                              </PopoverTrigger>
                              <PopoverContent
                                className="w-56 p-2.5 border-red-200 shadow-lg"
                                side="right"
                                align="start"
                              >
                                <div className="space-y-1.5">
                                  <div className="flex items-center gap-1.5 border-b border-red-100 pb-1.5">
                                    <div className="w-5 h-5 rounded bg-red-100 border border-red-300 flex items-center justify-center flex-shrink-0">
                                      <span className="text-[10px] font-black text-red-600">
                                        封
                                      </span>
                                    </div>
                                    <h4 className="text-xs font-bold text-red-700 truncate">
                                      {sealing.sealingName}
                                    </h4>
                                  </div>
                                  <div className="space-y-0.5 text-[10px]">
                                    <div className="flex items-center gap-1.5">
                                      <span className="text-gray-500 w-6">
                                        开始:
                                      </span>
                                      <span className="font-medium text-gray-700">
                                        {new Date(
                                          sealing.startDate,
                                        ).toLocaleString('zh-CN', {
                                          month: 'short',
                                          day: 'numeric',
                                          hour: '2-digit',
                                          minute: '2-digit',
                                        })}
                                      </span>
                                    </div>
                                    <div className="flex items-center gap-1.5">
                                      <span className="text-gray-500 w-6">
                                        结束:
                                      </span>
                                      <span className="font-medium text-gray-700">
                                        {new Date(
                                          sealing.endDate,
                                        ).toLocaleString('zh-CN', {
                                          month: 'short',
                                          day: 'numeric',
                                          hour: '2-digit',
                                          minute: '2-digit',
                                        })}
                                      </span>
                                    </div>
                                    {sealing.sealingType && (
                                      <div className="flex items-center gap-1.5">
                                        <span className="text-gray-500 w-6">
                                          类型:
                                        </span>
                                        <span className="font-medium text-red-600 bg-red-50 px-1 py-0.5 rounded text-[9px]">
                                          {sealing.sealingType}
                                        </span>
                                      </div>
                                    )}
                                    {sealing.autoNumber && (
                                      <div className="flex items-center gap-1.5">
                                        <span className="text-gray-500 w-6">
                                          编号:
                                        </span>
                                        <span className="font-medium text-gray-700">
                                          {sealing.autoNumber}
                                        </span>
                                      </div>
                                    )}
                                  </div>
                                </div>
                              </PopoverContent>
                            </Popover>
                          )}
                        </div>
                      </div>
                      {BUILDING_ORDER.map((building) => {
                        const { shiftInfo } = getScheduleByDateAndBuilding(
                          dateStr,
                          building,
                        );
                        const whiteShift = getWhiteShiftInfo(shiftInfo);
                        const nightShift = getNightShiftInfo(shiftInfo);

                        return (
                          <div
                            key={building}
                            className={`mr-1 flex min-w-[104px] flex-1 flex-shrink-0 flex-col overflow-hidden rounded-lg border bg-white last:mr-0 ${
                              isToday
                                ? 'border-blue-200 shadow-sm ring-1 ring-blue-100'
                                : 'border-slate-200 hover:border-slate-300'
                            }`}
                          >
                            <div
                              className={`min-h-[44px] flex-1 border-b border-slate-100 p-1.5 ${
                                isToday ? 'bg-amber-50/70' : 'bg-amber-50/35'
                              }`}
                            >
                              {whiteShift ? (
                                <div className="flex flex-col h-full justify-center">
                                  <div className="mb-1 flex items-center justify-center gap-0.5 text-center text-[9px] font-medium leading-tight text-amber-700">
                                    <Sun className="h-2.5 w-2.5" />
                                    <span>白</span>
                                  </div>
                                  <div className="px-1 text-center text-[10px] font-medium leading-[1.35] text-slate-800">
                                    {formatNameWithSpacing(whiteShift.person)}
                                  </div>
                                </div>
                              ) : (
                                <div className="text-center text-[10px] leading-tight text-slate-300">
                                  -
                                </div>
                              )}
                            </div>
                            <div
                              className={`min-h-[44px] flex-1 p-1.5 ${
                                isToday ? 'bg-sky-50/70' : 'bg-slate-50/80'
                              }`}
                            >
                              {nightShift ? (
                                <div className="flex flex-col h-full justify-center">
                                  <div className="mb-1 flex items-center justify-center gap-0.5 text-center text-[9px] font-medium leading-tight text-sky-700">
                                    <Moon className="h-2.5 w-2.5" />
                                    <span>夜</span>
                                  </div>
                                  <div className="px-1 text-center text-[10px] font-medium leading-[1.35] text-slate-800">
                                    {formatNameWithSpacing(nightShift.person)}
                                  </div>
                                </div>
                              ) : (
                                <div className="text-center text-[10px] leading-tight text-slate-300">
                                  -
                                </div>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          </>}
        </CardContent>
      </Card>
      <CalendarDayDialogHost controller={calendarDayDialogController}>
        {({ date: calendarDetailDate, open: calendarDetailOpen }) => {
          const setCalendarDetailOpen = calendarDayDialogController.setOpen;
          const calendarDetailDateKey = calendarDetailDate
            ? formatDateKey(calendarDetailDate)
            : selectedDateKey;
          const calendarDetailTitle = formatCalendarDateTitle(calendarDetailDate || selectedDate);
          const calendarDetailSealings = getSealingsByDate(calendarDetailDateKey);
          const calendarDetailChangeSummary = getCalendarChangeInfoByDate(calendarDetailDateKey);
          return (
      <Dialog open={calendarDetailOpen} onOpenChange={setCalendarDetailOpen}>
        <DialogContent onCloseAutoFocus={event => restoreCalendarDayDialogFocus(event, calendarDetailDate || selectedDate)} className="flex max-h-[min(82vh,760px)] w-[calc(100vw-2rem)] max-w-[900px] flex-col gap-0 overflow-hidden p-0">
          <DialogHeader className="border-b border-slate-100 px-5 py-4 pr-14">
            <DialogTitle className="flex items-center justify-between gap-3 text-base font-semibold text-slate-900">
              <span>{calendarDetailTitle} 当日事项</span>
              <span className="shrink-0 rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-500">
                {calendarDetailDateKey}
              </span>
            </DialogTitle>
            <div className="mt-2 flex flex-wrap gap-2 text-xs">
              <span className="rounded-full bg-rose-50 px-2.5 py-1 font-medium text-rose-600">
                封网 {calendarDetailSealings.length}
              </span>
              <span className="rounded-full bg-sky-50 px-2.5 py-1 font-medium text-sky-600">
                变更 {calendarDetailChangeSummary.all.length}
              </span>
              <span
                className={cn(
                  'rounded-full px-2.5 py-1 font-medium',
                  calendarDetailChangeSummary.conflictCount > 0
                    ? 'bg-red-50 text-red-600'
                    : 'bg-slate-50 text-slate-600',
                )}
              >
                冲突 {calendarDetailChangeSummary.conflictCount}
              </span>
              {calendarDetailChangeSummary.followedUpCount > 0 && <span className="rounded-full border border-blue-100 bg-blue-50 px-2.5 py-1 font-medium text-blue-700">已跟进 {calendarDetailChangeSummary.followedUpCount}</span>}
              <span className="rounded-full bg-amber-50 px-2.5 py-1 font-medium text-amber-600">
                提醒 {calendarDetailChangeSummary.reminderCount}
              </span>
              <span className="rounded-full bg-orange-50 px-2.5 py-1 font-medium text-orange-600">
                风险 {calendarDetailChangeSummary.riskCount}
              </span>
              {exceptionFollowUpsLoading && (
                <span className="rounded-full bg-slate-50 px-2.5 py-1 font-medium text-slate-500">
                  跟进加载中
                </span>
              )}
              {calendarFollowUps.error && <button type="button" onClick={()=>void calendarFollowUps.reload()} className="text-xs text-red-600 underline">{calendarFollowUps.error}</button>}
            </div>
          </DialogHeader>

          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
            {calendarDetailSealings.length === 0 &&
            calendarDetailChangeSummary.detail.length === 0 &&
            calendarDetailChangeSummary.staffConflicts.length === 0 ? (
              <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50 px-4 py-10 text-center text-sm text-slate-500">
                当日暂无封网或变更安排
              </div>
            ) : (
              <div className="space-y-4">
                {calendarDetailSealings.length > 0 && (
                  <section className="space-y-2">
                    <div className="text-xs font-semibold uppercase tracking-wide text-rose-500">
                      封网
                    </div>
                    {calendarDetailSealings.map((sealing) => (
                      <div
                        key={sealing.id || sealing.bitableRecordId}
                        className="rounded-xl border border-rose-100 bg-rose-50/50 p-3"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0 font-semibold text-slate-900">
                            {sealing.sealingName}
                          </div>
                          {sealing.sealingType && (
                            <span className="shrink-0 rounded-full bg-white px-2 py-0.5 text-xs font-medium text-rose-600">
                              {sealing.sealingType}
                            </span>
                          )}
                        </div>
                        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
                          <span>
                            开始 {formatSealingDateTime(sealing.startDate)}
                          </span>
                          <span>
                            结束 {formatSealingDateTime(sealing.endDate)}
                          </span>
                        </div>
                      </div>
                    ))}
                  </section>
                )}

                {calendarDetailChangeSummary.staffConflicts.length > 0 && (
                  <section className="space-y-2">
                    <div className="text-xs font-semibold uppercase tracking-wide text-orange-500">
                      排班风险
                    </div>
                    {calendarDetailChangeSummary.staffConflicts.map(
                      (conflict) => {
                        const riskTitle = `${conflict.staffName} 连班`;
                        const riskDetail = `${riskTitle}：${formatDutyDateLabel(conflict.previousDate)} ${conflict.previousBuildingLabel} ${conflict.previousShiftLabel} -> ${formatDutyDateLabel(conflict.currentDate)} ${conflict.currentBuildingLabel} ${conflict.currentShiftLabel}；${conflict.reason}`;
                        const riskMatchKeys = buildExceptionFollowUpTargetKeys(
                          calendarDetailDateKey,
                          '风险',
                          riskDetail,
                        );
                        const riskFollowUps = selectExceptionFollowUpsByTarget(
                          exceptionFollowUpsByKey,
                          calendarDetailDateKey,
                          '风险',
                          riskDetail,
                        );
                        const riskTarget: ExceptionFollowUpTarget = {
                          type: 'schedule',
                          abnormalLabel: '风险',
                          date: calendarDetailDateKey,
                          title: riskTitle,
                          detail: riskDetail,
                          matchKey: riskMatchKeys[0] || '',
                          existingFollowUp: null,
                        };

                        return (
                          <div
                            key={conflict.id}
                            className="rounded-xl border border-orange-100 bg-orange-50/60 p-3"
                          >
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0 font-semibold text-slate-900">
                                {riskTitle}
                              </div>
                              {riskFollowUps.length > 0 ? (
                                renderExceptionFollowUpBadge(
                                  riskFollowUps,
                                  riskTarget,
                                )
                              ) : (
                                <span className="shrink-0 rounded-full bg-orange-500 px-2 py-0.5 text-xs font-medium text-white">
                                  风险
                                </span>
                              )}
                            </div>
                            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
                              <span>
                                {formatDutyDateLabel(conflict.previousDate)}{' '}
                                {conflict.previousBuildingLabel}{' '}
                                {conflict.previousShiftLabel}
                              </span>
                              <span>
                                {formatDutyDateLabel(conflict.currentDate)}{' '}
                                {conflict.currentBuildingLabel}{' '}
                                {conflict.currentShiftLabel}
                              </span>
                            </div>
                            <div className="mt-2 rounded-lg border border-orange-100 bg-white/75 px-2.5 py-2 text-xs font-medium text-orange-600">
                              {conflict.reason}
                            </div>
                            {renderExceptionFollowUpRecords(
                              riskFollowUps,
                              riskTarget,
                            )}
                            <div className="mt-2 flex justify-end">
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                disabled={exceptionFollowUpSubmitting}
                                onClick={() =>
                                  openCreateExceptionFollowUpDialog(riskTarget)
                                }
                                className="h-8 border-orange-200 bg-white text-xs font-semibold text-orange-600 hover:bg-orange-50 hover:text-orange-700"
                              >
                                <ClipboardPlus className="mr-1.5 h-3.5 w-3.5" />
                                {riskFollowUps.length > 0
                                  ? '新增跟进'
                                  : '异常跟进'}
                              </Button>
                            </div>
                          </div>
                        );
                      },
                    )}
                  </section>
                )}

                {calendarDetailChangeSummary.detail.length > 0 && (
                  <section className="space-y-2">
                    <div className="text-xs font-semibold uppercase tracking-wide text-sky-500">
                      变更
                    </div>
                    {calendarDetailChangeSummary.detail.map(
                      ({
                        change,
                        conflictSealings,
                        reminderSealings,
                        overlapChanges,
                        windows,
                        followUp,
                      }) => {
                        const {hasConflict, hasReminder, rawConflict, rawReminder, target: followUpTarget, followUps: existingFollowUps} = followUp;
                        const {timeLabel, sourceLabel, levelLabel, executorLabel, buildingLabel, displayLevelLabel} = followUpTarget;
                        const changeRecordId =
                          change.bitableRecordId || change.id;
                        const hasPersistedAdjustment = Boolean(
                          change.plannedDelayStartDate ||
                          change.plannedDelayEndDate,
                        );
                        const adjustmentMessage =
                          changeAdjustmentMessages[changeRecordId] ||
                          (hasPersistedAdjustment
                            ? formatChangeAdjustmentMessage(
                                change.plannedDelayStartDate,
                                change.plannedDelayEndDate,
                              )
                            : null);
                        return (
                          <div
                            key={change.id}
                            className={cn(
                              'rounded-xl border p-3',
                              followUp.status === 'followed-up'
                                ? 'border-blue-200 bg-blue-50/40'
                                : hasConflict
                                ? 'border-red-200 bg-red-50/60'
                                : hasReminder
                                  ? 'border-amber-200 bg-amber-50/55'
                                  : 'border-slate-200 bg-white',
                            )}
                          >
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0 font-semibold text-slate-900">
                                {change.title}
                              </div>
                              {existingFollowUps.length > 0 &&
                              (rawConflict || rawReminder) ? (
                                renderExceptionFollowUpBadge(
                                  existingFollowUps,
                                  followUpTarget,
                                )
                              ) : (
                                <span
                                  className={cn(
                                    'shrink-0 rounded-full px-2 py-0.5 text-xs font-medium',
                                    hasConflict
                                      ? 'bg-red-600 text-white'
                                      : hasReminder
                                        ? 'bg-amber-500 text-white'
                                        : levelLabel
                                          ? 'bg-blue-50 text-blue-600'
                                          : 'bg-slate-100 text-slate-500',
                                  )}
                                >
                                  {hasConflict
                                    ? '冲突'
                                    : hasReminder
                                      ? '提醒'
                                      : levelLabel || '变更'}
                                </span>
                              )}
                            </div>
                            <div className="mt-2 grid gap-1.5 text-xs text-slate-500 sm:grid-cols-2">
                              <span>
                                {sourceLabel} {timeLabel}
                              </span>
                              <span>执行人 {executorLabel}</span>
                              <span>楼栋 {buildingLabel}</span>
                              <span>等级 {displayLevelLabel}</span>
                            </div>
                            {hasConflict && (
                              <div className="mt-2 rounded-lg border border-red-100 bg-white/75 px-2.5 py-2 text-xs font-medium text-red-600">
                                与封网「
                                {formatChangeRelationList(conflictSealings)}
                                」时间冲突，请确认是否允许执行。
                              </div>
                            )}
                            {followUp.status === 'followed-up' && rawConflict && (
                              <details className="mt-2 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-2 text-xs text-slate-600">
                                <summary className="cursor-pointer font-medium">原始时间重叠依据</summary>
                                <p className="mt-2">与封网「{formatChangeRelationList(conflictSealings)}」时间重叠；已登记跟进，未自动判定为正常。</p>
                              </details>
                            )}
                            {adjustmentMessage && (
                              <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-emerald-100 bg-emerald-50/80 px-2.5 py-2 text-xs font-medium text-emerald-700">
                                <span>{adjustmentMessage}</span>
                                {canDeleteChange &&
                                  hasPersistedAdjustment && (
                                    <Button
                                      type="button"
                                      variant="outline"
                                      size="sm"
                                      disabled={changeAdjustmentSubmitting}
                                      onClick={() =>
                                        handleClearChangeAdjustment(change)
                                      }
                                      className="h-7 border-emerald-200 bg-white px-2 text-xs font-semibold text-emerald-700 hover:bg-emerald-50 hover:text-emerald-800"
                                    >
                                      <Undo2 className="mr-1 h-3.5 w-3.5" />
                                      撤销调整
                                    </Button>
                                  )}
                              </div>
                            )}
                            {renderExceptionFollowUpRecords(
                              existingFollowUps,
                              followUpTarget,
                            )}
                            {(canUpdateChange || canCreateException) &&
                              (rawConflict || rawReminder) && (
                                <div className="mt-2 flex flex-wrap justify-end gap-2">
                                  {rawConflict && canUpdateChange && (
                                    <Button
                                      type="button"
                                      variant="outline"
                                      size="sm"
                                      onClick={() =>
                                        openChangeAdjustmentDialog({
                                          change,
                                          conflictSealings,
                                          sourceLabel,
                                          timeLabel,
                                        })
                                      }
                                      className="h-8 border-red-200 bg-white text-xs font-semibold text-red-600 hover:bg-red-50 hover:text-red-700"
                                    >
                                      <CalendarClock className="mr-1.5 h-3.5 w-3.5" />
                                      变更调整
                                    </Button>
                                  )}
                                  <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    disabled={exceptionFollowUpSubmitting || !canCreateException}
                                    onClick={() =>
                                      openCreateExceptionFollowUpDialog(
                                        followUpTarget,
                                      )
                                    }
                                    className={cn(
                                      'h-8 bg-white text-xs font-semibold',
                                      existingFollowUps.length > 0
                                        ? 'border-emerald-200 text-emerald-700 hover:bg-emerald-50 hover:text-emerald-800'
                                        : hasConflict
                                          ? 'border-red-200 text-red-600 hover:bg-red-50 hover:text-red-700'
                                          : 'border-amber-200 text-amber-600 hover:bg-amber-50 hover:text-amber-700',
                                    )}
                                  >
                                    <ClipboardPlus className="mr-1.5 h-3.5 w-3.5" />
                                    {existingFollowUps.length > 0
                                      ? '新增跟进'
                                      : '异常跟进'}
                                  </Button>
                                </div>
                              )}
                            {reminderSealings.length > 0 && (
                              <div className="mt-2 rounded-lg border border-amber-100 bg-white/75 px-2.5 py-2 text-xs font-medium text-amber-600">
                                当日存在封网「
                                {formatChangeRelationList(reminderSealings)}
                                」，当前变更未精确冲突，仍需关注执行窗口。
                              </div>
                            )}
                            {overlapChanges.length > 0 && (
                              <div className="mt-2 rounded-lg border border-amber-100 bg-white/75 px-2.5 py-2 text-xs font-medium text-amber-600">
                                与中风险及以上变更「
                                {formatChangeRelationList(overlapChanges)}
                                」时间重叠，需关注人员和资源安排。
                              </div>
                            )}
                          </div>
                        );
                      },
                    )}
                  </section>
                )}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
          );
        }}
      </CalendarDayDialogHost>
      <Dialog
        open={Boolean(exceptionFollowUpTarget)}
        onOpenChange={(open) => {
          if (!open && !exceptionFollowUpSubmitting) {
            setExceptionFollowUpTarget(null);
            setExceptionFollowUpHandling('');
          }
        }}
      >
        <DialogContent
          className="flex max-h-[min(86vh,680px)] w-[calc(100vw-2rem)] max-w-2xl flex-col gap-0 overflow-hidden p-0"
          showCloseButton={!exceptionFollowUpSubmitting}
        >
          {exceptionFollowUpTarget && (
            <>
              <DialogHeader className="border-b border-slate-100 px-5 py-4 pr-12">
                <DialogTitle className="flex items-center gap-2 text-base font-semibold text-slate-900">
                  <ClipboardPlus className="h-4 w-4 text-blue-600" />
                  {exceptionFollowUpTarget.existingFollowUp
                    ? '修改异常跟进'
                    : '异常跟进'}
                </DialogTitle>
                <DialogDescription className="text-sm text-slate-500">
                  记录异常项处理结论
                </DialogDescription>
              </DialogHeader>

              <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
                <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      className={cn(
                        'rounded-full px-2 py-0.5 text-xs font-semibold text-white',
                        exceptionFollowUpTarget.existingFollowUp
                          ? 'bg-emerald-500'
                          : exceptionFollowUpTarget.type === 'schedule'
                            ? 'bg-orange-500'
                            : 'bg-blue-600',
                      )}
                    >
                      {exceptionFollowUpTarget.existingFollowUp
                        ? '已跟进'
                        : exceptionFollowUpTarget.abnormalLabel}
                    </span>
                    <span className="text-sm font-semibold text-slate-900">
                      {exceptionFollowUpTarget.title}
                    </span>
                    <span className="text-xs font-medium text-slate-500">
                      {exceptionFollowUpTarget.date}
                    </span>
                  </div>
                  <div className="mt-2 text-sm leading-6 text-slate-600">
                    {exceptionFollowUpTarget.detail}
                  </div>
                </div>

                <div className="mt-4 space-y-2">
                  <label
                    htmlFor="exception-follow-up-handling"
                    className="text-sm font-semibold text-slate-700"
                  >
                    处理方式和措施
                  </label>
                  <Textarea
                    id="exception-follow-up-handling"
                    value={exceptionFollowUpHandling}
                    disabled={
                      exceptionFollowUpSubmitting || !(exceptionFollowUpTarget?.existingFollowUp ? canUpdateException : canCreateException)
                    }
                    onChange={(event) =>
                      setExceptionFollowUpHandling(event.target.value)
                    }
                    placeholder="填写已采取的处理方式、责任人、后续措施或确认结论"
                    className="min-h-28 resize-y border-slate-200 bg-white text-sm focus-visible:ring-blue-200"
                  />
                </div>
              </div>

              <DialogFooter className="border-t border-slate-100 bg-white px-5 py-4">
                {canDeleteException &&
                  exceptionFollowUpTarget.existingFollowUp && (
                    <Button
                      type="button"
                      variant="outline"
                      disabled={exceptionFollowUpSubmitting}
                      onClick={handleDeleteExceptionFollowUp}
                      className="border-red-200 text-red-600 hover:bg-red-50 hover:text-red-700 sm:mr-auto"
                    >
                      {exceptionFollowUpSubmitting ? (
                        <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                      ) : (
                        <Trash2 className="mr-1.5 h-4 w-4" />
                      )}
                      删除跟进
                    </Button>
                  )}
                <Button
                  type="button"
                  variant="outline"
                  disabled={exceptionFollowUpSubmitting}
                  onClick={() => {
                    setExceptionFollowUpTarget(null);
                    setExceptionFollowUpHandling('');
                  }}
                >
                  取消
                </Button>
                <Button
                  type="button"
                  disabled={
                    exceptionFollowUpSubmitting || !(exceptionFollowUpTarget?.existingFollowUp ? canUpdateException : canCreateException)
                  }
                  onClick={handleSubmitExceptionFollowUp}
                  className="bg-blue-600 text-white hover:bg-blue-700"
                >
                  {exceptionFollowUpSubmitting ? (
                    <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                  ) : (
                    <ClipboardPlus className="mr-1.5 h-4 w-4" />
                  )}
                  {exceptionFollowUpTarget.existingFollowUp
                    ? '更新跟进'
                    : '提交跟进'}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
      <Dialog
        open={Boolean(changeAdjustmentTarget)}
        onOpenChange={(open) => {
          if (!open && !changeAdjustmentSubmitting) {
            setChangeAdjustmentTarget(null);
          }
        }}
      >
        <DialogContent
          className="flex max-h-[min(86vh,720px)] w-[calc(100vw-2rem)] max-w-2xl flex-col gap-0 overflow-hidden p-0"
          showCloseButton={!changeAdjustmentSubmitting}
        >
          {changeAdjustmentTarget && (
            <>
              <DialogHeader className="border-b border-slate-100 px-5 py-4 pr-12">
                <DialogTitle className="flex items-center gap-2 text-base font-semibold text-slate-900">
                  <CalendarClock className="h-4 w-4 text-red-600" />
                  变更调整
                </DialogTitle>
                <p className="text-sm text-slate-500">
                  调整与封网冲突的变更计划时间
                </p>
              </DialogHeader>

              <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
                <div className="rounded-xl border border-red-100 bg-red-50/60 p-3">
                  <div className="text-sm font-semibold text-slate-900">
                    {changeAdjustmentTarget.change.title}
                  </div>
                  <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
                    <span>
                      {changeAdjustmentTarget.sourceLabel}{' '}
                      {changeAdjustmentTarget.timeLabel}
                    </span>
                    <span>
                      冲突封网{' '}
                      {formatChangeRelationList(
                        changeAdjustmentTarget.conflictSealings,
                      )}
                    </span>
                  </div>
                </div>

                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  <div className="rounded-lg border border-slate-200 bg-white p-3">
                    <div className="flex items-center justify-between gap-3">
                      <label
                        className="text-sm font-semibold text-slate-700"
                        htmlFor="change-adjustment-start"
                      >
                        延期开始
                      </label>
                      <label className="flex items-center gap-1.5 text-xs font-medium text-slate-500">
                        <input
                          type="checkbox"
                          checked={changeAdjustmentDraft.startNoAdjustment}
                          onChange={(event) =>
                            setChangeAdjustmentDraft((current) => ({
                              ...current,
                              startNoAdjustment: event.target.checked,
                            }))
                          }
                          className="h-3.5 w-3.5 rounded border-slate-300"
                        />
                        无调整
                      </label>
                    </div>
                    <Input
                      id="change-adjustment-start"
                      type="datetime-local"
                      value={changeAdjustmentDraft.startValue}
                      disabled={changeAdjustmentDraft.startNoAdjustment}
                      onChange={(event) =>
                        setChangeAdjustmentDraft((current) => ({
                          ...current,
                          startValue: event.target.value,
                        }))
                      }
                      className="mt-3 h-9 border-slate-200 bg-slate-50 focus-visible:ring-blue-200"
                    />
                  </div>

                  <div className="rounded-lg border border-slate-200 bg-white p-3">
                    <div className="flex items-center justify-between gap-3">
                      <label
                        className="text-sm font-semibold text-slate-700"
                        htmlFor="change-adjustment-end"
                      >
                        延期结束
                      </label>
                      <label className="flex items-center gap-1.5 text-xs font-medium text-slate-500">
                        <input
                          type="checkbox"
                          checked={changeAdjustmentDraft.endNoAdjustment}
                          onChange={(event) =>
                            setChangeAdjustmentDraft((current) => ({
                              ...current,
                              endNoAdjustment: event.target.checked,
                            }))
                          }
                          className="h-3.5 w-3.5 rounded border-slate-300"
                        />
                        无调整
                      </label>
                    </div>
                    <Input
                      id="change-adjustment-end"
                      type="datetime-local"
                      value={changeAdjustmentDraft.endValue}
                      disabled={changeAdjustmentDraft.endNoAdjustment}
                      onChange={(event) =>
                        setChangeAdjustmentDraft((current) => ({
                          ...current,
                          endValue: event.target.value,
                        }))
                      }
                      className="mt-3 h-9 border-slate-200 bg-slate-50 focus-visible:ring-blue-200"
                    />
                  </div>
                </div>

                <div className="mt-4 rounded-lg border border-blue-100 bg-blue-50/60 px-3 py-2 text-xs leading-5 text-blue-700">
                  选择“无调整”的时间不会写入飞书字段；开始和结束都无调整时，仅记录本次确认结果。
                </div>
              </div>

              <div className="flex items-center justify-end gap-2 border-t border-slate-100 bg-slate-50 px-5 py-4">
                <Button
                  type="button"
                  variant="outline"
                  disabled={changeAdjustmentSubmitting}
                  onClick={() => setChangeAdjustmentTarget(null)}
                >
                  取消
                </Button>
                <Button
                  type="button"
                  disabled={
                    changeAdjustmentSubmitting || !canUpdateChange
                  }
                  onClick={() => {
                    void handleSubmitChangeAdjustment();
                  }}
                  className="bg-blue-600 text-white hover:bg-blue-700"
                >
                  {changeAdjustmentSubmitting ? (
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <CalendarClock className="mr-1.5 h-3.5 w-3.5" />
                  )}
                  确认提交
                </Button>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
      <Dialog
        open={personnelMovementDialogOpen}
        onOpenChange={(open) => {
          if (!personnelMovementSubmitting) {
            setPersonnelMovementDialogOpen(open);
          }
        }}
      >
        <DialogContent className="w-[calc(100vw-2rem)] max-w-[560px] gap-0 overflow-hidden p-0">
          <DialogHeader className="border-b border-slate-100 px-5 py-4">
            <DialogTitle className="flex items-center gap-2 text-base font-semibold text-slate-900">
              <UserCog className="h-4 w-4 text-blue-600" />
              人员异动
            </DialogTitle>
            <DialogDescription className="text-sm text-slate-500">
              从异动时间开始，更新排班底表中的实际值班人员程序修改字段。
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 px-5 py-4">
            <div>
              <label
                className="mb-2 block text-xs font-semibold text-slate-500"
                htmlFor="personnel-movement-staff"
              >
                人员
              </label>
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <Input
                  id="personnel-movement-staff"
                  value={
                    personnelMovementStaffSearch || personnelMovementStaffName
                  }
                  onFocus={() => setPersonnelMovementStaffPickerOpen(true)}
                  onBlur={() => {
                    window.setTimeout(
                      () => setPersonnelMovementStaffPickerOpen(false),
                      160,
                    );
                  }}
                  onChange={(event) => {
                    const value = event.target.value;
                    setPersonnelMovementStaffSearch(value);
                    setPersonnelMovementStaffName(value);
                    setPersonnelMovementStaffPickerOpen(true);
                  }}
                  placeholder={
                    travelProfilesLoading
                      ? '正在加载人员...'
                      : '输入姓名模糊查找，也可手动输入'
                  }
                  className="h-9 border-slate-200 bg-slate-50 pl-9 focus-visible:ring-blue-200"
                />
                {personnelMovementStaffPickerOpen ? (
                  <div className="absolute left-0 right-0 top-full z-50 mt-1 max-h-56 overflow-y-auto rounded-md border border-slate-200 bg-white p-1 shadow-lg">
                    {travelProfilesLoading ? (
                      <div className="flex items-center gap-2 px-3 py-2 text-sm text-slate-500">
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        正在加载人员
                      </div>
                    ) : filteredPersonnelMovementStaffOptions.length > 0 ? (
                      filteredPersonnelMovementStaffOptions.map((name) => (
                        <button
                          key={name}
                          type="button"
                          className={cn(
                            'flex w-full items-center justify-between rounded px-3 py-2 text-left text-sm hover:bg-blue-50',
                            personnelMovementStaffName === name
                              ? 'bg-blue-50 font-semibold text-blue-700'
                              : 'text-slate-700',
                          )}
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() => {
                            setPersonnelMovementStaffName(name);
                            setPersonnelMovementStaffSearch(name);
                            setPersonnelMovementStaffPickerOpen(false);
                          }}
                        >
                          <span>{name}</span>
                          {personnelMovementStaffName === name ? (
                            <Check className="h-3.5 w-3.5" />
                          ) : null}
                        </button>
                      ))
                    ) : (
                      <div className="px-3 py-2 text-sm text-slate-500">
                        未匹配到人员，可继续手动输入
                      </div>
                    )}
                  </div>
                ) : null}
              </div>
            </div>

            <div>
              <div className="mb-2 text-xs font-semibold text-slate-500">
                异动类型
              </div>
              <div className="grid grid-cols-3 rounded-lg bg-slate-100 p-1">
                {PERSONNEL_MOVEMENT_TYPES.map((type) => (
                  <Button
                    key={type}
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setPersonnelMovementType(type)}
                    className={cn(
                      'h-8 rounded-md text-sm font-semibold',
                      personnelMovementType === type
                        ? 'bg-white text-blue-700 shadow-sm'
                        : 'text-slate-600 hover:bg-white/70 hover:text-blue-700',
                    )}
                  >
                    {type}
                  </Button>
                ))}
              </div>
            </div>

            <div>
              <label
                className="mb-2 block text-xs font-semibold text-slate-500"
                htmlFor="personnel-movement-date"
              >
                异动时间
              </label>
              <Input
                id="personnel-movement-date"
                type="date"
                value={personnelMovementDate}
                onChange={(event) =>
                  setPersonnelMovementDate(event.target.value)
                }
                className="h-9 border-slate-200 bg-slate-50 focus-visible:ring-blue-200"
              />
            </div>
          </div>

          <DialogFooter className="border-t border-slate-100 bg-slate-50 px-5 py-4">
            <Button
              type="button"
              variant="outline"
              disabled={personnelMovementSubmitting}
              onClick={() => setPersonnelMovementDialogOpen(false)}
            >
              取消
            </Button>
            <Button
              type="button"
              disabled={
                personnelMovementSubmitting ||
                !personnelMovementDate ||
                !(
                  personnelMovementStaffName || personnelMovementStaffSearch
                ).trim()
              }
              onClick={() => {
                void handleSubmitPersonnelMovement();
              }}
              className="bg-blue-600 text-white hover:bg-blue-700"
            >
              {personnelMovementSubmitting ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Check className="mr-1.5 h-3.5 w-3.5" />
              )}
              确认提交
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={vacancyDialogOpen}
        onOpenChange={(open) => {
          if (!vacancySubmitting && !repairSubmitting && !travelSubmitting) {
            setVacancyDialogOpen(open);
          }
        }}
      >
        <DialogContent className="flex max-h-[min(86vh,780px)] w-[calc(100vw-2rem)] max-w-[900px] flex-col gap-0 overflow-hidden p-0">
          <DialogHeader className="border-b border-slate-100 px-5 py-4">
            <DialogTitle className="flex items-center gap-2 text-base font-semibold text-slate-900">
              <UserCog className="h-4 w-4 text-blue-600" />
              人员调整
            </DialogTitle>
            <p className="text-sm text-slate-500">
              {staffAdjustmentMode === 'repair'
                ? repairDateKey
                : staffAdjustmentMode === 'emergency'
                  ? emergencyDutyDate
                  : selectedDateKey}{' '}
              · 支持缺岗替班、人员修正、差旅填充和应急值班调整
            </p>
          </DialogHeader>

          <div className="border-b border-slate-100 px-5 py-3">
            <div className="grid grid-cols-2 rounded-lg bg-slate-100 p-1 sm:grid-cols-4">
              {(
                [
                  ['vacancy', '缺岗替班'],
                  ['repair', '人员修正'],
                  ['travel', '差旅人员'],
                  ['emergency', '应急值班'],
                ] as Array<[StaffAdjustmentMode, string]>
              ).map(([mode, label]) => (
                <Button
                  key={mode}
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setStaffAdjustmentMode(mode);
                    if (mode === 'repair') {
                      void loadPersonProfiles(true);
                    }
                    if (mode === 'travel') {
                      setTravelStartDate(selectedDateKey);
                      setTravelEndDate(selectedDateKey);
                      setTravelStaffPickerOpen(false);
                      void loadTravelPersonProfiles(true);
                      void loadTravelDetails();
                    }
                    if (mode === 'emergency') {
                      prepareEmergencyDutyDraft(selectedDateKey);
                      void loadEmergencyDutyOptions();
                    }
                  }}
                  className={cn(
                    'h-8 rounded-md text-sm font-semibold',
                    staffAdjustmentMode === mode
                      ? 'bg-white text-blue-700 shadow-sm'
                      : 'text-slate-500 hover:bg-white/70 hover:text-slate-800',
                  )}
                >
                  {label}
                </Button>
              ))}
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
            {staffAdjustmentMode === 'vacancy' ? (
              vacancyCandidates.length === 0 ? (
                <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50 px-4 py-8 text-center">
                  <div className="text-sm font-medium text-slate-700">
                    今日暂无需补录的缺岗班次
                  </div>
                  <div className="mt-1 text-xs text-slate-500">
                    当前日期未发现只有 1 人值班的楼栋班次。
                  </div>
                </div>
              ) : (
                <div className="space-y-3">
                  {vacancyCandidates.map((candidate, index) => {
                    const inputId = `vacancy-substitute-${index}`;
                    return (
                      <div
                        key={candidate.key}
                        className="grid gap-3 rounded-lg border border-slate-200 bg-white p-3 shadow-sm md:grid-cols-[128px_minmax(0,1fr)_minmax(220px,260px)] md:items-center"
                      >
                        <div className="flex items-center gap-2">
                          <span className="inline-flex h-8 min-w-14 items-center justify-center rounded-md bg-blue-600 px-3 text-sm font-semibold text-white">
                            {candidate.buildingLabel}
                          </span>
                          <span className="rounded-md bg-slate-100 px-2 py-1 text-xs font-medium text-slate-600">
                            {candidate.shiftLabel}
                          </span>
                        </div>

                        <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
                          <span className="text-slate-500">现有人员</span>
                          {candidate.staffNames.map((name) => (
                            <StaffProfilePopover
                              key={`${candidate.key}-${name}`}
                              name={name}
                              profile={getStaffProfile(personProfileMap, name)}
                              className="rounded bg-blue-50 px-2 py-1 font-medium text-blue-700"
                            />
                          ))}
                          <label
                            htmlFor={inputId}
                            className="cursor-text rounded-md bg-rose-50 px-2 py-1 text-xs font-semibold text-rose-600 ring-1 ring-rose-100"
                          >
                            缺岗
                          </label>
                        </div>

                        <Input
                          id={inputId}
                          value={vacancyInputs[candidate.key] || ''}
                          onChange={(event) => {
                            const value = event.target.value;
                            setVacancyInputs((current) => ({
                              ...current,
                              [candidate.key]: value,
                            }));
                          }}
                          placeholder="填写替班人员姓名"
                          className="h-9 border-slate-200 bg-slate-50 focus-visible:ring-blue-200"
                        />
                      </div>
                    );
                  })}
                </div>
              )
            ) : staffAdjustmentMode === 'repair' ? (
              <div className="space-y-4">
                <div className="grid gap-3 rounded-lg border border-slate-200 bg-white p-3 shadow-sm lg:grid-cols-[180px_minmax(0,1fr)_minmax(260px,0.8fr)]">
                  <div className="min-w-0">
                    <label
                      className="mb-2 block text-xs font-semibold text-slate-500"
                      htmlFor="staff-repair-date"
                    >
                      选择日期
                    </label>
                    <div className="relative">
                      <CalendarClock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                      <Input
                        id="staff-repair-date"
                        type="date"
                        value={repairDate}
                        onChange={(event) => setRepairDate(event.target.value)}
                        className="h-8 border-slate-200 bg-slate-50 pl-9 focus-visible:ring-blue-200"
                      />
                    </div>
                  </div>
                  <div className="min-w-0">
                    <div className="mb-2 text-xs font-semibold text-slate-500">
                      选择楼栋
                    </div>
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
                      {VACANCY_BUILDING_ORDER.map((building) => (
                        <Button
                          key={building}
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => setRepairBuilding(building)}
                          className={cn(
                            'h-8 rounded-md text-sm',
                            repairBuilding === building
                              ? 'border-blue-600 bg-blue-600 text-white hover:bg-blue-700'
                              : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50',
                          )}
                        >
                          {BUILDING_MAP[building] || building}
                        </Button>
                      ))}
                    </div>
                  </div>
                  <div className="min-w-0">
                    <div className="mb-2 text-xs font-semibold text-slate-500">
                      选择班次
                    </div>
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                      {(['white', 'long_white', 'night'] as const).map(
                        (shift) => (
                          <Button
                            key={shift}
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => setRepairShift(shift)}
                            className={cn(
                              'h-8 rounded-md text-sm',
                              repairShift === shift
                                ? 'border-blue-600 bg-blue-600 text-white hover:bg-blue-700'
                                : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50',
                            )}
                          >
                            {VACANCY_SHIFT_LABELS[shift]}
                          </Button>
                        ),
                      )}
                    </div>
                  </div>
                </div>

                <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
                  {repairDateLoading ? (
                    <div className="flex items-center justify-center gap-2 rounded-lg border border-dashed border-slate-200 bg-slate-50 px-4 py-8 text-sm text-slate-500">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      正在加载该日期排班数据
                    </div>
                  ) : selectedRepairCandidate ? (
                    <>
                      <div className="flex flex-wrap items-center gap-2 text-sm">
                        <span className="text-slate-500">点击需修改人员</span>
                        {selectedRepairCandidate.staffNames.map((name) => (
                          <button
                            key={`${selectedRepairCandidate.key}-${name}`}
                            type="button"
                            onClick={() => {
                              setRepairTargetName(name);
                              setRepairReplacementName('');
                              setRepairReplacementSearch('');
                              setRepairReplacementPickerOpen(false);
                            }}
                            className={cn(
                              'rounded-md px-2.5 py-1 text-sm font-semibold transition-colors',
                              repairTargetName === name
                                ? 'bg-blue-600 text-white'
                                : 'bg-blue-50 text-blue-700 hover:bg-blue-100',
                            )}
                          >
                            {name}
                          </button>
                        ))}
                      </div>
                      <div className="mt-4 grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(260px,360px)] md:items-start">
                        <div className="flex min-h-9 items-center rounded-md bg-slate-50 px-3 py-2 text-sm text-slate-600">
                          {repairTargetName
                            ? `将 ${repairTargetName} 修正为：`
                            : '选择上方姓名后从在职人员名单选择修正人员'}
                        </div>
                        <div className="min-w-0">
                          <Popover
                            open={
                              repairReplacementPickerOpen &&
                              Boolean(repairTargetName)
                            }
                            onOpenChange={(open) => {
                              setRepairReplacementPickerOpen(
                                open && Boolean(repairTargetName),
                              );
                            }}
                          >
                            <div className="relative">
                              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                              <PopoverTrigger asChild>
                                <Input
                                  id="staff-repair-replacement"
                                  type="text"
                                  value={
                                    repairReplacementSearch ||
                                    repairReplacementName
                                  }
                                  onFocus={() => {
                                    if (repairTargetName) {
                                      setRepairReplacementPickerOpen(true);
                                    }
                                  }}
                                  onBlur={() => {
                                    window.setTimeout(
                                      () =>
                                        setRepairReplacementPickerOpen(false),
                                      160,
                                    );
                                  }}
                                  onChange={(event) => {
                                    const value = event.target.value;
                                    setRepairReplacementSearch(value);
                                    if (value !== repairReplacementName) {
                                      setRepairReplacementName('');
                                    }
                                    setRepairReplacementPickerOpen(
                                      Boolean(repairTargetName),
                                    );
                                  }}
                                  placeholder={
                                    personProfiles.length === 0
                                      ? '正在加载人员...'
                                      : '从在职人员名单选择'
                                  }
                                  disabled={!repairTargetName}
                                  className="h-9 border-slate-200 bg-slate-50 pl-9 focus-visible:ring-blue-200"
                                />
                              </PopoverTrigger>
                            </div>
                            <PopoverContent
                              align="start"
                              side="bottom"
                              sideOffset={6}
                              onOpenAutoFocus={(event) =>
                                event.preventDefault()
                              }
                              className="z-[60] w-[var(--radix-popover-trigger-width)] max-h-56 overflow-y-auto border-slate-200 bg-white p-1 shadow-lg"
                            >
                              {filteredRepairStaffOptions.length > 0 ? (
                                filteredRepairStaffOptions.map((name) => (
                                  <button
                                    key={name}
                                    type="button"
                                    className={cn(
                                      'flex w-full items-center justify-between rounded px-3 py-2 text-left text-sm hover:bg-blue-50',
                                      repairReplacementName === name
                                        ? 'bg-blue-50 font-semibold text-blue-700'
                                        : 'text-slate-700',
                                    )}
                                    onMouseDown={(event) =>
                                      event.preventDefault()
                                    }
                                    onClick={() => {
                                      setRepairReplacementName(name);
                                      setRepairReplacementSearch(name);
                                      setRepairReplacementPickerOpen(false);
                                    }}
                                  >
                                    <span>{name}</span>
                                    {repairReplacementName === name ? (
                                      <Check className="h-3.5 w-3.5" />
                                    ) : null}
                                  </button>
                                ))
                              ) : (
                                <div className="px-3 py-2 text-sm text-slate-500">
                                  未匹配到在职人员
                                </div>
                              )}
                            </PopoverContent>
                          </Popover>
                          <div className="mt-1 text-xs text-slate-400">
                            来源：在职人员表
                          </div>
                        </div>
                      </div>
                    </>
                  ) : (
                    <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50 px-4 py-8 text-center">
                      <div className="text-sm font-medium text-slate-700">
                        当前楼栋班次暂无值班人员
                      </div>
                      <div className="mt-1 text-xs text-slate-500">
                        请切换楼栋或班次后再进行人员修正。
                      </div>
                    </div>
                  )}
                </div>
              </div>
            ) : staffAdjustmentMode === 'emergency' ? (
              <EmergencyDutyAdjustmentPanel
                date={emergencyDutyDate}
                onDateChange={prepareEmergencyDutyDraft}
                editableRange={emergencyDutyLoadedRange}
                loadStatus={emergencyDutyLoadStatus}
                loadError={emergencyDutyLoadError}
                snapshotStale={emergencyDutySnapshotStale}
                currentPeople={emergencyDutyDraftView.people}
                syncState={emergencyDutyDraftSyncState}
                recoveryBinding={emergencyDutyRecoveryBinding}
                onRetrySchedules={() => void loadEmergencyDutySchedules()}
                options={emergencyDutyOptions}
                filteredOptions={filteredEmergencyDutyOptions}
                optionsStatus={emergencyDutyOptionsStatus}
                selectedKeys={emergencyDutySelectedKeys}
                selectedKeySet={emergencyDutySelectedKeySet}
                search={emergencyDutySearch}
                onSearchChange={setEmergencyDutySearch}
                onTogglePerson={(key) => {
                  setEmergencyDutySelectedKeys((current) => {
                    const next = new Set(current);
                    if (next.has(key)) next.delete(key);
                    else next.add(key);
                    return [...next];
                  });
                }}
                onRetryOptions={() => void loadEmergencyDutyOptions(true)}
              />
            ) : (
              <div className="space-y-4">
                <div className="rounded-lg border border-blue-100 bg-blue-50/60 px-4 py-3 text-sm text-blue-700">
                  选择差旅人员和日期后，系统会把人员写入“差旅人员”字段，并从对应日期的“值班人员（实际）程序修改”中移除。
                </div>

                <div className="grid items-start gap-4 rounded-lg border border-slate-200 bg-white p-4 shadow-sm md:grid-cols-[minmax(0,1fr)_160px_160px]">
                  <div>
                    <label
                      className="mb-2 block text-xs font-semibold text-slate-500"
                      htmlFor="travel-staff-name"
                    >
                      差旅人员
                    </label>
                    <div className="relative">
                      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                      <Input
                        id="travel-staff-name"
                        value={travelStaffSearch || travelStaffName}
                        onFocus={() => setTravelStaffPickerOpen(true)}
                        onBlur={() => {
                          window.setTimeout(
                            () => setTravelStaffPickerOpen(false),
                            160,
                          );
                        }}
                        onChange={(event) => {
                          const value = event.target.value;
                          setTravelStaffSearch(value);
                          if (value !== travelStaffName) {
                            setTravelStaffName('');
                          }
                          setTravelStaffPickerOpen(true);
                        }}
                        placeholder={
                          travelProfilesLoading
                            ? '正在加载人员...'
                            : '输入姓名快速匹配'
                        }
                        className="h-9 border-slate-200 bg-slate-50 pl-9 focus-visible:ring-blue-200"
                      />
                      {travelStaffPickerOpen ? (
                        <div className="absolute left-0 right-0 top-full z-50 mt-1 max-h-56 overflow-y-auto rounded-md border border-slate-200 bg-white p-1 shadow-lg">
                          {travelProfilesLoading ? (
                            <div className="flex items-center gap-2 px-3 py-2 text-sm text-slate-500">
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              正在加载人员
                            </div>
                          ) : filteredTravelStaffOptions.length > 0 ? (
                            filteredTravelStaffOptions.map((name) => (
                              <button
                                key={name}
                                type="button"
                                className={cn(
                                  'flex w-full items-center justify-between rounded px-3 py-2 text-left text-sm hover:bg-blue-50',
                                  travelStaffName === name
                                    ? 'bg-blue-50 font-semibold text-blue-700'
                                    : 'text-slate-700',
                                )}
                                onMouseDown={(event) => event.preventDefault()}
                                onClick={() => {
                                  setTravelStaffName(name);
                                  setTravelStaffSearch(name);
                                  setTravelStaffPickerOpen(false);
                                }}
                              >
                                <span>{name}</span>
                                {travelStaffName === name ? (
                                  <Check className="h-3.5 w-3.5" />
                                ) : null}
                              </button>
                            ))
                          ) : (
                            <div className="px-3 py-2 text-sm text-slate-500">
                              未匹配到人员
                            </div>
                          )}
                        </div>
                      ) : null}
                    </div>
                    <div className="mt-1 text-xs text-slate-400">
                      来源：在职人员表
                    </div>
                  </div>

                  <div>
                    <label
                      className="mb-2 block text-xs font-semibold text-slate-500"
                      htmlFor="travel-start-date"
                    >
                      开始日期
                    </label>
                    <Input
                      id="travel-start-date"
                      type="date"
                      value={travelStartDate}
                      onChange={(event) => {
                        const value = event.target.value;
                        setTravelStartDate(value);
                        setTravelEndDate((current) => {
                          if (
                            !current ||
                            current < value ||
                            current.slice(0, 7) !== value.slice(0, 7)
                          ) {
                            return value;
                          }
                          return current;
                        });
                      }}
                      className="h-9 border-slate-200 bg-slate-50 focus-visible:ring-blue-200"
                    />
                  </div>

                  <div>
                    <label
                      className="mb-2 block text-xs font-semibold text-slate-500"
                      htmlFor="travel-end-date"
                    >
                      结束日期
                    </label>
                    <Input
                      id="travel-end-date"
                      type="date"
                      value={travelEndDate}
                      min={travelStartDate || undefined}
                      max={
                        travelStartDate
                          ? getMonthEndDateKey(travelStartDate)
                          : undefined
                      }
                      onChange={(event) => setTravelEndDate(event.target.value)}
                      className="h-9 border-slate-200 bg-slate-50 focus-visible:ring-blue-200"
                    />
                  </div>
                </div>

                <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50 px-4 py-5 text-sm text-slate-500">
                  {travelStaffName ? (
                    <span>
                      将处理 {travelStaffName} 在{' '}
                      {travelStartDate || '未选开始日期'} 至{' '}
                      {travelEndDate || '未选结束日期'} 的值班记录。
                    </span>
                  ) : (
                    <span>
                      先从下拉列表选择人员，再选择同一个月份内的差旅日期。
                    </span>
                  )}
                </div>

                <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
                  <div className="mb-3 flex items-center justify-between gap-3">
                    <div>
                      <div className="text-sm font-semibold text-slate-900">
                        今日及未来差旅人员
                      </div>
                      <div className="mt-0.5 text-xs text-slate-500">
                        默认展示今天至本月底，支持查看、调整日期和撤回差旅记录。
                      </div>
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={travelDetailsLoading || travelActionSubmitting}
                      onClick={() => void loadTravelDetails(true)}
                    >
                      {travelDetailsLoading ? (
                        <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                      )}
                      刷新
                    </Button>
                  </div>

                  {travelDetailsLoading ? (
                    <div className="flex items-center justify-center gap-2 rounded-lg border border-dashed border-slate-200 bg-slate-50 px-4 py-8 text-sm text-slate-500">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      正在加载差旅详情
                    </div>
                  ) : travelStaffGroups.length === 0 ? (
                    <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50 px-4 py-8 text-center text-sm text-slate-500">
                      今天及未来暂无差旅记录
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {travelStaffGroups.map((group) => {
                        const isStaffExpanded = Boolean(
                          expandedTravelStaffNames[group.id],
                        );

                        return (
                          <div
                            key={group.id}
                            className="rounded-lg border border-slate-200 bg-slate-50/70 p-3"
                          >
                            <button
                              type="button"
                              className="flex w-full flex-wrap items-start justify-between gap-3 text-left"
                              onClick={() => {
                                setExpandedTravelStaffNames((current) => ({
                                  ...current,
                                  [group.id]: !isStaffExpanded,
                                }));
                              }}
                            >
                              <div>
                                <div className="text-sm font-semibold text-slate-900">
                                  {group.staffName}
                                </div>
                                <div className="mt-1 text-xs text-slate-500">
                                  {group.startDate} 至 {group.endDate} ·{' '}
                                  {group.segmentCount} 段 · {group.recordCount}{' '}
                                  条排班
                                </div>
                              </div>
                              <div className="inline-flex items-center gap-1 rounded-md bg-white px-2 py-1 text-xs font-medium text-blue-600 ring-1 ring-blue-100">
                                {isStaffExpanded ? '收起' : '展开'}
                                {isStaffExpanded ? (
                                  <ChevronUp className="h-3.5 w-3.5" />
                                ) : (
                                  <ChevronDown className="h-3.5 w-3.5" />
                                )}
                              </div>
                            </button>

                            {isStaffExpanded ? (
                              <div className="mt-3 overflow-hidden rounded-md border border-slate-200 bg-white">
                                {group.details.map((detail, detailIndex) => {
                                  const isExpanded =
                                    expandedTravelDetailId === detail.id;
                                  const selectedRecordIds =
                                    selectedTravelRecordIds[detail.id] || [];
                                  const selectedRecordIdSet = new Set(
                                    selectedRecordIds,
                                  );
                                  const hasSelectedRecords =
                                    selectedRecordIds.length > 0;

                                  return (
                                    <div
                                      key={detail.id}
                                      className={cn(
                                        'p-3',
                                        detailIndex > 0
                                          ? 'border-t border-slate-100'
                                          : '',
                                      )}
                                    >
                                      <button
                                        type="button"
                                        className="flex w-full flex-wrap items-start justify-between gap-3 text-left"
                                        onClick={() =>
                                          setExpandedTravelDetailId(
                                            isExpanded ? null : detail.id,
                                          )
                                        }
                                      >
                                        <div>
                                          <div className="text-xs font-semibold text-slate-500">
                                            {group.segmentCount > 1
                                              ? `差旅段 ${detailIndex + 1}`
                                              : '差旅排班'}
                                          </div>
                                          <div className="mt-1 text-xs text-slate-500">
                                            {detail.startDate} 至{' '}
                                            {detail.endDate} ·{' '}
                                            {detail.recordCount} 条排班
                                          </div>
                                        </div>
                                        <div className="inline-flex items-center gap-1 rounded-md bg-slate-50 px-2 py-1 text-xs font-medium text-blue-600 ring-1 ring-blue-100">
                                          {isExpanded ? '收起排班' : '查看排班'}
                                          {isExpanded ? (
                                            <ChevronUp className="h-3.5 w-3.5" />
                                          ) : (
                                            <ChevronDown className="h-3.5 w-3.5" />
                                          )}
                                        </div>
                                      </button>

                                      {canManageMonthlySchedule && (
                                        <div className="mt-3 flex flex-wrap items-center gap-2">
                                          <Button
                                            type="button"
                                            variant="outline"
                                            size="sm"
                                            disabled={travelActionSubmitting}
                                            onClick={() =>
                                              startTravelDetailEdit(detail)
                                            }
                                          >
                                            <PencilLine className="mr-1.5 h-3.5 w-3.5" />
                                            一键修改
                                          </Button>
                                          {canDeleteMonthlySchedule && (
                                            <Button
                                              type="button"
                                              variant="outline"
                                              size="sm"
                                              disabled={travelActionSubmitting}
                                              onClick={() =>
                                                void handleRevokeTravelDetail(
                                                  detail,
                                                )
                                              }
                                              className="border-rose-200 text-rose-600 hover:bg-rose-50 hover:text-rose-700"
                                            >
                                              <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
                                              一键撤回
                                            </Button>
                                          )}
                                          {hasSelectedRecords ? (
                                            <>
                                              <Button
                                                type="button"
                                                variant="outline"
                                                size="sm"
                                                disabled={
                                                  travelActionSubmitting
                                                }
                                                onClick={() =>
                                                  startTravelDetailEdit(
                                                    detail,
                                                    selectedRecordIds,
                                                  )
                                                }
                                              >
                                                <PencilLine className="mr-1.5 h-3.5 w-3.5" />
                                                修改选中{' '}
                                                {selectedRecordIds.length}
                                              </Button>
                                              {canDeleteMonthlySchedule && (
                                                <Button
                                                  type="button"
                                                  variant="outline"
                                                  size="sm"
                                                  disabled={
                                                    travelActionSubmitting
                                                  }
                                                  onClick={() =>
                                                    void handleRevokeTravelDetail(
                                                      detail,
                                                      selectedRecordIds,
                                                    )
                                                  }
                                                  className="border-rose-200 text-rose-600 hover:bg-rose-50 hover:text-rose-700"
                                                >
                                                  <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
                                                  撤回选中{' '}
                                                  {selectedRecordIds.length}
                                                </Button>
                                              )}
                                            </>
                                          ) : null}
                                        </div>
                                      )}

                                      {isExpanded ? (
                                        <>
                                          <div className="mt-3 grid gap-2 md:grid-cols-2">
                                            {detail.records.map((record) => {
                                              const selected =
                                                selectedRecordIdSet.has(
                                                  record.recordId,
                                                );
                                              return (
                                                <button
                                                  key={record.recordId}
                                                  type="button"
                                                  onClick={() => {
                                                    setSelectedTravelRecordIds(
                                                      (current) => {
                                                        const currentRecordIds =
                                                          current[detail.id] ||
                                                          [];
                                                        const nextRecordIds =
                                                          currentRecordIds.includes(
                                                            record.recordId,
                                                          )
                                                            ? currentRecordIds.filter(
                                                                (recordId) =>
                                                                  recordId !==
                                                                  record.recordId,
                                                              )
                                                            : [
                                                                ...currentRecordIds,
                                                                record.recordId,
                                                              ];
                                                        return {
                                                          ...current,
                                                          [detail.id]:
                                                            nextRecordIds,
                                                        };
                                                      },
                                                    );
                                                  }}
                                                  className={cn(
                                                    'flex items-start gap-2 rounded-md border px-3 py-2 text-left text-xs transition-colors',
                                                    selected
                                                      ? 'border-blue-300 bg-blue-50 text-blue-700'
                                                      : 'border-slate-200 bg-white text-slate-600 hover:border-blue-200 hover:bg-blue-50/60',
                                                  )}
                                                >
                                                  <span
                                                    className={cn(
                                                      'mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded border',
                                                      selected
                                                        ? 'border-blue-500 bg-blue-600 text-white'
                                                        : 'border-slate-300 bg-white',
                                                    )}
                                                  >
                                                    {selected ? (
                                                      <Check className="h-3 w-3" />
                                                    ) : null}
                                                  </span>
                                                  <span>
                                                    <span className="font-medium text-slate-800">
                                                      {record.scheduleDate}
                                                    </span>
                                                    <span className="mx-1 text-slate-300">
                                                      ·
                                                    </span>
                                                    <span>
                                                      {BUILDING_MAP[
                                                        record.building
                                                      ] ||
                                                        record.buildingText ||
                                                        record.building}
                                                    </span>
                                                    <span className="mx-1 text-slate-300">
                                                      ·
                                                    </span>
                                                    <span>
                                                      {record.shiftText ||
                                                        record.shift}
                                                    </span>
                                                  </span>
                                                </button>
                                              );
                                            })}
                                          </div>

                                          {editingTravelDetail?.id ===
                                          detail.id ? (
                                            <div className="mt-3 grid gap-3 rounded-md border border-blue-100 bg-slate-50 p-3 md:grid-cols-[1fr_1fr_auto] md:items-end">
                                              <div>
                                                <label
                                                  className="mb-1 block text-xs font-semibold text-slate-500"
                                                  htmlFor={`travel-edit-start-${detail.id}`}
                                                >
                                                  调整开始
                                                </label>
                                                <Input
                                                  id={`travel-edit-start-${detail.id}`}
                                                  type="date"
                                                  value={travelEditStartDate}
                                                  onChange={(event) => {
                                                    const value =
                                                      event.target.value;
                                                    setTravelEditStartDate(
                                                      value,
                                                    );
                                                    setTravelEditEndDate(
                                                      (current) => {
                                                        if (
                                                          !current ||
                                                          current < value ||
                                                          current.slice(
                                                            0,
                                                            7,
                                                          ) !==
                                                            value.slice(0, 7)
                                                        ) {
                                                          return value;
                                                        }
                                                        return current;
                                                      },
                                                    );
                                                  }}
                                                  className="h-9 border-slate-200 bg-white focus-visible:ring-blue-200"
                                                />
                                              </div>
                                              <div>
                                                <label
                                                  className="mb-1 block text-xs font-semibold text-slate-500"
                                                  htmlFor={`travel-edit-end-${detail.id}`}
                                                >
                                                  调整结束
                                                </label>
                                                <Input
                                                  id={`travel-edit-end-${detail.id}`}
                                                  type="date"
                                                  value={travelEditEndDate}
                                                  min={
                                                    travelEditStartDate ||
                                                    undefined
                                                  }
                                                  max={
                                                    travelEditStartDate
                                                      ? getMonthEndDateKey(
                                                          travelEditStartDate,
                                                        )
                                                      : undefined
                                                  }
                                                  onChange={(event) =>
                                                    setTravelEditEndDate(
                                                      event.target.value,
                                                    )
                                                  }
                                                  className="h-9 border-slate-200 bg-white focus-visible:ring-blue-200"
                                                />
                                              </div>
                                              <div className="flex gap-2 md:justify-end">
                                                <Button
                                                  type="button"
                                                  variant="outline"
                                                  disabled={
                                                    travelActionSubmitting
                                                  }
                                                  onClick={() => {
                                                    setEditingTravelDetail(
                                                      null,
                                                    );
                                                    setEditingTravelRecordIds(
                                                      [],
                                                    );
                                                  }}
                                                >
                                                  取消
                                                </Button>
                                                <Button
                                                  type="button"
                                                  disabled={
                                                    travelActionSubmitting
                                                  }
                                                  onClick={() =>
                                                    void handleSubmitTravelAdjustment()
                                                  }
                                                  className="bg-blue-600 text-white hover:bg-blue-700"
                                                >
                                                  {travelActionSubmitting ? (
                                                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                                                  ) : null}
                                                  确认调整
                                                </Button>
                                              </div>
                                              {editingTravelRecordIds.length >
                                              0 ? (
                                                <div className="text-xs text-blue-600 md:col-span-3">
                                                  本次仅调整已选中的{' '}
                                                  {
                                                    editingTravelRecordIds.length
                                                  }{' '}
                                                  条差旅排班。
                                                </div>
                                              ) : null}
                                            </div>
                                          ) : null}
                                        </>
                                      ) : (
                                        <div className="mt-3 flex flex-wrap gap-2 text-xs text-slate-600">
                                          {detail.records
                                            .slice(0, 4)
                                            .map((record) => (
                                              <span
                                                key={record.recordId}
                                                className="rounded-md bg-slate-50 px-2 py-1 ring-1 ring-slate-200"
                                              >
                                                {record.scheduleDate} ·{' '}
                                                {BUILDING_MAP[
                                                  record.building
                                                ] ||
                                                  record.buildingText ||
                                                  record.building}{' '}
                                                ·{' '}
                                                {record.shiftText ||
                                                  record.shift}
                                              </span>
                                            ))}
                                          {detail.records.length > 4 ? (
                                            <span className="rounded-md bg-slate-50 px-2 py-1 text-slate-400 ring-1 ring-slate-200">
                                              另 {detail.records.length - 4} 条
                                            </span>
                                          ) : null}
                                        </div>
                                      )}
                                    </div>
                                  );
                                })}
                              </div>
                            ) : (
                              <div className="mt-3 flex flex-wrap gap-2 text-xs text-slate-600">
                                {group.details.slice(0, 4).map((detail) => (
                                  <span
                                    key={detail.id}
                                    className="rounded-md bg-white px-2 py-1 ring-1 ring-slate-200"
                                  >
                                    {detail.startDate} 至 {detail.endDate} ·{' '}
                                    {detail.recordCount} 条
                                  </span>
                                ))}
                                {group.details.length > 4 ? (
                                  <span className="rounded-md bg-white px-2 py-1 text-slate-400 ring-1 ring-slate-200">
                                    另 {group.details.length - 4} 段
                                  </span>
                                ) : null}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

          <div className="flex flex-col gap-2 border-t border-slate-100 bg-slate-50 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="text-xs text-slate-500">
              {staffAdjustmentMode === 'vacancy'
                ? `已填写 ${filledVacancyCount} / ${vacancyCandidates.length} 个缺岗替班`
                : staffAdjustmentMode === 'repair'
                  ? repairDateLoading
                    ? `${repairDateKey} · 正在加载排班数据`
                    : selectedRepairCandidate
                      ? `${repairDateKey} · ${selectedRepairCandidate.buildingLabel} · ${selectedRepairCandidate.shiftLabel} · ${selectedRepairCandidate.staffNames.length} 人`
                      : '请选择有值班人员的楼栋班次'
                  : staffAdjustmentMode === 'emergency'
                    ? `${emergencyDutyDate} · 已选 ${emergencyDutySelectedKeys.length} 人${emergencyDutyDraftSyncState === 'unknown-result' ? ' · 待安全重试' : ''}`
                    : travelStaffName
                      ? `${travelStaffName} · ${travelStartDate || '未选开始日期'} 至 ${travelEndDate || '未选结束日期'}`
                      : '请选择差旅人员和日期'}
            </div>
            <div className="flex items-center justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={
                  vacancySubmitting ||
                  repairSubmitting ||
                  travelSubmitting ||
                  travelActionSubmitting
                }
                onClick={() => setVacancyDialogOpen(false)}
              >
                取消
              </Button>
              <Button
                type="button"
                disabled={
                  !(staffAdjustmentMode === 'emergency' ? (emergencyDutyIndex.get(emergencyDutyDate)?.recordId && !emergencyDutyIndex.get(emergencyDutyDate)?.recordId.startsWith('optimistic-') ? canManageMonthlySchedule : canCreateMonthlySchedule) : staffAdjustmentMode === 'travel' ? canCreateMonthlySchedule : canManageMonthlySchedule) ||
                  (staffAdjustmentMode === 'vacancy'
                    ? vacancySubmitting || filledVacancyCount === 0
                    : staffAdjustmentMode === 'repair'
                      ? repairSubmitting ||
                        repairDateLoading ||
                        !selectedRepairCandidate ||
                        !repairTargetName ||
                        !repairStaffOptions.includes(
                          repairReplacementName.trim(),
                        )
                      : staffAdjustmentMode === 'emergency'
                        ? emergencyDutySubmissionIssue !== null
                        : travelSubmitting ||
                          travelActionSubmitting ||
                          !travelStaffName.trim() ||
                          !travelStartDate ||
                          !travelEndDate)
                }
                onClick={() => {
                  if (staffAdjustmentMode === 'vacancy') {
                    void handleSubmitVacancySubstitutes();
                  } else if (staffAdjustmentMode === 'repair') {
                    void handleSubmitStaffRepair();
                  } else if (staffAdjustmentMode === 'emergency') {
                    void handleSubmitEmergencyDuty();
                  } else {
                    void handleSubmitTravelStaff();
                  }
                }}
                className="bg-blue-600 text-white hover:bg-blue-700"
              >
                {vacancySubmitting ||
                repairSubmitting ||
                travelSubmitting ||
                travelActionSubmitting ? (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                ) : staffAdjustmentMode === 'vacancy' ? (
                  <UserPlus className="mr-1.5 h-3.5 w-3.5" />
                ) : staffAdjustmentMode === 'travel' ? (
                  <ClipboardPlus className="mr-1.5 h-3.5 w-3.5" />
                ) : staffAdjustmentMode === 'emergency' ? (
                  <ShieldAlert className="mr-1.5 h-3.5 w-3.5" />
                ) : (
                  <PencilLine className="mr-1.5 h-3.5 w-3.5" />
                )}
                {staffAdjustmentMode === 'emergency' &&
                emergencyDutyDraftSyncState === 'unknown-result'
                  ? '安全重试'
                  : '确认写入'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog
        open={Boolean(pendingTravelRevoke)}
        onOpenChange={(open) => {
          if (!open && !travelActionSubmitting) {
            setPendingTravelRevoke(null);
          }
        }}
      >
        <DialogContent
          className="w-[calc(100vw-2rem)] max-w-md"
          showCloseButton={!travelActionSubmitting}
        >
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base font-semibold text-slate-900">
              <RotateCcw className="h-4 w-4 text-rose-600" />
              确认撤回差旅记录
            </DialogTitle>
            <DialogDescription className="text-sm leading-6 text-slate-500">
              {pendingTravelRevoke?.recordIds.length ? (
                <>
                  将撤回 {pendingTravelRevoke.detail.staffName} 选中的{' '}
                  {pendingTravelRevoke.recordIds.length} 条差旅记录。
                </>
              ) : pendingTravelRevoke ? (
                <>
                  将撤回 {pendingTravelRevoke.detail.staffName}{' '}
                  {pendingTravelRevoke.detail.startDate} 至{' '}
                  {pendingTravelRevoke.detail.endDate} 的差旅记录。
                </>
              ) : null}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={travelActionSubmitting}
              onClick={() => setPendingTravelRevoke(null)}
            >
              取消
            </Button>
            <Button
              type="button"
              disabled={travelActionSubmitting || !canDeleteMonthlySchedule}
              onClick={() => void confirmRevokeTravelDetail()}
              className="bg-rose-600 text-white hover:bg-rose-700"
            >
              {travelActionSubmitting ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : null}
              确认撤回
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={sealingRegistrationDialogOpen}
        onOpenChange={(open) => {
          if (!sealingRegistrationSubmitting) {
            setSealingRegistrationDialogOpen(open);
          }
        }}
      >
        <DialogContent className="max-h-[84vh] w-[calc(100vw-2rem)] max-w-4xl overflow-hidden p-0">
          <DialogHeader className="border-b border-slate-100 px-5 py-4">
            <DialogTitle className="flex items-center gap-2 text-base font-semibold text-slate-900">
              <ShieldAlert className="h-4 w-4 text-blue-600" />
              封网登记
            </DialogTitle>
            <p className="text-sm text-slate-500">
              写入封网信息多维表，支持一次添加多条，提交后刷新当前年份封网数据。
            </p>
          </DialogHeader>

          <div className="max-h-[58vh] space-y-3 overflow-y-auto px-5 py-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="text-xs font-semibold text-slate-500">
                封网明细
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={sealingRegistrationSubmitting}
                onClick={handleAddSealingRegistrationRow}
                className="h-8 border-blue-200 text-blue-700 hover:bg-blue-50 hover:text-blue-700"
              >
                <ClipboardPlus className="mr-1.5 h-3.5 w-3.5" />
                新增一条
              </Button>
            </div>

            {sealingRegistrationRows.map((row, index) => (
              <div
                key={row.id}
                className="space-y-3 rounded-lg border border-slate-200 bg-white p-3"
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="text-sm font-semibold text-slate-800">
                    第 {index + 1} 条
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={`删除第 ${index + 1} 条封网登记`}
                    disabled={
                      sealingRegistrationSubmitting ||
                      sealingRegistrationRows.length <= 1
                    }
                    onClick={() => handleRemoveSealingRegistrationRow(row.id)}
                    className="h-8 w-8 text-slate-400 hover:bg-rose-50 hover:text-rose-600 disabled:opacity-40"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>

                <div className="grid gap-2">
                  <label
                    htmlFor={`sealing-registration-info-${row.id}`}
                    className="text-xs font-semibold text-slate-500"
                  >
                    封网信息
                  </label>
                  <Textarea
                    id={`sealing-registration-info-${row.id}`}
                    value={row.sealingInfo}
                    onChange={(event) =>
                      updateSealingRegistrationRow(row.id, {
                        sealingInfo: event.target.value,
                      })
                    }
                    placeholder="填写封网名称或封网说明"
                    className="min-h-20 resize-none border-slate-200 bg-slate-50 focus-visible:ring-blue-200"
                  />
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="grid gap-2">
                    <label
                      htmlFor={`sealing-registration-start-${row.id}`}
                      className="text-xs font-semibold text-slate-500"
                    >
                      封网开始时间
                    </label>
                    <Input
                      id={`sealing-registration-start-${row.id}`}
                      type="datetime-local"
                      step={60}
                      value={row.startTime}
                      onChange={(event) =>
                        handleUpdateSealingRegistrationStartTime(
                          row.id,
                          event.target.value,
                        )
                      }
                      className="h-9 border-slate-200 bg-slate-50 focus-visible:ring-blue-200"
                    />
                  </div>
                  <div className="grid gap-2">
                    <label
                      htmlFor={`sealing-registration-end-${row.id}`}
                      className="text-xs font-semibold text-slate-500"
                    >
                      封网结束时间
                    </label>
                    <Input
                      id={`sealing-registration-end-${row.id}`}
                      type="datetime-local"
                      step={60}
                      min={row.startTime || undefined}
                      value={row.endTime}
                      onChange={(event) =>
                        updateSealingRegistrationRow(row.id, {
                          endTime: event.target.value,
                        })
                      }
                      className="h-9 border-slate-200 bg-slate-50 focus-visible:ring-blue-200"
                    />
                  </div>
                </div>
              </div>
            ))}
          </div>

          <div className="flex flex-col gap-2 border-t border-slate-100 bg-slate-50 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="text-xs text-slate-500">
              写入封网信息多维表：共 {sealingRegistrationRows.length} 条
            </div>
            <div className="flex items-center justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={sealingRegistrationSubmitting}
                onClick={() => setSealingRegistrationDialogOpen(false)}
              >
                取消
              </Button>
              <Button
                type="button"
                disabled={
                  sealingRegistrationSubmitting ||
                  !canCreateMonthlySchedule ||
                  sealingRegistrationRows.some(
                    (row) =>
                      !row.sealingInfo.trim() || !row.startTime || !row.endTime,
                  )
                }
                onClick={() => {
                  void handleSubmitSealingRegistration();
                }}
                className="bg-blue-600 text-white hover:bg-blue-700"
              >
                {sealingRegistrationSubmitting ? (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <ShieldAlert className="mr-1.5 h-3.5 w-3.5" />
                )}
                确认登记
                {sealingRegistrationRows.length > 1
                  ? ` ${sealingRegistrationRows.length} 条`
                  : ''}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
      {weatherGuardRegistrationEnabled && (
        <WeatherWarningGuardRegistrationDialog
          open={weatherGuardRegistration !== null}
          warningId={weatherGuardRegistration?.warningId ?? null}
          source={weatherGuardRegistration?.source ?? 'page'}
          onOpenChange={(nextOpen) => {
            if (!nextOpen) handleWeatherGuardRegistrationClose();
          }}
          onBackgroundSyncChange={(syncing) => {
            weatherGuardRegistrationSyncingRef.current = syncing;
            if (!syncing || typeof window === 'undefined') return;
            window.requestAnimationFrame(() => {
              const returnFocusTarget =
                weatherGuardRegistrationReturnFocusRef.current;
              const focusTarget = returnFocusTarget?.isConnected
                ? returnFocusTarget
                : weatherGuardRegistrationFallbackRef.current?.isConnected
                  ? weatherGuardRegistrationFallbackRef.current
                  : null;
              focusTarget?.focus({ preventScroll: true });
            });
          }}
          onSubmitted={() => {
            void weatherSnapshot.refreshWarning();
          }}
        />
      )}
      <ChangeRequestDialogHost
        ref={changeRequestDialogRef}
        onOpenStateChange={handleChangeRequestDialogOpenStateChange}
        ownerMutationId={changeRequestOwnerMutationId}
        initialDraft={changeRequestDraft}
        initialStagedDocuments={changeRequestStagedDocuments}
        attachmentRetryLocked={Boolean(changeRequestRetryAction)}
        retryAction={changeRequestRetryAction}
        resetKey={changeRequestResetKey}
        submitting={changeRequestSubmitting}
        serverError={changeRequestServerError}
        onDraftChange={() => {
          setChangeRequestServerError(null);
        }}
        onSubmit={handleSubmitChangeRequest}
      />
      <ChangeAdjustmentDialog
        key={changeAdjustmentRequestOwnerMutationId}
        open={changeAdjustmentRequestOpen}
        ownerMutationId={changeAdjustmentRequestOwnerMutationId}
        changes={changes}
        initialRecordId={changeAdjustmentRequestInitialRecordId}
        submitting={changeAdjustmentRequestSubmitting}
        serverError={changeAdjustmentRequestServerError}
        retryBinding={changeAdjustmentRequestRetryBinding}
        onOpenChange={(open) => {
          setChangeAdjustmentRequestOpen(open);
          if (
            !changeAdjustmentRequestRetryBinding &&
            !open &&
            !changeAdjustmentRequestSubmittingRef.current
          ) {
            setChangeAdjustmentRequestOwnerMutationId(
              createChangeAdjustmentMutationId(),
            );
            setChangeAdjustmentRequestInitialRecordId(null);
            setChangeAdjustmentRequestServerError(null);
          }
        }}
        onSubmit={handleSubmitChangeAdjustmentRequest}
      />
      <ChangeDrillReportDialog
        key={changeDrillReportOwnerMutationId}
        open={changeDrillReportOpen}
        ownerMutationId={changeDrillReportOwnerMutationId}
        changes={changes}
        submitting={changeDrillReportSubmitting}
        serverError={changeDrillReportServerError}
        retryBinding={changeDrillReportRetryBinding}
        onOpenChange={(open) => {
          setChangeDrillReportOpen(open);
          if (
            !changeDrillReportRetryBinding &&
            !open &&
            !changeDrillReportSubmittingRef.current
          ) {
            setChangeDrillReportServerError(null);
            setChangeDrillReportOwnerMutationId(
              createChangeDrillReportMutationId(),
            );
          }
        }}
        onDraftChange={() => setChangeDrillReportServerError(null)}
        onSubmit={handleSubmitChangeDrillReport}
      />
      {canSubmitChangeSummaryReport ? (
        <ChangeSummaryReportDialog
          key={changeSummaryReportOwnerMutationId}
          open={changeSummaryReportOpen}
          ownerMutationId={changeSummaryReportOwnerMutationId}
          changes={changes}
          personOptions={changeRequestSubmitterOptions}
          changesStatus={screenshotReadiness.changes}
          personOptionsStatus={screenshotReadiness.personProfiles}
          pendingChangeRecordIds={pendingChangeSummaryReportRecordIds}
          submitting={changeSummaryReportSubmitting}
          abandoning={changeSummaryReportAbandonOperation !== null}
          serverError={changeSummaryReportServerError}
          retryBinding={activeChangeSummaryReportRetryBinding}
          onOpenChange={(open) => {
            changeSummaryReportOpenRef.current = open;
            setChangeSummaryReportOpen(open);
            if (
              !activeChangeSummaryReportRetryBinding &&
              !open &&
              !changeSummaryReportSubmittingRef.current
            ) {
              setChangeSummaryReportServerError(null);
              setChangeSummaryReportOwnerMutationId(
                createChangeSummaryReportMutationId(),
              );
            }
          }}
          onDraftChange={() => setChangeSummaryReportServerError(null)}
          onSubmit={handleSubmitChangeSummaryReport}
          onAbandonFailed={handleAbandonFailedChangeSummaryReport}
        />
      ) : null}
      <ThresholdAdjustmentDialog
        open={thresholdAdjustmentDialogOpen}
        onOpenChange={setThresholdAdjustmentDialogOpen}
      />
      <PersonnelTimeInsightsDialog
        open={canReadTimeInsights && personnelTimeInsightsDialogOpen}
        onOpenChange={setPersonnelTimeInsightsDialogOpen}
        profiles={personProfileDetails}
      />
      <Dialog
        open={leaveRequestDialogOpen}
        onOpenChange={(open) => {
          if (!leaveRequestSubmitting) {
            setLeaveRequestDialogOpen(open);
          }
        }}
      >
        <DialogContent
          singleContainer
          onCloseAutoFocus={(event) => {
            const target = leaveRequestReturnFocusRef.current;
            leaveRequestReturnFocusRef.current = null;
            if (target?.isConnected) {
              event.preventDefault();
              target.focus({ preventScroll: true });
            }
          }}
          className="max-h-[84vh] w-[calc(100vw-2rem)] max-w-2xl overflow-hidden p-0"
        >
          <DialogHeader className="border-b border-slate-100 px-5 py-4">
            <DialogTitle className="flex items-center gap-2 text-base font-semibold text-slate-900">
              <CalendarClock className="h-4 w-4 text-blue-600" />
              请休假&差旅申请
            </DialogTitle>
          </DialogHeader>

          <div className="max-h-[58vh] space-y-4 overflow-y-auto px-5 py-4">
            <div className="grid gap-2">
              <label
                htmlFor="leave-staff-name"
                className="text-xs font-semibold text-slate-500"
              >
                申请人员
              </label>
              <LeaveRequestPersonPicker
                selectedName={leaveStaffName}
                options={leaveStaffOptions}
                disabled={leaveRequestDraftLocked}
                readOnly={leaveApplicant.mode === 'automatic'}
                matches={isFuzzyStaffNameMatch}
                onSelect={setLeaveStaffName}
              />
            </div>

            {leaveStaffName.trim() ? (
              selectedLeaveStaffProfile ? (
                <div className="rounded-lg border border-blue-100 bg-blue-50/60 px-3 py-3 text-xs text-slate-700">
                  <div className="mb-2 font-semibold text-blue-800">
                    人员信息
                  </div>
                  <div className="grid gap-2 sm:grid-cols-3">
                    <div>
                      <span className="text-slate-500">所属楼栋：</span>
                      <span className="font-medium">
                        {selectedLeaveStaffProfile.buildingsSpecialties.join(
                          '、',
                        ) || '未维护'}
                      </span>
                    </div>
                    <div>
                      <span className="text-slate-500">岗位：</span>
                      <span className="font-medium">
                        {selectedLeaveStaffProfile.position || '未维护'}
                      </span>
                    </div>
                    <div>
                      <span className="text-slate-500">默认班次：</span>
                      <span className="font-medium">
                        {selectedLeaveStaffProfile.shift || '未维护'}
                      </span>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                  {leaveApplicant.mode === 'automatic'
                    ? screenshotReadiness.personProfiles === 'error'
                      ? '人员资料加载失败，请关闭后重试。'
                      : screenshotReadiness.personProfiles === 'loading'
                        ? '正在加载人员资料…'
                        : '未匹配到登录人员，请联系管理员核对人员资料。'
                    : '未匹配到该人员，请从下拉列表中选择。'}
                </div>
              )
            ) : null}

            <div className="grid gap-3 sm:grid-cols-2">
              <LeaveRequestScheduleTimeFields
                startAt={leaveStartAt}
                endAt={leaveEndAt}
                startOptions={leaveTimeCandidates.startOptions}
                endOptions={leaveEndTimeCandidates.endOptions}
                shiftRanges={leaveTimeCandidates.shiftRanges}
                disabled={leaveRequestDraftLocked || !selectedLeaveStaffProfile}
                loading={leaveScheduleCoverageStatus === 'loading'}
                onStartAtChange={handleLeaveStartAtChange}
                onEndAtChange={setLeaveEndAt}
              />
              <div className="grid gap-2">
                <label
                  htmlFor="leave-type"
                  className="text-xs font-semibold text-slate-500"
                >
                  类型
                </label>
                <select
                  id="leave-type"
                  value={leaveType}
                  disabled={leaveRequestDraftLocked}
                  onChange={(event) =>
                    setLeaveType(event.target.value as LeaveRequestType)
                  }
                  className="h-9 rounded-md border border-slate-200 bg-slate-50 px-3 text-sm text-slate-800 outline-none focus:border-blue-300 focus:ring-2 focus:ring-blue-200"
                >
                  {(
                    [
                      '年假',
                      '病假',
                      '育儿假',
                      '调休',
                      '复审',
                      '事假',
                      '丧假',
                      '婚假',
                      '差旅',
                    ] as LeaveRequestType[]
                  ).map((type) => (
                    <option key={type} value={type}>
                      {type}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="grid gap-2">
              <label
                htmlFor="leave-reason"
                className="text-xs font-semibold text-slate-500"
              >
                原因
              </label>
              <Textarea
                id="leave-reason"
                value={leaveReason}
                maxLength={LEAVE_REQUEST_REASON_MAX_LENGTH}
                disabled={leaveRequestDraftLocked}
                onChange={(event) => setLeaveReason(event.target.value)}
                placeholder="填写原因"
                className="min-h-24 resize-none border-slate-200 bg-slate-50 focus-visible:ring-blue-200"
              />
            </div>

            <LeaveRequestScreenshotField
              file={leaveRequestScreenshot}
              disabled={leaveRequestDraftLocked}
              active={leaveRequestDialogOpen}
              onChange={(file) => {
                setLeaveRequestScreenshot(file);
                setLeaveRequestSyncStatus('idle');
              }}
              onRemove={() => {
                setLeaveRequestScreenshot(null);
                setLeaveRequestSyncStatus('idle');
              }}
              onError={(message) => toast.warning(message)}
            />

            {selectedLeaveStaffProfile ? (
              <LeaveRequestHoursSummary
                coverageStatus={leaveScheduleCoverageStatus}
                isCoverageReady={isLeaveScheduleCoverageReady}
                hasTimeRange={Boolean(leaveStartAt && leaveEndAt)}
                impact={leaveImpact}
                submitting={leaveRequestSubmitting}
                onRetry={handleRetryLeaveScheduleCoverage}
              />
            ) : null}
          </div>

          <div className="flex flex-col gap-2 border-t border-slate-100 bg-slate-50 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="text-xs text-slate-500">
              {leaveRequestSyncStatus === 'syncing'
                ? '正在提交请休假...'
                : leaveRequestRecoveryState === 'unknown-result'
                  ? recoveredLeaveRequestMutationId
                    ? '检测到上次提交结果待确认，请重新填写原申请并上传同一截图，系统将复用原申请标识安全对账。'
                    : '提交结果待确认，当前草稿已锁定；可用原申请标识安全重试对账。'
                  : leaveScheduleCoverageStatus === 'loading'
                    ? '正在加载完整日期范围内的排班，加载完成后开放登记。'
                    : leaveScheduleCoverageStatus === 'error'
                      ? '排班加载失败，已保留草稿，请稍后重试。'
                      : leaveRequestSyncStatus === 'error'
                        ? '提交失败，已保留当前填写内容，可修改后重试。'
                        : `休假时段：${leaveStartAt ? leaveStartAt.replace('T', ' ') : '未选开始时间'} 至 ${leaveEndAt ? leaveEndAt.replace('T', ' ') : '未选结束时间'}`}
            </div>
            <div className="flex items-center justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={leaveRequestSubmitting}
                onClick={() => setLeaveRequestDialogOpen(false)}
              >
                取消
              </Button>
              <Button
                type="button"
                disabled={
                  hasLockedLeaveRequestRetry
                    ? leaveRequestSubmitting || !canCreateLeaveRequest
                    : leaveRequestSubmitting ||
                      !canCreateLeaveRequest ||
                      !leaveStaffName.trim() ||
                      !selectedLeaveStaffProfile ||
                      !leaveStartAt ||
                      !leaveEndAt ||
                      !leaveTimeCandidates.startOptions.includes(
                        leaveStartAt,
                      ) ||
                      !leaveEndTimeCandidates.endOptions.includes(leaveEndAt) ||
                      !isLeaveScheduleCoverageReady ||
                      leaveImpact.invalidRange ||
                      leaveImpact.unrecognizedShifts.length > 0 ||
                      leaveImpact.missingCalendarYears.length > 0 ||
                      leaveImpact.rawHours < 4 ||
                      !leaveType ||
                      !leaveReason.trim() ||
                      !leaveRequestScreenshot
                }
                onClick={() => {
                  void handleSubmitLeaveRequest();
                }}
                className="bg-blue-600 text-white hover:bg-blue-700"
              >
                {leaveRequestSubmitting ? (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <CalendarClock className="mr-1.5 h-3.5 w-3.5" />
                )}
                {leaveRequestSubmitting
                  ? '提交中'
                  : leaveRequestRecoveryState === 'unknown-result'
                    ? '安全重试'
                    : '提交'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
      <OvertimeRequestDialogHost
        ref={overtimeRequestDialogRef}
        applicantOverride={selfServiceApplicant}
        canUseSelfServiceTools={canCreateOvertimeRequest}
        personProfiles={personProfiles}
        personProfilesStatus={screenshotReadiness.personProfiles}
        onRetryPersonProfiles={loadPersonProfiles}
        schedules={schedules}
        ensureSchedulesForDateRange={ensureSchedulesForLeaveDateRange}
      />
      <NewEmployeeOnboardingDialogHost ref={employeeOnboardingDialogRef} />
      <OvertimeConfirmationDeepLinkHost />
      <Dialog
        open={additionalMatterDialogOpen}
        onOpenChange={(open) => {
          if (!additionalMatterSubmitting) {
            setAdditionalMatterDialogOpen(open);
          }
        }}
      >
        <DialogContent className="max-h-[82vh] w-[calc(100vw-2rem)] max-w-2xl overflow-hidden p-0">
          <DialogHeader className="border-b border-slate-100 px-5 py-4">
            <DialogTitle className="flex items-center gap-2 text-base font-semibold text-slate-900">
              <ClipboardPlus className="h-4 w-4 text-blue-600" />
              其他事宜补充
            </DialogTitle>
            <p className="text-sm text-slate-500">
              按事项类型写入对应飞书多维表。
            </p>
          </DialogHeader>

          <div className="border-b border-slate-100 px-5 py-3">
            <div className="grid grid-cols-2 rounded-lg bg-slate-100 p-1">
              {(
                [
                  ['focus', '重点事宜登记'],
                  ['customer', '客户相关'],
                ] as Array<[AdditionalMatterMode, string]>
              ).map(([mode, label]) => (
                <Button
                  key={mode}
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setAdditionalMatterMode(mode)}
                  className={cn(
                    'h-8 rounded-md text-sm font-semibold',
                    additionalMatterMode === mode
                      ? 'bg-white text-blue-700 shadow-sm'
                      : 'text-slate-500 hover:bg-white/70 hover:text-slate-800',
                  )}
                >
                  {label}
                </Button>
              ))}
            </div>
          </div>

          <div className="space-y-4 px-5 py-4">
            <div className="grid gap-2">
              <label
                htmlFor="additional-matter-date"
                className="text-xs font-semibold text-slate-500"
              >
                事项日期
              </label>
              <Input
                id="additional-matter-date"
                type="date"
                value={additionalMatterDate}
                onChange={(event) =>
                  setAdditionalMatterDate(event.target.value)
                }
                className="h-9 max-w-48 border-slate-200 bg-slate-50 focus-visible:ring-blue-200"
              />
            </div>
            <div className="grid gap-2">
              <label
                htmlFor="additional-matter-content"
                className="text-xs font-semibold text-slate-500"
              >
                {additionalMatterMode === 'customer'
                  ? '客户相关内容'
                  : '重点事宜内容'}
              </label>
              <Textarea
                id="additional-matter-content"
                value={additionalMatterContent}
                onChange={(event) =>
                  setAdditionalMatterContent(event.target.value)
                }
                placeholder={
                  additionalMatterMode === 'customer'
                    ? '填写客户来访、沟通、需求或其他客户相关事项'
                    : '填写今日重点事宜、异常关注或需要交接的事项'
                }
                className="min-h-32 resize-none border-slate-200 bg-slate-50 focus-visible:ring-blue-200"
              />
            </div>
          </div>

          <div className="flex flex-col gap-2 border-t border-slate-100 bg-slate-50 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="text-xs text-slate-500">
              {additionalMatterMode === 'customer'
                ? '写入客户相关多维表'
                : '写入重点事宜登记多维表'}
            </div>
            <div className="flex items-center justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={additionalMatterSubmitting}
                onClick={() => setAdditionalMatterDialogOpen(false)}
              >
                取消
              </Button>
              <Button
                type="button"
                disabled={
                  additionalMatterSubmitting ||
                  !canCreateAdditionalMatter ||
                  !additionalMatterContent.trim()
                }
                onClick={() => {
                  void handleSubmitAdditionalMatter();
                }}
                className="bg-blue-600 text-white hover:bg-blue-700"
              >
                {additionalMatterSubmitting ? (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <ClipboardPlus className="mr-1.5 h-3.5 w-3.5" />
                )}
                确认登记
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
      <SealingDetailDialog
        open={sealingDetailDate !== null}
        onOpenChange={(open) => {
          if (!open) setSealingDetailDate(null);
        }}
        model={sealingDetailModel}
        loadState={screenshotReadiness.sealings}
        restoreFocusTo={sealingDetailTriggerRef.current}
      />
    </div>
  );
}

export default function MonthlySchedulePage() {
  const { principalFingerprint, role } = useAccess();
  const identityKey = principalFingerprint || role;
  if (getHasScreenshotModeRequest()) {
    return (
      <MonthlyScheduleScreenshotAccessGuard>
        <MonthlySchedulePageContent key={identityKey} />
      </MonthlyScheduleScreenshotAccessGuard>
    );
  }

  return <MonthlySchedulePageContent key={identityKey} />;
}

function getMonthlyScheduleScreenshotAccessPayload() {
  if (typeof window === 'undefined') {
    return {
      audience: 'monthly-schedule' as const,
      screenshotDate: null,
      token: null,
    };
  }
  const params = new URLSearchParams(window.location.search);
  return {
    audience: 'monthly-schedule' as const,
    screenshotDate: params.get('screenshotDate'),
    token: params.get('screenshotToken'),
  };
}

function MonthlyScheduleScreenshotAccessGuard({
  children,
}: {
  children: React.ReactNode;
}) {
  const [checking, setChecking] = useState(true);
  const [authorized, setAuthorized] = useState(false);

  useEffect(() => {
    let alive = true;

    async function verifyScreenshotAccess() {
      setChecking(true);
      try {
        const result = await checkMonthlyScheduleScreenshotAccess(
          getMonthlyScheduleScreenshotAccessPayload(),
        );
        if (!alive) return;
        const nextAuthorized = Boolean(result.authorized);
        setMonthlyScheduleScreenshotAuthorized(nextAuthorized);
        setAuthorized(nextAuthorized);
      } catch (error) {
        logger.warn('Monthly schedule screenshot access check failed', error);
        if (!alive) return;
        setMonthlyScheduleScreenshotAuthorized(false);
        setAuthorized(false);
      } finally {
        if (alive) setChecking(false);
      }
    }

    void verifyScreenshotAccess();
    return () => {
      alive = false;
      setMonthlyScheduleScreenshotAuthorized(false);
    };
  }, []);

  if (authorized) {
    return <>{children}</>;
  }

  if (checking) {
    return (
      <div className="min-h-screen bg-slate-50 px-4 py-10">
        <div className="mx-auto max-w-xl rounded-lg border border-slate-200 bg-white p-6 text-slate-700 shadow-sm">
          <div className="flex items-center gap-3">
            <Loader2 className="h-5 w-5 animate-spin text-blue-600" />
            <span>正在校验截图访问权限</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 px-4 py-10">
      <div className="mx-auto max-w-xl rounded-lg border border-rose-200 bg-white p-6 text-rose-700 shadow-sm">
        <div className="flex items-center gap-3">
          <ShieldAlert className="h-5 w-5" />
          <span>截图访问校验失败</span>
        </div>
      </div>
    </div>
  );
}
