import { canAccessPage } from '../../client/src/access/access-policy';
import { canReadPage, effectivePagePaths } from '../../shared/page-access';

describe('legacy training and certificate page access', () => {
  const destination = '/training-certification-management';

  it.each(['/campus-certificate-dashboard', '/campus-training-dashboard'])(
    '%s uses the destination permission before its redirect',
    (legacyPath) => {
      for (const path of [legacyPath, `${legacyPath}/`, `${legacyPath}?module=training`]) {
        expect(canAccessPage('editor', path, effectivePagePaths('editor'))).toBe(true);
        expect(canAccessPage('building_admin', path)).toBe(true);
        expect(canReadPage('guest', path, [destination])).toBe(true);
        expect(canReadPage('editor', path, ['/nantong-base'])).toBe(false);
        expect(canReadPage('guest', path)).toBe(false);
        expect(canReadPage('guest', path, [])).toBe(false);
      }
    },
  );

  it('does not grant unrelated paths or unknown descendants', () => {
    expect(canReadPage('editor', '/campus-training-dashboard/unrecognized', [destination])).toBe(false);
    expect(canReadPage('editor', '/system-configuration', [destination])).toBe(false);
    expect(canReadPage('guest', '/schedule-calendar', ['/today-focus-checklist'])).toBe(true);
  });
});
