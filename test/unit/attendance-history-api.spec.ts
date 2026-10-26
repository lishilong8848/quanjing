jest.mock('@lark-apaas/client-toolkit/utils/getAxiosForBackend', () => ({
  axiosForBackend: jest.fn(),
}));

import { axiosForBackend } from '@lark-apaas/client-toolkit/utils/getAxiosForBackend';
import { getAttendanceHistory } from '../../client/src/api/attendance-history';

describe('attendance history api', () => {
  it('用明确周期查询并传递中止信号', async () => {
    const response = { startDate: '2026-09-01', endDate: '2026-09-19' };
    (axiosForBackend as jest.Mock).mockResolvedValueOnce({ data: response });
    const controller = new AbortController();

    await expect(
      getAttendanceHistory('2026-09-01', '2026-09-19', {
        refresh: true,
        signal: controller.signal,
      }),
    ).resolves.toBe(response);

    expect(axiosForBackend).toHaveBeenCalledWith({
      url: '/api/attendance/history',
      method: 'GET',
      params: {
        from: '2026-09-01',
        through: '2026-09-19',
        refresh: '1',
      },
      timeout: 30_000,
      signal: controller.signal,
    });
  });
});
