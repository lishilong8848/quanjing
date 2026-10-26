export interface ManualReviewScope {
  projectRecordId: string;
  followupRecordId: string;
  reviewType: string;
}

export type ScopedManualReviewStatus = 'pending' | 'awaiting-confirmation';

export interface ScopedPendingManualReview<TReview extends { id: string }> {
  scope: ManualReviewScope;
  review: TReview;
  revision: number;
  status: ScopedManualReviewStatus;
}

export interface ScopedManualReviewSettlement<TReview extends { id: string }> {
  succeeded: readonly ScopedPendingManualReview<TReview>[];
  failed: readonly ScopedPendingManualReview<TReview>[];
}

export function buildManualReviewScope(
  projectRecordId: string,
  followupRecordId: string,
  reviewType: string,
): ManualReviewScope {
  return {
    projectRecordId: projectRecordId.trim(),
    followupRecordId: followupRecordId.trim(),
    reviewType: reviewType.trim(),
  };
}

export function getManualReviewScopeKey(scope: ManualReviewScope): string {
  return JSON.stringify([
    scope.projectRecordId,
    scope.followupRecordId,
    scope.reviewType,
  ]);
}

function getScopedReviewKey<TReview extends { id: string }>(
  entry: Pick<ScopedPendingManualReview<TReview>, 'scope' | 'review'>,
): string {
  return JSON.stringify([
    getManualReviewScopeKey(entry.scope),
    entry.review.id,
  ]);
}

function getScopedReviewRevisionKey<TReview extends { id: string }>(
  entry: ScopedPendingManualReview<TReview>,
): string {
  return JSON.stringify([getScopedReviewKey(entry), entry.revision]);
}

export function upsertScopedPendingManualReview<TReview extends { id: string }>(
  current: readonly ScopedPendingManualReview<TReview>[],
  scope: ManualReviewScope,
  review: TReview,
): ScopedPendingManualReview<TReview>[] {
  const scopedReviewKey = getScopedReviewKey({ scope, review });
  const previous = current.find(
    (entry) => getScopedReviewKey(entry) === scopedReviewKey,
  );
  const next: ScopedPendingManualReview<TReview> = {
    scope: { ...scope },
    review,
    revision: (previous?.revision || 0) + 1,
    status: 'pending',
  };
  return [
    ...current.filter((entry) => getScopedReviewKey(entry) !== scopedReviewKey),
    next,
  ];
}

export function selectScopedPendingManualReviews<
  TReview extends { id: string },
>(
  current: readonly ScopedPendingManualReview<TReview>[],
  scope: ManualReviewScope,
): ScopedPendingManualReview<TReview>[] {
  const scopeKey = getManualReviewScopeKey(scope);
  return current.filter(
    (entry) => getManualReviewScopeKey(entry.scope) === scopeKey,
  );
}

export function settleScopedManualReviewBatch<TReview extends { id: string }>(
  current: readonly ScopedPendingManualReview<TReview>[],
  settlement: ScopedManualReviewSettlement<TReview>,
): ScopedPendingManualReview<TReview>[] {
  const submitted = [
    ...settlement.succeeded.map((entry) => ({
      entry,
      status: 'awaiting-confirmation' as const,
    })),
    ...settlement.failed.map((entry) => ({
      entry,
      status: 'pending' as const,
    })),
  ];
  const statusByRevisionKey = new Map(
    submitted.map(({ entry, status }) => [
      getScopedReviewRevisionKey(entry),
      status,
    ]),
  );
  const result = current.map((entry) => {
    const status = statusByRevisionKey.get(getScopedReviewRevisionKey(entry));
    return status && status !== entry.status
      ? {
          ...entry,
          status,
        }
      : entry;
  });

  submitted.forEach(({ entry, status }) => {
    const scopedReviewKey = getScopedReviewKey(entry);
    const hasCurrentRevision = result.some(
      (candidate) =>
        getScopedReviewRevisionKey(candidate) ===
        getScopedReviewRevisionKey(entry),
    );
    const hasNewerRevision = result.some(
      (candidate) =>
        getScopedReviewKey(candidate) === scopedReviewKey &&
        candidate.revision > entry.revision,
    );
    if (!hasCurrentRevision && !hasNewerRevision) {
      result.push({
        ...entry,
        scope: { ...entry.scope },
        status,
      });
    }
  });

  return result;
}

export function confirmScopedManualReviewBatch<TReview extends { id: string }>(
  current: readonly ScopedPendingManualReview<TReview>[],
  submittedSucceeded: readonly ScopedPendingManualReview<TReview>[],
  ordinaryReadConfirmed: boolean,
): ScopedPendingManualReview<TReview>[] {
  if (!ordinaryReadConfirmed) {
    return settleScopedManualReviewBatch(current, {
      succeeded: submittedSucceeded,
      failed: [],
    });
  }
  const confirmedRevisionKeys = new Set(
    submittedSucceeded.map(getScopedReviewRevisionKey),
  );
  return current.filter(
    (entry) => !confirmedRevisionKeys.has(getScopedReviewRevisionKey(entry)),
  );
}
