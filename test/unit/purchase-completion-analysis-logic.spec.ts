import type { PurchaseInventoryRequestItem } from '../../shared/purchase-inventory.interface';
import {
  buildPurchaseCompletionAnalysis,
  filterCompletedPurchaseItems,
} from '../../client/src/pages/PurchaseInventoryManagement/completion-analysis.logic';

function request(
  overrides: Partial<PurchaseInventoryRequestItem>,
): PurchaseInventoryRequestItem {
  return {
    recordId: 'record-1',
    submissionRecordId: 'submission-1',
    executionRecordId: 'execution-1',
    requestCode: 'PR-001',
    title: '默认物品',
    requester: '申请人',
    purchaser: '采购人',
    building: 'H楼',
    specialty: '电气',
    primaryCategory: 'A备品备件类',
    secondaryCategory: '',
    stage: 'stocked',
    statusLabel: '已完成',
    supplier: '京东',
    estimatedAmount: 100,
    actualAmount: 100,
    quantity: 1,
    actualQuantity: 1,
    unit: '件',
    priority: 'P2',
    createdAt: '2026-01-01T00:00:00.000Z',
    expectedArrival: null,
    orderedAt: null,
    receivedAt: '2026-01-10T00:00:00.000Z',
    warehouseRequired: true,
    warehouseConfirmed: true,
    purchaseCompleted: true,
    inventorySku: 'SKU-001',
    notes: '',
    ...overrides,
  };
}

describe('purchase completion analysis', () => {
  it('builds fixed monthly buckets and multi-dimensional rankings', () => {
    const requests = [
      request({ recordId: 'jan-1', actualAmount: 100 }),
      request({
        recordId: 'jan-2',
        actualAmount: 200,
        receivedAt: '2026-01-20T00:00:00.000Z',
      }),
      request({
        recordId: 'feb-1',
        building: 'A楼',
        primaryCategory: 'B工具类',
        supplier: '天猫',
        actualAmount: null,
        estimatedAmount: 300,
        receivedAt: null,
        createdAt: '2026-02-05T00:00:00.000Z',
      }),
      request({
        recordId: 'undated',
        actualAmount: 400,
        createdAt: null,
        receivedAt: null,
      }),
      request({
        recordId: 'executing',
        stage: 'executing',
        purchaseCompleted: false,
      }),
    ];

    const result = buildPurchaseCompletionAnalysis(requests, 5, 2026);

    expect(result.completedCount).toBe(4);
    expect(result.yearCompletedCount).toBe(3);
    expect(result.yearAmount).toBe(600);
    expect(result.averageAmount).toBe(200);
    expect(result.completionRate).toBe(80);
    expect(result.monthly).toHaveLength(12);
    expect(result.monthly[0]).toMatchObject({ month: 1, count: 2, amount: 300 });
    expect(result.monthly[1]).toMatchObject({ month: 2, count: 1, amount: 300 });
    expect(result.monthly[11]).toMatchObject({ month: 12, count: 0, amount: 0 });
    expect(result.categoryRanking[0]).toMatchObject({
      label: 'A备品备件类',
      count: 3,
      amount: 700,
    });
    expect(result.buildingRanking[0]?.label).toBe('H楼');
    expect(result.supplierRanking[0]).toMatchObject({
      label: '京东',
      count: 3,
      amount: 700,
    });
    expect(result.datedCount).toBe(3);
    expect(result.undatedCount).toBe(1);
    expect(result.completedItems.at(-1)?.recordId).toBe('undated');
  });

  it('supports normalized fuzzy search and combined detail filters', () => {
    const items = [
      request({
        recordId: 'matched',
        requestCode: 'CG260720-601',
        title: '一次性纸杯',
        requester: '刘小杏',
        purchaser: '曹李培',
        building: 'H楼',
        supplier: '京东',
        primaryCategory: 'D消耗类',
        receivedAt: '2026-07-21T00:00:00.000Z',
      }),
      request({
        recordId: 'other',
        requestCode: 'CG260708-401',
        title: '塑料盆',
        building: 'D楼',
        supplier: '天猫',
        primaryCategory: 'C物资类',
        receivedAt: '2026-07-10T00:00:00.000Z',
      }),
    ];

    expect(
      filterCompletedPurchaseItems(items, {
        query: '  cg260720  纸杯  ',
        building: 'H楼',
        supplier: '京东',
        category: 'D消耗类',
        dateRange: '30d',
        now: new Date('2026-07-21T12:00:00.000Z'),
      }).map((item) => item.recordId),
    ).toEqual(['matched']);
    expect(
      filterCompletedPurchaseItems(items, {
        query: '刘小杏',
        building: 'all',
        supplier: 'all',
        category: 'all',
        dateRange: 'all',
        now: new Date('2026-07-21T12:00:00.000Z'),
      }).map((item) => item.recordId),
    ).toEqual(['matched']);
  });
});
