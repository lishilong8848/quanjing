import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { InventoryInboundHandoverAdapter } from '../../server/modules/inventory-management/inventory-inbound-handover.adapter';
import { InventoryInboundTaskLedgerStore } from '../../server/modules/inventory-management/inventory-inbound-task-ledger.store';
import { PurchaseWorkflowStore } from '../../server/modules/purchase-inventory/purchase-workflow.store';
import type { HandoverContext } from '../../shared/personnel-handover.interface';
import * as configurations from '../../server/common/access/access-configuration.store';
import * as defaults from '../../server/common/access/access-configuration.defaults';
import { AccessConfigurationService } from '../../server/common/access/access-configuration.service';
import { feishuIdentityFingerprint } from '../../server/common/access/feishu-access-approved-grants';
import { handoverItemMutationId } from '../../server/common/access/personnel-handover.store';

const mutationId = `handover-${'c'.repeat(64)}`;
const context = (): HandoverContext => ({
  from: { id: 'local-external-old', recordId: 'recInboundOld', name: '合成前任', openId: 'ou_inbound_old', active: true, type: 'employee', position: '', systemPosition: '', buildings: ['C楼'], specialties: [], permissionTags: [], dutyRecordIds: ['recInboundDuty'] },
  to: { id: 'local-external-new', recordId: 'recInboundNew', name: '合成接任者', openId: 'ou_inbound_new', active: true, type: 'employee', position: '', systemPosition: '', buildings: ['C楼'], specialties: [], permissionTags: [], dutyRecordIds: [] },
  duties: [{ recordId: 'recInboundDuty', name: 'C楼库房', kind: 'warehouse_approver', personnelIds: ['local-external-old'], buildings: ['C楼'], specialties: null, enabled: true, startsAt: 0, endsAt: null, parentDutyIds: [], version: 1 }], directoryVersion: 'synthetic-directory',
});
describe('实际入库交接适配器', () => {
  let folder: string, parent: string, owner: string, notices: PurchaseWorkflowStore, ledger: InventoryInboundTaskLedgerStore, savedApp: string | undefined;
  const row = () => ({ executionRecordId: 'recInboundTransfer', submissionRecordId: 'recSubmission', requestCode: 'SYNTHETIC', mode: 'existing', sku: 'TEST', itemName: '合成物料', specification: '', brand: '', primaryCategory: '', secondaryCategory: '', building: 'C楼', quantity: 1, unit: '件', signedAt: null, action: 'confirm', catalogRecordId: 'recCatalog', actionReason: '' });
  const configuration = () => ({ canUseFeishuBusinessIdentity: () => true, snapshot: () => ({ appId: 'cli_synthetic_inbound', accounts: ['old','new'].map(value => ({ id: `local-external-${value}`, kind: 'local', loginMethod: 'personnel-password', personnelAppId: 'cli_synthetic_inbound', personnelIdentity: `local-external-${value}`, name: value, enabled: true, role: 'inventory_admin', building: 'C楼', version: 1 })) }) });
  const pending = { listPending: jest.fn() };
  const adapter = () => new InventoryInboundHandoverAdapter(ledger, pending as never, notices, configuration() as never);
  beforeEach(async () => {
    savedApp = process.env.FEISHU_APP_ID; process.env.FEISHU_APP_ID = 'cli_synthetic_inbound'; parent = realpathSync(tmpdir()); folder = mkdtempSync(join(parent, 'nt-inbound-adapter-')); owner = randomUUID(); writeFileSync(join(folder, '.test-owner'), owner, { flag: 'wx' });
    ledger = new InventoryInboundTaskLedgerStore(join(folder, 'inbound.json')); notices = new PurchaseWorkflowStore(join(folder, 'purchase.json')); await notices.onModuleInit(); pending.listPending.mockResolvedValue({ items: [row()] });
  });
  it('统一岗位回执下恢复失败原提醒，立即可续办；伪造回执不改原账本', async () => {
    const ctx=context(),appId=process.env.FEISHU_APP_ID!,batchId=randomUUID();
    ctx.from.id=`local-external-${'a'.repeat(64)}`;ctx.to.id=`local-external-${'b'.repeat(64)}`;ctx.duties[0].personnelIds=[ctx.from.id];
    const config=new configurations.AccessConfigurationStore(join(folder,'configuration.json'));
    jest.spyOn(configurations,'getAccessConfigurationStore').mockReturnValue(config);jest.spyOn(defaults,'defaultAccessAccounts').mockReturnValue({});
    await config.mutate(0,randomUUID(),'synthetic-seed',state=>{
      for(const person of [ctx.from,ctx.to]){const identityHash=feishuIdentityFingerprint(appId,person.openId!),id=`feishu-${identityHash}`;state.accounts[id]={id,kind:'feishu',appId,openId:person.openId!,identityHash,name:person.name,role:'inventory_admin',building:'C楼',enabled:true,deleted:false,source:'configuration',version:1};}
      state.personnelDutyAssignments={recInboundDuty:{appId,dutyRecordId:'recInboundDuty',kind:'warehouse_approver',buildings:['C楼'],specialties:null,version:1,startsAt:0,endsAt:null,confirmedBatchId:batchId,members:[{personId:ctx.to.id,recordId:ctx.to.recordId,openId:ctx.to.openId!,name:ctx.to.name}]}};
    });
    try{
      const service=new InventoryInboundHandoverAdapter(ledger,pending as never,notices,new AccessConfigurationService()),item=(await service.listPending(ctx))[0],mutation=handoverItemMutationId(batchId,item.key);
      const receipt=await service.acceptTransfer(ctx,item,mutation),job=(await notices.takeNextWarehouseInboundHandover())!;
      await notices.failWarehouseInboundHandover(mutation,job.claimToken);
      expect(await service.reconcile(ctx,receipt)).toMatchObject({status:'error'});
      const before=readFileSync(join(folder,'purchase.json'),'utf8');
      expect(await service.reconcile(ctx,{...receipt,version:'bad'},{retryFailed:true})).toMatchObject({status:'error'});expect(readFileSync(join(folder,'purchase.json'),'utf8')).toBe(before);
      expect(await service.reconcile(ctx,receipt,{retryFailed:true})).toMatchObject({status:'syncing'});
      expect(await notices.takeNextWarehouseInboundHandover()).toBeTruthy();
    }finally{jest.restoreAllMocks();}
  });
  afterEach(async () => {
    jest.restoreAllMocks(); if (savedApp === undefined) delete process.env.FEISHU_APP_ID; else process.env.FEISHU_APP_ID = savedApp; await notices.onModuleDestroy();
    if (dirname(resolve(folder)).toLowerCase() !== resolve(parent).toLowerCase() || !/^nt-inbound-adapter-[A-Za-z0-9]+$/.test(basename(folder)) || !existsSync(folder) || lstatSync(folder).isSymbolicLink() || realpathSync(folder) !== folder || readFileSync(join(folder, '.test-owner'), 'utf8') !== owner) throw Error('Owned fixture mismatch');
    for (const name of readdirSync(folder)) if (!lstatSync(join(folder, name)).isFile() || lstatSync(join(folder, name)).isSymbolicLink()) throw Error('Unsafe fixture'); rmSync(folder, { recursive: true, force: false });
  });
  it('只列匹配职责的待入库，受理后重启同mutation恢复；等待真实卡片回执才成功', async () => {
    const service = adapter(), [item] = await service.listPending(context()); expect(item).toMatchObject({ module: 'inventory', phase: 'execution', stageKey: 'purchase_inbound', dutyRecordId: 'recInboundDuty' });
    const receipt = await service.acceptTransfer(context(), item, mutationId); expect(await service.reconcile(context(), receipt)).toEqual({ status: 'syncing' });
    ledger = new InventoryInboundTaskLedgerStore(join(folder, 'inbound.json')); await notices.onModuleDestroy(); notices = new PurchaseWorkflowStore(join(folder, 'purchase.json')); await notices.onModuleInit(); pending.listPending.mockResolvedValue({ items: [] });
    expect(await adapter().preflight(context(), item, mutationId)).toEqual({ ready: true }); expect(await adapter().acceptTransfer(context(), item, mutationId)).toEqual(receipt);
    const job = (await notices.takeNextWarehouseInboundHandover())!; await notices.completeWarehouseInboundHandover(mutationId, job.claimToken); const notification = (await notices.takeNextNotification())!;
    await notices.markInboundCompletedSendStarted(notification.key, notification.claimToken, new Date(), () => true); await notices.completeNotification(notification.key, notification.claimToken, { messageId: 'om_inbound_target' }); expect(await adapter().reconcile(context(), receipt)).toEqual({ status: 'success' });
  });
  it('采购物料或数量变化拒旧预览；跨楼栋不列入，伪造职责和目标身份不能复用回执', async () => {
    const service = adapter(), [item] = await service.listPending(context()); pending.listPending.mockResolvedValue({ items: [{ ...row(), quantity: 2 }] }); expect((await service.preflight(context(), item, mutationId)).ready).toBe(false); await expect(service.acceptTransfer(context(), item, mutationId)).rejects.toThrow();
    pending.listPending.mockResolvedValue({ items: [{ ...row(), building: 'A楼' }] }); expect(await service.listPending(context())).toEqual([]);
    pending.listPending.mockResolvedValue({ items: [row()] }); await service.acceptTransfer(context(), item, mutationId); const other = context(); other.to.recordId = 'recForgedPerson'; expect((await service.preflight(other, item, mutationId)).ready).toBe(false); await expect(service.acceptTransfer(other, item, mutationId)).rejects.toThrow();
  });
  it('原生责任受理后提醒账本失败，原mutation重试补缺失步骤且不改写责任历史', async () => {
    const service = adapter(), [item] = await service.listPending(context()); const original = notices.acceptWarehouseInboundHandover.bind(notices); jest.spyOn(notices, 'acceptWarehouseInboundHandover').mockRejectedValueOnce(new Error('synthetic-notice-write')).mockImplementation(original);
    await expect(service.acceptTransfer(context(), item, mutationId)).rejects.toThrow('synthetic-notice-write'); const bytes = readFileSync(join(folder, 'inbound.json'), 'utf8'); pending.listPending.mockResolvedValue({ items: [] });
    expect(await service.preflight(context(), item, mutationId)).toEqual({ ready: true }); expect((await service.acceptTransfer(context(), item, mutationId)).status).toBe('accepted'); expect(readFileSync(join(folder, 'inbound.json'), 'utf8')).toBe(bytes);
  });
});
