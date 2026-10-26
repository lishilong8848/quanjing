import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, writeFileSync, readFileSync, lstatSync, readdirSync, rmSync } from 'node:fs';
import { dirname, basename, resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import type { HandoverAdapter, HandoverContext } from '../../shared/personnel-handover.interface';
import * as configuration from '../../server/common/access/access-configuration.store';
import { handoverItemMutationId } from '../../server/common/access/personnel-handover.store';
import { feishuIdentityFingerprint } from '../../server/common/access/feishu-access-approved-grants';
import { ContractWorkflowStore } from '../../server/modules/contract-management/contract-workflow.store';
import { ContractWorkflowService } from '../../server/modules/contract-management/contract-workflow.service';
import { ContractPersonnelHandoverAdapter } from '../../server/modules/contract-management/contract-personnel-handover.adapter';

const appId = 'cli_synthetic_contract_handover';
const person = (letter: string) => ({ id: `local-external-${letter.repeat(64)}`, recordId: `recPerson${letter}`, openId: `ou_${letter}`, name: `合成人员${letter}`, active: true, type: 'employee' as const, position: '', systemPosition: '', buildings: [], specialties: [], permissionTags: [], dutyRecordIds: ['recAction', 'recNotify'] });
const context = (): HandoverContext => ({ from: person('a'), to: person('b'), directoryVersion: 'c'.repeat(64), duties: [
  { recordId: 'recAction', name: '合成合同办理', kind: 'contract_action', personnelIds: [person('a').id], buildings: null, specialties: null, enabled: true, startsAt: 0, endsAt: null, parentDutyIds: [], version: 1 },
  { recordId: 'recNotify', name: '合成合同通知', kind: 'contract_notify', personnelIds: [person('a').id], buildings: null, specialties: null, enabled: true, startsAt: 0, endsAt: null, parentDutyIds: [], version: 1 },
] });

describe('合同复用岗位事务与原通知交接', () => {
  let parent: string, folder: string, owner: string, savedApp: string | undefined, config: configuration.AccessConfigurationStore, store: ContractWorkflowStore, adapter: ContractPersonnelHandoverAdapter, workflow: ContractWorkflowService, gateway: any;
  beforeEach(() => {
    savedApp = process.env.FEISHU_APP_ID; process.env.FEISHU_APP_ID = appId;
    parent = realpathSync(tmpdir()); folder = mkdtempSync(join(parent, 'nt-contract-handover-')); owner = randomUUID(); writeFileSync(join(folder, '.test-owner'), owner, { flag: 'wx' });
    config = new configuration.AccessConfigurationStore(join(folder, 'configuration.json')); jest.spyOn(configuration, 'getAccessConfigurationStore').mockReturnValue(config);
    store = new ContractWorkflowStore(join(folder, 'contract-ledger.json'));
    gateway = { sendText: jest.fn(async () => 'om_synthetic'), sendInteractiveCard: jest.fn(async () => 'om_synthetic_card') };
    workflow = new ContractWorkflowService(gateway, store); adapter = new ContractPersonnelHandoverAdapter(store, workflow);
  });
  afterEach(async () => {
    await workflow.onModuleDestroy(); jest.restoreAllMocks(); if (savedApp === undefined) delete process.env.FEISHU_APP_ID; else process.env.FEISHU_APP_ID = savedApp;
    const canonical = (value: string) => resolve(value).toLowerCase();
    if (canonical(dirname(folder)) !== canonical(parent) || !/^nt-contract-handover-[A-Za-z0-9]+$/.test(basename(folder)) || lstatSync(folder).isSymbolicLink() || canonical(realpathSync(folder)) !== canonical(folder) || readFileSync(join(folder, '.test-owner'), 'utf8') !== owner) throw Error('Owned fixture mismatch');
    for (const name of readdirSync(folder)) if (!lstatSync(join(folder, name)).isFile() || lstatSync(join(folder, name)).isSymbolicLink()) throw Error('Unsafe fixture');
    rmSync(folder, { recursive: true, force: false });
  });
  async function apply(batchId: string) {
    await config.mutate(config.read().revision, randomUUID(), 'synthetic-duty-transfer', state => {
      state.personnelDutyAssignments = Object.fromEntries(context().duties.map(duty => [duty.recordId, { appId, dutyRecordId: duty.recordId, kind: duty.kind, buildings: duty.buildings, specialties: duty.specialties, startsAt: 0, endsAt: null, version: 1, confirmedBatchId: batchId, members: [{ personId: person('b').id, recordId: person('b').recordId, openId: 'ou_b', name: person('b').name }] }]));
    });
  }
  it('一次岗位回执接管合同办理和原待发通知，不新建模块交接日志；重启与重复保持', async () => {
    await store.enqueueRoleNotification({ key: 'synthetic-event', kind: 'text', content: '合成合同事件', fallbackRecipients: ['ou_a'] });
    const items = await adapter.listPending(context()); expect(items).toHaveLength(2);
    expect(await adapter.preflight(context(), items[0])).toEqual({ ready: true });
    const batchId = randomUUID(), mutation = (key: string) => handoverItemMutationId(batchId, key);
    await expect(adapter.acceptTransfer(context(), items[0], mutation(items[0].key))).rejects.toThrow('岗位');
    await apply(batchId);
    for (const item of items) {
      const receipt = await adapter.acceptTransfer(context(), item, mutation(item.key));
      expect(await adapter.reconcile(context(), receipt)).toEqual({ status: 'success' });
      const restarted = new ContractPersonnelHandoverAdapter(new ContractWorkflowStore(join(folder, 'contract-ledger.json')), workflow);
      expect(await restarted.acceptTransfer(context(), item, mutation(item.key))).toEqual(receipt);
      expect(await restarted.reconcile(context(), receipt)).toEqual({ status: 'success' });
      expect(await adapter.reconcile(context(), { ...receipt, mutationId: randomUUID() })).toMatchObject({ status: 'error' });
    }
    expect(gateway.sendText.mock.calls.map((row: any[]) => row[0])).toEqual(['ou_b']);
    expect(readdirSync(folder).sort()).toEqual(['.test-owner', 'configuration.json', 'contract-ledger.json']);
  });
  it('原合法到期处置继续执行，未知结果阻止静默交接', async () => {
    const sourceAccountId = `feishu-${feishuIdentityFingerprint(appId, 'ou_a')}`;
    const accepted = await store.acceptDispositionTask({ recordId: 'recSyntheticContract', request: { action: 'void', idempotencyKey: randomUUID() }, now: new Date().toISOString(), principal: { role: 'purchase_admin', purchaseBuilding: null, accountId: sourceAccountId, authorizationVersion: 1 } }, () => true);
    expect((await adapter.listPending(context())).some(item => item.recordId === accepted.task.id && item.status === 'in_progress')).toBe(true);
    await store.claimDispositionTask(accepted.task.id); await store.recoverDispositionTasks();
    expect((await adapter.listPending(context())).some(item => item.recordId === accepted.task.id && item.phase === 'reconcile')).toBe(true);
    expect(gateway.sendText).not.toHaveBeenCalled();
  });
  it('付款通知按原候选回执交接，历史与已合法旧投递保留', async () => {
    await store.enqueuePaymentDigest({ key: 'synthetic-digest', sourceUrl: 'https://synthetic.invalid/contracts', candidates: [{ dedupeKey: 'payment_due_reminder:recPayment:2026-10-20', fallbackRecipients: ['ou_a'], record: { recordId: 'recPayment', kind: 'payment', name: '合成付款', code: 'SYNTHETIC', ownerNames: ['合成前任'], ownerOpenIds: ['ou_a'], specialty: '电气', specialtyManagerOpenIds: [], amount: 100, startDate: null, endDate: '2026-10-20', attachmentCount: 0, paymentPlanCount: 0, createdAt: '' } }] });
    const item = (await adapter.listPending(context())).find(row => row.stageKey === 'payment_digest')!;
    const batchId = randomUUID(); await apply(batchId);
    const receipt = await adapter.acceptTransfer(context(), item, handoverItemMutationId(batchId, item.key));
    expect(await adapter.reconcile(context(), receipt)).toEqual({ status: 'success' });
    expect(gateway.sendInteractiveCard.mock.calls.map((row: any[]) => row[0])).toEqual(['ou_b']);
    expect((await store.processedKeys()).has('payment_due_reminder:recPayment:2026-10-20')).toBe(true);
  });
  it.each(['role','payment'] as const)('%s原通知耗尽后明确报错，管理员恢复仍用原SDK标识与内容', async kind => {
    if (kind === 'role') await store.enqueueRoleNotification({ key: 'synthetic-retry-notification', kind: 'text', content: '合成原合同通知', fallbackRecipients: ['ou_a'] });
    else await store.enqueuePaymentDigest({ key: 'synthetic-retry-digest', sourceUrl: 'https://synthetic.invalid/contracts', candidates: [{ dedupeKey: 'payment_due_reminder:recRetry:2026-10-20', fallbackRecipients: ['ou_a'], record: { recordId: 'recRetry', kind: 'payment', name: '合成待恢复付款', code: 'SYNTHETIC', ownerNames: ['合成前任'], ownerOpenIds: ['ou_a'], specialty: '电气', specialtyManagerOpenIds: [], amount: 100, startDate: null, endDate: '2026-10-20', attachmentCount: 0, paymentPlanCount: 0, createdAt: '' } }] });
    const item = (await adapter.listPending(context())).find(row => row.stageKey === (kind === 'role' ? 'role_notification' : 'payment_digest'))!;
    const batchId = randomUUID(); await apply(batchId);
    const receipt = await adapter.acceptTransfer(context(), item, handoverItemMutationId(batchId, item.key));
    const send = kind === 'role' ? gateway.sendText : gateway.sendInteractiveCard;
    send.mockRejectedValue(new Error('synthetic temporary transport failure'));
    const port: HandoverAdapter = adapter;
    await port.reconcile(context(), receipt); await port.reconcile(context(), receipt);
    expect(await port.reconcile(context(), receipt)).toMatchObject({ status: 'error' });
    expect(send).toHaveBeenCalledTimes(3);
    const before = readFileSync(join(folder, 'contract-ledger.json'), 'utf8');
    await expect(port.reconcile(context(), { ...receipt, version: 'forged' }, { retryFailed: true })).resolves.toMatchObject({ status: 'error' });
    expect(readFileSync(join(folder, 'contract-ledger.json'), 'utf8')).toBe(before);
    if (kind === 'role') {
      const job = (await store.getRoleNotification(item.recordId))!, delivery = job.deliveries.ou_b;
      expect(await store.claimRoleNotification(() => ['ou_b'], new Date(Date.parse(delivery.firstAttemptAt) + 55 * 60_000), job.key, () => {})).toBeUndefined();
    } else {
      const job = (await store.listPaymentDigests())[0], delivery = Object.values(job.messages)[0];
      expect(await store.claimPaymentDigest(() => ['ou_b'], () => { throw Error('Expired recovery must not create a new card'); }, new Date(Date.parse(delivery.firstAttemptAt) + 55 * 60_000), () => {}, job.key)).toBeUndefined();
    }
    expect(readFileSync(join(folder, 'contract-ledger.json'), 'utf8')).toBe(before);
    send.mockResolvedValue('om_synthetic_recovered');
    expect(await port.reconcile(context(), receipt, { retryFailed: true })).toEqual({ status: 'success' });
    expect(send).toHaveBeenCalledTimes(4); expect(new Set(send.mock.calls.map((row: unknown[]) => row[2])).size).toBe(1);
    expect(send.mock.calls[3][1]).toEqual(send.mock.calls[0][1]);
  });
  it('恢复一项付款通知不能越界重放另一项耗尽通知', async () => {
    for (const suffix of ['A','B']) await store.enqueuePaymentDigest({ key: `synthetic-scoped-${suffix}`, sourceUrl: 'https://synthetic.invalid/contracts', candidates: [{ dedupeKey: `payment_due_reminder:recScope${suffix}:2026-10-20`, fallbackRecipients: ['ou_a'], record: { recordId: `recScope${suffix}`, kind: 'payment', name: `合成付款${suffix}`, code: 'SYNTHETIC', ownerNames: ['合成前任'], ownerOpenIds: ['ou_a'], specialty: '电气', specialtyManagerOpenIds: [], amount: 100, startDate: null, endDate: '2026-10-20', attachmentCount: 0, paymentPlanCount: 0, createdAt: '' } }] });
    const item = (await adapter.listPending(context())).find(row => row.recordId === 'synthetic-scoped-A')!;
    const batchId = randomUUID(); await apply(batchId);
    const receipt = await adapter.acceptTransfer(context(), item, handoverItemMutationId(batchId, item.key));
    gateway.sendInteractiveCard.mockRejectedValue(new Error('synthetic transport failure'));
    for (let count = 0; count < 3; count++) await adapter.reconcile(context(), receipt);
    for (let count = 0; count < 3; count++) await workflow.flushPaymentDigests();
    const before = (await store.listPaymentDigests()).find(job => job.key === 'synthetic-scoped-B');
    expect(Object.values(before!.messages)[0].attempts).toBe(3);
    gateway.sendInteractiveCard.mockResolvedValue('om_synthetic_scoped');
    await expect((adapter as HandoverAdapter).reconcile(context(), receipt, { retryFailed: true })).resolves.toEqual({ status: 'success' });
    expect((await store.listPaymentDigests()).find(job => job.key === 'synthetic-scoped-B')).toEqual(before);
  });
  it('恢复排队期间岗位回执变化，在原通知领取锁内拒绝且不发送', async () => {
    await store.enqueueRoleNotification({ key: 'synthetic-claim-race', kind: 'text', content: '合成原通知', fallbackRecipients: ['ou_a'] });
    const item = (await adapter.listPending(context())).find(row => row.stageKey === 'role_notification')!;
    const batchId = randomUUID(); await apply(batchId);
    const receipt = await adapter.acceptTransfer(context(), item, handoverItemMutationId(batchId, item.key));
    const claim = store.claimRoleNotification.bind(store);
    jest.spyOn(store, 'claimRoleNotification').mockImplementationOnce(async (...args) => {
      await config.mutate(config.read().revision, randomUUID(), 'synthetic-race', state => {
        const additional = person('c'); state.personnelDutyAssignments!.recNotify.members.push({ personId: additional.id, recordId: additional.recordId, openId: additional.openId!, name: additional.name });
      });
      return claim(...args);
    });
    const before = readFileSync(join(folder, 'contract-ledger.json'), 'utf8');
    await expect((adapter as HandoverAdapter).reconcile(context(), receipt, { retryFailed: true })).resolves.toMatchObject({ status: 'error' });
    expect(gateway.sendText).not.toHaveBeenCalled(); expect(readFileSync(join(folder, 'contract-ledger.json'), 'utf8')).toBe(before);
  });
  it('已完成历史不阻断新范围，但跨应用未办通知必须在变更岗位前拒绝', async () => {
    await store.enqueueRoleNotification({ key: 'synthetic-old-history', kind: 'text', content: '合成历史', fallbackRecipients: ['ou_a'] });
    await workflow.flushRoleNotifications();
    const scoped = context(); scoped.duties[1].buildings = ['C楼'];
    expect(await adapter.listPending(scoped)).toHaveLength(1);
    await store.enqueueRoleNotification({ key: 'synthetic-old-pending', kind: 'text', content: '合成待发', fallbackRecipients: ['ou_a'] });
    process.env.FEISHU_APP_ID = 'cli_synthetic_other';
    await expect(adapter.listPending(context())).rejects.toThrow('应用');
  });
});
