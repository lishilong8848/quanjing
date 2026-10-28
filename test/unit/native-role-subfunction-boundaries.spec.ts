import 'reflect-metadata';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type {
  AccessPrincipal,
  AccessRole,
} from '../../shared/access-control.interface';
import {
  PAGE_ACCESS_ROLES,
  effectivePagePaths,
} from '../../shared/page-access';
import { roleBuildingOptions } from '../../shared/building-access';
import {
  canPerformBusinessAction,
  type BusinessAction,
  type BusinessModule,
} from '../../shared/business-permissions';
import { classifyBusinessRequest } from '../../shared/business-request-permission';
import { changeAttachmentMutationPermission } from '../../shared/change-attachment-permission';
import { SITE_MEMBER_BACKUP_ACCOUNT_ID } from '../../shared/site-member-backup';
import { UnifiedAccessGuard } from '../../server/common/access/unified-access.guard';
import { bindWorkforceRequestApplicant } from '../../server/common/access/workforce-request-applicant';
import { DutyScheduleController } from '../../server/modules/duty-schedule/duty-schedule.controller';
import { BitableSyncController } from '../../server/modules/bitable-sync/bitable-sync.controller';
import { TodayAttendanceController } from '../../server/modules/duty-schedule/today-attendance.controller';
import { EmergencyDutyController } from '../../server/modules/duty-schedule/emergency-duty.controller';

const all = [...PAGE_ACCESS_ROLES],
  editors: AccessRole[] = ['admin', 'editor', 'duty_editor'];
const noGuest = all.filter((role) => role !== 'guest');
const sourceRefresh = all.filter(
  (role) =>
    ![
      'guest',
      'site_member',
      'professional_admin',
      'professional_engineer',
    ].includes(role),
);
// Read from the frozen pre-V2 guard, including GuestReadable/Submittable,
// site-member exceptions and the fixed private handler role checks.
const defaults: {
  module: BusinessModule;
  action: BusinessAction;
  roles: AccessRole[];
}[] = [
  {
    module: 'change_requests',
    action: 'create',
    roles: all.filter((role) => role !== 'site_member'),
  },
  { module: 'change_documents', action: 'read', roles: editors },
  { module: 'change_documents', action: 'export', roles: editors },
  { module: 'personnel_schedule', action: 'read', roles: noGuest },
  { module: 'personnel_schedule', action: 'refresh', roles: sourceRefresh },
  {
    module: 'non_duty_schedule',
    action: 'read',
    roles: ['admin', 'editor', 'site_member'],
  },
  {
    module: 'non_duty_schedule',
    action: 'refresh',
    roles: ['admin', 'editor'],
  },
  ...(['read', 'update', 'refresh'] as const).map((action) => ({
    module: 'schedule_diagnostics' as const,
    action,
    roles: ['admin', 'editor'] as AccessRole[],
  })),
  { module: 'attendance', action: 'read', roles: noGuest },
  { module: 'attendance', action: 'refresh', roles: sourceRefresh },
  {
    module: 'schedule_assignments',
    action: 'read',
    roles: ['admin', 'editor', 'duty_editor', 'site_member'],
  },
  { module: 'change_management', action: 'create', roles: editors },
  { module: 'change_management', action: 'delete', roles: editors },
  { module: 'leave_requests', action: 'create', roles: all },
  { module: 'overtime_requests', action: 'create', roles: all },
  {
    module: 'personality',
    action: 'create',
    roles: all.filter((role) => role !== 'site_member'),
  },
];
function native(role: AccessRole): AccessPrincipal {
  const building = roleBuildingOptions(role)?.[0] || null;
  return {
    role,
    purchaseBuilding: building,
    ...(building ? { buildings: [building] } : {}),
    ...(['professional_admin', 'professional_engineer'].includes(role)
      ? { specialties: ['电气' as const] }
      : {}),
    accountId: `feishu-${'a'.repeat(64)}`,
    displayName: '合成人员',
    authorizationVersion: 1,
    effectiveAuthorization: {
      mode: 'independent',
      baseline: {
        nativeRole: role,
        pages: effectivePagePaths(role),
        rules: [],
      },
      overrides: { rules: [], allowPages: [], denyPages: [] },
    },
  };
}
function explicit(
  module: BusinessModule,
  action: BusinessAction,
): AccessPrincipal {
  return {
    ...native('guest'),
    effectiveAuthorization: {
      mode: 'independent',
      baseline: {
        nativeRole: null,
        pages: ['/monthly-schedule'],
        rules: [
          {
            id: 'synthetic-explicit',
            module,
            actions: [action],
            effect: 'allow',
            buildings: null,
            specialties: null,
          },
        ],
      },
      overrides: { rules: [], allowPages: [], denyPages: [] },
    },
  };
}
function probe(
  principal: AccessPrincipal,
  path: string,
  method: string,
  controller: Function,
  handler: Function,
): boolean {
  const guard = new UnifiedAccessGuard(new Reflector(), {
    cookieName: 'synthetic_access',
    isAccessControlEnabled: () => true,
    renew: () => ({
      principal,
      principalFingerprint: 'synthetic-family',
      token: 'synthetic',
      expiresAt: Date.now() + 60000,
    }),
  } as never);
  const request = {
    method,
    url: path,
    originalUrl: path,
    path: path.split('?')[0],
    query: Object.fromEntries(
      new URL(path, 'https://synthetic.invalid').searchParams,
    ),
    headers: { cookie: 'synthetic_access=synthetic' },
    socket: { remoteAddress: '127.0.0.1' },
  };
  const response = {
    once: jest.fn(),
    cookie: jest.fn(),
    clearCookie: jest.fn(),
  };
  return guard.canActivate({
    getClass: () => controller,
    getHandler: () => handler,
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
  } as unknown as ExecutionContext);
}

describe('native role defaults preserve old private/overview/action boundaries', () => {
  it.each(PAGE_ACCESS_ROLES)(
    '%s matches each reviewed native capability',
    (role) => {
      const actor = native(role);
      for (const row of defaults)
        expect({
          role,
          module: row.module,
          action: row.action,
          allowed: canPerformBusinessAction(actor, row),
        }).toEqual({
          role,
          module: row.module,
          action: row.action,
          allowed: row.roles.includes(role),
        });
    },
  );
  it.each(PAGE_ACCESS_ROLES)(
    '%s is checked by the actual guard at the split endpoints',
    (role) => {
      const cases: [string, string, Function, Function, AccessRole[]][] = [
        [
          '/api/attendance/today',
          'GET',
          TodayAttendanceController,
          TodayAttendanceController.prototype.getTodayAttendance,
          noGuest,
        ],
        [
          '/api/duty-schedules/long-white-duty-staff',
          'GET',
          DutyScheduleController,
          DutyScheduleController.prototype.getLongWhiteDutyStaff,
          noGuest,
        ],
        [
          '/api/duty-schedules/long-white-duty-staff?refresh=1',
          'GET',
          DutyScheduleController,
          DutyScheduleController.prototype.getLongWhiteDutyStaff,
          sourceRefresh,
        ],
        [
          '/api/bitable/non-duty-schedules',
          'GET',
          BitableSyncController,
          BitableSyncController.prototype.getNonDutySchedules,
          ['admin', 'editor', 'site_member'],
        ],
        [
          '/api/bitable/sync-non-duty',
          'POST',
          BitableSyncController,
          BitableSyncController.prototype.syncNonDutySchedule,
          ['admin', 'editor'],
        ],
        [
          '/api/duty-program-modified/scan',
          'GET',
          DutyScheduleController,
          DutyScheduleController.prototype.scanDutyProgramModifiedIssues,
          ['admin', 'editor'],
        ],
        [
          '/api/duty-schedules/emergency-duty/options',
          'GET',
          EmergencyDutyController,
          EmergencyDutyController.prototype.getOptions,
          ['admin', 'editor', 'duty_editor', 'site_member'],
        ],
        [
          '/api/duty-schedules/change-records/recSynthetic/attachments/synthetic-file',
          'GET',
          DutyScheduleController,
          DutyScheduleController.prototype.downloadChangeRecordAttachment,
          editors,
        ],
        [
          '/api/duty-schedules/change-request',
          'POST',
          DutyScheduleController,
          DutyScheduleController.prototype.createChangeRequest,
          all.filter((value) => value !== 'site_member'),
        ],
        [
          '/api/duty-schedules/change-drill-report',
          'POST',
          DutyScheduleController,
          DutyScheduleController.prototype.createChangeDrillReport,
          editors,
        ],
        [
          '/api/duty-schedules/change-summary-report/abandon',
          'POST',
          DutyScheduleController,
          DutyScheduleController.prototype.abandonChangeSummaryReport,
          editors,
        ],
      ];
      for (const [path, method, Controller, handler, allowed] of cases)
        expect({
          path,
          role,
          allowed: probe(native(role), path, method, Controller, handler),
        }).toEqual({ path, role, allowed: allowed.includes(role) });
    },
  );
  it('a null base cannot derive private reads from the shared monthly page, but explicit rules can grant them', () => {
    for (const module of [
      'attendance',
      'schedule_assignments',
      'personnel_schedule',
      'non_duty_schedule',
      'schedule_diagnostics',
      'change_documents',
    ] as const) {
      const actor = explicit(module, 'read');
      actor.effectiveAuthorization!.baseline.rules = [];
      expect(canPerformBusinessAction(actor, { module, action: 'read' })).toBe(
        false,
      );
      expect(
        canPerformBusinessAction(explicit(module, 'read'), {
          module,
          action: 'read',
        }),
      ).toBe(true);
    }
  });
  it.each(['professional_admin', 'professional_engineer'] as const)(
    '%s has no native construction write while explicit rules remain available',
    (role) => {
      expect(
        canPerformBusinessAction(native(role), {
          module: 'construction',
          action: 'create',
        }),
      ).toBe(false);
      expect(
        probe(
          native(role),
          '/api/duty-schedules/construction-management/followups',
          'POST',
          DutyScheduleController,
          DutyScheduleController.prototype.createConstructionFollowup,
        ),
      ).toBe(false);
      expect(
        probe(
          explicit('construction', 'create'),
          '/api/duty-schedules/construction-management/followups',
          'POST',
          DutyScheduleController,
          DutyScheduleController.prototype.createConstructionFollowup,
        ),
      ).toBe(true);
    },
  );
  it('the fixed backup account cannot submit either workforce form even with explicit permission or a changed display role', () => {
    for (const role of ['guest', 'site_member', 'editor', 'admin'] as const)
      expect(() =>
        bindWorkforceRequestApplicant(
          '合成人员',
          { ...native(role), accountId: SITE_MEMBER_BACKUP_ACCOUNT_ID },
          true,
          '提交申请',
        ),
      ).toThrow('基地备用账号');
  });
});

const uuid = '12345678-1234-4123-8123-123456789abc',
  requestOwner = `change-request-${uuid}`,
  summaryOwner = `change-summary-report-${uuid}`,
  adjustmentOwner = `change-adjustment-${uuid}`;
describe('shared change attachments enforce the selected form action and original owner', () => {
  function fixture() {
    const storage = {
      resolveOwned: jest.fn(async () => ({})),
      delete: jest.fn(async () => true),
      getSignedDownloadUrl: jest.fn(async () => '/synthetic-owned'),
      getSignedDownloadUrlForTrustedServer: jest.fn(
        async () => '/synthetic-private',
      ),
    };
    return {
      storage,
      controller: Object.assign(
        Object.create(DutyScheduleController.prototype),
        { changeAttachmentStorage: storage },
      ) as DutyScheduleController,
    };
  }
  const req = (actor: AccessPrincipal) =>
    ({ accessPrincipal: actor, accessRole: actor.role }) as never;
  it('declares cross-module candidates and keeps malformed owner ids unclassified', () => {
    expect(
      classifyBusinessRequest(
        '/api/duty-schedules/change-attachments/stage',
        'POST',
      ).candidatePermissions,
    ).toEqual([
      { module: 'change_requests', action: 'create' },
      { module: 'change_management', action: 'create' },
      { module: 'change_management', action: 'update' },
    ]);
    expect(changeAttachmentMutationPermission(requestOwner)).toEqual({
      module: 'change_requests',
      action: 'create',
    });
    expect(changeAttachmentMutationPermission(adjustmentOwner)).toEqual({
      module: 'change_management',
      action: 'update',
    });
    expect(
      changeAttachmentMutationPermission('change-request-guessed'),
    ).toBeUndefined();
  });
  it('public request create cannot delete private summary attachments or download private documents without an owner', async () => {
    const { controller, storage } = fixture(),
      actor = explicit('change_requests', 'create');
    await expect(
      controller.deleteStagedChangeAttachment(
        'synthetic-id',
        summaryOwner,
        req(actor),
      ),
    ).rejects.toThrow();
    await expect(
      controller.downloadChangeAttachment(
        'synthetic-id',
        undefined,
        req(actor),
        { redirect: jest.fn() } as never,
      ),
    ).rejects.toThrow();
    expect(storage.resolveOwned).not.toHaveBeenCalled();
    expect(storage.getSignedDownloadUrlForTrustedServer).not.toHaveBeenCalled();
    await controller.deleteStagedChangeAttachment(
      'synthetic-id',
      requestOwner,
      req(actor),
    );
    expect(storage.resolveOwned).toHaveBeenCalledWith(
      'synthetic-id',
      requestOwner,
    );
    expect(storage.delete).toHaveBeenCalledWith('synthetic-id', {
      ownerMutationId: requestOwner,
    });
  });
  it('update-only may operate its adjustment draft but cannot borrow request or summary create', async () => {
    const { controller, storage } = fixture(),
      actor = explicit('change_management', 'update');
    await controller.deleteStagedChangeAttachment(
      'synthetic-id',
      adjustmentOwner,
      req(actor),
    );
    await expect(
      controller.deleteStagedChangeAttachment(
        'synthetic-id',
        requestOwner,
        req(actor),
      ),
    ).rejects.toThrow();
    await expect(
      controller.deleteStagedChangeAttachment(
        'synthetic-id',
        summaryOwner,
        req(actor),
      ),
    ).rejects.toThrow();
    expect(storage.delete).toHaveBeenCalledTimes(1);
  });
  it('the original object owner check still rejects a different owner mutation', async () => {
    const { controller, storage } = fixture();
    storage.resolveOwned.mockRejectedValueOnce(new Error('owner mismatch'));
    await expect(
      controller.deleteStagedChangeAttachment(
        'synthetic-id',
        requestOwner,
        req(explicit('change_requests', 'create')),
      ),
    ).rejects.toThrow('owner mismatch');
    expect(storage.delete).not.toHaveBeenCalled();
  });
});
