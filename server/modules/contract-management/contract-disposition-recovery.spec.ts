import { ConflictException, ForbiddenException } from '@nestjs/common';
import { mkdtempSync, realpathSync, writeFileSync, readFileSync, lstatSync, readdirSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { ContractWorkflowStore } from './contract-workflow.store';
import { ContractWorkflowService } from './contract-workflow.service';
import { ContractExpiryDispositionService } from './contract-expiry-disposition.service';
import { buildPaymentCreateFields, FIXED_PAYMENT_FIELDS } from './contract-payment-follow-up.rules';
import type { PersonnelRecoveryActor, PersonnelRecoveryRequest, PersonnelRecoveryTask, PersonnelRecoveryResult } from '../../../shared/personnel-task-recovery.interface';

type Request = PersonnelRecoveryRequest & { selections?: string[] };
type RecoverySurface = {
  listRecoveryTasks(): Promise<PersonnelRecoveryTask[]>;
  previewRecoveryTask(input: Request): Promise<{ version: string; canConfirm: boolean; message?: string; choices: { options: { value: string }[] }[] }>;
  recoverTask(input: Request, actor: PersonnelRecoveryActor, authorize: () => void): Promise<PersonnelRecoveryResult>;
};

describe('contract disposition recovery uses actual records and the original native ledger', () => {
  let directory: string, parent: string, owner: string, priorApp: string | undefined;
  let store: ContractWorkflowStore, workflow: ContractWorkflowService, service: ContractExpiryDispositionService, recovery: RecoverySurface;
  const actor = { id: 'synthetic-contract-admin', name: '合成管理员', authorizationVersion: 1 };
  const principal = { role: 'admin' as const, accountId: actor.id, authorizationVersion: 1, purchaseBuilding: null, displayName: actor.name };
  const plan = { period: '一期', plannedAmount: 1200, plannedPaymentDate: '2027-08-20', ownerOpenId: 'ou_owner123' };
  const gateway = { getContract: jest.fn(), updateContract: jest.fn() };
  const creation = { listRecords: jest.fn(), createRecord: jest.fn(), deleteRecord: jest.fn() };
  const notificationGateway = { sendInteractiveCard: jest.fn(), sendText: jest.fn() };

  beforeEach(() => {
    jest.clearAllMocks(); priorApp = process.env.FEISHU_APP_ID; process.env.FEISHU_APP_ID = 'cli_synthetic_contract_recovery';
    parent = realpathSync(tmpdir()); directory = mkdtempSync(join(parent, 'nt-contract-recovery-')); owner = randomUUID();
    writeFileSync(join(directory, '.test-owner'), owner, { flag: 'wx' });
    store = new ContractWorkflowStore(join(directory, 'ledger.json'));
    workflow = new ContractWorkflowService(notificationGateway as never, store);
    Object.assign(workflow, { notificationStopped: true, readSourceWithRetry: async () => ({ sourceUrl: 'https://synthetic.example.test/contracts', organization: [] }) });
    service = new ContractExpiryDispositionService(gateway as never, creation as never, workflow, store, { currentPrincipal: () => principal } as never);
    recovery = service as unknown as RecoverySurface;
    gateway.getContract.mockResolvedValue({ record_id: 'rec-contract-1', fields: { 合同名称: '合成续期合同', 合同编号: 'SYNTHETIC-RECOVERY', 合同结束日期: Date.parse('2027-07-31T00:00:00+08:00'), 合同到期处置: '已续期至 2027-07-31', 跟进人: [{ id: 'ou_owner123', name: '合成跟进人' }] } });
    creation.listRecords.mockResolvedValue([{ record_id: 'rec-payment-new', fields: buildPaymentCreateFields(FIXED_PAYMENT_FIELDS, plan, 'rec-contract-1') }]);
  });
  afterEach(async () => {
    await service.onModuleDestroy(); await workflow.onModuleDestroy();
    const canonical = (value: string) => resolve(value).toLowerCase();
    if (canonical(dirname(directory)) !== canonical(parent) || !/^nt-contract-recovery-[A-Za-z0-9]+$/.test(basename(directory)) || lstatSync(directory).isSymbolicLink() || canonical(realpathSync(directory)) !== canonical(directory) || readFileSync(join(directory, '.test-owner'), 'utf8') !== owner) throw Error('Owned fixture mismatch');
    for (const name of readdirSync(directory)) if (!lstatSync(join(directory, name)).isFile() || lstatSync(join(directory, name)).isSymbolicLink()) throw Error('Unsafe fixture');
    rmSync(directory, { recursive: true, force: false });
    if (priorApp === undefined) delete process.env.FEISHU_APP_ID; else process.env.FEISHU_APP_ID = priorApp;
  });
  async function unknown(action: 'renew' | 'void' = 'renew') {
    const entry = await store.acceptDispositionTask({ recordId: 'rec-contract-1', request: { action, idempotencyKey: randomUUID(), ...(action === 'renew' ? { renewalEndDate: '2027-07-31', paymentPlans: [plan] } : {}) }, now: '2026-07-13T04:00:00.000Z', principal });
    const claimed = (await store.claimDispositionTask(entry.task.id))!;
    await store.settleDispositionTask(entry.task.id, claimed.claimToken!, { status: 'failed', uncertain: true, message: '合成响应丢失' });
    const task = (await recovery.listRecoveryTasks())[0];
    const input: Request = { module: 'contracts', taskId: task.id, expectedVersion: task.version, clientMutationId: randomUUID() };
    return { input, preview: await recovery.previewRecoveryTask(input) };
  }
  it('requires explicit payment selection, persists original notification intent, and replays after restart without business rewrites', async () => {
    const { input, preview } = await unknown(); expect(preview.canConfirm).toBe(true);
    expect(preview.choices[0].options.map(row => row.value)).toEqual(['rec-payment-new']);
    input.expectedVersion = preview.version;
    await expect(recovery.recoverTask(input, actor, () => {})).rejects.toThrow('付款计划');
    input.selections = ['rec-payment-new'];
    await expect(recovery.recoverTask(input, actor, () => {})).resolves.toMatchObject({ status: 'completed' });
    const reopened = new ContractWorkflowStore(join(directory, 'ledger.json'));
    const entry = await reopened.getDispositionTask(input.taskId);
    expect(entry?.task.status).toBe('completed'); expect(entry?.uncertain).toBe(false);
    expect(await reopened.listRoleNotifications()).toHaveLength(1);
    const native = readFileSync(join(directory, 'ledger.json'), 'utf8');
    await expect(recovery.recoverTask(input, actor, () => {})).resolves.toMatchObject({ status: 'completed' });
    expect(readFileSync(join(directory, 'ledger.json'), 'utf8')).toBe(native);
    expect(gateway.updateContract).not.toHaveBeenCalled(); expect(creation.createRecord).not.toHaveBeenCalled(); expect(creation.deleteRecord).not.toHaveBeenCalled();
    expect(notificationGateway.sendInteractiveCard).not.toHaveBeenCalled();
  });
  it('rejects stale external evidence, forged selected records and changed administrator authority without changing the native task', async () => {
    const { input, preview } = await unknown(); input.expectedVersion = preview.version; input.selections = ['rec-payment-new'];
    const bytes = readFileSync(join(directory, 'ledger.json'), 'utf8');
    gateway.getContract.mockResolvedValueOnce({ record_id: 'rec-contract-1', fields: { 合同结束日期: '2028-07-31', 合同到期处置: '已续期至 2028-07-31' } });
    await expect(recovery.recoverTask(input, actor, () => {})).rejects.toBeInstanceOf(ConflictException);
    await expect(recovery.recoverTask({ ...input, selections: ['rec-unrelated'] }, actor, () => {})).rejects.toThrow('付款计划');
    await expect(recovery.recoverTask(input, actor, () => { throw new ForbiddenException(); })).rejects.toBeInstanceOf(ForbiddenException);
    expect(readFileSync(join(directory, 'ledger.json'), 'utf8')).toBe(bytes);
  });
  it('does not mistake a matching historical payment for a confirmed new plan and leaves incomplete results unresolved', async () => {
    const { input } = await unknown();
    creation.listRecords.mockResolvedValue([{ record_id: 'rec-payment-old', fields: buildPaymentCreateFields(FIXED_PAYMENT_FIELDS, plan, 'rec-contract-1') }, { record_id: 'rec-payment-new', fields: buildPaymentCreateFields(FIXED_PAYMENT_FIELDS, plan, 'rec-contract-1') }]);
    const preview = await recovery.previewRecoveryTask(input);
    expect(preview.choices[0].options).toHaveLength(2);
    await expect(recovery.recoverTask({ ...input, expectedVersion: preview.version }, actor, () => {})).rejects.toThrow('付款计划');
    creation.listRecords.mockResolvedValue([]);
    const missing = await recovery.previewRecoveryTask(input); expect(missing.canConfirm).toBe(false);
    expect((await store.getDispositionTask(input.taskId))?.uncertain).toBe(true);
  });
});
