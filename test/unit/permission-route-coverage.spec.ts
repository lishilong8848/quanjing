import { BUSINESS_PERMISSION_CATALOG } from '../../shared/business-permissions';
import { classifyBusinessRequest, businessRequestPermission } from '../../shared/business-request-permission';
import { PERMISSION_ROUTE_CLASSIFICATIONS } from '../../shared/permission-route-classification';

function actualControllerRoutes(): string[] {
  const {inspect}=require('../../scripts/inspect-permission-routes.cjs') as {inspect(root:string):{method:string;path:string}[]};
  return inspect(process.cwd()).map(route=>`${route.method} ${route.path}`).sort();
}

describe('explicit permission route coverage', () => {
  it('classifies every real method and route in the reviewed controllers exactly once', () => {
    const declared = PERMISSION_ROUTE_CLASSIFICATIONS.map(route => `${route.method} ${route.path}`).sort();
    expect(new Set(declared).size).toBe(declared.length);
    expect(declared).toEqual(actualControllerRoutes());
  });
  it.each(PERMISSION_ROUTE_CLASSIFICATIONS)('$method $path has an explicit classification', route => {
    const pathname = route.path.replace(/:year/g, '2026').replace(/:month/g, '10').replace(/:(?:index|page)/g, '1').replace(/:[A-Za-z]+/g, 'synthetic-id');
    const result = classifyBusinessRequest(pathname, route.method);
    expect(result.declared).toBe(true); expect(result.kind).toBe(route.kind); expect(result.route?.path).toBe(route.path);
    if (route.permission) {
      const definition = BUSINESS_PERMISSION_CATALOG.find(item => item.id === route.permission!.module);
      expect(definition).toBeDefined();
      for (const action of [route.permission.action, ...(route.refreshQueries ? ['refresh'] : []), ...(route.recordDependent?.candidateActions || [])]) {
        expect(definition!.actions as readonly string[]).toContain(action);
      }
    }
    for (const dependency of [...(route.dependencies || []), ...(route.selectorPermissions || []), ...(route.refreshPermission ? [route.refreshPermission] : [])]) {
      expect(BUSINESS_PERMISSION_CATALOG.find(item => item.id === dependency.module)?.actions as readonly string[]).toContain(dependency.action);
    }
    if (route.selectorPermissions) expect(result.candidatePermissions).toEqual(route.selectorPermissions);
  });
  it.each(['/api/purchase-inventory/new-write', '/api/operations-kb/arbitrary-delete', '/api/not-declared', '/callbacks/not-declared'])('unknown %s never inherits prefix permissions', pathname => {
    for (const method of ['GET', 'POST', 'DELETE']) expect(classifyBusinessRequest(pathname, method)).toMatchObject({ kind: 'denied', declared: false });
  });
  it('prefers literal routes over parameter routes even when declaration order is reversed', () => {
    try {
      jest.isolateModules(() => {
        jest.doMock('../../shared/permission-route-classification', () => ({ PERMISSION_ROUTE_CLASSIFICATIONS: [...PERMISSION_ROUTE_CLASSIFICATIONS].reverse() }));
        const isolated = require('../../shared/business-request-permission') as typeof import('../../shared/business-request-permission');
        expect(isolated.classifyBusinessRequest('/api/purchase-inventory/workflows/status', 'GET').route?.path).toBe('/api/purchase-inventory/workflows/status');
        expect(isolated.classifyBusinessRequest('/api/bitable/alarm-human-reviews/people', 'GET').route?.path).toBe('/api/bitable/alarm-human-reviews/people');
      });
    } finally { jest.dontMock('../../shared/permission-route-classification'); }
  });
  it.each(['/api/purchase-inventory/records/%2fadmin', '/api/purchase-inventory/records/%252fadmin', '/api/purchase-inventory/../access/configuration', '/api/purchase-inventory/records/%00bad'])('rejects unsafe ID/path normalization %s', pathname => {
    expect(classifyBusinessRequest(pathname, 'PATCH')).toMatchObject({ kind: 'denied', declared: false });
  });
  it('does not let force flags replace an export/create requirement or authorize arbitrary methods', () => {
    expect(businessRequestPermission('/api/ali-monthly-report/files/synthetic?refresh=1', 'HEAD', true)).toEqual({ module: 'monthly_reports', action: 'export' });
    expect(classifyBusinessRequest('/api/purchase-inventory/application-options?force=1', 'GET', true).permissions).toEqual([{ module: 'purchase', action: 'create' }]);
    expect(classifyBusinessRequest('/api/purchase-inventory/dashboard?refresh=active', 'GET').permissions).toEqual([{ module: 'purchase', action: 'read' }]);
    expect(classifyBusinessRequest('/api/purchase-inventory/dashboard', 'POST')).toMatchObject({ kind: 'denied', declared: false });
    expect(businessRequestPermission('/api/threshold-management/adjustments?refresh=1', 'POST', true)).toEqual({ module: 'thresholds', action: 'create' });
    expect(classifyBusinessRequest('/API/not-declared', 'GET')).toMatchObject({ kind: 'denied', declared: false });
  });
  it('keeps upserts record-dependent instead of requiring both rights or trusting a supplied ID', () => {
    const result = classifyBusinessRequest('/api/duty-schedules/emergency-duty', 'POST');
    expect(result.permissions).toEqual([]);
    expect(result.candidatePermissions).toEqual([{ module: 'schedule_assignments', action: 'create' }, { module: 'schedule_assignments', action: 'update' }]);
    expect(result.route?.recordDependent?.service).toBe('EmergencyDutyService.performUpsert');
    const meeting = classifyBusinessRequest('/api/meeting-management/weekly/meetings', 'POST');
    expect(meeting.permissions).toEqual([{ module: 'meetings', action: 'update' }]);
    expect(meeting.candidatePermissions).toBeUndefined();
    expect(meeting.route?.recordDependent).toBeUndefined();
  });
  it('separates fixed configuration/protocol/auxiliary routes without treating classification as authorization', () => {
    expect(classifyBusinessRequest('/api/access/configuration/accounts', 'POST').kind).toBe('admin');
    expect(classifyBusinessRequest('/api/access/login', 'POST').kind).toBe('protocol');
    expect(classifyBusinessRequest('/api/weather/warning', 'GET').kind).toBe('auxiliary');
    expect(classifyBusinessRequest('/api/threshold-management/mutations', 'POST').kind).toBe('denied');
    expect(businessRequestPermission('/api/contract-management/attachments/storage', 'GET')).toEqual({ module: 'contracts', action: 'read' });
  });
  it('keeps basic personnel dependencies separate from both private profile scopes and source refresh', () => {
    const basic = classifyBusinessRequest('/api/bitable/person-profiles', 'GET');
    expect(basic.kind).toBe('auxiliary');
    expect(basic.route?.dependencies).toContainEqual({ module: 'leave_requests', action: 'create' });
    expect(businessRequestPermission('/api/bitable/organization-person-profile/synthetic/recSynthetic', 'GET')).toEqual({ module: 'organization_profile', action: 'read' });
    expect(businessRequestPermission('/api/bitable/person-profile-details', 'GET')).toEqual({ module: 'personnel_profile', action: 'read' });
    expect(businessRequestPermission('/api/bitable/employee-photo/recSynthetic', 'GET')).toEqual({ module: 'personnel_profile', action: 'read' });
    expect(classifyBusinessRequest('/api/bitable/person-profile-details?forceRefresh=1', 'GET').permissions).toEqual([{ module: 'personnel_profile', action: 'read' }, { module: 'personnel_profile', action: 'refresh' }]);
    expect(businessRequestPermission('/api/bitable/person-profiles?forceRefresh=1', 'GET')).toEqual({ module: 'organization', action: 'refresh' });
  });
});
