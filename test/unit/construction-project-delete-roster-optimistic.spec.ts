import { readFileSync } from 'fs';
import * as path from 'path';

describe('construction project delete and crew-roster optimistic interactions', () => {
  const source = readFileSync(
    path.resolve(
      __dirname,
      '../../client/src/pages/ConstructionManagement/index.tsx',
    ),
    'utf8',
  );
  const deleteMonitorSource = source.slice(
    source.indexOf('const monitorConstructionProjectDeleteTask'),
    source.indexOf('const handleConfirmDeleteProject'),
  );
  const deleteSubmitSource = source.slice(
    source.indexOf('const handleConfirmDeleteProject'),
    source.indexOf('const handleConfirmTerminateProject'),
  );
  const rosterMonitorSource = source.slice(
    source.indexOf('const monitorCrewRosterUploadTask'),
    source.indexOf('const handleSubmitCrewRosterUpload'),
  );
  const rosterSubmitSource = source.slice(
    source.indexOf('const handleSubmitCrewRosterUpload'),
    source.indexOf('if (loading)'),
  );

  it('removes a confirmed project from the page before starting the server request', () => {
    expect(source).toContain('applyProjectTombstones');
    expect(deleteSubmitSource).toContain(
      'const mutationKey = `project:delete:${candidate.recordId}`;',
    );
    expect(deleteSubmitSource).toContain(
      'applyProjectTombstones(value, new Set([candidate.recordId]))',
    );
    expect(
      deleteSubmitSource.indexOf('setProjectDeleteCandidate(null)'),
    ).toBeLessThan(deleteSubmitSource.indexOf('deleteConstructionProject({'));
    expect(deleteSubmitSource.indexOf('updateConstructionData')).toBeLessThan(
      deleteSubmitSource.indexOf('deleteConstructionProject({'),
    );
  });

  it('keeps deletion scoped per project and restores only after an explicit failure', () => {
    expect(deleteSubmitSource).toContain(
      'inFlightMutationKeysRef.current.has(mutationKey)',
    );
    expect(deleteSubmitSource).toContain(
      'constructionMutationCoordinator.begin({',
    );
    expect(deleteSubmitSource).toContain('restoreDeletedProjectUiIfUntouched');
    expect(deleteSubmitSource).toContain(
      'monitorConstructionProjectDeleteTask',
    );
    expect(deleteMonitorSource).toContain("task.status === 'failed'");
    expect(deleteMonitorSource).toContain('onFailed(');
    expect(deleteMonitorSource).not.toContain(
      'toast.error(getErrorMessage(err',
    );
  });

  it('retries transient deletion-status reads and refreshes normally on completion', () => {
    expect(deleteMonitorSource).toContain('getSyncTaskStatus(taskId)');
    expect(deleteMonitorSource).toContain('continue;');
    expect(deleteMonitorSource).toContain("task.status === 'completed'");
    expect(deleteMonitorSource).toContain(
      'loadData({ background: true, forceRefresh: false })',
    );
    expect(deleteMonitorSource).toContain('onUnknown(');
    expect(source).not.toContain('CONSTRUCTION_DELETE_SYNC_DELAY_MS');
    expect(deleteSubmitSource).not.toContain('loadData(true)');
  });

  it('keeps an accepted deletion pending when local post-processing throws', () => {
    const acceptedCatchSource = deleteSubmitSource.slice(
      deleteSubmitSource.lastIndexOf('.catch((err) =>'),
    );

    expect(acceptedCatchSource).toContain('requestAccepted');
    expect(acceptedCatchSource).toContain('keepPendingConfirmation(');
    expect(acceptedCatchSource).toContain('rollbackExplicitFailure(');
    expect(deleteSubmitSource).toMatch(
      /monitorConstructionProjectDeleteTask\([\s\S]*?\)\.catch\(/,
    );
  });

  it('does not report completion when an accepted task has no task id', () => {
    expect(deleteSubmitSource).toContain('if (result.pending)');
    expect(deleteSubmitSource).toContain('keepPendingConfirmation(');
    expect(deleteSubmitSource).toContain(
      '项目删除已受理，但未返回后台任务编号',
    );
    expect(rosterSubmitSource).toContain('if (result.pending)');
    expect(rosterSubmitSource).toContain('leaveCrewRosterSyncUnknown(');
    expect(rosterSubmitSource).toContain(
      '人员名单已受理，但未返回后台任务编号',
    );
  });

  it('always settles an unknown deletion refresh as confirmed or timeout-bound', () => {
    const pendingRefreshSource = deleteSubmitSource.slice(
      deleteSubmitSource.indexOf('const keepPendingConfirmation'),
      deleteSubmitSource.indexOf('const completeDeletion'),
    );

    expect(pendingRefreshSource).toContain(
      'constructionMutationCoordinator.has(overlayKey)',
    );
    expect(pendingRefreshSource).toContain(
      'scheduleOptimisticConfirmationTimeout(',
    );
    expect(pendingRefreshSource).toContain('项目删除已由服务器数据确认完成');
    expect(pendingRefreshSource).toContain('.catch(');
  });

  it('cleans up when a no-task-id completion refresh rejects', () => {
    const deleteNoTaskSource = deleteSubmitSource.slice(
      deleteSubmitSource.lastIndexOf('if (result.pending)'),
      deleteSubmitSource.lastIndexOf('.catch((err) =>'),
    );
    const rosterNoTaskSource = rosterSubmitSource.slice(
      rosterSubmitSource.lastIndexOf('if (result.pending)'),
      rosterSubmitSource.lastIndexOf('.catch((err) =>'),
    );

    expect(deleteNoTaskSource).toMatch(
      /\.catch\(\(err\) =>\s*keepPendingConfirmation\(/,
    );
    expect(rosterNoTaskSource).toMatch(
      /\.catch\(\(err\) =>\s*leaveCrewRosterSyncUnknown\(/,
    );
  });

  it('closes a valid crew-roster draft before starting its server request', () => {
    expect(rosterSubmitSource).toContain(
      'const mutationKey = `crew-roster:upload:${item.recordId}`;',
    );
    expect(rosterSubmitSource).toContain(
      'inFlightMutationKeysRef.current.has(mutationKey)',
    );
    expect(rosterSubmitSource).toContain(
      'const submittedDraft: CrewRosterUploadDraft =',
    );
    expect(
      rosterSubmitSource.indexOf('closeCrewRosterUploadDialog()'),
    ).toBeLessThan(
      rosterSubmitSource.indexOf(
        'syncConstructionCrewRosterFromUpload(formData)',
      ),
    );
  });

  it('does not overwrite a newer roster draft when an older request fails', () => {
    expect(source).toContain('crewRosterUploadSessionId');
    expect(source).toContain('failedCrewRosterUploadDraftsRef');
    expect(rosterSubmitSource).toContain(
      'restoreCrewRosterUploadDraftIfUntouched(submittedDraft)',
    );
    expect(rosterSubmitSource).toContain(
      'crewRosterSyncingRecordIdsRef.current.add(item.recordId)',
    );
    expect(rosterSubmitSource).toContain(
      'crewRosterSyncingRecordIdsRef.current.delete(item.recordId)',
    );
  });

  it('retries roster-status reads, refreshes normally, and treats timeout as unknown', () => {
    expect(rosterMonitorSource).toContain('getSyncTaskStatus(taskId)');
    expect(rosterMonitorSource).toContain('continue;');
    expect(rosterMonitorSource).toContain("task.status === 'completed'");
    expect(rosterMonitorSource).toContain(
      'loadData({ background: true, forceRefresh: false })',
    );
    expect(rosterMonitorSource).toContain("task.status === 'failed'");
    expect(rosterMonitorSource).toContain('onFailed(');
    expect(rosterMonitorSource).toContain('onUnknown(');
    expect(rosterMonitorSource).not.toContain('loadData(true)');
  });

  it('contains accepted roster-monitor callback errors without restoring the draft', () => {
    expect(rosterSubmitSource).toMatch(
      /monitorCrewRosterUploadTask\([\s\S]*?\)\.catch\(/,
    );
    const acceptedCatchSource = rosterSubmitSource.slice(
      rosterSubmitSource.lastIndexOf('.catch((err) =>'),
    );

    expect(acceptedCatchSource).toContain('serverWriteAccepted');
    expect(acceptedCatchSource).toContain('leaveCrewRosterSyncUnknown(');
  });
});
