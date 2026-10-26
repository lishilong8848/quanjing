import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { InventoryOutboundApprovalStore } from '../../server/modules/inventory-outbound-approval/inventory-outbound-approval.store';
import { InventoryOutboundApprovalService } from '../../server/modules/inventory-outbound-approval/inventory-outbound-approval.service';
import { InventoryOutboundApprovalModule } from '../../server/modules/inventory-outbound-approval/inventory-outbound-approval.module';
import type { HandoverAdapter, HandoverContext } from '../../shared/personnel-handover.interface';
import { InventoryOutboundApprovalGateway } from '../../server/modules/inventory-outbound-approval/inventory-outbound-approval.gateway';
import { InventoryPersonnelHandoverAdapter } from '../../server/modules/inventory-outbound-approval/inventory-personnel-handover.adapter';
import { AccessConfigurationService } from '../../server/common/access/access-configuration.service';
import { Test } from '@nestjs/testing';
import { InventoryBatchCardService, type InventoryBatchCardItem } from '../../server/modules/inventory-outbound-approval/inventory-batch-card.service';
import type { InventoryOutboundApprovalSnapshot } from '../../server/modules/inventory-outbound-approval/inventory-outbound-approval.types';

const snapshot: InventoryOutboundApprovalSnapshot = {
  recordId: 'recSyntheticOutbound', outboundNumber: 'synthetic-outbound', version: 1, policyVersion: 'synthetic-v1',
  applicantOpenId: 'ou_synthetic_applicant', applicantName: '合成申请人', itemName: '合成物料', sku: 'synthetic-sku',
  specification: '', brand: '', quantity: 1, unit: '个', availableStock: 8, building: 'C楼', location: '合成库位',
  reason: '合成验证', appliedAt: '2026-10-13T00:00:00.000Z', approvers: [{ openId: 'ou_synthetic_old', name: '合成前任' }],
};
const input = {
  recordId: snapshot.recordId, expectedVersion: 1, mutationId: `handover-${'a'.repeat(64)}`, dutyRecordId: 'recDutyFixture',
  sourcePersonRecordId: 'recOldFixture', sourceOpenId: 'ou_synthetic_old',
  target: { personRecordId: 'recNewFixture', openId: 'ou_synthetic_new', name: '合成接任' },
};
type Port = InventoryOutboundApprovalStore & { acceptPendingHandover(value: typeof input): Promise<{ status: string; version: number }> };
describe('出库未决议审批交接真实账本', () => {
  let directory: string, temporaryRoot: string, owner: string, file: string, store: Port;
  const ref = { recordId: snapshot.recordId, version: 1, kind: 'approvalCardDelivery' as const, recipientOpenId: input.sourceOpenId };
  beforeEach(async () => {
    temporaryRoot = realpathSync(tmpdir()); owner = randomUUID(); directory = mkdtempSync(join(temporaryRoot, 'nt-inventory-handover-'));
    writeFileSync(join(directory, '.test-owner'), owner, { flag: 'wx' }); file = join(directory, 'ledger.json');
    store = new InventoryOutboundApprovalStore(file) as Port;
    await store.registerPending(snapshot); await store.confirmPendingRegistration(snapshot.recordId, 1);
    const claim = await store.claimWork(ref); if (!claim.claimed) throw new Error('合成原卡未受理');
    await store.completeWork({ ...ref, leaseToken: claim.leaseToken, messageId: 'om_synthetic_old' });
  });
  afterEach(() => {
    const canonical = (value: string) => resolve(value).toLowerCase();
    if (canonical(dirname(directory)) !== canonical(temporaryRoot) || !/^nt-inventory-handover-[A-Za-z0-9]+$/u.test(basename(directory)) || !existsSync(directory) || lstatSync(directory).isSymbolicLink() || canonical(realpathSync(directory)) !== canonical(directory)) throw new Error('测试目录归属异常，已保留');
    for (const name of readdirSync(directory)) if (!lstatSync(join(directory, name)).isFile() || lstatSync(join(directory, name)).isSymbolicLink()) throw new Error('测试目录条目异常，已保留');
    if (readFileSync(join(directory, '.test-owner'), 'utf8') !== owner) throw new Error('测试归属标记异常，已保留');
    rmSync(directory, { recursive: true, force: false });
  });
  it('原子创建下一待审批版本，不伪造原决定，旧卡失效，补终态和Base确认之前不投新卡', async () => {
    expect(await store.acceptPendingHandover(input)).toEqual({ status: 'accepted', version: 2 });
    const old = await store.find(snapshot.recordId, 1), next = await store.find(snapshot.recordId, 2);
    expect(old?.decision).toBeUndefined(); expect(old?.baseSync).toBeUndefined(); expect(old?.resultNotifications).toEqual([]);
    expect(old?.cardPatches).toHaveLength(1); expect(next?.snapshot.approvers).toEqual([{ openId: input.target.openId, name: input.target.name }]);
    await expect(store.claimDecision({ recordId: snapshot.recordId, version: 1, actorOpenId: input.sourceOpenId, messageId: 'om_synthetic_old', eventId: 'synthetic-old-event', action: 'approve' })).rejects.toThrow('失效');
    const newRef = { ...ref, version: 2, recipientOpenId: input.target.openId };
    expect((await store.claimWork(newRef)).claimed).toBe(false);
    await store.confirmPendingRegistration(snapshot.recordId, 2);
    expect((await store.claimWork(newRef)).claimed).toBe(false);
    const patchRef = { ...ref, kind: 'cardPatch' as const }, claim = await store.claimWork(patchRef);
    if (!claim.claimed) throw new Error('旧卡补终态未受理'); await store.completeWork({ ...patchRef, leaseToken: claim.leaseToken });
    expect((await store.claimWork(newRef)).claimed).toBe(true);
  });
  it('重启与重复确认复用同一回执，篡改native接任人拒绝且字节不变', async () => {
    const receipt = await store.acceptPendingHandover(input), before = readFileSync(file, 'utf8');
    const restarted = new InventoryOutboundApprovalStore(file) as Port;
    expect(await restarted.acceptPendingHandover(input)).toEqual(receipt); expect(readFileSync(file, 'utf8')).toBe(before);
    await expect(restarted.acceptPendingHandover({ ...input, target: { ...input.target, personRecordId: 'recWrongFixture' } })).rejects.toThrow();
    expect(readFileSync(file, 'utf8')).toBe(before);
  });
  it('真实后台先补旧卡，外部语义确认失败可恢复，成功后投新卡且不重复旧副作用', async () => {
    const originalApp = process.env.FEISHU_APP_ID; process.env.FEISHU_APP_ID = 'cli_synthetic_handover';
    try {
      await store.acceptPendingHandover(input);
      const order: string[] = []; let failPatch = true, failBase = true;
      const gateway = {
        patchInteractiveCard: jest.fn(async (_id: string, card: unknown) => { order.push('patch'); expect(JSON.stringify(card)).not.toContain('callback'); if (failPatch) { failPatch = false; throw new Error('synthetic-patch-failure'); } }),
        writePendingHandover: jest.fn(async (old: InventoryOutboundApprovalSnapshot, next: InventoryOutboundApprovalSnapshot) => { expect(old.version).toBe(1); expect(next.version).toBe(2); order.push('base'); if (failBase) { failBase = false; throw new Error('synthetic-semantic-readback'); } }),
        sendInteractiveCard: jest.fn(async (recipient: string) => { expect(recipient).toBe(input.target.openId); order.push('send'); return 'om_synthetic_new'; }),
        writeApprovalCardDeliveryLedger: jest.fn(async () => { order.push('delivery-ledger'); }),
      };
      const workflow = () => new InventoryOutboundApprovalService(new InventoryOutboundApprovalStore(file), gateway as never, undefined, undefined, undefined, { canUseFeishuBusinessIdentity: () => true } as never);
      const first = await workflow().runPending(); expect(first.failed).toBe(1); expect(order).toEqual(['patch']);
      const second = await workflow().runPending(); expect(second.failed).toBe(1); expect(order).toEqual(['patch', 'patch', 'base']);
      expect((await store.find(snapshot.recordId, 2))?.registration.status).toBe('pending_base');
      await workflow().runPending(); await workflow().runPending();
      expect(order).toEqual(['patch', 'patch', 'base', 'base', 'send', 'delivery-ledger']);
      expect((await store.find(snapshot.recordId, 2))?.approvalCards[0].messageId).toBe('om_synthetic_new');
      expect((await store.find(snapshot.recordId, 1))?.decision).toBeUndefined();
      await workflow().runPending(); expect(gateway.sendInteractiveCard).toHaveBeenCalledTimes(1);
    } finally { if (originalApp === undefined) delete process.env.FEISHU_APP_ID; else process.env.FEISHU_APP_ID = originalApp; }
  });
  it('首个合法原决定已受理只跳过，历史决定和账本字节不变', async () => {
    await store.claimDecision({ recordId: snapshot.recordId, version: 1, actorOpenId: input.sourceOpenId, messageId: 'om_synthetic_old', eventId: 'synthetic-first-event', action: 'approve' });
    const before = readFileSync(file, 'utf8'); expect(await store.acceptPendingHandover(input)).toEqual({ status: 'already_completed', version: 1 });
    expect(readFileSync(file, 'utf8')).toBe(before); expect(await store.find(snapshot.recordId, 2)).toBeUndefined();
  });
  it('过期版本、无效native与自审批均拒绝且无新增版本', async () => {
    const before = readFileSync(file, 'utf8');
    for (const invalid of [{ ...input, expectedVersion: 0 }, { ...input, sourcePersonRecordId: '' }, { ...input, target: { ...input.target, openId: snapshot.applicantOpenId } }]) await expect(store.acceptPendingHandover(invalid)).rejects.toThrow();
    expect(readFileSync(file, 'utf8')).toBe(before);
  });
  it('转交后迟到的原卡只补终态，旧Base决定不得覆盖新版本', async () => {
    const second = { openId: 'ou_synthetic_other', name: '合成并行审批人' };
    const otherFile = join(directory, 'late-ledger.json'), lateStore = new InventoryOutboundApprovalStore(otherFile) as Port;
    const original = { ...snapshot, approvers: [...snapshot.approvers, second] };
    const registered = await lateStore.registerPending(original); await lateStore.confirmPendingRegistration(snapshot.recordId, 1);
    await lateStore.acceptPendingHandover(input);
    const late = registered.entry.approvalCards.find(card => card.recipientOpenId === second.openId)!;
    await lateStore.restoreFromBase({ kind: 'pending', snapshot: original, deliveries: [{ recipientOpenId: second.openId, recipientName: second.name, deliveryUuid: late.deliveryUuid, messageId: 'om_synthetic_late' }] });
    const old = await lateStore.find(snapshot.recordId, 1);
    expect(old?.decision).toBeUndefined(); expect(old?.cardPatches.map(patch => patch.messageId)).toEqual(['om_synthetic_late']);
    const before = readFileSync(otherFile, 'utf8');
    await expect(lateStore.restoreFromBase({ kind: 'decided', snapshot: original, deliveries: [], decision: { action: 'approve', actorOpenId: second.openId, actorName: second.name, messageId: 'om_synthetic_late', eventId: 'synthetic-late-decision', decidedAt: '2026-10-13T01:00:00.000Z', reason: '' }, resultDeliveries: [], requiresBusinessFinalization: true })).rejects.toThrow('失效');
    expect(readFileSync(otherFile, 'utf8')).toBe(before);
  });
  it('正式模块注册真实adapter，职责预览/受理/回执按native绑定且投递完成前不能报告成功', async () => {
    const Adapter = (Reflect.getMetadata('providers', InventoryOutboundApprovalModule) as Array<{ name?: string }>).find(provider => provider.name === 'InventoryPersonnelHandoverAdapter') as unknown as new (...args: unknown[]) => HandoverAdapter;
    expect(Adapter).toBeDefined();
    const originalApp = process.env.FEISHU_APP_ID; process.env.FEISHU_APP_ID = 'cli_synthetic_handover';
    try {
      const person = (recordId: string, openId: string, name: string, marker: string, active: boolean) => ({ id: `local-external-${marker.repeat(64)}`, recordId, openId, name, active, type: 'employee' as const, position: '库房负责人', systemPosition: '', buildings: ['C楼' as const], specialties: [], permissionTags: [], dutyRecordIds: [input.dutyRecordId] });
      const context: HandoverContext = { from: person(input.sourcePersonRecordId, input.sourceOpenId, '合成前任', 'a', false), to: person(input.target.personRecordId, input.target.openId, input.target.name, 'b', true), directoryVersion: 'synthetic-v1', duties: [{ recordId: input.dutyRecordId, name: 'C楼库房审批', kind: 'warehouse_approver', personnelIds: [`local-external-${'a'.repeat(64)}`], buildings: ['C楼'], specialties: null, enabled: true, startsAt: 0, endsAt: null, parentDutyIds: [], version: 1 }] };
      const adapter = new Adapter(store, { canUseFeishuBusinessIdentity: () => true }, { isEnabled: () => true });
      const [item] = await adapter.listPending(context); expect(item).toMatchObject({ module: 'inventory', dutyRecordId: input.dutyRecordId, status: 'pending', version: '1' });
      expect(await adapter.preflight(context, item)).toEqual({ ready: true });
      const receipt = await adapter.acceptTransfer(context, item, input.mutationId); expect(receipt).toMatchObject({ status: 'accepted', version: '2' });
      expect(await adapter.reconcile(context, receipt)).toEqual({ status: 'syncing' });
      expect((await adapter.reconcile({ ...context, to: { ...context.to, recordId: 'recWrongFixture' } }, receipt)).status).toBe('error');
      expect(await adapter.acceptTransfer(context, item, input.mutationId)).toEqual(receipt);
      expect((Reflect.getMetadata('exports', InventoryOutboundApprovalModule) as unknown[]).includes(Adapter)).toBe(true);
    } finally { if (originalApp === undefined) delete process.env.FEISHU_APP_ID; else process.env.FEISHU_APP_ID = originalApp; }
  });
  it('真实gateway仅写当前审批快照，按OpenID语义回读；不一致拒绝，写成功后重试不重复PUT，已有决定不写', async () => {
    const overrides: Record<string, string> = { FEISHU_APP_ID: 'cli_synthetic_handover', FEISHU_APP_SECRET: 'synthetic-test-only', FEISHU_WAREHOUSE_APP_TOKEN: 'synthetic_app_token', FEISHU_WAREHOUSE_OUTBOUND_TABLE_ID: 'tblabd97393f2b0eac28' };
    const saved = Object.fromEntries(Object.keys(overrides).map(key => [key, process.env[key]])); Object.assign(process.env, overrides);
    try {
      const replacement = { ...snapshot, version: 2, approvers: [{ openId: input.target.openId, name: input.target.name }] };
      let current: Record<string, unknown> = { 程序出库状态: '待审批', 出库工作流状态: '待审批', 出库当前审批人: [{ id: input.sourceOpenId }], 出库实际审批人: [], 出库审批动作标识: '', 出库审批时间: '', 出库确认标识: '', 出库审批策略版本: snapshot.policyVersion, 出库审批快照: JSON.stringify({ schemaVersion: 1, snapshot }) };
      let badReadback = true;
      const post = jest.fn(async () => ({ data: { code: 0, tenant_access_token: 'synthetic-token', expire: 7200 } }));
      const get = jest.fn(async () => {
        const fields = { ...current };
        if (put.mock.calls.length && badReadback) { badReadback = false; fields.出库当前审批人 = [{ name: input.target.name }]; }
        return { data: { code: 0, data: { record: { record_id: snapshot.recordId, fields } } } };
      });
      const put = jest.fn(async (_url: string, body: { fields: Record<string, unknown> }) => {
        expect(Object.keys(body.fields).sort()).toEqual(['出库当前审批人', '出库审批策略版本', '出库审批快照', '出库审批投递台账', '出库工作流错误'].sort());
        current = { ...current, ...body.fields }; return { data: { code: 0 } };
      });
      const gateway = new InventoryOutboundApprovalGateway({ axiosRef: { post, get, put } } as never);
      await expect(gateway.writePendingHandover(snapshot, replacement)).rejects.toThrow('语义回读不一致');
      await expect(gateway.writePendingHandover(snapshot, replacement)).resolves.toBeUndefined(); expect(put).toHaveBeenCalledTimes(1);
      current = { ...current, 出库实际审批人: [{ id: input.sourceOpenId }], 出库审批动作标识: 'synthetic-accepted-event' };
      await expect(gateway.writePendingHandover(snapshot, replacement)).rejects.toThrow('已变化'); expect(put).toHaveBeenCalledTimes(1);
    } finally { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
  });
  it('真实gateway适配器最小DI缺少配置必拒绝，显式端口可构造且不自动写账本', async () => {
    const providers = [InventoryPersonnelHandoverAdapter, { provide: InventoryOutboundApprovalStore, useValue: store }, { provide: InventoryOutboundApprovalService, useValue: { isEnabled: () => true } }];
    await expect(Test.createTestingModule({ providers }).compile()).rejects.toThrow();
    const before = readFileSync(file, 'utf8');
    const module = await Test.createTestingModule({ providers: [...providers, { provide: AccessConfigurationService, useValue: { canUseFeishuBusinessIdentity: () => true } }] }).compile();
    expect(module.get(InventoryPersonnelHandoverAdapter)).toBeInstanceOf(InventoryPersonnelHandoverAdapter);
    expect(readFileSync(file, 'utf8')).toBe(before); await module.close();
  });
  it('批量交接确认必须等待真实PATCH，不把已有消息编号当旧卡终态回执', async () => {
    let release!: () => void, started!: () => void;
    const startedPromise = new Promise<void>(resolve => { started = resolve; }), barrier = new Promise<void>(resolve => { release = resolve; });
    const gateway = { sendInteractiveCard: jest.fn(async () => 'om_synthetic_batch'), patchInteractiveCard: jest.fn(async () => { started(); await barrier; }) };
    const batch = new InventoryBatchCardService(gateway as never, join(directory, 'batch-ledger.json')) as InventoryBatchCardService & { upsertConfirmed(kind: 'outbound', id: string, openId: string, item: InventoryBatchCardItem): Promise<string> };
    const item = { id: snapshot.recordId, name: snapshot.itemName, sku: snapshot.sku, specification: '', quantity: 1, unit: snapshot.unit, building: snapshot.building, location: snapshot.location, status: '待审批', approvalVersion: 1 };
    await batch.upsert('outbound', 'a'.repeat(32), input.sourceOpenId, item);
    expect(batch.upsertConfirmed).toBeDefined(); let settled = false;
    const result = batch.upsertConfirmed('outbound', 'a'.repeat(32), input.sourceOpenId, { ...item, status: '审批失效' }).then(value => { settled = true; return value; });
    await startedPromise; expect(settled).toBe(false); release(); expect(await result).toBe('om_synthetic_batch'); batch.onModuleDestroy();
  });
  it('批量已到新版本时迟到旧卡失效请求无副作用，保留新版与同卡其它明细', async () => {
    const gateway = { sendInteractiveCard: jest.fn(async () => 'om_synthetic_batch'), patchInteractiveCard: jest.fn(async () => undefined) };
    const batch = new InventoryBatchCardService(gateway as never, join(directory, 'batch-late-ledger.json')) as InventoryBatchCardService & { upsertConfirmed(kind: 'outbound', id: string, openId: string, item: InventoryBatchCardItem): Promise<string> };
    const item = { id: snapshot.recordId, name: snapshot.itemName, sku: snapshot.sku, specification: '', quantity: 1, unit: snapshot.unit, building: snapshot.building, location: snapshot.location, status: '待审批', approvalVersion: 1 };
    expect(batch.upsertConfirmed).toBeDefined();
    await batch.upsertConfirmed('outbound', 'a'.repeat(32), input.target.openId, item);
    await batch.upsertConfirmed('outbound', 'a'.repeat(32), input.target.openId, { ...item, id: 'recUnrelated', status: '待审批' });
    await batch.upsertConfirmed('outbound', 'a'.repeat(32), input.target.openId, { ...item, status: '审批失效' });
    await batch.upsertConfirmed('outbound', 'a'.repeat(32), input.target.openId, { ...item, approvalVersion: 2 });
    const before = readFileSync(join(directory, 'batch-late-ledger.json'), 'utf8'), count = gateway.patchInteractiveCard.mock.calls.length;
    await batch.upsertConfirmed('outbound', 'a'.repeat(32), input.target.openId, { ...item, status: '审批失效' });
    expect(readFileSync(join(directory, 'batch-late-ledger.json'), 'utf8')).toBe(before); expect(gateway.patchInteractiveCard).toHaveBeenCalledTimes(count);
    const rendered = JSON.stringify(await batch.render('outbound', 'a'.repeat(32), input.target.openId)); expect(rendered).toContain('recUnrelated'); expect(rendered).toContain('"version":2'); batch.onModuleDestroy();
  });
  it('批量真实service交接在PATCH返回前不确认Base或发新卡，返回后才进入新负责人版本', async () => {
    const originalApp = process.env.FEISHU_APP_ID; process.env.FEISHU_APP_ID = 'cli_synthetic_handover';
    let release!: () => void, started!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; }), startedPromise = new Promise<void>(resolve => { started = resolve; });
    let running: Promise<unknown> | undefined;
    try {
      const batchId = 'a'.repeat(32), value = { ...snapshot, outboundNumber: `inventory_batch_outbound_${batchId}_1` };
      const local = new InventoryOutboundApprovalStore(join(directory, 'joint-ledger.json'));
      const gateway = { sendInteractiveCard: jest.fn(async (recipient: string) => recipient === input.sourceOpenId ? 'om_synthetic_joint_old' : 'om_synthetic_joint_new'), patchInteractiveCard: jest.fn(async () => { started(); await barrier; }), writePendingHandover: jest.fn(async () => undefined), writeApprovalCardDeliveryLedger: jest.fn(async () => undefined) };
      const batch = new InventoryBatchCardService(gateway as never, join(directory, 'joint-batch-ledger.json'));
      await local.registerPending(value); await local.confirmPendingRegistration(value.recordId, 1);
      const item = { id: value.recordId, name: value.itemName, sku: value.sku, specification: '', quantity: 1, unit: value.unit, building: value.building, location: value.location, status: '待审批', approvalVersion: 1 };
      const oldMessage = await batch.upsert('outbound', batchId, input.sourceOpenId, item), claim = await local.claimWork(ref);
      if (!claim.claimed) throw new Error('合成原批量卡未受理'); await local.completeWork({ ...ref, leaseToken: claim.leaseToken, messageId: oldMessage });
      await local.acceptPendingHandover(input);
      const workflow = new InventoryOutboundApprovalService(local, gateway as never, undefined, undefined, batch, { canUseFeishuBusinessIdentity: () => true } as never);
      running = workflow.runPending(); await startedPromise;
      expect(gateway.writePendingHandover).not.toHaveBeenCalled(); expect(gateway.sendInteractiveCard).toHaveBeenCalledTimes(1);
      expect((await local.find(value.recordId, 2))?.registration.status).toBe('pending_base');
      release(); await running; await workflow.runPending();
      expect(gateway.writePendingHandover).toHaveBeenCalledTimes(1); expect(gateway.sendInteractiveCard).toHaveBeenCalledTimes(2);
      expect((await local.find(value.recordId, 2))?.approvalCards[0].messageId).toBe('om_synthetic_joint_new'); batch.onModuleDestroy();
    } finally { release(); await running?.catch(() => undefined); if (originalApp === undefined) delete process.env.FEISHU_APP_ID; else process.env.FEISHU_APP_ID = originalApp; }
  });
  it('交接预览必须把原外部注册未确认列为待对账，不能默默当已受理动作排除', async () => {
    const local = new InventoryOutboundApprovalStore(join(directory, 'unconfirmed-ledger.json')); await local.registerPending(snapshot);
    const person = (recordId: string, openId: string, marker: string) => ({ id: `local-external-${marker.repeat(64)}`, recordId, openId, name: '合成人员', active: true, type: 'employee' as const, position: '库房负责人', systemPosition: '', buildings: ['C楼' as const], specialties: [], permissionTags: [], dutyRecordIds: [input.dutyRecordId] });
    const context: HandoverContext = { from: person(input.sourcePersonRecordId, input.sourceOpenId, 'a'), to: person(input.target.personRecordId, input.target.openId, 'b'), directoryVersion: 'synthetic-v1', duties: [{ recordId: input.dutyRecordId, name: 'C楼库房审批', kind: 'warehouse_approver', personnelIds: [`local-external-${'a'.repeat(64)}`], buildings: ['C楼'], specialties: null, enabled: true, startsAt: 0, endsAt: null, parentDutyIds: [], version: 1 }] };
    const adapter = new InventoryPersonnelHandoverAdapter(local, { canUseFeishuBusinessIdentity: () => true } as never, { isEnabled: () => true } as never);
    const [item] = await adapter.listPending(context); expect(item.phase).toBe('reconcile'); expect(item.status).toBe('pending');
  });
});
