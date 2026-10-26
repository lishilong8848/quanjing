import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  canViewOrganizationPersonProfile,
  parseOrganizationPersonProfileSource,
} from '../../shared/organization-person-profile';

const ROOT = path.resolve(__dirname, '../..');

describe('organization person profile access policy', () => {
  it.each([
    ['admin', true],
    ['editor', true],
    ['guest', false],
    ['duty_editor', false],
    ['inventory_admin', false],
    ['purchase_admin', false],
    ['purchase_applicant', false],
    ['supply_chain_admin', false],
    ['construction_admin', false],
  ] as const)('allows role %s: %s', (role, expected) => {
    expect(canViewOrganizationPersonProfile(role)).toBe(expected);
  });

  it('accepts only the two stable profile locator sources', () => {
    expect(parseOrganizationPersonProfileSource('organization')).toBe(
      'organization',
    );
    expect(parseOrganizationPersonProfileSource('certificate')).toBe(
      'certificate',
    );
    expect(() => parseOrganizationPersonProfileSource('name')).toThrow(
      '人员档案来源无效',
    );
  });

  it('keeps the detail route private and enforces the dedicated policy', () => {
    const source = fs.readFileSync(
      path.join(
        ROOT,
        'server/modules/bitable-sync/bitable-sync.controller.ts',
      ),
      'utf8',
    );
    const routeStart = source.indexOf(
      "@Get('organization-person-profile/:source/:recordId')",
    );
    expect(routeStart).toBeGreaterThan(-1);
    const nextRoute = source.indexOf(
      'GET /api/bitable/person-profiles',
      routeStart,
    );
    const routeBlock = source.slice(routeStart, nextRoute);
    expect(routeBlock).toContain("@Header('Cache-Control', 'private, no-store')");
    expect(routeBlock).toContain("@Header('Vary', 'Cookie')");
    expect(routeBlock).toContain('canViewOrganizationPersonProfile');
    expect(routeBlock).toContain('request.accessRole');
    expect(routeBlock).not.toContain('@GuestReadable()');
  });

  it('does not grant the organization profile route to the duty editor', () => {
    const source = fs.readFileSync(
      path.join(ROOT, 'server/common/access/unified-access.guard.ts'),
      'utf8',
    );
    expect(source).not.toContain(
      "'GET /api/bitable/organization-person-profile'",
    );
    expect(source).not.toContain('DUTY_EDITOR_ORGANIZATION_PERSON_PROFILE');
  });
});
