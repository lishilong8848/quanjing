import type {
  LeaveRequestCreateResponse,
  LeaveRequestType,
} from '@shared/api.interface';
import {
  createLeaveRequestImpactComparisonKey,
  type LeaveRequestImpact,
} from '@shared/leave-request-impact';

export interface LeaveRequestDraftIdentity {
  clientMutationId: string;
  startAt: string;
  endAt: string;
}

export type LeaveRequestFailureDisposition =
  | 'definitely-not-written'
  | 'unknown-result';

export type LeaveRequestRecoveryState = 'unknown-result' | 'workflow-pending';

export type LeaveRequestMutationState =
  | 'in-flight'
  | 'editable-error'
  | LeaveRequestRecoveryState;

export function isLockedLeaveRequestState(
  state: LeaveRequestMutationState | null | undefined,
): state is LeaveRequestRecoveryState {
  return state === 'unknown-result' || state === 'workflow-pending';
}

export interface LeaveRequestSubmissionSnapshot {
  staffName: string;
  startAt: string;
  endAt: string;
  expectedImpact: LeaveRequestImpact;
  leaveType: LeaveRequestType;
  reason: string;
  screenshot: File;
  needSubstitute: boolean;
  substituteName: string;
}

export interface LeaveRequestMutationBinding {
  clientMutationId: string;
  snapshot: LeaveRequestSubmissionSnapshot;
  state: LeaveRequestMutationState;
}

export type LeaveRequestMutationResolution =
  | {
      status: 'ready';
      binding: LeaveRequestMutationBinding;
      reused: boolean;
    }
  | {
      status: 'blocked';
      binding: LeaveRequestMutationBinding;
    };

const LEAVE_REQUEST_UNKNOWN_MUTATION_STORAGE_KEY =
  'monthly-schedule.leave-request.unknown-mutation-id';
const LEAVE_REQUEST_WORKFLOW_PENDING_STORAGE_KEY =
  'monthly-schedule.leave-request.workflow-pending-mutation-id';

function normalizeLeaveRequestMutationId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (
    normalized.length > 128 ||
    !/^leave-request-[A-Za-z0-9._:-]+$/.test(normalized)
  ) {
    return null;
  }
  return normalized;
}

export function readLeaveRequestUnknownMutationId(
  storage: Pick<Storage, 'getItem'> | null,
): string | null {
  try {
    return normalizeLeaveRequestMutationId(
      storage?.getItem(LEAVE_REQUEST_UNKNOWN_MUTATION_STORAGE_KEY),
    );
  } catch {
    return null;
  }
}

export function readLeaveRequestRecoveryState(
  storage: Pick<Storage, 'getItem'> | null,
): LeaveRequestRecoveryState | null {
  const clientMutationId = readLeaveRequestUnknownMutationId(storage);
  if (!clientMutationId) return null;
  try {
    if (storage?.getItem(LEAVE_REQUEST_WORKFLOW_PENDING_STORAGE_KEY) === clientMutationId) {
      return 'workflow-pending';
    }
  } catch {
    // The original mutation ID still protects recovery if the phase is unavailable.
  }
  return 'unknown-result';
}

export function persistLeaveRequestUnknownMutationId(
  storage: Pick<Storage, 'setItem'> | null,
  clientMutationId: string,
  state: LeaveRequestRecoveryState = 'unknown-result',
): boolean {
  const normalized = normalizeLeaveRequestMutationId(clientMutationId);
  if (!storage || !normalized) return false;
  try {
    storage.setItem(LEAVE_REQUEST_UNKNOWN_MUTATION_STORAGE_KEY, normalized);
    if (state === 'workflow-pending') {
      storage.setItem(LEAVE_REQUEST_WORKFLOW_PENDING_STORAGE_KEY, normalized);
    }
    return true;
  } catch {
    return false;
  }
}

export function clearLeaveRequestUnknownMutationId(
  storage: Pick<Storage, 'removeItem'> | null,
): boolean {
  if (!storage) return false;
  try {
    storage.removeItem(LEAVE_REQUEST_UNKNOWN_MUTATION_STORAGE_KEY);
    storage.removeItem(LEAVE_REQUEST_WORKFLOW_PENDING_STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}

type LeaveRequestResponseErrorCode =
  | 'LEAVE_REQUEST_RESPONSE_MALFORMED'
  | 'LEAVE_REQUEST_RESPONSE_MISMATCH';

export class LeaveRequestResponseError extends Error {
  constructor(
    message: string,
    readonly code: LeaveRequestResponseErrorCode,
  ) {
    super(message);
    this.name = 'LeaveRequestResponseError';
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasDefinitelyNotWrittenDisposition(
  value: unknown,
  depth = 0,
): boolean {
  if (depth > 3 || !isObject(value)) return false;
  if (value.writeDisposition === 'definitely-not-written') return true;
  return (
    hasDefinitelyNotWrittenDisposition(value.data, depth + 1) ||
    hasDefinitelyNotWrittenDisposition(value.error, depth + 1)
  );
}

function areLeaveRequestSubmissionSnapshotsEqual(
  left: LeaveRequestSubmissionSnapshot,
  right: LeaveRequestSubmissionSnapshot,
): boolean {
  const leftImpactKey = createLeaveRequestImpactComparisonKey(
    left.expectedImpact,
  );
  const rightImpactKey = createLeaveRequestImpactComparisonKey(
    right.expectedImpact,
  );
  return (
    left.staffName === right.staffName &&
    left.startAt === right.startAt &&
    left.endAt === right.endAt &&
    leftImpactKey !== null &&
    leftImpactKey === rightImpactKey &&
    left.leaveType === right.leaveType &&
    left.reason === right.reason &&
    left.screenshot === right.screenshot &&
    left.needSubstitute === right.needSubstitute &&
    left.substituteName === right.substituteName
  );
}

export function classifyLeaveRequestSubmissionError(
  error: unknown,
): LeaveRequestFailureDisposition {
  let current: unknown = error;
  for (let depth = 0; depth < 3; depth += 1) {
    if (!isObject(current)) break;
    if (current instanceof LeaveRequestResponseError) {
      return 'unknown-result';
    }

    const response = isObject(current.response) ? current.response : null;
    if (
      hasDefinitelyNotWrittenDisposition(current) ||
      hasDefinitelyNotWrittenDisposition(response)
    ) {
      return 'definitely-not-written';
    }
    const status = Number(
      current.status ?? current.statusCode ?? response?.status,
    );
    if (
      Number.isFinite(status) &&
      status >= 400 &&
      status < 500 &&
      status !== 408 &&
      status !== 409 &&
      status !== 425 &&
      status !== 429
    ) {
      return 'definitely-not-written';
    }
    if (
      status === 408 ||
      status === 409 ||
      status === 425 ||
      status === 429 ||
      status >= 500
    ) {
      return 'unknown-result';
    }

    const code = String(current.code || '').toUpperCase();
    if (
      [
        'ECONNABORTED',
        'ECONNREFUSED',
        'ECONNRESET',
        'EAI_AGAIN',
        'ENETDOWN',
        'ENETUNREACH',
        'ENOTFOUND',
        'ERR_NETWORK',
        'ETIMEDOUT',
      ].includes(code)
    ) {
      return 'unknown-result';
    }
    if (current.request !== undefined && current.response === undefined) {
      return 'unknown-result';
    }
    if (
      /network error|failed to fetch|fetch failed|timeout|timed out|socket hang up|connection reset/i.test(
        String(current.message || ''),
      )
    ) {
      return 'unknown-result';
    }
    current = current.cause;
  }
  return 'unknown-result';
}

export function markLeaveRequestMutationFailure(
  binding: LeaveRequestMutationBinding,
  error: unknown,
): LeaveRequestMutationBinding {
  if (isLockedLeaveRequestState(binding.state)) return binding;
  return {
    ...binding,
    state:
      classifyLeaveRequestSubmissionError(error) === 'definitely-not-written'
        ? 'editable-error'
        : 'unknown-result',
  };
}

export function resolveLeaveRequestMutationBinding(
  binding: LeaveRequestMutationBinding | null,
  snapshot: LeaveRequestSubmissionSnapshot,
  createMutationId: () => string,
): LeaveRequestMutationResolution {
  if (binding) {
    if (areLeaveRequestSubmissionSnapshotsEqual(binding.snapshot, snapshot)) {
      return {
        status: 'ready',
        binding:
          isLockedLeaveRequestState(binding.state)
            ? binding
            : { ...binding, state: 'in-flight' },
        reused: true,
      };
    }
    if (isLockedLeaveRequestState(binding.state)) {
      return { status: 'blocked', binding };
    }
  }

  return {
    status: 'ready',
    binding: {
      clientMutationId: createMutationId(),
      snapshot: Object.freeze({ ...snapshot }),
      state: 'in-flight',
    },
    reused: false,
  };
}

function isLeaveRequestSuccessPayload(
  value: unknown,
): value is LeaveRequestCreateResponse {
  if (!isObject(value)) return false;
  return (
    value.success === true &&
    typeof value.clientMutationId === 'string' &&
    typeof value.startAt === 'string' &&
    typeof value.endAt === 'string' &&
    typeof value.leaveStaffName === 'string' &&
    typeof value.message === 'string' &&
    typeof value.total === 'number' &&
    typeof value.created === 'number' &&
    typeof value.rawHours === 'number' &&
    typeof value.minimumHours === 'number' &&
    Array.isArray(value.recordIds) &&
    value.recordIds.length > 0 &&
    value.recordIds.every((id) => typeof id === 'string' && Boolean(id.trim())) &&
    new Set(value.recordIds).size === value.recordIds.length &&
    isLeaveRequestWorkflowReceipt(value.approvalWorkflow, value.recordIds) &&
    Array.isArray(value.affectedSchedules) &&
    Array.isArray(value.excludedSchedules) &&
    Array.isArray(value.unrecognizedShifts) &&
    Array.isArray(value.missingCalendarYears)
  );
}

function isLeaveRequestWorkflowReceipt(
  workflow: unknown,
  recordIds: string[],
): boolean {
  if (workflow === undefined) return true;
  if (!isObject(workflow)) return false;
  const workflowRecordIds = workflow.recordIds;
  return (
    workflow.mode === 'program_card' &&
    typeof workflow.accepted === 'boolean' &&
    workflow.pending === true &&
    Array.isArray(workflowRecordIds) &&
    workflowRecordIds.length === recordIds.length &&
    recordIds.every((id) => workflowRecordIds.includes(id))
  );
}

export function resolveLeaveRequestSuccessResponse(
  result: unknown,
  draft: LeaveRequestDraftIdentity,
): LeaveRequestCreateResponse {
  let candidate = result;
  for (let depth = 0; depth <= 2; depth += 1) {
    if (isLeaveRequestSuccessPayload(candidate)) {
      if (
        candidate.clientMutationId !== draft.clientMutationId ||
        candidate.startAt !== draft.startAt ||
        candidate.endAt !== draft.endAt
      ) {
        throw new LeaveRequestResponseError(
          '请休假响应与当前请求不一致，请保留草稿后重试',
          'LEAVE_REQUEST_RESPONSE_MISMATCH',
        );
      }
      return candidate;
    }
    if (!isObject(candidate) || !('data' in candidate)) break;
    candidate = candidate.data;
  }
  throw new LeaveRequestResponseError(
    '请休假响应格式异常，请保留草稿后重试',
    'LEAVE_REQUEST_RESPONSE_MALFORMED',
  );
}

export interface LeaveRequestSubmitOptions<TDraft, TResult> {
  draft: TDraft;
  onStart: (draft: TDraft) => void;
  request: (draft: TDraft) => Promise<TResult>;
  onSuccess: (result: TResult, draft: TDraft) => void | Promise<void>;
  onRollback: (error: unknown, draft: TDraft) => void;
  onReopen: (draft: TDraft) => void;
  onFailure: (error: unknown, draft: TDraft) => void | Promise<void>;
  onSettled: (draft: TDraft) => void;
}

export async function coordinateLeaveRequestSubmit<TDraft, TResult>({
  draft,
  onStart,
  request,
  onSuccess,
  onRollback,
  onReopen,
  onFailure,
  onSettled,
}: LeaveRequestSubmitOptions<TDraft, TResult>): Promise<TResult | undefined> {
  let settled = false;
  const settleOnce = () => {
    if (settled) {
      return;
    }
    settled = true;
    onSettled(draft);
  };

  onStart(draft);

  try {
    const result = await request(draft);
    await onSuccess(result, draft);
    settleOnce();
    return result;
  } catch (error) {
    onRollback(error, draft);
    onReopen(draft);
    settleOnce();
    await onFailure(error, draft);
    return undefined;
  }
}
