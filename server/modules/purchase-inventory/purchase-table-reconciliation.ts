export interface PurchaseTableReconciliationRecord {
  recordId: string;
  code: string;
  building: string;
  requester: string;
  itemName: string;
  quantity: number | null;
  createdAt: number;
  note?: string;
  unit?: string;
}

export interface PurchaseTableReconciliationUpdate {
  submissionRecordId: string;
  executionRecordId: string;
  code: string;
  building: string;
  previousCode: string;
  previousBuilding: string;
}

export interface PurchaseTableReconciliationPlan {
  updates: PurchaseTableReconciliationUpdate[];
  unresolvedSubmissionRecordIds: string[];
}

const RECONCILIATION_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;
const BUILDING_CODE = new Map([
  ['A楼', '1'],
  ['B楼', '2'],
  ['C楼', '3'],
  ['D楼', '4'],
  ['E楼', '5'],
  ['H楼', '6'],
  ['110站', '7'],
]);

export function planPurchaseTableReconciliation(
  submissions: readonly PurchaseTableReconciliationRecord[] = [],
  executions: readonly PurchaseTableReconciliationRecord[] = [],
): PurchaseTableReconciliationPlan {
  const updates: PurchaseTableReconciliationUpdate[] = [];
  const unresolved = new Set<string>();

  for (const submission of submissions) {
    const semanticCandidates = executions.filter((execution) =>
      recordsDescribeSamePurchase(submission, execution),
    );
    if (!semanticCandidates.length) continue;

    const validCandidates = semanticCandidates.filter((execution) =>
      executionCodeMatchesBuilding(execution.code, execution.building),
    );
    if (!validCandidates.length) {
      unresolved.add(submission.recordId);
      continue;
    }

    const sameCodeCandidates = validCandidates.filter(
      (execution) => execution.code === submission.code,
    );
    let candidates = sameCodeCandidates.length
      ? sameCodeCandidates
      : validCandidates;
    if (!sameCodeCandidates.length && submission.building.trim() !== 'H楼') {
      const sameBuildingCandidates = validCandidates.filter(
        (execution) =>
          execution.building.trim() === submission.building.trim(),
      );
      if (sameBuildingCandidates.length) candidates = sameBuildingCandidates;
    }
    const authorities = new Set(
      candidates.map((execution) => `${execution.code}\u0000${execution.building}`),
    );
    if (authorities.size !== 1) {
      unresolved.add(submission.recordId);
      continue;
    }

    const execution = closestExecution(submission, candidates);
    if (
      submission.code === execution.code &&
      submission.building === execution.building
    ) {
      continue;
    }
    updates.push({
      submissionRecordId: submission.recordId,
      executionRecordId: execution.recordId,
      code: execution.code,
      building: execution.building,
      previousCode: submission.code,
      previousBuilding: submission.building,
    });
  }

  const submissionById = new Map(
    submissions.map((submission) => [submission.recordId, submission]),
  );
  const updateBySubmissionId = new Map(
    updates.map((update) => [update.submissionRecordId, update]),
  );
  const unresolvedGroups = new Map<
    string,
    PurchaseTableReconciliationRecord[]
  >();
  for (const recordId of unresolved) {
    const submission = submissionById.get(recordId);
    if (!submission) continue;
    const key = purchaseGroupKey(submission);
    const group = unresolvedGroups.get(key) ?? [];
    group.push(submission);
    unresolvedGroups.set(key, group);
  }

  for (const [groupKey, unresolvedSubmissions] of unresolvedGroups) {
    const relatedSubmissions = submissions.filter(
      (submission) => purchaseGroupKey(submission) === groupKey,
    );
    const relatedExecutions = executions.filter(
      (execution) =>
        executionCodeMatchesBuilding(execution.code, execution.building) &&
        relatedSubmissions.some((submission) =>
          recordsDescribeSamePurchase(submission, execution),
        ),
    );
    const claimedAuthorities = new Set<string>();
    for (const submission of relatedSubmissions) {
      if (unresolved.has(submission.recordId)) continue;
      const planned = updateBySubmissionId.get(submission.recordId);
      if (planned) {
        claimedAuthorities.add(authorityKey(planned.code, planned.building));
        continue;
      }
      if (
        relatedExecutions.some(
          (execution) =>
            execution.code === submission.code &&
            execution.building === submission.building,
        )
      ) {
        claimedAuthorities.add(
          authorityKey(submission.code, submission.building),
        );
      }
    }

    const remainingByAuthority = new Map<
      string,
      PurchaseTableReconciliationRecord[]
    >();
    for (const execution of relatedExecutions) {
      const key = authorityKey(execution.code, execution.building);
      if (claimedAuthorities.has(key)) continue;
      const group = remainingByAuthority.get(key) ?? [];
      group.push(execution);
      remainingByAuthority.set(key, group);
    }

    const orderedSubmissions = [...unresolvedSubmissions].sort(
      compareRecordCreation,
    );
    const orderedAuthorities = [...remainingByAuthority.values()].sort(
      (left, right) =>
        Math.min(...left.map((record) => record.createdAt)) -
        Math.min(...right.map((record) => record.createdAt)),
    );
    if (orderedAuthorities.length === 1) {
      for (const submission of orderedSubmissions) {
        addReconciliationUpdate(
          submission,
          closestExecution(submission, orderedAuthorities[0]),
          updates,
          updateBySubmissionId,
          unresolved,
        );
      }
      continue;
    }
    if (orderedAuthorities.length !== orderedSubmissions.length) continue;
    orderedSubmissions.forEach((submission, index) => {
      addReconciliationUpdate(
        submission,
        closestExecution(submission, orderedAuthorities[index]),
        updates,
        updateBySubmissionId,
        unresolved,
      );
    });
  }

  return {
    updates: updates.sort((left, right) =>
      left.submissionRecordId.localeCompare(right.submissionRecordId),
    ),
    unresolvedSubmissionRecordIds: [...unresolved].sort(),
  };
}

function addReconciliationUpdate(
  submission: PurchaseTableReconciliationRecord,
  execution: PurchaseTableReconciliationRecord,
  updates: PurchaseTableReconciliationUpdate[],
  updateBySubmissionId: Map<string, PurchaseTableReconciliationUpdate>,
  unresolved: Set<string>,
): void {
  unresolved.delete(submission.recordId);
  if (
    submission.code === execution.code &&
    submission.building === execution.building
  ) {
    return;
  }
  const update = {
    submissionRecordId: submission.recordId,
    executionRecordId: execution.recordId,
    code: execution.code,
    building: execution.building,
    previousCode: submission.code,
    previousBuilding: submission.building,
  };
  updates.push(update);
  updateBySubmissionId.set(submission.recordId, update);
}

function recordsDescribeSamePurchase(
  submission: PurchaseTableReconciliationRecord,
  execution: PurchaseTableReconciliationRecord,
): boolean {
  if (
    !normalize(submission.requester) ||
    normalize(submission.requester) !== normalize(execution.requester) ||
    !normalize(submission.itemName) ||
    normalize(submission.itemName) !== normalize(execution.itemName)
  ) {
    return false;
  }
  if (submission.createdAt <= 0 || execution.createdAt <= 0) return false;
  const elapsed = execution.createdAt - submission.createdAt;
  if (elapsed < 0 || elapsed > RECONCILIATION_WINDOW_MS) return false;
  if (
    submission.unit &&
    execution.unit &&
    normalize(submission.unit) !== normalize(execution.unit)
  ) {
    return false;
  }
  if (
    submission.quantity !== null &&
    execution.quantity !== null &&
    submission.quantity !== execution.quantity
  ) {
    return Boolean(
      normalize(submission.note || '') &&
        normalize(submission.note || '') === normalize(execution.note || ''),
    );
  }
  return true;
}

function executionCodeMatchesBuilding(code: string, building: string): boolean {
  const match = /^CG\d{6}-([1-7])\d{2}$/.exec(code.trim());
  return Boolean(match && match[1] === BUILDING_CODE.get(building.trim()));
}

function purchaseGroupKey(record: PurchaseTableReconciliationRecord): string {
  return [
    normalize(record.requester),
    normalize(record.itemName),
    record.quantity ?? '',
    normalize(record.unit || ''),
  ].join('\u0000');
}

function authorityKey(code: string, building: string): string {
  return `${code}\u0000${building}`;
}

function compareRecordCreation(
  left: PurchaseTableReconciliationRecord,
  right: PurchaseTableReconciliationRecord,
): number {
  return left.createdAt - right.createdAt || left.recordId.localeCompare(right.recordId);
}

function closestExecution(
  submission: PurchaseTableReconciliationRecord,
  candidates: readonly PurchaseTableReconciliationRecord[],
): PurchaseTableReconciliationRecord {
  return [...candidates].sort((left, right) => {
    const leftDistance = Math.abs(left.createdAt - submission.createdAt);
    const rightDistance = Math.abs(right.createdAt - submission.createdAt);
    return leftDistance - rightDistance || left.recordId.localeCompare(right.recordId);
  })[0];
}

function normalize(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .toUpperCase();
}
