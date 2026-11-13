import { sanitizeReadonlyCard, isReadonlyDisplayCard } from '../../server/common/feishu-card-copy/readonly-card';
import { registerCardCopyObserver } from '../../server/common/feishu-card-copy/transport';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, relative } from 'node:path';
let mockActivation: (() => void) | undefined;
jest.mock('../../server/common/hotfix-runtime-activation', () => ({
  runHotfixInitialization: jest.fn(async (_owner: any, start: () => void) => {
    mockActivation = start;
  }),
  cancelHotfixInitialization: jest.fn(async () => {}),
}));
import { PersonnelProfileNotificationsService } from '../../server/common/access/personnel-profile-notifications.service';
import { PersonnelProfileNotificationStore } from '../../server/common/access/personnel-profile-notification.store';
import { PersonnelProfileChangesService } from '../../server/common/access/personnel-profile-changes.service';
import {
  profileChangeCard,
  profileChangeReviewUrl,
} from '../../server/common/access/personnel-profile-notification.card';
const digest = (text: string) =>
  createHash('sha256').update(text).digest('hex');
describe('profile administrator notifications', () => {
  let root: string,
    service: PersonnelProfileNotificationsService,
    store: PersonnelProfileNotificationStore,
    http: any,
    config: any,
    archive: any,
    requests: any,
    accounts: any[],
    row: any;
  const original = { ...process.env };
  const appId = 'cli_synthetic',
    id = '11111111-1111-1111-1111-111111111111';
  const messages = () =>
    http.axiosRef.post.mock.calls.filter(([url]: any[]) =>
      url.includes('/im/v1/messages'),
    );
  beforeEach(() => {
    root = mkdtempSync(join(realpathSync(tmpdir()), 'profile-notices-'));
    process.env.NODE_ENV = 'production';
    process.env.NANTONG_HOTFIX_SMOKE_MODE = 'false';
    process.env.FEISHU_APP_ID = appId;
    process.env.FEISHU_APP_SECRET = 'synthetic-secret';
    process.env.PUBLIC_BASE_URL = 'https://fixture.example.test';
    process.env.ACCESS_CONFIGURATION_FILE = join(root, 'configuration.json');
    mockActivation = undefined;
    row = {
      id,
      version: 1,
      status: 'pending',
      accountId: 'local-external-applicant',
      identity: 'local-external-identity',
      applicantName: '合成申请人',
      before: {phone:'13700000000',email:'old@example.test',photo:'已有照片'},
      changes: {
        phone: '13800000000',
        email: 'private@example.test',
        photo: 'secret-photo',
      },
      source: {
        appId,
        appToken: 'appSynthetic',
        tableId: 'tblSynthetic',
        recordId: 'recSynthetic',
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    requests = {
      read: jest.fn(() => ({ requests: { [id]: structuredClone(row) } })),
    };
    accounts = [
      {
        id: 'feishu-admin',
        kind: 'feishu',
        role: 'admin',
        appId,
        enabled: true,
        version: 1,
        openId: 'ou_admin',
        identityHash: digest(appId + '\0ou_admin'),
        personnelActive: true,
      },
      {
        id: 'feishu-owner-alias',
        kind: 'feishu',
        role: 'admin',
        appId,
        enabled: true,
        version: 1,
        openId: 'ou_owner',
        identityHash: digest(appId + '\0ou_owner'),
        personnelIdentity: row.identity,
      },
      {
        id: 'feishu-disabled',
        kind: 'feishu',
        role: 'admin',
        appId,
        enabled: false,
        version: 1,
        openId: 'ou_disabled',
        identityHash: digest(appId + '\0ou_disabled'),
      },
    ];
    config = {
      snapshot: jest.fn(() => ({ accounts })),
      currentPrincipal: jest.fn((id: string) =>
        accounts.find((a) => a.id === id && a.enabled)
          ? { role: 'admin' }
          : undefined,
      ),
    };
    archive = {
      read: jest.fn(async () => ({
        ...row.source,
        records: [
          {
            record_id: row.source.recordId,
            fields: { 员工姓名: [{ id: 'ou_owner' }] },
          },
        ],
      })),
    };
    http = {
      axiosRef: {
        post: jest.fn(async (url: string) =>
          url.includes('/auth/')
            ? {
                data: {
                  code: 0,
                  tenant_access_token: 'synthetic-token',
                  expire: 7200,
                },
              }
            : {
                status: 200,
                data: { code: 0, data: { message_id: 'om_synthetic' } },
              },
        ),
        patch: jest.fn(async () => ({ status: 200, data: { code: 0 } })),
      },
    };
    store = new PersonnelProfileNotificationStore(join(root, 'notices.json'));
    service = new PersonnelProfileNotificationsService(
      http,
      config,
      { read: jest.fn() } as any,
      archive,
      requests,
    );
    Object.assign(service as any, { store, stopped: false });
  });
  afterEach(async () => {
    await service.onModuleDestroy();
    for (const key of [
      'NODE_ENV',
      'NANTONG_HOTFIX_SMOKE_MODE',
      'FEISHU_APP_ID',
      'FEISHU_APP_SECRET',
      'PUBLIC_BASE_URL',
      'ACCESS_CONFIGURATION_FILE',
    ]) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
    if (resolve(dirname(root)) !== resolve(realpathSync(tmpdir())))
      throw new Error('outside temp');
    rmSync(root, { recursive: true });
    jest.clearAllMocks();
  });
  it('backfills only pending profile requests, filters owner aliases and delivers once with a stable uuid', async () => {
    await service.flush();
    await service.flush();
    expect(messages()).toHaveLength(1);
    const body = messages()[0][1];
    expect(body.receive_id).toBe('ou_admin');
    expect(body.uuid).toHaveLength(40);
    expect(store.read().jobs[id].deliveries[0]).toMatchObject({
      messageId: 'om_synthetic',
      status: 'sent',
      syncedVersion: 1,
    });
    expect(body.content).toContain(row.changes.phone);
    expect(body.content).toContain(row.before.phone);
    expect(body.content).toContain(row.changes.email);
    expect(body.content).not.toContain(row.changes.photo);
    expect(body.content).toContain('tab=profile-changes');
    expect(body.content).toContain('requestId=' + id);
  });
  it('uploads stored before/after photo bytes once and reuses confirmed IM keys for a second admin', async()=>{
    row.beforePhoto={name:id+'-before',type:'image/png',sha256:'a'.repeat(64),size:3};
    row.photo={name:id+'-after',type:'image/png',sha256:'b'.repeat(64),size:3};
    requests.readPhoto=jest.fn(()=>Buffer.from([1,2,3]));
    accounts.push({...accounts[0],id:'admin-two',openId:'ou_two',identityHash:digest(appId+'\0ou_two')});
    const base=http.axiosRef.post.getMockImplementation();let uploaded=0;
    http.axiosRef.post.mockImplementation((url:string,...args:any[])=>url.endsWith('/im/v1/images')?Promise.resolve({data:{code:0,data:{image_key:'img_profile_'+(++uploaded)}}}):base(url,...args));
    await service.flush();
    expect(uploaded).toBe(2);expect(requests.readPhoto).toHaveBeenCalledTimes(2);expect(messages()).toHaveLength(2);expect(store.read().jobs[id].deliveries.every(delivery=>delivery.approveAvailable===true)).toBe(true);
    for(const message of messages()){expect(message[1].content).toContain('img_profile_1');expect(message[1].content).toContain('img_profile_2');expect(message[1].content).not.toContain('secret-photo');}
    await service.flush();expect(uploaded).toBe(2);expect(messages()).toHaveLength(2);
  });
  it('keeps approval delivery usable with safe photo fallback when upload fails',async()=>{
    row.photo={name:id+'-after',type:'image/png',sha256:'a'.repeat(64),size:3};requests.readPhoto=jest.fn(()=>Buffer.from([1,2,3]));
    const base=http.axiosRef.post.getMockImplementation();http.axiosRef.post.mockImplementation((url:string,...args:any[])=>url.endsWith('/im/v1/images')?Promise.reject(new Error('secret source URL')):base(url,...args));
    await service.flush();expect(messages()).toHaveLength(1);expect(messages()[0][1].content).toContain('图片暂不可用');expect(messages()[0][1].content).toContain('profile_change_review');expect(messages()[0][1].content).not.toContain('secret source URL');expect(store.read().jobs[id].deliveries[0].approveAvailable).toBe(false);expect(JSON.parse(messages()[0][1].content).elements.filter((element:any)=>element.tag==='action').flatMap((element:any)=>element.actions).some((button:any)=>button.value?.decision==='approve')).toBe(false);
  });
  it('keeps unknown-send retries on the exact frozen card and its original approval capability',async()=>{
    const base=http.axiosRef.post.getMockImplementation();let sends=0;
    http.axiosRef.post.mockImplementation((url:string,...args:any[])=>url.endsWith('/im/v1/messages')&&++sends===1?Promise.reject(new Error('lost response')):base(url,...args));
    await service.flush();const frozen=messages()[0][1].content;
    row.photo={name:id+'-after',type:'image/png',sha256:'a'.repeat(64),size:3};requests.readPhoto=jest.fn(()=>Buffer.from([1,2,3]));
    store.update(state=>{state.jobs[id].deliveries[0].nextAttemptAt=0;});await service.flush();
    expect(messages()).toHaveLength(2);expect(messages()[1][1].content).toBe(frozen);expect(messages()[1][1].uuid).toBe(messages()[0][1].uuid);expect(requests.readPhoto).not.toHaveBeenCalled();expect(store.read().jobs[id].deliveries[0].approveAvailable).toBe(false);
  });
  it('retries a degraded photo preview on the original message and then enables card approval',async()=>{
    row.fields={photo:'照片'};row.baseline={'照片':[]};row.before.photo='暂无照片';row.photo={name:id+'-after',type:'image/png',sha256:'a'.repeat(64),size:3};requests.readPhoto=jest.fn(()=>Buffer.from([1,2,3]));
    const base=http.axiosRef.post.getMockImplementation();let uploads=0;
    http.axiosRef.post.mockImplementation((url:string,...args:any[])=>url.endsWith('/im/v1/images')?(++uploads===1?Promise.reject(new Error('transient')):Promise.resolve({data:{code:0,data:{image_key:'img_profile_restored'}}})):base(url,...args));
    await service.flush();expect(store.read().jobs[id].deliveries[0].approveAvailable).toBe(false);
    store.update(state=>{state.jobs[id].deliveries[0].presentationRetryAt=1;state.jobs[id].photoRetryAt={after:1};});
    await service.flush();expect(uploads).toBe(2);expect(messages()).toHaveLength(1);expect(http.axiosRef.patch).toHaveBeenCalledTimes(1);expect(store.read().jobs[id].deliveries[0].approveAvailable).toBe(true);expect(http.axiosRef.patch.mock.calls[0][1].content).toContain('img_profile_restored');
    await service.flush();expect(uploads).toBe(2);expect(http.axiosRef.patch).toHaveBeenCalledTimes(1);
  });
  it('caps failed photo uploads and degraded-card refreshes without reposting',async()=>{
    row.fields={photo:'照片'};row.baseline={'照片':[]};row.photo={name:id+'-after',type:'image/png',sha256:'a'.repeat(64),size:3};requests.readPhoto=jest.fn(()=>Buffer.from([1,2,3]));
    const base=http.axiosRef.post.getMockImplementation();let uploads=0;
    http.axiosRef.post.mockImplementation((url:string,...args:any[])=>url.endsWith('/im/v1/images')?(uploads++,Promise.reject(new Error('offline'))):base(url,...args));
    await service.flush();
    for(let attempt=0;attempt<5;attempt++){store.update(state=>{state.jobs[id].deliveries[0].presentationRetryAt=1;state.jobs[id].photoRetryAt={after:1};});await service.flush();}
    expect(uploads).toBe(3);expect(messages()).toHaveLength(1);expect(http.axiosRef.patch).toHaveBeenCalledTimes(2);expect(store.read().jobs[id].deliveries[0].approveAvailable).toBe(false);
  });
  it('does not expose callback buttons when source verification fails during card preparation',async()=>{
    const read=archive.read.getMockImplementation();let calls=0;archive.read.mockImplementation(()=>++calls===1?read():Promise.reject(new Error('source unavailable')));
    await service.flush();expect(messages()).toHaveLength(1);expect(messages()[0][1].content).not.toContain('profile_change_review');expect(messages()[0][1].content).toContain('平台查看申请');
  });
  it('upgrades an already-sent old card in place without another message',async()=>{
    await service.flush();store.update(state=>{delete state.jobs[id].deliveries[0].syncedCardRevision;});
    await service.flush();expect(messages()).toHaveLength(1);expect(http.axiosRef.patch).toHaveBeenCalledTimes(1);expect(http.axiosRef.patch.mock.calls[0][1].content).toContain('profile_change_review');
  });
  it('patches a known message when withdrawn without creating another card', async () => {
    await service.flush();
    row.status = 'cancelled';
    row.version++;
    await service.flush();
    expect(messages()).toHaveLength(1);
    expect(http.axiosRef.patch).toHaveBeenCalledTimes(1);
    expect(http.axiosRef.patch.mock.calls[0][1].content).toContain('已撤回');
  });
  it('does not backfill terminal requests', async () => {
    row.status = 'completed';
    await service.flush();
    expect(messages()).toHaveLength(0);
    expect(Object.keys(store.read().jobs)).toHaveLength(0);
  });
  it('never reposts an unknown pending card after the request was withdrawn', async () => {
    http.axiosRef.post.mockImplementation(async (url: string) => {
      if (url.includes('/auth/'))
        return { data: { code: 0, tenant_access_token: 'synthetic' } };
      throw new Error('lost');
    });
    await service.flush();
    row.status = 'cancelled';
    row.version++;
    store.update((s) => {
      s.jobs[id].deliveries[0].nextAttemptAt = 0;
    });
    await service.flush();
    expect(messages()).toHaveLength(1);
    expect(store.read().jobs[id].deliveries[0].status).toBe('attention');
  });
  it('deduplicates within the bounded send window and quarantines an old unknown result', async () => {
    http.axiosRef.post.mockImplementation(async (url: string) => {
      if (url.includes('/auth/'))
        return { data: { code: 0, tenant_access_token: 'synthetic' } };
      throw new Error('lost');
    });
    await service.flush();
    const first = messages()[0][1];
    store.update((s) => {
      s.jobs[id].deliveries[0].nextAttemptAt = 0;
    });
    await service.flush();
    expect(messages()[1][1]).toEqual(first);
    store.update((s) => {
      s.jobs[id].deliveries[0].nextAttemptAt = 0;
      s.jobs[id].deliveries[0].firstAttemptAt = Date.now() - 6 * 60000;
    });
    await service.flush();
    expect(messages()).toHaveLength(2);
    expect(store.read().jobs[id].deliveries[0].status).toBe('attention');
  });
  it('rechecks administrator eligibility after waiting for a token on a retry', async () => {
    http.axiosRef.post.mockImplementation(async (url: string) => {
      if (url.includes('/auth/'))
        return { data: { code: 0, tenant_access_token: 'synthetic' } };
      throw new Error('lost');
    });
    await service.flush();
    store.update((s) => {
      s.jobs[id].deliveries[0].nextAttemptAt = 0;
    });
    (service as any).token = undefined;
    let release!: (v: any) => void;
    http.axiosRef.post.mockImplementation((url: string) =>
      url.includes('/auth/')
        ? new Promise((r) => {
            release = r;
          })
        : Promise.reject(new Error('must not post')),
    );
    const running = service.flush();
    while (!release) await new Promise((r) => setImmediate(r));
    accounts[0].enabled = false;
    release({ data: { code: 0, tenant_access_token: 'new' } });
    await running;
    expect(messages()).toHaveLength(1);
  });
  it('waits for active sends during shutdown', async () => {
    let release!: (v: any) => void;
    http.axiosRef.post.mockImplementation((url: string) =>
      url.includes('/auth/')
        ? Promise.resolve({
            data: { code: 0, tenant_access_token: 'synthetic' },
          })
        : new Promise((r) => {
            release = r;
          }),
    );
    const task = service.flush();
    while (!release) await new Promise((r) => setImmediate(r));
    let done = false;
    const stop = service.onModuleDestroy().then(() => {
      done = true;
    });
    await Promise.resolve();
    expect(done).toBe(false);
    release({
      status: 200,
      data: { code: 0, data: { message_id: 'om_synthetic' } },
    });
    await task;
    await stop;
    expect(store.read().jobs[id].deliveries[0].messageId).toBe('om_synthetic');
  });
  it('does not activate notification or approved-source recovery in smoke mode', async () => {
    process.env.NANTONG_HOTFIX_SMOKE_MODE = 'true';
    const fresh = new PersonnelProfileNotificationsService(
      http,
      config,
      {} as any,
      archive,
      requests,
    );
    await fresh.onModuleInit();
    await fresh.flush();
    const profile = new PersonnelProfileChangesService(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
    const resume = jest.spyOn(profile as any, 'resume');
    await profile.onModuleInit();
    expect(resume).not.toHaveBeenCalled();
    expect(mockActivation).toBeUndefined();
    expect(messages()).toHaveLength(0);
    await fresh.onModuleDestroy();
    await profile.onModuleDestroy();
  });
  it('defers production work until runtime activation', async () => {
    const fresh = new PersonnelProfileNotificationsService(
      http,
      config,
      {} as any,
      archive,
      requests,
    );
    await fresh.onModuleInit();
    await fresh.flush();
    expect(messages()).toHaveLength(0);
    expect(mockActivation).toBeDefined();
    mockActivation!();
    await fresh.flush();
    expect(messages()).toHaveLength(1);
    await fresh.onModuleDestroy();
    const profile = new PersonnelProfileChangesService(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
    const resume = jest
      .spyOn(profile as any, 'resume')
      .mockImplementation(() => {});
    await profile.onModuleInit();
    expect(resume).not.toHaveBeenCalled();
    mockActivation!();
    expect(resume).toHaveBeenCalledTimes(1);
    await profile.onModuleDestroy();
  });
  it('continues to use the observed transport for read-only mirror enrollment and updates', async () => {
    const observer = {
      delivered: jest.fn(async () => {}),
      reserveUpdate: jest.fn(async () => ({})),
      updated: jest.fn(async () => {}),
      isCopyMessage: () => false,
      diagnostic: jest.fn(),
    };
    const detach = registerCardCopyObserver(observer);
    try {
      await service.flush();
      expect(observer.delivered).toHaveBeenCalledWith(
        expect.objectContaining({
          source: 'profile-change',
          messageId: 'om_synthetic',
        }),
      );
      row.status = 'rejected';
      row.version++;
      await service.flush();
      expect(observer.updated).toHaveBeenCalled();
      const card = (observer.delivered.mock.calls as any)[0][0].card;
      expect(JSON.stringify(card)).toContain('private@example.test');
      const mirror=sanitizeReadonlyCard(card).card;
      expect(isReadonlyDisplayCard(mirror)).toBe(true);
      expect(JSON.stringify(mirror)).not.toContain('profile_change_review');
      expect(JSON.stringify(mirror)).not.toContain('expectedVersion');
    } finally {
      detach();
    }
  });
  it('does not make a new initial delivery when pending changes during token acquisition', async () => {
    let release!: (v: any) => void;
    http.axiosRef.post.mockImplementation((url: string) =>
      url.includes('/auth/')
        ? new Promise((r) => {
            release = r;
          })
        : Promise.reject(new Error('should not send')),
    );
    const task = service.flush();
    while (!release) await new Promise((r) => setImmediate(r));
    row.status = 'completed';
    row.version++;
    release({ data: { code: 0, tenant_access_token: 'synthetic' } });
    await task;
    expect(messages()).toHaveLength(0);
    expect(store.read().jobs[id].deliveries[0].status).toBe('cancelled');
  });

  it('resolves a relative configuration path to the same absolute durable sibling', async () => {
    process.env.ACCESS_CONFIGURATION_FILE = relative(
      process.cwd(),
      join(root, 'configuration.json'),
    );
    const fresh = new PersonnelProfileNotificationsService(
      http,
      config,
      {} as any,
      archive,
      requests,
    );
    await fresh.onModuleInit();
    expect((fresh as any).store.filePath).toBe(
      join(root, 'personnel-profile-notifications.json'),
    );
    expect(mockActivation).toBeDefined();
    await fresh.onModuleDestroy();
  });
  it('does not notify a suspended administrator rejected by currentPrincipal', async () => {
    config.currentPrincipal.mockReturnValue(undefined);
    await service.flush();
    expect(messages()).toHaveLength(0);
    expect(Object.keys(store.read().jobs)).toHaveLength(0);
  });
});
