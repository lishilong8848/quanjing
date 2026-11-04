import { buildPurchaseLifecycleCard } from '../../server/modules/purchase-inventory/purchase-lifecycle-card';
import { projectPurchaseLifecycle, type PurchaseLifecycleProjectedItem } from '../../server/modules/purchase-inventory/purchase-lifecycle-projection';

const approvalBatchId = 'purchase-application-123';
const binding = (recordId: string, action: 'order' | 'receive' = 'order') => ({
  version: 4, workflowType: 'purchase_batch_fulfillment',
  role: action === 'order' ? 'purchaser' : 'requester',
  action: action === 'order' ? 'open_order' : 'open_receipt',
  approvalBatchId: 'purchase-application-123', executionRecordId: recordId,
});

describe('purchase lifecycle card from authorized projections', () => {
  it('renders only projected stages, with plain text and permitted image nodes', () => {
    const item = {
      recordId: 'record1', currentStage: 'ordering', actions: [],
      stages: [{ stage: 'application', fields: [
        { label: '物品', value: '<b>仅文本</b>' },
        { label: '比价单说明', value: '已提供三家报价' },
        { label: '附件令牌', value: 'file_secret' },
        { label: '备注', value: 'https://example.invalid/private' },
      ], images: [{ imageKey: 'img_v3_abc-123', alt: '比价图片' }] }],
    } as PurchaseLifecycleProjectedItem;
    const card = buildPurchaseLifecycleCard({ approvalBatchId, items: [item], observer: false });
    const serialized = JSON.stringify(card);
    expect(card).toMatchObject({ schema: '2.0', config: { update_multi: true, enable_forward: false } });
    expect(serialized).toContain('仅文本');
    expect(serialized).toContain('比价单说明');
    expect(serialized).toContain('已提供三家报价');
    expect(serialized).toContain('"tag":"plain_text"');
    expect(serialized).toContain('"tag":"img"');
    expect(serialized).toContain('img_v3_abc-123');
    expect(serialized).not.toContain('file_secret');
    expect(serialized).not.toContain('example.invalid');
  });

  it('never calls a resolver or emits buttons for observers', () => {
    const resolver = jest.fn(() => binding('record1'));
    const item: PurchaseLifecycleProjectedItem = { recordId: 'record1', currentStage: 'ordering', stages: [], actions: ['order'] };
    const card = JSON.stringify(buildPurchaseLifecycleCard({ approvalBatchId, items: [item], observer: true, resolveCallback: resolver }));
    expect(card).not.toContain('"tag":"button"');
    expect(card).toContain('只读抄送 · 不可操作');
    expect(resolver).not.toHaveBeenCalled();
  });

  it('requires an exact existing callback matching this record, role, action and current stage', () => {
    const item: PurchaseLifecycleProjectedItem = { recordId: 'record1', currentStage: 'ordering', stages: [], actions: ['order', 'receive'] };
    const allowed = buildPurchaseLifecycleCard({ approvalBatchId, items: [item], observer: false, resolveCallback: () => binding('record1') });
    expect(JSON.stringify(allowed)).toContain('open_order');
    for (const callback of [binding('other'), { ...binding('record1'), approvalBatchId: 'purchase-application-other' }, { ...binding('record1'), role: 'requester' }, { ...binding('record1'), leaked: 'secret' }, undefined]) {
      const result = buildPurchaseLifecycleCard({ approvalBatchId, items: [item], observer: false, resolveCallback: () => callback });
      expect(JSON.stringify(result)).not.toContain('"tag":"button"');
    }
    const wrongStage = { ...item, currentStage: 'receipt' as const, actions: ['order' as const] };
    expect(JSON.stringify(buildPurchaseLifecycleCard({ approvalBatchId, items: [wrongStage], observer: false, resolveCallback: () => binding('record1') }))).not.toContain('"tag":"button"');
  });

  it('does not invent whole-batch approval or inbound callbacks', () => {
    const item: PurchaseLifecycleProjectedItem = { recordId: 'record1', currentStage: 'application', stages: [], actions: ['approve'] };
    const callback = { version: 3, action: 'approve_pending_comprehensive', approvalBatchId: 'purchase-application-123' };
    expect(JSON.stringify(buildPurchaseLifecycleCard({ approvalBatchId, items: [item], observer: false, resolveCallback: () => callback }))).not.toContain('"tag":"button"');
  });

  it('rejects unsafe image identifiers and oversized card payloads', () => {
    const item = { recordId: 'record1', currentStage: 'application', stages: [{ stage: 'application', fields: [], images: [{ imageKey: 'https://bad.invalid/file', alt: 'x' }] }], actions: [] } as PurchaseLifecycleProjectedItem;
    expect(() => buildPurchaseLifecycleCard({ approvalBatchId, items: [item], observer: true })).toThrow('图片标识无效');
    const many: PurchaseLifecycleProjectedItem[] = Array.from({ length: 201 }, (_, i) => ({ recordId: `record${i}`, currentStage: null, stages: [], actions: [] }));
    expect(() => buildPurchaseLifecycleCard({ approvalBatchId, items: many, observer: true })).toThrow('组件数量超限');
    expect(() => buildPurchaseLifecycleCard({ approvalBatchId: 'bad', items: [], observer: true })).toThrow('批次标识无效');
  });

  it('merges stage text and deduplicates images while preserving 20 records and actions', () => {
    const stages = ['application', 'approval', 'ordering', 'receipt', 'inbound'] as const;
    const items: PurchaseLifecycleProjectedItem[] = Array.from({ length: 20 }, (_, index) => ({
      recordId: `record${index}`, currentStage: 'ordering', actions: ['order'],
      stages: stages.map(stage => ({ stage, fields: [{ label: stage, value: `明细${index}` }],
        images: Array.from({ length: 5 }, (_, image) => ({ imageKey: `img_${index}_${image}`, alt: `明细${index}图${image}` })) })),
    }));
    const card = buildPurchaseLifecycleCard({ approvalBatchId, items, observer: false, resolveCallback: record => binding(record) });
    const elements = (card.body as { elements: Array<{ tag: string; img_key?: string }> }).elements;
    expect(elements.filter(x => x.tag === 'div')).toHaveLength(20);
    expect(elements.filter(x => x.tag === 'img')).toHaveLength(100);
    expect(elements.filter(x => x.tag === 'button')).toHaveLength(20);
    expect(new Set(elements.filter(x => x.tag === 'img').map(x => x.img_key)).size).toBe(100);
    expect(JSON.stringify(card)).toContain('相关图片序号：1、2、3、4、5');
    expect(Buffer.byteLength(JSON.stringify(card), 'utf8')).toBeLessThanOrEqual(30 * 1024);
  });

  it('reports the 30KB limit without silently dropping content', () => {
    const items: PurchaseLifecycleProjectedItem[] = Array.from({ length: 20 }, (_, index) => ({
      recordId: `record${index}`, currentStage: 'ordering', actions: [],
      stages: [{ stage: 'ordering', fields: [{ label: '说明', value: '甲'.repeat(1000) }] }],
    }));
    expect(() => buildPurchaseLifecycleCard({ approvalBatchId, items, observer: false })).toThrow('超过飞书 30KB 限制');
  });

  it('does not restore stages removed by the authorization projection', () => {
    const items = projectPurchaseLifecycle([{ recordId: 'record1', status: '审批通过（待下单）', stages: [
      { stage: 'application', fields: [{ label: '申请', value: '允许查看' }] },
      { stage: 'ordering', fields: [{ label: '金额', value: '秘密金额' }] },
    ] }], { kind: 'participant', grants: [{ recordId: 'record1', visibleStages: ['application'], allowedActions: ['order'] }] });
    const value = JSON.stringify(buildPurchaseLifecycleCard({ approvalBatchId, items, observer: false, resolveCallback: () => binding('record1') }));
    expect(value).toContain('允许查看');
    expect(value).not.toContain('秘密金额');
    expect(value).not.toContain('"tag":"button"');
  });
});
