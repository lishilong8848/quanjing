jest.mock(
  '@lark-apaas/client-toolkit/logger',
  () => ({
    logger: {
      error: jest.fn(),
    },
  }),
  { virtual: true },
);

jest.mock(
  '@lark-apaas/client-toolkit/utils/getAxiosForBackend',
  () => ({
    axiosForBackend: jest.fn(() =>
      Promise.reject(new Error('axiosForBackend should not be used')),
    ),
  }),
  { virtual: true },
);

import {
  updateConstructionPermitManualReview,
  searchConstructionChangeOrders,
  searchConstructionOnsiteFollowers,
} from '../../client/src/api';

describe('construction api', () => {
  const originalFetch = globalThis.fetch;
  const originalWindow = globalThis.window;

  beforeEach(() => {
    Object.defineProperty(globalThis, 'window', {
      value: {
        csrfToken: 'csrf-token',
        location: {
          origin: 'https://localhost:3001',
        },
      },
      configurable: true,
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, 'window', {
      value: originalWindow,
      configurable: true,
    });
    jest.clearAllMocks();
  });

  it('searches construction onsite followers through constructionFetch', async () => {
    const fetchMock = jest.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          configured: true,
          items: [{ id: 'ou_zhang', name: '\u5f20\u6587\u8c6a' }],
          total: 1,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    globalThis.fetch = fetchMock;
    const controller = new AbortController();

    const result = await searchConstructionOnsiteFollowers(
      '\u5f20',
      controller.signal,
    );

    expect(result.items).toEqual([
      expect.objectContaining({ id: 'ou_zhang' }),
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/duty-schedules/construction-management/onsite-followers?query=%E5%BC%A0',
      expect.objectContaining({
        credentials: 'include',
        method: 'GET',
        signal: controller.signal,
      }),
    );
  });

  it('searches construction change orders through constructionFetch', async () => {
    const fetchMock = jest.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          configured: true,
          items: [{ id: 'change-1', title: 'CR-1' }],
          total: 1,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    globalThis.fetch = fetchMock;

    const result = await searchConstructionChangeOrders('CR-1');

    expect(result.items).toEqual([
      expect.objectContaining({ id: 'change-1' }),
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/duty-schedules/construction-management/change-orders?query=CR-1',
      expect.objectContaining({
        credentials: 'include',
        method: 'GET',
      }),
    );
  });

  it('updates construction permit manual review decisions through constructionFetch', async () => {
    const fetchMock = jest.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          recordId: 'recFollowup',
          fileKey: 'hotWorkPermitFiles',
          field: '动火许可证',
          reviewField: '人工审核-动火许可票',
          decision: 'passed',
          message: '动火许可证人工审核已标记为通过',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    globalThis.fetch = fetchMock;

    const result = await updateConstructionPermitManualReview({
      followupRecordId: 'recFollowup',
      fileKey: 'hotWorkPermitFiles',
      decision: 'passed',
      permitFileTokens: ['tokHot'],
      sourceFeedback: '核验日期：2026-06-04；结论：不通过',
      permitFingerprint: 'v1:abc123',
    });

    expect(result.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/duty-schedules/construction-management/permit-manual-review/result',
      expect.objectContaining({
        credentials: 'include',
        method: 'POST',
        body: JSON.stringify({
          followupRecordId: 'recFollowup',
          fileKey: 'hotWorkPermitFiles',
          decision: 'passed',
          permitFileTokens: ['tokHot'],
          sourceFeedback: '核验日期：2026-06-04；结论：不通过',
          permitFingerprint: 'v1:abc123',
        }),
      }),
    );
  });
});
