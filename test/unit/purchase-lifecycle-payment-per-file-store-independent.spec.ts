jest.mock('../../server/common/config/external-services.config', () => ({ ...jest.requireActual('../../server/common/config/external-services.config'), readEnv: (key: string) => key === 'FEISHU_APP_ID' ? 'cli_test_app' : key === 'PUBLIC_BASE_URL' ? 'https://www.sm.sjhl.online:3001' : '' }));
import { randomUUID, createHash } from 'node:crypto';
import { LifecyclePaymentPerFileStoreAdapter } from '../../server/modules/purchase-inventory/purchase-lifecycle-payment-per-file-store-adapter';
import { LifecyclePaymentUploadIsolatedService } from '../../server/modules/purchase-inventory/purchase-lifecycle-payment-upload-isolated';
import { LifecyclePaymentPerFileOrchestrator } from '../../server/modules/purchase-inventory/purchase-lifecycle-payment-upload-per-file';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PurchaseWorkflowStore } from '../../server/modules/purchase-inventory/purchase-workflow.store';
import { LifecyclePaymentUploadStoreAdapter } from '../../server/modules/purchase-inventory/purchase-lifecycle-payment-upload-store-adapter';
import { serializePurchaseManagerBatchApprovalCardContext } from '../../server/modules/purchase-inventory/purchase-manager-batch-approval-card';
import type { LifecyclePaymentUploadIdentity, LifecyclePaymentUploadSelector } from '../../server/modules/purchase-inventory/purchase-lifecycle-payment-upload-isolated';

describe('lifecycle payment upload using actual ledger transactions', () => {
  const appId = 'cli_test_app', batchId = 'purchase-application-payment', recordId = 'rec_one', manager = 'ou_manager', buyer = 'ou_buyer';
  const now = Date.now(), requestId = randomUUID();
  const selector: LifecyclePaymentUploadSelector = { approvalBatchId: batchId, executionRecordId: recordId, generation: 1 };
  const request = { requestId, files: [{ sha256: 'a'.repeat(64), size: 123, name: '付款.png' }] };
  let folder: string, file: string, store: PurchaseWorkflowStore, adapter: LifecyclePaymentUploadStoreAdapter, makeAdapter: () => LifecyclePaymentUploadStoreAdapter, previous: string | undefined;
  let allowed: boolean, current: boolean, remoteBatchId: string, grantAction: boolean;
  let perFileAdapter: LifecyclePaymentPerFileStoreAdapter;
  const identity: LifecyclePaymentUploadIdentity = { uploadSourceFingerprint: 'a'.repeat(64), appId, openId: buyer, accountId: 'account_buyer', authorizationVersion: 1, kind: 'feishu', origin: 'https://www.sm.sjhl.online:3001', assertCurrent: () => { if (!current) throw new Error('session revoked'); } };

  beforeEach(async () => {
    previous = process.env.FEISHU_APP_ID; process.env.FEISHU_APP_ID = appId;
    allowed = true; current = true; remoteBatchId = batchId; grantAction = true;
    folder = await mkdtemp(join(tmpdir(), 'purchase-payment-store-')); file = join(folder, 'ledger.json');
    store = new PurchaseWorkflowStore(file); await store.onModuleInit();
    await store.registerManagerApprovalBatch({ approvalBatchId: batchId, recipientOpenId: manager, requesterOpenId: 'ou_requester', recordIds: [recordId], flowVersion: 'lifecycle_v1' }, now, { appId, recipients: [{ openId: manager, fullView: false }], authorityTargets: [{ recordId, target: { building: 'H楼' } }], authorize: () => {} });
    await store.bindLifecycleReceiptImageSource(appId,identity.uploadSourceFingerprint!);
    const context = serializePurchaseManagerBatchApprovalCardContext({ version: 3, approvalBatchId: batchId, requesterOpenId: 'ou_requester', requesterName: '申请人', building: 'H楼', requestCode: 'CG-TEST', expectedDeliveryAt: '2026-01-10', createdAt: '2026-01-01', items: [{ executionRecordId: recordId, title: '测试', specification: '/', quantity: '1', unit: '个', amount: '1', status: 'pending', choice: '', rejectionReason: '' }] });
    const initial = await store.takeNextManagerApprovalNotification(now + 1000);
    await store.markManagerApprovalBatchSendStarted(initial!.key, initial!.claimToken, context, now + 1000);
    await store.completeManagerApprovalBatchRequestAndRegisterCard(initial!.key, initial!.claimToken, { messageId: 'om_manager' }, now + 1000);
    const managerIdentity = { appId, batchId, recipientOpenId: manager };
    const first = await store.beginLifecycleDelivery(managerIdentity, now + 1000, 1, 1, () => {});
    await store.markLifecycleDeliveryDispatched(managerIdentity, first.entry.attemptToken, () => {});
    await store.completeLifecycleDelivery(managerIdentity, first.entry.attemptToken, { kind: 'send', receipt: { source: 'feishu_message_readback', uuid: first.entry.replica.uuid, messageId: 'om_manager', sentAtMs: now - 1000 } });
    await store.claimManagerApprovalBatchPendingApproval({ approvalBatchId: batchId, actorOpenId: manager, messageId: 'om_manager', eventId: 'approve', choice: 'comprehensive', lifecycle: { appId, cardRevision: 1 } }, now + 2000, () => {});
    const action = await store.takeNextManagerApprovalBatchAction(now + 2000);
    await store.completeManagerApprovalBatchActionRecord(action!.key, action!.claimToken, recordId, { purchaserOpenId: buyer, purchaserName: '采购员', authorityTarget: { building: 'H楼' } }, now + 2001);
    let task = await store.takeNextManagerApprovalNotification(now + 3000);
    while (task && task.kind !== 'manager_batch_purchase_assigned') { await store.failNotification(task.key, task.claimToken, new Error('fixture'), now + 3000); task = await store.takeNextManagerApprovalNotification(now + 3000); }
    if (!task) throw new Error('purchase notification missing');
    const enrolled = await store.enrollLifecycleRecipientFromNotification(task.key, task.claimToken, () => {});
    const buyerIdentity = { appId, batchId, recipientOpenId: buyer }, state = (await store.getLifecycleOutbox(buyerIdentity))!;
    const send = await store.beginLifecycleDelivery(buyerIdentity, now + 3000, state.desiredRevision, state.desiredPage, () => {});
    await store.markLifecycleDeliveryDispatched(buyerIdentity, send.entry.attemptToken, () => {});
    await store.completeLifecycleDelivery(buyerIdentity, send.entry.attemptToken, { kind: 'send', receipt: { source: 'feishu_message_readback', uuid: send.entry.replica.uuid, messageId: 'om_buyer', sentAtMs: now - 500 } });
    await store.completeLifecycleStageNotification(task.key, task.claimToken, enrolled.stageTargetRevision, undefined, () => {}, now + 3001);
    const authorizer = { prepare: async () => ({ assertCurrent: () => { if (!allowed) throw new Error('permission revoked'); }, verifyLatest: async () => { if (!allowed) throw new Error('permission revoked'); }, authorizeBatch: () => {}, project: () => ({ items: [{ recordId, status: '审批通过（待下单）', stages: [{ stage: 'ordering', fields: [] }] }], viewer: { kind: 'participant', grants: [{ recordId, visibleStages: ['ordering'], allowedActions: grantAction ? ['order'] : [] }] } }) }) };
    const reader = { getExecutionRecordAsApp: async () => ({ recordId, approvalBatchId: remoteBatchId, purchaserOpenId: buyer, building: 'H楼', specialty: '', status: '审批通过（待下单）' }) };
    makeAdapter = () => new LifecyclePaymentUploadStoreAdapter(store, authorizer as never, reader as never);
    adapter = makeAdapter();
    perFileAdapter = new LifecyclePaymentPerFileStoreAdapter(store, authorizer as never, reader as never);
  });
  afterEach(async () => { jest.restoreAllMocks(); await store.onModuleDestroy(); await rm(folder, { recursive: true, force: true }); if (previous === undefined) delete process.env.FEISHU_APP_ID; else process.env.FEISHU_APP_ID = previous; });

  const files=()=>({requestId:randomUUID(),files:[{sha256:'a'.repeat(64),size:123,name:'first.png'},{sha256:'b'.repeat(64),size:456,name:'second.png'}]});
  it('重启后新来源不能接管已确认的付款任务，原来源可继续且回执保留',async()=>{
    const request=files(),task=await perFileAdapter.reserve(identity,selector,request),attempt=randomUUID();
    await perFileAdapter.beginFile(identity,selector,request,task.key,0,attempt);
    await store.onModuleDestroy();store=new PurchaseWorkflowStore(file);await store.onModuleInit();
    const changed={...identity,uploadSourceFingerprint:'b'.repeat(64)};
    await expect(store.bindLifecycleReceiptImageSource(appId,changed.uploadSourceFingerprint)).rejects.toThrow('来源已变化');
    await store.confirmLifecyclePaymentPerFile(task.key,0,attempt,'original_source_receipt');
    await expect(store.reserveLifecyclePaymentPerFile(changed,selector,request,()=>{})).rejects.toThrow('持久来源');
    await expect(store.beginLifecyclePaymentPerFile(changed,selector,request,task.key,1,randomUUID(),()=>{})).rejects.toThrow('持久来源');
    await expect(store.commitLifecyclePaymentPerFile(changed,selector,request,task.key,()=>{})).rejects.toThrow('持久来源');
    expect(await store.lifecyclePaymentUploadStatus(changed,selector,request.requestId)).toEqual({state:'manual_reconciliation'});
    const resumed=await store.reserveLifecyclePaymentPerFile(identity,selector,request,()=>{});
    expect(resumed.files.map(file=>file.state)).toEqual(['confirmed','pending']);
    expect(await store.lifecyclePaymentUploadStatus(identity,selector,request.requestId)).toEqual({state:'resumable'});
  });
  it('来源变化仍可安全取消尚未发送任务，但不能重绑或恢复发送',async()=>{
    const request=files();await perFileAdapter.reserve(identity,selector,request);
    const changed={...identity,uploadSourceFingerprint:'b'.repeat(64)};
    expect(await store.cancelUnsentLifecyclePaymentUpload(changed,selector,request.requestId)).toEqual({state:'cancelled'});
    await expect(store.reserveLifecyclePaymentPerFile(identity,selector,request,()=>{})).rejects.toThrow('已取消');
  });
  it.each(['task','cancel','tokens'])('无绑定的旧付款 %s 历史不能自动认领为当前来源',async kind=>{
    const request=files();
    if(kind==='task')await perFileAdapter.reserve(identity,selector,request);
    if(kind==='cancel')await store.cancelUnsentLifecyclePaymentUpload(identity,selector,request.requestId);
    await store.onModuleDestroy();
    const raw=JSON.parse(await readFile(file,'utf8'));delete raw.lifecycleReceiptImageSource;
    if(kind==='tokens')raw.managerApprovalBatches[0].items[0].paymentAttachmentTokens=['old_source_file'];
    await writeFile(file,JSON.stringify(raw));store=new PurchaseWorkflowStore(file);await store.onModuleInit();
    await expect(store.bindLifecycleReceiptImageSource(appId,identity.uploadSourceFingerprint!)).rejects.toThrow('不可自动接管');
    expect(JSON.parse(await readFile(file,'utf8')).lifecycleReceiptImageSource).toBeUndefined();
  });
  it('实际 service 接逐文件适配，部分确认可恢复且只上传未完成文件',async()=>{
    const uploadFiles=[{originalname:'one.png',mimetype:'image/png',size:3,buffer:Buffer.from('one')},{originalname:'two.png',mimetype:'image/png',size:3,buffer:Buffer.from('two')}];
    const request={requestId:randomUUID(),files:uploadFiles.map(file=>({name:file.originalname,size:file.size,sha256:createHash('sha256').update(file.buffer).digest('hex')}))};
    const first=await perFileAdapter.reserve(identity,selector,request),attempt=randomUUID();
    await perFileAdapter.beginFile(identity,selector,request,first.key,0,attempt);await perFileAdapter.confirmFile(first.key,0,attempt,'first_confirmed');
    expect(await store.lifecyclePaymentUploadStatus(identity,selector,request.requestId)).toEqual({state:'resumable'});
    const transport={uploadOne:jest.fn(async(_file:unknown)=> 'second_confirmed')};
    const service=new LifecyclePaymentUploadIsolatedService(adapter,transport,{isReady:()=>true},perFileAdapter);
    await expect(service.upload(identity,selector,request.requestId,[{...uploadFiles[0],buffer:Buffer.from('bad')},uploadFiles[1]])).rejects.toThrow();
    expect(transport.uploadOne).not.toHaveBeenCalled();
    expect(await service.upload(identity,selector,request.requestId,uploadFiles)).toEqual({state:'completed'});
    expect(transport.uploadOne).toHaveBeenCalledTimes(1);expect(transport.uploadOne.mock.calls[0][0]).toMatchObject({originalname:'two.png'});
    expect(await service.status(identity,selector,request.requestId)).toEqual({state:'completed'});
    // Committing queues a newer card revision. Recovery queries the original
    // task instead of resubmitting through the now-stale editable card.
    expect(await service.status(identity,selector,request.requestId)).toEqual({state:'completed'});expect(transport.uploadOne).toHaveBeenCalledTimes(1);
  });
  it('逐项记录回执后一次性合并，公开结果不含 token',async()=>{
    const request=files(), first=await store.reserveLifecyclePaymentPerFile(identity,selector,request,()=>{});
    expect(first.files.map(row=>row.state)).toEqual(['pending','pending']);
    const a=randomUUID(),b=randomUUID();
    await store.beginLifecyclePaymentPerFile(identity,selector,request,first.key,0,a,()=>{});
    const one=await store.confirmLifecyclePaymentPerFile(first.key,0,a,'file_one');
    expect(one.files.map(row=>row.state)).toEqual(['confirmed','pending']);expect(JSON.stringify(one)).not.toContain('file_one');
    await store.onModuleDestroy();store=new PurchaseWorkflowStore(file);await store.onModuleInit();
    const replay=await store.reserveLifecyclePaymentPerFile(identity,selector,request,()=>{});expect(replay.files.map(row=>row.state)).toEqual(['confirmed','pending']);
    await store.beginLifecyclePaymentPerFile(identity,selector,request,first.key,1,b,()=>{});
    await store.confirmLifecyclePaymentPerFile(first.key,1,b,'file_two');
    const committed=await store.commitLifecyclePaymentPerFile(identity,selector,request,first.key,()=>{});expect(committed.state).toBe('committed');
    expect(await store.lifecyclePaymentUploadStatus(identity,selector,request.requestId)).toEqual({state:'completed'});
    const raw=JSON.parse(await readFile(file,'utf8'));expect(raw.managerApprovalBatches[0].items[0].paymentAttachmentTokens).toEqual(['file_one','file_two']);
    expect(raw.lifecyclePaymentUploads[0].entry.status).toBe('committed');expect(raw.lifecycleOutbox.every((row:{desiredRevision:number})=>row.desiredRevision>0)).toBe(true);
  });
  it('同文件并发只认领一次，重启后不重复发送未知结果',async()=>{
    const request=files(),first=await store.reserveLifecyclePaymentPerFile(identity,selector,request,()=>{}),a=randomUUID(),b=randomUUID();
    const races=await Promise.allSettled([store.beginLifecyclePaymentPerFile(identity,selector,request,first.key,0,a,()=>{}),store.beginLifecyclePaymentPerFile(identity,selector,request,first.key,0,b,()=>{})]);
    expect(races.filter(row=>row.status==='fulfilled')).toHaveLength(1);
    const attempt=(races.find(row=>row.status==='fulfilled') as PromiseFulfilledResult<any>).value.files[0].attemptId;
    await store.onModuleDestroy();store=new PurchaseWorkflowStore(file);await store.onModuleInit();
    const current=await store.reserveLifecyclePaymentPerFile(identity,selector,request,()=>{});expect(current.files[0]!.state).toBe('dispatching');
    await expect(store.beginLifecyclePaymentPerFile(identity,selector,request,first.key,0,randomUUID(),()=>{})).rejects.toThrow();
    await store.markLifecyclePaymentPerFileUncertain(first.key,0,attempt);
    const unknown=await store.reserveLifecyclePaymentPerFile(identity,selector,request,()=>{});expect(unknown.state).toBe('manual_reconciliation');
    expect(await store.lifecyclePaymentUploadStatus(identity,selector,request.requestId)).toEqual({state:'manual_reconciliation'});
  });
  it('不同请求对同明细互斥，取消前围栏阻止迟到受理',async()=>{
    const request=files(),first=await store.reserveLifecyclePaymentPerFile(identity,selector,request,()=>{});
    await expect(store.reserveLifecyclePaymentPerFile(identity,selector,{requestId:randomUUID(),files:[{sha256:'c'.repeat(64),size:200,name:'other.png'}]},()=>{})).rejects.toThrow();
    await store.cancelUnsentLifecyclePaymentUpload(identity,selector,request.requestId);
    await expect(store.beginLifecyclePaymentPerFile(identity,selector,request,first.key,0,randomUUID(),()=>{})).rejects.toThrow();
    await expect(store.reserveLifecyclePaymentPerFile(identity,selector,request,()=>{})).rejects.toThrow();
  });
  it('权限撤销不会提交附件，回执已确认后可恢复',async()=>{
    const request={requestId:randomUUID(),files:[{sha256:'c'.repeat(64),size:100,name:'only.png'}]},first=await store.reserveLifecyclePaymentPerFile(identity,selector,request,()=>{}),attempt=randomUUID();
    await store.beginLifecyclePaymentPerFile(identity,selector,request,first.key,0,attempt,()=>{});await store.confirmLifecyclePaymentPerFile(first.key,0,attempt,'confirmed_file');
    const before=await readFile(file,'utf8');current=false;await expect(store.commitLifecyclePaymentPerFile(identity,selector,request,first.key,()=>{})).rejects.toThrow();current=true;
    expect(await readFile(file,'utf8')).toBe(before);expect((await store.commitLifecyclePaymentPerFile(identity,selector,request,first.key,()=>{})).state).toBe('committed');
  });
  it('同一明细不同请求并发仅受理一个，不依赖文件是否相同',async()=>{
    const a=files(),b={requestId:randomUUID(),files:[{sha256:'c'.repeat(64),size:100,name:'different.png'}]};
    const results=await Promise.allSettled([store.reserveLifecyclePaymentPerFile(identity,selector,a,()=>{}),store.reserveLifecyclePaymentPerFile(identity,selector,b,()=>{})]);
    expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(1);
    expect(JSON.parse(await readFile(file,'utf8')).lifecyclePaymentUploads).toHaveLength(1);
  });
  it('发送与取消并发只允许一个结果落盘',async()=>{
    const request=files(),first=await store.reserveLifecyclePaymentPerFile(identity,selector,request,()=>{});
    const results=await Promise.allSettled([store.beginLifecyclePaymentPerFile(identity,selector,request,first.key,0,randomUUID(),()=>{}),store.cancelUnsentLifecyclePaymentUpload(identity,selector,request.requestId)]);
    expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(1);
    expect(['dispatching','cancelled']).toContain((await store.lifecyclePaymentUploadStatus(identity,selector,request.requestId)).state);
  });
  it('写盘失败不推进发送围栏或丢弃已确认回执',async()=>{
    const request=files(),first=await store.reserveLifecyclePaymentPerFile(identity,selector,request,()=>{}),a=randomUUID();
    let before=await readFile(file,'utf8');
    const spy=jest.spyOn(store as unknown as {writeLifecycleRaw:(...args:unknown[])=>Promise<void>},'writeLifecycleRaw').mockRejectedValueOnce(new Error('synthetic disk failure'));
    await expect(store.beginLifecyclePaymentPerFile(identity,selector,request,first.key,0,a,()=>{})).rejects.toThrow('disk failure');expect(await readFile(file,'utf8')).toBe(before);
    await store.beginLifecyclePaymentPerFile(identity,selector,request,first.key,0,a,()=>{});before=await readFile(file,'utf8');spy.mockRejectedValueOnce(new Error('synthetic disk failure'));
    await expect(store.confirmLifecyclePaymentPerFile(first.key,0,a,'file_one')).rejects.toThrow('disk failure');expect(await readFile(file,'utf8')).toBe(before);spy.mockRestore();
  });
  it('错误回执和状态篡改失败关闭，不能丢弃已确认文件',async()=>{
    const request=files(),first=await store.reserveLifecyclePaymentPerFile(identity,selector,request,()=>{}),a=randomUUID();
    await store.beginLifecyclePaymentPerFile(identity,selector,request,first.key,0,a,()=>{});
    await expect(store.confirmLifecyclePaymentPerFile(first.key,0,randomUUID(),'file_one')).rejects.toThrow();
    await store.confirmLifecyclePaymentPerFile(first.key,0,a,'file_one');
    await expect(store.beginLifecyclePaymentPerFile(identity,selector,request,first.key,1,a,()=>{})).rejects.toThrow();
    const raw=JSON.parse(await readFile(file,'utf8'));raw.lifecyclePaymentUploads[0].perFile[0].sha256='f'.repeat(64);await writeFile(file,JSON.stringify(raw));
    await expect(store.lifecyclePaymentUploadStatus(identity,selector,request.requestId)).rejects.toThrow();
  });
  it('真实账本搭配逐文件编排：第二张响应丢失后不会重传第一或第二张',async()=>{
    const port={reserve:(i:any,s:any,r:any)=>store.reserveLifecyclePaymentPerFile(i,s,r,()=>{}),beginFile:(i:any,s:any,r:any,k:string,n:number,a:string)=>store.beginLifecyclePaymentPerFile(i,s,r,k,n,a,()=>{}),confirmFile:(k:string,n:number,a:string,t:string)=>store.confirmLifecyclePaymentPerFile(k,n,a,t),markFileUncertain:(k:string,n:number,a:string)=>store.markLifecyclePaymentPerFileUncertain(k,n,a),commit:(i:any,s:any,r:any,k:string)=>store.commitLifecyclePaymentPerFile(i,s,r,k,()=>{})};
    const gateway={uploadOne:jest.fn().mockResolvedValueOnce('file_one').mockRejectedValueOnce(new Error('synthetic lost response'))};
    const orchestrator=new LifecyclePaymentPerFileOrchestrator(port,gateway),requestId=randomUUID(),one=Buffer.from('synthetic first'),two=Buffer.from('synthetic second');
    const files=[{originalname:'one.png',mimetype:'image/png',size:one.length,buffer:one},{originalname:'two.png',mimetype:'image/png',size:two.length,buffer:two}];
    await expect(orchestrator.upload(identity,selector,requestId,files)).rejects.toThrow('待核对');
    expect(gateway.uploadOne).toHaveBeenCalledTimes(2);
    await store.onModuleDestroy();store=new PurchaseWorkflowStore(file);await store.onModuleInit();
    expect(await orchestrator.upload(identity,selector,requestId,files)).toEqual({state:'manual_reconciliation'});
    expect(gateway.uploadOne).toHaveBeenCalledTimes(2);
    const row=JSON.parse(await readFile(file,'utf8')).lifecyclePaymentUploads[0];expect(row.perFile.map((entry:any)=>entry.state)).toEqual(['confirmed','manual_reconciliation']);
  });
});
