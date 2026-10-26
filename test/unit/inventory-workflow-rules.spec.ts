import {
  buildPurchaseAutomationAction,
  extractOpenIds,
  isItemConfirmationCandidate,
  isPurchaseBackfillCandidate,
} from '../../server/modules/inventory-management/inventory-workflow.rules';

const purchaseRecord = (
  fields: Record<string, unknown> = {},
) => ({
  record_id: 'rec-purchase-1',
  fields: {
    物品类别码: 'SKU-001',
    申请楼栋: ['H楼'],
    实际采购数量: 3,
    签收时间: 1783699200000,
    是否已入库: false,
    采购完成: true,
    '1️⃣物品采购方式': '综合采购',
    采购到货入库后是否需要立即领用出库: true,
    需求人: [{ id: 'ou_requester', name: '测试人' }],
    ...fields,
  },
});

describe('inventory workflow rules', () => {
  it('matches the backfill workflow without adding purchase-complete or rejection conditions', () => {
    expect(
      isPurchaseBackfillCandidate(
        purchaseRecord({ 采购完成: false, '1️⃣物品采购方式': '驳回' }),
      ),
    ).toBe(true);
    expect(isPurchaseBackfillCandidate(purchaseRecord({ 签收时间: null }))).toBe(
      false,
    );
    expect(
      isPurchaseBackfillCandidate(purchaseRecord({ 是否已入库: true })),
    ).toBe(false);
  });

  it('maps the H-building purchase exactly and keeps its original recipients', () => {
    const action = buildPurchaseAutomationAction('purchase_h', purchaseRecord());

    expect(action).toEqual({
      building: 'H楼',
      inboundFields: {
        楼栋: 'H楼',
        物品类别号: 'SKU-001',
        入库数量: 3,
        入库日期: 1783699200000,
        '采购入库后是否需要即可领用出库（勿点）': true,
      },
      recipients: [
        'ou_9c63b3e37ad95f93afe98d98514ed0ab',
        'PUBLIC_EXAMPLE_FEISHU_ACCESS_INVENTORY_ADMIN_H_OPEN_IDS',
      ],
      detailButton: false,
    });
  });

  it('forces the A-building immediate-outbound flag to false and excludes two requesters', () => {
    const action = buildPurchaseAutomationAction(
      'purchase_abcde',
      purchaseRecord({ 申请楼栋: ['A楼'] }),
    );

    expect(action?.inboundFields).toMatchObject({
      楼栋: 'A楼',
      '采购入库后是否需要即可领用出库（勿点）': false,
    });
    expect(action?.recipients).toEqual([
      'ou_9c63b3e37ad95f93afe98d98514ed0ab',
      'PUBLIC_EXAMPLE_FEISHU_ACCESS_BUILDING_ADMIN_A_OPEN_IDS',
      'ou_b4fe57da4d5fd0420c31dcbbebdc855e',
    ]);
    expect(action?.detailButton).toBe(true);

    expect(
      buildPurchaseAutomationAction(
        'purchase_abcde',
        purchaseRecord({
          申请楼栋: ['A楼'],
          需求人: [{ id: 'ou_d22c6190a18a9d6df49fa72565e120f7' }],
        }),
      ),
    ).toBeNull();
    expect(
      buildPurchaseAutomationAction(
        'purchase_abcde',
        purchaseRecord({
          申请楼栋: ['E楼'],
          需求人: [{ id: 'PUBLIC_EXAMPLE_FEISHU_ACCESS_CONSTRUCTION_ADMIN_OPEN_IDS' }],
        }),
      ),
    ).toBeNull();
  });

  it('uses the source immediate-outbound flag for B-E and rejects invalid purchase states', () => {
    const action = buildPurchaseAutomationAction(
      'purchase_abcde',
      purchaseRecord({ 申请楼栋: ['D楼'] }),
    );
    expect(action?.inboundFields).toMatchObject({
      楼栋: 'D楼',
      '采购入库后是否需要即可领用出库（勿点）': true,
    });
    expect(action?.recipients).toEqual([
      'ou_9c63b3e37ad95f93afe98d98514ed0ab',
      'PUBLIC_EXAMPLE_FEISHU_ACCESS_BUILDING_ADMIN_D_OPEN_IDS',
    ]);

    expect(
      buildPurchaseAutomationAction(
        'purchase_abcde',
        purchaseRecord({ '1️⃣物品采购方式': '驳回' }),
      ),
    ).toBeNull();
    expect(
      buildPurchaseAutomationAction(
        'purchase_h',
        purchaseRecord({ 采购完成: false }),
      ),
    ).toBeNull();
  });

  it('matches item confirmation only for cross-building records and extracts lookup OpenIDs', () => {
    expect(
      isItemConfirmationCandidate({
        record_id: 'rec-outbound-1',
        fields: { 是否借出本楼栋: '是' },
      }),
    ).toBe(true);
    expect(
      isItemConfirmationCandidate({
        record_id: 'rec-outbound-2',
        fields: { 是否借出本楼栋: ['否'] },
      }),
    ).toBe(false);

    expect(
      extractOpenIds([
        { id: 'ou_one', name: '一号' },
        { value: [{ open_id: 'ou_two' }] },
        'ou_three',
        { id: 'not-an-open-id' },
      ]),
    ).toEqual(['ou_one', 'ou_two', 'ou_three']);
  });
});
