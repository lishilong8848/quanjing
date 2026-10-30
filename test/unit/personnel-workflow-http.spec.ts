import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { json } from 'express';
import { mkdtempSync, readFileSync, writeFileSync, realpathSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { PersonnelAccountController } from '../../server/common/access/personnel-account.controller';
import { AccessConfigurationController } from '../../server/common/access/access-configuration.controller';
import { AccessConfigurationService } from '../../server/common/access/access-configuration.service';
import { AccessConfigurationDirectory } from '../../server/common/access/access-configuration.directory';
import { AccessConfigurationCardDirectory } from '../../server/common/access/access-configuration.card-directory';
import { PersonnelCredentialsService } from '../../server/common/access/personnel-credentials.service';
import { PersonnelPermissionRequestsService } from '../../server/common/access/personnel-permission-requests.service';
import { PersonnelPermissionRequestsStore } from '../../server/common/access/personnel-permission-requests.store';
import { PersonnelArchiveCorrectionsService } from '../../server/common/access/personnel-archive-corrections.service';
import { PersonnelArchiveCorrectionsStore } from '../../server/common/access/personnel-archive-corrections.store';
import { UnifiedAccessService } from '../../server/common/access/unified-access.service';
import { UnifiedAccessGuard } from '../../server/common/access/unified-access.guard';
import { AccessLoginRedactionMiddleware } from '../../server/common/access/access-login-redaction.middleware';

describe('personal workflows actual HTTP controllers/guards/redaction/services with isolated ledgers',()=>{
  let app:INestApplication,url:string,dir:string,owner:string,previousUrl:string|undefined;
  let accounts:any[],config:any,permissions:PersonnelPermissionRequestsStore,corrections:PersonnelArchiveCorrectionsStore,observed:{path:string;visible:string;hidden:string[]}[];
  const personId='local-external-'+'a'.repeat(64),otherId='local-external-'+'b'.repeat(64);
  const base='/api/access/personal',adminBase='/api/access/configuration';
  const requestPermission=()=>({clientMutationId:randomUUID(),reason:'仅合成理由，不可进入正文追踪',permissions:[{kind:'action',module:'inventory',action:'create',buildings:['A楼'],specialties:['电气']}]});
  const requestCorrection=()=>({clientMutationId:randomUUID(),fields:['phone'],description:'仅合成纠错，联系方式请管理员核对'});
  const review=(id:string,decision='reject')=>({requestId:id,expectedRequestVersion:1,clientMutationId:randomUUID(),decision,comment:'仅合成处理说明'});
  const own=(id:string,version=1)=>({requestId:id,expectedRequestVersion:version,clientMutationId:randomUUID()});
  async function req(path:string,token='owner',body?:unknown,origin?:string){
    const response=await fetch(url+path,{method:body===undefined?'GET':'POST',headers:{...(token?{cookie:`vnet_access_session=${token}`} : {}),...(body===undefined?{}:{'content-type':'application/json',origin:origin??url})},...(body===undefined?{}:{body:JSON.stringify(body)})});
    return {status:response.status,body:await response.json()};
  }
  beforeEach(async()=>{
    dir=mkdtempSync(join(realpathSync(tmpdir()),'nt-personal-http-'));owner=randomUUID();writeFileSync(join(dir,'.owner'),owner);previousUrl=process.env.PUBLIC_BASE_URL;
    const effective=()=>({mode:'independent',baseline:{nativeRole:null,pages:[],rules:[]},overrides:{rules:[],allowPages:[],denyPages:[]}});
    accounts=[{id:personId,kind:'local',name:'HTTP合成本人',role:'guest',version:1,enabled:true,deleted:false,loginMethod:'personnel-password',personnelActive:true,personnelAppId:'cliHttp',effectiveAuthorization:effective()},
      {id:otherId,kind:'local',name:'HTTP合成他人',role:'guest',version:1,enabled:true,deleted:false,loginMethod:'personnel-password',personnelActive:true,personnelAppId:'cliHttp',effectiveAuthorization:effective()},
      {id:'local-admin-all',kind:'local',name:'HTTP合成管理员',role:'admin',version:1,enabled:true,deleted:false},
      {id:'feishu-linked-admin',kind:'feishu',name:'HTTP关联管理员',role:'admin',version:1,enabled:true,deleted:false,personnelIdentity:personId,personnelAppId:'cliHttp'}];
    const principal=(id:string)=>{const row=accounts.find(row=>row.id===id);return row?{accountId:id,displayName:row.name,role:row.role,authorizationVersion:row.version,purchaseBuilding:null,effectiveAuthorization:row.effectiveAuthorization}:undefined;};
    config={snapshot:()=>({revision:3,appId:'cliHttp',accounts:structuredClone(accounts)}),currentPrincipal:(id:string,version:number)=>{const row=accounts.find(row=>row.id===id);return row && row.version===version && row.enabled && !row.deleted ? principal(id):undefined;},pagePermissions:()=>({revision:3,paths:[],configured:true})};
    const session=(token?:string)=>{const id=token==='owner'||token==='impersonated'||token==='initial'?personId:token==='other'?otherId:token==='admin'?'local-admin-all':token==='linked-admin'?'feishu-linked-admin':'';
      const p=principal(id);return p?{principal:{...p,...(token==='impersonated'?{impersonation:{actorAccountId:'local-admin-all',actorName:'合成管理员',targetName:'合成本人',expiresAt:Date.now()+10000}}:{}),...(token==='initial'?{requiresPasswordChange:true}:{})},expiresAt:Date.now()+10000,principalFingerprint:'synthetic-'+token}:{principal:{role:'guest',purchaseBuilding:null},expiresAt:null,principalFingerprint:null};};
    const access:any={cookieName:'vnet_access_session',isAccessControlEnabled:()=>true,readSessionIdentity:session,readSession:session,renew:(token:string)=>{const result=session(token);return result.expiresAt?result:null;}};
    permissions=new PersonnelPermissionRequestsStore(join(dir,'permission.json'));corrections=new PersonnelArchiveCorrectionsStore(join(dir,'correction.json'));
    const permissionService=new PersonnelPermissionRequestsService(config,permissions),correctionService=new PersonnelArchiveCorrectionsService(config,corrections);
    const module=await Test.createTestingModule({controllers:[PersonnelAccountController,AccessConfigurationController],providers:[
      {provide:UnifiedAccessService,useValue:access},{provide:AccessConfigurationService,useValue:config},
      {provide:AccessConfigurationDirectory,useValue:{}},{provide:AccessConfigurationCardDirectory,useValue:{}},
      {provide:PersonnelCredentialsService,useValue:{profile:async()=>({canChangePassword:false,requiresPasswordChange:false})}},
      {provide:PersonnelPermissionRequestsService,useValue:permissionService},{provide:PersonnelArchiveCorrectionsService,useValue:correctionService},
    ]}).compile();
    app=module.createNestApplication({logger:false});observed=[];const redaction=new AccessLoginRedactionMiddleware();
    app.use(json());app.use((request:any,response:any,next:any)=>{if(request.method==='POST')redaction.use(request,response,()=>{observed.push({path:request.path,visible:JSON.stringify(request.body),hidden:Object.getOwnPropertyNames(request.body).filter(key=>!Object.keys(request.body).includes(key))});next();});else next();});
    app.useGlobalGuards(new UnifiedAccessGuard(new Reflector(),access));await app.listen(0,'127.0.0.1');url=await app.getUrl();process.env.PUBLIC_BASE_URL=url;
  });
  afterEach(async()=>{await app?.close();if(previousUrl===undefined)delete process.env.PUBLIC_BASE_URL;else process.env.PUBLIC_BASE_URL=previousUrl;if(resolve(dirname(dir)).toLowerCase()!==resolve(realpathSync(tmpdir())).toLowerCase()||readFileSync(join(dir,'.owner'),'utf8')!==owner)throw Error('synthetic owner mismatch');rmSync(dir,{recursive:true});});
  it('requires a real admin role for all management reads and denies anonymous personal reads',async()=>{
    for(const path of ['/permission-requests','/permission-requests/summary','/archive-corrections','/archive-corrections/summary']){
      expect((await req(adminBase+path,'owner')).status).toBe(403);expect((await req(adminBase+path,'admin')).status).toBe(200);
      expect((await req(base+path,'')).status).toBe(401);
    }
  });
  it('passes hidden reasons to actual services, updates once and cancels without duplicate audits',async()=>{
    const created=await req(base+'/permission-requests','owner',requestPermission());expect(created.status).toBe(201);const row=created.body;
    const edit={...own(row.id),reason:'合成补充说明，应该保持非枚举'};
    const updated=await req(base+'/permission-requests/update','owner',edit);expect(updated.body).toMatchObject({version:2,reason:edit.reason});
    expect((await req(base+'/permission-requests/update','owner',edit)).body).toEqual(updated.body);
    expect((await req(base+'/permission-requests/cancel','other',own(row.id,2))).status).toBe(403);
    const cancel=own(row.id,2);expect((await req(base+'/permission-requests/cancel','owner',cancel)).body.status).toBe('cancelled');
    expect((await req(base+'/permission-requests/cancel','owner',cancel)).body.status).toBe('cancelled');expect(permissions.read().audit).toHaveLength(3);
    expect(observed.filter(item=>item.path.endsWith('/update')).every(item=>item.hidden.includes('reason')&&!item.visible.includes(edit.reason))).toBe(true);
    expect((await req(base+'/permission-requests/summary')).body).toMatchObject({pending:0,cancelled:1});
  });
  it('requires actual grants before approving and reports later revocation without restoring permissions',async()=>{
    const row=(await req(base+'/permission-requests','owner',requestPermission())).body,body=review(row.id,'approve');
    expect((await req(adminBase+'/permission-requests','admin',body)).status).toBe(409);
    accounts[0].effectiveAuthorization.overrides.rules=[{id:'synthetic-allow',module:'inventory',actions:['create'],effect:'allow',buildings:['A楼'],specialties:['电气']}];
    const approved=await req(adminBase+'/permission-requests','admin',body);expect(approved.body).toMatchObject({status:'approved',currentEffect:'current'});
    accounts[0].effectiveAuthorization.overrides.rules=[];
    expect((await req(base+'/permission-requests')).body[0]).toMatchObject({status:'approved',currentEffect:'none'});expect(accounts[0].effectiveAuthorization.overrides.rules).toEqual([]);
  });
  it('records correction handling with hidden descriptions/comments and no write to any personnel source',async()=>{
    const before=JSON.stringify(accounts),input=requestCorrection();
    expect((await req(base+'/archive-corrections','owner',input,'https://foreign.invalid')).status).toBe(403);
    const row=(await req(base+'/archive-corrections','owner',input)).body;expect(row).not.toHaveProperty('applicantIdentity');
    expect((await req(adminBase+'/archive-corrections','admin',review(row.id,'resolve'),'https://foreign.invalid')).status).toBe(403);
    const body=review(row.id,'resolve'),handled=await req(adminBase+'/archive-corrections','admin',body);expect(handled.body).toMatchObject({status:'resolved',comment:body.comment});
    expect((await req(adminBase+'/archive-corrections','admin',body)).body).toEqual(handled.body);expect(corrections.read().audit).toHaveLength(2);expect(JSON.stringify(accounts)).toBe(before);
    expect(observed.some(item=>item.hidden.includes('description')&&!item.visible.includes(input.description))).toBe(true);
    expect(observed.some(item=>item.hidden.includes('comment')&&!item.visible.includes(body.comment))).toBe(true);
    expect((await req(adminBase+'/archive-corrections/summary','admin')).body).toMatchObject({total:1,pending:0,resolved:1});
  });
  it('rejects impersonation, initial-password work and linked self-review through real HTTP boundaries',async()=>{
    expect((await req(base+'/permission-requests','initial',requestPermission())).status).toBe(403);
    expect((await req(base+'/archive-corrections','impersonated',requestCorrection())).status).toBe(403);
    expect((await req(adminBase+'/archive-corrections','impersonated')).status).toBe(403);
    const row=(await req(base+'/archive-corrections','owner',requestCorrection())).body;
    expect((await req(adminBase+'/archive-corrections','linked-admin',review(row.id,'resolve'))).status).toBe(403);
    const permission=(await req(base+'/permission-requests','owner',requestPermission())).body;
    expect((await req(adminBase+'/permission-requests','linked-admin',review(permission.id))).status).toBe(403);
  });
  it('keeps one version winner when update and withdrawal arrive concurrently',async()=>{
    const row=(await req(base+'/permission-requests','owner',requestPermission())).body;
    const results=await Promise.all([req(base+'/permission-requests/update','owner',{...own(row.id),reason:'合成并发补充'}),req(base+'/permission-requests/cancel','owner',own(row.id))]);
    expect(results.map(result=>result.status).sort()).toEqual([201,409]);expect(permissions.read().audit).toHaveLength(2);
  });
  it('rejects caller identity injection and complete ID content without creating feedback',async()=>{
    expect((await req(base+'/archive-corrections','owner',{...requestCorrection(),accountId:otherId})).status).toBe(400);
    expect((await req(base+'/archive-corrections','owner',{...requestCorrection(),description:'11010519491231002X'})).status).toBe(400);
    expect(corrections.read().requests).toEqual({});
  });
});
