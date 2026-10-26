import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { PurchaseWorkflowStore } from '../../server/modules/purchase-inventory/purchase-workflow.store';
import { PurchaseManagerApprovalService } from '../../server/modules/purchase-inventory/purchase-manager-approval.service';
import { PurchaseWorkflowGateway } from '../../server/modules/purchase-inventory/purchase-workflow.gateway';
import { PURCHASE_MANAGER_APPROVAL_FIELDS as F, PURCHASE_MANAGER_APPROVAL_POLICY_VERSION } from '../../server/modules/purchase-inventory/purchase-manager-approval.fields';
import { serializePurchaseManagerBatchApprovalCardContext, type PurchaseManagerBatchApprovalCardInput } from '../../server/modules/purchase-inventory/purchase-manager-batch-approval-card';

const card: PurchaseManagerBatchApprovalCardInput = { version: 3, approvalBatchId: 'synthetic-purchase-batch', requesterName: '合成申请人', requesterOpenId: 'ou_synthetic_requester', building: 'C楼', requestCode: 'SYNTHETIC', expectedDeliveryAt: null, createdAt: null, items: [{ executionRecordId: 'recSyntheticPurchase', title: '合成物料', specification: '/', quantity: '1', unit: '个', amount: '1', status: 'pending', choice: '', rejectionReason: '' }] };
const input = { approvalBatchId: card.approvalBatchId, expectedRevision: 1, mutationId: `handover-${'b'.repeat(64)}`, dutyRecordId: 'recPurchaseDuty', sourcePersonRecordId: 'recOldFixture', sourceOpenId: 'ou_synthetic_old', target: { personRecordId: 'recNewFixture', openId: 'ou_synthetic_new', name: '合成接任' } };
type Port = PurchaseWorkflowStore & { acceptManagerBatchHandover(value: typeof input): Promise<{ status: string; revision: number }> };
describe('采购批次未决议审批交接账本', () => {
  let temporaryRoot: string, directory: string, owner: string, file: string, store: Port, revision: number;
  beforeEach(async () => {
    temporaryRoot = realpathSync(tmpdir()); owner = randomUUID(); directory = mkdtempSync(join(temporaryRoot, 'nt-purchase-handover-')); writeFileSync(join(directory, '.test-owner'), owner, { flag: 'wx' }); file = join(directory, 'ledger.json');
    store = new PurchaseWorkflowStore(file) as Port; await store.onModuleInit();
    await store.registerManagerApprovalBatch({ approvalBatchId: card.approvalBatchId, recipientOpenId: input.sourceOpenId, requesterOpenId: card.requesterOpenId, recordIds: card.items.map(item => item.executionRecordId) });
    const notification = await store.takeNextManagerApprovalNotification(); if (!notification) throw new Error('合成通知未受理');
    await store.markManagerApprovalBatchSendStarted(notification.key, notification.claimToken, serializePurchaseManagerBatchApprovalCardContext(card));
    await store.completeManagerApprovalBatchRequestAndRegisterCard(notification.key, notification.claimToken, { messageId: 'om_synthetic_purchase_old' });
    revision = (await store.findManagerApprovalBatch(card.approvalBatchId))!.revision;
  });
  afterEach(async () => {
    await store.onModuleDestroy(); const canonical = (value: string) => resolve(value).toLowerCase();
    if (canonical(dirname(directory)) !== canonical(temporaryRoot) || !/^nt-purchase-handover-[A-Za-z0-9]+$/u.test(basename(directory)) || !existsSync(directory) || lstatSync(directory).isSymbolicLink() || canonical(realpathSync(directory)) !== canonical(directory)) throw new Error('测试目录归属异常，已保留');
    for (const name of readdirSync(directory)) if (!lstatSync(join(directory, name)).isFile() || lstatSync(join(directory, name)).isSymbolicLink()) throw new Error('测试目录条目异常，已保留');
    if (readFileSync(join(directory, '.test-owner'), 'utf8') !== owner) throw new Error('测试归属标记异常，已保留'); rmSync(directory, { recursive: true, force: false });
  });
  it('CAS保留待审批明细且旧卡不可办理，旧卡终态确认前新通知不可认领', async () => {
    expect(await store.acceptManagerBatchHandover({ ...input, expectedRevision: revision })).toEqual({ status: 'accepted', revision: revision + 1 });
    const batch = await store.findManagerApprovalBatch(card.approvalBatchId);
    expect(batch).toMatchObject({ recipientOpenId: input.target.openId, state: 'awaiting_delivery', messageId: '', items: [{ status: 'pending', actionEventId: '', actorOpenId: '' }] });
    await expect(store.claimManagerApprovalBatchPendingApproval({ eventId: 'synthetic-old-click', approvalBatchId: card.approvalBatchId, messageId: 'om_synthetic_purchase_old', actorOpenId: input.sourceOpenId, choice: 'comprehensive' })).rejects.toThrow();
    expect(await store.takeNextManagerApprovalNotification()).toBeNull();
  });
  it('重复确认与重启复用持久回执，native篡改拒绝且字节不变', async () => {
    const value = { ...input, expectedRevision: revision }, receipt = await store.acceptManagerBatchHandover(value);
    await store.onModuleDestroy(); store = new PurchaseWorkflowStore(file) as Port; await store.onModuleInit();
    const before = readFileSync(file, 'utf8'); expect(await store.acceptManagerBatchHandover(value)).toEqual(receipt); expect(readFileSync(file, 'utf8')).toBe(before);
    await expect(store.acceptManagerBatchHandover({ ...value, target: { ...value.target, personRecordId: 'recOtherFixture' } })).rejects.toThrow(); expect(readFileSync(file, 'utf8')).toBe(before);
  });
  it('原合法动作先受理则跳过，不覆盖该动作、明细或原批准人', async () => {
    await store.claimManagerApprovalBatchPendingApproval({ eventId: 'synthetic-first-action', approvalBatchId: card.approvalBatchId, messageId: 'om_synthetic_purchase_old', actorOpenId: input.sourceOpenId, choice: 'comprehensive' });
    const before = readFileSync(file, 'utf8'); expect((await store.acceptManagerBatchHandover({ ...input, expectedRevision: revision })).status).toBe('already_completed'); expect(readFileSync(file, 'utf8')).toBe(before);
  });
  it('原外部结果待人工对账不能当已办结跳过，保留原账本', async () => {
    await store.claimManagerApprovalBatchPendingApproval({ eventId: 'synthetic-unknown-action', approvalBatchId: card.approvalBatchId, messageId: 'om_synthetic_purchase_old', actorOpenId: input.sourceOpenId, choice: 'comprehensive' });
    const action = await store.takeNextManagerApprovalBatchAction(); if (!action) throw new Error('合成审批动作未受理');
    await store.markManagerApprovalBatchActionRecordManual(action.key, action.claimToken, card.items[0].executionRecordId, new Error('synthetic-uncertain-write'));
    const before = readFileSync(file, 'utf8');
    await expect(store.acceptManagerBatchHandover({ ...input, expectedRevision: (await store.findManagerApprovalBatch(card.approvalBatchId))!.revision })).rejects.toThrow('对账');
    expect(readFileSync(file, 'utf8')).toBe(before);
  });
  it('真实交接worker逐步持久旧卡与外部确认，失败重启仅重失败步骤，之后才开放新通知', async () => {
    const originalApp = process.env.FEISHU_APP_ID; process.env.FEISHU_APP_ID = 'cli_synthetic_handover';
    try {
      await store.acceptManagerBatchHandover({ ...input, expectedRevision: revision });
      let failPatch = true, failBase = true; const order: string[] = [];
      const gateway = {
        updateInteractiveCard: jest.fn(async (messageId: string, value: unknown) => { expect(messageId).toBe('om_synthetic_purchase_old'); expect(JSON.stringify(value)).not.toContain('callback'); order.push('patch'); if (failPatch) { failPatch = false; throw new Error('synthetic-patch'); } }),
        writeManagerPendingHandover: jest.fn(async (value: { recordId: string; sourceOpenId: string; targetOpenId: string }) => { expect(value).toMatchObject({ recordId: card.items[0].executionRecordId, sourceOpenId: input.sourceOpenId, targetOpenId: input.target.openId }); order.push('base'); if (failBase) { failBase = false; throw new Error('synthetic-readback'); } }),
      };
      const workflow = () => { const service = new PurchaseManagerApprovalService(gateway as never, store, undefined, undefined, undefined, { canUseFeishuBusinessIdentity: () => true } as never) as PurchaseManagerApprovalService & { runPersonnelHandovers(limit: number, now: Date): Promise<{ processed: number; failed: number }> }; jest.spyOn(service, 'isEnabled').mockReturnValue(true); return service; };
      const now = Date.now(); expect((await workflow().runPersonnelHandovers(1, new Date(now))).failed).toBe(1); expect(order).toEqual(['patch']);
      expect((await workflow().runPersonnelHandovers(1, new Date(now + 120_000))).failed).toBe(1); expect(order).toEqual(['patch', 'patch', 'base']);
      expect(await store.takeNextManagerApprovalNotification(new Date(now + 120_000))).toBeNull();
      await store.onModuleDestroy(); store = new PurchaseWorkflowStore(file) as Port; await store.onModuleInit();
      expect((await workflow().runPersonnelHandovers(1, new Date(now + 240_000))).processed).toBe(1); expect(order).toEqual(['patch', 'patch', 'base', 'base']);
      const queued = (await store.listNotifications({ kind: 'manager_batch_approval_requested' })).find(entry => entry.recipientOpenId === input.target.openId);
      expect(queued).toMatchObject({ status: 'pending' }); expect(Date.parse(queued!.nextAttemptAt)).toBeGreaterThanOrEqual(now + 240_000);
      const notification = await store.takeNextManagerApprovalNotification(new Date(now + 300_000));
      expect(notification).toMatchObject({ kind: 'manager_batch_approval_requested', recipientOpenId: input.target.openId });
      expect((await store.findManagerApprovalBatch(card.approvalBatchId))?.items[0]).toMatchObject({ status: 'pending', actionEventId: '', actorOpenId: '' });
      expect((await workflow().runPersonnelHandovers(1, new Date(now + 360_000))).processed).toBe(0);
    } finally { jest.restoreAllMocks(); if (originalApp === undefined) delete process.env.FEISHU_APP_ID; else process.env.FEISHU_APP_ID = originalApp; }
  });
  it('实际采购gateway只改当前负责人，按OpenID回读，重试不重写，已批准及姓名代替身份均拒绝', async () => {
    const overrides: Record<string, string> = { FEISHU_APP_ID: 'cli_synthetic_handover', FEISHU_APP_SECRET: 'synthetic-test-only', FEISHU_PURCHASE_INVENTORY_APP_TOKEN: 'synthetic_app_token', FEISHU_PURCHASE_EXECUTION_TABLE_ID: 'tbl4d5cc1d204f3ce139' };
    const saved = Object.fromEntries(Object.keys(overrides).map(key => [key, process.env[key]])); Object.assign(process.env, overrides);
    try {
      const original: Record<string, unknown> = { 采购流程: '未开始（待审批）', [F.source]: '程序卡片', [F.state]: '待经理审批', [F.currentApprover]: [{ id: input.sourceOpenId }], [F.actualApprover]: [], [F.approvalTime]: null, [F.actionId]: '', [F.policyVersion]: PURCHASE_MANAGER_APPROVAL_POLICY_VERSION, [F.batchId]: card.approvalBatchId };
      let current = { ...original }, badReadback = true;
      const put = jest.fn(async (_url: string, body: { fields: Record<string, unknown> }) => { expect(Object.keys(body.fields).sort()).toEqual([F.currentApprover, F.error].sort()); current = { ...current, ...body.fields }; return { data: { code: 0 } }; });
      const post = jest.fn(async (url: string, _body: unknown, config: { params?: unknown }) => {
        if (url.includes('/auth/v3/')) return { data: { code: 0, tenant_access_token: 'synthetic-token', expire: 7200 } };
        expect(config.params).toEqual({ user_id_type: 'open_id' }); const fields = { ...current };
        if (put.mock.calls.length && badReadback) { badReadback = false; fields[F.currentApprover] = [{ name: input.target.name }]; }
        return { data: { code: 0, data: { records: [{ record_id: card.items[0].executionRecordId, fields }] } } };
      });
      const gateway = new PurchaseWorkflowGateway({ axiosRef: { post, put } } as never);
      const request = { recordId: card.items[0].executionRecordId, approvalBatchId: card.approvalBatchId, sourceOpenId: input.sourceOpenId, targetOpenId: input.target.openId };
      await expect(gateway.writeManagerPendingHandover(request)).rejects.toThrow('语义回读');
      await expect(gateway.writeManagerPendingHandover(request)).resolves.toBeUndefined(); expect(put).toHaveBeenCalledTimes(1);
      current = { ...current, [F.actualApprover]: [{ id: input.sourceOpenId }], [F.actionId]: 'synthetic-accepted', [F.approvalTime]: 1791849600000 };
      const before = JSON.stringify(current); await expect(gateway.writeManagerPendingHandover(request)).rejects.toThrow('已变化'); expect(JSON.stringify(current)).toBe(before); expect(put).toHaveBeenCalledTimes(1);
      current = { ...original, [F.currentApprover]: [{ name: '合成前任' }] }; await expect(gateway.writeManagerPendingHandover(request)).rejects.toThrow('已变化'); expect(put).toHaveBeenCalledTimes(1);
    } finally { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
  });
  it('混合批次真实发卡只读取未决项，仅写投递元数据，既有驳回与实际处理人保持', async () => {
    const originalApp = process.env.FEISHU_APP_ID; process.env.FEISHU_APP_ID = 'cli_synthetic_handover';
    const local = new PurchaseWorkflowStore(join(directory, 'mixed-ledger.json'));
    try {
      await local.onModuleInit();
      const mixed = { ...card, approvalBatchId: 'synthetic-purchase-mixed', items: [card.items[0], { ...card.items[0], executionRecordId: 'recSyntheticSecond', title: '合成第二项' }] };
      await local.registerManagerApprovalBatch({ approvalBatchId: mixed.approvalBatchId, recipientOpenId: input.sourceOpenId, requesterOpenId: mixed.requesterOpenId, recordIds: mixed.items.map(item => item.executionRecordId) });
      const initial = (await local.takeNextManagerApprovalNotification())!;
      await local.markManagerApprovalBatchSendStarted(initial.key, initial.claimToken, serializePurchaseManagerBatchApprovalCardContext(mixed));
      await local.completeManagerApprovalBatchRequestAndRegisterCard(initial.key, initial.claimToken, { messageId: 'om_synthetic_mixed_old' });
      const identity = { approvalBatchId: mixed.approvalBatchId, messageId: 'om_synthetic_mixed_old', actorOpenId: input.sourceOpenId, executionRecordId: mixed.items[0].executionRecordId };
      await local.openManagerApprovalBatchRejectEditor(identity);
      await local.claimManagerApprovalBatchItemReject({ ...identity, eventId: 'synthetic-rejected-first', rejectionReason: '合成拒绝原因' });
      const action = (await local.takeNextManagerApprovalBatchAction())!;
      await local.completeManagerApprovalBatchActionRecord(action.key, action.claimToken, mixed.items[0].executionRecordId, undefined);
      for (let count = 0; count < 10; count += 1) { const old = await local.takeNextManagerApprovalNotification(new Date(Date.now() + 120_000)); if (!old) break; await local.completeNotification(old.key, old.claimToken, { messageId: 'om_synthetic_mixed_old' }); }
      const before = (await local.findManagerApprovalBatch(mixed.approvalBatchId))!;
      const history = before.items[0]; expect(history.status).toBe('rejected');
      await local.acceptManagerBatchHandover({ ...input, approvalBatchId: mixed.approvalBatchId, expectedRevision: before.revision });
      const gateway = {
        updateInteractiveCard: jest.fn(async () => undefined), writeManagerPendingHandover: jest.fn(async () => undefined),
        writeManagerHandoverDeliveryReceipt: jest.fn(async (value: { recordId: string }) => { expect(value.recordId).toBe('recSyntheticSecond'); }),
        getExecutionRecordAsApp: jest.fn(async (id: string) => { expect(id).toBe('recSyntheticSecond'); return { recordId: id, status: '未开始（待审批）' }; }),
        sendInteractiveCard: jest.fn(async (id: string, value: unknown) => { expect(id).toBe(input.target.openId); expect(JSON.stringify(value)).toContain('已驳回'); return 'om_synthetic_mixed_new'; }),
        updateExecutionRecordAsApp: jest.fn(async (id: string, fields: Record<string, unknown>) => { expect(id).toBe('recSyntheticSecond'); for (const key of [F.actualApprover, F.approvalTime, F.actionId, F.state, F.currentApprover]) expect(fields).not.toHaveProperty(key); }),
      };
      const workflow = new PurchaseManagerApprovalService(gateway as never, local, undefined, undefined, undefined, { canUseFeishuBusinessIdentity: () => true } as never);
      jest.spyOn(workflow, 'isEnabled').mockReturnValue(true);
      expect((await workflow.runPersonnelHandovers(1, new Date())).processed).toBe(1);
      expect((await workflow.runPendingTasks(1, new Date(Date.now() + 120_000))).failed).toBe(0);
      expect(gateway.sendInteractiveCard).toHaveBeenCalledTimes(1); expect(gateway.updateExecutionRecordAsApp).toHaveBeenCalledTimes(1);
      expect((await local.findManagerApprovalBatch(mixed.approvalBatchId))?.items[0]).toEqual(history);
    } finally { await local.onModuleDestroy(); jest.restoreAllMocks(); if (originalApp === undefined) delete process.env.FEISHU_APP_ID; else process.env.FEISHU_APP_ID = originalApp; }
  });
  it('新卡已投递但外部回执失败时持久恢复，仅重元数据，不重发卡或改已受理审批', async () => {
    const originalApp = process.env.FEISHU_APP_ID; process.env.FEISHU_APP_ID = 'cli_synthetic_handover';
    try {
      await store.acceptManagerBatchHandover({ ...input, expectedRevision: revision });
      let failReceipt = true;
      const gateway = { updateInteractiveCard: jest.fn(async () => undefined), writeManagerPendingHandover: jest.fn(async () => undefined),
        writeManagerHandoverDeliveryReceipt: jest.fn(async (value: { messageId: string; targetOpenId: string }) => { expect(value).toMatchObject({ messageId: 'om_synthetic_purchase_new', targetOpenId: input.target.openId }); if (failReceipt) { failReceipt = false; throw new Error('synthetic-delivery-readback'); } }) };
      type Worker = PurchaseManagerApprovalService & { runPersonnelHandoverDeliveries(limit: number, now: Date): Promise<{ processed: number; failed: number }> };
      const workflow = () => { const service = new PurchaseManagerApprovalService(gateway as never, store, undefined, undefined, undefined, { canUseFeishuBusinessIdentity: () => true } as never) as Worker; jest.spyOn(service, 'isEnabled').mockReturnValue(true); return service; };
      const now = Date.now(); await workflow().runPersonnelHandovers(1, new Date(now));
      const next = (await store.takeNextManagerApprovalNotification(new Date(now + 60_000)))!;
      await store.markManagerApprovalBatchSendStarted(next.key, next.claimToken, next.cardContext);
      await store.completeManagerApprovalBatchRequestAndRegisterCard(next.key, next.claimToken, { messageId: 'om_synthetic_purchase_new' });
      await store.claimManagerApprovalBatchPendingApproval({ eventId: 'synthetic-new-approved', approvalBatchId: card.approvalBatchId, messageId: 'om_synthetic_purchase_new', actorOpenId: input.target.openId, choice: 'comprehensive' });
      const history = (await store.findManagerApprovalBatch(card.approvalBatchId))!.items;
      expect((await workflow().runPersonnelHandoverDeliveries(1, new Date(now + 120_000))).failed).toBe(1);
      await store.onModuleDestroy(); store = new PurchaseWorkflowStore(file) as Port; await store.onModuleInit();
      expect((await workflow().runPersonnelHandoverDeliveries(1, new Date(now + 240_000))).processed).toBe(1);
      expect((await store.listPersonnelHandovers())[0]).toMatchObject({ newMessageId: 'om_synthetic_purchase_new', deliveryConfirmedAt: expect.any(String) });
      expect((await store.findManagerApprovalBatch(card.approvalBatchId))!.items).toEqual(history);
      expect(gateway.updateInteractiveCard).toHaveBeenCalledTimes(1); expect((await store.listNotifications({ kind: 'manager_batch_approval_requested' }))).toHaveLength(2);
    } finally { jest.restoreAllMocks(); if (originalApp === undefined) delete process.env.FEISHU_APP_ID; else process.env.FEISHU_APP_ID = originalApp; }
  });
  it('实际新卡回执gateway按日期语义回读，写后重试不重PUT，已审批史实字段保持', async () => {
    const overrides: Record<string, string> = { FEISHU_APP_ID: 'cli_synthetic_handover', FEISHU_APP_SECRET: 'synthetic-test-only', FEISHU_PURCHASE_INVENTORY_APP_TOKEN: 'synthetic_app_token', FEISHU_PURCHASE_EXECUTION_TABLE_ID: 'tbl4d5cc1d204f3ce139' };
    const saved = Object.fromEntries(Object.keys(overrides).map(key => [key, process.env[key]])); Object.assign(process.env, overrides);
    try {
      let current: Record<string, unknown> = { [F.source]: '程序卡片', [F.policyVersion]: PURCHASE_MANAGER_APPROVAL_POLICY_VERSION, [F.batchId]: card.approvalBatchId, [F.currentApprover]: [], [F.actualApprover]: [{ id: input.target.openId }], [F.approvalTime]: 1791849600000, [F.actionId]: 'synthetic-approved', [F.state]: '已通过' };
      const original = { ...current }; let badReadback = true;
      const put = jest.fn(async (_url: string, body: { fields: Record<string, unknown> }) => { expect(Object.keys(body.fields).sort()).toEqual([F.deliveryState, F.deliveryTime, F.messageId, F.deliveryUuid, F.deliveryAttempts].sort()); current = { ...current, ...body.fields }; return { data: { code: 0 } }; });
      const post = jest.fn(async (url: string) => { if (url.includes('/auth/v3/')) return { data: { code: 0, tenant_access_token: 'synthetic-token', expire: 7200 } };
        const fields = { ...current }; if (fields[F.deliveryTime]) fields[F.deliveryTime] = new Date(Number(fields[F.deliveryTime])).toISOString();
        if (put.mock.calls.length && badReadback) { badReadback = false; fields[F.messageId] = 'om_synthetic_wrong'; }
        return { data: { code: 0, data: { records: [{ record_id: card.items[0].executionRecordId, fields }] } } };
      });
      const gateway = new PurchaseWorkflowGateway({ axiosRef: { post, put } } as never);
      const value = { recordId: card.items[0].executionRecordId, targetOpenId: input.target.openId, approvalBatchId: card.approvalBatchId, messageId: 'om_synthetic_purchase_new', deliveryUuid: '00000000-0000-4000-8000-000000000001', deliveredAt: '2026-10-13T02:00:00.000Z', deliveryAttempts: 1 };
      await expect(gateway.writeManagerHandoverDeliveryReceipt(value)).rejects.toThrow('尚未确认');
      await expect(gateway.writeManagerHandoverDeliveryReceipt(value)).resolves.toBeUndefined(); expect(put).toHaveBeenCalledTimes(1);
      for (const [key, field] of Object.entries(original)) expect(current[key]).toEqual(field);
      await expect(gateway.writeManagerHandoverDeliveryReceipt({ ...value, targetOpenId: 'ou_synthetic_wrong' })).rejects.toThrow('身份不一致'); expect(put).toHaveBeenCalledTimes(1);
    } finally { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
  });
});
