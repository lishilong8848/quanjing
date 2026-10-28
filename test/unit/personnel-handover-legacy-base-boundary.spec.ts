import type { AccountPermissionTemplate } from '../../shared/personnel-handover.interface';
import { BUILDING_ADMIN_BUILDINGS } from '../../shared/access-control.interface';
import {
  BUSINESS_PERMISSION_CATALOG,
  canPerformBusinessAction,
} from '../../shared/business-permissions';
import { PROFESSIONAL_SPECIALTIES } from '../../shared/professional-access';
import { effectivePagePaths } from '../../shared/page-access';
import { copyAccountPermissionTemplate } from '../../server/common/access/personnel-handover.preview';
import { frozenHandoverAuthorization } from '../../server/common/access/personnel-handover.authorization';
import {
  handoverPermissionGrantKeys,
  splitHandoverPermissionGrants,
} from '../../server/common/access/personnel-handover.ownership';

function legacy(): AccountPermissionTemplate {
  return {
    role: 'professional_engineer',
    building: 'B楼',
    buildings: ['B楼'],
    specialties: ['电气'],
    sourceVersion: 1,
    pagePaths: effectivePagePaths('professional_engineer'),
    personalRules: [
      {
        id: 'extra-A',
        module: 'equipment_ledger',
        effect: 'allow',
        actions: ['read'],
        buildings: ['A楼'],
        specialties: ['电气'],
      },
      {
        id: 'other-H',
        module: 'inventory',
        effect: 'allow',
        actions: ['read', 'confirm'],
        buildings: ['H楼'],
        specialties: ['暖通'],
      },
      {
        id: 'existing-limit',
        module: 'inventory',
        effect: 'deny',
        actions: ['delete'],
        buildings: ['B楼'],
        specialties: ['电气'],
      },
    ],
  };
}
function principal(value: AccountPermissionTemplate) {
  return {
    role: value.role,
    purchaseBuilding: value.building,
    buildings: value.buildings,
    specialties: value.specialties,
    personalRules: value.personalRules,
    effectiveAuthorization: value.effectiveAuthorization,
  };
}
function legacyGuest(): AccountPermissionTemplate {
  const value = legacy();
  value.role = 'guest';
  value.building = null;
  delete value.buildings;
  delete value.specialties;
  value.pagePaths = [
    ...effectivePagePaths('guest'),
    '/equipment-ledger-management',
    '/inventory-management',
  ];
  return value;
}
function selection(
  source: AccountPermissionTemplate,
  transfer: string[] = ['rule:extra-A'],
) {
  return handoverPermissionGrantKeys(source).map((key) => ({
    key,
    disposition: transfer.includes(key)
      ? ('transfer' as const)
      : ('retain' as const),
    ...(transfer.includes(key) ? { dutyRecordId: 'recDutyA' } : {}),
  }));
}
function expectSubset(
  source: AccountPermissionTemplate,
  candidate: AccountPermissionTemplate,
) {
  expect(() => copyAccountPermissionTemplate(candidate)).not.toThrow();
  for (const definition of BUSINESS_PERMISSION_CATALOG)
    for (const action of definition.actions) {
      const targets = definition.scoped
        ? BUILDING_ADMIN_BUILDINGS.flatMap((building) =>
            PROFESSIONAL_SPECIALTIES.map((specialty) => ({
              building,
              specialty,
            })),
          )
        : [{}];
      for (const scope of targets) {
        const point = { module: definition.id, action, ...scope };
        if (canPerformBusinessAction(principal(candidate), point))
          expect({
            point,
            allowed: canPerformBusinessAction(principal(source), point),
          }).toEqual({ point, allowed: true });
      }
    }
}

describe('V1 role split retains its actual source action boundary as catalogs grow', () => {
  it.each(['transfer', 'retain', 'shared'] as const)(
    'never grows effective actions when original role is %s',
    (disposition) => {
      const source = legacy(),
        choices = selection(source).map((row) =>
          row.key === 'role'
            ? {
                key: 'role',
                disposition,
                ...(disposition === 'retain'
                  ? {}
                  : { dutyRecordId: 'recDutyA' }),
              }
            : row,
        );
      const bytes = JSON.stringify(source),
        result = splitHandoverPermissionGrants(source, choices, ['recDutyA']);
      expectSubset(source, result.transfer);
      expectSubset(source, result.retained);
      for (const candidate of [result.transfer, result.retained])
        if (candidate.role === 'site_member') {
          expect(
            canPerformBusinessAction(principal(candidate), {
              module: 'leave_requests',
              action: 'create',
            }),
          ).toBe(true);
          expect(
            canPerformBusinessAction(principal(candidate), {
              module: 'overtime_requests',
              action: 'create',
            }),
          ).toBe(true);
        }
      expect(JSON.stringify(source)).toBe(bytes);
    },
  );
  it('preserves a deliberately selected pre-existing refresh grant', () => {
    const source = legacy();
    source.personalRules!.push({
      id: 'my-refresh',
      module: 'organization',
      effect: 'allow',
      actions: ['refresh'],
      buildings: null,
      specialties: null,
    });
    const { transfer } = splitHandoverPermissionGrants(
      source,
      selection(source, ['rule:extra-A', 'rule:my-refresh']),
      ['recDutyA'],
    );
    expect(
      canPerformBusinessAction(principal(transfer), {
        module: 'organization',
        action: 'refresh',
      }),
    ).toBe(true);
    expect(
      canPerformBusinessAction(principal(transfer), {
        module: 'overtime_requests',
        action: 'create',
      }),
    ).toBe(true);
    expectSubset(source, transfer);
  });
  it('does not turn a scoped V1 page entry into an unrestricted V2 baseline read', () => {
    const source = legacy(),
      { transfer } = splitHandoverPermissionGrants(source, selection(source), [
        'recDutyA',
      ]);
    const frozen = {
      ...transfer,
      effectiveAuthorization: frozenHandoverAuthorization(transfer),
    };
    expect(transfer.pagePaths).toContain('/equipment-ledger-management');
    expect(frozen.effectiveAuthorization.baseline.pages).not.toContain(
      '/equipment-ledger-management',
    );
    expect(
      canPerformBusinessAction(principal(frozen), {
        module: 'equipment_ledger',
        action: 'read',
        building: 'A楼',
        specialty: '电气',
      }),
    ).toBe(true);
    expect(
      canPerformBusinessAction(principal(frozen), {
        module: 'equipment_ledger',
        action: 'read',
        building: 'B楼',
        specialty: '暖通',
      }),
    ).toBe(false);
    expectSubset(transfer, frozen);
  });
  it('does not overwrite a colliding original rule id and does not duplicate restrictions on another split', () => {
    const source = legacyGuest();
    source.personalRules!.push({
      id: 'handover-base-today_operations',
      module: 'quality',
      effect: 'deny',
      actions: ['update'],
      buildings: ['B楼'],
      specialties: ['电气'],
    });
    const { transfer } = splitHandoverPermissionGrants(
      source,
      selection(source),
      ['recDutyA'],
    );
    expect(
      transfer.personalRules?.find(
        (rule) => rule.id === 'handover-base-today_operations',
      ),
    ).toEqual(source.personalRules!.at(-1));
    expect(
      transfer.personalRules?.find(
        (rule) => rule.id === 'handover-base-today_operations-2',
      ),
    ).toMatchObject({
      module: 'today_operations',
      effect: 'deny',
      actions: ['read'],
    });
    const repeated = splitHandoverPermissionGrants(
      transfer,
      selection(transfer),
      ['recDutyA'],
    ).transfer;
    expect(repeated.personalRules).toEqual(transfer.personalRules);
    expectSubset(source, repeated);
  });
  it('rejects a restriction set above 100 rather than truncating source restrictions or mutating input', () => {
    const source = legacyGuest();
    for (let index = 0; index < 93; index++)
      source.personalRules!.push({
        id: `limit-${index}`,
        module: 'quality',
        effect: 'deny',
        actions: ['update'],
        buildings: ['B楼'],
        specialties: ['电气'],
      });
    const bytes = JSON.stringify(source);
    expect(() =>
      splitHandoverPermissionGrants(source, selection(source), ['recDutyA']),
    ).toThrow('超过100条');
    expect(JSON.stringify(source)).toBe(bytes);
  });
  it('accepts exactly 100 resulting rules with every original restriction preserved', () => {
    const source = legacyGuest();
    for (let index = 0; index < 92; index++)
      source.personalRules!.push({
        id: `limit-${index}`,
        module: 'quality',
        effect: 'deny',
        actions: ['update'],
        buildings: ['B楼'],
        specialties: ['电气'],
      });
    const { transfer } = splitHandoverPermissionGrants(
      source,
      selection(source),
      ['recDutyA'],
    );
    expect(transfer.personalRules).toHaveLength(100);
    expect(
      transfer
        .personalRules!.filter((rule) => rule.id.startsWith('handover-base-'))
        .map((rule) => rule.module)
        .sort(),
    ).toEqual([
      'alarm_review',
      'attendance',
      'non_duty_schedule',
      'personnel_schedule',
      'schedule_assignments',
      'today_operations',
    ]);
    for (const restriction of source.personalRules!.filter(
      (rule) => rule.effect === 'deny',
    ))
      expect(transfer.personalRules).toContainEqual(restriction);
    expectSubset(source, transfer);
  });
  it('keeps a V2 null baseline empty and does not inject V1 site-member restrictions', () => {
    const source: AccountPermissionTemplate = {
      role: 'guest',
      building: null,
      sourceVersion: 1,
      pagePaths: ['/equipment-ledger-management'],
      effectiveAuthorization: {
        mode: 'independent',
        baseline: {
          nativeRole: null,
          pages: [],
          rules: [
            {
              id: 'A-read',
              module: 'equipment_ledger',
              effect: 'allow',
              actions: ['read'],
              buildings: ['A楼'],
              specialties: ['电气'],
            },
          ],
        },
        overrides: { rules: [], allowPages: [], denyPages: [] },
      },
    };
    const result = splitHandoverPermissionGrants(
      source,
      selection(source, ['v2:base-rule:A-read']),
      ['recDutyA'],
    );
    expect(
      result.transfer.effectiveAuthorization!.baseline.nativeRole,
    ).toBeNull();
    expect(
      result.retained.effectiveAuthorization!.baseline.nativeRole,
    ).toBeNull();
    expect(result.transfer.personalRules || []).toEqual([]);
    expectSubset(source, result.transfer);
    expectSubset(source, result.retained);
  });
});
