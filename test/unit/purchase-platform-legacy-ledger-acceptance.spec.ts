import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PurchaseWorkflowStore } from '../../server/modules/purchase-inventory/purchase-workflow.store';
import { serializePurchaseManagerApprovalCardContext } from '../../server/modules/purchase-inventory/purchase-manager-approval-card';
import type { PurchasePlatformIdentityProof } from '../../server/modules/purchase-inventory/purchase-platform-identity-proof';
import { createPurchasePlatformIdentityVerifier } from '../../server/modules/purchase-inventory/purchase-platform-identity-proof';
import type { PurchaseWorkflowRecord } from '../../shared/purchase-workflow.interface';
import type { AccessPrincipal } from '../../shared/access-control.interface';
import { createPlatformLegacyApprovalWorker } from '../../server/modules/purchase-inventory/purchase-platform-legacy-approval-worker';
import { createPlatformLegacyApprovalGateway } from '../../server/modules/purchase-inventory/purchase-platform-legacy-approval-gateway';
import { PurchaseManagerApprovalService } from '../../server/modules/purchase-inventory/purchase-manager-approval.service';

const now = new Date(Date.now() + 60_000);
const sourceFingerprint=createHash('sha256').update(JSON.stringify(['cli_test','synthetic_base','tbl_test'])).digest('hex');
const record = { recordId: 'recLegacy', status: '未开始（待审批）', building: 'C楼', specialty: '电气' };
const proof: PurchasePlatformIdentityProof = Object.freeze({ source: 'platform', actorAccountId: 'person', actorAuthorizationVersion: 1, actorDisplayName: '合成人员', subjectAccountId: 'person', subjectAuthorizationVersion: 1, subjectDisplayName: '合成人员', sessionFamilyFingerprint: 'x'.repeat(43), expiresAt: Date.parse('2027-01-01T00:00:00Z') });

describe('旧单卡及无批次采购的真实临时账本安全边界', () => {
  let directory: string, path: string, store: PurchaseWorkflowStore;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'platform-legacy-ledger-'));
    path = join(directory, 'ledger.json'); store = new PurchaseWorkflowStore(path); await store.onModuleInit();
    await store.recordReminder('synthetic-legacy-ledger-test');
  });
  afterEach(async () => { await store.onModuleDestroy(); await rm(directory, { recursive: true, force: true }); });

  async function oldCard(recordId = record.recordId, messageId = 'om_original') {
    const cardContext = serializePurchaseManagerApprovalCardContext({ executionRecordId: recordId, requester: '申请人', building: 'C楼', title: '合成物品', quantity: 1 });
    await store.enqueueNotification({ businessEventId: `legacy-single-${recordId}`, recordId, recipientOpenId: 'ou_manager', kind: 'manager_approval_requested', cardContext });
    const pending = (await store.takeNextManagerApprovalNotification(now))!;
    await store.markManagerApprovalSendStarted(pending.key, pending.claimToken, cardContext, now);
    await store.completeManagerApprovalRequestAndRegisterCard(pending.key, pending.claimToken, { messageId }, now);
  }
  function platform(batchId = '', reason = '') {
    return store.claimPlatformApprovalItem({ approvalBatchId: batchId, record,
      request: { requestId: 'request_id_1234567890', recordId: record.recordId, choice: 'reject', rejectionReason: reason },
      identity: proof, lifecycleReady: false }, () => true, now);
  }
  const legacyRecord = { ...record, approvalCompleted:false, purchaseMethod:'综合采购' as const, requesterOpenId:'ou_requester', approvalBatchId:'', approvalActionId:'' };
  function newPlatform() { return store.claimPlatformLegacyApproval({ record:legacyRecord, requestId:'request_id_1234567890', decision:'rejected', identity:proof, appId:'cli_test', sourceFingerprint }, (_identity,_record,_mode,app,source) => { if(app!=='cli_test'||source!==sourceFingerprint) throw Error('wrong source'); return true; }); }

  it('无批次记录当前安全拒绝；不制造批次、卡片、审批动作或工作任务', async () => {
    await expect(platform()).rejects.toThrow();
    const data = JSON.parse(await readFile(path, 'utf8'));
    expect(data.managerApprovalBatches ?? []).toHaveLength(0);
    expect(data.managerApprovalCards ?? []).toHaveLength(0);
    expect(data.platformApprovalClaims ?? []).toHaveLength(0);
    expect(data.platformApprovalWork ?? []).toHaveLength(0);
  });

  it('真实旧单卡和平台请求竞争时当前平台保守拒绝，旧卡动作可受理且无伪造批次', async () => {
    await oldCard();
    const [web, card] = await Promise.allSettled([
      platform('invented-batch', '合成原因'),
      store.claimManagerApprovalAction({ recordId: record.recordId, messageId: 'om_original', actorOpenId: 'ou_manager', eventId: 'single-event', choice: 'comprehensive', rejectionReason: '' }, now),
    ]);
    expect(web.status).toBe('rejected'); expect(card.status).toBe('fulfilled');
    const data = JSON.parse(await readFile(path, 'utf8'));
    expect(data.managerApprovalBatches ?? []).toHaveLength(0);
    expect(data.platformApprovalClaims ?? []).toHaveLength(0);
    expect(data.managerApprovalActions).toHaveLength(1);
    expect(data.managerApprovalActions[0]).toMatchObject({ recordId: record.recordId, messageId: 'om_original', actorOpenId: 'ou_manager' });
  });

  it('旧卡认领后重启仍拒绝平台伪造批次，不改变另一张旧卡', async () => {
    await oldCard(); await oldCard('recOther', 'om_other');
    const originalOther = await store.findManagerApprovalCard('om_other', 'ou_manager'); expect(originalOther).not.toBeNull();
    await store.claimManagerApprovalAction({ recordId: record.recordId, messageId:'om_original', actorOpenId:'ou_manager', eventId:'single-event', choice:'comprehensive', rejectionReason:'' }, now);
    await store.onModuleDestroy(); store = new PurchaseWorkflowStore(path); await store.onModuleInit();
    await expect(platform('invented-batch', '合成原因')).rejects.toThrow();
    expect(await store.findManagerApprovalCard('om_other', 'ou_manager')).toEqual(originalOther);
    const data = JSON.parse(await readFile(path, 'utf8'));
    expect(data.managerApprovalActions).toHaveLength(1);
    expect(data.managerApprovalBatches ?? []).toHaveLength(0);
    expect(data.platformApprovalClaims ?? []).toHaveLength(0);
  });

  it('无批次空原因网页驳回持久认领，不伪造飞书身份或批次并可重启重放', async () => {
    const claimed = await newPlatform(); expect(claimed.kind).toBe('claim');
    expect(claimed.entry).toMatchObject({ recordId:'recLegacy', decision:'rejected', phase:'queued', identity:{ actorAccountId:'person' }, cards:[] });
    expect(claimed.entry).not.toHaveProperty('approvalBatchId');
    expect(claimed.entry.identity).not.toHaveProperty('actorFeishuOpenId');
    await store.onModuleDestroy(); store = new PurchaseWorkflowStore(path); await store.onModuleInit();
    const replay = await newPlatform(); expect(replay.kind).toBe('replay'); expect(replay.entry).toEqual(claimed.entry);
  });
  it('旧单卡与网页相反决定并发时仅一方认领', async () => {
    await oldCard();
    const outcomes = await Promise.allSettled([newPlatform(), store.claimManagerApprovalAction({ recordId:record.recordId, messageId:'om_original', actorOpenId:'ou_manager', eventId:'single-event', choice:'comprehensive', rejectionReason:'' }, now)]);
    const webWon = outcomes[0].status === 'fulfilled' && outcomes[0].value.kind === 'claim';
    const cardWon = outcomes[1].status === 'fulfilled' && outcomes[1].value.claimed;
    expect(Number(webWon) + Number(cardWon)).toBe(1);
    const data = JSON.parse(await readFile(path, 'utf8'));
    expect(data.managerApprovalBatches ?? []).toHaveLength(0);
    if (webWon) expect(outcomes[0].value.entry.cards).toMatchObject([{ messageId:'om_original', recipientOpenId:'ou_manager' }]);
  });
  it.each(['需求自采','需求自采（楼内）'] as const)('显式选择%s保留原方式快照，重启后按所选方式完成且禁止更改原请求', async purchaseMethod => {
    const input={record:legacyRecord,requestId:'method_request_1234567890',decision:'approved' as const,purchaseMethod,identity:proof,appId:'cli_test',sourceFingerprint};
    const first=await store.claimPlatformLegacyApproval(input,()=>true);
    expect(first.entry.originalPurchaseMethod).toBe('综合采购');
    await store.onModuleDestroy();store=new PurchaseWorkflowStore(path);await store.onModuleInit();
    expect((await store.claimPlatformLegacyApproval(input,()=>true)).kind).toBe('replay');
    await expect(store.claimPlatformLegacyApproval({...input,purchaseMethod:'综合采购'},()=>true)).rejects.toThrow();
    const lease=(await store.leasePlatformLegacyApproval(first.entry.eventId))!;
    const patch=await store.beginPlatformLegacyApprovalDispatch(first.entry.eventId,lease.token,legacyRecord as PurchaseWorkflowRecord,true);
    expect(patch['1️⃣物品采购方式']).toBe(purchaseMethod);expect(patch).not.toHaveProperty('采购人');
    const finished={...legacyRecord,status:'审批通过（待下单）',purchaseMethod,approvalActionId:first.entry.serverActionId} as PurchaseWorkflowRecord;
    await store.confirmPlatformLegacyApproval(first.entry.eventId,lease.token,finished,true);
    await store.completePlatformLegacyApproval(first.entry.eventId,lease.token);
    const replay=await store.claimPlatformLegacyApproval({...input,record:finished},()=>true);
    expect(replay.kind).toBe('replay');expect(replay.entry.phase).toBe('completed');
    expect(JSON.parse(await readFile(path,'utf8')).platformLegacyApprovalClaims).toHaveLength(1);
  });
  it('同一人员重新登录及原任务已改变单据状态后仍重放原任务，改变决定或人员仍拒绝', async () => {
    const first=await newPlatform();
    await store.onModuleDestroy();store=new PurchaseWorkflowStore(path);await store.onModuleInit();
    const input={record:{...legacyRecord,status:'驳回申请',purchaseMethod:'驳回' as const},requestId:'request_id_1234567890',decision:'rejected' as const,
      identity:{...proof,sessionFamilyFingerprint:'y'.repeat(43),expiresAt:proof.expiresAt+60_000},appId:'cli_test',sourceFingerprint};
    const authorize=jest.fn(()=>true as const);
    const replay=await store.claimPlatformLegacyApproval(input,authorize);
    expect(replay.kind).toBe('replay');expect(replay.entry).toEqual(first.entry);expect(authorize).toHaveBeenCalled();
    await expect(store.claimPlatformLegacyApproval({...input,decision:'approved'},()=>true)).rejects.toThrow();
    await expect(store.claimPlatformLegacyApproval({...input,identity:{...input.identity,actorAccountId:'other'}},()=>true)).rejects.toThrow();
    await expect(store.claimPlatformLegacyApproval(input,()=>{throw Error('当前权限已撤销');})).rejects.toThrow('当前权限已撤销');
    expect(JSON.parse(await readFile(path,'utf8')).platformLegacyApprovalClaims).toHaveLength(1);
  });
  it('当前个人审批权限仅允许指定楼栋及专业，锁内撤权不能认领', async () => {
    let permitted = true;
    const principal:AccessPrincipal = {accountId:'person',authorizationVersion:1,role:'guest',purchaseBuilding:null,effectiveAuthorization:{mode:'independent',baseline:{nativeRole:null,pages:[],rules:[{id:'scope',module:'purchase',effect:'allow',actions:['approve'],buildings:['C楼'],specialties:['电气']}]},overrides:{rules:[],allowPages:[],denyPages:[]}}};
    const expiresAt=Date.now()+60_000;
    const verifier = createPurchasePlatformIdentityVerifier({readSignedSession:() => ({principal,principalFingerprint:'x'.repeat(43),expiresAt}),snapshot:() => ({appId:'cli_test',accounts:[{id:'person',kind:'local',name:'合成人员',role:'guest',building:null,enabled:true,deleted:false,version:1,source:'configuration',loginMethod:'personnel-password',personnelActive:true,personnelAppId:'cli_test'}]}),currentPrincipal:() => permitted ? principal : undefined});
    const verified=verifier.verify('synthetic-session'), authorize=(identity:PurchasePlatformIdentityProof,row:typeof legacyRecord,_mode:'new'|'replay',app:string,source:string) => {if(app!=='cli_test'||source!==sourceFingerprint)throw Error('wrong source');verifier.assertCurrent(identity,'approve',row);return true as const;};
    await expect(store.claimPlatformLegacyApproval({record:{...legacyRecord,building:'A楼'},requestId:'request_denied_123456',decision:'rejected',identity:verified,appId:'cli_test',sourceFingerprint},authorize)).rejects.toThrow();
    permitted=false;
    await expect(store.claimPlatformLegacyApproval({record:legacyRecord,requestId:'request_revoked_12345',decision:'rejected',identity:verified,appId:'cli_test',sourceFingerprint},authorize)).rejects.toThrow();
    permitted=true;
    expect((await store.claimPlatformLegacyApproval({record:legacyRecord,requestId:'request_allowed_12345',decision:'rejected',identity:verified,appId:'cli_test',sourceFingerprint},authorize)).kind).toBe('claim');
  });

  it('确认原动作回执后原子排队刷新原卡，保留另一张旧卡及未知账本字段', async () => {
    await oldCard(); await oldCard('recOther','om_other');
    const other = await store.findManagerApprovalCard('om_other','ou_manager'); expect(other).not.toBeNull();
    const before = JSON.parse(await readFile(path,'utf8')); before.unrelatedFutureData = {keep:'yes'};
    await import('node:fs/promises').then(fs => fs.writeFile(path,JSON.stringify(before)));
    const claim = await newPlatform(), lease = (await store.leasePlatformLegacyApproval(claim.entry.eventId))!;
    const patch = await store.beginPlatformLegacyApprovalDispatch(claim.entry.eventId,lease.token,legacyRecord as PurchaseWorkflowRecord,true);
    expect(patch).toEqual({'1️⃣物品采购方式':'驳回','采购流程':'驳回申请','采购审批动作标识':claim.entry.serverActionId});
    await store.confirmPlatformLegacyApproval(claim.entry.eventId,lease.token,{...legacyRecord,status:'驳回申请',purchaseMethod:'驳回',approvalActionId:claim.entry.serverActionId} as PurchaseWorkflowRecord,true);
    await store.completePlatformLegacyApproval(claim.entry.eventId,lease.token);
    await store.onModuleDestroy(); store = new PurchaseWorkflowStore(path); await store.onModuleInit();
    expect(await store.findManagerApprovalCard('om_other','ou_manager')).toEqual(other);
    const data=JSON.parse(await readFile(path,'utf8')); expect(data.unrelatedFutureData).toEqual({keep:'yes'});
    expect(data.managerApprovalBatches ?? []).toHaveLength(0); expect(data.managerApprovalActions ?? []).toHaveLength(0);
    const notification=(await store.takeNextManagerApprovalNotification(new Date(Date.now()+60_000)))!;
    expect(notification).toMatchObject({kind:'manager_approval_resolved',messageId:'om_original',recipientOpenId:'ou_manager'});
    expect(await store.getVerifiedPlatformLegacyCardResolution(notification.key,notification.claimToken)).toMatchObject({recordId:'recLegacy',messageId:'om_original',recipientOpenId:'ou_manager',decision:'rejected',actorDisplayName:'合成人员'});
    await expect(store.getVerifiedPlatformLegacyCardResolution(notification.key,'bad-token')).rejects.toThrow();
    expect((await store.leasePlatformLegacyApproval(claim.entry.eventId))?.kind).toBe('done');
  });
  it('缺少可信动作字段或回执时不进入发送阶段或排队成功卡片', async () => {
    await oldCard(); const claim = await newPlatform(), lease = (await store.leasePlatformLegacyApproval(claim.entry.eventId))!;
    await expect(store.beginPlatformLegacyApprovalDispatch(claim.entry.eventId,lease.token,legacyRecord as PurchaseWorkflowRecord,false)).rejects.toThrow();
    expect((await readFile(path,'utf8'))).not.toContain('manager_approval_resolved:platform_');
    await store.beginPlatformLegacyApprovalDispatch(claim.entry.eventId,lease.token,legacyRecord as PurchaseWorkflowRecord,true);
    await expect(store.confirmPlatformLegacyApproval(claim.entry.eventId,lease.token,{...legacyRecord,status:'驳回申请',purchaseMethod:'驳回',approvalActionId:claim.entry.serverActionId} as PurchaseWorkflowRecord,false)).rejects.toThrow();
    await expect(store.completePlatformLegacyApproval(claim.entry.eventId,lease.token)).rejects.toThrow();
    expect((await readFile(path,'utf8'))).not.toContain('manager_approval_resolved:platform_');
  });
  it('写入结果未知后重启只能核对，不能重复发送', async () => {
    const initial=Date.now(), clock=jest.spyOn(Date,'now').mockReturnValue(initial);
    try {
      const claim=await newPlatform(), first=(await store.leasePlatformLegacyApproval(claim.entry.eventId))!;
      await store.beginPlatformLegacyApprovalDispatch(claim.entry.eventId,first.token,legacyRecord as PurchaseWorkflowRecord,true);
      await store.onModuleDestroy(); store=new PurchaseWorkflowStore(path); await store.onModuleInit();
      clock.mockReturnValue(initial+61_000);
      const recovered=(await store.leasePlatformLegacyApproval(claim.entry.eventId))!;
      expect(recovered.kind).toBe('reconcile');
      await expect(store.beginPlatformLegacyApprovalDispatch(claim.entry.eventId,recovered.token,legacyRecord as PurchaseWorkflowRecord,true)).rejects.toThrow();
      await expect(store.confirmPlatformLegacyApproval(claim.entry.eventId,recovered.token,{...legacyRecord,status:'驳回申请',purchaseMethod:'驳回',approvalActionId:`pa_${'B'.repeat(43)}`} as PurchaseWorkflowRecord,true)).rejects.toThrow();
    } finally { clock.mockRestore(); }
  });
  it('网页受理后不再产生一张未绑定的新审批卡或新批次', async () => {
    await newPlatform();
    const cardContext=serializePurchaseManagerApprovalCardContext({executionRecordId:record.recordId,requester:'申请人',building:'C楼',title:'合成物品',quantity:1});
    await expect(store.enqueueNotification({businessEventId:'late-card',recordId:record.recordId,recipientOpenId:'ou_manager',kind:'manager_approval_requested',cardContext})).rejects.toThrow();
    await expect(store.registerManagerApprovalBatch({approvalBatchId:'synthetic-batch',recipientOpenId:'ou_manager',requesterOpenId:'ou_requester',recordIds:[record.recordId]})).rejects.toThrow();
  });
  it.each([['cli_other','synthetic_base','tbl_test'],['cli_test','other_base','tbl_test'],['cli_test','synthetic_base','tbl_other']])('受理后来源变为 %s/%s/%s 时 worker 不写入', async (...changed) => {
    const claim=await newPlatform(), current=createHash('sha256').update(JSON.stringify(changed)).digest('hex');
    const gateway={verifyMarker:jest.fn(async(expected:string)=>{if(expected!==current)throw Error('source mismatch');}),readSnapshot:jest.fn(async()=>({record:legacyRecord as PurchaseWorkflowRecord,markerPresent:true})),writeDecision:jest.fn(async()=>{})};
    expect(await createPlatformLegacyApprovalWorker(store,gateway).run(claim.entry.eventId)).toBe('busy');
    expect(gateway.readSnapshot).not.toHaveBeenCalled();expect(gateway.writeDecision).not.toHaveBeenCalled();
  });
  it('真实隔离网关与账本绑定 app/Base/table，HTTP 模拟只写冻结的表', async () => {
    const claim=await newPlatform();let source={appId:'cli_test',appToken:'synthetic_base',tableId:'tbl_test'};
    const raw={record_id:'recLegacy',fields:{'1️⃣物品采购方式':'综合采购','采购流程':'未开始（待审批）','采购审批批次号':null,'采购审批动作标识':null,'申请楼栋':'C楼','专业':'电气','需求人':[{id:'ou_requester'}]}};
    const fields=['1️⃣物品采购方式','采购流程','采购审批动作标识','采购审批批次号'].map((field_name,i)=>({field_name,field_id:`fld${i}`,type:i<2?3:1}));
    const http={axiosRef:{get:jest.fn(async()=>({data:{code:0,data:{items:fields,has_more:false}}})),post:jest.fn(async(url:string)=>url.includes('/auth/')?({data:{code:0,tenant_access_token:'synthetic'}}):({data:{code:0,data:{records:[structuredClone(raw)]}}})),put:jest.fn(async(_url:string,body:{fields:Record<string,string>})=>{Object.assign(raw.fields,body.fields);return {data:{code:0,data:{}}};})}};
    const native={getTenantAccessTokenAsApp:jest.fn(async()=>'synthetic')};
    const adapter=createPlatformLegacyApprovalGateway(native as never,http as never,()=>source,()=>({app_id:'cli_test',app_secret:'synthetic-only'}));
    expect(adapter.sourceFingerprint()).toBe(sourceFingerprint);
    await adapter.verifyMarker(sourceFingerprint);
    expect((await adapter.readSnapshot('recLegacy',sourceFingerprint)).markerPresent).toBe(true);
    expect(await createPlatformLegacyApprovalWorker(store,adapter).run(claim.entry.eventId)).toBe('completed');
    expect(http.axiosRef.put).toHaveBeenCalledTimes(1);
    expect(http.axiosRef.put.mock.calls[0][0]).toContain('/apps/synthetic_base/tables/tbl_test/records/recLegacy');
    source={...source,tableId:'tbl_other'};
    await expect(adapter.readSnapshot('recLegacy',claim.entry.sourceFingerprint)).rejects.toThrow();
    expect(http.axiosRef.put).toHaveBeenCalledTimes(1);
  });
  it('真实账本与隔离 worker 成功审批后仅刷新原卡，并且重试不重发', async () => {
    await oldCard(); const claim=await newPlatform(); let live={...legacyRecord} as PurchaseWorkflowRecord;
    const gateway={verifyMarker:jest.fn(async(_source:string)=>{}),readSnapshot:jest.fn(async(_id:string,_source:string)=>({record:structuredClone(live),markerPresent:true})),writeDecision:jest.fn(async (_id:string,patch:Record<string,string>,_source:string)=>{live={...live,status:patch['采购流程'],purchaseMethod:patch['1️⃣物品采购方式'] as PurchaseWorkflowRecord['purchaseMethod'],approvalActionId:patch['采购审批动作标识']};})};
    const worker=createPlatformLegacyApprovalWorker(store,gateway);
    expect(await worker.run(claim.entry.eventId)).toBe('completed');
    expect(await worker.run(claim.entry.eventId)).toBe('completed');
    expect(gateway.writeDecision).toHaveBeenCalledTimes(1);
    expect(claim.entry.sourceFingerprint).toBe(sourceFingerprint);
    expect(gateway.verifyMarker).toHaveBeenCalledWith(sourceFingerprint);
    expect(gateway.readSnapshot).toHaveBeenCalledTimes(3);
    for(const args of gateway.readSnapshot.mock.calls) expect(args[1]).toBe(sourceFingerprint);
    expect(gateway.writeDecision.mock.calls[0][2]).toBe(sourceFingerprint);
    expect((await store.findManagerApprovalCard('om_original','ou_manager'))?.state).toBe('resolved');
    const notification=(await store.takeNextManagerApprovalNotification(new Date(Date.now()+60_000)))!;
    expect(notification).toMatchObject({kind:'manager_approval_resolved',messageId:'om_original'});
    const transport={updateInteractiveCard:jest.fn(async(_messageId:string,_card:unknown)=>{}),sendInteractiveCard:jest.fn(async()=>{throw Error('must update original card');})};
    const manager=new PurchaseManagerApprovalService(transport as never,store);
    const result={processed:0,failed:0,manualReconciliation:0,alerts:[],errors:[]};
    try {
      expect(await (manager as any).processNotification(notification,new Date(Date.now()+60_000),result)).toBe(true);
      expect(transport.updateInteractiveCard).toHaveBeenCalledTimes(1);
      expect(transport.updateInteractiveCard.mock.calls[0][0]).toBe('om_original');
      const rendered=JSON.stringify(transport.updateInteractiveCard.mock.calls[0][1]);
      expect(rendered).toContain('已驳回');expect(rendered).toContain('合成人员');
      expect(rendered).not.toContain('驳回原因');expect(rendered).not.toContain('填写采购驳回原因');
      expect(transport.sendInteractiveCard).not.toHaveBeenCalled();
      expect((await store.listNotifications({kind:'manager_approval_resolved'})).filter(row=>row.status==='completed')).toHaveLength(1);
      expect(await store.takeNextManagerApprovalNotification(new Date(Date.now()+120_000))).toBeNull();
    } finally {/* This service owns no timer or module-destroy hook. */}
  });
  it('真实账本 worker 在发送前发现数据变化时停止且不发送', async () => {
    const claim=await newPlatform();let reads=0;
    const gateway={verifyMarker:jest.fn(async()=>{}),readSnapshot:jest.fn(async()=>({record:{...legacyRecord,...(++reads===2?{requesterOpenId:'ou_changed'}:{})} as PurchaseWorkflowRecord,markerPresent:true})),writeDecision:jest.fn(async()=>{})};
    expect(await createPlatformLegacyApprovalWorker(store,gateway).run(claim.entry.eventId)).toBe('manual_reconciliation');
    expect(gateway.writeDecision).not.toHaveBeenCalled();
  });
  it('持久来源变化后只进入待核对，不能写另一张表', async () => {
    const claim=await newPlatform();let reads=0,current=['cli_test','synthetic_base','tbl_test'];
    const gateway={verifyMarker:jest.fn(async (source:string)=>{expect(source).toBe(sourceFingerprint);}),readSnapshot:jest.fn(async (_id:string,source:string)=>{if(++reads===2)current=['cli_test','synthetic_base','tbl_other'];if(source!==createHash('sha256').update(JSON.stringify(current)).digest('hex'))throw new Error('source changed');return {record:legacyRecord as PurchaseWorkflowRecord,markerPresent:true};}),writeDecision:jest.fn(async()=>{})};
    expect(await createPlatformLegacyApprovalWorker(store,gateway).run(claim.entry.eventId)).toBe('manual_reconciliation');
    expect(gateway.writeDecision).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(path,'utf8')).platformLegacyApprovalClaims[0].phase).toBe('manual');
  });
  it('真实账本 worker 写后丢回执，重启后只核对并完成，不重发', async () => {
    const initial=Date.now(), clock=jest.spyOn(Date,'now').mockReturnValue(initial);
    try {
      await oldCard();const claim=await newPlatform();let live={...legacyRecord} as PurchaseWorkflowRecord;
      const gateway={verifyMarker:jest.fn(async(_source:string)=>{}),readSnapshot:jest.fn(async(_id:string,_source:string)=>({record:structuredClone(live),markerPresent:true})),writeDecision:jest.fn(async (_id:string,patch:Record<string,string>,_source:string)=>{live={...live,status:patch['采购流程'],purchaseMethod:patch['1️⃣物品采购方式'] as PurchaseWorkflowRecord['purchaseMethod'],approvalActionId:patch['采购审批动作标识']};throw new Error('synthetic lost response');})};
      expect(await createPlatformLegacyApprovalWorker(store,gateway).run(claim.entry.eventId)).toBe('manual_reconciliation');
      await store.onModuleDestroy();store=new PurchaseWorkflowStore(path);await store.onModuleInit();clock.mockReturnValue(initial+61_000);
      expect(await createPlatformLegacyApprovalWorker(store,gateway).run(claim.entry.eventId)).toBe('completed');
      expect(gateway.writeDecision).toHaveBeenCalledTimes(1);
      expect(gateway.writeDecision.mock.calls[0][2]).toBe(sourceFingerprint);
      for(const args of gateway.readSnapshot.mock.calls) expect(args[1]).toBe(sourceFingerprint);
      expect((await store.findManagerApprovalCard('om_original','ou_manager'))?.state).toBe('resolved');
    } finally { clock.mockRestore(); }
  });
  it('真实账本 worker 核不到动作标识元数据，不发远端写入', async () => {
    const claim=await newPlatform();
    const gateway={verifyMarker:jest.fn(async()=>{throw new Error('synthetic metadata missing');}),readSnapshot:jest.fn(async()=>({record:legacyRecord as PurchaseWorkflowRecord,markerPresent:false})),writeDecision:jest.fn(async()=>{})};
    expect(await createPlatformLegacyApprovalWorker(store,gateway).run(claim.entry.eventId)).toBe('busy');
    expect(gateway.writeDecision).not.toHaveBeenCalled();
  });
});

jest.mock('../../server/common/hotfix-runtime-activation',()=>({currentHotfixActivation:()=>({isAcceptingNewWork:()=>true})}));
