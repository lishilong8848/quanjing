import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, writeFileSync, readFileSync, lstatSync, readdirSync, rmSync } from 'node:fs';
import { dirname, basename, resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AccessPrincipal } from '../../shared/access-control.interface';
import * as configuration from '../../server/common/access/access-configuration.store';
import { AccessConfigurationService } from '../../server/common/access/access-configuration.service';
import * as defaults from '../../server/common/access/access-configuration.defaults';
import { feishuIdentityFingerprint } from '../../server/common/access/feishu-access-approved-grants';
import { ContractPaymentFollowUpService } from '../../server/modules/contract-management/contract-payment-follow-up.service';
import { ContractEditService } from '../../server/modules/contract-management/contract-edit.service';
import { ContractCreationService } from '../../server/modules/contract-management/contract-creation.service';
import { createFixedContractOptions } from '../../shared/contract-field-config';
import { ContractExpiryDispositionService } from '../../server/modules/contract-management/contract-expiry-disposition.service';
import { ContractWorkflowStore } from '../../server/modules/contract-management/contract-workflow.store';

const appId = 'cli_synthetic_payment_authority';
const sourceId = `feishu-${feishuIdentityFingerprint(appId, 'ou_source')}`;
const targetId = `feishu-${feishuIdentityFingerprint(appId, 'ou_target')}`;
const createRequest = () => ({ idempotencyKey: randomUUID(), period: '一期', plannedAmount: 100, plannedPaymentDate: '2026-10-20', ownerOpenId: 'ou_owner' });
const adjustment = { period: '二期', plannedAmount: 120, plannedPaymentDate: '2026-10-21', ownerOpenId: 'ou_owner' };
const confirmation = { actualAmount: 100, paymentDate: '2026-10-20' };

describe('合同付款原写入口使用当前权限', () => {
  let parent: string, folder: string, owner: string, savedApp: string | undefined;
  let config: configuration.AccessConfigurationStore, access: AccessConfigurationService, service: ContractPaymentFollowUpService;
  let gateway: any, disposition: any, contract: any;
  beforeEach(async () => {
    savedApp = process.env.FEISHU_APP_ID; process.env.FEISHU_APP_ID = appId;
    parent = realpathSync(tmpdir()); folder = mkdtempSync(join(parent, 'nt-payment-authority-')); owner = randomUUID();
    writeFileSync(join(folder, '.test-owner'), owner, { flag: 'wx' });
    config = new configuration.AccessConfigurationStore(join(folder, 'configuration.json'));
    jest.spyOn(configuration, 'getAccessConfigurationStore').mockReturnValue(config);
    jest.spyOn(defaults, 'defaultAccessAccounts').mockReturnValue({});
    await config.mutate(0, randomUUID(), 'synthetic-seed', state => {
      for (const [id, openId] of [[sourceId, 'ou_source'], [targetId, 'ou_target']]) state.accounts[id] = {
        id, kind: 'feishu', name: '合成人员', role: 'purchase_admin', building: null, enabled: true, deleted: false,
        version: 1, source: 'configuration', appId, openId, identityHash: feishuIdentityFingerprint(appId, openId),
      };
    });
    access = new AccessConfigurationService();
    contract = { record_id: 'recContract', fields: { 合同编号: 'SYNTHETIC', 合同名称: '合成合同', 专业类别: '电气', 楼栋: 'B楼', 跟进人: [{ id: 'ou_owner', name: '合成跟进人' }] } };
    const payment = { record_id: 'recPayment', fields: { 合同编号: [{ record_ids: ['recContract'] }], 付款周期: '一期', 计划付款金额: 100, 实际付款金额: 0, 付款状态: '未付款', 跟进人: [{ id: 'ou_owner', name: '合成跟进人' }] } };
    gateway = {
      getRecord: jest.fn(async (kind: string) => kind === 'execution' ? contract : payment),
      listRecords: jest.fn(async (kind: string) => kind === 'payment' ? [payment] : []),
      createRecord: jest.fn(async () => 'recCreated'), updateRecord: jest.fn(async () => {}),
    };
    disposition = { updateTextField: jest.fn(async () => {}) };
    service = new ContractPaymentFollowUpService(gateway, { notifyPaymentFollowUpChanged: jest.fn(async () => ({ attempted: true, recipients: 0, sent: 0, failed: 0, message: '合成通知' })) } as never, disposition, { invalidateDashboardCache: jest.fn() } as never, access);
  });
  afterEach(() => {
    jest.restoreAllMocks(); if (savedApp === undefined) delete process.env.FEISHU_APP_ID; else process.env.FEISHU_APP_ID = savedApp;
    const canonical = (value: string) => resolve(value).toLowerCase();
    if (canonical(dirname(folder)) !== canonical(parent) || !/^nt-payment-authority-[A-Za-z0-9]+$/.test(basename(folder)) || lstatSync(folder).isSymbolicLink() || canonical(realpathSync(folder)) !== canonical(folder) || readFileSync(join(folder, '.test-owner'), 'utf8') !== owner) throw Error('Owned fixture mismatch');
    for (const name of readdirSync(folder)) if (!lstatSync(join(folder, name)).isFile() || lstatSync(join(folder, name)).isSymbolicLink()) throw Error('Unsafe fixture');
    rmSync(folder, { recursive: true, force: false });
  });
  const principal = (access: AccessConfigurationService, id = sourceId): AccessPrincipal => {
    const current = access.currentPrincipal(id, 1); if (!current) throw Error('Synthetic account unavailable'); return current;
  };
  async function revoke() { await config.mutate(config.read().revision, randomUUID(), 'synthetic-revoke', state => { state.accounts[sourceId].role = 'site_member'; state.accounts[sourceId].siteMember = true; state.accounts[sourceId].version++; }); }
  function invoke(kind: string, actor: AccessPrincipal | undefined) {
    if (actor) actor = { ...actor, permissionContext: { module: 'contracts', action: kind === 'create' ? 'create' : kind === 'confirm' ? 'confirm' : 'update' } };
    if (kind === 'create') return service.createPlan('recContract', createRequest(), actor);
    if (kind === 'adjust') return service.adjustPlan('recContract', 'recPayment', adjustment, actor);
    if (kind === 'confirm') return service.confirmPlan('recContract', 'recPayment', confirmation, actor);
    return service.markNoPaymentRequired('recContract', { idempotencyKey: randomUUID() }, actor);
  }
  it.each(['create', 'adjust', 'confirm', 'no_payment'])('%s校验等待期间撤权，旧请求不能开始写入', async kind => {
    let entered!: () => void, release!: () => void;
    const began = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    gateway.listRecords.mockImplementation(async (table: string) => { if (table === (kind === 'no_payment' ? 'payment' : 'organization')) { entered(); await gate; } return []; });
    const pending = invoke(kind, principal(access)); const rejected = expect(pending).rejects.toThrow('权限');
    await began; await revoke(); release(); await rejected;
    expect(gateway.createRecord).not.toHaveBeenCalled(); expect(gateway.updateRecord).not.toHaveBeenCalled(); expect(disposition.updateTextField).not.toHaveBeenCalled();
  });
  it('接任者按当前授权继续确认同一原计划，已完成写入不因之后撤权重做', async () => {
    await revoke();
    gateway.updateRecord.mockImplementation(async () => { await config.mutate(config.read().revision, randomUUID(), 'synthetic-target-revoke', state => { state.accounts[targetId].enabled = false; state.accounts[targetId].version++; }); });
    await expect(invoke('confirm', principal(access, targetId))).resolves.toMatchObject({ ok: true, action: 'confirm', paymentRecordId: 'recPayment' });
    expect(gateway.updateRecord).toHaveBeenCalledTimes(1);
    await expect(invoke('confirm', { role: 'purchase_admin', purchaseBuilding: null, accountId: targetId, authorizationVersion: 1 })).rejects.toThrow('权限');
    expect(gateway.updateRecord).toHaveBeenCalledTimes(1);
  });
  it('工程师只能在当前专业和楼栋范围写入，个人精细允许可扩充且限制优先', async () => {
    await config.mutate(config.read().revision, randomUUID(), 'synthetic-engineer', state => { Object.assign(state.accounts[sourceId], { role: 'professional_engineer', building: 'B楼', buildings: ['B楼'], specialties: ['电气'] }); });
    const actor = principal(access); await expect(invoke('confirm', actor)).resolves.toMatchObject({ ok: true });
    contract.fields.楼栋 = 'A楼'; await expect(invoke('confirm', actor)).rejects.toThrow('授权');
    await config.mutate(config.read().revision, randomUUID(), 'synthetic-extra', state => { state.accounts[sourceId].personalRules = [{ id: 'synthetic-allow', effect: 'allow', module: 'contracts', actions: ['confirm'], buildings: ['A楼'], specialties: ['电气'] }]; });
    await expect(invoke('confirm', principal(access))).resolves.toMatchObject({ ok: true });
    await config.mutate(config.read().revision, randomUUID(), 'synthetic-deny', state => { state.accounts[sourceId].personalRules!.push({ id: 'synthetic-deny', effect: 'deny', module: 'contracts', actions: ['confirm'], buildings: ['A楼'], specialties: ['电气'] }); });
    await expect(invoke('confirm', principal(access))).rejects.toThrow('授权'); expect(gateway.updateRecord).toHaveBeenCalledTimes(2);
  });
  it('实名游客和缺少身份均不可调用原写入口', async () => {
    await config.mutate(config.read().revision, randomUUID(), 'synthetic-guest', state => { state.accounts[sourceId].role = 'guest'; });
    await expect(invoke('confirm', principal(access))).rejects.toThrow('权限');
    await expect(invoke('confirm', undefined)).rejects.toThrow('权限'); expect(gateway.updateRecord).not.toHaveBeenCalled();
  });
  it('合同编辑等待原记录期间撤权，不能继续写入', async () => {
    Object.assign(contract.fields, { 合同类型: '维保合同', 合同金额: 100, 合同开始日期: '2026-10-01', 合同结束日期: '2027-10-01', 供应商: [{ record_ids: ['recSupplier'] }] });
    let entered!: () => void, release!: () => void;
    const began = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    gateway.getRecord.mockImplementation(async () => { entered(); await gate; return contract; });
    const options = { ...createFixedContractOptions('execution'), people: [{ openId: 'ou_owner', name: '合成跟进人' }], suppliers: [] };
    const editing = new ContractEditService(gateway, { getOptions: jest.fn(async () => options) } as never, access);
    const pending = editing.update('recContract', { fields: { fldl8lAeAw: '合成新名称' } }, principal(access));
    const rejected = expect(pending).rejects.toThrow('权限'); await began; await revoke(); release(); await rejected;
    expect(gateway.updateRecord).not.toHaveBeenCalled();
  });
  it('合同新增等待资料期间撤权，不能上传附件或创建供应商与合同', async () => {
    let entered!: () => void, release!: () => void;
    const began = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    gateway.listRecords.mockImplementation(async (kind: string) => { if (kind === 'organization') { entered(); await gate; return [contract]; } return []; });
    gateway.uploadPdf = jest.fn(async () => 'boxSynthetic'); gateway.deleteRecord = jest.fn(async () => {});
    const creating = new ContractCreationService(gateway, { syncContractRecordAttachments: jest.fn(async () => []), removeContractRecordAttachments: jest.fn(async () => 0) } as never, { notifyContractCreated: jest.fn(async () => ({ failed: 0 })) } as never, access);
    const request = { kind: 'execution' as const, idempotencyKey: randomUUID(), fields: { fldbOaLbUD: 'SYNTHETIC', fldl8lAeAw: '合成合同', fldxPuYT19: 'ou_owner', fldlu37YRh: '维保合同', flda4ARUY9: 100, fldTKcyksD: '2026-10-01', fldEcltbl1: '2027-10-01', fldGqKUOPN: '电气' }, supplier: { mode: 'new' as const, fields: { fld7wwRKhu: '合成供应商' } }, linkFramework: false, paymentPlans: [{ period: '一期', plannedAmount: 100, plannedPaymentDate: '2026-10-20', ownerOpenId: 'ou_owner' }] };
    const buffer = Buffer.from('%PDF-1.4\nsynthetic');
    const pending = creating.create(request, [{ originalname: 'synthetic.pdf', mimetype: 'application/pdf', size: buffer.length, buffer }], { principal: principal(access) });
    const rejected = expect(pending).rejects.toThrow('权限'); await began; await revoke(); release(); await rejected;
    expect(gateway.uploadPdf).not.toHaveBeenCalled(); expect(gateway.createRecord).not.toHaveBeenCalled();
  });
  it('当前实名游客也不能通过处置受理服务创建新任务', async () => {
    await config.mutate(config.read().revision, randomUUID(), 'synthetic-guest-disposition', state => { state.accounts[sourceId].role = 'guest'; });
    const native = new ContractWorkflowStore(join(folder, 'contract-ledger.json'));
    const expiry = new ContractExpiryDispositionService({} as never, {} as never, {} as never, native, access);
    try {
      await expect(expiry.submit('recContract', { action: 'void', idempotencyKey: randomUUID() }, new Date(), principal(access))).rejects.toThrow('权限');
      expect(await native.listDispositionTasks()).toEqual([]);
    } finally { await expiry.onModuleDestroy(); }
  });
});
