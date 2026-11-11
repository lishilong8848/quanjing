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
    expect(body.content).not.toContain(row.changes.phone);
    expect(body.content).not.toContain(row.changes.email);
    expect(body.content).not.toContain(row.changes.photo);
    expect(body.content).toContain('tab=profile-changes');
    expect(body.content).toContain('requestId=' + id);
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
      expect(JSON.stringify(card)).not.toContain('private@example.test');
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
