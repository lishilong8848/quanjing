import { buildPurchaseLifecycleCard, buildPurchaseLifecycleCardPage } from '../../server/modules/purchase-inventory/purchase-lifecycle-card';
import { projectPurchaseLifecycle, type PurchaseLifecycleProjectedItem } from '../../server/modules/purchase-inventory/purchase-lifecycle-projection';
import { parsePurchaseCardCallback } from '../../server/modules/purchase-inventory/purchase-workflow-callback';

const approvalBatchId = 'purchase-application-123';
const binding = (recordId: string, action: 'order' | 'receive' = 'order') => ({
  version: 4, workflowType: 'purchase_batch_fulfillment',
  role: action === 'order' ? 'purchaser' : 'requester',
  action: action === 'order' ? 'open_order' : 'open_receipt',
  approvalBatchId: 'purchase-application-123', executionRecordId: recordId,
});

describe('purchase lifecycle card from authorized projections', () => {
  it('only shows the configured in-site inbound link for the authorized active inbound duty', () => {
    const item: PurchaseLifecycleProjectedItem = { recordId: 'record1', currentStage: 'inbound', stages: [], actions: ['inbound'] };
    const render = (items: PurchaseLifecycleProjectedItem[], observer = false) => JSON.stringify(buildPurchaseLifecycleCard({ cardRevision: 1, approvalBatchId, items, observer, attachmentBaseUrl: 'https://portal.example/' }));
    expect(render([item])).toContain('https://portal.example/inventory-management?view=inbound&amp;purchase=record1'.replace('&amp;', '&'));
    expect(render([{ ...item, actions: [] }])).not.toContain('打开库存管理并入库');
    expect(render([item], true)).not.toContain('打开库存管理并入库');
    expect(render([{ ...item, currentStage: 'completed' }])).not.toContain('打开库存管理并入库');
    expect(() => buildPurchaseLifecycleCard({ cardRevision: 1, approvalBatchId, items: [item], observer: false, attachmentBaseUrl: 'https://user:pass@evil.example/' })).toThrow();
  });
  it('adds only stage-authorized attachment links, bound to generation and without file identifiers', () => {
    const items = [{ recordId: 'record1', status: '未开始（待审批）', stages: [
      { stage: 'application' as const, fields: [], attachments: [{ purpose: 'comparison' as const, index: 0 }] },
      { stage: 'ordering' as const, fields: [], attachments: [{ purpose: 'payment' as const, index: 0 }] },
    ] }];
    const projected = projectPurchaseLifecycle(items, { kind: 'participant', grants: [{ recordId: 'record1', visibleStages: ['application'], allowedActions: [] }] });
    const card = JSON.stringify(buildPurchaseLifecycleCard({ cardRevision: 1, approvalBatchId, items: projected, observer: false, attachmentBaseUrl: 'https://portal.example/', generation: 2 }));
    expect(card).toContain('purpose=comparison');
    expect(card).toContain('generation=2');
    expect(card).not.toContain('purpose=payment');
    expect(card).not.toContain('file_token');
    expect(() => buildPurchaseLifecycleCard({ cardRevision: 1, approvalBatchId, items: projected, observer: false, attachmentBaseUrl: 'https://user:pass@evil.example/', generation: 2 })).toThrow();
  });
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
    const card = buildPurchaseLifecycleCard({ cardRevision: 1, approvalBatchId, items: [item], observer: false });
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
    const card = JSON.stringify(buildPurchaseLifecycleCard({ cardRevision: 1, approvalBatchId, items: [item], observer: true, resolveCallback: resolver }));
    expect(card).not.toContain('"tag":"button"');
    expect(card).toContain('只读抄送 · 不可操作');
    expect(resolver).not.toHaveBeenCalled();
  });

  it('requires an exact existing callback matching this record, role, action and current stage', () => {
    const item: PurchaseLifecycleProjectedItem = { recordId: 'record1', currentStage: 'ordering', stages: [], actions: ['order', 'receive'] };
    const allowed = buildPurchaseLifecycleCard({ cardRevision: 1, approvalBatchId, items: [item], observer: false, resolveCallback: () => binding('record1') });
    expect(JSON.stringify(allowed)).toContain('open_order');
    for (const callback of [binding('other'), { ...binding('record1'), approvalBatchId: 'purchase-application-other' }, { ...binding('record1'), role: 'requester' }, { ...binding('record1'), leaked: 'secret' }, undefined]) {
      const result = buildPurchaseLifecycleCard({ cardRevision: 1, approvalBatchId, items: [item], observer: false, resolveCallback: () => callback });
      expect(JSON.stringify(result)).not.toContain('"tag":"button"');
    }
    const wrongStage = { ...item, currentStage: 'receipt' as const, actions: ['order' as const] };
    expect(JSON.stringify(buildPurchaseLifecycleCard({ cardRevision: 1, approvalBatchId, items: [wrongStage], observer: false, resolveCallback: () => binding('record1') }))).not.toContain('"tag":"button"');
  });

  it('does not invent whole-batch approval or inbound callbacks', () => {
    const item: PurchaseLifecycleProjectedItem = { recordId: 'record1', currentStage: 'application', stages: [], actions: ['approve'] };
    const callback = { version: 3, action: 'approve_pending_comprehensive', approvalBatchId: 'purchase-application-123' };
    expect(JSON.stringify(buildPurchaseLifecycleCard({ cardRevision: 1, approvalBatchId, items: [item], observer: false, resolveCallback: () => callback }))).not.toContain('"tag":"button"');
  });

  it('shows batch approval only when the complete pending set is explicitly authorized', () => {
    const items: PurchaseLifecycleProjectedItem[] = ['rec1', 'rec2'].map(recordId => ({
      recordId, currentStage: 'application', stages: [], actions: ['approve'],
    }));
    const manager = (action: string, recordId?: string) => ({ version: 3, action, approvalBatchId,
      ...(recordId ? { executionRecordId: recordId } : {}) });
    const complete = { pendingRecordIds: ['rec1', 'rec2'], authorizedPendingRecordIds: ['rec1', 'rec2'], building: 'A楼' };
    const value = JSON.stringify(buildPurchaseLifecycleCard({ cardRevision: 1, approvalBatchId, items, observer: false, batchApprovalProof: complete, resolveManagerCallback: manager }));
    expect(value).toContain('approve_pending_comprehensive');
    expect(value).toContain('approve_pending_building_self');
    expect(value.match(/open_item_reject/g)).toHaveLength(2);
    expect(value).toContain('"executionRecordId":"rec1"');
    expect(value).toContain('"executionRecordId":"rec2"');
    const hBuilding = JSON.stringify(buildPurchaseLifecycleCard({ cardRevision: 1, approvalBatchId, items, observer: false,
      batchApprovalProof: { ...complete, building: 'H楼' }, resolveManagerCallback: manager }));
    expect(hBuilding).toContain('approve_pending_comprehensive');
    expect(hBuilding).not.toContain('approve_pending_building_self');
    const observer = JSON.stringify(buildPurchaseLifecycleCard({ cardRevision: 1, approvalBatchId, items, observer: true, batchApprovalProof: complete, resolveManagerCallback: manager }));
    expect(observer).not.toContain('"tag":"button"');
  });

  it('denies batch buttons for partial authorization, hidden pending items, malformed or missing proof', () => {
    const items: PurchaseLifecycleProjectedItem[] = [{ recordId: 'rec1', currentStage: 'application', stages: [], actions: ['approve'] }];
    const manager = (action: string, recordId?: string) => ({ version: 3, action, approvalBatchId,
      ...(recordId ? { executionRecordId: recordId } : {}) });
    const proofs = [
      undefined,
      { pendingRecordIds: ['rec1', 'rec2'], authorizedPendingRecordIds: ['rec1'], building: 'A楼' },
      { pendingRecordIds: ['rec1', 'rec2'], authorizedPendingRecordIds: ['rec1', 'rec2'], building: 'A楼' },
      { pendingRecordIds: ['rec1', 'rec1'], authorizedPendingRecordIds: ['rec1'], building: 'A楼' },
      { pendingRecordIds: ['rec1'], authorizedPendingRecordIds: ['rec1'], building: '' },
    ];
    for (const proof of proofs) {
      const value = JSON.stringify(buildPurchaseLifecycleCard({ cardRevision: 1, approvalBatchId, items, observer: false, batchApprovalProof: proof, resolveManagerCallback: manager }));
      expect(value).not.toContain('approve_pending_comprehensive');
      expect(value).not.toContain('approve_pending_building_self');
      expect(value).toContain('open_item_reject');
    }
    const forbidden = [{ ...items[0], actions: [] }];
    const value = JSON.stringify(buildPurchaseLifecycleCard({ cardRevision: 1, approvalBatchId, items: forbidden, observer: false,
      batchApprovalProof: { pendingRecordIds: ['rec1'], authorizedPendingRecordIds: ['rec1'], building: 'A楼' }, resolveManagerCallback: manager }));
    expect(value).not.toContain('"tag":"button"');
  });

  it('rejects forged manager callbacks and duplicate projected items', () => {
    const item: PurchaseLifecycleProjectedItem = { recordId: 'rec1', currentStage: 'application', stages: [], actions: ['approve'] };
    const proof = { pendingRecordIds: ['rec1'], authorizedPendingRecordIds: ['rec1'], building: 'A楼' };
    for (const resolver of [
      (action: string, recordId?: string) => ({ version: 3, action, approvalBatchId: 'other-batch', ...(recordId ? { executionRecordId: recordId } : {}) }),
      (action: string, recordId?: string) => ({ version: 3, action, approvalBatchId, ...(recordId ? { executionRecordId: 'other-record' } : {}), leaked: 'x' }),
      (action: string) => ({ version: 4, action, approvalBatchId }),
    ]) {
      expect(JSON.stringify(buildPurchaseLifecycleCard({ cardRevision: 1, approvalBatchId, items: [item], observer: false, batchApprovalProof: proof, resolveManagerCallback: resolver }))).not.toContain('"tag":"button"');
    }
    expect(() => buildPurchaseLifecycleCard({ cardRevision: 1, approvalBatchId, items: [item, item], observer: false })).toThrow('明细重复');
  });

  it('emits manager callbacks accepted by the existing parser', () => {
    const item: PurchaseLifecycleProjectedItem = { recordId: 'rec1', currentStage: 'application', stages: [], actions: ['approve'] };
    const manager = (action: string, recordId?: string) => ({ version: 3, action, approvalBatchId,
      ...(recordId ? { executionRecordId: recordId } : {}) });
    const card = buildPurchaseLifecycleCard({ cardRevision: 1, approvalBatchId, items: [item], observer: false,
      batchApprovalProof: { pendingRecordIds: ['rec1'], authorizedPendingRecordIds: ['rec1'], building: 'H楼' }, resolveManagerCallback: manager });
    const elements = (card.body as { elements: Array<{ tag: string; behaviors?: Array<{ value: Record<string, unknown> }> }> }).elements;
    const buttons = elements.filter(element => element.tag === 'button');
    expect(buttons).toHaveLength(3);
    for (const button of buttons) {
      const value = button.behaviors![0].value;
      const payload = { schema: '2.0', header: { event_id: 'evt_01', event_type: 'card.action.trigger', token: 'test-token' },
        event: { operator: { open_id: 'ou_manager_01' }, context: { open_message_id: 'om_card_01' }, action: { tag: 'button', value } } };
      expect(parsePurchaseCardCallback({ headers: {}, rawBody: JSON.stringify(payload), now: new Date('2026-11-04T00:00:00Z') }, {
        verificationToken: 'test-token', encryptKey: '', legacyApproverOpenIds: [], managerApproverOpenId: 'ou_manager_01',
      })).toMatchObject({ kind: 'manager_batch_action', action: value.action, approvalBatchId });
    }
  });

  it('rejects unsafe image identifiers and oversized card payloads', () => {
    const item = { recordId: 'record1', currentStage: 'application', stages: [{ stage: 'application', fields: [], images: [{ imageKey: 'https://bad.invalid/file', alt: 'x' }] }], actions: [] } as PurchaseLifecycleProjectedItem;
    expect(() => buildPurchaseLifecycleCard({ cardRevision: 1, approvalBatchId, items: [item], observer: true })).toThrow('图片标识无效');
    const many: PurchaseLifecycleProjectedItem[] = Array.from({ length: 201 }, (_, i) => ({ recordId: `record${i}`, currentStage: null, stages: [], actions: [] }));
    expect(() => buildPurchaseLifecycleCard({ cardRevision: 1, approvalBatchId, items: many, observer: true })).toThrow('组件数量超限');
    expect(() => buildPurchaseLifecycleCard({ cardRevision: 1, approvalBatchId: 'bad', items: [], observer: true })).toThrow('批次标识无效');
  });

  it('merges stage text and deduplicates images while preserving 20 records and actions', () => {
    const stages = ['application', 'approval', 'ordering', 'receipt', 'inbound'] as const;
    const items: PurchaseLifecycleProjectedItem[] = Array.from({ length: 20 }, (_, index) => ({
      recordId: `record${index}`, currentStage: 'ordering', actions: ['order'],
      stages: stages.map(stage => ({ stage, fields: [{ label: stage, value: `明细${index}` }],
        images: Array.from({ length: 5 }, (_, image) => ({ imageKey: `img_${index}_${image}`, alt: `明细${index}图${image}` })) })),
    }));
    const card = buildPurchaseLifecycleCard({ cardRevision: 1, approvalBatchId, items, observer: false, resolveCallback: record => binding(record) });
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
    expect(() => buildPurchaseLifecycleCard({ cardRevision: 1, approvalBatchId, items, observer: false })).toThrow('超过飞书 30KB 限制');
  });

  it('paginates the authorized content of a large batch without creating extra messages', () => {
    const stages = ['application', 'approval', 'ordering', 'receipt', 'inbound'] as const;
    const items: PurchaseLifecycleProjectedItem[] = Array.from({ length: 20 }, (_, index) => ({
      recordId: `record${index}`, currentStage: 'ordering', actions: ['order'],
      stages: stages.map((stage, stageIndex) => ({ stage, fields: [{ label: stage, value: `明细${index}` }],
        images: Array.from({ length: 5 }, (_, image) => ({ imageKey: `img_${index}_${stageIndex}_${image}`, alt: `图${image}` })) })),
    }));
    const input = { approvalBatchId, cardRevision: 4, items, observer: false, resolveCallback: (record: string) => binding(record) };
    const first = buildPurchaseLifecycleCardPage(input, 1);
    expect(first.pageInfo.totalPages).toBeGreaterThan(1);
    const imageKeys = new Set<string>();
    for (let page = 1; page <= first.pageInfo.totalPages; page += 1) {
      const result = buildPurchaseLifecycleCardPage(input, page);
      const elements = (result.card.body as { elements: Array<{ tag: string; img_key?: string }> }).elements;
      for (const element of elements) if (element.tag === 'img') imageKeys.add(element.img_key!);
      expect(Buffer.byteLength(JSON.stringify(result.card), 'utf8')).toBeLessThan(30 * 1024);
      const text = JSON.stringify(result.card);
      expect(text).toContain(`第 ${page}/${first.pageInfo.totalPages} 页`);
      expect(text).toContain('purchase_lifecycle_page');
      expect(text).toContain('"cardRevision":4');
    }
    expect(imageKeys.size).toBe(500);
    expect(() => buildPurchaseLifecycleCardPage(input, first.pageInfo.totalPages + 1)).toThrow();
  });

  it('splits a long authorized text block across safe pages without dropping content', () => {
    const payload = Array.from({ length: 18 }, (_, index) => ({ label: `字段${index}`, value: '甲'.repeat(1900) }));
    const items: PurchaseLifecycleProjectedItem[] = [{ recordId: 'record1', currentStage: 'application', actions: [], stages: [{ stage: 'application', fields: payload }] }];
    const input = { approvalBatchId, cardRevision: 1, items, observer: true };
    const first = buildPurchaseLifecycleCardPage(input, 1);
    expect(first.pageInfo.totalPages).toBeGreaterThan(1);
    const all = Array.from({ length: first.pageInfo.totalPages }, (_, i) => JSON.stringify(buildPurchaseLifecycleCardPage(input, i + 1).card)).join('');
    for (let index = 0; index < payload.length; index += 1) expect(all).toContain(`字段${index}`);
    expect((all.match(/甲/g) || []).length).toBe(18 * 1900);
  });

  it('does not restore stages removed by the authorization projection', () => {
    const items = projectPurchaseLifecycle([{ recordId: 'record1', status: '审批通过（待下单）', stages: [
      { stage: 'application', fields: [{ label: '申请', value: '允许查看' }] },
      { stage: 'ordering', fields: [{ label: '金额', value: '秘密金额' }] },
    ] }], { kind: 'participant', grants: [{ recordId: 'record1', visibleStages: ['application'], allowedActions: ['order'] }] });
    const value = JSON.stringify(buildPurchaseLifecycleCard({ cardRevision: 1, approvalBatchId, items, observer: false, resolveCallback: () => binding('record1') }));
    expect(value).toContain('允许查看');
    expect(value).not.toContain('秘密金额');
    expect(value).not.toContain('"tag":"button"');
  });
});
