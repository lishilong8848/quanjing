import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PurchaseWorkflowStore } from '../../server/modules/purchase-inventory/purchase-workflow.store';
import { PurchaseManagerApprovalService as ActualService } from '../../server/modules/purchase-inventory/purchase-manager-approval.service';
import { serializePurchaseManagerApprovalCardContext } from '../../server/modules/purchase-inventory/purchase-manager-approval-card';
import { serializePurchaseManagerBatchApprovalCardContext, parsePurchaseManagerBatchApprovalCardContext } from '../../server/modules/purchase-inventory/purchase-manager-batch-approval-card';
import * as BatchCards from '../../server/modules/purchase-inventory/purchase-manager-batch-approval-card';
import { withSyntheticBusinessIdentity } from './synthetic-business-identity.fixture';
const Service = withSyntheticBusinessIdentity(ActualService, 5);

const now = new Date('2099-10-29T02:00:00.000Z');
const evidence = (recordId = 'recComparison') => ({ recordId, recordUrl: `https://vnet.feishu.cn/base/appSynthetic?table=tblSynthetic&record=${recordId}`,
  attachments: [1, 2, 3].map(i => ({ name: `第${i}家报价.png`, disposition: 'preview' as const, imageKey: `img_synthetic_${i}` })) });
const record = (form = '三方比价') => ({ recordId: 'recComparison', requestCode: 'CG-SYNTHETIC', status: '未开始（待审批）', itemName: '测试物品', specification: '测试型号',
  building: 'H楼', requesterOpenId: 'ou_requester', requesterName: '合成人员', purchaserOpenId: '', purchaserName: '', purchaseMethod: '', procurementForm: form,
  requestedQuantity: 1, unit: '件', unitPrice: 10, createdAt: now.getTime(), actualQuantity: null, actualAmount: null, approvalCompleted: false,
  warehouseConfirmed: false, purchaseCompleted: false, receiptConfirmed: false, signer: '', receiptTime: null, receiptPhotoTokens: [], invoiceTokens: [] });
const batchInput = () => ({ version: 3 as const, approvalBatchId: 'purchase-comparison-synthetic', requesterName: '合成人员', requesterOpenId: 'ou_requester',
  building: 'H楼', requestCode: 'CG-SYNTHETIC', expectedDeliveryAt: null, createdAt: null,
  items: [{ executionRecordId: 'recComparison', title: '测试物品', specification: '测试型号', quantity: '1', unit: '件', amount: '10', procurementForm: '三方比价' as const,
    singleReason: null, status: 'pending' as const, choice: '' as const, rejectionReason: '' }], comparisonEvidence: [evidence()] });

describe('比价附件发卡沿用真实账本与发卡租约', () => {
  let directory: string, store: PurchaseWorkflowStore, gateway: any, service: any;
  const env = { ...process.env };
  beforeEach(async () => {
    process.env.PURCHASE_MANAGER_APPROVAL_CARD_ENABLED = 'true'; process.env.PURCHASE_MANAGER_APPROVER_OPEN_ID = 'ou_manager';
    process.env.PURCHASE_MANAGER_APPROVER_NAME = '合成审批人';
    directory = await mkdtemp(join(tmpdir(), 'purchase-comparison-delivery-'));
    store = new PurchaseWorkflowStore(join(directory, 'workflow.json')); await store.onModuleInit();
    gateway = { getExecutionRecordAsApp: jest.fn(async () => record()), prepareManagerComparisonBatchEvidence: jest.fn(async () => [evidence()]),
      prepareManagerComparisonEvidence: jest.fn(async () => evidence()), updateExecutionRecordAsApp: jest.fn(async () => undefined),
      sendInteractiveCard: jest.fn(async () => 'om_comparison_sent'), updateInteractiveCard: jest.fn(async () => undefined) };
    service = new Service(gateway, store);
  });
  afterEach(async () => { jest.restoreAllMocks(); process.env = { ...env }; await store.onModuleDestroy(); await rm(directory, { recursive: true, force: true }); });
  const register = () => store.registerManagerApprovalBatch({ approvalBatchId: 'purchase-comparison-synthetic', requesterOpenId: 'ou_requester', recipientOpenId: 'ou_manager', recordIds: ['recComparison'] }, now);

  it('批次图片先准备并冻结context，再用原稳定UUID发卡', async () => {
    await register();
    const mark = jest.spyOn(store, 'markManagerApprovalBatchSendStarted');
    const result = await service.runAcceptedTasks(1, now);
    expect(result.failed).toBe(0); expect(gateway.sendInteractiveCard).toHaveBeenCalledTimes(1);
    const batch = await store.findManagerApprovalBatch('purchase-comparison-synthetic');
    expect(parsePurchaseManagerBatchApprovalCardContext(batch!.cardContext).comparisonEvidence).toEqual([evidence()]);
    expect(gateway.prepareManagerComparisonBatchEvidence.mock.invocationCallOrder[0]).toBeLessThan(mark.mock.invocationCallOrder[0]);
    expect(mark.mock.invocationCallOrder[0]).toBeLessThan(gateway.sendInteractiveCard.mock.invocationCallOrder[0]);
    expect(gateway.sendInteractiveCard.mock.calls[0][2]).toBeTruthy();
    expect(JSON.stringify(gateway.sendInteractiveCard.mock.calls[0][1])).toContain('img_synthetic_1');
  });

  it('单一采购完全不调用附件准备', async () => {
    await register(); gateway.getExecutionRecordAsApp.mockResolvedValue(record('单一采购'));
    const result = await service.runAcceptedTasks(1, now);
    expect(result.failed).toBe(0); expect(gateway.prepareManagerComparisonBatchEvidence).not.toHaveBeenCalled();
    expect(JSON.stringify(gateway.sendInteractiveCard.mock.calls[0][1])).not.toContain('三方比价附件');
  });

  it('准备超过5分钟即拒绝send-start，不发卡也不落unknown', async () => {
    await register();
    let clock = 1_000; jest.spyOn(Date, 'now').mockImplementation(() => clock);
    gateway.prepareManagerComparisonBatchEvidence.mockImplementation(async () => { clock += 300_001; return [evidence()]; });
    const result = await service.runAcceptedTasks(1, now);
    expect(result.failed).toBe(1); expect(gateway.sendInteractiveCard).not.toHaveBeenCalled();
    const notifications = await store.listNotifications();
    expect(notifications[0].sendOutcome).toBe('unattempted'); expect(notifications[0].firstSendAttemptAt).toBe('');
    expect(result.errors.join(' ')).toContain('租约已过期');
  });

  it('过期任务被另一worker重领后旧claim不能发送，新claim可以', async () => {
    await register();
    const old = await store.takeNextManagerApprovalNotification(now, 300_000);
    const later = new Date(now.getTime() + 300_001);
    const current = await store.takeNextManagerApprovalNotification(later, 300_000);
    expect(current!.claimToken).not.toBe(old!.claimToken);
    const context = serializePurchaseManagerBatchApprovalCardContext(batchInput());
    await expect(store.markManagerApprovalBatchSendStarted(old!.key, old!.claimToken, context, later)).rejects.toThrow('领取凭证');
    await expect(store.markManagerApprovalBatchSendStarted(current!.key, current!.claimToken, context, later)).resolves.toMatchObject({ sendOutcome: 'unknown' });
  });

  it('单条发卡的原子入口同样拒绝过期租约', async () => {
    await store.enqueueNotification({ kind: 'manager_approval_requested', businessEventId: 'manager_approval_requested:recComparison', recordId: 'recComparison', recipientOpenId: 'ou_manager' }, now);
    const task = await store.takeNextManagerApprovalNotification(now, 300_000);
    const context = serializePurchaseManagerApprovalCardContext({ executionRecordId: 'recComparison', requester: '合成人员', building: 'H楼', title: '测试', quantity: 1,
      procurementForm: '三方比价', comparisonEvidence: evidence() });
    await expect(store.markManagerApprovalSendStarted(task!.key, task!.claimToken, context, new Date(now.getTime() + 300_001))).rejects.toThrow('租约已过期');
  });

  it('渲染或卡片尺寸校验失败不写send-start、不发送、不变成发送结果未知', async () => {
    await register();
    // Context is valid; the final card render itself fails after serialization.
    // The old build-after-anchor order would already have recorded an unknown send here.
    const render = jest.spyOn(BatchCards, 'buildPurchaseManagerBatchApprovalCard').mockImplementation(() => { throw new Error('synthetic final card render failed'); });
    const mark = jest.spyOn(store, 'markManagerApprovalBatchSendStarted');
    const result = await service.runAcceptedTasks(1, now);
    expect(result.failed).toBe(1); expect(render).toHaveBeenCalledTimes(1); expect(mark).not.toHaveBeenCalled(); expect(gateway.sendInteractiveCard).not.toHaveBeenCalled();
    expect((await store.listNotifications())[0].sendOutcome).toBe('unattempted');
  });

  it('已有批次结果路径也累计父处理耗时，不能通过静态now绕过5分钟租约', async () => {
    const context = serializePurchaseManagerBatchApprovalCardContext(batchInput());
    let clock = 1_000; jest.spyOn(Date, 'now').mockImplementation(() => clock);
    const batch = { approvalBatchId: 'purchase-comparison-synthetic', state: 'active', cardContext: context };
    const mockStore = { findManagerApprovalBatch: jest.fn(async () => { clock += 300_001; return batch; }),
      markManagerApprovalBatchSendStarted: jest.fn(async (_key: string, _claim: string, _context: string, observed: Date) => {
        expect(observed.getTime()).toBeGreaterThan(now.getTime() + 300_000); throw new Error('lease expired');
      }), rescheduleNotification: jest.fn(), failNotification: jest.fn() };
    const target: any = new Service(gateway, mockStore as never);
    const result = { processed: 0, failed: 0, manualReconciliation: 0, alerts: [], errors: [] };
    await target.processNotification({ key: 'synthetic-result', claimToken: 'synthetic-claim', kind: 'manager_batch_approval_result', cardContext: context, attempts: 1, recipientOpenId: 'ou_requester' }, now, result);
    expect(mockStore.markManagerApprovalBatchSendStarted).toHaveBeenCalledTimes(1); expect(gateway.sendInteractiveCard).not.toHaveBeenCalled();
  });
});
