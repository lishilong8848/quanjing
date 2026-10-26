import * as scheduler from '../../server/modules/contract-management/contract-workflow.scheduler';

describe('contract workflow scheduler', () => {
  it('schedules the contract-expiry reminder for every Monday at 09:30 Shanghai time', () => {
    const definition = scheduler.CONTRACT_WORKFLOW_DEFINITIONS.find(
      (item) => item.code === 'contract_expiry_reminder',
    );
    const nextWeeklyRunAt = (
      scheduler as unknown as {
        nextShanghaiWeeklyRunAt?: (
          now: Date,
          weekday: number,
          hour: number,
          minute: number,
        ) => Date;
      }
    ).nextShanghaiWeeklyRunAt;

    expect(definition).toMatchObject({ scheduleLabel: '每周一 09:30' });
    expect(nextWeeklyRunAt).toBeDefined();
    expect(
      nextWeeklyRunAt?.(
        new Date('2026-07-12T00:00:00.000Z'),
        1,
        9,
        30,
      ).toISOString(),
    ).toBe('2026-07-13T01:30:00.000Z');
    expect(
      nextWeeklyRunAt?.(
        new Date('2026-07-13T01:30:00.000Z'),
        1,
        9,
        30,
      ).toISOString(),
    ).toBe('2026-07-20T01:30:00.000Z');
  });
});
