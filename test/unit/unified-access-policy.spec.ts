import {
  canSubmitChangeDrillReportForRole,
  PURCHASE_ACCESS_BUILDINGS,
  type AccessLoginAccountType,
  type AccessPrincipal,
  type AccessLoginRequest,
  type AccessRole,
  type AccessSessionResponse,
  type PrivilegedAccessPrincipal,
} from '../../shared/access-control.interface';
import {
  canAccessPage,
  canCreatePurchaseApplication,
  canDeleteCompletedPurchaseRecords,
  canDeletePurchaseRecord,
  canEditPurchaseRecord,
  canManagePurchaseWorkflow,
  canOrderPurchaseRecord,
  canReceivePurchaseRecord,
  capabilitiesForRole,
  getAccessRoleLabel,
  getPostLoginPath,
  getUnifiedLoginAccountTypes,
  isControlledScreenshotPageRequest,
  isPersistedDeleteAction,
  normalizeAccessSession,
} from '../../client/src/access/access-policy';
import type { PurchaseInventoryRequestItem } from '../../shared/purchase-inventory.interface';

const admin: AccessPrincipal = { role: 'admin', purchaseBuilding: null };
const editor: AccessPrincipal = { role: 'editor', purchaseBuilding: null };
const purchaseAdmin: AccessPrincipal = {
  role: 'purchase_admin',
  purchaseBuilding: null,
};
const supplyChainAdmin: AccessPrincipal = {
  role: 'supply_chain_admin',
  purchaseBuilding: null,
};
const applicantA: AccessPrincipal = {
  role: 'purchase_applicant',
  purchaseBuilding: 'A楼',
};
const guest: AccessPrincipal = { role: 'guest', purchaseBuilding: null };

describe('change drill report access', () => {
  it.each(['admin', 'editor', 'duty_editor'] as const)(
    'allows the backend-approved %s role',
    (role) => {
      expect(canSubmitChangeDrillReportForRole(role)).toBe(true);
    },
  );

  it.each([
    'guest',
    'inventory_admin',
    'purchase_admin',
    'purchase_applicant',
    'supply_chain_admin',
    'construction_admin',
  ] as const)('rejects the unrelated %s role', (role) => {
    expect(canSubmitChangeDrillReportForRole(role)).toBe(false);
  });
});

describe('normalizeAccessSession', () => {
  it('preserves the server-issued principal fingerprint', () => {
    expect(
      normalizeAccessSession({
        role: 'editor',
        purchaseBuilding: null,
        expiresAt: 1_800_000_000_000,
        principalFingerprint: 'a'.repeat(43),
      }).principalFingerprint,
    ).toBe('a'.repeat(43));
  });

  it('fills capabilities when an older or incomplete session omits them', () => {
    expect(
      normalizeAccessSession({
        role: 'guest',
        purchaseBuilding: null,
        expiresAt: null,
      }),
    ).toEqual({
      role: 'guest',
      purchaseBuilding: null,
      expiresAt: null,
      capabilities: capabilitiesForRole('guest'),
      pagePaths: ['/nantong-base', '/monthly-schedule', '/mbti-assessment'],
    });
  });
});

describe('controlled screenshot page access', () => {
  it('allows only a fully formed campus screenshot request to reach token verification', () => {
    expect(
      isControlledScreenshotPageRequest(
        '/campus-operations-dashboard',
        '?screenshot=1&screenshotDate=2026-07-22&screenshotShift=white&screenshotToken=v1.test.signature',
      ),
    ).toBe(true);

    for (const [pathname, search] of [
      [
        '/campus-operations-dashboard',
        '?screenshot=1&screenshotDate=2026-07-22&screenshotShift=white',
      ],
      [
        '/campus-operations-dashboard',
        '?screenshot=1&screenshotDate=2026-07-22&screenshotShift=invalid&screenshotToken=v1.test.signature',
      ],
      [
        '/campus-operations-dashboard-archive',
        '?screenshot=1&screenshotDate=2026-07-22&screenshotShift=white&screenshotToken=v1.test.signature',
      ],
      [
        '/today-operations-panorama',
        '?screenshot=1&screenshotDate=2026-07-22&screenshotShift=white&screenshotToken=v1.test.signature',
      ],
    ] as const) {
      expect(isControlledScreenshotPageRequest(pathname, search)).toBe(false);
    }
  });
});

const feishuRolePageCases = [
  {
    role: 'duty_editor' as AccessRole,
    allowedPaths: [
      '/monthly-schedule',
      '/Monthly-Schedule///',
      '/construction-management',
    ],
    deniedPaths: [
      '/',
      '/monthly-schedule/shifts',
      '/monthly-schedule-archive',
      '/purchase-inventory-management',
      '/contract-management',
    ],
  },
  {
    role: 'supply_chain_admin' as AccessRole,
    allowedPaths: [
      '/purchase-inventory-management',
      '/Purchase-Inventory-Management///',
      '/contract-management',
      '/Contract-Management/frameworks///',
      '/monthly-schedule',
      '/construction-management',
    ],
    deniedPaths: [
      '/',
      '/purchase-inventory-management/records',
      '/purchase-inventory-management-archive',
      '/contract-management-archive',
    ],
  },
  {
    role: 'construction_admin' as AccessRole,
    allowedPaths: [
      '/construction-management',
      '/Construction-Management///',
      '/monthly-schedule',
    ],
    deniedPaths: [
      '/',
      '/construction-management/projects',
      '/construction-management-archive',
      '/purchase-inventory-management',
      '/contract-management',
    ],
  },
] as const;

function purchaseRecord(
  overrides: Partial<PurchaseInventoryRequestItem> = {},
): PurchaseInventoryRequestItem {
  return {
    recordId: 'request-a',
    submissionRecordId: 'submission-a',
    executionRecordId: null,
    requestCode: 'A-PENDING',
    title: '测试物品',
    requester: '申请人',
    purchaser: '',
    building: 'A楼',
    specialty: '弱电',
    primaryCategory: '办公用品',
    secondaryCategory: '耗材',
    stage: 'application',
    statusLabel: '待提交',
    supplier: '测试供应商',
    estimatedAmount: 100,
    actualAmount: null,
    quantity: 1,
    actualQuantity: null,
    unit: '件',
    priority: 'P2',
    createdAt: null,
    expectedArrival: null,
    orderedAt: null,
    receivedAt: null,
    warehouseRequired: false,
    warehouseConfirmed: false,
    purchaseCompleted: false,
    inventorySku: '',
    notes: '',
    ...overrides,
  };
}

describe('unified access policy', () => {
  it.each([
    '/nantong-base',
    '/mbti-assessment',
  ])('allows guest page %s', (path) =>
    expect(canAccessPage('guest', path)).toBe(true),
  );

  it.each([
    'editor',
    'inventory_admin',
    'purchase_admin',
    'purchase_applicant',
    'duty_editor',
    'supply_chain_admin',
    'construction_admin',
  ] as const)('allows %s to access every guest page', (role) => {
    expect(canAccessPage(role, '/monthly-schedule')).toBe(true);
    expect(canAccessPage(role, '/construction-management')).toBe(true);
    expect(canAccessPage(role, '/today-operations-panorama')).toBe(true);
    expect(canAccessPage(role, '/monthly-operations')).toBe(true);
    expect(canAccessPage(role, '/nantong-base')).toBe(true);
  });

  it.each([
    '/mbti-assessment/',
    '/nantong-base///',
  ])('normalizes trailing slashes for guest page %s', (path) =>
    expect(canAccessPage('guest', path)).toBe(true),
  );

  it.each([
    '/',
    '/monthly-schedule/apply/leave',
    '/monthly-schedule/apply/overtime',
    '/today-operations-panorama',
    '/construction-management',
    '/construction-management///',
    '/monthly-operations///',
    '/system-monthly-report',
    '/purchase-inventory-management',
    '/contract-management',
    '/campus-operations-dashboard',
    '/construction-management/project/1',
  ])('denies guest page %s', (path) => {
    expect(canAccessPage('guest', path)).toBe(false);
  });

  it('denies editors contract pages but allows unrelated matching prefixes', () => {
    expect(canAccessPage('editor', '/contract-management')).toBe(false);
    expect(canAccessPage('editor', '/Contract-Management')).toBe(false);
    expect(canAccessPage('editor', '/contract-management/frameworks')).toBe(
      false,
    );
    expect(canAccessPage('editor', '/contract-management-archive')).toBe(true);
  });

  it('matches guest routes case-insensitively like React Router', () => {
    expect(canAccessPage('guest', '/Monthly-Schedule')).toBe(true);
    expect(canAccessPage('guest', '/Nantong-Base///')).toBe(true);
    expect(canAccessPage('guest', '/Construction-Management/')).toBe(false);
  });

  it.each([
    '/',
    '/purchase-inventory-management',
    '/contract-management/frameworks',
  ])('allows admin page %s', (path) => {
    expect(canAccessPage('admin', path)).toBe(true);
  });

  it.each(feishuRolePageCases)(
    'limits $role to its normalized, segment-safe page scope',
    ({ role, allowedPaths, deniedPaths }) => {
      for (const path of allowedPaths) {
        expect(canAccessPage(role, path)).toBe(true);
      }
      for (const path of deniedPaths) {
        expect(canAccessPage(role, path)).toBe(false);
      }
    },
  );

  it('lists every configured password login identity', () => {
    const accountTypes = getUnifiedLoginAccountTypes();

    expect(accountTypes).toEqual([
      'admin',
      'editor',
      'inventory_admin',
      'building_admin',
      'purchase_admin',
      'purchase_applicant',
      'construction_admin',
    ]);
    expect(accountTypes).not.toContain('duty_editor');
    expect(accountTypes).not.toContain('supply_chain_admin');
  });

  it.each([
    [
      'inventory_admin',
      '/purchase-inventory-management',
      '/inventory-management',
    ],
    [
      'purchase_admin',
      '/inventory-management',
      '/purchase-inventory-management',
    ],
    [
      'purchase_admin',
      '/Contract-Management/frameworks///',
      '/contract-management/frameworks',
    ],
    [
      'purchase_applicant',
      '/monthly-schedule',
      '/purchase-inventory-management',
    ],
    ['admin', '/contract-management', '/contract-management'],
    ['editor', '/construction-management', '/construction-management'],
    ['editor', '/contract-management', '/monthly-schedule'],
  ] as const)(
    'routes %s from %s to %s after login',
    (role, currentPath, expected) => {
      expect(getPostLoginPath(role, currentPath)).toBe(expected);
    },
  );

  it.each([
    ['duty_editor', '/contract-management', '/monthly-schedule'],
    ['duty_editor', '/Monthly-Schedule///', '/monthly-schedule'],
    [
      'supply_chain_admin',
      '/Purchase-Inventory-Management///',
      '/purchase-inventory-management',
    ],
    [
      'supply_chain_admin',
      '/Contract-Management/frameworks///',
      '/contract-management/frameworks',
    ],
    [
      'supply_chain_admin',
      '/construction-management',
      '/construction-management',
    ],
    [
      'construction_admin',
      '/Construction-Management///',
      '/construction-management',
    ],
    ['construction_admin', '/monthly-schedule', '/construction-management'],
  ] as const)(
    'routes Feishu role %s from %s to %s after login',
    (role, currentPath, expected) => {
      expect(getPostLoginPath(role as AccessRole, currentPath)).toBe(expected);
    },
  );

  it('allows a purchase applicant only on the normalized purchase inventory page', () => {
    expect(
      canAccessPage('purchase_applicant', '/purchase-inventory-management'),
    ).toBe(true);
    expect(
      canAccessPage('purchase_applicant', '/Purchase-Inventory-Management///'),
    ).toBe(true);
  });

  it('allows existing purchase roles on the exact application direct route', () => {
    for (const role of [
      'purchase_admin',
      'purchase_applicant',
      'supply_chain_admin',
    ] as const) {
      expect(
        canAccessPage(role, '/purchase-inventory-management/apply/new'),
      ).toBe(true);
    }

    expect(
      canAccessPage(
        'inventory_admin',
        '/purchase-inventory-management/apply/new',
      ),
    ).toBe(false);
    expect(
      canAccessPage(
        'purchase_applicant',
        '/purchase-inventory-management/apply/new-evil',
      ),
    ).toBe(false);
  });

  it('returns a purchase applicant to the direct route after login', () => {
    expect(
      getPostLoginPath(
        'purchase_applicant',
        '/Purchase-Inventory-Management/apply/new///',
      ),
    ).toBe('/purchase-inventory-management/apply/new');
  });

  it('allows an inventory administrator on inventory and guest pages', () => {
    const role = 'inventory_admin' as AccessRole;

    expect(canAccessPage(role, '/inventory-management')).toBe(true);
    expect(canAccessPage(role, '/Inventory-Management///')).toBe(true);
    expect(canAccessPage(role, '/purchase-inventory-management')).toBe(false);
    expect(canAccessPage(role, '/contract-management')).toBe(false);
    expect(canAccessPage(role, '/monthly-schedule')).toBe(true);
    expect(canAccessPage(role, '/construction-management')).toBe(true);
  });

  it('allows a purchase administrator only on purchase and contract pages', () => {
    expect(
      canAccessPage('purchase_admin', '/purchase-inventory-management'),
    ).toBe(true);
    expect(canAccessPage('purchase_admin', '/contract-management')).toBe(true);
    expect(
      canAccessPage('purchase_admin', '/Contract-Management/frameworks///'),
    ).toBe(true);
    expect(
      canAccessPage('purchase_admin', '/contract-management-archive'),
    ).toBe(false);
  });

  it('allows administrators and purchase administrators on normalized contract pages', () => {
    expect(canAccessPage('admin', '/contract-management')).toBe(true);
    expect(canAccessPage('admin', '/Contract-Management/frameworks///')).toBe(
      true,
    );
    for (const role of ['editor', 'purchase_applicant'] as const) {
      expect(canAccessPage(role, '/contract-management')).toBe(false);
    }
  });

  it('denies a purchase administrator on non-guest unrelated and prefix-collision pages', () => {
    for (const path of [
      '/',
      '/purchase-inventory-management/records',
      '/purchase-inventory-management-evil',
      '/contract-management-archive',
    ]) {
      expect(canAccessPage('purchase_admin', path)).toBe(false);
    }
  });

  it('denies a purchase applicant on every non-guest, non-purchase or prefix-collision page', () => {
    for (const path of [
      '/',
      '/contract-management',
      '/purchase-inventory-management/records',
      '/purchase-inventory-management-evil',
    ]) {
      expect(canAccessPage('purchase_applicant', path)).toBe(false);
    }
  });

  it.each([
    [
      'guest',
      {
        canEdit: false,
        canDelete: false,
        canForceRefresh: false,
        canAccessContracts: false,
      },
    ],
    [
      'editor',
      {
        canEdit: true,
        canDelete: false,
        canForceRefresh: true,
        canAccessContracts: false,
      },
    ],
    [
      'admin',
      {
        canEdit: true,
        canDelete: true,
        canForceRefresh: true,
        canAccessContracts: true,
      },
    ],
    [
      'purchase_admin',
      {
        canEdit: true,
        canDelete: true,
        canForceRefresh: true,
        canAccessContracts: true,
      },
    ],
    [
      'inventory_admin',
      {
        canEdit: true,
        canDelete: false,
        canForceRefresh: true,
        canAccessContracts: false,
      },
    ],
    [
      'purchase_applicant',
      {
        canEdit: false,
        canDelete: false,
        canForceRefresh: true,
        canAccessContracts: false,
      },
    ],
  ] as const)('maps %s capabilities', (role, capabilities) => {
    expect(capabilitiesForRole(role as AccessRole)).toEqual(capabilities);
  });

  it.each([
    [
      'duty_editor',
      {
        canEdit: true,
        canDelete: false,
        canForceRefresh: true,
        canAccessContracts: false,
      },
    ],
    [
      'supply_chain_admin',
      {
        canEdit: true,
        canDelete: true,
        canForceRefresh: true,
        canAccessContracts: true,
      },
    ],
    [
      'construction_admin',
      {
        canEdit: true,
        canDelete: true,
        canForceRefresh: true,
        canAccessContracts: false,
      },
    ],
  ] as const)('maps Feishu role %s capabilities', (role, capabilities) => {
    expect(capabilitiesForRole(role as AccessRole)).toEqual(capabilities);
  });

  it.each([
    [admin, true, true],
    [editor, true, true],
    [purchaseAdmin, true, true],
    [supplyChainAdmin, true, true],
    [applicantA, true, false],
    [guest, false, false],
  ] as const)(
    'maps %s purchase creation and workflow capabilities',
    (principal, canCreate, canManageWorkflow) => {
      expect(canCreatePurchaseApplication(principal)).toBe(canCreate);
      expect(canManagePurchaseWorkflow(principal)).toBe(canManageWorkflow);
    },
  );

  it('preserves full-role record editing and deletion rules', () => {
    const item = purchaseRecord({
      building: 'B楼',
      stage: 'stocked',
      purchaseCompleted: true,
    });

    expect(canEditPurchaseRecord(admin, item)).toBe(true);
    expect(canDeletePurchaseRecord(admin, item)).toBe(true);
    expect(canEditPurchaseRecord(editor, item)).toBe(true);
    expect(canDeletePurchaseRecord(editor, item)).toBe(true);
    expect(canDeleteCompletedPurchaseRecords(editor)).toBe(true);
    expect(canEditPurchaseRecord(purchaseAdmin, item)).toBe(true);
    expect(canDeletePurchaseRecord(purchaseAdmin, item)).toBe(true);
    expect(canEditPurchaseRecord(supplyChainAdmin, item)).toBe(true);
    expect(canDeletePurchaseRecord(supplyChainAdmin, item)).toBe(true);
  });

  it('limits sub-administrator deletion to completed purchase records', () => {
    expect(
      canDeletePurchaseRecord(editor, purchaseRecord({ stage: 'inbound' })),
    ).toBe(false);
    expect(
      canDeletePurchaseRecord(editor, purchaseRecord({ stage: 'executing' })),
    ).toBe(false);
  });

  it('allows ordering for administrators and same-building self-purchase applicants only', () => {
    const selfPurchaseA = purchaseRecord({
      stage: 'executing',
      executionRecordId: 'execution-a',
      building: 'A楼',
      purchaseMethod: '需求自采（楼内）',
    });
    const selfPurchaseB = purchaseRecord({
      ...selfPurchaseA,
      building: 'B楼',
    });
    const comprehensiveA = purchaseRecord({
      ...selfPurchaseA,
      purchaseMethod: '综合采购',
    });

    expect(canOrderPurchaseRecord(admin, comprehensiveA)).toBe(true);
    expect(canOrderPurchaseRecord(purchaseAdmin, comprehensiveA)).toBe(true);
    expect(canOrderPurchaseRecord(supplyChainAdmin, comprehensiveA)).toBe(true);
    expect(canOrderPurchaseRecord(editor, comprehensiveA)).toBe(false);
    expect(canOrderPurchaseRecord(applicantA, selfPurchaseA)).toBe(true);
    expect(canOrderPurchaseRecord(applicantA, selfPurchaseB)).toBe(false);
    expect(canOrderPurchaseRecord(applicantA, comprehensiveA)).toBe(false);
    expect(
      canOrderPurchaseRecord(applicantA, {
        ...selfPurchaseA,
        executionRecordId: null,
      }),
    ).toBe(false);
  });

  it('allows every building applicant to receive same-building purchases regardless of purchase method', () => {
    for (const building of PURCHASE_ACCESS_BUILDINGS) {
      const applicant: AccessPrincipal = {
        role: 'purchase_applicant',
        purchaseBuilding: building,
      };
      const comprehensive = purchaseRecord({
        stage: 'receiving',
        executionRecordId: `execution-${building}`,
        building,
        purchaseMethod: '综合采购',
      });
      const selfPurchase = purchaseRecord({
        ...comprehensive,
        purchaseMethod: '需求自采（楼内）',
      });
      const otherBuilding = PURCHASE_ACCESS_BUILDINGS.find(
        (candidate) => candidate !== building,
      )!;

      expect(canReceivePurchaseRecord(applicant, comprehensive)).toBe(true);
      expect(canReceivePurchaseRecord(applicant, selfPurchase)).toBe(true);
      expect(
        canReceivePurchaseRecord(applicant, {
          ...comprehensive,
          building: otherBuilding,
        }),
      ).toBe(false);
    }
  });

  it('keeps receipt stage requirements and full-role permissions unchanged', () => {
    const comprehensiveA = purchaseRecord({
      stage: 'receiving',
      executionRecordId: 'execution-a',
      building: 'A楼',
      purchaseMethod: '综合采购',
    });

    expect(canReceivePurchaseRecord(admin, comprehensiveA)).toBe(true);
    expect(canReceivePurchaseRecord(purchaseAdmin, comprehensiveA)).toBe(true);
    expect(canReceivePurchaseRecord(supplyChainAdmin, comprehensiveA)).toBe(
      true,
    );
    expect(canReceivePurchaseRecord(editor, comprehensiveA)).toBe(true);
    expect(
      canReceivePurchaseRecord(applicantA, {
        ...comprehensiveA,
        executionRecordId: null,
      }),
    ).toBe(false);
    expect(
      canReceivePurchaseRecord(applicantA, {
        ...comprehensiveA,
        purchaseCompleted: true,
      }),
    ).toBe(true);
  });

  it('lets only the system administrator edit rejected terminal history', () => {
    const item = purchaseRecord({
      stage: 'rejected',
      statusLabel: '已驳回',
    });

    expect(canEditPurchaseRecord(admin, item)).toBe(true);
    expect(canEditPurchaseRecord(editor, item)).toBe(false);
    expect(canEditPurchaseRecord(purchaseAdmin, item)).toBe(false);
    expect(canEditPurchaseRecord(supplyChainAdmin, item)).toBe(false);
    expect(canEditPurchaseRecord(applicantA, item)).toBe(false);
  });

  it.each([
    ['same-building application', purchaseRecord(), true],
    [
      'same-building approval',
      purchaseRecord({ stage: 'approval', statusLabel: '审批中' }),
      true,
    ],
    ['another building', purchaseRecord({ building: 'B楼' }), false],
    [
      'execution stage',
      purchaseRecord({ stage: 'executing', executionRecordId: 'execution-a' }),
      false,
    ],
    ['completed record', purchaseRecord({ purchaseCompleted: true }), false],
  ] as const)(
    'limits applicant edit and delete for %s',
    (_label, item, expected) => {
      expect(canEditPurchaseRecord(applicantA, item)).toBe(expected);
      expect(canDeletePurchaseRecord(applicantA, item)).toBe(expected);
    },
  );

  it('normalizes canonical whitespace and case without accepting building aliases', () => {
    const canonicalSameBuilding = purchaseRecord({ building: ' a楼 ' });
    const aliasBuilding = purchaseRecord({ building: 'A栋' });

    expect(canEditPurchaseRecord(applicantA, canonicalSameBuilding)).toBe(true);
    expect(canDeletePurchaseRecord(applicantA, canonicalSameBuilding)).toBe(
      true,
    );
    expect(canEditPurchaseRecord(applicantA, aliasBuilding)).toBe(false);
    expect(canDeletePurchaseRecord(applicantA, aliasBuilding)).toBe(false);
  });

  it('denies guest record editing and deletion', () => {
    const item = purchaseRecord();
    expect(canEditPurchaseRecord(guest, item)).toBe(false);
    expect(canDeletePurchaseRecord(guest, item)).toBe(false);
  });

  it('provides distinct Chinese labels for every access role', () => {
    const building = PURCHASE_ACCESS_BUILDINGS[0];

    expect(getAccessRoleLabel('guest')).toBe('游客');
    expect(getAccessRoleLabel('editor')).toBe('子管理员');
    expect(getAccessRoleLabel('admin')).toBe('管理员');
    expect(getAccessRoleLabel('inventory_admin')).toBe('库存管理员');
    expect(getAccessRoleLabel('purchase_admin')).toBe('采购&合同管理员');
    expect(getAccessRoleLabel('purchase_applicant', building)).toBe(
      `${building}采购申请人`,
    );
  });

  it.each([
    ['duty_editor', '排班编辑'],
    ['supply_chain_admin', '采购与合同管理员'],
    ['construction_admin', '施工管理员'],
  ] as const)('labels Feishu role %s as %s', (role, label) => {
    expect(getAccessRoleLabel(role as AccessRole)).toBe(label);
  });

  it('recognizes every standard DELETE request', () => {
    expect(isPersistedDeleteAction('DELETE', '/api/records/1')).toBe(true);
    expect(isPersistedDeleteAction('delete', '/api/records/1')).toBe(true);
  });

  it.each([
    '/api/purchase-inventory/records/batch-delete',
    '/api/duty-schedules/construction-management/attachments/delete',
    '/api/duty-schedules/construction-management/projects/delete',
    '/api/duty-schedules/exception-follow-up/delete',
    '/api/duty-schedules/travel-staff/revoke',
  ])('recognizes persisted POST delete route %s', (path) => {
    expect(isPersistedDeleteAction('POST', path)).toBe(true);
  });

  it('does not classify a read request by a delete-like path alone', () => {
    expect(
      isPersistedDeleteAction(
        'GET',
        '/api/duty-schedules/construction-management/projects/delete',
      ),
    ).toBe(false);
  });

  it('does not classify project termination as deletion', () => {
    expect(
      isPersistedDeleteAction(
        'POST',
        '/api/duty-schedules/construction-management/projects/terminate',
      ),
    ).toBe(false);
  });

  it('exposes shared login and session DTO shapes', () => {
    const request: AccessLoginRequest = {
      accountType: 'editor',
      password: 'not-a-real-secret',
    };
    const session: AccessSessionResponse = {
      role: 'guest',
      purchaseBuilding: null,
      expiresAt: null,
      capabilities: capabilitiesForRole('guest'),
    };
    const roles: AccessRole[] = [
      'guest',
      'editor',
      'admin',
      'inventory_admin',
      'purchase_admin',
      'purchase_applicant',
      'duty_editor',
      'supply_chain_admin',
      'construction_admin',
    ];

    expect(request.accountType).toBe('editor');
    expect(request.password).toBe('not-a-real-secret');
    expect(session.role).toBe('guest');
    expect(roles).toEqual([
      'guest',
      'editor',
      'admin',
      'inventory_admin',
      'purchase_admin',
      'purchase_applicant',
      'duty_editor',
      'supply_chain_admin',
      'construction_admin',
    ]);
  });

  it('separates local login targets from every non-guest principal role', () => {
    const localAccountTypes: AccessLoginAccountType[] = [
      'admin',
      'editor',
      'inventory_admin',
      'building_admin',
      'purchase_admin',
      'purchase_applicant',
      'construction_admin',
    ];
    const privilegedPrincipals: PrivilegedAccessPrincipal[] = [
      { role: 'admin', purchaseBuilding: null },
      { role: 'editor', purchaseBuilding: null },
      { role: 'inventory_admin', purchaseBuilding: 'A楼' },
      { role: 'building_admin', purchaseBuilding: '110站' },
      { role: 'purchase_admin', purchaseBuilding: null },
      { role: 'purchase_applicant', purchaseBuilding: 'A楼' },
      { role: 'duty_editor', purchaseBuilding: null },
      { role: 'supply_chain_admin', purchaseBuilding: null },
      { role: 'construction_admin', purchaseBuilding: null },
    ];

    if (false) {
      // @ts-expect-error Feishu-only roles are not local password-login targets.
      const dutyRequest: AccessLoginRequest = {
        accountType: 'duty_editor',
        password: 'unused',
      };
      // @ts-expect-error Feishu-only roles are not local password-login targets.
      const supplyRequest: AccessLoginRequest = {
        accountType: 'supply_chain_admin',
        password: 'unused',
      };
      const constructionRequest: AccessLoginRequest = {
        accountType: 'construction_admin',
        password: 'unused',
      };
      // @ts-expect-error Guest sessions are not privileged principals.
      const guestPrincipal: PrivilegedAccessPrincipal = {
        role: 'guest',
        purchaseBuilding: null,
      };
      void [dutyRequest, supplyRequest, constructionRequest, guestPrincipal];
    }

    expect(localAccountTypes).toEqual(getUnifiedLoginAccountTypes());
    expect(privilegedPrincipals.map(({ role }) => role)).toEqual([
      'admin',
      'editor',
      'inventory_admin',
      'building_admin',
      'purchase_admin',
      'purchase_applicant',
      'duty_editor',
      'supply_chain_admin',
      'construction_admin',
    ]);
  });
});
