import type { ChangeInfo } from '../../shared/api.interface';
import {
  applyPendingChangeAdjustment,
  createChangeAdjustmentDraftForRecord,
  getChangeAdjustmentLifecycle,
  listAdjustableChanges,
} from '../../client/src/pages/MonthlySchedule/change-adjustment-state';

function change(overrides: Partial<ChangeInfo> = {}): ChangeInfo {
  return {
    id: 'rec-1',
    bitableRecordId: 'rec-1',
    title: 'UPS 维护',
    startDate: '2026-08-10T09:00',
    endDate: '2026-08-10T18:00',
    actualStartDate: null,
    actualEndDate: null,
    plannedDelayStartDate: null,
    plannedDelayEndDate: null,
    level: '低',
    type: '计划性变更',
    progress: '未开始',
    executor: null,
    buildings: ['A楼'],
    riskSummary: null,
    isKey: false,
    createdAt: '2026-08-09T00:00:00.000Z',
    updatedAt: '2026-08-09T01:00:00.000Z',
    adjustmentUpdatedAt: '2026-08-09T00:59:59.000Z',
    planDocuments: [
      {
        fileToken: 'old-token',
        name: '旧方案.pdf',
        url: '/api/duty-schedules/change-attachments/old/download',
      },
    ],
    ...overrides,
  };
}

describe('monthly schedule change adjustment state', () => {
  const before = new Date('2026-08-09T12:00:00+08:00');
  const during = new Date('2026-08-10T12:00:00+08:00');

  it('uses delayed dates and actual timestamps to derive lifecycle', () => {
    expect(getChangeAdjustmentLifecycle(change(), before)).toBe('not-started');
    expect(getChangeAdjustmentLifecycle(change(), during)).toBe('in-progress');
    expect(
      getChangeAdjustmentLifecycle(
        change({
          actualStartDate: '2026-08-10T09:00:00+08:00',
          actualEndDate: '2026-08-10T17:30:00+08:00',
        }),
        before,
      ),
    ).toBe('finished');
    expect(
      getChangeAdjustmentLifecycle(
        change({
          plannedDelayStartDate: '2026-08-11T09:00',
          plannedDelayEndDate: '2026-08-11T18:00',
        }),
        during,
      ),
    ).toBe('not-started');
  });

  it('keeps an actually started change in progress after its planned end', () => {
    expect(
      getChangeAdjustmentLifecycle(
        change({
          actualStartDate: '2026-08-10T09:15:00+08:00',
          actualEndDate: null,
        }),
        new Date('2026-08-11T09:00:00+08:00'),
      ),
    ).toBe('in-progress');
  });

  it('only lists not-started and in-progress records', () => {
    const finished = change({
      id: 'finished',
      bitableRecordId: 'finished',
      actualEndDate: '2026-08-08T18:00:00+08:00',
    });
    expect(listAdjustableChanges([change(), finished], before)).toEqual([
      change(),
    ]);
  });

  it('locks the start date for an in-progress adjustment draft', () => {
    const draft = createChangeAdjustmentDraftForRecord(change(), during);

    expect(draft.lifecycleStatus).toBe('in-progress');
    expect(draft.request.plannedDelayStartDate).toBeNull();
    expect(draft.request.plannedDelayEndDate).toBe('2026-08-10T18:00');
    expect(draft.request.retainedDocumentTokens).toEqual(['old-token']);
    expect(draft.request.removedDocumentTokens).toEqual([]);
    expect(draft.request.expectedUpdatedAt).toBe(
      '2026-08-09T00:59:59.000Z',
    );
  });

  it('does not use a display fallback timestamp as an optimistic-lock version', () => {
    const draft = createChangeAdjustmentDraftForRecord(
      change({ adjustmentUpdatedAt: null }),
      before,
    );

    expect(draft.request.expectedUpdatedAt).toBe('');
  });

  it('creates an immediate pending overlay without mutating the source', () => {
    const original = change();
    const prepared = createChangeAdjustmentDraftForRecord(original, before);
    const request = {
      ...prepared.request,
      clientMutationId:
        'change-adjustment-123e4567-e89b-42d3-a456-426614174000',
      plannedDelayStartDate: '2026-08-11T09:00',
      plannedDelayEndDate: '2026-08-11T20:00',
      reason: '等待备件',
    };

    const pending = applyPendingChangeAdjustment(
      original,
      request,
      '2026-08-09T02:00:00.000Z',
    );

    expect(original.plannedDelayStartDate).toBeNull();
    expect(pending).toMatchObject({
      plannedDelayStartDate: '2026-08-11T09:00',
      plannedDelayEndDate: '2026-08-11T20:00',
      delayReason: '等待备件',
      progress: '调整同步中',
      updatedAt: '2026-08-09T02:00:00.000Z',
    });
  });
});
