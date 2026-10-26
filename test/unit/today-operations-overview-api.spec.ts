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
import { getTodayOperationsOverview } from '../../client/src/api';

describe('today operations overview api', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (axiosForBackend as jest.Mock).mockResolvedValue({
      data: { sourceStatus: 'fresh' },
    });
  });

  it('keeps normal cached reads short while allowing an explicit refresh to finish', async () => {
    await getTodayOperationsOverview(false);
    await getTodayOperationsOverview(true);

    expect(axiosForBackend).toHaveBeenNthCalledWith(1, {
      url: '/api/bitable/today-operations-overview',
      method: 'GET',
      params: undefined,
      headers: undefined,
      timeout: 20_000,
    });
    expect(axiosForBackend).toHaveBeenNthCalledWith(2, {
      url: '/api/bitable/today-operations-overview',
      method: 'GET',
      params: { refresh: '1' },
      headers: { 'Cache-Control': 'no-cache' },
      timeout: 60_000,
    });
  });
});
