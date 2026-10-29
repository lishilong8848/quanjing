import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { AccessConfigurationService } from '../../server/common/access/access-configuration.service';
import { AccessPersonnelSyncService } from '../../server/common/access/access-personnel-sync.service';
import { UnifiedAccessService, hashAccessPassword } from '../../server/common/access/unified-access.service';
import { buildExternalEmployeeCredentials } from '../../server/common/access/external-employee-directory';
import type { ConfigurationDirectorySnapshot } from '../../server/common/access/access-configuration.directory';

describe('new personnel login automatically synchronizes missing credentials', () => {
  const saved = { ...process.env };
  let root: string;
  let configuration: AccessConfigurationService;
  let source: ConfigurationDirectorySnapshot;
  let directory: { read: jest.Mock };
  let sync: AccessPersonnelSyncService;
  let access: UnifiedAccessService;
  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'nt-personnel-login-'));
    process.env.ACCESS_CONFIGURATION_FILE = join(root, 'accounts.json');
    process.env.FEISHU_APP_ID = 'cli_synthetic_login_sync';
    process.env.LOCAL_ACCESS_SESSION_SECRET = randomBytes(32).toString('base64');
    process.env.LOCAL_ADMIN_PASSWORD_HASH = hashAccessPassword('synthetic-admin-only');
    const externalEmployees = await buildExternalEmployeeCredentials([
      { record_id: 'recNewOne', fields: { 姓名: '新增验收人员甲', 密码: 'synthetic-member-only', '离职/异动情况': false } },
      { record_id: 'recNewTwo', fields: { 姓名: '新增验收人员乙', 密码: 'synthetic-member-only', '离职/异动情况': false } },
    ], process.env.FEISHU_APP_ID, 'synthetic-base', 'tblSynthetic');
    source = { appId: process.env.FEISHU_APP_ID, people: [], employees: [], snapshotAt: Date.now(), personnelComplete: true,
      credentialsComplete: true, externalEmployees,
      activeMembers: externalEmployees.map(person => ({ name: person.name, passwordAccountId: person.id })),
      activeMembersComplete: true,
      employmentState: { complete: true, entries: externalEmployees.map(person => ({ personnelIdentity: person.id, inactive: false })) } };
    configuration = new AccessConfigurationService();
    directory = { read: jest.fn(async () => structuredClone(source)) };
    sync = new AccessPersonnelSyncService(configuration, directory as never);
    access = new UnifiedAccessService(configuration, sync);
  });
  afterEach(async () => {
    jest.useRealTimers();
    await sync.onModuleDestroy();
    process.env = { ...saved };
    rmSync(root, { recursive: true, force: true });
  });
  const login = (name = '新增验收人员甲', password = 'synthetic-member-only') => access.login({ employeeName: name, password }, 'synthetic-source');

  it('syncs a new active employee on first login and retains stable account/version on later login', async () => {
    const result = await login();
    expect(result.principal).toMatchObject({ role: 'site_member', displayName: '新增验收人员甲' });
    expect(directory.read).toHaveBeenCalledWith(true);
    const version = configuration.snapshot().revision;
    await expect(login()).resolves.toMatchObject({ principal: { accountId: result.principal.accountId } });
    expect(directory.read).toHaveBeenCalledTimes(1);
    expect(configuration.snapshot().revision).toBe(version);
    expect(readFileSync(process.env.ACCESS_CONFIGURATION_FILE!, 'utf8')).not.toContain('synthetic-member-only');
  });

  it('creates the initial identity-suffix credential during first login without persisting the identity number', async () => {
    const identity = '11010519491231002X'; // Public synthetic validation fixture, never a live employee identity.
    const initial = await buildExternalEmployeeCredentials([{ record_id: 'recNewOne', fields: {
      姓名: '新增验收人员甲', 密码: '', 身份证号: identity, '离职/异动情况': false,
    } }], process.env.FEISHU_APP_ID!, 'synthetic-base', 'tblSynthetic');
    source.externalEmployees![0] = initial[0];
    await expect(login(undefined, identity.slice(-6))).resolves.toMatchObject({ principal: { role: 'site_member', displayName: '新增验收人员甲' } });
    await expect(login(undefined, 'wrong-six')).rejects.toThrow('登录凭据无效');
    expect(directory.read).toHaveBeenCalledTimes(1);
    const disk = readFileSync(process.env.ACCESS_CONFIGURATION_FILE!, 'utf8');
    expect(disk).not.toContain(identity);
    expect(disk).not.toContain(identity.slice(-6));
  });

  it('joins two missing-person requests into one source read', async () => {
    const results = await Promise.all([login(), login('新增验收人员乙')]);
    expect(directory.read).toHaveBeenCalledTimes(1);
    expect(results[0].principal.accountId).not.toBe(results[1].principal.accountId);
  });

  it('never fetches personnel for an existing account with a wrong password', async () => {
    await configuration.synchronizePersonnel(source);
    await expect(login(undefined, 'wrong-password')).rejects.toThrow('登录凭据无效');
    expect(directory.read).not.toHaveBeenCalled();
  });

  it('limits unknown-name refreshes across different names to one per minute', async () => {
    await expect(login('不存在甲')).rejects.toThrow('登录凭据无效');
    await expect(login('不存在乙')).rejects.toThrow('登录凭据无效');
    expect(directory.read).toHaveBeenCalledTimes(1);
  });

  it('does not let missing-person source waits occupy the existing-account password verification slots', async () => {
    await configuration.synchronizePersonnel(source);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    directory.read.mockImplementation(async () => { await gate; return structuredClone(source); });
    const first = expect(login('未同步甲')).rejects.toThrow('登录凭据无效');
    const second = expect(login('未同步乙')).rejects.toThrow('登录凭据无效');
    await expect(login('未同步丙')).rejects.toMatchObject({ status: 429 });
    try { await expect(login()).resolves.toMatchObject({ principal: { displayName: '新增验收人员甲' } }); }
    finally { release(); }
    await Promise.all([first, second]);
    expect(directory.read).toHaveBeenCalledTimes(1);
  });

  it('keeps a manually disabled account disabled when missing-target login refreshes', async () => {
    await configuration.synchronizePersonnel(source);
    const account = configuration.snapshot().accounts.find(person => person.name === '新增验收人员甲')!;
    const actor = configuration.localTargets().find(target => target.principal.role === 'admin')!.principal;
    await configuration.saveAccount({ clientMutationId: 'disable-synthetic-member', expectedRevision: configuration.snapshot().revision,
      id: account.id, kind: 'local', name: account.name, role: account.role, building: null, enabled: false }, actor);
    await expect(login()).rejects.toThrow('登录凭据无效');
    expect(configuration.snapshot().accounts.find(person => person.id === account.id)?.enabled).toBe(false);
  });

  it('does not restore a departed employee through automatic refresh', async () => {
    await configuration.synchronizePersonnel(source);
    const session = await login();
    const departed = structuredClone(source);
    departed.employmentState!.entries[0].inactive = true;
    await configuration.synchronizePersonnel(departed);
    await expect(login()).rejects.toThrow('登录凭据无效');
    expect(access.readSession(session.token).expiresAt).toBeNull();
  });

  it('preserves existing credentials when the source fails and makes the retry message explicit', async () => {
    await configuration.synchronizePersonnel(source);
    directory.read.mockRejectedValue(new Error('synthetic outage'));
    await expect(login('新资料未就绪')).rejects.toThrow('人员登录资料');
    await expect(login()).resolves.toBeDefined();
    expect(directory.read).toHaveBeenCalledTimes(1);
  });

  it('records credential-source failure as a retryable sync error without clearing saved credentials', async () => {
    await configuration.synchronizePersonnel(source);
    const previous = configuration.employeeTargets('新增验收人员甲');
    await configuration.synchronizePersonnel({ ...source, externalEmployees: undefined, credentialsComplete: false });
    expect(configuration.snapshot().personnelSync).toMatchObject({ status: 'error', error: expect.stringContaining('姓名登录资料') });
    expect(configuration.employeeTargets('新增验收人员甲')).toEqual(previous);
    await expect(login()).resolves.toBeDefined();
  });
});

it('bounds one login wait at eight seconds without cancelling the shared synchronization', async () => {
  jest.useFakeTimers();
  let finish!: (value: unknown) => void;
  const synchronization = new Promise<unknown>(resolve => { finish = resolve; });
  const configuration = {
    beginPersonnelSyncAttempt: jest.fn(async () => undefined),
    synchronizePersonnel: jest.fn(async () => ({ personnelSync: { status: 'success' } })),
    recordPersonnelSyncError: jest.fn(),
  };
  const directory = { read: jest.fn(() => synchronization) };
  const service = new AccessPersonnelSyncService(configuration as never, directory as never);
  try {
    const waiting = service.refreshForLogin();
    const rejected = expect(waiting).rejects.toThrow('人员登录资料正在同步');
    await jest.advanceTimersByTimeAsync(8_000);
    await rejected;
    expect(configuration.synchronizePersonnel).not.toHaveBeenCalled();
    finish({ personnelComplete: true });
    await service.onModuleDestroy();
    expect(configuration.synchronizePersonnel).toHaveBeenCalledTimes(1);
  } finally { jest.useRealTimers(); }
});
