import { PurchaseLifecycleReceiptImageCoordinator } from '../../server/modules/purchase-inventory/purchase-lifecycle-receipt-image-coordinator';

describe('isolated lifecycle receipt image coordinator', () => {
  const make = () => {
    const calls: string[] = [];
    const auth = jest.fn();
    const verifier: any = { verify: jest.fn(async () => { calls.push('verify'); return {}; }) };
    const task: any = { taskId: 't1', leaseToken: 'lease', state: 'ready', imageMessageId: 'msg', imageKey: 'img' };
    const store: any = {
      acceptVerified: jest.fn(async (_s: unknown, cb: any) => { calls.push('accept'); cb({}); return {accepted:true,enqueued:true,taskId:'t1'}; }),
      claimUpload: jest.fn(async (_id: string, cb: any) => { calls.push('claim'); cb({}); return {...task}; }),
      releaseBeforeDispatch: jest.fn(async () => { calls.push('release'); }),
      markUploadDispatched: jest.fn(async (_id: string, _lease: string, cb: any) => { calls.push('fence'); cb({}); }),
      recordUploaded: jest.fn(async () => { calls.push('record'); }),
      markUploadUncertain: jest.fn(async () => { calls.push('uncertain'); }),
      commitUploaded: jest.fn(async (_id: string, _lease: string, cb: any) => { calls.push('commit'); cb({}); }),
    };
    const gateway: any = {downloadMessageImage: jest.fn(async () => { calls.push('download'); return Buffer.from('img'); }), uploadAttachment: jest.fn(async () => { calls.push('upload'); return 'file-token'; })};
    let appId = 'cli_test';
    const coordinator = new PurchaseLifecycleReceiptImageCoordinator(verifier, store, gateway, () => appId, auth);
    return { calls, auth, verifier, store, gateway, task, coordinator, setApp: (v:string) => {appId=v;} };
  };
  it('authenticates before the store and refuses an app identity change', async () => {
    const a = make();
    await expect(a.coordinator.accept({})).resolves.toMatchObject({accepted:true});
    expect(a.calls).toEqual(['verify','accept']);
    a.verifier.verify.mockImplementationOnce(async () => {a.setApp('cli_other'); return {};});
    await expect(a.coordinator.accept({})).rejects.toThrow('身份已变化');
    expect(a.store.acceptVerified).toHaveBeenCalledTimes(1);
  });
  it('fails closed when a dependency is unavailable', async () => {
    const a = make();
    const c = new PurchaseLifecycleReceiptImageCoordinator(undefined,a.store,a.gateway,()=> 'cli_test', a.auth);
    await expect(c.accept({})).rejects.toThrow('尚未就绪');
    expect(a.store.acceptVerified).not.toHaveBeenCalled();
  });
  it('persists the fence and receipt before committing', async () => {
    const a = make();
    await expect(a.coordinator.process('t1')).resolves.toBe('completed');
    expect(a.calls).toEqual(['claim','download','fence','upload','record','commit']);
    expect(a.auth).toHaveBeenCalledTimes(3);
  });
  it('releases a failed download without uploading and never uploads after fence failure', async () => {
    const a = make(); a.gateway.downloadMessageImage.mockRejectedValueOnce(new Error('download'));
    await expect(a.coordinator.process('t1')).rejects.toThrow('download');
    expect(a.calls).toEqual(['claim','release']);
    a.store.markUploadDispatched.mockRejectedValueOnce(new Error('fence'));
    await expect(a.coordinator.process('t1')).rejects.toThrow('fence');
    expect(a.gateway.uploadAttachment).not.toHaveBeenCalled();
  });
  it('never retries an uncertain upload', async () => {
    const a = make(); a.gateway.uploadAttachment.mockRejectedValueOnce(new Error('timeout'));
    await expect(a.coordinator.process('t1')).rejects.toThrow('timeout');
    expect(a.calls.slice(-2)).toEqual(['fence','uncertain']);
    a.task.state = 'dispatching';
    await expect(a.coordinator.process('t1')).resolves.toBe('manual_reconciliation');
    expect(a.gateway.uploadAttachment).toHaveBeenCalledTimes(1);
  });
  it('treats a failed upload receipt write as uncertain', async () => {
    const a = make(); a.store.recordUploaded.mockRejectedValueOnce(new Error('ledger'));
    await expect(a.coordinator.process('t1')).rejects.toThrow('ledger');
    expect(a.store.markUploadUncertain).toHaveBeenCalledTimes(1);
    expect(a.store.commitUploaded).not.toHaveBeenCalled();
  });
  it('retries commit only after a saved upload receipt', async () => {
    const a = make(); a.store.commitUploaded.mockRejectedValueOnce(new Error('commit'));
    await expect(a.coordinator.process('t1')).rejects.toThrow('commit');
    a.task.state = 'uploaded';
    await expect(a.coordinator.process('t1')).resolves.toBe('completed');
    expect(a.gateway.uploadAttachment).toHaveBeenCalledTimes(1);
    expect(a.store.commitUploaded).toHaveBeenCalledTimes(2);
  });
  it('rejects an invalid task and revoked access before external I/O', async () => {
    const a = make();
    await expect(a.coordinator.process('../x')).rejects.toThrow('任务无效');
    a.auth.mockImplementationOnce(() => {throw new Error('revoked');});
    await expect(a.coordinator.process('t1')).rejects.toThrow('revoked');
    expect(a.gateway.downloadMessageImage).not.toHaveBeenCalled();
  });
});
