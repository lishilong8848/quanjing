jest.mock('../../common/feishu/bitable-direct-read', () => ({
  extractDisplayText: jest.fn((value: unknown) => String(value ?? '')),
  fetchBitableRecords: jest.fn(),
}));

import { fetchBitableRecords } from '../../common/feishu/bitable-direct-read';
import { PurchaseCodeService } from './purchase-code.service';

describe('PurchaseCodeService', () => {
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
      submissionTableId: 'PUBLIC_EXAMPLE_FEISHU_PURCHASE_SUBMISSION_TABLE_ID',
      executionTableId: 'PUBLIC_EXAMPLE_FEISHU_PURCHASE_EXECUTION_TABLE_ID',
    };

    await expect(service.allocate(input)).resolves.toBe('CG260721-604');
    await expect(service.allocate(input)).resolves.toBe('CG260721-605');

    expect(fetchBitableRecords).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        appToken: 'app-token',
        fieldNames: ['采购编码'],
        forceRefresh: true,
      }),
    );
  });
});
