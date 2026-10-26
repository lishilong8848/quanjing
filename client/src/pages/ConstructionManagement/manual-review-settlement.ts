export interface ManualReviewSettlement<T> {
  succeeded: T[];
  failed: T[];
}

export function partitionManualReviewSettlements<T>(
  reviews: readonly T[],
  results: readonly PromiseSettledResult<unknown>[],
): ManualReviewSettlement<T> {
  const succeeded: T[] = [];
  const failed: T[] = [];

  reviews.forEach((review, index) => {
    if (results[index]?.status === 'fulfilled') {
      succeeded.push(review);
    } else {
      failed.push(review);
    }
  });

  return { succeeded, failed };
}

export function retainPendingManualReviewItems<T extends { id: string }>(
  current: readonly T[],
  submitted: readonly T[],
  succeeded: readonly T[],
): T[] {
  const submittedById = new Map(
    submitted.map((review) => [review.id, review] as const),
  );
  const succeededSnapshots = new Set(succeeded);

  return current.filter((review) => {
    const submittedSnapshot = submittedById.get(review.id);
    return (
      !submittedSnapshot ||
      !succeededSnapshots.has(submittedSnapshot) ||
      submittedSnapshot !== review
    );
  });
}
