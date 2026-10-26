import { canApplyPagePermissionSnapshot } from '../../client/src/access/session-commit-coordinator';
import { Reflector } from '@nestjs/core';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { PAGE_ACCESS_CATALOG, canReadPage, effectivePagePaths, validRolePageRules } from '../../shared/page-access';
import { AccessConfigurationService } from '../../server/common/access/access-configuration.service';
import { UnifiedAccessService, hashAccessPassword } from '../../server/common/access/unified-access.service';
import { UnifiedAccessGuard } from '../../server/common/access/unified-access.guard';
import { AdminOnlyMetadataKey, GuestReadableMetadataKey } from '../../server/common/access/unified-access.decorators';
import { MeetingController } from '../../server/modules/meeting-management/meeting.controller';
import { WeeklyController } from '../../server/modules/meeting-management/weekly.controller';
import { ledgerAccessBuilding } from '../../server/modules/equipment-lifecycle/equipment-ledger-access';
import { scopeToolsSnapshot } from '../../server/modules/operations-tools/operations-tools.mapper';
import { ThresholdController } from '../../server/modules/threshold-management/threshold.controller';
import { getAccessibleNavigationDomains } from '../../client/src/navigation/page-switcher';
import { canAccessPage, getPostLoginPath } from '../../client/src/access/access-policy';
import type { AccessPrincipal, AccessRole } from '../../shared/access-control.interface';

function authorize(role: AccessRole, paths: string[], url: string, method = 'GET', handlerAdmin = false) {
  const handler = () => undefined;
  Reflect.defineMetadata(GuestReadableMetadataKey, true, handler);
  if (handlerAdmin) Reflect.defineMetadata(AdminOnlyMetadataKey, true, handler);
  const request = { method, url, originalUrl: url, headers: {}, query: {}, accessPrincipal: undefined as AccessPrincipal | undefined, accessPageRead: undefined as boolean | undefined };
  const access = { cookieName: 'test', isAccessControlEnabled: () => true, renew: () => ({ principal: { role, purchaseBuilding: role === 'building_admin' ? 'A楼' : null, ...(role === 'professional_admin' ? { specialties: ['暖通'] } : {}), displayName: '合成验收人员' } }), pagePermissions: () => ({ paths, configured: true, revision: 1 }) };
  const guard = new UnifiedAccessGuard(new Reflector(), access as never);
  const context = { getClass: () => class {}, getHandler: () => handler, switchToHttp: () => ({ getRequest: () => request, getResponse: () => ({}) }) };
  return { allowed: guard.canActivate(context as never), request };
}
describe('role page read permission boundaries', () => {
  it.each(['/today-operations-panorama', '/monthly-operations', '/meeting-management', '/operations-kb', '/system-monthly-report', '/ali-monthly-report', '/construction-management'])('guest default excludes %s including subroutes', path => {
    expect(canReadPage('guest', path)).toBe(false);
    expect(canReadPage('guest', path + '/detail')).toBe(false);
    expect(canReadPage('guest', path, [path])).toBe(true);
  });
  it('catalog has unique stable pages and navigation uses the same rule', () => {
    expect(new Set(PAGE_ACCESS_CATALOG.map(page => page.path)).size).toBe(PAGE_ACCESS_CATALOG.length);
    expect(getAccessibleNavigationDomains('guest', ['/meeting-management']).flatMap(group => group.pages.map(page => page.path))).toEqual(['/meeting-management']);
    expect(canAccessPage('guest', '/meeting-management/nantong-weekly', ['/meeting-management'])).toBe(true);
    expect(getPostLoginPath('guest', '/monthly-schedule', ['/nantong-base'])).toBe('/nantong-base');
    expect(canReadPage('guest', '/system-configuration', ['/system-configuration'])).toBe(false);
  });
  it.each(['/api/monthly-schedules/2026/10', '/api/bitable/today-operations-overview', '/api/meeting-management/snapshot', '/api/meeting-management/weekly/workspace', '/api/purchase-inventory/dashboard', '/api/contract-management/dashboard'])('unselected guest API %s rejects even GuestReadable', url => {
    expect(authorize('guest', ['/nantong-base'], url).allowed).toBe(false);
  });
  it.each([
    ['/monthly-schedule', '/api/monthly-schedules/2026/10'],
    ['/today-operations-panorama', '/api/bitable/today-operations-overview'],
    ['/meeting-management', '/api/meeting-management/snapshot'],
    ['/meeting-management', '/api/meeting-management/weekly/workspace'],
    ['/purchase-inventory-management', '/api/purchase-inventory/dashboard'],
    ['/contract-management', '/api/contract-management/dashboard'],
  ])('selected %s grants its observed GET', (page,url) => {
    const result = authorize('guest', [page], url);
    expect(result.allowed).toBe(true);
    expect(result.request.accessPrincipal?.role).toBe('guest');
    expect(result.request.accessPageRead).toBe(true);
    expect(authorize('guest', [page], url, 'POST').allowed).toBe(false);
    expect(authorize('guest', [page], url, 'DELETE').allowed).toBe(false);
    expect(authorize('guest', [page], url, 'GET', true).allowed).toBe(false);
  });
  it.each(['?refresh=1','?refresh=true','?refresh=active','?forceRefresh=1','?recheck=1','?refresh=0&refresh=1'])('page read does not grant forced refresh %s', query => {
    expect(authorize('guest', ['/meeting-management'], '/api/meeting-management/weekly/workspace'+query).allowed).toBe(false);
  });
  it('guest private attendance remains denied even when schedule reading is selected', () => {
    expect(authorize('guest', ['/monthly-schedule'], '/api/attendance/today').allowed).toBe(false);
    expect(authorize('guest', ['/monthly-schedule'], '/api/duty-schedules/long-white-duty-staff').allowed).toBe(false);
    expect(authorize('guest', ['/monthly-schedule'], '/api/duty-schedules').allowed).toBe(false);
    expect(authorize('guest', ['/monthly-schedule'], '/api/bitable/non-duty-schedules').allowed).toBe(false);
  });
  it('read grant preserves the original building and professional principal', () => {
    expect(authorize('building_admin', ['/meeting-management'], '/api/meeting-management/snapshot').request.accessPrincipal).toMatchObject({ role: 'building_admin', purchaseBuilding: 'A楼' });
    expect(authorize('professional_admin', ['/contract-management'], '/api/contract-management/dashboard').request.accessPrincipal).toMatchObject({ role: 'professional_admin', specialties: ['暖通'] });
  });
  it('read helpers preserve a restricted multi-building scope; missing scopes do not become global', () => {
    const principal: AccessPrincipal = { role: 'purchase_applicant', purchaseBuilding: 'A楼', buildings: ['A楼', 'B楼'] };
    expect(ledgerAccessBuilding(principal, true)).toBeNull();
    expect(() => ledgerAccessBuilding({ role: 'inventory_admin', purchaseBuilding: null }, true)).toThrow();
    const snapshot = { tools: [{ id:'a', building:'A楼' }, { id:'b', building:'B楼' }, { id:'c', building:'C楼' }], flows: [] };
    expect(scopeToolsSnapshot(principal, snapshot as never, true).tools.map(tool => tool.id)).toEqual(['a','b']);
    expect(() => scopeToolsSnapshot(principal, snapshot as never)).toThrow();
  });
  it('actual threshold reading is scoped, while force and POST retain the existing actor rule', () => {
    const sync = { refreshSource: jest.fn(), sourceStatus: () => ({}) };
    const controller = new ThresholdController({ list: () => ({ records: [{ id:'a',building:'A楼',profession:'暖通' },{ id:'b',building:'B楼',profession:'电气' }] }) } as never, sync as never);
    const request = { accessPrincipal:{ role:'inventory_admin',purchaseBuilding:'A楼' }, accessPageRead:true } as never;
    expect(controller.list(request).records.map(record => record.id)).toEqual(['a']);
    expect(() => controller.list(request,'true')).toThrow();
    expect(() => controller.mutate({} as never,request)).toThrow();
  });
  it('actual meeting/weekly controllers allow only the guard read marker and retain mutation checks', async () => {
    const meetings = { snapshot: jest.fn(() => ({ records: [] })), detail: jest.fn(() => ({ id: 'recFixture' })) };
    const weekly = { snapshot: jest.fn(async () => ({ jobs: [{ id: 'private-task' }], writeAccess: { enabled: true } })), formRecord: jest.fn(() => ({ id: 'recFixture' })), save: jest.fn(), generate: jest.fn(), retry: jest.fn() };
    const mc = new MeetingController(meetings as never), wc = new WeeklyController(weekly as never);
    const request = authorize('guest', ['/meeting-management'], '/api/meeting-management/snapshot').request as never;
    expect(mc.snapshot(request)).toEqual({ records: [] });
    expect(mc.detail(request, 'recFixture')).toEqual({ id: 'recFixture' });
    expect(await wc.snapshot(request)).toMatchObject({ jobs: [], writeAccess: { enabled: false } });
    expect(wc.formRecord(request, 'recFixture')).toEqual({ id: 'recFixture' });
    expect(() => mc.snapshot(request, '1')).toThrow();
    await expect(wc.snapshot(request, '1')).rejects.toThrow();
    expect(() => wc.save(request, {} as never)).toThrow();
    expect(() => wc.generate(request, {} as never)).toThrow();
    expect(() => wc.retry(request, 'task')).toThrow();
    expect(() => wc.job(request, 'task')).toThrow();
    expect(weekly.save).not.toHaveBeenCalled();
    expect(() => mc.snapshot({ accessPrincipal: { role: 'guest' } } as never)).toThrow();
  });
});
describe('persistent page rule administration', () => {
  const original = { ...process.env };
  let dir: string, config: AccessConfigurationService, access: UnifiedAccessService, actor: AccessPrincipal;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nt-page-permission-'));
    process.env.ACCESS_CONFIGURATION_FILE = join(dir, 'configuration.json');
    process.env.LOCAL_ACCESS_SESSION_SECRET = randomBytes(32).toString('base64');
    process.env.LOCAL_ADMIN_PASSWORD_HASH = hashAccessPassword('page-admin-test-only');
    process.env.FEISHU_APP_ID = 'cli_page_fixture';
    config = new AccessConfigurationService(); access = new UnifiedAccessService(config);
    actor = config.localTargets().find(target => target.principal.role === 'admin')!.principal;
  });
  afterEach(() => { process.env = { ...original }; rmSync(dir,{ recursive:true,force:true }); });
  const command = () => ({ role: 'guest' as const, pages: ['/meeting-management'], expectedRevision: 0, clientMutationId: 'page-role-fixture-001' });
  it('persists, audits, rejects stale revisions and deduplicates a retry', async () => {
    await config.savePageRole(command(), actor);
    await config.savePageRole(command(), actor);
    expect(config.snapshot().revision).toBe(1);
    expect(config.snapshot().audit).toHaveLength(1);
    expect(new AccessConfigurationService().pagePermissions('guest').paths).toEqual(['/meeting-management']);
    await expect(config.savePageRole({ ...command(), clientMutationId: 'page-role-fixture-002' }, actor)).rejects.toThrow('已更新');
    await expect(config.savePageRole({ ...command(), pages: [], }, actor)).rejects.toThrow('重复请求');
  });
  it('empty read list denies pages; deletion of override restores the default', async () => {
    await config.savePageRole({ ...command(), pages: [] },actor);
    expect(access.pagePermissions('guest').paths).toEqual([]);
    await config.savePageRole({ ...command(), expectedRevision: 1, clientMutationId: 'page-role-fixture-002', restoreDefault: true },actor);
    expect(access.pagePermissions('guest')).toMatchObject({ configured: false, paths: effectivePagePaths('guest') });
  });
  it('cannot remove administrator access or grant configuration/unknown page', async () => {
    for (const bad of [{ role: 'admin', pages: [] }, { role: 'guest', pages: ['/system-configuration'] }, { role: 'guest', pages: ['/unknown'] }, { role: 'guest', pages: ['/nantong-base','/nantong-base'] }]) {
      await expect(config.savePageRole({ ...command(), ...bad } as never, actor)).rejects.toThrow();
    }
    await expect(config.savePageRole(command(),{ role:'editor',purchaseBuilding:null })).rejects.toThrow();
    expect(config.snapshot().revision).toBe(0);
  });
  it('existing signed session sees new page rules without changing identity or business role', async () => {
    const session = access.issueTrustedSession(actor);
    await config.savePageRole(command(), actor);
    expect(access.readSession(session.token).principal).toEqual(session.principal);
    expect(access.pagePermissions('guest').paths).toEqual(['/meeting-management']);
    await config.savePageRole({ ...command(), pages: [], expectedRevision: 1, clientMutationId:'page-role-fixture-002' }, actor);
    expect(access.pagePermissions('guest').paths).toEqual([]);
  });
  it('optional field preserves old files; malformed policy fails closed', async () => {
    await config.savePageRole(command(), actor);
    const file=process.env.ACCESS_CONFIGURATION_FILE!, state=JSON.parse(readFileSync(file,'utf8'));
    delete state.rolePageRules; writeFileSync(file,JSON.stringify(state));
    expect(config.pagePermissions('guest').configured).toBe(false);
    state.rolePageRules={ guest:['/system-configuration'] }; writeFileSync(file,JSON.stringify(state));
    expect(() => config.pagePermissions('guest')).toThrow('无效');
    expect(validRolePageRules({ admin: [] })).toBe(false);
  });
});

describe('page permission response ordering', () => {
  it('a late old read grant cannot overwrite a revoked policy for the same identity', () => {
    const revoked = { principalFingerprint: 'fixture-person', pagePermissionsRevision: 8, pagePaths: [] };
    const oldGrant = { principalFingerprint: 'fixture-person', pagePermissionsRevision: 7, pagePaths: ['/equipment-ledger-management'] };
    expect(canApplyPagePermissionSnapshot(revoked, oldGrant)).toBe(false);
    expect(canApplyPagePermissionSnapshot(oldGrant, revoked)).toBe(true);
    expect(canApplyPagePermissionSnapshot(revoked, { ...oldGrant, principalFingerprint: 'different-login' })).toBe(true);
  });
});
