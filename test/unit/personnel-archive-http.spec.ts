import { Test } from '@nestjs/testing';
import { HttpService } from '@nestjs/axios';
import type { INestApplication } from '@nestjs/common';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { UnifiedAccessModule } from '../../server/common/access/unified-access.module';
import { UnifiedAccessService, hashAccessPassword } from '../../server/common/access/unified-access.service';
import { AccessConfigurationService } from '../../server/common/access/access-configuration.service';
import { AccessPersonnelSyncService } from '../../server/common/access/access-personnel-sync.service';
import { PersonnelArchiveGateway } from '../../server/common/access/personnel-archive.gateway';
import { buildExternalEmployeeCredentials } from '../../server/common/access/external-employee-directory';

describe('personal archive real HTTP/module integration', () => {
  const saved = { ...process.env }, appId='cli_archive_http', appToken='bascnArchiveHttpSynthetic', tableId='tblArchiveHttp', name='档案合成员工';
  let folder: string, app: INestApplication, url: string, token: string, configuration: AccessConfigurationService;
  const record = { record_id:'recArchiveHttp', fields: { 姓名:name, 密码:'synthetic-only-password', 员工工号:'TEST-042', 联系方式:'13900000000', 身份证号:'11010519491231002X', '离职/异动情况':false, 照片:[{file_token:'mockAttachmentOnly'}] } };
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/q3cAAAAASUVORK5CYII=','base64');
  const gateway={read:jest.fn(async()=>({appId,appToken,tableId,records:[record],snapshotAt:'2026-10-29T00:00:00.000Z'})),photo:jest.fn(async()=>({buffer:png,contentType:'image/png'}))};
  beforeAll(async()=>{
    folder=mkdtempSync(join(tmpdir(),'personal-archive-http-'));
    process.env.ACCESS_CONFIGURATION_FILE=join(folder,'accounts.json');
    process.env.PERSONNEL_SECURITY_FILE=join(folder,'security.json');
    process.env.PERSONNEL_PERMISSION_REQUESTS_FILE=join(folder,'requests.json');
    process.env.FEISHU_APP_ID=appId;process.env.FEISHU_APP_SECRET='synthetic-no-network';
    process.env.LOCAL_ACCESS_SESSION_SECRET=randomBytes(32).toString('base64');
    process.env.LOCAL_ADMIN_PASSWORD_HASH=hashAccessPassword('synthetic-admin-password');
    process.env.LOCAL_ACCESS_CONTROL_ENABLED='true';process.env.LOCAL_ACCESS_COOKIE_SECURE='false';
    process.env.FEISHU_ACCESS_APPROVED_GRANTS_ENABLED='false';
    configuration=new AccessConfigurationService();
    const externalEmployees=await buildExternalEmployeeCredentials([record],appId,appToken,tableId);
    await configuration.synchronizePersonnel({appId,people:[],employees:[],personnelComplete:true,snapshotAt:Date.now(),externalEmployees});
    const module=await Test.createTestingModule({imports:[UnifiedAccessModule]})
      .overrideProvider(AccessConfigurationService).useValue(configuration)
      .overrideProvider(PersonnelArchiveGateway).useValue(gateway)
      .overrideProvider(AccessPersonnelSyncService).useValue({refreshForLogin:jest.fn()})
      .overrideProvider(HttpService).useValue({axiosRef:{get:()=>{throw Error('Unexpected outbound request');},post:()=>{throw Error('Unexpected outbound request');}}})
      .compile();
    app=module.createNestApplication({logger:false});await app.listen(0,'127.0.0.1');url=await app.getUrl();
    const access=app.get(UnifiedAccessService),person=configuration.employeeTargets(name)[0].principal;
    token=access.issueTrustedSession(person as any).token;
  },30000);
  afterAll(async()=>{await app?.close();process.env={...saved};if(folder&&dirname(resolve(folder))===resolve(tmpdir()))rmSync(folder,{recursive:true,force:true});},30000);
  const get=(path:string,authenticated=true)=>fetch(url+path,{headers:authenticated?{cookie:`vnet_access_session=${token}`}:{}});
  it('returns own archive despite no organization-profile business grants, with sensitive values removed',async()=>{
    const res=await get('/api/access/personal/archive');expect(res.status).toBe(200);expect(res.headers.get('cache-control')).toBe('private, no-store');
    const payload=await res.json();expect(payload.profile).toMatchObject({name,employeeNo:'TEST-042',phone:'13900000000',photoUrl:'/api/access/personal/archive/photo'});
    expect(JSON.stringify(payload)).not.toMatch(/synthetic-only-password|11010519491231002X|mockAttachmentOnly|recArchiveHttp|passwordHash/);
  });
  it('does not expose personal archive/photo anonymously or accept a different person selector',async()=>{
    for(const path of ['/api/access/personal/archive','/api/access/personal/archive/photo']){
      expect((await get(path,false)).status).toBe(401);
      expect((await get(path+'?recordId=recSomeoneElse')).status).toBe(400);
    }
    expect((await get('/api/access/configuration')).status).toBe(403);
  });
  it('serves the own photo without sharing browser/intermediary cache',async()=>{
    const res=await get('/api/access/personal/archive/photo');expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('image/png');expect(res.headers.get('cache-control')).toBe('private, no-store');expect(res.headers.get('vary')).toBe('Cookie');
    expect(Buffer.from(await res.arrayBuffer())).toEqual(png);
  });
});
