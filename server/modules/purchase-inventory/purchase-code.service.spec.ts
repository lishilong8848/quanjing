jest.mock('../../common/feishu/bitable-direct-read', () => ({
  extractDisplayText: jest.fn((value: unknown) => String(value ?? '')),
  fetchBitableRecords: jest.fn(),
}));

import { fetchBitableRecords } from '../../common/feishu/bitable-direct-read';
import { PurchaseCodeService } from './purchase-code.service';

describe('PurchaseCodeService', () => {
  beforeEach(() => jest.clearAllMocks());

  it('continues from the largest code in either purchase table without reusing a sequence', async () => {
    (fetchBitableRecords as jest.Mock).mockResolvedValue([
      { fields: { 采购编码: 'CG260721-601' } },
      { fields: { 采购编码: 'CG260721-603' } },
    ]);
    const service = new PurchaseCodeService({ axiosRef: {} } as never);
    const input = {
      appToken: 'app-token',
      date: '2026-07-21',
      building: 'H楼',
      submissionTableId: 'tblIfmOB4VTUMmMh',
      executionTableId: 'tblKmajonrdwW7Z0',
    };

    await expect(service.allocate(input)).resolves.toBe('CG260721-604');
    await expect(service.allocate(input)).resolves.toBe('CG260721-605');

    expect(fetchBitableRecords).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        appToken: 'app-token',
        fieldNames: ['采购编码'],
        filter: {
          conjunction: 'and',
          conditions: [{ field_name: '采购编码', operator: 'contains', value: ['CG260721-6'] }],
        },
        forceRefresh: true,
      }),
    );
  });

  it('retries invalidated reads independently while preserving sequential code allocation', async () => {
    let conflicts = 2;
    (fetchBitableRecords as jest.Mock).mockImplementation(async (_http, options) => {
      if (options.tableId === 'tblExecution' && conflicts-- > 0) {
        throw new Error('数据在读取期间已变更，请重新读取');
      }
      return [{ fields: { 采购编码: 'CG261118-609' } }];
    });
    const service = new PurchaseCodeService({ axiosRef: {} } as never);
    const input = { appToken: 'app', date: '2026-11-18', building: 'H楼',
      submissionTableId: 'tblSubmission', executionTableId: 'tblExecution' };
    await expect(Promise.all([service.allocate(input), service.allocate(input)]))
      .resolves.toEqual(['CG261118-610', 'CG261118-611']);
    expect((fetchBitableRecords as jest.Mock).mock.calls.filter(([, o]) => o.tableId === 'tblSubmission'))
      .toHaveLength(2);
  });

  it('bounds conflict retries and never reserves a code from an invalidated result', async () => {
    (fetchBitableRecords as jest.Mock).mockRejectedValue(new Error('数据在读取期间已变更，请重新读取'));
    const service = new PurchaseCodeService({ axiosRef: {} } as never);
    const input = { appToken: 'app', date: '2026-11-18', building: 'H楼',
      submissionTableId: 'tblSubmission', executionTableId: 'tblExecution' };
    await expect(service.allocate(input)).rejects.toThrow('数据在读取期间已变更');
    // Both independent source reads have bounded lifetimes.
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(fetchBitableRecords).toHaveBeenCalledTimes(6);
    (fetchBitableRecords as jest.Mock).mockResolvedValue([]);
    await expect(service.allocate(input)).resolves.toBe('CG261118-601');
  });

  it('propagates permission errors without retry and isolates allocations between data sources', async () => {
    (fetchBitableRecords as jest.Mock).mockRejectedValue(new Error('无权读取采购表'));
    const service = new PurchaseCodeService({ axiosRef: {} } as never);
    const input = { appToken: 'first', date: '2026-11-18', building: 'H楼',
      submissionTableId: 'tblSubmission', executionTableId: 'tblExecution' };
    await expect(service.allocate(input)).rejects.toThrow('无权读取采购表');
    expect(fetchBitableRecords).toHaveBeenCalledTimes(2);
    (fetchBitableRecords as jest.Mock).mockResolvedValue([]);
    await expect(service.allocate(input)).resolves.toBe('CG261118-601');
    await expect(service.allocate({ ...input, appToken: 'second' })).resolves.toBe('CG261118-601');
  });
});
