export interface ProjectExpansionCandidate {
  recordId: string;
  archived: boolean;
}

export interface ProjectCreatedTimeCandidate {
  recordId: string;
  workContent?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  planStartTime?: string | null;
}

export function getDefaultExpandedProjectIds(
  items: ProjectExpansionCandidate[],
  currentIds: Iterable<string>,
  initialized: boolean,
): Set<string> {
  const visibleIds = new Set(
    items.filter((item) => !item.archived).map((item) => item.recordId),
  );
  const next = new Set(
    Array.from(currentIds).filter((recordId) => visibleIds.has(recordId)),
  );

  if (!initialized) {
    const firstVisible = items.find((item) => !item.archived);
    if (firstVisible) {
      next.add(firstVisible.recordId);
    }
  }

  return next;
}

export function filterTemporarilyDeletedProjectItems<
  T extends { recordId: string },
>(items: readonly T[], deletedIds: Iterable<string>): T[] {
  const deleted = new Set(deletedIds);
  if (deleted.size === 0) {
    return [...items];
  }
  return items.filter((item) => !deleted.has(item.recordId));
}

export function getVisibleProjectItems<T>(
  items: readonly T[],
  limit: number,
): T[] {
  const visibleLimit = Math.max(0, Math.floor(limit));
  return items.slice(0, visibleLimit);
}

export function sortProjectItemsByCreatedAtDesc<
  T extends ProjectCreatedTimeCandidate,
>(items: readonly T[]): T[] {
  return [...items].sort(
    (left, right) =>
      getProjectCreatedSortTime(right) - getProjectCreatedSortTime(left) ||
      getProjectFallbackSortTime(right) - getProjectFallbackSortTime(left) ||
      String(left.workContent || '').localeCompare(
        String(right.workContent || ''),
        'zh-Hans',
      ) ||
      left.recordId.localeCompare(right.recordId, 'zh-Hans'),
  );
}

function getProjectCreatedSortTime(item: ProjectCreatedTimeCandidate): number {
  return parseProjectSortTime(item.createdAt);
}

function getProjectFallbackSortTime(item: ProjectCreatedTimeCandidate): number {
  return (
    parseProjectSortTime(item.updatedAt) ||
    parseProjectSortTime(item.planStartTime)
  );
}

function parseProjectSortTime(value?: string | null): number {
  if (!value) {
    return 0;
  }
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.getTime() : 0;
}
