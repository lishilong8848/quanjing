import {
  getDutyProgramModifiedRefreshWindow,
} from '../../server/modules/duty-schedule/duty-staff-actual-refresh-window';

describe('duty staff actual refresh window', () => {
  it('uses current Shanghai date through the next 15 days', () => {
    expect(
      getDutyProgramModifiedRefreshWindow(
        new Date('2026-06-01T00:10:00+08:00'),
      ),
    ).toEqual({
      startDate: '2026-06-01',
      endDate: '2026-06-16',
    });
  });
});
