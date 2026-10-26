import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AccessRole } from '../../shared/access-control.interface';

describe('person profile detail access', () => {
  it('allows only schedule administrators and editors to view private details', () => {
    const policyPath = join(
      process.cwd(),
      'shared/person-profile-access.ts',
    );
    expect(existsSync(policyPath)).toBe(true);
    const policy = require(policyPath) as {
      canViewPersonProfileDetails: (role: AccessRole) => boolean;
    };

    for (const role of ['admin', 'editor', 'duty_editor'] as AccessRole[]) {
      expect(policy.canViewPersonProfileDetails(role)).toBe(true);
    }
    for (const role of [
      'guest',
      'inventory_admin',
      'purchase_admin',
      'purchase_applicant',
      'supply_chain_admin',
      'construction_admin',
    ] as AccessRole[]) {
      expect(policy.canViewPersonProfileDetails(role)).toBe(false);
    }
  });

  it('keeps the detailed route protected and hides private UI for guests', () => {
    const controllerSource = readFileSync(
      join(
        process.cwd(),
        'server/modules/bitable-sync/bitable-sync.controller.ts',
      ),
      'utf8',
    );
    const routeStart = controllerSource.indexOf(
      "@Get('person-profile-details')",
    );
    const routeEnd = controllerSource.indexOf('\n  /**', routeStart);
    const routeSource = controllerSource.slice(routeStart, routeEnd);
    const pageSource = readFileSync(
      join(process.cwd(), 'client/src/pages/MonthlySchedule/index.tsx'),
      'utf8',
    );

    expect(routeStart).toBeGreaterThan(-1);
    expect(routeSource).not.toContain('@GuestReadable()');
    expect(routeSource).toContain('canViewPersonProfileDetails');
    expect(pageSource).toContain('canViewPersonProfileDetails(role)');
    expect(pageSource).toContain('getPersonProfileDetails');
    expect(pageSource).toContain('canViewPrivateProfile');
  });

  it('protects employee photos with the same role policy and private caching', () => {
    const controllerSource = readFileSync(
      join(
        process.cwd(),
        'server/modules/bitable-sync/bitable-sync.controller.ts',
      ),
      'utf8',
    );
    const guardSource = readFileSync(
      join(process.cwd(), 'server/common/access/unified-access.guard.ts'),
      'utf8',
    );
    const routeStart = controllerSource.indexOf(
      "@Get('employee-photo/:recordId')",
    );
    const routeEnd = controllerSource.indexOf('\n  /**', routeStart);
    const routeSource = controllerSource.slice(routeStart, routeEnd);

    expect(routeStart).toBeGreaterThan(-1);
    expect(routeSource).toContain('canViewPersonProfileDetails');
    expect(routeSource).toContain("'Cache-Control', 'private, max-age=3600'");
    expect(routeSource).toContain("'Vary', 'Cookie'");
    expect(routeSource).not.toContain("'Cache-Control', 'public");
    expect(guardSource).toContain('DUTY_EDITOR_EMPLOYEE_PHOTO_PATH');
    expect(guardSource).toContain('DUTY_EDITOR_EMPLOYEE_PHOTO_PATH.test(path)');
    expect(guardSource).toMatch(
      /DUTY_EDITOR_EMPLOYEE_PHOTO_PATH\s*=\s*\/[\s\S]*?\/[i]/,
    );
  });

  it('keeps the Feishu chat redirect protected and permits mixed-case record ids for duty editors', () => {
    const controllerSource = readFileSync(
      join(
        process.cwd(),
        'server/modules/bitable-sync/bitable-sync.controller.ts',
      ),
      'utf8',
    );
    const guardSource = readFileSync(
      join(process.cwd(), 'server/common/access/unified-access.guard.ts'),
      'utf8',
    );
    const routeStart = controllerSource.indexOf(
      "@Get('person-chat/:recordId')",
    );
    const routeEnd = controllerSource.indexOf('\n  /**', routeStart);
    const routeSource = controllerSource.slice(routeStart, routeEnd);

    expect(routeStart).toBeGreaterThan(-1);
    expect(routeSource).toContain('canViewPersonProfileDetails');
    expect(routeSource).toContain("'Cache-Control', 'private, no-store'");
    expect(routeSource).not.toContain('@GuestReadable()');
    expect(guardSource).toContain('DUTY_EDITOR_PERSON_CHAT_PATH');
    expect(guardSource).toMatch(
      /DUTY_EDITOR_PERSON_CHAT_PATH\s*=\s*\/[\s\S]*?\/[i]/,
    );
  });
});
