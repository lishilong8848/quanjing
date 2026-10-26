import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { PurchaseWorkflowStore } from '../../server/modules/purchase-inventory/purchase-workflow.store';
import { PurchaseInventoryModule } from '../../server/modules/purchase-inventory/purchase-inventory.module';
import { serializePurchaseManagerBatchApprovalCardContext, type PurchaseManagerBatchApprovalCardInput } from '../../server/modules/purchase-inventory/purchase-manager-batch-approval-card';
import type { HandoverAdapter, HandoverContext } from '../../shared/personnel-handover.interface';
import { Test } from '@nestjs/testing';
import { AccessConfigurationService } from '../../server/common/access/access-configuration.service';
import { PurchasePersonnelHandoverAdapter } from '../../server/modules/purchase-inventory/purchase-personnel-handover.adapter';
import { PurchaseManagerApprovalService } from '../../server/modules/purchase-inventory/purchase-manager-approval.service';
import { PurchaseWorkflowGateway } from '../../server/modules/purchase-inventory/purchase-workflow.gateway';
import { PurchaseWorkflowService } from '../../server/modules/purchase-inventory/purchase-workflow.service';
import { PurchaseWorkflowReceiptTaskService } from '../../server/modules/purchase-inventory/purchase-workflow-receipt-task.service';

describe('真实采购人员交接adapter', () => {
  let directory: string, root: string, owner: string, store: PurchaseWorkflowStore;
  const batchId = 'synthetic-purchase-adapter', dutyRecordId = 'recPurchaseDuty', mutationId = `handover-${'b'.repeat(64)}`;
  const card: PurchaseManagerBatchApprovalCardInput = { version: 3, approvalBatchId: batchId, requesterName: '合成申请人', requesterOpenId: 'ou_synthetic_requester', building: 'C楼', requestCode: 'SYNTHETIC', expectedDeliveryAt: null, createdAt: null, items: [{ executionRecordId: 'recSyntheticPurchase', title: '合成物料', specification: '/', quantity: '1', unit: '个', amount: '1', status: 'pending', choice: '', rejectionReason: '' }] };
  beforeEach(async () => {
    root = realpathSync(tmpdir()); owner = randomUUID(); directory = mkdtempSync(join(root, 'nt-purchase-adapter-')); writeFileSync(join(directory, '.test-owner'), owner, { flag: 'wx' });
    store = new PurchaseWorkflowStore(join(directory, 'ledger.json')); await store.onModuleInit();
    await store.registerManagerApprovalBatch({ approvalBatchId: batchId, recipientOpenId: 'ou_synthetic_old', requesterOpenId: card.requesterOpenId, recordIds: [card.items[0].executionRecordId] });
    const notification = (await store.takeNextManagerApprovalNotification())!;
    await store.markManagerApprovalBatchSendStarted(notification.key, notification.claimToken, serializePurchaseManagerBatchApprovalCardContext(card));
    await store.completeManagerApprovalBatchRequestAndRegisterCard(notification.key, notification.claimToken, { messageId: 'om_synthetic_old' });
  });
  afterEach(async () => {
    await store.onModuleDestroy(); const canonical = (value: string) => resolve(value).toLowerCase();
    if (canonical(dirname(directory)) !== canonical(root) || !/^nt-purchase-adapter-[A-Za-z0-9]+$/u.test(basename(directory)) || !existsSync(directory) || lstatSync(directory).isSymbolicLink() || canonical(realpathSync(directory)) !== canonical(directory)) throw new Error('测试目录归属异常，已保留');
    for (const name of readdirSync(directory)) if (!lstatSync(join(directory, name)).isFile() || lstatSync(join(directory, name)).isSymbolicLink()) throw new Error('测试目录条目异常，已保留');
    if (readFileSync(join(directory, '.test-owner'), 'utf8') !== owner) throw new Error('测试归属标记异常，已保留'); rmSync(directory, { recursive: true, force: false });
  });
  it('真实采购adapter正式注册，职责及native回执绑定，route完成或新卡未确认均不能假报成功', async () => {
    const Adapter = (Reflect.getMetadata('providers', PurchaseInventoryModule) as Array<{ name?: string }>).find(provider => provider.name === 'PurchasePersonnelHandoverAdapter') as unknown as new (...args: unknown[]) => HandoverAdapter;
    expect(Adapter).toBeDefined();
    const originalApp = process.env.FEISHU_APP_ID; process.env.FEISHU_APP_ID = 'cli_synthetic_handover';
    try {
      const person = (recordId: string, openId: string, marker: string, active: boolean) => ({ id: `local-external-${marker.repeat(64)}`, recordId, openId, name: '合成人员', active, type: 'employee' as const, position: '综合管理', systemPosition: '', buildings: ['C楼' as const], specialties: [], permissionTags: [], dutyRecordIds: [dutyRecordId] });
      const context: HandoverContext = { from: person('recOldFixture', 'ou_synthetic_old', 'a', false), to: person('recNewFixture', 'ou_synthetic_new', 'b', true), directoryVersion: 'synthetic-v1', duties: [{ recordId: dutyRecordId, name: '采购经理审批', kind: 'purchase_manager', personnelIds: [`local-external-${'a'.repeat(64)}`], buildings: null, specialties: null, enabled: true, startsAt: 0, endsAt: null, parentDutyIds: [], version: 1 }] };
      const adapter = new Adapter(store, { canUseFeishuBusinessIdentity: () => true }, { isEnabled: () => true });
      const revision = (await store.findManagerApprovalBatch(batchId))!.revision;
      const [item] = await adapter.listPending(context); expect(item).toMatchObject({ module: 'purchase', dutyRecordId, version: String(revision), status: 'pending' });
      expect(await adapter.preflight(context, item)).toEqual({ ready: true });
      const receipt = await adapter.acceptTransfer(context, item, mutationId); expect(receipt).toMatchObject({ status: 'accepted', version: String(revision + 1) });
      expect(await adapter.reconcile(context, receipt)).toEqual({ status: 'syncing' });
      expect((await adapter.reconcile({ ...context, to: { ...context.to, recordId: 'recWrongFixture' } }, receipt)).status).toBe('error');
      expect(await adapter.acceptTransfer(context, item, mutationId)).toEqual(receipt);
      expect((Reflect.getMetadata('exports', PurchaseInventoryModule) as unknown[]).includes(Adapter)).toBe(true);
      const gateway = { updateInteractiveCard: jest.fn(async () => undefined), writeManagerPendingHandover: jest.fn(async () => undefined), writeManagerHandoverDeliveryReceipt: jest.fn(async () => undefined) };
      const worker = new PurchaseManagerApprovalService(gateway as never, store, undefined, undefined, undefined, { canUseFeishuBusinessIdentity: () => true } as never);
      jest.spyOn(worker, 'isEnabled').mockReturnValue(true); const now = Date.now();
      await worker.runPersonnelHandovers(1, new Date(now)); expect(await adapter.reconcile(context, receipt)).toEqual({ status: 'syncing' });
      const next = (await store.takeNextManagerApprovalNotification(new Date(now + 60_000)))!;
      await store.markManagerApprovalBatchSendStarted(next.key, next.claimToken, next.cardContext);
      await store.completeManagerApprovalBatchRequestAndRegisterCard(next.key, next.claimToken, { messageId: 'om_synthetic_new' });
      expect(await adapter.reconcile(context, receipt)).toEqual({ status: 'syncing' });
      await worker.runPersonnelHandoverDeliveries(1, new Date(now + 120_000)); expect(await adapter.reconcile(context, receipt)).toEqual({ status: 'success' });
      jest.restoreAllMocks();
    } finally { if (originalApp === undefined) delete process.env.FEISHU_APP_ID; else process.env.FEISHU_APP_ID = originalApp; }
  });
  it('采购adapter最小DI缺Config拒绝，显式端口构造且无初始化外写', async () => {
    const providers = [PurchasePersonnelHandoverAdapter, { provide: PurchaseWorkflowStore, useValue: store }, { provide: PurchaseManagerApprovalService, useValue: { isEnabled: () => true } }, { provide: PurchaseWorkflowGateway, useValue: {} }, { provide: PurchaseWorkflowService, useValue: { isEnabled: () => false } }, { provide: PurchaseWorkflowReceiptTaskService, useValue: {} }];
    await expect(Test.createTestingModule({ providers }).compile()).rejects.toThrow();
    const before = readFileSync(join(directory, 'ledger.json'), 'utf8');
    const module = await Test.createTestingModule({ providers: [...providers, { provide: AccessConfigurationService, useValue: { canUseFeishuBusinessIdentity: () => true } }] }).compile();
    expect(module.get(PurchasePersonnelHandoverAdapter)).toBeInstanceOf(PurchasePersonnelHandoverAdapter); expect(readFileSync(join(directory, 'ledger.json'), 'utf8')).toBe(before); await module.close();
  });
  it('批次已受理但通用回执未保存时，重启可用原mutation通过预检且不重复切换', async () => {
    const originalApp=process.env.FEISHU_APP_ID;process.env.FEISHU_APP_ID='cli_synthetic_handover';
    try {
      const person=(recordId:string,openId:string,marker:string,active:boolean)=>({id:`local-external-${marker.repeat(64)}`,recordId,openId,name:'合成人员',active,type:'employee' as const,position:'综合管理',systemPosition:'',buildings:['C楼' as const],specialties:[],permissionTags:[],dutyRecordIds:[dutyRecordId]});
      const context:HandoverContext={from:person('recOldFixture','ou_synthetic_old','a',false),to:person('recNewFixture','ou_synthetic_new','b',true),directoryVersion:'synthetic-v1',duties:[{recordId:dutyRecordId,name:'采购经理审批',kind:'purchase_manager',personnelIds:[`local-external-${'a'.repeat(64)}`],buildings:null,specialties:null,enabled:true,startsAt:0,endsAt:null,parentDutyIds:[],version:1}]};
      const make=():HandoverAdapter=>new PurchasePersonnelHandoverAdapter(store,{canUseFeishuBusinessIdentity:()=>true} as never,{isEnabled:()=>true} as never);
      let adapter=make();const [item]=await adapter.listPending(context),receipt=await adapter.acceptTransfer(context,item,mutationId);
      await store.onModuleDestroy();store=new PurchaseWorkflowStore(join(directory,'ledger.json'));await store.onModuleInit();adapter=make();const bytes=readFileSync(join(directory,'ledger.json'),'utf8');
      expect(await adapter.preflight(context,item,mutationId)).toEqual({ready:true});expect(await adapter.acceptTransfer(context,item,mutationId)).toEqual(receipt);expect(readFileSync(join(directory,'ledger.json'),'utf8')).toBe(bytes);
      for (const [ctx,value,id] of [[context,item,`handover-${'c'.repeat(64)}`],[{...context,to:{...context.to,recordId:'recWrongIdentity'}},item,mutationId],[context,{...item,dutyRecordId:'recWrongDuty'},mutationId],[context,{...item,recipients:[{name:'错误',openId:'ou_unrelated'}]},mutationId]] as const) {
        expect((await adapter.preflight(ctx,value,id)).ready).toBe(false);await expect(adapter.acceptTransfer(ctx,value,id)).rejects.toThrow();
      }
      expect(readFileSync(join(directory,'ledger.json'),'utf8')).toBe(bytes);
    } finally {if(originalApp===undefined)delete process.env.FEISHU_APP_ID;else process.env.FEISHU_APP_ID=originalApp;}
  });
});
