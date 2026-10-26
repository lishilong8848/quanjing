import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import * as stores from '../../server/common/access/access-configuration.store';
import * as defaults from '../../server/common/access/access-configuration.defaults';
import { AccessConfigurationService } from '../../server/common/access/access-configuration.service';
import { feishuIdentityFingerprint } from '../../server/common/access/feishu-access-approved-grants';
import { capturePersonnelPermission } from '../../server/common/access/personnel-permission-archive';
import { buildPermissionMatrix, matrixAccountSubject } from '../../shared/permission-matrix';
import { Reflector } from '@nestjs/core';
import { UnifiedAccessService } from '../../server/common/access/unified-access.service';
import { UnifiedAccessGuard } from '../../server/common/access/unified-access.guard';
import { UnifiedAccessController } from '../../server/common/access/unified-access.controller';
import { GuestReadableMetadataKey } from '../../server/common/access/unified-access.decorators';
const appId='cli_personal_page_synthetic';
const account=(id:string):stores.StoredAccount=>({ id:`feishu-${feishuIdentityFingerprint(appId,`ou_synthetic_${id}`)}`,kind:'feishu',name:`合成-${id}`,openId:`ou_synthetic_${id}`,appId,identityHash:feishuIdentityFingerprint(appId,`ou_synthetic_${id}`),role:'site_member',building:null,version:2,enabled:true,deleted:false,source:'configuration',siteMember:true });
describe('个人页面增补只授予读取',()=>{
  let directory:string,temporaryRoot:string,owner:string,store:stores.AccessConfigurationStore,service:AccessConfigurationService,originalApp:string|undefined,originalSecret:string|undefined,originalAppSecret:string|undefined;
  const chief=account('chief'),other=account('other'),backup=account('backup');
  beforeEach(async()=>{
    originalApp=process.env.FEISHU_APP_ID; process.env.FEISHU_APP_ID=appId;
    originalAppSecret=process.env.FEISHU_APP_SECRET; process.env.FEISHU_APP_SECRET=randomBytes(32).toString('base64');
    originalSecret=process.env.LOCAL_ACCESS_SESSION_SECRET; process.env.LOCAL_ACCESS_SESSION_SECRET=randomBytes(32).toString('base64');
    temporaryRoot=realpathSync(tmpdir()); owner=randomUUID(); directory=mkdtempSync(join(temporaryRoot,'nt-personal-page-')); writeFileSync(join(directory,'.test-owner'),owner,{flag:'wx'});
    store=new stores.AccessConfigurationStore(join(directory,'configuration.json'));
    jest.spyOn(stores,'getAccessConfigurationStore').mockReturnValue(store); jest.spyOn(defaults,'defaultAccessAccounts').mockReturnValue({});
    await store.mutate(0,'synthetic-page-seed','synthetic-page-seed',state=>{ state.accounts[chief.id]=Object.assign(structuredClone(chief),{pagePaths:['/contract-management']}); state.accounts[other.id]=structuredClone(other); state.accounts[backup.id]={...backup,role:'admin'}; });
    service=new AccessConfigurationService();
  });
  afterEach(()=>{
    jest.restoreAllMocks(); if(originalApp === undefined) delete process.env.FEISHU_APP_ID; else process.env.FEISHU_APP_ID=originalApp;
    if(originalSecret === undefined) delete process.env.LOCAL_ACCESS_SESSION_SECRET; else process.env.LOCAL_ACCESS_SESSION_SECRET=originalSecret;
    if(originalAppSecret === undefined) delete process.env.FEISHU_APP_SECRET; else process.env.FEISHU_APP_SECRET=originalAppSecret;
    const canonical=(value:string)=>resolve(value).toLowerCase();
    if(canonical(dirname(directory)) !== canonical(temporaryRoot) || !/^nt-personal-page-[A-Za-z0-9]+$/u.test(basename(directory)) || !existsSync(directory) || lstatSync(directory).isSymbolicLink() || canonical(realpathSync(directory)) !== canonical(directory)) throw new Error('测试目录归属异常，已保留');
    for(const name of readdirSync(directory)) if(!lstatSync(join(directory,name)).isFile() || lstatSync(join(directory,name)).isSymbolicLink()) throw new Error('测试目录条目异常，已保留');
    if(readFileSync(join(directory,'.test-owner'),'utf8') !== owner) throw new Error('测试目录归属标记异常，已保留');
    rmSync(directory,{recursive:true,force:false});
  });
  it('只按已验证的当前账号版本增补读取，不改变同角色示例人员004员',()=>{
    const own=Reflect.apply(service.pagePermissions,service,['site_member',chief.id,2]);
    expect(own.paths).toContain('/contract-management'); expect(own.configured).toBe(true);
    expect(Reflect.apply(service.pagePermissions,service,['site_member',other.id,2]).paths).not.toContain('/contract-management');
    expect(Reflect.apply(service.pagePermissions,service,['site_member',chief.id,1]).paths).not.toContain('/contract-management');
    expect(service.pagePermissions('site_member').paths).not.toContain('/contract-management');
  });
  it('归档和矩阵采用个人页面读取，业务修改仍按原角色',()=>{
    const current=store.read().accounts[chief.id],archive=capturePersonnelPermission(current,undefined,store.read().revision)!;
    expect(archive.template.pagePaths).toContain('/contract-management');
    const cell=buildPermissionMatrix(matrixAccountSubject(current)).find(item=>item.path === '/contract-management')!;
    expect(cell.read).toBe('all'); expect(cell.operations).toBe('none');
  });
  it('管理员可保存或清除个人增补，版本更新使旧会话失效',async()=>{
    const change={clientMutationId:'synthetic-page-change',expectedRevision:store.read().revision,id:chief.id,kind:'feishu' as const,name:chief.name,role:chief.role,building:null,enabled:true,pagePaths:['/operations-kb']};
    await service.saveAccount(change,service.feishuPrincipal(backup.openId!,appId)!);
    const saved=service.snapshot().accounts.find(item=>item.id === chief.id)!;
    expect(saved.version).toBe(3); expect(Reflect.apply(service.pagePermissions,service,[saved.role,saved.id,saved.version]).paths).toContain('/operations-kb');
    expect(service.validateSession(chief.id,2,'site_member',null)).toBe(false);
    await service.saveAccount({...change,clientMutationId:'synthetic-page-clear',expectedRevision:store.read().revision,pagePaths:[]},service.feishuPrincipal(backup.openId!,appId)!);
    expect(Reflect.apply(service.pagePermissions,service,['site_member',chief.id,4]).paths).not.toContain('/operations-kb');
  });
  it('未知页面和非管理员配置页拒绝写入，原字节保持',async()=>{
    const before=readFileSync(store.filePath,'utf8');
    for(const page of ['/synthetic-unknown-page','/system-configuration']) {
      await expect(store.mutate(store.read().revision,`synthetic-invalid-${page.length}`,`synthetic-invalid-${page.length}`,state=>{ Object.assign(state.accounts[chief.id],{pagePaths:[page]}); })).rejects.toThrow('权限配置校验失败');
      expect(readFileSync(store.filePath,'utf8')).toBe(before);
    }
  });
  it('实际guard和session响应绑定已签名主体，GET可读，写入、强制刷新及伪造query不扩权',()=>{
    const access=new UnifiedAccessService(service),guard=new UnifiedAccessGuard(new Reflector(),access);
    const login=access.issueTrustedSession(service.feishuPrincipal(chief.openId!,appId)!);
    const otherLogin=access.issueTrustedSession(service.feishuPrincipal(other.openId!,appId)!);
    const authorize=(token:string,method='GET',url='/api/contract-management/dashboard',query={})=>{
      const handler=()=>undefined; Reflect.defineMetadata(GuestReadableMetadataKey,true,handler);
      const req={method,url,originalUrl:url,headers:{cookie:`${access.cookieName}=${token}`},query,accessPageRead:undefined as boolean|undefined};
      const context={getClass:()=>class {},getHandler:()=>handler,switchToHttp:()=>({getRequest:()=>req,getResponse:()=>({})})};
      return {allowed:guard.canActivate(context as never),req};
    };
    const read=authorize(login.token); expect(read.allowed).toBe(true); expect(read.req.accessPageRead).toBe(true);
    expect(authorize(login.token,'POST').allowed).toBe(false); expect(authorize(login.token,'DELETE').allowed).toBe(false);
    expect(authorize(login.token,'GET','/api/contract-management/dashboard?refresh=1',{refresh:'1'}).allowed).toBe(false);
    expect(authorize(otherLogin.token,'GET','/api/contract-management/dashboard',{accountId:chief.id,authorizationVersion:'2',pagePaths:'/contract-management'}).allowed).toBe(false);
    const response={setHeader:jest.fn(),clearCookie:jest.fn()},controller=new UnifiedAccessController(access,{} as never);
    const session=controller.session({headers:{cookie:`${access.cookieName}=${login.token}`}} as never,response as never);
    expect(session.pagePaths).toContain('/contract-management'); expect(session.role).toBe('site_member');
  });
});
