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

import { readFileSync } from 'fs';
import { join } from 'path';
import { axiosForBackend } from '@lark-apaas/client-toolkit/utils/getAxiosForBackend';
import { getTodayLeaveStaff } from '../../client/src/api';

describe('today leave staff refresh', () => {
  beforeEach(() => {
    (axiosForBackend as jest.Mock).mockReset();
  });

  it('sends an explicit refresh query when current personnel data is required', async () => {
    const response = { date: '2026-07-21', buildings: [], totalLeaveCount: 0 };
    (axiosForBackend as jest.Mock).mockResolvedValueOnce({ data: response });

    await expect(getTodayLeaveStaff('2026-07-21', true)).resolves.toEqual(response);

    expect(axiosForBackend).toHaveBeenCalledWith({
      url: '/api/bitable/today-leave-staff',
      method: 'GET',
      params: { date: '2026-07-21', refresh: '1' },
      headers: { 'Cache-Control': 'no-cache' },
    });
  });

  it('passes refresh through the controller and always uses the approval-aware source', () => {
    const controllerSource = readFileSync(
      join(process.cwd(), 'server/modules/bitable-sync/bitable-sync.controller.ts'),
      'utf8',
    );
    const serviceSource = readFileSync(
      join(process.cwd(), 'server/modules/bitable-sync/bitable-sync.service.ts'),
      'utf8',
    );

    expect(controllerSource).toContain("@Query('refresh') refresh?: string");
    expect(controllerSource).toContain(
      "refresh === '1' || refresh === 'true'",
    );
    expect(serviceSource).toContain(
      'async getTodayLeaveStaff(date: string, forceRefresh = false)',
    );
    expect(serviceSource).toContain(
      'this.requiresApprovalAwareLeaveSourceRead()',
    );
    expect(serviceSource).toContain(
      'return this.getTodayLeaveStaffFromFeishu(date, forceRefresh)',
    );
  });
});
