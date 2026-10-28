import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as stores from '../../server/common/access/access-configuration.store';
import * as defaults from '../../server/common/access/access-configuration.defaults';
import { AccessConfigurationService } from '../../server/common/access/access-configuration.service';
import { authorizationMigrationPreview, captureIndependentAuthorization, migrateAuthorizationState } from '../../server/common/access/authorization-profile.configuration';
import { legacyAuthorizationOverrides, legacyAuthorizationPolicy, legacyScopedReadAllowed } from '../../server/common/access/legacy-authorization-migration';
import { feishuIdentityFingerprint } from '../../server/common/access/feishu-access-approved-grants';
import { BUILDING_ADMIN_BUILDINGS, type AccessPrincipal } from '../../shared/access-control.interface';
import { PROFESSIONAL_SPECIALTIES } from '../../shared/professional-access';
import { createBusinessPermissionEvaluator, type PersonalPermissionRule } from '../../shared/business-permissions';
import { classifyBusinessRequest } from '../../shared/business-request-permission';
import { effectivePagePaths, pageApiBinding, type RolePageRules } from '../../shared/page-access';

describe('V1 authorization migration preserves real scoped reads and page restrictions', () => {
  const appId = 'cli_migration_synthetic', openId = 'ou_migration_synthetic';
  let directory: string, store: stores.AccessConfigurationStore;
  const rule = (extra: Partial<PersonalPermissionRule> = {}): PersonalPermissionRule => ({ id: 'original-equipment-A', module: 'equipment_ledger',
    actions: ['read'], effect: 'allow', buildings: ['A楼'], specialties: ['电气'], ...extra });
  const account = (extra: Partial<stores.StoredAccount> = {}): stores.StoredAccount => ({
    id: `feishu-${feishuIdentityFingerprint(appId, openId)}`, kind: 'feishu', name: '合成迁移人员', role: 'site_member', building: null,
    enabled: true, deleted: false, version: 7, source: 'configuration', appId, openId, identityHash: feishuIdentityFingerprint(appId, openId),
    personalRules: [rule()], pagePaths: ['/equipment-ledger-management'], ...extra,
  });
  const state = (value: stores.StoredAccount, rolePageRules?: RolePageRules): stores.ConfigurationState => ({ schemaVersion: 1, revision: 3,
    legacySessionsRevoked: false, accounts: { [value.id]: value }, cardRules: {}, audit: [], mutations: {}, ...(rolePageRules ? { rolePageRules } : {}) });
  const principal = (value: stores.StoredAccount): AccessPrincipal => ({ accountId: value.id, authorizationVersion: value.version, role: value.role,
    purchaseBuilding: value.building, buildings: value.buildings, specialties: value.specialties, personalRules: value.personalRules, effectiveAuthorization: value.effectiveAuthorization });
  const decide = (value: stores.StoredAccount) => createBusinessPermissionEvaluator(principal(value));
  beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'nt-migration-scope-')); store = new stores.AccessConfigurationStore(join(directory, 'configuration.json')); });
  afterEach(() => { jest.restoreAllMocks(); rmSync(directory, { recursive: true, force: true }); });
  const seed = (value: stores.ConfigurationState) => { writeFileSync(store.filePath, JSON.stringify(value)); return readFileSync(store.filePath); };
  function assertReadMatrix(before: stores.StoredAccount, after: stores.StoredAccount) {
    const evaluate = decide(after);
    for (const building of [...BUILDING_ADMIN_BUILDINGS, undefined]) for (const specialty of [...PROFESSIONAL_SPECIALTIES, undefined]) {
      const target = { module: 'equipment_ledger' as const, action: 'read' as const, building, specialty };
      expect({ building, specialty, allowed: evaluate(target).allowed }).toEqual({ building, specialty, allowed: legacyScopedReadAllowed(before, target) });
    }
    for (const building of [['A楼', 'B楼'], BUILDING_ADMIN_BUILDINGS, undefined]) for (const specialty of [['电气', '暖通'], PROFESSIONAL_SPECIALTIES, undefined]) {
      const target = { module: 'equipment_ledger' as const, action: 'read' as const, building, specialty };
      expect(evaluate(target).allowed).toBe(legacyScopedReadAllowed(before, target));
    }
  }
  it.each(['guest', 'site_member'] as const)('does not turn the derived equipment entry into a global read grant for %s', role => {
    const original = account({ role }), current = state(original);
    migrateAuthorizationState(current, {}); const after = current.accounts[original.id];
    expect(after.authorizationBinding).toEqual({ mode: 'follow', templateId: `builtin-${role}` });
    expect(after.authorizationOverrides!.allowPages).not.toContain('/equipment-ledger-management');
    expect(after.authorizationOverrides!.rules[0]).toEqual(original.personalRules![0]);
    expect(after.version).toBe(7); assertReadMatrix(original, after);
    expect(decide(after)({ module: 'equipment_ledger', action: 'read', building: 'A楼', specialty: '电气' }).allowed).toBe(true);
    expect(decide(after)({ module: 'equipment_ledger', action: 'read', building: 'B楼', specialty: '电气' }).allowed).toBe(false);
  });
  it('materializes visible complement denies when a role page overlaps a narrow personal rule', () => {
    const original = account(), current = state(original, { site_member: ['/equipment-ledger-management'] });
    migrateAuthorizationState(current, {}); const after = current.accounts[original.id];
    expect(after.authorizationOverrides!.rules.slice(0, 1)).toEqual(original.personalRules);
    expect(after.authorizationOverrides!.rules.some(value => value.effect === 'deny' && value.id.startsWith('migration-'))).toBe(true);
    assertReadMatrix(original, after);
    expect(decide(after)({ module: 'equipment_ledger', action: 'read', building: ['A楼', 'B楼'], specialty: ['电气'] }).allowed).toBe(false);
  });
  it('keeps original deny priority and the intended independent capture scope', () => {
    const original = account({ personalRules: [rule({ buildings: ['A楼', 'B楼'] }), rule({ id: 'original-deny-B', effect: 'deny', buildings: ['B楼'] })] });
    const current = state(original, { site_member: ['/equipment-ledger-management'] });
    const detached = captureIndependentAuthorization(original, current);
    expect(detached.authorizationBinding?.mode).toBe('independent');
    expect(detached.authorizationOverrides!.rules.slice(0, 2)).toEqual(original.personalRules); assertReadMatrix(original, detached);
  });
  it('keeps hidden-page actions as overrideable template denies; a new create grant does not grant list read', () => {
    const original = account({ role: 'editor', personalRules: [], pagePaths: [] });
    const current = state(original, { editor: effectivePagePaths('editor').filter(page => page !== '/meeting-management') });
    migrateAuthorizationState(current, {}); const after = current.accounts[original.id];
    const target = { module: 'meetings' as const, action: 'create' as const };
    expect(after.effectiveAuthorization!.baseline.rules.find(value => value.module === 'meetings')?.actions).toContain('create');
    expect(decide(after)(target).allowed).toBe(false);
    const granted = structuredClone(after);
    granted.effectiveAuthorization!.overrides.rules.push(rule({ id: 'new-create-only', module: 'meetings', actions: ['create'], buildings: null, specialties: null }));
    granted.personalRules = granted.effectiveAuthorization!.overrides.rules;
    expect(decide(granted)(target).allowed).toBe(true);
    expect(decide(granted)({ module: 'meetings', action: 'read' }).allowed).toBe(false);
    // An unbound legacy sync command remains independent. Forced page reads still
    // fail their fixed read requirement even though refresh itself is permitted.
    expect(decide(after)({ module: 'monthly_schedule', action: 'refresh' }).allowed).toBe(true);
    const forced = classifyBusinessRequest('/api/meeting-management/snapshot?refresh=true', 'GET');
    expect(forced.permissions).toEqual([{ module: 'meetings', action: 'read' }, { module: 'meetings', action: 'refresh' }]);
    expect(forced.permissions!.every(required => decide(after)(required).allowed)).toBe(false);
  });
  it('a personal read exception reopens a hidden legacy page without a blanket account deny', () => {
    const original = account(), current = state(original, { site_member: [] });
    migrateAuthorizationState(current, {}); assertReadMatrix(original, current.accounts[original.id]);
    expect(decide(current.accounts[original.id])({ module: 'equipment_ledger', action: 'read', building: 'A楼', specialty: '电气' }).allowed).toBe(true);
  });
  it('rejects an unknown-dimension mismatch instead of silently detaching or widening an editor', async () => {
    const original = account({ role: 'editor', pagePaths: [] }), current = state(original);
    const before = structuredClone(current), bytes = seed(current);
    expect(() => migrateAuthorizationState(current, {})).toThrow('旧权限无法安全迁移'); expect(current).toEqual(before);
    const preview = authorizationMigrationPreview(before, {});
    expect(preview).toMatchObject({ canMigrate: false, conflicts: [expect.objectContaining({ module: 'equipment_ledger', action: 'read', beforeAllowed: false, afterAllowed: true })] });
    await expect(store.mutate(3, 'synthetic-unknown-conflict', 'synthetic', value => migrateAuthorizationState(value, {}))).rejects.toThrow('旧权限无法安全迁移');
    expect(readFileSync(store.filePath)).toEqual(bytes); expect(readdirSync(directory)).toEqual(['configuration.json']);
  });
  it('refuses real mixed legacy endpoint gates without changing the original bytes', async () => {
    const original = account({ role: 'editor', personalRules: [], pagePaths: [] }), current = state(original, { editor: [] });
    const bytes = seed(current), copy = structuredClone(current);
    // These are actual legacy bindings: batch/additional-matter were not page-gated,
    // whereas travel-staff was denied by an explicit empty editor page selection.
    expect(pageApiBinding('/api/duty-schedules/batch')).toBeUndefined();
    expect(pageApiBinding('/api/duty-schedules/additional-matter')).toBeUndefined();
    expect(pageApiBinding('/api/duty-schedules/travel-staff')?.pages).toEqual(['/monthly-schedule', '/today-operations-panorama']);
    const preview = authorizationMigrationPreview(current, {});
    expect(preview).toMatchObject({ canMigrate: false, conflicts: [expect.objectContaining({ module: 'schedule_assignments', action: 'create',
      reason: '同一动作的旧接口页面限制不同，不能合并为一个范围规则' })] });
    await expect(store.mutate(3, 'synthetic-mixed-gate-conflict', 'synthetic', value => migrateAuthorizationState(value, {}))).rejects.toThrow('旧权限无法安全迁移');
    expect(current).toEqual(copy); expect(readFileSync(store.filePath)).toEqual(bytes); expect(readdirSync(directory)).toEqual(['configuration.json']);
  });
  it('refuses a 101st rule without truncating originals or leaving a migration backup', async () => {
    const original = account({ personalRules: Array.from({ length: 100 }, (_, index) => rule({ id: `original-${index}` })) });
    const current = state(original, { site_member: ['/equipment-ledger-management'] }), bytes = seed(current);
    await expect(store.mutate(3, 'synthetic-capacity-conflict', 'synthetic', value => migrateAuthorizationState(value, {}))).rejects.toThrow('100');
    expect(readFileSync(store.filePath)).toEqual(bytes); expect(readdirSync(directory)).toEqual(['configuration.json']);
    expect(current.accounts[original.id].personalRules).toHaveLength(100);
  });
  it('previews the real account difference without writing or returning provider IDs and credentials', () => {
    const original = account(), current = state(original, { site_member: ['/equipment-ledger-management'] }), bytes = seed(current);
    jest.spyOn(stores, 'getAccessConfigurationStore').mockReturnValue(store); jest.spyOn(defaults, 'defaultAccessAccounts').mockReturnValue({});
    const service = new AccessConfigurationService(), preview = service.previewAuthorizationMigration();
    expect(preview.canMigrate).toBe(true);
    expect(preview.accounts[0]).toMatchObject({ accountId: original.id, before: { mode: 'legacy', role: 'site_member', authorizationVersion: 7 },
      after: { mode: 'follow', templateId: 'builtin-site_member', role: 'site_member', authorizationVersion: 7 }, behavior: { status: 'verified' } });
    expect(preview.accounts[0].after!.rules.personal.length).toBeGreaterThan(preview.accounts[0].before.rules.personal.length);
    expect(preview.accounts[0].pageChanges).toEqual({ added: [], removed: [] });
    expect(preview.accounts[0].behavior.checks).toContainEqual(expect.objectContaining({ module: 'equipment_ledger', action: 'read', checkedTargets: 233, equivalent: true }));
    expect(JSON.stringify(preview)).not.toMatch(/openId|passwordHash|identityHash|credentialSource/);
    expect(JSON.stringify(preview)).not.toContain(openId); expect(JSON.stringify(preview)).not.toContain(appId);
    service.snapshot(); expect(readFileSync(store.filePath)).toEqual(bytes); expect(readdirSync(directory)).toEqual(['configuration.json']);
  });
  it('commits only after all checks, keeps exact V1 bytes and permits only unchanged migration rollback', async () => {
    const original = account(), current = state(original, { site_member: ['/equipment-ledger-management'] }), bytes = seed(current);
    const result = await store.mutate(3, 'synthetic-safe-migration', 'synthetic', value => migrateAuthorizationState(value, {}), { migrationOnly: true });
    expect(result.schemaVersion).toBe(2); expect(result.revision).toBe(4);
    expect(readFileSync(result.authorizationMigration!.backupFile)).toEqual(bytes);
    expect(store.inspectAuthorizationRollback().allowed).toBe(true); assertReadMatrix(original, store.read().accounts[original.id]);
  });
  it.each(['guest', 'site_member', 'editor', 'purchase_admin'] as const)('does not invent scope conflicts for an ordinary default %s', role => {
    const original = account({ role, personalRules: [], pagePaths: [] }), current = state(original);
    expect(() => migrateAuthorizationState(current, {})).not.toThrow();
    expect(current.accounts[original.id].authorizationBinding).toEqual({ mode: 'follow', templateId: `builtin-${role}` });
  });
  it('rejects nonmatching missing dimensions while preserving all known professional scope points', () => {
    const original = account({ role: 'professional_engineer', building: 'A楼', buildings: ['A楼', 'B楼'], specialties: ['电气'], personalRules: [], pagePaths: [] });
    const baseline = legacyAuthorizationPolicy(original.role);
    const { overrides } = legacyAuthorizationOverrides(original, baseline);
    const after = { ...original, effectiveAuthorization: { mode: 'independent' as const, baseline, overrides } };
    assertReadMatrix(original, after);
  });
});
