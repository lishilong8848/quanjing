jest.mock('../../server/common/feishu/bitable-direct-read', () => ({
  ...jest.requireActual('../../server/common/feishu/bitable-direct-read'),
  getTenantAccessToken: jest.fn(async () => 'synthetic-token'),
  resolveBitableAppToken: jest.fn(async () => 'bascnEmploymentSynthetic'),
}));
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { PersonnelProfileChangesGateway } from '../../server/common/access/personnel-profile-changes.gateway';
import { PersonnelProfileChangesService } from '../../server/common/access/personnel-profile-changes.service';
import { PersonnelProfileChangesStore } from '../../server/common/access/personnel-profile-changes.store';
import { feishuIdentityFingerprint } from '../../server/common/access/feishu-access-approved-grants';
import type { AccessPrincipal } from '../../shared/access-control.interface';

describe('profile submission with schema-confirmed omitted employment checkbox', () => {
  const env = { ...process.env };
  const source = { appId: 'cli_employment_fixture', appToken: 'bascnEmploymentSynthetic', tableId: 'tblEmploymentFixture', recordId: 'recEmploymentFixture' };
  let folder: string;
  beforeEach(() => {
    folder = mkdtempSync(join(realpathSync(tmpdir()), 'nt-employment-integration-'));
    process.env.FEISHU_APP_ID = source.appId;
    process.env.FEISHU_EMPLOYEE_ONBOARDING_APP_TOKEN = source.appToken;
    process.env.FEISHU_EMPLOYEE_ONBOARDING_TABLE_ID = source.tableId;
  });
  afterEach(() => {
    process.env = { ...env };
    if (dirname(resolve(folder)) !== resolve(realpathSync(tmpdir())) || lstatSync(folder).isSymbolicLink()) throw new Error('Unsafe fixture cleanup');
    rmSync(folder, { recursive: true, force: false });
  });
  it.each(['feishu', 'personnel-password'] as const)('%s creates pending via the real gateway and service without source writes', async mode => {
    await exercise(mode, false);
  });
  it.each(['feishu', 'personnel-password'] as const)('%s still rejects a genuinely checked departure value', async mode => {
    await exercise(mode, true);
  });
  async function exercise(mode: 'feishu' | 'personnel-password', departed: boolean) {
    const identity = 'local-external-' + createHash('sha256').update(JSON.stringify([source.appId, source.appToken, source.tableId, source.recordId])).digest('hex');
    const openId = 'ou_synthetic_employment';
    const id = mode === 'feishu' ? 'feishu-' + feishuIdentityFingerprint(source.appId, openId) : identity;
    const principal: AccessPrincipal = { accountId: id, authorizationVersion: 1, role: 'guest', purchaseBuilding: null, displayName: '合成测试人员' };
    const account = { id, version: 1, role: 'guest', name: principal.displayName, enabled: true, deleted: false, personnelActive: true, personnelIdentity: identity,
      ...(mode === 'feishu' ? { kind: 'feishu', appId: source.appId, openId } : { kind: 'local', loginMethod: 'personnel-password', personnelAppId: source.appId }) };
    const configuration = { currentPrincipal: jest.fn((accountId, version) => accountId === id && version === 1 ? principal : null), getPersonnelCredentialAccount: jest.fn(accountId => accountId === id ? account : null) };
    const baseFields = { 姓名: principal.displayName, 员工姓名: [{ id: openId, name: principal.displayName }], 联系方式: '13800000000' };
    const directory = { read: jest.fn(async () => ({ ...source, snapshotAt: new Date().toISOString(), records: [{ record_id: source.recordId, fields: { ...baseFields, '离职/异动情况': false } }] })) };
    const get = jest.fn(async (url: string) => {
      if (url.endsWith('/fields')) return { data: { code: 0, data: { has_more: false, items: [{ field_name: '离职/异动情况', type: 7 }, { field_name: '联系方式', type: 13 }] } } };
      if (url.endsWith('/records/' + source.recordId)) return { data: { code: 0, data: { record: { record_id: source.recordId, fields: { ...baseFields, ...(departed ? { '离职/异动情况': true } : {}) } } } } };
      throw new Error('Unexpected fixture HTTP endpoint');
    });
    const put = jest.fn(), post = jest.fn();
    const gateway = new PersonnelProfileChangesGateway({ axiosRef: { get, put, post } } as any);
    const store = new PersonnelProfileChangesStore();
    Object.defineProperty(store, 'path', { value: join(folder, 'changes.json') });
    const service = new PersonnelProfileChangesService(configuration as any, directory as any, gateway, store);
    const input = { clientMutationId: randomUUID(), phone: '13800000001' };
    if (departed) {
      await expect(service.create(principal, input)).rejects.toThrow('人员在职状态已变化');
      expect(Object.keys(store.read().requests)).toHaveLength(0);
    } else {
      const result = await service.create(principal, input);
      expect(result).toMatchObject({ accountId: id, status: 'pending', changes: { phone: '13800000001' } });
      expect(store.read().requests[result.id]).toMatchObject({ identity, source, status: 'pending' });
      expect(get.mock.calls.filter(([url]) => url.endsWith('/fields'))).toHaveLength(2);
    }
    expect(put).not.toHaveBeenCalled(); expect(post).not.toHaveBeenCalled();
    await service.onModuleDestroy();
  }
});
