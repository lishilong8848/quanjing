jest.mock(
  '@lark-apaas/client-toolkit/logger',
  () => ({ logger: { error: jest.fn() } }),
  { virtual: true },
);

jest.mock(
  '@lark-apaas/client-toolkit/utils/getAxiosForBackend',
  () => ({ axiosForBackend: jest.fn() }),
  { virtual: true },
);

import { axiosForBackend } from '@lark-apaas/client-toolkit/utils/getAxiosForBackend';
import { getAliMonthlyQualityDataset } from '../../client/src/api';

describe('Ali monthly quality API compatibility adapter', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('fills personnel defaults when an older backend omits the new fields', async () => {
    (axiosForBackend as jest.Mock).mockResolvedValue({
      data: {
        issues: [
          {
            id: 'legacy-issue',
            month: '7月',
            building: 'A楼',
            item: '值班纪律',
            issue: '人员睡岗',
            supplemental: '',
            attachments: [],
            images: [],
          },
        ],
        ratings: [],
        options: {
          years: ['2026年'],
          months: ['7月'],
          buildings: ['A楼'],
          items: ['值班纪律'],
        },
        sources: {
          issues: { status: 'fresh', sourceUpdatedAt: null, warning: '' },
          ratings: { status: 'fresh', sourceUpdatedAt: null, warning: '' },
        },
        sourceUpdatedAt: null,
        syncedAt: '2026-08-30T00:00:00.000Z',
        sourceStatus: 'fresh',
        warnings: [],
      },
    });

    const result = await getAliMonthlyQualityDataset();

    expect(result.issues[0]).toEqual(
      expect.objectContaining({
        responsiblePersons: [],
        personMatchStatus: 'none',
      }),
    );
  });
});
