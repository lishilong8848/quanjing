import type {
  ConstructionFollowupItem,
  ConstructionManagementResponse,
  ConstructionOverviewItem,
} from '../../../../shared/api.interface';

export type OptimisticFollowupFields = Partial<
  Pick<
    ConstructionFollowupItem,
    | 'workTypes'
    | 'dailyWorkTypesConfirmed'
    | 'followupStaff'
    | 'followupStaffMembers'
    | 'dailyPersonnelCheck'
    | 'isolationCompliant'
    | 'isolationFeedback'
    | 'processFeedback'
    | 'completed'
    | 'completionChecklist'
    | 'attachments'
    | 'depositPaid'
  >
>;

export interface OptimisticFollowupPatch {
  projectRecordId: string;
  followupRecordId?: string | null;
  followupDate: string;
  optimisticRecordId?: string;
  allowDateFallback?: boolean;
  fields: OptimisticFollowupFields;
}

export interface FollowupFieldSnapshot {
  projectRecordId: string;
  followupRecordId?: string | null;
  followupDate: string;
  optimisticRecordId?: string;
  createdOptimisticRecordId: string | null;
  fields: OptimisticFollowupFields;
  existed: boolean;
}

export interface TemporaryConstructionProjectInput {
  mutationId: string;
  workContent: string;
  building?: string | null;
  specialty?: string | null;
  workTypes: readonly string[];
  contractorType?: string | null;
  relatedWorkType?: string | null;
  planStartTime: string;
  planEndTime: string;
}

export interface OptimisticProjectFields {
  workflow?: ConstructionOverviewItem['workflow'];
  workTypes?: ConstructionOverviewItem['workTypes'];
  approval?: Partial<ConstructionOverviewItem['approval']>;
  deposit?: Partial<ConstructionOverviewItem['deposit']>;
}

export interface OptimisticProjectPatch {
  projectRecordId: string;
  fields: OptimisticProjectFields;
}

export interface ProjectFieldSnapshot {
  projectRecordId: string;
  fields: OptimisticProjectFields;
  existed: boolean;
}

export interface FailedApplicationDraft<TForm, TFiles> {
  sessionId: number;
  form: TForm;
  files: TFiles;
}

export function resolveFailedApplicationDraft<
  TDraft extends FailedApplicationDraft<unknown, unknown>,
>(
  activeSessionId: number | null,
  failedDrafts: readonly TDraft[],
  failedDraft: TDraft,
): {
  autoRestore: TDraft | null;
  failedDrafts: TDraft[];
} {
  return activeSessionId === failedDraft.sessionId
    ? {
        autoRestore: failedDraft,
        failedDrafts: [...failedDrafts],
      }
    : {
        autoRestore: null,
        failedDrafts: [...failedDrafts, failedDraft],
      };
}

export function dequeueFailedApplicationDraft<
  TDraft extends FailedApplicationDraft<unknown, unknown>,
>(
  failedDrafts: readonly TDraft[],
): {
  draft: TDraft | null;
  remaining: TDraft[];
} {
  const [draft = null, ...remaining] = failedDrafts;
  return { draft, remaining };
}

export function isOptimisticConstructionRecordId(
  recordId: string | null | undefined,
): boolean {
  return String(recordId || '')
    .trim()
    .startsWith('optimistic:');
}

export interface TerminationUiChangeFlags {
  removedExpanded: boolean;
  clearedSelected: boolean;
  removedListItem: boolean;
  closedFollowup: boolean;
  clearedCandidate: boolean;
}

export interface TerminationUiRestoreInput {
  targetRecordId: string;
  changed: TerminationUiChangeFlags;
  originalListIdentity: string | null;
  current: {
    expandedHasTarget: boolean;
    selectedRecordId: string | null;
    listIdentity: string | null;
    listHasTarget: boolean;
    listOperationOwned: boolean;
    followupOpen: boolean;
    followupPristine: boolean;
    candidateRecordId: string | null;
  };
}

export function getTerminationUiRestoreDecisions(
  input: TerminationUiRestoreInput,
): {
  restoreExpanded: boolean;
  restoreSelected: boolean;
  restoreListItem: boolean;
  restoreFollowup: boolean;
  restoreCandidate: boolean;
} {
  return {
    restoreExpanded:
      input.changed.removedExpanded && !input.current.expandedHasTarget,
    restoreSelected:
      input.changed.clearedSelected && input.current.selectedRecordId === null,
    restoreListItem:
      input.changed.removedListItem &&
      input.current.listOperationOwned &&
      input.originalListIdentity !== null &&
      input.current.listIdentity === input.originalListIdentity &&
      !input.current.listHasTarget,
    restoreFollowup:
      input.changed.closedFollowup &&
      !input.current.followupOpen &&
      input.current.followupPristine,
    restoreCandidate:
      input.changed.clearedCandidate &&
      input.current.candidateRecordId === null,
  };
}

export function settleAcceptedOptimisticMutation(options: {
  confirmationScheduled: boolean;
  releaseGate: () => void;
  finishOverlay: () => void;
  requestBackgroundRefresh: () => void;
  notifyResync: () => void;
}): boolean {
  options.releaseGate();
  if (options.confirmationScheduled) {
    return false;
  }
  const callbacks = [
    options.finishOverlay,
    options.requestBackgroundRefresh,
    options.notifyResync,
  ];
  let firstError: unknown;
  callbacks.forEach((callback) => {
    try {
      callback();
    } catch (error) {
      firstError ??= error;
    }
  });
  if (firstError) {
    throw firstError;
  }
  return true;
}

export function preserveAcceptedOptimisticMutationOnConfirmationTimeout(options: {
  isPending: () => boolean;
  notifyDelayed: () => void;
}): boolean {
  if (!options.isPending()) {
    return false;
  }
  options.notifyDelayed();
  return true;
}

const shanghaiDateFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function normalizeDatePrefix(value: string): string {
  const match = value.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  return match
    ? `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`
    : '';
}

function formatShanghaiDate(date: Date): string {
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  const parts = shanghaiDateFormatter.formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value || '';
  const year = part('year');
  const month = part('month');
  const day = part('day');
  return year && month && day ? `${year}-${month}-${day}` : '';
}

export function toShanghaiDateKey(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  const normalized = String(value).trim();
  if (!normalized) {
    return '';
  }
  if (/^\d{10}$/.test(normalized)) {
    return formatShanghaiDate(new Date(Number(normalized) * 1000));
  }
  if (/^\d{13}$/.test(normalized)) {
    return formatShanghaiDate(new Date(Number(normalized)));
  }
  const prefix = normalizeDatePrefix(normalized);
  if (/^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}$/.test(normalized)) {
    return prefix;
  }
  const parsed = new Date(normalized);
  return formatShanghaiDate(parsed) || prefix;
}

function getFollowupDateKey(followup: ConstructionFollowupItem): string {
  return (
    toShanghaiDateKey(followup.followupDate) ||
    toShanghaiDateKey(followup.createdAt) ||
    toShanghaiDateKey(followup.updatedAt)
  );
}

function findFollowupIndex(
  followups: readonly ConstructionFollowupItem[],
  patch: OptimisticFollowupPatch,
  inScope: (followup: ConstructionFollowupItem) => boolean = () => true,
): number {
  if (patch.followupRecordId) {
    const recordIndex = followups.findIndex(
      (followup) =>
        inScope(followup) && followup.recordId === patch.followupRecordId,
    );
    if (recordIndex >= 0) {
      return recordIndex;
    }
  }
  if (patch.allowDateFallback === false) {
    return -1;
  }
  const targetDateKey = toShanghaiDateKey(patch.followupDate);
  return targetDateKey
    ? followups.findIndex(
        (followup) =>
          inScope(followup) && getFollowupDateKey(followup) === targetDateKey,
      )
    : -1;
}

function findProjectFollowup(
  data: ConstructionManagementResponse,
  patch: OptimisticFollowupPatch,
): ConstructionFollowupItem | null {
  const project = data.items.find(
    (item) => item.recordId === patch.projectRecordId,
  );
  const candidates = [
    ...(project?.followups || []),
    ...(project?.latestFollowup ? [project.latestFollowup] : []),
    ...data.followups.filter((followup) =>
      followup.overviewRecordIds.includes(patch.projectRecordId),
    ),
  ];
  const index = findFollowupIndex(candidates, patch);
  return index >= 0 ? candidates[index] : null;
}

function getCreatedOptimisticFollowupRecordId(
  patch: OptimisticFollowupPatch,
): string {
  const requestedRecordId = patch.optimisticRecordId?.trim();
  if (requestedRecordId?.startsWith('optimistic:')) {
    return requestedRecordId;
  }
  const dateKey =
    toShanghaiDateKey(patch.followupDate) || patch.followupDate || 'undated';
  return `optimistic:${patch.projectRecordId}:${dateKey}`;
}

function createEmptyFollowup(
  project: ConstructionOverviewItem,
  patch: OptimisticFollowupPatch,
): ConstructionFollowupItem {
  return {
    recordId: getCreatedOptimisticFollowupRecordId(patch),
    title: patch.followupDate,
    constructionCode: project.constructionCode,
    workContent: project.workContent,
    workTypes: [],
    dailyWorkTypesConfirmed: false,
    overviewRecordIds: [patch.projectRecordId],
    constructionDay: null,
    isLatest: true,
    followupStaff: null,
    followupStaffMembers: [],
    completed: null,
    dailyPersonnelCheck: null,
    isolationCompliant: null,
    isolationFeedback: null,
    processFeedback: null,
    closingFeedback: null,
    closingApproval: null,
    depositPaid: null,
    roomManagerSync: null,
    completionChecklist: [],
    followupDate: patch.followupDate,
    createdAt: null,
    updatedAt: null,
    recordUrl: null,
    attachments: [],
    aiIssues: [],
  };
}

function upsertFollowup(
  followups: ConstructionFollowupItem[],
  patch: OptimisticFollowupPatch,
  nextFollowup: ConstructionFollowupItem,
  inScope?: (followup: ConstructionFollowupItem) => boolean,
): ConstructionFollowupItem[] {
  const index = findFollowupIndex(followups, patch, inScope);
  if (index < 0) {
    return [nextFollowup, ...followups];
  }
  return followups.map((followup, currentIndex) =>
    currentIndex === index ? nextFollowup : followup,
  );
}

export function applyOptimisticFollowupPatch(
  data: ConstructionManagementResponse,
  patch: OptimisticFollowupPatch,
): ConstructionManagementResponse {
  const project = data.items.find(
    (item) => item.recordId === patch.projectRecordId,
  );
  if (!project) {
    return data;
  }

  const currentFollowup = findProjectFollowup(data, patch);

  const nextFollowup: ConstructionFollowupItem = {
    ...(currentFollowup || createEmptyFollowup(project, patch)),
    ...patch.fields,
  };
  return {
    ...data,
    items: data.items.map((item) =>
      item.recordId === patch.projectRecordId
        ? {
            ...item,
            followups: upsertFollowup(item.followups, patch, nextFollowup),
            latestFollowup:
              item.latestFollowup &&
              currentFollowup &&
              item.latestFollowup.recordId === currentFollowup.recordId
                ? nextFollowup
                : currentFollowup
                  ? item.latestFollowup
                  : nextFollowup,
          }
        : item,
    ),
    followups: upsertFollowup(data.followups, patch, nextFollowup, (followup) =>
      followup.overviewRecordIds.includes(patch.projectRecordId),
    ),
  };
}

export function captureFollowupFieldSnapshot(
  data: ConstructionManagementResponse,
  input: OptimisticFollowupPatch,
): FollowupFieldSnapshot {
  const currentFollowup = findProjectFollowup(data, input);
  const fields = Object.keys(input.fields).reduce<OptimisticFollowupFields>(
    (snapshotFields, field) =>
      Object.assign(snapshotFields, {
        [field]: currentFollowup
          ? currentFollowup[field as keyof OptimisticFollowupFields]
          : undefined,
      }),
    {},
  );
  return {
    projectRecordId: input.projectRecordId,
    followupRecordId: currentFollowup?.recordId ?? input.followupRecordId,
    followupDate: input.followupDate,
    optimisticRecordId: input.optimisticRecordId,
    createdOptimisticRecordId:
      !currentFollowup &&
      data.items.some((item) => item.recordId === input.projectRecordId)
        ? getCreatedOptimisticFollowupRecordId(input)
        : null,
    fields,
    existed: Boolean(currentFollowup),
  };
}

function isDeepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) {
    return true;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => isDeepEqual(value, right[index]))
    );
  }
  if (
    !left ||
    !right ||
    typeof left !== 'object' ||
    typeof right !== 'object'
  ) {
    return false;
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key) =>
        Object.prototype.hasOwnProperty.call(rightRecord, key) &&
        isDeepEqual(leftRecord[key], rightRecord[key]),
    )
  );
}

function normalizeStringSet(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return Array.from(
    new Set(value.map((item) => String(item || '').trim()).filter(Boolean)),
  ).sort();
}

function normalizeFollowupStaffMemberSet(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return Array.from(
    new Set(
      value
        .map((item) => {
          if (!item || typeof item !== 'object') {
            return '';
          }
          const record = item as Record<string, unknown>;
          const id = String(record.id || '').trim();
          const name = String(record.name || '').trim();
          return id || name ? `${id}\u0000${name}` : '';
        })
        .filter(Boolean),
    ),
  ).sort();
}

function normalizeFollowupStaffSet(value: unknown): string[] {
  if (value === null || value === undefined) {
    return [];
  }
  return Array.from(
    new Set(
      String(value)
        .split(/[、,，;；\r\n]+/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ).sort();
}

function isFollowupFieldConfirmed(
  field: keyof OptimisticFollowupFields,
  actual: unknown,
  expected: unknown,
): boolean {
  if (field === 'workTypes') {
    return isDeepEqual(
      normalizeStringSet(actual),
      normalizeStringSet(expected),
    );
  }
  if (field === 'followupStaffMembers') {
    return isDeepEqual(
      normalizeFollowupStaffMemberSet(actual),
      normalizeFollowupStaffMemberSet(expected),
    );
  }
  if (field === 'followupStaff') {
    return isDeepEqual(
      normalizeFollowupStaffSet(actual),
      normalizeFollowupStaffSet(expected),
    );
  }
  return isDeepEqual(actual, expected);
}

export function isFollowupPatchConfirmed(
  data: ConstructionManagementResponse,
  patch: OptimisticFollowupPatch,
): boolean {
  const followup = findProjectFollowup(data, patch);
  if (!followup) {
    return false;
  }
  return Object.keys(patch.fields).every((field) => {
    const typedField = field as keyof OptimisticFollowupFields;
    return isFollowupFieldConfirmed(
      typedField,
      followup[typedField],
      patch.fields[typedField],
    );
  });
}

export function applyOptimisticProjectPatch(
  data: ConstructionManagementResponse,
  patch: OptimisticProjectPatch,
): ConstructionManagementResponse {
  const projectIndex = data.items.findIndex(
    (item) => item.recordId === patch.projectRecordId,
  );
  if (projectIndex < 0) {
    return data;
  }
  return {
    ...data,
    items: data.items.map((item, index) => {
      if (index !== projectIndex) {
        return item;
      }
      return {
        ...item,
        ...('workflow' in patch.fields
          ? { workflow: patch.fields.workflow }
          : {}),
        ...(patch.fields.workTypes
          ? { workTypes: patch.fields.workTypes }
          : {}),
        ...(patch.fields.approval
          ? {
              approval: {
                ...item.approval,
                ...patch.fields.approval,
              },
            }
          : {}),
        ...(patch.fields.deposit
          ? {
              deposit: {
                ...item.deposit,
                ...patch.fields.deposit,
              },
            }
          : {}),
      };
    }),
  };
}

function captureNestedProjectFieldSnapshot<T extends object>(
  current: T,
  patch: Partial<T>,
): Partial<T> {
  return Object.keys(patch).reduce<Partial<T>>(
    (snapshot, field) =>
      Object.assign(snapshot, {
        [field]: current[field as keyof T],
      }),
    {},
  );
}

export function captureProjectFieldSnapshot(
  data: ConstructionManagementResponse,
  patch: OptimisticProjectPatch,
): ProjectFieldSnapshot {
  const project = data.items.find(
    (item) => item.recordId === patch.projectRecordId,
  );
  const fields = Object.keys(patch.fields).reduce<OptimisticProjectFields>(
    (snapshotFields, field) => {
      if (!project) {
        return Object.assign(snapshotFields, { [field]: undefined });
      }
      if (field === 'approval' && patch.fields.approval) {
        return Object.assign(snapshotFields, {
          approval: captureNestedProjectFieldSnapshot(
            project.approval,
            patch.fields.approval,
          ),
        });
      }
      if (field === 'deposit' && patch.fields.deposit) {
        return Object.assign(snapshotFields, {
          deposit: captureNestedProjectFieldSnapshot(
            project.deposit,
            patch.fields.deposit,
          ),
        });
      }
      return Object.assign(snapshotFields, {
        [field]: project[field as 'workflow' | 'workTypes'],
      });
    },
    {},
  );
  return {
    projectRecordId: patch.projectRecordId,
    fields,
    existed: Boolean(project),
  };
}

export function restoreProjectFieldSnapshot(
  data: ConstructionManagementResponse,
  snapshot: ProjectFieldSnapshot,
): ConstructionManagementResponse {
  return snapshot.existed
    ? applyOptimisticProjectPatch(data, {
        projectRecordId: snapshot.projectRecordId,
        fields: snapshot.fields,
      })
    : data;
}

export function isProjectPatchConfirmed(
  data: ConstructionManagementResponse,
  patch: OptimisticProjectPatch,
): boolean {
  const project = data.items.find(
    (item) => item.recordId === patch.projectRecordId,
  );
  return Boolean(
    project &&
    Object.keys(patch.fields).every((field) => {
      const typedField = field as keyof OptimisticProjectFields;
      if (typedField === 'workTypes') {
        return isDeepEqual(
          normalizeStringSet(project.workTypes),
          normalizeStringSet(patch.fields.workTypes),
        );
      }
      if (typedField === 'approval' && patch.fields.approval) {
        return Object.keys(patch.fields.approval).every((nestedField) =>
          isDeepEqual(
            project.approval[
              nestedField as keyof ConstructionOverviewItem['approval']
            ],
            patch.fields.approval?.[
              nestedField as keyof ConstructionOverviewItem['approval']
            ],
          ),
        );
      }
      if (typedField === 'deposit' && patch.fields.deposit) {
        return Object.keys(patch.fields.deposit).every((nestedField) =>
          isDeepEqual(
            project.deposit[
              nestedField as keyof ConstructionOverviewItem['deposit']
            ],
            patch.fields.deposit?.[
              nestedField as keyof ConstructionOverviewItem['deposit']
            ],
          ),
        );
      }
      return isDeepEqual(project[typedField], patch.fields[typedField]);
    }),
  );
}

export function applyProjectTombstones(
  data: ConstructionManagementResponse,
  tombstones: ReadonlySet<string>,
): ConstructionManagementResponse {
  const items = data.items.filter((item) => !tombstones.has(item.recordId));
  const removedCount = data.items.length - items.length;
  return removedCount === 0
    ? data
    : {
        ...data,
        summary: {
          ...data.summary,
          total: Math.max(data.summary.total - removedCount, 0),
        },
        items,
      };
}

export function createTemporaryConstructionProject(
  input: TemporaryConstructionProjectInput,
): ConstructionOverviewItem {
  return {
    recordId: `optimistic:${input.mutationId}`,
    constructionCode: null,
    workContent: input.workContent,
    building: input.building ?? null,
    specialty: input.specialty ?? null,
    contractorType: input.contractorType ?? null,
    workTypes: [...input.workTypes],
    relatedWorkType: input.relatedWorkType ?? null,
    workflow: null,
    planStartTime: input.planStartTime,
    planEndTime: input.planEndTime,
    remainingDays: null,
    approval: {
      supervisor: null,
      ehsNotified: null,
      ehs: null,
      credential: null,
      depositConfirmation: null,
      parkSync: null,
      depositPaid: null,
    },
    deposit: {
      amount: null,
      deducted: null,
      balance: null,
    },
    managers: {
      supervisor: null,
      safety: null,
      park: null,
      applicant: null,
      engineer: null,
    },
    createdBy: null,
    createdAt: null,
    updatedAt: null,
    recordUrl: null,
    applicationAttachments: [],
    constructionIssues: [],
    completionChecklistArchive: [],
    depositAgreementFiles: [],
    depositTransferFiles: [],
    crewMembers: [],
    followups: [],
    latestFollowup: null,
  };
}

export function appendTemporaryProject(
  data: ConstructionManagementResponse,
  item: ConstructionOverviewItem,
): ConstructionManagementResponse {
  if (data.items.some((current) => current.recordId === item.recordId)) {
    return data;
  }
  return {
    ...data,
    summary: {
      ...data.summary,
      total: data.summary.total + 1,
    },
    items: [item, ...data.items],
  };
}

function replaceFollowupOverviewRecordId(
  followup: ConstructionFollowupItem,
  temporaryRecordId: string,
  realRecordId: string,
): ConstructionFollowupItem {
  if (!followup.overviewRecordIds.includes(temporaryRecordId)) {
    return followup;
  }
  const overviewRecordIds = Array.from(
    new Set(
      followup.overviewRecordIds.map((recordId) =>
        recordId === temporaryRecordId ? realRecordId : recordId,
      ),
    ),
  );
  return {
    ...followup,
    overviewRecordIds,
  };
}

function replaceProjectFollowupOverviewRecordIds(
  item: ConstructionOverviewItem,
  temporaryRecordId: string,
  realRecordId: string,
): ConstructionOverviewItem {
  const followups = item.followups.map((followup) =>
    replaceFollowupOverviewRecordId(followup, temporaryRecordId, realRecordId),
  );
  const latestFollowup = item.latestFollowup
    ? replaceFollowupOverviewRecordId(
        item.latestFollowup,
        temporaryRecordId,
        realRecordId,
      )
    : null;
  const changed =
    followups.some((followup, index) => followup !== item.followups[index]) ||
    latestFollowup !== item.latestFollowup;
  return changed ? { ...item, followups, latestFollowup } : item;
}

function findFollowupRecordIndex(
  followups: readonly ConstructionFollowupItem[],
  recordId: string,
): number {
  return followups.findIndex((followup) => followup.recordId === recordId);
}

const DAILY_FOLLOWUP_ATTACHMENT_FIELDS = new Set([
  'dailyPersonnelChecklistFiles',
  'isolationPhotoFiles',
  'processPhotoFiles',
  'closingPhotoFiles',
  'inspectionFormFiles',
]);

function isDailyLikeFollowup(followup: ConstructionFollowupItem): boolean {
  const hasDailyAttachment = followup.attachments.some(
    (attachment) =>
      DAILY_FOLLOWUP_ATTACHMENT_FIELDS.has(attachment.field) &&
      (attachment.count > 0 || attachment.files.length > 0),
  );
  return Boolean(
    followup.dailyWorkTypesConfirmed ||
    followup.dailyPersonnelCheck ||
    followup.isolationCompliant ||
    followup.isolationFeedback ||
    followup.processFeedback ||
    followup.closingFeedback ||
    followup.closingApproval ||
    followup.completed ||
    followup.completionChecklist.length > 0 ||
    hasDailyAttachment,
  );
}

function isFollowupBusinessCompatible(
  candidate: ConstructionFollowupItem,
  followup: ConstructionFollowupItem,
): boolean {
  return isDailyLikeFollowup(candidate) === isDailyLikeFollowup(followup);
}

function findFollowupDateIndex(
  followups: readonly ConstructionFollowupItem[],
  candidate: ConstructionFollowupItem,
): number {
  const candidateDateKey = getFollowupDateKey(candidate);
  if (!candidateDateKey) {
    return -1;
  }
  const compatibleIndexes = followups.flatMap((followup, index) =>
    getFollowupDateKey(followup) === candidateDateKey &&
    isFollowupBusinessCompatible(candidate, followup)
      ? [index]
      : [],
  );
  return compatibleIndexes.length === 1 ? compatibleIndexes[0] : -1;
}

function mergeFollowupOverviewRecordIds(
  authoritative: ConstructionFollowupItem,
  candidate: ConstructionFollowupItem,
): ConstructionFollowupItem {
  const overviewRecordIds = Array.from(
    new Set([
      ...authoritative.overviewRecordIds,
      ...candidate.overviewRecordIds,
    ]),
  );
  return overviewRecordIds.length === authoritative.overviewRecordIds.length
    ? authoritative
    : { ...authoritative, overviewRecordIds };
}

function mergeFollowupsByRecordId(
  current: readonly ConstructionFollowupItem[],
  candidates: readonly ConstructionFollowupItem[],
): ConstructionFollowupItem[] {
  return candidates.reduce<ConstructionFollowupItem[]>(
    (merged, candidate) => {
      const existingIndex = findFollowupRecordIndex(merged, candidate.recordId);
      if (existingIndex < 0) {
        return [...merged, candidate];
      }
      const reconciled = mergeFollowupOverviewRecordIds(
        merged[existingIndex],
        candidate,
      );
      return reconciled === merged[existingIndex]
        ? merged
        : merged.map((followup, index) =>
            index === existingIndex ? reconciled : followup,
          );
    },
    [...current],
  );
}

function mergeTemporaryFollowups(
  authoritativeFollowups: readonly ConstructionFollowupItem[],
  temporaryFollowups: readonly ConstructionFollowupItem[],
  aliases: Map<string, string>,
): ConstructionFollowupItem[] {
  return temporaryFollowups.reduce<ConstructionFollowupItem[]>(
    (merged, candidate) => {
      const recordIndex = findFollowupRecordIndex(merged, candidate.recordId);
      if (recordIndex >= 0) {
        const canonical = merged[recordIndex];
        aliases.set(candidate.recordId, canonical.recordId);
        const reconciled = mergeFollowupOverviewRecordIds(canonical, candidate);
        return reconciled === canonical
          ? merged
          : merged.map((followup, index) =>
              index === recordIndex ? reconciled : followup,
            );
      }

      const authoritativeDateIndex = findFollowupDateIndex(
        authoritativeFollowups,
        candidate,
      );
      if (authoritativeDateIndex >= 0) {
        const canonicalRecordId =
          authoritativeFollowups[authoritativeDateIndex].recordId;
        aliases.set(candidate.recordId, canonicalRecordId);
        const canonicalIndex = findFollowupRecordIndex(
          merged,
          canonicalRecordId,
        );
        const canonical = merged[canonicalIndex];
        const reconciled = mergeFollowupOverviewRecordIds(canonical, candidate);
        return reconciled === canonical
          ? merged
          : merged.map((followup, index) =>
              index === canonicalIndex ? reconciled : followup,
            );
      }
      return [...merged, candidate];
    },
    [...authoritativeFollowups],
  );
}

function mergeTopLevelProjectFollowups(
  current: readonly ConstructionFollowupItem[],
  candidates: readonly {
    followup: ConstructionFollowupItem;
    fromTemporaryProject: boolean;
  }[],
  authoritativeFollowups: readonly ConstructionFollowupItem[],
  aliases: Map<string, string>,
): ConstructionFollowupItem[] {
  return candidates.reduce<ConstructionFollowupItem[]>(
    (merged, { followup: candidate, fromTemporaryProject }) => {
      const aliasedRecordId =
        aliases.get(candidate.recordId) || candidate.recordId;
      const recordIndex = findFollowupRecordIndex(merged, aliasedRecordId);
      if (recordIndex >= 0) {
        const canonical = merged[recordIndex];
        const reconciled = mergeFollowupOverviewRecordIds(canonical, candidate);
        return reconciled === canonical
          ? merged
          : merged.map((followup, index) =>
              index === recordIndex ? reconciled : followup,
            );
      }
      if (fromTemporaryProject) {
        const authoritativeDateIndex = findFollowupDateIndex(
          authoritativeFollowups,
          candidate,
        );
        if (authoritativeDateIndex >= 0) {
          const canonicalRecordId =
            authoritativeFollowups[authoritativeDateIndex].recordId;
          aliases.set(candidate.recordId, canonicalRecordId);
          const canonicalIndex = findFollowupRecordIndex(
            merged,
            canonicalRecordId,
          );
          const canonical = merged[canonicalIndex];
          const reconciled = mergeFollowupOverviewRecordIds(
            canonical,
            candidate,
          );
          return reconciled === canonical
            ? merged
            : merged.map((followup, index) =>
                index === canonicalIndex ? reconciled : followup,
              );
        }
      }
      return [...merged, candidate];
    },
    [...current],
  );
}

function reconcileTopLevelFollowups(
  followups: readonly ConstructionFollowupItem[],
  mergedProjectFollowups: readonly ConstructionFollowupItem[],
  aliases: ReadonlyMap<string, string>,
  temporaryRecordId: string,
  realRecordId: string,
): ConstructionFollowupItem[] {
  const emittedProjectRecordIds = new Set<string>();
  const reconciled = followups.flatMap((followup) => {
    const isProjectFollowup =
      followup.overviewRecordIds.includes(temporaryRecordId) ||
      followup.overviewRecordIds.includes(realRecordId);
    if (!isProjectFollowup) {
      return [followup];
    }
    const normalized = replaceFollowupOverviewRecordId(
      followup,
      temporaryRecordId,
      realRecordId,
    );
    const canonicalRecordId =
      aliases.get(normalized.recordId) || normalized.recordId;
    const canonicalIndex = findFollowupRecordIndex(
      mergedProjectFollowups,
      canonicalRecordId,
    );
    if (canonicalIndex < 0 || emittedProjectRecordIds.has(canonicalRecordId)) {
      return [];
    }
    emittedProjectRecordIds.add(canonicalRecordId);
    return [mergedProjectFollowups[canonicalIndex]];
  });
  mergedProjectFollowups.forEach((followup) => {
    if (!emittedProjectRecordIds.has(followup.recordId)) {
      reconciled.push(followup);
    }
  });
  return reconciled;
}

export function replaceTemporaryProjectRecordId(
  data: ConstructionManagementResponse,
  temporaryRecordId: string,
  realRecordId: string,
): ConstructionManagementResponse {
  if (
    temporaryRecordId === realRecordId ||
    !data.items.some((item) => item.recordId === temporaryRecordId)
  ) {
    return data;
  }
  const authoritativeProjectExists = data.items.some(
    (item) => item.recordId === realRecordId,
  );
  if (authoritativeProjectExists) {
    const temporaryProject = data.items.find(
      (item) => item.recordId === temporaryRecordId,
    )!;
    const authoritativeProject = data.items.find(
      (item) => item.recordId === realRecordId,
    )!;
    const normalizeFollowup = (followup: ConstructionFollowupItem) =>
      replaceFollowupOverviewRecordId(
        followup,
        temporaryRecordId,
        realRecordId,
      );
    const authoritativeCandidates = [
      ...authoritativeProject.followups,
      ...(authoritativeProject.latestFollowup
        ? [authoritativeProject.latestFollowup]
        : []),
    ].map(normalizeFollowup);
    const temporaryLatestFollowup = temporaryProject.latestFollowup
      ? normalizeFollowup(temporaryProject.latestFollowup)
      : null;
    const temporaryCandidates = [
      ...temporaryProject.followups,
      ...(temporaryProject.latestFollowup
        ? [temporaryProject.latestFollowup]
        : []),
    ].map(normalizeFollowup);
    const topLevelCandidates = data.followups
      .filter(
        (followup) =>
          followup.overviewRecordIds.includes(temporaryRecordId) ||
          followup.overviewRecordIds.includes(realRecordId),
      )
      .map((followup) => ({
        followup: normalizeFollowup(followup),
        fromTemporaryProject:
          followup.overviewRecordIds.includes(temporaryRecordId),
      }));
    const authoritativeFollowups = mergeFollowupsByRecordId(
      [],
      authoritativeCandidates,
    );
    const aliases = new Map<string, string>();
    const mergedProjectFollowups = mergeTopLevelProjectFollowups(
      mergeTemporaryFollowups(
        authoritativeFollowups,
        temporaryCandidates,
        aliases,
      ),
      topLevelCandidates,
      authoritativeFollowups,
      aliases,
    );
    const temporaryLatestCanonicalRecordId = temporaryLatestFollowup
      ? aliases.get(temporaryLatestFollowup.recordId) ||
        temporaryLatestFollowup.recordId
      : null;
    const temporaryLatestMatchesAuthoritative = Boolean(
      temporaryLatestCanonicalRecordId &&
      findFollowupRecordIndex(
        authoritativeFollowups,
        temporaryLatestCanonicalRecordId,
      ) >= 0,
    );
    const canonicalFollowup = (
      followup: ConstructionFollowupItem | null,
    ): ConstructionFollowupItem | null => {
      if (!followup) {
        return null;
      }
      const normalized = normalizeFollowup(followup);
      const canonicalRecordId =
        aliases.get(normalized.recordId) || normalized.recordId;
      const index = findFollowupRecordIndex(
        mergedProjectFollowups,
        canonicalRecordId,
      );
      return index >= 0 ? mergedProjectFollowups[index] : null;
    };
    const latestFollowup =
      temporaryLatestFollowup && !temporaryLatestMatchesAuthoritative
        ? canonicalFollowup(temporaryLatestFollowup)
        : canonicalFollowup(authoritativeProject.latestFollowup);
    const reconciledAuthoritativeProject: ConstructionOverviewItem = {
      ...authoritativeProject,
      followups: mergedProjectFollowups,
      latestFollowup,
    };
    const items = data.items
      .filter((item) => item.recordId !== temporaryRecordId)
      .map((item) =>
        item.recordId === realRecordId
          ? reconciledAuthoritativeProject
          : replaceProjectFollowupOverviewRecordIds(
              item,
              temporaryRecordId,
              realRecordId,
            ),
      );
    return {
      ...data,
      summary: {
        ...data.summary,
        total: Math.max(data.summary.total - 1, items.length, 0),
      },
      items,
      followups: reconcileTopLevelFollowups(
        data.followups,
        mergedProjectFollowups,
        aliases,
        temporaryRecordId,
        realRecordId,
      ),
    };
  }
  return {
    ...data,
    items: data.items.map((item) => {
      if (item.recordId !== temporaryRecordId) {
        return item;
      }
      return {
        ...item,
        recordId: realRecordId,
        followups: item.followups.map((followup) =>
          replaceFollowupOverviewRecordId(
            followup,
            temporaryRecordId,
            realRecordId,
          ),
        ),
        latestFollowup: item.latestFollowup
          ? replaceFollowupOverviewRecordId(
              item.latestFollowup,
              temporaryRecordId,
              realRecordId,
            )
          : null,
      };
    }),
    followups: data.followups.map((followup) =>
      replaceFollowupOverviewRecordId(
        followup,
        temporaryRecordId,
        realRecordId,
      ),
    ),
  };
}

export function restoreFollowupFieldSnapshot(
  data: ConstructionManagementResponse,
  snapshot: FollowupFieldSnapshot,
): ConstructionManagementResponse {
  if (!snapshot.existed) {
    const createdRecordId = snapshot.createdOptimisticRecordId;
    if (!createdRecordId?.startsWith('optimistic:')) {
      return data;
    }
    return {
      ...data,
      items: data.items.map((item) => {
        if (item.recordId !== snapshot.projectRecordId) {
          return item;
        }
        const followups = item.followups.filter(
          (followup) => followup.recordId !== createdRecordId,
        );
        return {
          ...item,
          followups,
          latestFollowup:
            item.latestFollowup?.recordId === createdRecordId
              ? followups[0] || null
              : item.latestFollowup,
        };
      }),
      followups: data.followups.filter(
        (followup) =>
          followup.recordId !== createdRecordId ||
          !followup.overviewRecordIds.includes(snapshot.projectRecordId),
      ),
    };
  }
  return applyOptimisticFollowupPatch(data, {
    projectRecordId: snapshot.projectRecordId,
    followupRecordId: snapshot.followupRecordId,
    followupDate: snapshot.followupDate,
    optimisticRecordId: snapshot.optimisticRecordId,
    fields: snapshot.fields,
  });
}

export function rebaseConstructionDataAfterOptimisticFailure(
  authoritativeData: ConstructionManagementResponse | null,
  currentData: ConstructionManagementResponse,
  applyPending: (
    value: ConstructionManagementResponse,
  ) => ConstructionManagementResponse,
  fallbackSnapshot?: FollowupFieldSnapshot,
  fallbackProjectSnapshot?: ProjectFieldSnapshot,
): ConstructionManagementResponse {
  if (authoritativeData) {
    return applyPending(authoritativeData);
  }
  const restoredFollowup = fallbackSnapshot
    ? restoreFollowupFieldSnapshot(currentData, fallbackSnapshot)
    : currentData;
  return fallbackProjectSnapshot
    ? restoreProjectFieldSnapshot(restoredFollowup, fallbackProjectSnapshot)
    : restoredFollowup;
}
