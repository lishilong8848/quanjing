import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pbkdf2Sync } from 'node:crypto';
import { PersonnelCredentialsService } from '../../server/common/access/personnel-credentials.service';
import { PersonnelSecurityStore, personnelFingerprint } from '../../server/common/access/personnel-security.store';
import { parsePersonnelPasswordHash, verifyPersonnelPassword } from '../../server/common/access/personnel-password';
import { createAccessPasswordHash } from '../../server/common/access/access-password';
import type { PersonnelCredentialRecord } from '../../server/common/access/personnel-credentials.gateway';
import type { StoredAccount } from '../../server/common/access/access-configuration.store';
import type { AccessPrincipal } from '../../shared/access-control.interface';

const IDENTITY = '11010519491231002X'; // Public checksum example; synthetic test identity only.
const ACCOUNT_ID = 'local-external-' + 'a'.repeat(64);
const FORMAL_PASSWORD = '  safe password  ';
const hash = (password: string) => {
  const salt = Buffer.alloc(16, 3);
  return `pbkdf2_sha256$600000$${salt.toString('base64')}$${pbkdf2Sync(password, salt, 600000, 32, 'sha256').toString('base64')}`;
};
let formalHash: string;
beforeAll(() => { formalHash = hash(FORMAL_PASSWORD); });

describe('personnel credential lifecycle with isolated source/configuration', () => {
  let directory: string, store: PersonnelSecurityStore, service: PersonnelCredentialsService;
  let account: StoredAccount, record: PersonnelCredentialRecord, gateway: any, configuration: any;
  let previousSecret: string | undefined;
  const principal = (): AccessPrincipal => ({ accountId: ACCOUNT_ID, displayName: '测试人员', role: 'guest', purchaseBuilding: null, authorizationVersion: account.version });
  const change = (overrides: Record<string, unknown> = {}) => ({ currentPassword: '31002x', newPassword: 'my new password', confirmPassword: 'my new password', clientMutationId: 'mutation_12345678', ...overrides });
  const reset = (overrides: Record<string, unknown> = {}) => ({ employeeName: '测试人员', identityNumber: IDENTITY, newPassword: 'my new password', confirmPassword: 'my new password', clientMutationId: 'reset_123456789', ...overrides });

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'personnel-credentials-'));
    previousSecret = process.env.LOCAL_ACCESS_SESSION_SECRET;
    process.env.LOCAL_ACCESS_SESSION_SECRET = Buffer.alloc(32, 7).toString('base64');
    account = { id: ACCOUNT_ID, name: '测试人员', kind: 'local', role: 'guest', building: null, version: 4, enabled: true,
      deleted: false, source: 'configuration', personnelActive: true, loginMethod: 'personnel-password', personnelAppId: 'cliTest',
      passwordHash: await createAccessPasswordHash('31002X') };
    record = { appId: 'cliTest', appToken: 'bascnTestSource0001', tableId: 'tblSource1', recordId: 'recTest1', accountId: ACCOUNT_ID,
      name: '测试人员', identityNumber: IDENTITY, password: '', token: 'mock-only-token' };
    store = new PersonnelSecurityStore(join(directory, 'security.json'));
    gateway = {
      findActive: jest.fn(async () => ({ ...record })), fresh: jest.fn(async () => ({ ...record })),
      writePassword: jest.fn(async (_record, newHash) => { record.password = newHash; }),
    };
    const committed = new Map<string, string>();
    configuration = {
      getPersonnelCredentialAccount: jest.fn((id) => id === account.id ? { ...account } : null),
      personnelCredentialEligible: jest.fn(() => true),
      currentPrincipal: jest.fn((id, version) => id === account.id && version === account.version ? principal() : undefined),
      commitPersonnelPassword: jest.fn(async (id, expected, newHash, mutation) => {
        if (id !== account.id) throw new Error('identity');
        if (!committed.has(mutation)) {
          if (expected !== account.passwordHash) throw new Error('conflict');
          account.passwordHash = newHash; account.version++; committed.set(mutation, newHash);
        } else if (committed.get(mutation) !== newHash) throw new Error('idempotency conflict');
        return principal();
      }),
    };
    service = new PersonnelCredentialsService({} as any, configuration, store, gateway);
  });
  afterEach(() => {
    if (previousSecret === undefined) delete process.env.LOCAL_ACCESS_SESSION_SECRET;
    else process.env.LOCAL_ACCESS_SESSION_SECRET = previousSecret;
    rmSync(directory, { recursive: true, force: true });
  });

  it('verifies the initial identity suffix from fresh source, supports X/trim, and persists a restricted-login marker', async () => {
    const result = await service.authenticateLogin(principal(), ' 31002x ');
    expect(result.accountId).toBe(ACCOUNT_ID);
    expect(service.requiresPasswordChange(result)).toBe(true);
    const restarted = new PersonnelCredentialsService({} as any, configuration, new PersonnelSecurityStore(store.filePath), gateway);
    expect(restarted.requiresPasswordChange(result)).toBe(true);
    expect(gateway.writePassword).not.toHaveBeenCalled();
  });
  it('keeps the shared recovery administrator independent of a corrupted personnel-only ledger', () => {
    writeFileSync(store.filePath, '{broken');
    configuration.getPersonnelCredentialAccount.mockImplementation((id: string) => id === ACCOUNT_ID ? account :
      { ...account, id: 'local-admin-all', role: 'admin', loginMethod: undefined, personnelIdentity: undefined });
    expect(() => service.requiresPasswordChange(principal())).toThrow('安全状态');
    expect(service.requiresPasswordChange({ accountId: 'local-admin-all', role: 'admin', purchaseBuilding: null })).toBe(false);
  });

  it('does not treat a malformed nonempty encoded password as the initial password', async () => {
    record.password = 'pbkdf2_sha256$broken';
    await expect(service.authenticateLogin(principal(), '31002X')).rejects.toThrow('登录凭据无效');
    expect(configuration.commitPersonnelPassword).not.toHaveBeenCalled();
  });

  it('rejects the old local password and synchronizes a valid password changed by another project', async () => {
    record.password = formalHash;
    await expect(service.authenticateLogin(principal(), '31002X')).rejects.toThrow('登录凭据无效');
    const result = await service.authenticateLogin(principal(), FORMAL_PASSWORD);
    expect(account.passwordHash).toBe(formalHash);
    expect(result.authorizationVersion).toBe(5);
    expect(service.requiresPasswordChange(result)).toBe(false);
    expect(gateway.writePassword).not.toHaveBeenCalled();
    await expect(service.authenticateLogin(result, FORMAL_PASSWORD.trim())).rejects.toThrow('登录凭据无效');
  });

  it('keeps existing non-six-character plaintext sources compatible without writing them back', async () => {
    record.password = 'Existing raw password';
    const result = await service.authenticateLogin(principal(), record.password);
    expect(result.accountId).toBe(ACCOUNT_ID);
    expect(account.passwordHash).toMatch(/^scrypt\$/);
    expect(service.requiresPasswordChange(result)).toBe(false);
    expect(gateway.writePassword).not.toHaveBeenCalled();
  });

  it('forces change for an existing suffix and rejects unrelated six-character plaintext credentials', async () => {
    record.password = '31002X';
    await service.checkLogin(principal(), '31002x');
    expect(service.requiresPasswordChange(principal())).toBe(true);
    record.password = '777777';
    await expect(service.checkLogin(principal(), '777777')).rejects.toThrow('登录凭据无效');
    expect(service.requiresPasswordChange(principal())).toBe(true);
  });

  it('rejects disabled, deleted, inactive, reactivation-pending and impersonated principals before source writes', async () => {
    for (const flag of ['deleted', 'reactivationRequired', 'personnelSuspended']) {
      (account as any)[flag] = true;
      await expect(service.changePassword(principal(), change())).rejects.toThrow('不可修改');
      (account as any)[flag] = false;
    }
    for (const flag of ['enabled', 'personnelActive']) {
      (account as any)[flag] = false;
      await expect(service.changePassword(principal(), change())).rejects.toThrow('不可修改');
      (account as any)[flag] = true;
    }
    await expect(service.changePassword({ ...principal(), impersonation: { actorAccountId: 'admin', actorName: '管理员', targetName: account.name, expiresAt: Date.now() + 10000 } }, change())).rejects.toThrow('不可修改');
    expect(gateway.findActive).not.toHaveBeenCalled();
  });

  it('rejects a same-name source record with a different stable identity', async () => {
    record.accountId = 'local-external-' + 'b'.repeat(64);
    await expect(service.changePassword(principal(), change())).rejects.toThrow('登录凭据无效');
    expect(gateway.writePassword).not.toHaveBeenCalled();
  });

  it('changes a password to a fresh PBKDF2 hash, preserves permissions and keeps secrets out of the ledger', async () => {
    record.password = '31002X';
    account.personalRules = [{ module: 'inventory', actions: ['read'], effect: 'deny' }] as any;
    const old = principal();
    const result = await service.changePassword(old, change({ newPassword: FORMAL_PASSWORD, confirmPassword: FORMAL_PASSWORD }));
    expect(result.authorizationVersion).toBe(old.authorizationVersion! + 1);
    expect(parsePersonnelPasswordHash(record.password)).not.toBeNull();
    expect(record.password.split('$')[2]).toMatch(/^[A-Za-z0-9_-]{22}==$/);
    expect(record.password.split('$')[3]).toMatch(/^[A-Za-z0-9_-]{43}=$/);
    expect(await verifyPersonnelPassword(FORMAL_PASSWORD, record.password)).toBe(true);
    expect(await verifyPersonnelPassword(FORMAL_PASSWORD.trim(), record.password)).toBe(false);
    expect(account.personalRules).toEqual([{ module: 'inventory', actions: ['read'], effect: 'deny' }]);
    expect(service.requiresPasswordChange(result)).toBe(false);
    const saved = readFileSync(store.filePath, 'utf8');
    for (const raw of [IDENTITY, FORMAL_PASSWORD, '31002x', '测试人员', 'mock-only-token']) expect(saved).not.toContain(raw);
    expect(Object.values(store.read().intents)[0].status).toBe('completed');
    expect(Object.values(store.read().intents)[0].previousSourceFingerprint).not.toBe(personnelFingerprint('31002X'));
  });

  it('persists intent before any external write and recovers a successful timed-out write by reading it back', async () => {
    gateway.writePassword.mockImplementationOnce(async (_record, newHash) => {
      expect(Object.values(store.read().intents)[0]).toMatchObject({ status: 'prepared', newHash });
      record.password = newHash;
      throw { response: { data: 'secret-upstream-data' } };
    });
    await service.changePassword(principal(), change());
    expect(gateway.writePassword).toHaveBeenCalledTimes(1);
    expect(configuration.commitPersonnelPassword).toHaveBeenCalledTimes(1);
  });

  it('replays the same completed mutation without another source write or audit', async () => {
    const request = change();
    await service.changePassword(principal(), request);
    await service.changePassword(principal(), request);
    expect(gateway.writePassword).toHaveBeenCalledTimes(1);
    expect(configuration.commitPersonnelPassword).toHaveBeenCalledTimes(1);
    await expect(service.changePassword(principal(), change({ newPassword: 'different password', confirmPassword: 'different password' }))).rejects.toThrow('不同内容');
  });

  it('recovers after source success and local commit failure without repeating PUT', async () => {
    const commit = configuration.commitPersonnelPassword.getMockImplementation();
    configuration.commitPersonnelPassword.mockImplementationOnce(async () => { throw new Error('simulated local conflict'); });
    await expect(service.changePassword(principal(), change())).rejects.toThrow('simulated local conflict');
    expect(Object.values(store.read().intents)[0].status).toBe('written');
    configuration.commitPersonnelPassword.mockImplementation(commit);
    await service.changePassword(principal(), change());
    expect(gateway.writePassword).toHaveBeenCalledTimes(1);
  });

  it('allows a fresh login with the new password to finish an interrupted local commit', async () => {
    const commit = configuration.commitPersonnelPassword.getMockImplementation();
    configuration.commitPersonnelPassword.mockImplementationOnce(async () => { throw new Error('simulated interrupted commit'); });
    await expect(service.changePassword(principal(), change())).rejects.toThrow('interrupted');
    configuration.commitPersonnelPassword.mockImplementation(commit);
    const result = await service.authenticateLogin(principal(), change().newPassword);
    expect(result.authorizationVersion).toBe(5);
    expect(Object.values(store.read().intents)[0].status).toBe('completed');
    expect(gateway.writePassword).toHaveBeenCalledTimes(1);
    expect(configuration.commitPersonnelPassword.mock.calls.at(-1)[3]).toBe(change().clientMutationId);
  });

  it('recovers an interrupted intent after service restart without retaining raw credentials', async () => {
    gateway.fresh.mockImplementationOnce(async () => ({ ...record }));
    gateway.fresh.mockRejectedValueOnce(new Error('read-back timeout'));
    await expect(service.changePassword(principal(), change())).rejects.toThrow('read-back timeout');
    const restarted = new PersonnelCredentialsService({} as any, configuration, new PersonnelSecurityStore(store.filePath), gateway);
    await restarted.changePassword(principal(), change());
    expect(gateway.writePassword).toHaveBeenCalledTimes(1);
    expect(configuration.commitPersonnelPassword).toHaveBeenCalledTimes(1);
  });

  it('uses the server secret, not the visible new hash, to authenticate a replay fingerprint', async () => {
    gateway.writePassword.mockRejectedValueOnce(new Error('timeout'));
    await expect(service.changePassword(principal(), change())).rejects.toThrow('尚未确认');
    process.env.LOCAL_ACCESS_SESSION_SECRET = Buffer.alloc(32, 9).toString('base64');
    await expect(service.changePassword(principal(), change())).rejects.toThrow('不同内容');
    expect(gateway.writePassword).toHaveBeenCalledTimes(1);
  });

  it('uses explicit Feishu personnelIdentity bindings and returns that refreshed principal', async () => {
    const feishu: StoredAccount = { ...account, id: 'feishu-' + 'b'.repeat(64), kind: 'feishu', appId: 'cliTest', personnelIdentity: ACCOUNT_ID };
    configuration.getPersonnelCredentialAccount.mockImplementation(id => id === feishu.id ? { ...feishu } : id === account.id ? { ...account } : null);
    configuration.currentPrincipal.mockImplementation((id, version) => id === feishu.id && version === feishu.version
      ? { ...principal(), accountId: feishu.id, authorizationVersion: feishu.version }
      : id === account.id && version === account.version ? principal() : undefined);
    const originalCommit = configuration.commitPersonnelPassword.getMockImplementation();
    configuration.commitPersonnelPassword.mockImplementation(async (...args) => { const result = await originalCommit(...args); feishu.version++; return result; });
    const feishuPrincipal = { ...principal(), accountId: feishu.id, authorizationVersion: feishu.version };
    expect(await service.profile(feishuPrincipal)).toEqual({ canChangePassword: true, requiresPasswordChange: false });
    const result = await service.changePassword(feishuPrincipal, change());
    expect(result.accountId).toBe(feishu.id);
    expect(result.authorizationVersion).toBe(5);
    expect(configuration.commitPersonnelPassword.mock.calls[0][0]).toBe(ACCOUNT_ID);
    delete feishu.personnelIdentity;
    expect(await service.profile({ ...result, authorizationVersion: feishu.version })).toEqual({ canChangePassword: false, requiresPasswordChange: false });
  });

  it('keeps an unresolved intent, blocks a different mutation, and permits the original retry', async () => {
    gateway.writePassword.mockRejectedValueOnce(new Error('timeout'));
    await expect(service.changePassword(principal(), change())).rejects.toThrow('尚未确认');
    await expect(service.changePassword(principal(), change({ clientMutationId: 'another_mutation_123' }))).rejects.toThrow('原请求');
    await service.changePassword(principal(), change());
    expect(configuration.commitPersonnelPassword).toHaveBeenCalledTimes(1);
  });

  it('retains source conflicts and never overwrites a concurrent password', async () => {
    gateway.fresh.mockImplementationOnce(async () => ({ ...record, password: 'someone else changed it' }));
    await expect(service.changePassword(principal(), change())).rejects.toThrow('来源已变化');
    expect(Object.values(store.read().intents)[0].status).toBe('conflict');
    expect(gateway.writePassword).not.toHaveBeenCalled();
  });

  it.each([
    { newPassword: 'short', confirmPassword: 'short' },
    { newPassword: ' long enough ', confirmPassword: 'long enough' },
    { newPassword: IDENTITY, confirmPassword: IDENTITY },
    { newPassword: 'x'.repeat(129), confirmPassword: 'x'.repeat(129) },
  ])('rejects invalid new passwords before writing (%j)', async (values) => {
    await expect(service.changePassword(principal(), change(values))).rejects.toThrow();
    expect(gateway.writePassword).not.toHaveBeenCalled();
  });

  it('accepts eight plain letters as the configured policy does not impose character classes', async () => {
    await service.changePassword(principal(), change({ newPassword: 'abcdefgh', confirmPassword: 'abcdefgh' }));
    expect(await verifyPersonnelPassword('abcdefgh', record.password)).toBe(true);
  });

  it('rejects the current formal password even when source and local hashes differ', async () => {
    record.password = formalHash;
    await expect(service.changePassword(principal(), change({ currentPassword: FORMAL_PASSWORD, newPassword: FORMAL_PASSWORD, confirmPassword: FORMAL_PASSWORD }))).rejects.toThrow('当前密码');
    expect(gateway.writePassword).not.toHaveBeenCalled();
  });

  it('uses full identity checksum, active-source identity, and local eligibility for reset with a generic failure', async () => {
    await expect(service.resetPassword(reset({ identityNumber: '110105194912310020' }), '192.0.2.1')).rejects.toThrow('人员身份核验未通过');
    gateway.findActive.mockResolvedValueOnce(null);
    await expect(service.resetPassword(reset(), '192.0.2.1')).rejects.toThrow('人员身份核验未通过');
    configuration.personnelCredentialEligible.mockReturnValueOnce(false);
    await expect(service.resetPassword(reset(), '192.0.2.1')).rejects.toThrow('人员身份核验未通过');
    expect(gateway.writePassword).not.toHaveBeenCalled();
    await service.resetPassword(reset(), '192.0.2.1');
    expect(gateway.writePassword).toHaveBeenCalledTimes(1);
  });

  it('does not create accounts during forgotten-password reset', async () => {
    configuration.getPersonnelCredentialAccount.mockReturnValue(null);
    await expect(service.resetPassword(reset(), '192.0.2.1')).rejects.toThrow('人员身份核验未通过');
    expect(configuration.commitPersonnelPassword).not.toHaveBeenCalled();
  });

  it('recovers an unwritten prior change after losing its mutation ID, and rejects the old request afterward', async () => {
    const old = change();
    gateway.writePassword.mockRejectedValueOnce(new Error('timeout without confirmed write'));
    await expect(service.changePassword(principal(), old)).rejects.toThrow('尚未确认');
    const oldKey = personnelFingerprint(`${ACCOUNT_ID}\0${old.clientMutationId}`);
    expect(store.read().intents[oldKey].status).toBe('prepared');
    const replacement = reset({ newPassword: 'replacement password', confirmPassword: 'replacement password' });
    await service.resetPassword(replacement, '192.0.2.1');
    expect(store.read().intents[oldKey].status).toBe('conflict');
    expect(await verifyPersonnelPassword(replacement.newPassword, record.password)).toBe(true);
    const written = record.password;
    await expect(service.changePassword(principal(), old)).rejects.toThrow('来源已变化');
    expect(record.password).toBe(written);
    expect(configuration.commitPersonnelPassword).toHaveBeenCalledTimes(1);
    expect(gateway.writePassword).toHaveBeenCalledTimes(2);
  });

  it.each(['prepared', 'written'] as const)('finishes a remotely written %s intent before a new verified reset', async status => {
    const old = change();
    if (status === 'prepared') {
      gateway.fresh.mockImplementationOnce(async () => ({ ...record }));
      gateway.fresh.mockRejectedValueOnce(new Error('read-back unavailable'));
      await expect(service.changePassword(principal(), old)).rejects.toThrow('read-back unavailable');
    } else {
      configuration.commitPersonnelPassword.mockRejectedValueOnce(new Error('local commit interrupted'));
      await expect(service.changePassword(principal(), old)).rejects.toThrow('local commit interrupted');
    }
    const oldKey = personnelFingerprint(`${ACCOUNT_ID}\0${old.clientMutationId}`), oldHash = record.password;
    expect(store.read().intents[oldKey].status).toBe(status);
    const replacement = reset({ newPassword: 'replacement password', confirmPassword: 'replacement password' });
    await service.resetPassword(replacement, '192.0.2.1');
    expect(store.read().intents[oldKey].status).toBe('completed');
    expect(configuration.commitPersonnelPassword.mock.calls.slice(-2).map(call => [call[2], call[3]])).toEqual([
      [oldHash, old.clientMutationId], [record.password, replacement.clientMutationId],
    ]);
    expect(account.version).toBe(6);
    expect(gateway.writePassword).toHaveBeenCalledTimes(2);
    const written = record.password;
    await expect(service.changePassword(principal(), old)).rejects.toThrow();
    expect(record.password).toBe(written);
    expect(await verifyPersonnelPassword(replacement.newPassword, written)).toBe(true);
  });

  it('uses a third-party source change as the baseline for verified reset without restoring the stale intent', async () => {
    const old = change();
    gateway.writePassword.mockRejectedValueOnce(new Error('unconfirmed write'));
    await expect(service.changePassword(principal(), old)).rejects.toThrow('尚未确认');
    record.password = formalHash;
    const replacement = reset({ newPassword: 'replacement password', confirmPassword: 'replacement password' });
    await service.resetPassword(replacement, '192.0.2.1');
    expect(store.read().intents[personnelFingerprint(`${ACCOUNT_ID}\0${old.clientMutationId}`)].status).toBe('conflict');
    expect(configuration.commitPersonnelPassword).toHaveBeenCalledTimes(1);
    expect(await verifyPersonnelPassword(replacement.newPassword, record.password)).toBe(true);
    expect(gateway.writePassword.mock.calls[1][0].password).toBe(formalHash);
  });

  it('does not terminate a pending change on forged identity, disabled account, or failed fresh read', async () => {
    gateway.writePassword.mockRejectedValueOnce(new Error('unconfirmed write'));
    await expect(service.changePassword(principal(), change())).rejects.toThrow('尚未确认');
    const before = readFileSync(store.filePath, 'utf8');
    await expect(service.resetPassword(reset({ identityNumber: '110105194912310020' }), '192.0.2.1')).rejects.toThrow('身份核验');
    gateway.findActive.mockResolvedValueOnce({ ...record, identityNumber: '110105194912310011' });
    await expect(service.resetPassword(reset(), '192.0.2.1')).rejects.toThrow('身份核验');
    account.enabled = false;
    await expect(service.resetPassword(reset(), '192.0.2.1')).rejects.toThrow('身份核验');
    account.enabled = true;
    gateway.fresh.mockRejectedValueOnce(new Error('source unreadable'));
    await expect(service.resetPassword(reset(), '192.0.2.1')).rejects.toThrow('source unreadable');
    expect(readFileSync(store.filePath, 'utf8')).toBe(before);
    expect(gateway.writePassword).toHaveBeenCalledTimes(1);
    expect(configuration.commitPersonnelPassword).not.toHaveBeenCalled();
  });

  it('keeps account serialization while a verified reset waits for an in-flight prior write', async () => {
    let releaseWrite!: () => void, markEntered!: () => void;
    const entered = new Promise<void>(resolve => { markEntered = resolve; });
    const gate = new Promise<void>(resolve => { releaseWrite = resolve; });
    gateway.writePassword.mockImplementationOnce(async (_record, newHash) => {
      markEntered(); await gate; record.password = newHash;
    });
    const old = change(), active = service.changePassword(principal(), old);
    await entered;
    const replacement = reset({ newPassword: 'replacement password', confirmPassword: 'replacement password' });
    const resetting = service.resetPassword(replacement, '192.0.2.1');
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(gateway.writePassword).toHaveBeenCalledTimes(1);
    expect(configuration.commitPersonnelPassword).not.toHaveBeenCalled();
    releaseWrite();
    await Promise.all([active, resetting]);
    expect(gateway.writePassword).toHaveBeenCalledTimes(2);
    expect(configuration.commitPersonnelPassword.mock.calls.map(call => call[3])).toEqual([old.clientMutationId, replacement.clientMutationId]);
    expect(await verifyPersonnelPassword(replacement.newPassword, record.password)).toBe(true);
    expect(account.version).toBe(6);
  });

  it('does not let a completed reset replay terminate a newer unresolved change', async () => {
    const completed = reset();
    await service.resetPassword(completed, '192.0.2.1');
    const newer = change({ currentPassword: completed.newPassword, newPassword: 'another new password',
      confirmPassword: 'another new password', clientMutationId: 'newer_change_123456' });
    gateway.writePassword.mockRejectedValueOnce(new Error('unconfirmed newer write'));
    await expect(service.changePassword(principal(), newer)).rejects.toThrow('尚未确认');
    const newerKey = personnelFingerprint(`${ACCOUNT_ID}\0${newer.clientMutationId}`);
    await service.resetPassword(completed, '192.0.2.1');
    expect(store.read().intents[newerKey].status).toBe('prepared');
    expect(gateway.writePassword).toHaveBeenCalledTimes(2);
    expect(configuration.commitPersonnelPassword).toHaveBeenCalledTimes(1);
  });

  it('rate limits by employee name even across different IP addresses', async () => {
    gateway.findActive.mockResolvedValue(null);
    for (let i = 0; i < 8; i++) await expect(service.resetPassword(reset(), `192.0.2.${i}`)).rejects.toThrow('身份核验');
    await expect(service.resetPassword(reset(), '192.0.2.90')).rejects.toMatchObject({ status: 429 });
    expect(gateway.findActive).toHaveBeenCalledTimes(8);
  });

  it('limits failed logins by account across IPs, including fresh source lookup failures', async () => {
    for (let i = 0; i < 10; i++) await expect(service.authenticateLogin(principal(), 'wrong', `192.0.2.${i}`)).rejects.toThrow('登录凭据无效');
    await expect(service.authenticateLogin(principal(), '31002X', '192.0.2.100')).rejects.toMatchObject({ status: 429 });
    expect(gateway.findActive).toHaveBeenCalledTimes(10);
  });

  it('clears only the successful account failure bucket, leaving the IP budget intact', async () => {
    for (let batch = 0; batch < 5; batch++) {
      for (let i = 0; i < 8; i++) await expect(service.authenticateLogin(principal(), 'wrong', '192.0.2.1')).rejects.toThrow('登录凭据无效');
      if (batch < 4) await service.authenticateLogin(principal(), '31002X', '192.0.2.1');
    }
    await expect(service.authenticateLogin(principal(), '31002X', '192.0.2.1')).rejects.toMatchObject({ status: 429 });
    expect(gateway.findActive).toHaveBeenCalledTimes(44);
  });

  it('limits all concurrent source verification tasks to two', async () => {
    let active = 0, max = 0;
    gateway.findActive.mockImplementation(async () => {
      active++; max = Math.max(max, active);
      await new Promise(resolve => setTimeout(resolve, 10)); active--;
      return null;
    });
    await Promise.allSettled(Array.from({ length: 6 }, (_, i) => service.resetPassword(reset({ employeeName: `测试${i}` }), '192.0.2.1')));
    expect(max).toBe(2);
  });

  it('fails closed on corrupted, unknown-version or removed security state', async () => {
    store.update(state => { state.accounts[ACCOUNT_ID] = { requiresPasswordChange: true, updatedAt: Date.now() }; });
    const saved = readFileSync(store.filePath, 'utf8');
    for (const bad of ['{}', saved.replace('"version":1', '"version":2'), saved.replace('"revision":1', '"revision":1,"password":"secret"')]) {
      writeFileSync(store.filePath, bad);
      expect(() => service.requiresPasswordChange(principal())).toThrow('安全状态');
    }
    writeFileSync(store.filePath, saved);
    expect(service.requiresPasswordChange(principal())).toBe(true);
    rmSync(store.filePath);
    expect(() => service.requiresPasswordChange(principal())).toThrow('安全状态');
  });
});
