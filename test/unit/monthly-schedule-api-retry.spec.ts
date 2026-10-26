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
import { getMonthlySchedules } from '../../client/src/api';

describe('monthly schedule api retry', () => {
  beforeEach(() => {
    (axiosForBackend as jest.Mock).mockReset();
  });

  it.each([
    ['network interruption', { code: 'ERR_NETWORK' }],
    ['HTTP 503', { response: { status: 503 } }],
  ])('retries a transient %s before returning schedule data', async (_label, error) => {
    const response = { schedules: [{ date: '2026-07-15' }] };
    (axiosForBackend as jest.Mock)
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce({ data: response });

    await expect(getMonthlySchedules(2026, 7)).resolves.toEqual(response);

    expect(axiosForBackend).toHaveBeenCalledTimes(2);
    expect(axiosForBackend).toHaveBeenNthCalledWith(1, {
      url: '/api/monthly-schedules/2026/7',
      method: 'GET',
    });
  });

  it.each([401, 403])('does not retry an HTTP %s response', async (status) => {
    const accessError = { response: { status } };
    (axiosForBackend as jest.Mock).mockRejectedValueOnce(accessError);

    await expect(getMonthlySchedules(2026, 7)).rejects.toBe(accessError);

    expect(axiosForBackend).toHaveBeenCalledTimes(1);
  });

  it('passes an explicit refresh query when stale leave impact must be reloaded', async () => {
    (axiosForBackend as jest.Mock).mockResolvedValueOnce({
      data: { schedules: [] },
    });

    await getMonthlySchedules(2026, 8, true);

    expect(axiosForBackend).toHaveBeenCalledWith({
      url: '/api/monthly-schedules/2026/8',
      method: 'GET',
      params: { refresh: 'true' },
    });
  });
});
