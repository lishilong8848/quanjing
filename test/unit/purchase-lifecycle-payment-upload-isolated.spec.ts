jest.mock('../../server/common/config/external-services.config', () => ({ ...jest.requireActual('../../server/common/config/external-services.config'), readEnv: (key: string) => key === 'FEISHU_APP_ID' ? 'cli_test' : key === 'PUBLIC_BASE_URL' ? 'https://www.sm.sjhl.online:3001' : key === 'FEISHU_PURCHASE_INVENTORY_APP_TOKEN' ? 'synthetic_base' : key === 'FEISHU_PURCHASE_EXECUTION_TABLE_ID' ? 'tbl_synthetic' : '' }));
import { randomUUID } from 'node:crypto';
import { beginLifecyclePaymentUpload, commitLifecyclePaymentUpload, markLifecyclePaymentUploadUncertain, planLifecyclePaymentUpload, recordLifecyclePaymentUpload, type LifecyclePaymentUploadAuthority, type LifecyclePaymentUploadEntry } from '../../server/modules/purchase-inventory/purchase-lifecycle-payment-upload';
import { LifecyclePaymentUploadIsolatedController, LifecyclePaymentUploadIsolatedService, LifecyclePaymentUploadSessionAccess, LifecyclePaymentUploadSessionGuard, type LifecyclePaymentUploadIdentity, type LifecyclePaymentUploadStorePort, type LifecyclePaymentUploadSelector, type LifecyclePaymentUploadReceivedFile } from '../../server/modules/purchase-inventory/purchase-lifecycle-payment-upload-isolated';

describe('isolated lifecycle payment upload', () => {
  const csrf = 'a'.repeat(43), selector: LifecyclePaymentUploadSelector = { approvalBatchId: 'purchase-application-test', executionRecordId: 'rec_one', generation: 1 };
  const file = (): LifecyclePaymentUploadReceivedFile => ({ originalname: '付款.png', mimetype: 'image/png', size: 3, buffer: Buffer.from('abc') });
  let enabled: boolean, duty: boolean, app: string, revision: number, uploads: jest.Mock, entry: LifecyclePaymentUploadEntry | null;
  let sessionAccess: LifecyclePaymentUploadSessionAccess, service: LifecyclePaymentUploadIsolatedService;
  const principal = { accountId: 'feishu-account', authorizationVersion: 1, role: 'admin', purchaseBuilding: null };
  const req = () => ({ headers: { origin: 'https://www.sm.sjhl.online:3001', 'sec-fetch-site': 'same-origin', 'x-suda-csrf-token': csrf, cookie: `__Host-vnet_access_session=valid; __Host-suda-csrf-token=${csrf}` } }) as never;
  let ports: LifecyclePaymentUploadStorePort;
  // One-file legacy-state fixture adapted to the production per-file service
  // contract. Multi-file receipts use the actual ledger integration suite.
  function makeService(port:LifecyclePaymentUploadStorePort=ports) {
    let descriptions:any[]=[];
    const task=(row:LifecyclePaymentUploadEntry)=>({key:row.key,state:row.status==='committed'?'committed':row.status==='cancelled'?'cancelled':row.status==='manual_reconciliation'?'manual_reconciliation':'active',files:descriptions.map((file,index)=>({...file,index,state:row.status==='prepared'?'pending':row.status==='uploaded'||row.status==='committed'?'confirmed':row.status==='manual_reconciliation'?'manual_reconciliation':'dispatching',...(row.attemptId?{attemptId:row.attemptId}:{})}))});
    const perFile:any={
      reserve:async(identity:any,selector:any,request:any)=>{descriptions=request.files;const d=await port.reserve(identity,selector,request);return task(d.entry);},
      beginFile:async(identity:any,selector:any,request:any,_key:any,_index:any,attemptId:any)=>task(await port.begin(identity,selector,request,entry!,attemptId)),
      confirmFile:async(_key:any,_index:any,attemptId:any,token:any)=>task(await port.recordConfirmed(entry!,attemptId,[token])),
      markFileUncertain:async(_key:any,_index:any,attemptId:any)=>port.markUncertain(entry!,attemptId),
      commit:async(identity:any,selector:any,request:any)=>{await port.commit(identity,selector,request,entry!);return task(entry!);},
    };
    return new LifecyclePaymentUploadIsolatedService(port,{uploadOne:async(file,attempt)=>(await uploads([file],attempt))[0]},{isReady:()=>true},perFile);
  }

  beforeEach(() => {
    enabled = true; duty = true; app = 'cli_test'; revision = 1; entry = null;
    const sessions = { cookieName: 'vnet_access_session', readSessionIdentity: (token: string) => token === 'valid' && enabled ? { principal, principalFingerprint: 'fingerprint', expiresAt: Date.now() + 60000 } : { principal: { role: 'guest' }, principalFingerprint: null, expiresAt: null } };
    const config = { currentPrincipal: () => enabled ? principal : undefined, snapshot: () => ({ appId: app, revision, accounts: [{ id: 'feishu-account', kind: 'feishu', enabled: true, openId: 'ou_buyer', appId: app }] }) };
    sessionAccess = new LifecyclePaymentUploadSessionAccess(sessions as never, config as never);
    const authority = (identity: LifecyclePaymentUploadIdentity): LifecyclePaymentUploadAuthority => ({
      session: { accountId: identity.accountId, authorizationVersion: identity.authorizationVersion, appId: identity.appId, openId: identity.openId, kind: 'feishu', shared: false, impersonated: false, active: true, requiresPasswordChange: false },
      origin: identity.origin, expectedOrigin: identity.origin, csrfVerified: true, currentAppId: app,
      target: { flowVersion: 'lifecycle_v1', approvalBatchId: selector.approvalBatchId, executionRecordId: selector.executionRecordId, purchaserOpenId: 'ou_buyer', orderState: 'waiting', messageId: 'om_buyer', generation: 1, cardRevision: 1, desiredRevision: 1, replicaState: 'delivered', sentAtMs: Date.now() - 1000 },
    });
    const check = (identity: LifecyclePaymentUploadIdentity) => { identity.assertCurrent(); if (!duty) throw new Error('duty revoked'); };
    ports = {
      async reserve(identity, _selector, request) { const decision = planLifecyclePaymentUpload(authority(identity), request, entry, [], Date.now(), () => check(identity)); if (decision.kind === 'new') entry = decision.entry; return decision; },
      async begin(identity, _selector, request, _entry, attemptId) { if (planLifecyclePaymentUpload(authority(identity), request, entry, [], Date.now(), () => check(identity)).kind !== 'start') throw new Error('conflict'); entry = beginLifecyclePaymentUpload(entry!, attemptId); return entry; },
      async recordConfirmed(_entry, attemptId, tokens) { entry = recordLifecyclePaymentUpload(entry!, attemptId, tokens); return entry; },
      async markUncertain(_entry, attemptId) { entry = markLifecyclePaymentUploadUncertain(entry!, attemptId); },
      async commit(identity, _selector, request, _entry) { entry = commitLifecyclePaymentUpload(authority(identity), request, entry!, [], Date.now(), () => check(identity)); },
      async status(identity) { check(identity); return { state: entry?.status === 'committed' ? 'completed' : entry?.status || 'not_found' }; },
      async cancel(identity) { check(identity); if (entry && entry.status !== 'prepared') throw new Error('already dispatched'); return { state: 'cancelled' }; },
    };
    uploads = jest.fn().mockResolvedValue(['file_token']);
    service = makeService();
  });

  it('derives actual personal session, verifies same origin and csrf, and notices account changes', () => {
    const identity = sessionAccess.resolve(req());
    expect(identity).toMatchObject({ accountId: 'feishu-account', openId: 'ou_buyer', appId: 'cli_test' });
    expect(() => sessionAccess.resolve({ headers: { ...((req() as any).headers), origin: 'https://attacker.example' } } as never)).toThrow();
    expect(() => sessionAccess.resolve({ headers: { ...((req() as any).headers), 'x-suda-csrf-token': 'b'.repeat(43) } } as never)).toThrow();
    expect(() => sessionAccess.resolve({ headers: { ...((req() as any).headers), cookie: `__Host-vnet_access_session=valid; __Host-suda-csrf-token=${csrf}; __Host-suda-csrf-token=${csrf}` } } as never)).toThrow();
    revision += 1; expect(() => identity.assertCurrent()).toThrow();
  });

  it('fails before any gateway call when required production adapters or readiness are absent', async () => {
    const identity = sessionAccess.resolve(req());
    await expect(new LifecyclePaymentUploadIsolatedService().upload(identity, selector, randomUUID(), [file()])).rejects.toThrow('尚未接入');
    await expect(new LifecyclePaymentUploadIsolatedService(ports, { upload: uploads }, { isReady: () => false }).upload(identity, selector, randomUUID(), [file()])).rejects.toThrow('尚未接入');
    expect(uploads).not.toHaveBeenCalled();
  });

  it('rejects before multipart handling when the real adapters are absent', () => {
    const access = jest.spyOn(sessionAccess, 'resolve');
    const guard = new LifecyclePaymentUploadSessionGuard(sessionAccess, new LifecyclePaymentUploadIsolatedService());
    expect(() => guard.canActivate({ switchToHttp: () => ({ getRequest: () => req() }) } as never)).toThrow('尚未接入');
    expect(access).not.toHaveBeenCalled();
  });

  it('uses actual bytes, persists a dispatch fence and commits once with fake locked ports', async () => {
    const identity = sessionAccess.resolve(req()), id = randomUUID();
    const result = await service.upload(identity, selector, id, [file()]);
    expect(result).toEqual({ state: 'completed' }); expect(JSON.stringify(result)).not.toContain('file_token'); expect(entry?.status).toBe('committed'); expect(uploads).toHaveBeenCalledTimes(1);
    expect((await service.upload(identity, selector, id, [file()])).state).toBe('completed'); expect(uploads).toHaveBeenCalledTimes(1);
    await expect(service.upload(identity, selector, id, [{ ...file(), buffer: Buffer.from('xyz') }])).rejects.toThrow();
  });

  it('marks unknown remote results for reconciliation and never resends', async () => {
    const identity = sessionAccess.resolve(req()), id = randomUUID(); uploads.mockRejectedValueOnce(new Error('synthetic_sensitive_remote_token'));
    try { await service.upload(identity, selector, id, [file()]); throw new Error('expected failure'); }
    catch (error) { expect(String(error)).toContain('结果待核对'); expect(String(error)).not.toContain('synthetic_sensitive_remote_token'); }
    expect(entry?.status).toBe('manual_reconciliation');
    expect((await service.upload(identity, selector, id, [file()])).state).toBe('manual_reconciliation');
    expect(uploads).toHaveBeenCalledTimes(1);
  });

  it('preserves confirmed remote evidence if permissions change before commit', async () => {
    const identity = sessionAccess.resolve(req()), id = randomUUID();
    uploads.mockImplementationOnce(async () => { duty = false; return ['file_token']; });
    await expect(service.upload(identity, selector, id, [file()])).rejects.toThrow('duty revoked');
    expect(entry?.status).toBe('uploaded'); duty = true;
    expect((await service.upload(identity, selector, id, [file()])).state).toBe('completed'); expect(uploads).toHaveBeenCalledTimes(1);
  });

  it('rejects a corrupt fence and identical files before contacting the gateway', async () => {
    const identity = sessionAccess.resolve(req());
    await expect(service.upload(identity, selector, randomUUID(), [file(), file()])).rejects.toThrow('重复');
    const broken = { ...ports, begin: async () => ({ key: 'wrong', status: 'prepared' } as LifecyclePaymentUploadEntry) };
    await expect(makeService(broken).upload(identity, selector, randomUUID(), [file()])).rejects.toThrow('不可核对');
    expect(uploads).not.toHaveBeenCalled();
  });

  it('uses a detached server-computed file snapshot across asynchronous reservation', async () => {
    const identity = sessionAccess.resolve(req()), input = file();
    let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    const delayed = { ...ports, reserve: async (...args: Parameters<LifecyclePaymentUploadStorePort['reserve']>) => { const result = await ports.reserve(...args); await gate; return result; } };
    const run = makeService(delayed).upload(identity, selector, randomUUID(), [input]);
    input.buffer.fill(0); finish();
    expect((await run).state).toBe('completed');
    expect(uploads.mock.calls[0]![0][0].buffer.toString()).toBe('abc');
  });

  it('serializes duplicate requests through the store fence before any remote dispatch', async () => {
    const identity = sessionAccess.resolve(req()), id = randomUUID();
    const results = await Promise.allSettled([service.upload(identity, selector, id, [file()]), service.upload(identity, selector, id, [file()])]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(uploads).toHaveBeenCalledTimes(1);
  });

  it('exposes only same-session status and cancellation through strict JSON selectors', async () => {
    const identity = sessionAccess.resolve(req()), id = randomUUID(), controller = new LifecyclePaymentUploadIsolatedController(service);
    const request = { lifecyclePaymentIdentity: identity } as never;
    const body = { ...selector, requestId: id };
    expect(await controller.status(request, body)).toEqual({ state: 'not_found' });
    expect(await controller.cancel(request, body)).toEqual({ state: 'cancelled' });
    expect(() => controller.status(request, { ...body, actorOpenId: 'ou_other' })).toThrow();
    await expect(service.status(undefined, selector, id)).rejects.toThrow();
    expect(uploads).not.toHaveBeenCalled();
  });
  it('keeps original-task status and cancellation available while new uploads are disabled', async () => {
    const recoveryOnly=new LifecyclePaymentUploadIsolatedService(ports,undefined,{isReady:()=>false});
    const identity=sessionAccess.resolve(req()),id=randomUUID();
    expect(await recoveryOnly.status(identity,selector,id)).toEqual({state:'not_found'});
    expect(await recoveryOnly.cancel(identity,selector,id)).toEqual({state:'cancelled'});
    await expect(recoveryOnly.upload(identity,selector,id,[file()])).rejects.toThrow('尚未接入');
    await expect(new LifecyclePaymentUploadIsolatedService().status(identity,selector,id)).rejects.toThrow('恢复记录尚未接入');
    enabled=false;
    await expect(recoveryOnly.status(identity,selector,id)).rejects.toThrow();
    await expect(recoveryOnly.cancel(identity,selector,id)).rejects.toThrow();
    expect(uploads).not.toHaveBeenCalled();
  });
  it('uses actual handler metadata for drain recovery and never a caller-controlled URL', () => {
    const recoveryOnly=new LifecyclePaymentUploadIsolatedService(ports,undefined,{isReady:()=>false});
    const guard=new LifecyclePaymentUploadSessionGuard(sessionAccess,recoveryOnly),resolve=jest.spyOn(sessionAccess,'resolve');
    const context=(handler:Function,request:any=req())=>({getHandler:()=>handler,switchToHttp:()=>({getRequest:()=>request})}) as never;
    expect(guard.canActivate(context(LifecyclePaymentUploadIsolatedController.prototype.status))).toBe(true);
    expect(guard.canActivate(context(LifecyclePaymentUploadIsolatedController.prototype.cancel))).toBe(true);
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(()=>guard.canActivate(context(LifecyclePaymentUploadIsolatedController.prototype.upload,{...(req() as any),url:'/api/purchase-inventory/lifecycle/payment-attachments/status',body:{recovery:true}}))).toThrow('尚未接入');
    expect(resolve).toHaveBeenCalledTimes(2);
    const forged={headers:{...(req() as any).headers,origin:'https://other.example'}};
    expect(()=>guard.canActivate(context(LifecyclePaymentUploadIsolatedController.prototype.status,forged))).toThrow('本站');
    expect(uploads).not.toHaveBeenCalled();
  });
});
