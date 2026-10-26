import {
  getDueDailyOperationsPatrolRun,
  getNextDailyOperationsPatrolRun,
} from './daily-operations-patrol.scheduler';

describe('daily operations patrol schedule', () => {
  it.each([
    ['2026-09-07T01:29:59.999Z', false],
    ['2026-09-07T01:30:00.000Z', true],
    ['2026-09-07T01:59:59.999Z', true],
    ['2026-09-07T02:00:00.000Z', false],
  ])('resolves the 09:30-10:00 Shanghai due window at %s', (value, due) => {
    const run = getDueDailyOperationsPatrolRun(new Date(value));

    expect(Boolean(run)).toBe(due);
    if (run) {
      expect(run.businessDate).toBe('2026-09-07');
      expect(run.scheduledAt.toISOString()).toBe('2026-09-07T01:30:00.000Z');
    }
  });

  it('always schedules the next exact 09:30 Shanghai run', () => {
    expect(
      getNextDailyOperationsPatrolRun(
        new Date('2026-09-07T01:29:59.999Z'),
      ).scheduledAt.toISOString(),
    ).toBe('2026-09-07T01:30:00.000Z');
    expect(
      getNextDailyOperationsPatrolRun(
        new Date('2026-09-07T01:30:00.000Z'),
      ).scheduledAt.toISOString(),
    ).toBe('2026-09-08T01:30:00.000Z');
  });
});
