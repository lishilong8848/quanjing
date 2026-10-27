import React, {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { toast } from 'sonner';
import {
  AlertCircle,
  ArrowUpRight,
  BarChart3,
  Bell,
  Briefcase,
  CalendarCheck,
  Camera,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ClipboardCheck,
  Clock3,
  Eye,
  FileUp,
  HardHat,
  HelpCircle,
  ImageIcon,
  Layers3,
  ListChecks,
  Loader2,
  LockKeyhole,
  MapPinned,
  PenLine,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Trash2,
  UploadCloud,
  UserCheck,
  Wrench,
  X,
} from 'lucide-react';

import {
  createConstructionApplication,
  createConstructionFollowup,
  deleteConstructionAttachment,
  deleteConstructionProject,
  getConstructionAttachmentDownloadUrl,
  getConstructionManagement,
  getSyncTaskStatus,
  searchConstructionChangeOrders,
  searchConstructionOnsiteFollowers,
  syncConstructionCrewRosterFromUpload,
  terminateConstructionProject,
  updateConstructionIsolationPhotoManualReview,
  updateConstructionPermitManualReview,
} from '@/api';
import { getAccessRoleLabel, useAccess } from '@/access/AccessProvider';
import { isConstructionManualReviewAutoApprovalRole } from '@shared/construction-manual-review-policy';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import {
  CONSTRUCTION_COMPLETION_CHECKLIST_ITEMS,
  CONSTRUCTION_DAILY_COMPLETION_CHECKLIST_ITEMS,
  CONSTRUCTION_FULL_COMPLETION_CHECKLIST_ITEMS,
  type ConstructionCompletionChecklistAnswer,
  type ConstructionCompletionChecklistTemplateItem,
} from '@shared/api.interface';
import {
  buildDailyPersonnelCheckText,
  getConstructionCrewAuthorizationSummary,
} from '@shared/construction-personnel-check';
import type {
  ConstructionAttachmentGroup,
  ConstructionAttachmentFile,
  ConstructionChangeOrderCandidate,
  ConstructionCrewMemberItem,
  ConstructionFollowupItem,
  ConstructionImageAuditStatus,
  ConstructionManagementResponse,
  ConstructionOverviewItem,
  ConstructionPermitManualReviewDecision,
  ConstructionStaffCandidate,
  ConstructionCrewRosterUploadSyncResponse,
} from '@shared/api.interface';
import {
  getDailyProgressReferenceDate,
  getDailyProgressCandidateItems,
  getDailyPrepareEvidence,
  getDailyProgressStagePrimaryMetric,
  groupDailyProgressItems,
  isInitialApplicationFollowupByEvidence,
  isDailyFollowupOnDate,
  type DailyFollowupStage,
  type DailyFollowupStageProgress,
} from './daily-progress';
import {
  buildConstructionAiAuditProblemEntries,
  resolveConstructionAttachmentAuditPresentation,
  resolveConstructionLifecycleAuditPolicy,
  resolveConstructionMaterialSubmissionState,
} from './ai-audit-policy';
import {
  DAILY_PERMIT_DEFINITIONS,
  getBlockingDailyPermitIssues,
  getDailyPermitAuditDetails,
  getDailyPermitDisplayMessage,
  getDailyPermitInvalidDetails,
  getDailyPermitNextRefreshDelay,
  getDailyPermitSummary,
  getDailyPermitVerificationTone,
  getDailyPermitVerifications,
  isDailyFollowupStageAllowedByPermits,
  type DailyPermitVerification,
} from './daily-permit-verification';
import {
  buildCalendarDayDetail,
  type CalendarDayDetail,
} from './calendar-day-detail';
import {
  type DailyChecklistActionKind,
  type DailyChecklistActionItem,
  isDailyChecklistActionable,
} from './daily-progress-actions';
import {
  buildDailyIsolationAuditSummary,
  type DailyIsolationAuditSummary,
} from './daily-isolation-audit';
import {
  getDefaultExpandedProjectIds,
  getVisibleProjectItems,
  sortProjectItemsByCreatedAtDesc,
} from './project-expansion';
import {
  createEmptyOnlineWorkFormDraft,
  createOnlineWorkFormPeopleFromCrewMembers,
  getOnlineWorkFormTarget,
  type OnlineWorkFormCrewMember,
  type OnlineWorkFormDraft,
  type OnlineWorkFormTarget,
} from './online-work-form-model';
import {
  applyOptimisticFollowupPatch,
  applyOptimisticProjectPatch,
  applyProjectTombstones,
  appendTemporaryProject,
  captureFollowupFieldSnapshot,
  captureProjectFieldSnapshot,
  createTemporaryConstructionProject,
  dequeueFailedApplicationDraft,
  getTerminationUiRestoreDecisions,
  isOptimisticConstructionRecordId,
  isFollowupPatchConfirmed,
  isProjectPatchConfirmed,
  preserveAcceptedOptimisticMutationOnConfirmationTimeout,
  rebaseConstructionDataAfterOptimisticFailure,
  replaceTemporaryProjectRecordId,
  resolveFailedApplicationDraft,
  settleAcceptedOptimisticMutation,
  type FailedApplicationDraft,
  type FollowupFieldSnapshot,
  type OptimisticFollowupFields,
  type OptimisticFollowupPatch,
  type OptimisticProjectPatch,
  type ProjectFieldSnapshot,
} from './optimistic-crud';

const LazyOnlineWorkFormDialog = React.lazy(() => import('./online-work-form'));
import {
  createConstructionMutationCoordinator,
  createConstructionRecordAliasRegistry,
  createLatestConstructionRequestCoordinator,
  type ConstructionMutationCoordinator,
} from './mutation-coordinator';
import { monitorOptimisticConfirmation } from './optimistic-confirmation';
import {
  buildManualReviewScope,
  confirmScopedManualReviewBatch,
  getManualReviewScopeKey,
  selectScopedPendingManualReviews,
  settleScopedManualReviewBatch,
  upsertScopedPendingManualReview,
  type ScopedPendingManualReview,
} from './scoped-manual-review-registry';
import {
  overlayConstructionAttachmentTombstones,
  reconcileConstructionAttachmentTombstones,
  registerConstructionAttachmentTombstone,
  revokeConstructionAttachmentTombstone,
  type ConstructionAttachmentTombstone,
} from './attachment-tombstones';

const BUILDINGS = ['A楼', 'B楼', 'C楼', 'D楼', 'E楼', 'H楼', '110站'];
const SPECIALTIES = ['电气', '暖通', '弱电', '消防', '其他'];
const VNET_OFFICIAL_LOGO_URL = '/assets/vnet-official-logo.png';
const CONSTRUCTION_AUTO_SYNC_INTERVAL_MS = 30 * 60 * 1000;
const CREW_ROSTER_TASK_POLL_INTERVAL_MS = 2500;
const CREW_ROSTER_TASK_MAX_POLLS = 72;
const CONSTRUCTION_TASK_STATUS_MAX_CONSECUTIVE_ERRORS = 3;
const CONSTRUCTION_PROJECT_RENDER_BATCH_SIZE = 12;

function yieldToBrowserForConstructionResponse(): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => window.setTimeout(resolve, 0);
    if (typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(finish);
      return;
    }
    finish();
  });
}
const OPTIMISTIC_CONFIRMATION_TIMEOUT_MS = 120_000;
const OPTIMISTIC_CONFIRMATION_POLL_INTERVAL_MS = 1500;
const OPTIMISTIC_CONFIRMATION_MAX_POLLS = 80;
let constructionMutationSequence = 0;
const WORK_TYPES = [
  '一般作业',
  '临时用电作业',
  '动火作业',
  '受限空间作业',
  '高处作业',
  '开挖动土作业',
  '吊装作业',
  '消防系统关闭作业',
];
const CONTRACTOR_TYPES = ['外部', '内部'];
const RELATED_WORK_TYPES = ['维护', '检修', '变更', '其他'];

type LifecycleStageKey =
  | 'apply'
  | 'approval'
  | 'isolation'
  | 'process'
  | 'close';
type LifecycleStageStatus = 'done' | 'active' | 'blocked' | 'pending';
type ConstructionWorkState = 'approval' | 'active' | 'completed';

interface LifecycleStageDefinition {
  key: LifecycleStageKey;
  label: string;
  shortLabel: string;
  description: string;
  icon: React.ElementType;
  tone: 'blue' | 'emerald' | 'amber' | 'orange' | 'rose' | 'slate';
}

interface LifecycleStageView extends LifecycleStageDefinition {
  status: LifecycleStageStatus;
  evidence: string;
  missing: string[];
  issueCount: number;
}

interface LifecycleStageAttachmentView {
  label: string;
  count: number;
  files: ConstructionAttachmentFile[];
  status: ConstructionAttachmentGroup['status'];
  feedbacks: string[];
}

interface LifecycleStageDetailRow {
  label: string;
  value: string;
}

interface ScheduleMeta {
  state: 'active' | 'upcoming' | 'completed' | 'unknown';
  label: string;
  progress: number;
  totalDays: number;
  elapsedDays: number;
  remainingDays: number | null;
}

interface ConstructionListDialogState {
  title: string;
  description: string;
  emptyText: string;
  items: ConstructionOverviewItem[];
  stageKey?: LifecycleStageKey;
  dailyStageKey?: DailyFollowupStage;
}

function getConstructionListDialogIdentity(
  state: ConstructionListDialogState | null,
): string | null {
  return state
    ? [
        state.title,
        state.description,
        state.stageKey || '',
        state.dailyStageKey || '',
      ].join('\u0000')
    : null;
}

const LIFECYCLE_STAGES: LifecycleStageDefinition[] = [
  {
    key: 'approval',
    label: '项目施工申请',
    shortLabel: '项目申请',
    description: '申请材料、人员资料、审批节点和作业许可统一闭环。',
    icon: ClipboardCheck,
    tone: 'blue',
  },
  {
    key: 'isolation',
    label: '施工准备',
    shortLabel: '施工准备',
    description: '先校核当天作业类型，再完成人员、作业票和挂牌隔离核查。',
    icon: MapPinned,
    tone: 'emerald',
  },
  {
    key: 'process',
    label: '施工过程',
    shortLabel: '施工过程',
    description: '随工监督、过程照片和现场问题反馈。',
    icon: Wrench,
    tone: 'amber',
  },
  {
    key: 'close',
    label: '施工收尾',
    shortLabel: '施工收尾',
    description: '每日或整体收尾检查、照片和清单归档。',
    icon: CalendarCheck,
    tone: 'emerald',
  },
];

type FileFieldDefinition = readonly [string, string];
type SpecialWorkTypeMaterialGroup = {
  readonly workType: string;
  readonly title: string;
  readonly fields: readonly FileFieldDefinition[];
};

const FOLLOWUP_FILE_FIELDS = [
  ['applicationFiles', '施工作业申请单'],
  ['crewRosterFiles', '施工人员名单'],
  ['dailyPersonnelChecklistFiles', '每日人员核查清单'],
  ['trainingPhotoFiles', '入场培训照片'],
  ['entryTrainingSignInFiles', '入场培训签到表'],
  ['entryTrainingAssessmentFiles', '入场培训考核'],
  ['safetyNoticePhotoFiles', '安全告知书'],
  ['temporaryPowerRiskDisclosureFiles', '临电作业风险交底单'],
  ['temporaryPowerTrainingSignInFiles', '临电作业培训签到表'],
  ['temporaryPowerTrainingAssessmentFiles', '临电作业培训考核'],
  ['hotWorkRiskDisclosureFiles', '动火作业风险交底单'],
  ['hotWorkTrainingSignInFiles', '动火作业培训签到表'],
  ['hotWorkTrainingAssessmentFiles', '动火作业培训考核'],
  ['heightWorkRiskDisclosureFiles', '高处作业风险交底单'],
  ['heightWorkTrainingSignInFiles', '高处作业培训签到表'],
  ['heightWorkTrainingAssessmentFiles', '高处作业培训考核'],
  ['confinedSpaceRiskDisclosureFiles', '受限空间作业风险交底单'],
  ['confinedSpaceTrainingSignInFiles', '受限空间作业培训签到表'],
  ['confinedSpaceTrainingAssessmentFiles', '受限空间作业培训考核'],
  ['excavationRiskDisclosureFiles', '开挖动土作业风险交底单'],
  ['excavationTrainingSignInFiles', '开挖动土作业培训签到表'],
  ['excavationTrainingAssessmentFiles', '开挖动土作业培训考核'],
  ['liftingRiskDisclosureFiles', '吊装作业风险交底单'],
  ['liftingTrainingSignInFiles', '吊装作业培训签到表'],
  ['liftingTrainingAssessmentFiles', '吊装作业培训考核'],
  ['fireSystemShutdownRiskDisclosureFiles', '消防系统关闭作业风险交底单'],
  ['fireSystemShutdownTrainingSignInFiles', '消防系统关闭作业培训签到表'],
  ['fireSystemShutdownTrainingAssessmentFiles', '消防系统关闭作业培训考核'],
  ['confinedSpacePermitFiles', '受限空间作业票'],
  ['temporaryPowerPermitFiles', '临时用电作业票'],
  ['hotWorkPermitFiles', '动火作业票'],
  ['heightWorkPermitFiles', '高处作业票'],
  ['excavationPermitFiles', '开挖动土作业票'],
  ['liftingPermitFiles', '吊装作业票'],
  ['fireSystemShutdownPermitFiles', '消防系统关闭作业票'],
  ['isolationPhotoFiles', '挂牌与隔离照片'],
  ['processPhotoFiles', '施工过程照片'],
  ['closingPhotoFiles', '每日收尾照片'],
  ['inspectionFormFiles', '施工检查表'],
] as const;
const DEPOSIT_FILE_FIELDS = [
  ['depositAgreementFiles', '质保金协议'],
  ['depositTransferFiles', '质保金到账/返还'],
] as const;
const OVERVIEW_ATTACHMENT_FILE_KEYS = new Set([
  'constructionIssueFiles',
  'completionChecklistArchiveFiles',
  'depositAgreementFiles',
  'depositTransferFiles',
]);
const FOLLOWUP_FILE_FIELDS_BY_KEY = Object.fromEntries([
  ...FOLLOWUP_FILE_FIELDS,
  ...DEPOSIT_FILE_FIELDS,
]);
const ATTACHMENT_LABEL_ALIASES: Record<string, string[]> = {
  施工作业申请单: ['施工申请作业单', '施工申请单'],
  施工人员名单: [
    '施工人员信息表--初始',
    '施工人员名册--迭代',
    '施工人员增删名单',
  ],
  入场培训照片: ['培训照片'],
  安全告知书: ['安全告知书照片'],
  临电作业风险交底单: ['临时用电风险交底单'],
  临电作业培训签到表: ['临时用电培训签到'],
  临电作业培训考核: ['临时用电培训考核'],
  动火作业风险交底单: ['动火风险交底单'],
  动火作业培训签到表: ['动火培训签到'],
  动火作业培训考核: ['动火培训考核'],
  高处作业风险交底单: ['高处风险交底单'],
  高处作业培训签到表: ['高处培训签到'],
  高处作业培训考核: ['高处培训考核'],
  受限空间作业风险交底单: ['受限空间风险交底单'],
  受限空间作业培训签到表: ['受限空间培训签到'],
  受限空间作业培训考核: ['受限空间培训考核'],
  开挖动土作业风险交底单: ['开挖动土风险交底单', '动土风险交底单'],
  开挖动土作业培训签到表: ['开挖动土培训签到', '动土培训签到'],
  开挖动土作业培训考核: ['开挖动土培训考核', '动土培训考核'],
  吊装作业风险交底单: ['吊装风险交底单'],
  吊装作业培训签到表: ['吊装培训签到'],
  吊装作业培训考核: ['吊装培训考核'],
  消防系统关闭作业风险交底单: ['消防系统关闭风险交底单'],
  消防系统关闭作业培训签到表: ['消防系统关闭培训签到'],
  消防系统关闭作业培训考核: ['消防系统关闭培训考核'],
  受限空间作业票: ['受限空间许可证', '受限空间作业许可证'],
  临时用电作业票: ['临时用电作业许可证'],
  动火作业票: ['动火许可证', '动火作业许可证'],
  高处作业票: ['高处作业许可证'],
  开挖动土作业票: ['开挖动土作业许可', '开挖动土作业许可证'],
  吊装作业票: ['吊装作业单', '吊装作业许可', '吊装作业许可证'],
  消防系统关闭作业票: ['消防系统关闭作业许可证'],
  每日收尾照片: ['施工收尾照片'],
  施工检查表: ['每日收尾检查表'],
};
const INITIAL_APPLICATION_BASE_FILE_KEYS = [
  'applicationFiles',
  'crewRosterFiles',
  'trainingPhotoFiles',
  'entryTrainingSignInFiles',
  'entryTrainingAssessmentFiles',
  'safetyNoticePhotoFiles',
] as const;
const APPLICATION_FILE_FIELDS = FOLLOWUP_FILE_FIELDS.filter(([key]) =>
  ['crewRosterFiles'].includes(key),
);
const APPLICATION_REQUIRED_FILE_KEYS = ['crewRosterFiles'] as const;
const INITIAL_APPLICATION_PERMIT_FILE_KEYS = [
  'confinedSpacePermitFiles',
  'temporaryPowerPermitFiles',
  'hotWorkPermitFiles',
  'heightWorkPermitFiles',
] as const;
const INITIAL_APPLICATION_SPECIAL_COMMON_FILE_KEYS = [] as const;
const SPECIAL_WORK_TYPE_MATERIAL_GROUPS: readonly SpecialWorkTypeMaterialGroup[] =
  [
    {
      workType: '受限空间作业',
      title: '受限空间作业资料',
      fields: [
        ['confinedSpaceRiskDisclosureFiles', '受限空间作业风险交底单'],
        ['confinedSpaceTrainingSignInFiles', '受限空间作业培训签到表'],
        ['confinedSpaceTrainingAssessmentFiles', '受限空间作业培训考核'],
        ['confinedSpacePermitFiles', '受限空间作业票'],
      ],
    },
    {
      workType: '临时用电作业',
      title: '临时用电作业资料',
      fields: [
        ['temporaryPowerRiskDisclosureFiles', '临电作业风险交底单'],
        ['temporaryPowerTrainingSignInFiles', '临电作业培训签到表'],
        ['temporaryPowerTrainingAssessmentFiles', '临电作业培训考核'],
        ['temporaryPowerPermitFiles', '临时用电作业票'],
      ],
    },
    {
      workType: '动火作业',
      title: '动火作业资料',
      fields: [
        ['hotWorkRiskDisclosureFiles', '动火作业风险交底单'],
        ['hotWorkTrainingSignInFiles', '动火作业培训签到表'],
        ['hotWorkTrainingAssessmentFiles', '动火作业培训考核'],
        ['hotWorkPermitFiles', '动火作业票'],
      ],
    },
    {
      workType: '高处作业',
      title: '高处作业资料',
      fields: [
        ['heightWorkRiskDisclosureFiles', '高处作业风险交底单'],
        ['heightWorkTrainingSignInFiles', '高处作业培训签到表'],
        ['heightWorkTrainingAssessmentFiles', '高处作业培训考核'],
        ['heightWorkPermitFiles', '高处作业票'],
      ],
    },
    {
      workType: '开挖动土作业',
      title: '开挖动土作业资料',
      fields: [
        ['excavationRiskDisclosureFiles', '开挖动土作业风险交底单'],
        ['excavationTrainingSignInFiles', '开挖动土作业培训签到表'],
        ['excavationTrainingAssessmentFiles', '开挖动土作业培训考核'],
        ['excavationPermitFiles', '开挖动土作业票'],
      ],
    },
    {
      workType: '吊装作业',
      title: '吊装作业资料',
      fields: [
        ['liftingRiskDisclosureFiles', '吊装作业风险交底单'],
        ['liftingTrainingSignInFiles', '吊装作业培训签到表'],
        ['liftingTrainingAssessmentFiles', '吊装作业培训考核'],
        ['liftingPermitFiles', '吊装作业票'],
      ],
    },
    {
      workType: '消防系统关闭作业',
      title: '消防系统关闭作业资料',
      fields: [
        ['fireSystemShutdownRiskDisclosureFiles', '消防系统关闭作业风险交底单'],
        ['fireSystemShutdownTrainingSignInFiles', '消防系统关闭作业培训签到表'],
        [
          'fireSystemShutdownTrainingAssessmentFiles',
          '消防系统关闭作业培训考核',
        ],
        ['fireSystemShutdownPermitFiles', '消防系统关闭作业票'],
      ],
    },
  ];
const SPECIAL_WORK_TYPE_MODAL_FILE_KEYS: string[] =
  SPECIAL_WORK_TYPE_MATERIAL_GROUPS.flatMap((group) =>
    group.fields.map(([key]) => key),
  );
const SPECIAL_WORK_TYPE_PERMIT_FILE_FIELDS = [
  { workType: '受限空间作业', fileKey: 'confinedSpacePermitFiles' },
  { workType: '临时用电作业', fileKey: 'temporaryPowerPermitFiles' },
  { workType: '动火作业', fileKey: 'hotWorkPermitFiles' },
  { workType: '高处作业', fileKey: 'heightWorkPermitFiles' },
] as const;
const CONSTRUCTION_ISSUE_FILE_FIELD = [
  'constructionIssueFiles',
  '施工问题',
] as const;
const INITIAL_APPLICATION_FILE_KEYS: readonly string[] = [
  ...INITIAL_APPLICATION_BASE_FILE_KEYS,
  ...INITIAL_APPLICATION_SPECIAL_COMMON_FILE_KEYS,
  ...SPECIAL_WORK_TYPE_MODAL_FILE_KEYS,
  ...INITIAL_APPLICATION_PERMIT_FILE_KEYS,
  'depositAgreementFiles',
  'depositTransferFiles',
];

const DAILY_FOLLOWUP_FILE_FIELDS = [
  ['isolationPhotoFiles', '挂牌与隔离照片'],
  ['processPhotoFiles', '施工过程照片'],
  ['closingPhotoFiles', '每日收尾照片'],
] as const;

const DAILY_FOLLOWUP_STAGE_FILE_FIELDS = {
  prepare: [['isolationPhotoFiles', '挂牌与隔离照片']],
  process: [['processPhotoFiles', '施工过程照片']],
  close: [['closingPhotoFiles', '每日收尾照片']],
} as const;

const DAILY_FOLLOWUP_STAGE_REQUIRED_FILE_KEYS = {
  prepare: ['isolationPhotoFiles'],
  process: ['processPhotoFiles'],
  close: ['closingPhotoFiles'],
} as const;

const DAILY_FOLLOWUP_STAGES = [
  {
    key: 'prepare',
    label: '准备',
    description: '作业类型、人员核查、作业票、挂牌隔离',
    icon: ClipboardCheck,
  },
  {
    key: 'process',
    label: '进行',
    description: '施工过程照片',
    icon: Wrench,
  },
  {
    key: 'close',
    label: '收尾',
    description: '施工收尾清单、收尾照片',
    icon: CalendarCheck,
  },
] as const;

type FileBucket = Record<string, File[]>;
type FileFieldStatusHint = {
  tone: 'success' | 'warning' | 'danger' | 'neutral';
  text: string;
};
type ExistingFileTokenMap = Record<string, string[]>;
type FollowupMode = 'daily' | 'supplemental';
type ConstructionLoadDataOptions = {
  forceRefresh?: boolean;
  background?: boolean;
};
type ConstructionBackgroundTaskCallbacks = {
  onCompleted: (message: string) => void;
  onFailed: (message: string) => void;
  onUnknown: (message: string) => void;
};
type OptimisticAttachmentExpectation = {
  fieldKey: string;
  minimumCount: number;
  fingerprints: string[];
};

interface DailyProgressStageDefinition {
  key: DailyFollowupStage;
  label: string;
  description: string;
  workItems: string[];
  icon: React.ElementType;
  tone: 'blue' | 'amber' | 'emerald';
}

interface DailyProgressStageSummary extends DailyProgressStageDefinition {
  total: number;
  done: number;
  pending: number;
  items: ConstructionOverviewItem[];
}

const DAILY_PROGRESS_STAGES: DailyProgressStageDefinition[] = [
  {
    key: 'prepare',
    label: '施工准备',
    description: '先校核当天作业类型，再完成人员、作业票和挂牌隔离核查。',
    workItems: ['作业类型校核', '人员核查', '作业票校核', '挂牌隔离'],
    icon: ClipboardCheck,
    tone: 'blue',
  },
  {
    key: 'process',
    label: '施工过程中',
    description: '当天施工过程中上传施工过程照片。',
    workItems: ['施工过程照片'],
    icon: Wrench,
    tone: 'amber',
  },
  {
    key: 'close',
    label: '每日收尾',
    description: '当天收尾填写施工收尾清单，并上传收尾照片。',
    workItems: ['施工收尾清单', '收尾照片'],
    icon: CalendarCheck,
    tone: 'emerald',
  },
];

type CompletionChecklistResult =
  | ''
  | ConstructionCompletionChecklistAnswer['result'];
type CompletionChecklistFormState = Record<
  string,
  {
    result: CompletionChecklistResult;
    remark: string;
  }
>;
type SelectFieldOption = string | { value: string; label: string };

interface ApplicationFormState {
  workContent: string;
  building: string;
  specialty: string;
  workTypes: string[];
  contractorType: string;
  relatedWorkType: string;
  planStartTime: string;
  planEndTime: string;
  authorizationStartDate: string;
  authorizationEndDate: string;
  depositPaid: string;
  depositAmount: string;
  constructionApplicantId: string;
  constructionApplicantName: string;
  changeOrderRecordId: string;
  changeOrderTitle: string;
}

interface ApplicationRecoveryDraft extends FailedApplicationDraft<
  ApplicationFormState,
  FileBucket
> {
  revision: number;
}

interface CrewRosterUploadDraft {
  sessionId: number;
  item: ConstructionOverviewItem;
  files: FileBucket;
  authorizationStartDate: string;
  authorizationEndDate: string;
}

interface FollowupFormState {
  constructionRecordId: string;
  followupRecordId: string;
  followupMode: FollowupMode;
  dailyFollowupStage: DailyFollowupStage;
  followupStaffMembers: ConstructionStaffCandidate[];
  workTypes: string[];
  dailyPersonnelCheck: string;
  dailyCrewRecordIds: string[];
  permitValidFromByFileKey: Record<string, string>;
  permitValidUntilByFileKey: Record<string, string>;
  isolationFeedback: string;
  processFeedback: string;
  completed: string;
  depositPaid: string;
  depositAmount: string;
  depositDeducted: string;
  completionChecklist: CompletionChecklistFormState;
}

interface FollowupRecoveryDraft extends FailedApplicationDraft<
  FollowupFormState,
  FileBucket
> {
  removedExistingFileTokens: ExistingFileTokenMap;
  focus: DailyChecklistActionKind | null;
  projectRecordId: string;
  followupMode: FollowupMode;
}

type PendingManualReviewItem =
  | {
      id: string;
      kind: 'permit';
      label: string;
      followupRecordId: string;
      fileKey: string;
      decision: ConstructionPermitManualReviewDecision;
      permitFileTokens: string[];
      permitFingerprint: string | null;
      sourceFeedback: string | null;
      validFrom: string | null;
      validUntil: string | null;
    }
  | {
      id: string;
      kind: 'isolation';
      label: string;
      followupRecordId: string;
      decision: ConstructionPermitManualReviewDecision;
    };

interface DailyFollowupFormCacheEntry {
  followupRecordId: string;
  followupStaffMembers: Array<Pick<ConstructionStaffCandidate, 'id' | 'name'>>;
  dailyCrewRecordIds: string[];
  dailyPersonnelCheck: string;
  updatedAt: number;
}

const DAILY_FOLLOWUP_FORM_CACHE_STORAGE_KEY =
  'construction-management:daily-followup-form-cache:v1';

const initialApplicationForm: ApplicationFormState = {
  workContent: '',
  building: 'A楼',
  specialty: '其他',
  workTypes: [],
  contractorType: '外部',
  relatedWorkType: '维护',
  planStartTime: '',
  planEndTime: '',
  authorizationStartDate: '',
  authorizationEndDate: '',
  depositPaid: '',
  depositAmount: '',
  constructionApplicantId: '',
  constructionApplicantName: '',
  changeOrderRecordId: '',
  changeOrderTitle: '',
};

const initialFollowupForm: FollowupFormState = {
  constructionRecordId: '',
  followupRecordId: '',
  followupMode: 'daily',
  dailyFollowupStage: 'prepare',
  followupStaffMembers: [],
  workTypes: ['一般作业'],
  dailyPersonnelCheck: '',
  dailyCrewRecordIds: [],
  permitValidFromByFileKey: {},
  permitValidUntilByFileKey: {},
  isolationFeedback: '',
  processFeedback: '',
  completed: '',
  depositPaid: '',
  depositAmount: '',
  depositDeducted: '',
  completionChecklist: createInitialCompletionChecklistState(),
};

function isFollowupUiPristine(
  form: FollowupFormState,
  files: FileBucket,
  removedExistingFileTokens: ExistingFileTokenMap,
  focus: DailyChecklistActionKind | null,
): boolean {
  return (
    JSON.stringify(form) === JSON.stringify(initialFollowupForm) &&
    Object.values(files).every((bucket) => bucket.length === 0) &&
    Object.values(removedExistingFileTokens).every(
      (tokens) => tokens.length === 0,
    ) &&
    focus === null
  );
}

interface DialogOpeningFeedbackHandle {
  show: (label: string) => void;
  hide: () => void;
}

function DialogOpeningFeedback({
  feedbackRef,
}: {
  feedbackRef: React.MutableRefObject<DialogOpeningFeedbackHandle | null>;
}) {
  useEffect(() => {
    const overlay = document.createElement('div');
    overlay.setAttribute('role', 'status');
    overlay.setAttribute('aria-live', 'polite');
    overlay.className =
      'fixed inset-0 z-[70] items-center justify-center bg-slate-950/25 px-4';
    overlay.style.display = 'none';
    overlay.style.pointerEvents = 'none';

    const panel = document.createElement('div');
    panel.className =
      'flex items-center gap-3 rounded-lg border border-blue-100 bg-white px-5 py-4 shadow-[0_18px_48px_rgba(15,23,42,0.24)]';
    const icon = document.createElement('div');
    icon.className =
      'flex h-5 w-5 items-center justify-center text-base font-semibold text-blue-600';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = '↗';
    const text = document.createElement('div');
    const hint = document.createElement('div');
    hint.className = 'text-xs font-semibold text-blue-600';
    hint.textContent = '正在打开';
    const label = document.createElement('div');
    label.className = 'mt-0.5 text-sm font-semibold text-slate-900';
    text.append(hint, label);
    panel.append(icon, text);
    overlay.append(panel);
    document.body.append(overlay);

    const handle: DialogOpeningFeedbackHandle = {
      show: (nextLabel) => {
        label.textContent = nextLabel;
        overlay.setAttribute('aria-label', `正在打开${nextLabel}`);
        overlay.style.display = 'flex';
      },
      hide: () => {
        overlay.style.display = 'none';
      },
    };
    feedbackRef.current = handle;

    return () => {
      if (feedbackRef.current === handle) {
        feedbackRef.current = null;
      }
      overlay.remove();
    };
  }, [feedbackRef]);

  return null;
}

export default function ConstructionManagementPage() {
  const { role, capabilities } = useAccess();
  const canEditConstruction = capabilities.canEdit;
  const canDeleteConstruction = capabilities.canDelete;
  const canForceRefreshConstruction = capabilities.canForceRefresh;
  const manualReviewAutoApproved =
    isConstructionManualReviewAutoApprovalRole(role);

  const [data, setData] = useState<ConstructionManagementResponse | null>(null);
  const constructionAiAuditEnabled = data?.imageAuditStatus?.enabled === true;
  const dataRef = useRef<ConstructionManagementResponse | null>(null);
  const authoritativeConstructionDataRef =
    useRef<ConstructionManagementResponse | null>(null);
  const constructionMutationCoordinatorRef = useRef<
    ConstructionMutationCoordinator<ConstructionManagementResponse>
  >(createConstructionMutationCoordinator<ConstructionManagementResponse>());
  const constructionRecordAliasRegistryRef = useRef(
    createConstructionRecordAliasRegistry(),
  );
  const inFlightMutationKeysRef = useRef(new Set<string>());
  const attachmentTombstonesRef = useRef<ConstructionAttachmentTombstone[]>([]);
  const manualReviewSyncingIdsRef = useRef(new Set<string>());
  const optimisticConfirmationTimersRef = useRef(new Map<string, number>());
  const forceRefreshInFlightRef = useRef(false);
  const mountedRef = useRef(true);
  const latestConstructionRequestCoordinatorRef = useRef(
    createLatestConstructionRequestCoordinator(),
  );
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [manualReviewRefreshing, setManualReviewRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [applicationOpen, setApplicationOpen] = useState(false);
  const [applicationRecoveryDraft, setApplicationRecoveryDraft] =
    useState<ApplicationRecoveryDraft | null>(null);
  const [applicationSessionId, setApplicationSessionId] = useState(0);
  const applicationSessionSequenceRef = useRef(0);
  const activeApplicationSessionIdRef = useRef<number | null>(null);
  const failedApplicationDraftsRef = useRef<ApplicationRecoveryDraft[]>([]);
  const applicationRecoveryRevisionRef = useRef(0);
  const [followupOpen, setFollowupOpen] = useState(false);
  const followupOpeningFeedbackRef = useRef<DialogOpeningFeedbackHandle | null>(
    null,
  );
  const followupOpeningFrameRef = useRef<number | null>(null);
  const followupSessionSequenceRef = useRef(0);
  const activeFollowupSessionIdRef = useRef<number | null>(null);
  const failedFollowupDraftsRef = useRef<FollowupRecoveryDraft[]>([]);
  const [dailyChecklistFocus, setDailyChecklistFocus] =
    useState<DailyChecklistActionKind | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const followupSubmitInFlightRef = useRef(false);
  const [followupForm, setFollowupForm] =
    useState<FollowupFormState>(initialFollowupForm);
  const [followupFiles, setFollowupFiles] = useState<FileBucket>({});
  const [removedExistingFileTokens, setRemovedExistingFileTokens] =
    useState<ExistingFileTokenMap>({});
  const [selectedConstruction, setSelectedConstruction] =
    useState<ConstructionOverviewItem | null>(null);
  const [selectedDetailStageKey, setSelectedDetailStageKey] =
    useState<LifecycleStageKey | null>(null);
  const [selectedDetailDailyOnly, setSelectedDetailDailyOnly] = useState(false);
  const [constructionListDialog, setConstructionListDialog] =
    useState<ConstructionListDialogState | null>(null);
  const [projectDeleteCandidate, setProjectDeleteCandidate] =
    useState<ConstructionOverviewItem | null>(null);
  const [projectTerminateCandidate, setProjectTerminateCandidate] =
    useState<ConstructionOverviewItem | null>(null);
  const [crewRosterSyncingRecordIds, setCrewRosterSyncingRecordIds] = useState<
    Set<string>
  >(() => new Set());
  const crewRosterSyncingRecordIdsRef = useRef(new Set<string>());
  const crewRosterUploadSessionSequenceRef = useRef(0);
  const activeCrewRosterUploadSessionIdRef = useRef<number | null>(null);
  const failedCrewRosterUploadDraftsRef = useRef<CrewRosterUploadDraft[]>([]);
  const [crewRosterUploadTarget, setCrewRosterUploadTarget] =
    useState<ConstructionOverviewItem | null>(null);
  const [crewRosterUploadFiles, setCrewRosterUploadFiles] =
    useState<FileBucket>({});
  const [
    crewRosterAuthorizationStartDate,
    setCrewRosterAuthorizationStartDate,
  ] = useState(() => getCurrentWeekDateInputRange().startDate);
  const [crewRosterAuthorizationEndDate, setCrewRosterAuthorizationEndDate] =
    useState(() => getCurrentWeekDateInputRange().endDate);
  const dailyPermitUploadingKey: string | null = null;
  const [pendingManualReviews, setPendingManualReviews] = useState<
    PendingManualReviewItem[]
  >([]);
  const scopedPendingManualReviewsRef = useRef<
    ScopedPendingManualReview<PendingManualReviewItem>[]
  >([]);
  const [dailyPermitReferenceDate, setDailyPermitReferenceDate] = useState(() =>
    getDailyProgressReferenceDate(),
  );
  const constructionAliasDateRef = useRef(
    formatDateForBitableDate(dailyPermitReferenceDate),
  );
  const selectedConstructionRef = useRef(selectedConstruction);
  const selectedDetailStageKeyRef = useRef(selectedDetailStageKey);
  const selectedDetailDailyOnlyRef = useRef(selectedDetailDailyOnly);
  const constructionListDialogRef = useRef(constructionListDialog);
  const followupOpenRef = useRef(followupOpen);
  const followupFormRef = useRef(followupForm);
  const followupFilesRef = useRef(followupFiles);
  const removedExistingFileTokensRef = useRef(removedExistingFileTokens);
  const dailyChecklistFocusRef = useRef(dailyChecklistFocus);
  const projectTerminateCandidateRef = useRef(projectTerminateCandidate);
  const projectDeleteCandidateRef = useRef(projectDeleteCandidate);
  selectedConstructionRef.current = selectedConstruction;
  selectedDetailStageKeyRef.current = selectedDetailStageKey;
  selectedDetailDailyOnlyRef.current = selectedDetailDailyOnly;
  constructionListDialogRef.current = constructionListDialog;
  followupOpenRef.current = followupOpen;
  followupFormRef.current = followupForm;
  followupFilesRef.current = followupFiles;
  removedExistingFileTokensRef.current = removedExistingFileTokens;
  dailyChecklistFocusRef.current = dailyChecklistFocus;
  projectTerminateCandidateRef.current = projectTerminateCandidate;
  projectDeleteCandidateRef.current = projectDeleteCandidate;

  const updateConstructionData = useCallback(
    (
      value:
        | ConstructionManagementResponse
        | null
        | ((
            current: ConstructionManagementResponse | null,
          ) => ConstructionManagementResponse | null),
    ): ConstructionManagementResponse | null => {
      const current = dataRef.current;
      const computed = typeof value === 'function' ? value(current) : value;
      const next = computed
        ? overlayConstructionAttachmentTombstones(
            computed,
            attachmentTombstonesRef.current,
          )
        : computed;
      if (next === current) {
        return current;
      }
      dataRef.current = next;
      setData(next);
      setSelectedConstruction((selected) =>
        selected && next
          ? next.items.find((item) => item.recordId === selected.recordId) ||
            null
          : selected,
      );
      return next;
    },
    [],
  );

  const registerAttachmentTombstone = useCallback(
    (tombstone: ConstructionAttachmentTombstone) => {
      attachmentTombstonesRef.current = registerConstructionAttachmentTombstone(
        attachmentTombstonesRef.current,
        tombstone,
      );
      updateConstructionData((current) =>
        authoritativeConstructionDataRef.current
          ? constructionMutationCoordinatorRef.current.applyPending(
              authoritativeConstructionDataRef.current,
            )
          : current,
      );
    },
    [updateConstructionData],
  );

  const revokeAttachmentTombstone = useCallback(
    (tombstone: ConstructionAttachmentTombstone) => {
      attachmentTombstonesRef.current = revokeConstructionAttachmentTombstone(
        attachmentTombstonesRef.current,
        tombstone,
      );
      updateConstructionData((current) =>
        authoritativeConstructionDataRef.current
          ? constructionMutationCoordinatorRef.current.applyPending(
              authoritativeConstructionDataRef.current,
            )
          : current,
      );
    },
    [updateConstructionData],
  );

  const setCrewRosterRecordSyncing = useCallback(
    (recordId: string, syncing: boolean) => {
      const next = new Set(crewRosterSyncingRecordIdsRef.current);
      if (syncing) {
        next.add(recordId);
      } else {
        next.delete(recordId);
      }
      crewRosterSyncingRecordIdsRef.current = next;
      if (mountedRef.current) {
        setCrewRosterSyncingRecordIds(next);
      }
    },
    [],
  );

  const clearOptimisticConfirmationTimer = useCallback((overlayKey: string) => {
    const timerId = optimisticConfirmationTimersRef.current.get(overlayKey);
    if (timerId !== undefined) {
      window.clearTimeout(timerId);
      optimisticConfirmationTimersRef.current.delete(overlayKey);
    }
  }, []);

  const rebaseVisibleConstructionData = useCallback(
    (
      fallbackSnapshot?: FollowupFieldSnapshot,
      fallbackProjectSnapshot?: ProjectFieldSnapshot,
    ) => {
      updateConstructionData((current) =>
        current
          ? rebaseConstructionDataAfterOptimisticFailure(
              authoritativeConstructionDataRef.current,
              current,
              (authoritative) =>
                constructionMutationCoordinatorRef.current.applyPending(
                  authoritative,
                ),
              fallbackSnapshot,
              fallbackProjectSnapshot,
            )
          : current,
      );
    },
    [updateConstructionData],
  );

  const scheduleOptimisticConfirmationTimeout = useCallback(
    (overlayKey: string) => {
      clearOptimisticConfirmationTimer(overlayKey);
      const timerId = window.setTimeout(() => {
        optimisticConfirmationTimersRef.current.delete(overlayKey);
        if (!mountedRef.current) {
          return;
        }
        preserveAcceptedOptimisticMutationOnConfirmationTimeout({
          isPending: () =>
            constructionMutationCoordinatorRef.current.has(overlayKey),
          notifyDelayed: () =>
            toast.warning('服务器读取暂有延迟，页面状态已保留'),
        });
      }, OPTIMISTIC_CONFIRMATION_TIMEOUT_MS);
      optimisticConfirmationTimersRef.current.set(overlayKey, timerId);
    },
    [clearOptimisticConfirmationTimer],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      latestConstructionRequestCoordinatorRef.current.invalidate();
      forceRefreshInFlightRef.current = false;
      optimisticConfirmationTimersRef.current.forEach((timerId, overlayKey) => {
        window.clearTimeout(timerId);
        constructionMutationCoordinatorRef.current.finish(overlayKey);
      });
      optimisticConfirmationTimersRef.current.clear();
      constructionRecordAliasRegistryRef.current.clear();
      inFlightMutationKeysRef.current.clear();
      attachmentTombstonesRef.current = [];
      manualReviewSyncingIdsRef.current.clear();
      crewRosterSyncingRecordIdsRef.current.clear();
      failedCrewRosterUploadDraftsRef.current = [];
      activeCrewRosterUploadSessionIdRef.current = null;
      failedFollowupDraftsRef.current = [];
      activeFollowupSessionIdRef.current = null;
    };
  }, []);

  useEffect(() => {
    const nextDateKey = formatDateForBitableDate(dailyPermitReferenceDate);
    if (constructionAliasDateRef.current === nextDateKey) {
      return;
    }
    constructionAliasDateRef.current = nextDateKey;
    constructionRecordAliasRegistryRef.current.clear();
  }, [dailyPermitReferenceDate]);

  const getVisiblePendingManualReviews = useCallback(
    (
      registry: readonly ScopedPendingManualReview<PendingManualReviewItem>[],
      form: FollowupFormState = followupFormRef.current,
    ): PendingManualReviewItem[] => {
      const projectRecordId = form.constructionRecordId.trim();
      if (!projectRecordId) {
        return [];
      }
      const followupRecordId = form.followupRecordId.trim();
      const entries = followupRecordId
        ? (['permit', 'isolation'] as const).flatMap((reviewType) =>
            selectScopedPendingManualReviews(
              registry,
              buildManualReviewScope(
                projectRecordId,
                followupRecordId,
                reviewType,
              ),
            ),
          )
        : registry.filter(
            (entry) => entry.scope.projectRecordId === projectRecordId,
          );
      return entries.map((entry) => entry.review);
    },
    [],
  );

  useEffect(() => {
    if (!followupOpen) {
      return;
    }
    setPendingManualReviews(
      getVisiblePendingManualReviews(scopedPendingManualReviewsRef.current),
    );
  }, [
    followupForm.constructionRecordId,
    followupForm.dailyFollowupStage,
    followupForm.followupMode,
    followupOpen,
    getVisiblePendingManualReviews,
  ]);

  const loadData = useCallback(
    async (
      options: boolean | ConstructionLoadDataOptions = false,
    ): Promise<ConstructionManagementResponse | null> => {
      const forceRefresh =
        typeof options === 'boolean' ? options : options.forceRefresh === true;
      const background =
        typeof options === 'boolean' ? false : options.background === true;
      if (forceRefresh && forceRefreshInFlightRef.current) {
        return null;
      }
      if (background && forceRefreshInFlightRef.current) {
        return null;
      }
      if (!background && !forceRefresh && forceRefreshInFlightRef.current) {
        return null;
      }
      if (!mountedRef.current) {
        return null;
      }
      if (forceRefresh) {
        forceRefreshInFlightRef.current = true;
      }
      if (!background && forceRefresh) {
        setRefreshing(true);
      } else if (!background) {
        setLoading(true);
      }
      setError(null);

      let loadedData: ConstructionManagementResponse | null = null;
      await latestConstructionRequestCoordinatorRef.current.run(
        getConstructionManagement(forceRefresh),
        {
          onSuccess(result) {
            if (!mountedRef.current) {
              return;
            }
            attachmentTombstonesRef.current =
              reconcileConstructionAttachmentTombstones(
                attachmentTombstonesRef.current,
                result,
              ).pending;
            authoritativeConstructionDataRef.current = result;
            const reconciled =
              constructionMutationCoordinatorRef.current.reconcile(result);
            reconciled.confirmedKeys.forEach(clearOptimisticConfirmationTimer);
            loadedData = updateConstructionData(reconciled.value);
            if (!loadedData) {
              return;
            }
            setDailyPermitReferenceDate(
              getDailyProgressReferenceDate(loadedData.generatedAt),
            );
            if (loadedData.items.length > 0) {
              setFollowupForm((current) =>
                current.constructionRecordId
                  ? current
                  : {
                      ...current,
                      constructionRecordId: loadedData!.items[0].recordId,
                    },
              );
            }
          },
          onError(err) {
            if (mountedRef.current) {
              setError(getErrorMessage(err, '施工管理数据加载失败'));
            }
          },
          onSettled() {
            if (forceRefresh) {
              forceRefreshInFlightRef.current = false;
            }
            if (!mountedRef.current) {
              return;
            }
            setLoading(false);
            setRefreshing(false);
          },
        },
      );
      return loadedData;
    },
    [clearOptimisticConfirmationTimer, updateConstructionData],
  );

  const monitorAcceptedFollowupMutation = useCallback(
    async (options: {
      overlayKey: string;
      scopeKey: string;
      taskId?: string | null;
      fallbackSnapshot?: FollowupFieldSnapshot;
      fallbackProjectSnapshot?: ProjectFieldSnapshot;
      restoreDraft?: () => boolean;
    }) => {
      const result = await monitorOptimisticConfirmation({
        taskId: options.taskId,
        maxPolls: OPTIMISTIC_CONFIRMATION_MAX_POLLS,
        confirmAfterTaskReadErrors: 2,
        readTask: async (taskId) => {
          const response = await getSyncTaskStatus(taskId);
          if (!response.success || !response.task) {
            throw new Error(response.message || '后台同步任务不存在');
          }
          return {
            status: response.task.status,
            message: response.task.message,
          };
        },
        refresh: () =>
          loadData({
            background: true,
            forceRefresh: false,
          }),
        isPending: () =>
          constructionMutationCoordinatorRef.current.has(options.overlayKey),
        wait: () =>
          new Promise((resolve) =>
            window.setTimeout(
              resolve,
              OPTIMISTIC_CONFIRMATION_POLL_INTERVAL_MS,
            ),
          ),
        shouldStop: () => !mountedRef.current,
      });

      if (
        result.status === 'confirmed' ||
        result.status === 'cancelled' ||
        !mountedRef.current
      ) {
        return;
      }
      if (result.status === 'failed') {
        clearOptimisticConfirmationTimer(options.overlayKey);
        constructionMutationCoordinatorRef.current.finish(options.overlayKey);
        constructionRecordAliasRegistryRef.current.clear(options.scopeKey);
        rebaseVisibleConstructionData(
          options.fallbackSnapshot,
          options.fallbackProjectSnapshot,
        );
        const restored = options.restoreDraft?.() ?? false;
        toast.error(
          `${result.message}；同步失败，${
            restored ? '已恢复本次草稿' : '页面已恢复服务器状态'
          }`,
        );
        return;
      }
      if (result.status === 'unknown') {
        toast.warning(
          `后台同步状态暂未确认，页面变更已保留；${result.message}`,
        );
      }
    },
    [clearOptimisticConfirmationTimer, loadData, rebaseVisibleConstructionData],
  );

  useEffect(() => {
    void loadData(false).catch((err) => {
      if (mountedRef.current) {
        toast.error(getErrorMessage(err, '施工管理数据加载失败'));
      }
    });
  }, [loadData]);

  const updateScopedPendingManualReviews = useCallback(
    (
      updater: (
        current: readonly ScopedPendingManualReview<PendingManualReviewItem>[],
      ) => ScopedPendingManualReview<PendingManualReviewItem>[],
    ) => {
      const next = updater(scopedPendingManualReviewsRef.current);
      scopedPendingManualReviewsRef.current = next;
      if (mountedRef.current && followupOpenRef.current) {
        setPendingManualReviews(getVisiblePendingManualReviews(next));
      }
      return next;
    },
    [getVisiblePendingManualReviews],
  );

  const syncPendingManualReviewItem = useCallback(
    (review: PendingManualReviewItem) => {
      if (review.kind === 'permit') {
        return updateConstructionPermitManualReview({
          followupRecordId: review.followupRecordId,
          fileKey: review.fileKey,
          decision: review.decision,
          permitFileTokens: review.permitFileTokens,
          permitFingerprint: review.permitFingerprint,
          sourceFeedback: review.sourceFeedback,
          validFrom: review.validFrom,
          validUntil: review.validUntil,
        });
      }

      return updateConstructionIsolationPhotoManualReview({
        followupRecordId: review.followupRecordId,
        decision: review.decision,
      });
    },
    [],
  );

  const confirmPendingManualReviewSync = useCallback(
    async (
      reviews: readonly ScopedPendingManualReview<PendingManualReviewItem>[],
    ): Promise<number> => {
      const loaded = await loadData({
        background: true,
        forceRefresh: false,
      });
      if (!loaded) {
        throw new Error('普通读取未返回最新施工数据');
      }
      updateScopedPendingManualReviews((current) =>
        confirmScopedManualReviewBatch(current, reviews, true),
      );
      return reviews.length;
    },
    [loadData, updateScopedPendingManualReviews],
  );

  const submitPendingManualReviewBatchInBackground = useCallback(
    (
      requestedReviews: readonly PendingManualReviewItem[],
      options: { announce?: boolean } = {},
    ): number => {
      const submittedEntries = scopedPendingManualReviewsRef.current.filter(
        (entry) => requestedReviews.some((review) => entry.review === review),
      );
      const entries = submittedEntries.filter((entry) => {
        const syncKey = JSON.stringify([
          getManualReviewScopeKey(entry.scope),
          entry.review.id,
          entry.revision,
        ]);
        return !manualReviewSyncingIdsRef.current.has(syncKey);
      });
      const syncKeys = entries.map((entry) =>
        JSON.stringify([
          getManualReviewScopeKey(entry.scope),
          entry.review.id,
          entry.revision,
        ]),
      );
      if (entries.length === 0) {
        return 0;
      }

      syncKeys.forEach((syncKey) =>
        manualReviewSyncingIdsRef.current.add(syncKey),
      );
      if (options.announce !== false) {
        toast.success(`已提交 ${entries.length} 项人工审核，后台同步中`);
      }

      void (async () => {
        const results = await Promise.allSettled(
          entries.map((entry) => syncPendingManualReviewItem(entry.review)),
        );
        const succeeded = entries.filter(
          (_, index) => results[index]?.status === 'fulfilled',
        );
        const failed = entries.filter(
          (_, index) => results[index]?.status === 'rejected',
        );
        updateScopedPendingManualReviews((current) =>
          settleScopedManualReviewBatch(current, { succeeded, failed }),
        );
        if (!mountedRef.current) {
          return;
        }

        if (succeeded.length > 0) {
          toast.success(`已同步 ${succeeded.length} 项人工审核结果`);
          try {
            await confirmPendingManualReviewSync(succeeded);
          } catch (err) {
            updateScopedPendingManualReviews((current) =>
              confirmScopedManualReviewBatch(current, succeeded, false),
            );
            if (mountedRef.current) {
              toast.error(
                getErrorMessage(err, '人工审核已同步，但页面数据刷新失败'),
              );
            }
          }
        }
        if (failed.length > 0) {
          const firstFailure = results.find(
            (result): result is PromiseRejectedResult =>
              result.status === 'rejected',
          );
          toast.error(
            `${failed.length} 项人工审核同步失败，已保留可重试：${getErrorMessage(
              firstFailure?.reason,
              '后台同步失败',
            )}`,
          );
        }
      })()
        .catch((err) => {
          if (mountedRef.current) {
            toast.error(getErrorMessage(err, '人工审核结果批量同步失败'));
          }
        })
        .finally(() => {
          syncKeys.forEach((syncKey) =>
            manualReviewSyncingIdsRef.current.delete(syncKey),
          );
        });
      return entries.length;
    },
    [
      confirmPendingManualReviewSync,
      syncPendingManualReviewItem,
      updateScopedPendingManualReviews,
    ],
  );

  useEffect(() => {
    if (!canForceRefreshConstruction) {
      return;
    }
    let timeoutId: number | undefined;
    const scheduleMidnightRefresh = () => {
      timeoutId = window.setTimeout(() => {
        setDailyPermitReferenceDate(getDailyProgressReferenceDate());
        void loadData({ background: true, forceRefresh: false }).catch(
          (err) => {
            if (mountedRef.current) {
              toast.error(getErrorMessage(err, '跨日施工数据自动同步失败'));
            }
          },
        );
        scheduleMidnightRefresh();
      }, getDailyPermitNextRefreshDelay());
    };

    scheduleMidnightRefresh();
    return () => {
      if (timeoutId) {
        window.clearTimeout(timeoutId);
      }
    };
  }, [canForceRefreshConstruction, loadData]);

  useEffect(() => {
    if (!canForceRefreshConstruction) {
      return;
    }
    const intervalId = window.setInterval(() => {
      void loadData({ background: true, forceRefresh: false }).catch((err) => {
        if (mountedRef.current) {
          toast.error(getErrorMessage(err, '施工管理数据自动同步失败'));
        }
      });
    }, CONSTRUCTION_AUTO_SYNC_INTERVAL_MS);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [canForceRefreshConstruction, loadData]);

  useEffect(() => {
    document.title = '南通全景平台-施工管理';
  }, []);

  const visibleConstructionItems = useMemo(() => {
    const items = data?.items || [];
    return manualReviewAutoApproved
      ? applyConstructionManualReviewAutoApprovalPresentation(items)
      : items;
  }, [data, manualReviewAutoApproved]);
  const dailyProgressSummaries = useMemo(
    () =>
      summarizeDailyProgressStages(
        visibleConstructionItems,
        dailyPermitReferenceDate,
        constructionAiAuditEnabled,
      ),
    [
      constructionAiAuditEnabled,
      dailyPermitReferenceDate,
      visibleConstructionItems,
    ],
  );
  const [projectSearchQuery, setProjectSearchQuery] = useState('');
  const deferredProjectSearchQuery = useDeferredValue(projectSearchQuery);
  const projectInProgressItems = useMemo(
    () =>
      getProjectInProgressItems(
        visibleConstructionItems,
        constructionAiAuditEnabled,
      ),
    [constructionAiAuditEnabled, visibleConstructionItems],
  );
  const filteredProjectInProgressItems = useMemo(
    () =>
      projectInProgressItems.filter((item) =>
        matchesConstructionProjectSearch(item, deferredProjectSearchQuery),
      ),
    [deferredProjectSearchQuery, projectInProgressItems],
  );
  const [expandedProjectIds, setExpandedProjectIds] = useState<Set<string>>(
    () => new Set(),
  );
  const expandedProjectIdsRef = useRef(expandedProjectIds);
  expandedProjectIdsRef.current = expandedProjectIds;
  const [projectsFullyHidden, setProjectsFullyHidden] = useState(false);
  const [projectExpansionInitialized, setProjectExpansionInitialized] =
    useState(false);
  const [visibleProjectLimit, setVisibleProjectLimit] = useState(
    CONSTRUCTION_PROJECT_RENDER_BATCH_SIZE,
  );

  useEffect(() => {
    setVisibleProjectLimit(CONSTRUCTION_PROJECT_RENDER_BATCH_SIZE);
  }, [deferredProjectSearchQuery, filteredProjectInProgressItems.length]);

  useEffect(() => {
    if (
      !deferredProjectSearchQuery.trim() ||
      filteredProjectInProgressItems.length === 0
    ) {
      return;
    }

    setProjectsFullyHidden(false);
    setExpandedProjectIds((current) => {
      let changed = false;
      const next = new Set(current);
      filteredProjectInProgressItems.forEach((item) => {
        if (!next.has(item.recordId)) {
          next.add(item.recordId);
          changed = true;
        }
      });
      return changed ? next : current;
    });
  }, [deferredProjectSearchQuery, filteredProjectInProgressItems]);

  useEffect(() => {
    setExpandedProjectIds((current) => {
      return getDefaultExpandedProjectIds(
        projectInProgressItems.map((item) => ({
          recordId: item.recordId,
          archived: isConstructionProjectArchived(item),
        })),
        current,
        projectExpansionInitialized,
      );
    });
    if (
      !projectExpansionInitialized &&
      projectInProgressItems.some(
        (item) => !isConstructionProjectArchived(item),
      )
    ) {
      setProjectExpansionInitialized(true);
    }
  }, [projectExpansionInitialized, projectInProgressItems]);

  const handleProjectExpansionChange = useCallback(
    (recordId: string, expanded: boolean) => {
      if (expanded) {
        setProjectsFullyHidden(false);
      }
      setExpandedProjectIds((current) => {
        const next = new Set(current);
        if (expanded) {
          next.add(recordId);
        } else {
          next.delete(recordId);
        }
        return next;
      });
    },
    [],
  );
  const handleExpandAllProjects = useCallback(() => {
    setProjectsFullyHidden(false);
    setVisibleProjectLimit(filteredProjectInProgressItems.length);
    setExpandedProjectIds((current) => {
      const next = new Set(current);
      filteredProjectInProgressItems.forEach((item) => {
        next.add(item.recordId);
      });
      return next;
    });
  }, [filteredProjectInProgressItems]);
  const handleHideAllProjects = useCallback(() => {
    setProjectsFullyHidden(true);
    setExpandedProjectIds(new Set());
  }, []);
  const handleShowMoreProjects = useCallback(() => {
    setVisibleProjectLimit((current) =>
      Math.min(
        current + CONSTRUCTION_PROJECT_RENDER_BATCH_SIZE,
        filteredProjectInProgressItems.length,
      ),
    );
  }, [filteredProjectInProgressItems.length]);
  const expandedProjectCount = filteredProjectInProgressItems.filter((item) =>
    expandedProjectIds.has(item.recordId),
  ).length;
  const projectSearchActive = Boolean(deferredProjectSearchQuery.trim());
  const effectiveVisibleProjectLimit = projectSearchActive
    ? filteredProjectInProgressItems.length
    : visibleProjectLimit;
  const visibleProjectInProgressItems = useMemo(
    () =>
      getVisibleProjectItems(
        filteredProjectInProgressItems,
        effectiveVisibleProjectLimit,
      ),
    [effectiveVisibleProjectLimit, filteredProjectInProgressItems],
  );
  const hiddenProjectCount =
    filteredProjectInProgressItems.length -
    visibleProjectInProgressItems.length;
  const allProjectsHidden =
    projectsFullyHidden && filteredProjectInProgressItems.length > 0;
  const requireConstructionEdit = useCallback(
    (actionLabel = '执行该操作') => {
      if (canEditConstruction) {
        return true;
      }
      toast.error(`游客模式不能${actionLabel}`);
      return false;
    },
    [canEditConstruction],
  );
  const requireConstructionDelete = useCallback(
    (actionLabel = '执行删除操作') => {
      if (canDeleteConstruction) {
        return true;
      }
      toast.error(`当前权限不能${actionLabel}`);
      return false;
    },
    [canDeleteConstruction],
  );
  useEffect(() => {
    if (canEditConstruction) {
      return;
    }
    if (followupOpeningFrameRef.current !== null) {
      window.cancelAnimationFrame(followupOpeningFrameRef.current);
      followupOpeningFrameRef.current = null;
    }
    followupOpeningFeedbackRef.current?.hide();
    setApplicationOpen(false);
    setFollowupOpen(false);
    setCrewRosterUploadTarget(null);
    setProjectTerminateCandidate(null);
  }, [canEditConstruction]);
  useEffect(() => {
    if (!canDeleteConstruction) {
      setProjectDeleteCandidate(null);
    }
  }, [canDeleteConstruction]);
  const beginFollowupDialogSession = useCallback(
    (projectRecordId?: string, followupMode?: FollowupMode) => {
      const sessionId = ++followupSessionSequenceRef.current;
      activeFollowupSessionIdRef.current = sessionId;
      const queuedIndex = failedFollowupDraftsRef.current.findIndex(
        (draft) =>
          (!projectRecordId || draft.projectRecordId === projectRecordId) &&
          (!followupMode || draft.followupMode === followupMode),
      );
      if (queuedIndex < 0) {
        return { sessionId, restored: false };
      }

      const queuedDraft = failedFollowupDraftsRef.current[queuedIndex];
      failedFollowupDraftsRef.current = failedFollowupDraftsRef.current.filter(
        (_, index) => index !== queuedIndex,
      );
      followupFormRef.current = queuedDraft.form;
      followupFilesRef.current = queuedDraft.files;
      removedExistingFileTokensRef.current =
        queuedDraft.removedExistingFileTokens;
      dailyChecklistFocusRef.current = queuedDraft.focus;
      setFollowupForm(queuedDraft.form);
      setFollowupFiles(queuedDraft.files);
      setRemovedExistingFileTokens(queuedDraft.removedExistingFileTokens);
      setDailyChecklistFocus(queuedDraft.focus);
      toast.info('已恢复较早同步失败的施工跟进草稿');
      return { sessionId, restored: true };
    },
    [],
  );
  const scheduleFollowupDialogOpen = useCallback(
    (label: string, openDialog: () => void) => {
      if (followupOpeningFrameRef.current !== null) {
        window.cancelAnimationFrame(followupOpeningFrameRef.current);
      }

      const openingFeedback = followupOpeningFeedbackRef.current;
      const hideFollowupOpeningFeedbackOnNextFrame = () => {
        const hide = () => {
          openingFeedback?.hide();
          if (followupOpeningFeedbackRef.current !== openingFeedback) {
            followupOpeningFeedbackRef.current?.hide();
          }
        };
        if (typeof window.requestAnimationFrame === 'function') {
          window.requestAnimationFrame(hide);
          return;
        }
        hide();
      };
      openingFeedback?.show(label);
      followupOpeningFrameRef.current = window.requestAnimationFrame(() => {
        followupOpeningFrameRef.current = window.requestAnimationFrame(() => {
          followupOpeningFrameRef.current = null;
          try {
            openDialog();
          } finally {
            hideFollowupOpeningFeedbackOnNextFrame();
          }
        });
      });
    },
    [],
  );
  useEffect(
    () => () => {
      if (followupOpeningFrameRef.current !== null) {
        window.cancelAnimationFrame(followupOpeningFrameRef.current);
      }
    },
    [],
  );
  const handleDailyProgressStageOpen = useCallback(
    (stage: DailyProgressStageSummary) => {
      const items = getItemsForDailyProgressStage(
        visibleConstructionItems,
        stage.key,
        dailyPermitReferenceDate,
        constructionAiAuditEnabled,
      );
      const done = items.filter(
        (item) =>
          getDailyFollowupStageProgress(
            item,
            dailyPermitReferenceDate,
            constructionAiAuditEnabled,
          )[stage.key],
      ).length;

      setConstructionListDialog({
        title: stage.label,
        description: `进行中 ${items.length} 项 · 今日已完成 ${done} · 待跟进 ${items.length - done}`,
        emptyText: `${stage.label}暂无进行中施工`,
        items,
        dailyStageKey: stage.key,
      });
    },
    [
      constructionAiAuditEnabled,
      dailyPermitReferenceDate,
      visibleConstructionItems,
    ],
  );
  const handleDailyFollowupQuickOpen = useCallback(
    (
      item: ConstructionOverviewItem,
      dailyFollowupStage: DailyFollowupStage,
      actionKind: DailyChecklistActionKind | null = null,
    ) => {
      if (!requireConstructionEdit('提交每日跟进')) {
        return;
      }

      scheduleFollowupDialogOpen(
        getDailyChecklistFocusDialogTitle(actionKind, dailyFollowupStage),
        () => {
          if (isOptimisticConstructionRecordId(item.recordId)) {
            toast.info('项目正在同步到多维表，完成后才能提交跟进');
            return;
          }
          if (
            !isDailyFollowupOpenForProject(item, constructionAiAuditEnabled)
          ) {
            toast.error('项目施工申请未闭环，请先补充申请材料');
            return;
          }
          if (
            actionKind === 'personnel' &&
            getConfirmedTodayDailyWorkTypes(item, dailyPermitReferenceDate)
              .length === 0
          ) {
            toast.error('请先完成当天作业类型校核');
            return;
          }

          const { restored } = beginFollowupDialogSession(
            item.recordId,
            'daily',
          );
          if (!restored) {
            setFollowupForm((current) => {
              const base: FollowupFormState = {
                ...current,
                followupMode: 'daily',
                constructionRecordId: item.recordId,
                workTypes: item.workTypes.length
                  ? item.workTypes
                  : current.workTypes,
              };

              return applyDailyFollowupStageForm(
                base,
                item,
                dailyFollowupStage,
                getDailyFollowupForSubmission(
                  item,
                  dailyFollowupStage,
                  dailyPermitReferenceDate,
                ),
                readDailyFollowupFormCache(
                  item.recordId,
                  dailyFollowupStage,
                  dailyPermitReferenceDate,
                ),
                constructionAiAuditEnabled,
              );
            });
            setFollowupFiles({});
            setRemovedExistingFileTokens({});
            setDailyChecklistFocus(actionKind);
          }
          followupOpenRef.current = true;
          setFollowupOpen(true);
        },
      );
    },
    [
      beginFollowupDialogSession,
      constructionAiAuditEnabled,
      dailyPermitReferenceDate,
      requireConstructionEdit,
      scheduleFollowupDialogOpen,
    ],
  );
  const handleSupplementalFollowupQuickOpen = useCallback(
    (item: ConstructionOverviewItem) => {
      if (!requireConstructionEdit('补充申请材料')) {
        return;
      }
      scheduleFollowupDialogOpen('补充申请材料', () => {
        if (isOptimisticConstructionRecordId(item.recordId)) {
          toast.info('项目正在同步到多维表，完成后才能补充材料');
          return;
        }
        const { restored } = beginFollowupDialogSession(
          item.recordId,
          'supplemental',
        );
        if (!restored) {
          setFollowupForm((current) => {
            const base: FollowupFormState = {
              ...current,
              followupMode: 'supplemental',
              constructionRecordId: item.recordId,
              workTypes: item.workTypes.length
                ? item.workTypes
                : current.workTypes,
            };

            return applyInitialApplicationFollowupForm(
              base,
              item,
              getInitialApplicationFollowup(item),
            );
          });
          setFollowupFiles({});
          setRemovedExistingFileTokens({});
          setDailyChecklistFocus(null);
        }
        followupOpenRef.current = true;
        setFollowupOpen(true);
      });
    },
    [
      beginFollowupDialogSession,
      requireConstructionEdit,
      scheduleFollowupDialogOpen,
    ],
  );
  const handleRefreshDailyProgress = useCallback(async () => {
    if (refreshing) {
      return;
    }
    try {
      if (await loadData({ background: true, forceRefresh: false })) {
        toast.success('已同步多维表今日跟进最新内容');
      } else {
        toast.error('多维表今日跟进同步失败');
      }
    } catch (err) {
      toast.error(getErrorMessage(err, '多维表今日跟进同步失败'));
    }
  }, [loadData, refreshing]);
  const handleStatusListOpen = useCallback((group: ConstructionStatusGroup) => {
    setConstructionListDialog({
      title: group.label,
      description: `共 ${group.items.length} 项施工`,
      emptyText: `${group.label}暂无施工项目`,
      items: group.items,
    });
  }, []);
  const handleAllConstructionOpen = useCallback(() => {
    const items = visibleConstructionItems;
    setConstructionListDialog({
      title: '施工项目总览',
      description: `共 ${items.length} 项施工，按计划时间、当前阶段和跟进状态展示简要信息。`,
      emptyText: '暂无施工项目',
      items,
    });
  }, [visibleConstructionItems]);
  const openConstructionDetail = useCallback(
    (
      item: ConstructionOverviewItem,
      stageKey: LifecycleStageKey | null = null,
      dailyOnly = false,
    ) => {
      if (isOptimisticConstructionRecordId(item.recordId)) {
        toast.info('项目正在同步到多维表，详情将在同步完成后开放');
        return;
      }
      selectedConstructionRef.current = item;
      selectedDetailStageKeyRef.current = stageKey;
      selectedDetailDailyOnlyRef.current =
        dailyOnly && isDailyLifecycleStageKey(stageKey);
      setSelectedDetailStageKey(stageKey);
      setSelectedDetailDailyOnly(
        dailyOnly && isDailyLifecycleStageKey(stageKey),
      );
      setSelectedConstruction(item);
    },
    [],
  );
  const handleListItemSelect = useCallback(
    (item: ConstructionOverviewItem, dailyStageKey?: DailyFollowupStage) => {
      if (isOptimisticConstructionRecordId(item.recordId)) {
        toast.info('项目正在同步到多维表，详情将在同步完成后开放');
        return;
      }
      const lifecycleStageKey = dailyStageKey
        ? getLifecycleStageKeyForDailyStage(dailyStageKey)
        : null;
      setConstructionListDialog(null);
      openConstructionDetail(item, lifecycleStageKey, Boolean(dailyStageKey));
    },
    [openConstructionDetail],
  );
  const handleFollowupDialogOpen = useCallback(() => {
    if (!requireConstructionEdit('施工跟进')) {
      return;
    }
    scheduleFollowupDialogOpen(
      followupForm.followupMode === 'supplemental'
        ? '补充申请材料'
        : '施工跟进',
      () => {
        const selectableItems = getFollowupProjectOptions(
          visibleConstructionItems,
          followupForm.followupMode,
          constructionAiAuditEnabled,
        );
        const selectedItem =
          selectableItems.find(
            (item) => item.recordId === followupForm.constructionRecordId,
          ) ||
          selectableItems[0] ||
          null;
        const nextStage = getNextDailyFollowupStage(
          getDailyFollowupStageProgress(
            selectedItem,
            dailyPermitReferenceDate,
            constructionAiAuditEnabled,
          ),
        );
        const todayFollowups = getTodayConstructionFollowups(
          selectedItem,
          dailyPermitReferenceDate,
        );
        const hasConfirmedDailyWorkTypes = Boolean(
          selectedItem &&
          getConfirmedTodayDailyWorkTypes(
            selectedItem,
            dailyPermitReferenceDate,
          ).length > 0,
        );
        const hasDailyPersonnelCheck = todayFollowups.some(
          (followup) =>
            Boolean(followup.dailyPersonnelCheck) ||
            hasAttachment(followup.attachments, '每日人员核查清单'),
        );
        const openingDailyChecklistFocus: DailyChecklistActionKind | null =
          followupForm.followupMode !== 'daily'
            ? null
            : !hasConfirmedDailyWorkTypes
              ? 'workType'
              : !hasDailyPersonnelCheck
                ? 'personnel'
                : null;

        const { restored } = beginFollowupDialogSession(
          selectedItem?.recordId,
          followupForm.followupMode,
        );
        if (!restored) {
          setFollowupForm((current) => {
            const base = {
              ...current,
              constructionRecordId:
                current.constructionRecordId || selectedItem?.recordId || '',
            };

            if (current.followupMode === 'supplemental') {
              return applyInitialApplicationFollowupForm(
                base,
                selectedItem,
                getInitialApplicationFollowup(selectedItem),
              );
            }

            return applyDailyFollowupStageForm(
              base,
              selectedItem,
              nextStage,
              getDailyFollowupForSubmission(
                selectedItem,
                nextStage,
                dailyPermitReferenceDate,
              ),
              readDailyFollowupFormCache(
                selectedItem?.recordId,
                nextStage,
                dailyPermitReferenceDate,
              ),
              constructionAiAuditEnabled,
            );
          });
          setFollowupFiles({});
          setRemovedExistingFileTokens({});
          setDailyChecklistFocus(openingDailyChecklistFocus);
        }
        followupOpenRef.current = true;
        setFollowupOpen(true);
      },
    );
  }, [
    beginFollowupDialogSession,
    constructionAiAuditEnabled,
    followupForm.constructionRecordId,
    followupForm.followupMode,
    dailyPermitReferenceDate,
    requireConstructionEdit,
    scheduleFollowupDialogOpen,
    visibleConstructionItems,
  ]);

  const handleOpenNewApplication = useCallback(() => {
    if (!requireConstructionEdit('新建施工')) {
      return;
    }
    applicationSessionSequenceRef.current += 1;
    const nextSessionId = applicationSessionSequenceRef.current;
    const queued = dequeueFailedApplicationDraft(
      failedApplicationDraftsRef.current,
    );
    failedApplicationDraftsRef.current = queued.remaining;
    activeApplicationSessionIdRef.current = nextSessionId;
    setApplicationSessionId(nextSessionId);
    if (queued.draft) {
      applicationRecoveryRevisionRef.current += 1;
      setApplicationRecoveryDraft({
        ...queued.draft,
        sessionId: nextSessionId,
        revision: applicationRecoveryRevisionRef.current,
      });
      toast.info('已恢复较早同步失败的施工申请草稿');
    } else {
      setApplicationRecoveryDraft(null);
    }
    setApplicationOpen(true);
  }, [requireConstructionEdit]);

  const closeFollowupDialogForOptimisticSubmit = useCallback(() => {
    followupOpenRef.current = false;
    setFollowupOpen(false);
  }, []);

  const handleApplicationSubmit = async (
    applicationSessionId: number,
    form: ApplicationFormState,
    files: FileBucket,
  ) => {
    if (!requireConstructionEdit('新建施工')) {
      return false;
    }
    if (
      !form.workContent.trim() ||
      !form.planStartTime ||
      !form.planEndTime ||
      !form.constructionApplicantId
    ) {
      toast.error('请填写作业内容、计划时间和施工申请人');
      return false;
    }
    if (!form.authorizationStartDate || !form.authorizationEndDate) {
      toast.error('请选择施工人员名单授权开始日期和施工结束日期');
      return false;
    }
    if (form.authorizationStartDate > form.authorizationEndDate) {
      toast.error('授权开始日期不能晚于施工结束日期');
      return false;
    }
    if (form.relatedWorkType === '变更' && !form.changeOrderRecordId) {
      toast.error('关联作业类型为变更时，请选择对应变更单');
      return false;
    }
    const missingApplicationFiles = getMissingFileLabels(
      APPLICATION_FILE_FIELDS,
      files,
      APPLICATION_REQUIRED_FILE_KEYS,
    );
    if (missingApplicationFiles.length > 0) {
      toast.error(`请上传${missingApplicationFiles.join('、')}`);
      return false;
    }
    const currentData = dataRef.current;
    if (!currentData) {
      toast.error('施工管理数据尚未加载完成，请稍后重试');
      return false;
    }
    if (activeApplicationSessionIdRef.current !== applicationSessionId) {
      toast.error('施工申请会话已更新，请在当前弹窗重新提交');
      return false;
    }
    const mutationKey = `application:create:${applicationSessionId}`;
    if (inFlightMutationKeysRef.current.has(mutationKey)) {
      toast.info('施工申请正在同步，请勿重复提交');
      return false;
    }

    setApplicationRecoveryDraft(null);
    setApplicationOpen(false);
    const applicationFeedbackToastId = toast.info('已受理，正在更新页面状态');
    await yieldToBrowserForConstructionResponse();

    const clientMutationId = createConstructionClientMutationId();
    const overlayKey = `${mutationKey}:${clientMutationId}`;
    const formData = new FormData();
    appendApplicationFields(formData, form);
    formData.append('clientMutationId', clientMutationId);
    appendFileBuckets(
      formData,
      pickAllowedFileBuckets(files, APPLICATION_REQUIRED_FILE_KEYS),
    );
    const applicationDraft = {
      sessionId: applicationSessionId,
      form: {
        ...form,
        workTypes: [...form.workTypes],
      },
      files: Object.fromEntries(
        Object.entries(files).map(([key, bucket]) => [key, [...bucket]]),
      ) as FileBucket,
    };
    const temporaryProject = createTemporaryConstructionProject({
      mutationId: clientMutationId,
      workContent: form.workContent.trim(),
      building: form.building || null,
      specialty: form.specialty || null,
      workTypes: form.workTypes,
      contractorType: form.contractorType || null,
      relatedWorkType: form.relatedWorkType || null,
      planStartTime: form.planStartTime,
      planEndTime: form.planEndTime,
    });
    const temporaryRecordId = temporaryProject.recordId;
    let realRecordId: string | null = null;
    let requestAccepted = false;
    const applyApplicationLayer = (value: ConstructionManagementResponse) => {
      const appended = appendTemporaryProject(value, temporaryProject);
      return realRecordId
        ? replaceTemporaryProjectRecordId(
            appended,
            temporaryRecordId,
            realRecordId,
          )
        : appended;
    };
    const constructionMutationCoordinator =
      constructionMutationCoordinatorRef.current;

    inFlightMutationKeysRef.current.add(mutationKey);
    if (
      !constructionMutationCoordinator.begin({
        key: overlayKey,
        apply: applyApplicationLayer,
        matches: (value) =>
          Boolean(
            requestAccepted &&
            realRecordId &&
            value.items.some((item) => item.recordId === realRecordId),
          ),
      })
    ) {
      inFlightMutationKeysRef.current.delete(mutationKey);
      setApplicationOpen(true);
      toast.info('施工申请正在同步，请勿重复提交', {
        id: applicationFeedbackToastId,
      });
      return false;
    }

    updateConstructionData((value) =>
      value ? applyApplicationLayer(value) : value,
    );
    toast.success('页面已更新，多维表同步中', {
      id: applicationFeedbackToastId,
    });

    let serverWriteAccepted = false;
    const applicationRequest = createConstructionApplication(formData);
    void applicationRequest
      .then(
        (result) => {
          serverWriteAccepted = true;
          realRecordId = result.recordId?.trim() || null;
          requestAccepted = Boolean(realRecordId);
          let confirmationScheduled = false;
          try {
            if (!mountedRef.current) {
              return;
            }
            updateConstructionData((value) =>
              value ? applyApplicationLayer(value) : value,
            );
            scheduleOptimisticConfirmationTimeout(overlayKey);
            confirmationScheduled = true;
            void loadData({
              background: true,
              forceRefresh: false,
            }).catch((err) => {
              if (mountedRef.current) {
                toast.error(
                  getErrorMessage(err, '多维表已同步，但页面数据刷新失败'),
                );
              }
            });
            if (
              activeApplicationSessionIdRef.current === applicationSessionId
            ) {
              activeApplicationSessionIdRef.current = null;
            }
            toast.success(result.message || '施工申请已同步到多维表');
          } catch (err) {
            if (mountedRef.current) {
              toast.error(
                getErrorMessage(err, '服务器已保存，页面正在重新同步'),
              );
            }
          } finally {
            settleAcceptedOptimisticMutation({
              confirmationScheduled,
              releaseGate: () =>
                inFlightMutationKeysRef.current.delete(mutationKey),
              finishOverlay: () =>
                constructionMutationCoordinator.finish(overlayKey),
              requestBackgroundRefresh: () => {
                if (!mountedRef.current) {
                  return;
                }
                rebaseVisibleConstructionData();
                void loadData({
                  background: true,
                  forceRefresh: false,
                }).catch((err) => {
                  if (mountedRef.current) {
                    toast.error(
                      getErrorMessage(err, '服务器已保存，但页面数据刷新失败'),
                    );
                  }
                });
              },
              notifyResync: () => {
                if (mountedRef.current) {
                  toast.error('服务器已保存，页面正在重新同步');
                }
              },
            });
          }
        },
        (err) => {
          inFlightMutationKeysRef.current.delete(mutationKey);
          clearOptimisticConfirmationTimer(overlayKey);
          constructionMutationCoordinator.finish(overlayKey);
          if (!mountedRef.current) {
            return;
          }
          rebaseVisibleConstructionData();
          applicationRecoveryRevisionRef.current += 1;
          const failedDraft: ApplicationRecoveryDraft = {
            sessionId: applicationSessionId,
            revision: applicationRecoveryRevisionRef.current,
            form: applicationDraft.form,
            files: applicationDraft.files,
          };
          const recovery = resolveFailedApplicationDraft(
            activeApplicationSessionIdRef.current,
            failedApplicationDraftsRef.current,
            failedDraft,
          );
          failedApplicationDraftsRef.current = recovery.failedDrafts;
          if (recovery.autoRestore) {
            setApplicationRecoveryDraft(recovery.autoRestore);
            setApplicationOpen(true);
            toast.error(
              `${getErrorMessage(err, '施工申请同步失败')}；同步失败，已恢复原状态`,
            );
          } else {
            toast.error(
              `${getErrorMessage(err, '施工申请同步失败')}；失败草稿已保留，不影响当前申请`,
            );
          }
        },
      )
      .catch((err) => {
        if (!mountedRef.current) {
          return;
        }
        toast.error(
          getErrorMessage(
            err,
            serverWriteAccepted
              ? '多维表已同步，但页面后处理失败'
              : '同步失败后的页面恢复处理异常',
          ),
        );
      });
    return true;
  };

  const handleFollowupSubmit = async (
    options: {
      filesOverride?: FileBucket;
      keepDialogOpen?: boolean;
      permitOnlyUpload?: boolean;
      permitUploadFileKey?: string;
      successMessage?: string;
    } = {},
  ) => {
    if (!requireConstructionEdit('提交施工跟进')) {
      return false;
    }
    const recoverFailedFollowupDraft = (draft: FollowupRecoveryDraft) => {
      const failure = resolveFailedApplicationDraft(
        activeFollowupSessionIdRef.current,
        failedFollowupDraftsRef.current,
        draft,
      );
      failedFollowupDraftsRef.current = failure.failedDrafts;
      if (!failure.autoRestore) {
        return false;
      }
      followupOpenRef.current = true;
      followupFormRef.current = failure.autoRestore.form;
      followupFilesRef.current = failure.autoRestore.files;
      removedExistingFileTokensRef.current =
        failure.autoRestore.removedExistingFileTokens;
      dailyChecklistFocusRef.current = failure.autoRestore.focus;
      setFollowupForm(failure.autoRestore.form);
      setFollowupFiles(failure.autoRestore.files);
      setRemovedExistingFileTokens(
        failure.autoRestore.removedExistingFileTokens,
      );
      setDailyChecklistFocus(failure.autoRestore.focus);
      setFollowupOpen(true);
      return true;
    };
    if (isOptimisticConstructionRecordId(followupForm.constructionRecordId)) {
      toast.info('项目正在同步到多维表，完成后才能提交跟进');
      return false;
    }
    const submitFiles = options.filesOverride || followupFiles;
    const focusedDailySubmit =
      followupForm.followupMode === 'daily' && dailyChecklistFocus !== null;
    const permitFocusedSubmit =
      focusedDailySubmit && dailyChecklistFocus === 'permit';
    const partialDailySubmit = focusedDailySubmit && !permitFocusedSubmit;
    const permitOnlyUpload =
      options.permitOnlyUpload === true || permitFocusedSubmit;
    const optimisticDailyFocus =
      dailyChecklistFocus === null ||
      (
        [
          'workType',
          'personnel',
          'permit',
          'isolation',
          'processPhoto',
          'closeChecklist',
          'closePhoto',
        ] as DailyChecklistActionKind[]
      ).includes(dailyChecklistFocus);
    const optimisticDailySubmit =
      followupForm.followupMode === 'daily' && optimisticDailyFocus;
    const optimisticSupplementalSubmit =
      followupForm.followupMode === 'supplemental';
    const optimisticFollowupSubmit =
      optimisticDailySubmit || optimisticSupplementalSubmit;
    if (
      !optimisticFollowupSubmit &&
      (submitting ||
        manualReviewRefreshing ||
        followupSubmitInFlightRef.current)
    ) {
      return false;
    }
    if (!followupForm.constructionRecordId) {
      toast.error('请选择施工项目');
      return false;
    }
    const selectedConstruction =
      visibleConstructionItems.find(
        (item) => item.recordId === followupForm.constructionRecordId,
      ) || null;
    const rawSupplementalExistingFiles =
      followupForm.followupMode === 'supplemental'
        ? getExistingFollowupSubmissionFileMap(
            selectedConstruction,
            followupForm,
          )
        : {};
    const supplementalExistingFiles = filterExistingFileMapByRemovedTokens(
      rawSupplementalExistingFiles,
      removedExistingFileTokens,
    );
    const dailySpecialMaterialExistingFiles =
      followupForm.followupMode === 'daily'
        ? filterExistingFileMapByRemovedTokens(
            buildProjectSpecialWorkTypeMaterialFileMap(selectedConstruction),
            removedExistingFileTokens,
          )
        : {};
    const dailyWorkTypes =
      followupForm.followupMode === 'daily'
        ? getCompleteSubmittableWorkTypes(
            followupForm.workTypes,
            submitFiles,
            dailySpecialMaterialExistingFiles,
          )
        : followupForm.workTypes;
    const supplementalWorkTypes =
      followupForm.followupMode === 'supplemental'
        ? getCompleteSubmittableWorkTypes(
            followupForm.workTypes,
            submitFiles,
            supplementalExistingFiles,
          )
        : followupForm.workTypes;
    const scopedSubmitFiles =
      followupForm.followupMode === 'supplemental'
        ? pickSupplementalFileBuckets(
            submitFiles,
            supplementalWorkTypes,
            followupForm.depositPaid,
          )
        : submitFiles;
    let submittedPermitValidFromByFileKey: Record<string, string> = {};
    let submittedPermitValidUntilByFileKey: Record<string, string> = {};
    const activeDailyChecklistFocus =
      followupForm.followupMode === 'daily' ? dailyChecklistFocus : null;
    if (followupForm.followupMode === 'daily') {
      const selectableDailyItems = getFollowupProjectOptions(
        visibleConstructionItems,
        'daily',
        constructionAiAuditEnabled,
      );
      if (
        !selectedConstruction ||
        !selectableDailyItems.some(
          (item) => item.recordId === selectedConstruction.recordId,
        )
      ) {
        toast.error('请选择审批流已完成的施工项目');
        return false;
      }
      const progress = getDailyFollowupStageProgress(
        selectedConstruction,
        dailyPermitReferenceDate,
        constructionAiAuditEnabled,
      );
      const permitVerifications = getDailyPermitVerifications(
        selectedConstruction,
        dailyPermitReferenceDate,
        dailyWorkTypes,
        constructionAiAuditEnabled,
      );
      const permitUploadFileBuckets = permitOnlyUpload
        ? pickDailyPermitFileBuckets(
            scopedSubmitFiles,
            permitVerifications,
            options.permitUploadFileKey,
          )
        : {};
      if (permitOnlyUpload && !hasFileBucketContent(permitUploadFileBuckets)) {
        const permitReviewsToSync = pendingManualReviews.filter(
          (item) => item.kind === 'permit',
        );
        if (permitReviewsToSync.length === 0) {
          if (
            permitVerifications.every((item) => !item.blocksProcess) &&
            getDailyPermitSummary(permitVerifications).done
          ) {
            toast.success('当前作业票仍在有效期，无需重复提交');
            if (!options.keepDialogOpen) {
              followupOpenRef.current = false;
              setFollowupOpen(false);
              setDailyChecklistFocus(null);
            }
            return true;
          }
          toast.error('请上传新的作业票或先选择人工审核结果');
          return false;
        }
        return (
          submitPendingManualReviewBatchInBackground(permitReviewsToSync) > 0
        );
      }
      if (permitOnlyUpload && manualReviewAutoApproved) {
        const submittedPermitFileKeys = Object.entries(permitUploadFileBuckets)
          .filter(([, bucket]) => bucket.length > 0)
          .map(([fieldKey]) => fieldKey);
        const missingPermitValidityLabels = submittedPermitFileKeys
          .filter(
            (fieldKey) =>
              !followupForm.permitValidFromByFileKey[fieldKey]?.trim() ||
              !followupForm.permitValidUntilByFileKey[fieldKey]?.trim(),
          )
          .map(
            (fieldKey) =>
              DAILY_PERMIT_DEFINITIONS.find(
                (definition) => definition.fileKey === fieldKey,
              )?.label || fieldKey,
          );
        if (missingPermitValidityLabels.length > 0) {
          toast.error(
            `请选择${missingPermitValidityLabels.join('、')}的作业票有效期开始和结束日期`,
          );
          return false;
        }
        const invalidPermitValidityLabels = submittedPermitFileKeys
          .filter(
            (fieldKey) =>
              followupForm.permitValidFromByFileKey[fieldKey].trim() >
              followupForm.permitValidUntilByFileKey[fieldKey].trim(),
          )
          .map(
            (fieldKey) =>
              DAILY_PERMIT_DEFINITIONS.find(
                (definition) => definition.fileKey === fieldKey,
              )?.label || fieldKey,
          );
        if (invalidPermitValidityLabels.length > 0) {
          toast.error(
            `${invalidPermitValidityLabels.join('、')}的有效期开始日期不能晚于结束日期`,
          );
          return false;
        }
        submittedPermitValidFromByFileKey = Object.fromEntries(
          submittedPermitFileKeys.map((fieldKey) => [
            fieldKey,
            followupForm.permitValidFromByFileKey[fieldKey].trim(),
          ]),
        );
        submittedPermitValidUntilByFileKey = Object.fromEntries(
          submittedPermitFileKeys.map((fieldKey) => [
            fieldKey,
            followupForm.permitValidUntilByFileKey[fieldKey].trim(),
          ]),
        );
      }
      const focusedDailyFileBuckets =
        activeDailyChecklistFocus && !permitOnlyUpload
          ? pickDailyFocusedFileBuckets(
              followupForm.dailyFollowupStage,
              scopedSubmitFiles,
              permitVerifications,
              dailyWorkTypes,
              activeDailyChecklistFocus,
            )
          : {};
      if (
        activeDailyChecklistFocus === 'isolation' &&
        !hasFileBucketContent(focusedDailyFileBuckets) &&
        !followupForm.isolationFeedback.trim()
      ) {
        const isolationReviewsToSync = pendingManualReviews.filter(
          (item) => item.kind === 'isolation',
        );
        if (isolationReviewsToSync.length > 0) {
          return (
            submitPendingManualReviewBatchInBackground(isolationReviewsToSync) >
            0
          );
        }
      }
      const blockingPermitIssues =
        getBlockingDailyPermitIssues(permitVerifications);
      const crewMembers = selectedConstruction?.crewMembers || [];
      const currentDailyFollowup = getDailyFollowupByRecordIdOnDate(
        selectedConstruction,
        followupForm.followupRecordId,
        dailyPermitReferenceDate,
      );
      const editingFollowup = followupForm.followupRecordId
        ? currentDailyFollowup ||
          getDailyFollowupForSubmission(
            selectedConstruction,
            followupForm.dailyFollowupStage,
            dailyPermitReferenceDate,
          )
        : getDailyFollowupForSubmission(
            selectedConstruction,
            followupForm.dailyFollowupStage,
            dailyPermitReferenceDate,
          );
      const existingDailyFilesForValidation =
        filterExistingFileMapByRemovedTokens(
          editingFollowup
            ? buildExistingDailyFollowupFileMap(editingFollowup)
            : {},
          removedExistingFileTokens,
        );
      if (
        partialDailySubmit &&
        !permitOnlyUpload &&
        activeDailyChecklistFocus &&
        !hasFileBucketContent(focusedDailyFileBuckets) &&
        !hasFocusedDailyFollowupFormContent(
          activeDailyChecklistFocus,
          followupForm,
        )
      ) {
        if (
          hasFocusedDailyFollowupExistingContent(
            activeDailyChecklistFocus,
            editingFollowup,
            existingDailyFilesForValidation,
            constructionAiAuditEnabled,
          )
        ) {
          toast.success('当前内容已是最新，无需重复提交');
          if (!options.keepDialogOpen) {
            setFollowupOpen(false);
            setDailyChecklistFocus(null);
          }
          return true;
        }
        toast.error('请填写或上传当前弹窗的跟进内容');
        return false;
      }
      const dailyPersonnelCheck = buildDailyPersonnelCheckText(
        crewMembers,
        followupForm.dailyCrewRecordIds,
        followupForm.dailyPersonnelCheck,
      );
      const shouldSubmitDailyPersonnelCheck =
        !activeDailyChecklistFocus || activeDailyChecklistFocus === 'personnel';
      const shouldSubmitDailyFollowupStaff =
        !activeDailyChecklistFocus || activeDailyChecklistFocus === 'personnel';

      if (
        !permitOnlyUpload &&
        shouldSubmitDailyFollowupStaff &&
        followupForm.followupStaffMembers.length === 0
      ) {
        toast.error('请选择跟进人员');
        return false;
      }
      if (
        !isDailyFollowupStageEnabled(followupForm.dailyFollowupStage, progress)
      ) {
        toast.error('请先完成前一个每日跟进阶段');
        return false;
      }
      if (
        !isDailyFollowupStageAllowedByPermits(
          followupForm.dailyFollowupStage,
          permitVerifications,
        )
      ) {
        toast.error(getDailyPermitBlockingMessage(blockingPermitIssues));
        return false;
      }
      if (
        !permitOnlyUpload &&
        followupForm.dailyFollowupStage === 'prepare' &&
        shouldSubmitDailyPersonnelCheck &&
        !dailyPersonnelCheck
      ) {
        toast.error('请填写每日人员核查结果');
        return false;
      }
      if (
        !permitOnlyUpload &&
        followupForm.dailyFollowupStage === 'prepare' &&
        shouldSubmitDailyPersonnelCheck &&
        crewMembers.length > 0 &&
        followupForm.dailyCrewRecordIds.length === 0
      ) {
        toast.error('请勾选今日参与施工人员');
        return false;
      }
      const missingRequiredFiles = getMissingDailyFollowupFileLabels(
        followupForm.dailyFollowupStage,
        submitFiles,
        permitVerifications,
        Object.keys(existingDailyFilesForValidation),
        activeDailyChecklistFocus,
      );
      if (!permitOnlyUpload && missingRequiredFiles.length > 0) {
        toast.error(
          `每日施工${getDailyFollowupStageLabel(followupForm.dailyFollowupStage)}需上传${missingRequiredFiles.join('、')}`,
        );
        return false;
      }
      if (followupForm.dailyFollowupStage === 'close') {
        if (!followupForm.completed) {
          toast.error('请选择项目是否整体全部完成');
          return false;
        }
        const checklistItems = getCompletionChecklistItemsForStatus(
          followupForm.completed,
        );
        const checklistError = getCompletionChecklistValidationMessage(
          followupForm.completionChecklist,
          checklistItems,
        );
        if (checklistError) {
          toast.error(checklistError);
          return false;
        }
      }
    } else if (
      !hasInitialApplicationContent(
        followupForm,
        scopedSubmitFiles,
        supplementalExistingFiles,
      )
    ) {
      toast.error('初始申请至少选择一个作业类型或上传一项申请材料');
      return false;
    }

    let followupDialogClosedBeforePayload = false;
    let optimisticUiApplied = false;
    let submitFeedbackToastId: string | number | undefined;
    if (optimisticFollowupSubmit && !options.keepDialogOpen) {
      closeFollowupDialogForOptimisticSubmit();
      followupDialogClosedBeforePayload = true;
      submitFeedbackToastId = toast.info('已受理，正在更新页面状态');
      await yieldToBrowserForConstructionResponse();
    }

    const followupSessionId =
      activeFollowupSessionIdRef.current ??
      ++followupSessionSequenceRef.current;
    activeFollowupSessionIdRef.current = followupSessionId;
    if (!optimisticFollowupSubmit) {
      followupSubmitInFlightRef.current = true;
      setSubmitting(true);
    }
    try {
      const formData = new FormData();
      const dailyPermitVerifications =
        followupForm.followupMode === 'daily'
          ? getDailyPermitVerifications(
              selectedConstruction,
              dailyPermitReferenceDate,
              followupForm.workTypes,
              constructionAiAuditEnabled,
            )
          : [];
      const localDailyFollowupRecordId =
        followupForm.followupMode === 'daily'
          ? getDailyFollowupByRecordIdOnDate(
              selectedConstruction,
              followupForm.followupRecordId,
              dailyPermitReferenceDate,
            )?.recordId ||
            getTodayDailyFollowup(
              selectedConstruction,
              dailyPermitReferenceDate,
            )?.recordId ||
            ''
          : followupForm.followupRecordId ||
            getInitialApplicationFollowup(selectedConstruction)?.recordId ||
            '';
      const existingFilesForRetention =
        followupForm.followupMode === 'daily'
          ? getExistingDailyFollowupFileMapForSubmission(
              selectedConstruction,
              followupForm,
              dailyPermitReferenceDate,
            )
          : rawSupplementalExistingFiles;
      const permitUploadFileBuckets =
        followupForm.followupMode === 'daily' && permitOnlyUpload
          ? pickDailyPermitFileBuckets(
              scopedSubmitFiles,
              dailyPermitVerifications,
              options.permitUploadFileKey,
            )
          : {};
      const retainedAttachmentRemovedTokens =
        followupForm.followupMode === 'daily' && permitOnlyUpload
          ? mergeExistingFileTokenMaps(
              removedExistingFileTokens,
              buildRemovedAttachmentTokenPayloadForUploadedFields(
                existingFilesForRetention,
                permitUploadFileBuckets,
              ),
            )
          : removedExistingFileTokens;
      const permitValidUntilPayload =
        Object.keys(submittedPermitValidUntilByFileKey).length > 0
          ? JSON.stringify(submittedPermitValidUntilByFileKey)
          : '';
      const permitValidFromPayload =
        Object.keys(submittedPermitValidFromByFileKey).length > 0
          ? JSON.stringify(submittedPermitValidFromByFileKey)
          : '';
      appendOptionalField(
        formData,
        'retainedAttachmentTokens',
        JSON.stringify(
          buildRetainedAttachmentTokenPayload(
            existingFilesForRetention,
            retainedAttachmentRemovedTokens,
          ),
        ),
      );
      appendOptionalField(
        formData,
        'constructionRecordId',
        followupForm.constructionRecordId,
      );
      appendOptionalField(
        formData,
        'followupRecordId',
        optimisticDailySubmit ? '' : localDailyFollowupRecordId,
      );
      appendOptionalField(formData, 'followupMode', followupForm.followupMode);
      appendOptionalField(
        formData,
        'permitOnlyUpload',
        permitOnlyUpload ? 'true' : '',
      );
      appendOptionalField(formData, 'permitValidFromByFileKey', permitValidFromPayload);
      appendOptionalField(formData, 'permitValidUntilByFileKey', permitValidUntilPayload);
      appendOptionalField(
        formData,
        'partialDailySubmit',
        followupForm.followupMode === 'daily' &&
          partialDailySubmit &&
          !permitOnlyUpload
          ? 'true'
          : '',
      );
      appendOptionalField(
        formData,
        'dailyChecklistFocus',
        followupForm.followupMode === 'daily' && activeDailyChecklistFocus
          ? activeDailyChecklistFocus
          : '',
      );
      appendOptionalField(
        formData,
        'dailyFollowupStage',
        followupForm.followupMode === 'daily'
          ? followupForm.dailyFollowupStage
          : '',
      );
      appendOptionalField(
        formData,
        'followupDate',
        followupForm.followupMode === 'daily'
          ? formatDateForBitableDate(dailyPermitReferenceDate)
          : formatDateForBitableDate(new Date()),
      );
      appendOptionalField(
        formData,
        'workTypes',
        followupForm.followupMode === 'daily'
          ? JSON.stringify(dailyWorkTypes)
          : followupForm.followupMode === 'supplemental'
            ? JSON.stringify(
                getCompleteSubmittableWorkTypes(
                  supplementalWorkTypes,
                  scopedSubmitFiles,
                  supplementalExistingFiles,
                ),
              )
            : '',
      );
      appendOptionalField(
        formData,
        'followupStaffIds',
        followupForm.followupMode === 'daily' &&
          (!activeDailyChecklistFocus ||
            activeDailyChecklistFocus === 'personnel')
          ? JSON.stringify(
              followupForm.followupStaffMembers.map((item) => item.id),
            )
          : '',
      );
      appendOptionalField(
        formData,
        'dailyPersonnelCheck',
        followupForm.followupMode === 'daily' &&
          followupForm.dailyFollowupStage === 'prepare' &&
          !permitOnlyUpload &&
          (!activeDailyChecklistFocus ||
            activeDailyChecklistFocus === 'personnel')
          ? buildDailyPersonnelCheckText(
              selectedConstruction?.crewMembers || [],
              followupForm.dailyCrewRecordIds,
              followupForm.dailyPersonnelCheck,
            )
          : '',
      );
      appendOptionalField(
        formData,
        'dailyCrewMembers',
        followupForm.followupMode === 'daily' &&
          followupForm.dailyFollowupStage === 'prepare' &&
          !permitOnlyUpload &&
          (!activeDailyChecklistFocus ||
            activeDailyChecklistFocus === 'personnel')
          ? JSON.stringify(
              (selectedConstruction?.crewMembers || [])
                .filter((member) =>
                  followupForm.dailyCrewRecordIds.includes(member.recordId),
                )
                .map((member) => ({
                  recordId: member.recordId,
                  name: member.name,
                  certificateSummary: member.certificateSummary,
                  complianceStatus: member.complianceStatus,
                  issueSummary: member.issueSummary,
                })),
            )
          : '',
      );
      appendOptionalField(
        formData,
        'processFeedback',
        followupForm.followupMode === 'daily' &&
          followupForm.dailyFollowupStage === 'process' &&
          (!activeDailyChecklistFocus ||
            activeDailyChecklistFocus === 'processPhoto')
          ? followupForm.processFeedback
          : '',
      );
      appendOptionalField(
        formData,
        'completed',
        followupForm.followupMode === 'daily' &&
          followupForm.dailyFollowupStage === 'close'
          ? followupForm.completed
          : '',
      );
      if (followupForm.followupMode === 'supplemental') {
        appendOptionalField(formData, 'depositPaid', followupForm.depositPaid);
        if (shouldShowDepositDetailFields(followupForm.depositPaid)) {
          appendOptionalField(
            formData,
            'depositAmount',
            followupForm.depositAmount,
          );
          appendOptionalField(
            formData,
            'depositDeducted',
            followupForm.depositDeducted,
          );
        }
      }
      if (followupForm.followupMode === 'daily') {
        appendOptionalField(
          formData,
          'checklistWorkContent',
          selectedConstruction?.workContent,
        );
        appendOptionalField(
          formData,
          'checklistConstructionCode',
          selectedConstruction?.constructionCode,
        );
        appendOptionalField(
          formData,
          'checklistBuilding',
          selectedConstruction?.building,
        );
        appendOptionalField(
          formData,
          'checklistContractor',
          selectedConstruction?.contractorType,
        );
        appendOptionalField(
          formData,
          'checklistPlanStartTime',
          selectedConstruction?.planStartTime,
        );
        appendOptionalField(
          formData,
          'checklistPlanEndTime',
          selectedConstruction?.planEndTime,
        );
      }
      if (
        followupForm.followupMode === 'daily' &&
        followupForm.dailyFollowupStage === 'close'
      ) {
        appendOptionalField(
          formData,
          'completionChecklist',
          JSON.stringify(
            buildCompletionChecklistPayload(
              followupForm.completionChecklist,
              getCompletionChecklistItemsForStatus(followupForm.completed),
            ),
          ),
        );
      }
      const filesToRetainAfterPermitUpload =
        permitOnlyUpload && options.keepDialogOpen
          ? { ...followupFiles, ...permitUploadFileBuckets }
          : {};
      const submittedFollowupFileBuckets =
        followupForm.followupMode === 'daily'
          ? permitOnlyUpload
            ? permitUploadFileBuckets
            : pickDailyFocusedFileBuckets(
                followupForm.dailyFollowupStage,
                scopedSubmitFiles,
                dailyPermitVerifications,
                dailyWorkTypes,
                activeDailyChecklistFocus,
              )
          : scopedSubmitFiles;
      const hasSubmittedFollowupFiles = hasFileBucketContent(
        submittedFollowupFileBuckets,
      );
      appendFileBuckets(formData, submittedFollowupFileBuckets);
      if (optimisticSupplementalSubmit) {
        const currentData = dataRef.current;
        if (!currentData || !selectedConstruction) {
          toast.error('施工管理数据尚未加载完成，请稍后重试');
          return false;
        }

        const clientMutationId = createConstructionClientMutationId();
        formData.append('clientMutationId', clientMutationId);
        formData.append('backgroundSync', 'true');
        const mutationKey = [
          'supplemental',
          followupForm.constructionRecordId,
          followupSessionId,
        ].join(':');
        if (inFlightMutationKeysRef.current.has(mutationKey)) {
          toast.info('当前补充跟进正在同步，请勿重复提交');
          return false;
        }
        const overlayKey = `${mutationKey}:${clientMutationId}`;
        const supplementalMutationScopeKey = [
          'supplemental',
          followupForm.constructionRecordId,
        ].join(':');
        const constructionMutationCoordinator =
          constructionMutationCoordinatorRef.current;
        const constructionRecordAliasRegistry =
          constructionRecordAliasRegistryRef.current;
        constructionRecordAliasRegistry.remember(
          supplementalMutationScopeKey,
          localDailyFollowupRecordId,
        );
        const currentSupplementalFollowup =
          (localDailyFollowupRecordId
            ? selectedConstruction.followups.find(
                (followup) =>
                  followup.recordId === localDailyFollowupRecordId &&
                  isInitialApplicationFollowup(followup),
              )
            : null) || getInitialApplicationFollowup(selectedConstruction);
        const effectiveSupplementalWorkTypes =
          supplementalWorkTypes.length > 0
            ? [...supplementalWorkTypes]
            : currentSupplementalFollowup?.workTypes.length
              ? [...currentSupplementalFollowup.workTypes]
              : [...selectedConstruction.workTypes];
        const optimisticSupplementalFiles = Object.fromEntries(
          Object.entries(submittedFollowupFileBuckets).filter(([fieldKey]) =>
            Object.prototype.hasOwnProperty.call(
              FOLLOWUP_FILE_FIELDS_BY_KEY,
              fieldKey,
            ),
          ),
        ) as FileBucket;
        const shouldPatchSupplementalAttachments =
          hasFileBucketContent(optimisticSupplementalFiles) ||
          Object.values(removedExistingFileTokens).some(
            (tokens) => tokens.length > 0,
          );
        const supplementalOptimisticFields: OptimisticFollowupFields = {
          workTypes: effectiveSupplementalWorkTypes,
          depositPaid:
            followupForm.depositPaid.trim() ||
            currentSupplementalFollowup?.depositPaid ||
            null,
        };
        if (shouldPatchSupplementalAttachments) {
          supplementalOptimisticFields.attachments =
            buildOptimisticDailyFollowupAttachments(
              currentSupplementalFollowup?.attachments || [],
              optimisticSupplementalFiles,
              removedExistingFileTokens,
              clientMutationId,
            );
        }
        const supplementalOptimisticPatch: OptimisticFollowupPatch = {
          projectRecordId: followupForm.constructionRecordId,
          followupRecordId: localDailyFollowupRecordId || null,
          followupDate: formatDateForBitableDate(new Date()),
          optimisticRecordId: `optimistic:supplemental:${clientMutationId}`,
          allowDateFallback: false,
          fields: supplementalOptimisticFields,
        };
        const parseDepositNumber = (value: string): number | null => {
          const normalized = value.trim();
          if (!normalized) {
            return null;
          }
          const parsed = Number(normalized);
          return Number.isFinite(parsed) ? parsed : null;
        };
        const depositAmount = shouldShowDepositDetailFields(
          followupForm.depositPaid,
        )
          ? parseDepositNumber(followupForm.depositAmount)
          : null;
        const depositDeducted = shouldShowDepositDetailFields(
          followupForm.depositPaid,
        )
          ? parseDepositNumber(followupForm.depositDeducted)
          : null;
        const supplementalProjectPatch: OptimisticProjectPatch = {
          projectRecordId: followupForm.constructionRecordId,
          fields: {
            ...(supplementalWorkTypes.length > 0
              ? { workTypes: effectiveSupplementalWorkTypes }
              : {}),
            ...(followupForm.depositPaid.trim()
              ? {
                  approval: {
                    depositPaid: followupForm.depositPaid.trim(),
                  },
                }
              : {}),
            ...(depositAmount !== null || depositDeducted !== null
              ? {
                  deposit: {
                    ...(depositAmount !== null
                      ? { amount: depositAmount }
                      : {}),
                    ...(depositDeducted !== null
                      ? { deducted: depositDeducted }
                      : {}),
                    ...(depositAmount !== null
                      ? {
                          balance:
                            depositAmount -
                            (depositDeducted ??
                              selectedConstruction.deposit.deducted ??
                              0),
                        }
                      : {}),
                  },
                }
              : {}),
          },
        };
        const optimisticSnapshot = captureFollowupFieldSnapshot(
          currentData,
          supplementalOptimisticPatch,
        );
        const optimisticProjectSnapshot = captureProjectFieldSnapshot(
          currentData,
          supplementalProjectPatch,
        );
        const attachmentExpectations =
          supplementalOptimisticFields.attachments &&
          hasFileBucketContent(optimisticSupplementalFiles)
            ? buildOptimisticAttachmentExpectations(
                supplementalOptimisticFields.attachments,
                Object.keys(optimisticSupplementalFiles),
              )
            : [];
        const scalarConfirmationFields = {
          ...supplementalOptimisticFields,
        };
        delete scalarConfirmationFields.attachments;
        let requestAccepted = false;
        let acceptedRecordId: string | null = null;
        inFlightMutationKeysRef.current.add(mutationKey);
        if (
          !constructionMutationCoordinator.begin({
            key: overlayKey,
            apply: (value) =>
              applyOptimisticProjectPatch(
                applyOptimisticFollowupPatch(
                  value,
                  supplementalOptimisticPatch,
                ),
                supplementalProjectPatch,
              ),
            matches: (value) => {
              if (!requestAccepted) {
                return false;
              }
              const followupConfirmed = isFollowupPatchConfirmed(value, {
                ...supplementalOptimisticPatch,
                followupRecordId:
                  acceptedRecordId ||
                  supplementalOptimisticPatch.followupRecordId,
                fields: scalarConfirmationFields,
              });
              if (
                !followupConfirmed ||
                !isProjectPatchConfirmed(value, supplementalProjectPatch)
              ) {
                return false;
              }
              if (attachmentExpectations.length === 0) {
                return true;
              }
              const authoritativeProject =
                value.items.find(
                  (item) =>
                    item.recordId ===
                    supplementalOptimisticPatch.projectRecordId,
                ) || null;
              const confirmationCandidates = deduplicateConstructionFollowups([
                ...(authoritativeProject?.followups || []),
                ...value.followups.filter((followup) =>
                  followup.overviewRecordIds.includes(
                    supplementalOptimisticPatch.projectRecordId,
                  ),
                ),
              ]).filter(
                (followup) =>
                  followup.recordId ===
                  (acceptedRecordId ||
                    supplementalOptimisticPatch.followupRecordId),
              );
              return confirmationCandidates.some((followup) =>
                matchesOptimisticAttachmentExpectations(
                  followup,
                  attachmentExpectations,
                ),
              );
            },
          })
        ) {
          inFlightMutationKeysRef.current.delete(mutationKey);
          toast.info('当前补充跟进正在同步，请勿重复提交');
          return false;
        }

        const optimisticDraft: FollowupRecoveryDraft = {
          sessionId: followupSessionId,
          projectRecordId: followupForm.constructionRecordId,
          followupMode: followupForm.followupMode,
          form: {
            ...followupForm,
            followupStaffMembers: followupForm.followupStaffMembers.map(
              (member) => ({ ...member }),
            ),
            workTypes: [...followupForm.workTypes],
            dailyCrewRecordIds: [...followupForm.dailyCrewRecordIds],
            permitValidFromByFileKey: {
              ...followupForm.permitValidFromByFileKey,
            },
            permitValidUntilByFileKey: {
              ...followupForm.permitValidUntilByFileKey,
            },
            completionChecklist: Object.fromEntries(
              Object.entries(followupForm.completionChecklist).map(
                ([key, item]) => [key, { ...item }],
              ),
            ) as CompletionChecklistFormState,
          },
          files: Object.fromEntries(
            Object.entries(followupFiles).map(([key, bucket]) => [
              key,
              [...bucket],
            ]),
          ) as FileBucket,
          removedExistingFileTokens: Object.fromEntries(
            Object.entries(removedExistingFileTokens).map(([key, tokens]) => [
              key,
              [...tokens],
            ]),
          ) as ExistingFileTokenMap,
          focus: dailyChecklistFocus,
        };

        updateConstructionData((current) =>
          current
            ? applyOptimisticProjectPatch(
                applyOptimisticFollowupPatch(
                  current,
                  supplementalOptimisticPatch,
                ),
                supplementalProjectPatch,
              )
            : current,
        );
        optimisticUiApplied = true;
        if (!options.keepDialogOpen) {
          followupOpenRef.current = false;
          setFollowupOpen(false);
          setDailyChecklistFocus(null);
          setFollowupForm((current) => ({
            ...initialFollowupForm,
            constructionRecordId: current.constructionRecordId,
            followupMode: 'supplemental',
          }));
        }
        setFollowupFiles({});
        setRemovedExistingFileTokens({});
        if (submitFeedbackToastId !== undefined) {
          toast.success('页面已更新，多维表同步中', {
            id: submitFeedbackToastId,
          });
        } else {
          toast.success('页面已更新，多维表同步中');
        }

        let serverWriteAccepted = false;
        const mutationRequest = constructionMutationCoordinator.enqueue(
          supplementalMutationScopeKey,
          async () => {
            if (!mountedRef.current) {
              throw new Error('页面已卸载，已取消待执行的施工跟进同步');
            }
            const serverFollowupRecordId =
              constructionRecordAliasRegistry.resolve(
                supplementalMutationScopeKey,
                localDailyFollowupRecordId,
              );
            if (serverFollowupRecordId) {
              formData.set('followupRecordId', serverFollowupRecordId);
            } else {
              formData.delete('followupRecordId');
            }
            const response = await createConstructionFollowup(formData);
            constructionRecordAliasRegistry.remember(
              supplementalMutationScopeKey,
              response.recordId,
            );
            return response;
          },
        );
        void mutationRequest
          .then(
            (result) => {
              serverWriteAccepted = true;
              acceptedRecordId = result.recordId?.trim() || null;
              requestAccepted = true;
              let confirmationScheduled = false;
              try {
                if (!mountedRef.current) {
                  return;
                }
                confirmationScheduled = true;
                void monitorAcceptedFollowupMutation({
                  overlayKey,
                  scopeKey: supplementalMutationScopeKey,
                  taskId: result.taskId || result.retryTaskId,
                  fallbackSnapshot: optimisticSnapshot,
                  fallbackProjectSnapshot: optimisticProjectSnapshot,
                  restoreDraft: () =>
                    recoverFailedFollowupDraft(optimisticDraft),
                }).catch((err) => {
                  if (mountedRef.current) {
                    toast.error(
                      getErrorMessage(err, '后台同步确认异常，页面变更已保留'),
                    );
                  }
                });
                toast.success(
                  result.retryTaskId
                    ? '页面已更新，飞书连接超时，后台重试同步中'
                    : result.attachmentSyncPending || hasSubmittedFollowupFiles
                      ? '多维表主记录已同步，附件后台处理中'
                      : result.message || '多维表已同步',
                );
              } catch (err) {
                if (mountedRef.current) {
                  toast.error(
                    getErrorMessage(err, '服务器已保存，页面正在重新同步'),
                  );
                }
              } finally {
                settleAcceptedOptimisticMutation({
                  confirmationScheduled,
                  releaseGate: () =>
                    inFlightMutationKeysRef.current.delete(mutationKey),
                  finishOverlay: () =>
                    constructionMutationCoordinator.finish(overlayKey),
                  requestBackgroundRefresh: () => {
                    if (!mountedRef.current) {
                      return;
                    }
                    rebaseVisibleConstructionData();
                    void loadData({
                      background: true,
                      forceRefresh: false,
                    }).catch((err) => {
                      if (mountedRef.current) {
                        toast.error(
                          getErrorMessage(
                            err,
                            '服务器已保存，但页面数据刷新失败',
                          ),
                        );
                      }
                    });
                  },
                  notifyResync: () => {
                    if (mountedRef.current) {
                      toast.error('服务器已保存，页面正在重新同步');
                    }
                  },
                });
              }
            },
            (err) => {
              inFlightMutationKeysRef.current.delete(mutationKey);
              clearOptimisticConfirmationTimer(overlayKey);
              constructionMutationCoordinator.finish(overlayKey);
              if (!mountedRef.current) {
                return;
              }
              rebaseVisibleConstructionData(
                optimisticSnapshot,
                optimisticProjectSnapshot,
              );
              const restored = recoverFailedFollowupDraft(optimisticDraft);
              toast.error(
                `${getErrorMessage(err, '施工跟进同步失败')}；同步失败，${
                  restored ? '已恢复本次草稿' : '草稿已保留，未覆盖当前弹窗'
                }`,
              );
            },
          )
          .catch((err) => {
            if (!mountedRef.current) {
              return;
            }
            toast.error(
              getErrorMessage(
                err,
                serverWriteAccepted
                  ? '多维表已同步，但页面后处理失败'
                  : '同步失败后的页面恢复处理异常',
              ),
            );
          });
        return true;
      }
      if (optimisticDailySubmit) {
        const currentData = dataRef.current;
        if (!currentData) {
          toast.error('施工管理数据尚未加载完成，请稍后重试');
          return false;
        }

        const clientMutationId = createConstructionClientMutationId();
        formData.append('clientMutationId', clientMutationId);
        formData.append('backgroundSync', 'true');
        const followupDate = formatDateForBitableDate(dailyPermitReferenceDate);
        const mutationKind = permitOnlyUpload
          ? `permit:${options.permitUploadFileKey || 'all'}`
          : activeDailyChecklistFocus || followupForm.dailyFollowupStage;
        const mutationKey = [
          followupForm.constructionRecordId,
          followupDate,
          mutationKind,
        ].join(':');
        if (inFlightMutationKeysRef.current.has(mutationKey)) {
          toast.info('当前操作正在同步，请勿重复提交');
          return false;
        }
        const overlayKey = mutationKey;
        let requestAccepted = false;
        let acceptedRecordId: string | null = null;
        const dailyMutationScopeKey = [
          followupForm.constructionRecordId,
          followupDate,
        ].join(':');
        const constructionRecordAliasRegistry =
          constructionRecordAliasRegistryRef.current;
        constructionRecordAliasRegistry.remember(
          dailyMutationScopeKey,
          localDailyFollowupRecordId,
        );
        const currentOptimisticFollowup =
          getDailyFollowupByRecordIdOnDate(
            selectedConstruction,
            localDailyFollowupRecordId,
            dailyPermitReferenceDate,
          ) ||
          getTodayDailyFollowup(selectedConstruction, dailyPermitReferenceDate);
        const optimisticFields: OptimisticFollowupFields = {};
        const shouldPatchWorkTypes =
          !permitOnlyUpload &&
          (activeDailyChecklistFocus === 'workType' ||
            (!activeDailyChecklistFocus &&
              followupForm.dailyFollowupStage === 'prepare'));
        const shouldPatchPersonnel =
          !permitOnlyUpload &&
          (!activeDailyChecklistFocus ||
            activeDailyChecklistFocus === 'personnel') &&
          followupForm.dailyFollowupStage === 'prepare';
        const shouldPatchProcess =
          (!activeDailyChecklistFocus ||
            activeDailyChecklistFocus === 'processPhoto') &&
          followupForm.dailyFollowupStage === 'process';
        const shouldPatchIsolation =
          activeDailyChecklistFocus === 'isolation' &&
          followupForm.dailyFollowupStage === 'prepare';
        const shouldPatchClose =
          (!activeDailyChecklistFocus ||
            activeDailyChecklistFocus === 'closeChecklist' ||
            activeDailyChecklistFocus === 'closePhoto') &&
          followupForm.dailyFollowupStage === 'close';

        if (shouldPatchWorkTypes) {
          optimisticFields.workTypes = [...dailyWorkTypes];
          optimisticFields.dailyWorkTypesConfirmed = true;
        }
        if (shouldPatchPersonnel) {
          optimisticFields.followupStaffMembers =
            followupForm.followupStaffMembers.map(({ id, name }) => ({
              id,
              name,
            }));
          optimisticFields.followupStaff =
            followupForm.followupStaffMembers
              .map((member) => member.name)
              .filter(Boolean)
              .join('、') || null;
          optimisticFields.dailyPersonnelCheck =
            buildDailyPersonnelCheckText(
              selectedConstruction?.crewMembers || [],
              followupForm.dailyCrewRecordIds,
              followupForm.dailyPersonnelCheck,
            ) || null;
        }
        if (shouldPatchIsolation) {
          if (manualReviewAutoApproved) {
            optimisticFields.isolationCompliant = '通过';
          }
          if (followupForm.isolationFeedback.trim()) {
            optimisticFields.isolationFeedback =
              followupForm.isolationFeedback.trim();
          }
        }
        if (shouldPatchProcess && followupForm.processFeedback.trim()) {
          optimisticFields.processFeedback =
            followupForm.processFeedback.trim();
        }
        if (shouldPatchClose) {
          if (activeDailyChecklistFocus !== 'closePhoto') {
            optimisticFields.completed = followupForm.completed || null;
            optimisticFields.completionChecklist =
              buildCompletionChecklistPayload(
                followupForm.completionChecklist,
                getCompletionChecklistItemsForStatus(followupForm.completed),
              );
          }
        }

        const shouldPatchAttachments =
          hasSubmittedFollowupFiles &&
          activeDailyChecklistFocus !== 'workType' &&
          activeDailyChecklistFocus !== 'personnel';
        if (shouldPatchAttachments) {
          optimisticFields.attachments =
            buildOptimisticDailyFollowupAttachments(
              currentOptimisticFollowup?.attachments || [],
              submittedFollowupFileBuckets,
              retainedAttachmentRemovedTokens,
              clientMutationId,
              manualReviewAutoApproved,
              submittedPermitValidFromByFileKey,
              submittedPermitValidUntilByFileKey,
            );
        }

        const optimisticPatch: OptimisticFollowupPatch = {
          projectRecordId: followupForm.constructionRecordId,
          followupRecordId: localDailyFollowupRecordId || null,
          followupDate,
          optimisticRecordId: `optimistic:${clientMutationId}`,
          fields: optimisticFields,
        };
        const optimisticSnapshot = captureFollowupFieldSnapshot(
          currentData,
          optimisticPatch,
        );
        const attachmentExpectations =
          shouldPatchAttachments && optimisticFields.attachments
            ? buildOptimisticAttachmentExpectations(
                optimisticFields.attachments,
                Object.keys(submittedFollowupFileBuckets),
              )
            : [];
        const scalarConfirmationFields = {
          ...optimisticFields,
        };
        delete scalarConfirmationFields.attachments;
        const constructionMutationCoordinator =
          constructionMutationCoordinatorRef.current;
        inFlightMutationKeysRef.current.add(mutationKey);
        if (
          !constructionMutationCoordinator.begin({
            key: overlayKey,
            apply: (value) =>
              applyOptimisticFollowupPatch(value, optimisticPatch),
            matches: (value) => {
              if (!requestAccepted) {
                return false;
              }
              const scalarConfirmed =
                Object.keys(scalarConfirmationFields).length === 0 ||
                isFollowupPatchConfirmed(value, {
                  ...optimisticPatch,
                  followupRecordId:
                    acceptedRecordId || optimisticPatch.followupRecordId,
                  fields: scalarConfirmationFields,
                });
              if (!scalarConfirmed || attachmentExpectations.length === 0) {
                return scalarConfirmed;
              }
              const authoritativeProject =
                value.items.find(
                  (item) => item.recordId === optimisticPatch.projectRecordId,
                ) || null;
              const relatedFollowups = deduplicateConstructionFollowups([
                ...(authoritativeProject?.followups || []),
                ...value.followups.filter((followup) =>
                  followup.overviewRecordIds.includes(
                    optimisticPatch.projectRecordId,
                  ),
                ),
              ]);
              const confirmationCandidates = acceptedRecordId
                ? relatedFollowups.filter(
                    (followup) => followup.recordId === acceptedRecordId,
                  )
                : relatedFollowups.filter((followup) =>
                    isDailyFollowupOnDate(followup, dailyPermitReferenceDate),
                  );
              return confirmationCandidates.some((followup) =>
                matchesOptimisticAttachmentExpectations(
                  followup,
                  attachmentExpectations,
                ),
              );
            },
          })
        ) {
          inFlightMutationKeysRef.current.delete(mutationKey);
          toast.info('当前操作正在同步，请勿重复提交');
          return false;
        }

        const optimisticDraft: FollowupRecoveryDraft = {
          sessionId: followupSessionId,
          projectRecordId: followupForm.constructionRecordId,
          followupMode: followupForm.followupMode,
          form: {
            ...followupForm,
            followupStaffMembers: followupForm.followupStaffMembers.map(
              (member) => ({ ...member }),
            ),
            workTypes: [...followupForm.workTypes],
            dailyCrewRecordIds: [...followupForm.dailyCrewRecordIds],
            permitValidFromByFileKey: {
              ...followupForm.permitValidFromByFileKey,
            },
            permitValidUntilByFileKey: {
              ...followupForm.permitValidUntilByFileKey,
            },
            completionChecklist: Object.fromEntries(
              Object.entries(followupForm.completionChecklist).map(
                ([key, item]) => [key, { ...item }],
              ),
            ) as CompletionChecklistFormState,
          },
          files: Object.fromEntries(
            Object.entries(followupFiles).map(([key, bucket]) => [
              key,
              [...bucket],
            ]),
          ) as FileBucket,
          removedExistingFileTokens: Object.fromEntries(
            Object.entries(removedExistingFileTokens).map(([key, tokens]) => [
              key,
              [...tokens],
            ]),
          ) as ExistingFileTokenMap,
          focus: dailyChecklistFocus,
        };
        const reviewsToSync =
          pendingManualReviews.length > 0 ? [...pendingManualReviews] : [];

        updateConstructionData((current) =>
          current
            ? applyOptimisticFollowupPatch(current, optimisticPatch)
            : current,
        );
        optimisticUiApplied = true;
        if (!options.keepDialogOpen) {
          followupOpenRef.current = false;
          setFollowupOpen(false);
          setDailyChecklistFocus(null);
          setFollowupForm((current) => ({
            ...initialFollowupForm,
            constructionRecordId: current.constructionRecordId,
          }));
        }
        setFollowupFiles(
          options.keepDialogOpen ? filesToRetainAfterPermitUpload : {},
        );
        setRemovedExistingFileTokens({});
        if (submitFeedbackToastId !== undefined) {
          toast.success('页面已更新，多维表同步中', {
            id: submitFeedbackToastId,
          });
        } else {
          toast.success('页面已更新，多维表同步中');
        }

        const mutationRequest = constructionMutationCoordinator.enqueue(
          dailyMutationScopeKey,
          () => {
            if (!mountedRef.current) {
              throw new Error('页面已卸载，已取消待执行的施工跟进同步');
            }
            const serverFollowupRecordId =
              constructionRecordAliasRegistry.resolve(
                dailyMutationScopeKey,
                localDailyFollowupRecordId,
              );
            if (serverFollowupRecordId) {
              formData.set('followupRecordId', serverFollowupRecordId);
            } else {
              formData.delete('followupRecordId');
            }
            return createConstructionFollowup(formData);
          },
        );
        let serverWriteAccepted = false;
        void mutationRequest
          .then(
            (result) => {
              constructionRecordAliasRegistry.remember(
                dailyMutationScopeKey,
                result.recordId,
              );
              serverWriteAccepted = true;
              acceptedRecordId = result.recordId?.trim() || null;
              requestAccepted = true;
              inFlightMutationKeysRef.current.delete(mutationKey);
              if (!mountedRef.current) {
                clearOptimisticConfirmationTimer(overlayKey);
                constructionMutationCoordinator.finish(overlayKey);
                constructionRecordAliasRegistry.clear(dailyMutationScopeKey);
                return;
              }
              void monitorAcceptedFollowupMutation({
                overlayKey,
                scopeKey: dailyMutationScopeKey,
                taskId: result.taskId || result.retryTaskId,
                fallbackSnapshot: optimisticSnapshot,
                restoreDraft: () => recoverFailedFollowupDraft(optimisticDraft),
              }).catch((err) => {
                if (mountedRef.current) {
                  toast.error(
                    getErrorMessage(err, '后台同步确认异常，页面变更已保留'),
                  );
                }
              });
              writeDailyFollowupFormCache(
                optimisticDraft.form,
                result.recordId || localDailyFollowupRecordId,
                dailyPermitReferenceDate,
              );
              if (reviewsToSync.length > 0) {
                submitPendingManualReviewBatchInBackground(reviewsToSync, {
                  announce: false,
                });
              }
              toast.success(
                options.successMessage ||
                  (result.retryTaskId
                    ? '页面已更新，飞书连接超时，后台重试同步中'
                    : result.attachmentSyncPending || hasSubmittedFollowupFiles
                      ? '多维表主记录已同步，附件后台处理中'
                      : result.message || '多维表已同步'),
              );
            },
            (err) => {
              inFlightMutationKeysRef.current.delete(mutationKey);
              clearOptimisticConfirmationTimer(overlayKey);
              constructionMutationCoordinator.finish(overlayKey);
              if (!mountedRef.current) {
                constructionRecordAliasRegistry.clear(dailyMutationScopeKey);
                return;
              }
              rebaseVisibleConstructionData(optimisticSnapshot);
              const restored = recoverFailedFollowupDraft(optimisticDraft);
              toast.error(
                `${getErrorMessage(err, '施工跟进同步失败')}；同步失败，${
                  restored ? '已恢复本次草稿' : '草稿已保留，未覆盖当前弹窗'
                }`,
              );
            },
          )
          .catch((err) => {
            if (!mountedRef.current) {
              return;
            }
            toast.error(
              getErrorMessage(
                err,
                serverWriteAccepted
                  ? '多维表已同步，但页面后处理失败'
                  : '同步失败后的页面恢复处理异常',
              ),
            );
          });
        return true;
      }
      throw new Error('不支持的施工跟进提交模式');
    } catch (err) {
      toast.error(getErrorMessage(err, '施工跟进提交失败'));
      return false;
    } finally {
      if (followupDialogClosedBeforePayload && !optimisticUiApplied) {
        followupOpenRef.current = true;
        setFollowupOpen(true);
      }
      if (!optimisticFollowupSubmit) {
        followupSubmitInFlightRef.current = false;
        setSubmitting(false);
      }
    }
  };

  const handleGeneratedOnlineFormSubmit = async (
    fieldKey: string,
    file: File,
  ): Promise<boolean> => {
    if (!requireConstructionEdit('生成在线表附件')) {
      return false;
    }
    const selectedConstruction =
      visibleConstructionItems.find(
        (item) => item.recordId === followupForm.constructionRecordId,
      ) || null;
    if (!selectedConstruction) {
      toast.error('请选择施工项目后再生成附件');
      return false;
    }
    const latestTodayFollowup = getTodayDailyFollowup(
      selectedConstruction,
      new Date(),
    );
    if (!latestTodayFollowup?.recordId) {
      toast.error('今天还没有施工跟进记录，请先提交一条每日跟进后再生成附件');
      return false;
    }

    const mutationKey = `online-form:${selectedConstruction.recordId}:${latestTodayFollowup.recordId}:${fieldKey}`;
    if (inFlightMutationKeysRef.current.has(mutationKey)) {
      toast.info('该在线表单正在回填，请勿重复提交');
      return false;
    }
    inFlightMutationKeysRef.current.add(mutationKey);
    try {
      const generatedWorkApplication =
        isGeneratedOnlineWorkApplicationField(fieldKey);
      const existingDailyFiles =
        buildExistingDailyFollowupFileMap(latestTodayFollowup);
      const formData = new FormData();
      appendOptionalField(
        formData,
        'retainedAttachmentTokens',
        JSON.stringify(
          buildGeneratedOnlineFormRetainedAttachmentTokenPayload(
            existingDailyFiles,
            fieldKey,
          ),
        ),
      );
      appendOptionalField(
        formData,
        'constructionRecordId',
        selectedConstruction.recordId,
      );
      appendOptionalField(
        formData,
        'followupRecordId',
        latestTodayFollowup.recordId,
      );
      appendOptionalField(
        formData,
        'followupMode',
        generatedWorkApplication ? 'daily' : 'supplemental',
      );
      if (generatedWorkApplication) {
        appendOptionalField(formData, 'dailyFollowupStage', 'prepare');
        appendOptionalField(formData, 'permitOnlyUpload', 'true');
        appendOptionalField(
          formData,
          'followupDate',
          formatDateForBitableDate(new Date()),
        );
        appendOptionalField(
          formData,
          'workTypes',
          JSON.stringify(selectedConstruction.workTypes),
        );
        appendOptionalField(
          formData,
          'checklistWorkContent',
          selectedConstruction.workContent,
        );
        appendOptionalField(
          formData,
          'checklistConstructionCode',
          selectedConstruction.constructionCode,
        );
        appendOptionalField(
          formData,
          'checklistBuilding',
          selectedConstruction.building,
        );
        appendOptionalField(
          formData,
          'checklistContractor',
          selectedConstruction.contractorType,
        );
        appendOptionalField(
          formData,
          'checklistPlanStartTime',
          selectedConstruction.planStartTime,
        );
        appendOptionalField(
          formData,
          'checklistPlanEndTime',
          selectedConstruction.planEndTime,
        );
      }
      formData.append(fieldKey, file);
      formData.append('clientMutationId', createConstructionClientMutationId());
      formData.append('backgroundSync', 'true');

      const result = await createConstructionFollowup(formData);
      const label = FOLLOWUP_FILE_FIELDS_BY_KEY[fieldKey] || '在线表单';
      const confirmation = await monitorOptimisticConfirmation({
        taskId: result.taskId || result.retryTaskId,
        maxPolls: OPTIMISTIC_CONFIRMATION_MAX_POLLS,
        readTask: async (taskId) => {
          const response = await getSyncTaskStatus(taskId);
          if (!response.success || !response.task) {
            throw new Error(response.message || '后台同步任务不存在');
          }
          return {
            status: response.task.status,
            message: response.task.message,
          };
        },
        refresh: () => loadData({ background: true, forceRefresh: false }),
        isPending: () => false,
        wait: () =>
          new Promise((resolve) =>
            window.setTimeout(
              resolve,
              OPTIMISTIC_CONFIRMATION_POLL_INTERVAL_MS,
            ),
          ),
        shouldStop: () => !mountedRef.current,
      });
      if (!mountedRef.current || confirmation.status === 'cancelled') {
        return false;
      }
      if (confirmation.status === 'failed') {
        toast.error(`${label}后台回填失败：${confirmation.message}`);
        return false;
      }
      if (confirmation.status === 'unknown') {
        toast.warning(
          `${label}后台状态暂未确认，本地预览已保留：${confirmation.message}`,
        );
        return true;
      }
      toast.success(`${label}已生成 Word，并回填到今天最新跟进记录`);
      return true;
    } catch (err) {
      if (mountedRef.current) {
        toast.error(getErrorMessage(err, '在线表单回填失败'));
      }
      return false;
    } finally {
      inFlightMutationKeysRef.current.delete(mutationKey);
    }
  };

  const handleDailyPermitUpload = (
    verification: DailyPermitVerification,
    selectedFiles: File[],
  ) => {
    if (!requireConstructionEdit('上传作业票')) {
      return;
    }
    if (submitting) {
      return;
    }
    if (followupForm.followupMode !== 'daily') {
      toast.error('请先切换到每日跟进');
      return;
    }
    if (followupForm.dailyFollowupStage !== 'prepare') {
      toast.error('作业票续期需在每日准备阶段提交');
      return;
    }
    if (selectedFiles.length === 0) {
      return;
    }
    if (manualReviewAutoApproved) {
      const validFrom =
        followupForm.permitValidFromByFileKey[verification.fileKey]?.trim() ||
        '';
      const validUntil =
        followupForm.permitValidUntilByFileKey[verification.fileKey]?.trim() ||
        '';
      if (!validFrom || !validUntil) {
        toast.error(`请先选择${verification.label}有效期开始和结束日期`);
        return;
      }
      if (validFrom > validUntil) {
        toast.error(`${verification.label}有效期开始日期不能晚于结束日期`);
        return;
      }
    }

    const nextFiles = {
      ...followupFiles,
      [verification.fileKey]: selectedFiles,
    };
    setFollowupFiles(nextFiles);
    toast.success(`${verification.label}已选择，请提交作业票校核`);
  };

  const handleRefreshConstructionBitableData = useCallback(
    async (successMessage = '已同步多维表最新数据') => {
      if (manualReviewRefreshing || followupSubmitInFlightRef.current) {
        return;
      }
      setManualReviewRefreshing(true);
      try {
        if (
          await loadData({
            background: true,
            forceRefresh: false,
          })
        ) {
          toast.success(successMessage);
        }
      } catch (err) {
        toast.error(getErrorMessage(err, '多维表数据同步失败'));
      } finally {
        setManualReviewRefreshing(false);
      }
    },
    [loadData, manualReviewRefreshing],
  );

  const handleRefreshConstructionData = useCallback(
    async (successMessage = '已同步多维表最新数据') => {
      try {
        if (
          await loadData({
            background: true,
            forceRefresh: false,
          })
        ) {
          toast.success(successMessage);
        }
      } catch (err) {
        toast.error(getErrorMessage(err, '多维表数据同步失败'));
      }
    },
    [loadData],
  );
  const handleRefreshApprovalStatus = useCallback(() => {
    void handleRefreshConstructionData('已刷新质保金确认状态');
  }, [handleRefreshConstructionData]);
  const handleProjectTerminateRequest = useCallback(
    (candidate: ConstructionOverviewItem) => {
      projectTerminateCandidateRef.current = candidate;
      setProjectTerminateCandidate(candidate);
    },
    [],
  );

  const handlePermitManualReviewRequest = useCallback(
    (
      verification: DailyPermitVerification,
      followupRecordId: string | null,
      decision: ConstructionPermitManualReviewDecision,
      validFrom: string | null,
      validUntil: string | null,
    ) => {
      if (!requireConstructionEdit('暂存作业票人工审核')) {
        return;
      }
      const targetFollowupRecordId =
        followupRecordId || verification.sourceFollowupRecordId;
      const projectRecordId =
        followupFormRef.current.constructionRecordId.trim();
      if (!projectRecordId) {
        toast.error('未找到施工项目，无法暂存人工审核');
        return;
      }
      if (!targetFollowupRecordId) {
        toast.error('未找到施工跟进记录，无法暂存人工审核');
        return;
      }
      if (decision === 'passed') {
        if (!validFrom || !validUntil) {
          toast.error('人工审核通过时请填写授权有效期开始和结束日期');
          return;
        }
        if (validFrom > validUntil) {
          toast.error('授权有效期开始日期不能晚于结束日期');
          return;
        }
      }

      const pending: PendingManualReviewItem = {
        id: buildPendingPermitManualReviewId(
          targetFollowupRecordId,
          verification.fileKey,
        ),
        kind: 'permit',
        label: verification.label,
        followupRecordId: targetFollowupRecordId,
        fileKey: verification.fileKey,
        decision,
        permitFileTokens: verification.files
          .map((file) => file.fileToken)
          .filter(Boolean),
        permitFingerprint: verification.manualReview.expectedFingerprint,
        sourceFeedback: verification.sourceText,
        validFrom: decision === 'passed' ? validFrom : null,
        validUntil: decision === 'passed' ? validUntil : null,
      };

      updateScopedPendingManualReviews((current) =>
        upsertScopedPendingManualReview(
          current,
          buildManualReviewScope(
            projectRecordId,
            targetFollowupRecordId,
            'permit',
          ),
          pending,
        ),
      );
      toast.success(`${verification.label}人工审核已暂存，统一提交后同步`);
    },
    [requireConstructionEdit, updateScopedPendingManualReviews],
  );

  const handleIsolationPhotoManualReviewRequest = useCallback(
    (
      followupRecordId: string | null,
      decision: ConstructionPermitManualReviewDecision,
    ) => {
      if (!requireConstructionEdit('暂存挂牌隔离人工审核')) {
        return;
      }
      if (!followupRecordId) {
        toast.error('未找到施工跟进记录，无法暂存挂牌隔离人工审核');
        return;
      }
      const projectRecordId =
        followupFormRef.current.constructionRecordId.trim();
      if (!projectRecordId) {
        toast.error('未找到施工项目，无法暂存挂牌隔离人工审核');
        return;
      }

      const pending: PendingManualReviewItem = {
        id: buildPendingIsolationManualReviewId(followupRecordId),
        kind: 'isolation',
        label: '挂牌隔离照片',
        followupRecordId,
        decision,
      };

      updateScopedPendingManualReviews((current) =>
        upsertScopedPendingManualReview(
          current,
          buildManualReviewScope(
            projectRecordId,
            followupRecordId,
            'isolation',
          ),
          pending,
        ),
      );
      toast.success('挂牌隔离人工审核已暂存，统一提交后同步');
    },
    [requireConstructionEdit, updateScopedPendingManualReviews],
  );

  const handleSubmitPendingManualReviews = useCallback(() => {
    if (!requireConstructionEdit('提交人工审核')) {
      return;
    }
    if (pendingManualReviews.length === 0) {
      toast.info('暂无待提交人工审核');
      return;
    }
    if (
      submitPendingManualReviewBatchInBackground(pendingManualReviews) === 0
    ) {
      toast.info('所选人工审核正在同步，请勿重复提交');
    }
  }, [
    pendingManualReviews,
    requireConstructionEdit,
    submitPendingManualReviewBatchInBackground,
  ]);

  const monitorConstructionProjectDeleteTask = useCallback(
    async (taskId: string, callbacks: ConstructionBackgroundTaskCallbacks) => {
      let consecutiveErrors = 0;
      let lastStatusMessage = '项目删除后台状态暂不可确认';
      for (
        let attempt = 0;
        attempt < CREW_ROSTER_TASK_MAX_POLLS;
        attempt += 1
      ) {
        if (!mountedRef.current) {
          return;
        }
        try {
          const taskStatus = await getSyncTaskStatus(taskId);
          const task = taskStatus.task;
          if (!taskStatus.success || !task) {
            throw new Error(taskStatus.message || '项目删除后台任务不存在');
          }
          consecutiveErrors = 0;
          if (task.status === 'completed') {
            await loadData({ background: true, forceRefresh: false });
            if (mountedRef.current) {
              callbacks.onCompleted(task.message || '项目后台删除完成');
            }
            return;
          }
          if (task.status === 'failed') {
            callbacks.onFailed(task.message || '项目后台删除失败');
            return;
          }
        } catch (err) {
          consecutiveErrors += 1;
          lastStatusMessage = getErrorMessage(err, '项目删除后台任务查询失败');
          if (
            consecutiveErrors >= CONSTRUCTION_TASK_STATUS_MAX_CONSECUTIVE_ERRORS
          ) {
            callbacks.onUnknown(lastStatusMessage);
            return;
          }
          await new Promise((resolve) =>
            window.setTimeout(resolve, CREW_ROSTER_TASK_POLL_INTERVAL_MS),
          );
          continue;
        }

        await new Promise((resolve) =>
          window.setTimeout(resolve, CREW_ROSTER_TASK_POLL_INTERVAL_MS),
        );
      }
      callbacks.onUnknown(lastStatusMessage);
    },
    [loadData],
  );

  const handleConfirmDeleteProject = () => {
    if (!requireConstructionDelete('删除项目')) {
      return;
    }
    const candidate = projectDeleteCandidate;
    if (!candidate) {
      return;
    }
    if (isOptimisticConstructionRecordId(candidate.recordId)) {
      toast.info('项目正在同步到多维表，暂不能删除');
      return;
    }
    const currentData = dataRef.current;
    if (!currentData) {
      toast.error('施工管理数据尚未加载完成，请稍后重试');
      return;
    }
    const mutationKey = `project:delete:${candidate.recordId}`;
    if (inFlightMutationKeysRef.current.has(mutationKey)) {
      toast.info('该项目正在后台删除，请勿重复提交');
      return;
    }

    let requestAccepted = false;
    const overlayKey = `${mutationKey}:${createConstructionClientMutationId()}`;
    const deletionChanges = {
      removedExpanded: expandedProjectIds.has(candidate.recordId),
      clearedSelected: selectedConstruction?.recordId === candidate.recordId,
      removedListItem: Boolean(
        constructionListDialog?.items.some(
          (item) => item.recordId === candidate.recordId,
        ),
      ),
      closedFollowup:
        followupOpen &&
        followupForm.constructionRecordId === candidate.recordId,
      clearedCandidate: true,
    };
    const uiContext = {
      selectedDetailStageKey,
      selectedDetailDailyOnly,
      listIdentity: getConstructionListDialogIdentity(constructionListDialog),
      listIndex:
        constructionListDialog?.items.findIndex(
          (item) => item.recordId === candidate.recordId,
        ) ?? -1,
      followup: {
        form: {
          ...followupForm,
          followupStaffMembers: followupForm.followupStaffMembers.map(
            (member) => ({ ...member }),
          ),
          workTypes: [...followupForm.workTypes],
          dailyCrewRecordIds: [...followupForm.dailyCrewRecordIds],
          completionChecklist: Object.fromEntries(
            Object.entries(followupForm.completionChecklist).map(
              ([key, item]) => [key, { ...item }],
            ),
          ) as CompletionChecklistFormState,
        },
        files: Object.fromEntries(
          Object.entries(followupFiles).map(([key, bucket]) => [
            key,
            [...bucket],
          ]),
        ) as FileBucket,
        removedExistingFileTokens: Object.fromEntries(
          Object.entries(removedExistingFileTokens).map(([key, tokens]) => [
            key,
            [...tokens],
          ]),
        ) as ExistingFileTokenMap,
        focus: dailyChecklistFocus,
      },
    };
    let deletionListAfterRemoval: ConstructionListDialogState | null = null;
    const restoreDeletedProjectUiIfUntouched = () => {
      const latestTarget =
        dataRef.current?.items.find(
          (item) => item.recordId === candidate.recordId,
        ) || candidate;
      const currentList = constructionListDialogRef.current;
      const decisions = getTerminationUiRestoreDecisions({
        targetRecordId: candidate.recordId,
        changed: deletionChanges,
        originalListIdentity: uiContext.listIdentity,
        current: {
          expandedHasTarget: expandedProjectIdsRef.current.has(
            candidate.recordId,
          ),
          selectedRecordId: selectedConstructionRef.current?.recordId || null,
          listIdentity: getConstructionListDialogIdentity(currentList),
          listHasTarget: Boolean(
            currentList?.items.some(
              (item) => item.recordId === candidate.recordId,
            ),
          ),
          listOperationOwned:
            currentList !== null && currentList === deletionListAfterRemoval,
          followupOpen: followupOpenRef.current,
          followupPristine: isFollowupUiPristine(
            followupFormRef.current,
            followupFilesRef.current,
            removedExistingFileTokensRef.current,
            dailyChecklistFocusRef.current,
          ),
          candidateRecordId:
            projectDeleteCandidateRef.current?.recordId || null,
        },
      });
      if (decisions.restoreExpanded) {
        const next = new Set(expandedProjectIdsRef.current);
        next.add(candidate.recordId);
        expandedProjectIdsRef.current = next;
        setExpandedProjectIds(next);
      }
      if (decisions.restoreSelected) {
        selectedConstructionRef.current = latestTarget;
        selectedDetailStageKeyRef.current = uiContext.selectedDetailStageKey;
        selectedDetailDailyOnlyRef.current = uiContext.selectedDetailDailyOnly;
        setSelectedConstruction(latestTarget);
        setSelectedDetailStageKey(uiContext.selectedDetailStageKey);
        setSelectedDetailDailyOnly(uiContext.selectedDetailDailyOnly);
      }
      if (decisions.restoreListItem && currentList) {
        const items = [...currentList.items];
        items.splice(
          Math.min(Math.max(uiContext.listIndex, 0), items.length),
          0,
          latestTarget,
        );
        const restoredList = { ...currentList, items };
        constructionListDialogRef.current = restoredList;
        setConstructionListDialog(restoredList);
      }
      if (decisions.restoreFollowup) {
        followupOpenRef.current = true;
        followupFormRef.current = uiContext.followup.form;
        followupFilesRef.current = uiContext.followup.files;
        removedExistingFileTokensRef.current =
          uiContext.followup.removedExistingFileTokens;
        dailyChecklistFocusRef.current = uiContext.followup.focus;
        setFollowupForm(uiContext.followup.form);
        setFollowupFiles(uiContext.followup.files);
        setRemovedExistingFileTokens(
          uiContext.followup.removedExistingFileTokens,
        );
        setDailyChecklistFocus(uiContext.followup.focus);
        setFollowupOpen(true);
      }
      if (decisions.restoreCandidate) {
        projectDeleteCandidateRef.current = latestTarget;
        setProjectDeleteCandidate(latestTarget);
      }
    };
    const constructionMutationCoordinator =
      constructionMutationCoordinatorRef.current;
    inFlightMutationKeysRef.current.add(mutationKey);
    if (
      !constructionMutationCoordinator.begin({
        key: overlayKey,
        apply: (value) =>
          applyProjectTombstones(value, new Set([candidate.recordId])),
        matches: (value) =>
          requestAccepted &&
          !value.items.some((item) => item.recordId === candidate.recordId),
      })
    ) {
      inFlightMutationKeysRef.current.delete(mutationKey);
      toast.info('该项目正在后台删除，请勿重复提交');
      return;
    }

    updateConstructionData((value) =>
      value
        ? applyProjectTombstones(value, new Set([candidate.recordId]))
        : value,
    );
    if (deletionChanges.removedExpanded) {
      const next = new Set(expandedProjectIds);
      next.delete(candidate.recordId);
      expandedProjectIdsRef.current = next;
      setExpandedProjectIds(next);
    }
    if (deletionChanges.removedListItem && constructionListDialog) {
      const nextList = {
        ...constructionListDialog,
        items: constructionListDialog.items.filter(
          (item) => item.recordId !== candidate.recordId,
        ),
      };
      deletionListAfterRemoval = nextList;
      constructionListDialogRef.current = nextList;
      setConstructionListDialog(nextList);
    }
    if (deletionChanges.clearedSelected) {
      selectedConstructionRef.current = null;
      selectedDetailStageKeyRef.current = null;
      selectedDetailDailyOnlyRef.current = false;
      setSelectedConstruction(null);
      setSelectedDetailStageKey(null);
      setSelectedDetailDailyOnly(false);
    }
    if (deletionChanges.closedFollowup) {
      followupOpenRef.current = false;
      followupFormRef.current = initialFollowupForm;
      followupFilesRef.current = {};
      removedExistingFileTokensRef.current = {};
      dailyChecklistFocusRef.current = null;
      setFollowupOpen(false);
      setFollowupForm(initialFollowupForm);
      setFollowupFiles({});
      setRemovedExistingFileTokens({});
      setDailyChecklistFocus(null);
    }
    projectDeleteCandidateRef.current = null;
    setProjectDeleteCandidate(null);

    const rollbackExplicitFailure = (message: string) => {
      inFlightMutationKeysRef.current.delete(mutationKey);
      clearOptimisticConfirmationTimer(overlayKey);
      constructionMutationCoordinator.finish(overlayKey);
      if (!mountedRef.current) {
        return;
      }
      rebaseVisibleConstructionData();
      restoreDeletedProjectUiIfUntouched();
      toast.error(`${message}；已恢复页面原状态`);
    };
    const keepPendingConfirmation = (message: string) => {
      inFlightMutationKeysRef.current.delete(mutationKey);
      if (!mountedRef.current) {
        return;
      }
      void loadData({
        background: true,
        forceRefresh: false,
      })
        .then(() => {
          if (!mountedRef.current) {
            return;
          }
          if (!constructionMutationCoordinator.has(overlayKey)) {
            toast.success('项目删除已由服务器数据确认完成');
            return;
          }
          scheduleOptimisticConfirmationTimeout(overlayKey);
          toast.warning(`${message}，已停止等待，请稍后刷新确认`);
        })
        .catch((err) => {
          if (!mountedRef.current) {
            return;
          }
          if (constructionMutationCoordinator.has(overlayKey)) {
            scheduleOptimisticConfirmationTimeout(overlayKey);
          }
          toast.warning(
            `${message}；${getErrorMessage(err, '服务器状态刷新失败')}，请稍后刷新确认`,
          );
        });
    };
    const completeDeletion = (message: string) => {
      inFlightMutationKeysRef.current.delete(mutationKey);
      if (!mountedRef.current) {
        return;
      }
      if (constructionMutationCoordinator.has(overlayKey)) {
        scheduleOptimisticConfirmationTimeout(overlayKey);
      }
      toast.success(message);
    };

    void deleteConstructionProject({
      recordId: candidate.recordId,
      constructionCode: candidate.constructionCode,
    })
      .then(
        (result) => {
          requestAccepted = true;
          if (!mountedRef.current) {
            inFlightMutationKeysRef.current.delete(mutationKey);
            constructionMutationCoordinator.finish(overlayKey);
            return;
          }
          toast.success(result.message || '项目删除已受理，后台处理中');
          if (result.taskId) {
            void monitorConstructionProjectDeleteTask(result.taskId, {
              onCompleted: completeDeletion,
              onFailed: rollbackExplicitFailure,
              onUnknown: keepPendingConfirmation,
            }).catch((err) =>
              keepPendingConfirmation(
                getErrorMessage(err, '项目删除已受理，但页面任务监控异常'),
              ),
            );
            return;
          }
          if (result.pending) {
            keepPendingConfirmation(
              result.message || '项目删除已受理，但未返回后台任务编号',
            );
            return;
          }
          void loadData({
            background: true,
            forceRefresh: false,
          })
            .then(() => completeDeletion(result.message || '项目删除完成'))
            .catch((err) =>
              keepPendingConfirmation(
                getErrorMessage(err, '项目删除已受理，但页面状态刷新失败'),
              ),
            );
        },
        (err) =>
          rollbackExplicitFailure(getErrorMessage(err, '施工项目删除失败')),
      )
      .catch((err) => {
        const message = getErrorMessage(
          err,
          requestAccepted
            ? '项目删除已受理，但页面后处理失败'
            : '施工项目删除失败',
        );
        if (requestAccepted) {
          keepPendingConfirmation(message);
        } else {
          rollbackExplicitFailure(message);
        }
      });
  };

  const handleConfirmTerminateProject = () => {
    if (!requireConstructionEdit('终止项目')) {
      return;
    }
    const candidate = projectTerminateCandidate;
    if (!candidate) {
      return;
    }
    if (isOptimisticConstructionRecordId(candidate.recordId)) {
      toast.info('项目正在同步到多维表，暂不能终止');
      return;
    }
    const currentData = dataRef.current;
    if (!currentData) {
      toast.error('施工管理数据尚未加载完成，请稍后重试');
      return;
    }
    const mutationKey = `project:terminate:${candidate.recordId}`;
    if (inFlightMutationKeysRef.current.has(mutationKey)) {
      toast.info('该项目正在终止同步，请勿重复提交');
      return;
    }

    let acceptedWorkflow = '已终止';
    let requestAccepted = false;
    const getOptimisticPatch = (): OptimisticProjectPatch => ({
      projectRecordId: candidate.recordId,
      fields: { workflow: acceptedWorkflow },
    });
    const projectSnapshot = captureProjectFieldSnapshot(
      currentData,
      getOptimisticPatch(),
    );
    if (!projectSnapshot.existed) {
      toast.error('未找到待终止项目，请刷新页面后重试');
      return;
    }
    const overlayKey = `${mutationKey}:${createConstructionClientMutationId()}`;
    const terminationChanges = {
      removedExpanded: expandedProjectIds.has(candidate.recordId),
      clearedSelected: selectedConstruction?.recordId === candidate.recordId,
      removedListItem: Boolean(
        constructionListDialog?.items.some(
          (item) => item.recordId === candidate.recordId,
        ),
      ),
      closedFollowup:
        followupOpen &&
        followupForm.constructionRecordId === candidate.recordId,
      clearedCandidate: true,
    };
    const uiContext = {
      selectedDetailStageKey,
      selectedDetailDailyOnly,
      listIdentity: getConstructionListDialogIdentity(constructionListDialog),
      listIndex:
        constructionListDialog?.items.findIndex(
          (item) => item.recordId === candidate.recordId,
        ) ?? -1,
      followup: {
        form: {
          ...followupForm,
          followupStaffMembers: followupForm.followupStaffMembers.map(
            (member) => ({ ...member }),
          ),
          workTypes: [...followupForm.workTypes],
          dailyCrewRecordIds: [...followupForm.dailyCrewRecordIds],
          completionChecklist: Object.fromEntries(
            Object.entries(followupForm.completionChecklist).map(
              ([key, item]) => [key, { ...item }],
            ),
          ) as CompletionChecklistFormState,
        },
        files: Object.fromEntries(
          Object.entries(followupFiles).map(([key, bucket]) => [
            key,
            [...bucket],
          ]),
        ) as FileBucket,
        removedExistingFileTokens: Object.fromEntries(
          Object.entries(removedExistingFileTokens).map(([key, tokens]) => [
            key,
            [...tokens],
          ]),
        ) as ExistingFileTokenMap,
        focus: dailyChecklistFocus,
      },
    };
    let terminationListAfterRemoval: ConstructionListDialogState | null = null;
    const restoreTerminationUiIfUntouched = () => {
      const latestTarget =
        dataRef.current?.items.find(
          (item) => item.recordId === candidate.recordId,
        ) || candidate;
      const currentList = constructionListDialogRef.current;
      const decisions = getTerminationUiRestoreDecisions({
        targetRecordId: candidate.recordId,
        changed: terminationChanges,
        originalListIdentity: uiContext.listIdentity,
        current: {
          expandedHasTarget: expandedProjectIdsRef.current.has(
            candidate.recordId,
          ),
          selectedRecordId: selectedConstructionRef.current?.recordId || null,
          listIdentity: getConstructionListDialogIdentity(currentList),
          listHasTarget: Boolean(
            currentList?.items.some(
              (item) => item.recordId === candidate.recordId,
            ),
          ),
          listOperationOwned:
            currentList !== null && currentList === terminationListAfterRemoval,
          followupOpen: followupOpenRef.current,
          followupPristine: isFollowupUiPristine(
            followupFormRef.current,
            followupFilesRef.current,
            removedExistingFileTokensRef.current,
            dailyChecklistFocusRef.current,
          ),
          candidateRecordId:
            projectTerminateCandidateRef.current?.recordId || null,
        },
      });
      if (decisions.restoreExpanded) {
        const next = new Set(expandedProjectIdsRef.current);
        next.add(candidate.recordId);
        expandedProjectIdsRef.current = next;
        setExpandedProjectIds(next);
      }
      if (decisions.restoreSelected) {
        selectedConstructionRef.current = latestTarget;
        selectedDetailStageKeyRef.current = uiContext.selectedDetailStageKey;
        selectedDetailDailyOnlyRef.current = uiContext.selectedDetailDailyOnly;
        setSelectedConstruction(latestTarget);
        setSelectedDetailStageKey(uiContext.selectedDetailStageKey);
        setSelectedDetailDailyOnly(uiContext.selectedDetailDailyOnly);
      }
      if (decisions.restoreListItem && currentList) {
        const items = [...currentList.items];
        items.splice(
          Math.min(Math.max(uiContext.listIndex, 0), items.length),
          0,
          latestTarget,
        );
        const restoredList = { ...currentList, items };
        constructionListDialogRef.current = restoredList;
        setConstructionListDialog(restoredList);
      }
      if (decisions.restoreFollowup) {
        followupOpenRef.current = true;
        followupFormRef.current = uiContext.followup.form;
        followupFilesRef.current = uiContext.followup.files;
        removedExistingFileTokensRef.current =
          uiContext.followup.removedExistingFileTokens;
        dailyChecklistFocusRef.current = uiContext.followup.focus;
        setFollowupForm(uiContext.followup.form);
        setFollowupFiles(uiContext.followup.files);
        setRemovedExistingFileTokens(
          uiContext.followup.removedExistingFileTokens,
        );
        setDailyChecklistFocus(uiContext.followup.focus);
        setFollowupOpen(true);
      }
      if (decisions.restoreCandidate) {
        projectTerminateCandidateRef.current = latestTarget;
        setProjectTerminateCandidate(latestTarget);
      }
    };
    const constructionMutationCoordinator =
      constructionMutationCoordinatorRef.current;
    inFlightMutationKeysRef.current.add(mutationKey);
    if (
      !constructionMutationCoordinator.begin({
        key: overlayKey,
        apply: (value) =>
          applyOptimisticProjectPatch(value, getOptimisticPatch()),
        matches: (value) =>
          requestAccepted &&
          isProjectPatchConfirmed(value, getOptimisticPatch()),
      })
    ) {
      inFlightMutationKeysRef.current.delete(mutationKey);
      toast.info('该项目正在终止同步，请勿重复提交');
      return;
    }

    updateConstructionData((value) =>
      value ? applyOptimisticProjectPatch(value, getOptimisticPatch()) : value,
    );
    if (terminationChanges.removedExpanded) {
      const next = new Set(expandedProjectIds);
      next.delete(candidate.recordId);
      expandedProjectIdsRef.current = next;
      setExpandedProjectIds(next);
    }
    if (terminationChanges.removedListItem && constructionListDialog) {
      const nextList = {
        ...constructionListDialog,
        items: constructionListDialog.items.filter(
          (item) => item.recordId !== candidate.recordId,
        ),
      };
      terminationListAfterRemoval = nextList;
      constructionListDialogRef.current = nextList;
      setConstructionListDialog(nextList);
    }
    if (terminationChanges.clearedSelected) {
      selectedConstructionRef.current = null;
      selectedDetailStageKeyRef.current = null;
      selectedDetailDailyOnlyRef.current = false;
      setSelectedConstruction(null);
      setSelectedDetailStageKey(null);
      setSelectedDetailDailyOnly(false);
    }
    if (terminationChanges.closedFollowup) {
      followupOpenRef.current = false;
      followupFormRef.current = initialFollowupForm;
      followupFilesRef.current = {};
      removedExistingFileTokensRef.current = {};
      dailyChecklistFocusRef.current = null;
      setFollowupOpen(false);
      setFollowupForm(initialFollowupForm);
      setFollowupFiles({});
      setRemovedExistingFileTokens({});
      setDailyChecklistFocus(null);
    }
    projectTerminateCandidateRef.current = null;
    setProjectTerminateCandidate(null);
    toast.success('页面已更新，多维表同步中');

    let serverWriteAccepted = false;
    const terminateRequest = terminateConstructionProject({
      recordId: candidate.recordId,
      constructionCode: candidate.constructionCode,
    });
    void terminateRequest
      .then(
        (result) => {
          serverWriteAccepted = true;
          acceptedWorkflow = result.workflow?.trim() || acceptedWorkflow;
          requestAccepted = true;
          let confirmationScheduled = false;
          try {
            if (!mountedRef.current) {
              return;
            }
            updateConstructionData((value) =>
              value
                ? applyOptimisticProjectPatch(value, getOptimisticPatch())
                : value,
            );
            scheduleOptimisticConfirmationTimeout(overlayKey);
            confirmationScheduled = true;
            void loadData({
              background: true,
              forceRefresh: false,
            }).catch((err) => {
              if (mountedRef.current) {
                toast.error(
                  getErrorMessage(err, '多维表已同步，但页面数据刷新失败'),
                );
              }
            });
            toast.success(result.message || '项目已终止');
          } catch (err) {
            if (mountedRef.current) {
              toast.error(
                getErrorMessage(err, '服务器已保存，页面正在重新同步'),
              );
            }
          } finally {
            settleAcceptedOptimisticMutation({
              confirmationScheduled,
              releaseGate: () =>
                inFlightMutationKeysRef.current.delete(mutationKey),
              finishOverlay: () =>
                constructionMutationCoordinator.finish(overlayKey),
              requestBackgroundRefresh: () => {
                if (!mountedRef.current) {
                  return;
                }
                rebaseVisibleConstructionData();
                restoreTerminationUiIfUntouched();
                void loadData({
                  background: true,
                  forceRefresh: false,
                }).catch((err) => {
                  if (mountedRef.current) {
                    toast.error(
                      getErrorMessage(err, '项目已终止，但页面数据刷新失败'),
                    );
                  }
                });
              },
              notifyResync: () => {
                if (mountedRef.current) {
                  toast.error('服务器已保存，页面正在重新同步');
                }
              },
            });
          }
        },
        (err) => {
          inFlightMutationKeysRef.current.delete(mutationKey);
          clearOptimisticConfirmationTimer(overlayKey);
          constructionMutationCoordinator.finish(overlayKey);
          if (!mountedRef.current) {
            return;
          }
          rebaseVisibleConstructionData();
          restoreTerminationUiIfUntouched();
          toast.error(
            `${getErrorMessage(err, '施工项目终止失败')}；同步失败，已恢复原状态`,
          );
        },
      )
      .catch((err) => {
        if (!mountedRef.current) {
          return;
        }
        toast.error(
          getErrorMessage(
            err,
            serverWriteAccepted
              ? '多维表已同步，但页面后处理失败'
              : '同步失败后的页面恢复处理异常',
          ),
        );
      });
  };

  const openCrewRosterUploadDialog = useCallback(
    (item: ConstructionOverviewItem) => {
      if (!requireConstructionEdit('更新人员名单')) {
        return;
      }
      if (isOptimisticConstructionRecordId(item.recordId)) {
        toast.info('项目正在同步到多维表，完成后才能更新人员名单');
        return;
      }
      if (!item.constructionCode) {
        toast.error('该项目缺少施工编码，无法更新人员名单');
        return;
      }
      if (crewRosterSyncingRecordIdsRef.current.has(item.recordId)) {
        toast.info('该项目人员名单正在后台更新，请勿重复提交');
        return;
      }
      const failedDraftIndex =
        failedCrewRosterUploadDraftsRef.current.findIndex(
          (draft) => draft.item.recordId === item.recordId,
        );
      const failedDraft =
        failedDraftIndex >= 0
          ? failedCrewRosterUploadDraftsRef.current[failedDraftIndex]
          : null;
      if (failedDraftIndex >= 0) {
        failedCrewRosterUploadDraftsRef.current =
          failedCrewRosterUploadDraftsRef.current.filter(
            (_, index) => index !== failedDraftIndex,
          );
      }
      const crewRosterUploadSessionId =
        ++crewRosterUploadSessionSequenceRef.current;
      activeCrewRosterUploadSessionIdRef.current = crewRosterUploadSessionId;
      const defaultAuthorizationRange = getCurrentWeekDateInputRange();
      setCrewRosterUploadTarget(failedDraft?.item || item);
      setCrewRosterUploadFiles(failedDraft?.files || {});
      setCrewRosterAuthorizationStartDate(
        failedDraft?.authorizationStartDate ||
          defaultAuthorizationRange.startDate,
      );
      setCrewRosterAuthorizationEndDate(
        failedDraft?.authorizationEndDate || defaultAuthorizationRange.endDate,
      );
    },
    [requireConstructionEdit],
  );

  const closeCrewRosterUploadDialog = () => {
    activeCrewRosterUploadSessionIdRef.current = null;
    const defaultAuthorizationRange = getCurrentWeekDateInputRange();
    setCrewRosterUploadTarget(null);
    setCrewRosterUploadFiles({});
    setCrewRosterAuthorizationStartDate(defaultAuthorizationRange.startDate);
    setCrewRosterAuthorizationEndDate(defaultAuthorizationRange.endDate);
  };

  const restoreCrewRosterUploadDraftIfUntouched = (
    submittedDraft: CrewRosterUploadDraft,
  ) => {
    if (activeCrewRosterUploadSessionIdRef.current !== null) {
      failedCrewRosterUploadDraftsRef.current = [
        ...failedCrewRosterUploadDraftsRef.current.filter(
          (draft) =>
            !(
              draft.sessionId === submittedDraft.sessionId &&
              draft.item.recordId === submittedDraft.item.recordId
            ),
        ),
        submittedDraft,
      ].slice(-5);
      return;
    }
    const recoverySessionId = ++crewRosterUploadSessionSequenceRef.current;
    activeCrewRosterUploadSessionIdRef.current = recoverySessionId;
    setCrewRosterUploadTarget(submittedDraft.item);
    setCrewRosterUploadFiles(submittedDraft.files);
    setCrewRosterAuthorizationStartDate(submittedDraft.authorizationStartDate);
    setCrewRosterAuthorizationEndDate(submittedDraft.authorizationEndDate);
  };

  const monitorCrewRosterUploadTask = useCallback(
    async (
      taskId: string,
      fallbackAuthorizationRange: { startDate: string; endDate: string },
      callbacks: ConstructionBackgroundTaskCallbacks,
    ) => {
      let consecutiveErrors = 0;
      let lastStatusMessage = '人员名单后台状态暂不可确认';
      for (
        let attempt = 0;
        attempt < CREW_ROSTER_TASK_MAX_POLLS;
        attempt += 1
      ) {
        if (!mountedRef.current) {
          return;
        }
        try {
          const taskStatus = await getSyncTaskStatus(taskId);
          const task = taskStatus.task;
          if (!taskStatus.success || !task) {
            throw new Error(taskStatus.message || '人员名单后台任务不存在');
          }
          consecutiveErrors = 0;
          if (task.status === 'completed') {
            const result = getCrewRosterUploadTaskResult(task.result);
            const message = result
              ? formatCrewRosterUploadResultMessage(
                  result,
                  fallbackAuthorizationRange,
                )
              : task.message || '人员名单后台更新完成';
            await loadData({ background: true, forceRefresh: false });
            if (mountedRef.current) {
              callbacks.onCompleted(message);
            }
            return;
          }
          if (task.status === 'failed') {
            callbacks.onFailed(task.message || '人员名单后台更新失败');
            return;
          }
        } catch (err) {
          consecutiveErrors += 1;
          lastStatusMessage = getErrorMessage(err, '人员名单后台任务查询失败');
          if (
            consecutiveErrors >= CONSTRUCTION_TASK_STATUS_MAX_CONSECUTIVE_ERRORS
          ) {
            callbacks.onUnknown(lastStatusMessage);
            return;
          }
          await new Promise((resolve) =>
            window.setTimeout(resolve, CREW_ROSTER_TASK_POLL_INTERVAL_MS),
          );
          continue;
        }

        await new Promise((resolve) =>
          window.setTimeout(resolve, CREW_ROSTER_TASK_POLL_INTERVAL_MS),
        );
      }
      callbacks.onUnknown(lastStatusMessage);
    },
    [loadData],
  );

  const handleSubmitCrewRosterUpload = () => {
    if (!requireConstructionEdit('提交人员名单更新')) {
      return;
    }
    const item = crewRosterUploadTarget;
    if (!item) {
      return;
    }
    if (!item.constructionCode) {
      toast.error('该项目缺少施工编码，无法更新人员名单');
      return;
    }
    const selectedFiles = crewRosterUploadFiles.crewRosterFiles || [];
    if (selectedFiles.length === 0) {
      toast.error('请上传施工人员名单文件');
      return;
    }
    if (!crewRosterAuthorizationStartDate || !crewRosterAuthorizationEndDate) {
      toast.error('请选择授权有效期');
      return;
    }
    if (crewRosterAuthorizationStartDate > crewRosterAuthorizationEndDate) {
      toast.error('授权开始日期不能晚于结束日期');
      return;
    }
    const mutationKey = `crew-roster:upload:${item.recordId}`;
    if (inFlightMutationKeysRef.current.has(mutationKey)) {
      toast.info('该项目人员名单正在后台更新，请勿重复提交');
      return;
    }
    const submittedDraft: CrewRosterUploadDraft = {
      sessionId:
        activeCrewRosterUploadSessionIdRef.current ||
        ++crewRosterUploadSessionSequenceRef.current,
      item,
      files: Object.fromEntries(
        Object.entries(crewRosterUploadFiles).map(([key, files]) => [
          key,
          [...files],
        ]),
      ) as FileBucket,
      authorizationStartDate: crewRosterAuthorizationStartDate,
      authorizationEndDate: crewRosterAuthorizationEndDate,
    };

    const formData = new FormData();
    appendOptionalField(formData, 'recordId', item.recordId);
    appendOptionalField(formData, 'constructionCode', item.constructionCode);
    appendOptionalField(
      formData,
      'authorizationStartDate',
      crewRosterAuthorizationStartDate,
    );
    appendOptionalField(
      formData,
      'authorizationEndDate',
      crewRosterAuthorizationEndDate,
    );
    appendFileBuckets(formData, {
      crewRosterFiles: selectedFiles,
    });

    inFlightMutationKeysRef.current.add(mutationKey);
    crewRosterSyncingRecordIdsRef.current.add(item.recordId);
    setCrewRosterRecordSyncing(item.recordId, true);
    closeCrewRosterUploadDialog();
    let serverWriteAccepted = false;
    const finishCrewRosterSync = () => {
      inFlightMutationKeysRef.current.delete(mutationKey);
      crewRosterSyncingRecordIdsRef.current.delete(item.recordId);
      setCrewRosterRecordSyncing(item.recordId, false);
    };
    const rollbackCrewRosterSync = (message: string) => {
      finishCrewRosterSync();
      if (!mountedRef.current) {
        return;
      }
      restoreCrewRosterUploadDraftIfUntouched(submittedDraft);
      toast.error(`${message}；已恢复本次上传内容`);
    };
    const leaveCrewRosterSyncUnknown = (message: string) => {
      finishCrewRosterSync();
      if (!mountedRef.current) {
        return;
      }
      void loadData({
        background: true,
        forceRefresh: false,
      }).catch((err) => {
        if (mountedRef.current) {
          toast.warning(getErrorMessage(err, '人员名单页面状态刷新失败'));
        }
      });
      toast.warning(`${message}，已停止等待，请稍后刷新确认`);
    };
    const completeCrewRosterSync = (message: string) => {
      finishCrewRosterSync();
      if (mountedRef.current) {
        toast.success(message);
      }
    };

    void syncConstructionCrewRosterFromUpload(formData)
      .then(
        (result) => {
          serverWriteAccepted = true;
          if (!mountedRef.current) {
            finishCrewRosterSync();
            return;
          }
          toast.success('人员名单已提交后台更新，完成后自动提示结果');
          if (result.taskId) {
            void monitorCrewRosterUploadTask(
              result.taskId,
              {
                startDate: submittedDraft.authorizationStartDate,
                endDate: submittedDraft.authorizationEndDate,
              },
              {
                onCompleted: completeCrewRosterSync,
                onFailed: rollbackCrewRosterSync,
                onUnknown: leaveCrewRosterSyncUnknown,
              },
            ).catch((err) =>
              leaveCrewRosterSyncUnknown(
                getErrorMessage(err, '人员名单已受理，但页面任务监控异常'),
              ),
            );
            return;
          }
          if (result.pending) {
            leaveCrewRosterSyncUnknown(
              result.message || '人员名单已受理，但未返回后台任务编号',
            );
            return;
          }
          void loadData({
            background: true,
            forceRefresh: false,
          })
            .then(() =>
              completeCrewRosterSync(
                formatCrewRosterUploadResultMessage(result, {
                  startDate: submittedDraft.authorizationStartDate,
                  endDate: submittedDraft.authorizationEndDate,
                }),
              ),
            )
            .catch((err) =>
              leaveCrewRosterSyncUnknown(
                getErrorMessage(err, '人员名单已同步，但页面状态刷新失败'),
              ),
            );
        },
        (err) =>
          rollbackCrewRosterSync(getErrorMessage(err, '施工人员名单更新失败')),
      )
      .catch((err) => {
        const message = getErrorMessage(
          err,
          serverWriteAccepted
            ? '人员名单已受理，但页面后处理失败'
            : '施工人员名单更新失败',
        );
        if (serverWriteAccepted) {
          leaveCrewRosterSyncUnknown(message);
        } else {
          rollbackCrewRosterSync(message);
        }
      });
  };

  if (loading) {
    return (
      <main className="min-h-full bg-[#F2F5FA] p-4 text-foreground">
        <div className="mx-auto flex min-h-[360px] max-w-5xl items-center justify-center rounded-lg border border-[#dce7f6] bg-white shadow-[0_14px_38px_rgba(0,91,255,0.08)]">
          <div className="flex items-center gap-2 text-sm font-medium text-[#005BFF]">
            <Loader2 className="h-4 w-4 animate-spin" />
            加载南通全景平台-施工管理数据
          </div>
        </div>
      </main>
    );
  }

  const summary = data?.summary;
  const latestUpdatedLabel =
    formatDateTime(summary?.latestUpdatedAt || data?.generatedAt) ||
    '暂无同步时间';

  return (
    <main className="min-h-full overflow-hidden bg-[linear-gradient(180deg,#eef4ff_0%,#f8fbff_48%,#eef5ff_100%)] text-foreground">
      <section className="relative overflow-hidden bg-[linear-gradient(180deg,#064fc5_0%,#00359b_54%,#012a7d_100%)] text-white shadow-[0_18px_42px_rgba(0,47,135,0.28)]">
        <div className="pointer-events-none absolute inset-0 opacity-70 [background-image:radial-gradient(circle_at_68%_70%,rgba(0,220,255,0.42),transparent_18%),linear-gradient(120deg,rgba(255,255,255,0.08)_0_1px,transparent_1px_120px)]" />
        <div className="pointer-events-none absolute bottom-0 right-[12%] h-24 w-[34rem] bg-[linear-gradient(180deg,rgba(0,214,255,0.48),rgba(0,214,255,0))] blur-2xl" />
        <div className="pointer-events-none absolute bottom-0 right-[18%] hidden h-28 w-[28rem] opacity-50 [background-image:linear-gradient(90deg,rgba(125,211,252,0.2)_1px,transparent_1px),linear-gradient(0deg,rgba(125,211,252,0.18)_1px,transparent_1px)] [background-size:28px_28px] xl:block" />
        <div className="relative mx-auto flex w-full max-w-[1800px] flex-col gap-4 px-4 py-4 md:px-8 xl:flex-row xl:items-center xl:justify-between">
          <div className="flex min-w-0 flex-col gap-3 md:flex-row md:items-center">
            <div className="flex shrink-0 items-center gap-4">
              <div
                className="inline-flex h-14 w-36 items-center md:h-16 md:w-40"
                role="img"
                aria-label="世纪互联 VNET"
              >
                <span
                  aria-hidden="true"
                  className="block h-11 w-36 bg-white drop-shadow-[0_3px_12px_rgba(0,0,0,0.28)] md:h-[3.25rem] md:w-40"
                  style={{
                    WebkitMask: `url(${VNET_OFFICIAL_LOGO_URL}) center / contain no-repeat`,
                    mask: `url(${VNET_OFFICIAL_LOGO_URL}) center / contain no-repeat`,
                  }}
                />
              </div>
              <div className="hidden h-16 w-px self-center bg-white/28 md:block" />
            </div>
            <div className="min-w-0">
              <h1 className="truncate text-2xl font-semibold tracking-tight md:text-3xl">
                南通全景平台 · 施工管理
              </h1>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <span className="inline-flex items-center gap-1.5 rounded-full border border-cyan-300/30 bg-cyan-400/[0.18] px-3 py-1 text-xs font-semibold text-cyan-50 shadow-[inset_0_1px_0_rgba(255,255,255,0.28)] backdrop-blur-md">
                  <ShieldCheck className="h-3.5 w-3.5" />
                  全生命周期
                </span>
                <span className="inline-flex items-center gap-1.5 rounded-full border border-cyan-300/30 bg-cyan-400/[0.18] px-3 py-1 text-xs font-semibold text-cyan-50 shadow-[inset_0_1px_0_rgba(255,255,255,0.28)] backdrop-blur-md">
                  <HardHat className="h-3.5 w-3.5" />
                  施工现场
                </span>
                {constructionAiAuditEnabled && (
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-300/40 bg-emerald-400/[0.18] px-3 py-1 text-xs font-semibold text-emerald-50 shadow-[inset_0_1px_0_rgba(255,255,255,0.28)] backdrop-blur-md">
                    <Eye className="h-3.5 w-3.5" />
                    视觉审核 {data?.imageAuditStatus?.provider || 'Qwen'}
                  </span>
                )}
                <span className="inline-flex items-center gap-1.5 rounded-full border border-white/25 bg-white/[0.14] px-3 py-1 text-xs font-semibold text-blue-50 shadow-[inset_0_1px_0_rgba(255,255,255,0.22)] backdrop-blur-md">
                  <LockKeyhole className="h-3.5 w-3.5" />
                  {getAccessRoleLabel(role)}
                </span>
                {constructionAiAuditEnabled && (
                  <button
                    type="button"
                    className="inline-flex items-center gap-1.5 rounded-full border border-white/25 bg-white/[0.12] px-3 py-1 text-xs font-semibold text-blue-50 shadow-[inset_0_1px_0_rgba(255,255,255,0.22)] backdrop-blur-md transition hover:bg-white/[0.18] disabled:cursor-not-allowed disabled:opacity-60"
                    disabled={refreshing || !canForceRefreshConstruction}
                    onClick={() =>
                      void loadData(true).catch((err) => {
                        if (mountedRef.current) {
                          toast.error(
                            getErrorMessage(err, '施工管理视觉审核刷新失败'),
                          );
                        }
                      })
                    }
                    aria-label="补缺并刷新过期的施工管理视觉审核"
                  >
                    {refreshing ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <RefreshCw className="h-3.5 w-3.5" />
                    )}
                    补缺/刷新视觉审核
                  </button>
                )}
                <span className="text-xs font-medium text-blue-100/80">
                  更新 {latestUpdatedLabel}
                </span>
              </div>
            </div>
          </div>

          <div className="flex flex-col gap-3 xl:items-end">
            <div className="flex flex-wrap items-center gap-3">
              <Button
                type="button"
                className="h-11 rounded-lg bg-[#1e63ff] px-5 text-white shadow-[0_12px_28px_rgba(0,30,130,0.24)] hover:bg-[#1554df]"
                disabled={!canEditConstruction}
                onClick={handleOpenNewApplication}
              >
                <Plus className="h-4 w-4" />
                新建施工
              </Button>
              <Button
                type="button"
                variant="outline"
                className="h-11 rounded-lg border-white/20 bg-white px-5 text-slate-700 shadow-[0_10px_24px_rgba(0,24,84,0.18)] hover:bg-blue-50"
                onClick={handleFollowupDialogOpen}
                disabled={
                  !canEditConstruction || !visibleConstructionItems.length
                }
              >
                <FileUp className="h-4 w-4" />
                施工跟进
              </Button>
            </div>
          </div>
        </div>
      </section>

      <div className="mx-auto w-full max-w-[1800px] space-y-6 px-4 py-6 md:px-8">
        <MemoizedConstructionStatusOverview
          items={visibleConstructionItems}
          totalCount={summary?.total ?? visibleConstructionItems.length}
          constructionAiAuditEnabled={constructionAiAuditEnabled}
          onOpenGroup={handleStatusListOpen}
          onOpenAll={handleAllConstructionOpen}
        />

        <div className="grid gap-6 min-[84rem]:grid-cols-[minmax(0,1fr)_31rem] min-[84rem]:items-stretch">
          <div className="h-full space-y-5">
            <MemoizedDailyProgressBoard
              summaries={dailyProgressSummaries}
              dailyPermitReferenceDate={dailyPermitReferenceDate}
              constructionAiAuditEnabled={constructionAiAuditEnabled}
              onOpenStage={handleDailyProgressStageOpen}
            />
          </div>
          <MemoizedConstructionCalendar
            items={visibleConstructionItems}
            constructionAiAuditEnabled={constructionAiAuditEnabled}
            onSelectItem={openConstructionDetail}
          />
        </div>

        {error && (
          <div className="flex items-start gap-2 rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-sm text-red-700">
            <AlertCircle className="mt-0.5 h-4 w-4" />
            {error}
          </div>
        )}

        {data &&
          (!data.sectionStatus.overview.configured ||
            !data.sectionStatus.followups.configured) && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
              {[
                data.sectionStatus.overview.message,
                data.sectionStatus.followups.message,
              ]
                .filter(Boolean)
                .join('；')}
            </div>
          )}

        <section className="space-y-4">
          <div className="space-y-3">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <SectionHeader
                title="项目进行时"
                description="仅展示新建/审批中和施工进行中的项目，已闭环项目进入归档不在此处展示。"
              />
              {projectInProgressItems.length > 0 && (
                <div className="flex w-full flex-col gap-2 sm:w-auto sm:items-end">
                  <div className="relative w-full sm:w-80">
                    <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                    <Input
                      value={projectSearchQuery}
                      onChange={(event) =>
                        setProjectSearchQuery(event.target.value)
                      }
                      placeholder="搜索项目名称、编码、楼栋"
                      className="h-9 rounded-xl border-[#d8e5f7] bg-white/80 pl-9 pr-9 text-sm shadow-sm focus-visible:ring-[#005BFF]/20"
                    />
                    {projectSearchQuery.trim() && (
                      <button
                        type="button"
                        aria-label="清空项目搜索"
                        className="absolute right-2 top-1/2 inline-flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-full text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
                        onClick={() => setProjectSearchQuery('')}
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center justify-end gap-2">
                    <span className="rounded-full border border-[#d8e5f7] bg-white/75 px-3 py-1 text-xs font-semibold text-slate-500">
                      已展开 {expandedProjectCount}/
                      {filteredProjectInProgressItems.length}
                    </span>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="h-8 rounded-lg border-[#bdd2f4] bg-white/80 px-3 text-xs text-[#005BFF] hover:bg-blue-50"
                      onClick={handleExpandAllProjects}
                      disabled={filteredProjectInProgressItems.length === 0}
                    >
                      展开全部
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="h-8 rounded-lg border-slate-200 bg-white/80 px-3 text-xs text-slate-600 hover:bg-slate-50"
                      onClick={handleHideAllProjects}
                      disabled={filteredProjectInProgressItems.length === 0}
                    >
                      隐藏全部
                    </Button>
                  </div>
                </div>
              )}
            </div>
            {projectInProgressItems.length ? (
              filteredProjectInProgressItems.length === 0 ? (
                <EmptyPanel
                  title="未找到匹配项目"
                  description="换个项目名称、施工编码、楼栋、专业、施工方或作业类型再试。"
                />
              ) : allProjectsHidden ? (
                <div className="rounded-2xl border border-dashed border-[#cfe0ff] bg-white/65 px-6 py-8 text-center text-sm font-medium text-slate-500 shadow-[0_12px_30px_rgba(15,86,228,0.05)]">
                  已隐藏全部项目，点击“展开全部”恢复查看。
                </div>
              ) : (
                <div className="space-y-3">
                  {visibleProjectInProgressItems.map((item) => (
                    <MemoizedConstructionCard
                      key={item.recordId}
                      item={item}
                      expanded={expandedProjectIds.has(item.recordId)}
                      dailyPermitReferenceDate={dailyPermitReferenceDate}
                      constructionAiAuditEnabled={constructionAiAuditEnabled}
                      readOnly={!canEditConstruction}
                      onExpandedChange={handleProjectExpansionChange}
                      onSelect={openConstructionDetail}
                      onOpenDailyFollowup={handleDailyFollowupQuickOpen}
                      onOpenApplicationFollowup={
                        handleSupplementalFollowupQuickOpen
                      }
                      onRefreshDailyProgress={handleRefreshDailyProgress}
                      onRefreshApprovalStatus={handleRefreshApprovalStatus}
                      dailyProgressRefreshing={refreshing}
                      crewRosterSyncing={crewRosterSyncingRecordIds.has(
                        item.recordId,
                      )}
                      onSyncCrewRoster={openCrewRosterUploadDialog}
                      onDeleteRequest={
                        canDeleteConstruction
                          ? setProjectDeleteCandidate
                          : undefined
                      }
                      onTerminateRequest={handleProjectTerminateRequest}
                    />
                  ))}
                  {hiddenProjectCount > 0 && (
                    <div className="flex flex-col items-center justify-between gap-3 rounded-2xl border border-dashed border-[#cfe0ff] bg-white/70 px-5 py-4 text-sm text-slate-500 shadow-[0_12px_30px_rgba(15,86,228,0.05)] sm:flex-row">
                      <span className="font-medium">
                        已显示 {visibleProjectInProgressItems.length}/
                        {filteredProjectInProgressItems.length} 项
                      </span>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="h-8 rounded-lg border-[#bdd2f4] bg-white/90 px-3 text-xs text-[#005BFF] hover:bg-blue-50"
                        onClick={handleShowMoreProjects}
                      >
                        <ChevronDown className="h-4 w-4" />
                        显示更多
                      </Button>
                    </div>
                  )}
                </div>
              )
            ) : (
              <EmptyPanel
                title="暂无进行中的施工项目"
                description="新建、审批中或施工进行中的项目会显示在这里，已闭环项目不展示。"
              />
            )}
          </div>
        </section>
      </div>

      <DialogOpeningFeedback feedbackRef={followupOpeningFeedbackRef} />

      {applicationOpen && (
        <ApplicationDialog
          open
          submitting={submitting}
          sessionId={applicationSessionId}
          recoveryDraft={applicationRecoveryDraft}
          onOpenChange={setApplicationOpen}
          onSubmit={handleApplicationSubmit}
        />
      )}
      {followupOpen && (
        <FollowupDialog
          open
          submitting={submitting}
          items={visibleConstructionItems}
          imageAuditStatus={data?.imageAuditStatus}
          constructionAiAuditEnabled={constructionAiAuditEnabled}
          manualReviewAutoApproved={manualReviewAutoApproved}
          form={followupForm}
          dailyChecklistFocus={dailyChecklistFocus}
          files={followupFiles}
          removedExistingFileTokens={removedExistingFileTokens}
          permitUploadingKey={dailyPermitUploadingKey}
          manualReviewRefreshing={manualReviewRefreshing}
          dailyPermitReferenceDate={dailyPermitReferenceDate}
          pendingManualReviews={pendingManualReviews}
          pendingManualReviewCount={pendingManualReviews.length}
          allowAttachmentDelete={canDeleteConstruction}
          onOpenChange={(open) => {
            followupOpenRef.current = open;
            setFollowupOpen(open);
            if (!open) {
              activeFollowupSessionIdRef.current = null;
              setPendingManualReviews([]);
              setRemovedExistingFileTokens({});
              setDailyChecklistFocus(null);
            }
          }}
          onFormChange={setFollowupForm}
          onFilesChange={setFollowupFiles}
          onUpdateCrewAuthorization={openCrewRosterUploadDialog}
          onRemovedExistingFileTokensChange={setRemovedExistingFileTokens}
          onSubmit={() => handleFollowupSubmit()}
          onGeneratedFileSubmit={handleGeneratedOnlineFormSubmit}
          onAttachmentDeleteStart={registerAttachmentTombstone}
          onAttachmentDeleteFailure={revokeAttachmentTombstone}
          onAttachmentDeleted={() =>
            void loadData({
              background: true,
              forceRefresh: false,
            }).catch((err) => {
              if (mountedRef.current) {
                toast.error(
                  getErrorMessage(err, '附件已删除，但页面数据刷新失败'),
                );
              }
            })
          }
          onSubmitPendingManualReviews={handleSubmitPendingManualReviews}
          onPermitUpload={handleDailyPermitUpload}
          onRefreshPermitData={() =>
            handleRefreshConstructionBitableData('已同步多维表最新作业票数据')
          }
          onRefreshIsolationAuditData={() =>
            handleRefreshConstructionBitableData('已同步多维表挂牌审核状态')
          }
          onRequestManualReview={handlePermitManualReviewRequest}
          onRequestIsolationManualReview={
            handleIsolationPhotoManualReviewRequest
          }
        />
      )}
      {selectedConstruction && (
        <ConstructionDetailDialog
          item={selectedConstruction}
          initialStageKey={selectedDetailStageKey}
          initialDailyOnly={selectedDetailDailyOnly}
          dailyPermitReferenceDate={dailyPermitReferenceDate}
          constructionAiAuditEnabled={constructionAiAuditEnabled}
          onOpenChange={(open) => {
            if (!open) {
              selectedConstructionRef.current = null;
              selectedDetailStageKeyRef.current = null;
              selectedDetailDailyOnlyRef.current = false;
              setSelectedConstruction(null);
              setSelectedDetailStageKey(null);
              setSelectedDetailDailyOnly(false);
            }
          }}
        />
      )}
      {constructionListDialog && (
        <ConstructionListDialog
          state={constructionListDialog}
          dailyPermitReferenceDate={dailyPermitReferenceDate}
          constructionAiAuditEnabled={constructionAiAuditEnabled}
          onOpenChange={(open) => {
            if (!open) setConstructionListDialog(null);
          }}
          onSelect={handleListItemSelect}
          readOnly={!canEditConstruction}
        />
      )}
      {crewRosterUploadTarget && (
        <CrewRosterUploadDialog
          item={crewRosterUploadTarget}
          open
          files={crewRosterUploadFiles}
          authorizationStartDate={crewRosterAuthorizationStartDate}
          authorizationEndDate={crewRosterAuthorizationEndDate}
          submitting={crewRosterSyncingRecordIds.has(
            crewRosterUploadTarget.recordId,
          )}
          onFilesChange={setCrewRosterUploadFiles}
          onAuthorizationStartDateChange={setCrewRosterAuthorizationStartDate}
          onAuthorizationEndDateChange={setCrewRosterAuthorizationEndDate}
          onSubmit={handleSubmitCrewRosterUpload}
          onOpenChange={(open) => {
            if (!open) {
              closeCrewRosterUploadDialog();
            }
          }}
        />
      )}
      {projectTerminateCandidate && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) {
              projectTerminateCandidateRef.current = null;
              setProjectTerminateCandidate(null);
            }
          }}
        >
          <DialogContent className="w-[calc(100vw-2rem)] max-w-md rounded-2xl border-amber-200 bg-white p-0 shadow-[0_24px_70px_rgba(146,64,14,0.16)]">
            <DialogHeader className="border-b border-amber-100 px-5 py-4">
              <DialogTitle className="flex items-center gap-2 text-base text-slate-950">
                <AlertCircle className="h-4 w-4 text-amber-600" />
                确认终止施工项目
              </DialogTitle>
              <DialogDescription>
                终止后项目流程将标记为“已终止”，保留总览、跟进和人员台账记录。
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 px-5 py-4 text-sm text-slate-600">
              <div className="rounded-lg border border-amber-100 bg-amber-50/70 px-3 py-2 text-amber-900">
                {projectTerminateCandidate?.workContent || '当前项目'}
                {projectTerminateCandidate?.constructionCode
                  ? `（${projectTerminateCandidate.constructionCode}）`
                  : ''}
              </div>
              <div className="rounded-lg border border-blue-100 bg-blue-50 px-3 py-2 text-xs leading-5 text-blue-800">
                系统会先校验施工编码，确认页面项目与多维表记录一致后再终止。
              </div>
            </div>
            <DialogFooter className="border-t border-slate-100 bg-slate-50 px-5 py-4">
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setProjectTerminateCandidate(null);
                }}
              >
                取消
              </Button>
              <Button
                type="button"
                className="bg-amber-600 text-white hover:bg-amber-700"
                onClick={handleConfirmTerminateProject}
              >
                <AlertCircle className="h-4 w-4" />
                确认终止
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
      {projectDeleteCandidate && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) {
              projectDeleteCandidateRef.current = null;
              setProjectDeleteCandidate(null);
            }
          }}
        >
          <DialogContent className="w-[calc(100vw-2rem)] max-w-md rounded-2xl border-[#f7c7c7] bg-white p-0 shadow-[0_24px_70px_rgba(127,29,29,0.18)]">
            <DialogHeader className="border-b border-rose-100 px-5 py-4">
              <DialogTitle className="flex items-center gap-2 text-base text-slate-950">
                <Trash2 className="h-4 w-4 text-rose-600" />
                确认删除施工项目
              </DialogTitle>
              <DialogDescription>
                将后台删除施工总览、施工跟进、施工人员台账中与该项目施工编码精确匹配的记录，并删除对应项目视图。
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 px-5 py-4 text-sm text-slate-600">
              <div className="rounded-lg border border-rose-100 bg-rose-50/70 px-3 py-2 text-rose-800">
                {projectDeleteCandidate?.workContent || '当前项目'}
                {projectDeleteCandidate?.constructionCode
                  ? `（${projectDeleteCandidate.constructionCode}）`
                  : ''}
              </div>
              <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800">
                确认后页面会立即移除项目，后台同步删除多维表；若后台明确失败，页面会自动恢复。
              </div>
            </div>
            <DialogFooter className="border-t border-slate-100 bg-slate-50 px-5 py-4">
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  projectDeleteCandidateRef.current = null;
                  setProjectDeleteCandidate(null);
                }}
              >
                取消
              </Button>
              <Button
                type="button"
                className="bg-rose-600 text-white hover:bg-rose-700"
                onClick={handleConfirmDeleteProject}
              >
                <Trash2 className="h-4 w-4" />
                立即移除并后台删除
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </main>
  );
}

function CrewRosterUploadDialog({
  item,
  open,
  files,
  authorizationStartDate,
  authorizationEndDate,
  submitting,
  onFilesChange,
  onAuthorizationStartDateChange,
  onAuthorizationEndDateChange,
  onSubmit,
  onOpenChange,
}: {
  item: ConstructionOverviewItem | null;
  open: boolean;
  files: FileBucket;
  authorizationStartDate: string;
  authorizationEndDate: string;
  submitting: boolean;
  onFilesChange: React.Dispatch<React.SetStateAction<FileBucket>>;
  onAuthorizationStartDateChange: (value: string) => void;
  onAuthorizationEndDateChange: (value: string) => void;
  onSubmit: () => void;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[82vh] w-[calc(100vw-2rem)] max-w-2xl flex-col overflow-hidden rounded-2xl border-emerald-100 bg-white p-0 shadow-[0_24px_70px_rgba(6,95,70,0.16)]">
        <DialogHeader className="border-b border-emerald-100 px-5 py-4">
          <DialogTitle className="flex items-center gap-2 text-base text-slate-950">
            <UserCheck className="h-4 w-4 text-emerald-600" />
            更新人员名单
          </DialogTitle>
        </DialogHeader>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
          <div className="rounded-lg border border-emerald-100 bg-emerald-50/70 px-3 py-2 text-sm font-semibold text-emerald-900">
            {item?.workContent || '当前项目'}
            {item?.constructionCode ? `（${item.constructionCode}）` : ''}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="授权开始日期" required>
              <Input
                type="date"
                value={authorizationStartDate}
                disabled={submitting}
                onChange={(event) =>
                  onAuthorizationStartDateChange(event.target.value)
                }
                className="h-10 rounded-lg border-emerald-100 focus-visible:ring-emerald-200"
              />
            </Field>
            <Field label="授权结束日期" required>
              <Input
                type="date"
                value={authorizationEndDate}
                disabled={submitting}
                onChange={(event) =>
                  onAuthorizationEndDateChange(event.target.value)
                }
                className="h-10 rounded-lg border-emerald-100 focus-visible:ring-emerald-200"
              />
            </Field>
          </div>
          <MemoizedFilePickerField
            fieldKey="crewRosterFiles"
            label="施工人员名单"
            required
            selectedFiles={files.crewRosterFiles || []}
            uploadedFiles={[]}
            onFilesChange={onFilesChange}
          />
        </div>
        <DialogFooter className="border-t border-slate-100 bg-slate-50 px-5 py-4">
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
            className="bg-emerald-600 text-white hover:bg-emerald-700"
            disabled={submitting}
            onClick={onSubmit}
          >
            {submitting ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                更新中
              </>
            ) : (
              <>
                <FileUp className="h-4 w-4" />
                更新台账
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DailyProgressBoard({
  summaries,
  dailyPermitReferenceDate,
  constructionAiAuditEnabled,
  onOpenStage,
}: {
  summaries: DailyProgressStageSummary[];
  dailyPermitReferenceDate: Date;
  constructionAiAuditEnabled: boolean;
  onOpenStage: (stage: DailyProgressStageSummary) => void;
}) {
  const activeTotal = summaries.reduce(
    (total, stage) => total + stage.total,
    0,
  );

  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden rounded-2xl border border-white/80 bg-white/[0.92] p-5 shadow-[0_18px_44px_rgba(35,78,150,0.10)] ring-1 ring-white/70">
      <div className="construction-daily-skyline pointer-events-none absolute inset-x-0 bottom-0 h-24 opacity-80" />
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <span className="inline-flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-[linear-gradient(135deg,#58a2ff,#1e63ff)] text-white shadow-[0_10px_22px_rgba(30,99,255,0.20)]">
              <BarChart3 className="h-4 w-4" />
            </span>
            <h2 className="flex items-center gap-1.5 text-lg font-semibold text-slate-950">
              每日施工进展
              <InfoHint text="只统计当前进行中的施工项目；按施工跟进表的施工准备、施工过程中、每日收尾字段判断当天留痕是否完成。" />
            </h2>
          </div>
          <button
            type="button"
            className="hidden items-center gap-1 text-sm font-semibold text-[#1e63ff] transition hover:text-[#164fc8] sm:inline-flex"
            onClick={() => summaries[1] && onOpenStage(summaries[1])}
          >
            进行中施工 {activeTotal} 项
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
        <div className="grid min-h-0 flex-1 items-stretch gap-4 lg:grid-cols-3">
          {summaries.map((stage, index) => (
            <div key={stage.key} className="relative h-full min-h-0 min-w-0">
              <DailyProgressStageCard
                stage={stage}
                index={index}
                dailyPermitReferenceDate={dailyPermitReferenceDate}
                constructionAiAuditEnabled={constructionAiAuditEnabled}
                onOpen={() => onOpenStage(stage)}
              />
              {index < summaries.length - 1 && (
                <span className="pointer-events-none absolute -right-5 top-[calc(50%-0.875rem)] z-20 hidden h-7 w-7 items-center justify-center text-[#7aa8ff] lg:flex">
                  <ChevronRight className="h-6 w-6 stroke-[3]" />
                </span>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

const MemoizedDailyProgressBoard = React.memo(DailyProgressBoard);

function ConstructionCalendar({
  items,
  constructionAiAuditEnabled,
  onSelectItem,
}: {
  items: ConstructionOverviewItem[];
  constructionAiAuditEnabled: boolean;
  onSelectItem: (item: ConstructionOverviewItem) => void;
}) {
  const initialMonth = useMemo(() => getInitialCalendarMonth(items), [items]);
  const [visibleMonth, setVisibleMonth] = useState(initialMonth);
  const [selectedDay, setSelectedDay] = useState<CalendarDayView | null>(null);

  useEffect(() => {
    setVisibleMonth(initialMonth);
  }, [initialMonth]);

  const calendarDays = useMemo(
    () => buildCalendarDays(visibleMonth, items),
    [visibleMonth, items],
  );
  const monthItems = useMemo(() => {
    const monthStart = startOfMonth(visibleMonth);
    const monthEnd = endOfMonth(visibleMonth);
    return items.filter((item) => isItemInRange(item, monthStart, monthEnd));
  }, [items, visibleMonth]);
  const scheduledDays = calendarDays.filter(
    (day) => day.inMonth && day.items.length > 0,
  ).length;
  const activeAttentionDays = calendarDays.filter(
    (day) =>
      day.inMonth &&
      day.items.some((item) =>
        getLifecycleStages(item, day.date, constructionAiAuditEnabled).some(
          (stage) => stage.status === 'blocked',
        ),
      ),
  ).length;
  const selectedDayDetail = useMemo(
    () =>
      selectedDay
        ? buildCalendarDayDetailFromView(
            selectedDay,
            constructionAiAuditEnabled,
          )
        : null,
    [constructionAiAuditEnabled, selectedDay],
  );

  return (
    <>
      <aside className="flex h-full flex-col overflow-hidden rounded-2xl border border-white/80 bg-white/[0.92] p-4 shadow-[0_18px_44px_rgba(35,78,150,0.10)] ring-1 ring-white/70">
        <div>
          <div className="flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <span className="inline-flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-[linear-gradient(135deg,#58a2ff,#1e63ff)] text-white shadow-[0_10px_22px_rgba(30,99,255,0.20)] ring-1 ring-[#005BFF]/20">
                <CalendarCheck className="h-4 w-4" />
              </span>
              <div className="min-w-0">
                <h2 className="flex items-center gap-1.5 text-base font-semibold text-slate-950">
                  施工日历
                  <InfoHint text="按计划开始和结束时间展示施工排期密度；点击日期可查看当天施工项目和需跟进事项。" />
                </h2>
                <div className="mt-0.5 text-sm font-semibold text-slate-900">
                  {formatMonthLabel(visibleMonth)}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-1">
              <Button
                type="button"
                variant="outline"
                className="h-8 w-8 rounded-lg border-[#d8e5f7] bg-white/80 p-0 text-slate-700 shadow-sm hover:border-[#005BFF]/20 hover:bg-[#F2F5FA]"
                onClick={() =>
                  setVisibleMonth((current) => addMonths(current, -1))
                }
                aria-label="上个月"
              >
                <ChevronLeft className="h-3.5 w-3.5" />
              </Button>
              <Button
                type="button"
                variant="outline"
                className="h-8 w-8 rounded-lg border-[#d8e5f7] bg-white/80 p-0 text-slate-700 shadow-sm hover:border-[#005BFF]/20 hover:bg-[#F2F5FA]"
                onClick={() =>
                  setVisibleMonth((current) => addMonths(current, 1))
                }
                aria-label="下个月"
              >
                <ChevronRight className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>

          <div className="mt-2 grid grid-cols-3 gap-2">
            <CalendarStat
              label="本月项目"
              value={`${monthItems.length}项`}
              tone="blue"
              icon={Briefcase}
            />
            <CalendarStat
              label="施工日"
              value={`${scheduledDays}天`}
              tone="emerald"
              icon={CalendarCheck}
            />
            <CalendarStat
              label="需跟进日"
              value={`${activeAttentionDays}天`}
              tone="rose"
              icon={Bell}
            />
          </div>
        </div>

        <div className="mt-2 overflow-hidden rounded-xl border border-[#e2ebf7] bg-white/75">
          <div className="grid grid-cols-7 border-b border-[#e5edf8] bg-[#F8FBFF] px-1.5 py-1 text-center text-xs font-semibold text-slate-500">
            {['一', '二', '三', '四', '五', '六', '日'].map((day) => (
              <div key={day}>{day}</div>
            ))}
          </div>
          <div className="grid grid-cols-7 gap-1 p-1.5">
            {calendarDays.map((day) => (
              <CalendarDayCell
                key={day.key}
                day={day}
                constructionAiAuditEnabled={constructionAiAuditEnabled}
                onOpen={() => setSelectedDay(day)}
              />
            ))}
          </div>
        </div>
        <div className="mt-auto flex items-center justify-between gap-2 px-1 pt-2 text-xs font-medium text-slate-500">
          <span className="inline-flex items-center gap-1">
            <span className="h-2.5 w-2.5 rounded-full bg-[#1e63ff]" />
            有施工
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="h-2.5 w-2.5 rounded-full bg-rose-500" />
            需跟进
          </span>
        </div>
      </aside>
      <CalendarDayDetailDialog
        detail={selectedDayDetail}
        onOpenChange={(open) => {
          if (!open) {
            setSelectedDay(null);
          }
        }}
        onSelectItem={(recordId) => {
          const item = selectedDay?.items.find(
            (candidate) => candidate.recordId === recordId,
          );
          if (item) {
            setSelectedDay(null);
            onSelectItem(item);
          }
        }}
      />
    </>
  );
}

const MemoizedConstructionCalendar = React.memo(ConstructionCalendar);

function ConstructionStatusOverview({
  items,
  totalCount,
  constructionAiAuditEnabled,
  onOpenGroup,
  onOpenAll,
}: {
  items: ConstructionOverviewItem[];
  totalCount: number;
  constructionAiAuditEnabled: boolean;
  onOpenGroup: (group: ConstructionStatusGroup) => void;
  onOpenAll: () => void;
}) {
  const groups = useMemo(
    () => buildConstructionStatusGroups(items, constructionAiAuditEnabled),
    [constructionAiAuditEnabled, items],
  );

  return (
    <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-4">
      <ConstructionPanoramaCard
        label="施工项目总览"
        value={totalCount}
        accent="blue"
        icon={Briefcase}
        onOpen={onOpenAll}
        showLiveIndicator={false}
      />
      {groups.map((group) => (
        <ConstructionPanoramaCard
          key={group.key}
          label={group.label}
          value={group.items.length}
          accent={group.accent}
          icon={group.icon}
          onOpen={onOpenAll}
          onOpenGroup={() => onOpenGroup(group)}
          showLiveIndicator={group.key !== 'completed'}
        />
      ))}
    </div>
  );
}

const MemoizedConstructionStatusOverview = React.memo(
  ConstructionStatusOverview,
);

function ConstructionPanoramaCard({
  label,
  value,
  accent,
  icon: Icon,
  onOpen,
  onOpenGroup,
  showLiveIndicator = true,
}: {
  label: string;
  value: number;
  accent: 'blue' | 'indigo' | 'amber' | 'emerald';
  icon: React.ElementType;
  onOpen: () => void;
  onOpenGroup?: () => void;
  showLiveIndicator?: boolean;
}) {
  const tone = {
    blue: {
      iconBackground: 'linear-gradient(135deg, #7fb3ff, #1e63ff)',
      text: 'text-[#1e63ff]',
      glow: 'bg-[#1e63ff]/12',
      decor: 'construction-panorama-card--blue',
      chip: 'border-[#1e63ff]/15 bg-[#1e63ff]/[0.08] text-[#1e63ff]',
      pulse: 'bg-[#1e63ff] shadow-[0_0_18px_rgba(30,99,255,0.45)]',
      live: '#1e63ff',
    },
    indigo: {
      iconBackground: 'linear-gradient(135deg, #68a2ff, #2855e8)',
      text: 'text-[#2855e8]',
      glow: 'bg-[#2855e8]/12',
      decor: 'construction-panorama-card--indigo',
      chip: 'border-[#2855e8]/15 bg-[#2855e8]/[0.08] text-[#2855e8]',
      pulse: 'bg-[#2855e8] shadow-[0_0_18px_rgba(40,85,232,0.45)]',
      live: '#2855e8',
    },
    amber: {
      iconBackground: 'linear-gradient(135deg, #ffbb64, #ff8a1f)',
      text: 'text-[#d76a00]',
      glow: 'bg-[#ff9b2f]/14',
      decor: 'construction-panorama-card--amber',
      chip: 'border-amber-200 bg-amber-50 text-amber-700',
      pulse: 'bg-[#ff9b2f] shadow-[0_0_18px_rgba(255,155,47,0.45)]',
      live: '#ff9b2f',
    },
    emerald: {
      iconBackground: 'linear-gradient(135deg, #62d8a0, #21a96d)',
      text: 'text-[#178a58]',
      glow: 'bg-[#27AB71]/12',
      decor: 'construction-panorama-card--emerald',
      chip: 'border-emerald-200 bg-emerald-50 text-emerald-700',
      pulse: 'bg-[#27AB71] shadow-[0_0_18px_rgba(39,171,113,0.45)]',
      live: '#27AB71',
    },
  }[accent];
  const handleOpen = onOpenGroup || onOpen;

  return (
    <button
      type="button"
      onClick={handleOpen}
      className={cn(
        'construction-panorama-card group relative min-h-[8.5rem] overflow-hidden rounded-2xl border border-white/80 bg-white/[0.94] px-7 py-6 text-left shadow-[0_18px_44px_rgba(35,78,150,0.10)] transition duration-200 hover:-translate-y-0.5 hover:shadow-[0_24px_56px_rgba(35,78,150,0.14)] focus:outline-none focus:ring-2 focus:ring-[#005BFF]/20',
        tone.decor,
      )}
      aria-label={`查看${label}施工项目`}
    >
      <div
        className={cn(
          'pointer-events-none absolute -right-12 -top-12 h-32 w-32 rounded-full blur-3xl',
          tone.glow,
        )}
      />
      {showLiveIndicator && (
        <span
          className="construction-live-indicator"
          style={
            {
              '--construction-live-color': tone.live,
            } as React.CSSProperties
          }
          aria-label="实时更新"
        >
          <span className="construction-live-indicator__halo" />
          <span className="construction-live-indicator__ring" />
          <span className="construction-live-indicator__core" />
        </span>
      )}
      <div className="relative z-10 flex h-full items-center gap-7">
        <span
          className="inline-flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl text-white shadow-[0_14px_28px_rgba(30,99,255,0.20)]"
          style={{ background: tone.iconBackground }}
        >
          <Icon className="h-8 w-8" />
        </span>
        <div className="min-w-0">
          <div className="truncate text-xl font-semibold text-slate-950">
            {label}
          </div>
          <div className="mt-2 flex items-end gap-2">
            <span className="text-5xl font-semibold leading-none tracking-tight text-slate-950">
              {value}
            </span>
            <span className="pb-1 text-sm text-slate-500">项</span>
          </div>
        </div>
      </div>
    </button>
  );
}

function CalendarStat({
  label,
  value,
  tone,
  icon: Icon,
}: {
  label: string;
  value: string;
  tone: 'blue' | 'emerald' | 'rose';
  icon: React.ElementType;
}) {
  const valueMatch = value.match(/^(\d+)(.*)$/);
  const amount = valueMatch?.[1] || value;
  const unit = valueMatch?.[2] || '';
  const toneMap = {
    blue: {
      card: 'border-[#b9d2ff] bg-[#f6f9ff] text-[#1e63ff]',
      icon: 'bg-[#1e63ff]/10 text-[#1e63ff]',
    },
    emerald: {
      card: 'border-emerald-200 bg-emerald-50/70 text-[#178a58]',
      icon: 'bg-emerald-100 text-[#178a58]',
    },
    rose: {
      card: 'border-rose-200 bg-rose-50/70 text-rose-600',
      icon: 'bg-rose-100 text-rose-600',
    },
  };
  const style = toneMap[tone];

  return (
    <div
      className={cn(
        'flex items-center justify-center gap-1.5 rounded-lg border px-2 py-1.5 text-center shadow-[0_8px_18px_rgba(35,78,150,0.07)]',
        style.card,
      )}
    >
      <span
        className={cn(
          'hidden h-6 w-6 shrink-0 items-center justify-center rounded-md sm:inline-flex',
          style.icon,
        )}
      >
        <Icon className="h-3.5 w-3.5" />
      </span>
      <div className="min-w-0">
        <div className="text-[11px] font-semibold leading-3 opacity-80">
          {label}
        </div>
        <div className="mt-0.5 flex items-end justify-center gap-1">
          <span className="text-lg font-semibold leading-none">{amount}</span>
          {unit && (
            <span className="text-xs font-semibold leading-4">{unit}</span>
          )}
        </div>
      </div>
    </div>
  );
}

interface CalendarDayView {
  key: string;
  date: Date;
  dayNumber: number;
  inMonth: boolean;
  isToday: boolean;
  items: ConstructionOverviewItem[];
}

interface ConstructionStatusGroup {
  key: ConstructionWorkState;
  label: string;
  helper: string;
  accent: 'indigo' | 'amber' | 'emerald';
  description: string;
  icon: React.ElementType;
  items: ConstructionOverviewItem[];
}

function CalendarDayCell({
  day,
  constructionAiAuditEnabled,
  onOpen,
}: {
  day: CalendarDayView;
  constructionAiAuditEnabled: boolean;
  onOpen: () => void;
}) {
  const hasBlockedItem = day.items.some((item) =>
    getLifecycleStages(item, day.date, constructionAiAuditEnabled).some(
      (stage) => stage.status === 'blocked',
    ),
  );
  const hasItems = day.items.length > 0;
  const title = day.items
    .map(
      (item) =>
        `${item.workContent}｜${item.building || '楼栋未填'}｜${
          getCurrentStage(
            getLifecycleStages(item, day.date, constructionAiAuditEnabled),
          ).shortLabel
        }`,
    )
    .join('\n');

  return (
    <button
      type="button"
      className={cn(
        'relative flex min-h-8 flex-col items-center justify-center gap-0.5 rounded-md border bg-white/90 px-1 py-0.5 transition hover:-translate-y-0.5 hover:bg-white hover:shadow-sm focus:outline-none focus:ring-2 focus:ring-[#005BFF]/20',
        hasItems
          ? 'border-[#d5e3fb] text-slate-900'
          : 'border-[#edf2f8] text-slate-400',
        !day.inMonth && 'bg-slate-50/50 text-slate-300',
        hasBlockedItem && 'border-rose-200 bg-rose-50/40',
        day.isToday &&
          'border-[#1e63ff] bg-[#1e63ff]/[0.04] ring-1 ring-inset ring-[#1e63ff]/40',
      )}
      title={title || undefined}
      onClick={onOpen}
      aria-label={`${formatCalendarDayButtonLabel(
        day,
        constructionAiAuditEnabled,
      )}，点击查看施工详情`}
    >
      <span
        className={cn(
          'text-[11px] font-semibold leading-none',
          day.isToday ? 'text-[#005BFF]' : undefined,
        )}
      >
        {day.dayNumber}
      </span>
      <span
        className={cn(
          'h-1.5 w-1.5 rounded-full',
          hasItems
            ? hasBlockedItem
              ? 'bg-rose-500'
              : 'bg-[#1e63ff]'
            : 'opacity-0',
        )}
        aria-hidden="true"
      />
    </button>
  );
}

function CalendarDayDetailDialog({
  detail,
  onOpenChange,
  onSelectItem,
}: {
  detail: CalendarDayDetail | null;
  onOpenChange: (open: boolean) => void;
  onSelectItem: (recordId: string) => void;
}) {
  return (
    <Dialog open={Boolean(detail)} onOpenChange={onOpenChange}>
      {detail && (
        <DialogContent className="flex max-h-[82vh] w-[calc(100vw-2rem)] max-w-2xl flex-col overflow-hidden rounded-2xl border-[#dbe7f6] bg-white p-0 shadow-[0_24px_70px_rgba(15,23,42,0.18)]">
          <DialogHeader className="shrink-0 border-b border-[#e5edf8] bg-[linear-gradient(135deg,rgba(248,251,255,0.98),rgba(239,247,255,0.96))] px-5 py-4 pr-12">
            <DialogTitle className="flex flex-wrap items-center gap-2 text-base font-semibold text-slate-950">
              <CalendarCheck className="h-4 w-4 text-[#1e63ff]" />
              {detail.dateLabel}
              <Badge className="rounded-md border-blue-100 bg-blue-50 text-blue-700">
                {detail.totalCount} 项施工
              </Badge>
              {detail.attentionCount > 0 && (
                <Badge className="rounded-md border-rose-100 bg-rose-50 text-rose-600">
                  {detail.attentionCount} 项需跟进
                </Badge>
              )}
            </DialogTitle>
            <DialogDescription>
              当天施工排期、当前阶段和待处理项明细。
            </DialogDescription>
          </DialogHeader>

          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-5 py-4">
            {detail.rows.length ? (
              detail.rows.map((row) => (
                <div
                  key={row.recordId}
                  className={cn(
                    'rounded-xl border bg-white px-4 py-3 shadow-sm',
                    row.status === 'attention'
                      ? 'border-rose-200 bg-rose-50/35'
                      : 'border-[#dbe7f6] bg-[#F8FBFF]/60',
                  )}
                >
                  <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span
                          className={cn(
                            'h-2 w-2 rounded-full',
                            row.status === 'attention'
                              ? 'bg-rose-500'
                              : 'bg-[#1e63ff]',
                          )}
                        />
                        <span className="truncate text-sm font-semibold text-slate-950">
                          {row.title}
                        </span>
                        {row.code && (
                          <Badge className="rounded-md border-slate-200 bg-white/80 text-slate-500">
                            {row.code}
                          </Badge>
                        )}
                        <Badge
                          className={cn(
                            'rounded-md border px-2 py-0.5 text-xs font-semibold',
                            row.status === 'attention'
                              ? 'border-rose-100 bg-rose-50 text-rose-600'
                              : 'border-blue-100 bg-blue-50 text-blue-700',
                          )}
                        >
                          {row.statusLabel}
                        </Badge>
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                        <span>{row.location}</span>
                        <span>·</span>
                        <span>{row.stageLabel}</span>
                      </div>
                      <p className="mt-2 text-xs leading-5 text-slate-600">
                        {row.stageEvidence}
                      </p>
                      {row.missing.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {row.missing.map((label) => (
                            <span
                              key={label}
                              className="rounded-md border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700"
                            >
                              {label}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      className="h-8 shrink-0 rounded-lg border-[#cfe0ff] bg-white px-3 text-xs font-semibold text-[#1e63ff] hover:bg-blue-50 disabled:cursor-not-allowed disabled:opacity-60"
                      onClick={() => onSelectItem(row.recordId)}
                    >
                      查看详情
                    </Button>
                  </div>
                </div>
              ))
            ) : (
              <EmptyPanel
                title="当天暂无施工安排"
                description="可切换月份或点击有蓝点、红点的日期查看施工明细"
                compact
              />
            )}
          </div>
        </DialogContent>
      )}
    </Dialog>
  );
}

function buildCalendarDayDetailFromView(
  day: CalendarDayView,
  constructionAiAuditEnabled = false,
): CalendarDayDetail {
  return buildCalendarDayDetail(
    day.date,
    day.items.map((item) => {
      const stages = getLifecycleStages(
        item,
        day.date,
        constructionAiAuditEnabled,
      );
      const blockedStage = stages.find((stage) => stage.status === 'blocked');
      const stage = blockedStage || getCurrentStage(stages);

      return {
        recordId: item.recordId,
        workContent: item.workContent,
        constructionCode: item.constructionCode,
        building: item.building,
        specialty: item.specialty,
        stageLabel: stage.shortLabel,
        stageEvidence: stage.evidence,
        missing: stage.missing.slice(0, 4),
        blocked: Boolean(blockedStage),
      };
    }),
  );
}

function formatCalendarDayButtonLabel(
  day: CalendarDayView,
  constructionAiAuditEnabled = false,
): string {
  const dateLabel = `${day.date.getFullYear()}年${day.date.getMonth() + 1}月${day.date.getDate()}日`;
  if (!day.items.length) {
    return `${dateLabel}，暂无施工`;
  }

  const blockedCount = day.items.filter((item) =>
    getLifecycleStages(item, day.date, constructionAiAuditEnabled).some(
      (stage) => stage.status === 'blocked',
    ),
  ).length;
  return `${dateLabel}，${day.items.length}项施工，${blockedCount}项需跟进`;
}

function DailyProgressStageCard({
  stage,
  index,
  dailyPermitReferenceDate,
  constructionAiAuditEnabled,
  onOpen,
}: {
  stage: DailyProgressStageSummary;
  index: number;
  dailyPermitReferenceDate: Date;
  constructionAiAuditEnabled: boolean;
  onOpen: () => void;
}) {
  const Icon = stage.icon;
  const style = getDailyProgressToneStyle(stage.tone);
  const doneRate =
    stage.total > 0 ? Math.round((stage.done / stage.total) * 100) : 0;
  const previewItems = stage.items.slice(0, 2);
  const primaryMetric = getDailyProgressStagePrimaryMetric(stage.key, stage);

  return (
    <div
      className={cn(
        'relative z-10 flex h-full min-h-[13.25rem] min-w-0 cursor-pointer overflow-hidden rounded-xl border p-5 shadow-[0_12px_30px_rgba(15,86,228,0.07)] transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[0_20px_42px_rgba(0,91,255,0.13)] focus:outline-none focus:ring-2 focus:ring-[#005BFF]/20',
        style.card,
        stage.pending > 0 && 'ring-1 ring-[#005BFF]/10',
      )}
      tabIndex={0}
      role="button"
      onClick={onOpen}
      onKeyDown={(event) => handleInteractiveCardKeyDown(event, onOpen)}
      aria-label={`查看${stage.label}每日跟进详情`}
    >
      <div className="relative flex h-full w-full flex-col">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <span
              className={cn(
                'inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-base font-semibold text-white shadow-[0_10px_20px_rgba(35,78,150,0.14)]',
                style.step,
              )}
            >
              {String(index + 1).padStart(2, '0')}
            </span>
            <div className="flex min-w-0 flex-1 items-center gap-1.5 text-base font-semibold text-slate-950">
              <span className="min-w-0 flex-1 truncate">{stage.label}</span>
              <InfoHint text={stage.description} />
            </div>
          </div>
          <span
            className={cn(
              'inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-white/60 shadow-sm ring-1 backdrop-blur-md',
              style.icon,
            )}
          >
            <Icon className="h-5 w-5" />
          </span>
        </div>

        <div className={cn('mt-4 border-t border-dashed', style.divider)} />

        <div className="mt-4 flex items-end justify-between gap-3">
          <div>
            <div
              className={cn('text-3xl font-semibold leading-none', style.count)}
            >
              {primaryMetric.value}
            </div>
            <div className="mt-1 text-[11px] text-slate-500">
              {primaryMetric.label}
            </div>
          </div>
          <div className="text-right text-[11px] text-slate-500">
            <div>完成 {stage.done}</div>
            <div>共 {stage.total}</div>
          </div>
        </div>

        <div
          className="mt-4 h-1.5 overflow-hidden rounded-full bg-white/70 shadow-inner ring-1 ring-white/70"
          role="progressbar"
          aria-label={`${stage.label}完成进度`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={doneRate}
        >
          <div
            className={cn('h-full rounded-full', style.progress)}
            style={{ width: `${doneRate}%` }}
          />
        </div>

        <div className="mt-4 min-h-[4.5rem] space-y-2">
          {previewItems.length ? (
            previewItems.map((item) => {
              const done = getDailyFollowupStageProgress(
                item,
                dailyPermitReferenceDate,
                constructionAiAuditEnabled,
              )[stage.key];

              return (
                <div
                  key={item.recordId}
                  className="rounded-lg border border-white/70 bg-white/[0.88] px-3 py-2 shadow-[0_8px_18px_rgba(15,23,42,0.04)]"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="min-w-0 flex-1 truncate text-xs font-semibold text-slate-900">
                      {item.workContent}
                    </span>
                    <span
                      className={cn(
                        'shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold',
                        done
                          ? 'bg-emerald-50 text-emerald-700'
                          : 'bg-blue-50 text-blue-700',
                      )}
                    >
                      {done ? '已完成' : '待跟进'}
                    </span>
                  </div>
                  <div className="mt-1 truncate text-[11px] text-slate-500">
                    {item.building || '楼栋未填'} ·{' '}
                    {formatCompactDateRange(
                      item.planStartTime,
                      item.planEndTime,
                    )}
                  </div>
                </div>
              );
            })
          ) : (
            <div className="flex h-[4.5rem] items-center justify-center rounded-lg border border-dashed border-white/70 bg-white/[0.72] text-sm font-medium text-slate-400">
              无
            </div>
          )}
        </div>

        <div className="mt-auto flex flex-wrap gap-2 pt-5">
          {stage.workItems.map((item) => {
            const WorkItemIcon = getDailyProgressWorkItemIcon(item);

            return (
              <span
                key={item}
                className={cn(
                  'inline-flex items-center gap-1 rounded-md border bg-white/60 px-2 py-1 text-[11px] font-medium backdrop-blur-md',
                  style.chip,
                )}
              >
                <WorkItemIcon className="h-3.5 w-3.5" />
                {item}
              </span>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function getDailyProgressToneStyle(tone: DailyProgressStageDefinition['tone']) {
  const styles: Record<
    DailyProgressStageDefinition['tone'],
    {
      card: string;
      step: string;
      icon: string;
      count: string;
      progress: string;
      chip: string;
      divider: string;
    }
  > = {
    blue: {
      card: 'border-[#b9d2ff] bg-[linear-gradient(135deg,rgba(30,99,255,0.12),rgba(255,255,255,0.88)_58%,rgba(255,255,255,0.76))]',
      step: 'bg-[linear-gradient(135deg,#58a2ff,#1e63ff)]',
      icon: 'text-[#1e63ff] ring-[#1e63ff]/20',
      count: 'text-[#005BFF]',
      progress: 'bg-[#005BFF]',
      chip: 'border-[#1e63ff]/25 text-[#1e63ff]',
      divider: 'border-[#b9d2ff]',
    },
    amber: {
      card: 'border-amber-200 bg-[linear-gradient(135deg,rgba(255,158,31,0.15),rgba(255,255,255,0.88)_58%,rgba(255,255,255,0.76))]',
      step: 'bg-[linear-gradient(135deg,#ffc35f,#ff8a1f)]',
      icon: 'text-[#ff8a1f] ring-amber-200/80',
      count: 'text-amber-700',
      progress: 'bg-amber-500',
      chip: 'border-amber-200/80 text-amber-700',
      divider: 'border-amber-200',
    },
    emerald: {
      card: 'border-emerald-200 bg-[linear-gradient(135deg,rgba(39,171,113,0.14),rgba(255,255,255,0.88)_58%,rgba(255,255,255,0.76))]',
      step: 'bg-[linear-gradient(135deg,#50d591,#21a96d)]',
      icon: 'text-[#178a58] ring-[#27AB71]/25',
      count: 'text-[#178a58]',
      progress: 'bg-[#27AB71]',
      chip: 'border-[#27AB71]/20 text-[#178a58]',
      divider: 'border-emerald-200',
    },
  };

  return styles[tone];
}

function getDailyProgressWorkItemIcon(item: string): React.ElementType {
  if (item.includes('人员')) return UserCheck;
  if (item.includes('挂牌') || item.includes('隔离')) return LockKeyhole;
  if (item.includes('过程')) return Camera;
  if (item.includes('清单')) return ListChecks;
  if (item.includes('照片')) return ImageIcon;
  return ClipboardCheck;
}

function isConstructionCardInteractiveTarget(
  target: EventTarget | null,
): boolean {
  return (
    target instanceof Element &&
    Boolean(
      target.closest(
        'button,a,input,textarea,select,[role="button"],[data-no-card-expand]',
      ),
    )
  );
}

function ConstructionCard({
  item,
  expanded,
  dailyPermitReferenceDate,
  constructionAiAuditEnabled,
  readOnly = false,
  onExpandedChange,
  onSelect,
  onOpenDailyFollowup,
  onOpenApplicationFollowup,
  onRefreshDailyProgress,
  onRefreshApprovalStatus,
  dailyProgressRefreshing,
  crewRosterSyncing,
  onSyncCrewRoster,
  onDeleteRequest,
  onTerminateRequest,
}: {
  item: ConstructionOverviewItem;
  expanded: boolean;
  dailyPermitReferenceDate: Date;
  constructionAiAuditEnabled: boolean;
  readOnly?: boolean;
  onExpandedChange: (recordId: string, expanded: boolean) => void;
  onSelect: (
    item: ConstructionOverviewItem,
    stageKey?: LifecycleStageKey | null,
    dailyOnly?: boolean,
  ) => void;
  onOpenDailyFollowup: (
    item: ConstructionOverviewItem,
    dailyFollowupStage: DailyFollowupStage,
    actionKind?: DailyChecklistActionKind,
  ) => void;
  onOpenApplicationFollowup: (item: ConstructionOverviewItem) => void;
  onRefreshDailyProgress?: () => void;
  onRefreshApprovalStatus?: () => void;
  dailyProgressRefreshing?: boolean;
  crewRosterSyncing?: boolean;
  onSyncCrewRoster: (item: ConstructionOverviewItem) => void;
  onDeleteRequest?: (item: ConstructionOverviewItem) => void;
  onTerminateRequest: (item: ConstructionOverviewItem) => void;
}) {
  const optimisticSyncing = isOptimisticConstructionRecordId(item.recordId);
  const effectiveReadOnly = readOnly || optimisticSyncing;
  const stages = getLifecycleStages(
    item,
    dailyPermitReferenceDate,
    constructionAiAuditEnabled,
  );
  const currentStage = getCurrentStage(stages);
  const issueCount = stages.reduce((sum, stage) => sum + stage.issueCount, 0);
  const missing = Array.from(
    new Set(stages.flatMap((stage) => stage.missing)),
  ).slice(0, 4);
  const CurrentStageIcon = currentStage.icon;
  const [visualCalendarOpen, setVisualCalendarOpen] = useState(false);
  const dailyFollowupOpen = isDailyFollowupOpenForProject(
    item,
    constructionAiAuditEnabled,
  );
  const applicationGapActionEnabled = !effectiveReadOnly && !dailyFollowupOpen;
  const handleCardClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (expanded || isConstructionCardInteractiveTarget(event.target)) {
        return;
      }
      onExpandedChange(item.recordId, true);
    },
    [expanded, onExpandedChange],
  );
  const handleOpenApplicationGap = useCallback(() => {
    if (effectiveReadOnly) {
      return;
    }
    onOpenApplicationFollowup(item);
  }, [effectiveReadOnly, item, onOpenApplicationFollowup]);

  return (
    <div
      className={cn(
        'rounded-2xl border border-[#dce7f6] bg-white/92 p-5 shadow-[0_14px_34px_rgba(15,86,228,0.07)] ring-1 ring-white/70 transition-all duration-200',
        expanded
          ? 'shadow-[0_22px_54px_rgba(0,91,255,0.10)]'
          : effectiveReadOnly
            ? 'cursor-default'
            : 'cursor-pointer hover:-translate-y-0.5 hover:border-[#005BFF]/25 hover:shadow-[0_18px_42px_rgba(0,91,255,0.10)]',
      )}
      onClick={handleCardClick}
    >
      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="truncate text-xl font-semibold text-slate-950">
              {item.workContent}
            </h2>
            {item.constructionCode && (
              <Badge className="rounded-md border-slate-200 bg-slate-50 text-slate-600">
                {item.constructionCode}
              </Badge>
            )}
            {optimisticSyncing && (
              <Badge className="rounded-md border-blue-200 bg-blue-50 text-blue-700">
                <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                多维表同步中
              </Badge>
            )}
            <LifecycleStatusBadge stage={currentStage} />
            {item.recordUrl && !effectiveReadOnly && (
              <a
                href={item.recordUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex text-[#005BFF] hover:text-[#004be0]"
                aria-label="打开施工记录"
                onClick={(event) => event.stopPropagation()}
                onKeyDown={(event) => event.stopPropagation()}
              >
                <ArrowUpRight className="h-4 w-4" />
              </a>
            )}
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-8 rounded-lg border-[#bdd2f4] bg-white px-2.5 text-xs font-semibold text-[#005BFF] shadow-sm hover:bg-blue-50 disabled:cursor-not-allowed disabled:opacity-60"
              disabled={optimisticSyncing}
              onClick={() => setVisualCalendarOpen(true)}
            >
              <CalendarCheck className="h-3.5 w-3.5" />
              施工可视化一览
            </Button>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-slate-500">
            <span>{item.building || '楼栋未填'}</span>
            <span>·</span>
            <span>{item.specialty || '专业未填'}</span>
            <span>·</span>
            <span>{item.contractorType || '施工方未填'}</span>
            <span>·</span>
            <span>{formatDateRange(item.planStartTime, item.planEndTime)}</span>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 md:justify-end">
          <div className="flex flex-wrap gap-2 md:justify-end">
            {item.workTypes.slice(0, 3).map((type) => (
              <Badge
                key={type}
                className="rounded-md border-[#005BFF]/15 bg-[#005BFF]/[0.06] text-[#005BFF]"
              >
                {type}
              </Badge>
            ))}
            {item.workTypes.length > 3 && (
              <Badge className="rounded-md border-slate-200 bg-slate-50 text-slate-600">
                +{item.workTypes.length - 3}
              </Badge>
            )}
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-9 rounded-lg border-[#bdd2f4] bg-white px-3 text-[#005BFF] hover:bg-blue-50 disabled:cursor-not-allowed disabled:opacity-60"
            onClick={() => onExpandedChange(item.recordId, !expanded)}
          >
            <ChevronDown
              className={cn(
                'h-4 w-4 transition-transform duration-200',
                expanded && 'rotate-180',
              )}
            />
            {expanded ? '收起项目' : '展开项目'}
          </Button>
          <Button
            type="button"
            size="sm"
            className="h-9 rounded-lg bg-[#005BFF] px-3 text-white hover:bg-[#004bd6] disabled:cursor-not-allowed disabled:opacity-60"
            disabled={optimisticSyncing}
            onClick={() => onSelect(item)}
          >
            查看详情
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-9 rounded-lg border-emerald-200 bg-white px-3 text-emerald-700 hover:bg-emerald-50 disabled:opacity-60"
            disabled={effectiveReadOnly || crewRosterSyncing}
            onClick={() => onSyncCrewRoster(item)}
          >
            {crewRosterSyncing ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <UserCheck className="h-4 w-4" />
            )}
            更新人员名单
          </Button>
          {!optimisticSyncing && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-9 rounded-lg border-amber-200 bg-white px-3 text-amber-700 hover:bg-amber-50 disabled:cursor-not-allowed disabled:opacity-60"
              disabled={readOnly}
              onClick={() => onTerminateRequest(item)}
            >
              <AlertCircle className="h-4 w-4" />
              终止项目
            </Button>
          )}
          {!optimisticSyncing && onDeleteRequest && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-9 rounded-lg border-rose-200 bg-white px-3 text-rose-600 hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-60"
              onClick={() => onDeleteRequest(item)}
            >
              <Trash2 className="h-4 w-4" />
              删除项目
            </Button>
          )}
        </div>
      </div>

      {expanded ? (
        <>
          <ProjectScheduleProgress item={item} />
          <ProjectKanbanDetail
            item={item}
            stages={stages}
            dailyPermitReferenceDate={dailyPermitReferenceDate}
            constructionAiAuditEnabled={constructionAiAuditEnabled}
            onOpenStageDetail={(stageKey, dailyOnly) =>
              onSelect(item, stageKey, dailyOnly)
            }
            onOpenDailyFollowup={(stage, actionKind) =>
              onOpenDailyFollowup(item, stage, actionKind)
            }
            onOpenApplicationFollowup={handleOpenApplicationGap}
            onRefreshDailyProgress={onRefreshDailyProgress}
            onRefreshApprovalStatus={onRefreshApprovalStatus}
            dailyProgressRefreshing={dailyProgressRefreshing}
            readOnly={effectiveReadOnly}
          />
        </>
      ) : (
        <div className="mt-4 flex flex-col gap-3 rounded-xl border border-[#e2ebf8] bg-[#f8fbff]/80 px-4 py-3 md:flex-row md:items-center md:justify-between">
          <div className="flex min-w-0 items-center gap-3">
            <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-[#cfe0ff] bg-white text-[#005BFF] shadow-sm">
              <CurrentStageIcon className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <div className="text-sm font-semibold text-slate-950">
                {currentStage.label}
              </div>
              <div className="mt-0.5 truncate text-xs text-slate-500">
                {currentStage.evidence}
              </div>
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            {missing.slice(0, 2).map((label) =>
              applicationGapActionEnabled && !readOnly ? (
                <button
                  type="button"
                  key={label}
                  data-no-card-expand
                  className="rounded-md bg-amber-50 px-2 py-1 text-xs text-amber-700 ring-1 ring-amber-100 transition hover:bg-amber-100 focus:outline-none focus:ring-2 focus:ring-amber-200"
                  onClick={handleOpenApplicationGap}
                >
                  {label}
                </button>
              ) : (
                <span
                  key={label}
                  className="rounded-md bg-amber-50 px-2 py-1 text-xs text-amber-700 ring-1 ring-amber-100"
                >
                  {label}
                </span>
              ),
            )}
            {issueCount > 0 &&
              (applicationGapActionEnabled && !readOnly ? (
                <button
                  type="button"
                  data-no-card-expand
                  className="rounded-md bg-rose-50 px-2 py-1 text-xs text-rose-700 ring-1 ring-rose-100 transition hover:bg-rose-100 focus:outline-none focus:ring-2 focus:ring-rose-200"
                  onClick={handleOpenApplicationGap}
                >
                  待跟进 {issueCount}
                </button>
              ) : (
                <span className="rounded-md bg-rose-50 px-2 py-1 text-xs text-rose-700 ring-1 ring-rose-100">
                  待跟进 {issueCount}
                </span>
              ))}
          </div>
        </div>
      )}

      {expanded && (missing.length > 0 || issueCount > 0) && (
        <div className="mt-4 rounded-lg border border-amber-100 bg-amber-50/70 px-3 py-2">
          <div className="flex items-center gap-2 text-xs font-semibold text-amber-800">
            <ListChecks className="h-3.5 w-3.5" />
            当前阶段缺口
          </div>
          <div className="mt-1 flex flex-wrap gap-2">
            {missing.map((label) =>
              applicationGapActionEnabled && !readOnly ? (
                <button
                  type="button"
                  key={label}
                  data-no-card-expand
                  className="rounded-md bg-white px-2 py-1 text-xs text-amber-800 ring-1 ring-amber-100 transition hover:bg-amber-100 focus:outline-none focus:ring-2 focus:ring-amber-200"
                  onClick={handleOpenApplicationGap}
                >
                  {label}
                </button>
              ) : (
                <span
                  key={label}
                  className="rounded-md bg-white px-2 py-1 text-xs text-amber-800 ring-1 ring-amber-100"
                >
                  {label}
                </span>
              ),
            )}
            {issueCount > 0 &&
              (applicationGapActionEnabled && !readOnly ? (
                <button
                  type="button"
                  data-no-card-expand
                  className="rounded-md bg-rose-50 px-2 py-1 text-xs text-rose-700 ring-1 ring-rose-100 transition hover:bg-rose-100 focus:outline-none focus:ring-2 focus:ring-rose-200"
                  onClick={handleOpenApplicationGap}
                >
                  待跟进项 {issueCount}
                </button>
              ) : (
                <span className="rounded-md bg-rose-50 px-2 py-1 text-xs text-rose-700 ring-1 ring-rose-100">
                  待跟进项 {issueCount}
                </span>
              ))}
          </div>
        </div>
      )}
      <ProjectVisualCalendarDialog
        item={item}
        open={visualCalendarOpen}
        constructionAiAuditEnabled={constructionAiAuditEnabled}
        onOpenChange={setVisualCalendarOpen}
      />
    </div>
  );
}

const MemoizedConstructionCard = React.memo(ConstructionCard);

type ProjectCalendarDayStatus = 'closed' | 'incomplete' | 'pending' | 'outside';

interface ProjectCalendarChecklistItem {
  label: string;
  value: string;
  done: boolean;
  issue?: boolean;
}

interface ProjectCalendarProblemItem {
  label: string;
  detail: string;
  tone: 'amber' | 'rose' | 'slate';
}

interface ProjectCalendarDayView {
  key: string;
  date: Date;
  dayNumber: number;
  inMonth: boolean;
  inProjectRange: boolean;
  isToday: boolean;
  status: ProjectCalendarDayStatus;
  statusLabel: string;
  checklist: ProjectCalendarChecklistItem[];
  problems: ProjectCalendarProblemItem[];
  followups: ConstructionFollowupItem[];
}

function ProjectVisualCalendarDialog({
  item,
  open,
  constructionAiAuditEnabled,
  onOpenChange,
}: {
  item: ConstructionOverviewItem;
  open: boolean;
  constructionAiAuditEnabled: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const initialMonth = useMemo(
    () => getProjectCalendarInitialMonth(item),
    [item],
  );
  const [visibleMonth, setVisibleMonth] = useState(initialMonth);
  const [selectedDayKey, setSelectedDayKey] = useState<string | null>(null);

  useEffect(() => {
    setVisibleMonth(initialMonth);
    setSelectedDayKey(null);
  }, [initialMonth, item.recordId]);

  const calendarDays = useMemo(
    () =>
      buildProjectCalendarDays(item, visibleMonth, constructionAiAuditEnabled),
    [constructionAiAuditEnabled, item, visibleMonth],
  );
  const cycleDays = useMemo(
    () => buildProjectCycleDays(item, constructionAiAuditEnabled),
    [constructionAiAuditEnabled, item],
  );
  const selectedDay = useMemo(() => {
    const exact = calendarDays.find((day) => day.key === selectedDayKey);
    if (exact) return exact;
    return (
      calendarDays.find((day) => day.isToday && day.inProjectRange) ||
      calendarDays.find((day) => day.status === 'incomplete') ||
      calendarDays.find((day) => day.status === 'closed') ||
      calendarDays.find((day) => day.inProjectRange) ||
      null
    );
  }, [calendarDays, selectedDayKey]);
  const stats = useMemo(
    () => buildProjectCalendarStats(cycleDays),
    [cycleDays],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[88vh] w-[calc(100vw-2rem)] max-w-5xl flex-col overflow-hidden rounded-2xl border-[#dbe7f6] bg-[#F8FBFF] p-0 shadow-[0_24px_70px_rgba(15,23,42,0.18)]">
        <DialogHeader className="shrink-0 border-b border-[#e5edf8] bg-[linear-gradient(135deg,rgba(248,251,255,0.98),rgba(239,247,255,0.96))] px-5 py-4 pr-12">
          <DialogTitle className="flex flex-wrap items-center gap-2 text-base font-semibold text-slate-950">
            <CalendarCheck className="h-4 w-4 text-[#005BFF]" />
            施工可视化一览
            <Badge className="rounded-md border-blue-100 bg-blue-50 text-blue-700">
              {item.constructionCode || '施工编码待生成'}
            </Badge>
          </DialogTitle>
          <DialogDescription>
            {item.workContent} ·{' '}
            {formatCompactDateRange(item.planStartTime, item.planEndTime)}
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1.05fr)_minmax(320px,0.95fr)]">
            <section className="rounded-xl border border-[#dbe7f6] bg-white/95 p-4 shadow-[0_16px_36px_rgba(20,71,150,0.07)]">
              <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                <div>
                  <div className="flex items-center gap-2 text-sm font-semibold text-slate-950">
                    <CalendarCheck className="h-4 w-4 text-[#005BFF]" />
                    {formatMonthLabel(visibleMonth)}
                  </div>
                  <div className="mt-1 text-xs text-slate-500">
                    绿色闭环，红色未完成，蓝色待施工。
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  <Button
                    type="button"
                    variant="outline"
                    className="h-8 w-8 rounded-lg border-[#d8e5f7] bg-white/80 p-0 text-slate-700 shadow-sm hover:border-[#005BFF]/20 hover:bg-[#F2F5FA]"
                    onClick={() =>
                      setVisibleMonth((current) => addMonths(current, -1))
                    }
                    aria-label="上个月"
                  >
                    <ChevronLeft className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    className="h-8 w-8 rounded-lg border-[#d8e5f7] bg-white/80 p-0 text-slate-700 shadow-sm hover:border-[#005BFF]/20 hover:bg-[#F2F5FA]"
                    onClick={() =>
                      setVisibleMonth((current) => addMonths(current, 1))
                    }
                    aria-label="下个月"
                  >
                    <ChevronRight className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>

              <div className="mt-3 grid grid-cols-4 gap-2">
                <ProjectCalendarStat
                  label="周期天数"
                  value={stats.total}
                  tone="blue"
                />
                <ProjectCalendarStat
                  label="已闭环"
                  value={stats.closed}
                  tone="emerald"
                />
                <ProjectCalendarStat
                  label="未完成"
                  value={stats.incomplete}
                  tone="rose"
                />
                <ProjectCalendarStat
                  label="待施工"
                  value={stats.pending}
                  tone="slate"
                />
              </div>

              <div className="mt-3 overflow-hidden rounded-xl border border-[#e2ebf7] bg-white/75">
                <div className="grid grid-cols-7 border-b border-[#e5edf8] bg-[#F8FBFF] px-1.5 py-1 text-center text-xs font-semibold text-slate-500">
                  {['一', '二', '三', '四', '五', '六', '日'].map((day) => (
                    <div key={day}>{day}</div>
                  ))}
                </div>
                <div className="grid grid-cols-7 gap-1 p-1.5">
                  {calendarDays.map((day) => (
                    <ProjectCalendarDayCell
                      key={day.key}
                      day={day}
                      selected={selectedDay?.key === day.key}
                      onOpen={() => setSelectedDayKey(day.key)}
                    />
                  ))}
                </div>
              </div>

              <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 px-1 text-xs font-medium text-slate-500">
                <ProjectCalendarLegend
                  color="bg-emerald-500"
                  label="按要求闭环"
                />
                <ProjectCalendarLegend
                  color="bg-rose-500"
                  label="有缺失或问题"
                />
                <ProjectCalendarLegend
                  color="bg-[#1e63ff]"
                  label="计划待施工"
                />
                <ProjectCalendarLegend
                  color="bg-slate-300"
                  label="非施工周期"
                />
              </div>
            </section>

            <ProjectCalendarDayDetailPanel item={item} day={selectedDay} />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ProjectCalendarStat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: 'blue' | 'emerald' | 'rose' | 'slate';
}) {
  const style = {
    blue: 'border-blue-100 bg-blue-50 text-[#005BFF]',
    emerald: 'border-emerald-100 bg-emerald-50 text-emerald-700',
    rose: 'border-rose-100 bg-rose-50 text-rose-700',
    slate: 'border-slate-200 bg-slate-50 text-slate-600',
  }[tone];

  return (
    <div className={cn('rounded-lg border px-2.5 py-2 text-center', style)}>
      <div className="text-[11px] font-medium">{label}</div>
      <div className="mt-0.5 text-base font-semibold leading-none">{value}</div>
    </div>
  );
}

function ProjectCalendarLegend({
  color,
  label,
}: {
  color: string;
  label: string;
}) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={cn('h-2.5 w-2.5 rounded-full', color)} />
      {label}
    </span>
  );
}

function ProjectCalendarDayCell({
  day,
  selected,
  onOpen,
}: {
  day: ProjectCalendarDayView;
  selected: boolean;
  onOpen: () => void;
}) {
  const style = getProjectCalendarDayStyle(day.status);
  const problemCount = day.problems.length;

  return (
    <button
      type="button"
      className={cn(
        'relative flex min-h-12 flex-col items-center justify-center gap-1 rounded-lg border px-1 py-1 text-center transition hover:-translate-y-0.5 hover:bg-white hover:shadow-sm focus:outline-none focus:ring-2 focus:ring-[#005BFF]/20',
        style.cell,
        !day.inMonth && 'opacity-45',
        selected && 'ring-2 ring-[#005BFF]/30',
        day.isToday && 'shadow-[inset_0_-2px_0_#005BFF]',
      )}
      onClick={onOpen}
      aria-label={`${formatProjectCalendarDayLabel(day)}，点击查看问题项`}
    >
      <span className={cn('text-xs font-semibold leading-none', style.text)}>
        {day.dayNumber}
      </span>
      <span
        className={cn('h-1.5 w-7 rounded-full', style.dot)}
        aria-hidden="true"
      />
      {problemCount > 0 && (
        <span className="absolute right-1 top-1 rounded-full bg-white/95 px-1 text-[10px] font-semibold leading-4 text-rose-600 ring-1 ring-rose-100">
          {problemCount}
        </span>
      )}
    </button>
  );
}

function ProjectCalendarDayDetailPanel({
  item,
  day,
}: {
  item: ConstructionOverviewItem;
  day: ProjectCalendarDayView | null;
}) {
  if (!day) {
    return (
      <section className="rounded-xl border border-[#dbe7f6] bg-white/95 p-4 shadow-[0_16px_36px_rgba(20,71,150,0.07)]">
        <EmptyPanel
          title="请选择日期"
          description="点击施工周期内日期查看闭环情况"
          compact
        />
      </section>
    );
  }

  const statusStyle = getProjectCalendarDayStyle(day.status);
  const projectIssueFiles = item.constructionIssues || [];

  return (
    <section className="rounded-xl border border-[#dbe7f6] bg-white/95 p-4 shadow-[0_16px_36px_rgba(20,71,150,0.07)]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-slate-950">
            {formatProjectCalendarDate(day.date)}
          </div>
          <div className="mt-1 text-xs text-slate-500">
            {day.followups.length
              ? `${day.followups.length} 条当日跟进记录`
              : day.inProjectRange
                ? '当日暂无跟进记录'
                : '不在施工计划周期内'}
          </div>
        </div>
        <Badge
          className={cn(
            'rounded-md border px-2 py-0.5 text-xs',
            statusStyle.badge,
          )}
        >
          {day.statusLabel}
        </Badge>
      </div>

      <div className="mt-4 space-y-2">
        <div className="text-xs font-semibold text-slate-700">当日闭环项</div>
        <div className="grid gap-2">
          {day.checklist.map((check) => (
            <div
              key={check.label}
              className={cn(
                'flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-xs',
                check.issue
                  ? 'border-rose-100 bg-rose-50/80 text-rose-700'
                  : check.done
                    ? 'border-emerald-100 bg-emerald-50/70 text-emerald-700'
                    : 'border-amber-100 bg-amber-50/70 text-amber-700',
              )}
            >
              <span className="font-medium">{check.label}</span>
              <span className="text-right">{check.value}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="mt-4 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-semibold text-slate-700">问题项</span>
          <span className="rounded-full bg-slate-50 px-2 py-0.5 text-[11px] font-semibold text-slate-500 ring-1 ring-slate-200">
            {day.problems.length} 项
          </span>
        </div>
        {day.problems.length ? (
          <div className="space-y-2">
            {day.problems.map((problem, index) => (
              <div
                key={`${problem.label}-${index}`}
                className={cn(
                  'rounded-lg border px-3 py-2 text-xs leading-5',
                  problem.tone === 'rose'
                    ? 'border-rose-100 bg-rose-50/70 text-rose-700'
                    : problem.tone === 'amber'
                      ? 'border-amber-100 bg-amber-50/80 text-amber-800'
                      : 'border-slate-200 bg-slate-50 text-slate-600',
                )}
              >
                <div className="font-semibold">{problem.label}</div>
                <div className="mt-0.5">{problem.detail}</div>
              </div>
            ))}
          </div>
        ) : (
          <div className="rounded-lg border border-emerald-100 bg-emerald-50/70 px-3 py-2 text-xs text-emerald-700">
            当日闭环项均已满足，未发现异常反馈。
          </div>
        )}
      </div>

      {projectIssueFiles.length > 0 && (
        <div className="mt-4 rounded-lg border border-rose-100 bg-rose-50/60 px-3 py-2">
          <div className="text-xs font-semibold text-rose-700">
            项目登记问题
          </div>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {projectIssueFiles.map((file) => (
              <span
                key={file.fileToken}
                className="rounded-md bg-white/80 px-2 py-1 text-[11px] text-rose-700 ring-1 ring-rose-100"
              >
                {file.name}
              </span>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function ProjectKanbanDetail({
  item,
  stages,
  dailyPermitReferenceDate,
  constructionAiAuditEnabled,
  onOpenStageDetail,
  onOpenDailyFollowup,
  onOpenApplicationFollowup,
  onRefreshDailyProgress,
  onRefreshApprovalStatus,
  dailyProgressRefreshing,
  readOnly = false,
}: {
  item: ConstructionOverviewItem;
  stages: LifecycleStageView[];
  dailyPermitReferenceDate: Date;
  constructionAiAuditEnabled: boolean;
  onOpenStageDetail: (stageKey: LifecycleStageKey, dailyOnly?: boolean) => void;
  onOpenDailyFollowup: (
    dailyFollowupStage: DailyFollowupStage,
    actionKind?: DailyChecklistActionKind,
  ) => void;
  onOpenApplicationFollowup: () => void;
  onRefreshDailyProgress?: () => void;
  onRefreshApprovalStatus?: () => void;
  dailyProgressRefreshing?: boolean;
  readOnly?: boolean;
}) {
  const applicationStage = stages.find((stage) => stage.key === 'approval');
  const dailyStages = stages.filter((stage) =>
    ['isolation', 'process', 'close'].includes(stage.key),
  );
  const approvalProgress = getApprovalFlowProgress(
    item,
    constructionAiAuditEnabled,
  );
  const approvalPercent =
    approvalProgress.total > 0
      ? Math.round((approvalProgress.completed / approvalProgress.total) * 100)
      : 0;
  const dailyChecklist = getProjectDailyProgressChecklist(
    item,
    dailyStages,
    dailyPermitReferenceDate,
    constructionAiAuditEnabled,
  );
  const completedChecklistCount = dailyChecklist.filter(
    (check) => check.done,
  ).length;
  const dailyFollowupOpen = isDailyFollowupOpenForProject(
    item,
    constructionAiAuditEnabled,
  );
  return (
    <div className="mt-4 grid items-start gap-4 xl:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
      {applicationStage && (
        <div className="rounded-xl border border-[#dbe8fa] bg-white/88 p-3 shadow-[0_12px_30px_rgba(15,86,228,0.06)]">
          <div className="mb-2 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-base font-semibold text-slate-950">
              <ClipboardCheck className="h-4 w-4 text-[#005BFF]" />
              项目施工申请
            </div>
            <span
              className={cn(
                'rounded-full px-2.5 py-1 text-xs font-semibold',
                applicationStage.status === 'done'
                  ? 'bg-emerald-50 text-emerald-700'
                  : applicationStage.status === 'blocked'
                    ? 'bg-rose-50 text-rose-700'
                    : 'bg-blue-50 text-[#005BFF]',
              )}
            >
              {approvalPercent}%
            </span>
          </div>
          <ProjectStageCell
            stage={applicationStage}
            index={0}
            disabled={readOnly}
            onClick={readOnly ? undefined : onOpenApplicationFollowup}
          />
          <ApprovalFlowMiniTimeline
            item={item}
            constructionAiAuditEnabled={constructionAiAuditEnabled}
            onOpenDetail={readOnly ? undefined : onOpenApplicationFollowup}
            onStepClick={
              readOnly
                ? undefined
                : (step) => {
                    if (step.title === '质保金确认') {
                      onRefreshApprovalStatus?.();
                      return;
                    }
                    onOpenApplicationFollowup();
                  }
            }
          />
          <ApprovalFlowIssueSummary
            item={item}
            constructionAiAuditEnabled={constructionAiAuditEnabled}
            actionLabel={readOnly ? '游客只读' : '补充材料'}
            onOpenDetail={readOnly ? undefined : onOpenApplicationFollowup}
          />
        </div>
      )}

      <div
        className={cn(
          'rounded-xl border border-[#dbe8fa] bg-white/88 p-4 shadow-[0_12px_30px_rgba(15,86,228,0.06)]',
          !dailyFollowupOpen && 'opacity-70',
        )}
      >
        <div className="mb-3 flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2 text-base font-semibold text-slate-950">
            <ListChecks className="h-4 w-4 shrink-0 text-[#005BFF]" />
            <span>今日施工进展</span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 w-7 rounded-lg border-[#d8e5f7] bg-white p-0 text-[#005BFF] shadow-sm hover:border-[#005BFF]/30 hover:bg-blue-50 disabled:cursor-not-allowed disabled:opacity-60"
              disabled={readOnly || dailyProgressRefreshing}
              title="同步多维表今日跟进最新内容"
              aria-label="同步多维表今日跟进最新内容"
              onClick={(event) => {
                event.stopPropagation();
                onRefreshDailyProgress?.();
              }}
            >
              {dailyProgressRefreshing ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )}
            </Button>
          </div>
          <span className="text-xs font-semibold text-[#005BFF]">
            {dailyFollowupOpen ? '准备 / 过程 / 收尾' : '申请闭环后开放'}
          </span>
        </div>
        <div className="grid gap-3 md:grid-cols-3">
          {dailyStages.map((stage, index) => (
            <ProjectStageCell
              key={stage.key}
              stage={stage}
              index={index + 1}
              disabled={!dailyFollowupOpen || readOnly}
              onClick={
                dailyFollowupOpen && !readOnly
                  ? () => onOpenStageDetail(stage.key, true)
                  : undefined
              }
            />
          ))}
        </div>
        <div className="mt-3 rounded-lg border border-[#dbe8fa] bg-[linear-gradient(135deg,rgba(255,255,255,0.92),rgba(244,249,255,0.76))] px-3 py-3">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-semibold text-slate-700">
              今日留痕
            </span>
            <span className="rounded-full bg-white/80 px-2 py-0.5 text-[11px] font-semibold text-slate-500 ring-1 ring-[#e2ebf8]">
              {completedChecklistCount}/{dailyChecklist.length} 完成
            </span>
          </div>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {dailyChecklist.map((check) => (
              <DailyChecklistActionRow
                key={check.label}
                check={check}
                disabled={!dailyFollowupOpen || readOnly}
                onOpenDailyFollowup={onOpenDailyFollowup}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function DailyChecklistActionRow({
  check,
  disabled = false,
  onOpenDailyFollowup,
}: {
  check: ReturnType<typeof getProjectDailyProgressChecklist>[number];
  disabled?: boolean;
  onOpenDailyFollowup: (
    dailyFollowupStage: DailyFollowupStage,
    actionKind?: DailyChecklistActionKind,
  ) => void;
}) {
  const actionable = !disabled && isDailyChecklistActionable(check);
  const className = cn(
    'flex min-h-9 items-center justify-between gap-3 rounded-lg border px-3 py-2 text-xs transition focus:outline-none focus:ring-2 focus:ring-blue-100',
    check.done
      ? 'border-emerald-100 bg-white/90 text-slate-700'
      : check.issue
        ? 'border-rose-100 bg-rose-50/80 text-rose-700'
        : 'border-amber-100 bg-amber-50/70 text-amber-700',
    actionable && 'cursor-pointer hover:-translate-y-0.5 hover:shadow-sm',
    !actionable && 'cursor-not-allowed opacity-60',
  );
  const content = (
    <>
      <span className="flex min-w-0 items-center gap-2 font-medium">
        <span
          className={cn(
            'h-1.5 w-1.5 shrink-0 rounded-full',
            check.done
              ? 'bg-emerald-500'
              : check.issue
                ? 'bg-rose-500'
                : 'bg-amber-400',
          )}
        />
        <span className="truncate">{check.label}</span>
      </span>
      <span className="shrink-0 font-semibold">{check.value}</span>
    </>
  );

  return (
    <button
      type="button"
      className={className}
      disabled={!actionable}
      title={!actionable ? check.disabledReason : undefined}
      onClick={() => {
        if (!actionable) return;
        onOpenDailyFollowup(check.stage, check.actionKind);
      }}
      aria-label={`打开每日跟进：${check.label}${check.value}`}
    >
      {content}
    </button>
  );
}

function IsolationAuditReviewDialog({
  summary,
  open,
  onOpenChange,
}: {
  summary: DailyIsolationAuditSummary | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  if (!summary) {
    return null;
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[calc(100vw-2rem)] max-w-xl rounded-2xl border-[#fecdd3] bg-white p-0 shadow-[0_24px_70px_rgba(127,29,29,0.18)]">
        <DialogHeader className="border-b border-rose-100 bg-rose-50/60 px-5 py-4 pr-12">
          <DialogTitle className="flex items-center gap-2 text-base font-semibold text-slate-950">
            {summary.tone === 'issue' ? (
              <AlertCircle className="h-4 w-4 text-rose-600" />
            ) : (
              <ShieldCheck className="h-4 w-4 text-emerald-600" />
            )}
            {summary.title}
          </DialogTitle>
          <DialogDescription>挂牌隔离照片审核结果。</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 px-5 py-4">
          {summary.details.length > 0 ? (
            <div className="grid gap-2">
              {summary.details.map((detail) => (
                <div
                  key={detail.label}
                  className={cn(
                    'rounded-lg border px-3 py-2 text-sm',
                    detail.tone === 'issue'
                      ? 'border-rose-100 bg-rose-50/75 text-rose-800'
                      : detail.tone === 'success'
                        ? 'border-emerald-100 bg-emerald-50/75 text-emerald-800'
                        : 'border-slate-200 bg-slate-50 text-slate-700',
                  )}
                >
                  <div className="text-xs font-semibold text-slate-500">
                    {detail.label}
                  </div>
                  <div className="mt-1 leading-relaxed">{detail.value}</div>
                </div>
              ))}
            </div>
          ) : (
            <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm leading-relaxed text-slate-700">
              {summary.description}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ApprovalFlowIssueSummary({
  item,
  constructionAiAuditEnabled,
  actionLabel = '查看详情',
  onOpenDetail,
}: {
  item: ConstructionOverviewItem;
  constructionAiAuditEnabled: boolean;
  actionLabel?: string;
  onOpenDetail?: () => void;
}) {
  const steps = getApprovalFlowSteps(item, constructionAiAuditEnabled);
  const issueSteps = steps.filter(
    (step) => step.tone !== 'done' && step.tone !== 'skipped',
  );
  const visibleSteps = issueSteps.length
    ? issueSteps.slice(0, 3)
    : steps.slice(-2);
  const completed = issueSteps.length === 0;

  return (
    <button
      type="button"
      className={cn(
        'mt-3 w-full rounded-lg border px-3 py-2 text-left transition hover:bg-white focus:outline-none focus:ring-2 focus:ring-[#005BFF]/20',
        completed
          ? 'border-emerald-100 bg-emerald-50/45'
          : 'border-amber-100 bg-amber-50/55',
      )}
      onClick={onOpenDetail}
    >
      <div className="flex items-center justify-between gap-2">
        <span
          className={cn(
            'text-xs font-semibold',
            completed ? 'text-emerald-700' : 'text-amber-800',
          )}
        >
          {completed
            ? '申请节点已闭环'
            : `申请节点问题 ${issueSteps.length} 项`}
        </span>
        <span className="text-[11px] text-slate-400">{actionLabel}</span>
      </div>
      <div className="mt-2 grid gap-1.5 sm:grid-cols-2">
        {visibleSteps.map((step) => (
          <div
            key={`${step.title}-${step.status}`}
            className={cn(
              'flex min-w-0 items-center justify-between gap-2 rounded-md border bg-white/75 px-2 py-1.5 text-[11px]',
              step.tone === 'issue'
                ? 'border-rose-100 text-rose-700'
                : completed
                  ? 'border-emerald-100 text-emerald-700'
                  : 'border-amber-100 text-amber-700',
            )}
          >
            <span className="min-w-0 truncate font-medium">{step.title}</span>
            <span className="shrink-0 font-semibold">{step.status}</span>
          </div>
        ))}
      </div>
    </button>
  );
}

function getProjectDailyProgressChecklist(
  item: ConstructionOverviewItem,
  dailyStages: LifecycleStageView[],
  dailyPermitReferenceDate: Date,
  constructionAiAuditEnabled = false,
): DailyChecklistActionItem[] {
  const todayFollowups = getTodayConstructionFollowups(
    item,
    dailyPermitReferenceDate,
  ).filter((followup) => !isInitialApplicationFollowup(followup));
  const todayAttachments = todayFollowups.flatMap(
    (followup) => followup.attachments,
  );
  const isolationStage = dailyStages.find((stage) => stage.key === 'isolation');
  const processStage = dailyStages.find((stage) => stage.key === 'process');
  const closeFollowup = getDailyFollowupForStage(
    item,
    'close',
    dailyPermitReferenceDate,
  );
  const prepareEvidence = getDailyPrepareEvidence(
    todayFollowups.map((followup) => ({
      dailyPersonnelCheck: followup.dailyPersonnelCheck,
      hasDailyPersonnelChecklist: hasAttachment(
        followup.attachments,
        '每日人员核查清单',
      ),
      isolationFeedback: followup.isolationFeedback,
      hasIsolationAttachment: hasAttachment(
        followup.attachments,
        '挂牌与隔离照片',
      ),
    })),
    constructionAiAuditEnabled,
  );
  const hasPersonnelCheck = prepareEvidence.hasPersonnelCheck;
  const hasIsolationTrace = prepareEvidence.hasIsolationTrace;
  const isolationManualReviewStatus = getDailyIsolationManualReviewStatus(
    getLatestIsolationManualReviewDecision(todayFollowups),
  );
  const isolationManualReviewPassed = isIsolationManualReviewPassed(
    isolationManualReviewStatus,
  );
  const isolationStageBlocked =
    isolationStage?.status === 'blocked' && !isolationManualReviewPassed;
  const isolationManualReviewIssue =
    hasIsolationTrace && !isolationManualReviewPassed;
  const hasProcessPhoto = hasAttachment(todayAttachments, '施工过程照片');
  const hasClosePhoto =
    hasAttachment(todayAttachments, '施工收尾照片') ||
    hasAttachment(todayAttachments, '每日收尾照片');
  const hasCloseChecklist =
    hasAttachment(todayAttachments, '施工检查表') ||
    hasAttachment(todayAttachments, '每日收尾检查表') ||
    Boolean(closeFollowup?.completed);
  const closeTraceDone = hasCloseChecklist && hasClosePhoto;
  const closeTraceValue = closeTraceDone
    ? '已完成'
    : hasCloseChecklist
      ? '待上传'
      : hasClosePhoto
        ? '待填写'
        : '待填写/上传';
  const confirmedDailyWorkTypes = getConfirmedTodayDailyWorkTypes(
    item,
    dailyPermitReferenceDate,
  );
  const hasDailyWorkTypeAudit = confirmedDailyWorkTypes.length > 0;
  const permitSummary = getConfirmedDailyPermitSummary(
    item,
    dailyPermitReferenceDate,
    constructionAiAuditEnabled,
  );

  return [
    {
      label: '作业类型校核',
      value: hasDailyWorkTypeAudit
        ? confirmedDailyWorkTypes.join('、')
        : '待校核',
      done: hasDailyWorkTypeAudit,
      actionKind: 'workType',
      stage: 'prepare',
    },
    {
      label: '人员核查',
      value: !hasDailyWorkTypeAudit
        ? '请先校核作业类型'
        : hasPersonnelCheck
          ? '已核查'
          : '待核查',
      done: hasPersonnelCheck,
      disabled: !hasDailyWorkTypeAudit,
      disabledReason: !hasDailyWorkTypeAudit
        ? '请先完成当天作业类型校核'
        : undefined,
      actionKind: 'personnel',
      stage: 'prepare',
    },
    {
      label: '作业票校核',
      value: permitSummary.value,
      done: permitSummary.done,
      issue: permitSummary.issue,
      actionKind: 'permit',
      stage: 'prepare',
    },
    {
      label: '挂牌隔离',
      value: isolationManualReviewPassed
        ? '已审核'
        : isolationStageBlocked
          ? '需复核'
          : isolationManualReviewIssue
            ? '需复核'
            : hasIsolationTrace
              ? '待审核'
              : '待上传',
      done: hasIsolationTrace && isolationManualReviewPassed,
      issue: isolationStageBlocked || isolationManualReviewIssue,
      actionKind: 'isolation',
      stage: 'prepare',
    },
    {
      label: '过程照片',
      value:
        processStage?.status === 'blocked'
          ? '需复核'
          : hasProcessPhoto
            ? '已上传'
            : '待上传',
      done: hasProcessPhoto,
      issue: processStage?.status === 'blocked',
      actionKind: 'processPhoto',
      stage: 'process',
    },
    {
      label: '收尾清单/照片',
      value: closeTraceValue,
      done: closeTraceDone,
      actionKind: 'closeChecklist',
      stage: 'close',
    },
  ];
}

function ApprovalFlowMiniTimeline({
  item,
  constructionAiAuditEnabled,
  onOpenDetail,
  onStepClick,
}: {
  item: ConstructionOverviewItem;
  constructionAiAuditEnabled: boolean;
  onOpenDetail?: () => void;
  onStepClick?: (step: ApprovalFlowStep, index: number) => void;
}) {
  const steps = getApprovalFlowSteps(item, constructionAiAuditEnabled);

  return (
    <div className="mt-2 overflow-hidden">
      <div className="flex min-w-0 items-start gap-1">
        {steps.map((step, index) => {
          const content = (
            <div className="flex min-w-0 flex-1 flex-col items-center text-center">
              <span
                className={cn(
                  'flex h-6 w-6 items-center justify-center rounded-full border text-[11px] font-semibold shadow-sm',
                  step.tone === 'done' &&
                    'border-emerald-100 bg-emerald-50 text-emerald-700',
                  step.tone === 'active' &&
                    'border-[#bdd2f4] bg-blue-50 text-[#005BFF]',
                  step.tone === 'pending' &&
                    'border-slate-200 bg-slate-50 text-slate-500',
                  step.tone === 'skipped' &&
                    'border-slate-100 bg-slate-50 text-slate-400',
                  step.tone === 'issue' &&
                    'border-rose-100 bg-rose-50 text-rose-700',
                )}
              >
                {index + 1}
              </span>
              <span className="mt-1 max-w-[4.25rem] truncate text-[10px] font-medium text-slate-600">
                {step.title}
              </span>
              <span
                className={cn(
                  'mt-0.5 rounded px-1.5 py-0.5 text-[10px]',
                  step.tone === 'issue'
                    ? 'bg-rose-50 text-rose-700'
                    : step.tone === 'done'
                      ? 'bg-emerald-50 text-emerald-700'
                      : 'bg-slate-50 text-slate-500',
                )}
              >
                {step.status}
              </span>
            </div>
          );

          return (
            <div
              key={`${step.title}-${index}`}
              className="flex min-w-0 flex-1 items-start gap-1"
            >
              {onOpenDetail ? (
                <button
                  type="button"
                  className="min-w-0 flex-1 rounded-lg p-1 transition hover:bg-white/70 focus:outline-none focus:ring-2 focus:ring-[#005BFF]/20"
                  onClick={() =>
                    onStepClick ? onStepClick(step, index) : onOpenDetail()
                  }
                >
                  {content}
                </button>
              ) : (
                content
              )}
              {index < steps.length - 1 && (
                <span
                  className={cn(
                    'mt-3 h-px w-5 shrink-0',
                    step.tone === 'done' ? 'bg-emerald-200' : 'bg-slate-200',
                  )}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ProjectScheduleProgress({ item }: { item: ConstructionOverviewItem }) {
  const meta = getScheduleMeta(item);
  const [showProgressTip, setShowProgressTip] = useState(false);
  const progress = Math.min(100, Math.max(0, meta.progress));
  const visualProgress = progress > 0 && progress < 6 ? 6 : progress;
  const markerPosition = meta.state === 'unknown' ? 0 : visualProgress;
  const startDate = parseOptionalDate(item.planStartTime);
  const endDate = parseOptionalDate(item.planEndTime);
  const planPeriodText = formatDateRange(item.planStartTime, item.planEndTime);
  const stateStyle: Record<
    ScheduleMeta['state'],
    {
      fill: string;
      marker: string;
      dot: string;
      halo: string;
    }
  > = {
    active: {
      fill: 'bg-[linear-gradient(90deg,#005BFF_0%,#27AB71_72%,#7DD3FC_100%)]',
      marker: 'bg-slate-950 text-white shadow-[0_8px_18px_rgba(15,23,42,0.18)]',
      dot: 'border-[#27AB71] bg-white text-[#178a58]',
      halo: 'bg-[#27AB71]/20',
    },
    upcoming: {
      fill: 'bg-[linear-gradient(90deg,#94A3B8_0%,#60A5FA_100%)]',
      marker: 'bg-slate-700 text-white shadow-[0_8px_18px_rgba(15,23,42,0.16)]',
      dot: 'border-[#005BFF] bg-white text-[#005BFF]',
      halo: 'bg-[#005BFF]/18',
    },
    completed: {
      fill: 'bg-[linear-gradient(90deg,#178A58_0%,#27AB71_55%,#A7F3D0_100%)]',
      marker:
        'bg-[#178A58] text-white shadow-[0_8px_18px_rgba(23,138,88,0.20)]',
      dot: 'border-[#178A58] bg-white text-[#178a58]',
      halo: 'bg-[#27AB71]/22',
    },
    unknown: {
      fill: 'bg-slate-300',
      marker:
        'bg-slate-500 text-white shadow-[0_8px_18px_rgba(100,116,139,0.14)]',
      dot: 'border-slate-300 bg-white text-slate-500',
      halo: 'bg-slate-300/30',
    },
  };
  const style = stateStyle[meta.state];
  const remainingText =
    meta.remainingDays === null
      ? meta.label
      : meta.remainingDays > 0
        ? `剩余 ${meta.remainingDays} 天`
        : meta.label;

  return (
    <div className="mt-4 rounded-lg border border-[#dce7f6] bg-white/75 px-3 py-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.75)]">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-[#005BFF]/15 bg-white/80 text-[#005BFF] shadow-sm">
            <Clock3 className="h-3.5 w-3.5" />
          </span>
          <div className="min-w-0">
            <div className="text-xs font-semibold text-slate-900">
              项目时间进度
            </div>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-slate-500">
              <span className="truncate">计划周期 {planPeriodText}</span>
              <span className="text-slate-300">·</span>
              <span>{remainingText}</span>
            </div>
          </div>
        </div>
      </div>

      <div
        className="mt-4"
        aria-label={`项目时间进度 ${progress}%`}
        onMouseEnter={() => setShowProgressTip(true)}
        onMouseLeave={() => setShowProgressTip(false)}
      >
        <div className="relative h-8">
          <div className="absolute inset-x-0 top-1/2 h-2.5 -translate-y-1/2 overflow-hidden rounded-full bg-slate-100 shadow-inner ring-1 ring-slate-200/70">
            <div
              className={cn(
                'relative h-full rounded-full shadow-[0_6px_18px_rgba(0,91,255,0.16)] transition-all duration-500 ease-out',
                style.fill,
              )}
              style={{ width: `${visualProgress}%` }}
            >
              <span className="absolute inset-y-0 right-0 w-8 rounded-full bg-white/35 blur-[5px]" />
            </div>
          </div>
          {meta.state !== 'unknown' && (
            <>
              <span
                className="absolute top-1/2 z-10 inline-flex h-5 w-5 -translate-x-1/2 -translate-y-1/2 items-center justify-center"
                style={{ left: `${markerPosition}%` }}
              >
                <span
                  className={cn(
                    'absolute h-7 w-7 rounded-full blur-sm',
                    style.halo,
                  )}
                />
                <span
                  className={cn(
                    'relative h-3.5 w-3.5 rounded-full border-2 shadow-sm',
                    style.dot,
                  )}
                />
              </span>
              {showProgressTip && (
                <span
                  className={cn(
                    'absolute -top-1 z-20 -translate-y-0.5 rounded-full px-2 py-0.5 text-[10px] font-semibold leading-4 shadow-sm',
                    style.marker,
                  )}
                  style={{
                    left: `${markerPosition}%`,
                    transform:
                      markerPosition < 8
                        ? 'translateX(0)'
                        : markerPosition > 92
                          ? 'translateX(-100%)'
                          : 'translateX(-50%)',
                  }}
                >
                  {progress}%
                </span>
              )}
            </>
          )}
        </div>
        <div className="mt-1 flex items-center justify-between gap-3 text-[11px] text-slate-500">
          <span className="truncate">
            开工 {startDate ? formatCompactDate(startDate) : '待确认'}
          </span>
          <span className="truncate text-right">
            结束 {endDate ? formatCompactDate(endDate) : '待确认'}
          </span>
        </div>
      </div>
    </div>
  );
}

function ConstructionListDialog({
  state,
  dailyPermitReferenceDate,
  constructionAiAuditEnabled,
  onOpenChange,
  onSelect,
  readOnly = false,
}: {
  state: ConstructionListDialogState | null;
  dailyPermitReferenceDate: Date;
  constructionAiAuditEnabled: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (
    item: ConstructionOverviewItem,
    dailyStageKey?: DailyFollowupStage,
  ) => void;
  readOnly?: boolean;
}) {
  return (
    <Dialog open={Boolean(state)} onOpenChange={onOpenChange}>
      {state && (
        <DialogContent className="flex max-h-[88vh] w-[calc(100vw-2rem)] max-w-3xl flex-col overflow-hidden p-0">
          <DialogHeader className="shrink-0 border-b border-slate-100 bg-[linear-gradient(135deg,hsl(217_91%_60%/0.08),hsl(142_76%_36%/0.06))] px-5 py-4 pr-12">
            <DialogTitle className="flex flex-wrap items-center gap-2 text-base">
              <ListChecks className="h-4 w-4 text-blue-600" />
              {state.title}
              <Badge className="rounded-md border-blue-100 bg-blue-50 text-blue-700">
                {state.items.length} 项
              </Badge>
            </DialogTitle>
            <DialogDescription>{state.description}</DialogDescription>
          </DialogHeader>

          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-5 py-4">
            {state.items.length ? (
              state.items.map((item) => (
                <ConstructionListDialogRow
                  key={item.recordId}
                  item={item}
                  stageKey={state.stageKey}
                  dailyStageKey={state.dailyStageKey}
                  dailyPermitReferenceDate={dailyPermitReferenceDate}
                  constructionAiAuditEnabled={constructionAiAuditEnabled}
                  onSelect={onSelect}
                  readOnly={readOnly}
                />
              ))
            ) : (
              <EmptyPanel
                title={state.emptyText}
                description="暂无可查看详情"
                compact
              />
            )}
          </div>
        </DialogContent>
      )}
    </Dialog>
  );
}

function ConstructionListDialogRow({
  item,
  stageKey,
  dailyStageKey,
  dailyPermitReferenceDate,
  constructionAiAuditEnabled,
  onSelect,
  readOnly = false,
}: {
  item: ConstructionOverviewItem;
  stageKey?: LifecycleStageKey;
  dailyStageKey?: DailyFollowupStage;
  dailyPermitReferenceDate: Date;
  constructionAiAuditEnabled: boolean;
  onSelect: (
    item: ConstructionOverviewItem,
    dailyStageKey?: DailyFollowupStage,
  ) => void;
  readOnly?: boolean;
}) {
  const stages = getLifecycleStages(
    item,
    dailyPermitReferenceDate,
    constructionAiAuditEnabled,
  );
  const stage =
    (stageKey
      ? stages.find((candidate) => candidate.key === stageKey)
      : null) || getCurrentStage(stages);
  const dailyDefinition = dailyStageKey
    ? DAILY_PROGRESS_STAGES.find((candidate) => candidate.key === dailyStageKey)
    : null;
  const dailyDone = dailyStageKey
    ? getDailyFollowupStageProgress(
        item,
        dailyPermitReferenceDate,
        constructionAiAuditEnabled,
      )[dailyStageKey]
    : false;
  const missing =
    dailyDefinition && !dailyDone
      ? dailyDefinition.workItems
      : stage.missing.slice(0, 3);

  return (
    <button
      type="button"
      onClick={() => onSelect(item, dailyStageKey)}
      className={cn(
        'group w-full rounded-lg border border-slate-100 bg-white px-3 py-3 text-left shadow-sm transition-all duration-200',
        readOnly
          ? 'cursor-default'
          : 'hover:-translate-y-0.5 hover:border-blue-200 hover:shadow-md',
      )}
    >
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-semibold text-slate-950 group-hover:text-blue-700">
              {item.workContent}
            </span>
            {item.constructionCode && (
              <Badge className="rounded-md border-slate-200 bg-slate-50 text-slate-600">
                {item.constructionCode}
              </Badge>
            )}
            {dailyStageKey ? (
              <Badge
                className={cn(
                  'rounded-md border px-2 py-0.5 text-xs font-semibold',
                  dailyDone
                    ? 'border-[#27AB71]/20 bg-[#27AB71]/10 text-[#178a58]'
                    : 'border-amber-200 bg-amber-50 text-amber-700',
                )}
              >
                {dailyDone ? '今日已完成' : '今日待跟进'}
              </Badge>
            ) : (
              <LifecycleStatusBadge stage={stage} />
            )}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-500">
            <span>{item.building || '楼栋未填'}</span>
            <span>·</span>
            <span>{item.specialty || '专业未填'}</span>
            <span>·</span>
            <span>{formatDateRange(item.planStartTime, item.planEndTime)}</span>
          </div>
          <div className="mt-2 grid gap-1 text-[11px] text-slate-500 md:grid-cols-3">
            <span>
              审批：{formatApprovalSummary(item, constructionAiAuditEnabled)}
            </span>
            <span>申请人：{getConstructionApplicantName(item)}</span>
            <span>
              当前：
              {dailyDefinition
                ? dailyDefinition.workItems.join('、')
                : stage.evidence}
            </span>
          </div>
          {missing.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {missing.map((label) => (
                <span
                  key={label}
                  className="rounded bg-amber-50 px-1.5 py-0.5 text-[11px] text-amber-700 ring-1 ring-amber-100"
                >
                  {label}
                </span>
              ))}
            </div>
          )}
        </div>
        <span
          className={cn(
            'shrink-0 text-xs font-semibold text-blue-600',
            !readOnly && 'group-hover:text-blue-700',
          )}
        >
          查看详情
        </span>
      </div>
    </button>
  );
}

function ConstructionDetailDialog({
  item,
  initialStageKey,
  initialDailyOnly = false,
  dailyPermitReferenceDate,
  constructionAiAuditEnabled,
  onOpenChange,
}: {
  item: ConstructionOverviewItem | null;
  initialStageKey?: LifecycleStageKey | null;
  initialDailyOnly?: boolean;
  dailyPermitReferenceDate: Date;
  constructionAiAuditEnabled: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const stages = item
    ? getLifecycleStages(
        item,
        dailyPermitReferenceDate,
        constructionAiAuditEnabled,
      )
    : [];
  const currentStage = stages.length ? getCurrentStage(stages) : null;
  const currentStageKey = currentStage?.key || null;
  const [selectedStageKey, setSelectedStageKey] =
    useState<LifecycleStageKey | null>(null);
  const requestedStageKey = stages.some(
    (stage) => stage.key === initialStageKey,
  )
    ? initialStageKey
    : null;
  const fallbackStageKey =
    requestedStageKey || currentStageKey || stages[0]?.key || null;
  const selectedStage =
    stages.find((stage) => stage.key === selectedStageKey) ||
    currentStage ||
    stages[0] ||
    null;
  const isDailyStageDetail =
    initialDailyOnly && isDailyLifecycleStageKey(selectedStage?.key);

  useEffect(() => {
    setSelectedStageKey(fallbackStageKey);
  }, [fallbackStageKey, initialStageKey, item?.recordId]);

  return (
    <Dialog open={Boolean(item)} onOpenChange={onOpenChange}>
      {item && (
        <DialogContent className="flex max-h-[90vh] w-[calc(100vw-2rem)] max-w-6xl flex-col gap-0 overflow-hidden rounded-2xl border-[#dbe7f6] bg-[#F8FBFF] p-0 shadow-[0_24px_70px_rgba(15,23,42,0.18)]">
          <DialogHeader className="shrink-0 border-b border-[#e5edf8] bg-[linear-gradient(135deg,rgba(248,251,255,0.98),rgba(239,247,255,0.96))] px-6 py-4 pr-14">
            <DialogTitle className="flex flex-wrap items-center gap-2 text-xl font-bold text-slate-950">
              <FileUp className="h-5 w-5 text-[#005BFF]" />
              {item.workContent}
              {currentStage && <LifecycleStatusBadge stage={currentStage} />}
            </DialogTitle>
            <DialogDescription className="mt-2 text-sm text-slate-500">
              {item.constructionCode || '施工编码待生成'} ·{' '}
              {item.building || '楼栋未填'} · {item.specialty || '专业未填'}
            </DialogDescription>
          </DialogHeader>

          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-4">
            <ProjectDetailSummaryCards item={item} stages={stages} />

            {selectedStage && (
              <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
                <section className="min-w-0 rounded-xl border border-[#dbe7f6] bg-white/90 p-4 shadow-[0_18px_42px_rgba(20,71,150,0.08)] backdrop-blur-md">
                  <LifecycleStageDetailPanel
                    item={item}
                    stage={selectedStage}
                    stages={stages}
                    dailyPermitReferenceDate={dailyPermitReferenceDate}
                    constructionAiAuditEnabled={constructionAiAuditEnabled}
                    dailyOnly={isDailyStageDetail}
                    selectedStageKey={selectedStage.key}
                    onSelectStage={setSelectedStageKey}
                  />
                </section>
                <StageMaterialSidePanel
                  item={item}
                  stage={selectedStage}
                  dailyPermitReferenceDate={dailyPermitReferenceDate}
                  constructionAiAuditEnabled={constructionAiAuditEnabled}
                  dailyOnly={isDailyStageDetail}
                />
              </div>
            )}
          </div>
        </DialogContent>
      )}
    </Dialog>
  );
}

function ProjectDetailSummaryCards({
  item,
  stages,
}: {
  item: ConstructionOverviewItem;
  stages: LifecycleStageView[];
}) {
  const issueCount = item.constructionIssues?.length || 0;
  const currentStage = stages.length ? getCurrentStage(stages) : null;
  const todayStatus = getProjectTodayStatusText(item, currentStage);

  return (
    <div className="grid gap-4 md:grid-cols-3">
      <ProjectDetailSummaryCard
        icon={HelpCircle}
        title="施工问题"
        value={issueCount > 0 ? `${issueCount} 个问题` : '暂无'}
        description={
          issueCount > 0 ? '施工总览已登记现场问题' : '施工总览未登记施工问题'
        }
        tone={issueCount > 0 ? 'rose' : 'blue'}
      />
      <ProjectDetailSummaryCard
        icon={Layers3}
        title="项目阶段"
        value={currentStage?.shortLabel || '待确认'}
        description="申请 / 准备 / 过程 / 收尾"
        tone="blue"
      />
      <ProjectDetailSummaryCard
        icon={CalendarCheck}
        title="今日状态"
        value={todayStatus.value}
        description={todayStatus.description}
        tone={todayStatus.tone}
      />
    </div>
  );
}

function ProjectDetailSummaryCard({
  icon: Icon,
  title,
  value,
  description,
  tone,
}: {
  icon: React.ElementType;
  title: string;
  value: string;
  description: string;
  tone: 'blue' | 'emerald' | 'rose';
}) {
  return (
    <div className="rounded-xl border border-[#dbe7f6] bg-white/90 p-4 shadow-[0_14px_34px_rgba(20,71,150,0.07)] backdrop-blur-md">
      <div className="flex items-center gap-3">
        <span
          className={cn(
            'inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-white shadow-lg',
            tone === 'blue' &&
              'bg-[linear-gradient(135deg,#2F6BFF,#005BFF)] shadow-blue-500/20',
            tone === 'emerald' &&
              'bg-[linear-gradient(135deg,#44D19D,#27AB71)] shadow-emerald-500/18',
            tone === 'rose' &&
              'bg-[linear-gradient(135deg,#FF7186,#E11D48)] shadow-rose-500/18',
          )}
        >
          <Icon className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <div className="text-sm font-semibold text-slate-950">{title}</div>
            <span
              className={cn(
                'shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold',
                tone === 'rose'
                  ? 'bg-rose-50 text-rose-700'
                  : tone === 'emerald'
                    ? 'bg-emerald-50 text-emerald-700'
                    : 'bg-blue-50 text-[#005BFF]',
              )}
            >
              {value}
            </span>
          </div>
          <div className="mt-1 line-clamp-1 text-xs text-slate-500">
            {description}
          </div>
        </div>
      </div>
    </div>
  );
}

function DetailLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-slate-100 pb-2 last:border-b-0 last:pb-0">
      <span className="shrink-0 text-slate-500">{label}</span>
      <span className="text-right font-medium text-slate-900">{value}</span>
    </div>
  );
}

function LifecycleStatusBadge({ stage }: { stage: LifecycleStageView }) {
  return (
    <Badge
      className={cn(
        'rounded-md border px-2 py-0.5 text-xs',
        stage.status === 'blocked'
          ? 'border-rose-100 bg-rose-50 text-rose-700'
          : stage.status === 'active'
            ? 'border-[#005BFF]/15 bg-[#005BFF]/[0.06] text-[#005BFF]'
            : stage.status === 'done'
              ? 'border-[#27AB71]/20 bg-[#27AB71]/[0.08] text-[#178a58]'
              : 'border-slate-200 bg-slate-50 text-slate-500',
      )}
    >
      {stage.label} · {getLifecycleStatusText(stage.status)}
    </Badge>
  );
}

function ProjectLifecycleStages({
  stages,
  selectedStageKey,
  onSelectStage,
}: {
  stages: LifecycleStageView[];
  selectedStageKey?: LifecycleStageKey | null;
  onSelectStage?: (stageKey: LifecycleStageKey) => void;
}) {
  const applicationStage = stages.find((stage) => stage.key === 'approval');
  const dailyStages = stages.filter((stage) =>
    ['isolation', 'process', 'close'].includes(stage.key),
  );
  const renderStage = (stage: LifecycleStageView, index: number) => (
    <ProjectStageCell
      key={stage.key}
      stage={stage}
      index={index}
      selected={selectedStageKey === stage.key}
      onClick={onSelectStage ? () => onSelectStage(stage.key) : undefined}
    />
  );

  return (
    <div className="mt-4 grid gap-3 lg:grid-cols-[minmax(220px,0.85fr)_minmax(0,3fr)]">
      {applicationStage && (
        <div className="min-w-0">
          <div className="mb-1 text-[11px] font-semibold text-slate-500">
            项目施工申请
          </div>
          {renderStage(applicationStage, 0)}
        </div>
      )}
      <div className="min-w-0">
        <div className="mb-1 flex items-center justify-between gap-2">
          <span className="text-[11px] font-semibold text-slate-500">
            今日施工进展
          </span>
          <span className="text-[11px] text-slate-400">准备 / 过程 / 收尾</span>
        </div>
        <div className="grid gap-2 md:grid-cols-3">
          {dailyStages.map((stage, index) => renderStage(stage, index + 1))}
        </div>
      </div>
    </div>
  );
}

function ProjectStageCell({
  stage,
  index,
  selected = false,
  disabled = false,
  onClick,
}: {
  stage: LifecycleStageView;
  index: number;
  selected?: boolean;
  disabled?: boolean;
  onClick?: () => void;
}) {
  const Icon = stage.icon;
  const interactive = Boolean(onClick) && !disabled;
  const className = cn(
    'relative rounded-lg border px-2 py-2 text-left transition duration-200',
    interactive &&
      'hover:-translate-y-0.5 hover:shadow-md focus:outline-none focus:ring-2 focus:ring-[#005BFF]/20',
    disabled && 'cursor-not-allowed opacity-60',
    stage.status === 'done' &&
      'border-[#27AB71]/20 bg-[#27AB71]/[0.08] text-[#177e53]',
    stage.status === 'active' &&
      'border-[#005BFF]/20 bg-[#005BFF]/[0.07] text-[#005BFF]',
    stage.status === 'blocked' && 'border-rose-200 bg-rose-50/80 text-rose-800',
    stage.status === 'pending' && 'border-slate-200 bg-white text-slate-500',
    selected &&
      'ring-2 ring-[#005BFF]/20 shadow-[0_12px_28px_rgba(0,91,255,0.14)]',
  );
  const content = (
    <>
      <div className="flex items-center justify-between gap-2">
        <Icon className="h-3.5 w-3.5" />
        <span className="text-[10px] font-semibold opacity-70">
          0{index + 1}
        </span>
      </div>
      <div className="mt-2 text-xs font-semibold">{stage.shortLabel}</div>
      <div className="mt-1 line-clamp-2 text-[11px] leading-4 opacity-80">
        {stage.evidence}
      </div>
    </>
  );

  if (interactive) {
    return (
      <button
        type="button"
        aria-pressed={selected}
        onClick={onClick}
        className={className}
      >
        {content}
      </button>
    );
  }

  return <div className={className}>{content}</div>;
}

function ProjectDetailStageNav({
  stages,
  selectedStageKey,
  onSelectStage,
}: {
  stages: LifecycleStageView[];
  selectedStageKey?: LifecycleStageKey | null;
  onSelectStage?: (stageKey: LifecycleStageKey) => void;
}) {
  return (
    <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {stages.map((stage) => {
        const Icon = stage.icon;
        const selected = selectedStageKey === stage.key;
        const toneClass =
          stage.status === 'done'
            ? 'border-emerald-100 bg-emerald-50/70 text-emerald-700'
            : stage.status === 'blocked'
              ? 'border-rose-100 bg-rose-50/70 text-rose-700'
              : stage.status === 'active'
                ? 'border-blue-100 bg-blue-50/80 text-[#005BFF]'
                : 'border-slate-100 bg-white/80 text-slate-500';

        return (
          <button
            key={stage.key}
            type="button"
            onClick={() => onSelectStage?.(stage.key)}
            className={cn(
              'flex min-h-[72px] items-center gap-3 rounded-lg border px-3 py-3 text-left transition duration-200 hover:-translate-y-0.5 hover:shadow-md focus:outline-none focus:ring-2 focus:ring-[#005BFF]/20',
              toneClass,
              selected &&
                'ring-2 ring-[#005BFF]/25 shadow-[0_12px_28px_rgba(0,91,255,0.14)]',
            )}
          >
            <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white/90 shadow-sm">
              <Icon className="h-4 w-4" />
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-semibold text-slate-950">
                {stage.label}
              </span>
              <span className="mt-1 block truncate text-xs opacity-80">
                {stage.evidence}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

function CurrentStageGapStrip({ stage }: { stage: LifecycleStageView }) {
  const gaps = stage.missing.length ? stage.missing : [];

  return (
    <div className="mt-4 rounded-lg border border-amber-100 bg-amber-50/70 px-3 py-3">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="font-semibold text-amber-900">当前缺口</span>
        {gaps.length ? (
          <>
            <span className="rounded-md bg-rose-50 px-2 py-1 font-semibold text-rose-700 ring-1 ring-rose-100">
              材料缺 {gaps.length} 项
            </span>
            {gaps.map((gap) => (
              <span
                key={gap}
                className="rounded-md border border-amber-200 bg-white/80 px-2 py-1 text-amber-800"
              >
                {gap}
              </span>
            ))}
          </>
        ) : (
          <span className="rounded-md border border-emerald-100 bg-emerald-50 px-2 py-1 font-medium text-emerald-700">
            暂无缺口
          </span>
        )}
      </div>
    </div>
  );
}

function StageMaterialSidePanel({
  item,
  stage,
  dailyPermitReferenceDate,
  constructionAiAuditEnabled,
  dailyOnly = false,
}: {
  item: ConstructionOverviewItem;
  stage: LifecycleStageView;
  dailyPermitReferenceDate: Date;
  constructionAiAuditEnabled: boolean;
  dailyOnly?: boolean;
}) {
  const attachments = getLifecycleStageAttachmentGroups(
    item,
    stage,
    dailyPermitReferenceDate,
    dailyOnly,
    constructionAiAuditEnabled,
  );
  const completedAttachments = attachments.filter(
    (attachment) => attachment.count > 0,
  ).length;
  const title =
    stage.key === 'approval'
      ? '申请与许可材料'
      : dailyOnly
        ? '今日留痕材料'
        : '本阶段留痕材料';

  return (
    <aside className="rounded-xl border border-[#dbe7f6] bg-white/90 p-4 shadow-[0_18px_42px_rgba(20,71,150,0.08)] backdrop-blur-md">
      <div className="flex items-center justify-between gap-2">
        <div className="text-base font-bold text-slate-950">{title}</div>
        <span
          className={cn(
            'rounded-full px-2 py-1 text-xs font-bold',
            completedAttachments === attachments.length &&
              attachments.length > 0
              ? 'bg-emerald-50 text-emerald-700'
              : 'bg-rose-50 text-rose-700',
          )}
        >
          {completedAttachments}/{attachments.length || 0}
        </span>
      </div>
      {attachments.length > 0 ? (
        <div className="mt-3 grid gap-2">
          {attachments.map((attachment) => (
            <AttachmentTraceRow
              key={`${stage.key}-side-${attachment.label}`}
              attachment={attachment}
            />
          ))}
        </div>
      ) : (
        <div className="mt-3 rounded-lg border border-dashed border-slate-200 bg-slate-50 px-3 py-8 text-center text-sm text-slate-400">
          无
        </div>
      )}
    </aside>
  );
}

function LifecycleStageDetailPanel({
  item,
  stage,
  stages = [],
  dailyPermitReferenceDate,
  constructionAiAuditEnabled,
  dailyOnly = false,
  selectedStageKey,
  onSelectStage,
}: {
  item: ConstructionOverviewItem;
  stage: LifecycleStageView;
  stages?: LifecycleStageView[];
  dailyPermitReferenceDate: Date;
  constructionAiAuditEnabled: boolean;
  dailyOnly?: boolean;
  selectedStageKey?: LifecycleStageKey | null;
  onSelectStage?: (stageKey: LifecycleStageKey) => void;
}) {
  if (stage.key === 'apply') {
    return (
      <ApplicationAccessDetailPanel
        item={item}
        stage={stage}
        stages={stages}
        dailyPermitReferenceDate={dailyPermitReferenceDate}
        constructionAiAuditEnabled={constructionAiAuditEnabled}
        selectedStageKey={selectedStageKey}
        onSelectStage={onSelectStage}
      />
    );
  }

  if (stage.key === 'approval') {
    return (
      <ApprovalFlowDetailPanel
        item={item}
        stage={stage}
        stages={stages}
        constructionAiAuditEnabled={constructionAiAuditEnabled}
        selectedStageKey={selectedStageKey}
        onSelectStage={onSelectStage}
      />
    );
  }

  return (
    <ConstructionTraceDetailPanel
      item={item}
      stage={stage}
      stages={stages}
      dailyPermitReferenceDate={dailyPermitReferenceDate}
      constructionAiAuditEnabled={constructionAiAuditEnabled}
      dailyOnly={dailyOnly}
      selectedStageKey={selectedStageKey}
      onSelectStage={onSelectStage}
    />
  );
}

function ApplicationAccessDetailPanel({
  item,
  stage,
  stages,
  dailyPermitReferenceDate,
  constructionAiAuditEnabled,
  selectedStageKey,
  onSelectStage,
}: {
  item: ConstructionOverviewItem;
  stage: LifecycleStageView;
  stages: LifecycleStageView[];
  dailyPermitReferenceDate: Date;
  constructionAiAuditEnabled: boolean;
  selectedStageKey?: LifecycleStageKey | null;
  onSelectStage?: (stageKey: LifecycleStageKey) => void;
}) {
  const Icon = stage.icon;
  const rows = getLifecycleStageDetailRows(
    item,
    stage,
    dailyPermitReferenceDate,
    false,
    constructionAiAuditEnabled,
  );

  return (
    <div>
      <StageDetailHeader icon={Icon} stage={stage} title="项目施工申请详情" />
      <div className="mt-4 rounded-xl border border-[#dbe7f6] bg-[#F8FBFF]/80 px-4 py-3">
        <div className="text-sm font-semibold text-slate-950">施工基础信息</div>
        <div className="mt-3 grid gap-2 text-sm text-slate-600 sm:grid-cols-2">
          {rows.map((row) => (
            <DetailLine
              key={`${stage.key}-${row.label}`}
              label={row.label}
              value={row.value}
            />
          ))}
        </div>
      </div>
      <ProjectDetailStageNav
        stages={stages}
        selectedStageKey={selectedStageKey}
        onSelectStage={onSelectStage}
      />
      <CurrentStageGapStrip stage={stage} />
    </div>
  );
}

function ApprovalFlowDetailPanel({
  item,
  stage,
  stages,
  constructionAiAuditEnabled,
  selectedStageKey,
  onSelectStage,
}: {
  item: ConstructionOverviewItem;
  stage: LifecycleStageView;
  stages: LifecycleStageView[];
  constructionAiAuditEnabled: boolean;
  selectedStageKey?: LifecycleStageKey | null;
  onSelectStage?: (stageKey: LifecycleStageKey) => void;
}) {
  const Icon = stage.icon;
  const steps = getApprovalFlowSteps(item, constructionAiAuditEnabled);
  const progress = getApprovalFlowProgress(item, constructionAiAuditEnabled);

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <StageDetailHeader
          icon={Icon}
          stage={stage}
          title="项目施工申请详情"
          description="审批流与复核流转一体展示"
        />
        <span className="rounded-lg border border-[#dbe7f6] bg-[#F8FBFF] px-4 py-2 text-sm font-semibold text-slate-700">
          审批进度{' '}
          <span className="text-[#005BFF]">
            {progress.completed}/{progress.total}
          </span>
        </span>
      </div>

      <div className="mt-3 flex justify-end gap-4 text-xs text-slate-500">
        <span className="inline-flex items-center gap-1">
          <i className="h-2 w-2 rounded-full bg-[#27AB71]" />
          已完成
        </span>
        <span className="inline-flex items-center gap-1">
          <i className="h-2 w-2 rounded-full bg-[#F59E0B]" />
          当前处理
        </span>
        <span className="inline-flex items-center gap-1">
          <i className="h-2 w-2 rounded-full bg-[#005BFF]" />
          待处理
        </span>
      </div>

      <div className="mt-4 min-w-0 overflow-x-auto pb-2">
        <div className="relative min-w-[760px]">
          <div className="absolute left-14 right-14 top-8 h-px bg-gradient-to-r from-[#27AB71]/60 via-[#F59E0B]/50 to-[#005BFF]/35" />
          <div className="relative grid grid-cols-7 gap-3">
            {steps.map((step, index) => (
              <ApprovalFlowStepCard
                key={`${step.title}-${index}`}
                step={step}
                index={index}
              />
            ))}
          </div>
        </div>
      </div>

      <ProjectDetailStageNav
        stages={stages}
        selectedStageKey={selectedStageKey}
        onSelectStage={onSelectStage}
      />
      <CurrentStageGapStrip stage={stage} />
    </div>
  );
}

function ConstructionTraceDetailPanel({
  item,
  stage,
  stages,
  dailyPermitReferenceDate,
  constructionAiAuditEnabled,
  dailyOnly = false,
  selectedStageKey,
  onSelectStage,
}: {
  item: ConstructionOverviewItem;
  stage: LifecycleStageView;
  stages: LifecycleStageView[];
  dailyPermitReferenceDate: Date;
  constructionAiAuditEnabled: boolean;
  dailyOnly?: boolean;
  selectedStageKey?: LifecycleStageKey | null;
  onSelectStage?: (stageKey: LifecycleStageKey) => void;
}) {
  const Icon = stage.icon;
  const rows = getLifecycleStageDetailRows(
    item,
    stage,
    dailyPermitReferenceDate,
    dailyOnly,
    constructionAiAuditEnabled,
  );
  const relatedFollowups = getLifecycleStageRelatedFollowups(
    item,
    stage,
    dailyPermitReferenceDate,
    dailyOnly,
  );

  return (
    <div>
      <StageDetailHeader
        icon={Icon}
        stage={stage}
        title={dailyOnly ? `今日${stage.shortLabel}详情` : `${stage.label}详情`}
        description={
          dailyOnly
            ? `${formatCompactDate(dailyPermitReferenceDate)} 当日跟进记录`
            : undefined
        }
      />

      <div className="mt-4 grid gap-3 md:grid-cols-[0.9fr_1.1fr]">
        <div className="rounded-xl border border-[#dbe7f6] bg-[#F8FBFF]/80 px-4 py-3">
          <div className="text-sm font-semibold text-slate-950">关键状态</div>
          <div className="mt-3 grid gap-2 text-sm text-slate-600">
            <DetailLine
              label="阶段状态"
              value={getLifecycleStatusText(stage.status)}
            />
            <DetailLine
              label="缺口"
              value={stage.missing.length ? stage.missing.join('、') : '暂无'}
            />
            <DetailLine
              label="待跟进项"
              value={stage.issueCount > 0 ? `${stage.issueCount} 项` : '暂无'}
            />
            {rows.map((row) => (
              <DetailLine
                key={`${stage.key}-${row.label}`}
                label={row.label}
                value={row.value}
              />
            ))}
          </div>
        </div>

        <div className="rounded-xl border border-[#dbe7f6] bg-white/80 px-4 py-3">
          <div className="text-sm font-semibold text-slate-950">关联跟进</div>
          {relatedFollowups.length ? (
            <div className="mt-3 grid gap-2">
              {relatedFollowups.map((followup) => (
                <div
                  key={followup.recordId}
                  className="rounded-md border border-slate-100 bg-slate-50/70 px-2 py-2 text-xs text-slate-600"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold text-slate-900">
                      {normalizeDisplayText(followup.title || '跟进记录')}
                    </span>
                    <span className="shrink-0 text-[11px] text-slate-400">
                      {formatDateTime(followup.updatedAt || followup.createdAt)}
                    </span>
                  </div>
                  <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
                    <span>跟进人：{followup.followupStaff || '未填写'}</span>
                    {followup.constructionDay ? (
                      <span>第 {followup.constructionDay} 天</span>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="mt-2 rounded-md border border-dashed border-slate-200 bg-slate-50 px-3 py-4 text-center text-xs text-slate-500">
              {dailyOnly ? '今日暂无该阶段跟进记录' : '暂无该阶段跟进记录'}
            </div>
          )}
        </div>
      </div>

      <ProjectDetailStageNav
        stages={stages}
        selectedStageKey={selectedStageKey}
        onSelectStage={onSelectStage}
      />
      <CurrentStageGapStrip stage={stage} />
    </div>
  );
}

function StageDetailHeader({
  icon: Icon,
  stage,
  title,
  description,
}: {
  icon: React.ElementType;
  stage: LifecycleStageView;
  title: string;
  description?: string;
}) {
  return (
    <div className="flex items-start gap-2">
      <div
        className={cn(
          'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border bg-white shadow-sm',
          stage.status === 'done' && 'border-[#27AB71]/20 text-[#178a58]',
          stage.status === 'active' && 'border-[#005BFF]/20 text-[#005BFF]',
          stage.status === 'blocked' && 'border-rose-200 text-rose-700',
          stage.status === 'pending' && 'border-slate-200 text-slate-500',
        )}
      >
        <Icon className="h-4 w-4" />
      </div>
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="text-sm font-semibold text-slate-950">{title}</div>
          <LifecycleStatusBadge stage={stage} />
        </div>
        <div className="mt-1 text-xs leading-5 text-slate-500">
          {description || stage.evidence}
        </div>
      </div>
    </div>
  );
}

interface ApprovalFlowStep {
  title: string;
  owner: string;
  status: string;
  tone: 'done' | 'active' | 'pending' | 'skipped' | 'issue';
}

interface ApprovalFlowProgress {
  total: number;
  completed: number;
  missing: string[];
  hasIssue: boolean;
  isComplete: boolean;
}

function ApprovalFlowStepCard({
  step,
  index,
}: {
  step: ApprovalFlowStep;
  index: number;
}) {
  return (
    <div
      className={cn(
        'relative flex min-h-[150px] flex-col items-center rounded-xl border bg-white/90 px-3 py-3 text-center shadow-[0_12px_28px_rgba(15,23,42,0.06)] backdrop-blur-md',
        step.tone === 'done' && 'border-emerald-100',
        step.tone === 'active' && 'border-amber-200',
        step.tone === 'pending' && 'border-blue-100',
        step.tone === 'skipped' && 'border-slate-100',
        step.tone === 'issue' && 'border-rose-200',
      )}
      title={`${step.title}｜${step.owner}｜${step.status}`}
    >
      <div className="flex h-14 items-center">
        <div
          className={cn(
            'relative z-10 flex h-11 w-11 items-center justify-center rounded-full border-4 border-white text-sm font-semibold shadow-[0_8px_18px_rgba(15,23,42,0.12)]',
            step.tone === 'done' && 'bg-emerald-100 text-emerald-700',
            step.tone === 'active' && 'bg-amber-100 text-amber-700',
            step.tone === 'pending' && 'bg-blue-50 text-[#005BFF]',
            step.tone === 'skipped' && 'bg-slate-50 text-slate-400',
            step.tone === 'issue' && 'bg-rose-100 text-rose-700',
          )}
        >
          {index + 1}
        </div>
      </div>
      <div className="min-h-10 text-sm font-semibold leading-5 text-slate-950">
        {step.title}
      </div>
      <div className="mt-1 min-h-4 max-w-full truncate text-[11px] font-medium text-slate-500">
        {step.owner}
      </div>
      <span
        className={cn(
          'mt-2 rounded-full px-2 py-0.5 text-[10px] font-semibold',
          step.tone === 'done' && 'bg-emerald-50 text-emerald-700',
          step.tone === 'active' && 'bg-amber-50 text-amber-700',
          step.tone === 'pending' && 'bg-blue-50 text-[#005BFF]',
          step.tone === 'skipped' && 'bg-slate-50 text-slate-400',
          step.tone === 'issue' && 'bg-rose-50 text-rose-700',
        )}
      >
        {step.status}
      </span>
    </div>
  );
}

function AttachmentTraceRow({
  attachment,
}: {
  attachment: LifecycleStageAttachmentView;
}) {
  const isComplete = attachment.count > 0;
  const isIssue = attachment.status === 'issue';

  return (
    <div
      className={cn(
        'rounded-md border px-2 py-2 text-xs',
        isIssue
          ? 'border-rose-100 bg-rose-50 text-rose-700'
          : isComplete
            ? 'border-[#27AB71]/15 bg-[#27AB71]/[0.06] text-[#177e53]'
            : 'border-slate-100 bg-slate-50 text-slate-500',
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-semibold">{attachment.label}</span>
        <span className="shrink-0">
          {isComplete ? `${attachment.count} 个文件` : '未上传'}
        </span>
      </div>
      {attachment.files.length ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {attachment.files.map((file, index) => {
            const fileName = normalizeDisplayText(file.name) || '附件';
            return (
              <a
                key={`${attachment.label}-${file.fileToken}-${index}`}
                href={getConstructionAttachmentDownloadUrl(
                  file.fileToken,
                  fileName,
                  { tmpUrl: file.tmpUrl },
                )}
                download={fileName}
                className="inline-flex max-w-full items-center rounded-md border border-current/15 bg-white/70 px-2 py-0.5 text-[11px] font-medium underline-offset-2 hover:underline"
                title={fileName}
              >
                <span className="truncate">{fileName}</span>
              </a>
            );
          })}
        </div>
      ) : null}
      {attachment.feedbacks.length ? (
        <div className="mt-1 line-clamp-2 text-[11px] opacity-75">
          {attachment.feedbacks.map(normalizeDisplayText).join('；')}
        </div>
      ) : null}
    </div>
  );
}

function InfoPill({
  icon: Icon,
  label,
  value,
}: {
  icon: React.ElementType;
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-lg border border-[#e5edf8] bg-[#F8FBFF] px-3 py-2">
      <div className="flex items-center gap-1.5 text-xs text-slate-500">
        <Icon className="h-3.5 w-3.5 text-[#005BFF]" />
        {label}
      </div>
      <div className="mt-1 truncate text-sm font-semibold text-slate-900">
        {value}
      </div>
    </div>
  );
}

function ConstructionIssueCard({
  item,
  compact = false,
  className,
}: {
  item: ConstructionOverviewItem;
  compact?: boolean;
  className?: string;
}) {
  const files = item.constructionIssues || [];
  const hasIssues = files.length > 0;

  return (
    <div
      className={cn(
        'rounded-lg border px-3 py-3',
        hasIssues
          ? 'border-rose-100 bg-rose-50/70 text-rose-800'
          : 'border-slate-100 bg-slate-50/75 text-slate-600',
        compact ? 'mt-3' : '',
        className,
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs font-semibold">
          <AlertCircle
            className={cn(
              'h-3.5 w-3.5',
              hasIssues ? 'text-rose-600' : 'text-slate-400',
            )}
          />
          <span>施工问题</span>
        </div>
        <span
          className={cn(
            'rounded-full px-2 py-0.5 text-[11px] font-semibold',
            hasIssues ? 'bg-rose-100 text-rose-700' : 'bg-white text-slate-500',
          )}
        >
          {hasIssues ? `${files.length} 个文件` : '暂无'}
        </span>
      </div>
      {hasIssues ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {files.map((file, index) => {
            const fileName = normalizeDisplayText(file.name) || '施工问题附件';
            return (
              <a
                key={`${file.fileToken}-${index}`}
                href={getConstructionAttachmentDownloadUrl(
                  file.fileToken,
                  fileName,
                  { tmpUrl: file.tmpUrl },
                )}
                download={fileName}
                title={fileName}
                className="inline-flex max-w-full items-center rounded-md border border-rose-200 bg-white/80 px-2 py-0.5 text-[11px] font-medium text-rose-700 underline-offset-2 hover:underline"
                onClick={(event) => event.stopPropagation()}
                onKeyDown={(event) => event.stopPropagation()}
              >
                <span className="truncate">{fileName}</span>
              </a>
            );
          })}
        </div>
      ) : (
        <div className="mt-1 text-xs text-slate-500">
          施工总览未登记施工问题
        </div>
      )}
    </div>
  );
}

function SectionHeader({
  title,
  description,
  compact = false,
}: {
  title: string;
  description: string;
  compact?: boolean;
}) {
  return (
    <div className="flex items-center justify-between">
      <h2
        className={cn(
          'flex items-center gap-1.5 font-semibold text-slate-950',
          compact ? 'text-base' : 'text-lg',
        )}
      >
        {title}
        <InfoHint text={description} />
      </h2>
    </div>
  );
}

function InfoHint({ text }: { text: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={text}
          className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-[#d8e5f7] bg-white/80 text-slate-400 shadow-sm transition hover:border-[#005BFF]/25 hover:text-[#005BFF] focus:outline-none focus:ring-2 focus:ring-[#005BFF]/20"
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          <HelpCircle className="h-3 w-3" />
        </button>
      </TooltipTrigger>
      <TooltipContent
        side="top"
        sideOffset={8}
        className="z-[70] max-w-64 text-left text-xs font-normal leading-5"
      >
        {text}
      </TooltipContent>
    </Tooltip>
  );
}

function handleInteractiveCardKeyDown(
  event: React.KeyboardEvent<HTMLElement>,
  onActivate: () => void,
) {
  if (event.key !== 'Enter' && event.key !== ' ') {
    return;
  }

  event.preventDefault();
  onActivate();
}

function EmptyPanel({
  title,
  description,
  compact = false,
}: {
  title: string;
  description: string;
  compact?: boolean;
}) {
  return (
    <div
      className={cn(
        'rounded-lg border border-dashed border-slate-200 bg-white/70 text-center',
        compact ? 'px-3 py-5' : 'px-4 py-10',
      )}
    >
      <div className="text-sm font-semibold text-slate-800">{title}</div>
      <div className="mt-1 text-sm text-slate-500">{description}</div>
    </div>
  );
}

function ApplicationDialog({
  open,
  submitting,
  sessionId,
  recoveryDraft,
  onOpenChange,
  onSubmit,
}: {
  open: boolean;
  submitting: boolean;
  sessionId: number;
  recoveryDraft: ApplicationRecoveryDraft | null;
  onOpenChange: (open: boolean) => void;
  onSubmit: (
    sessionId: number,
    form: ApplicationFormState,
    files: FileBucket,
  ) => Promise<boolean>;
}) {
  const [form, setForm] = useState<ApplicationFormState>(
    initialApplicationForm,
  );
  const [files, setFiles] = useState<FileBucket>({});
  const restoredRevisionRef = useRef<number | null>(null);

  useEffect(() => {
    if (
      open &&
      recoveryDraft &&
      restoredRevisionRef.current !== recoveryDraft.revision
    ) {
      restoredRevisionRef.current = recoveryDraft.revision;
      setForm(recoveryDraft.form);
      setFiles(recoveryDraft.files);
      return;
    }
    if (!open && !submitting) {
      setForm(initialApplicationForm);
      setFiles({});
    }
  }, [open, recoveryDraft, submitting]);

  const handleSubmit = useCallback(async () => {
    const submitted = await onSubmit(sessionId, form, files);
    if (submitted) {
      setForm(initialApplicationForm);
      setFiles({});
    }
  }, [files, form, onSubmit, sessionId]);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => !submitting && onOpenChange(next)}
    >
      <DialogContent
        className="flex max-h-[88vh] w-[calc(100vw-2rem)] max-w-3xl flex-col overflow-hidden p-0"
        showCloseButton={!submitting}
      >
        <DialogHeader className="sticky top-0 z-20 shrink-0 border-b border-slate-100 bg-white/95 px-5 py-4 shadow-[0_8px_22px_rgba(15,23,42,0.04)] backdrop-blur-md">
          <DialogTitle className="flex items-center gap-2 text-base">
            <HardHat className="h-4 w-4 text-blue-600" />
            新建施工申请
          </DialogTitle>
          <DialogDescription>
            提交施工总览信息；施工人员名单为必填申请材料。
          </DialogDescription>
        </DialogHeader>
        <div className="grid min-h-0 flex-1 gap-4 overflow-y-auto px-5 py-4 md:grid-cols-2">
          <Field label="作业内容" className="md:col-span-2">
            <Textarea
              value={form.workContent}
              onChange={(event) =>
                setForm((current) => ({
                  ...current,
                  workContent: event.target.value,
                }))
              }
              placeholder="例如：A楼挖潜机房施工"
              className="min-h-24 border-slate-200 bg-slate-50 focus-visible:ring-blue-200"
            />
          </Field>
          <SelectField
            label="楼栋"
            value={form.building}
            options={BUILDINGS}
            onChange={(building) =>
              setForm((current) => ({ ...current, building }))
            }
          />
          <SelectField
            label="专业"
            value={form.specialty}
            options={SPECIALTIES}
            onChange={(specialty) =>
              setForm((current) => ({ ...current, specialty }))
            }
          />
          <SelectField
            label="施工方"
            value={form.contractorType}
            options={CONTRACTOR_TYPES}
            onChange={(contractorType) =>
              setForm((current) => ({ ...current, contractorType }))
            }
          />
          <SelectField
            label="关联作业类型"
            value={form.relatedWorkType}
            options={RELATED_WORK_TYPES}
            onChange={(relatedWorkType) =>
              setForm((current) => ({
                ...current,
                relatedWorkType,
                changeOrderRecordId:
                  relatedWorkType === '变更' ? current.changeOrderRecordId : '',
                changeOrderTitle:
                  relatedWorkType === '变更' ? current.changeOrderTitle : '',
              }))
            }
          />
          {form.relatedWorkType === '变更' && (
            <Field label="关联变更单" className="md:col-span-2" required>
              <ConstructionChangeOrderSelect
                valueId={form.changeOrderRecordId}
                valueName={form.changeOrderTitle}
                disabled={submitting}
                onChange={(candidate) =>
                  setForm((current) => ({
                    ...current,
                    changeOrderRecordId: candidate?.id || '',
                    changeOrderTitle: candidate?.title || '',
                  }))
                }
              />
              <p className="mt-1 text-xs text-slate-500">
                仅关联已同步到施工管理底表的变更单；提交时会写入施工总览的“变更关联”。
              </p>
            </Field>
          )}
          <Field label="计划开始时间">
            <Input
              type="datetime-local"
              value={form.planStartTime}
              onChange={(event) => {
                const planStartTime = event.target.value;
                setForm((current) => {
                  const previousDate = getDateInputValue(current.planStartTime);
                  const nextDate = getDateInputValue(planStartTime);
                  return {
                    ...current,
                    planStartTime,
                    authorizationStartDate:
                      !current.authorizationStartDate ||
                      current.authorizationStartDate === previousDate
                        ? nextDate
                        : current.authorizationStartDate,
                  };
                });
              }}
              className="border-slate-200 bg-slate-50 focus-visible:ring-blue-200"
            />
          </Field>
          <Field label="计划结束时间">
            <Input
              type="datetime-local"
              value={form.planEndTime}
              onChange={(event) => {
                const planEndTime = event.target.value;
                setForm((current) => {
                  const previousDate = getDateInputValue(current.planEndTime);
                  const nextDate = getDateInputValue(planEndTime);
                  return {
                    ...current,
                    planEndTime,
                    authorizationEndDate:
                      !current.authorizationEndDate ||
                      current.authorizationEndDate === previousDate
                        ? nextDate
                        : current.authorizationEndDate,
                  };
                });
              }}
              className="border-slate-200 bg-slate-50 focus-visible:ring-blue-200"
            />
          </Field>
          <Field label="授权开始日期" required>
            <Input
              type="date"
              value={form.authorizationStartDate}
              onChange={(event) =>
                setForm((current) => ({
                  ...current,
                  authorizationStartDate: event.target.value,
                }))
              }
              className="border-slate-200 bg-slate-50 focus-visible:ring-blue-200"
            />
          </Field>
          <Field label="施工结束日期" required>
            <Input
              type="date"
              value={form.authorizationEndDate}
              onChange={(event) =>
                setForm((current) => ({
                  ...current,
                  authorizationEndDate: event.target.value,
                }))
              }
              className="border-slate-200 bg-slate-50 focus-visible:ring-blue-200"
            />
          </Field>
          <Field label="施工申请人" className="md:col-span-2" required>
            <ConstructionStaffSelect
              valueId={form.constructionApplicantId}
              valueName={form.constructionApplicantName}
              disabled={submitting}
              onChange={(candidate) =>
                setForm((current) => ({
                  ...current,
                  constructionApplicantId: candidate?.id || '',
                  constructionApplicantName: candidate?.name || '',
                }))
              }
            />
            <p className="mt-1 text-xs text-slate-500">
              培训照片、挂牌隔离、过程反馈请在“施工跟进”里填写。
            </p>
          </Field>
          <Field
            label="申请材料"
            className="md:col-span-2"
            required
            asLabel={false}
          >
            <FileGrid
              fields={APPLICATION_FILE_FIELDS}
              files={files}
              requiredKeys={APPLICATION_REQUIRED_FILE_KEYS}
              onFilesChange={setFiles}
            />
          </Field>
        </div>
        <DialogFooter className="shrink-0 border-t border-slate-100 bg-slate-50 px-5 py-4">
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
            disabled={submitting}
            onClick={() => void handleSubmit()}
            className="bg-blue-600 text-white hover:bg-blue-700"
          >
            {submitting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <UploadCloud className="h-4 w-4" />
            )}
            提交施工申请
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ConstructionChangeOrderSelect({
  valueId,
  valueName,
  disabled = false,
  onChange,
}: {
  valueId: string;
  valueName: string;
  disabled?: boolean;
  onChange: (candidate: ConstructionChangeOrderCandidate | null) => void;
}) {
  const [query, setQuery] = useState(valueName);
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<ConstructionChangeOrderCandidate[]>([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (valueId && valueName && query !== valueName) {
      setQuery(valueName);
    }
  }, [query, valueId, valueName]);

  useEffect(() => {
    if (disabled || (!open && !query.trim())) {
      return undefined;
    }

    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setLoading(true);
      setMessage('');
      searchConstructionChangeOrders(query.trim(), controller.signal)
        .then((response) => {
          if (controller.signal.aborted) return;
          setItems(response.items);
          setMessage(
            response.configured
              ? response.message || ''
              : response.message || '施工关联变更单多维表待配置',
          );
        })
        .catch((error) => {
          if (controller.signal.aborted) return;
          setItems([]);
          setMessage(getErrorMessage(error, '施工关联变更单加载失败'));
        })
        .finally(() => {
          if (!controller.signal.aborted) {
            setLoading(false);
          }
        });
    }, 220);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [disabled, open, query]);

  return (
    <div className="relative">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
        <Input
          value={query}
          disabled={disabled}
          onFocus={() => setOpen(true)}
          onBlur={() => window.setTimeout(() => setOpen(false), 150)}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
            if (valueId) {
              onChange(null);
            }
          }}
          placeholder="搜索变更编码、描述、楼栋、专业"
          className="border-slate-200 bg-slate-50 pl-9 focus-visible:ring-blue-200"
        />
      </div>

      {open && (
        <div className="absolute z-50 mt-1 max-h-80 w-full overflow-auto rounded-lg border border-slate-200 bg-white shadow-lg">
          {loading ? (
            <div className="flex items-center gap-2 px-3 py-3 text-sm text-slate-500">
              <Loader2 className="h-4 w-4 animate-spin text-blue-500" />
              正在从变更单视图加载
            </div>
          ) : items.length > 0 ? (
            items.map((item) => (
              <button
                key={item.id}
                type="button"
                onMouseDown={(event) => {
                  event.preventDefault();
                  onChange(item);
                  setQuery(item.title);
                  setOpen(false);
                }}
                onClick={(event) => {
                  event.preventDefault();
                  onChange(item);
                  setQuery(item.title);
                  setOpen(false);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    onChange(item);
                    setQuery(item.title);
                    setOpen(false);
                  }
                }}
                className={cn(
                  'flex w-full items-start justify-between gap-3 border-b border-slate-100 px-3 py-2 text-left text-sm transition last:border-b-0 hover:bg-blue-50/70',
                  valueId === item.id && 'bg-blue-50 text-blue-700',
                )}
              >
                <span className="min-w-0">
                  <span className="block truncate font-semibold">
                    {item.title}
                  </span>
                  <span className="mt-0.5 block truncate text-xs text-slate-500">
                    {[
                      formatDateRange(item.planStartTime, item.planEndTime),
                      item.buildings.join('/'),
                      item.specialties.join('/'),
                      item.level,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </span>
                {(item.progress || item.status) && (
                  <span className="shrink-0 rounded-md border border-slate-200 bg-white px-2 py-0.5 text-[11px] text-slate-500">
                    {item.progress || item.status}
                  </span>
                )}
              </button>
            ))
          ) : (
            <div className="px-3 py-3 text-sm text-slate-500">
              {message || '未找到匹配的变更单'}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ConstructionStaffSelect({
  valueId,
  valueName,
  disabled = false,
  onChange,
}: {
  valueId: string;
  valueName: string;
  disabled?: boolean;
  onChange: (candidate: ConstructionStaffCandidate | null) => void;
}) {
  const [query, setQuery] = useState(valueName);
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<ConstructionStaffCandidate[]>([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (valueId && valueName && query !== valueName) {
      setQuery(valueName);
    }
  }, [query, valueId, valueName]);

  useEffect(() => {
    if (disabled || (!open && !query.trim())) {
      return undefined;
    }

    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setLoading(true);
      setMessage('');
      searchConstructionOnsiteFollowers(query.trim(), controller.signal)
        .then((response) => {
          if (controller.signal.aborted) return;
          setItems(response.items);
          setMessage(
            response.configured
              ? response.message || ''
              : response.message || '施工申请人在职人员视图待配置',
          );
        })
        .catch((error) => {
          if (controller.signal.aborted) return;
          setItems([]);
          setMessage(getErrorMessage(error, '施工申请人加载失败'));
        })
        .finally(() => {
          if (!controller.signal.aborted) {
            setLoading(false);
          }
        });
    }, 220);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [disabled, open, query]);

  return (
    <div className="relative">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
        <Input
          value={query}
          disabled={disabled}
          onFocus={() => setOpen(true)}
          onBlur={() => window.setTimeout(() => setOpen(false), 150)}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
            if (valueId) {
              onChange(null);
            }
          }}
          placeholder="搜索在职人员姓名、岗位、机楼"
          className="border-slate-200 bg-slate-50 pl-9 focus-visible:ring-blue-200"
        />
      </div>

      {open && (
        <div className="absolute z-50 mt-1 max-h-72 w-full overflow-auto rounded-lg border border-slate-200 bg-white shadow-lg">
          {loading ? (
            <div className="flex items-center gap-2 px-3 py-3 text-sm text-slate-500">
              <Loader2 className="h-4 w-4 animate-spin text-blue-500" />
              正在从在职人员视图加载
            </div>
          ) : items.length > 0 ? (
            items.map((item) => (
              <button
                key={item.id}
                type="button"
                onMouseDown={(event) => {
                  event.preventDefault();
                  onChange(item);
                  setQuery(item.name);
                  setOpen(false);
                }}
                onClick={(event) => {
                  event.preventDefault();
                  onChange(item);
                  setQuery(item.name);
                  setOpen(false);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    onChange(item);
                    setQuery(item.name);
                    setOpen(false);
                  }
                }}
                className={cn(
                  'flex w-full items-start justify-between gap-3 border-b border-slate-100 px-3 py-2 text-left text-sm transition last:border-b-0 hover:bg-blue-50/70',
                  valueId === item.id && 'bg-blue-50 text-blue-700',
                )}
              >
                <span className="min-w-0">
                  <span className="block truncate font-semibold">
                    {item.name}
                  </span>
                  <span className="mt-0.5 block truncate text-xs text-slate-500">
                    {[
                      item.position,
                      item.buildingSpecialties.join(' / '),
                      item.team,
                    ]
                      .filter(Boolean)
                      .join(' · ') || '在职人员'}
                  </span>
                </span>
                {item.onDutyToday && (
                  <span className="shrink-0 rounded-md border border-slate-200 bg-white px-2 py-0.5 text-[11px] text-slate-500">
                    今日{item.onDutyToday}
                  </span>
                )}
              </button>
            ))
          ) : (
            <div className="px-3 py-3 text-sm text-slate-500">
              {message || '未找到匹配的在职人员'}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ConstructionStaffMultiSelect({
  values,
  disabled = false,
  onChange,
}: {
  values: ConstructionStaffCandidate[];
  disabled?: boolean;
  onChange: (values: ConstructionStaffCandidate[]) => void;
}) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<ConstructionStaffCandidate[]>([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const selectedIds = useMemo(
    () => new Set(values.map((item) => item.id)),
    [values],
  );
  const handleSelect = (item: ConstructionStaffCandidate) => {
    if (selectedIds.has(item.id)) {
      return;
    }
    onChange([...values, item]);
    setQuery('');
    setOpen(false);
  };

  useEffect(() => {
    if (disabled || (!open && !query.trim())) {
      return undefined;
    }

    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setLoading(true);
      setMessage('');
      searchConstructionOnsiteFollowers(query.trim(), controller.signal)
        .then((response) => {
          if (controller.signal.aborted) return;
          setItems(response.items.filter((item) => !selectedIds.has(item.id)));
          setMessage(
            response.configured
              ? response.message || ''
              : response.message || '在职人员视图待配置',
          );
        })
        .catch((error) => {
          if (controller.signal.aborted) return;
          setItems([]);
          setMessage(getErrorMessage(error, '跟进人员加载失败'));
        })
        .finally(() => {
          if (!controller.signal.aborted) {
            setLoading(false);
          }
        });
    }, 220);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [disabled, open, query, selectedIds]);

  return (
    <div className="grid gap-2">
      {values.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {values.map((item) => (
            <span
              key={item.id}
              className="inline-flex max-w-full items-center gap-1 rounded-md border border-blue-100 bg-blue-50 px-2 py-1 text-xs font-medium text-blue-700"
            >
              <span className="truncate">{item.name}</span>
              <button
                type="button"
                disabled={disabled}
                onClick={() =>
                  onChange(values.filter((value) => value.id !== item.id))
                }
                className="rounded-sm p-0.5 text-blue-500 transition hover:bg-blue-100 hover:text-blue-700 disabled:opacity-50"
                aria-label={`移除${item.name}`}
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="relative">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <Input
            value={query}
            disabled={disabled}
            onFocus={() => setOpen(true)}
            onBlur={() => window.setTimeout(() => setOpen(false), 150)}
            onChange={(event) => {
              setQuery(event.target.value);
              setOpen(true);
            }}
            placeholder="搜索并添加在职跟进人员"
            className="border-slate-200 bg-slate-50 pl-9 focus-visible:ring-blue-200"
          />
        </div>

        {open && (
          <div className="absolute z-50 mt-1 max-h-72 w-full overflow-auto rounded-lg border border-slate-200 bg-white shadow-lg">
            {loading ? (
              <div className="flex items-center gap-2 px-3 py-3 text-sm text-slate-500">
                <Loader2 className="h-4 w-4 animate-spin text-blue-500" />
                正在从在职人员视图加载
              </div>
            ) : items.length > 0 ? (
              items.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onMouseDown={(event) => {
                    event.preventDefault();
                    handleSelect(item);
                  }}
                  onClick={(event) => event.preventDefault()}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      handleSelect(item);
                    }
                  }}
                  className="flex w-full items-start justify-between gap-3 border-b border-slate-100 px-3 py-2 text-left text-sm transition last:border-b-0 hover:bg-blue-50/70"
                >
                  <span className="min-w-0">
                    <span className="block truncate font-semibold">
                      {item.name}
                    </span>
                    <span className="mt-0.5 block truncate text-xs text-slate-500">
                      {[
                        item.position,
                        item.buildingSpecialties.join(' / '),
                        item.team,
                      ]
                        .filter(Boolean)
                        .join(' · ') || '在职人员'}
                    </span>
                  </span>
                  {item.onDutyToday && (
                    <span className="shrink-0 rounded-md border border-slate-200 bg-white px-2 py-0.5 text-[11px] text-slate-500">
                      今日{item.onDutyToday}
                    </span>
                  )}
                </button>
              ))
            ) : (
              <div className="px-3 py-3 text-sm text-slate-500">
                {message || '未找到可添加的在职人员'}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function FollowupDialog({
  open,
  submitting,
  items,
  imageAuditStatus,
  constructionAiAuditEnabled,
  manualReviewAutoApproved,
  form,
  dailyChecklistFocus,
  files,
  removedExistingFileTokens,
  permitUploadingKey,
  manualReviewRefreshing,
  dailyPermitReferenceDate,
  pendingManualReviews,
  pendingManualReviewCount,
  allowAttachmentDelete,
  onOpenChange,
  onFormChange,
  onFilesChange,
  onUpdateCrewAuthorization,
  onRemovedExistingFileTokensChange,
  onSubmit,
  onGeneratedFileSubmit,
  onAttachmentDeleteStart,
  onAttachmentDeleteFailure,
  onAttachmentDeleted,
  onSubmitPendingManualReviews,
  onPermitUpload,
  onRefreshPermitData,
  onRefreshIsolationAuditData,
  onRequestManualReview,
  onRequestIsolationManualReview,
}: {
  open: boolean;
  submitting: boolean;
  items: ConstructionOverviewItem[];
  imageAuditStatus?: ConstructionImageAuditStatus;
  constructionAiAuditEnabled: boolean;
  manualReviewAutoApproved: boolean;
  form: FollowupFormState;
  dailyChecklistFocus: DailyChecklistActionKind | null;
  files: FileBucket;
  removedExistingFileTokens: ExistingFileTokenMap;
  permitUploadingKey?: string | null;
  manualReviewRefreshing?: boolean;
  dailyPermitReferenceDate: Date;
  pendingManualReviews: readonly PendingManualReviewItem[];
  pendingManualReviewCount: number;
  allowAttachmentDelete: boolean;
  onOpenChange: (open: boolean) => void;
  onFormChange: React.Dispatch<React.SetStateAction<FollowupFormState>>;
  onFilesChange: React.Dispatch<React.SetStateAction<FileBucket>>;
  onUpdateCrewAuthorization: (item: ConstructionOverviewItem) => void;
  onRemovedExistingFileTokensChange: React.Dispatch<
    React.SetStateAction<ExistingFileTokenMap>
  >;
  onSubmit: () => void;
  onGeneratedFileSubmit: (fieldKey: string, file: File) => Promise<boolean>;
  onAttachmentDeleteStart: (tombstone: ConstructionAttachmentTombstone) => void;
  onAttachmentDeleteFailure: (
    tombstone: ConstructionAttachmentTombstone,
  ) => void;
  onAttachmentDeleted: () => void | Promise<void>;
  onSubmitPendingManualReviews: () => void | Promise<void>;
  onPermitUpload: (
    verification: DailyPermitVerification,
    selectedFiles: File[],
  ) => void | Promise<void>;
  onRefreshPermitData: () => void | Promise<void>;
  onRefreshIsolationAuditData: () => void | Promise<void>;
  onRequestManualReview: (
    verification: DailyPermitVerification,
    followupRecordId: string | null,
    decision: ConstructionPermitManualReviewDecision,
    validFrom: string | null,
    validUntil: string | null,
  ) => void | Promise<void>;
  onRequestIsolationManualReview: (
    followupRecordId: string | null,
    decision: ConstructionPermitManualReviewDecision,
  ) => void | Promise<void>;
}) {
  const submitPending = submitting || manualReviewRefreshing;
  const submitPendingLabel =
    dailyChecklistFocus === 'workType'
      ? '正在提交作业类型校核'
      : dailyChecklistFocus === 'permit'
        ? '正在提交作业票校核'
        : '正在提交';
  const selectedAnyConstruction = useMemo(
    () =>
      items.find((item) => item.recordId === form.constructionRecordId) || null,
    [form.constructionRecordId, items],
  );
  const dailyFollowupLockedForSelected = Boolean(
    selectedAnyConstruction &&
    !isDailyFollowupOpenForProject(
      selectedAnyConstruction,
      constructionAiAuditEnabled,
    ),
  );
  const selectableItems = useMemo(
    () =>
      getFollowupProjectOptions(
        items,
        form.followupMode,
        constructionAiAuditEnabled,
      ),
    [constructionAiAuditEnabled, form.followupMode, items],
  );
  const selectedConstruction = useMemo(
    () =>
      selectableItems.find(
        (item) => item.recordId === form.constructionRecordId,
      ) || null,
    [form.constructionRecordId, selectableItems],
  );
  const [workApplicationOnlineFormTarget, setWorkApplicationOnlineFormTarget] =
    useState<OnlineWorkFormTarget | null>(null);
  const [workApplicationOnlineFormDrafts, setWorkApplicationOnlineFormDrafts] =
    useState<Record<string, OnlineWorkFormDraft>>({});
  const [generatedOnlineFormFiles, setGeneratedOnlineFormFiles] = useState<
    Record<string, ConstructionAttachmentFile[]>
  >({});
  const generatedOnlineFormMutationIdsRef = useRef(new Map<string, string>());
  const attachmentDeleteMutationKeysRef = useRef(new Set<string>());
  const crewMembers = selectedConstruction?.crewMembers || [];
  const crewAuthorizationSummary = useMemo(
    () => getConstructionCrewAuthorizationSummary(crewMembers),
    [crewMembers],
  );
  const authorizedCrewRecordIds = useMemo(
    () =>
      new Set(
        crewAuthorizationSummary.authorizedMembers.map(
          (member) => member.recordId,
        ),
      ),
    [crewAuthorizationSummary.authorizedMembers],
  );
  const checkedCrewIds = useMemo(
    () =>
      new Set(
        form.dailyCrewRecordIds.filter((recordId) =>
          authorizedCrewRecordIds.has(recordId),
        ),
      ),
    [authorizedCrewRecordIds, form.dailyCrewRecordIds],
  );
  const handleDailyWorkTypesChange = useCallback(
    (workTypes: string[]) => {
      onFormChange((current) => ({
        ...current,
        workTypes,
      }));
    },
    [onFormChange],
  );
  const handleFollowupStaffMembersChange = useCallback(
    (followupStaffMembers: ConstructionStaffCandidate[]) => {
      onFormChange((current) => ({
        ...current,
        followupStaffMembers,
      }));
    },
    [onFormChange],
  );
  const handleCrewToggle = useCallback(
    (recordId: string) => {
      if (!authorizedCrewRecordIds.has(recordId)) {
        return;
      }
      onFormChange((current) => ({
        ...current,
        dailyCrewRecordIds: current.dailyCrewRecordIds.includes(recordId)
          ? current.dailyCrewRecordIds.filter((id) => id !== recordId)
          : [...current.dailyCrewRecordIds, recordId],
      }));
    },
    [authorizedCrewRecordIds, onFormChange],
  );
  const handleCrewCheckAll = useCallback(() => {
    onFormChange((current) => ({
      ...current,
      dailyCrewRecordIds: crewAuthorizationSummary.authorizedMembers.map(
        (member) => member.recordId,
      ),
    }));
  }, [crewAuthorizationSummary.authorizedMembers, onFormChange]);
  const handleCrewClear = useCallback(() => {
    onFormChange((current) => ({
      ...current,
      dailyCrewRecordIds: [],
    }));
  }, [onFormChange]);
  const handleCrewAuthorizationUpdate = useCallback(() => {
    if (!selectedConstruction) {
      return;
    }
    onOpenChange(false);
    onUpdateCrewAuthorization(selectedConstruction);
  }, [onOpenChange, onUpdateCrewAuthorization, selectedConstruction]);
  const dailyProgress = useMemo(
    () =>
      getDailyFollowupStageProgress(
        selectedConstruction,
        dailyPermitReferenceDate,
        constructionAiAuditEnabled,
      ),
    [
      constructionAiAuditEnabled,
      dailyPermitReferenceDate,
      selectedConstruction,
    ],
  );
  const completionChecklistItems = useMemo(
    () =>
      form.completed
        ? getCompletionChecklistItemsForStatus(form.completed)
        : [],
    [form.completed],
  );
  const currentStageFollowup = useMemo(
    () =>
      form.followupMode === 'daily'
        ? getDailyFollowupForStage(
            selectedConstruction,
            form.dailyFollowupStage,
            dailyPermitReferenceDate,
          )
        : null,
    [
      dailyPermitReferenceDate,
      form.dailyFollowupStage,
      form.followupMode,
      selectedConstruction,
    ],
  );
  const todayDailyFollowup = useMemo(
    () =>
      form.followupMode === 'daily'
        ? getTodayDailyFollowup(selectedConstruction, dailyPermitReferenceDate)
        : null,
    [dailyPermitReferenceDate, form.followupMode, selectedConstruction],
  );
  const activeDailyFollowup = currentStageFollowup || todayDailyFollowup;
  const currentInitialFollowup = useMemo(
    () =>
      form.followupMode === 'supplemental'
        ? getInitialApplicationFollowup(selectedConstruction)
        : null,
    [form.followupMode, selectedConstruction],
  );
  const latestGeneratedApplicationFollowup = useMemo(
    () =>
      form.followupMode === 'supplemental'
        ? getLatestGeneratedWorkApplicationFollowup(
            selectedConstruction,
            dailyPermitReferenceDate,
          )
        : null,
    [dailyPermitReferenceDate, form.followupMode, selectedConstruction],
  );
  const showDepositDetailFields = shouldShowDepositDetailFields(
    form.depositPaid,
  );
  const [specialMaterialWorkType, setSpecialMaterialWorkType] = useState<
    string | null
  >(null);
  const [
    cancelledSpecialMaterialWorkTypes,
    setCancelledSpecialMaterialWorkTypes,
  ] = useState<string[]>([]);
  const specialMaterialGroup = specialMaterialWorkType
    ? getSpecialWorkTypeMaterialGroup(specialMaterialWorkType)
    : null;

  useEffect(() => {
    if (!open || form.followupMode !== 'supplemental') {
      setSpecialMaterialWorkType(null);
      setCancelledSpecialMaterialWorkTypes([]);
    }
  }, [form.followupMode, open]);

  useEffect(() => {
    setCancelledSpecialMaterialWorkTypes([]);
  }, [form.constructionRecordId, form.followupRecordId]);

  const clearGeneratedOnlineFormFiles = useCallback(() => {
    generatedOnlineFormMutationIdsRef.current.clear();
    setGeneratedOnlineFormFiles((current) => {
      revokeGeneratedOnlineFormFileUrls(current);
      return {};
    });
  }, []);

  useEffect(() => {
    if (!open) {
      clearGeneratedOnlineFormFiles();
    }
  }, [clearGeneratedOnlineFormFiles, open]);

  useEffect(() => {
    clearGeneratedOnlineFormFiles();
  }, [
    clearGeneratedOnlineFormFiles,
    form.constructionRecordId,
    form.followupMode,
    form.followupRecordId,
  ]);

  const removeSpecialMaterialWorkType = useCallback(
    (workType: string) => {
      const group = getSpecialWorkTypeMaterialGroup(workType);
      onFormChange((current) => ({
        ...current,
        workTypes: current.workTypes.filter((item) => item !== workType),
      }));
      if (group) {
        if (form.followupMode === 'supplemental') {
          setCancelledSpecialMaterialWorkTypes((current) =>
            current.includes(workType) ? current : [...current, workType],
          );
        }
        onFilesChange((currentFiles) =>
          omitFileBucketKeys(
            currentFiles,
            group.fields.map((field) => field[0]),
          ),
        );
      }
      setSpecialMaterialWorkType(null);
    },
    [form.followupMode, onFilesChange, onFormChange],
  );

  useEffect(() => {
    if (
      !open ||
      form.followupMode !== 'daily' ||
      !dailyFollowupLockedForSelected ||
      !selectedAnyConstruction
    ) {
      return;
    }

    onFormChange((current) => {
      if (
        current.followupMode !== 'daily' ||
        current.constructionRecordId !== selectedAnyConstruction.recordId
      ) {
        return current;
      }

      const base: FollowupFormState = {
        ...current,
        followupMode: 'supplemental',
        constructionRecordId: selectedAnyConstruction.recordId,
      };

      return applyInitialApplicationFollowupForm(
        base,
        selectedAnyConstruction,
        getInitialApplicationFollowup(selectedAnyConstruction),
      );
    });
    onFilesChange({});
  }, [
    dailyFollowupLockedForSelected,
    form.constructionRecordId,
    form.followupMode,
    onFilesChange,
    onFormChange,
    open,
    selectedAnyConstruction,
  ]);

  const rawExistingFiles = useMemo(() => {
    let nextExistingFiles: Record<string, ConstructionAttachmentFile[]> = {};
    if (
      form.followupMode === 'daily' &&
      activeDailyFollowup?.recordId === form.followupRecordId
    ) {
      nextExistingFiles =
        buildExistingDailyFollowupFileMap(activeDailyFollowup);
    } else if (form.followupMode === 'supplemental') {
      if (currentInitialFollowup) {
        nextExistingFiles = buildExistingDailyFollowupFileMap(
          currentInitialFollowup,
        );
      }
      if (latestGeneratedApplicationFollowup) {
        const latestGeneratedApplicationFiles =
          buildExistingDailyFollowupFileMap(latestGeneratedApplicationFollowup)
            .applicationFiles || [];
        if (latestGeneratedApplicationFiles.length > 0) {
          nextExistingFiles = {
            ...nextExistingFiles,
            applicationFiles: latestGeneratedApplicationFiles,
          };
        }
      }
    }
    if (
      form.followupMode === 'supplemental' &&
      selectedConstruction?.constructionIssues?.length
    ) {
      nextExistingFiles = {
        ...nextExistingFiles,
        constructionIssueFiles: selectedConstruction.constructionIssues,
      };
    }
    if (
      form.followupMode === 'supplemental' &&
      selectedConstruction &&
      showDepositDetailFields
    ) {
      nextExistingFiles = {
        ...nextExistingFiles,
        depositAgreementFiles: selectedConstruction.depositAgreementFiles || [],
        depositTransferFiles: selectedConstruction.depositTransferFiles || [],
      };
    }
    return nextExistingFiles;
  }, [
    activeDailyFollowup,
    currentInitialFollowup,
    form.followupMode,
    form.followupRecordId,
    latestGeneratedApplicationFollowup,
    selectedConstruction,
    showDepositDetailFields,
  ]);
  const visibleExistingFiles = useMemo(
    () =>
      getVisibleSpecialWorkTypeExistingFiles(
        rawExistingFiles,
        cancelledSpecialMaterialWorkTypes,
      ),
    [cancelledSpecialMaterialWorkTypes, rawExistingFiles],
  );
  const existingFiles = useMemo(() => {
    const retainedFiles = filterExistingFileMapByRemovedTokens(
      visibleExistingFiles,
      removedExistingFileTokens,
    );
    return mergeGeneratedOnlineFormFileMap(
      retainedFiles,
      generatedOnlineFormFiles,
    );
  }, [
    generatedOnlineFormFiles,
    removedExistingFileTokens,
    visibleExistingFiles,
  ]);
  const dailySpecialMaterialExistingFiles = useMemo(
    () =>
      form.followupMode === 'daily'
        ? filterExistingFileMapByRemovedTokens(
            buildProjectSpecialWorkTypeMaterialFileMap(selectedConstruction),
            removedExistingFileTokens,
          )
        : {},
    [form.followupMode, removedExistingFileTokens, selectedConstruction],
  );
  const specialMaterialDialogExistingFiles = useMemo(
    () =>
      form.followupMode === 'daily'
        ? mergeExistingFileMaps(
            dailySpecialMaterialExistingFiles,
            existingFiles,
          )
        : existingFiles,
    [dailySpecialMaterialExistingFiles, existingFiles, form.followupMode],
  );
  const followupFieldStatusHints = useMemo<
    Partial<Record<string, FileFieldStatusHint>>
  >(() => {
    const applicationFilesHint = getWorkApplicationFileStatusHint({
      followup:
        latestGeneratedApplicationFollowup ||
        currentInitialFollowup ||
        getInitialApplicationFollowup(selectedConstruction),
      files,
      existingFiles,
      referenceDate: dailyPermitReferenceDate,
      constructionAiAuditEnabled,
    });
    return applicationFilesHint
      ? { applicationFiles: applicationFilesHint }
      : {};
  }, [
    currentInitialFollowup,
    constructionAiAuditEnabled,
    dailyPermitReferenceDate,
    existingFiles,
    files,
    latestGeneratedApplicationFollowup,
    selectedConstruction,
  ]);
  const dailyPermitWorkTypes = useMemo(
    () =>
      form.followupMode === 'daily'
        ? form.workTypes.filter((workType) => {
            const group = getSpecialWorkTypeMaterialGroup(workType);
            return (
              !group ||
              isSpecialWorkTypeMaterialComplete(
                group,
                files,
                specialMaterialDialogExistingFiles,
              )
            );
          })
        : [],
    [
      files,
      form.followupMode,
      form.workTypes,
      specialMaterialDialogExistingFiles,
    ],
  );
  const dailyPermitVerifications = useMemo(
    () =>
      form.followupMode === 'daily'
        ? getDailyPermitVerifications(
            selectedConstruction,
            dailyPermitReferenceDate,
            dailyPermitWorkTypes,
            constructionAiAuditEnabled,
          )
        : [],
    [
      dailyPermitReferenceDate,
      dailyPermitWorkTypes,
      form.followupMode,
      constructionAiAuditEnabled,
      selectedConstruction,
    ],
  );
  const activeDailyChecklistFocus =
    form.followupMode === 'daily' ? dailyChecklistFocus : null;
  const showFullDailyFollowup =
    form.followupMode !== 'daily' || activeDailyChecklistFocus === null;
  const showDailyStageStepper =
    form.followupMode === 'daily' && showFullDailyFollowup;
  const showDailyWorkTypeAudit =
    form.followupMode === 'daily' &&
    (showFullDailyFollowup || activeDailyChecklistFocus === 'workType');
  const showDailyPermitVerification =
    form.followupMode === 'daily' &&
    (showFullDailyFollowup || activeDailyChecklistFocus === 'permit');
  const showDailyConstructionIssues =
    form.followupMode === 'daily' && showFullDailyFollowup;
  const showDailyIsolationAuditNotice =
    form.followupMode === 'daily' &&
    form.dailyFollowupStage === 'prepare' &&
    (showFullDailyFollowup || activeDailyChecklistFocus === 'isolation');
  const showDailyFollowupStaff =
    form.followupMode === 'daily' &&
    (showFullDailyFollowup || activeDailyChecklistFocus === 'personnel');
  const showDailyPersonnelCheck =
    form.followupMode === 'daily' &&
    form.dailyFollowupStage === 'prepare' &&
    (showFullDailyFollowup || activeDailyChecklistFocus === 'personnel');
  const showDailyProcessFeedback =
    form.followupMode === 'daily' &&
    form.dailyFollowupStage === 'process' &&
    (showFullDailyFollowup || activeDailyChecklistFocus === 'processPhoto');
  const showDailyCloseStatus =
    form.followupMode === 'daily' &&
    form.dailyFollowupStage === 'close' &&
    (showFullDailyFollowup ||
      activeDailyChecklistFocus === 'closeChecklist' ||
      activeDailyChecklistFocus === 'closePhoto');
  const showDailyCompletionChecklist =
    form.followupMode === 'daily' &&
    form.dailyFollowupStage === 'close' &&
    (showFullDailyFollowup ||
      activeDailyChecklistFocus === 'closeChecklist' ||
      activeDailyChecklistFocus === 'closePhoto');
  const focusedDailyFileFields =
    form.followupMode === 'daily'
      ? getDailyFollowupFileFieldsForFocus(
          form.dailyFollowupStage,
          dailyPermitVerifications,
          activeDailyChecklistFocus,
        )
      : [];
  const focusedDailyRequiredFileKeys =
    form.followupMode === 'daily'
      ? getDailyFollowupRequiredFileKeysForFocus(
          form.dailyFollowupStage,
          dailyPermitVerifications,
          activeDailyChecklistFocus,
        )
      : [];

  const submitGeneratedOnlineFormOptimistically = useCallback(
    (fieldKey: string, file: File, closeDialog: () => void) => {
      if (generatedOnlineFormMutationIdsRef.current.has(fieldKey)) {
        toast.info('该在线表单正在回填，请勿重复生成');
        return;
      }
      const mutationId = createConstructionClientMutationId();
      generatedOnlineFormMutationIdsRef.current.set(fieldKey, mutationId);
      setGeneratedOnlineFormFiles((current) =>
        replaceGeneratedOnlineFormFile(current, fieldKey, file),
      );
      closeDialog();

      const settleFailedMutation = () => {
        if (
          generatedOnlineFormMutationIdsRef.current.get(fieldKey) !== mutationId
        ) {
          return;
        }
        generatedOnlineFormMutationIdsRef.current.delete(fieldKey);
        setGeneratedOnlineFormFiles((current) =>
          rollbackGeneratedOnlineFormFile(current, fieldKey),
        );
      };

      void Promise.resolve(onGeneratedFileSubmit(fieldKey, file))
        .then((success) => {
          if (!success) {
            settleFailedMutation();
            return;
          }
          if (
            generatedOnlineFormMutationIdsRef.current.get(fieldKey) ===
            mutationId
          ) {
            generatedOnlineFormMutationIdsRef.current.delete(fieldKey);
          }
        }, settleFailedMutation)
        .catch(settleFailedMutation);
    },
    [onGeneratedFileSubmit],
  );

  const removeExistingFile = useCallback(
    async (fieldKey: string, fileToken: string) => {
      if (!allowAttachmentDelete) {
        toast.error('当前权限不能删除附件');
        return;
      }
      if (!fileToken) {
        return;
      }
      const applyLocalRemoval = () =>
        onRemovedExistingFileTokensChange((current) => {
          const nextTokens = new Set(current[fieldKey] || []);
          nextTokens.add(fileToken);
          return {
            ...current,
            [fieldKey]: Array.from(nextTokens),
          };
        });
      const rollbackLocalRemoval = () =>
        onRemovedExistingFileTokensChange((current) => {
          const nextTokens = new Set(current[fieldKey] || []);
          nextTokens.delete(fileToken);
          return {
            ...current,
            [fieldKey]: Array.from(nextTokens),
          };
        });
      const deleteTarget = getConstructionAttachmentDeleteTarget(
        selectedConstruction,
        fieldKey,
        fileToken,
      );
      if (!deleteTarget) {
        toast.error('未找到该附件对应的多维表记录，无法删除');
        return;
      }
      const tombstone: ConstructionAttachmentTombstone = {
        ...deleteTarget,
        fieldKey,
        fileToken,
      };
      const mutationKey = [deleteTarget.recordId, fieldKey, fileToken].join(
        ':',
      );
      if (attachmentDeleteMutationKeysRef.current.has(mutationKey)) {
        toast.info('该附件正在删除，请勿重复操作');
        return;
      }
      attachmentDeleteMutationKeysRef.current.add(mutationKey);
      onAttachmentDeleteStart(tombstone);
      applyLocalRemoval();
      try {
        const result = await deleteConstructionAttachment({
          ...deleteTarget,
          fieldKey,
          fileToken,
        });
        toast.success(result.message || '附件已从多维表删除');
        void onAttachmentDeleted();
      } catch (err) {
        onAttachmentDeleteFailure(tombstone);
        rollbackLocalRemoval();
        toast.error(getErrorMessage(err, '删除多维表附件失败'));
      } finally {
        attachmentDeleteMutationKeysRef.current.delete(mutationKey);
      }
    },
    [
      allowAttachmentDelete,
      onAttachmentDeleteFailure,
      onAttachmentDeleteStart,
      onAttachmentDeleted,
      onRemovedExistingFileTokensChange,
      selectedConstruction,
    ],
  );

  useEffect(() => {
    if (!open || !['daily', 'supplemental'].includes(form.followupMode)) {
      return;
    }
    const materialExistingFiles =
      form.followupMode === 'daily'
        ? specialMaterialDialogExistingFiles
        : existingFiles;
    onFormChange((current) => {
      if (current.followupMode !== form.followupMode) {
        return current;
      }
      const nextWorkTypes = current.workTypes.filter((workType) => {
        const group = getSpecialWorkTypeMaterialGroup(workType);
        return (
          !group ||
          isSpecialWorkTypeMaterialComplete(group, files, materialExistingFiles)
        );
      });
      return nextWorkTypes.length === current.workTypes.length
        ? current
        : { ...current, workTypes: nextWorkTypes };
    });
  }, [
    existingFiles,
    files,
    form.followupMode,
    onFormChange,
    open,
    specialMaterialDialogExistingFiles,
  ]);

  const confirmSpecialMaterialWorkType = useCallback(
    (workType: string) => {
      const group = getSpecialWorkTypeMaterialGroup(workType);
      if (
        !group ||
        !isSpecialWorkTypeMaterialComplete(
          group,
          files,
          specialMaterialDialogExistingFiles,
        )
      ) {
        return;
      }
      onFormChange((current) =>
        current.workTypes.includes(workType)
          ? current
          : { ...current, workTypes: [...current.workTypes, workType] },
      );
      setCancelledSpecialMaterialWorkTypes((current) =>
        current.filter((item) => item !== workType),
      );
      setSpecialMaterialWorkType(null);
    },
    [files, onFormChange, specialMaterialDialogExistingFiles],
  );
  const isolationPhotoAuditSummary =
    constructionAiAuditEnabled &&
    form.followupMode === 'daily' &&
    form.dailyFollowupStage === 'prepare'
      ? buildDailyIsolationAuditSummary(
          getFollowupIsolationAuditFeedback(activeDailyFollowup),
        )
      : null;
  const dailyFollowupFieldActions =
    form.followupMode === 'daily' && form.dailyFollowupStage === 'prepare'
      ? {
          isolationPhotoFiles: (
            <DailyIsolationPhotoAuditAction
              summary={isolationPhotoAuditSummary}
              constructionAiAuditEnabled={constructionAiAuditEnabled}
              manualReviewAutoApproved={manualReviewAutoApproved}
              manualDecision={activeDailyFollowup?.isolationCompliant || null}
              pendingDecision={getPendingIsolationManualReviewDecision(
                pendingManualReviews,
                activeDailyFollowup?.recordId || form.followupRecordId || null,
              )}
              followupRecordId={
                activeDailyFollowup?.recordId || form.followupRecordId || null
              }
              disabled={submitting}
              refreshing={manualReviewRefreshing}
              onRefresh={onRefreshIsolationAuditData}
              onRequestManualReview={onRequestIsolationManualReview}
            />
          ),
        }
      : {};
  const openWorkApplicationOnlineForm = useCallback(() => {
    const target = getOnlineWorkFormTarget(
      '施工申请',
      'applicationFiles',
      '施工作业申请单',
    );
    setWorkApplicationOnlineFormDrafts((current) => {
      const existing = current[target.fieldKey];
      if (
        existing?.values.formNo ===
        (selectedConstruction?.constructionCode || '')
      ) {
        return {
          ...current,
          [target.fieldKey]: {
            ...existing,
            people: createOnlineWorkFormPeopleFromCrewMembers(
              selectedConstruction?.crewMembers || [],
              existing.people,
            ),
          },
        };
      }
      const draft = createEmptyOnlineWorkFormDraft(target);
      const sourceCrewMembers = selectedConstruction?.crewMembers || [];
      const people =
        createOnlineWorkFormPeopleFromCrewMembers(sourceCrewMembers);
      const defaultWorkPartyLead =
        sourceCrewMembers.find(
          (member) =>
            member.name === (selectedConstruction?.managers?.applicant || ''),
        ) || null;
      return {
        ...current,
        [target.fieldKey]: {
          ...draft,
          people,
          values: {
            ...draft.values,
            formNo: selectedConstruction?.constructionCode || '',
            projectName: selectedConstruction?.workContent || '',
            contractor: selectedConstruction?.contractorType || '',
            workContent: selectedConstruction?.workContent || '',
            startDate: toOnlineDatetimeLocalValue(
              selectedConstruction?.planStartTime,
            ),
            endDate: toOnlineDatetimeLocalValue(
              selectedConstruction?.planEndTime,
            ),
            workPartyLeadId: defaultWorkPartyLead?.recordId || '',
            workPartyLead: defaultWorkPartyLead?.name || '',
            workPartyPhone: defaultWorkPartyLead?.phone || '',
            constructionCount: people.length ? String(people.length) : '',
            siteResponsibleId: '',
            siteResponsible:
              selectedConstruction?.managers?.safety ||
              selectedConstruction?.managers?.engineer ||
              '',
            building: selectedConstruction?.building || '',
            roomArea: selectedConstruction?.specialty || '',
            specialWorks: getWorkApplicationSpecialWorkValue(
              selectedConstruction?.workTypes || [],
            ),
            approver: selectedConstruction?.managers?.applicant || '',
            siteOwner: selectedConstruction?.managers?.applicant || '',
          },
        },
      };
    });
    setWorkApplicationOnlineFormTarget(target);
  }, [selectedConstruction]);
  const openEntryTrainingSignInOnlineForm = useCallback(() => {
    const target = getOnlineWorkFormTarget(
      '入场培训',
      'entryTrainingSignInFiles',
      '入场培训签到表',
    );
    setWorkApplicationOnlineFormDrafts((current) => {
      const existing = current[target.fieldKey];
      if (
        existing?.values.formNo ===
        (selectedConstruction?.constructionCode || '')
      ) {
        return {
          ...current,
          [target.fieldKey]: {
            ...existing,
            people: createOnlineWorkFormPeopleFromCrewMembers(
              selectedConstruction?.crewMembers || [],
              existing.people,
            ),
          },
        };
      }
      const draft = createEmptyOnlineWorkFormDraft(target);
      const people = createOnlineWorkFormPeopleFromCrewMembers(
        selectedConstruction?.crewMembers || [],
      );
      return {
        ...current,
        [target.fieldKey]: {
          ...draft,
          people,
          values: {
            ...draft.values,
            formNo: selectedConstruction?.constructionCode || '',
            projectName: '施工安全管理培训',
            contractor: selectedConstruction?.contractorType || '',
            workLocation: [
              selectedConstruction?.building,
              selectedConstruction?.specialty,
            ]
              .filter(Boolean)
              .join(' '),
            workContent: `施工作业安全管理相关内容${
              selectedConstruction?.workContent
                ? `（${selectedConstruction.workContent}）`
                : ''
            }`,
            startDate: toOnlineDatetimeLocalValue(
              selectedConstruction?.planStartTime,
            ),
            endDate: toOnlineDatetimeLocalValue(
              selectedConstruction?.planEndTime,
            ),
            trainer:
              selectedConstruction?.managers?.safety ||
              selectedConstruction?.managers?.engineer ||
              selectedConstruction?.managers?.applicant ||
              '',
          },
        },
      };
    });
    setWorkApplicationOnlineFormTarget(target);
  }, [selectedConstruction]);
  const followupFieldActions = {
    ...dailyFollowupFieldActions,
    ...(form.followupMode === 'supplemental'
      ? {
          applicationFiles: (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 border-emerald-200 bg-emerald-50 text-xs font-semibold text-emerald-700 hover:bg-emerald-100 hover:text-emerald-800"
              onClick={openWorkApplicationOnlineForm}
            >
              <PenLine className="h-3.5 w-3.5" />
              在线填表
            </Button>
          ),
          entryTrainingSignInFiles: (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 border-emerald-200 bg-emerald-50 text-xs font-semibold text-emerald-700 hover:bg-emerald-100 hover:text-emerald-800"
              onClick={openEntryTrainingSignInOnlineForm}
            >
              <PenLine className="h-3.5 w-3.5" />
              在线填表
            </Button>
          ),
        }
      : {}),
  };
  const applyDailyStage = (
    construction: ConstructionOverviewItem | null,
    dailyFollowupStage: DailyFollowupStage,
  ) => {
    const followup = getDailyFollowupForSubmission(
      construction,
      dailyFollowupStage,
      dailyPermitReferenceDate,
    );
    onFormChange((current) =>
      applyDailyFollowupStageForm(
        current,
        construction,
        dailyFollowupStage,
        followup,
        readDailyFollowupFormCache(
          construction?.recordId,
          dailyFollowupStage,
          dailyPermitReferenceDate,
        ),
        constructionAiAuditEnabled,
      ),
    );
    onFilesChange({});
  };
  const followupDialogTitle =
    form.followupMode === 'daily'
      ? getDailyChecklistFocusDialogTitle(
          activeDailyChecklistFocus,
          form.dailyFollowupStage,
        )
      : '施工跟进';
  const showFollowupModeTabs = !activeDailyChecklistFocus;

  return (
    <>
      <Dialog
        modal={!workApplicationOnlineFormTarget}
        open={open}
        onOpenChange={(next) => {
          if (submitting || workApplicationOnlineFormTarget) {
            return;
          }
          onOpenChange(next);
        }}
      >
        <DialogContent
          aria-describedby={undefined}
          className="flex max-h-[88vh] w-[calc(100vw-2rem)] max-w-3xl flex-col overflow-hidden p-0"
          showCloseButton={!submitting}
        >
          <DialogHeader className="shrink-0 border-b border-slate-100 bg-white/95 px-5 py-4 pr-12 shadow-[0_8px_22px_rgba(15,23,42,0.04)]">
            <DialogTitle className="flex items-center gap-2 text-base">
              <FileUp className="h-4 w-4 text-blue-600" />
              {followupDialogTitle}
            </DialogTitle>
          </DialogHeader>
          <div className="shrink-0 border-b border-slate-100 bg-white/95 px-5 py-4 shadow-[0_10px_24px_rgba(15,23,42,0.04)]">
            <div className="grid gap-4 md:grid-cols-2">
              {showFollowupModeTabs && (
                <div className="md:col-span-2 grid grid-cols-2 gap-2 rounded-lg border border-slate-200 bg-slate-50 p-1">
                  {[
                    ['daily', '每日跟进'],
                    ['supplemental', '初始申请&增量修正'],
                  ].map(([mode, label]) => {
                    const followupMode = mode as FollowupMode;
                    const modeDisabled =
                      mode === 'daily' && dailyFollowupLockedForSelected;
                    return (
                      <button
                        key={mode}
                        type="button"
                        disabled={modeDisabled}
                        title={
                          modeDisabled
                            ? '项目施工申请未闭环，暂不可每日跟进'
                            : undefined
                        }
                        onClick={() => {
                          if (modeDisabled) {
                            return;
                          }

                          onFormChange((current) => {
                            const nextSelectableItems =
                              getFollowupProjectOptions(
                                items,
                                followupMode,
                                constructionAiAuditEnabled,
                              );
                            const nextConstruction =
                              nextSelectableItems.find(
                                (item) =>
                                  item.recordId ===
                                  current.constructionRecordId,
                              ) ||
                              nextSelectableItems[0] ||
                              null;
                            const base = {
                              ...current,
                              followupMode,
                              constructionRecordId:
                                nextConstruction?.recordId || '',
                            };

                            if (followupMode === 'daily') {
                              const nextStage = getNextDailyFollowupStage(
                                getDailyFollowupStageProgress(
                                  nextConstruction,
                                  dailyPermitReferenceDate,
                                  constructionAiAuditEnabled,
                                ),
                              );
                              return applyDailyFollowupStageForm(
                                base,
                                nextConstruction,
                                nextStage,
                                getDailyFollowupForSubmission(
                                  nextConstruction,
                                  nextStage,
                                  dailyPermitReferenceDate,
                                ),
                                readDailyFollowupFormCache(
                                  nextConstruction?.recordId,
                                  nextStage,
                                  dailyPermitReferenceDate,
                                ),
                                constructionAiAuditEnabled,
                              );
                            }

                            return applyInitialApplicationFollowupForm(
                              base,
                              nextConstruction,
                              getInitialApplicationFollowup(nextConstruction),
                            );
                          });
                          onFilesChange({});
                        }}
                        className={cn(
                          'rounded-md px-3 py-2 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-55',
                          modeDisabled
                            ? 'text-slate-400'
                            : form.followupMode === mode
                              ? 'bg-white text-blue-700 shadow-sm ring-1 ring-blue-100'
                              : 'text-slate-500 hover:bg-white/70 hover:text-slate-800',
                        )}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
              )}
              <Field label="施工项目" className="md:col-span-2">
                <select
                  value={form.constructionRecordId}
                  onChange={(event) => {
                    const nextConstruction =
                      selectableItems.find(
                        (item) => item.recordId === event.target.value,
                      ) || null;
                    const nextStage = getNextDailyFollowupStage(
                      getDailyFollowupStageProgress(
                        nextConstruction,
                        dailyPermitReferenceDate,
                        constructionAiAuditEnabled,
                      ),
                    );
                    onFormChange((current) => {
                      const base = {
                        ...current,
                        constructionRecordId: event.target.value,
                      };

                      if (current.followupMode === 'supplemental') {
                        return applyInitialApplicationFollowupForm(
                          base,
                          nextConstruction,
                          getInitialApplicationFollowup(nextConstruction),
                        );
                      }

                      return applyDailyFollowupStageForm(
                        base,
                        nextConstruction,
                        nextStage,
                        getDailyFollowupForSubmission(
                          nextConstruction,
                          nextStage,
                          dailyPermitReferenceDate,
                        ),
                        readDailyFollowupFormCache(
                          nextConstruction?.recordId,
                          nextStage,
                          dailyPermitReferenceDate,
                        ),
                        constructionAiAuditEnabled,
                      );
                    });
                    onFilesChange({});
                  }}
                  className="h-9 w-full rounded-md border border-slate-200 bg-slate-50 px-3 text-sm outline-none transition focus:border-blue-300 focus:ring-2 focus:ring-blue-100"
                >
                  {selectableItems.length === 0 && (
                    <option value="">
                      {form.followupMode === 'daily'
                        ? '暂无审批完成的施工项目'
                        : '暂无施工项目'}
                    </option>
                  )}
                  {selectableItems.map((item) => (
                    <option key={item.recordId} value={item.recordId}>
                      {item.workContent}
                      {item.constructionCode
                        ? `（${item.constructionCode}）`
                        : ''}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
          </div>
          <div className="grid min-h-0 flex-1 gap-4 overflow-y-auto px-5 py-4 md:grid-cols-2">
            {!manualReviewAutoApproved && (
              <ManualReviewBatchSubmitBar
                count={pendingManualReviewCount}
                disabled={submitPending}
                onSubmit={onSubmitPendingManualReviews}
              />
            )}
            {form.followupMode === 'supplemental' && (
              <Field label="作业类型" className="md:col-span-2">
                <div className="flex flex-wrap gap-2">
                  {WORK_TYPES.map((type) => {
                    const materialGroup = getSpecialWorkTypeMaterialGroup(type);
                    const materialCount = materialGroup
                      ? getSpecialWorkTypeMaterialCount(
                          materialGroup,
                          files,
                          existingFiles,
                        )
                      : 0;
                    const selected =
                      form.workTypes.includes(type) &&
                      (!materialGroup ||
                        isSpecialWorkTypeMaterialComplete(
                          materialGroup,
                          files,
                          existingFiles,
                        ));

                    return (
                      <button
                        key={type}
                        type="button"
                        onClick={() => {
                          if (materialGroup) {
                            setSpecialMaterialWorkType(type);
                            return;
                          }
                          onFormChange((current) => {
                            const currentSelected =
                              current.workTypes.includes(type);
                            const nextWorkTypes = currentSelected
                              ? current.workTypes.filter(
                                  (item) => item !== type,
                                )
                              : [...current.workTypes, type];

                            onFilesChange((currentFiles) =>
                              pickSupplementalFileBuckets(
                                currentFiles,
                                nextWorkTypes,
                                current.depositPaid,
                              ),
                            );
                            return {
                              ...current,
                              workTypes: nextWorkTypes,
                            };
                          });
                        }}
                        className={cn(
                          'rounded-md border px-3 py-1.5 text-sm transition',
                          selected
                            ? 'border-blue-200 bg-blue-50 text-blue-700 shadow-sm'
                            : materialGroup && materialCount > 0
                              ? 'border-amber-200 bg-amber-50 text-amber-700 hover:border-blue-200 hover:text-blue-700'
                              : 'border-slate-200 bg-white text-slate-600 hover:border-blue-200 hover:text-blue-700',
                        )}
                      >
                        <span>{type}</span>
                        {materialGroup && (materialCount > 0 || selected) && (
                          <span
                            className={cn(
                              'ml-2 text-xs',
                              selected ? 'text-blue-500' : 'text-amber-600',
                            )}
                          >
                            {materialCount}/4
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </Field>
            )}
            {showDailyStageStepper && (
              <div className="md:col-span-2">
                <DailyFollowupStageStepper
                  value={form.dailyFollowupStage}
                  progress={dailyProgress}
                  permitVerifications={dailyPermitVerifications}
                  onChange={(dailyFollowupStage) => {
                    applyDailyStage(selectedConstruction, dailyFollowupStage);
                  }}
                />
              </div>
            )}
            {showDailyWorkTypeAudit && (
              <MemoizedDailyWorkTypeAuditPanel
                value={form.workTypes}
                disabled={submitting}
                files={files}
                existingFiles={specialMaterialDialogExistingFiles}
                onRequireMaterial={setSpecialMaterialWorkType}
                onChange={handleDailyWorkTypesChange}
              />
            )}
            {showDailyPermitVerification &&
              dailyPermitVerifications.length > 0 && (
                <DailyPermitVerificationCard
                  verifications={dailyPermitVerifications}
                  constructionAiAuditEnabled={constructionAiAuditEnabled}
                  manualReviewAutoApproved={manualReviewAutoApproved}
                  disabled={submitting}
                  uploadingKey={permitUploadingKey}
                  followupRecordId={
                    activeDailyFollowup?.recordId ||
                    form.followupRecordId ||
                    null
                  }
                  pendingManualReviews={pendingManualReviews}
                  refreshingManualReview={manualReviewRefreshing}
                  files={files}
                  existingFiles={specialMaterialDialogExistingFiles}
                  permitValidFromByFileKey={
                    form.permitValidFromByFileKey
                  }
                  permitValidUntilByFileKey={
                    form.permitValidUntilByFileKey
                  }
                  onPermitValidFromChange={(fieldKey, validFrom) => {
                    onFormChange((current) => ({
                      ...current,
                      permitValidFromByFileKey: {
                        ...current.permitValidFromByFileKey,
                        [fieldKey]: validFrom,
                      },
                    }));
                  }}
                  onPermitValidUntilChange={(fieldKey, validUntil) => {
                    onFormChange((current) => ({
                      ...current,
                      permitValidUntilByFileKey: {
                        ...current.permitValidUntilByFileKey,
                        [fieldKey]: validUntil,
                      },
                    }));
                  }}
                  onUploadPermit={onPermitUpload}
                  onRequireMaterial={setSpecialMaterialWorkType}
                  onRefreshPermitData={onRefreshPermitData}
                  onRequestManualReview={onRequestManualReview}
                  className="md:col-span-2"
                />
              )}
            {showDailyConstructionIssues && selectedConstruction && (
              <ConstructionIssueCard
                item={selectedConstruction}
                compact
                className="md:col-span-2"
              />
            )}
            {activeDailyChecklistFocus === 'personnel' && (
              <div className="md:col-span-2 rounded-lg border border-blue-100 bg-blue-50/70 px-3 py-2 text-sm text-blue-800">
                <div className="font-semibold">证书匹配依据</div>
                <div className="mt-1 text-xs leading-5 text-blue-700">
                  当天作业类型：
                  {getSupportedWorkTypes(form.workTypes).join('、') || '未校核'}
                  。提交时服务端只按已保存的当天作业类型核查人员证书。
                </div>
              </div>
            )}
            {constructionAiAuditEnabled && showDailyIsolationAuditNotice && (
              <div
                className={cn(
                  'md:col-span-2 rounded-md border px-3 py-2 text-sm',
                  imageAuditStatus?.configured &&
                    imageAuditStatus.supportsImageInput
                    ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                    : imageAuditStatus?.configured
                      ? 'border-blue-200 bg-blue-50 text-blue-800'
                      : 'border-amber-200 bg-amber-50 text-amber-800',
                )}
              >
                <div className="flex items-center gap-2 font-medium">
                  {imageAuditStatus?.configured ? (
                    <ShieldCheck className="h-4 w-4" />
                  ) : (
                    <AlertCircle className="h-4 w-4" />
                  )}
                  <span>
                    {imageAuditStatus?.configured &&
                    imageAuditStatus.supportsImageInput
                      ? `挂牌照片审核：${imageAuditStatus.provider} ${imageAuditStatus.model || ''}`
                      : imageAuditStatus?.configured
                        ? `挂牌照片审核：${imageAuditStatus.provider} 文本模型已配置`
                        : '挂牌照片审核：未配置模型 Key'}
                  </span>
                </div>
                {(!imageAuditStatus?.configured ||
                  !imageAuditStatus.supportsImageInput) && (
                  <p
                    className={cn(
                      'mt-1 text-xs leading-5',
                      imageAuditStatus?.configured
                        ? 'text-blue-700'
                        : 'text-amber-700',
                    )}
                  >
                    {imageAuditStatus?.configured
                      ? '当前模型接口不支持直接识别图片，提交后回填规则审核要点。'
                      : '提交后会先回填规则审核要点，配置 Key 后自动调用视觉模型。'}
                  </p>
                )}
              </div>
            )}
            {showDailyFollowupStaff && (
              <Field
                label="跟进人员"
                className="md:col-span-2"
                required
                asLabel={false}
              >
                <ConstructionStaffMultiSelect
                  values={form.followupStaffMembers}
                  disabled={submitting}
                  onChange={handleFollowupStaffMembersChange}
                />
              </Field>
            )}
            {showDailyPersonnelCheck && (
              <div className="md:col-span-2">
                {crewMembers.length > 0 ? (
                  <CrewCheckList
                    members={crewMembers}
                    checkedIds={checkedCrewIds}
                    authorizedCount={crewAuthorizationSummary.authorizedCount}
                    authorizationNotice={crewAuthorizationSummary.notice}
                    onToggle={handleCrewToggle}
                    onCheckAll={handleCrewCheckAll}
                    onClear={handleCrewClear}
                    onUpdateAuthorization={handleCrewAuthorizationUpdate}
                  />
                ) : (
                  <Field label="每日人员核查" required>
                    <Textarea
                      value={form.dailyPersonnelCheck}
                      onChange={(event) =>
                        onFormChange((current) => ({
                          ...current,
                          dailyPersonnelCheck: event.target.value,
                        }))
                      }
                      placeholder="未读取到施工人员台账时，可手工填写核查结果"
                      className="min-h-20 border-slate-200 bg-slate-50 focus-visible:ring-blue-200"
                    />
                  </Field>
                )}
              </div>
            )}
            {showDailyProcessFeedback && (
              <Field label="过程反馈" className="md:col-span-2">
                <Input
                  value={form.processFeedback}
                  onChange={(event) =>
                    onFormChange((current) => ({
                      ...current,
                      processFeedback: event.target.value,
                    }))
                  }
                  className="border-slate-200 bg-slate-50 focus-visible:ring-blue-200"
                />
              </Field>
            )}
            {showDailyCloseStatus && (
              <>
                <SelectField
                  label="项目是否整体全部完成"
                  value={form.completed}
                  options={[
                    '',
                    { value: '是', label: '是，已全部完成' },
                    { value: '否', label: '否，明日继续' },
                  ]}
                  emptyLabel="请选择"
                  required
                  onChange={(completed) =>
                    onFormChange((current) => {
                      const checklistItems = completed
                        ? getCompletionChecklistItemsForStatus(completed)
                        : [];
                      return {
                        ...current,
                        completed,
                        completionChecklist: reconcileCompletionChecklistState(
                          current.completionChecklist,
                          checklistItems,
                        ),
                      };
                    })
                  }
                />
              </>
            )}
            {showDailyCompletionChecklist && (
              <CompletionChecklistEditor
                value={form.completionChecklist}
                items={completionChecklistItems}
                mode={form.completed === '是' ? 'full' : 'daily'}
                disabled={!form.completed}
                onChange={(completionChecklist) =>
                  onFormChange((current) => ({
                    ...current,
                    completionChecklist,
                  }))
                }
              />
            )}
            {form.followupMode === 'supplemental' && (
              <section className="md:col-span-2 rounded-lg border border-amber-200 bg-amber-50/60 p-3">
                <div className="flex items-center gap-2 text-sm font-semibold text-amber-900">
                  <ShieldCheck className="h-4 w-4 text-amber-600" />
                  <span>质保金补充/扣除</span>
                </div>
                <div className="mt-3 grid gap-3 md:grid-cols-3">
                  <SelectField
                    label="是否缴纳保证金"
                    value={form.depositPaid}
                    options={['', '是', '否']}
                    emptyLabel="暂不填写"
                    onChange={(depositPaid) => {
                      onFormChange((current) => ({
                        ...clearDepositDetailFormFields(current, depositPaid),
                        depositPaid,
                      }));
                      if (!shouldShowDepositDetailFields(depositPaid)) {
                        onFilesChange(clearDepositDetailFileBuckets);
                      }
                    }}
                  />
                  {showDepositDetailFields && (
                    <>
                      <Field label="补充/到账金额（元）">
                        <Input
                          type="number"
                          min="0"
                          value={form.depositAmount}
                          onChange={(event) =>
                            onFormChange((current) => ({
                              ...current,
                              depositAmount: event.target.value,
                            }))
                          }
                          className="border-amber-100 bg-white/75 focus-visible:ring-amber-200"
                        />
                      </Field>
                      <Field label="扣除/返还金额（元）">
                        <Input
                          type="number"
                          min="0"
                          value={form.depositDeducted}
                          onChange={(event) =>
                            onFormChange((current) => ({
                              ...current,
                              depositDeducted: event.target.value,
                            }))
                          }
                          className="border-amber-100 bg-white/75 focus-visible:ring-amber-200"
                        />
                      </Field>
                    </>
                  )}
                </div>
                {showDepositDetailFields && (
                  <div className="mt-3">
                    <FileGrid
                      fields={DEPOSIT_FILE_FIELDS}
                      files={files}
                      existingFiles={existingFiles}
                      onUploadedFileRemove={
                        allowAttachmentDelete ? removeExistingFile : undefined
                      }
                      onFilesChange={onFilesChange}
                    />
                  </div>
                )}
              </section>
            )}
            {(form.followupMode === 'daily'
              ? focusedDailyFileFields.length > 0
              : true) && (
              <FileGrid
                fields={
                  form.followupMode === 'daily'
                    ? focusedDailyFileFields
                    : getInitialApplicationFileFields(form.workTypes)
                }
                files={files}
                requiredKeys={
                  form.followupMode === 'daily'
                    ? focusedDailyRequiredFileKeys
                    : []
                }
                existingFiles={existingFiles}
                fieldActions={followupFieldActions}
                fieldStatusHints={followupFieldStatusHints}
                onUploadedFileRemove={
                  allowAttachmentDelete ? removeExistingFile : undefined
                }
                onFilesChange={onFilesChange}
              />
            )}
            <SpecialWorkTypeMaterialDialog
              group={specialMaterialGroup}
              construction={selectedConstruction}
              crewMembers={crewMembers}
              files={files}
              existingFiles={specialMaterialDialogExistingFiles}
              onUploadedFileRemove={
                allowAttachmentDelete ? removeExistingFile : undefined
              }
              onFilesChange={onFilesChange}
              onGeneratedFileSubmit={submitGeneratedOnlineFormOptimistically}
              onOpenChange={(nextOpen) => {
                if (!nextOpen) {
                  setSpecialMaterialWorkType(null);
                }
              }}
              onRemoveWorkType={removeSpecialMaterialWorkType}
              onConfirmComplete={confirmSpecialMaterialWorkType}
            />
          </div>
          <DialogFooter className="shrink-0 border-t border-slate-100 bg-slate-50 px-5 py-4">
            <Button
              type="button"
              variant="outline"
              disabled={submitPending}
              onClick={() => onOpenChange(false)}
            >
              取消
            </Button>
            <Button
              type="button"
              disabled={submitPending}
              onClick={onSubmit}
              className="bg-blue-600 text-white hover:bg-blue-700"
            >
              {submitPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <UploadCloud className="h-4 w-4" />
              )}
              {submitPending
                ? submitPendingLabel
                : form.followupMode === 'daily'
                  ? `提交${getDailyChecklistFocusSubmitLabel(
                      activeDailyChecklistFocus,
                      form.dailyFollowupStage,
                    )}`
                  : '提交初始申请&增量修正'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <React.Suspense fallback={null}>
        <LazyOnlineWorkFormDialog
          target={workApplicationOnlineFormTarget}
          open={Boolean(workApplicationOnlineFormTarget)}
          crewMembers={crewMembers}
          draft={
            workApplicationOnlineFormTarget
              ? workApplicationOnlineFormDrafts[
                  workApplicationOnlineFormTarget.fieldKey
                ]
              : undefined
          }
          onDraftChange={(fieldKey, draft) =>
            setWorkApplicationOnlineFormDrafts((current) => ({
              ...current,
              [fieldKey]: draft,
            }))
          }
          onGenerateFile={(fieldKey, file, draft) => {
            setWorkApplicationOnlineFormDrafts((current) => ({
              ...current,
              [fieldKey]: draft,
            }));
            submitGeneratedOnlineFormOptimistically(fieldKey, file, () =>
              setWorkApplicationOnlineFormTarget(null),
            );
          }}
          onOpenChange={(nextOpen) => {
            if (!nextOpen) {
              setWorkApplicationOnlineFormTarget(null);
            }
          }}
        />
      </React.Suspense>
    </>
  );
}

function SpecialWorkTypeMaterialDialog({
  group,
  construction,
  crewMembers,
  files,
  existingFiles,
  onUploadedFileRemove,
  onFilesChange,
  onGeneratedFileSubmit,
  onOpenChange,
  onRemoveWorkType,
  onConfirmComplete,
}: {
  group: (typeof SPECIAL_WORK_TYPE_MATERIAL_GROUPS)[number] | null;
  construction: ConstructionOverviewItem | null;
  crewMembers: OnlineWorkFormCrewMember[];
  files: FileBucket;
  existingFiles: Record<string, ConstructionAttachmentFile[]>;
  onUploadedFileRemove?: (fieldKey: string, fileToken: string) => void;
  onFilesChange: React.Dispatch<React.SetStateAction<FileBucket>>;
  onGeneratedFileSubmit: (
    fieldKey: string,
    file: File,
    closeDialog: () => void,
  ) => void;
  onOpenChange: (open: boolean) => void;
  onRemoveWorkType: (workType: string) => void;
  onConfirmComplete: (workType: string) => void;
}) {
  const [onlineFormTarget, setOnlineFormTarget] =
    useState<OnlineWorkFormTarget | null>(null);
  const [onlineFormDrafts, setOnlineFormDrafts] = useState<
    Record<string, OnlineWorkFormDraft>
  >({});
  const selectedCount = group
    ? getSpecialWorkTypeMaterialCount(group, files, existingFiles)
    : 0;
  const complete = group
    ? isSpecialWorkTypeMaterialComplete(group, files, existingFiles)
    : false;
  const fieldActions = useMemo<Partial<Record<string, React.ReactNode>>>(() => {
    if (!group) {
      return {};
    }
    return Object.fromEntries(
      group.fields.map(([fieldKey, label]) => [
        fieldKey,
        <Button
          key={fieldKey}
          type="button"
          variant="outline"
          size="sm"
          className="h-8 border-emerald-200 bg-emerald-50 text-xs font-semibold text-emerald-700 hover:bg-emerald-100 hover:text-emerald-800"
          onClick={() => {
            const target = getOnlineWorkFormTarget(
              group.workType,
              fieldKey,
              label,
            );
            setOnlineFormDrafts((current) => {
              const existing = current[target.fieldKey];
              if (
                existing?.values.formNo ===
                (construction?.constructionCode || '')
              ) {
                return {
                  ...current,
                  [target.fieldKey]: {
                    ...existing,
                    people:
                      target.kind === 'trainingSignIn'
                        ? createOnlineWorkFormPeopleFromCrewMembers(
                            crewMembers,
                            existing.people,
                          )
                        : existing.people,
                  },
                };
              }
              return {
                ...current,
                [target.fieldKey]: createSpecialOnlineWorkFormDraft(
                  target,
                  construction,
                  crewMembers,
                ),
              };
            });
            setOnlineFormTarget(target);
          }}
        >
          <PenLine className="h-3.5 w-3.5" />
          在线填表
        </Button>,
      ]),
    );
  }, [construction, crewMembers, group]);

  useEffect(() => {
    if (!group) {
      setOnlineFormTarget(null);
    }
  }, [group]);

  return (
    <>
      <Dialog
        open={Boolean(group)}
        modal={!onlineFormTarget}
        onOpenChange={onOpenChange}
      >
        <DialogContent className="flex max-h-[82vh] w-[calc(100vw-2rem)] max-w-2xl flex-col overflow-hidden rounded-2xl border-slate-200 bg-white p-0 shadow-[0_24px_70px_rgba(15,23,42,0.18)]">
          <DialogHeader className="shrink-0 border-b border-slate-100 bg-white px-5 py-4 pr-12">
            <DialogTitle className="text-lg font-semibold text-slate-900">
              {group?.title || '特种作业资料'}
            </DialogTitle>
            <DialogDescription className="text-sm text-slate-500">
              {selectedCount}/4
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
            {group && (
              <FileGrid
                fields={group.fields}
                files={files}
                existingFiles={existingFiles}
                fieldActions={fieldActions}
                onUploadedFileRemove={onUploadedFileRemove}
                onFilesChange={onFilesChange}
              />
            )}
          </div>
          <DialogFooter className="shrink-0 border-t border-slate-100 bg-slate-50 px-5 py-4">
            {group && (
              <Button
                type="button"
                variant="outline"
                className="mr-auto border-rose-200 text-rose-700 hover:bg-rose-50 hover:text-rose-700"
                onClick={() => onRemoveWorkType(group.workType)}
              >
                取消选择该作业
              </Button>
            )}
            <Button
              type="button"
              disabled={!complete}
              onClick={() => group && onConfirmComplete(group.workType)}
            >
              完成
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <React.Suspense fallback={null}>
        <LazyOnlineWorkFormDialog
          target={onlineFormTarget}
          open={Boolean(onlineFormTarget)}
          crewMembers={crewMembers}
          draft={
            onlineFormTarget
              ? onlineFormDrafts[onlineFormTarget.fieldKey]
              : undefined
          }
          onDraftChange={(fieldKey, draft) =>
            setOnlineFormDrafts((current) => ({
              ...current,
              [fieldKey]: draft,
            }))
          }
          onGenerateFile={(fieldKey, file, draft) => {
            setOnlineFormDrafts((current) => ({
              ...current,
              [fieldKey]: draft,
            }));
            onGeneratedFileSubmit(fieldKey, file, () =>
              setOnlineFormTarget(null),
            );
          }}
          onOpenChange={(open) => {
            if (!open) {
              setOnlineFormTarget(null);
            }
          }}
        />
      </React.Suspense>
    </>
  );
}

function createSpecialOnlineWorkFormDraft(
  target: OnlineWorkFormTarget,
  construction: ConstructionOverviewItem | null,
  crewMembers: readonly OnlineWorkFormCrewMember[],
): OnlineWorkFormDraft {
  const draft = createEmptyOnlineWorkFormDraft(target);
  const people =
    target.kind === 'trainingSignIn'
      ? createOnlineWorkFormPeopleFromCrewMembers(crewMembers)
      : draft.people;

  return {
    ...draft,
    people,
    values: {
      ...draft.values,
      formNo: construction?.constructionCode || '',
      projectName:
        target.kind === 'trainingSignIn'
          ? '施工安全管理培训'
          : construction?.workContent || target.label,
      contractor: construction?.contractorType || '',
      workLocation: [construction?.building, construction?.specialty]
        .filter(Boolean)
        .join(' '),
      workContent:
        target.kind === 'trainingSignIn'
          ? `施工作业安全管理相关内容${
              construction?.workContent ? `（${construction.workContent}）` : ''
            }`
          : construction?.workContent || target.workType,
      startDate: toOnlineDatetimeLocalValue(construction?.planStartTime),
      endDate: toOnlineDatetimeLocalValue(construction?.planEndTime),
      trainer:
        construction?.managers?.safety ||
        construction?.managers?.engineer ||
        construction?.managers?.applicant ||
        draft.values.trainer,
    },
  };
}

function DailyWorkTypeAuditPanel({
  value,
  disabled = false,
  files,
  existingFiles = {},
  onRequireMaterial,
  onChange,
}: {
  value: readonly string[];
  disabled?: boolean;
  files: FileBucket;
  existingFiles?: Record<string, ConstructionAttachmentFile[]>;
  onRequireMaterial: (workType: string) => void;
  onChange: (workTypes: string[]) => void;
}) {
  const selectedWorkTypes = getSupportedWorkTypes(value);
  const normalizedWorkTypes =
    selectedWorkTypes.length > 0 ? selectedWorkTypes : ['一般作业'];
  const selectedSet = new Set(normalizedWorkTypes);
  const relatedPermits = DAILY_PERMIT_DEFINITIONS.filter((definition) =>
    normalizedWorkTypes.some((type) => type.includes(definition.workType)),
  );
  const relatedPermitText =
    relatedPermits.length > 0
      ? `已关联${relatedPermits.map((item) => item.label).join('、')}核对`
      : '当前无需作业票核对';

  const toggleWorkType = (type: string) => {
    const selected = selectedSet.has(type);
    const materialGroup = getSpecialWorkTypeMaterialGroup(type);
    const materialComplete = materialGroup
      ? isSpecialWorkTypeMaterialComplete(materialGroup, files, existingFiles)
      : false;
    if (materialGroup && !selected && !materialComplete) {
      onRequireMaterial(type);
      return;
    }

    const nextWorkTypes = selected
      ? normalizedWorkTypes.filter((item) => item !== type)
      : [...normalizedWorkTypes, type];

    onChange(nextWorkTypes.length > 0 ? nextWorkTypes : ['一般作业']);
  };

  return (
    <section className="md:col-span-2 rounded-lg border border-slate-200 bg-white px-3 py-3 text-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-2 font-semibold text-slate-900">
            <Wrench className="h-4 w-4 text-blue-600" />
            <span>第 1 步 · 当天作业类型校核</span>
          </div>
          <p className="mt-1 text-xs leading-5 text-slate-500">
            先确认今日实际作业类型；下一步人员核查会据此匹配证书。
          </p>
        </div>
        <span className="rounded-full border border-blue-100 bg-blue-50 px-2 py-0.5 text-xs font-semibold text-blue-700">
          先校核类型 · 关联作业票核对
        </span>
      </div>
      <div
        className="mt-3 flex flex-wrap gap-2"
        role="group"
        aria-label="核对施工类型"
      >
        {WORK_TYPES.map((type) => {
          const materialGroup = getSpecialWorkTypeMaterialGroup(type);
          const materialCount = materialGroup
            ? getSpecialWorkTypeMaterialCount(
                materialGroup,
                files,
                existingFiles,
              )
            : 0;
          const selected = selectedSet.has(type);
          return (
            <button
              key={type}
              type="button"
              disabled={disabled}
              onClick={() => toggleWorkType(type)}
              className={cn(
                'rounded-md border px-3 py-1.5 text-sm font-medium transition focus:outline-none focus:ring-2 focus:ring-blue-200 disabled:cursor-not-allowed disabled:opacity-70',
                selected
                  ? 'border-blue-200 bg-blue-50 text-blue-700 shadow-sm'
                  : materialGroup && materialCount > 0
                    ? 'border-amber-200 bg-amber-50 text-amber-700 hover:border-blue-200 hover:text-blue-700'
                    : 'border-slate-200 bg-white text-slate-600 hover:border-blue-200 hover:text-blue-700',
              )}
            >
              <span>{type}</span>
              {materialGroup && (
                <span
                  className={cn(
                    'ml-2 text-xs',
                    selected ? 'text-blue-500' : 'text-amber-600',
                  )}
                >
                  {materialCount}/4
                </span>
              )}
            </button>
          );
        })}
      </div>
      <div
        className={cn(
          'mt-3 inline-flex max-w-full items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-semibold',
          relatedPermits.length > 0
            ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
            : 'border-slate-200 bg-slate-50 text-slate-500',
        )}
      >
        <ShieldCheck className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">{relatedPermitText}</span>
      </div>
    </section>
  );
}

const MemoizedDailyWorkTypeAuditPanel = React.memo(DailyWorkTypeAuditPanel);

function ManualReviewBatchSubmitBar({
  count,
  disabled = false,
  onSubmit,
}: {
  count: number;
  disabled?: boolean;
  onSubmit: () => void | Promise<void>;
}) {
  if (count <= 0) {
    return null;
  }

  return (
    <div className="md:col-span-2 flex flex-wrap items-center justify-between gap-3 rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-800">
      <div className="flex min-w-0 items-center gap-2 font-medium">
        <UserCheck className="h-4 w-4 shrink-0" />
        <span className="truncate">已暂存 {count} 项人工审核</span>
      </div>
      <Button
        type="button"
        size="sm"
        disabled={disabled}
        onClick={() => void onSubmit()}
        className="h-8 bg-blue-600 px-3 text-white hover:bg-blue-700"
      >
        {disabled ? (
          <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
        ) : (
          <UploadCloud className="mr-1.5 h-3.5 w-3.5" />
        )}
        提交人工审核
      </Button>
    </div>
  );
}

function AutomaticManualReviewBadge({ label }: { label: string }) {
  return (
    <span
      className="inline-flex h-7 items-center gap-1 rounded-md border border-emerald-200 bg-emerald-50 px-2 text-[11px] font-semibold text-emerald-700"
      title="管理员、施工管理员和子管理员提交时默认人工审核通过"
    >
      <CheckCircle2 className="h-3.5 w-3.5" />
      {label}
    </span>
  );
}

function buildPendingPermitManualReviewId(
  followupRecordId: string,
  fileKey: string,
): string {
  return `permit:${followupRecordId}:${fileKey}`;
}

function buildPendingIsolationManualReviewId(followupRecordId: string): string {
  return `isolation:${followupRecordId}`;
}

function upsertPendingManualReview(
  items: PendingManualReviewItem[],
  next: PendingManualReviewItem,
): PendingManualReviewItem[] {
  return [...items.filter((item) => item.id !== next.id), next];
}

function getPendingPermitManualReviewDecision(
  items: readonly PendingManualReviewItem[],
  verification: DailyPermitVerification,
  followupRecordId: string | null,
): ConstructionPermitManualReviewDecision | null {
  const targetFollowupRecordId =
    followupRecordId || verification.sourceFollowupRecordId;
  if (!targetFollowupRecordId) {
    return null;
  }

  return (
    items.find(
      (item) =>
        item.kind === 'permit' &&
        item.id ===
          buildPendingPermitManualReviewId(
            targetFollowupRecordId,
            verification.fileKey,
          ),
    )?.decision || null
  );
}

function getManualReviewSyncConfirmationError(
  data: ConstructionManagementResponse | null,
  reviews: readonly PendingManualReviewItem[],
  referenceDate: Date,
  workTypes: readonly string[],
  constructionAiAuditEnabled = false,
): string | null {
  if (!data) {
    return '人工审核结果已提交，但未获取到最新数据，请刷新后确认';
  }

  for (const review of reviews) {
    if (review.kind !== 'permit') {
      continue;
    }
    const construction = data.items.find((item) =>
      item.followups.some(
        (followup) => followup.recordId === review.followupRecordId,
      ),
    );
    const verification = construction
      ? getDailyPermitVerifications(
          construction,
          referenceDate,
          workTypes,
          constructionAiAuditEnabled,
        ).find((item) => item.fileKey === review.fileKey)
      : null;
    const expectedStatus = review.decision;
    if (!verification || verification.manualReview.status !== expectedStatus) {
      return verification?.manualReview.status === 'stale'
        ? `${review.label}已变化，人工审核结果未生效，请刷新后重新审核`
        : `${review.label}人工审核结果未生效，请刷新后重试`;
    }
  }

  return null;
}

function getPendingIsolationManualReviewDecision(
  items: readonly PendingManualReviewItem[],
  followupRecordId: string | null,
): ConstructionPermitManualReviewDecision | null {
  if (!followupRecordId) {
    return null;
  }

  return (
    items.find(
      (item) =>
        item.kind === 'isolation' &&
        item.id === buildPendingIsolationManualReviewId(followupRecordId),
    )?.decision || null
  );
}

function DailyIsolationPhotoAuditAction({
  summary,
  constructionAiAuditEnabled,
  manualReviewAutoApproved,
  manualDecision = null,
  pendingDecision = null,
  followupRecordId = null,
  disabled = false,
  refreshing = false,
  onRefresh,
  onRequestManualReview,
}: {
  summary: DailyIsolationAuditSummary | null;
  constructionAiAuditEnabled: boolean;
  manualReviewAutoApproved: boolean;
  manualDecision?: string | null;
  pendingDecision?: ConstructionPermitManualReviewDecision | null;
  followupRecordId?: string | null;
  disabled?: boolean;
  refreshing?: boolean;
  onRefresh?: () => void | Promise<void>;
  onRequestManualReview?: (
    followupRecordId: string | null,
    decision: ConstructionPermitManualReviewDecision,
  ) => void | Promise<void>;
}) {
  if (manualReviewAutoApproved) {
    return <AutomaticManualReviewBadge label="挂牌审核默认通过" />;
  }

  const status = pendingDecision
    ? {
        label: pendingDecision === 'passed' ? '待提交通过' : '待提交驳回',
        tone:
          pendingDecision === 'passed'
            ? ('success' as const)
            : ('issue' as const),
        title:
          pendingDecision === 'passed'
            ? '人工审核通过已暂存'
            : '人工审核驳回已暂存',
      }
    : getDailyIsolationPhotoAuditStatus(
        summary,
        manualDecision,
        constructionAiAuditEnabled,
      );
  const Icon =
    status.tone === 'success'
      ? CheckCircle2
      : status.tone === 'issue'
        ? AlertCircle
        : HelpCircle;
  const controlDisabled =
    disabled || refreshing || !onRequestManualReview || !followupRecordId;
  const actionLabel = followupRecordId
    ? '先暂存，点击提交人工审核后同步多维表'
    : '当前记录未创建，提交每日准备后可人工审核';
  const handleDecision = (decision: ConstructionPermitManualReviewDecision) => {
    if (controlDisabled) {
      return;
    }
    void onRequestManualReview?.(followupRecordId, decision);
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className={cn(
                'inline-flex h-7 max-w-[13rem] items-center gap-1 rounded-md border bg-white/85 px-2 text-[11px] font-semibold shadow-sm transition focus:outline-none focus:ring-2 focus:ring-blue-200 disabled:cursor-wait disabled:opacity-70',
                status.tone === 'success' &&
                  'border-emerald-200 text-emerald-700 hover:bg-emerald-50',
                status.tone === 'issue' &&
                  'border-rose-200 text-rose-700 hover:bg-rose-50',
                status.tone === 'neutral' &&
                  'border-slate-200 text-slate-500 hover:border-blue-200 hover:bg-blue-50 hover:text-blue-700',
              )}
              title={`${status.title}，${actionLabel}`}
              aria-label={`挂牌审核状态${status.label}，${actionLabel}`}
              disabled={controlDisabled}
            >
              {refreshing ? (
                <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
              ) : (
                <Icon className="h-3.5 w-3.5 shrink-0" />
              )}
              <span className="shrink-0 text-slate-500">挂牌审核状态</span>
              <span className="truncate">{status.label}</span>
              <ChevronDown className="h-3 w-3 shrink-0 opacity-70" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-32">
            <DropdownMenuItem
              className="text-emerald-700 focus:bg-emerald-50 focus:text-emerald-800"
              disabled={controlDisabled}
              onClick={() => handleDecision('passed')}
            >
              <CheckCircle2 className="h-4 w-4" />
              标记通过
            </DropdownMenuItem>
            <DropdownMenuItem
              className="text-rose-700 focus:bg-rose-50 focus:text-rose-800"
              disabled={controlDisabled}
              onClick={() => handleDecision('rejected')}
            >
              <AlertCircle className="h-4 w-4" />
              标记驳回
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        {constructionAiAuditEnabled && (
          <button
            type="button"
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-500 shadow-sm transition hover:border-blue-200 hover:text-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-200 disabled:cursor-wait disabled:opacity-70"
            title="同步多维表挂牌审核状态"
            aria-label="同步多维表挂牌审核状态"
            disabled={disabled || refreshing || !onRefresh}
            onClick={() => void onRefresh?.()}
          >
            <RefreshCw
              className={cn('h-3.5 w-3.5', refreshing && 'animate-spin')}
            />
          </button>
        )}
      </div>
      {constructionAiAuditEnabled && summary && (
        <div className="rounded-md border border-slate-200 bg-white/80 px-2.5 py-2 text-[11px] leading-5 text-slate-600">
          <div className="font-semibold text-slate-700">AI审核提炼</div>
          <div className="mt-1 grid gap-1 sm:grid-cols-3">
            {summary.details.map((detail) => (
              <div
                key={detail.label}
                className={cn(
                  'rounded border px-2 py-1',
                  detail.tone === 'issue'
                    ? 'border-rose-100 bg-rose-50 text-rose-700'
                    : detail.tone === 'success'
                      ? 'border-emerald-100 bg-emerald-50 text-emerald-700'
                      : 'border-slate-100 bg-slate-50 text-slate-600',
                )}
              >
                <span className="font-semibold">{detail.label}</span>
                <span className="mx-1">:</span>
                <span>{detail.value}</span>
              </div>
            ))}
          </div>
          <div className="mt-2 font-semibold text-slate-700">AI原始结论</div>
          <p className="mt-0.5 break-words text-slate-500">
            {summary.rawText || summary.description}
          </p>
        </div>
      )}
    </div>
  );
}

function getDailyIsolationPhotoAuditStatus(
  summary: DailyIsolationAuditSummary | null,
  manualDecision?: string | null,
  constructionAiAuditEnabled = false,
): { label: string; tone: 'success' | 'issue' | 'neutral'; title: string } {
  const manualStatus = getDailyIsolationManualReviewStatus(manualDecision);
  if (manualStatus === 'passed') {
    return {
      label: '通过',
      tone: 'success',
      title: '人工审核通过',
    };
  }
  if (manualStatus === 'rejected') {
    return {
      label: '驳回',
      tone: 'issue',
      title: '人工审核驳回',
    };
  }

  if (!constructionAiAuditEnabled) {
    return {
      label: '待审核',
      tone: 'neutral',
      title: '待人工审核',
    };
  }

  if (!summary) {
    return {
      label: '待审核',
      tone: 'neutral',
      title: '多维表未回填挂牌隔离照片审核状态',
    };
  }

  if (summary.tone === 'success') {
    return {
      label: '待人工',
      tone: 'neutral',
      title: `AI审核通过，待人工确认：${summary.description}`,
    };
  }

  return {
    label: '需复核',
    tone: 'issue',
    title: summary.description,
  };
}

type DailyIsolationManualReviewStatus = 'passed' | 'rejected' | 'pending';

function getDailyIsolationManualReviewStatus(
  manualDecision?: string | null,
): DailyIsolationManualReviewStatus {
  const manualText = normalizeDisplayText(manualDecision);
  if (!manualText) {
    return 'pending';
  }
  if (
    /^(驳回|不通过|未通过|人工驳回|否|false|no|fail|reject|rejected)$/i.test(
      manualText,
    ) ||
    /审核驳回|人工驳回|审核不通过|未通过|不合格|不通过|拒绝|否决/i.test(
      manualText,
    )
  ) {
    return 'rejected';
  }
  if (
    /^(通过|已通过|人工通过|合格|是|true|yes|pass|passed|approve|approved|已审核|已人工审核|人工已审|人员已审|√|✓|✔|☑)$/i.test(
      manualText,
    ) ||
    /审核通过|人工通过|已审核|已人工审核|人工已审|已确认|合格/i.test(manualText)
  ) {
    return 'passed';
  }
  return 'pending';
}

function isIsolationManualReviewPassed(
  status: DailyIsolationManualReviewStatus,
): boolean {
  return status === 'passed';
}

function getLatestIsolationManualReviewDecision(
  followups: readonly ConstructionFollowupItem[],
): string | null {
  return (
    followups
      .slice()
      .sort((left, right) => getFollowupTime(right) - getFollowupTime(left))
      .find((followup) => normalizeDisplayText(followup.isolationCompliant))
      ?.isolationCompliant || null
  );
}

function getFollowupIsolationAuditFeedback(
  followup: ConstructionFollowupItem | null,
): string | null {
  if (!followup) {
    return null;
  }

  return (
    followup.isolationFeedback ||
    followup.attachments.find(
      (group) =>
        group.label === '挂牌与隔离照片' || group.field === '挂牌与隔离照片',
    )?.feedback ||
    null
  );
}

function DailyPermitVerificationCard({
  verifications,
  constructionAiAuditEnabled,
  manualReviewAutoApproved,
  disabled = false,
  uploadingKey = null,
  followupRecordId = null,
  pendingManualReviews,
  refreshingManualReview = false,
  files,
  existingFiles,
  permitValidFromByFileKey,
  permitValidUntilByFileKey,
  onPermitValidFromChange,
  onPermitValidUntilChange,
  onUploadPermit,
  onRequireMaterial,
  onRefreshPermitData,
  onRequestManualReview,
  className,
}: {
  verifications: readonly DailyPermitVerification[];
  constructionAiAuditEnabled: boolean;
  manualReviewAutoApproved: boolean;
  disabled?: boolean;
  uploadingKey?: string | null;
  followupRecordId?: string | null;
  pendingManualReviews: readonly PendingManualReviewItem[];
  refreshingManualReview?: boolean;
  files: FileBucket;
  existingFiles: Record<string, ConstructionAttachmentFile[]>;
  permitValidFromByFileKey: Record<string, string>;
  permitValidUntilByFileKey: Record<string, string>;
  onPermitValidFromChange: (fieldKey: string, validFrom: string) => void;
  onPermitValidUntilChange: (fieldKey: string, validUntil: string) => void;
  onUploadPermit?: (
    verification: DailyPermitVerification,
    selectedFiles: File[],
  ) => void | Promise<void>;
  onRequireMaterial?: (workType: string) => void;
  onRefreshPermitData?: () => void | Promise<void>;
  onRequestManualReview?: (
    verification: DailyPermitVerification,
    followupRecordId: string | null,
    decision: ConstructionPermitManualReviewDecision,
    validFrom: string | null,
    validUntil: string | null,
  ) => void | Promise<void>;
  className?: string;
}) {
  const blocking = getBlockingDailyPermitIssues(verifications);
  const allValid = verifications.every(
    (item) => getDailyPermitVerificationTone(item) === 'valid',
  );
  const tone = blocking.length > 0 ? 'danger' : allValid ? 'valid' : 'notice';
  const blockingLabel =
    blocking.length > 0
      ? `需处理 ${blocking.length} 项`
      : allValid
        ? '全部有效'
        : '需关注';
  const [expandedInvalidKey, setExpandedInvalidKey] = useState<string | null>(
    null,
  );

  return (
    <section
      className={cn(
        'rounded-lg border px-3 py-3 text-sm',
        tone === 'danger'
          ? 'border-[hsl(354_70%_85%)] bg-[hsl(354_70%_96%)] text-[hsl(354_70%_42%)]'
          : tone === 'valid'
            ? 'border-[hsl(142_76%_82%)] bg-[hsl(142_76%_94%)] text-[hsl(142_76%_26%)]'
            : 'border-[hsl(38_92%_82%)] bg-[hsl(38_92%_94%)] text-[hsl(38_92%_32%)]',
        className,
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 font-semibold">
          {tone === 'danger' ? (
            <AlertCircle className="h-4 w-4" />
          ) : (
            <ShieldCheck className="h-4 w-4" />
          )}
          <span>作业票审核</span>
        </div>
        <div className="flex items-center gap-1.5">
          {constructionAiAuditEnabled && (
            <button
              type="button"
              className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-white/80 bg-white/80 text-current shadow-sm transition hover:bg-white focus:outline-none focus:ring-2 focus:ring-blue-200 disabled:cursor-wait disabled:opacity-70"
              title="同步多维表最新作业票数据"
              aria-label="同步多维表最新作业票数据"
              disabled={
                disabled || refreshingManualReview || !onRefreshPermitData
              }
              onClick={() => void onRefreshPermitData?.()}
            >
              <RefreshCw
                className={cn(
                  'h-3.5 w-3.5',
                  refreshingManualReview && 'animate-spin',
                )}
              />
            </button>
          )}
          <span className="rounded-full bg-white/70 px-2 py-0.5 text-xs font-semibold">
            {blockingLabel}
          </span>
        </div>
      </div>
      <div className="mt-2 grid gap-2 md:grid-cols-2">
        {verifications.map((item) => {
          const itemTone = getDailyPermitVerificationTone(item);
          const auditDetails = constructionAiAuditEnabled
            ? getDailyPermitAuditDetails(item)
            : null;
          const invalidDetails = constructionAiAuditEnabled
            ? getDailyPermitInvalidDetails(item)
            : null;
          const detailId = `daily-permit-detail-${item.fileKey}`;
          const detailExpanded = expandedInvalidKey === item.fileKey;
          const canToggleDetails = Boolean(auditDetails || invalidDetails);
          const materialGroup = getSpecialWorkTypeMaterialGroup(item.workType);
          const requiresMaterialBeforePermitUpload = Boolean(
            materialGroup &&
            !isSpecialWorkTypeMaterialComplete(
              materialGroup,
              files,
              existingFiles,
            ),
          );
          const statusClassName = cn(
            'rounded-full px-2 py-0.5 text-[11px] font-semibold',
            itemTone === 'danger'
              ? 'bg-[hsl(354_70%_94%)] text-[hsl(354_70%_42%)]'
              : itemTone === 'valid'
                ? 'bg-[hsl(142_76%_90%)] text-[hsl(142_76%_26%)]'
                : 'bg-[hsl(38_92%_90%)] text-[hsl(38_92%_32%)]',
          );
          const metaText = constructionAiAuditEnabled
            ? getDailyPermitCardMeta(item, auditDetails)
            : '';
          const selectedPermitFiles = files[item.fileKey] || [];
          const hasSelectedPermitFiles = selectedPermitFiles.length > 0;
          const permitValidFrom =
            permitValidFromByFileKey[item.fileKey] ||
            item.manualReview.validFrom ||
            '';
          const permitValidUntil =
            permitValidUntilByFileKey[item.fileKey] ||
            item.manualReview.validUntil ||
            '';
          return (
            <div
              key={item.fileKey}
              className={cn(
                'rounded-md border px-3 py-2',
                itemTone === 'danger'
                  ? 'border-[hsl(354_70%_88%)] bg-[hsl(354_70%_97%)] text-[hsl(354_70%_42%)]'
                  : itemTone === 'valid'
                    ? 'border-[hsl(142_76%_84%)] bg-[hsl(142_76%_95%)] text-[hsl(142_76%_26%)]'
                    : 'border-[hsl(38_92%_84%)] bg-[hsl(38_92%_96%)] text-[hsl(38_92%_32%)]',
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="min-w-0 font-semibold">{item.label}</span>
                <div className="flex shrink-0 items-center gap-1.5">
                  <DailyPermitManualReviewBadge
                    verification={item}
                    manualReviewAutoApproved={manualReviewAutoApproved}
                    followupRecordId={followupRecordId}
                    pendingDecision={getPendingPermitManualReviewDecision(
                      pendingManualReviews,
                      item,
                      followupRecordId,
                    )}
                    disabled={disabled || refreshingManualReview}
                    refreshing={refreshingManualReview}
                    onRequestManualReview={onRequestManualReview}
                  />
                  {canToggleDetails ? (
                    <button
                      type="button"
                      className={cn(
                        statusClassName,
                        'inline-flex items-center gap-1 transition focus:outline-none focus:ring-2',
                        itemTone === 'danger'
                          ? 'hover:bg-rose-200 focus:ring-rose-300'
                          : itemTone === 'valid'
                            ? 'hover:bg-emerald-200 focus:ring-emerald-300'
                            : 'hover:bg-amber-200 focus:ring-amber-300',
                      )}
                      aria-expanded={detailExpanded}
                      aria-controls={detailId}
                      onClick={() =>
                        setExpandedInvalidKey((current) =>
                          current === item.fileKey ? null : item.fileKey,
                        )
                      }
                    >
                      {getDailyPermitStatusLabel(item.status)}
                      <ChevronDown
                        className={cn(
                          'h-3 w-3 transition-transform',
                          detailExpanded && 'rotate-180',
                        )}
                      />
                    </button>
                  ) : (
                    <span className={statusClassName}>
                      {getDailyPermitStatusLabel(item.status)}
                    </span>
                  )}
                </div>
              </div>

              <p
                className="mt-1 text-xs leading-5 opacity-90"
                style={{
                  display: '-webkit-box',
                  WebkitBoxOrient: 'vertical',
                  WebkitLineClamp: 2,
                  overflow: 'hidden',
                }}
              >
                {getDailyPermitDisplayMessage(item, constructionAiAuditEnabled)}
              </p>

              <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] font-medium">
                {metaText && (
                  <span className="rounded-md bg-white/70 px-2 py-0.5">
                    {metaText}
                  </span>
                )}
              </div>

              {canToggleDetails && detailExpanded && (
                <DailyPermitAuditDetailPanel
                  id={detailId}
                  auditDetails={auditDetails}
                  invalidDetails={invalidDetails}
                />
              )}

              {hasSelectedPermitFiles || item.files.length > 0 ? (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {hasSelectedPermitFiles
                    ? selectedPermitFiles.map((file, index) => (
                        <LocalSelectedPermitFilePreviewLink
                          key={`${item.fileKey}-selected-${getFileIdentity(file)}-${index}`}
                          file={file}
                          label={item.label}
                        />
                      ))
                    : item.files.map((file, index) => {
                        const fileName =
                          normalizeDisplayText(file.name) || '作业票附件';
                        return (
                          <a
                            key={`${item.fileKey}-${file.fileToken}-${index}`}
                            href={getConstructionAttachmentDownloadUrl(
                              file.fileToken,
                              fileName,
                              { tmpUrl: file.tmpUrl },
                            )}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex max-w-full items-center gap-1 rounded-md border border-current/15 bg-white/80 px-2 py-0.5 text-[11px] font-semibold underline-offset-2 hover:underline"
                            title={`预览${fileName}`}
                          >
                            <Eye className="h-3 w-3 shrink-0" />
                            <span className="truncate">{fileName}</span>
                          </a>
                        );
                      })}
                </div>
              ) : (
                <div className="mt-2 text-[11px] text-amber-700/80">
                  未匹配到可预览附件
                </div>
              )}
              {manualReviewAutoApproved && (
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  <label className="block">
                    <span className="text-[11px] font-semibold">
                      作业票有效期开始
                      <span className="ml-0.5 text-rose-500">*</span>
                    </span>
                    <Input
                      type="date"
                      value={permitValidFrom}
                      max={permitValidUntil || undefined}
                      disabled={disabled || uploadingKey !== null}
                      onChange={(event) =>
                        onPermitValidFromChange(
                          item.fileKey,
                          event.target.value,
                        )
                      }
                      className="mt-1 h-8 border-current/20 bg-white/90 text-xs text-slate-700"
                    />
                  </label>
                  <label className="block">
                    <span className="text-[11px] font-semibold">
                      作业票有效期至
                      <span className="ml-0.5 text-rose-500">*</span>
                    </span>
                    <Input
                      type="date"
                      value={permitValidUntil}
                      min={permitValidFrom || undefined}
                      disabled={disabled || uploadingKey !== null}
                      onChange={(event) =>
                        onPermitValidUntilChange(
                          item.fileKey,
                          event.target.value,
                        )
                      }
                      className="mt-1 h-8 border-current/20 bg-white/90 text-xs text-slate-700"
                    />
                  </label>
                </div>
              )}
              <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                <DailyPermitUploadButton
                  verification={item}
                  validFrom={permitValidFrom}
                  validUntil={permitValidUntil}
                  requireValidityRange={manualReviewAutoApproved}
                  disabled={disabled || uploadingKey !== null}
                  uploading={uploadingKey === item.fileKey}
                  requiresMaterial={requiresMaterialBeforePermitUpload}
                  onUploadPermit={onUploadPermit}
                  onRequireMaterial={onRequireMaterial}
                />
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function LocalSelectedPermitFilePreviewLink({
  file,
  label,
}: {
  file: File;
  label: string;
}) {
  const previewUrl = useMemo(() => URL.createObjectURL(file), [file]);
  useEffect(() => () => URL.revokeObjectURL(previewUrl), [previewUrl]);
  const fileName = normalizeDisplayText(file.name) || `${label}附件`;

  return (
    <a
      href={previewUrl}
      target="_blank"
      rel="noreferrer"
      className="inline-flex max-w-full items-center gap-1 rounded-md border border-blue-200 bg-blue-50/90 px-2 py-0.5 text-[11px] font-semibold text-blue-700 underline-offset-2 hover:underline"
      title={`预览最新${fileName}`}
    >
      <Eye className="h-3 w-3 shrink-0" />
      <span className="truncate">{fileName}</span>
      <span className="rounded bg-blue-100 px-1 text-[10px]">最新</span>
    </a>
  );
}

function DailyPermitManualReviewBadge({
  verification,
  manualReviewAutoApproved,
  followupRecordId = null,
  pendingDecision = null,
  disabled = false,
  refreshing = false,
  onRequestManualReview,
}: {
  verification: DailyPermitVerification;
  manualReviewAutoApproved: boolean;
  followupRecordId?: string | null;
  pendingDecision?: ConstructionPermitManualReviewDecision | null;
  disabled?: boolean;
  refreshing?: boolean;
  onRequestManualReview?: (
    verification: DailyPermitVerification,
    followupRecordId: string | null,
    decision: ConstructionPermitManualReviewDecision,
    validFrom: string | null,
    validUntil: string | null,
  ) => void | Promise<void>;
}) {
  const review = verification.manualReview;
  const [manualValidFrom, setManualValidFrom] = useState(
    review.validFrom || '',
  );
  const [manualValidUntil, setManualValidUntil] = useState(
    review.validUntil || '',
  );
  if (manualReviewAutoApproved) {
    return <AutomaticManualReviewBadge label="人工审核默认通过" />;
  }
  const hasPendingDecision = Boolean(pendingDecision);
  const isPassed =
    pendingDecision === 'passed' ||
    (!hasPendingDecision && review.status === 'passed');
  const isRejected =
    pendingDecision === 'rejected' ||
    (!hasPendingDecision && review.status === 'rejected');
  const isStale = !hasPendingDecision && review.status === 'stale';
  const label = hasPendingDecision
    ? pendingDecision === 'passed'
      ? '待提交通过'
      : '待提交驳回'
    : isPassed
      ? '人工已审'
      : isRejected
        ? '人工驳回'
        : isStale
          ? '需重审'
          : '待人工审';
  const targetFollowupRecordId =
    followupRecordId || verification.sourceFollowupRecordId || null;
  const hasFollowupRecord = Boolean(targetFollowupRecordId);
  const actionLabel = hasFollowupRecord
    ? '先暂存，点击提交人工审核后同步多维表'
    : '提交每日准备后可人工审核';
  const controlDisabled =
    disabled || refreshing || !onRequestManualReview || !hasFollowupRecord;
  const handleDecision = (decision: ConstructionPermitManualReviewDecision) => {
    if (controlDisabled) {
      return;
    }
    void onRequestManualReview?.(
      verification,
      targetFollowupRecordId,
      decision,
      decision === 'passed' ? manualValidFrom : null,
      decision === 'passed' ? manualValidUntil : null,
    );
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            'inline-flex h-7 items-center gap-1 rounded-md border bg-white/80 px-2 text-[11px] font-semibold transition focus:outline-none focus:ring-2 focus:ring-blue-200 disabled:cursor-not-allowed disabled:opacity-70',
            hasPendingDecision
              ? 'border-blue-200 text-blue-700 hover:bg-blue-50'
              : isPassed
                ? 'border-emerald-200 text-emerald-700 hover:bg-emerald-50'
                : isRejected
                  ? 'border-rose-200 text-rose-700 hover:bg-rose-50'
                  : isStale
                    ? 'border-amber-200 text-amber-700 hover:bg-amber-50'
                    : 'border-slate-200 text-slate-500 hover:border-blue-200 hover:bg-blue-50 hover:text-blue-700',
          )}
          title={`${hasPendingDecision ? label : review.message}，${actionLabel}`}
          aria-label={`${verification.label}${hasPendingDecision ? label : review.message}，${actionLabel}`}
          disabled={controlDisabled}
        >
          {refreshing ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : hasPendingDecision ? (
            <UploadCloud className="h-3.5 w-3.5" />
          ) : isPassed ? (
            <CheckCircle2 className="h-3.5 w-3.5" />
          ) : isRejected ? (
            <AlertCircle className="h-3.5 w-3.5" />
          ) : (
            <UserCheck className="h-3.5 w-3.5" />
          )}
          {label}
          <ChevronDown className="h-3 w-3 opacity-70" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64 p-2">
        <label className="mb-2 grid gap-1 text-xs font-semibold text-slate-600">
          作业票有效期开始<span className="text-rose-500">*</span>
          <Input
            type="date"
            value={manualValidFrom}
            max={manualValidUntil || undefined}
            onChange={(event) => setManualValidFrom(event.target.value)}
            disabled={controlDisabled}
            className="h-8 text-xs"
          />
        </label>
        <label className="mb-2 grid gap-1 text-xs font-semibold text-slate-600">
          作业票有效期结束<span className="text-rose-500">*</span>
          <Input
            type="date"
            value={manualValidUntil}
            min={manualValidFrom || undefined}
            onChange={(event) => setManualValidUntil(event.target.value)}
            disabled={controlDisabled}
            className="h-8 text-xs"
          />
        </label>
        <DropdownMenuItem
          className="text-emerald-700 focus:bg-emerald-50 focus:text-emerald-800"
          disabled={
            controlDisabled ||
            !manualValidFrom ||
            !manualValidUntil ||
            manualValidFrom > manualValidUntil
          }
          onClick={() => handleDecision('passed')}
        >
          <CheckCircle2 className="h-4 w-4" />
          标记通过
        </DropdownMenuItem>
        <DropdownMenuItem
          className="text-rose-700 focus:bg-rose-50 focus:text-rose-800"
          disabled={controlDisabled}
          onClick={() => handleDecision('rejected')}
        >
          <AlertCircle className="h-4 w-4" />
          标记驳回
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function DailyPermitAuditDetailPanel({
  id,
  auditDetails,
  invalidDetails,
}: {
  id: string;
  auditDetails: ReturnType<typeof getDailyPermitAuditDetails>;
  invalidDetails: ReturnType<typeof getDailyPermitInvalidDetails>;
}) {
  const issueText = invalidDetails?.reason || auditDetails?.issue || '';
  const suggestionText =
    invalidDetails?.suggestion || auditDetails?.suggestion || '';

  return (
    <div
      id={id}
      className="mt-2 max-h-64 overflow-y-auto rounded-md border border-rose-100 bg-white/85 px-2 py-2 text-[11px] leading-5 text-rose-800"
    >
      <div className="grid gap-2 sm:grid-cols-2">
        <DailyPermitDetailField
          label="核验结论"
          value={auditDetails?.conclusion}
        />
        <DailyPermitDetailField label="有效期" value={auditDetails?.expiry} />
        <DailyPermitDetailField
          label="核验日期"
          value={auditDetails?.verificationDate}
        />
        <DailyPermitDetailField label="版本" value={auditDetails?.version} />
      </div>
      <DailyPermitDetailField
        className="mt-2"
        label="说明"
        value={auditDetails?.description}
      />
      <DailyPermitDetailList label="问题" value={issueText} />
      <DailyPermitDetailList label="建议" value={suggestionText} />
      {auditDetails?.rawText && (
        <details className="mt-2 rounded-md border border-rose-100 bg-rose-50/50 px-2 py-1">
          <summary className="cursor-pointer select-none font-semibold">
            AI原文
          </summary>
          <div className="mt-1 max-h-24 overflow-y-auto break-words text-rose-700/90">
            {auditDetails.rawText}
          </div>
        </details>
      )}
    </div>
  );
}

function DailyPermitDetailField({
  label,
  value,
  className,
}: {
  label: string;
  value?: string | null;
  className?: string;
}) {
  if (!value) {
    return null;
  }

  return (
    <div className={className}>
      <div className="font-semibold text-rose-900">{label}</div>
      <div className="mt-0.5 break-words text-rose-700">{value}</div>
    </div>
  );
}

function DailyPermitDetailList({
  label,
  value,
}: {
  label: string;
  value?: string | null;
}) {
  const items = splitDailyPermitDetailText(value);
  if (items.length === 0) {
    return null;
  }

  return (
    <div>
      <div className="font-semibold text-rose-900">{label}</div>
      <ul className="mt-1 max-h-32 space-y-1 overflow-y-auto">
        {items.map((item, index) => (
          <li key={`${label}-${index}`} className="flex gap-1.5">
            <span className="mt-[0.45rem] h-1 w-1 shrink-0 rounded-full bg-rose-400" />
            <span className="break-words text-rose-700">{item}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function getDailyPermitCardMeta(
  item: DailyPermitVerification,
  auditDetails: ReturnType<typeof getDailyPermitAuditDetails>,
): string {
  const validityRange =
    item.manualReview.validFrom && item.manualReview.validUntil
      ? `有效期 ${item.manualReview.validFrom} 至 ${item.manualReview.validUntil}`
      : '';
  const parts = [
    validityRange,
    auditDetails?.expiry || item.expiryDate
      ? validityRange
        ? ''
        : `有效期至 ${auditDetails?.expiry || item.expiryDate}`
      : '',
    auditDetails?.verificationDate
      ? `核验 ${auditDetails.verificationDate}`
      : '',
  ].filter(Boolean);

  return parts.join(' · ');
}

function splitDailyPermitDetailText(value?: string | null): string[] {
  return String(value || '')
    .split(/[；;。]\s*|、(?=(?:[^0-9]|$))/)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 12);
}

function DailyPermitUploadButton({
  verification,
  validFrom,
  validUntil,
  requireValidityRange,
  disabled,
  uploading,
  requiresMaterial,
  onUploadPermit,
  onRequireMaterial,
}: {
  verification: DailyPermitVerification;
  validFrom: string;
  validUntil: string;
  requireValidityRange: boolean;
  disabled: boolean;
  uploading: boolean;
  requiresMaterial: boolean;
  onUploadPermit?: (
    verification: DailyPermitVerification,
    selectedFiles: File[],
  ) => void | Promise<void>;
  onRequireMaterial?: (workType: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);

  if (!onUploadPermit) {
    return null;
  }

  return (
    <div className="mt-2">
      <input
        ref={inputRef}
        type="file"
        multiple
        className="sr-only"
        aria-label={`上传新的${verification.label}`}
        onChange={(event) => {
          const selectedFiles = Array.from(event.target.files || []);
          event.currentTarget.value = '';
          if (requireValidityRange) {
            if (!validFrom || !validUntil) {
              toast.error(
                `请先选择${verification.label}有效期开始和结束日期`,
              );
              return;
            }
            if (validFrom > validUntil) {
              toast.error(
                `${verification.label}有效期开始日期不能晚于结束日期`,
              );
              return;
            }
          }
          if (selectedFiles.length > 0) {
            void onUploadPermit(verification, selectedFiles);
          }
        }}
      />
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={disabled}
        className="h-7 rounded-md border-amber-200 bg-white/80 px-2 text-[11px] font-semibold text-amber-700 hover:bg-amber-50"
        onClick={() => {
          if (requiresMaterial) {
            onRequireMaterial?.(verification.workType);
            return;
          }
          if (requireValidityRange) {
            if (!validFrom || !validUntil) {
              toast.error(
                `请先选择${verification.label}有效期开始和结束日期`,
              );
              return;
            }
            if (validFrom > validUntil) {
              toast.error(
                `${verification.label}有效期开始日期不能晚于结束日期`,
              );
              return;
            }
          }
          inputRef.current?.click();
        }}
      >
        {uploading ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <UploadCloud className="h-3.5 w-3.5" />
        )}
        {requiresMaterial ? '补充四类资料' : '上传新作业票'}
      </Button>
    </div>
  );
}

function DailyFollowupStageStepper({
  value,
  progress,
  permitVerifications,
  onChange,
}: {
  value: DailyFollowupStage;
  progress: DailyFollowupStageProgress;
  permitVerifications: readonly DailyPermitVerification[];
  onChange: (value: DailyFollowupStage) => void;
}) {
  const blockingPermitIssues =
    getBlockingDailyPermitIssues(permitVerifications);
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50/70 p-3">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div>
          <div className="text-xs font-semibold text-slate-500">
            每日跟进阶段<span className="ml-0.5 text-rose-500">*</span>
          </div>
          <div className="mt-0.5 text-xs text-slate-500">
            按准备、进行、收尾依次提交；前一阶段完成后才能进入下一阶段。
          </div>
        </div>
      </div>
      <div className="grid gap-2 md:grid-cols-3">
        {DAILY_FOLLOWUP_STAGES.map((stage, index) => {
          const Icon = stage.icon;
          const sequenceEnabled = isDailyFollowupStageEnabled(
            stage.key,
            progress,
          );
          const permitEnabled = isDailyFollowupStageAllowedByPermits(
            stage.key,
            permitVerifications,
          );
          const enabled = sequenceEnabled && permitEnabled;
          const completed = progress[stage.key];
          const selected = value === stage.key;
          const permitStatusText =
            getDailyPermitBlockingShortStatus(blockingPermitIssues);
          const statusText = completed
            ? '已完成'
            : stage.key === 'process' && progress.processEvidence
              ? '可继续提交'
              : !sequenceEnabled
                ? stage.key === 'close' && !progress.processEvidence
                  ? '待施工过程照片'
                  : '待前置阶段'
                : !permitEnabled
                  ? permitStatusText
                  : '可提交';

          return (
            <button
              key={stage.key}
              type="button"
              disabled={!enabled}
              onClick={() => enabled && onChange(stage.key)}
              className={cn(
                'rounded-lg border px-3 py-3 text-left transition focus:outline-none focus:ring-2 focus:ring-blue-100',
                selected
                  ? 'border-blue-200 bg-white text-blue-700 shadow-sm ring-1 ring-blue-100'
                  : completed
                    ? 'border-emerald-100 bg-emerald-50/70 text-emerald-700'
                    : enabled
                      ? 'border-slate-200 bg-white text-slate-700 hover:border-blue-200'
                      : 'cursor-not-allowed border-slate-100 bg-slate-100/80 text-slate-400',
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="inline-flex items-center gap-2 text-sm font-semibold">
                  <Icon className="h-4 w-4" />
                  {stage.label}
                </span>
                <span className="text-[11px] font-semibold opacity-70">
                  0{index + 1}
                </span>
              </div>
              <div className="mt-1 text-xs opacity-75">{stage.description}</div>
              <div className="mt-2 text-[11px] font-medium">{statusText}</div>
            </button>
          );
        })}
      </div>
      {blockingPermitIssues.length > 0 && (
        <div className="mt-3 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs leading-5 text-rose-700">
          {getDailyPermitBlockingMessage(blockingPermitIssues)}
        </div>
      )}
    </div>
  );
}

function getDailyPermitBlockingShortStatus(
  blockingPermitIssues: readonly DailyPermitVerification[],
): string {
  if (blockingPermitIssues.some((item) => item.status === 'expired')) {
    return '作业票过期';
  }
  if (blockingPermitIssues.some((item) => item.status === 'pendingReview')) {
    return '作业票待人工审';
  }
  if (blockingPermitIssues.some((item) => item.status === 'invalid')) {
    return '作业票需复核';
  }
  return '作业票待处理';
}

function getDailyPermitBlockingMessage(
  blockingPermitIssues: readonly DailyPermitVerification[],
): string {
  const labels = blockingPermitIssues.map((item) => item.label).join('、');
  if (blockingPermitIssues.some((item) => item.status === 'expired')) {
    return `${labels}已过期，进入施工过程前需上传续期作业票并重新人工审核。`;
  }
  if (blockingPermitIssues.some((item) => item.status === 'pendingReview')) {
    return `${labels}待人工审核，在页面提交人工审核后可进入施工过程。`;
  }
  if (blockingPermitIssues.some((item) => item.status === 'invalid')) {
    return `${labels}待人工审核，请重新上传并提交人工审核后再进入施工过程。`;
  }
  return `${labels}未满足作业票校核要求，请先处理后再进入施工过程。`;
}

function CompletionChecklistEditor({
  value,
  items,
  mode,
  disabled = false,
  onChange,
}: {
  value: CompletionChecklistFormState;
  items: readonly ConstructionCompletionChecklistTemplateItem[];
  mode: 'full' | 'daily';
  disabled?: boolean;
  onChange: (value: CompletionChecklistFormState) => void;
}) {
  const progress = getCompletionChecklistProgress(value, items);
  const title = mode === 'full' ? '项目收尾检查清单' : '每日完工检查清单';
  const updateItem = (
    key: string,
    patch: Partial<CompletionChecklistFormState[string]>,
  ) => {
    if (disabled) {
      return;
    }
    onChange({
      ...value,
      [key]: {
        ...(value[key] || { result: '', remark: '' }),
        ...patch,
      },
    });
  };

  return (
    <section className="md:col-span-2 rounded-lg border border-slate-200 bg-white">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-3 py-3">
        <div className="flex items-center gap-2">
          <ListChecks className="h-4 w-4 text-blue-600" />
          <div>
            <div className="text-sm font-semibold text-slate-900">
              {title}
              <span className="ml-0.5 text-rose-500">*</span>
            </div>
          </div>
        </div>
        <Badge className="bg-blue-50 text-blue-700 hover:bg-blue-50">
          {disabled ? '待选择' : `${progress.done}/${progress.total}`}
        </Badge>
      </div>
      <div className="max-h-[360px] overflow-y-auto divide-y divide-slate-100">
        {disabled && (
          <div className="px-3 py-6 text-center text-sm text-slate-500">
            请先选择项目是否整体全部完成后填写对应检查清单。
          </div>
        )}
        {!disabled &&
          items.map((item) => {
            const current = value[item.key] || { result: '', remark: '' };
            const needsRemark = current.result === '×';

            return (
              <div
                key={item.key}
                className="grid gap-3 px-3 py-3 md:grid-cols-[1fr_auto]"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] font-semibold text-slate-600">
                      {item.no}
                    </span>
                    <span className="text-xs font-semibold text-slate-500">
                      {item.category}
                    </span>
                  </div>
                  <div className="mt-1 text-sm leading-5 text-slate-800">
                    {item.content}
                  </div>
                  {(needsRemark || current.remark) && (
                    <Input
                      value={current.remark}
                      onChange={(event) =>
                        updateItem(item.key, { remark: event.target.value })
                      }
                      disabled={disabled}
                      placeholder={needsRemark ? '填写整改说明' : '备注'}
                      className={cn(
                        'mt-2 h-8 border-slate-200 bg-slate-50 text-xs focus-visible:ring-blue-200',
                        needsRemark &&
                          !current.remark.trim() &&
                          'border-rose-200 focus-visible:ring-rose-100',
                      )}
                    />
                  )}
                </div>
                <div className="grid h-9 grid-cols-3 rounded-md border border-slate-200 bg-slate-50 p-0.5 md:w-[168px]">
                  {(['√', '×', 'N/A'] as const).map((result) => (
                    <button
                      key={result}
                      type="button"
                      disabled={disabled}
                      onClick={() =>
                        updateItem(item.key, {
                          result,
                          remark:
                            result === '×' ? current.remark : current.remark,
                        })
                      }
                      className={cn(
                        'rounded px-2 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-60',
                        current.result === result
                          ? result === '×'
                            ? 'bg-rose-600 text-white shadow-sm'
                            : result === 'N/A'
                              ? 'bg-slate-700 text-white shadow-sm'
                              : 'bg-emerald-600 text-white shadow-sm'
                          : 'text-slate-500 hover:bg-white hover:text-slate-800',
                      )}
                    >
                      {result}
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
      </div>
    </section>
  );
}

function CrewCheckListItem({
  member,
  checked,
  disabled,
  onToggle,
}: {
  member: ConstructionCrewMemberItem;
  checked: boolean;
  disabled: boolean;
  onToggle: (recordId: string) => void;
}) {
  const handleChange = useCallback(() => {
    onToggle(member.recordId);
  }, [member.recordId, onToggle]);

  return (
    <label
      className={cn(
        'flex cursor-pointer items-start gap-2 rounded-lg border bg-white px-3 py-2 text-sm shadow-sm transition hover:border-blue-200 hover:bg-blue-50/40',
        checked ? 'border-blue-200 ring-1 ring-blue-100' : 'border-slate-100',
        disabled &&
          'cursor-not-allowed border-slate-200 bg-slate-100/80 opacity-75 hover:border-slate-200 hover:bg-slate-100/80',
      )}
      style={{
        contentVisibility: 'auto',
        containIntrinsicSize: '72px',
      }}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={handleChange}
        className="mt-1 h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-200 disabled:cursor-not-allowed"
      />
      <span className="min-w-0">
        <span className="flex flex-wrap items-center gap-1.5 font-semibold text-slate-900">
          {member.name}
          <span
            className={cn(
              'rounded px-1.5 py-0.5 text-[10px] font-medium',
              member.authorizationStatus === '授权有效'
                ? 'bg-emerald-50 text-emerald-700'
                : member.authorizationStatus === '已过期'
                  ? 'bg-rose-50 text-rose-700'
                  : 'bg-amber-50 text-amber-700',
            )}
          >
            {member.authorizationStatus || '未设置授权'}
          </span>
        </span>
        {member.certificateSummary && (
          <span className="mt-1 block truncate text-xs text-slate-500">
            {member.certificateSummary}
          </span>
        )}
        {member.issueSummary && (
          <span className="mt-1 block text-xs text-rose-600">
            {member.issueSummary}
          </span>
        )}
      </span>
    </label>
  );
}

const MemoizedCrewCheckListItem = React.memo(CrewCheckListItem);

function CrewCheckList({
  members,
  checkedIds,
  authorizedCount,
  authorizationNotice,
  onToggle,
  onCheckAll,
  onClear,
  onUpdateAuthorization,
}: {
  members: ConstructionCrewMemberItem[];
  checkedIds: Set<string>;
  authorizedCount: number;
  authorizationNotice: string | null;
  onToggle: (recordId: string) => void;
  onCheckAll: () => void;
  onClear: () => void;
  onUpdateAuthorization: () => void;
}) {
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50/70 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-xs font-semibold text-slate-500">
            第 2 步 · 每日人员核查
            <span className="ml-0.5 text-rose-500">*</span>
          </div>
          <div className="mt-0.5 text-xs text-slate-500">
            勾选今日实际参与施工的人员
          </div>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <span className="font-semibold text-blue-700">
            {checkedIds.size}/{authorizedCount} 可核查 · 名单 {members.length}
          </span>
          <button
            type="button"
            className="text-blue-600 hover:text-blue-700"
            onClick={onCheckAll}
            disabled={authorizedCount === 0}
          >
            全部参与
          </button>
          <button
            type="button"
            className="text-slate-500 hover:text-slate-700"
            onClick={onClear}
          >
            清空
          </button>
          <button
            type="button"
            className="rounded-md border border-amber-200 bg-amber-50 px-2 py-1 font-medium text-amber-700 transition hover:bg-amber-100"
            onClick={onUpdateAuthorization}
          >
            更新人员授权
          </button>
        </div>
      </div>
      {authorizationNotice && (
        <div
          role="alert"
          className="mt-3 flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800"
        >
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{authorizationNotice}</span>
        </div>
      )}
      <div className="mt-3 grid max-h-72 gap-2 overflow-auto md:grid-cols-2">
        {members.map((member) => {
          const checked = checkedIds.has(member.recordId);
          const disabled = member.authorizationStatus !== '授权有效';

          return (
            <MemoizedCrewCheckListItem
              key={member.recordId}
              member={member}
              checked={checked}
              disabled={disabled}
              onToggle={onToggle}
            />
          );
        })}
      </div>
    </div>
  );
}

function Field({
  label,
  children,
  className,
  required = false,
  asLabel = true,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
  required?: boolean;
  asLabel?: boolean;
}) {
  const content = (
    <>
      <span className="text-xs font-semibold text-slate-500">
        {label}
        {required && <span className="ml-0.5 text-rose-500">*</span>}
      </span>
      {children}
    </>
  );

  return asLabel ? (
    <label className={cn('grid gap-2', className)}>{content}</label>
  ) : (
    <div className={cn('grid gap-2', className)}>{content}</div>
  );
}

function SelectField({
  label,
  value,
  options,
  emptyLabel,
  required = false,
  onChange,
}: {
  label: string;
  value: string;
  options: SelectFieldOption[];
  emptyLabel?: string;
  required?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <Field label={label} required={required}>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-9 rounded-md border border-slate-200 bg-slate-50 px-3 text-sm outline-none transition focus:border-blue-300 focus:ring-2 focus:ring-blue-100"
      >
        {options.map((item) => {
          const option =
            typeof item === 'string' ? { value: item, label: item } : item;
          return (
            <option key={option.value || 'empty'} value={option.value}>
              {option.label || emptyLabel || '请选择'}
            </option>
          );
        })}
      </select>
    </Field>
  );
}

function FileGrid({
  fields,
  files,
  existingFiles = {},
  requiredKeys = [],
  fieldActions = {},
  fieldStatusHints = {},
  onUploadedFileRemove,
  onFilesChange,
}: {
  fields: ReadonlyArray<readonly [string, string]>;
  files: FileBucket;
  existingFiles?: Record<string, ConstructionAttachmentFile[]>;
  requiredKeys?: readonly string[];
  fieldActions?: Partial<Record<string, React.ReactNode>>;
  fieldStatusHints?: Partial<Record<string, FileFieldStatusHint>>;
  onUploadedFileRemove?: (fieldKey: string, fileToken: string) => void;
  onFilesChange: React.Dispatch<React.SetStateAction<FileBucket>>;
}) {
  return (
    <div className="grid gap-3 md:col-span-2 md:grid-cols-2">
      {fields.map(([key, label]) => {
        const required = requiredKeys.includes(key);

        return (
          <MemoizedFilePickerField
            key={key}
            fieldKey={key}
            label={label}
            required={required}
            selectedFiles={files[key] || []}
            uploadedFiles={existingFiles[key] || []}
            fieldAction={fieldActions[key]}
            statusHint={fieldStatusHints[key]}
            onUploadedFileRemove={onUploadedFileRemove}
            onFilesChange={onFilesChange}
          />
        );
      })}
    </div>
  );
}

function FilePickerField({
  fieldKey,
  label,
  required,
  selectedFiles,
  uploadedFiles,
  fieldAction,
  statusHint,
  onUploadedFileRemove,
  onFilesChange,
}: {
  fieldKey: string;
  label: string;
  required: boolean;
  selectedFiles: File[];
  uploadedFiles: ConstructionAttachmentFile[];
  fieldAction?: React.ReactNode;
  statusHint?: FileFieldStatusHint;
  onUploadedFileRemove?: (fieldKey: string, fileToken: string) => void;
  onFilesChange: React.Dispatch<React.SetStateAction<FileBucket>>;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);

  const openFilePicker = useCallback(() => {
    inputRef.current?.click();
  }, []);

  const replaceSelectedFiles = useCallback(
    (nextFiles: File[]) => {
      onFilesChange((current) => ({
        ...current,
        [fieldKey]: nextFiles,
      }));
    },
    [fieldKey, onFilesChange],
  );

  const appendSelectedFiles = useCallback(
    (nextFiles: File[]) => {
      if (nextFiles.length === 0) return;
      onFilesChange((current) => ({
        ...current,
        [fieldKey]: mergeFileLists(current[fieldKey] || [], nextFiles),
      }));
    },
    [fieldKey, onFilesChange],
  );

  return (
    <div
      className={cn(
        'rounded-lg border bg-slate-50/70 px-3 py-3',
        required ? 'border-blue-200 ring-1 ring-blue-50' : 'border-slate-200',
      )}
      data-upload-field={fieldKey}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2 text-xs font-semibold text-slate-600">
          <UploadCloud className="h-3.5 w-3.5 shrink-0 text-blue-500" />
          <span className="truncate">{label}</span>
          {required && <span className="text-rose-500">*</span>}
        </div>
      </div>
      {fieldAction && <div className="mt-2">{fieldAction}</div>}
      {statusHint && (
        <div
          className={cn(
            'mt-2 rounded-md border px-2.5 py-1.5 text-xs font-semibold',
            statusHint.tone === 'danger' &&
              'border-rose-200 bg-rose-50 text-rose-700',
            statusHint.tone === 'warning' &&
              'border-amber-200 bg-amber-50 text-amber-700',
            statusHint.tone === 'success' &&
              'border-emerald-200 bg-emerald-50 text-emerald-700',
            statusHint.tone === 'neutral' &&
              'border-slate-200 bg-white text-slate-500',
          )}
        >
          {statusHint.text}
        </div>
      )}
      <div className="mt-2 flex min-h-9 flex-wrap items-center gap-2">
        <input
          ref={inputRef}
          type="file"
          multiple
          className="sr-only"
          aria-label={`选择${label}附件`}
          onChange={(event) => {
            appendSelectedFiles(Array.from(event.target.files || []));
            event.currentTarget.value = '';
          }}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 rounded-md border-blue-100 bg-blue-50 px-3 text-xs font-semibold text-blue-700 hover:bg-blue-100"
          onClick={openFilePicker}
        >
          选择文件
        </Button>
        <span className="min-w-0 flex-1 truncate text-xs text-slate-500">
          {getFilePickerFieldSummary(selectedFiles, uploadedFiles)}
        </span>
        {selectedFiles.length > 0 && (
          <button
            type="button"
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
            aria-label={`清空${label}附件`}
            onClick={() => replaceSelectedFiles([])}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      {uploadedFiles.length > 0 && (
        <div className="mt-2 grid gap-1.5">
          {uploadedFiles.map((file, index) => {
            const fileName = normalizeDisplayText(file.name) || `${label}附件`;
            return (
              <div
                key={`${fieldKey}-${file.fileToken}-${index}`}
                className="flex min-w-0 items-center gap-1.5 rounded-md border border-slate-200 bg-white/85 px-2 py-1 text-[11px] font-semibold text-slate-600"
              >
                <a
                  href={getConstructionAttachmentPreviewUrl(file, fileName)}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex min-w-0 flex-1 items-center gap-1 underline-offset-2 hover:text-blue-700 hover:underline"
                  title={`预览${fileName}`}
                >
                  <Eye className="h-3 w-3 shrink-0 text-blue-500" />
                  <span className="truncate">{fileName}</span>
                </a>
                {onUploadedFileRemove && file.fileToken && (
                  <button
                    type="button"
                    className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-slate-400 transition hover:bg-rose-50 hover:text-rose-600 focus:outline-none focus:ring-2 focus:ring-rose-100"
                    aria-label={`移除已上传${fileName}`}
                    title={`移除已上传${fileName}`}
                    onClick={() =>
                      onUploadedFileRemove(fieldKey, file.fileToken)
                    }
                  >
                    <X className="h-3 w-3" />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

const MemoizedFilePickerField = React.memo(FilePickerField);

function mergeFileLists(currentFiles: File[], nextFiles: File[]): File[] {
  const seen = new Set(currentFiles.map(getFileIdentity));
  const merged = [...currentFiles];
  nextFiles.forEach((file) => {
    const identity = getFileIdentity(file);
    if (!seen.has(identity)) {
      seen.add(identity);
      merged.push(file);
    }
  });
  return merged;
}

function getFileIdentity(file: File): string {
  return [file.name, file.size, file.lastModified].join(':');
}

function getFilePickerFieldSummary(
  selectedFiles: File[],
  uploadedFiles: ConstructionAttachmentFile[],
): string {
  if (selectedFiles.length > 0) {
    return formatFileNameList(
      selectedFiles.map((file) => file.name),
      '已选',
    );
  }
  if (uploadedFiles.length > 0) {
    return formatFileNameList(
      uploadedFiles.map((file) => normalizeDisplayText(file.name) || '附件'),
      '已上传',
    );
  }
  return '未选择任何文件';
}

function formatFileNameList(names: string[], prefix: string): string {
  const visibleNames = names.slice(0, 2).join('、');
  const extraCount = names.length - 2;
  return extraCount > 0
    ? `${prefix} ${names.length} 个：${visibleNames} 等`
    : `${prefix} ${names.length} 个：${visibleNames}`;
}

function buildConstructionStatusGroups(
  items: ConstructionOverviewItem[],
  constructionAiAuditEnabled = false,
): ConstructionStatusGroup[] {
  const byState = items.reduce<
    Record<ConstructionWorkState, ConstructionOverviewItem[]>
  >(
    (acc, item) => {
      acc[getConstructionWorkState(item, constructionAiAuditEnabled)].push(
        item,
      );
      return acc;
    },
    {
      approval: [],
      active: [],
      completed: [],
    },
  );

  const sortBySchedule = (
    left: ConstructionOverviewItem,
    right: ConstructionOverviewItem,
  ) => getItemStartTime(left) - getItemStartTime(right);

  return [
    {
      key: 'approval',
      label: '项目施工申请',
      helper: '申请审批',
      accent: 'amber',
      description: '施工申请材料、人员资料和审批节点未闭环，或尚未到施工窗口。',
      icon: ClipboardCheck,
      items: byState.approval.sort(sortBySchedule),
    },
    {
      key: 'active',
      label: '施工进行时',
      helper: '现场施工',
      accent: 'indigo',
      description: '已进入施工窗口且未闭环，重点关注现场跟进和每日留痕。',
      icon: Clock3,
      items: byState.active.sort(sortBySchedule),
    },
    {
      key: 'completed',
      label: '施工闭环/终止归档',
      helper: '闭环终止',
      accent: 'emerald',
      description: '收尾已确认完成或项目已终止，施工记录进入归档状态。',
      icon: CheckCircle2,
      items: byState.completed.sort(
        (a, b) => getItemStartTime(b) - getItemStartTime(a),
      ),
    },
  ];
}

function getConstructionWorkState(
  item: ConstructionOverviewItem,
  constructionAiAuditEnabled = false,
): ConstructionWorkState {
  const approvalFlowComplete = getApprovalFlowProgress(
    item,
    constructionAiAuditEnabled,
  ).isComplete;
  if (isConstructionProjectArchived(item)) {
    return 'completed';
  }
  if (!approvalFlowComplete || getScheduleMeta(item).state === 'upcoming') {
    return 'approval';
  }
  return 'active';
}

function isConstructionProjectArchived(
  item: ConstructionOverviewItem,
): boolean {
  return (
    isConstructionProjectTerminated(item) ||
    item.followups.some((followup) => followup.completed === '是')
  );
}

function isConstructionProjectTerminated(
  item: ConstructionOverviewItem,
): boolean {
  return /终止|中止|作废|取消/.test(item.workflow || '');
}

function isDailyFollowupOpenForProject(
  item: ConstructionOverviewItem,
  constructionAiAuditEnabled = false,
): boolean {
  return (
    Boolean(item.constructionCode) &&
    getConstructionWorkState(item, constructionAiAuditEnabled) === 'active'
  );
}

function getFollowupProjectOptions(
  items: ConstructionOverviewItem[],
  mode: FollowupMode,
  constructionAiAuditEnabled = false,
): ConstructionOverviewItem[] {
  const persistedItems = items.filter(
    (item) => !isOptimisticConstructionRecordId(item.recordId),
  );
  if (mode !== 'daily') {
    return persistedItems;
  }

  return persistedItems.filter((item) =>
    isDailyFollowupOpenForProject(item, constructionAiAuditEnabled),
  );
}

function summarizeDailyProgressStages(
  items: ConstructionOverviewItem[],
  referenceDate: Date,
  constructionAiAuditEnabled = false,
): DailyProgressStageSummary[] {
  const activeItems = getDailyProgressCandidateItems(
    items,
    (item) =>
      getConstructionWorkState(item, constructionAiAuditEnabled) === 'active',
    (item) => hasTodayDailyFollowup(item, referenceDate),
  );
  const stageItems = groupDailyProgressItems(
    activeItems,
    (item) =>
      getDailyFollowupStageProgress(
        item,
        referenceDate,
        constructionAiAuditEnabled,
      ),
    getItemStartTime,
  );

  return DAILY_PROGRESS_STAGES.map((definition) => {
    const itemsInStage = stageItems[definition.key];
    const done = itemsInStage.filter(
      (item) =>
        getDailyFollowupStageProgress(
          item,
          referenceDate,
          constructionAiAuditEnabled,
        )[definition.key],
    ).length;

    return {
      ...definition,
      total: itemsInStage.length,
      done,
      pending: itemsInStage.length - done,
      items: itemsInStage,
    };
  });
}

function getItemsForDailyProgressStage(
  items: ConstructionOverviewItem[],
  stageKey: DailyFollowupStage,
  referenceDate: Date,
  constructionAiAuditEnabled = false,
): ConstructionOverviewItem[] {
  return groupDailyProgressItems(
    getDailyProgressCandidateItems(
      items,
      (item) =>
        getConstructionWorkState(item, constructionAiAuditEnabled) === 'active',
      (item) => hasTodayDailyFollowup(item, referenceDate),
    ),
    (item) =>
      getDailyFollowupStageProgress(
        item,
        referenceDate,
        constructionAiAuditEnabled,
      ),
    getItemStartTime,
  )[stageKey];
}

function getActiveConstructionItems(
  items: ConstructionOverviewItem[],
): ConstructionOverviewItem[] {
  return items.filter((item) => getConstructionWorkState(item) === 'active');
}

function hasTodayDailyFollowup(
  item: ConstructionOverviewItem,
  referenceDate: Date,
): boolean {
  return getTodayConstructionFollowups(item, referenceDate).some(
    isDailyFollowupRecord,
  );
}

function getProjectInProgressItems(
  items: ConstructionOverviewItem[],
  constructionAiAuditEnabled = false,
): ConstructionOverviewItem[] {
  return sortProjectItemsByCreatedAtDesc(
    items.filter(
      (item) =>
        getConstructionWorkState(item, constructionAiAuditEnabled) !==
        'completed',
    ),
  );
}

function matchesConstructionProjectSearch(
  item: ConstructionOverviewItem,
  query: string,
): boolean {
  const needle = normalizeProjectSearchText(query);
  if (!needle) {
    return true;
  }

  const haystack = normalizeProjectSearchText(
    [
      item.workContent,
      item.constructionCode,
      item.building,
      item.specialty,
      item.contractorType,
      item.relatedWorkType,
      item.workTypes.join(' '),
      formatDateRange(item.planStartTime, item.planEndTime),
    ]
      .filter(Boolean)
      .join(' '),
  );

  return isFuzzySearchMatch(haystack, needle);
}

function normalizeProjectSearchText(value: string | null | undefined): string {
  return normalizeDisplayText(value).toLocaleLowerCase().replace(/\s+/g, '');
}

function isFuzzySearchMatch(source: string, query: string): boolean {
  if (!query) {
    return true;
  }
  if (source.includes(query)) {
    return true;
  }

  let queryIndex = 0;
  for (const char of source) {
    if (char === query[queryIndex]) {
      queryIndex += 1;
      if (queryIndex === query.length) {
        return true;
      }
    }
  }

  return false;
}

function getItemLatestStartTime(item: ConstructionOverviewItem): number {
  return (
    parseOptionalDate(item.planStartTime)?.getTime() || Number.MIN_SAFE_INTEGER
  );
}

function getLifecycleStatusText(status: LifecycleStageStatus): string {
  const statusLabel: Record<LifecycleStageStatus, string> = {
    done: '已闭环',
    active: '当前阶段',
    blocked: '进行中',
    pending: '待进入',
  };

  return statusLabel[status];
}

function getLifecycleStageDetailRows(
  item: ConstructionOverviewItem,
  stage: LifecycleStageView,
  dailyPermitReferenceDate: Date,
  dailyOnly = false,
  constructionAiAuditEnabled = false,
): LifecycleStageDetailRow[] {
  const latest = getLatestRelatedFollowup(
    item,
    stage,
    dailyPermitReferenceDate,
    dailyOnly,
  );
  const initial = getInitialApplicationFollowup(item);
  const attachmentGroups = getLifecycleStageAttachmentGroups(
    item,
    stage,
    dailyPermitReferenceDate,
    dailyOnly,
    constructionAiAuditEnabled,
  );

  if (stage.key === 'apply') {
    return [
      { label: '施工名称', value: item.constructionCode || '待生成' },
      { label: '楼栋', value: item.building || '未填写' },
      { label: '专业', value: item.specialty || '未填写' },
      { label: '作业内容', value: item.workContent || '未填写' },
      { label: '作业类型', value: item.workTypes.join('、') || '未填写' },
      { label: '计划开始时间', value: formatDateTime(item.planStartTime) },
      { label: '计划结束日期', value: formatDateTime(item.planEndTime) },
      { label: '施工方', value: item.contractorType || '未填写' },
      { label: '施工申请人', value: getConstructionApplicantName(item) },
    ];
  }

  if (stage.key === 'approval') {
    const approvalProgress = getApprovalFlowProgress(
      item,
      constructionAiAuditEnabled,
    );
    return [
      { label: '施工编号', value: item.constructionCode || '待生成' },
      { label: '作业类型', value: item.workTypes.join('、') || '未填写' },
      { label: '施工申请人', value: getConstructionApplicantName(item) },
      {
        label: '审批进度',
        value: `${approvalProgress.completed}/${approvalProgress.total} 节点`,
      },
      { label: '主管审批', value: item.approval.supervisor || '待确认' },
      { label: '知会EHS工程师', value: getEhsNotifiedStatus(item) || '待知会' },
      {
        label: '审批材料提交',
        value: getApprovalMaterialSubmissionState(
          item,
          undefined,
          constructionAiAuditEnabled,
        ).status,
      },
      { label: '质保金确认', value: getDepositConfirmationStatus(item) },
      { label: '质保金要求', value: formatDepositSummary(item) },
      {
        label: '申请与许可材料',
        value:
          [
            ...getApplicationAttachmentLabels(),
            ...getPrepareAttachmentLabels(item),
          ].join('、') || '无额外材料',
      },
      {
        label: '材料提交',
        value: initial
          ? formatDateTime(initial.updatedAt || initial.createdAt)
          : '暂无',
      },
      {
        label: '附件完成',
        value: formatAttachmentCoverage(attachmentGroups),
      },
    ];
  }

  if (stage.key === 'isolation') {
    return [
      ...getDailyPrepareVerificationRows(
        item,
        stage,
        dailyPermitReferenceDate,
        constructionAiAuditEnabled,
      ),
      ...(constructionAiAuditEnabled
        ? [{ label: '隔离反馈', value: latest?.isolationFeedback || '未填写' }]
        : []),
      { label: '跟进人员', value: latest?.followupStaff || '未填写' },
      {
        label: '跟进时间',
        value: latest
          ? formatDateTime(latest.updatedAt || latest.createdAt)
          : '暂无',
      },
    ];
  }

  if (stage.key === 'process') {
    return [
      { label: '过程反馈', value: latest?.processFeedback || '未填写' },
      {
        label: '施工天数',
        value: latest?.constructionDay
          ? `第 ${latest.constructionDay} 天`
          : '未记录',
      },
      { label: '跟进人员', value: latest?.followupStaff || '未填写' },
      {
        label: '跟进时间',
        value: latest
          ? formatDateTime(latest.updatedAt || latest.createdAt)
          : '暂无',
      },
    ];
  }

  return [
    { label: '是否完成', value: latest?.completed || '未填写' },
    { label: '收尾审批', value: latest?.closingApproval || '未填写' },
    {
      label: '跟进时间',
      value: latest
        ? formatDateTime(latest.updatedAt || latest.createdAt)
        : '暂无',
    },
  ];
}

function getDailyPrepareVerificationRows(
  item: ConstructionOverviewItem,
  stage: LifecycleStageView,
  dailyPermitReferenceDate: Date,
  constructionAiAuditEnabled = false,
): LifecycleStageDetailRow[] {
  const todayFollowups = getTodayConstructionFollowups(
    item,
    dailyPermitReferenceDate,
  ).filter((followup) => !isInitialApplicationFollowup(followup));
  const prepareFollowup =
    getDailyFollowupForStage(item, 'prepare', dailyPermitReferenceDate) ||
    todayFollowups[0] ||
    null;
  const todayAttachments = todayFollowups.flatMap(
    (followup) => followup.attachments,
  );
  const hasPersonnelCheck =
    hasAttachment(todayAttachments, '每日人员核查清单') ||
    todayFollowups.some((followup) => Boolean(followup.dailyPersonnelCheck));
  const hasIsolationPhoto =
    hasAttachment(todayAttachments, '挂牌与隔离照片') ||
    (constructionAiAuditEnabled && Boolean(prepareFollowup?.isolationFeedback));
  const isolationManualReviewStatus = getDailyIsolationManualReviewStatus(
    getLatestIsolationManualReviewDecision(todayFollowups),
  );
  const isolationManualReviewPassed = isIsolationManualReviewPassed(
    isolationManualReviewStatus,
  );
  const isolationStageBlocked =
    stage.status === 'blocked' && !isolationManualReviewPassed;
  const confirmedDailyWorkTypes = getConfirmedTodayDailyWorkTypes(
    item,
    dailyPermitReferenceDate,
  );
  const permitSummary = getConfirmedDailyPermitSummary(
    item,
    dailyPermitReferenceDate,
    constructionAiAuditEnabled,
  );

  return [
    {
      label: '作业类型校核',
      value:
        confirmedDailyWorkTypes.length > 0
          ? confirmedDailyWorkTypes.join('、')
          : '待校核',
    },
    {
      label: '人员核查',
      value:
        prepareFollowup?.dailyPersonnelCheck ||
        (hasPersonnelCheck ? '已核查' : '待核查'),
    },
    {
      label: '作业票校核',
      value: permitSummary.value,
    },
    {
      label: '校核说明',
      value: permitSummary.description,
    },
    {
      label: '挂牌隔离',
      value: isolationManualReviewPassed
        ? '已审核'
        : isolationStageBlocked
          ? '需复核'
          : hasIsolationPhoto
            ? '已留痕'
            : '待上传',
    },
  ];
}

function getLatestRelatedFollowup(
  item: ConstructionOverviewItem,
  stage: LifecycleStageView,
  dailyPermitReferenceDate: Date = new Date(),
  dailyOnly = false,
): ConstructionFollowupItem | null {
  return (
    getLifecycleStageRelatedFollowups(
      item,
      stage,
      dailyPermitReferenceDate,
      dailyOnly,
    )[0] || null
  );
}

function getLifecycleStageRelatedFollowups(
  item: ConstructionOverviewItem,
  stage: LifecycleStageView,
  dailyPermitReferenceDate: Date = new Date(),
  dailyOnly = false,
): ConstructionFollowupItem[] {
  let followups: ConstructionFollowupItem[] = [];
  const sourceFollowups =
    dailyOnly && isDailyLifecycleStageKey(stage.key)
      ? getTodayConstructionFollowups(item, dailyPermitReferenceDate).filter(
          (followup) => !isInitialApplicationFollowup(followup),
        )
      : item.followups;

  if (stage.key === 'apply' || stage.key === 'approval') {
    const initial = getInitialApplicationFollowup(item);
    followups = initial
      ? [initial]
      : sourceFollowups.filter((followup) =>
          hasAnyAttachmentByKeys(
            followup.attachments,
            INITIAL_APPLICATION_FILE_KEYS,
          ),
        );
  } else if (stage.key === 'isolation') {
    followups = sourceFollowups.filter((followup) =>
      isDailyFollowupForStage(followup, 'prepare'),
    );
  } else if (stage.key === 'process') {
    followups = sourceFollowups.filter((followup) =>
      isDailyFollowupForStage(followup, 'process'),
    );
  } else if (stage.key === 'close') {
    followups = sourceFollowups.filter((followup) =>
      isDailyFollowupForStage(followup, 'close'),
    );
  }

  return followups
    .slice()
    .sort((left, right) => getFollowupTime(right) - getFollowupTime(left))
    .slice(0, 3);
}

function getLifecycleStageAttachmentGroups(
  item: ConstructionOverviewItem,
  stage: LifecycleStageView,
  dailyPermitReferenceDate: Date,
  dailyOnly = false,
  constructionAiAuditEnabled = false,
): LifecycleStageAttachmentView[] {
  const labels = getLifecycleStageAttachmentLabels(item, stage);
  const attachments =
    dailyOnly && isDailyLifecycleStageKey(stage.key)
      ? getLifecycleStageRelatedFollowups(
          item,
          stage,
          dailyPermitReferenceDate,
          true,
        ).flatMap((followup) => followup.attachments)
      : getAllFollowupAttachments(item);

  return labels.map((label) => {
    if (stage.key === 'isolation' && label === '每日作业票校核') {
      const permitSummary = getConfirmedDailyPermitSummary(
        item,
        dailyPermitReferenceDate,
        constructionAiAuditEnabled,
      );
      return {
        label,
        count: permitSummary.done ? 1 : 0,
        files: [],
        status: permitSummary.issue
          ? ('issue' as const)
          : permitSummary.done
            ? ('complete' as const)
            : ('empty' as const),
        feedbacks: [permitSummary.description || permitSummary.value].filter(
          Boolean,
        ),
      };
    }
    const matchedGroups = attachments.filter((group) =>
      isAttachmentGroupMatchedByLabel(group, label),
    );
    const files = matchedGroups.flatMap((group) => group.files);
    const count = matchedGroups.reduce((sum, group) => sum + group.count, 0);
    const auditPresentation = resolveConstructionAttachmentAuditPresentation({
      enabled: constructionAiAuditEnabled,
      count,
      hasAiIssue: matchedGroups.some((group) => group.status === 'issue'),
      aiFeedbacks: matchedGroups
        .map((group) => group.feedback)
        .filter((feedback): feedback is string => Boolean(feedback)),
    });

    return {
      label,
      count,
      files,
      status: auditPresentation.status,
      feedbacks: auditPresentation.feedbacks,
    };
  });
}

function getAttachmentLabelCandidates(label: string): string[] {
  return Array.from(
    new Set([label, ...(ATTACHMENT_LABEL_ALIASES[label] || [])]),
  );
}

function isAttachmentGroupMatchedByLabel(
  group: Pick<ConstructionAttachmentGroup, 'field' | 'label'>,
  label: string,
): boolean {
  return getAttachmentLabelCandidates(label).some(
    (candidate) =>
      group.label.includes(candidate) ||
      group.field.includes(candidate) ||
      candidate.includes(group.label) ||
      candidate.includes(group.field),
  );
}

function getLifecycleStageAttachmentLabels(
  item: ConstructionOverviewItem,
  stage: LifecycleStageView,
): string[] {
  if (stage.key === 'apply') {
    return getApplicationAttachmentLabels();
  }
  if (stage.key === 'approval') {
    return Array.from(
      new Set([
        ...getApplicationAttachmentLabels(),
        ...getPrepareAttachmentLabels(item),
      ]),
    );
  }
  if (stage.key === 'isolation') {
    return Array.from(
      new Set(['每日人员核查清单', '每日作业票校核', '挂牌与隔离照片']),
    );
  }
  if (stage.key === 'process') {
    return ['施工过程照片'];
  }
  if (stage.key === 'close') {
    return ['每日收尾照片', '施工检查表'];
  }
  return [];
}

function getApplicationAttachmentLabels(): string[] {
  return ['crewRosterFiles']
    .map((key) => String(FOLLOWUP_FILE_FIELDS_BY_KEY[key] || ''))
    .filter(Boolean);
}

function getPrepareAttachmentLabels(item: ConstructionOverviewItem): string[] {
  return getInitialApplicationFileKeys(item.workTypes)
    .map((key) => String(FOLLOWUP_FILE_FIELDS_BY_KEY[key] || ''))
    .filter(Boolean);
}

function getAllFollowupAttachments(
  item: ConstructionOverviewItem,
): ConstructionAttachmentGroup[] {
  return [
    ...(item.applicationAttachments || []),
    ...item.followups.flatMap((followup) => followup.attachments),
  ];
}

function formatAttachmentCoverage(
  attachments: LifecycleStageAttachmentView[],
): string {
  if (!attachments.length) {
    return '无附件要求';
  }
  const completed = attachments.filter(
    (attachment) => attachment.count > 0,
  ).length;
  return `${completed}/${attachments.length} 已上传`;
}

function normalizeDisplayText(value?: string | null): string {
  const text = String(value || '').trim();
  if (!text) {
    return '';
  }

  let current = text;
  for (let index = 0; index < 2; index += 1) {
    const repaired = repairLatin1Mojibake(current);
    if (repaired === current) {
      break;
    }
    current = repaired;
  }
  return current;
}

function repairLatin1Mojibake(text: string): string {
  if (!hasLatin1MojibakeSignal(text)) {
    return text;
  }

  try {
    const bytes = Array.from(text).map(getLegacyDecodedByte);
    if (bytes.some((byte) => byte === null)) {
      return text;
    }
    const repaired = new TextDecoder('utf-8', { fatal: false }).decode(
      Uint8Array.from(bytes as number[]),
    );
    if (
      repaired &&
      countCjkCharacters(repaired) > countCjkCharacters(text) &&
      countLatin1MojibakeSignals(repaired) < countLatin1MojibakeSignals(text)
    ) {
      return repaired;
    }
  } catch {
    return text;
  }

  return text;
}

function getLegacyDecodedByte(char: string): number | null {
  const code = char.charCodeAt(0);
  if (code <= 0xff) {
    return code;
  }

  return WINDOWS_1252_REVERSE_BYTES[code] ?? null;
}

const WINDOWS_1252_REVERSE_BYTES: Record<number, number> = {
  0x20ac: 0x80,
  0x201a: 0x82,
  0x0192: 0x83,
  0x201e: 0x84,
  0x2026: 0x85,
  0x2020: 0x86,
  0x2021: 0x87,
  0x02c6: 0x88,
  0x2030: 0x89,
  0x0160: 0x8a,
  0x2039: 0x8b,
  0x0152: 0x8c,
  0x017d: 0x8e,
  0x2018: 0x91,
  0x2019: 0x92,
  0x201c: 0x93,
  0x201d: 0x94,
  0x2022: 0x95,
  0x2013: 0x96,
  0x2014: 0x97,
  0x02dc: 0x98,
  0x2122: 0x99,
  0x0161: 0x9a,
  0x203a: 0x9b,
  0x0153: 0x9c,
  0x017e: 0x9e,
  0x0178: 0x9f,
};

function hasLatin1MojibakeSignal(text: string): boolean {
  return /[ÃÂÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞßàáâãäåæçèéêëìíîïðñòóôõöøùúûüýþÿ]/.test(
    text,
  );
}

function countLatin1MojibakeSignals(text: string): number {
  return (
    text.match(
      /[ÃÂÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞßàáâãäåæçèéêëìíîïðñòóôõöøùúûüýþÿ]/g,
    ) || []
  ).length;
}

function countCjkCharacters(text: string): number {
  return (text.match(/[\u4e00-\u9fff]/g) || []).length;
}

function getFollowupTime(followup: ConstructionFollowupItem): number {
  return (
    parseOptionalDate(followup.updatedAt || followup.createdAt)?.getTime() || 0
  );
}

function getProjectCalendarInitialMonth(item: ConstructionOverviewItem): Date {
  const range = getProjectPlanDateRange(item);
  const today = startOfDay(new Date());
  if (
    range &&
    range.start.getTime() <= today.getTime() &&
    range.end.getTime() >= today.getTime()
  ) {
    return startOfMonth(today);
  }
  return startOfMonth(range?.start || today);
}

function buildProjectCalendarStats(days: ProjectCalendarDayView[]) {
  return {
    total: days.length,
    closed: days.filter((day) => day.status === 'closed').length,
    incomplete: days.filter((day) => day.status === 'incomplete').length,
    pending: days.filter((day) => day.status === 'pending').length,
  };
}

function buildProjectCycleDays(
  item: ConstructionOverviewItem,
  constructionAiAuditEnabled = false,
): ProjectCalendarDayView[] {
  const range = getProjectPlanDateRange(item);
  if (!range) {
    return [];
  }
  const totalDays = Math.min(differenceInDays(range.end, range.start) + 1, 730);
  return Array.from({ length: totalDays }, (_, index) =>
    buildProjectCalendarDay(
      item,
      addDays(range.start, index),
      true,
      constructionAiAuditEnabled,
    ),
  );
}

function buildProjectCalendarDays(
  item: ConstructionOverviewItem,
  month: Date,
  constructionAiAuditEnabled = false,
): ProjectCalendarDayView[] {
  const monthStart = startOfMonth(month);
  const monthEnd = endOfMonth(month);
  const gridStart = addDays(monthStart, -getMondayWeekdayIndex(monthStart));
  const totalDays =
    Math.ceil((getMondayWeekdayIndex(monthEnd) + monthEnd.getDate()) / 7) * 7;

  return Array.from({ length: totalDays }, (_, index) => {
    const date = addDays(gridStart, index);
    return buildProjectCalendarDay(
      item,
      date,
      date.getMonth() === monthStart.getMonth(),
      constructionAiAuditEnabled,
    );
  });
}

function buildProjectCalendarDay(
  item: ConstructionOverviewItem,
  date: Date,
  inMonth: boolean,
  constructionAiAuditEnabled = false,
): ProjectCalendarDayView {
  const dayStart = startOfDay(date);
  const range = getProjectPlanDateRange(item);
  const today = startOfDay(new Date());
  const inProjectRange = Boolean(
    range &&
    dayStart.getTime() >= range.start.getTime() &&
    dayStart.getTime() <= startOfDay(range.end).getTime(),
  );
  const followups = getProjectDailyFollowupsForDate(item, dayStart);
  const checklist = inProjectRange
    ? buildProjectDayChecklist(
        item,
        dayStart,
        followups,
        constructionAiAuditEnabled,
      )
    : [];
  const problems = inProjectRange
    ? buildProjectDayProblems(checklist, followups, constructionAiAuditEnabled)
    : [];
  const isFuture = dayStart.getTime() > today.getTime();
  const status: ProjectCalendarDayStatus = !inProjectRange
    ? 'outside'
    : isFuture
      ? 'pending'
      : problems.length === 0 &&
          checklist.every((check) => check.done && !check.issue)
        ? 'closed'
        : 'incomplete';

  return {
    key: dayStart.toISOString(),
    date: dayStart,
    dayNumber: dayStart.getDate(),
    inMonth,
    inProjectRange,
    isToday: dayStart.getTime() === today.getTime(),
    status,
    statusLabel: getProjectCalendarStatusLabel(status),
    checklist,
    problems,
    followups,
  };
}

function getProjectPlanDateRange(item: ConstructionOverviewItem): {
  start: Date;
  end: Date;
} | null {
  const start = parseOptionalDate(item.planStartTime);
  const end = parseOptionalDate(item.planEndTime) || start;
  if (!start || !end) {
    return null;
  }
  const startDay = startOfDay(start);
  const endDay = startOfDay(end);
  if (endDay.getTime() < startDay.getTime()) {
    return { start: endDay, end: startDay };
  }
  return { start: startDay, end: endDay };
}

function getProjectDailyFollowupsForDate(
  item: ConstructionOverviewItem,
  date: Date,
): ConstructionFollowupItem[] {
  return item.followups
    .filter((followup) => !isInitialApplicationFollowup(followup))
    .filter((followup) => isDailyFollowupOnDate(followup, date))
    .sort((left, right) => getFollowupTime(right) - getFollowupTime(left));
}

function buildProjectDayChecklist(
  item: ConstructionOverviewItem,
  date: Date,
  followups: ConstructionFollowupItem[],
  constructionAiAuditEnabled = false,
): ProjectCalendarChecklistItem[] {
  const attachments = followups.flatMap((followup) => followup.attachments);
  const hasPersonnelCheck =
    hasAttachment(attachments, '每日人员核查清单') ||
    followups.some((followup) => Boolean(followup.dailyPersonnelCheck));
  const confirmedDailyWorkTypes = getConfirmedTodayDailyWorkTypes(item, date);
  const hasDailyWorkTypeAudit = confirmedDailyWorkTypes.length > 0;
  const permitSummary = getConfirmedDailyPermitSummary(
    item,
    date,
    constructionAiAuditEnabled,
  );
  const hasIsolation =
    hasAttachment(attachments, '挂牌与隔离照片') ||
    (constructionAiAuditEnabled &&
      followups.some((followup) => Boolean(followup.isolationFeedback)));
  const isolationManualReviewStatus = getDailyIsolationManualReviewStatus(
    getLatestIsolationManualReviewDecision(followups),
  );
  const isolationManualReviewIssue =
    hasIsolation && isolationManualReviewStatus !== 'passed';
  const hasProcess =
    hasAttachment(attachments, '施工过程照片') ||
    followups.some((followup) => Boolean(followup.processFeedback));
  const hasClosePhoto =
    hasAttachment(attachments, '施工收尾照片') ||
    hasAttachment(attachments, '每日收尾照片');
  const hasCloseChecklist =
    hasAttachment(attachments, '施工检查表') ||
    hasAttachment(attachments, '每日收尾检查表') ||
    followups.some((followup) => Boolean(followup.completed));
  const closeTraceDone = hasCloseChecklist && hasClosePhoto;
  const closeTraceValue = closeTraceDone
    ? '已提交'
    : hasCloseChecklist
      ? '缺照片'
      : hasClosePhoto
        ? '缺清单'
        : '缺失';
  const closeTraceIssue =
    constructionAiAuditEnabled &&
    followups.some((followup) => isIssueFeedback(followup.closingFeedback));

  return [
    {
      label: '作业类型校核',
      value: hasDailyWorkTypeAudit
        ? confirmedDailyWorkTypes.join('、')
        : '缺失',
      done: hasDailyWorkTypeAudit,
    },
    {
      label: '人员核查',
      value: hasPersonnelCheck ? '已核查' : '缺失',
      done: hasPersonnelCheck,
    },
    {
      label: '作业票校核',
      value: permitSummary.value,
      done: permitSummary.done,
      issue: permitSummary.issue,
    },
    {
      label: '挂牌隔离',
      value: !hasIsolation
        ? '缺失'
        : isolationManualReviewStatus === 'passed'
          ? '人工审核通过'
          : isolationManualReviewStatus === 'rejected'
            ? '人工审核驳回'
            : '待人工审核',
      done: hasIsolation,
      issue:
        isolationManualReviewIssue ||
        (constructionAiAuditEnabled &&
          followups.some((followup) =>
            isIssueFeedback(followup.isolationFeedback),
          )),
    },
    {
      label: '过程照片',
      value: hasProcess ? '已留痕' : '缺失',
      done: hasProcess,
      issue: followups.some((followup) =>
        isIssueFeedback(followup.processFeedback),
      ),
    },
    {
      label: '收尾清单/照片',
      value: closeTraceValue,
      done: closeTraceDone,
      issue: closeTraceIssue,
    },
  ];
}

function buildProjectDayProblems(
  checklist: ProjectCalendarChecklistItem[],
  followups: ConstructionFollowupItem[],
  constructionAiAuditEnabled = false,
): ProjectCalendarProblemItem[] {
  const missingProblems = checklist
    .filter((item) => !item.done || item.issue)
    .map((item) => ({
      label: item.label,
      detail: item.issue ? item.value : `${item.label}未按要求闭环`,
      tone: item.issue ? ('rose' as const) : ('amber' as const),
    }));
  const feedbackProblems = followups.flatMap((followup) => {
    const feedbacks: Array<readonly [string, string | null | undefined]> = [
      ['过程反馈', followup.processFeedback],
      ...buildConstructionAiAuditProblemEntries({
        enabled: constructionAiAuditEnabled,
        isolationFeedback: followup.isolationFeedback,
        closingFeedback: followup.closingFeedback,
        attachmentIssues: followup.attachments
          .filter((attachment) => attachment.status === 'issue')
          .map((attachment) => ({
            label: attachment.label,
            feedback: attachment.feedback || '附件审核异常',
          })),
        aiIssues: followup.aiIssues,
      }),
    ];
    return feedbacks
      .filter((entry) => Boolean(entry[1] && isIssueFeedback(entry[1])))
      .map(([label, detail]) => ({
        label,
        detail: detail || '',
        tone: 'rose' as const,
      }));
  });

  const seen = new Set<string>();
  return [...missingProblems, ...feedbackProblems].filter((problem) => {
    const key = `${problem.label}:${problem.detail}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function getProjectCalendarStatusLabel(
  status: ProjectCalendarDayStatus,
): string {
  if (status === 'closed') return '已闭环';
  if (status === 'incomplete') return '未完成';
  if (status === 'pending') return '待施工';
  return '非周期';
}

function getProjectCalendarDayStyle(status: ProjectCalendarDayStatus) {
  const styles = {
    closed: {
      cell: 'border-emerald-100 bg-emerald-50/80 text-emerald-700',
      text: 'text-emerald-700',
      dot: 'bg-emerald-500',
      badge: 'border-emerald-100 bg-emerald-50 text-emerald-700',
    },
    incomplete: {
      cell: 'border-rose-200 bg-rose-50/80 text-rose-700',
      text: 'text-rose-700',
      dot: 'bg-rose-500',
      badge: 'border-rose-100 bg-rose-50 text-rose-700',
    },
    pending: {
      cell: 'border-blue-100 bg-blue-50/70 text-[#005BFF]',
      text: 'text-[#005BFF]',
      dot: 'bg-[#1e63ff]',
      badge: 'border-blue-100 bg-blue-50 text-blue-700',
    },
    outside: {
      cell: 'border-slate-200 bg-slate-50 text-slate-400',
      text: 'text-slate-400',
      dot: 'bg-slate-300',
      badge: 'border-slate-200 bg-slate-50 text-slate-500',
    },
  } satisfies Record<
    ProjectCalendarDayStatus,
    { cell: string; text: string; dot: string; badge: string }
  >;
  return styles[status];
}

function formatProjectCalendarDayLabel(day: ProjectCalendarDayView): string {
  return `${formatProjectCalendarDate(day.date)}，${day.statusLabel}，${day.problems.length}个问题项`;
}

function formatProjectCalendarDate(value: Date): string {
  return `${value.getFullYear()}年${value.getMonth() + 1}月${value.getDate()}日`;
}

function getLifecycleStages(
  item: ConstructionOverviewItem,
  dailyPermitReferenceDate: Date = new Date(),
  constructionAiAuditEnabled = false,
): LifecycleStageView[] {
  const latest = item.latestFollowup;
  const attachments = getAllFollowupAttachments(item);
  const projectCompleted = isConstructionProjectArchived(item);
  const dailyStageFollowups = projectCompleted
    ? item.followups.filter(
        (followup) => !isInitialApplicationFollowup(followup),
      )
    : getTodayConstructionFollowups(item, dailyPermitReferenceDate).filter(
        (followup) => !isInitialApplicationFollowup(followup),
      );
  const dailyStageAttachments = dailyStageFollowups.flatMap(
    (followup) => followup.attachments,
  );
  const latestDailyStageFollowup =
    [...dailyStageFollowups].sort(
      (left, right) => getFollowupTime(right) - getFollowupTime(left),
    )[0] || null;
  const requiredApplicationLabels = getApplicationAttachmentLabels();
  const missingApplication = requiredApplicationLabels.filter(
    (label) => !hasAttachment(attachments, label),
  );
  const applicationAiIssueCount = countIssues(
    attachments,
    requiredApplicationLabels,
  );
  const approvalProgress = getApprovalFlowProgress(
    item,
    constructionAiAuditEnabled,
  );
  const approvalsPassed = approvalProgress.isComplete;
  const approvalRejected = approvalProgress.hasIssue;
  const requiredPrepareLabels = getPrepareAttachmentLabels(item);
  const missingPrepare = requiredPrepareLabels.filter(
    (label) => !hasAttachment(attachments, label),
  );
  const prepareAiIssueCount = countIssues(attachments, requiredPrepareLabels);
  const approvalWorkflowClosed = isApprovalWorkflowClosed(item);
  const approvalStageMissingPrepare = approvalWorkflowClosed
    ? []
    : missingPrepare;
  const hasIsolation =
    hasAttachment(dailyStageAttachments, '挂牌与隔离照片') ||
    (constructionAiAuditEnabled &&
      Boolean(latestDailyStageFollowup?.isolationFeedback));
  const isolationManualReviewStatus = getDailyIsolationManualReviewStatus(
    getLatestIsolationManualReviewDecision(dailyStageFollowups),
  );
  const isolationManualReviewPassed = isIsolationManualReviewPassed(
    isolationManualReviewStatus,
  );
  const isolationManualReviewIssue =
    hasIsolation && !isolationManualReviewPassed;
  const hasDailyPersonnelChecklist =
    hasAttachment(dailyStageAttachments, '每日人员核查清单') ||
    dailyStageFollowups.some((followup) =>
      Boolean(followup.dailyPersonnelCheck),
    );
  const hasDailyWorkTypeAudit =
    getConfirmedTodayDailyWorkTypes(item, dailyPermitReferenceDate).length > 0;
  const dailyPermitSummary = getConfirmedDailyPermitSummary(
    item,
    dailyPermitReferenceDate,
    constructionAiAuditEnabled,
  );
  const hasProcess =
    hasAttachment(dailyStageAttachments, '施工过程照片') ||
    Boolean(latestDailyStageFollowup?.processFeedback);
  const processManualIssue = isIssueFeedback(
    latestDailyStageFollowup?.processFeedback || '',
  );
  const hasDailyClose =
    hasAttachment(dailyStageAttachments, '施工收尾照片') ||
    hasAttachment(dailyStageAttachments, '每日收尾照片') ||
    hasAttachment(dailyStageAttachments, '施工检查表');
  const hasClose = projectCompleted || hasDailyClose;
  const lifecycleAuditPolicy = resolveConstructionLifecycleAuditPolicy({
    enabled: constructionAiAuditEnabled,
    applicationAiIssueCount,
    prepareAiIssueCount,
    isolationAiIssue: isIssueFeedback(
      latestDailyStageFollowup?.isolationFeedback || '',
    ),
    isolationManualPassed: isolationManualReviewPassed,
    isolationManualIssue: isolationManualReviewIssue,
    processManualIssue,
    closingAiIssue: isIssueFeedback(
      latestDailyStageFollowup?.closingFeedback || '',
    ),
    closingApprovalRejected: isRejectedStatusText(latest?.closingApproval),
  });
  const applicationIssues = lifecycleAuditPolicy.applicationIssueCount;
  const prepareIssues = lifecycleAuditPolicy.prepareIssueCount;
  const isolationBlocked = lifecycleAuditPolicy.isolationBlocked;
  const processBlocked = lifecycleAuditPolicy.processBlocked;
  const closeBlocked = lifecycleAuditPolicy.closeBlocked;
  const approvalStagePrepareIssues = approvalWorkflowClosed ? 0 : prepareIssues;
  const applicationReady =
    missingApplication.length === 0 && applicationIssues === 0;
  const approvalReady =
    approvalsPassed &&
    (approvalWorkflowClosed ||
      (missingPrepare.length === 0 && prepareIssues === 0)) &&
    !approvalRejected;

  return LIFECYCLE_STAGES.map((definition) => {
    if (definition.key === 'approval') {
      const missing = [
        ...missingApplication,
        ...approvalProgress.missing,
        ...approvalStageMissingPrepare,
      ];
      const issueCount =
        applicationIssues +
        (approvalRejected ? 1 : 0) +
        approvalStagePrepareIssues;
      const evidenceParts = [
        `审批 ${approvalProgress.completed}/${approvalProgress.total}`,
        missing.length > 0 ? `缺 ${missing.length} 项` : '材料已提交',
      ];

      return {
        ...definition,
        status:
          issueCount > 0
            ? 'blocked'
            : applicationReady && approvalReady
              ? 'done'
              : 'active',
        evidence:
          applicationReady && approvalReady
            ? '申请材料与审批已闭环'
            : evidenceParts.join(' · '),
        missing,
        issueCount,
      };
    }

    if (definition.key === 'isolation') {
      const missing = [
        !hasDailyWorkTypeAudit ? '当天作业类型校核' : '',
        !hasDailyPersonnelChecklist ? '每日人员核查清单' : '',
        !dailyPermitSummary.done ? '每日作业票校核' : '',
        !hasIsolation ? '挂牌与隔离照片' : '',
        isolationManualReviewIssue ? '挂牌隔离人工审核' : '',
      ].filter(Boolean);
      const issueCount =
        (isolationBlocked ? 1 : 0) + (dailyPermitSummary.issue ? 1 : 0);
      const prepareDone = missing.length === 0 && issueCount === 0;
      return {
        ...definition,
        status:
          issueCount > 0
            ? 'blocked'
            : prepareDone
              ? 'done'
              : approvalReady
                ? 'active'
                : 'pending',
        evidence: prepareDone
          ? '作业类型、人员核查、作业票和挂牌隔离已留痕'
          : '等待作业类型、人员核查、作业票和挂牌隔离留痕',
        missing,
        issueCount,
      };
    }

    if (definition.key === 'process') {
      return {
        ...definition,
        status: processBlocked
          ? 'blocked'
          : hasClose
            ? 'done'
            : hasProcess || hasIsolation
              ? 'active'
              : 'pending',
        evidence: hasClose
          ? '施工过程与收尾已闭环'
          : hasProcess
            ? `第 ${latestDailyStageFollowup?.constructionDay || '-'} 天过程留痕，可继续补充并进入收尾`
            : '等待随工过程照片或现场反馈',
        missing: hasProcess ? [] : ['施工过程照片'],
        issueCount: processBlocked ? 1 : 0,
      };
    }

    const projectTerminated = isConstructionProjectTerminated(item);
    const closeEvidence = projectTerminated
      ? `终止状态：${item.workflow || '已终止'}`
      : projectCompleted
        ? `收尾状态：${latest?.completed || latest?.closingApproval || '已留痕'}`
        : hasDailyClose
          ? `今日收尾：${latestDailyStageFollowup?.completed || '明日继续'}`
          : '等待收尾照片、施工检查表和审批单回收';

    return {
      ...definition,
      status: closeBlocked
        ? 'blocked'
        : projectCompleted
          ? 'done'
          : hasDailyClose || hasProcess
            ? 'active'
            : 'pending',
      evidence: closeEvidence,
      missing: hasClose ? [] : ['施工收尾照片', '施工检查表'],
      issueCount: closeBlocked ? 1 : 0,
    };
  });
}

function hasAttachment(
  groups: ConstructionAttachmentGroup[],
  label: string,
): boolean {
  return groups.some(
    (group) => isAttachmentGroupMatchedByLabel(group, label) && group.count > 0,
  );
}

function hasAnyAttachmentByKeys(
  groups: ConstructionAttachmentGroup[],
  keys: readonly string[],
): boolean {
  return groups.some((group) => {
    if (group.count <= 0) return false;
    return keys.some((key) => {
      const label = String(FOLLOWUP_FILE_FIELDS_BY_KEY[key] || key);
      return isAttachmentGroupMatchedByLabel(group, label);
    });
  });
}

function countIssues(
  groups: ConstructionAttachmentGroup[],
  labels: string[],
): number {
  return groups.filter(
    (group) =>
      labels.some((label) => isAttachmentGroupMatchedByLabel(group, label)) &&
      group.status === 'issue',
  ).length;
}

function getConstructionApplicantName(item: ConstructionOverviewItem): string {
  return item.managers.applicant || item.managers.engineer || '未配置';
}

function formatApprovalSummary(
  item: ConstructionOverviewItem,
  constructionAiAuditEnabled = false,
): string {
  const progress = getApprovalFlowProgress(item, constructionAiAuditEnabled);
  return `${progress.completed}/${progress.total} 节点`;
}

function formatConstructionIssueSummary(
  item: ConstructionOverviewItem,
): string {
  const count = item.constructionIssues?.length || 0;
  return count > 0 ? `${count} 个问题` : '暂无';
}

function getProjectTodayStatusText(
  item: ConstructionOverviewItem,
  currentStage: LifecycleStageView | null,
): { value: string; description: string; tone: 'blue' | 'emerald' | 'rose' } {
  if (item.constructionIssues?.length) {
    return {
      value: '需处理',
      description: '施工总览已登记现场问题',
      tone: 'rose',
    };
  }

  if (currentStage?.key === 'close') {
    if (isConstructionProjectTerminated(item)) {
      return {
        value: '已终止',
        description: item.workflow || currentStage.evidence,
        tone: 'emerald',
      };
    }
    const archived = isConstructionProjectArchived(item);
    return {
      value: archived ? '已归档' : '收尾中',
      description: archived ? '施工闭环归档已完成' : currentStage.evidence,
      tone: archived ? 'emerald' : 'blue',
    };
  }

  if (currentStage?.key === 'process') {
    return {
      value: '施工中',
      description: currentStage.evidence || '施工过程按日留痕',
      tone: 'blue',
    };
  }

  if (currentStage?.key === 'isolation') {
    return {
      value: currentStage.status === 'done' ? '已准备' : '准备中',
      description: currentStage.evidence || '人员核查与挂牌隔离',
      tone: currentStage.status === 'done' ? 'emerald' : 'blue',
    };
  }

  return {
    value: currentStage?.status === 'done' ? '已完成' : '流转中',
    description: currentStage?.evidence || '申请与审批按流程推进',
    tone: currentStage?.status === 'done' ? 'emerald' : 'blue',
  };
}

function formatDepositSummary(item: ConstructionOverviewItem): string {
  if (!item.approval.depositPaid) {
    return '未填写';
  }
  const amount =
    item.deposit.amount !== null ? `${item.deposit.amount}元` : '金额未填';
  const balance =
    item.deposit.balance !== null ? `结余${item.deposit.balance}元` : '';
  return [item.approval.depositPaid, amount, balance]
    .filter(Boolean)
    .join(' / ');
}

function getApprovalFlowSteps(
  item: ConstructionOverviewItem,
  constructionAiAuditEnabled = false,
): ApprovalFlowStep[] {
  const supervisorPassed = isPassedStatusText(item.approval.supervisor);
  const ehsNotifiedStatus = getEhsNotifiedStatus(item);
  const ehsNotifiedPassed = isPassedStatusText(ehsNotifiedStatus);
  const depositStatus = getDepositConfirmationStatus(item);
  const depositTone = getDepositConfirmationTone(item);
  const depositReady = depositTone === 'done' || depositTone === 'skipped';
  const materialSubmission = getApprovalMaterialSubmissionState(
    item,
    ehsNotifiedPassed,
    constructionAiAuditEnabled,
  );
  const parkReady = materialSubmission.passed && depositReady;
  const parkSyncStatus = getParkSyncStatus(item, parkReady);
  const parkSyncTone = getParkSyncTone(item, parkReady);

  return [
    {
      title: '提交基础信息',
      owner: getConstructionApplicantName(item),
      status:
        getConstructionApplicantName(item) === '未配置' ? '待配置' : '已提交',
      tone:
        getConstructionApplicantName(item) === '未配置' ? 'pending' : 'done',
    },
    {
      title: '楼栋主管审批',
      owner: item.managers.supervisor || '楼栋主管（多维表生成）',
      status: item.approval.supervisor || '待审批',
      tone: getApprovalTone(item.approval.supervisor),
    },
    {
      title: '知会EHS工程师',
      owner: item.managers.safety || 'EHS工程师',
      status: ehsNotifiedStatus || (supervisorPassed ? '待知会' : '待主管审批'),
      tone: getApprovalTone(
        ehsNotifiedStatus,
        supervisorPassed ? 'active' : 'pending',
      ),
    },
    {
      title: '审批材料提交',
      owner: item.managers.safety || 'EHS工程师',
      status: materialSubmission.status,
      tone: materialSubmission.tone,
    },
    {
      title: '质保金确认',
      owner: '曹李培',
      status: depositStatus,
      tone: depositTone,
    },
    {
      title: '同步机房经理',
      owner: item.managers.park || '机房经理',
      status: parkSyncStatus,
      tone: parkSyncTone,
    },
  ];
}

function getApprovalFlowProgress(
  item: ConstructionOverviewItem,
  constructionAiAuditEnabled = false,
): ApprovalFlowProgress {
  const steps = getApprovalFlowSteps(item, constructionAiAuditEnabled);
  const requiredSteps = steps.filter((step) => step.tone !== 'skipped');
  const completed = requiredSteps.filter((step) => step.tone === 'done').length;
  const missing = requiredSteps
    .filter((step) => step.tone !== 'done')
    .map((step) => step.title);

  return {
    total: requiredSteps.length,
    completed,
    missing,
    hasIssue: steps.some((step) => step.tone === 'issue'),
    isComplete: requiredSteps.length > 0 && completed === requiredSteps.length,
  };
}

function isApprovalWorkflowClosed(item: ConstructionOverviewItem): boolean {
  const supervisorPassed = isPassedStatusText(item.approval.supervisor);
  const ehsNotifiedPassed = isPassedStatusText(getEhsNotifiedStatus(item));
  const depositTone = getDepositConfirmationTone(item);
  const depositReady = depositTone === 'done' || depositTone === 'skipped';
  const parkSynced = isPassedStatusText(item.approval.parkSync);

  return supervisorPassed && ehsNotifiedPassed && depositReady && parkSynced;
}

function getApprovalMaterialSubmissionState(
  item: ConstructionOverviewItem,
  ehsNotifiedPassed = isPassedStatusText(getEhsNotifiedStatus(item)),
  constructionAiAuditEnabled = false,
): {
  status: string;
  tone: ApprovalFlowStep['tone'];
  passed: boolean;
} {
  const requiredLabels = Array.from(
    new Set([
      ...getApplicationAttachmentLabels(),
      ...getPrepareAttachmentLabels(item),
    ]),
  );
  const attachments = getAllFollowupAttachments(item);
  const uploadedCount = requiredLabels.filter((label) =>
    hasAttachment(attachments, label),
  ).length;
  return resolveConstructionMaterialSubmissionState({
    enabled: constructionAiAuditEnabled,
    workflowClosed: isApprovalWorkflowClosed(item),
    ehsNotified: ehsNotifiedPassed,
    requiredCount: requiredLabels.length,
    uploadedCount,
    aiIssueCount: countIssues(attachments, requiredLabels),
  });
}

function getApprovalTone(
  status?: string | null,
  fallback: ApprovalFlowStep['tone'] = 'pending',
): ApprovalFlowStep['tone'] {
  if (isRejectedStatusText(status)) {
    return 'issue';
  }
  if (isPassedStatusText(status)) {
    return 'done';
  }
  return fallback;
}

function getEhsNotifiedStatus(item: ConstructionOverviewItem): string | null {
  if (item.approval.ehsNotified) {
    return item.approval.ehsNotified;
  }
  const hasDownstreamApprovalValue = Boolean(
    item.approval.depositConfirmation || item.approval.parkSync,
  );
  if (
    isPassedStatusText(item.approval.supervisor) &&
    hasDownstreamApprovalValue
  ) {
    return '已知会';
  }
  if (isPassedStatusText(item.approval.supervisor) && item.managers.safety) {
    return '已知会';
  }
  return null;
}

function getDepositRequirement(
  item: ConstructionOverviewItem,
): 'required' | 'not-required' | 'unknown' {
  const value = String(item.approval.depositPaid || '').trim();
  if (!value) {
    return 'unknown';
  }
  if (/无需|不需要|否/.test(value)) {
    return 'not-required';
  }
  if (/是|需|需要|缴纳/.test(value)) {
    return 'required';
  }
  return 'unknown';
}

function getDepositConfirmationStatus(item: ConstructionOverviewItem): string {
  if (item.approval.depositConfirmation) {
    return item.approval.depositConfirmation;
  }
  const requirement = getDepositRequirement(item);
  if (requirement === 'required') {
    return '已确认';
  }
  if (requirement === 'not-required') {
    return '无需缴纳';
  }
  if (requirement === 'unknown') {
    return '待确认是否缴纳';
  }
  return '待质保金确认';
}

function getDepositConfirmationTone(
  item: ConstructionOverviewItem,
): ApprovalFlowStep['tone'] {
  if (item.approval.depositConfirmation) {
    return getApprovalTone(item.approval.depositConfirmation, 'active');
  }
  const requirement = getDepositRequirement(item);
  if (requirement === 'required' || requirement === 'not-required') {
    return 'done';
  }
  return 'pending';
}

function getParkSyncStatus(
  item: ConstructionOverviewItem,
  parkReady: boolean,
): string {
  if (item.approval.parkSync) {
    return item.approval.parkSync;
  }
  return parkReady ? '待消息同步' : '等待前序节点';
}

function getParkSyncTone(
  item: ConstructionOverviewItem,
  parkReady: boolean,
): ApprovalFlowStep['tone'] {
  if (item.approval.parkSync) {
    return getApprovalTone(item.approval.parkSync, 'active');
  }
  return parkReady ? 'active' : 'pending';
}

function isPassedStatusText(value?: string | null): boolean {
  const text = String(value || '').trim();
  if (!text || isRejectedStatusText(text)) {
    return false;
  }

  return Boolean(
    /通过|合格|完成|已通过|已确认|已知会|已同步|无需|不需要|是/i.test(text),
  );
}

function isRejectedStatusText(value?: string | null): boolean {
  const text = String(value || '').trim();
  return Boolean(text && /驳回|否决|异常|失败|不通过|不合格|^否$/i.test(text));
}

function isIssueFeedback(value?: string | null): boolean {
  const text = String(value || '').trim();
  const negativePattern =
    /不通过|未识别|未看到|缺失|缺少|需人工|异常|失败|驳回|不合格|未填写|无效/;
  if (
    /(?:视觉审核|审核结果|结论)[:：]\s*通过/.test(text) &&
    !negativePattern.test(text)
  ) {
    return false;
  }
  if (/审核结果[:：]\s*通过/.test(text) && /问题清单[:：]\s*无/.test(text)) {
    return false;
  }
  if (
    /已确认|已完成|已留痕|通过|合格|正常|无异常|ok|yes|是/i.test(text) &&
    !negativePattern.test(text)
  ) {
    return false;
  }
  if (
    /状态[:：]\s*不通过|审核结果[:：]\s*不通过|视觉审核[:：]\s*不通过|结论[:：]\s*不通过|驳回|异常|失败|缺少|未填写|无效/.test(
      text,
    )
  ) {
    return true;
  }
  return Boolean(text && !/^(通过|合格|正常|无异常|ok|yes|是)$/i.test(text));
}

function appendApplicationFields(
  formData: FormData,
  form: ApplicationFormState,
) {
  appendOptionalField(formData, 'workContent', form.workContent);
  appendOptionalField(formData, 'building', form.building);
  appendOptionalField(formData, 'specialty', form.specialty);
  if (form.workTypes.length > 0) {
    appendOptionalField(formData, 'workTypes', JSON.stringify(form.workTypes));
  }
  appendOptionalField(formData, 'contractorType', form.contractorType);
  appendOptionalField(formData, 'relatedWorkType', form.relatedWorkType);
  appendOptionalField(formData, 'planStartTime', form.planStartTime);
  appendOptionalField(formData, 'planEndTime', form.planEndTime);
  appendOptionalField(
    formData,
    'authorizationStartDate',
    form.authorizationStartDate,
  );
  appendOptionalField(
    formData,
    'authorizationEndDate',
    form.authorizationEndDate,
  );
  appendOptionalField(formData, 'depositPaid', form.depositPaid);
  if (shouldShowDepositDetailFields(form.depositPaid)) {
    appendOptionalField(formData, 'depositAmount', form.depositAmount);
  }
  appendOptionalField(
    formData,
    'constructionApplicantId',
    form.constructionApplicantId,
  );
  if (form.relatedWorkType === '变更') {
    appendOptionalField(
      formData,
      'changeOrderRecordId',
      form.changeOrderRecordId,
    );
  }
}

function appendOptionalField(
  formData: FormData,
  key: string,
  value?: string | null,
) {
  const text = String(value || '').trim();
  if (text) {
    formData.append(key, text);
  }
}

function appendFileBuckets(formData: FormData, buckets: FileBucket) {
  Object.entries(buckets).forEach(([key, bucket]) => {
    bucket.forEach((file) => formData.append(key, file));
  });
}

function hasFileBucketContent(buckets: FileBucket): boolean {
  return Object.values(buckets).some((bucket) => bucket.length > 0);
}

function pickAllowedFileBuckets(
  files: FileBucket,
  allowedKeys: readonly string[],
): FileBucket {
  const allowed = new Set(allowedKeys);
  return Object.fromEntries(
    Object.entries(files).filter(
      ([key, bucket]) => allowed.has(key) && bucket.length > 0,
    ),
  );
}

function getMissingFileLabels(
  fields: ReadonlyArray<readonly [string, string]>,
  files: FileBucket,
  requiredKeys: readonly string[],
) {
  const labels = new Map(fields.map(([key, label]) => [key, label]));
  return requiredKeys
    .filter((key) => !files[key]?.length)
    .map((key) => labels.get(key) || key);
}

function getMissingDailyFollowupFileLabels(
  stage: DailyFollowupStage,
  files: FileBucket,
  permitVerifications: readonly DailyPermitVerification[],
  existingFileKeys: string[] = [],
  focus: DailyChecklistActionKind | null = null,
) {
  const labels = new Map(
    getDailyFollowupFileFieldsForFocus(stage, permitVerifications, focus).map(
      ([key, label]) => [key, label],
    ),
  );
  const existingKeys = new Set(existingFileKeys);

  return getDailyFollowupRequiredFileKeysForFocus(
    stage,
    permitVerifications,
    focus,
  )
    .filter((key) => !files[key]?.length && !existingKeys.has(key))
    .map((key) => labels.get(key) || key);
}

function getDailyFollowupStageFileFields(
  stage: DailyFollowupStage,
  _permitVerifications: readonly DailyPermitVerification[],
): ReadonlyArray<readonly [string, string]> {
  return DAILY_FOLLOWUP_STAGE_FILE_FIELDS[stage];
}

function getDailyFollowupFileFieldsForFocus(
  stage: DailyFollowupStage,
  permitVerifications: readonly DailyPermitVerification[],
  focus: DailyChecklistActionKind | null,
): ReadonlyArray<readonly [string, string]> {
  if (focus === 'workType' || focus === 'personnel' || focus === 'permit') {
    return [];
  }
  if (focus === 'isolation') {
    return DAILY_FOLLOWUP_STAGE_FILE_FIELDS.prepare;
  }
  if (focus === 'processPhoto') {
    return DAILY_FOLLOWUP_STAGE_FILE_FIELDS.process;
  }
  if (focus === 'closeChecklist' || focus === 'closePhoto') {
    return DAILY_FOLLOWUP_STAGE_FILE_FIELDS.close;
  }
  return getDailyFollowupStageFileFields(stage, permitVerifications);
}

function getDailyFollowupStageRequiredFileKeys(
  stage: DailyFollowupStage,
  _permitVerifications: readonly DailyPermitVerification[],
): readonly string[] {
  return DAILY_FOLLOWUP_STAGE_REQUIRED_FILE_KEYS[stage];
}

function getDailyFollowupRequiredFileKeysForFocus(
  stage: DailyFollowupStage,
  permitVerifications: readonly DailyPermitVerification[],
  focus: DailyChecklistActionKind | null,
): readonly string[] {
  if (focus === 'workType' || focus === 'personnel' || focus === 'permit') {
    return [];
  }
  if (focus === 'isolation') {
    return DAILY_FOLLOWUP_STAGE_REQUIRED_FILE_KEYS.prepare;
  }
  if (focus === 'processPhoto') {
    return DAILY_FOLLOWUP_STAGE_REQUIRED_FILE_KEYS.process;
  }
  if (focus === 'closeChecklist' || focus === 'closePhoto') {
    return DAILY_FOLLOWUP_STAGE_REQUIRED_FILE_KEYS.close;
  }
  return getDailyFollowupStageRequiredFileKeys(stage, permitVerifications);
}

function pickDailyStageFileBuckets(
  stage: DailyFollowupStage,
  files: FileBucket,
  permitVerifications: readonly DailyPermitVerification[] = [],
  workTypes: readonly string[] = [],
): FileBucket {
  const allowedKeys = new Set<string>(
    getDailyFollowupStageFileFields(stage, permitVerifications).map(
      (field) => field[0],
    ),
  );
  if (stage === 'prepare') {
    getDailySpecialWorkTypeMaterialFileKeys(workTypes).forEach((key) =>
      allowedKeys.add(key),
    );
  }

  return Object.fromEntries(
    Object.entries(files).filter(
      ([key, bucket]) => allowedKeys.has(key) && bucket.length > 0,
    ),
  );
}

function pickDailyFocusedFileBuckets(
  stage: DailyFollowupStage,
  files: FileBucket,
  permitVerifications: readonly DailyPermitVerification[] = [],
  workTypes: readonly string[] = [],
  focus: DailyChecklistActionKind | null = null,
): FileBucket {
  if (!focus) {
    return pickDailyStageFileBuckets(
      stage,
      files,
      permitVerifications,
      workTypes,
    );
  }
  const allowedKeys = new Set<string>(
    getDailyFollowupFileFieldsForFocus(stage, permitVerifications, focus).map(
      (field) => field[0],
    ),
  );
  if (focus === 'workType') {
    getDailySpecialWorkTypeMaterialFileKeys(workTypes).forEach((key) =>
      allowedKeys.add(key),
    );
  }
  return Object.fromEntries(
    Object.entries(files).filter(
      ([key, bucket]) => allowedKeys.has(key) && bucket.length > 0,
    ),
  );
}

function getDailySpecialWorkTypeMaterialFileKeys(
  workTypes: readonly string[],
): string[] {
  const selectedWorkTypes = new Set(workTypes);
  return SPECIAL_WORK_TYPE_MATERIAL_GROUPS.filter((group) =>
    selectedWorkTypes.has(group.workType),
  ).flatMap((group) => group.fields.map(([key]) => key));
}

function omitFileBucketKeys(
  files: FileBucket,
  keysToOmit: readonly string[],
): FileBucket {
  const omitted = new Set(keysToOmit);
  return Object.fromEntries(
    Object.entries(files).filter(([key]) => !omitted.has(key)),
  );
}

function getVisibleSpecialWorkTypeExistingFiles(
  existingFiles: Record<string, ConstructionAttachmentFile[]>,
  cancelledWorkTypes: readonly string[],
): Record<string, ConstructionAttachmentFile[]> {
  const omitted = new Set<string>();
  cancelledWorkTypes.forEach((workType) => {
    const group = getSpecialWorkTypeMaterialGroup(workType);
    group?.fields.forEach(([key]) => omitted.add(key));
  });

  if (omitted.size === 0) {
    return existingFiles;
  }

  const result: Record<string, ConstructionAttachmentFile[]> = {};
  Object.entries(existingFiles).forEach(([key, value]) => {
    if (!omitted.has(key)) {
      result[key] = value;
    }
  });
  return result;
}

function buildProjectSpecialWorkTypeMaterialFileMap(
  construction: ConstructionOverviewItem | null,
): Record<string, ConstructionAttachmentFile[]> {
  if (!construction) {
    return {};
  }

  const materialKeys = new Set(SPECIAL_WORK_TYPE_MODAL_FILE_KEYS);
  return mergeExistingFileMaps(
    ...construction.followups.map((followup) =>
      pickExistingFileMapKeys(
        buildExistingDailyFollowupFileMap(followup),
        materialKeys,
      ),
    ),
  );
}

function pickExistingFileMapKeys(
  existingFiles: Record<string, ConstructionAttachmentFile[]>,
  allowedKeys: ReadonlySet<string>,
): Record<string, ConstructionAttachmentFile[]> {
  const result: Record<string, ConstructionAttachmentFile[]> = {};
  Object.entries(existingFiles).forEach(([key, value]) => {
    if (allowedKeys.has(key) && value.length > 0) {
      result[key] = value;
    }
  });
  return result;
}

function mergeExistingFileMaps(
  ...maps: Array<Record<string, ConstructionAttachmentFile[]>>
): Record<string, ConstructionAttachmentFile[]> {
  const result: Record<string, ConstructionAttachmentFile[]> = {};
  const seenByKey: Record<string, Set<string>> = {};

  maps.forEach((map) => {
    Object.entries(map).forEach(([key, files]) => {
      if (!seenByKey[key]) {
        seenByKey[key] = new Set();
      }
      files.forEach((file) => {
        const identity = getExistingFileIdentity(file);
        if (seenByKey[key].has(identity)) {
          return;
        }
        seenByKey[key].add(identity);
        result[key] = [...(result[key] || []), file];
      });
    });
  });

  return result;
}

function replaceGeneratedOnlineFormFile(
  current: Record<string, ConstructionAttachmentFile[]>,
  fieldKey: string,
  file: File,
): Record<string, ConstructionAttachmentFile[]> {
  revokeGeneratedOnlineFormFileUrls({ [fieldKey]: current[fieldKey] || [] });
  const localFile: ConstructionAttachmentFile = {
    fileToken: '',
    name: file.name,
    size: file.size,
    tmpUrl: URL.createObjectURL(file),
    mimeType: file.type || null,
  };
  return {
    ...current,
    [fieldKey]: [localFile],
  };
}

function rollbackGeneratedOnlineFormFile(
  current: Record<string, ConstructionAttachmentFile[]>,
  fieldKey: string,
): Record<string, ConstructionAttachmentFile[]> {
  if (!current[fieldKey]) {
    return current;
  }
  revokeGeneratedOnlineFormFileUrls({ [fieldKey]: current[fieldKey] });
  const next = { ...current };
  delete next[fieldKey];
  return next;
}

function revokeGeneratedOnlineFormFileUrls(
  files: Record<string, ConstructionAttachmentFile[]>,
): void {
  Object.values(files)
    .flat()
    .forEach((file) => {
      if (file.tmpUrl?.startsWith('blob:')) {
        URL.revokeObjectURL(file.tmpUrl);
      }
    });
}

function mergeGeneratedOnlineFormFileMap(
  existingFiles: Record<string, ConstructionAttachmentFile[]>,
  generatedFiles: Record<string, ConstructionAttachmentFile[]>,
): Record<string, ConstructionAttachmentFile[]> {
  if (Object.keys(generatedFiles).length === 0) {
    return existingFiles;
  }

  const result: Record<string, ConstructionAttachmentFile[]> = {
    ...existingFiles,
  };
  Object.entries(generatedFiles).forEach(([fieldKey, localFiles]) => {
    if (localFiles.length === 0) {
      return;
    }
    if (isGeneratedOnlineWorkApplicationField(fieldKey)) {
      result[fieldKey] = localFiles;
      return;
    }
    const existingFieldFiles = existingFiles[fieldKey] || [];
    const retainedExistingFiles = existingFieldFiles.filter(
      (file) =>
        !isGeneratedOnlineWorkFormAttachment(file) ||
        localFiles.some((localFile) =>
          hasSameAttachmentNameAndSize(file, localFile),
        ),
    );
    const visibleLocalFiles = localFiles.filter(
      (localFile) =>
        !retainedExistingFiles.some((file) =>
          hasSameAttachmentNameAndSize(file, localFile),
        ),
    );
    result[fieldKey] = [...retainedExistingFiles, ...visibleLocalFiles];
  });
  return result;
}

function hasSameAttachmentNameAndSize(
  left: ConstructionAttachmentFile,
  right: ConstructionAttachmentFile,
): boolean {
  const leftName = normalizeDisplayText(left.name);
  const rightName = normalizeDisplayText(right.name);
  if (!leftName || leftName !== rightName) {
    return false;
  }
  return left.size == null || right.size == null || left.size === right.size;
}

function getExistingFileIdentity(file: ConstructionAttachmentFile): string {
  return (
    file.fileToken ||
    [normalizeDisplayText(file.name), file.size || 0, file.tmpUrl || ''].join(
      ':',
    )
  );
}

function getConstructionAttachmentPreviewUrl(
  file: ConstructionAttachmentFile,
  fileName: string,
): string {
  if (!file.fileToken && file.tmpUrl) {
    return file.tmpUrl;
  }
  return getConstructionAttachmentDownloadUrl(file.fileToken, fileName, {
    tmpUrl: file.tmpUrl,
  });
}

function getConstructionAttachmentDeleteTarget(
  construction: ConstructionOverviewItem | null,
  fieldKey: string,
  fileToken: string,
): { source: 'followup' | 'overview'; recordId: string } | null {
  if (!construction || !fileToken) {
    return null;
  }
  if (OVERVIEW_ATTACHMENT_FILE_KEYS.has(fieldKey)) {
    return { source: 'overview', recordId: construction.recordId };
  }
  const followup = construction.followups.find((item) => {
    const files = buildExistingDailyFollowupFileMap(item)[fieldKey] || [];
    return files.some((file) => file.fileToken === fileToken);
  });
  return followup ? { source: 'followup', recordId: followup.recordId } : null;
}

function pickDailyPermitFileBuckets(
  files: FileBucket,
  permitVerifications: readonly DailyPermitVerification[] = [],
  selectedFileKey?: string,
): FileBucket {
  const allowedKeys = new Set<string>(
    selectedFileKey
      ? [selectedFileKey]
      : permitVerifications.map((item) => item.fileKey),
  );

  return Object.fromEntries(
    Object.entries(files).filter(
      ([key, bucket]) => allowedKeys.has(key) && bucket.length > 0,
    ),
  );
}

function pickSupplementalFileBuckets(
  files: FileBucket,
  workTypes: readonly string[],
  depositPaid: string,
): FileBucket {
  const allowedKeys = new Set<string>([
    ...getInitialApplicationFileKeys(workTypes),
    CONSTRUCTION_ISSUE_FILE_FIELD[0],
    ...(shouldShowDepositDetailFields(depositPaid)
      ? DEPOSIT_FILE_FIELDS.map((field) => field[0])
      : []),
  ]);

  return Object.fromEntries(
    Object.entries(files).filter(
      ([key, bucket]) => allowedKeys.has(key) && bucket.length > 0,
    ),
  );
}

function getDailyPermitStatusLabel(status: DailyPermitVerification['status']) {
  switch (status) {
    case 'expired':
      return '已过期';
    case 'notStarted':
      return '未生效';
    case 'invalid':
      return '无效';
    case 'pendingReview':
      return '待审核';
    case 'expiresToday':
      return '今日到期';
    case 'expiresTomorrow':
      return '明日到期';
    case 'valid':
      return '有效';
    default:
      return '待核验';
  }
}

function getInitialApplicationFileKeys(workTypes: readonly string[]): string[] {
  const keys = new Set<string>(INITIAL_APPLICATION_BASE_FILE_KEYS);

  const selectedWorkTypes = new Set(workTypes);
  SPECIAL_WORK_TYPE_MATERIAL_GROUPS.forEach((group) => {
    if (selectedWorkTypes.has(group.workType)) {
      group.fields.forEach(([key]) => {
        keys.add(key);
      });
    }
  });

  const hasCommonSpecialWorkType = workTypes.some(
    (workType) =>
      workType !== '一般作业' && !getSpecialWorkTypeMaterialGroup(workType),
  );
  if (hasCommonSpecialWorkType) {
    INITIAL_APPLICATION_SPECIAL_COMMON_FILE_KEYS.forEach((key) =>
      keys.add(key),
    );
  }
  SPECIAL_WORK_TYPE_PERMIT_FILE_FIELDS.forEach(({ workType, fileKey }) => {
    if (
      selectedWorkTypes.has(workType) &&
      !getSpecialWorkTypeMaterialGroup(workType)
    ) {
      keys.add(fileKey);
    }
  });

  return Array.from(keys);
}

function getSpecialWorkTypeMaterialGroup(workType: string) {
  return (
    SPECIAL_WORK_TYPE_MATERIAL_GROUPS.find(
      (group) => group.workType === workType,
    ) || null
  );
}

function getInitialApplicationFileFields(
  workTypes: string[],
): ReadonlyArray<readonly [string, string]> {
  const keys = new Set<string>(getInitialApplicationFileKeys(workTypes));
  return [
    ...FOLLOWUP_FILE_FIELDS.filter(
      ([key]) =>
        keys.has(key) && !SPECIAL_WORK_TYPE_MODAL_FILE_KEYS.includes(key),
    ).map(
      ([key, label]) =>
        [key, getInitialApplicationFileFieldLabel(key, label)] as const,
    ),
    CONSTRUCTION_ISSUE_FILE_FIELD,
  ];
}

function getInitialApplicationFileFieldLabel(key: string, label: string) {
  if (key === 'crewRosterFiles') {
    return '施工人员增删名单';
  }
  return label;
}

function getWorkApplicationFileStatusHint({
  followup,
  files,
  existingFiles,
  referenceDate,
  constructionAiAuditEnabled = false,
}: {
  followup: ConstructionFollowupItem | null;
  files: FileBucket;
  existingFiles: Record<string, ConstructionAttachmentFile[]>;
  referenceDate: Date;
  constructionAiAuditEnabled?: boolean;
}): FileFieldStatusHint | null {
  const selectedFiles = files.applicationFiles || [];
  const uploadedFiles = existingFiles.applicationFiles || [];
  if (selectedFiles.length === 0 && uploadedFiles.length === 0) {
    return null;
  }

  const applicationGroup =
    followup?.attachments.find(
      (group) =>
        getFollowupAttachmentKeyFromGroup(group) === 'applicationFiles',
    ) || null;
  const sourceText = [
    constructionAiAuditEnabled ? applicationGroup?.feedback || '' : '',
    ...(applicationGroup?.files || []).map((file) => file.name || ''),
    ...uploadedFiles.map((file) => file.name || ''),
    ...selectedFiles.map((file) => file.name),
  ]
    .map(normalizeDisplayText)
    .filter(Boolean)
    .join(' ');
  const expiryDate = extractWorkApplicationExpiryDate(
    sourceText,
    referenceDate,
  );
  if (!expiryDate) {
    return { tone: 'warning', text: '作业申请单有效期待核验' };
  }

  const expiryText = formatDateForBitableDate(expiryDate);
  const diffDays = getLocalDayDiff(expiryDate, referenceDate);
  if (diffDays < 0) {
    return {
      tone: 'danger',
      text: `作业申请单已过期，有效期至 ${expiryText}`,
    };
  }
  if (diffDays === 0) {
    return {
      tone: 'warning',
      text: `作业申请单今日到期，有效期至 ${expiryText}`,
    };
  }
  return {
    tone: 'success',
    text: `作业申请单有效期至 ${expiryText}`,
  };
}

function extractWorkApplicationExpiryDate(
  text: string,
  referenceDate: Date,
): Date | null {
  const normalized = normalizeDisplayText(text).replace(/\s+/g, ' ');
  if (!normalized) {
    return null;
  }

  const contextCandidates: Date[] = [];
  const contextRegex =
    /(?:有效期|有效日期|有效期限|有效期至|作业日期|作业时间|作业期限|截止|到期)[^；;。,\n]{0,90}/g;
  for (const match of normalized.matchAll(contextRegex)) {
    contextCandidates.push(
      ...extractFullDateCandidates(match[0]),
      ...extractMonthDayRangeEndCandidates(match[0], referenceDate),
    );
  }
  const contextExpiry = getLatestDateCandidate(contextCandidates);
  if (contextExpiry) {
    return contextExpiry;
  }

  return getLatestDateCandidate([
    ...extractFullDateCandidates(normalized),
    ...extractMonthDayRangeEndCandidates(normalized, referenceDate),
  ]);
}

function extractFullDateCandidates(text: string): Date[] {
  const candidates: Date[] = [];
  const fullDateRegex =
    /(20\d{2}|2\d)\s*[年/.-]\s*(\d{1,2})\s*[月/.-]\s*(\d{1,2})\s*(?:日)?/g;
  for (const match of text.matchAll(fullDateRegex)) {
    const year = Number(match[1].length === 2 ? `20${match[1]}` : match[1]);
    const candidate = createLocalDateCandidate(
      year,
      Number(match[2]),
      Number(match[3]),
    );
    if (candidate) {
      candidates.push(candidate);
    }
  }
  return candidates;
}

function extractMonthDayRangeEndCandidates(
  text: string,
  referenceDate: Date,
): Date[] {
  const candidates: Date[] = [];
  const rangeRegex =
    /(\d{1,2})\s*[./-]\s*(\d{1,2})\s*(?:至|到|[-~—])\s*(\d{1,2})\s*[./-]\s*(\d{1,2})/g;
  for (const match of text.matchAll(rangeRegex)) {
    const startMonth = Number(match[1]);
    const startDay = Number(match[2]);
    const endMonth = Number(match[3]);
    const endDay = Number(match[4]);
    const year = referenceDate.getFullYear();
    const startDate = createLocalDateCandidate(year, startMonth, startDay);
    let endDate = createLocalDateCandidate(year, endMonth, endDay);
    if (startDate && endDate && endDate.getTime() < startDate.getTime()) {
      endDate = createLocalDateCandidate(year + 1, endMonth, endDay);
    }
    if (endDate) {
      candidates.push(endDate);
    }
  }
  return candidates;
}

function createLocalDateCandidate(
  year: number,
  month: number,
  day: number,
): Date | null {
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day) ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31
  ) {
    return null;
  }
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year &&
    date.getMonth() === month - 1 &&
    date.getDate() === day
    ? date
    : null;
}

function getLatestDateCandidate(candidates: Date[]): Date | null {
  return (
    candidates
      .filter((date) => Number.isFinite(date.getTime()))
      .sort((left, right) => right.getTime() - left.getTime())[0] || null
  );
}

function getLocalDayDiff(left: Date, right: Date): number {
  return Math.round(
    (startOfDay(left).getTime() - startOfDay(right).getTime()) /
      (24 * 60 * 60 * 1000),
  );
}

function createInitialCompletionChecklistState(
  items: readonly ConstructionCompletionChecklistTemplateItem[] = CONSTRUCTION_COMPLETION_CHECKLIST_ITEMS,
): CompletionChecklistFormState {
  return Object.fromEntries(
    items.map((item) => [item.key, { result: '', remark: '' }]),
  );
}

function buildCompletionChecklistFormState(
  answers: readonly ConstructionCompletionChecklistAnswer[] | null | undefined,
  items: readonly ConstructionCompletionChecklistTemplateItem[] = CONSTRUCTION_COMPLETION_CHECKLIST_ITEMS,
): CompletionChecklistFormState {
  const next = createInitialCompletionChecklistState(items);
  (answers || []).forEach((answer) => {
    if (!next[answer.key]) {
      return;
    }
    next[answer.key] = {
      result: answer.result || '',
      remark: answer.remark || '',
    };
  });
  return next;
}

function buildCompletionChecklistPayload(
  value: CompletionChecklistFormState,
  items: readonly ConstructionCompletionChecklistTemplateItem[] = CONSTRUCTION_COMPLETION_CHECKLIST_ITEMS,
): ConstructionCompletionChecklistAnswer[] {
  return items.map((item) => ({
    key: item.key,
    result: value[item.key]
      ?.result as ConstructionCompletionChecklistAnswer['result'],
    remark: value[item.key]?.remark.trim() || '',
  }));
}

function getCompletionChecklistValidationMessage(
  value: CompletionChecklistFormState,
  items: readonly ConstructionCompletionChecklistTemplateItem[] = CONSTRUCTION_COMPLETION_CHECKLIST_ITEMS,
): string | null {
  const missing = items.find((item) => !value[item.key]?.result);
  if (missing) {
    return `请完成完工检查清单：${missing.no} ${missing.content}`;
  }
  const missingRemark = items.find((item) => {
    const answer = value[item.key];
    return answer?.result === '×' && !answer.remark.trim();
  });
  if (missingRemark) {
    return `不合格项需填写整改说明：${missingRemark.no} ${missingRemark.content}`;
  }
  return null;
}

function getCompletionChecklistProgress(
  value: CompletionChecklistFormState,
  items: readonly ConstructionCompletionChecklistTemplateItem[] = CONSTRUCTION_COMPLETION_CHECKLIST_ITEMS,
) {
  const total = items.length;
  const done = items.filter((item) => value[item.key]?.result).length;
  return { done, total };
}

function getCompletionChecklistItemsForStatus(
  completed: string,
): readonly ConstructionCompletionChecklistTemplateItem[] {
  return completed === '否'
    ? CONSTRUCTION_DAILY_COMPLETION_CHECKLIST_ITEMS
    : CONSTRUCTION_FULL_COMPLETION_CHECKLIST_ITEMS;
}

function reconcileCompletionChecklistState(
  value: CompletionChecklistFormState,
  items: readonly ConstructionCompletionChecklistTemplateItem[],
): CompletionChecklistFormState {
  return Object.fromEntries(
    items.map((item) => [
      item.key,
      value[item.key] || { result: '', remark: '' },
    ]),
  );
}

function getDailyFollowupStageLabel(stage: DailyFollowupStage): string {
  return (
    DAILY_FOLLOWUP_STAGES.find((item) => item.key === stage)?.label || stage
  );
}

function getDailyChecklistFocusDialogTitle(
  focus: DailyChecklistActionKind | null,
  stage: DailyFollowupStage,
): string {
  if (focus === 'workType') return '作业类型校核';
  if (focus === 'personnel') return '人员核查';
  if (focus === 'permit') return '作业票校核';
  if (focus === 'isolation') return '挂牌隔离';
  if (focus === 'processPhoto') return '过程照片';
  if (focus === 'closeChecklist' || focus === 'closePhoto') {
    return '收尾清单和照片';
  }
  return `每日${getDailyFollowupStageLabel(stage)}`;
}

function getDailyChecklistFocusSubmitLabel(
  focus: DailyChecklistActionKind | null,
  stage: DailyFollowupStage,
): string {
  return getDailyChecklistFocusDialogTitle(focus, stage);
}

function getLifecycleStageKeyForDailyStage(
  stage: DailyFollowupStage,
): LifecycleStageKey {
  if (stage === 'prepare') return 'isolation';
  if (stage === 'process') return 'process';
  return 'close';
}

function isDailyLifecycleStageKey(
  stageKey?: LifecycleStageKey | null,
): boolean {
  return (
    stageKey === 'isolation' || stageKey === 'process' || stageKey === 'close'
  );
}

function getDailyFollowupStageProgress(
  item: ConstructionOverviewItem | null,
  referenceDate: Date = new Date(),
  constructionAiAuditEnabled = false,
): DailyFollowupStageProgress {
  const todayFollowups = getTodayConstructionFollowups(item, referenceDate);
  const hasDailyWorkTypeAudit = Boolean(
    item && getConfirmedTodayDailyWorkTypes(item, referenceDate).length > 0,
  );
  const prepareEvidence = getDailyPrepareEvidence(
    todayFollowups.map((followup) => ({
      dailyPersonnelCheck: followup.dailyPersonnelCheck,
      hasDailyPersonnelChecklist: hasAttachment(
        followup.attachments,
        '每日人员核查清单',
      ),
      isolationFeedback: followup.isolationFeedback,
      hasIsolationAttachment: hasAttachment(
        followup.attachments,
        '挂牌与隔离照片',
      ),
    })),
    constructionAiAuditEnabled,
  );
  const processEvidence = todayFollowups.some(
    (followup) =>
      Boolean(followup.processFeedback) ||
      hasAttachment(followup.attachments, '施工过程照片'),
  );
  const close = todayFollowups.some(
    (followup) =>
      (hasAttachment(followup.attachments, '施工收尾照片') ||
        hasAttachment(followup.attachments, '每日收尾照片')) &&
      (hasAttachment(followup.attachments, '施工检查表') ||
        hasAttachment(followup.attachments, '每日收尾检查表')),
  );

  return {
    prepare:
      hasDailyWorkTypeAudit &&
      prepareEvidence.hasPersonnelCheck &&
      prepareEvidence.hasIsolationTrace,
    process: close,
    processEvidence: processEvidence || close,
    close,
  };
}

function getTodayConstructionFollowups(
  item: ConstructionOverviewItem | null,
  referenceDate: Date = new Date(),
): ConstructionFollowupItem[] {
  return (
    item?.followups.filter((followup) =>
      isDailyFollowupOnDate(followup, referenceDate),
    ) || []
  );
}

function getDailyFollowupByRecordIdOnDate(
  item: ConstructionOverviewItem | null,
  recordId: string,
  referenceDate: Date,
): ConstructionFollowupItem | null {
  if (!recordId) return null;

  const followup =
    item?.followups.find((candidate) => candidate.recordId === recordId) ||
    null;
  if (
    !followup ||
    isInitialApplicationFollowup(followup) ||
    !isDailyFollowupOnDate(followup, referenceDate)
  ) {
    return null;
  }

  return followup;
}

function getDailyFollowupForStage(
  item: ConstructionOverviewItem | null,
  stage: DailyFollowupStage,
  referenceDate: Date = new Date(),
): ConstructionFollowupItem | null {
  return (
    getTodayConstructionFollowups(item, referenceDate).find((followup) =>
      isDailyFollowupForStage(followup, stage),
    ) || null
  );
}

function getDailyFollowupForSubmission(
  item: ConstructionOverviewItem | null,
  stage: DailyFollowupStage,
  referenceDate: Date = new Date(),
): ConstructionFollowupItem | null {
  return (
    getDailyFollowupForStage(item, stage, referenceDate) ||
    getTodayDailyFollowup(item, referenceDate)
  );
}

function getTodayDailyFollowup(
  item: ConstructionOverviewItem | null,
  referenceDate: Date = new Date(),
): ConstructionFollowupItem | null {
  return (
    getTodayConstructionFollowups(item, referenceDate)
      .filter(isDailyFollowupRecord)
      .sort(
        (left, right) => getFollowupTime(right) - getFollowupTime(left),
      )[0] || null
  );
}

function getTodayDailyWorkTypes(
  item: ConstructionOverviewItem,
  referenceDate: Date = new Date(),
): string[] {
  const todayWorkTypes = getConfirmedTodayDailyWorkTypes(item, referenceDate);

  return todayWorkTypes.length > 0
    ? todayWorkTypes
    : getSupportedWorkTypes(item.workTypes);
}

function getConfirmedTodayDailyWorkTypes(
  item: ConstructionOverviewItem,
  referenceDate: Date = new Date(),
): string[] {
  return (
    getTodayConstructionFollowups(item, referenceDate)
      .filter((followup) => followup.dailyWorkTypesConfirmed)
      .sort((left, right) => getFollowupTime(right) - getFollowupTime(left))
      .map((followup) => getSupportedWorkTypes(followup.workTypes))
      .find((workTypes) => workTypes.length > 0) || []
  );
}

function getConfirmedDailyPermitSummary(
  item: ConstructionOverviewItem,
  referenceDate: Date = new Date(),
  constructionAiAuditEnabled = false,
) {
  const confirmedWorkTypes = getConfirmedTodayDailyWorkTypes(
    item,
    referenceDate,
  );
  if (confirmedWorkTypes.length === 0) {
    return {
      label: '作业票校核',
      value: '待类型校核',
      description: '请先完成当天作业类型校核。',
      done: false,
      issue: false,
      tone: 'pending' as const,
    };
  }

  return getDailyPermitSummary(
    getDailyPermitVerifications(
      item,
      referenceDate,
      confirmedWorkTypes,
      constructionAiAuditEnabled,
    ),
  );
}

function isDailyFollowupRecord(followup: ConstructionFollowupItem): boolean {
  return DAILY_FOLLOWUP_STAGES.some((stage) =>
    isDailyFollowupForStage(followup, stage.key),
  );
}

function getInitialApplicationFollowup(
  item: ConstructionOverviewItem | null,
): ConstructionFollowupItem | null {
  return (
    item?.followups.filter(isInitialApplicationFollowup).sort((left, right) => {
      const scoreCompare =
        getInitialApplicationFollowupScore(right) -
        getInitialApplicationFollowupScore(left);
      return scoreCompare || getFollowupTime(right) - getFollowupTime(left);
    })[0] || null
  );
}

function getLatestGeneratedWorkApplicationFollowup(
  item: ConstructionOverviewItem | null,
  referenceDate: Date = new Date(),
): ConstructionFollowupItem | null {
  return (
    (item?.followups || [])
      .filter(hasGeneratedWorkApplicationAttachment)
      .sort((left, right) => {
        const todayCompare =
          Number(isDailyFollowupOnDate(right, referenceDate)) -
          Number(isDailyFollowupOnDate(left, referenceDate));
        return todayCompare || getFollowupTime(right) - getFollowupTime(left);
      })[0] || null
  );
}

function hasGeneratedWorkApplicationAttachment(
  followup: ConstructionFollowupItem,
): boolean {
  const applicationFiles =
    buildExistingDailyFollowupFileMap(followup).applicationFiles || [];
  return applicationFiles.some(isGeneratedOnlineWorkFormAttachment);
}

function getInitialApplicationFollowupScore(
  followup: ConstructionFollowupItem,
): number {
  if (
    hasAnyAttachmentByKeys(
      followup.attachments,
      INITIAL_APPLICATION_BASE_FILE_KEYS,
    )
  ) {
    return 2;
  }
  if (
    hasAnyAttachmentByKeys(followup.attachments, INITIAL_APPLICATION_FILE_KEYS)
  ) {
    return 1;
  }
  return followup.workTypes.length > 0 ? 1 : 0;
}

function isInitialApplicationFollowup(
  followup: ConstructionFollowupItem,
): boolean {
  const hasInitialFiles = hasAnyAttachmentByKeys(
    followup.attachments,
    INITIAL_APPLICATION_FILE_KEYS,
  );
  const hasDailySignals = Boolean(
    followup.dailyWorkTypesConfirmed ||
    followup.dailyPersonnelCheck ||
    followup.processFeedback ||
    followup.completed ||
    hasAnyAttachmentByKeys(followup.attachments, [
      'dailyPersonnelChecklistFiles',
      'isolationPhotoFiles',
      'processPhotoFiles',
      'closingPhotoFiles',
      'inspectionFormFiles',
    ]),
  );

  return isInitialApplicationFollowupByEvidence({
    hasInitialApplicationFiles: hasInitialFiles,
    hasDailySignals,
    workTypes: followup.workTypes,
  });
}

function isDailyFollowupForStage(
  followup: ConstructionFollowupItem,
  stage: DailyFollowupStage,
): boolean {
  if (stage === 'prepare') {
    return (
      Boolean(
        followup.dailyWorkTypesConfirmed || followup.dailyPersonnelCheck,
      ) ||
      hasAttachment(followup.attachments, '每日人员核查清单') ||
      hasAttachment(followup.attachments, '挂牌与隔离照片')
    );
  }
  if (stage === 'process') {
    return (
      Boolean(followup.processFeedback) ||
      hasAttachment(followup.attachments, '施工过程照片')
    );
  }
  return (
    Boolean(followup.completed) ||
    hasAttachment(followup.attachments, '施工收尾照片') ||
    hasAttachment(followup.attachments, '每日收尾照片') ||
    hasAttachment(followup.attachments, '施工检查表') ||
    hasAttachment(followup.attachments, '每日收尾检查表')
  );
}

function applyDailyFollowupStageForm(
  current: FollowupFormState,
  construction: ConstructionOverviewItem | null,
  dailyFollowupStage: DailyFollowupStage,
  followup: ConstructionFollowupItem | null,
  cachedDraft: DailyFollowupFormCacheEntry | null = null,
  constructionAiAuditEnabled = false,
): FollowupFormState {
  const crewMembers = construction?.crewMembers || [];
  const completed =
    dailyFollowupStage === 'close' ? followup?.completed || '' : '';
  const completionChecklistItems =
    getCompletionChecklistItemsForStatus(completed);
  const followupStaffMembers = mapFollowupStaffMembersToCandidates(followup);
  return {
    ...current,
    followupRecordId: followup?.recordId || cachedDraft?.followupRecordId || '',
    dailyFollowupStage,
    followupStaffMembers: followupStaffMembers.length
      ? followupStaffMembers
      : mapCachedFollowupStaffMembersToCandidates(cachedDraft),
    workTypes: followup?.workTypes?.length
      ? followup.workTypes
      : construction?.workTypes?.length
        ? construction.workTypes
        : current.workTypes.length
          ? current.workTypes
          : ['一般作业'],
    dailyCrewRecordIds:
      dailyFollowupStage === 'prepare'
        ? getCheckedCrewRecordIdsFromFollowup(
            crewMembers,
            followup,
            cachedDraft,
          )
        : [],
    dailyPersonnelCheck:
      dailyFollowupStage === 'prepare'
        ? followup?.dailyPersonnelCheck ||
          cachedDraft?.dailyPersonnelCheck ||
          ''
        : '',
    permitValidFromByFileKey: {},
    permitValidUntilByFileKey: {},
    isolationFeedback:
      constructionAiAuditEnabled && dailyFollowupStage === 'prepare'
        ? followup?.isolationFeedback || ''
        : '',
    processFeedback:
      dailyFollowupStage === 'process' ? followup?.processFeedback || '' : '',
    completed,
    depositPaid: '',
    depositAmount: '',
    depositDeducted: '',
    completionChecklist:
      dailyFollowupStage === 'close'
        ? buildCompletionChecklistFormState(
            followup?.completionChecklist,
            completionChecklistItems,
          )
        : createInitialCompletionChecklistState(),
  };
}

function readDailyFollowupFormCache(
  constructionRecordId: string | null | undefined,
  dailyFollowupStage: DailyFollowupStage,
  referenceDate: Date,
): DailyFollowupFormCacheEntry | null {
  const key = getDailyFollowupFormCacheKey(
    constructionRecordId,
    dailyFollowupStage,
    referenceDate,
  );
  if (!key || typeof window === 'undefined') {
    return null;
  }
  try {
    const parsed = JSON.parse(
      window.localStorage.getItem(DAILY_FOLLOWUP_FORM_CACHE_STORAGE_KEY) ||
        '{}',
    ) as Record<string, DailyFollowupFormCacheEntry>;
    return normalizeDailyFollowupFormCacheEntry(parsed[key]);
  } catch {
    return null;
  }
}

function writeDailyFollowupFormCache(
  form: FollowupFormState,
  recordId: string | null | undefined,
  referenceDate: Date,
) {
  if (form.followupMode !== 'daily' || typeof window === 'undefined') {
    return;
  }
  const key = getDailyFollowupFormCacheKey(
    form.constructionRecordId,
    form.dailyFollowupStage,
    referenceDate,
  );
  if (!key) {
    return;
  }
  try {
    const parsed = JSON.parse(
      window.localStorage.getItem(DAILY_FOLLOWUP_FORM_CACHE_STORAGE_KEY) ||
        '{}',
    ) as Record<string, DailyFollowupFormCacheEntry>;
    parsed[key] = {
      followupRecordId: String(recordId || form.followupRecordId || ''),
      followupStaffMembers: form.followupStaffMembers.map((member) => ({
        id: member.id,
        name: member.name,
      })),
      dailyCrewRecordIds: [...form.dailyCrewRecordIds],
      dailyPersonnelCheck: form.dailyPersonnelCheck,
      updatedAt: Date.now(),
    };
    window.localStorage.setItem(
      DAILY_FOLLOWUP_FORM_CACHE_STORAGE_KEY,
      JSON.stringify(pruneDailyFollowupFormCache(parsed)),
    );
  } catch {
    // Cache failures should not block Bitable submission.
  }
}

function getDailyFollowupFormCacheKey(
  constructionRecordId: string | null | undefined,
  dailyFollowupStage: DailyFollowupStage,
  referenceDate: Date,
): string | null {
  const recordId = String(constructionRecordId || '').trim();
  if (!recordId) {
    return null;
  }
  return `${recordId}:${formatDateForBitableDate(referenceDate)}:${dailyFollowupStage}`;
}

function normalizeDailyFollowupFormCacheEntry(
  value: unknown,
): DailyFollowupFormCacheEntry | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const record = value as Partial<DailyFollowupFormCacheEntry>;
  return {
    followupRecordId: String(record.followupRecordId || ''),
    followupStaffMembers: Array.isArray(record.followupStaffMembers)
      ? record.followupStaffMembers
          .map((member) => ({
            id: String(member?.id || '').trim(),
            name: String(member?.name || '').trim(),
          }))
          .filter((member) => member.id && member.name)
      : [],
    dailyCrewRecordIds: Array.isArray(record.dailyCrewRecordIds)
      ? record.dailyCrewRecordIds
          .map((id) => String(id || '').trim())
          .filter(Boolean)
      : [],
    dailyPersonnelCheck: String(record.dailyPersonnelCheck || ''),
    updatedAt: Number(record.updatedAt) || 0,
  };
}

function pruneDailyFollowupFormCache(
  value: Record<string, DailyFollowupFormCacheEntry>,
): Record<string, DailyFollowupFormCacheEntry> {
  const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => (entry.updatedAt || 0) >= cutoff)
      .slice(-100),
  );
}

function applyInitialApplicationFollowupForm(
  current: FollowupFormState,
  construction: ConstructionOverviewItem | null,
  followup: ConstructionFollowupItem | null,
): FollowupFormState {
  return {
    ...current,
    followupRecordId: followup?.recordId || '',
    followupStaffMembers: [],
    workTypes: followup?.workTypes?.length
      ? followup.workTypes
      : construction?.workTypes?.length
        ? construction.workTypes
        : current.workTypes.length
          ? current.workTypes
          : ['一般作业'],
    dailyPersonnelCheck: '',
    dailyCrewRecordIds: [],
    permitValidFromByFileKey: {},
    permitValidUntilByFileKey: {},
    isolationFeedback: '',
    processFeedback: '',
    completed: '',
    depositPaid: construction?.approval.depositPaid || '',
    depositAmount:
      construction?.deposit.amount !== null &&
      construction?.deposit.amount !== undefined
        ? String(construction.deposit.amount)
        : '',
    depositDeducted:
      construction?.deposit.deducted !== null &&
      construction?.deposit.deducted !== undefined
        ? String(construction.deposit.deducted)
        : '',
    completionChecklist: createInitialCompletionChecklistState(),
  };
}

function shouldShowDepositDetailFields(value?: string | null): boolean {
  const depositPaid = String(value || '').trim();
  return depositPaid !== '否';
}

function clearDepositDetailFormFields<
  T extends { depositAmount: string; depositDeducted?: string },
>(current: T, depositPaid: string): T {
  if (shouldShowDepositDetailFields(depositPaid)) {
    return current;
  }

  return {
    ...current,
    depositAmount: '',
    ...('depositDeducted' in current ? { depositDeducted: '' } : {}),
  } as T;
}

function clearDepositDetailFileBuckets(current: FileBucket): FileBucket {
  const depositKeys = new Set<string>(DEPOSIT_FILE_FIELDS.map(([key]) => key));
  return Object.fromEntries(
    Object.entries(current).filter(([key]) => !depositKeys.has(key)),
  );
}

function mapFollowupStaffMembersToCandidates(
  followup: ConstructionFollowupItem | null,
): ConstructionStaffCandidate[] {
  return (followup?.followupStaffMembers || []).map((member) => ({
    id: member.id,
    name: member.name,
    recordId: '',
    employeeNo: null,
    position: null,
    buildingSpecialties: [],
    team: null,
    shift: null,
    onDutyToday: null,
  }));
}

function mapCachedFollowupStaffMembersToCandidates(
  cachedDraft: DailyFollowupFormCacheEntry | null,
): ConstructionStaffCandidate[] {
  return (cachedDraft?.followupStaffMembers || []).map((member) => ({
    id: member.id,
    name: member.name,
    recordId: '',
    employeeNo: null,
    position: null,
    buildingSpecialties: [],
    team: null,
    shift: null,
    onDutyToday: null,
  }));
}

function getCheckedCrewRecordIdsFromFollowup(
  crewMembers: ConstructionCrewMemberItem[],
  followup: ConstructionFollowupItem | null,
  cachedDraft: DailyFollowupFormCacheEntry | null = null,
): string[] {
  const authorizedRecordIds = new Set(
    getConstructionCrewAuthorizationSummary(crewMembers).authorizedMembers.map(
      (member) => member.recordId,
    ),
  );
  const text = followup?.dailyPersonnelCheck || '';
  if (!text) {
    return (cachedDraft?.dailyCrewRecordIds || []).filter((recordId) =>
      authorizedRecordIds.has(recordId),
    );
  }
  const presentText = text.split(/未参与施工|未参加施工|未到场/)[0] || text;
  return crewMembers
    .filter(
      (member) =>
        authorizedRecordIds.has(member.recordId) &&
        presentText.includes(member.name),
    )
    .map((member) => member.recordId);
}

function buildExistingDailyFollowupFileMap(
  followup: ConstructionFollowupItem,
): Record<string, ConstructionAttachmentFile[]> {
  const result: Record<string, ConstructionAttachmentFile[]> = {};
  followup.attachments.forEach((group) => {
    const key = getFollowupAttachmentKeyFromGroup(group);
    if (key && group.files.length > 0) {
      result[key] = group.files;
    }
  });
  return result;
}

function buildOptimisticDailyFollowupAttachments(
  current: readonly ConstructionAttachmentGroup[],
  submittedFiles: FileBucket,
  removedTokens: ExistingFileTokenMap,
  clientMutationId: string,
  manualReviewAutoApproved = false,
  permitValidFromByFileKey: Record<string, string> = {},
  permitValidUntilByFileKey: Record<string, string> = {},
): ConstructionAttachmentGroup[] {
  let next = current
    .map((group) => {
      const fieldKey = getFollowupAttachmentKeyFromGroup(group);
      const removed = new Set(fieldKey ? removedTokens[fieldKey] || [] : []);
      const files = group.files.filter((file) => !removed.has(file.fileToken));
      return {
        ...group,
        files,
        count: files.length,
        status: files.length > 0 ? group.status : ('empty' as const),
      };
    })
    .filter((group) => group.files.length > 0);

  Object.entries(submittedFiles).forEach(([fieldKey, files]) => {
    if (files.length === 0) {
      return;
    }
    const existingIndex = next.findIndex(
      (group) => getFollowupAttachmentKeyFromGroup(group) === fieldKey,
    );
    const existingGroup = existingIndex >= 0 ? next[existingIndex] : null;
    const existingFiles = existingGroup?.files || [];
    const optimisticFiles = files.map(
      (file, index): ConstructionAttachmentFile => ({
        fileToken: `optimistic:${clientMutationId}:${fieldKey}:${index}`,
        name: file.name,
        size: file.size,
        mimeType: file.type || null,
      }),
    );
    const mergedFiles = [...existingFiles, ...optimisticFiles];
    const label = String(FOLLOWUP_FILE_FIELDS_BY_KEY[fieldKey] || fieldKey);
    const nextGroup: ConstructionAttachmentGroup = {
      ...(existingGroup || {}),
      field: existingGroup?.field || label,
      label: existingGroup?.label || label,
      files: mergedFiles,
      count: mergedFiles.length,
      status: 'complete',
      feedback: existingGroup?.feedback || null,
      manualReview:
        manualReviewAutoApproved &&
        DAILY_PERMIT_DEFINITIONS.some(
          (definition) => definition.fileKey === fieldKey,
        )
          ? {
              field: '管理账号自动审核',
              fingerprintField: '',
              reviewed: true,
              value: '通过',
              fingerprint: null,
              expectedFingerprint: null,
              validFrom: permitValidFromByFileKey[fieldKey] || null,
              validUntil: permitValidUntilByFileKey[fieldKey] || null,
            }
          : existingGroup?.manualReview || null,
    };
    next =
      existingIndex >= 0
        ? next.map((group, index) =>
            index === existingIndex ? nextGroup : group,
          )
        : [...next, nextGroup];
  });

  return next;
}

function applyConstructionManualReviewAutoApprovalPresentation(
  items: readonly ConstructionOverviewItem[],
): ConstructionOverviewItem[] {
  return items.map((item) => {
    const followups = item.followups.map(
      applyConstructionFollowupManualReviewAutoApproval,
    );
    return {
      ...item,
      followups,
      latestFollowup: item.latestFollowup
        ? applyConstructionFollowupManualReviewAutoApproval(item.latestFollowup)
        : null,
    };
  });
}

function applyConstructionFollowupManualReviewAutoApproval(
  followup: ConstructionFollowupItem,
): ConstructionFollowupItem {
  let hasIsolationEvidence = Boolean(followup.isolationFeedback);
  const attachments = followup.attachments.map((group) => {
    const fieldKey = getFollowupAttachmentKeyFromGroup(group);
    if (fieldKey === 'isolationPhotoFiles' && group.files.length > 0) {
      hasIsolationEvidence = true;
    }
    if (
      group.files.length === 0 ||
      !DAILY_PERMIT_DEFINITIONS.some(
        (definition) => definition.fileKey === fieldKey,
      )
    ) {
      return group;
    }

    const expectedFingerprint =
      group.manualReview?.expectedFingerprint ||
      group.manualReview?.fingerprint ||
      null;
    return {
      ...group,
      status: 'complete' as const,
      manualReview: {
        field: group.manualReview?.field || '管理账号自动审核',
        fingerprintField: group.manualReview?.fingerprintField || '',
        reviewed: true,
        value: '通过',
        fingerprint: expectedFingerprint,
        expectedFingerprint,
        validFrom: group.manualReview?.validFrom || null,
        validUntil: group.manualReview?.validUntil || null,
      },
    };
  });

  return {
    ...followup,
    attachments,
    isolationCompliant: hasIsolationEvidence
      ? '通过'
      : followup.isolationCompliant,
  };
}

function buildOptimisticAttachmentExpectations(
  attachments: readonly ConstructionAttachmentGroup[],
  submittedFieldKeys: readonly string[],
): OptimisticAttachmentExpectation[] {
  const expectedFieldKeys = new Set(submittedFieldKeys);
  const filesByField = new Map<string, ConstructionAttachmentFile[]>();
  attachments.forEach((group) => {
    const fieldKey = getFollowupAttachmentKeyFromGroup(group);
    if (!fieldKey || !expectedFieldKeys.has(fieldKey)) {
      return;
    }
    filesByField.set(fieldKey, group.files);
  });
  return submittedFieldKeys
    .map((fieldKey) => {
      const files = filesByField.get(fieldKey) || [];
      return {
        fieldKey,
        minimumCount: files.length,
        fingerprints: files.map(getConstructionAttachmentFingerprint),
      };
    })
    .filter((expectation) => expectation.minimumCount > 0);
}

function matchesOptimisticAttachmentExpectations(
  followup: ConstructionFollowupItem,
  expectations: readonly OptimisticAttachmentExpectation[],
): boolean {
  const actualFilesByField = buildExistingDailyFollowupFileMap(followup);
  return expectations.every((expectation) => {
    const actualFiles = actualFilesByField[expectation.fieldKey] || [];
    if (actualFiles.length < expectation.minimumCount) {
      return false;
    }
    const actualFingerprintCounts = new Map<string, number>();
    actualFiles.forEach((file) => {
      const fingerprint = getConstructionAttachmentFingerprint(file);
      actualFingerprintCounts.set(
        fingerprint,
        (actualFingerprintCounts.get(fingerprint) || 0) + 1,
      );
    });
    return expectation.fingerprints.every((fingerprint) => {
      const remaining = actualFingerprintCounts.get(fingerprint) || 0;
      if (remaining <= 0) {
        return false;
      }
      actualFingerprintCounts.set(fingerprint, remaining - 1);
      return true;
    });
  });
}

function getConstructionAttachmentFingerprint(
  file: ConstructionAttachmentFile,
): string {
  return `${file.name.trim()}\u0000${file.size ?? 'unknown'}`;
}

function deduplicateConstructionFollowups(
  followups: readonly ConstructionFollowupItem[],
): ConstructionFollowupItem[] {
  const seen = new Set<string>();
  return followups.filter((followup) => {
    if (seen.has(followup.recordId)) {
      return false;
    }
    seen.add(followup.recordId);
    return true;
  });
}

function getFollowupAttachmentKeyFromGroup(
  group: Pick<ConstructionAttachmentGroup, 'field' | 'label'>,
): string | null {
  const groupLabel = String(group.label || '');
  const groupField = String(group.field || '');
  for (const [key, label] of Object.entries(FOLLOWUP_FILE_FIELDS_BY_KEY)) {
    const candidates = getAttachmentLabelCandidates(String(label));
    if (
      candidates.some(
        (candidate) =>
          groupLabel === candidate ||
          groupField === candidate ||
          groupLabel.includes(candidate) ||
          groupField.includes(candidate) ||
          candidate.includes(groupLabel) ||
          candidate.includes(groupField),
      )
    ) {
      return key;
    }
  }
  return null;
}

function getExistingDailyFollowupFileKeys(
  followup: ConstructionFollowupItem,
): string[] {
  return Object.keys(buildExistingDailyFollowupFileMap(followup));
}

function getNextDailyFollowupStage(
  progress: DailyFollowupStageProgress,
): DailyFollowupStage {
  if (!progress.prepare) return 'prepare';
  if (!progress.close) return 'process';
  return 'close';
}

function isDailyFollowupStageEnabled(
  stage: DailyFollowupStage,
  progress: DailyFollowupStageProgress,
): boolean {
  if (progress[stage]) return true;
  if (stage === 'prepare') return true;
  if (stage === 'process') return progress.prepare;
  return progress.prepare && progress.processEvidence;
}

function isSameLocalDay(
  value: string | null | undefined,
  reference: Date,
): boolean {
  const date = parseOptionalDate(value);
  if (!date) return false;

  return startOfDay(date).getTime() === startOfDay(reference).getTime();
}

function formatDateForBitableDate(value: Date): string {
  const date = Number.isFinite(value.getTime()) ? value : new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function createConstructionClientMutationId(): string {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === 'function') {
    return cryptoApi.randomUUID();
  }
  if (typeof cryptoApi?.getRandomValues === 'function') {
    const bytes = new Uint32Array(4);
    cryptoApi.getRandomValues(bytes);
    return Array.from(bytes, (value) =>
      value.toString(16).padStart(8, '0'),
    ).join('-');
  }
  constructionMutationSequence += 1;
  return [
    'construction',
    Date.now().toString(36),
    constructionMutationSequence.toString(36),
  ].join('-');
}

function getDateInputValue(value?: string | null): string {
  const date = parseOptionalDate(value);
  return date ? formatDateForBitableDate(date) : '';
}

function getCurrentWeekDateInputRange(reference = new Date()): {
  startDate: string;
  endDate: string;
} {
  const today = startOfDay(reference);
  const monday = addDays(today, -getMondayWeekdayIndex(today));
  return {
    startDate: formatDateForBitableDate(monday),
    endDate: formatDateForBitableDate(addDays(monday, 6)),
  };
}

function getCrewRosterUploadTaskResult(
  value: unknown,
): ConstructionCrewRosterUploadSyncResponse | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const result = value as Partial<ConstructionCrewRosterUploadSyncResponse>;
  return result.success
    ? (result as ConstructionCrewRosterUploadSyncResponse)
    : null;
}

function formatCrewRosterUploadResultMessage(
  result: ConstructionCrewRosterUploadSyncResponse,
  fallbackAuthorizationRange: { startDate: string; endDate: string },
): string {
  if (result.message && !result.pending) {
    return result.message;
  }
  const updated = result.synced?.updated || 0;
  const created = result.synced?.created || 0;
  const startDate =
    result.authorizationStartDate || fallbackAuthorizationRange.startDate;
  const endDate =
    result.authorizationEndDate || fallbackAuthorizationRange.endDate;
  const certificateSummary = result.certificateCheck?.summary;
  return [
    `更新${updated}人、新增${created}人，授权有效期${startDate}至${endDate}`,
    certificateSummary,
  ]
    .filter(Boolean)
    .join('；');
}

function hasInitialApplicationContent(
  form: FollowupFormState,
  files: FileBucket,
  existingFiles: Record<string, ConstructionAttachmentFile[]> = {},
) {
  const hasWorkTypes =
    getCompleteSubmittableWorkTypes(form.workTypes, files, existingFiles)
      .length > 0;
  const hasAnyFileContent = Object.values(files).some(
    (bucket) => bucket.length > 0,
  );
  const hasInitialApplicationFileContent = INITIAL_APPLICATION_FILE_KEYS.some(
    (key) => files[key]?.length,
  );
  const hasFileContent = form.followupRecordId
    ? hasAnyFileContent
    : hasInitialApplicationFileContent;
  const hasDepositContent = Boolean(
    form.depositPaid || form.depositAmount || form.depositDeducted,
  );

  return hasWorkTypes || hasFileContent || hasDepositContent;
}

function hasFocusedDailyFollowupFormContent(
  focus: DailyChecklistActionKind,
  form: FollowupFormState,
): boolean {
  if (focus === 'workType') {
    return getSupportedWorkTypes(form.workTypes).length > 0;
  }
  if (focus === 'personnel') {
    return Boolean(
      form.dailyPersonnelCheck.trim() ||
      form.dailyCrewRecordIds.length > 0 ||
      form.followupStaffMembers.length > 0,
    );
  }
  if (focus === 'isolation') {
    return false;
  }
  if (focus === 'processPhoto') {
    return Boolean(form.processFeedback.trim());
  }
  if (focus === 'closeChecklist' || focus === 'closePhoto') {
    return Boolean(
      form.completed ||
      Object.values(form.completionChecklist).some(
        (item) => item.result || item.remark.trim(),
      ),
    );
  }
  return false;
}

function hasFocusedDailyFollowupExistingContent(
  focus: DailyChecklistActionKind,
  followup: ConstructionFollowupItem | null,
  existingFiles: Record<string, ConstructionAttachmentFile[]> = {},
  constructionAiAuditEnabled = false,
): boolean {
  if (!followup && Object.keys(existingFiles).length === 0) {
    return false;
  }
  if (focus === 'isolation') {
    return Boolean(
      existingFiles.isolationPhotoFiles?.length ||
      (constructionAiAuditEnabled && followup?.isolationFeedback) ||
      followup?.isolationCompliant,
    );
  }
  if (focus === 'processPhoto') {
    return Boolean(
      existingFiles.processPhotoFiles?.length || followup?.processFeedback,
    );
  }
  if (focus === 'closeChecklist' || focus === 'closePhoto') {
    return Boolean(
      existingFiles.closingPhotoFiles?.length ||
      existingFiles.inspectionFormFiles?.length ||
      followup?.completed ||
      followup?.completionChecklist?.length,
    );
  }
  if (focus === 'permit') {
    return Object.values(existingFiles).some((files) => files.length > 0);
  }
  if (focus === 'workType') {
    return Boolean(
      followup?.dailyWorkTypesConfirmed && followup.workTypes.length > 0,
    );
  }
  return false;
}

function getSupportedWorkTypes(workTypes: readonly string[]): string[] {
  return Array.from(
    new Set(workTypes.filter((type) => WORK_TYPES.includes(type))),
  );
}

function getSubmittableWorkTypes(workTypes: readonly string[]): string[] {
  return Array.from(
    new Set(workTypes.filter((type) => !isLikelyBitableOptionId(type))),
  );
}

function getCompleteSubmittableWorkTypes(
  workTypes: readonly string[],
  files: FileBucket,
  existingFiles: Record<string, ConstructionAttachmentFile[]> = {},
): string[] {
  return getSubmittableWorkTypes(workTypes).filter((type) => {
    const group = getSpecialWorkTypeMaterialGroup(type);
    return (
      !group || isSpecialWorkTypeMaterialComplete(group, files, existingFiles)
    );
  });
}

function getSpecialWorkTypeMaterialCount(
  group: SpecialWorkTypeMaterialGroup,
  files: FileBucket,
  existingFiles: Record<string, ConstructionAttachmentFile[]> = {},
): number {
  return group.fields.filter(
    ([key]) =>
      (files[key]?.length || 0) + (existingFiles[key]?.length || 0) > 0,
  ).length;
}

function isSpecialWorkTypeMaterialComplete(
  group: SpecialWorkTypeMaterialGroup,
  files: FileBucket,
  existingFiles: Record<string, ConstructionAttachmentFile[]> = {},
): boolean {
  return getSpecialWorkTypeMaterialCount(group, files, existingFiles) >= 4;
}

function getExistingSupplementalFileMap(
  construction: ConstructionOverviewItem | null,
  form: FollowupFormState,
): Record<string, ConstructionAttachmentFile[]> {
  const followup =
    (form.followupRecordId
      ? construction?.followups.find(
          (item) =>
            item.recordId === form.followupRecordId &&
            isInitialApplicationFollowup(item),
        )
      : null) || getInitialApplicationFollowup(construction);
  return followup ? buildExistingDailyFollowupFileMap(followup) : {};
}

function getExistingFollowupSubmissionFileMap(
  construction: ConstructionOverviewItem | null,
  form: FollowupFormState,
): Record<string, ConstructionAttachmentFile[]> {
  let result = getExistingSupplementalFileMap(construction, form);
  if (construction?.constructionIssues?.length) {
    result = {
      ...result,
      constructionIssueFiles: construction.constructionIssues,
    };
  }
  if (construction && shouldShowDepositDetailFields(form.depositPaid)) {
    result = {
      ...result,
      depositAgreementFiles: construction.depositAgreementFiles || [],
      depositTransferFiles: construction.depositTransferFiles || [],
    };
  }
  return result;
}

function getExistingDailyFollowupFileMapForSubmission(
  construction: ConstructionOverviewItem | null,
  form: FollowupFormState,
  referenceDate: Date,
): Record<string, ConstructionAttachmentFile[]> {
  const followup = form.followupRecordId
    ? getDailyFollowupByRecordIdOnDate(
        construction,
        form.followupRecordId,
        referenceDate,
      ) ||
      getDailyFollowupForSubmission(
        construction,
        form.dailyFollowupStage,
        referenceDate,
      )
    : getDailyFollowupForSubmission(
        construction,
        form.dailyFollowupStage,
        referenceDate,
      );
  return followup ? buildExistingDailyFollowupFileMap(followup) : {};
}

function filterExistingFileMapByRemovedTokens(
  existingFiles: Record<string, ConstructionAttachmentFile[]>,
  removedTokens: ExistingFileTokenMap,
): Record<string, ConstructionAttachmentFile[]> {
  const result: Record<string, ConstructionAttachmentFile[]> = {};
  Object.entries(existingFiles).forEach(([fieldKey, files]) => {
    const removed = new Set(removedTokens[fieldKey] || []);
    const keptFiles = files.filter((file) => !removed.has(file.fileToken));
    if (keptFiles.length > 0) {
      result[fieldKey] = keptFiles;
    }
  });
  return result;
}

function buildRetainedAttachmentTokenPayload(
  existingFiles: Record<string, ConstructionAttachmentFile[]>,
  removedTokens: ExistingFileTokenMap,
): ExistingFileTokenMap {
  const result: ExistingFileTokenMap = {};
  const keys = new Set([
    ...Object.keys(existingFiles),
    ...Object.keys(removedTokens),
  ]);
  keys.forEach((fieldKey) => {
    const removed = new Set(removedTokens[fieldKey] || []);
    const tokens = (existingFiles[fieldKey] || [])
      .map((file) => file.fileToken)
      .filter((fileToken) => fileToken && !removed.has(fileToken));
    result[fieldKey] = Array.from(new Set(tokens));
  });
  return result;
}

function mergeExistingFileTokenMaps(
  ...maps: ExistingFileTokenMap[]
): ExistingFileTokenMap {
  const result: ExistingFileTokenMap = {};
  maps.forEach((map) => {
    Object.entries(map).forEach(([fieldKey, tokens]) => {
      const nextTokens = new Set(result[fieldKey] || []);
      tokens.forEach((token) => {
        if (token) {
          nextTokens.add(token);
        }
      });
      result[fieldKey] = Array.from(nextTokens);
    });
  });
  return result;
}

function buildRemovedAttachmentTokenPayloadForUploadedFields(
  existingFiles: Record<string, ConstructionAttachmentFile[]>,
  uploadedFiles: FileBucket,
): ExistingFileTokenMap {
  const result: ExistingFileTokenMap = {};
  Object.entries(uploadedFiles).forEach(([fieldKey, files]) => {
    if (files.length === 0) {
      return;
    }
    const tokens = (existingFiles[fieldKey] || [])
      .map((file) => file.fileToken)
      .filter(Boolean);
    result[fieldKey] = tokens;
  });
  return result;
}

function buildGeneratedOnlineFormRetainedAttachmentTokenPayload(
  existingFiles: Record<string, ConstructionAttachmentFile[]>,
  fieldKey: string,
): ExistingFileTokenMap {
  const removedGeneratedTokens = getGeneratedOnlineFormAttachmentRemovalFiles(
    existingFiles,
    fieldKey,
  )
    .map((file) => file.fileToken)
    .filter(Boolean);
  return buildRetainedAttachmentTokenPayload(
    existingFiles,
    removedGeneratedTokens.length > 0
      ? { [fieldKey]: removedGeneratedTokens }
      : {},
  );
}

function getGeneratedOnlineFormAttachmentRemovalFiles(
  existingFiles: Record<string, ConstructionAttachmentFile[]>,
  fieldKey: string,
): ConstructionAttachmentFile[] {
  const fieldFiles = existingFiles[fieldKey] || [];
  return isGeneratedOnlineWorkApplicationField(fieldKey)
    ? fieldFiles
    : fieldFiles.filter(isGeneratedOnlineWorkFormAttachment);
}

function isGeneratedOnlineWorkApplicationField(fieldKey: string): boolean {
  return fieldKey === 'applicationFiles';
}

function isGeneratedOnlineWorkFormAttachment(
  file: ConstructionAttachmentFile,
): boolean {
  const fileName = normalizeDisplayText(file.name);
  return (
    fileName.includes('在线填表') ||
    /^20\d{6}-.+-(?:施工作业申请单|入场培训签到表|风险交底单|培训签到表|培训考核|作业票)\.doc$/i.test(
      fileName,
    )
  );
}

function isLikelyBitableOptionId(value: string): boolean {
  return /^opt[A-Za-z0-9_-]+$/.test(value.trim());
}

function getCurrentStage(stages: LifecycleStageView[]): LifecycleStageView {
  const dailyStages = stages.filter((stage) => stage.key !== 'approval');
  const approvalStage = stages.find((stage) => stage.key === 'approval');
  return (
    dailyStages.find((stage) => stage.status === 'blocked') ||
    dailyStages.find((stage) => stage.status === 'active') ||
    (approvalStage &&
    (approvalStage.status === 'blocked' || approvalStage.status === 'active')
      ? approvalStage
      : null) ||
    dailyStages.find((stage) => stage.status === 'pending') ||
    approvalStage ||
    stages[stages.length - 1]
  );
}

function getScheduleMeta(item: ConstructionOverviewItem): ScheduleMeta {
  const start = parseOptionalDate(item.planStartTime);
  const end = parseOptionalDate(item.planEndTime) || start;
  const today = startOfDay(new Date());

  if (!start || !end) {
    return {
      state: 'unknown',
      label: '时间待确认',
      progress: 0,
      totalDays: 0,
      elapsedDays: 0,
      remainingDays: null,
    };
  }

  const startDay = startOfDay(start);
  const endDay = startOfDay(end);
  const totalDays = Math.max(1, differenceInDays(endDay, startDay) + 1);

  if (today.getTime() < startDay.getTime()) {
    return {
      state: 'upcoming',
      label: `${differenceInDays(startDay, today)}天后开始`,
      progress: 0,
      totalDays,
      elapsedDays: 0,
      remainingDays: totalDays,
    };
  }

  if (today.getTime() > endDay.getTime()) {
    return {
      state: 'completed',
      label: '计划已结束',
      progress: 100,
      totalDays,
      elapsedDays: totalDays,
      remainingDays: 0,
    };
  }

  const elapsedDays = Math.min(
    totalDays,
    differenceInDays(today, startDay) + 1,
  );
  const remainingDays = differenceInDays(endDay, today) + 1;

  return {
    state: 'active',
    label: `剩余${remainingDays}天`,
    progress: Math.round((elapsedDays / totalDays) * 100),
    totalDays,
    elapsedDays,
    remainingDays,
  };
}

function getInitialCalendarMonth(items: ConstructionOverviewItem[]): Date {
  const today = startOfDay(new Date());
  const activeItem = items.find((item) => isItemInRange(item, today, today));
  const anchor =
    activeItem?.planStartTime || items[0]?.planStartTime || today.toISOString();
  const date = new Date(anchor);
  return startOfMonth(Number.isFinite(date.getTime()) ? date : today);
}

function buildCalendarDays(
  month: Date,
  items: ConstructionOverviewItem[],
): CalendarDayView[] {
  const monthStart = startOfMonth(month);
  const monthEnd = endOfMonth(month);
  const gridStart = addDays(monthStart, -getMondayWeekdayIndex(monthStart));
  const totalDays =
    Math.ceil((getMondayWeekdayIndex(monthEnd) + monthEnd.getDate()) / 7) * 7;
  const today = startOfDay(new Date());

  return Array.from({ length: totalDays }, (_, index) => {
    const date = addDays(gridStart, index);
    const dayStart = startOfDay(date);
    const dayEnd = endOfDay(date);
    return {
      key: date.toISOString(),
      date,
      dayNumber: date.getDate(),
      inMonth: date.getMonth() === monthStart.getMonth(),
      isToday: dayStart.getTime() === today.getTime(),
      items: items
        .filter((item) => isItemInRange(item, dayStart, dayEnd))
        .sort((a, b) => getItemStartTime(a) - getItemStartTime(b)),
    };
  });
}

function isItemInRange(
  item: ConstructionOverviewItem,
  rangeStart: Date,
  rangeEnd: Date,
): boolean {
  const start = parseOptionalDate(item.planStartTime);
  const end = parseOptionalDate(item.planEndTime) || start;
  if (!start || !end) {
    return false;
  }
  return (
    startOfDay(start).getTime() <= rangeEnd.getTime() &&
    endOfDay(end).getTime() >= rangeStart.getTime()
  );
}

function getItemStartTime(item: ConstructionOverviewItem): number {
  return (
    parseOptionalDate(item.planStartTime)?.getTime() || Number.MAX_SAFE_INTEGER
  );
}

function parseOptionalDate(value?: string | null): Date | null {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function startOfMonth(value: Date): Date {
  return new Date(value.getFullYear(), value.getMonth(), 1);
}

function endOfMonth(value: Date): Date {
  return endOfDay(new Date(value.getFullYear(), value.getMonth() + 1, 0));
}

function startOfDay(value: Date): Date {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate());
}

function endOfDay(value: Date): Date {
  return new Date(
    value.getFullYear(),
    value.getMonth(),
    value.getDate(),
    23,
    59,
    59,
    999,
  );
}

function addDays(value: Date, days: number): Date {
  const next = new Date(value);
  next.setDate(value.getDate() + days);
  return next;
}

function addMonths(value: Date, months: number): Date {
  return new Date(value.getFullYear(), value.getMonth() + months, 1);
}

function getMondayWeekdayIndex(value: Date): number {
  return (value.getDay() + 6) % 7;
}

function differenceInDays(later: Date, earlier: Date): number {
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.max(
    0,
    Math.round(
      (startOfDay(later).getTime() - startOfDay(earlier).getTime()) / msPerDay,
    ),
  );
}

function formatMonthLabel(value: Date): string {
  return value.toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: 'long',
  });
}

function formatCompactDateRange(
  start?: string | null,
  end?: string | null,
): string {
  const startDate = parseOptionalDate(start);
  const endDate = parseOptionalDate(end);
  if (startDate && endDate)
    return `${formatCompactDate(startDate)} - ${formatCompactDate(endDate)}`;
  if (startDate) return formatCompactDate(startDate);
  if (endDate) return formatCompactDate(endDate);
  return '计划时间待确认';
}

function formatCompactDate(value: Date): string {
  return `${value.getMonth() + 1}/${value.getDate()}`;
}

function formatDateRange(start?: string | null, end?: string | null): string {
  const startLabel = formatDateTime(start);
  const endLabel = formatDateTime(end);
  if (startLabel && endLabel) return `${startLabel} - ${endLabel}`;
  return startLabel || endLabel || '计划时间待确认';
}

function formatDateTime(value?: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function toOnlineDatetimeLocalValue(value?: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    return value.slice(0, 16);
  }
  const localDate = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return localDate.toISOString().slice(0, 16);
}

function getWorkApplicationSpecialWorkValue(
  workTypes: readonly string[],
): string {
  const labelMap: Record<string, string> = {
    受限空间作业: '有限空间作业',
  };
  return workTypes
    .map((workType) => labelMap[workType] || workType)
    .filter((workType) => workType && workType !== '一般作业')
    .join('、');
}

function getErrorMessage(error: unknown, fallback: string): string {
  const responseData = (error as { response?: { data?: unknown } })?.response
    ?.data;
  return (
    normalizeErrorMessage(responseData) ||
    (error instanceof Error ? error.message : fallback)
  );
}

function normalizeErrorMessage(value: unknown): string {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return '';
    if (/^[{[]/.test(trimmed)) {
      try {
        return normalizeErrorMessage(JSON.parse(trimmed)) || trimmed;
      } catch {
        return trimmed;
      }
    }
    return trimmed;
  }
  if (Array.isArray(value)) {
    return value.map(normalizeErrorMessage).filter(Boolean).join('；');
  }
  if (!value || typeof value !== 'object') {
    return '';
  }

  const record = value as Record<string, unknown>;
  return (
    normalizeErrorMessage(record.message) ||
    normalizeErrorMessage(record.error) ||
    normalizeErrorMessage(record.details)
  );
}
