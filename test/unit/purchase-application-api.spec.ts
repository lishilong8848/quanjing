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
import * as purchaseApi from '../../client/src/api';
import {
  getPurchaseInventoryDashboard,
  getPurchaseApplicationSubmissionTaskStatus,
  getPurchaseApplicationOptions,
  searchPurchaseApplicationApplicants,
  searchInventoryApplicants,
  searchPurchaseApplicationCatalog,
  submitPurchaseApplications,
} from '../../client/src/api';
import type { PurchaseApplicationBatchRequest } from '../../shared/purchase-application.interface';

describe('purchase application api', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (axiosForBackend as jest.Mock).mockResolvedValue({ data: {} });
  });

  it('uses the typed options and catalog routes without personal OAuth APIs', async () => {
    await getPurchaseApplicationOptions();
    await searchPurchaseApplicationCatalog({ building: 'H楼', query: 'A4' });

    expect(axiosForBackend).toHaveBeenNthCalledWith(1, {
      url: '/api/purchase-inventory/application-options',
      method: 'GET',
      timeout: 120_000,
    });
    expect(axiosForBackend).toHaveBeenNthCalledWith(2, {
      url: '/api/purchase-inventory/catalog-search',
      method: 'GET',
      params: { building: 'H楼', query: 'A4' },
      timeout: 120_000,
    });
    expect(purchaseApi).not.toHaveProperty('getPurchaseApplicationAuthStatus');
    expect(purchaseApi).not.toHaveProperty('getPurchaseApplicationLoginUrl');
  });

  it('submits the batch and files as multipart form data', async () => {
    (axiosForBackend as jest.Mock).mockResolvedValue({
      data: {
        pending: true,
        taskId: 'purchase-application-task-1',
        message: '采购申请已受理',
      },
    });
    const payload = request();
    const file = new File(['quote'], 'quote.pdf', { type: 'application/pdf' });

    await submitPurchaseApplications(
      payload,
      [file],
      'mutation-12345678',
      'a'.repeat(64),
    );

    const config = (axiosForBackend as jest.Mock).mock.calls[0][0];
    expect(config).toEqual(
      expect.objectContaining({
        url: '/api/purchase-inventory/applications',
        method: 'POST',
        timeout: 30_000,
        headers: {
          'X-Idempotency-Key': 'mutation-12345678',
          'X-Idempotency-Fingerprint': 'a'.repeat(64),
        },
      }),
    );
    expect(config.data).toBeInstanceOf(FormData);
    expect(config.data.get('payload')).toBe(JSON.stringify(payload));
    expect((config.data.get('comparisonAttachments') as File).name).toBe(
      'quote.pdf',
    );
  });

  it('polls the accepted purchase application task', async () => {
    await getPurchaseApplicationSubmissionTaskStatus(
      'purchase-application-task-1',
    );

    expect(axiosForBackend).toHaveBeenCalledWith({
      url: '/api/purchase-inventory/applications/tasks/purchase-application-task-1',
      method: 'GET',
      timeout: 15_000,
    });
  });

  it('requests an active-only dashboard refresh without escalating to a full refresh', async () => {
    await getPurchaseInventoryDashboard('active' as never);

    expect(axiosForBackend).toHaveBeenCalledWith({
      url: '/api/purchase-inventory/dashboard',
      method: 'GET',
      params: { refresh: 'active' },
      timeout: 120_000,
    });
  });

  it('fuzzy searches purchase applicants from the backend source', async () => {
    (axiosForBackend as jest.Mock).mockResolvedValue({ data: [] });

    await searchPurchaseApplicationApplicants({ query: '马金', limit: 30 });

    expect(axiosForBackend).toHaveBeenCalledWith({
      url: '/api/purchase-inventory/applicant-search',
      method: 'GET',
      params: { query: '马金', limit: 30 },
      timeout: 120_000,
    });
  });

  it('rejects a malformed applicant-search response before picker rendering', async () => {
    (axiosForBackend as jest.Mock).mockResolvedValue({
      data: '<!doctype html><title>proxy error</title>',
    });

    await expect(
      searchPurchaseApplicationApplicants({ query: '马', limit: 20 }),
    ).rejects.toThrow('申请人搜索返回格式无效');
  });

  it('uses the inventory selector and canonical self lookup without procurement authorization', async () => {
    (axiosForBackend as jest.Mock).mockResolvedValue({ data: [] });
    await searchInventoryApplicants({ query: '合成', limit: 20 });
    await searchInventoryApplicants({ self: true, limit: 1 });
    expect(axiosForBackend).toHaveBeenNthCalledWith(1, {
      url: '/api/inventory-management/applicant-search', method: 'GET',
      params: { query: '合成', limit: 20 }, timeout: 120_000,
    });
    expect(axiosForBackend).toHaveBeenNthCalledWith(2, {
      url: '/api/inventory-management/applicant-search', method: 'GET',
      params: { self: true, limit: 1 }, timeout: 15_000,
    });
  });

  it('rejects malformed inventory selector data without altering a pending draft', async () => {
    (axiosForBackend as jest.Mock).mockResolvedValue({ data: '<html>error</html>' });
    await expect(searchInventoryApplicants({ query: '合成' })).rejects.toThrow('申请人搜索返回格式无效');
  });
});

function request(): PurchaseApplicationBatchRequest {
  return {
    shared: {
      applicantRecordId: 'rec-ma',
      applicantOpenId: 'ou_ma',
      applicantName: '马金玉',
      applicantEmployeeNo: 'NT-001',
      building: 'H楼',
      specialty: '其他',
      purchaseMethod: '综合采购',
      purchaseChannel: '线下',
      supplier: '供应商',
      onlineUrl: '',
      comparisonSatisfied: '是',
      requirementSummary: '补充办公物资',
      expectedDeliveryDate: '2026-07-20',
      immediateOutbound: false,
      notes: '',
    },
    items: [],
  };
}
