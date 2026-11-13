import type { InventoryOutboundMovementCreateRequest, PurchaseExistingInboundConfirmRequest } from '../../shared/inventory-management.interface';
import {
  applyInventoryBatchAcceptance,
  createInventoryBatchJournal,
  inventoryBatchMutationId,
  readInventoryBatchJournal,
  saveInventoryBatchJournal,
  updateInventoryBatchTask,
} from '../../client/src/pages/InventoryManagement/inventory-batch-acceptance';

function requests(): InventoryOutboundMovementCreateRequest[] {
  return ['first', 'second'].map((id) => ({
    type: 'outbound',
    clientMutationId: id,
    catalogRecordId: `catalog-${id}`,
    sku: `SKU-${id}`,
    building: 'A楼',
    quantity: 1,
    occurredAt: '2026-09-29T00:00:00.000Z',
    applicantOpenId: 'ou_applicant',
    reason: '批量出库测试',
  }));
}

describe('inventory batch acceptance', () => {
  it('keeps the preallocated item IDs that staged purchase photos are bound to', () => {
    const batchId = 'a'.repeat(32);
    const photoId = 'b'.repeat(64);
    const input = [1, 2].map((index): PurchaseExistingInboundConfirmRequest => ({
      executionRecordId: `purchase-${index}`,
      clientMutationId: inventoryBatchMutationId('purchase', batchId, index),
      mode: 'existing',
      building: 'A楼',
      catalogRecordId: 'catalog-1',
      sku: 'SKU-1',
      quantity: 1,
      occurredAt: '2026-09-29T00:00:00.000Z',
      photoIds: [photoId],
    }));
    const journal = createInventoryBatchJournal('purchase', 'principal', input, ['甲', '乙'], batchId);
    expect(journal.requests).toEqual(input);
    expect(() => createInventoryBatchJournal('purchase', 'principal', input, ['甲', '乙'], 'c'.repeat(32)))
      .toThrow('照片与入库请求编号不一致');
  });

  it('requires distinct mutation ids before any batch is sent', () => {
    const input = requests();
    input[1].clientMutationId = input[0].clientMutationId;
    expect(() =>
      createInventoryBatchJournal('outbound', 'principal', input, ['甲', '乙']),
    ).toThrow('编号无效或重复');
  });

  it('keeps each accepted task id and isolated rejection for recovery', () => {
    const journal = createInventoryBatchJournal(
      'outbound',
      'principal',
      requests(),
      ['甲', '乙'],
    );
    const [firstId, secondId] = journal.entries.map((entry) => entry.clientMutationId);
    const result = applyInventoryBatchAcceptance(journal, {
      success: true,
      items: [
        {
          clientMutationId: firstId,
          accepted: true,
          taskId: 'task-first',
          message: '已受理',
        },
        { clientMutationId: secondId, accepted: false, message: '库存不足' },
      ],
    });
    expect(result.entries).toEqual([
      {
        clientMutationId: firstId,
        label: '甲',
        status: 'accepted',
        taskId: 'task-first',
        message: '已受理',
      },
      {
        clientMutationId: secondId,
        label: '乙',
        status: 'rejected',
        taskId: undefined,
        message: '库存不足',
      },
    ]);
    expect(
      updateInventoryBatchTask(result, firstId, 'completed', '已完成')
        .entries[1],
    ).toEqual(result.entries[1]);
    expect(
      updateInventoryBatchTask(result, firstId, 'accepted', '已受理'),
    ).toBe(result);
  });

  it('rejects incomplete acceptance responses so original ids can be retried', () => {
    const journal = createInventoryBatchJournal(
      'outbound',
      'principal',
      requests(),
      ['甲', '乙'],
    );
    expect(() =>
      applyInventoryBatchAcceptance(journal, {
        success: true,
        items: [
          {
            clientMutationId: journal.entries[0].clientMutationId,
            accepted: true,
            taskId: 'task-first',
            message: '已受理',
          },
        ],
      }),
    ).toThrow('响应与提交内容不一致');
    expect(
      journal.entries.every((entry) => entry.status === 'submitting'),
    ).toBe(true);
  });

  it('restores the exact original requests after an uncertain network response', () => {
    const values = new Map<string, string>();
    const previousWindow = (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = {
      localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => {
          values.set(key, value);
        },
      },
    };
    try {
      const journal = createInventoryBatchJournal(
        'outbound',
        'principal',
        requests(),
        ['甲', '乙'],
      );
      saveInventoryBatchJournal(journal);
      expect(
        readInventoryBatchJournal('principal', 'outbound')?.requests,
      ).toEqual(journal.requests);
      expect(
        readInventoryBatchJournal('another-principal', 'outbound'),
      ).toBeNull();
    } finally {
      (globalThis as { window?: unknown }).window = previousWindow;
    }
  });
});
