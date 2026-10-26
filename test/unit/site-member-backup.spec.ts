import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Reflector } from '@nestjs/core';
import { AccessConfigurationService } from '../../server/common/access/access-configuration.service';
import { UnifiedAccessService, hashAccessPassword } from '../../server/common/access/unified-access.service';
import { UnifiedAccessGuard } from '../../server/common/access/unified-access.guard';
import { GuestReadable, GuestSubmittable } from '../../server/common/access/unified-access.decorators';
import { validAccount } from '../../server/common/access/access-configuration.validation';
import { effectivePagePaths } from '../../shared/page-access';

const id='local-site_member-all';
class Probe { read(){} submit(){} }
GuestReadable()(Probe.prototype,'read',Object.getOwnPropertyDescriptor(Probe.prototype,'read')!);
GuestSubmittable()(Probe.prototype,'submit',Object.getOwnPropertyDescriptor(Probe.prototype,'submit')!);
describe('基地备用账号',()=>{
  const saved={...process.env};let root:string;
  beforeEach(()=>{
    root=mkdtempSync(join(tmpdir(),'nt-member-backup-'));process.env.ACCESS_CONFIGURATION_FILE=join(root,'accounts.json');
    process.env.LOCAL_ACCESS_SESSION_SECRET=randomBytes(32).toString('base64');process.env.LOCAL_ACCESS_CONTROL_ENABLED='true';
    process.env.LOCAL_ADMIN_PASSWORD_HASH=hashAccessPassword('synthetic-admin-password');
    process.env.LOCAL_SITE_MEMBER_PASSWORD_HASH=hashAccessPassword('synthetic-backup-password');
    delete process.env.FEISHU_APP_ID;
  });
  afterEach(()=>{process.env={...saved};rmSync(root,{recursive:true,force:true});});
  function services(){const configuration=new AccessConfigurationService();return {configuration,access:new UnifiedAccessService(configuration)};}
  it('未设密码默认停用，设置后从现有备用入口获得基地成员身份并可续期',async()=>{
    delete process.env.LOCAL_SITE_MEMBER_PASSWORD_HASH;
    expect(services().configuration.snapshot().accounts.find(row=>row.id===id)).toMatchObject({enabled:false,passwordConfigured:false});
    process.env.LOCAL_SITE_MEMBER_PASSWORD_HASH=hashAccessPassword('synthetic-backup-password');
    const {configuration,access}=services();const result=await access.login({password:'synthetic-backup-password'},'fixture');
    expect(result.principal).toMatchObject({role:'site_member',displayName:'基地备用',accountId:id,purchaseBuilding:null});
    expect(result.principal).not.toHaveProperty('personalRules');
    expect(access.readSession(result.token).principal).toEqual(result.principal);expect(access.renew(result.token)?.principal).toEqual(result.principal);
    expect(configuration.pagePermissions('site_member',id,result.principal.authorizationVersion).paths).toEqual(effectivePagePaths('site_member'));
    expect(JSON.stringify(configuration.snapshot())).not.toContain('scrypt$');
    await expect(access.login({password:'synthetic-wrong-password'},'wrong')).rejects.toThrow();
  });
  it('改密并重启后旧会话失效，不能靠旧版本继续续期',async()=>{
    const first=services(),old=await first.access.login({password:'synthetic-backup-password'},'fixture');
    process.env.LOCAL_SITE_MEMBER_PASSWORD_HASH=hashAccessPassword('synthetic-rotated-password');const next=services();
    expect(next.access.readSession(old.token).expiresAt).toBeNull();expect(next.access.renew(old.token)).toBeNull();
    expect((await next.access.login({password:'synthetic-rotated-password'},'fixture')).principal.role).toBe('site_member');
  });
  it('可读取排班中心和今日航图，拒绝强刷、配置、个人申请及管理写入',async()=>{
    const {access}=services(),session=await access.login({password:'synthetic-backup-password'},'fixture'),guard=new UnifiedAccessGuard(new Reflector(),access);
    async function allowed(path:string,method='GET',query:Record<string,unknown>={}){
      const request={headers:{cookie:`${access.cookieName}=${session.token}`},method,path,url:path,originalUrl:path,query};
      const response={cookie:jest.fn(),clearCookie:jest.fn(),setHeader:jest.fn()};
      return guard.canActivate({getHandler:()=>method==='GET'?Probe.prototype.read:Probe.prototype.submit,getClass:()=>Probe,switchToHttp:()=>({getRequest:()=>request,getResponse:()=>response})} as never);
    }
    expect(await allowed('/api/duty-schedules')).toBe(true);
    expect(await allowed('/api/bitable/today-operations-overview')).toBe(true);
    expect(await allowed('/api/contract-management')).toBe(false);
    expect(await allowed('/api/access/configuration')).toBe(false);
    for(const key of ['refresh','forceRefresh','force','recheck'])expect(await allowed('/api/duty-schedules','GET',{[key]:'true'})).toBe(false);
    expect(await allowed('/api/duty-schedules?force=1')).toBe(false);
    for(const url of ['/api/duty-schedules/leave-request','/api/duty-schedules/overtime-request','/api/duty-schedules/staff-adjustment'])expect(await allowed(url,'POST')).toBe(false);
  });
  it('不能伪装人员关联或额外授权，管理员可以停用且已有会话即时失效',async()=>{
    const {configuration,access}=services(),session=await access.login({password:'synthetic-backup-password'},'fixture');
    const account=configuration.snapshot().accounts.find(row=>row.id===id)!;expect(validAccount(account)).toBe(true);
    expect(validAccount({...account,role:'admin'})).toBe(false);
    expect(validAccount({...account,personnelIdentity:`local-external-${'a'.repeat(64)}`})).toBe(false);
    expect(validAccount({...account,pagePaths:['/system-configuration']})).toBe(false);
    const actor=configuration.localTargets().find(row=>row.principal.role==='admin')!.principal;
    await configuration.saveAccount({clientMutationId:'synthetic-backup-disable',expectedRevision:configuration.snapshot().revision,id,kind:'local',name:'基地备用',role:'site_member',building:null,enabled:false},actor);
    expect(access.readSession(session.token).expiresAt).toBeNull();
  });
});
