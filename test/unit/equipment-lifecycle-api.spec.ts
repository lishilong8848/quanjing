jest.mock(
  '@lark-apaas/client-toolkit/logger',
  () => ({ logger: { error: jest.fn(), warn: jest.fn() } }),
  { virtual: true },
);

jest.mock(
  '@lark-apaas/client-toolkit/utils/getAxiosForBackend',
  () => ({ axiosForBackend: jest.fn() }),
  { virtual: true },
);

import { axiosForBackend } from '@lark-apaas/client-toolkit/utils/getAxiosForBackend';
import { getEquipmentLifecycleDashboard } from '../../client/src/api';

describe('equipment lifecycle dashboard api', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (axiosForBackend as jest.Mock).mockResolvedValue({
      data: { month: '2026-07' },
    });
  });

  it('requests the typed dashboard route with month, refresh and a 120 second timeout', async () => {
    await expect(
      getEquipmentLifecycleDashboard({ month: '2026-07', refresh: true }),
    ).resolves.toEqual({ month: '2026-07' });

    expect(axiosForBackend).toHaveBeenCalledWith({
      url: '/api/equipment-lifecycle/dashboard',
      method: 'GET',
      params: {
        month: '2026-07',
        refresh: '1',
      },
      timeout: 120_000,
    });
  });

  it('omits optional query values and propagates backend failures', async () => {
    await getEquipmentLifecycleDashboard();
    expect(axiosForBackend).toHaveBeenLastCalledWith({
      url: '/api/equipment-lifecycle/dashboard',
      method: 'GET',
      params: {
        month: undefined,
        refresh: undefined,
      },
      timeout: 120_000,
    });

    const failure = new Error('base unavailable');
    (axiosForBackend as jest.Mock).mockRejectedValueOnce(failure);
    await expect(getEquipmentLifecycleDashboard()).rejects.toBe(failure);
  });
});
