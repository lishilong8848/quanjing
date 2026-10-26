jest.mock('@lark-apaas/client-toolkit/utils/getAxiosForBackend', () => ({
  axiosForBackend: jest.fn(),
}));
import { axiosForBackend } from '@lark-apaas/client-toolkit/utils/getAxiosForBackend';
import {
  getStocktakeSheet,
  bulkConfirmStocktake,
  undoBulkStocktake,
  getStocktakeSync,
  retryStocktakeSync,
  waitStocktakeBulkTask,
} from '../../client/src/pages/InventoryManagement/inventory-stocktake.api';

describe('stocktake sheet HTTP response', () => {
  const request = axiosForBackend as jest.MockedFunction<
    typeof axiosForBackend
  >;
  beforeEach(() => jest.clearAllMocks());
  it('polls a durable task and reads the sheet only once on success', async () => {
    jest.useFakeTimers();
    try {
      const task = {
        id: 'bulk-stable-001',
        month: '2026-10',
        building: 'H楼',
        status: 'queued',
        count: 859,
      } as any;
      const sheet = {
        month: task.month,
        building: task.building,
        scope: 'review',
        lines: [],
      };
      request
        .mockResolvedValueOnce({ data: task } as any)
        .mockResolvedValueOnce({ data: { ...task, status: 'running' } } as any)
        .mockResolvedValueOnce({ data: { ...task, status: 'success' } } as any)
        .mockResolvedValueOnce({ data: sheet } as any);
      const progress = jest.fn();
      const pending = bulkConfirmStocktake(
        {
          month: task.month,
          building: task.building,
          clientMutationId: task.id,
        } as any,
        progress,
      );
      await jest.advanceTimersByTimeAsync(4000);
      expect(await pending).toEqual(sheet);
      expect(
        request.mock.calls.filter(([config]) => config.method === 'POST'),
      ).toHaveLength(1);
      expect(
        request.mock.calls.filter(([config]) => config.url.endsWith('/sheet')),
      ).toHaveLength(1);
      expect(progress.mock.calls.map(([t]) => t.status)).toEqual([
        'queued',
        'running',
        'success',
      ]);
    } finally {
      jest.useRealTimers();
    }
  });
  it('recovers a lost acceptance response by querying the same mutation, without a second write', async () => {
    const task = {
      id: 'bulk-stable-002',
      month: '2026-10',
      building: 'H楼',
      status: 'success',
    } as any;
    request
      .mockRejectedValueOnce(
        Object.assign(new Error('timeout'), { code: 'ECONNABORTED' }),
      )
      .mockResolvedValueOnce({ data: task } as any)
      .mockResolvedValueOnce({ data: { lines: [] } } as any);
    await bulkConfirmStocktake({
      month: task.month,
      building: task.building,
      clientMutationId: task.id,
    } as any);
    expect(request.mock.calls[1][0]).toMatchObject({
      method: 'GET',
      params: { id: task.id, month: task.month, building: task.building },
    });
    expect(
      request.mock.calls.filter(([config]) => config.method === 'POST'),
    ).toHaveLength(1);
  });
  it('stops polling with a recoverable task message rather than spinning forever', async () => {
    jest.useFakeTimers();
    try {
      const task = {
        id: 'bulk-stable-003',
        month: '2026-10',
        building: 'H楼',
        status: 'running',
      } as any;
      request.mockResolvedValue({ data: task } as any);
      const result = waitStocktakeBulkTask(task).catch(
        (error) => error.message,
      );
      await jest.advanceTimersByTimeAsync(120000);
      expect(await result).toContain('后台处理');
    } finally {
      jest.useRealTimers();
    }
  });
  it('keeps undo and sync retry mutation IDs and reads compact scoped sync status', async () => {
    request.mockResolvedValue({ data: { pending: 1 } } as any);
    const undo = {
      month: '2026-10',
      building: 'A楼',
      scope: 'review',
      expectedVersion: 2,
      batchId: 'test-batch',
      clientMutationId: 'stable-undo-001',
    } as any;
    await undoBulkStocktake(undo);
    await undoBulkStocktake(undo);
    expect(request.mock.calls[0][0]).toEqual(request.mock.calls[1][0]);
    expect(request.mock.calls[0][0].url).toContain('/bulk-undo');
    await getStocktakeSync('2026-10', 'A楼', 'review');
    expect(request.mock.calls[2][0].params).toEqual({
      month: '2026-10',
      building: 'A楼',
      scope: 'review',
    });
    await retryStocktakeSync(undo);
    expect(request.mock.calls[3][0]).toMatchObject({
      url: '/api/inventory-management/stocktake/retry-sync',
      data: undo,
    });
  });

  it.each(['', null])(
    'treats an absent Nest HTTP sheet as null (%p)',
    async (data) => {
      request.mockResolvedValueOnce({ data } as any);
      expect(await getStocktakeSheet('2026-10', 'A楼')).toBeNull();
    },
  );

  it('keeps an existing sheet', async () => {
    const sheet = { month: '2026-10', building: 'A楼', lines: [] };
    request.mockResolvedValueOnce({ data: sheet } as any);
    expect(await getStocktakeSheet('2026-10', 'A楼')).toBe(sheet);
  });
  it('separates read scope and sends the same stable bulk mutation unchanged for a retry', async () => {
    request.mockResolvedValue({
      data: { month: '2026-10', building: 'A楼', scope: 'review', lines: [] },
    } as any);
    await getStocktakeSheet('2026-10', 'A楼', 'review');
    expect(request.mock.calls[0][0].params).toEqual({
      month: '2026-10',
      building: 'A楼',
      scope: 'review',
    });
    const body = {
      month: '2026-10',
      building: 'A楼',
      scope: 'review',
      expectedVersion: 1,
      confirmer: null,
      clientMutationId: 'retry-bulk-001',
      lines: [],
    } as any;
    await bulkConfirmStocktake(body);
    await bulkConfirmStocktake(body);
    expect(request.mock.calls[1][0]).toMatchObject({
      method: 'POST',
      url: '/api/inventory-management/stocktake/bulk-confirm',
      data: body,
      timeout: 20000,
    });
    expect(request.mock.calls[2][0]).toEqual(request.mock.calls[1][0]);
  });

  it.each([{}, { lines: null }, 'invalid'])(
    'rejects malformed nonempty sheets (%p)',
    async (data) => {
      request.mockResolvedValueOnce({ data } as any);
      await expect(getStocktakeSheet('2026-10', 'A楼')).rejects.toThrow(
        '盘点清单返回格式异常',
      );
    },
  );

  it('preserves HTTP failures for the page retry state', async () => {
    const error = new Error('network timeout');
    request.mockRejectedValueOnce(error);
    await expect(getStocktakeSheet('2026-10', 'A楼')).rejects.toBe(error);
  });
});
