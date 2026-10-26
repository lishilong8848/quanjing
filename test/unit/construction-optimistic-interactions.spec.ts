import { readFileSync } from 'fs';
import * as path from 'path';

import {
  createTemporaryConstructionProject,
  dequeueFailedApplicationDraft,
  getTerminationUiRestoreDecisions,
  isOptimisticConstructionRecordId,
  preserveAcceptedOptimisticMutationOnConfirmationTimeout,
  resolveFailedApplicationDraft,
  settleAcceptedOptimisticMutation,
} from '../../client/src/pages/ConstructionManagement/optimistic-crud';
import { createConstructionMutationCoordinator } from '../../client/src/pages/ConstructionManagement/mutation-coordinator';

describe('construction optimistic interaction state', () => {
  it('keeps a late failed A draft queued without replacing active session B', () => {
    const failedA = {
      sessionId: 1,
      form: { workContent: 'A' },
      files: { roster: ['a.xlsx'] },
    };

    const failure = resolveFailedApplicationDraft(2, [], failedA);

    expect(failure.autoRestore).toBeNull();
    expect(failure.failedDrafts).toEqual([failedA]);

    const next = dequeueFailedApplicationDraft(failure.failedDrafts);
    expect(next.draft).toBe(failedA);
    expect(next.remaining).toEqual([]);
  });

  it('auto-restores a failed draft only while its own session remains current', () => {
    const failedA = {
      sessionId: 1,
      form: { workContent: 'A' },
      files: {},
    };

    const failure = resolveFailedApplicationDraft(1, [], failedA);

    expect(failure.autoRestore).toBe(failedA);
    expect(failure.failedDrafts).toEqual([]);
  });

  it('allows separate application sessions to keep two temporary layers', () => {
    const coordinator = createConstructionMutationCoordinator<{
      recordIds: string[];
    }>();
    const a = createTemporaryConstructionProject({
      mutationId: 'a',
      workContent: 'A',
      workTypes: [],
      planStartTime: '2026-07-24T08:00',
      planEndTime: '2026-07-24T09:00',
    });
    const b = createTemporaryConstructionProject({
      mutationId: 'b',
      workContent: 'B',
      workTypes: [],
      planStartTime: '2026-07-24T10:00',
      planEndTime: '2026-07-24T11:00',
    });

    expect(
      coordinator.begin({
        key: 'application:create:1:a',
        apply: (value) => ({
          recordIds: [...value.recordIds, a.recordId],
        }),
        matches: () => false,
      }),
    ).toBe(true);
    expect(
      coordinator.begin({
        key: 'application:create:2:b',
        apply: (value) => ({
          recordIds: [...value.recordIds, b.recordId],
        }),
        matches: () => false,
      }),
    ).toBe(true);
    expect(coordinator.applyPending({ recordIds: [] }).recordIds).toEqual([
      'optimistic:a',
      'optimistic:b',
    ]);
  });

  it('recognizes only local optimistic construction record ids', () => {
    expect(isOptimisticConstructionRecordId('optimistic:application-a')).toBe(
      true,
    );
    expect(isOptimisticConstructionRecordId('rec-real')).toBe(false);
    expect(isOptimisticConstructionRecordId(null)).toBe(false);
  });

  it('does not restore stale termination detail or follow-up over newer UI', () => {
    const decisions = getTerminationUiRestoreDecisions({
      targetRecordId: 'project-a',
      changed: {
        removedExpanded: true,
        clearedSelected: true,
        removedListItem: true,
        closedFollowup: true,
        clearedCandidate: true,
      },
      originalListIdentity: 'daily:prepare',
      current: {
        expandedHasTarget: false,
        selectedRecordId: 'project-b',
        listIdentity: 'daily:prepare',
        listHasTarget: false,
        listOperationOwned: true,
        followupOpen: true,
        followupPristine: false,
        candidateRecordId: 'project-c',
      },
    });

    expect(decisions).toEqual({
      restoreExpanded: true,
      restoreSelected: false,
      restoreListItem: true,
      restoreFollowup: false,
      restoreCandidate: false,
    });
  });

  it('releases accepted mutations and removes an overlay when no confirmation timer exists', () => {
    const calls: string[] = [];

    const recovered = settleAcceptedOptimisticMutation({
      confirmationScheduled: false,
      releaseGate: () => calls.push('release'),
      finishOverlay: () => calls.push('finish'),
      requestBackgroundRefresh: () => calls.push('refresh'),
      notifyResync: () => calls.push('notify'),
    });

    expect(recovered).toBe(true);
    expect(calls).toEqual(['release', 'finish', 'refresh', 'notify']);
  });

  it('only releases the gate when an accepted mutation already has a confirmation timer', () => {
    const calls: string[] = [];

    const recovered = settleAcceptedOptimisticMutation({
      confirmationScheduled: true,
      releaseGate: () => calls.push('release'),
      finishOverlay: () => calls.push('finish'),
      requestBackgroundRefresh: () => calls.push('refresh'),
      notifyResync: () => calls.push('notify'),
    });

    expect(recovered).toBe(false);
    expect(calls).toEqual(['release']);
  });

  it('preserves an accepted optimistic mutation when authoritative confirmation is delayed', () => {
    const calls: string[] = [];

    const preserved =
      preserveAcceptedOptimisticMutationOnConfirmationTimeout({
        isPending: () => true,
        notifyDelayed: () => calls.push('notify'),
      });

    expect(preserved).toBe(true);
    expect(calls).toEqual(['notify']);
  });

  it('does nothing when a delayed confirmation timer fires after the mutation already settled', () => {
    const notifyDelayed = jest.fn();

    const preserved =
      preserveAcceptedOptimisticMutationOnConfirmationTimeout({
        isPending: () => false,
        notifyDelayed,
      });

    expect(preserved).toBe(false);
    expect(notifyDelayed).not.toHaveBeenCalled();
  });
});

describe('construction optimistic interaction wiring', () => {
  const source = readFileSync(
    path.resolve(
      __dirname,
      '../../client/src/pages/ConstructionManagement/index.tsx',
    ),
    'utf8',
  );

  it('uses an application session gate and queues stale-session failures', () => {
    const submitSource = source.slice(
      source.indexOf('const handleApplicationSubmit'),
      source.indexOf('const handleFollowupSubmit'),
    );
    const newApplicationSource = source.slice(
      source.indexOf("requireConstructionEdit('新建施工')"),
      source.indexOf('施工跟进', source.indexOf("requireConstructionEdit('新建施工')")),
    );

    expect(submitSource).toContain('applicationSessionId');
    expect(submitSource).toContain(
      'const mutationKey = `application:create:${applicationSessionId}`;',
    );
    expect(submitSource).toContain('resolveFailedApplicationDraft(');
    expect(submitSource).toContain('failedApplicationDraftsRef.current');
    expect(newApplicationSource).toContain('dequeueFailedApplicationDraft(');
    expect(newApplicationSource).toContain('setApplicationSessionId(');
    expect(newApplicationSource).toContain('if (queued.draft)');
    expect(newApplicationSource).toContain(
      "toast.info('已恢复较早同步失败的施工申请草稿')",
    );
  });

  it('submits supplemental follow-ups optimistically and isolates stale dialog failures', () => {
    const submitSource = source.slice(
      source.indexOf('const handleFollowupSubmit'),
      source.indexOf('const handleGeneratedOnlineFormSubmit'),
    );
    const pageSource = source.slice(
      source.indexOf('export default function ConstructionManagementPage'),
      source.indexOf('function ConstructionPanoramaCard'),
    );

    expect(pageSource).toContain('followupSessionSequenceRef');
    expect(pageSource).toContain('activeFollowupSessionIdRef');
    expect(pageSource).toContain('failedFollowupDraftsRef');
    expect(pageSource).toContain('beginFollowupDialogSession(');
    expect(submitSource).toContain("followupForm.followupMode === 'supplemental'");
    expect(submitSource).toContain('supplementalOptimisticPatch');
    expect(submitSource).toContain('supplementalProjectPatch');
    expect(submitSource).toContain('constructionMutationCoordinator.begin({');
    expect(submitSource).toContain(
      "formData.append('clientMutationId', clientMutationId)",
    );
    expect(submitSource).toContain('resolveFailedApplicationDraft(');
    expect(submitSource).toContain('failedFollowupDraftsRef.current');
    expect(submitSource).toContain('failure.autoRestore');
    expect(submitSource).toMatch(
      /rebaseVisibleConstructionData\(\s*optimisticSnapshot,\s*optimisticProjectSnapshot,\s*\)/,
    );

    const optimisticCloseIndex = submitSource.indexOf(
      "toast.success('页面已更新，多维表同步中')",
    );
    const backgroundRequestIndex = submitSource.indexOf(
      'createConstructionFollowup(formData)',
      optimisticCloseIndex,
    );
    expect(optimisticCloseIndex).toBeGreaterThan(-1);
    expect(backgroundRequestIndex).toBeGreaterThan(optimisticCloseIndex);
    expect(submitSource.slice(0, backgroundRequestIndex)).toContain(
      'setFollowupOpen(false)',
    );
    expect(submitSource).not.toContain(
      'const result = await createConstructionFollowup(formData);',
    );
  });

  it('polls accepted follow-up background tasks and rolls back only explicit failures', () => {
    const submitSource = source.slice(
      source.indexOf('const handleFollowupSubmit'),
      source.indexOf('const handleGeneratedOnlineFormSubmit'),
    );
    const monitorSource = source.slice(
      source.indexOf('const monitorAcceptedFollowupMutation'),
      source.indexOf(
        'useEffect(() =>',
        source.indexOf('const monitorAcceptedFollowupMutation'),
      ),
    );

    expect(source).toContain(
      "import { monitorOptimisticConfirmation } from './optimistic-confirmation';",
    );
    expect(submitSource).toContain('monitorAcceptedFollowupMutation({');
    expect(submitSource).toContain(
      'taskId: result.taskId || result.retryTaskId',
    );
    expect(submitSource).not.toContain(
      'scheduleOptimisticConfirmationTimeout(',
    );
    expect(monitorSource).toContain('getSyncTaskStatus(taskId)');
    expect(monitorSource).toContain('forceRefresh: false');
    expect(monitorSource).toContain('confirmAfterTaskReadErrors: 2');
    expect(monitorSource).toContain("result.status === 'failed'");
    expect(monitorSource).toContain("result.status === 'unknown'");
    expect(monitorSource).toContain('rebaseVisibleConstructionData(');
    expect(monitorSource).toContain('restoreDraft?.()');
  });

  it('guards temporary projects in handlers and renders their cards as syncing', () => {
    const pageSource = source.slice(
      source.indexOf('export default function ConstructionManagementPage'),
      source.indexOf('function ConstructionPanoramaCard'),
    );
    const cardSource = source.slice(
      source.indexOf('function ConstructionCard'),
      source.indexOf('type ProjectCalendarDayStatus'),
    );

    expect(pageSource).toContain(
      'isOptimisticConstructionRecordId(item.recordId)',
    );
    expect(pageSource).toContain(
      'isOptimisticConstructionRecordId(candidate.recordId)',
    );
    expect(cardSource).toContain('const optimisticSyncing =');
    expect(cardSource).toContain('多维表同步中');
    expect(cardSource).toContain('const effectiveReadOnly =');
    expect(cardSource).toContain('!optimisticSyncing && (');
  });

  it('restores termination UI only on explicit failure and preserves accepted state on confirmation delay', () => {
    const timeoutSource = source.slice(
      source.indexOf('const scheduleOptimisticConfirmationTimeout'),
      source.indexOf('useEffect(() =>', source.indexOf('const scheduleOptimisticConfirmationTimeout')),
    );
    const terminateSource = source.slice(
      source.indexOf('const handleConfirmTerminateProject'),
      source.indexOf('const openCrewRosterUploadDialog'),
    );

    expect(timeoutSource).toContain(
      'preserveAcceptedOptimisticMutationOnConfirmationTimeout({',
    );
    expect(timeoutSource).not.toContain(
      'constructionMutationCoordinatorRef.current.finish(overlayKey)',
    );
    expect(timeoutSource).not.toContain('rebaseVisibleConstructionData(');
    expect(terminateSource).toContain('restoreTerminationUiIfUntouched');
    expect(terminateSource).toContain('getTerminationUiRestoreDecisions(');
    expect(terminateSource).toContain(
      'scheduleOptimisticConfirmationTimeout(overlayKey)',
    );
    expect(terminateSource).not.toContain(
      'setSelectedConstruction(uiContext.selectedConstruction)',
    );
    expect(
      terminateSource.indexOf('setFollowupForm(uiContext.followup.form)'),
    ).toBeGreaterThan(
      terminateSource.indexOf('if (decisions.restoreFollowup)'),
    );
  });

  it('settles accepted application and termination overlays from finally blocks', () => {
    const applicationSource = source.slice(
      source.indexOf('const handleApplicationSubmit'),
      source.indexOf('const handleFollowupSubmit'),
    );
    const terminateSource = source.slice(
      source.indexOf('const handleConfirmTerminateProject'),
      source.indexOf('const openCrewRosterUploadDialog'),
    );

    for (const handlerSource of [applicationSource, terminateSource]) {
      expect(handlerSource).toContain('let confirmationScheduled = false;');
      expect(handlerSource).toContain('confirmationScheduled = true;');
      expect(handlerSource).toContain('finally {');
      expect(handlerSource).toContain('settleAcceptedOptimisticMutation({');
      expect(handlerSource).toContain(
        '服务器已保存，页面正在重新同步',
      );
    }
  });
});
