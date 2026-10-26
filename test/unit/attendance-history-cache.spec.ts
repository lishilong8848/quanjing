jest.mock(
  '@/api/attendance-history',
  () => ({
    getAttendanceHistory: jest.fn(),
  }),
  { virtual: true },
);

import { getAttendanceHistory } from '@/api/attendance-history';
import { prefetchAttendanceHistory } from '../../client/src/components/attendance/use-attendance-history';

describe('attendance history client cache', () => {
  it('warms once and reuses the same range without another request', async () => {
    const response = {
      startDate: '2026-09-01',
      endDate: '2026-09-19',
      fetchedAt: '2026-09-19 16:39',
      checkedCount: 2055,
      anomalyCount: 3,
      abnormalPeople: 3,
      affectedBuildings: 3,
      correctedCount: 4,
      items: [],
      categoryBreakdown: [],
      personRanking: [],
      buildingRanking: [],
    };
    jest.mocked(getAttendanceHistory).mockResolvedValue(response);
    const range = { from: '2026-09-01', through: '2026-09-19' };

    await Promise.all([
      prefetchAttendanceHistory(range),
      prefetchAttendanceHistory(range),
    ]);
    await expect(prefetchAttendanceHistory(range)).resolves.toBe(response);

    expect(getAttendanceHistory).toHaveBeenCalledTimes(1);
  });
});
