import { mkdtempSync, readFileSync, writeFileSync, rmSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccessConfigurationService } from '../../server/common/access/access-configuration.service';
import type { ConfigurationState, StoredAccount } from '../../server/common/access/access-configuration.store';

describe('readonly recipient validation against real configuration and session rules', () => {
  const environment = process.env, appId = 'cli_synthetic_recipient', hash = 'a'.repeat(64), id = `feishu-${hash}`;
  const target = { appId, identityHash: hash, name: '合成接收人' };
  let directory: string, file: string, configuration: AccessConfigurationService, state: ConfigurationState;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'readonly-recipient-access-')); file = join(directory, 'configuration.json');
    process.env = { ...environment, ACCESS_CONFIGURATION_FILE: file, FEISHU_APP_ID: appId, FEISHU_ACCESS_APPROVED_GRANTS_ENABLED: 'false' };
    state = { schemaVersion: 1, revision: 0, legacySessionsRevoked: false, accounts: {}, cardRules: {}, audit: [], mutations: {} };
    const account: StoredAccount = { id, kind: 'feishu', appId, identityHash: hash, name: target.name, role: 'editor', building: null, enabled: true, deleted: false, version: 1, source: 'configuration' };
    state.accounts[id] = account; writeFileSync(file, JSON.stringify(state)); configuration = new AccessConfigurationService();
  });
  afterEach(() => { process.env = environment; rmSync(directory, { recursive: true, force: true }); });
  function legacy(): boolean {
    try {
      const matches = configuration.snapshot().accounts.filter(account => account.kind === 'feishu' && account.appId === appId && account.identityHash === hash && account.name === target.name && account.enabled && !account.deleted && !account.reactivationRequired && !account.permissionsRevoked && account.personnelActive !== false);
      return matches.length === 1 && !!configuration.currentPrincipal(matches[0].id, matches[0].version);
    } catch { return false; }
  }
  function save() { writeFileSync(file, JSON.stringify(state)); }
  it('matches the previous full response plus current principal with one fresh store read', () => {
    const read = jest.spyOn((configuration as any).store, 'read');
    expect(configuration.isCurrentReadonlyCardRecipient(target)).toBe(true); expect(read).toHaveBeenCalledTimes(1);
    expect(legacy()).toBe(true); expect(read).toHaveBeenCalledTimes(4);
  });
  it.each(['enabled', 'deleted', 'permissionsRevoked', 'reactivationRequired', 'personnelSuspended', 'name', 'appId', 'identityHash', 'siteMember', 'inactive', 'linkedInactive', 'loginBlocked', 'linkedLoginBlocked', 'personnelActive'])('keeps the existing rejection for %s', field => {
    const account = state.accounts[id];
    if (field === 'enabled') account.enabled = false;
    else if (field === 'personnelSuspended') { account.enabled = false; account.personnelSuspended = true; }
    else if (field === 'name') account.name = '合成其他人';
    else if (field === 'appId') account.appId = 'cli_other_app';
    else if (field === 'identityHash') account.identityHash = 'b'.repeat(64);
    else if (field === 'siteMember') account.role = 'site_member';
    else if (['inactive', 'linkedInactive', 'loginBlocked', 'linkedLoginBlocked'].includes(field)) {
      const linked = `local-external-${'b'.repeat(64)}`; account.personnelIdentity = linked;
      const key = field.startsWith('linked') ? linked : id;
      state.personnelEmployment = { appId, snapshotAt: Date.now(), inactive: field.toLowerCase().endsWith('inactive') ? { [key]: true } : {}, ...(field.toLowerCase().endsWith('blocked') ? { loginBlocked: { [key]: true } } : {}) };
    } else if (field === 'personnelActive') account.personnelActive = false;
    else (account as any)[field] = true;
    save(); expect(configuration.isCurrentReadonlyCardRecipient(target)).toBe(false); expect(legacy()).toBe(false);
  });
  it('preserves valid site-member and professional session conditions', () => {
    state.accounts[id].role = 'site_member'; state.accounts[id].siteMember = true; save();
    expect(configuration.isCurrentReadonlyCardRecipient(target)).toBe(legacy()); expect(legacy()).toBe(true);
    state.accounts[id].role = 'professional_admin'; state.accounts[id].specialties = ['电气']; save();
    expect(configuration.isCurrentReadonlyCardRecipient(target)).toBe(legacy()); expect(legacy()).toBe(true);
  });
  it('rejects ambiguous identity matches and missing accounts rather than selecting an arbitrary principal', () => {
    const read = jest.spyOn((configuration as any).store, 'read');
    read.mockReturnValue({ ...state, accounts: { [id]: state.accounts[id], duplicate: { ...state.accounts[id], id: 'duplicate' } } });
    expect(configuration.isCurrentReadonlyCardRecipient(target)).toBe(false); expect(legacy()).toBe(false);
    read.mockReturnValue({ ...state, accounts: {} });
    expect(configuration.isCurrentReadonlyCardRecipient(target)).toBe(false); expect(legacy()).toBe(false);
  });
  it('observes immediate revocation with identical file size and timestamp and fails closed on damage', () => {
    expect(configuration.isCurrentReadonlyCardRecipient(target)).toBe(true);
    const before = statSync(file), bytes = readFileSync(file, 'utf8');
    writeFileSync(file, bytes.replace('"deleted":false', '"deleted": true')); utimesSync(file, before.atime, before.mtime);
    expect(statSync(file).size).toBe(before.size);
    expect(configuration.isCurrentReadonlyCardRecipient(target)).toBe(false); expect(legacy()).toBe(false);
    writeFileSync(file, 'not-valid-json'); expect(configuration.isCurrentReadonlyCardRecipient(target)).toBe(false);
  });
  it('rejects a runtime app change without reusing the previous authorization result', () => {
    expect(configuration.isCurrentReadonlyCardRecipient(target)).toBe(true); process.env.FEISHU_APP_ID = 'cli_changed';
    expect(configuration.isCurrentReadonlyCardRecipient(target)).toBe(false); expect(legacy()).toBe(false);
  });
});
