import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { mkdtempSync, readFileSync, readdirSync, lstatSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { UnifiedAccessModule } from '../../server/common/access/unified-access.module';
import { UnifiedAccessService, hashAccessPassword } from '../../server/common/access/unified-access.service';
import { AccessConfigurationDirectory } from '../../server/common/access/access-configuration.directory';
import { AccessConfigurationService } from '../../server/common/access/access-configuration.service';
import { PERSONNEL_PREVIEW_READERS } from '../../server/common/access/personnel-preview.ports';
import type { PersonnelAuthoritySnapshot, AuthorityPerson } from '../../shared/personnel-authority.interface';

describe('Stage2 real administrator preview HTTP',()=>{
  const saved={...process.env};
  let app:INestApplication,folder:string,owner:string,url:string,cookie:string,configuration:AccessConfigurationService;
  const appId='cli_preview_http_fixture';
  const from:AuthorityPerson={id:'local-external-'+ 'a'.repeat(64),recordId:'recOld',name:'合成前任',openId:'ou_preview_old',active:false,type:'employee',position:'C楼主管',systemPosition:'',buildings:['C楼'],specialties:[],permissionTags:[],dutyRecordIds:['recDuty']};
  const to:AuthorityPerson={...from,id:'local-external-'+ 'b'.repeat(64),recordId:'recNew',name:'合成接任者',openId:'ou_preview_new',active:true,dutyRecordIds:[]};
  const authority:PersonnelAuthoritySnapshot={mode:'shadow',version:'e'.repeat(64),snapshotAt:Date.now(),source:{appId,appToken:'fixture',tableId:'tblPeople'},people:[from,to],duties:[{recordId:'recDuty',name:'C楼请休假',kind:'leave_supervisor',personnelIds:[to.id],buildings:['C楼'],specialties:null,enabled:true,startsAt:0,endsAt:null,parentDutyIds:[],version:1}],problems:[],issues:[]};
  beforeEach(async()=>{
    folder=mkdtempSync(join(tmpdir(),'personnel-preview-http-'));owner=randomUUID();writeFileSync(join(folder,'.owner'),owner);
    process.env.ACCESS_CONFIGURATION_FILE=join(folder,'configuration.json');
    process.env.LOCAL_ACCESS_SESSION_SECRET=randomBytes(32).toString('base64');
    process.env.LOCAL_ADMIN_PASSWORD_HASH=hashAccessPassword('synthetic-preview-admin-only');
    process.env.FEISHU_APP_ID=appId;process.env.FEISHU_APP_SECRET='';process.env.FEISHU_ACCESS_APPROVED_GRANTS_ENABLED='false';
    const people=[{openId:from.openId!,name:from.name},{openId:to.openId!,name:to.name}];
    const module=await Test.createTestingModule({imports:[UnifiedAccessModule],providers:Object.entries(PERSONNEL_PREVIEW_READERS).map(([module,provide])=>({provide,useValue:{module,listPending:async()=>[],acceptTransfer:()=>{throw new Error('Mutation forbidden');}}}))})
      .overrideProvider(AccessConfigurationDirectory).useValue({read:async()=>({appId,people,personnelAuthority:authority}),assertKnown:async()=>{}}).compile();
    app=module.createNestApplication({logger:false});await app.listen(0,'127.0.0.1');url=await app.getUrl();process.env.PUBLIC_BASE_URL=url;
    configuration=app.get(AccessConfigurationService);const access=app.get(UnifiedAccessService);
    const principal=configuration.localTargets().find(item=>item.principal.role==='admin')!.principal;
    cookie=`${access.cookieName}=${access.issueTrustedSession(principal).token}`;
    const source=await configuration.saveAccount({clientMutationId:'preview-fixture-source',expectedRevision:configuration.snapshot().revision,kind:'feishu',openId:from.openId!,name:from.name,role:'building_admin',building:'C楼',enabled:true},principal);
    const old=source.accounts.find(account=>account.name===from.name)!;
    await configuration.saveAccount({clientMutationId:'preview-fixture-disabled',expectedRevision:configuration.snapshot().revision,id:old.id,kind:'feishu',name:old.name,role:old.role,building:old.building,enabled:false},principal);
    await configuration.saveAccount({clientMutationId:'preview-fixture-target',expectedRevision:configuration.snapshot().revision,kind:'feishu',openId:to.openId!,name:to.name,role:'guest',building:null,enabled:true},principal);
  });
  afterEach(async()=>{
    await app?.close();process.env={...saved};
    if(!resolve(folder).startsWith(resolve(tmpdir())+sep) || readFileSync(join(folder,'.owner'),'utf8')!==owner || readdirSync(folder).some(name=>lstatSync(join(folder,name)).isSymbolicLink()))throw new Error('Unsafe fixture cleanup');
    rmSync(folder,{recursive:true,force:true});
  });
  const request=()=>({fromPersonId:from.id,toPersonId:to.id,dutyRecordIds:['recDuty'],expectedDirectoryVersion:authority.version,expectedConfigurationRevision:configuration.snapshot().revision});
  const post=(body:unknown,headers:Record<string,string>={cookie,origin:url})=>fetch(url+'/api/access/configuration/personnel-preview',{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify(body)});
  it('匿名、游客、子管理员和跨站请求都不能预览',async()=>{
    expect([401,403]).toContain((await post(request(),{})).status);
    const access=app.get(UnifiedAccessService);
    const principals=[configuration.feishuPrincipal(to.openId!,appId)!,{role:'editor' as const,purchaseBuilding:null}];
    for(const principal of principals){const token=access.issueTrustedSession(principal).token;expect([401,403]).toContain((await post(request(),{cookie:`${access.cookieName}=${token}`,origin:url})).status);}
    expect((await post(request(),{cookie,origin:'https://foreign.invalid'})).status).toBe(403);
  });
  it('真实服务生成存档继承预览，权限文件和审计原字节保持',async()=>{
    const file=join(folder,'configuration.json'),before=readFileSync(file,'utf8'),revision=configuration.snapshot().revision;
    const people=await fetch(url+'/api/access/configuration/people',{headers:{cookie}});expect(people.status).toBe(200);
    const overview=await people.json();expect(overview.personnelOverview.people.map((row:{person:AuthorityPerson})=>row.person.name)).toEqual([from.name,to.name]);
    const response=await post(request());expect(response.status).toBe(201);expect(response.headers.get('cache-control')).toContain('no-store');
    const value=await response.json();expect(value.readOnly).toBe(true);expect(value.permissions[0].sourceArchiveAt).toBeTruthy();expect(value.permissions[0].after.role).toBe('building_admin');
    expect(configuration.snapshot().revision).toBe(revision);expect(readFileSync(file,'utf8')).toBe(before);expect(JSON.stringify(value)).not.toMatch(/scrypt\$|passwordHash|SESSION_SECRET/);
  });
  it('旧版本拒绝且没有确认、执行、转办路由',async()=>{
    expect((await post({...request(),expectedConfigurationRevision:0})).status).toBe(409);
    for(const suffix of ['personnel-confirm','personnel-handover/confirm','personnel-handover/process'])expect((await fetch(url+'/api/access/configuration/'+suffix,{method:'POST',headers:{cookie,origin:url,'content-type':'application/json'},body:'{}'})).status).toBe(404);
  });
});
