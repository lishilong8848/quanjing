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

jest.mock(
  '@/access/access-events',
  () => ({ dispatchAccessInvalidated: jest.fn() }),
  { virtual: true },
);

import { axiosForBackend } from '@lark-apaas/client-toolkit/utils/getAxiosForBackend';
import {
  deletePurchaseInventoryRecords,
  getPurchaseInventoryDashboard,
  updatePurchaseInventoryRecord,
} from '../../client/src/api';

describe('purchase inventory api', () => {
  beforeEach(() => jest.clearAllMocks());

  it('loads the dashboard through the production backend route', async () => {
    (axiosForBackend as jest.Mock).mockResolvedValue({
      data: { generatedAt: '2026-07-10T06:00:00.000Z', requests: [] },
    });

    await getPurchaseInventoryDashboard(true);

    expect(axiosForBackend).toHaveBeenCalledWith({
      url: '/api/purchase-inventory/dashboard',
      method: 'GET',
      params: { refresh: '1' },
      timeout: 120_000,
    });
  });

  it('submits one unified-admin-protected batch-delete request without a second password', async () => {
    (axiosForBackend as jest.Mock).mockResolvedValue({
      data: {
        deletedItems: 1,
        deletedSubmissionRecords: 1,
        deletedExecutionRecords: 0,
        durationMs: 20,
      },
    });

    await deletePurchaseInventoryRecords({
      records: [
        {
          key: 'row-1',
          submissionRecordId: 'rec_submission_1',
          executionRecordId: null,
        },
      ],
    });

    expect(axiosForBackend).toHaveBeenCalledWith({
      url: '/api/purchase-inventory/records/batch-delete',
      method: 'POST',
      data: {
        records: [
          {
            key: 'row-1',
            submissionRecordId: 'rec_submission_1',
            executionRecordId: null,
          },
        ],
      },
      timeout: 120_000,
    });
  });

  it('rejects a backend error payload instead of treating it as a successful delete', async () => {
    (axiosForBackend as jest.Mock).mockResolvedValue({
      data: { success: false, message: '当前账号无删除权限' },
    });

    await expect(
      deletePurchaseInventoryRecords({
        records: [
          {
            key: 'row-1',
            submissionRecordId: 'rec_submission_1',
            executionRecordId: null,
          },
        ],
      }),
    ).rejects.toThrow('当前账号无删除权限');
  });

  it('updates one purchase record through the login-protected PATCH route', async () => {
    (axiosForBackend as jest.Mock).mockResolvedValue({
      data: {
        updatedSubmissionRecord: true,
        updatedExecutionRecord: false,
        durationMs: 18,
      },
    });

    await updatePurchaseInventoryRecord('rec_submission_1', {
      submissionRecordId: 'rec_submission_1',
      executionRecordId: null,
      fields: { itemName: '粘鼠板', quantity: 2, unit: '盒' },
    });

    expect(axiosForBackend).toHaveBeenCalledWith({
      url: '/api/purchase-inventory/records/rec_submission_1',
      method: 'PATCH',
      data: {
        submissionRecordId: 'rec_submission_1',
        executionRecordId: null,
        fields: { itemName: '粘鼠板', quantity: 2, unit: '盒' },
      },
      timeout: 120_000,
    });
  });
});
