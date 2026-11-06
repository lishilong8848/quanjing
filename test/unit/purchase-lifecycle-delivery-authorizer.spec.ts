import { PurchaseLifecycleServerAuthorizer } from '../../server/modules/purchase-inventory/purchase-lifecycle-delivery-authorizer';
import { createHash } from 'node:crypto';
import { projectPurchaseLifecycle } from '../../server/modules/purchase-inventory/purchase-lifecycle-projection';
import { buildPurchaseLifecycleCard } from '../../server/modules/purchase-inventory/purchase-lifecycle-card';
import type { PurchaseManagerApprovalBatchEntry } from '../../server/modules/purchase-inventory/purchase-workflow.store';
import type { PurchaseWorkflowRecord } from '../../shared/purchase-workflow.interface';

const identity = { appId: 'cli_test_app', batchId: 'purchase-batch-test', recipientOpenId: 'ou_manager' };
const record = { recordId: 'rec1', status: '未开始（待审批）', building: 'A楼', requestCode: 'CG1', itemName: '物品', requesterOpenId: 'ou_applicant', requesterName: '申请人', purchaserOpenId: 'ou_buyer', purchaserName: '采购人', purchaseMethod: '综合采购', requestedQuantity: 1, actualQuantity: 1, actualAmount: 123, receiptPhotoTokens: [], invoiceTokens: [] } as PurchaseWorkflowRecord;
const batch = { flowVersion: 'lifecycle_v1', approvalBatchId: identity.batchId, requesterOpenId: 'ou_applicant', recordIds: ['rec1'], state: 'active', managerDeliveries: [{ recipientOpenId: identity.recipientOpenId }], items: [{ executionRecordId: 'rec1', status: 'pending', purchaserOpenId: 'ou_buyer', choice: '' }] } as PurchaseManagerApprovalBatchEntry;
const batchFingerprint = createHash('sha256').update(JSON.stringify(batch)).digest('hex');

describe('purchase lifecycle server delivery authorization', () => {
  let revision: number, current: boolean, principal: any, duty: any, configured: any;
  let access: any, source: any;
  beforeEach(() => {
    revision = 1; current = true; principal = { role: 'admin', purchaseBuilding: null };
    duty = (kind: string) => kind === 'purchase_manager' ? [{ openId: identity.recipientOpenId }] : [];
    configured = { FEISHU_APP_ID: identity.appId };
    access = {
      snapshot: jest.fn(() => ({ revision })), feishuPrincipal: jest.fn(() => principal),
      currentDutyRoutePeople: jest.fn((kind: string) => duty(kind)), isCurrentReadonlyCardRecipient: jest.fn(() => true),
    };
    source = { load: jest.fn(async () => ({ version: 'source-1', batchFingerprint, records: [record], comparisonImages: { rec1: [{ imageKey: 'img_1', alt: '报价' }] } })), isLocallyValid: jest.fn(() => current), verifyLatest: jest.fn(async () => current) };
  });
  const create = () => new PurchaseLifecycleServerAuthorizer(access, source, () => configured, () => configured.FEISHU_APP_ID || '');

  it('uses configured current card duties for delivery when no rich personnel route exists', async () => {
    access.currentDutyMembers = jest.fn((kind: string) => duty(kind));
    access.currentDutyRoutePeople.mockReturnValue(null);
    const grant = await create().prepare(identity);
    grant.authorizeBatch(batch, 1);
    const projection = grant.project(batch, 1);
    expect(projectPurchaseLifecycle(projection.items, projection.viewer)[0].actions).toEqual(['approve']);
    expect(access.currentDutyMembers).toHaveBeenCalledWith('purchase_manager', { building: 'A楼' });
    expect(access.currentDutyRoutePeople).not.toHaveBeenCalled();
  });

  it('uses live principal, current duty and batch binding to limit stages and actions', async () => {
    const grant = await create().prepare(identity);
    grant.assertCurrent();
    grant.authorizeBatch(batch, 1);
    const projection = grant.project(batch, 1);
    const items = projectPurchaseLifecycle(projection.items, projection.viewer);
    expect(items[0].actions).toEqual(['approve']);
    expect(items[0].stages.map(s => s.stage)).toEqual(['application', 'approval']);
    expect(JSON.stringify(items)).not.toContain('实际金额');
    expect(JSON.stringify(items)).toContain('img_1');
    expect(projection.batchApprovalProof).toMatchObject({ pendingRecordIds: ['rec1'], authorizedPendingRecordIds: ['rec1'] });
    expect(projection.formPresentations).toEqual({ rec1: { reject: {} } });
    expect(access.feishuPrincipal).toHaveBeenCalledWith(identity.recipientOpenId, identity.appId);
    expect(access.currentDutyRoutePeople).toHaveBeenCalledWith('purchase_manager', { building: 'A楼' });
  });

  it('displays a confirmed platform rejection without inventing a reason or exposing an action', async () => {
    const rejected={...batch,items:[{...batch.items[0],status:'rejected',choice:'reject',rejectionReason:'',decisionSource:'platform'}]} as PurchaseManagerApprovalBatchEntry;
    source.load.mockResolvedValue({version:'source-1',batchFingerprint:createHash('sha256').update(JSON.stringify(rejected)).digest('hex'),records:[{...record,status:'驳回申请',purchaseMethod:'驳回',rejectionReason:''}],comparisonImages:{}});
    const view=(await create().prepare(identity)).project(rejected,2);
    const items=projectPurchaseLifecycle(view.items,view.viewer);
    expect(items[0].actions).toEqual([]);
    const fields=items[0].stages.find(stage=>stage.stage==='approval')!.fields;
    expect(fields).toContainEqual({label:'审批结果',value:'平台驳回'});
    expect(fields).toContainEqual({label:'驳回原因',value:''});
  });

  it('rejects absent identity, missing source fence or records that do not match the authoritative batch', async () => {
    principal = null;
    await expect(create().prepare(identity)).rejects.toThrow();
    principal = { role: 'admin', purchaseBuilding: null };
    current = false;
    const stale = await create().prepare(identity);
    expect(() => stale.authorizeBatch(batch, 1)).toThrow();
    current = true;
    const grant = await create().prepare(identity);
    expect(() => grant.authorizeBatch({ ...batch, recordIds: ['other'] }, 1)).toThrow();
    expect(() => grant.authorizeBatch({ ...batch, flowVersion: 'legacy' }, 1)).toThrow();
    expect(() => grant.authorizeBatch({ ...batch, items: [] }, 1)).toThrow();
  });

  it('revokes stale grants when access config, principal or source version changes', async () => {
    let grant = await create().prepare(identity);
    revision += 1;
    expect(() => grant.assertCurrent()).toThrow();
    grant = await create().prepare(identity);
    principal = { role: 'guest', purchaseBuilding: null };
    expect(() => grant.assertCurrent()).toThrow();
    grant = await create().prepare(identity);
    current = false;
    expect(() => grant.assertCurrent()).toThrow();
  });

  it('does not authorize manager actions without read permission or current manager duty', async () => {
    principal = { role: 'guest', purchaseBuilding: null };
    let grant = await create().prepare(identity);
    let projection = grant.project(batch, 1);
    expect(projectPurchaseLifecycle(projection.items, projection.viewer)).toEqual([]);
    principal = { role: 'admin', purchaseBuilding: null };
    duty = () => null;
    grant = await create().prepare(identity);
    projection = grant.project(batch, 1);
    expect(projectPurchaseLifecycle(projection.items, projection.viewer)).toEqual([]);
  });

  it('allows only configured and active observer identities full visibility without actions', async () => {
    configured = { FEISHU_APP_ID: identity.appId, FEISHU_CARD_READONLY_COPY_ENABLED: 'true', FEISHU_CARD_READONLY_COPY_APP_ID: identity.appId,
      FEISHU_CARD_READONLY_COPY_OPEN_ID: identity.recipientOpenId, FEISHU_CARD_READONLY_COPY_NAME: '李世龙' };
    duty = () => [];
    const grant = await create().prepare(identity);
    const projection = grant.project(batch, 1);
    expect(projection.viewer.kind).toBe('observer');
    expect(projection.formPresentations).toEqual({});
    expect(projectPurchaseLifecycle(projection.items, projection.viewer)[0].actions).toEqual([]);
    expect(JSON.stringify(projectPurchaseLifecycle(projection.items, projection.viewer))).toContain('实际金额');
    access.isCurrentReadonlyCardRecipient.mockReturnValue(false);
    expect(() => grant.assertCurrent()).toThrow();
  });

  it('permits an active configured observer without a platform principal only in read-only mode', async () => {
    configured = { FEISHU_APP_ID: identity.appId, FEISHU_CARD_READONLY_COPY_ENABLED: 'true', FEISHU_CARD_READONLY_COPY_APP_ID: identity.appId,
      FEISHU_CARD_READONLY_COPY_OPEN_ID: identity.recipientOpenId, FEISHU_CARD_READONLY_COPY_NAME: '李世龙' };
    principal = null;
    const grant = await create().prepare(identity);
    const projection = grant.project(batch, 1);
    expect(projection.viewer.kind).toBe('observer');
    expect(projectPurchaseLifecycle(projection.items, projection.viewer)[0].actions).toEqual([]);
    access.isCurrentReadonlyCardRecipient.mockReturnValue(false);
    expect(() => grant.assertCurrent()).toThrow();
    await expect(create().prepare(identity)).rejects.toThrow();
  });

  it('uses the canonical current app identity instead of a stale process environment app id', async () => {
    configured = { ...configured, FEISHU_APP_ID: 'cli_stale', FEISHU_CARD_READONLY_COPY_ENABLED: 'true', FEISHU_CARD_READONLY_COPY_APP_ID: identity.appId,
      FEISHU_CARD_READONLY_COPY_OPEN_ID: identity.recipientOpenId, FEISHU_CARD_READONLY_COPY_NAME: '李世龙' };
    principal = null;
    const authorizer = new PurchaseLifecycleServerAuthorizer(access, source, () => configured, () => identity.appId);
    const grant = await authorizer.prepare(identity);
    expect(grant.project(batch, 1).viewer.kind).toBe('observer');
    grant.assertCurrent();
  });

  it('allows a configured observer actual authorized duties without granting any extra action', async () => {
    configured = { FEISHU_APP_ID: identity.appId, FEISHU_CARD_READONLY_COPY_ENABLED: 'true', FEISHU_CARD_READONLY_COPY_APP_ID: identity.appId,
      FEISHU_CARD_READONLY_COPY_OPEN_ID: identity.recipientOpenId, FEISHU_CARD_READONLY_COPY_NAME: '刘小杏' };
    const projection = (await create().prepare(identity)).project(batch, 1);
    expect(projection.viewer.kind).toBe('participant');
    const items = projectPurchaseLifecycle(projection.items, projection.viewer);
    expect(items[0].actions).toEqual(['approve']);
    expect(JSON.stringify(items)).toContain('实际金额');
    expect(items[0].actions).not.toContain('order');
  });

  it.each(['李世龙', '刘小杏'])('keeps every read-only stage for %s when also serving a manager duty', async name => {
    configured = { FEISHU_APP_ID: identity.appId, FEISHU_CARD_READONLY_COPY_ENABLED: 'true', FEISHU_CARD_READONLY_COPY_APP_ID: identity.appId,
      FEISHU_CARD_READONLY_COPY_OPEN_ID: identity.recipientOpenId, FEISHU_CARD_READONLY_COPY_NAME: name };
    source.load.mockResolvedValueOnce({ version: 'source-1', batchFingerprint, records: [{ ...record,
      paymentAttachmentTokens: ['file_payment'], receiptPhotoTokens: ['file_receipt'], invoiceTokens: ['file_invoice'] }],
      comparisonImages: { rec1: [{ imageKey: 'img_1', alt: '报价' }] }, comparisonCounts: { rec1: 3 } });
    const view = (await create().prepare(identity)).project(batch, 1);
    const item = projectPurchaseLifecycle(view.items, view.viewer)[0];
    expect(view.viewer.kind).toBe('participant');
    expect(item.stages.map(stage => stage.stage)).toEqual(['application', 'approval', 'ordering', 'receipt', 'inbound']);
    expect(item.actions).toEqual(['approve']);
    expect(item.stages.flatMap(stage => stage.attachments || []).map(row => row.purpose)).toEqual(['comparison', 'comparison', 'comparison', 'payment', 'receipt', 'invoice']);
    expect(JSON.stringify(item)).not.toContain('file_payment');
    expect(JSON.stringify(item)).not.toContain('file_receipt');
    expect(JSON.stringify(item)).not.toContain('file_invoice');
  });

  it('renders both individual approval callbacks from the real authorized manager projection', async () => {
    const projection = (await create().prepare(identity)).project(batch, 7);
    const items = projectPurchaseLifecycle(projection.items, projection.viewer);
    const card = JSON.stringify(buildPurchaseLifecycleCard({ approvalBatchId: identity.batchId, cardRevision: 7, items, observer: false,
      batchApprovalProof: projection.batchApprovalProof, resolveManagerCallback: projection.resolveManagerCallback }));
    expect(card).toContain('"action":"approve_item_comprehensive"');
    expect(card).toContain('"action":"approve_item_building_self"');
    expect(card).toContain('"executionRecordId":"rec1"');
    expect(card).toContain('"approvalBatchId":"purchase-batch-test"');
    expect(card).toContain('"cardRevision":7');
    expect(card).toContain('"flowVersion":"lifecycle_v1"');
  });

  it('only exposes safe current order and receipt form data to the actual assigned actor', async () => {
    const authorizedBatch = { ...batch, requesterOpenId: identity.recipientOpenId,
      items: [{ ...batch.items[0], status: 'approved', choice: 'comprehensive', purchaserOpenId: identity.recipientOpenId, receiptPhotoTokens: ['pending_receipt'], invoiceTokens: ['pending_invoice'] }] };
    const targetFingerprint = createHash('sha256').update(JSON.stringify(authorizedBatch)).digest('hex');
    const baseRecord = { ...record, requesterOpenId: identity.recipientOpenId, purchaserOpenId: identity.recipientOpenId,
      actualQuantity: 7, actualAmount: 10, paymentAttachmentTokens: ['secret_payment'], receiptPhotoTokens: ['secret_receipt'], invoiceTokens: ['secret_invoice'] };
    duty = (kind: string) => kind === 'purchase_executor' ? [{ openId: identity.recipientOpenId }] : [];
    source.load.mockResolvedValueOnce({ version: 'source-1', batchFingerprint: targetFingerprint, records: [{ ...baseRecord, status: '审批通过（待下单）' }] });
    const order = (await create().prepare(identity)).project(authorizedBatch, 1).formPresentations;
    expect(order).toEqual({ rec1: { order: { actualQuantity: 7, actualAmount: 10 } } });
    source.load.mockResolvedValueOnce({ version: 'source-1', batchFingerprint: targetFingerprint, records: [{ ...baseRecord, status: '下单完成（待签收）' }] });
    const receipt = (await create().prepare(identity)).project(authorizedBatch, 1).formPresentations;
    expect(receipt).toEqual({ rec1: { receipt: { signerOpenId: identity.recipientOpenId, purchaseMethod: '综合采购', receiptPhotoCount: 1, invoiceCount: 1 } } });
    expect(JSON.stringify(receipt)).not.toContain('secret_');
  });
  it('uses the approved batch choice and pending attachment ledger for self-purchase receipt requirements', async () => {
    const authoritative = { ...batch, requesterOpenId: identity.recipientOpenId,
      items: [{ ...batch.items[0], status: 'approved', choice: 'building_self', purchaserOpenId: identity.recipientOpenId,
        receiptPhotoTokens: ['pending_photo'], invoiceTokens: [] }] };
    source.load.mockResolvedValueOnce({ version: 'source-1', batchFingerprint: createHash('sha256').update(JSON.stringify(authoritative)).digest('hex'),
      records: [{ ...record, requesterOpenId: identity.recipientOpenId, status: '下单完成（待签收）', purchaseMethod: '综合采购', receiptPhotoTokens: [], invoiceTokens: ['old_invoice'] }] });
    const forms = (await create().prepare(identity)).project(authoritative, 1).formPresentations;
    expect(forms?.rec1?.receipt).toMatchObject({ purchaseMethod: '需求自采', receiptPhotoCount: 1, invoiceCount: 0 });
  });

  it('reports only supported stage results and does not treat warehouse confirmation alone as inbound', async () => {
    configured = { FEISHU_APP_ID: identity.appId, FEISHU_CARD_READONLY_COPY_ENABLED: 'true', FEISHU_CARD_READONLY_COPY_APP_ID: identity.appId,
      FEISHU_CARD_READONLY_COPY_OPEN_ID: identity.recipientOpenId, FEISHU_CARD_READONLY_COPY_NAME: '李世龙' };
    duty = () => [];
    source.load.mockResolvedValueOnce({ version: 'source-1', batchFingerprint, records: [{ ...record, warehouseConfirmed: true, purchaseCompleted: false, receiptConfirmed: false }], comparisonImages: {} });
    let projection = (await create().prepare(identity)).project(batch, 1);
    let serialized = JSON.stringify(projectPurchaseLifecycle(projection.items, projection.viewer));
    expect(serialized).toContain('尚未确认');
    expect(serialized).not.toContain('已入库');
    source.load.mockResolvedValueOnce({ version: 'source-1', batchFingerprint, records: [{ ...record, status: '采购完成（已入库）', purchaseCompleted: false, receiptConfirmed: false }], comparisonImages: {} });
    projection = (await create().prepare(identity)).project(batch, 1);
    serialized = JSON.stringify(projectPurchaseLifecycle(projection.items, projection.viewer));
    expect(serialized).toContain('待核对');
    expect(serialized).not.toContain('已入库');
    source.load.mockResolvedValueOnce({ version: 'source-1', batchFingerprint, records: [{ ...record, status: '采购完成（已入库）', approvalCompleted: true, purchaseCompleted: true, receiptConfirmed: true }], comparisonImages: {} });
    projection = (await create().prepare(identity)).project(batch, 1);
    serialized = JSON.stringify(projectPurchaseLifecycle(projection.items, projection.viewer));
    expect(serialized).toContain('已入库');
  });

  it('shows managers confirmed order progress without exposing ordering amounts', async () => {
    source.load.mockResolvedValueOnce({ version: 'source-1', batchFingerprint, records: [{ ...record, status: '下单完成（待签收）', purchaseCompleted: true, actualAmount: 999 }], comparisonImages: {} });
    const projection = (await create().prepare(identity)).project(batch, 1);
    const projected = projectPurchaseLifecycle(projection.items, projection.viewer);
    expect(projected[0].overallProgress).toBe('ordered');
    const card = JSON.stringify(buildPurchaseLifecycleCard({ approvalBatchId: identity.batchId, cardRevision: 2, items: projected, observer: false }));
    expect(card).toContain('已下单 · 待签收');
    expect(card).not.toContain('999');
    source.load.mockResolvedValueOnce({ version: 'source-1', batchFingerprint, records: [{ ...record, status: '下单完成（待签收）', purchaseCompleted: false }], comparisonImages: {} });
    const uncertain = (await create().prepare(identity)).project(batch, 1);
    expect(projectPurchaseLifecycle(uncertain.items, uncertain.viewer)[0].overallProgress).toBe('unknown');
  });
});
