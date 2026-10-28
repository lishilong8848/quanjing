import { readFileSync } from 'fs';
import { join } from 'path';

const readSource = (relativePath: string) =>
  readFileSync(join(process.cwd(), relativePath), 'utf8');

describe('unified access duty backend migration', () => {
  const controllerPath =
    'server/modules/duty-schedule/duty-schedule.controller.ts';
  const servicePath = 'server/modules/duty-schedule/duty-schedule.service.ts';

  it('removes legacy monthly schedule and construction password endpoints', () => {
    const source = readSource(controllerPath);

    for (const route of [
      'monthly-schedules/access/login-url',
      'monthly-schedules/access/password-login',
      'monthly-schedules/access/code-login',
      'monthly-schedules/access/oauth/callback',
      'monthly-schedules/access/check',
      'monthly-schedules/access/apply',
      'duty-schedules/construction-management/access',
    ]) {
      expect(source).not.toContain(route);
    }
    expect(source).not.toContain('MONTHLY_SCHEDULE_ACCESS_SESSION_COOKIE');
    expect(source).not.toContain('mergeMonthlyScheduleAccessIdentity');
    expect(source).not.toContain('verifyConstructionManagementAccess');
  });

  it('keeps public screenshot verification and guarded business routes', () => {
    const source = readSource(controllerPath);

    expect(source).toMatch(
      /@PublicAccess\(\)\s+@Post\('monthly-schedules\/access\/screenshot-check'\)/,
    );
    expect(source).toContain("@Get('monthly-schedules/:year/:month')");
    expect(source).toContain("@Get('duty-schedules/construction-management')");
    expect(source).toContain(
      "@Post('duty-schedules/construction-management/applications')",
    );
    expect(source).toMatch(
      /@AdminOnly\(\)\s+@ProfessionalScoped\(\)\s+@Post\('duty-schedules\/construction-management\/projects\/delete'\)/,
    );
  });

  it('removes legacy local-password configuration and service checks', () => {
    const source = readSource(servicePath);

    for (const legacySymbol of [
      'constructionDeleteAdminPassword',
      'CONSTRUCTION_DELETE_ADMIN_PASSWORD',
      'monthlyScheduleAccessLocalPassword',
      'MONTHLY_SCHEDULE_LOCAL_ADMIN_PASSWORD',
      'SCHEDULE_LOCAL_ADMIN_PASSWORD',
      'createMonthlyScheduleAccessPasswordSession',
      'isMonthlyScheduleAccessLocalPasswordMatched',
      'verifyConstructionManagementAccess',
      'request?.adminPassword',
    ]) {
      expect(source).not.toContain(legacySymbol);
    }
  });

  it('removes the unreachable monthly schedule OAuth, group and code access service', () => {
    const source = readSource(servicePath);

    for (const legacySymbol of [
      'createMonthlyScheduleAccessLoginUrl',
      'createMonthlyScheduleAccessCodeSession',
      'completeMonthlyScheduleAccessOAuth',
      'getMonthlyScheduleAccessSession',
      'verifyMonthlyScheduleAccess',
      'applyMonthlyScheduleAccess',
      'fetchMonthlyScheduleAccessMemberIds',
      'sendMonthlyScheduleAccessNotification',
      'monthlyScheduleAccessOAuthStates',
      'monthlyScheduleAccessVerificationCodes',
    ]) {
      expect(source).not.toContain(legacySymbol);
    }

    expect(source).toContain('verifyMonthlyScheduleScreenshotAccess');
  });

  it('passes only the guard-derived role into destructive-capable service paths', () => {
    const source = readSource(controllerPath);
    const followupSource = source.slice(
      source.indexOf('async createConstructionFollowup('),
      source.indexOf('async deleteConstructionAttachment('),
    );
    const adjustmentSource = source.slice(
      source.indexOf('async updateChangeScheduleAdjustment('),
      source.indexOf('async getTodayFocusChecklist('),
    );

    expect(source).toContain('accessPrincipalFingerprint?: string;');
    expect(followupSource).toContain(
      '@Req() request: DutyScheduleAccessRequest',
    );
    expect(followupSource).toContain("request.accessRole ?? 'guest'");
    expect(adjustmentSource).toContain(
      '@Req() request: DutyScheduleAccessRequest',
    );
    expect(adjustmentSource).toContain("request.accessRole ?? 'guest'");
    expect(adjustmentSource).toContain('throw new ForbiddenException(');
  });
});
