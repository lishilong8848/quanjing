jest.mock('node:http', () => ({ ...jest.requireActual('node:http'), request: () => { throw Error('Unexpected HTTP'); }, get: () => { throw Error('Unexpected HTTP'); } }));
jest.mock('node:https', () => ({ ...jest.requireActual('node:https'), request: () => { throw Error('Unexpected HTTPS'); }, get: () => { throw Error('Unexpected HTTPS'); } }));
jest.mock('../../server/common/process-lock-owner', () => ({ ...jest.requireActual('../../server/common/process-lock-owner'), processLockOwnerMayBeAlive: jest.fn() }));
jest.mock('../../server/common/config/external-services.config', () => ({ readEnv: jest.fn() }));

import { ServiceUnavailableException } from '@nestjs/common';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createProcessLockOwner, processLockOwnerMayBeAlive } from '../../server/common/process-lock-owner';
import { PersonnelPermissionNotificationStore, type PermissionNotificationJob } from '../../server/common/access/personnel-permission-notification.store';
import { permissionRequestNotificationCard, permissionRequestReviewUrl, requestedPermissionText } from '../../server/common/access/personnel-permission-notification.card';
import { readEnv } from '../../server/common/config/external-services.config';
import type { PersonnelPermissionRequest } from '../../shared/personnel-permission-request.interface';

const requestId = '11111111-1111-4111-8111-111111111111';
const secondRequestId = '22222222-2222-4222-8222-222222222222';
const deliveryUuid = 'a'.repeat(40);
const time = Date.parse('2026-10-30T06:00:00Z');
const job = (id = requestId): PermissionNotificationJob => ({ requestId: id, appId: 'cli_notification_fixture', createdAt: time,
  recipientAccountIds: ['admin-fixture'], recipientsResolved: true,
  deliveries: [{ accountId: 'admin-fixture', openId: 'ou_admin_fixture', uuid: deliveryUuid, attempts: 0, nextAttemptAt: time, status: 'queued' }] });
const lockAlive = processLockOwnerMayBeAlive as jest.Mock;

describe('permission notification persistence and delivery isolation', () => {
  let parent: string, folder: string, file: string, store: PersonnelPermissionNotificationStore;
  beforeEach(() => {
    parent = fs.realpathSync(tmpdir()); folder = fs.mkdtempSync(join(parent, 'nt-permission-notify-')); file = join(folder, 'notifications.json');
    store = new PersonnelPermissionNotificationStore(file);
    lockAlive.mockClear();
    lockAlive.mockImplementation(owner => owner.pid === process.pid);
    jest.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Unexpected fetch'));
  });
  afterEach(() => {
    jest.restoreAllMocks();
    if (dirname(resolve(folder)) !== parent || !/^nt-permission-notify-/.test(basename(folder)) || fs.lstatSync(folder).isSymbolicLink() || fs.realpathSync(folder) !== folder) throw Error('Unsafe fixture cleanup');
    fs.rmSync(folder, { recursive: true, force: false });
  });
  const save = (value: unknown) => fs.writeFileSync(file, JSON.stringify(value));

  it('starts empty without creating a file or scanning neighbouring historical requests', () => {
    fs.writeFileSync(join(folder, 'personnel-permission-requests.json'), '{"historical":"must never be scanned"}');
    expect(store.read()).toEqual({ version: 1, jobs: {} });
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.readdirSync(folder)).toEqual(['personnel-permission-requests.json']);
  });
  it('persists only explicitly registered jobs and returns detached snapshots', () => {
    store.update(state => { state.jobs[requestId] = job(); });
    const current = store.read(); current.jobs[requestId].deliveries[0].status = 'cancelled';
    expect(new PersonnelPermissionNotificationStore(file).read().jobs[requestId].deliveries[0].status).toBe('queued');
    expect(fs.readdirSync(folder)).toEqual(['notifications.json']);
  });
  it('can retry the same enqueue key without resetting an already delivered receipt', () => {
    store.update(state => { const value = job(); Object.assign(value.deliveries[0], { status: 'sent', attempts: 1, firstAttemptAt: time, messageId: 'om_fixture', syncedVersion: 1 }); state.jobs[requestId] = value; });
    store.update(state => { state.jobs[requestId] ||= job(); });
    expect(Object.keys(store.read().jobs)).toEqual([requestId]);
    expect(store.read().jobs[requestId].deliveries[0]).toMatchObject({ status: 'sent', messageId: 'om_fixture', attempts: 1 });
  });
  it('reloads the current file during update so another store instance is not overwritten', () => {
    store.update(state => { state.jobs[requestId] = job(); });
    const other = new PersonnelPermissionNotificationStore(file); other.read();
    other.update(state => { state.jobs[secondRequestId] = job(secondRequestId); });
    store.update(state => { state.jobs[requestId].deliveries[0].status = 'cancelled'; });
    expect(Object.keys(store.read().jobs).sort()).toEqual([requestId, secondRequestId]);
  });
  it.each(['successful read', 'successful write', 'corrupt observed file'])('fails closed if the file disappears after %s', (stage) => {
    if (stage === 'successful write') store.update(state => { state.jobs[requestId] = job(); });
    else if (stage === 'successful read') { save({ version: 1, jobs: { [requestId]: job() } }); store.read(); }
    else { fs.writeFileSync(file, '{bad'); expect(() => store.read()).toThrow(ServiceUnavailableException); }
    fs.unlinkSync(file);
    expect(() => store.read()).toThrow(ServiceUnavailableException);
    const change = jest.fn(); expect(() => store.update(change)).toThrow(ServiceUnavailableException);
    expect(change).not.toHaveBeenCalled(); expect(fs.existsSync(file)).toBe(false);
  });
  it.each(['{bad', 'null', '{"version":2,"jobs":{}}', '{"version":1,"jobs":[],"extra":1}'])('preserves corrupt or unsupported bytes: %s', (bytes) => {
    fs.writeFileSync(file, bytes); expect(() => store.read()).toThrow(ServiceUnavailableException);
    expect(fs.readFileSync(file, 'utf8')).toBe(bytes);
  });
  it('refuses an oversized file without replacing its contents', () => {
    fs.writeFileSync(file, ' '.repeat(8 * 1024 * 1024 + 1));
    expect(() => store.read()).toThrow(ServiceUnavailableException);
    expect(fs.statSync(file).size).toBe(8 * 1024 * 1024 + 1);
  });
  it.each([
    ['mismatched request key', (value: any) => { value.requestId = secondRequestId; }],
    ['duplicate recipient account', (value: any) => { value.recipientAccountIds.push(value.recipientAccountIds[0]); }],
    ['duplicate open ID', (value: any) => { value.deliveries.push({ ...value.deliveries[0] }); }],
    ['duplicate delivery UUID', (value: any) => { value.recipientAccountIds.push('admin-second'); value.deliveries.push({ ...value.deliveries[0], accountId: 'admin-second', openId: 'ou_admin_second' }); }],
    ['delivery outside recipient snapshot', (value: any) => { value.deliveries[0].accountId = 'not-a-recipient'; }],
    ['missing recipient resolution state', (value: any) => { delete value.recipientsResolved; }],
    ['negative attempt count', (value: any) => { value.deliveries[0].attempts = -1; }],
    ['negative retry time', (value: any) => { value.deliveries[0].nextAttemptAt = -1; }],
    ['negative first attempt time', (value: any) => { value.deliveries[0].firstAttemptAt = -1; }],
    ['sent without receipt', (value: any) => { value.deliveries[0].status = 'sent'; value.deliveries[0].syncedVersion = 1; }],
    ['sent without synced version', (value: any) => { value.deliveries[0].status = 'sent'; value.deliveries[0].messageId = 'om_fixture'; }],
    ['sending without initial time', (value: any) => { value.deliveries[0].status = 'sending'; }],
    ['pending card without version', (value: any) => { value.deliveries[0].pendingCard = { elements: [] }; }],
    ['pending version without card', (value: any) => { value.deliveries[0].pendingVersion = 1; }],
    ['invalid pending version', (value: any) => { value.deliveries[0].pendingCard = { elements: [] }; value.deliveries[0].pendingVersion = 0; }],
    ['array pending card', (value: any) => { value.deliveries[0].pendingCard = []; value.deliveries[0].pendingVersion = 1; }],
    ['oversized UTF8 pending card', (value: any) => { value.deliveries[0].pendingCard = { text: '中'.repeat(10000) }; value.deliveries[0].pendingVersion = 1; }],
  ])('rejects %s without changing previously valid persisted data', (_label, change) => {
    store.update(state => { state.jobs[requestId] = job(); }); const before = fs.readFileSync(file);
    expect(() => store.update(state => change(state.jobs[requestId]))).toThrow(ServiceUnavailableException);
    expect(fs.readFileSync(file).equals(before)).toBe(true);
    expect(fs.readdirSync(folder)).toEqual(['notifications.json']);
  });
  it('keeps unresolved recipient identities durable without fabricating open IDs', () => {
    store.update(state => { state.jobs[requestId] = { ...job(), recipientAccountIds: ['admin-fixture', 'admin-unresolved'], recipientsResolved: false }; });
    expect(store.read().jobs[requestId]).toMatchObject({ recipientsResolved: false, recipientAccountIds: ['admin-fixture', 'admin-unresolved'] });
    expect(store.read().jobs[requestId].deliveries).toHaveLength(1);
  });
  it('durably keeps the exact pending card and version across restart for same-UUID recovery', () => {
    const pendingCard = { elements: [{ tag: 'div', text: { tag: 'plain_text', content: '合成首次投递内容' } }] };
    store.update(state => { const value = job(); Object.assign(value.deliveries[0], { status: 'sending', attempts: 1, firstAttemptAt: time, pendingVersion: 2, pendingCard }); state.jobs[requestId] = value; });
    pendingCard.elements[0].text.content = '后来页面内容';
    expect(new PersonnelPermissionNotificationStore(file).read().jobs[requestId].deliveries[0]).toMatchObject({ uuid: deliveryUuid, status: 'sending', pendingVersion: 2, pendingCard: { elements: [{ tag: 'div', text: { tag: 'plain_text', content: '合成首次投递内容' } }] } });
  });
  it('rejects more than one hundred delivery targets before persistence', () => {
    expect(() => store.update(state => { state.jobs[requestId] = { ...job(), recipientAccountIds: Array.from({ length: 101 }, (_, i) => `admin-${i}`), deliveries: [] }; })).toThrow(ServiceUnavailableException);
    expect(fs.existsSync(file)).toBe(false);
  });
  it('preserves the old file and releases the lock if mutation or atomic rename fails', () => {
    store.update(state => { state.jobs[requestId] = job(); }); const before = fs.readFileSync(file);
    expect(() => store.update(() => { throw Error('Synthetic mutation failure'); })).toThrow('Synthetic mutation failure');
    const rename = jest.spyOn(fs, 'renameSync').mockImplementationOnce(() => { throw Error('Synthetic rename failure'); });
    expect(() => store.update(state => { state.jobs[requestId].deliveries[0].status = 'cancelled'; })).toThrow('Synthetic rename failure');
    rename.mockRestore();
    expect(fs.readFileSync(file).equals(before)).toBe(true); expect(fs.readdirSync(folder)).toEqual(['notifications.json']);
    store.update(state => { state.jobs[requestId].deliveries[0].status = 'cancelled'; });
    expect(store.read().jobs[requestId].deliveries[0].status).toBe('cancelled');
  });
  it('does not replace committed data if flushing the temporary data fails', () => {
    store.update(state => { state.jobs[requestId] = job(); }); const before = fs.readFileSync(file);
    const sync = jest.spyOn(fs, 'fsyncSync').mockImplementationOnce(() => undefined).mockImplementationOnce(() => { throw Error('Synthetic fsync failure'); });
    expect(() => store.update(state => { state.jobs[requestId].deliveries[0].status = 'cancelled'; })).toThrow('Synthetic fsync failure');
    sync.mockRestore(); expect(fs.readFileSync(file).equals(before)).toBe(true); expect(fs.readdirSync(folder)).toEqual(['notifications.json']);
  });
  it.each(['live', 'unreadable'])('does not steal a %s writer lock', (kind) => {
    const content = kind === 'live' ? JSON.stringify(createProcessLockOwner('synthetic-live-owner')) : '{bad';
    fs.writeFileSync(file + '.lock', content);
    expect(() => store.update(() => undefined)).toThrow(ServiceUnavailableException);
    expect(fs.readFileSync(file + '.lock', 'utf8')).toBe(content); expect(fs.existsSync(file)).toBe(false);
  });
  it('recovers a positively dead owner through the recovery guard without leaving a lock', () => {
    fs.writeFileSync(file + '.lock', JSON.stringify({ ...createProcessLockOwner('synthetic-dead-owner'), pid: 2147483646 }));
    store.update(state => { state.jobs[requestId] = job(); });
    expect(lockAlive).toHaveBeenCalledWith(expect.objectContaining({ pid: 2147483646 }), expect.any(Number)); expect(Object.keys(store.read().jobs)).toEqual([requestId]);
    expect(fs.readdirSync(folder)).toEqual(['notifications.json']);
  });
  it('does not remove a dead-owner lock if another recovery is already in progress', () => {
    const owner = JSON.stringify({ ...createProcessLockOwner('synthetic-dead-owner'), pid: 2147483646 });
    fs.writeFileSync(file + '.lock', owner); fs.writeFileSync(file + '.lock.recovery', 'other recovery');
    expect(() => store.update(() => undefined)).toThrow(ServiceUnavailableException);
    expect(fs.readFileSync(file + '.lock', 'utf8')).toBe(owner); expect(fs.readFileSync(file + '.lock.recovery', 'utf8')).toBe('other recovery');
  });
  it('rechecks ownership and keeps the lock if its owner may be alive before recovery commits', () => {
    const owner = JSON.stringify({ ...createProcessLockOwner('synthetic-dead-owner'), pid: 2147483646 });
    fs.writeFileSync(file + '.lock', owner); lockAlive.mockReturnValueOnce(false).mockReturnValueOnce(true);
    expect(() => store.update(() => undefined)).toThrow(ServiceUnavailableException);
    expect(fs.readFileSync(file + '.lock', 'utf8')).toBe(owner); expect(fs.existsSync(file + '.lock.recovery')).toBe(false); expect(fs.existsSync(file)).toBe(false);
  });
  it('allows only one in-flight action for a delivery and releases its lock after completion', async () => {
    let release!: () => void;
    const first = store.withDeliveryLock(requestId, deliveryUuid, () => new Promise<string>(done => { release = () => done('first'); }));
    const duplicate = jest.fn(async () => 'duplicate');
    expect(await store.withDeliveryLock(requestId, deliveryUuid, duplicate)).toBeUndefined(); expect(duplicate).not.toHaveBeenCalled();
    release(); expect(await first).toBe('first');
    expect(await store.withDeliveryLock(requestId, deliveryUuid, async () => 'later')).toBe('later'); expect(fs.readdirSync(folder)).toEqual([]);
  });
  it('releases delivery locks after work fails and never deletes a replacement owner', async () => {
    await expect(store.withDeliveryLock(requestId, deliveryUuid, async () => { throw Error('Synthetic work failure'); })).rejects.toThrow('Synthetic work failure');
    const lock = `${file}.${requestId}.${deliveryUuid}.lock`, replacement = JSON.stringify(createProcessLockOwner('replacement-owner'));
    await store.withDeliveryLock(requestId, deliveryUuid, async () => { fs.writeFileSync(lock, replacement); });
    expect(fs.readFileSync(lock, 'utf8')).toBe(replacement);
  });
  it('rejects relative paths and symlinked directories', () => {
    expect(() => new PersonnelPermissionNotificationStore('relative.json')).toThrow(ServiceUnavailableException);
    const actual = join(folder, 'actual'), alias = join(folder, 'alias'); fs.mkdirSync(actual); fs.symlinkSync(actual, alias, 'junction');
    try { expect(() => new PersonnelPermissionNotificationStore(join(alias, 'notifications.json'))).toThrow(ServiceUnavailableException); }
    finally { fs.unlinkSync(alias); }
  });
});

describe('permission request notification card content and deep links', () => {
  const environment: Record<string, string> = {};
  const request = (): PersonnelPermissionRequest => ({ id: requestId, version: 1, accountId: 'local-fixture', applicantName: '合成人员 <at id=all> @all',
    permissions: [{ kind: 'page', path: '/monthly-schedule' }], reason: '**text only** [external](https://invalid.example) <a>markup</a>', status: 'pending',
    createdAt: new Date(time).toISOString(), updatedAt: new Date(time).toISOString() });
  beforeEach(() => {
    for (const key of Object.keys(environment)) delete environment[key]; environment.PUBLIC_BASE_URL = 'https://www.sm.sjhl.online:3001';
    (readEnv as jest.Mock).mockImplementation(name => environment[name] || '');
  });
  afterEach(() => jest.clearAllMocks());
  it('uses only canonical PUBLIC_BASE_URL with www and links to the exact administrator request', () => {
    environment.FEISHU_REDIRECT_URI = 'https://untrusted.example/callback'; environment.HOST = 'untrusted.example';
    const url = new URL(permissionRequestReviewUrl(requestId));
    expect(url.origin).toBe('https://www.sm.sjhl.online:3001'); expect(url.pathname).toBe('/system-configuration');
    expect([...url.searchParams.entries()]).toEqual([['tab', 'permission-requests'], ['requestId', requestId]]);
  });
  it('preserves the public application mount prefix', () => {
    environment.CLIENT_BASE_PATH = '/portal';
    expect(new URL(permissionRequestReviewUrl(requestId)).pathname).toBe('/portal/system-configuration');
  });
  it.each(['', 'http://www.sm.sjhl.online:3001', 'https://user:pass@www.sm.sjhl.online:3001', 'https://www.sm.sjhl.online:3001/?token=x', 'https://www.sm.sjhl.online:3001/#fragment'])('refuses unsafe or missing public origin: %s', value => {
    environment.PUBLIC_BASE_URL = value; expect(() => permissionRequestReviewUrl(requestId)).toThrow();
  });
  it('does not allow an injected request ID in the link', () => { expect(() => permissionRequestReviewUrl(requestId + '&tab=accounts')).toThrow('PERMISSION_NOTIFICATION_ID_INVALID'); });
  it('keeps applicant text and reason as plain text and has only the fixed review button URL', () => {
    const value = request(), url = permissionRequestReviewUrl(requestId), card = permissionRequestNotificationCard(value, url) as any;
    expect(card.elements.slice(0, 3).every((item: any) => item.text.tag === 'plain_text')).toBe(true);
    expect(card.elements[0].text.content).toContain(value.applicantName); expect(card.elements[2].text.content).toContain(value.reason);
    expect(JSON.stringify(card)).not.toContain('lark_md');
    expect(card.elements.at(-1).actions).toEqual([{ tag: 'button', text: { tag: 'plain_text', content: '前往审批' }, type: 'primary', url }]);
  });
  it.each(['approved', 'rejected', 'cancelled'] as const)('makes a %s card terminal with no URL or callback', status => {
    const card = permissionRequestNotificationCard({ ...request(), status, reviewerName: '**合成审核人**', comment: '<at id=all> unchanged text' }, 'https://must-not-remain.invalid/') as any;
    const action = card.elements.at(-1).actions[0];
    expect(action.disabled).toBe(true); expect(action.url).toBeUndefined(); expect(action.value).toBeUndefined(); expect(action.behaviors).toBeUndefined();
    expect(JSON.stringify(card)).not.toContain('must-not-remain'); expect(card.elements[3].text.tag).toBe('plain_text');
  });
  it('renders actual requested page labels and action scopes instead of raw rule IDs', () => {
    expect(requestedPermissionText({ kind: 'page', path: '/monthly-schedule' })).toMatch(/页面查看：.+/);
    expect(requestedPermissionText({ kind: 'action', module: 'inventory', action: 'read', buildings: ['A楼'], specialties: null } as any)).toContain('楼栋：A楼');
  });
});
