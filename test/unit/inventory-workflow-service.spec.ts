jest.mock(
  '@server/common/config/external-services.config',
  () => ({
    parseFeishuBitableLink: jest.fn(() => ({ appToken: 'app-token' })),
    readEnv: jest.fn((name: string) => {
      const values: Record<string, string> = {
        FEISHU_WAREHOUSE_SOURCE_URL: 'https://example.feishu.cn/base/PUBLIC_EXAMPLE_SOURCE',
        FEISHU_WAREHOUSE_PURCHASE_TABLE_ID: 'tbl-purchase',
        FEISHU_WAREHOUSE_INBOUND_TABLE_ID: 'tbl-inbound',
        FEISHU_WAREHOUSE_OUTBOUND_TABLE_ID: 'tbl-outbound',
        FEISHU_WAREHOUSE_WORKFLOW_LOG_TABLE_ID: 'tbl-log',
      };
      return values[name] || '';
    }),
  }),
  { virtual: true },
);

import { InventoryWorkflowService } from '../../server/modules/inventory-management/inventory-workflow.service';

const purchase = {
  record_id: 'rec-purchase',
  fields: {
    物品类别码: 'SKU-001',
    申请楼栋: ['H楼'],
    实际采购数量: 2,
    签收时间: '2026-07-11 09:30:00',
    是否已入库: false,
    采购完成: true,
    '1️⃣物品采购方式': ['综合采购'],
    采购到货入库后是否需要立即领用出库: true,
  },
};

function createHarness() {
  const logs = new Map<string, any>();
  const gateway = {
    listRecords: jest.fn(),
    createRecord: jest.fn().mockResolvedValue('rec-inbound'),
    updateRecord: jest.fn().mockResolvedValue(undefined),
    deleteRecord: jest.fn().mockResolvedValue(undefined),
    getRecord: jest.fn(),
    sendInteractiveCard: jest
      .fn()
      .mockResolvedValueOnce('om-1')
      .mockResolvedValueOnce('om-2')
      .mockResolvedValueOnce('om-3'),
    recordLink: jest.fn(() => 'https://example.feishu.cn/base/PUBLIC_EXAMPLE_SOURCE'),
  };
  const store = {
    find: jest.fn(async (_appToken: string, _tableId: string, key: string) =>
      logs.get(key),
    ),
    claim: jest.fn(async (_appToken: string, _tableId: string, input: any) => {
      const current = logs.get(input.idempotencyKey);
      const value = {
        recordId: current?.recordId || `log-${logs.size + 1}`,
        idempotencyKey: input.idempotencyKey,
        code: input.code,
        sourceRecordId: input.sourceRecordId,
        targetRecordId: current?.targetRecordId || '',
        messageState: current?.messageState || {},
        stage: current?.stage || '处理中',
        attempts: (current?.attempts || 0) + 1,
        selfTest: false,
      };
      logs.set(input.idempotencyKey, value);
      return value;
    }),
    update: jest.fn(async (_appToken: string, _tableId: string, value: any) => {
      const current = logs.get(value.idempotencyKey);
      const next = { ...current, ...value };
      logs.set(value.idempotencyKey, next);
      return next;
    }),
    listRecent: jest.fn().mockResolvedValue([]),
    delete: jest.fn(),
  };
  const service = new InventoryWorkflowService(gateway as never, store as never);
  return { gateway, store, service, logs };
}

describe('InventoryWorkflowService', () => {
  it('creates inbound, updates purchase, then sends H notifications and stays idempotent', async () => {
    const { gateway, store, service } = createHarness();
    gateway.listRecords.mockResolvedValue([purchase]);

    const first = await service.run('purchase_h', { trigger: 'manual' });
    const second = await service.run('purchase_h', { trigger: 'manual' });

    expect(first).toMatchObject({ processed: 1, failed: 0, notified: 2 });
    expect(second).toMatchObject({ processed: 0, skipped: 1, failed: 0 });
    expect(gateway.createRecord).toHaveBeenCalledTimes(1);
    expect(gateway.createRecord).toHaveBeenCalledWith(
      'app-token',
      'tbl-inbound',
      expect.objectContaining({
        楼栋: 'H楼',
        物品类别号: 'SKU-001',
        入库数量: 2,
      }),
      '入库填写',
    );
    expect(gateway.updateRecord).toHaveBeenCalledWith(
      'app-token',
      'tbl-purchase',
      'rec-purchase',
      { 是否已入库: true },
      '【引用】采购管理',
    );
    expect(gateway.sendInteractiveCard).toHaveBeenCalledTimes(2);
    expect(store.update.mock.calls.map((call) => call[2].stage)).toEqual(
      expect.arrayContaining(['业务已写入', '源记录已回写', '已完成']),
    );
  });

  it('resumes notifications without resending recipients already recorded', async () => {
    const { gateway, service, logs } = createHarness();
    logs.set('purchase_h:rec-purchase:H楼', {
      recordId: 'log-existing',
      idempotencyKey: 'purchase_h:rec-purchase:H楼',
      code: 'purchase_h',
      sourceRecordId: 'rec-purchase',
      targetRecordId: 'rec-inbound',
      stage: '源记录已回写',
      attempts: 1,
      messageState: {
        ou_9c63b3e37ad95f93afe98d98514ed0ab: 'om-existing',
      },
    });
    gateway.listRecords.mockResolvedValue([purchase]);

    const result = await service.run('purchase_h', { trigger: 'retry' });

    expect(result).toMatchObject({ processed: 1, failed: 0, notified: 1 });
    expect(gateway.createRecord).not.toHaveBeenCalled();
    expect(gateway.updateRecord).not.toHaveBeenCalled();
    expect(gateway.sendInteractiveCard).toHaveBeenCalledTimes(1);
    expect(gateway.sendInteractiveCard).toHaveBeenCalledWith(
      'PUBLIC_EXAMPLE_FEISHU_ACCESS_INVENTORY_ADMIN_H_OPEN_IDS',
      expect.any(Object),
    );
  });

  it('does not claim or update a backfill purchase when the SKU already has inbound records', async () => {
    const { gateway, store, service } = createHarness();
    gateway.listRecords
      .mockResolvedValueOnce([
        { ...purchase, fields: { ...purchase.fields, 采购完成: false } },
      ])
      .mockResolvedValueOnce([
        { record_id: 'rec-existing-inbound', fields: { 物品类别号: 'SKU-001' } },
      ]);

    const result = await service.run('purchase_backfill', { trigger: 'schedule' });

    expect(result).toMatchObject({ processed: 0, skipped: 1, failed: 0 });
    expect(store.claim).not.toHaveBeenCalled();
    expect(gateway.createRecord).not.toHaveBeenCalled();
    expect(gateway.updateRecord).not.toHaveBeenCalled();
  });

  it('sends item confirmation with the original three form buttons', async () => {
    const { gateway, service } = createHarness();
    gateway.listRecords.mockResolvedValue([
      {
        record_id: 'rec-outbound',
        fields: {
          是否借出本楼栋: ['是'],
          应入库管理员: [{ id: 'ou_receiver', name: '接收人' }],
        },
      },
    ]);

    const result = await service.run('item_confirmation', { trigger: 'poll' });

    expect(result).toMatchObject({ processed: 1, notified: 1, failed: 0 });
    const card = gateway.sendInteractiveCard.mock.calls[0][1];
    expect(JSON.stringify(card)).toContain('物品确认');
    expect(JSON.stringify(card)).toContain('入库');
    expect(JSON.stringify(card)).toContain('借调');
    expect(JSON.stringify(card)).toContain('出库');
    expect(JSON.stringify(card)).toContain(
      'https://example.feishu.cn/share/PUBLIC_EXAMPLE_SOURCE',
    );
  });
});
