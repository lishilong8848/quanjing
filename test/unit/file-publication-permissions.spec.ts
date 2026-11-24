import { canPerformBusinessAction, type BusinessAction, type PersonalPermissionRule } from '../../shared/business-permissions';
import { classifyBusinessRequest } from '../../shared/business-request-permission';
import { defaultCanAccessPage, pageApiBinding } from '../../shared/page-access';
import { PERMISSION_ROUTE_CLASSIFICATIONS } from '../../shared/permission-route-classification';

describe('file publication access', () => {
  const allows = (role: 'admin' | 'editor' | 'guest' | 'professional_engineer', action: BusinessAction) =>
    canPerformBusinessAction({ role, specialties: [] }, { module: 'file_publication', action });

  it('separates publishing, approval and download permissions', () => {
    expect(defaultCanAccessPage('guest', '/file-publication')).toBe(false);
    expect(defaultCanAccessPage('professional_engineer', '/file-publication')).toBe(true);
    expect(allows('guest', 'read')).toBe(false);
    expect(allows('editor', 'create')).toBe(true);
    expect(allows('editor', 'export')).toBe(true);
    expect(allows('editor', 'approve')).toBe(false);
    expect(allows('professional_engineer', 'approve')).toBe(false);
    expect(allows('admin', 'approve')).toBe(true);
  });

  it('classifies each API under the publication page and grants writes explicitly', () => {
    const routes = PERMISSION_ROUTE_CLASSIFICATIONS.filter(route => route.permission?.module === 'file_publication');
    expect(routes.map(route => [route.method, route.path, route.permission?.action])).toEqual([
      ['GET', '/api/file-publication/options', 'read'],
      ['POST', '/api/file-publication/parse', 'create'],
      ['GET', '/api/file-publication/batches', 'read'],
      ['GET', '/api/file-publication/submissions/:requestId', 'create'],
      ['GET', '/api/file-publication/batches/:id', 'read'],
      ['POST', '/api/file-publication/batches', 'create'],
      ['POST', '/api/file-publication/batches/:id/review', 'approve'],
      ['POST', '/api/file-publication/batches/:id/deliveries/retry', 'approve'],
      ['GET', '/api/file-publication/batches/:id/files/:fileId', 'export'],
    ]);
    expect(pageApiBinding('/api/file-publication/batches/record/files/attachment')).toEqual({
      pages: ['/file-publication'],
      readable: true,
    });
  });

  it('does not grant access to source records through publication or page access alone', () => {
    const target = { module: 'file_publication_table', action: 'read' } as const;
    const principal = { role: 'professional_engineer', specialties: [] } as const;
    const grant: PersonalPermissionRule = {
      id: 'allow-publication-table-read', module: target.module, effect: 'allow', actions: ['read'],
      buildings: null, specialties: null,
    };
    expect(canPerformBusinessAction({ role: 'admin', specialties: [] }, { ...target, action: 'delete' })).toBe(true);
    expect(canPerformBusinessAction({ ...principal, specialties: [] }, target)).toBe(false);
    const withPageRead = {
      ...principal, specialties: [], effectiveAuthorization: {
        mode: 'independent' as const,
        baseline: { nativeRole: null, pages: ['/file-publication'], rules: [] },
        overrides: { allowPages: ['/file-publication'], denyPages: [], rules: [] },
      },
    };
    expect(canPerformBusinessAction(withPageRead, target)).toBe(false);
    const withRecordRead = { ...withPageRead, effectiveAuthorization: {
      ...withPageRead.effectiveAuthorization, overrides: { ...withPageRead.effectiveAuthorization.overrides, rules: [grant] },
    } };
    expect(canPerformBusinessAction(withRecordRead, target)).toBe(true);
    expect(canPerformBusinessAction(withRecordRead, { ...target, action: 'create' })).toBe(false);
  });

  it('authorizes the record query and each mutation independently', () => {
    const routes = PERMISSION_ROUTE_CLASSIFICATIONS.filter(route => route.permission?.module === 'file_publication_table');
    expect(routes.map(route => [route.method, route.path, route.permission?.action])).toEqual([
      ['POST', '/api/file-publication/records/query', 'read'],
      ['POST', '/api/file-publication/records', 'create'],
      ['PATCH', '/api/file-publication/records/:id', 'update'],
      ['POST', '/api/file-publication/records/:id/delete', 'delete'],
    ]);
    expect(classifyBusinessRequest('/api/file-publication/options', 'GET').candidatePermissions).toEqual([
      { module: 'file_publication', action: 'read' }, { module: 'file_publication_table', action: 'read' },
    ]);
  });
});
