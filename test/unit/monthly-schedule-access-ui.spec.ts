import { readFileSync } from 'fs';
import { join } from 'path';

const readSource = (relativePath: string) =>
  readFileSync(join(process.cwd(), relativePath), 'utf8');

describe('monthly schedule unified access UI', () => {
  const pageSource = readSource('client/src/pages/MonthlySchedule/index.tsx');
  const apiSource = readSource('client/src/api/index.ts');
  const sharedSource = readSource('shared/api.interface.ts');

  it('uses the global capabilities for edit and destructive actions', () => {
    expect(pageSource).toContain(
      "import { useAccess } from '@/access/AccessProvider';",
    );
    expect(pageSource).toContain('const { capabilities, role } = useAccess();');
    expect(pageSource).toContain(
      'const canManageMonthlySchedule = capabilities.canEdit;',
    );
    expect(pageSource).toContain(
      'const canDeleteMonthlySchedule = capabilities.canDelete;',
    );

    const revokeSource = pageSource.slice(
      pageSource.indexOf('const handleRevokeTravelDetail'),
      pageSource.indexOf('const confirmRevokeTravelDetail'),
    );
    const confirmRevokeSource = pageSource.slice(
      pageSource.indexOf('const confirmRevokeTravelDetail'),
      pageSource.indexOf('const handleSubmitLeaveRequest'),
    );
    const exceptionDeleteSource = pageSource.slice(
      pageSource.indexOf('const handleDeleteExceptionFollowUpItem'),
      pageSource.indexOf('const handleDeleteExceptionFollowUp ='),
    );
    const adjustmentRevokeSource = pageSource.slice(
      pageSource.indexOf('const handleClearChangeAdjustment'),
      pageSource.indexOf('const currentMonthLabel'),
    );

    for (const destructiveSource of [
      revokeSource,
      confirmRevokeSource,
      exceptionDeleteSource,
      adjustmentRevokeSource,
    ]) {
      expect(destructiveSource).toContain('canDeleteMonthlySchedule');
      expect(destructiveSource).not.toContain('if (!canManageMonthlySchedule)');
    }
  });

  it('removes the page-local OAuth, password and identity switch gate', () => {
    for (const legacySymbol of [
      'MonthlyScheduleAccessGuard',
      'MonthlyScheduleAccessScreen',
      'MonthlyScheduleIdentitySwitch',
      'MonthlyScheduleAccessRoleContext',
      'checkMonthlyScheduleAccess',
      'applyMonthlyScheduleAccess',
      'getMonthlyScheduleAccessLoginUrl',
      'loginMonthlyScheduleAccessByPassword',
      'loginMonthlyScheduleAccessByCode',
      'canApplyMonthlyScheduleAccess',
    ]) {
      expect(pageSource).not.toContain(legacySymbol);
    }

    expect(pageSource).toContain('checkMonthlyScheduleScreenshotAccess');
  });

  it('removes legacy monthly access DTOs and client API methods', () => {
    for (const legacySymbol of [
      'MonthlyScheduleAccessCheckRequest',
      'MonthlyScheduleAccessCheckResponse',
      'MonthlyScheduleAccessApplyRequest',
      'MonthlyScheduleAccessApplyResponse',
      'MonthlyScheduleAccessCodeLoginRequest',
      'MonthlyScheduleAccessCodeLoginResponse',
      'MonthlyScheduleAccessLoginUrlResponse',
      'MonthlyScheduleAccessPasswordLoginRequest',
      'MonthlyScheduleAccessPasswordLoginResponse',
    ]) {
      expect(sharedSource).not.toContain(legacySymbol);
      expect(apiSource).not.toContain(legacySymbol);
    }

    expect(sharedSource).toContain('MonthlyScheduleScreenshotAccessRequest');
    expect(apiSource).toContain('checkMonthlyScheduleScreenshotAccess');
  });

  it('only force-refreshes date follow-ups for roles with refresh capability', () => {
    const detailRefreshSource = pageSource.slice(pageSource.indexOf('const fetchCalendarFollowUps'), pageSource.indexOf('const exceptionFollowUpsByKey'));

    expect(detailRefreshSource).toMatch(
      /getExceptionFollowUps\(range\.start, force && capabilities\.canForceRefresh, range\.end\)/,
    );
    expect(detailRefreshSource).not.toContain(
      'loadExceptionFollowUpsForDate(calendarDetailDateKey, true)',
    );
  });

  it('downgrades a persisted refresh token after losing refresh capability', () => {
    expect(pageSource).toMatch(
      /const effectiveDataRefreshToken\s*=\s*capabilities\.canForceRefresh\s*\?\s*dataRefreshToken\s*:\s*0;/,
    );
    expect(
      pageSource.match(/refreshToken=\{effectiveDataRefreshToken\}/g),
    ).toHaveLength(2);
    expect(pageSource).not.toContain('refreshToken={dataRefreshToken}');
  });
});
