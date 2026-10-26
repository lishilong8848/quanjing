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

jest.mock('../../client/src/access/access-events', () => ({
  dispatchAccessInvalidated: jest.fn(),
}));

import { axiosForBackend } from '@lark-apaas/client-toolkit/utils/getAxiosForBackend';
import { dispatchAccessInvalidated } from '../../client/src/access/access-events';
import {
  getContractAttachmentInlineUrl,
  getContractManagementDashboard,
  markContractNoPaymentRequired,
} from '../../client/src/api';

describe('contract management api', () => {
  beforeEach(() => jest.clearAllMocks());

  it('builds an authenticated same-origin inline contract URL', () => {
    expect(getContractAttachmentInlineUrl('attachment / 1')).toBe(
      '/api/contract-management/attachments/attachment%20%2F%201/download?disposition=inline',
    );
  });

  it('rejects a toolkit-fulfilled 403 instead of returning an empty dashboard', async () => {
    (axiosForBackend as jest.Mock).mockResolvedValue({
      status: 403,
      config: { url: '/api/contract-management/dashboard' },
      data: { success: false, message: 'forbidden' },
    });

    await expect(getContractManagementDashboard()).rejects.toThrow(
      '管理员会话已失效',
    );
    expect(dispatchAccessInvalidated).toHaveBeenCalledTimes(1);
  });

  it('persists no-payment-required through the contract disposition endpoint', async () => {
    const request = {
      idempotencyKey: '74cc5e80-f3f2-4aa1-a26c-81c02ad03b70',
    };
    (axiosForBackend as jest.Mock).mockResolvedValue({
      data: {
        ok: true,
        action: 'no_payment_required',
        contractRecordId: 'rec_contract',
        disposition: '无需付款',
        message: '已标记为无需付款',
      },
    });

    await expect(
      markContractNoPaymentRequired('rec_contract', request),
    ).resolves.toMatchObject({
      ok: true,
      disposition: '无需付款',
    });
    expect(axiosForBackend).toHaveBeenCalledWith({
      url: '/api/contract-management/contracts/rec_contract/payment-follow-up-disposition',
      method: 'PATCH',
      data: request,
      timeout: 120_000,
    });
  });

  it('rejects a malformed successful payload instead of showing no data', async () => {
    (axiosForBackend as jest.Mock).mockResolvedValue({
      status: 200,
      data: { success: true },
    });

    await expect(getContractManagementDashboard()).rejects.toThrow(
      '合同数据响应格式无效',
    );
  });

  it('returns a valid dashboard and preserves the refresh request', async () => {
    const dashboard = {
      generatedAt: '2026-07-15T04:00:00.000Z',
      summary: { totalContracts: 40 },
      paymentProgress: { pendingAmount: 0 },
      contracts: [],
      payments: [],
      sectionStatus: {},
    };
    (axiosForBackend as jest.Mock).mockResolvedValue({
      status: 200,
      data: dashboard,
    });

    await expect(getContractManagementDashboard(true)).resolves.toBe(dashboard);
    expect(axiosForBackend).toHaveBeenCalledWith({
      url: '/api/contract-management/dashboard',
      method: 'GET',
      params: { refresh: '1' },
      timeout: 120_000,
    });
  });
});
