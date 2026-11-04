import {
  projectPurchaseLifecycle,
  type PurchaseLifecycleItem,
} from '../../server/modules/purchase-inventory/purchase-lifecycle-projection';

const items: PurchaseLifecycleItem[] = [
  {
    recordId: 'a',
    status: '未开始（待审批）',
    stages: [
      { stage: 'application', fields: [{ label: '申请', value: '申请明细 A' }], images: [{ imageKey: 'img_comparison_a', alt: '比价单' }] },
      { stage: 'ordering', fields: [{ label: '报价', value: '采购价格 A' }] },
    ],
  },
  {
    recordId: 'b',
    status: '审批通过（待下单）',
    stages: [
      { stage: 'application', fields: [{ label: '申请', value: '申请明细 B' }] },
      { stage: 'ordering', fields: [{ label: '报价', value: '采购价格 B' }] },
    ],
  },
  {
    recordId: 'c',
    status: '到货已签收（待入库）',
    stages: [{ stage: 'inbound', fields: [{ label: '入库', value: '仓库 C' }] }],
  },
];

describe('purchase lifecycle least-privilege projection', () => {
  it('denies records and actions with no grant', () => {
    expect(projectPurchaseLifecycle(items, { kind: 'participant', grants: [] })).toEqual([]);
  });

  it('keeps independent stages and actions for different records and a multi-role actor', () => {
    const result = projectPurchaseLifecycle(items, {
      kind: 'participant',
      grants: [
        { recordId: 'a', visibleStages: ['application'], allowedActions: ['approve', 'order'] },
        { recordId: 'b', visibleStages: ['ordering'], allowedActions: ['approve', 'order', 'order'] },
        { recordId: 'c', visibleStages: ['inbound'], allowedActions: ['inbound'] },
      ],
    });
    expect(result.map(({ recordId, currentStage, actions }) => ({ recordId, currentStage, actions }))).toEqual([
      { recordId: 'a', currentStage: 'application', actions: ['approve'] },
      { recordId: 'b', currentStage: 'ordering', actions: ['order'] },
      { recordId: 'c', currentStage: 'inbound', actions: ['inbound'] },
    ]);
    expect(JSON.stringify(result)).not.toContain('采购价格 A');
    expect(JSON.stringify(result)).not.toContain('申请明细 B');
  });

  it('does not expose current stage or actionable data when only an earlier stage is visible', () => {
    const result = projectPurchaseLifecycle([items[1]], {
      kind: 'participant',
      grants: [{ recordId: 'b', visibleStages: ['application'], allowedActions: ['order'] }],
    });
    expect(result).toEqual([{ recordId: 'b', currentStage: null, stages: [items[1].stages[0]], actions: [] }]);
    expect(JSON.stringify(result)).not.toContain('采购价格 B');
    expect(JSON.stringify(result)).not.toContain('ordering');
  });

  it('observers can see all stage content but have no action', () => {
    const result = projectPurchaseLifecycle(items, { kind: 'observer' });
    expect(result).toHaveLength(3);
    expect(result.every((item) => item.actions.length === 0)).toBe(true);
    expect(JSON.stringify(result)).toContain('采购价格 A');
    expect(result[0].stages[0].images).toEqual([{ imageKey: 'img_comparison_a', alt: '比价单' }]);
    expect(result.map((item) => item.currentStage)).toEqual(['application', 'ordering', 'inbound']);
  });

  it('only returns image keys for stages the recipient may view', () => {
    const approved = projectPurchaseLifecycle([items[0]], {
      kind: 'participant', grants: [{ recordId: 'a', visibleStages: ['application'], allowedActions: [] }],
    });
    expect(approved[0].stages[0].images).toEqual([{ imageKey: 'img_comparison_a', alt: '比价单' }]);
    const denied = projectPurchaseLifecycle([items[0]], {
      kind: 'participant', grants: [{ recordId: 'a', visibleStages: ['ordering'], allowedActions: [] }],
    });
    expect(JSON.stringify(denied)).not.toContain('img_comparison_a');
  });

  it('does not allow unknown, rejected or completed stages to execute operations', () => {
    for (const [status, stage] of [['未知状态', 'unknown'], ['驳回申请', 'terminated'], ['采购完成（已入库）', 'completed']] as const) {
      const result = projectPurchaseLifecycle([{ recordId: 'x', status, stages: [] }], {
        kind: 'participant', grants: [{ recordId: 'x', visibleStages: [stage], allowedActions: ['approve', 'start', 'order', 'receive', 'inbound'] }],
      });
      expect(result[0].currentStage).toBe(stage);
      expect(result[0].actions).toEqual([]);
    }
  });

  it('treats both signed-for pending-inbound statuses as inbound', () => {
    for (const status of ['物品签收（待入库）', '到货已签收（待入库）']) {
      const result = projectPurchaseLifecycle([{ recordId: 'x', status, stages: [] }], {
        kind: 'participant', grants: [{ recordId: 'x', visibleStages: ['inbound'], allowedActions: ['inbound'] }],
      });
      expect(result[0]).toMatchObject({ currentStage: 'inbound', actions: ['inbound'] });
    }
  });

  it('rejects duplicate records and ambiguous grants rather than merging permissions', () => {
    expect(() => projectPurchaseLifecycle([items[0], items[0]], { kind: 'observer' })).toThrow();
    const grant = { recordId: 'a', visibleStages: ['application'] as const, allowedActions: ['approve'] as const };
    expect(() => projectPurchaseLifecycle(items, { kind: 'participant', grants: [grant, grant] })).toThrow();
  });

  it('detaches permitted data from the original input', () => {
    const result = projectPurchaseLifecycle([items[0]], { kind: 'observer' });
    result[0].stages[0].fields[0].value = 'changed';
    result[0].stages[0].images![0].imageKey = 'changed';
    expect(items[0].stages[0].fields[0].value).toBe('申请明细 A');
    expect(items[0].stages[0].images![0].imageKey).toBe('img_comparison_a');
  });
});
