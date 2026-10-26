import { rackLoadRows } from '../../client/src/pages/MonthlyOperations/resource-model';
import type { MonthlyOperationsResourcesResponse } from '../../shared/monthly-operations-resources.interface';

describe('rack and IT load comparison', () => {
  const data = {
    racks: {
      rows: [
        {
          building: 'A楼',
          date: '2026-09-24',
          capacity: 988,
          online: 970,
          rate: 98.2,
        },
        {
          building: 'B楼',
          date: '2026-09-24',
          capacity: 1076,
          online: 1022,
          rate: 95.0,
        },
        {
          building: 'C楼',
          date: '2026-09-24',
          capacity: 998,
          online: 970,
          rate: 97.2,
        },
      ],
    },
    load: {
      rows: [
        { building: 'B楼', value: 72.5 },
        { building: 'A楼', value: 0 },
      ],
    },
  } as MonthlyOperationsResourcesResponse;

  it('matches IT load by building without confusing zero with missing data', () => {
    expect(rackLoadRows(data, 'all')).toEqual([
      expect.objectContaining({ building: 'A楼', loadRate: 0 }),
      expect.objectContaining({ building: 'B楼', loadRate: 72.5 }),
      expect.objectContaining({ building: 'C楼', loadRate: null }),
    ]);
  });

  it('respects the selected building', () => {
    expect(rackLoadRows(data, 'B楼')).toEqual([
      expect.objectContaining({ building: 'B楼', loadRate: 72.5 }),
    ]);
  });
});
