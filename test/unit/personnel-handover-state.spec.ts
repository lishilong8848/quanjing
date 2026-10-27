import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { assertHandoverBaseline, handoverFingerprint, permissionTemplateFingerprint, type PreviewContent } from '../../server/common/access/personnel-handover.baseline';
import { PersonnelHandoverStore, handoverItemMutationId } from '../../server/common/access/personnel-handover.store';
import type { AuthorityPerson } from '../../shared/personnel-authority.interface';
import type { PersonnelHandoverPreview } from '../../shared/personnel-handover.interface';
import { accountPermissionTemplate, previewPermissionInheritance } from '../../server/common/access/personnel-handover.preview';

const authorityPerson = (id: string, active: boolean): AuthorityPerson => ({ id,recordId:`rec-${id}`,name:`合成人员-${id}`,openId:`ou_synthetic_${id}`,active,type:'employee',position:'设施主管',systemPosition:'',buildings:['C楼'],specialties:[],permissionTags:[],dutyRecordIds:['synthetic-duty'] });
function content(): PreviewContent {
  const source = accountPermissionTemplate({ id:'synthetic-old',kind:'feishu',name:'合成前任',role:'building_admin',building:'C楼',enabled:false,deleted:false,version:3,source:'configuration' });
  const target = accountPermissionTemplate({ id:'synthetic-new',kind:'feishu',name:'合成接任',role:'site_member',building:null,enabled:true,deleted:false,version:2,source:'configuration' });
  return {
    requested:{ fromPersonId:'old',toPersonId:'new',dutyRecordIds:['synthetic-duty'],mode:'offboarding' },
    baseline:{ configurationRevision:8,directoryVersion:'a'.repeat(64),accounts:[{ id:'synthetic-old',version:3 },{ id:'synthetic-new',version:2 }],duties:[{ recordId:'synthetic-duty',version:4 }],pending:[{ key:'leave:synthetic',version:'stage-2' }] },
    from:authorityPerson('old',false),to:authorityPerson('new',true),permissions:[{ ...previewPermissionInheritance(source,target),sourceAccountId:'synthetic-old',targetAccountId:'synthetic-new' }],
    pending:[{ key:'leave:synthetic',module:'leave',recordId:'synthetic-record',title:'合成请休假',dutyRecordId:'synthetic-duty',phase:'approval',status:'pending',stageKey:'supervisor',version:'stage-2',recipients:[{ name:'合成前任',openId:'ou_synthetic_old' }] }],excluded:[],conflicts:[],warnings:[],
  };
}
const preview = (): PersonnelHandoverPreview => { const value=content(); return { ...value,fingerprint:handoverFingerprint(value),createdAt:new Date().toISOString() }; };
const request = () => ({ clientMutationId:'synthetic-mutation-0001',actorId:'synthetic-admin',actorName:'合成管理员',preview:preview() });

describe('交接确认指纹', () => {
  it('排序无关的版本引用产生相同指纹，权限、目录和待办任一变化使旧确认失效', () => {
    const original = preview();
    expect(original.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    const reordered=content(); reordered.baseline.accounts.reverse();
    expect(handoverFingerprint(reordered)).toBe(original.fingerprint);
    for (const change of [(v: PreviewContent)=>v.baseline.configurationRevision++, (v: PreviewContent)=>v.baseline.directoryVersion='b'.repeat(64), (v: PreviewContent)=>{ v.pending[0].version='stage-3'; v.baseline.pending[0].version='stage-3'; }, (v: PreviewContent)=>{ v.permissions[0].after.pagePaths=[]; }]) {
      const updated=content(); change(updated);
      expect(()=>assertHandoverBaseline(original,updated)).toThrow('交接清单已变化');
    }
  });
  it('稳定身份不一致、重复待办、离职接任人和缺少基线引用拒绝确认', () => {
    for (const change of [(v:PreviewContent)=>v.requested.toPersonId='other', (v:PreviewContent)=>v.pending.push(v.pending[0]), (v:PreviewContent)=>v.to.active=false, (v:PreviewContent)=>{ v.baseline.pending=[]; }]) {
      const invalid=content(); change(invalid); expect(()=>handoverFingerprint(invalid)).toThrow();
    }
  });
  it('离职前归档保留原权限版本，当前禁用账号版本独立校验', () => {
    const value=content(), source=value.permissions[0].source;
    value.baseline.accounts.find(item=>item.id === 'synthetic-old')!.version=5;
    const ref={ accountId:'synthetic-old',configurationRevision:6,sourceVersion:source.sourceVersion,templateHash:permissionTemplateFingerprint(source) };
    value.baseline.archives=[ref]; value.permissions[0].sourceArchive=ref;
    const archived={ ...structuredClone(value),fingerprint:handoverFingerprint(value),createdAt:new Date().toISOString() };
    expect(archived.permissions[0].source.sourceVersion).toBe(3);
    expect(()=>assertHandoverBaseline(archived,value)).not.toThrow();
    value.baseline.accounts.find(item=>item.id === 'synthetic-old')!.version=6;
    expect(()=>assertHandoverBaseline(archived,value)).toThrow('交接清单已变化');
  });
  it('归档引用、模板内容或版本不一致时拒绝，不用当前账号版本伪装旧授权', () => {
    for (const mutate of [
      (v:PreviewContent)=>{ v.permissions[0].sourceArchive!.templateHash='b'.repeat(64); },
      (v:PreviewContent)=>{ v.permissions[0].source.pagePaths=[]; },
      (v:PreviewContent)=>{ v.baseline.archives=[]; },
      (v:PreviewContent)=>{ v.permissions[0].sourceArchive!.configurationRevision=9; },
      (v:PreviewContent)=>{ v.permissions[0].source.sourceVersion=5; },
    ]) {
      const value=content(), source=value.permissions[0].source;
      value.baseline.accounts.find(item=>item.id === 'synthetic-old')!.version=5;
      const ref={ accountId:'synthetic-old',configurationRevision:6,sourceVersion:3,templateHash:permissionTemplateFingerprint(source) };
      value.baseline.archives=[{ ...ref }]; value.permissions[0].sourceArchive={ ...ref };
      mutate(value); expect(()=>handoverFingerprint(value)).toThrow();
    }
  });
});

describe('交接持久批次', () => {
  let directory:string, file:string, owner:string, temporaryRoot:string;
  beforeEach(()=>{
    temporaryRoot=realpathSync(tmpdir()); owner=randomUUID();
    directory=mkdtempSync(join(temporaryRoot,'nt-handover-state-')); file=join(directory,'handover.json');
    writeFileSync(join(directory,'.test-owner'),owner,{flag:'wx'});
  });
  afterEach(()=>{
    const canonical=(value:string)=>resolve(value).toLowerCase();
    if (!isAbsolute(directory) || canonical(dirname(directory)) !== canonical(temporaryRoot) || !/^nt-handover-state-[A-Za-z0-9]+$/u.test(basename(directory)) ||
      !existsSync(directory) || lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory() || canonical(realpathSync(directory)) !== canonical(directory)) {
      throw new Error('测试临时目录归属异常，已保留供诊断');
    }
    for (const name of readdirSync(directory)) {
      const item=lstatSync(join(directory,name));
      if (!item.isFile() || item.isSymbolicLink()) throw new Error('测试临时目录包含异常条目，已保留供诊断');
    }
    if (readFileSync(join(directory,'.test-owner'),'utf8') !== owner) throw new Error('测试临时目录所有权不匹配，已保留供诊断');
    rmSync(directory,{recursive:true,force:false});
  });
  it('只读不落文件，受理落正式批次后可由新实例恢复，返回值不会改写台账', async () => {
    const store=new PersonnelHandoverStore(file); expect(store.read().revision).toBe(0); expect(existsSync(file)).toBe(false);
    const accepted=await store.accept(0,request());
    expect(accepted).toMatchObject({ version:1,status:'accepted',permissionStatus:'pending' }); expect(accepted.items).toHaveLength(1);
    accepted.preview.to.name='不能污染';
    expect(new PersonnelHandoverStore(file).read().batches[accepted.id].preview.to.name).toBe('合成人员-new');
    expect(existsSync(file+'.lock')).toBe(false);
  });
  it('重复确认恢复原批次，不同内容或管理员复用同一幂等键拒绝', async () => {
    const store=new PersonnelHandoverStore(file), first=request(); const accepted=await store.accept(0,first);
    expect((await new PersonnelHandoverStore(file).accept(0,first)).id).toBe(accepted.id); expect(store.read().revision).toBe(1);
    await expect(store.accept(1,{ ...first,actorId:'other-admin' })).rejects.toThrow('重复交接请求内容不一致');
    const changed=request(); changed.preview.baseline.configurationRevision++; changed.preview.fingerprint=handoverFingerprint(changed.preview);
    await expect(store.accept(1,changed)).rejects.toThrow('重复交接请求内容不一致');
  });
  it('两实例基线和单项版本做CAS，已完成项目不得退回待办；恢复保留原回执', async () => {
    const a=new PersonnelHandoverStore(file), b=new PersonnelHandoverStore(file), accepted=await a.accept(0,request());
    await expect(b.accept(0,{ ...request(),clientMutationId:'synthetic-mutation-0002' })).rejects.toThrow('交接台账已更新');
    const receipt={ itemKey:'leave:synthetic',mutationId:handoverItemMutationId(accepted.id,'leave:synthetic'),module:'leave' as const,recordId:'synthetic-record',version:'stage-3',status:'accepted' as const };
    const updated=await a.updateProgress(accepted.id,1,{ items:[{ key:'leave:synthetic',status:'accepted',receipt }] });
    await expect(b.updateProgress(accepted.id,1,{ permissionStatus:'success' })).rejects.toThrow('交接进度已更新');
    const done=await b.updateProgress(accepted.id,updated.version,{ permissionStatus:'success',items:[{ key:'leave:synthetic',status:'success',receipt }] });
    expect(done.status).toBe('success');
    await expect(a.updateProgress(accepted.id,done.version,{ items:[{ key:'leave:synthetic',status:'pending' }] })).rejects.toThrow('已完成项目不能重新办理');
    expect(new PersonnelHandoverStore(file).read().batches[accepted.id].items[0].receipt).toEqual(receipt);
  });
  it('冲突预览和伪造指纹不受理，未知字段不进入持久资料', async () => {
    const store=new PersonnelHandoverStore(file), invalid=request(); invalid.preview.conflicts=['合成冲突']; invalid.preview.fingerprint=handoverFingerprint(invalid.preview);
    await expect(store.accept(0,invalid)).rejects.toThrow('交接清单存在冲突');
    const forged=request(); forged.preview.fingerprint='0'.repeat(64); await expect(store.accept(0,forged)).rejects.toThrow('交接预览指纹无效');
    const safe=request(); Object.assign(safe.preview.to,{passwordHash:'synthetic-do-not-save'}); await store.accept(0,safe);
    expect(readFileSync(file,'utf8')).not.toContain('synthetic-do-not-save');
  });
  it('损坏台账、丢失已保存台账和活锁失败关闭，不改写原字节', async () => {
    const store=new PersonnelHandoverStore(file); writeFileSync(file,'{broken'); expect(()=>store.read()).toThrow('交接台账无效');
    unlinkSync(file); const fresh=new PersonnelHandoverStore(file); await fresh.accept(0,request()); unlinkSync(file); expect(()=>fresh.read()).toThrow('交接台账无效');
    const other=new PersonnelHandoverStore(join(directory,'other.json')); writeFileSync(other.filePath+'.lock','{malformed');
    await expect(other.accept(0,request())).rejects.toThrow('交接正在保存'); expect(readFileSync(other.filePath+'.lock','utf8')).toBe('{malformed');
  });
});
