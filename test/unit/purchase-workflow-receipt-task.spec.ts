import { randomUUID } from 'node:crypto';
import { lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { PurchaseWorkflowReceiptTaskService } from '../../server/modules/purchase-inventory/purchase-workflow-receipt-task.service';
import { PurchaseWorkflowStore } from '../../server/modules/purchase-inventory/purchase-workflow.store';
import type { PurchaseWorkflowSession } from '../../server/modules/purchase-inventory/purchase-workflow.service';

describe('PurchaseWorkflowReceiptTaskService', () => {
  let folder: string, parent: string, marker: string, store: PurchaseWorkflowStore, previousApp: string | undefined;
  beforeEach(async () => {
    previousApp = process.env.FEISHU_APP_ID; process.env.FEISHU_APP_ID = 'cli_synthetic_receipt_unit';
    parent = realpathSync(tmpdir()); folder = mkdtempSync(join(parent, 'nt-receipt-unit-')); marker = randomUUID(); writeFileSync(join(folder, '.owner'), marker, { flag: 'wx' });
    store = new PurchaseWorkflowStore(join(folder, 'purchase.json')); await store.onModuleInit();
    jest.spyOn(global, 'setImmediate').mockImplementation((() => ({ unref() {} })) as never);
  });
  afterEach(async () => {
    await store.onModuleDestroy(); jest.restoreAllMocks();
    if (previousApp === undefined) delete process.env.FEISHU_APP_ID; else process.env.FEISHU_APP_ID = previousApp;
    if (dirname(resolve(folder)).toLowerCase() !== resolve(parent).toLowerCase() || !/^nt-receipt-unit-[A-Za-z0-9]+$/.test(basename(folder)) || readFileSync(join(folder, '.owner'), 'utf8') !== marker) throw Error('Owned fixture mismatch');
    function check(path: string) { const stats = lstatSync(path); if (stats.isSymbolicLink() || resolve(realpathSync(path)).toLowerCase() !== resolve(path).toLowerCase() || path !== folder && !path.toLowerCase().startsWith(folder.toLowerCase() + sep)) throw Error('Unsafe fixture'); if (stats.isDirectory()) for (const name of readdirSync(path)) check(join(path, name)); else if (!stats.isFile()) throw Error('Unsafe fixture file'); }
    check(folder); rmSync(folder, { recursive: true, force: false });
  });
  function fixture() {
    const session: PurchaseWorkflowSession = { accessToken: 'synthetic-runtime-token', openId: 'ou_synthetic_operator', userName: '合成签收员', accessRole: 'admin', authenticationMode: 'delegated-app', permissionPrincipal: { accountId: 'local-synthetic-admin', authorizationVersion: 1, role: 'admin', displayName: '合成签收员' } };
    const core = { prepareReceiptSubmission: jest.fn(async () => ({ appId: process.env.FEISHU_APP_ID, actor: { openId: session.openId, name: session.userName, positions: [], buildings: ['B楼'], accessRole: 'admin' }, scope: { building: 'B楼' } })), assertReceiptSubmissionCurrent: jest.fn(), assertReceiptTaskReadable: jest.fn(), receiveAcceptedReceipt: jest.fn(async () => ({ notificationWarnings: [] })) };
    const gateway = { getTenantAccessTokenAsApp: jest.fn(async () => 'synthetic-app-token'), uploadAttachment: jest.fn(async () => 'synthetic-file-token') };
    const input = { clientMutationId: randomUUID(), signer: session.userName, signerOpenId: session.openId, receiptTime: Date.now(), note: '' };
    const buffer = Buffer.from('img'), files = { receiptPhotos: [{ originalname: 'photo.jpg', mimetype: 'image/jpeg', size: 3, buffer }], invoices: [] };
    const service = new PurchaseWorkflowReceiptTaskService(gateway as never, core as never, store);
    return { session, core, gateway, input, files, service };
  }

  it('accepts receipt durably and uploads files only in the background', async () => {
    const f = fixture(), accepted = await f.service.acceptReceipt('recReceipt001', f.session, f.input, f.files);
    expect(accepted).toMatchObject({ pending: true }); expect(accepted.taskId).toMatch(/^purchase-receipt-/);
    expect(f.gateway.uploadAttachment).not.toHaveBeenCalled(); expect(f.core.receiveAcceptedReceipt).not.toHaveBeenCalled();
    await f.service.runPendingTasks();
    expect(f.gateway.uploadAttachment).toHaveBeenCalledTimes(1); expect(f.core.receiveAcceptedReceipt).toHaveBeenCalledTimes(1);
    const task = await store.findWebReceipt(accepted.taskId);
    expect(task?.webReceipt?.files[0].token).toBe('synthetic-file-token');
    expect(await f.service.getReceiptTaskStatus(accepted.taskId, f.session)).toMatchObject({ task: { status: 'completed' } });
  });
  it('deduplicates active receipt tasks for the same record', async () => {
    const f = fixture(); const results = await Promise.all([f.service.acceptReceipt('recReceipt002', f.session, f.input, f.files), f.service.acceptReceipt('recReceipt002', f.session, f.input, f.files)]);
    expect(results[0].taskId).toBe(results[1].taskId); expect(await store.listNotifications({ kind: 'web_receipt_command' })).toHaveLength(1);
  });
  it('does not disclose an applicant receipt task to another building account', async () => {
    const f = fixture();
    const session = { ...f.session, accessRole: 'purchase_applicant' as const, permissionPrincipal: { ...f.session.permissionPrincipal!, role: 'purchase_applicant' as const, accountId: 'local-synthetic-applicant-B' }, purchaseBuilding: 'B楼' };
    const accepted = await f.service.acceptReceipt('recReceipt003', session, f.input, f.files);
    expect(await f.service.getReceiptTaskStatus(accepted.taskId, session)).toMatchObject({ success: true });
    expect(await f.service.getReceiptTaskStatus(accepted.taskId, { ...session, purchaseBuilding: 'A楼', permissionPrincipal: { ...session.permissionPrincipal, accountId: 'local-synthetic-applicant-A' } })).toMatchObject({ success: false });
  });
  it('does not reuse an active receipt task across different building accounts', async () => {
    const f = fixture(); await f.service.acceptReceipt('recReceipt004', f.session, f.input, f.files);
    await expect(f.service.acceptReceipt('recReceipt004', { ...f.session, permissionPrincipal: { ...f.session.permissionPrincipal!, accountId: 'local-synthetic-other' } }, f.input, f.files)).rejects.toThrow('已有正式签收任务');
    expect(await store.listNotifications({ kind: 'web_receipt_command' })).toHaveLength(1);
  });
  it('rejects a receipt without a selected signer open id', async () => {
    const f = fixture(); await expect(f.service.acceptReceipt('recReceipt005', f.session, { ...f.input, signerOpenId: '' }, f.files)).rejects.toThrow('请选择签收人');
    expect(f.core.prepareReceiptSubmission).not.toHaveBeenCalled(); expect(f.gateway.uploadAttachment).not.toHaveBeenCalled();
  });

  async function waitUntil(check: () => boolean | Promise<boolean>): Promise<void> {
    const until = Date.now() + 3000;
    while (!await check()) {
      if (Date.now() > until) throw new Error('Receipt fixture did not reach the expected state');
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  }

  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
  }

  it('runs at most two receipts, allowing B and C to complete while A is uploading', async () => {
    const f = fixture(), slow = deferred<string>();
    let active = 0, maximum = 0;
    f.gateway.uploadAttachment.mockImplementation(async (file: any) => {
      active++; maximum = Math.max(maximum, active);
      try { return file.originalname === 'a.jpg' ? await slow.promise : `token-${file.originalname}`; }
      finally { active--; }
    });
    const tasks = [];
    for (const id of ['a', 'b', 'c']) {
      tasks.push(await f.service.acceptReceipt(`recConcurrent${id}`, f.session, { ...f.input, clientMutationId: randomUUID() },
        { ...f.files, receiptPhotos: [{ ...f.files.receiptPhotos[0], originalname: `${id}.jpg` }] }));
    }
    const run = f.service.runPendingTasks();
    expect(f.service.runPendingTasks()).toBe(run);
    try {
      await waitUntil(async () => (await store.findWebReceipt(tasks[2].taskId))?.status === 'completed');
      expect((await store.findWebReceipt(tasks[0].taskId))?.status).toBe('processing');
      expect((await store.findWebReceipt(tasks[1].taskId))?.status).toBe('completed');
      expect(maximum).toBe(2);
    } finally { slow.resolve('token-a'); await run; }
    expect(f.gateway.uploadAttachment).toHaveBeenCalledTimes(3);
    expect(f.core.receiveAcceptedReceipt).toHaveBeenCalledTimes(3);
  });

  it('never admits a second command for a record or reclaims an excluded in-flight record', async () => {
    const f = fixture();
    const one = await f.service.acceptReceipt('recUnique', f.session, f.input, f.files);
    expect(await store.takeNextNotification(Date.now(), 1000, ['web_receipt_command'], undefined, () => false)).toBeNull();
    expect((await store.findWebReceipt(one.taskId))?.attempts).toBe(0);
    await expect(f.service.acceptReceipt('recUnique', f.session, { ...f.input, clientMutationId: randomUUID() }, f.files)).rejects.toThrow('已有正式签收任务');
    const claimed = await store.takeNextNotification(Date.now(), 1000, ['web_receipt_command']);
    expect(claimed?.webReceipt?.taskId).toBe(one.taskId);
    expect(await store.takeNextNotification(Date.now() + 5000, 1000, ['web_receipt_command'], new Set(['recUnique']))).toBeNull();
    expect((await store.findWebReceipt(one.taskId))?.claimToken).toBe(claimed?.claimToken);
  });

  it('keeps the ledger available during shutdown, saves in-flight upload receipts and leaves later work for restart', async () => {
    const f = fixture(), uploads = [deferred<string>(), deferred<string>()];
    let started = 0;
    f.gateway.uploadAttachment.mockImplementation(() => uploads[started++].promise);
    const tasks = [];
    for (let i = 0; i < 3; i++) tasks.push(await f.service.acceptReceipt(`recShutdown${i}`, f.session, { ...f.input, clientMutationId: randomUUID() }, f.files));
    const run = f.service.runPendingTasks();
    await waitUntil(() => started === 2);
    let stopped = false;
    const stop = store.onModuleDestroy().then(() => { stopped = true; });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(stopped).toBe(false);
    await f.service.runPendingTasks();
    expect(started).toBe(2);
    uploads[0].resolve('token-stop-a'); uploads[1].resolve('token-stop-b');
    await Promise.all([run, stop]);
    expect(f.core.receiveAcceptedReceipt).not.toHaveBeenCalled();
    store = new PurchaseWorkflowStore(join(folder, 'purchase.json')); await store.onModuleInit();
    const saved = await Promise.all(tasks.map(task => store.findWebReceipt(task.taskId)));
    expect(saved.map(task => task?.status)).toEqual(['pending', 'pending', 'pending']);
    expect(saved.slice(0, 2).every(task => Boolean(task?.webReceipt?.files[0].token))).toBe(true);
    expect(saved[2]?.attempts).toBe(0);
    f.gateway.uploadAttachment.mockResolvedValue('token-stop-c');
    const restarted = new PurchaseWorkflowReceiptTaskService(f.gateway as never, f.core as never, store);
    await restarted.runPendingTasks();
    expect(f.gateway.uploadAttachment).toHaveBeenCalledTimes(3);
    expect(f.core.receiveAcceptedReceipt).toHaveBeenCalledTimes(3);
  });

  it('drains a recovery being read during shutdown without writing or accepting another request', async () => {
    const f = fixture();
    const accepted = await f.service.acceptReceipt('recRecoveryStop', f.session, f.input, f.files);
    const original = await store.findWebReceipt(accepted.taskId), reading = deferred<typeof original>();
    jest.spyOn(store, 'findWebReceipt').mockReturnValueOnce(reading.promise);
    const write = jest.spyOn(store, 'recoverWebReceipt');
    const input = { module: 'purchase' as const, taskId: accepted.taskId, expectedVersion: 'a'.repeat(64), clientMutationId: randomUUID() };
    const actor = { id: 'synthetic-admin', name: '合成管理员', authorizationVersion: 1 };
    const recovery = f.service.recoverTask(input, actor, () => {});
    const rejected = expect(recovery).rejects.toThrow('系统正在更新');
    let stopped = false;
    const stop = store.onModuleDestroy().then(() => { stopped = true; });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(stopped).toBe(false);
    await expect(f.service.recoverTask(input, actor, () => {})).rejects.toThrow('系统正在更新');
    await expect(f.service.acceptReceipt('recAfterStop', f.session, f.input, f.files)).rejects.toThrow('系统正在更新');
    reading.resolve(original);
    await rejected; await stop;
    expect(write).not.toHaveBeenCalled();
  });

  it('retries an unstarted failed upload later without blocking another receipt or reuploading its files', async () => {
    const f = fixture();
    const first = await f.service.acceptReceipt('recRetryA', f.session, f.input, f.files);
    const second = await f.service.acceptReceipt('recRetryB', f.session, { ...f.input, clientMutationId: randomUUID() }, f.files);
    f.gateway.getTenantAccessTokenAsApp.mockRejectedValueOnce(new Error('temporary token failure'));
    await f.service.runPendingTasks();
    expect((await store.findWebReceipt(first.taskId))?.status).toBe('pending');
    expect((await store.findWebReceipt(second.taskId))?.status).toBe('completed');
    await f.service.runPendingTasks(Date.now() + 5000);
    expect((await store.findWebReceipt(first.taskId))?.status).toBe('completed');
    expect(f.gateway.uploadAttachment).toHaveBeenCalledTimes(2);
    expect(f.core.receiveAcceptedReceipt).toHaveBeenCalledTimes(2);
  });
});
