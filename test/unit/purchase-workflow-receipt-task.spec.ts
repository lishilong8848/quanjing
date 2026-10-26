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
});
