import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AdminOnly,
  AdminOnlyMetadataKey,
  GuestReadable,
  GuestReadableMetadataKey,
  PublicAccess,
  PublicAccessMetadataKey,
} from '../../server/common/access/unified-access.decorators';
import * as accessDecorators from '../../server/common/access/unified-access.decorators';

const EXPECTED_GUEST_SUBMITTABLE_METADATA_KEY =
  'unified-access:guest-submittable';

type ControllerSourceKey =
  | 'unified'
  | 'duty'
  | 'bitable'
  | 'weatherWarning'
  | 'purchase'
  | 'inventory'
  | 'contract';
type SourceMetadataCase = [ControllerSourceKey, string];

const controllerSources: Record<ControllerSourceKey, string> = {
  unified: readFileSync(
    join(process.cwd(), 'server/common/access/unified-access.controller.ts'),
    'utf8',
  ),
  duty: readFileSync(
    join(
      process.cwd(),
      'server/modules/duty-schedule/duty-schedule.controller.ts',
    ),
    'utf8',
  ),
  bitable: readFileSync(
    join(
      process.cwd(),
      'server/modules/bitable-sync/bitable-sync.controller.ts',
    ),
    'utf8',
  ),
  weatherWarning: readFileSync(
    join(
      process.cwd(),
      'server/modules/weather-warning/weather-warning.controller.ts',
    ),
    'utf8',
  ),
  purchase: readFileSync(
    join(
      process.cwd(),
      'server/modules/purchase-inventory/purchase-inventory.controller.ts',
    ),
    'utf8',
  ),
  inventory: readFileSync(
    join(
      process.cwd(),
      'server/modules/inventory-management/inventory-management.controller.ts',
    ),
    'utf8',
  ),
  contract: readFileSync(
    join(
      process.cwd(),
      'server/modules/contract-management/contract-management.controller.ts',
    ),
    'utf8',
  ),
};

const getMethodDecoratorBlock = (
  sourceKey: ControllerSourceKey,
  methodName: string,
) => {
  const source = controllerSources[sourceKey];
  const methodMatch = new RegExp(
    `^  (?:async )?${methodName}\\s*\\(`,
    'm',
  ).exec(source);
  if (!methodMatch) {
    throw new Error(`${sourceKey}.${methodName} method not found`);
  }
  const previousMethodEnd = source.lastIndexOf('\n  }', methodMatch.index);
  return source.slice(
    previousMethodEnd === -1 ? 0 : previousMethodEnd + 4,
    methodMatch.index,
  );
};

@AdminOnly()
class AdminOnlyFixture {}

class MethodMetadataFixture {
  @GuestReadable()
  guestReadable() {}

  @PublicAccess()
  publicAccess() {}

  @AdminOnly()
  adminOnly() {}
}

describe('unified access controller route metadata', () => {
  it('publishes the runtime probe as GET /api/access/runtime', () => {
    expect(controllerSources.unified).toContain("@Controller('api/access')");
    const decoratorBlock = getMethodDecoratorBlock('unified', 'runtime');
    expect(decoratorBlock).toContain('@PublicAccess()');
    expect(decoratorBlock).toContain("@Get('runtime')");
  });

  it('stores each access decorator as real Reflect metadata', () => {
    expect(Reflect.getMetadata(AdminOnlyMetadataKey, AdminOnlyFixture)).toBe(
      true,
    );
    expect(
      Reflect.getMetadata(
        GuestReadableMetadataKey,
        MethodMetadataFixture.prototype.guestReadable,
      ),
    ).toBe(true);
    expect(
      Reflect.getMetadata(
        PublicAccessMetadataKey,
        MethodMetadataFixture.prototype.publicAccess,
      ),
    ).toBe(true);
    expect(
      Reflect.getMetadata(
        AdminOnlyMetadataKey,
        MethodMetadataFixture.prototype.adminOnly,
      ),
    ).toBe(true);
  });

  it('exports GuestSubmittable and stores its fixed metadata contract', () => {
    const exports = accessDecorators as unknown as Record<string, unknown>;
    const metadataKey = exports.GuestSubmittableMetadataKey;
    const guestSubmittable = exports.GuestSubmittable;

    expect(metadataKey).toBe(EXPECTED_GUEST_SUBMITTABLE_METADATA_KEY);
    expect(guestSubmittable).toEqual(expect.any(Function));

    class SubmissionFixture {
      submit() {}
    }
    const handler = SubmissionFixture.prototype.submit;
    const descriptor = Object.getOwnPropertyDescriptor(
      SubmissionFixture.prototype,
      'submit',
    );
    if (typeof guestSubmittable === 'function') {
      (guestSubmittable as () => MethodDecorator)()(
        SubmissionFixture.prototype,
        'submit',
        descriptor as TypedPropertyDescriptor<unknown>,
      );
    }

    expect(Reflect.getMetadata(metadataKey as string, handler)).toBe(true);
  });

  it.each<SourceMetadataCase>([
    ['duty', 'getBuildings'],
    ['duty', 'getDutySchedules'],
    ['duty', 'getMonthlySchedules'],
    ['duty', 'getTravelStaffDetails'],
    ['duty', 'getLongWhiteDutyStaff'],
    ['duty', 'getConstructionManagement'],
    ['duty', 'downloadConstructionAttachment'],
    ['duty', 'getExceptionFollowUps'],
    ['duty', 'getYearlySealingInfo'],
    ['duty', 'getYearlyChangeInfo'],
    ['duty', 'getTodayFocusChecklist'],
    ['bitable', 'getWeatherNow'],
    ['bitable', 'getWeatherWarning'],
    ['bitable', 'getWeatherHourly'],
    ['bitable', 'getPersonProfiles'],
    ['bitable', 'getFestivalSchedules'],
    ['bitable', 'getTodayLeaveStaff'],
    ['bitable', 'getCampusOperationsDashboard'],
    ['bitable', 'getTodayOperationsAlarms'],
    ['bitable', 'getTodayOperationsOverview'],
    ['weatherWarning', 'getSnapshot'],
    ['weatherWarning', 'getRegistrationOptions'],
  ])('%s.%s is explicitly guest readable', (sourceKey, methodName) => {
    expect(getMethodDecoratorBlock(sourceKey, methodName)).toContain(
      '@GuestReadable()',
    );
  });

  it.each<SourceMetadataCase>([
    ['duty', 'getConstructionOnsiteFollowers'],
    ['duty', 'getConstructionChangeOrders'],
    ['duty', 'syncFromFeishuBase'],
    ['duty', 'syncAllFromFeishu'],
    ['duty', 'getSyncTask'],
    ['bitable', 'syncFromBitable'],
    ['bitable', 'getBitableRecords'],
    ['bitable', 'syncOrganization'],
    ['bitable', 'getOrganizations'],
    ['bitable', 'getDutyStaff'],
    ['bitable', 'getEmployeePhoto'],
    ['bitable', 'syncHolidayDutySchedule'],
    ['bitable', 'getHolidayDutySchedules'],
    ['bitable', 'syncNonDutySchedule'],
    ['bitable', 'getNonDutySchedules'],
    ['bitable', 'debugRecord'],
    ['bitable', 'getTableFields'],
    ['weatherWarning', 'getTestPreview'],
    ['weatherWarning', 'sendTest'],
    ['weatherWarning', 'submitRegistration'],
  ])('%s.%s is not guest readable', (sourceKey, methodName) => {
    expect(getMethodDecoratorBlock(sourceKey, methodName)).not.toContain(
      '@GuestReadable()',
    );
  });

  it.each<SourceMetadataCase>([['weatherWarning', 'submitRegistration']])(
    '%s.%s is explicitly guest submittable',
    (sourceKey, methodName) => {
      expect(getMethodDecoratorBlock(sourceKey, methodName)).toContain(
        '@GuestSubmittable()',
      );
    },
  );

  it.each<SourceMetadataCase>([
    ['duty', 'checkMonthlyScheduleScreenshotAccess'],
  ])('%s.%s is public', (sourceKey, methodName) => {
    expect(getMethodDecoratorBlock(sourceKey, methodName)).toContain(
      '@PublicAccess()',
    );
  });

  it('contains no purchase personal OAuth route or cookie', () => {
    expect(controllerSources.purchase).not.toContain('application-auth/');
    expect(controllerSources.purchase).not.toContain(
      'purchase_application_user_session',
    );
  });

  it.each<SourceMetadataCase>([
    ['duty', 'deleteConstructionAttachment'],
    ['duty', 'deleteConstructionProject'],
    ['duty', 'deleteExceptionFollowUp'],
    ['duty', 'revokeTravelStaff'],
    ['purchase', 'selfTestWorkflows'],
    ['inventory', 'selfTestWorkflows'],
    ['contract', 'selfTestWorkflows'],
    ['weatherWarning', 'getTestPreview'],
    ['weatherWarning', 'sendTest'],
  ])('%s.%s is admin-only', (sourceKey, methodName) => {
    expect(getMethodDecoratorBlock(sourceKey, methodName)).toContain(
      '@AdminOnly()',
    );
  });

  it.each<SourceMetadataCase>([
    ['weatherWarning', 'getRegistrationOptions'],
    ['weatherWarning', 'submitRegistration'],
  ])('%s.%s is not admin-only', (sourceKey, methodName) => {
    expect(getMethodDecoratorBlock(sourceKey, methodName)).not.toContain(
      '@AdminOnly()',
    );
  });

  it.each<SourceMetadataCase>([['duty', 'terminateConstructionProject']])(
    '%s.%s remains available to editors',
    (sourceKey, methodName) => {
      expect(getMethodDecoratorBlock(sourceKey, methodName)).not.toContain(
        '@AdminOnly()',
      );
    },
  );

  it('protects the contract controller for administrators only', () => {
    const source = controllerSources.contract;
    const classIndex = source.indexOf(
      'export class ContractManagementController',
    );
    expect(classIndex).toBeGreaterThan(-1);
    expect(source.slice(Math.max(0, classIndex - 300), classIndex)).toContain(
      '@AdminOnly()',
    );
  });

  it('enumerates every delete or batch-delete route and enforces its intended access metadata', () => {
    const routePattern =
      /@(Get|Post|Patch|Put|Delete)\(\s*['"]([^'"]*(?:delete|batch-delete)[^'"]*)['"]\s*\)/g;
    const deleteRoutes = Object.entries(controllerSources).flatMap(
      ([sourceKey, source]) =>
        Array.from(source.matchAll(routePattern), (match) => ({
          sourceKey: sourceKey as ControllerSourceKey,
          httpMethod: match[1],
          path: match[2],
        })),
    );

    expect(deleteRoutes).toEqual([
      {
        sourceKey: 'duty',
        httpMethod: 'Post',
        path: 'duty-schedules/change-attachments/:id/delete',
      },
      {
        sourceKey: 'duty',
        httpMethod: 'Post',
        path: 'duty-schedules/construction-management/attachments/delete',
      },
      {
        sourceKey: 'duty',
        httpMethod: 'Post',
        path: 'duty-schedules/construction-management/projects/delete',
      },
      {
        sourceKey: 'duty',
        httpMethod: 'Post',
        path: 'duty-schedules/exception-follow-up/delete',
      },
      {
        sourceKey: 'purchase',
        httpMethod: 'Post',
        path: 'records/batch-delete',
      },
    ]);

    for (const [sourceKey, methodName] of [
      ['duty', 'deleteConstructionAttachment'],
      ['duty', 'deleteConstructionProject'],
      ['duty', 'deleteExceptionFollowUp'],
    ] as SourceMetadataCase[]) {
      const decoratorBlock = getMethodDecoratorBlock(sourceKey, methodName);
      expect(decoratorBlock).toContain('@Post(');
      expect(decoratorBlock).toContain('@AdminOnly()');
    }

    const stagedChangeAttachmentDelete = getMethodDecoratorBlock(
      'duty',
      'deleteStagedChangeAttachment',
    );
    expect(stagedChangeAttachmentDelete).toContain('@GuestSubmittable()');
    expect(stagedChangeAttachmentDelete).not.toContain('@AdminOnly()');

    expect(getMethodDecoratorBlock('purchase', 'deleteRecords')).not.toContain(
      '@AdminOnly()',
    );
  });
});
