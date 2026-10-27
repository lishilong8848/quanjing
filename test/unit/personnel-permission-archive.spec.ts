import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { capturePersonnelPermission } from '../../server/common/access/personnel-permission-archive';
import * as stores from '../../server/common/access/access-configuration.store';
import * as defaults from '../../server/common/access/access-configuration.defaults';
import { AccessConfigurationService } from '../../server/common/access/access-configuration.service';
import { feishuIdentityFingerprint } from '../../server/common/access/feishu-access-approved-grants';

const appId='cli_archive_synthetic';
const identity=feishuIdentityFingerprint(appId,'ou_archive_synthetic_chief');
const chief:stores.StoredAccount={ id:`feishu-${identity}`,kind:'feishu',name:'合成主管',openId:'ou_archive_synthetic_chief',appId,identityHash:identity,role:'building_admin',building:'C楼',buildings:['C楼'],version:3,enabled:true,deleted:false,source:'configuration',permissionSource:'personnel',siteMember:true,
  personalRules:[{ id:'synthetic-extra',effect:'allow',module:'knowledge',actions:['read','update'],buildings:null,specialties:null }] };
const archiveState=(store:stores.AccessConfigurationStore)=>store.read() as stores.ConfigurationState & { personnelPermissionArchives?: Record<string, ReturnType<typeof capturePersonnelPermission>> };

describe('离职与权限变更前的完整授权快照',()=>{
  let directory:string, temporaryRoot:string, owner:string, file:string, store:stores.AccessConfigurationStore, service:AccessConfigurationService;
  let originalApp:string|undefined, originalSecret:string|undefined;
  beforeEach(async()=>{
    originalApp=process.env.FEISHU_APP_ID; process.env.FEISHU_APP_ID=appId;
    originalSecret=process.env.LOCAL_ACCESS_SESSION_SECRET; process.env.LOCAL_ACCESS_SESSION_SECRET=randomBytes(32).toString('base64');
    temporaryRoot=realpathSync(tmpdir()); directory=mkdtempSync(join(temporaryRoot,'nt-permission-archive-')); owner=randomUUID(); file=join(directory,'configuration.json');
    writeFileSync(join(directory,'.test-owner'),owner,{flag:'wx'});
    store=new stores.AccessConfigurationStore(file);
    jest.spyOn(stores,'getAccessConfigurationStore').mockReturnValue(store); jest.spyOn(defaults,'defaultAccessAccounts').mockReturnValue({});
    await store.mutate(0,'synthetic-archive-seed','synthetic-seed',state=>{ state.accounts[chief.id]=JSON.parse(JSON.stringify(chief)); state.rolePageRules={ building_admin:['/inventory-management','/operations-kb'] }; });
    service=new AccessConfigurationService();
  });
  afterEach(()=>{
    jest.restoreAllMocks(); if (originalApp === undefined) delete process.env.FEISHU_APP_ID; else process.env.FEISHU_APP_ID=originalApp;
    if (originalSecret === undefined) delete process.env.LOCAL_ACCESS_SESSION_SECRET; else process.env.LOCAL_ACCESS_SESSION_SECRET=originalSecret;
    const canonical=(value:string)=>resolve(value).toLowerCase();
    if (!isAbsolute(directory) || canonical(dirname(directory)) !== canonical(temporaryRoot) || !/^nt-permission-archive-[A-Za-z0-9]+$/u.test(basename(directory)) || !existsSync(directory) ||
      lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory() || canonical(realpathSync(directory)) !== canonical(directory)) throw new Error('授权快照测试目录归属异常，已保留');
    for (const name of readdirSync(directory)) { const item=lstatSync(join(directory,name)); if (!item.isFile() || item.isSymbolicLink()) throw new Error('授权快照测试目录包含异常条目，已保留'); }
    if (readFileSync(join(directory,'.test-owner'),'utf8') !== owner) throw new Error('授权快照测试目录所有权异常，已保留');
    rmSync(directory,{recursive:true,force:false});
  });
  it('显式白名单保留完整读写范围，排除凭证和私人字段；停用快照不能覆盖最后有效授权',()=>{
    const input={ ...chief,passwordHash:'synthetic-do-not-archive',password:'synthetic-do-not-archive',identityNumber:'synthetic-do-not-archive' };
    const archive=capturePersonnelPermission(input,{ building_admin:['/inventory-management','/operations-kb'] },8)!;
    expect(archive).toMatchObject({ accountId:chief.id,name:chief.name,configurationRevision:8,template:{ role:'building_admin',buildings:['C楼'],sourceVersion:3,personalRules:chief.personalRules } });
    expect(archive.template.pagePaths).toContain('/operations-kb'); expect(JSON.stringify(archive)).not.toContain('synthetic-do-not-archive');
    expect(capturePersonnelPermission({ ...chief,enabled:false },undefined,9)).toBeNull();
  });
  it('人员同步禁用与前任授权快照在同一原子配置中保存，重启可恢复且页面API不泄露归档',async()=>{
    await service.synchronizePersonnel({ appId,people:[],employees:[{ name:chief.name,openId:chief.openId!,position:'设施主管',specialties:'C楼',inactive:true }],snapshotAt:Date.now(),personnelComplete:true });
    expect(service.snapshot().accounts[0].enabled).toBe(false);
    const restored=archiveState(new stores.AccessConfigurationStore(file)).personnelPermissionArchives?.[chief.id];
    expect(restored?.template).toMatchObject({ role:'building_admin',buildings:['C楼'],sourceVersion:3,personalRules:chief.personalRules });
    expect(restored?.template.pagePaths).toContain('/operations-kb'); expect(service.snapshot()).not.toHaveProperty('personnelPermissionArchives');
  });
  it('角色页面规则变更前保存旧读取快照，不用修改后的规则重建前任权限',async()=>{
    await service.savePageRole({ clientMutationId:'synthetic-page-update',expectedRevision:store.read().revision,role:'building_admin',pages:['/nantong-base'] },{ role:'admin',purchaseBuilding:null,displayName:'合成管理员' });
    const archive=archiveState(store).personnelPermissionArchives?.[chief.id]; expect(archive?.template.pagePaths).toContain('/inventory-management');
    expect(service.pagePermissions('building_admin').paths).toEqual(['/nantong-base']);
  });
  it('语义损坏的授权归档阻止落盘，不影响原配置字节和修订号',async()=>{
    const before=readFileSync(file,'utf8'); const revision=store.read().revision;
    await expect(store.mutate(revision,'synthetic-bad-archive','synthetic-bad',state=>{ Object.assign(state,{personnelPermissionArchives:{ [chief.id]:{accountId:chief.id,template:{role:'admin'},passwordHash:'synthetic-do-not-archive'} }}); })).rejects.toThrow('权限配置校验失败');
    expect(readFileSync(file,'utf8')).toBe(before); expect(store.read().revision).toBe(revision);
  });
});
