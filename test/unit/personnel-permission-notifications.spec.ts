import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { PersonnelPermissionNotificationsService } from '../../server/common/access/personnel-permission-notifications.service';
import { PersonnelPermissionNotificationStore } from '../../server/common/access/personnel-permission-notification.store';
import type { StoredPermissionRequest } from '../../server/common/access/personnel-permission-requests.store';

let requests: Record<string, StoredPermissionRequest> = {};
let mockRequests: Record<string, StoredPermissionRequest> = {};
jest.mock('../../server/common/access/personnel-permission-requests.store', () => ({ getPersonnelPermissionRequestsStore: () => ({ read: () => ({ requests: mockRequests }) }) }));
jest.mock('../../server/common/hotfix-runtime-activation', () => ({ runHotfixInitialization: async (_owner: unknown, start: () => void) => start(), cancelHotfixInitialization: async () => undefined }));
const APP = 'cli_test_notification', REQUEST = '11111111-2222-3333-4444-555555555555';
const hash = (v: string) => createHash('sha256').update(v).digest('hex');
const account = (id: string, role = 'admin', visible = true) => ({ id: 'feishu-' + id, kind: 'feishu', appId: APP,
  name: id, role, enabled: true, deleted: false, version: 1, identityHash: hash(APP + '\0ou_' + id), ...(visible ? { openId: 'ou_' + id } : {}) });
describe('permission notification outbox with synthetic recipients only', () => {
  let directory: string, file: string, previous: Record<string, string | undefined>, service: PersonnelPermissionNotificationsService;
  let accounts: any[], http: any, people: any, store: PersonnelPermissionNotificationStore;
  let committedReceipt: any;
  beforeEach(async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] }); jest.setSystemTime(new Date('2026-10-30T07:00:00Z'));
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    directory = mkdtempSync(join(tmpdir(), 'permission-notification-')); file = join(directory, 'personnel-permission-notifications.json');
    previous = Object.fromEntries(['NODE_ENV','NANTONG_HOTFIX_SMOKE_MODE','ACCESS_CONFIGURATION_FILE','FEISHU_APP_ID','FEISHU_APP_SECRET','PUBLIC_BASE_URL','CLIENT_BASE_PATH'].map(key => [key, process.env[key]]));
    Object.assign(process.env, { NODE_ENV: 'production', ACCESS_CONFIGURATION_FILE: join(directory, 'configuration.json'), FEISHU_APP_ID: APP,
      FEISHU_APP_SECRET: 'synthetic-only', PUBLIC_BASE_URL: 'https://www.example.test:3001', CLIENT_BASE_PATH: '/' });
    delete process.env.NANTONG_HOTFIX_SMOKE_MODE;
    accounts = [account('admin1'), account('admin2', 'admin', false), account('viewer', 'guest')];
    committedReceipt = undefined;
    requests = { [REQUEST]: { id: REQUEST, version: 1, accountId: 'synthetic-owner', applicantIdentity: 'synthetic-owner', applicantName: '合成人员',
      permissions: [{ kind: 'page', path: '/inventory-management' }], reason: '合成测试', status: 'pending', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } };
    mockRequests = requests;
    let serial = 0;
    http = { axiosRef: { post: jest.fn(async (url: string) => ({ status: 200, data: url.endsWith('/internal') ? { code: 0, tenant_access_token: 'synthetic-token' } : { code: 0, data: { message_id: 'om_test' + ++serial } } })),
      patch: jest.fn(async () => ({ status: 200, data: { code: 0 } })) } };
    people = { read: jest.fn(async () => ({ appId: APP, personnelComplete: true, people: [{ openId: 'ou_admin2', name: '合成管理员' }] })) };
    service = makeService(); store = new PersonnelPermissionNotificationStore(file); await service.onModuleInit();
  });
  function makeService() { return new PersonnelPermissionNotificationsService(http, { snapshot: () => ({ accounts }), permissionRequestGrantReceipt: () => committedReceipt,
    permissionRequestGrantReceipts: (rows: StoredPermissionRequest[]) => new Map(committedReceipt ? rows.map(row => [row.id, committedReceipt]) : []),
    currentPrincipal: (id: string, version: number) => { const a = accounts.find(row => row.id === id && row.version === version); return a?.enabled && !a.deleted ? { role: a.role } : undefined; } } as any, people); }
  afterEach(async () => {
    await service.onModuleDestroy(); jest.clearAllTimers(); jest.useRealTimers(); jest.restoreAllMocks();
    for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    rmSync(directory, { recursive: true, force: true });
  });
  const posts = (http: any) => http.axiosRef.post.mock.calls.filter((row: any[]) => row[0].endsWith('/messages'));
  it('does not scan or replay historic requests on startup', async () => {
    await service.flush(); expect(http.axiosRef.post).not.toHaveBeenCalled(); expect(Object.keys(store.read().jobs)).toEqual([]);
  });
  it('durably enqueues quickly, resolves hashed admin identity, and sends each administrator once', async () => {
    await service.enqueue(requests[REQUEST]); expect(http.axiosRef.post).not.toHaveBeenCalled();
    expect(store.read().jobs[REQUEST].recipientAccountIds).toEqual(['feishu-admin1', 'feishu-admin2']);
    await service.flush(); expect(posts(http).map((row: any[]) => row[1].receive_id)).toEqual(['ou_admin1','ou_admin2']);
    expect(posts(http)[0][1].content).toContain('requestId=' + REQUEST);
    await service.enqueue(requests[REQUEST]); await service.flush(); expect(posts(http)).toHaveLength(2);
    await service.onModuleDestroy(); service = makeService(); await service.onModuleInit(); await service.flush(); expect(posts(http)).toHaveLength(2);
  });
  it('does not block known administrators when one directory identity is unavailable', async () => {
    people.read.mockRejectedValue(new Error('synthetic source unavailable')); await service.enqueue(requests[REQUEST]); await service.flush();
    expect(posts(http).map((row: any[]) => row[1].receive_id)).toEqual(['ou_admin1']); expect(store.read().jobs[REQUEST].recipientsResolved).toBe(false);
    people.read.mockResolvedValue({ appId: APP, personnelComplete: true, people: [{ openId: 'ou_admin2', name: '合成管理员' }] });
    jest.setSystemTime(Date.now() + 61000);
    await service.flush(); expect(posts(http)).toHaveLength(2);
  });
  it('uses the same UUID and original card for an uncertain send, then patches the latest terminal result', async () => {
    accounts = [account('admin1')]; let rejectFirst = true;
    http.axiosRef.post.mockImplementation(async (url: string) => { if (url.endsWith('/internal')) return { status: 200, data: { code: 0, tenant_access_token: 'synthetic-token' } };
      if (rejectFirst) { rejectFirst = false; throw new Error('synthetic response lost'); }
      return { status: 200, data: { code: 0, data: { message_id: 'om_same' } } }; });
    await service.enqueue(requests[REQUEST]); await service.flush();
    requests[REQUEST] = { ...requests[REQUEST], version: 2, status: 'rejected', reviewerName: '合成管理员', comment: '合成驳回' };
    jest.setSystemTime(Date.now() + 31000); await service.flush();
    expect(posts(http)).toHaveLength(2); expect(posts(http)[1][1]).toEqual(posts(http)[0][1]);
    expect(store.read().jobs[REQUEST].deliveries[0].syncedVersion).toBe(1);
    await service.flush(); expect(http.axiosRef.patch).toHaveBeenCalledTimes(1);
    const card = JSON.parse(http.axiosRef.patch.mock.calls[0][1].content);
    const button = card.elements.at(-1).actions[0]; expect(button.disabled).toBe(true); expect(button.url).toBeUndefined();
    expect(store.read().jobs[REQUEST].deliveries[0].syncedVersion).toBe(2);
  });
  it('never replays an unknown historical send outside the bounded deduplication window', async () => {
    accounts = [account('admin1')]; http.axiosRef.post.mockImplementation(async (url: string) => {
      if (url.endsWith('/internal')) return { status: 200, data: { code: 0, tenant_access_token: 'synthetic-token' } };
      throw new Error('synthetic timeout'); });
    await service.enqueue(requests[REQUEST]); await service.flush(); jest.setSystemTime(Date.now() + 301000); await service.flush();
    expect(posts(http)).toHaveLength(1); expect(store.read().jobs[REQUEST].deliveries[0].status).toBe('attention');
  });
  it('checks administrator revocation again after token retrieval and does not send', async () => {
    accounts = [account('admin1')]; http.axiosRef.post.mockImplementation(async () => { accounts[0].role = 'guest'; return { status: 200, data: { code: 0, tenant_access_token: 'synthetic-token' } }; });
    await service.enqueue(requests[REQUEST]); await service.flush(); expect(posts(http)).toHaveLength(0);
    await service.flush(); expect(store.read().jobs[REQUEST].deliveries[0].status).toBe('cancelled');
  });
  it.each(['development', 'smoke'])('cannot deliver from %s preview or fixture', async mode => {
    await service.onModuleDestroy(); if (mode === 'development') process.env.NODE_ENV = 'development'; else process.env.NANTONG_HOTFIX_SMOKE_MODE = 'true';
    service = makeService(); await service.onModuleInit(); await service.enqueue(requests[REQUEST]); await service.flush(); expect(http.axiosRef.post).not.toHaveBeenCalled();
  });
  it('keeps application initialization available on damaged notification state and reports enqueue failure', async () => {
    await service.onModuleDestroy(); writeFileSync(file, '{broken'); service = makeService();
    await expect(service.onModuleInit()).resolves.toBeUndefined();
    await expect(service.enqueue(requests[REQUEST])).rejects.toThrow('通知暂未登记'); expect(readFileSync(file,'utf8')).toBe('{broken'); expect(http.axiosRef.post).not.toHaveBeenCalled();
  });
  it('retains the request and reports unavailable administrator delivery routing', async () => {
    accounts = [account('viewer', 'guest')]; await expect(service.enqueue(requests[REQUEST])).rejects.toThrow('未找到');
    expect(requests[REQUEST].status).toBe('pending'); expect(http.axiosRef.post).not.toHaveBeenCalled();
  });
  it('projects a durable grant receipt into the terminal card without granting or modifying the raw request again', async () => {
    accounts = [account('admin1')]; await service.enqueue(requests[REQUEST]); await service.flush();
    committedReceipt = { reviewerAccountId: 'feishu-admin1', reviewerName: '合成管理员', reviewedAt: new Date().toISOString(), configurationRevision: 9, comment: '合成通过' };
    await service.flush(); expect(posts(http)).toHaveLength(1); expect(http.axiosRef.patch).toHaveBeenCalledTimes(1);
    expect(http.axiosRef.patch.mock.calls[0][1].content).toContain('已授权');
    expect(store.read().jobs[REQUEST].deliveries[0].syncedVersion).toBe(2); expect(requests[REQUEST].status).toBe('pending');
  });
  it('excludes another administrator login linked to the applicant identity', async () => {
    accounts = [{ ...account('linked'), personnelIdentity: 'synthetic-owner' }, account('admin1')];
    requests[REQUEST].applicantIdentity = APP + ':synthetic-owner';
    await service.enqueue(requests[REQUEST]); await service.flush();
    expect(posts(http).map((row: any[]) => row[1].receive_id)).toEqual(['ou_admin1']);
  });
});
