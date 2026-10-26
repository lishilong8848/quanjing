import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import * as stores from '../../server/common/access/access-configuration.store';
import * as defaults from '../../server/common/access/access-configuration.defaults';
import { AccessConfigurationService } from '../../server/common/access/access-configuration.service';

const appId = 'cli_source_store_synthetic';
const source = () => ({ status: 'active', source: { appId, appToken: 'syntheticBase', tableId: 'tblPeople', dutyTableId: 'tblDuties' },
  directoryVersion: 'a'.repeat(64), activatedAt: Date.now(), lastSuccessAt: Date.now(), routes: { recDuty: {
    appId, dutyRecordId: 'recDuty', kind: 'warehouse_approver', buildings: ['C楼'], specialties: null, startsAt: 0, endsAt: null, version: 1,
    confirmedBatchId: 'eb761f03-468f-4a86-b971-1f074fa695cc', members: [{ personId: `local-external-${'a'.repeat(64)}`, recordId: 'recPerson', openId: 'ou_source', name: '合成人员' }],
  } }, pending: [] });
describe('正式来源随原权限配置持久化', () => {
  let directory: string, owner: string, store: stores.AccessConfigurationStore, previous: NodeJS.ProcessEnv;
  beforeEach(() => {
    previous = { ...process.env }; process.env.FEISHU_APP_ID = appId; process.env.LOCAL_ACCESS_SESSION_SECRET = randomBytes(32).toString('base64');
    directory = mkdtempSync(join(realpathSync(tmpdir()), 'nt-personnel-source-')); owner = randomUUID(); writeFileSync(join(directory, '.test-owner'), owner, { flag: 'wx' });
    store = new stores.AccessConfigurationStore(join(directory, 'configuration.json'));
    jest.spyOn(stores, 'getAccessConfigurationStore').mockReturnValue(store); jest.spyOn(defaults, 'defaultAccessAccounts').mockReturnValue({});
  });
  afterEach(() => {
    jest.restoreAllMocks(); process.env = previous;
    if (resolve(directory).startsWith(realpathSync(tmpdir()) + '\\') && readFileSync(join(directory, '.test-owner'), 'utf8') === owner) rmSync(directory, { recursive: true });
  });
  it('非法来源状态不能被旧配置读取逻辑忽略后继续放行', async () => {
    await store.mutate(0, 'seed', 'seed', () => undefined);
    const value = JSON.parse(readFileSync(store.filePath, 'utf8')); value.personnelSource = { ...source(), status: 'unknown' };
    writeFileSync(store.filePath, JSON.stringify(value));
    expect(() => store.read()).toThrow(/权限配置文件无效/);
  });
  it('每日重试次数、日期和下次重试必须有持久字段校验', async () => {
    await expect(store.mutate(0, 'bad-counter', 'bad-counter', state => { state.personnelSync = { status: 'error', attempts: -1 } as never; })).rejects.toThrow(/校验/);
  });
  it('启用后原卡片人员编辑不能产生优先级更高的隐藏名单', async () => {
    await store.mutate(0, 'seed', 'seed', state => { (state as unknown as { personnelSource: unknown }).personnelSource = source(); });
    const service = new AccessConfigurationService();
    await expect(service.saveCardRule({ clientMutationId: randomUUID(), expectedRevision: 1, code: 'warehouse_responsible', building: 'C楼', members: [{ openId: 'ou_override', name: '合成覆盖人员' }] },
      { role: 'admin', purchaseBuilding: null })).rejects.toThrow(/统一岗位|统一来源/);
  });
  it('未被正式来源接管的其他职责仍可按原规则保存', async () => {
    await store.mutate(0, 'seed', 'seed', state => { (state as unknown as { personnelSource: unknown }).personnelSource = source(); });
    const service = new AccessConfigurationService();
    await expect(service.saveCardRule({ clientMutationId: randomUUID(), expectedRevision: 1, code: 'warehouse_notify', building: 'A楼', members: [{ openId: 'ou_other', name: '合成示例人员004员' }] },
      { role: 'admin', purchaseBuilding: null })).resolves.toMatchObject({ revision: 2, cardRules: [{ code: 'warehouse_notify', building: 'A楼' }] });
  });
});
