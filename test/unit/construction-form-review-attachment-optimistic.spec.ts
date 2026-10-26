import { readFileSync } from 'fs';
import * as path from 'path';

type ManualReview = {
  id: string;
  decision: string;
};

type ManualReviewSettlementModule = {
  partitionManualReviewSettlements<T>(
    reviews: readonly T[],
    results: readonly PromiseSettledResult<unknown>[],
  ): {
    succeeded: T[];
    failed: T[];
  };
  retainPendingManualReviewItems<T extends { id: string }>(
    current: readonly T[],
    submitted: readonly T[],
    succeeded: readonly T[],
  ): T[];
};

function loadManualReviewSettlementModule(): ManualReviewSettlementModule {
  try {
    return require('../../client/src/pages/ConstructionManagement/manual-review-settlement') as ManualReviewSettlementModule;
  } catch {
    const missing = () => {
      throw new Error('manual-review-settlement helper is not implemented');
    };
    return {
      partitionManualReviewSettlements: missing,
      retainPendingManualReviewItems: missing,
    };
  }
}

describe('construction manual-review settlement behavior', () => {
  const settlement = loadManualReviewSettlementModule();

  it('keeps successful and failed review items independent', () => {
    const passed: ManualReview = { id: 'permit:a', decision: 'passed' };
    const failed: ManualReview = { id: 'permit:b', decision: 'rejected' };

    expect(
      settlement.partitionManualReviewSettlements(
        [passed, failed],
        [
          { status: 'fulfilled', value: undefined },
          { status: 'rejected', reason: new Error('network error') },
        ],
      ),
    ).toEqual({
      succeeded: [passed],
      failed: [failed],
    });
  });

  it('clears only the submitted successful snapshot and preserves a newer edit', () => {
    const submittedA: ManualReview = {
      id: 'permit:a',
      decision: 'passed',
    };
    const submittedB: ManualReview = {
      id: 'permit:b',
      decision: 'rejected',
    };
    const newerA: ManualReview = {
      id: 'permit:a',
      decision: 'rejected',
    };

    expect(
      settlement.retainPendingManualReviewItems(
        [newerA, submittedB],
        [submittedA, submittedB],
        [submittedA, submittedB],
      ),
    ).toEqual([newerA]);
  });
});

describe('construction form, review, and attachment optimistic wiring', () => {
  const source = readFileSync(
    path.resolve(
      __dirname,
      '../../client/src/pages/ConstructionManagement/index.tsx',
    ),
    'utf8',
  );
  const pageSource = source.slice(
    source.indexOf('export default function ConstructionManagementPage'),
    source.indexOf('function ConstructionPanoramaCard'),
  );
  const followupSubmitSource = pageSource.slice(
    pageSource.indexOf('const handleFollowupSubmit'),
    pageSource.indexOf('const handleGeneratedOnlineFormSubmit'),
  );
  const onlineSubmitSource = pageSource.slice(
    pageSource.indexOf('const handleGeneratedOnlineFormSubmit'),
    pageSource.indexOf('const handleDailyPermitUpload'),
  );
  const permitUploadSource = pageSource.slice(
    pageSource.indexOf('const handleDailyPermitUpload'),
    pageSource.indexOf('const handleRefreshConstructionBitableData'),
  );
  const manualSubmitSource = pageSource.slice(
    pageSource.indexOf('const handleSubmitPendingManualReviews'),
    pageSource.indexOf('const monitorConstructionProjectDeleteTask'),
  );
  const manualBatchSource = pageSource.slice(
    pageSource.indexOf('const submitPendingManualReviewBatchInBackground'),
    pageSource.indexOf(
      'useEffect(() =>',
      pageSource.indexOf('const submitPendingManualReviewBatchInBackground'),
    ),
  );
  const dialogSource = source.slice(
    source.indexOf('function FollowupDialog'),
    source.indexOf('function DailyWorkTypeAuditPanel'),
  );
  const generatedDialogCallbackSource = dialogSource.slice(
    dialogSource.indexOf('onGenerateFile={'),
    dialogSource.indexOf(
      'onOpenChange=',
      dialogSource.indexOf('onGenerateFile={'),
    ),
  );
  const optimisticGeneratedSubmitSource = dialogSource.slice(
    dialogSource.indexOf('const submitGeneratedOnlineFormOptimistically'),
    dialogSource.indexOf(
      'const removeExistingFile',
      dialogSource.indexOf('const submitGeneratedOnlineFormOptimistically'),
    ),
  );
  const attachmentDeleteSource = dialogSource.slice(
    dialogSource.indexOf('const removeExistingFile'),
    dialogSource.indexOf(
      'useEffect(() =>',
      dialogSource.indexOf('const removeExistingFile'),
    ),
  );
  const specialMaterialDialogSource = source.slice(
    source.indexOf('function SpecialWorkTypeMaterialDialog'),
    source.indexOf('function createSpecialOnlineWorkFormDraft'),
  );
  const specialGeneratedCallbackSource = specialMaterialDialogSource.slice(
    specialMaterialDialogSource.lastIndexOf('onGenerateFile={'),
    specialMaterialDialogSource.lastIndexOf('onOpenChange='),
  );

  it('shows and closes a generated online form before starting its background write', () => {
    const previewIndex = optimisticGeneratedSubmitSource.indexOf(
      'setGeneratedOnlineFormFiles',
    );
    const closeIndex = optimisticGeneratedSubmitSource.indexOf('closeDialog()');
    const requestIndex = optimisticGeneratedSubmitSource.indexOf(
      'onGeneratedFileSubmit(fieldKey, file)',
    );

    expect(optimisticGeneratedSubmitSource).toContain(
      'createConstructionClientMutationId()',
    );
    expect(previewIndex).toBeGreaterThanOrEqual(0);
    expect(closeIndex).toBeGreaterThan(previewIndex);
    expect(requestIndex).toBeGreaterThan(closeIndex);
    expect(optimisticGeneratedSubmitSource).toContain('void Promise.resolve(');
    expect(optimisticGeneratedSubmitSource).toContain(
      'rollbackGeneratedOnlineFormFile(',
    );
    expect(generatedDialogCallbackSource).toContain(
      'submitGeneratedOnlineFormOptimistically(',
    );
    expect(generatedDialogCallbackSource).not.toContain(
      'if (await onGeneratedFileSubmit',
    );
  });

  it('deduplicates online backfill per record and field and refreshes without OCR', () => {
    expect(onlineSubmitSource).toContain(
      'const mutationKey = `online-form:${selectedConstruction.recordId}:${latestTodayFollowup.recordId}:${fieldKey}`;',
    );
    expect(onlineSubmitSource).toContain(
      'inFlightMutationKeysRef.current.has(mutationKey)',
    );
    expect(onlineSubmitSource).toContain(
      'inFlightMutationKeysRef.current.add(mutationKey)',
    );
    expect(onlineSubmitSource).toContain(
      'inFlightMutationKeysRef.current.delete(mutationKey)',
    );
    expect(onlineSubmitSource).not.toContain('if (submitting)');
    expect(onlineSubmitSource).not.toContain('setSubmitting(');
    expect(onlineSubmitSource).toContain(
      'loadData({ background: true, forceRefresh: false })',
    );
    expect(onlineSubmitSource).not.toContain('loadData(true)');
  });

  it('keeps the online-form preview optimistic until its background task reaches a terminal state', () => {
    expect(onlineSubmitSource).toContain(
      'await monitorOptimisticConfirmation({',
    );
    expect(onlineSubmitSource).toContain(
      'taskId: result.taskId || result.retryTaskId',
    );
    expect(onlineSubmitSource).toContain('getSyncTaskStatus(taskId)');
    expect(onlineSubmitSource).toContain("confirmation.status === 'failed'");
    expect(onlineSubmitSource).toContain("confirmation.status === 'unknown'");
    expect(onlineSubmitSource).toContain("confirmation.status === 'cancelled'");
    expect(onlineSubmitSource).not.toContain('confirmAfterTaskReadErrors:');
    expect(onlineSubmitSource).toMatch(
      /confirmation\.status === 'failed'[\s\S]*return false;/,
    );
    expect(onlineSubmitSource).toMatch(
      /confirmation\.status === 'cancelled'[\s\S]*return false;/,
    );
    expect(
      onlineSubmitSource.indexOf("confirmation.status === 'cancelled'"),
    ).toBeLessThan(onlineSubmitSource.indexOf('toast.success('));
  });

  it('previews a generated special-work file without waiting for its backfill', () => {
    expect(specialGeneratedCallbackSource).toContain(
      'onGeneratedFileSubmit(fieldKey, file, () =>',
    );
    expect(specialGeneratedCallbackSource).toContain(
      'setOnlineFormTarget(null)',
    );
    expect(specialGeneratedCallbackSource).not.toContain(
      'if (await onGeneratedFileSubmit',
    );
    expect(dialogSource).toContain(
      'onGeneratedFileSubmit={submitGeneratedOnlineFormOptimistically}',
    );
  });

  it('stages a daily permit selection until the bottom submit action', () => {
    const localPreviewIndex = permitUploadSource.indexOf(
      'setFollowupFiles(nextFiles)',
    );

    expect(localPreviewIndex).toBeGreaterThanOrEqual(0);
    expect(permitUploadSource).toContain(
      'toast.success(`${verification.label}已选择，请提交作业票校核`)',
    );
    expect(permitUploadSource).not.toContain('handleFollowupSubmit');
    expect(permitUploadSource).not.toContain('setSubmitting(');
  });

  it('submits manual reviews in the background and settles each result separately', () => {
    expect(manualBatchSource).toContain('manualReviewSyncingIdsRef.current');
    expect(manualBatchSource).toContain('void (async () => {');
    expect(manualBatchSource).toContain('Promise.allSettled(');
    expect(manualBatchSource).toContain('settleScopedManualReviewBatch(');
    expect(manualBatchSource).toContain(
      'confirmScopedManualReviewBatch(current, succeeded, false)',
    );
    expect(manualBatchSource).toContain(
      'confirmPendingManualReviewSync(succeeded)',
    );
    expect(manualSubmitSource).toContain(
      'submitPendingManualReviewBatchInBackground(pendingManualReviews)',
    );
    expect(followupSubmitSource).toContain(
      'submitPendingManualReviewBatchInBackground(',
    );
    expect(manualSubmitSource).not.toContain('confirmPendingManualReviewSync');
    expect(manualSubmitSource).not.toContain('setSubmitting(');
    expect(manualSubmitSource).not.toContain('setManualReviewRefreshing(');
    expect(manualBatchSource).not.toContain('loadData(true)');
  });

  it('hides an attachment immediately, gates duplicate deletion, and rolls back only its token', () => {
    const localRemovalIndex = attachmentDeleteSource.indexOf(
      'applyLocalRemoval()',
    );
    const requestIndex = attachmentDeleteSource.indexOf(
      'deleteConstructionAttachment({',
    );

    expect(dialogSource).toContain('attachmentDeleteMutationKeysRef');
    expect(attachmentDeleteSource).toContain(
      'attachmentDeleteMutationKeysRef.current.has(mutationKey)',
    );
    expect(attachmentDeleteSource).toContain(
      'attachmentDeleteMutationKeysRef.current.add(mutationKey)',
    );
    expect(attachmentDeleteSource).toContain(
      'attachmentDeleteMutationKeysRef.current.delete(mutationKey)',
    );
    expect(localRemovalIndex).toBeGreaterThanOrEqual(0);
    expect(requestIndex).toBeGreaterThan(localRemovalIndex);
    expect(attachmentDeleteSource).toContain('rollbackLocalRemoval()');
    expect(attachmentDeleteSource).not.toContain('loadData(true)');
    expect(dialogSource).toMatch(
      /filterExistingFileMapByRemovedTokens\(\s*visibleExistingFiles\s*,\s*removedExistingFileTokens\s*,?/,
    );
  });

  it('uses ordinary reads after CRUD and reserves force refresh for the header audit action', () => {
    const manualConfirmationSource = pageSource.slice(
      pageSource.indexOf('const confirmPendingManualReviewSync'),
      pageSource.indexOf(
        'useEffect(() =>',
        pageSource.indexOf('const confirmPendingManualReviewSync'),
      ),
    );
    const explicitRefreshSource = pageSource.slice(
      pageSource.indexOf('const handleRefreshConstructionBitableData'),
      pageSource.indexOf('const handlePermitManualReviewRequest'),
    );
    const dailyProgressRefreshSource = pageSource.slice(
      pageSource.indexOf('const handleRefreshDailyProgress'),
      pageSource.indexOf('const handleStatusListOpen'),
    );
    const followupDialogUsageSource = pageSource.slice(
      pageSource.indexOf('<FollowupDialog'),
      pageSource.indexOf('<ConstructionDetailDialog'),
    );

    expect(manualConfirmationSource).toMatch(
      /loadData\(\{\s*background: true,\s*forceRefresh: false,?\s*\}\)/,
    );
    expect(manualConfirmationSource).not.toContain('loadData(true)');
    expect(followupDialogUsageSource).toMatch(
      /loadData\(\{\s*background: true,\s*forceRefresh: false,?\s*\}\)/,
    );
    expect(followupDialogUsageSource).toContain('.catch((err) =>');
    expect(followupDialogUsageSource).not.toContain(
      'onAttachmentDeleted={() => void loadData(true)}',
    );
    expect(explicitRefreshSource).toMatch(
      /loadData\(\{\s*background: true,\s*forceRefresh: false,?\s*\}\)/,
    );
    expect(explicitRefreshSource).not.toContain('loadData(true)');
    expect(dailyProgressRefreshSource).toMatch(
      /loadData\(\{\s*background: true,\s*forceRefresh: false,?\s*\}\)/,
    );
    expect(dailyProgressRefreshSource).not.toContain('loadData(true)');
    expect(onlineSubmitSource).not.toContain('loadData(true)');
    expect(manualSubmitSource).not.toContain('loadData(true)');
    expect(pageSource.match(/loadData\(true\)/g)).toHaveLength(1);
    expect(pageSource).toContain(
      'if (forceRefresh && forceRefreshInFlightRef.current)',
    );
  });

  it('handles every detached page refresh rejection', () => {
    const initialLoadSource = pageSource.slice(
      pageSource.indexOf('void loadData(false)'),
      pageSource.indexOf('const updateScopedPendingManualReviews'),
    );
    const applicationSource = pageSource.slice(
      pageSource.indexOf('const handleApplicationSubmit'),
      pageSource.indexOf('const handleFollowupSubmit'),
    );
    const terminationSource = pageSource.slice(
      pageSource.indexOf('const handleConfirmTerminateProject'),
      pageSource.indexOf('const openCrewRosterUploadDialog'),
    );
    const headerRefreshLabelIndex = pageSource.indexOf(
      'aria-label="补缺并刷新过期的施工管理视觉审核"',
    );
    const headerRefreshSource = pageSource.slice(
      pageSource.lastIndexOf('onClick={() =>', headerRefreshLabelIndex),
      headerRefreshLabelIndex + 100,
    );

    expect(initialLoadSource).toContain('.catch((err) =>');
    expect(applicationSource).toMatch(
      /requestBackgroundRefresh:[\s\S]*?void loadData\([\s\S]*?\.catch\(\(err\) =>/,
    );
    expect(terminationSource).toMatch(
      /requestBackgroundRefresh:[\s\S]*?void loadData\([\s\S]*?\.catch\(\(err\) =>/,
    );
    expect(headerRefreshSource).toContain('loadData(true).catch((err) =>');
  });
});
