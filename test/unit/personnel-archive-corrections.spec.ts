import { mkdtempSync, readFileSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PersonnelArchiveCorrectionsService } from '../../server/common/access/personnel-archive-corrections.service';
import { PersonnelArchiveCorrectionsStore, getPersonnelArchiveCorrectionsStore } from '../../server/common/access/personnel-archive-corrections.store';
import { PersonnelAccountController } from '../../server/common/access/personnel-account.controller';
import { createProcessLockOwner } from '../../server/common/process-lock-owner';
import type { AccessPrincipal } from '../../shared/access-control.interface';

describe('independent personal archive feedback lifecycle', () => {
  let dir: string, owner: string, store: PersonnelArchiveCorrectionsStore, service: PersonnelArchiveCorrectionsService, config: any;
  let accounts: any[], person: AccessPrincipal, other: AccessPrincipal, admin: AccessPrincipal;
  const create = () => ({clientMutationId:randomUUID(),fields:['phone','education'] as const as any,description:'手机号已更新，请核对已提交的资料'});
  const review = (id:string,overrides = {}) => ({requestId:id,expectedRequestVersion:1,clientMutationId:randomUUID(),decision:'resolve' as const,comment:'已通过现有资料维护渠道核对，来源将在下次同步后展示',...overrides});
  beforeEach(() => {
    dir=mkdtempSync(join(realpathSync(tmpdir()),'nt-correction-test-'));owner=randomUUID();writeFileSync(join(dir,'.owner'),owner);
    accounts=[{id:'local-external-'+'a'.repeat(64),kind:'local',name:'合成人员',version:2,role:'guest',enabled:true,deleted:false,personnelActive:true,loginMethod:'personnel-password',personnelAppId:'cliSynthetic'},
      {id:'local-external-'+'b'.repeat(64),kind:'local',name:'合成其他人员',version:2,role:'guest',enabled:true,deleted:false,personnelActive:true,loginMethod:'personnel-password',personnelAppId:'cliSynthetic'},
      {id:'local-admin-all',kind:'local',name:'合成管理员',version:2,role:'admin',enabled:true,deleted:false}];
    const principal=(id:string)=>{const row=accounts.find(row=>row.id===id);return {accountId:id,role:row.role,displayName:row.name,purchaseBuilding:null,authorizationVersion:row.version};};
    person=principal(accounts[0].id);other=principal(accounts[1].id);admin=principal(accounts[2].id);
    config={currentPrincipal:jest.fn((id,version)=>{const row=accounts.find(row=>row.id===id);return row && row.version===version && row.enabled && !row.deleted ? principal(id) : undefined;}),snapshot:jest.fn(()=>({appId:'cliSynthetic',accounts:structuredClone(accounts),revision:3}))};
    store=new PersonnelArchiveCorrectionsStore(join(dir,'corrections.json'));service=new PersonnelArchiveCorrectionsService(config,store);
  });
  afterEach(()=>{jest.restoreAllMocks();if(resolve(dirname(dir)).toLowerCase()!==resolve(realpathSync(tmpdir())).toLowerCase() || readFileSync(join(dir,'.owner'),'utf8')!==owner)throw new Error('test owner mismatch');rmSync(dir,{recursive:true});});
  it('creates only own feedback, hides stable identity and exposes counts without changing accounts',async()=>{
    const before=JSON.stringify(accounts),row=await service.create(person,create());
    expect(row).toMatchObject({status:'pending',version:1,applicantName:'合成人员'});expect(row).not.toHaveProperty('applicantIdentity');
    expect(service.listOwn(person)).toEqual([row]);expect(service.listOwn(other)).toEqual([]);expect(service.listAdmin(admin)).toEqual([row]);
    expect(service.summaryOwn(person)).toMatchObject({total:1,pending:1,resolved:0,capacity:{level:'normal',requests:1}});
    expect(service.summaryOwn(other).total).toBe(0);expect(service.summaryAdmin(admin).pending).toBe(1);expect(JSON.stringify(accounts)).toBe(before);
  });
  it('deduplicates exact replay and duplicate open feedback without adding an audit',async()=>{
    const body=create(),row=await service.create(person,body);
    expect(await service.create(person,body)).toEqual(row);
    expect((await service.create(person,{...body,clientMutationId:randomUUID()})).id).toBe(row.id);
    await expect(service.create(person,{...body,description:'different'})).rejects.toThrow('重复提交内容不一致');
    expect(store.read().audit).toHaveLength(1);
    expect(new PersonnelArchiveCorrectionsService(config,new PersonnelArchiveCorrectionsStore(store.filePath)).listOwn(person)).toEqual([row]);
  });
  it('withdraws only the owner pending feedback and preserves idempotent retry',async()=>{
    const row=await service.create(person,create()),body={requestId:row.id,expectedRequestVersion:1,clientMutationId:randomUUID()};
    await expect(service.cancel(other,body)).rejects.toThrow('本人的');
    const cancelled=await service.cancel(person,body);expect(cancelled).toMatchObject({status:'cancelled',version:2});
    expect(await service.cancel(person,body)).toEqual(cancelled);expect(store.read().audit).toHaveLength(2);
    await expect(service.review(admin,review(row.id))).rejects.toThrow('已变化或已处理');
  });
  it('requires administrator comments and records handling without a source write capability',async()=>{
    const row=await service.create(person,create()),before=JSON.stringify(accounts);
    await expect(service.review(other,review(row.id))).rejects.toThrow('仅系统管理员');
    await expect(service.review(admin,review(row.id,{comment:' '}))).rejects.toThrow('1至1000');
    const body=review(row.id),handled=await service.review(admin,body);
    expect(handled).toMatchObject({status:'resolved',version:2,reviewerName:'合成管理员',comment:body.comment});
    expect(await service.review(admin,body)).toEqual(handled);expect(store.read().audit).toHaveLength(2);expect(JSON.stringify(accounts)).toBe(before);
    expect(Object.keys(config).sort()).toEqual(['currentPrincipal','snapshot']);
  });
  it('allows one result when rejection races withdrawal and retains both immutable original and audit',async()=>{
    const row=await service.create(person,create());
    const results=await Promise.allSettled([service.review(admin,review(row.id,{decision:'reject',comment:'请补充信息'})),service.cancel(person,{requestId:row.id,expectedRequestVersion:1,clientMutationId:randomUUID()})]);
    expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(1);expect(store.read().audit).toHaveLength(2);
    expect(store.read().requests[row.id].description).toBe(row.description);
  });
  it('blocks shared/unbound, initial-password, impersonated, stale and departed applicants',async()=>{
    await expect(service.create(admin,create())).rejects.toThrow('未关联');
    await expect(service.create({...person,requiresPasswordChange:true},create())).rejects.toThrow('初始密码');
    await expect(service.create({...person,impersonation:{actorAccountId:admin.accountId!,actorName:'合成',targetName:'合成',expiresAt:Date.now()+1000}},create())).rejects.toThrow('代登录');
    await expect(service.create({...person,authorizationVersion:1},create())).rejects.toThrow('权限已变化');
    accounts[0].personnelActive=false;await expect(service.create(person,create())).rejects.toThrow('不可办理');
    expect(store.read().requests).toEqual({});
  });
  it('prevents a linked administrator from handling their own correction',async()=>{
    const row=await service.create(person,create());accounts[2].personnelIdentity=accounts[0].id;accounts[2].personnelAppId='cliSynthetic';
    await expect(service.review(admin,review(row.id))).rejects.toThrow('本人或关联账号');
  });
  it('accepts middleware-redacted non-enumerable text but rejects hidden selectors and complete IDs',async()=>{
    const body=create();Object.defineProperty(body,'description',{value:body.description,enumerable:false});
    const row=await service.create(person,body);expect(row.description).toBe(body.description);
    const foreign=create();Object.defineProperty(foreign,'accountId',{value:other.accountId,enumerable:false});
    await expect(service.create(person,foreign)).rejects.toThrow('内容无效');
    await expect(service.create(person,{...create(),description:'身份证请改成11010519491231002X'})).rejects.toThrow('完整身份证');
    const bodyReview=review(row.id);Object.defineProperty(bodyReview,'comment',{value:bodyReview.comment,enumerable:false});
    expect((await service.review(admin,bodyReview)).status).toBe('resolved');
  });
  it('bounds pending items and reports capacity without deleting any evidence',async()=>{
    for(let i=0;i<10;i++)await service.create(person,{...create(),description:'合成问题'+i});
    await expect(service.create(person,{...create(),description:'第十一项'})).rejects.toThrow('较多待处理');
    const state=store.read(),sample=Object.values(state.requests)[0];for(let i=0;i<8000;i++){state.requests['synthetic-'+i]={...sample,id:'synthetic-'+i};}
    expect(store.capacity(state).level).toBe('warning');expect(store.read().audit).toHaveLength(10);
  });
  it('fails closed for corruption, unknown format, a live lock and a removed persisted file',async()=>{
    await service.create(person,create());const good=readFileSync(store.filePath,'utf8');
    writeFileSync(store.filePath,'{broken');expect(()=>store.read()).toThrow('台账暂不可用');
    writeFileSync(store.filePath,good.replace('"schemaVersion":1','"schemaVersion":2'));expect(()=>store.read()).toThrow('台账暂不可用');
    writeFileSync(store.filePath,good);writeFileSync(store.filePath+'.lock',JSON.stringify(createProcessLockOwner(randomUUID())));
    await expect(service.create(person,{...create(),description:'other'})).rejects.toThrow('正在保存');expect(readFileSync(store.filePath,'utf8')).toBe(good);
    rmSync(store.filePath+'.lock');rmSync(store.filePath);expect(()=>store.read()).toThrow('台账暂不可用');
  });
  it('rejects a corrupted audit version without replacing any existing ledger bytes',async()=>{
    await service.create(person,create());const bad:any=store.read();bad.audit[0].version='1';const bytes=JSON.stringify(bad);writeFileSync(store.filePath,bytes);
    expect(()=>service.listOwn(person)).toThrow('台账暂不可用');expect(readFileSync(store.filePath,'utf8')).toBe(bytes);
  });
  it('refuses configuring its independent file over authorization or credential ledgers',()=>{
    const oldConfig=process.env.ACCESS_CONFIGURATION_FILE,oldCorrection=process.env.PERSONNEL_ARCHIVE_CORRECTIONS_FILE;
    try{process.env.ACCESS_CONFIGURATION_FILE=join(dir,'configuration.json');process.env.PERSONNEL_ARCHIVE_CORRECTIONS_FILE=process.env.ACCESS_CONFIGURATION_FILE;
      expect(()=>getPersonnelArchiveCorrectionsStore()).toThrow('台账暂不可用');
    }finally{if(oldConfig===undefined)delete process.env.ACCESS_CONFIGURATION_FILE;else process.env.ACCESS_CONFIGURATION_FILE=oldConfig;if(oldCorrection===undefined)delete process.env.PERSONNEL_ARCHIVE_CORRECTIONS_FILE;else process.env.PERSONNEL_ARCHIVE_CORRECTIONS_FILE=oldCorrection;}
  });
  it('uses cookie identity and same-origin checks for all personal write routes',async()=>{
    const old=process.env.PUBLIC_BASE_URL;process.env.PUBLIC_BASE_URL='https://example.test';
    try{const access:any={cookieName:'vnet_access_session',readSessionIdentity:()=>({principal:person,expiresAt:Date.now()+10000,principalFingerprint:'synthetic'})};
      const controller=new PersonnelAccountController(access,config,{} as any,{} as any,undefined,service);
      const request:any={headers:{origin:'https://foreign.test'},protocol:'https',get:()=> 'example.test'};
      expect(()=>controller.createArchiveCorrection(request,create())).toThrow('本站');
      request.headers.origin='https://example.test';const row=await controller.createArchiveCorrection(request,create());
      expect(controller.archiveCorrectionSummary(request).pending).toBe(1);
      expect((await controller.cancelArchiveCorrection(request,{requestId:row.id,expectedRequestVersion:1,clientMutationId:randomUUID()})).status).toBe('cancelled');
    }finally{if(old===undefined)delete process.env.PUBLIC_BASE_URL;else process.env.PUBLIC_BASE_URL=old;}
  });
});
