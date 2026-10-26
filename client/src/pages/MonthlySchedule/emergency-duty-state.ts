import type {
  EmergencyDutyPerson,
  EmergencyDutyPersonOption,
  EmergencyDutySchedule,
  EmergencyDutyUpsertResponse,
} from '@shared/emergency-duty.interface';

export type EmergencyDutyPendingState =
  | 'pending'
  | 'cache_refresh_pending'
  | 'unknown-result';

export interface EmergencyDutyViewRecord extends EmergencyDutySchedule {
  syncState?: EmergencyDutyPendingState;
  clientMutationId?: string;
  localRevision?: number;
}

export type EmergencyDutyIndex = Map<string, EmergencyDutyViewRecord>;

export interface EmergencyDutyMutationBinding {
  date: string;
  clientMutationId: string;
  revision: number;
  unknownHistory: boolean;
  before: EmergencyDutyViewRecord | null;
  draft: {
    date: string;
    personKeys: string[];
    clientMutationId: string;
  };
}

export interface EmergencyDutyMutationInput {
  date: string;
  people: EmergencyDutyPersonOption[];
  clientMutationId: string;
  revision?: number;
}

export type EmergencyDutyWriteDisposition =
  | 'definitely-not-written'
  | 'unknown-result';

export type EmergencyDutyLoadState = 'loading' | 'ready' | 'error';

export interface EmergencyDutyLoadedRange {
  startDate: string;
  endDate: string;
}

export interface EmergencyDutyDayView {
  state: 'scheduled' | 'empty';
  people: EmergencyDutyPersonOption[];
  syncState: EmergencyDutyPendingState | null;
  loadState: EmergencyDutyLoadState;
  stale: boolean;
}

export type EmergencyDutySubmissionIssue =
  | 'invalid-date'
  | 'schedules-unavailable'
  | 'outside-loaded-range'
  | 'pending'
  | 'empty-selection'
  | 'options-unavailable';

function normalizePeople(
  people: ReadonlyArray<EmergencyDutyPerson>,
): EmergencyDutyPerson[] {
  const byKey = new Map<string, EmergencyDutyPerson>();
  people.forEach((person) => {
    const key = person.key.trim();
    if (!key || byKey.has(key)) return;
    byKey.set(key, {
      key,
      name: person.name.trim() || '姓名未维护',
      role: person.role.trim(),
    });
  });
  return Array.from(byKey.values());
}

function normalizeRecord(
  record: EmergencyDutySchedule,
): EmergencyDutyViewRecord {
  return {
    recordId: record.recordId,
    date: record.date,
    people: normalizePeople(record.people),
    building: record.building,
  };
}

function cloneRecord(record: EmergencyDutyViewRecord): EmergencyDutyViewRecord {
  return {
    ...record,
    people: record.people.map((person) => ({ ...person })),
  };
}

function isCurrentMutation(
  index: EmergencyDutyIndex,
  binding: EmergencyDutyMutationBinding,
): boolean {
  return index.get(binding.date)?.clientMutationId === binding.clientMutationId;
}

function isCanonicalEmergencyDutyRecord(
  left: EmergencyDutyViewRecord,
  right: EmergencyDutyViewRecord,
): boolean {
  const leftKeys = left.people.map((person) => person.key).sort();
  const rightKeys = right.people.map((person) => person.key).sort();
  const leftBuildingIsEmpty =
    left.building === null || left.building.trim().length === 0;
  const rightBuildingIsEmpty =
    right.building === null || right.building.trim().length === 0;
  return (
    left.recordId === right.recordId &&
    left.date === right.date &&
    leftBuildingIsEmpty &&
    rightBuildingIsEmpty &&
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index])
  );
}

export function buildEmergencyDutyIndex(
  schedules: ReadonlyArray<EmergencyDutySchedule>,
): EmergencyDutyIndex {
  const index = new Map<string, EmergencyDutyViewRecord>();
  schedules.forEach((schedule) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(schedule.date)) return;
    index.set(schedule.date, normalizeRecord(schedule));
  });
  return index;
}

export function getEmergencyDutyByDate(
  index: EmergencyDutyIndex,
  date: string,
): {
  state: 'scheduled' | 'empty';
  people: EmergencyDutyPerson[];
  syncState: EmergencyDutyPendingState | null;
} {
  const record = index.get(date);
  if (!record || record.people.length === 0) {
    return { state: 'empty', people: [], syncState: record?.syncState || null };
  }
  return {
    state: 'scheduled',
    people: record.people,
    syncState: record.syncState || null,
  };
}

export function beginEmergencyDutyMutation(
  index: EmergencyDutyIndex,
  input: EmergencyDutyMutationInput,
): { index: EmergencyDutyIndex; binding: EmergencyDutyMutationBinding } {
  const before = index.get(input.date);
  const revision =
    Number.isSafeInteger(input.revision) && Number(input.revision) >= 0
      ? Number(input.revision)
      : 0;
  const binding: EmergencyDutyMutationBinding = {
    date: input.date,
    clientMutationId: input.clientMutationId,
    revision,
    unknownHistory: false,
    before: before ? cloneRecord(before) : null,
    draft: {
      date: input.date,
      personKeys: input.people.map((person) => person.key),
      clientMutationId: input.clientMutationId,
    },
  };
  const next = new Map(index);
  next.set(input.date, {
    recordId: before?.recordId || `optimistic-${input.clientMutationId}`,
    date: input.date,
    people: normalizePeople(input.people),
    building: before?.building ?? null,
    syncState: 'pending',
    clientMutationId: input.clientMutationId,
    localRevision: revision,
  });
  return { index: next, binding };
}

export function resolveEmergencyDutyMutationSuccess(
  index: EmergencyDutyIndex,
  binding: EmergencyDutyMutationBinding,
  response: EmergencyDutyUpsertResponse,
): EmergencyDutyIndex {
  if (
    response.clientMutationId !== binding.clientMutationId ||
    !isCurrentMutation(index, binding)
  ) {
    return index;
  }

  const next = new Map(index);
  const record = normalizeRecord(response.record);
  next.set(
    binding.date,
    response.syncStatus === 'cache_refresh_pending'
      ? {
          ...record,
          syncState: 'cache_refresh_pending',
          clientMutationId: binding.clientMutationId,
          localRevision: binding.revision,
        }
      : { ...record, localRevision: binding.revision },
  );
  return next;
}

export function resolveEmergencyDutyMutationFailure(
  index: EmergencyDutyIndex,
  binding: EmergencyDutyMutationBinding,
  disposition: EmergencyDutyWriteDisposition,
): {
  index: EmergencyDutyIndex;
  restoreDraft: EmergencyDutyMutationBinding['draft'] | null;
  retryBinding: EmergencyDutyMutationBinding | null;
} {
  if (!isCurrentMutation(index, binding)) {
    return { index, restoreDraft: null, retryBinding: null };
  }

  const next = new Map(index);
  if (disposition === 'definitely-not-written' && !binding.unknownHistory) {
    if (binding.before) {
      next.set(binding.date, cloneRecord(binding.before));
    } else {
      next.delete(binding.date);
    }
    return { index: next, restoreDraft: binding.draft, retryBinding: null };
  }

  const current = next.get(binding.date);
  if (current) {
    next.set(binding.date, { ...current, syncState: 'unknown-result' });
  }
  const retryBinding = binding.unknownHistory
    ? binding
    : { ...binding, unknownHistory: true };
  return { index: next, restoreDraft: null, retryBinding };
}

export function retryEmergencyDutyMutation(
  index: EmergencyDutyIndex,
  binding: EmergencyDutyMutationBinding,
): { index: EmergencyDutyIndex; binding: EmergencyDutyMutationBinding } {
  const current = index.get(binding.date);
  if (
    !current ||
    current.clientMutationId !== binding.clientMutationId ||
    current.syncState !== 'unknown-result'
  ) {
    return { index, binding };
  }
  const next = new Map(index);
  next.set(binding.date, { ...current, syncState: 'pending' });
  return { index: next, binding };
}

export function mergeEmergencyDutySnapshot(
  current: EmergencyDutyIndex,
  schedules: ReadonlyArray<EmergencyDutySchedule>,
  options: { snapshotRevision?: number } = {},
): EmergencyDutyIndex {
  const next = buildEmergencyDutyIndex(schedules);
  const snapshotRevision = Number.isSafeInteger(options.snapshotRevision)
    ? Number(options.snapshotRevision)
    : Number.MAX_SAFE_INTEGER;
  current.forEach((record, date) => {
    if (
      record.localRevision !== undefined &&
      record.localRevision > snapshotRevision
    ) {
      next.set(date, cloneRecord(record));
      return;
    }
    if (
      record.syncState === 'pending' ||
      record.syncState === 'unknown-result'
    ) {
      next.set(date, cloneRecord(record));
      return;
    }
    if (record.syncState === 'cache_refresh_pending') {
      const snapshotRecord = next.get(date);
      if (
        !snapshotRecord ||
        !isCanonicalEmergencyDutyRecord(record, snapshotRecord)
      ) {
        next.set(date, cloneRecord(record));
      }
    }
  });
  return next;
}

export function classifyEmergencyDutyMutationError(
  error: unknown,
): EmergencyDutyWriteDisposition {
  const queue: unknown[] = [error];
  const visited = new Set<object>();
  let sawDefinitelyNotWritten = false;
  let sawUnknownResult = false;

  while (queue.length > 0 && visited.size < 24) {
    const value = queue.shift();
    if (!value || typeof value !== 'object' || visited.has(value)) continue;
    visited.add(value);
    const candidate = value as Record<string, unknown>;
    if (candidate.writeDisposition === 'definitely-not-written') {
      sawDefinitelyNotWritten = true;
    } else if (candidate.writeDisposition === 'unknown-result') {
      sawUnknownResult = true;
    }
    queue.push(
      candidate.response,
      candidate.data,
      candidate.cause,
      candidate.error,
      candidate.body,
    );
  }

  return sawDefinitelyNotWritten && !sawUnknownResult
    ? 'definitely-not-written'
    : 'unknown-result';
}

export function getEmergencyDutySubmissionIssue({
  date,
  loadedRange,
  loadState,
  syncState,
  selectedCount,
  optionsReady,
  isRecovery,
}: {
  date: string;
  loadedRange: EmergencyDutyLoadedRange | null;
  loadState: EmergencyDutyLoadState;
  syncState: EmergencyDutyPendingState | null;
  selectedCount: number;
  optionsReady: boolean;
  isRecovery: boolean;
}): EmergencyDutySubmissionIssue | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return 'invalid-date';
  if (syncState === 'pending') return 'pending';
  if (selectedCount <= 0) return 'empty-selection';
  if (isRecovery) return null;
  if (loadState !== 'ready') return 'schedules-unavailable';
  if (
    !loadedRange ||
    date < loadedRange.startDate ||
    date > loadedRange.endDate
  ) {
    return 'outside-loaded-range';
  }
  if (!optionsReady) return 'options-unavailable';
  return null;
}

export function formatEmergencyDutySummary(
  view: EmergencyDutyDayView,
  visiblePeople = 2,
): string {
  if (view.people.length === 0) {
    if (view.loadState === 'loading') return '应急：加载中';
    if (view.loadState === 'error') return '应急：刷新失败 · 暂无法确认';
    if (view.stale) return '应急：缓存已过期 · 暂无法确认';
    return '应急：未安排';
  }

  const names = view.people
    .slice(0, visiblePeople)
    .map((person) => person.name)
    .join(' ');
  const overflow =
    view.people.length > visiblePeople ? `等${view.people.length}人` : '';
  const syncLabel =
    view.syncState === 'pending'
      ? ' · 同步中'
      : view.syncState === 'cache_refresh_pending'
        ? ' · 缓存待刷新'
        : view.syncState === 'unknown-result'
          ? ' · 结果待确认'
          : '';
  const freshnessLabel =
    view.loadState === 'error'
      ? ' · 刷新失败，展示上次缓存'
      : view.stale
        ? ' · 缓存已过期'
        : '';
  return `应急：${names}${overflow}${syncLabel}${freshnessLabel}`;
}
