import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { APP_GUARD } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import * as stores from '../../server/common/access/access-configuration.store';
import * as defaults from '../../server/common/access/access-configuration.defaults';
import { AccessConfigurationService } from '../../server/common/access/access-configuration.service';
import { AccessConfigurationController } from '../../server/common/access/access-configuration.controller';
import { AccessConfigurationDirectory } from '../../server/common/access/access-configuration.directory';
import { AccessConfigurationCardDirectory } from '../../server/common/access/access-configuration.card-directory';
import { UnifiedAccessService } from '../../server/common/access/unified-access.service';
import { UnifiedAccessGuard } from '../../server/common/access/unified-access.guard';
import { feishuIdentityFingerprint } from '../../server/common/access/feishu-access-approved-grants';
import { PersonnelSourceService } from '../../server/common/access/personnel-source.service';
import { PersonnelBaselineService } from '../../server/common/access/personnel-baseline.service';
import { PERSONNEL_BASELINE_READER } from '../../server/common/access/personnel-baseline.reader';

describe('第四阶段管理员来源核对 HTTP', () => {
  let app: INestApplication, store: stores.AccessConfigurationStore, folder: string, tempRoot: string, owner: string, previous: NodeJS.ProcessEnv;
  const appId = 'cli_source_http_synthetic';
  beforeEach(async () => {
    previous = { ...process.env }; process.env.FEISHU_APP_ID = appId; process.env.LOCAL_ACCESS_SESSION_SECRET = randomBytes(32).toString('base64');
    process.env.LOCAL_ACCESS_CONTROL_ENABLED = 'true'; delete process.env.PUBLIC_BASE_URL;
    tempRoot = realpathSync(tmpdir()); folder = mkdtempSync(join(tempRoot, 'nt-source-http-')); owner = randomUUID(); writeFileSync(join(folder, '.test-owner'), owner, { flag: 'wx' });
    store = new stores.AccessConfigurationStore(join(folder, 'configuration.json')); jest.spyOn(stores, 'getAccessConfigurationStore').mockReturnValue(store); jest.spyOn(defaults, 'defaultAccessAccounts').mockReturnValue({});
    const identityHash = feishuIdentityFingerprint(appId, 'ou_source_admin');
    await store.mutate(0, 'seed-source-admin', 'seed', state => { state.accounts[`feishu-${identityHash}`] = { id: `feishu-${identityHash}`, kind: 'feishu', appId, identityHash, openId: 'ou_source_admin', name: '合成管理员',
      role: 'admin', building: null, enabled: true, deleted: false, source: 'configuration', version: 1 }; });
    const directory = { appId, people: [], employees: [], snapshotAt: Date.now(), personnelComplete: true, employmentState: { complete: true, entries: [] }, personnelAuthority: {
      mode: 'shadow', version: 'a'.repeat(64), snapshotAt: Date.now(), source: { appId, appToken: 'syntheticBase', tableId: 'tblPeople', dutyTableId: 'tblDuties' }, people: [], duties: [], problems: [], issues: [],
    } };
    const module = await Test.createTestingModule({ controllers: [AccessConfigurationController], providers: [AccessConfigurationService, UnifiedAccessService, PersonnelSourceService,PersonnelBaselineService,
      {provide:PERSONNEL_BASELINE_READER,useValue:{read:async()=>({})}},
      { provide: AccessConfigurationDirectory, useValue: { read: async () => structuredClone(directory) } }, { provide: AccessConfigurationCardDirectory, useValue: {} }, { provide: APP_GUARD, useClass: UnifiedAccessGuard }] }).compile();
    app = module.createNestApplication({ logger: false }); await app.listen(0, '127.0.0.1');
  }, 30000);
  afterEach(async () => {
    await app?.close(); jest.restoreAllMocks(); process.env = previous;
    if (resolve(dirname(folder)).toLowerCase() !== resolve(tempRoot).toLowerCase() || realpathSync(folder) !== folder || lstatSync(folder).isSymbolicLink() || readFileSync(join(folder, '.test-owner'), 'utf8') !== owner) throw Error('测试目录归属异常');
    rmSync(folder, { recursive: true });
  });
  it('管理员核对无可识别岗位时得到明确未就绪状态，预览不写配置', async () => {
    const base = await app.getUrl(), access = app.get(UnifiedAccessService), identityHash = feishuIdentityFingerprint(appId, 'ou_source_admin');
    const token = access.issueTrustedSession({ role: 'admin', purchaseBuilding: null, displayName: '合成管理员', accountId: `feishu-${identityHash}`, authorizationVersion: 1 }).token;
    const before = readFileSync(store.filePath);
    const response = await fetch(`${base}/api/access/configuration/personnel-source/preview`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: `${access.cookieName}=${token}`, Origin: base }, body: '{}' });
    expect(response.status).toBe(201);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await response.json()).toMatchObject({ canActivate: false, configurationRevision: 1, problems: expect.arrayContaining(['尚无可识别岗位，请核对人员岗位、范围或额外职责']) });
    expect(readFileSync(store.filePath)).toEqual(before);
  });
  it('真实管理路由拒绝匿名、跨站、伪造操作者和过期管理员会话', async () => {
    const base=await app.getUrl(),access=app.get(UnifiedAccessService),id=`feishu-${feishuIdentityFingerprint(appId,'ou_source_admin')}`;
    const token=access.issueTrustedSession({role:'admin',purchaseBuilding:null,displayName:'合成管理员',accountId:id,authorizationVersion:1}).token;
    const post=(suffix:string,body:unknown,cookie=`${access.cookieName}=${token}`,origin=base)=>fetch(`${base}/api/access/configuration/personnel-source${suffix}`,{method:'POST',headers:{'Content-Type':'application/json',Cookie:cookie,Origin:origin},body:JSON.stringify(body)});
    expect((await post('/preview',{},'')).status).toBe(403);
    expect((await post('/preview',{},undefined,'https://untrusted.example')).status).toBe(403);
    const operation={clientMutationId:randomUUID(),expectedRevision:1,expectedDirectoryVersion:'a'.repeat(64),action:'activate'};
    expect((await post('',{...operation,actorId:'forged'})).status).toBe(400);
    const before=readFileSync(store.filePath);expect((await post('',operation)).status).toBe(409);expect(readFileSync(store.filePath)).toEqual(before);
    await store.mutate(store.read().revision,'source-http-admin-version','version',state=>{state.accounts[id].version++;});
    expect((await post('/preview',{})).status).toBe(403);expect((await post('',operation)).status).toBe(403);
    expect(store.read().personnelSource).toBeUndefined();
  });
  it('首次基线真实HTTP只读核对空源并复用Admin、Origin、严格请求与版本门禁',async()=>{
    const base=await app.getUrl(),access=app.get(UnifiedAccessService),id=`feishu-${feishuIdentityFingerprint(appId,'ou_source_admin')}`;
    const token=access.issueTrustedSession({role:'admin',purchaseBuilding:null,displayName:'合成管理员',accountId:id,authorizationVersion:1}).token;
    const post=(suffix:string,body:unknown,cookie=`${access.cookieName}=${token}`,origin=base)=>fetch(`${base}/api/access/configuration/personnel-baseline/${suffix}`,{method:'POST',headers:{'Content-Type':'application/json',Cookie:cookie,Origin:origin},body:JSON.stringify(body)});
    const before=readFileSync(store.filePath),preview=await post('preview',{});expect(preview.status).toBe(201);expect(preview.headers.get('cache-control')).toBe('private, no-store');expect(await preview.json()).toMatchObject({canConfirm:false});expect(readFileSync(store.filePath)).toEqual(before);
    expect((await post('preview',{},'')).status).toBe(403);expect((await post('preview',{},undefined,'https://untrusted.example')).status).toBe(403);
    const operation={clientMutationId:randomUUID(),expectedRevision:store.read().revision,expectedFingerprint:'d'.repeat(64)};
    expect((await post('confirm',{...operation,actorId:'forged'})).status).toBe(400);expect((await post('confirm',operation)).status).toBe(409);
    await store.mutate(store.read().revision,'baseline-http-admin-change','change',state=>{state.accounts[id].version++;});expect((await post('preview',{})).status).toBe(403);expect((await post('confirm',operation)).status).toBe(403);expect(store.read().personnelBaseline).toBeUndefined();
  });
});
