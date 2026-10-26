import { createHash, randomUUID, randomBytes } from 'node:crypto';
import { mkdtempSync, realpathSync, readFileSync, writeFileSync, lstatSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import * as stores from '../../server/common/access/access-configuration.store';
import * as defaults from '../../server/common/access/access-configuration.defaults';
import { AccessConfigurationService } from '../../server/common/access/access-configuration.service';
import { AccessPersonnelSyncService, personnelSyncCalendarDay } from '../../server/common/access/access-personnel-sync.service';
import { PersonnelSourceService } from '../../server/common/access/personnel-source.service';
import { acknowledgePersonnelSourceAssignments, resolvePersonnelSourceMembers } from '../../server/common/access/personnel-source.policy';
import { resolveCurrentPersonnelDutyMembers } from '../../server/common/access/personnel-duty-current';
import { feishuIdentityFingerprint } from '../../server/common/access/feishu-access-approved-grants';
import type { ConfigurationDirectorySnapshot } from '../../server/common/access/access-configuration.directory';
import type { AccessPrincipal } from '../../shared/access-control.interface';
import type { PersonnelSourceMutation } from '../../shared/personnel-source.interface';
import { PERSONNEL_SOURCE_MAX_AGE_MS, PERSONNEL_SOURCE_CARD_DUTIES } from '../../shared/personnel-source.interface';
import { CARD_PERSONNEL_DUTIES } from '../../server/common/access/personnel-duty-routing';

const appId = 'cli_source_lifecycle_synthetic', source = { appId, appToken: 'syntheticBase', tableId: 'tblPeople', dutyTableId: 'tblDuties' };
const nativeId = (recordId: string) => `local-external-${createHash('sha256').update(JSON.stringify([appId,source.appToken,source.tableId,recordId])).digest('hex')}`;
const people = ['A','B'].map(suffix => ({ id: nativeId(`recPerson${suffix}`), recordId: `recPerson${suffix}`, openId: `ou_source_${suffix}`, name: `合成人员${suffix}`, active: true,
  type: 'employee' as const, position: '值班人员', systemPosition: '', buildings: ['C楼' as const], specialties: [], permissionTags: [], dutyRecordIds: [] as string[] }));
function directory(holder = 0): ConfigurationDirectorySnapshot {
  return { appId, people: people.map(person => ({ name: person.name, openId: person.openId })), employees: people.map(person => ({ name: person.name, openId: person.openId, position: person.position, specialties: 'C楼', inactive: false })),
    snapshotAt: Date.now(), personnelComplete: true, employmentState: { complete: true, entries: people.map(person => ({ personnelIdentity: person.id, openId: person.openId, inactive: false })) },
    personnelAuthority: { mode: 'shadow', version: (holder ? 'b' : 'a').repeat(64), snapshotAt: Date.now(), source, problems: [], issues: [], people: people.map((person,index) => ({ ...person, dutyRecordIds: index === holder ? ['recDuty'] : [] })),
      duties: [{ recordId: 'recDuty', name: '合成C楼库房审批', kind: 'warehouse_approver', personnelIds: [people[holder].id], buildings: ['C楼'], specialties: null, enabled: true, startsAt: 0, endsAt: null, parentDutyIds: [], version: holder + 1 }] } };
}
const route = (holder = 0) => ({ appId, dutyRecordId: 'recDuty', kind: 'warehouse_approver' as const, buildings: ['C楼' as const], specialties: null, startsAt: 0, endsAt: null,
  version: holder + 1, confirmedBatchId: 'eb761f03-468f-4a86-b971-1f074fa695cc', members: [{ personId: people[holder].id, recordId: people[holder].recordId, openId: people[holder].openId, name: people[holder].name }] });

describe('正式来源激活、持久同步与恢复', () => {
  let store: stores.AccessConfigurationStore, configuration: AccessConfigurationService, service: PersonnelSourceService, actor: AccessPrincipal;
  let root: string, folder: string, owner: string, previous: NodeJS.ProcessEnv;
  let current: ConfigurationDirectorySnapshot, read: jest.Mock;
  beforeEach(async () => {
    previous = { ...process.env }; process.env.FEISHU_APP_ID = appId; process.env.LOCAL_ACCESS_SESSION_SECRET = randomBytes(32).toString('base64');
    root = realpathSync(tmpdir()); folder = mkdtempSync(join(root, 'nt-source-lifecycle-')); owner = randomUUID(); writeFileSync(join(folder, '.test-owner'), owner, { flag: 'wx' });
    store = new stores.AccessConfigurationStore(join(folder, 'configuration.json')); jest.spyOn(stores, 'getAccessConfigurationStore').mockReturnValue(store); jest.spyOn(defaults, 'defaultAccessAccounts').mockReturnValue({});
    const account = (openId: string, name: string): stores.StoredAccount => { const identityHash = feishuIdentityFingerprint(appId,openId); return { id: `feishu-${identityHash}`, appId, identityHash, openId, name, kind: 'feishu', role: 'site_member', siteMember: true, building: null, enabled: true, deleted: false, source: 'configuration', version: 1 }; };
    const admin = { ...account('ou_source_admin','合成管理员'), role: 'admin' as const };
    await store.mutate(0, 'seed-source-lifecycle', 'seed', state => {
      state.accounts = Object.fromEntries([admin,...people.map(person => ({ ...account(person.openId,person.name), personnelIdentity: person.id }))].map(value => [value.id,value]));
      state.personnelDutyAssignments = { recDuty: route() };
    });
    actor = { role: 'admin', purchaseBuilding: null, displayName: admin.name, accountId: admin.id, authorizationVersion: 1 };
    configuration = new AccessConfigurationService(); current = directory(); read = jest.fn(async () => structuredClone(current)); service = new PersonnelSourceService(configuration,{ read } as never);
  });
  afterEach(() => {
    jest.useRealTimers(); jest.restoreAllMocks(); process.env = previous;
    if (resolve(dirname(folder)).toLowerCase() !== resolve(root).toLowerCase() || realpathSync(folder) !== folder || lstatSync(folder).isSymbolicLink() || readFileSync(join(folder,'.test-owner'),'utf8') !== owner) throw Error('测试目录归属异常');
    rmSync(folder,{recursive:true});
  });
  const input = (configuration: AccessConfigurationService, version = 'a'.repeat(64), action: 'activate' | 'pause' = 'activate'): PersonnelSourceMutation => ({ action, clientMutationId: randomUUID(), expectedRevision: configuration.snapshot().revision, expectedDirectoryVersion: version });
  it('核对已确认岗位后同一原配置事务启用，身份、个人权限和密码不复制', async () => {
    const before = configuration.snapshot().accounts;
    expect(await service.preview(actor)).toMatchObject({ canActivate: true, rows: [{ members: ['合成人员A'], status: 'aligned' }] });
    await service.change(input(configuration),actor);
    expect(configuration.snapshot().accounts).toEqual(before);
    expect(new stores.AccessConfigurationStore(store.filePath).read().personnelSource).toMatchObject({ status: 'active', routes: { recDuty: { confirmedBatchId: route().confirmedBatchId } } });
    expect(resolveCurrentPersonnelDutyMembers(store.read(),appId,'warehouse_approver',{building:'C楼'})).toEqual([{openId:people[0].openId,name:people[0].name}]);
  });
  it('没有已确认基线时不能直接从表中获得新岗位权限', async () => {
    await store.mutate(store.read().revision,'remove-confirmed-baseline','remove',state=>{delete state.personnelDutyAssignments;});
    expect(await service.preview(actor)).toMatchObject({canActivate:false,rows:[{status:'unconfirmed'}]});
    const before=readFileSync(store.filePath);await expect(service.change(input(configuration),actor)).rejects.toThrow(/尚未对齐/);expect(readFileSync(store.filePath)).toEqual(before);
  });
  it('表中仍在职但本地手工停用的负责人不能被核源当作已就绪', async () => {
    const id=`feishu-${feishuIdentityFingerprint(appId,people[0].openId)}`;
    await store.mutate(store.read().revision,'manual-source-holder-disable','disable',state=>{state.accounts[id].enabled=false;state.accounts[id].version++;});
    expect(await service.preview(actor)).toMatchObject({canActivate:false});
    await expect(service.change(input(configuration),actor)).rejects.toThrow(/尚未对齐/);
    expect(store.read().accounts[id].enabled).toBe(false);
  });
  it('结果丢失重试同mutation不重复核源或写入；旧暂停重放不覆盖后来的恢复', async () => {
    const first=input(configuration);await service.change(first,actor);const calls=read.mock.calls.length,revision=store.read().revision;
    await service.change({...first},actor);expect(read).toHaveBeenCalledTimes(calls);expect(store.read().revision).toBe(revision);
    const pause=input(configuration,'a'.repeat(64),'pause');await service.change(pause,actor);expect(store.read().personnelSource?.status).toBe('paused');
    await service.change(input(configuration),actor);const finalRevision=store.read().revision;
    await service.change(pause,actor);expect(store.read().revision).toBe(finalRevision);expect(store.read().personnelSource?.status).toBe('active');
    await expect(service.change({...first,action:'pause'},actor)).rejects.toThrow(/重复请求/);
  });
  it('异步核源期间管理员版本失效，拒绝保存且不替换成新版本', async () => {
    let release!:()=>void;read.mockImplementationOnce(async()=>{await new Promise<void>(resolve=>{release=resolve;});return current;});
    const pending=service.change(input(configuration),actor);await Promise.resolve();
    await store.mutate(store.read().revision,'admin-version-change','change',state=>{state.accounts[actor.accountId!].version++;});release();
    await expect(pending).rejects.toThrow(/管理权限已变化/);expect(store.read().personnelSource).toBeUndefined();
  });
  it('人员换岗只进入待交接；确认的原岗位事务更新后才恢复该职责', async () => {
    await service.change(input(configuration),actor);current=directory(1);await configuration.synchronizePersonnel(current);
    expect(store.read().personnelSource).toMatchObject({status:'pending',routes:{recDuty:{members:[{openId:people[0].openId}]}},pending:[{candidate:{members:[{openId:people[1].openId}]}}]});
    expect(()=>resolveCurrentPersonnelDutyMembers(store.read(),appId,'warehouse_approver',{building:'C楼'})).toThrow(/交接/);
    await store.mutate(store.read().revision,'synthetic-confirmed-handover','handover',state=>{state.personnelDutyAssignments!.recDuty=route(1);acknowledgePersonnelSourceAssignments(state);});
    expect(new stores.AccessConfigurationStore(store.filePath).read().personnelSource).toMatchObject({status:'active',pending:[]});
    expect(resolveCurrentPersonnelDutyMembers(store.read(),appId,'warehouse_approver',{building:'C楼'})).toEqual([{openId:people[1].openId,name:people[1].name}]);
  });
  it('来源坏页保留最近确认数据和时间；超过有效期拒绝；恢复不回旧表', async () => {
    await service.change(input(configuration),actor);const before=store.read().personnelSource!;
    current.personnelAuthority!.problems=['合成分页缺失'];await configuration.synchronizePersonnel(current);
    const failed=new stores.AccessConfigurationStore(store.filePath).read().personnelSource!;
    expect(failed).toMatchObject({status:'error',lastSuccessAt:before.lastSuccessAt,routes:before.routes});
    expect(()=>resolvePersonnelSourceMembers(failed,appId,'warehouse_approver',{building:'C楼'},before.lastSuccessAt+PERSONNEL_SOURCE_MAX_AGE_MS+1)).toThrow(/有效期/);
    current=directory();await configuration.synchronizePersonnel(current);expect(store.read().personnelSource?.status).toBe('active');
    await service.change(input(configuration,'a'.repeat(64),'pause'),actor);expect(()=>resolveCurrentPersonnelDutyMembers(store.read(),appId,'warehouse_approver',{building:'C楼'})).toThrow(/暂停/);
    await configuration.synchronizePersonnel(directory());expect(store.read().personnelSource?.status).toBe('paused');
  });
  it('自动失败预算落原配置，重建同步service后仍等5分钟，成功后当天不重复', async () => {
    jest.useFakeTimers();const start=new Date('2026-10-16T02:00:00+08:00');jest.setSystemTime(start);current=directory();await service.change(input(configuration),actor);
    const directoryPort={read:jest.fn().mockRejectedValueOnce(new Error('synthetic-source-outage')).mockImplementation(async()=>directory())};
    const first=new AccessPersonnelSyncService(configuration,directoryPort as never);await expect(first.run()).rejects.toThrow('synthetic-source-outage');
    expect(new stores.AccessConfigurationStore(store.filePath).read().personnelSync).toMatchObject({status:'error',attempts:1,attemptDay:personnelSyncCalendarDay(start)});
    const restarted=new AccessPersonnelSyncService(new AccessConfigurationService(),directoryPort as never);
    jest.setSystemTime(new Date(start.getTime()+4*60_000));await restarted.tick();expect(directoryPort.read).toHaveBeenCalledTimes(1);
    jest.setSystemTime(new Date(start.getTime()+5*60_000));await restarted.tick();expect(directoryPort.read).toHaveBeenCalledTimes(2);expect(store.read().personnelSync).toMatchObject({status:'success',attempts:2});
    await restarted.tick();expect(directoryPort.read).toHaveBeenCalledTimes(2);
  });
  it('前后端卡片职责映射必须与原路由目录一致',()=>{expect(PERSONNEL_SOURCE_CARD_DUTIES).toEqual(CARD_PERSONNEL_DUTIES);});
});
