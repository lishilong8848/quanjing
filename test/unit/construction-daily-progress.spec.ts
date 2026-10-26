import {
  getDailyProgressCandidateItems,
  getDailyProgressReferenceDate,
  getDailyPrepareEvidence,
  getDailyProgressStagePrimaryMetric,
  groupDailyProgressItems,
  isDailyFollowupOnDate,
  isInitialApplicationFollowupByEvidence,
  type DailyFollowupStageProgress,
} from '../../client/src/pages/ConstructionManagement/daily-progress';

describe('construction daily progress grouping', () => {
  it('includes projects with today daily followups even before planned start', () => {
    const items = [
      { id: 'scheduled-active', active: true, hasTodayDailyFollowup: false },
      { id: 'early-prepared', active: false, hasTodayDailyFollowup: true },
      { id: 'future-idle', active: false, hasTodayDailyFollowup: false },
    ];

    const candidates = getDailyProgressCandidateItems(
      items,
      (item) => item.active,
      (item) => item.hasTodayDailyFollowup,
    );

    expect(candidates.map((item) => item.id)).toEqual([
      'scheduled-active',
      'early-prepared',
    ]);
  });

  it('uses the server generated date as the daily progress reference date', () => {
    const referenceDate = getDailyProgressReferenceDate(
      '2026-06-04T01:20:38.107Z',
      new Date('2026-06-03T18:00:00+08:00'),
    );

    expect(referenceDate.toISOString()).toBe(
      new Date('2026-06-04T00:00:00+08:00').toISOString(),
    );
  });

  it('shows completed close count as the primary metric', () => {
    expect(
      getDailyProgressStagePrimaryMetric('prepare', { done: 1, pending: 2 }),
    ).toEqual({ value: 2, label: '待跟进' });
    expect(
      getDailyProgressStagePrimaryMetric('process', { done: 1, pending: 2 }),
    ).toEqual({ value: 2, label: '待跟进' });
    expect(
      getDailyProgressStagePrimaryMetric('close', { done: 1, pending: 0 }),
    ).toEqual({ value: 1, label: '已完成' });
  });

  it('does not count yesterday daily followup as today when it was only updated today', () => {
    const followup = {
      createdAt: '2026-06-02T09:00:00+08:00',
      updatedAt: '2026-06-03T09:00:00+08:00',
    };

    expect(
      isDailyFollowupOnDate(followup, new Date('2026-06-03T10:00:00+08:00')),
    ).toBe(false);
    expect(
      isDailyFollowupOnDate(followup, new Date('2026-06-02T10:00:00+08:00')),
    ).toBe(true);
  });

  it('uses the explicit follow-up date before record creation time', () => {
    const followup = {
      followupDate: '2026-06-05',
      createdAt: '2026-06-04T09:00:00+08:00',
      updatedAt: '2026-06-04T10:00:00+08:00',
    };

    expect(
      isDailyFollowupOnDate(followup, new Date('2026-06-05T10:00:00+08:00')),
    ).toBe(true);
    expect(
      isDailyFollowupOnDate(followup, new Date('2026-06-04T10:00:00+08:00')),
    ).toBe(false);
  });

  it('ignores historical isolation AI feedback as prepare evidence by default', () => {
    const evidence = getDailyPrepareEvidence([
      {
        dailyPersonnelCheck: 'checked',
        isolationFeedback: 'audit result',
        hasIsolationAttachment: false,
      },
    ]);

    expect(evidence.hasPersonnelCheck).toBe(true);
    expect(evidence.hasIsolationTrace).toBe(false);
  });

  it('uses isolation AI feedback as prepare evidence only when explicitly enabled', () => {
    const evidence = getDailyPrepareEvidence(
      [
        {
          isolationFeedback: 'audit result',
          hasIsolationAttachment: false,
        },
      ],
      true,
    );

    expect(evidence.hasIsolationTrace).toBe(true);
  });

  it('counts the generated daily personnel checklist attachment as personnel check evidence', () => {
    const evidence = getDailyPrepareEvidence([
      {
        dailyPersonnelCheck: '',
        hasDailyPersonnelChecklist: true,
        hasIsolationAttachment: true,
      },
    ]);

    expect(evidence.hasPersonnelCheck).toBe(true);
    expect(evidence.hasIsolationTrace).toBe(true);
  });

  it('does not classify daily followup with daily evidence as initial application', () => {
    expect(
      isInitialApplicationFollowupByEvidence({
        hasInitialApplicationFiles: true,
        hasDailySignals: true,
        workTypes: ['hot-work'],
      }),
    ).toBe(false);
  });

  it('assigns each project to only one current daily stage', () => {
    const project = {
      id: 'project-a',
      startedAt: 1,
      progress: {
        prepare: false,
        process: false,
        processEvidence: false,
        close: false,
      } satisfies DailyFollowupStageProgress,
    };

    const grouped = groupDailyProgressItems(
      [project],
      (item) => item.progress,
      (item) => item.startedAt,
    );

    expect(grouped.prepare).toEqual([project]);
    expect(grouped.process).toEqual([]);
    expect(grouped.close).toEqual([]);
    expect(
      grouped.prepare.length + grouped.process.length + grouped.close.length,
    ).toBe(1);
  });

  it('keeps projects in process until daily close is completed', () => {
    const projects = [
      {
        id: 'prepare',
        startedAt: 3,
        progress: {
          prepare: false,
          process: false,
          processEvidence: false,
          close: false,
        },
      },
      {
        id: 'process',
        startedAt: 2,
        progress: {
          prepare: true,
          process: false,
          processEvidence: false,
          close: false,
        },
      },
      {
        id: 'process-with-photo',
        startedAt: 1,
        progress: {
          prepare: true,
          process: false,
          processEvidence: true,
          close: false,
        },
      },
      {
        id: 'close-done',
        startedAt: 4,
        progress: {
          prepare: true,
          process: true,
          processEvidence: true,
          close: true,
        },
      },
    ] satisfies Array<{
      id: string;
      startedAt: number;
      progress: DailyFollowupStageProgress;
    }>;

    const grouped = groupDailyProgressItems(
      projects,
      (item) => item.progress,
      (item) => item.startedAt,
    );

    expect(grouped.prepare.map((item) => item.id)).toEqual(['prepare']);
    expect(grouped.process.map((item) => item.id)).toEqual([
      'process-with-photo',
      'process',
    ]);
    expect(grouped.close.map((item) => item.id)).toEqual(['close-done']);
  });
});
