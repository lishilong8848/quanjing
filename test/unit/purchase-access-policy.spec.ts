import { ForbiddenException } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  AccessPrincipal,
  AccessRole,
} from '../../shared/access-control.interface';
import type {
  PurchaseInventoryAlertItem,
  PurchaseInventoryMovementItem,
  PurchaseInventoryRequestItem,
  PurchaseInventoryResponse,
  PurchaseRecordBatchDeleteRequest,
  PurchaseRecordUpdateRequest,
} from '../../shared/purchase-inventory.interface';
import { PurchaseAccessPolicyService } from '../../server/modules/purchase-inventory/purchase-access-policy.service';

const applicantA: AccessPrincipal = {
  role: 'purchase_applicant',
  purchaseBuilding: 'A楼',
};

describe('PurchaseAccessPolicyService dashboard scope', () => {
  let dashboard: PurchaseInventoryResponse;
  let getDashboard: jest.Mock;
  let policy: PurchaseAccessPolicyService;

  beforeEach(() => {
    dashboard = createDashboard();
    getDashboard = jest.fn().mockResolvedValue(dashboard);
    policy = new PurchaseAccessPolicyService({ getDashboard } as never);
  });

  it.each(['admin', 'editor', 'purchase_admin', 'supply_chain_admin'] as const)(
    'returns the original full dashboard for %s',
    (role) => {
      expect(policy.scopeDashboard(principal(role), dashboard)).toBe(dashboard);
    },
  );

  it('denies dashboard access to guests', () => {
    expect(() => policy.scopeDashboard(principal('guest'), dashboard)).toThrow(
      ForbiddenException,
    );
  });

  it('requires a valid applicant building', () => {
    expect(() =>
      policy.scopeDashboard(
        { role: 'purchase_applicant', purchaseBuilding: null },
        dashboard,
      ),
    ).toThrow(ForbiddenException);
    expect(() =>
      policy.scopeDashboard(
        {
          role: 'purchase_applicant',
          purchaseBuilding: 'G楼',
        } as never,
        dashboard,
      ),
    ).toThrow(ForbiddenException);
  });

  it('normalizes canonical building values but does not accept record aliases', () => {
    const result = policy.scopeDashboard(
      {
        role: 'purchase_applicant',
        purchaseBuilding: ' a楼 ',
      } as never,
      dashboard,
    );

    expect(result.requests.map((item) => item.requestCode)).toEqual([
      'A-APPLICATION',
      'A-APPROVAL',
      'A-EXECUTING',
      'A-RECEIVING',
      'A-STOCKED',
    ]);
    expect(result.requests).not.toContainEqual(
      expect.objectContaining({ requestCode: 'A-ALIAS' }),
    );
    expect(result.requests).not.toContainEqual(
      expect.objectContaining({ requestCode: 'NO-BUILDING' }),
    );
  });

  it('filters every building-owned collection and recalculates all scoped totals', () => {
    const result = policy.scopeDashboard(applicantA, dashboard);

    expect(result.requests.map((item) => item.requestCode)).toEqual([
      'A-APPLICATION',
      'A-APPROVAL',
      'A-EXECUTING',
      'A-RECEIVING',
      'A-STOCKED',
    ]);
    expect(result.summary).toEqual({
      totalRequests: 5,
      pendingApprovals: 1,
      executingOrders: 1,
      awaitingReceipt: 1,
      stockedRequests: 1,
      estimatedAmount: 1500.25,
      actualAmount: 850.38,
      catalogItems: 0,
      inventorySkus: 1,
      availableQuantity: 3,
      inventoryValue: 30,
      lowStockSkus: 2,
      pendingInbound: 1,
      stageCounts: {
        application: 1,
        approval: 1,
        rejected: 0,
        executing: 1,
        receiving: 1,
        inbound: 0,
        stocked: 1,
      },
    });
    expect(result.inventory.categoryBreakdown).toEqual([]);
    expect(result.inventory.alerts.map((item) => item.recordId)).toEqual([
      'rec_alert_a_1',
      'rec_alert_a_2',
    ]);
    expect(result.movements.recentInbound.map((item) => item.recordId)).toEqual(
      ['rec_inbound_a_pending', 'rec_inbound_a_done'],
    );
    expect(
      result.movements.recentOutbound.map((item) => item.recordId),
    ).toEqual(['rec_outbound_a']);
    expect(JSON.stringify(result)).not.toContain('B-PENDING');
    expect(JSON.stringify(result)).not.toContain('B楼机密物品');
  });

  it('preserves section health but recomputes every count from visible records', () => {
    const result = policy.scopeDashboard(applicantA, dashboard);

    expect(result.sectionStatus).toEqual({
      submissions: {
        configured: true,
        count: 5,
        message: 'submission-health',
      },
      executions: {
        configured: true,
        count: 4,
        message: 'execution-health',
      },
      catalog: { configured: true, count: 0, message: 'catalog-health' },
      inventory: {
        configured: true,
        count: 2,
        message: 'inventory-health',
      },
      inbound: { configured: true, count: 2, message: 'inbound-health' },
      outbound: { configured: true, count: 1, message: 'outbound-health' },
    });
  });

  it('preserves the dashboard refresh health for an applicant-scoped view', () => {
    dashboard.refreshState = 'stale';
    dashboard.refreshError = '采购数据刷新失败：temporary token failure';

    const result = policy.scopeDashboard(applicantA, dashboard);

    expect(result.refreshState).toBe('stale');
    expect(result.refreshError).toBe(dashboard.refreshError);
  });

  it('requires an explicit matching applicant building', () => {
    expect(policy.requireApplicantBuilding(applicantA)).toBe('A楼');
    expect(policy.assertRequestedBuilding(applicantA, ' a楼 ')).toBe('A楼');
    for (const requestedBuilding of [
      '',
      ' ',
      null,
      undefined,
      1,
      {},
      [],
      'G楼',
      'A栋',
      'B楼',
    ]) {
      expect(() =>
        policy.assertRequestedBuilding(applicantA, requestedBuilding),
      ).toThrow(ForbiddenException);
    }
  });

  it.each(['admin', 'editor', 'purchase_admin', 'supply_chain_admin'] as const)(
    'normalizes and validates requested buildings for %s',
    (role) => {
      expect(policy.assertRequestedBuilding(principal(role), ' b楼 ')).toBe(
        'B楼',
      );
      for (const requestedBuilding of [
        '',
        ' ',
        null,
        undefined,
        1,
        {},
        [],
        'G楼',
        'A栋',
      ]) {
        expect(() =>
          policy.assertRequestedBuilding(principal(role), requestedBuilding),
        ).toThrow(ForbiddenException);
      }
    },
  );

  it('denies requested buildings for guests', () => {
    expect(() =>
      policy.assertRequestedBuilding(principal('guest'), 'A楼'),
    ).toThrow(ForbiddenException);
  });
});

describe('PurchaseAccessPolicyService record authorization', () => {
  let dashboard: PurchaseInventoryResponse;
  let getDashboard: jest.Mock;
  let policy: PurchaseAccessPolicyService;

  beforeEach(() => {
    dashboard = createDashboard();
    getDashboard = jest.fn().mockResolvedValue(dashboard);
    policy = new PurchaseAccessPolicyService({ getDashboard } as never);
  });

  it.each(['admin', 'editor', 'purchase_admin', 'supply_chain_admin'] as const)(
    'returns an update unchanged for %s without reading the dashboard',
    async (role) => {
      const item = itemByCode(dashboard, 'B-PENDING');
      const request = updateFor(item);

      await expect(
        policy.prepareUpdate(principal(role), item.recordId, request),
      ).resolves.toBe(request);
      expect(getDashboard).not.toHaveBeenCalled();
    },
  );

  it.each(['editor', 'purchase_admin', 'supply_chain_admin'] as const)(
    'denies lifecycle status updates for non-admin role %s',
    async (role) => {
      const item = itemByCode(dashboard, 'A-APPROVAL');
      const request = updateFor(item);
      request.fields.status = 'executing';

      await expect(
        policy.prepareUpdate(principal(role), item.recordId, request),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(getDashboard).not.toHaveBeenCalled();
    },
  );

  it('lets an administrator change an active lifecycle status after revalidating the record', async () => {
    const item = itemByCode(dashboard, 'A-APPROVAL');
    const request = updateFor(item);
    request.fields.status = 'executing';

    await expect(
      policy.prepareUpdate(principal('admin'), item.recordId, request),
    ).resolves.toBe(request);
    expect(getDashboard).toHaveBeenCalledWith(true);
  });

  it('lets an administrator revive a rejected purchase record', async () => {
    const item = itemByCode(dashboard, 'A-APPROVAL');
    item.stage = 'rejected';
    item.statusLabel = '已驳回';
    const request = updateFor(item);
    request.fields.status = 'executing';

    await expect(
      policy.prepareUpdate(principal('admin'), item.recordId, request),
    ).resolves.toBe(request);
    expect(getDashboard).toHaveBeenCalledWith(true);
  });

  it('denies guest updates without reading the dashboard', async () => {
    const item = itemByCode(dashboard, 'A-APPLICATION');

    await expect(
      policy.prepareUpdate(principal('guest'), item.recordId, updateFor(item)),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(getDashboard).not.toHaveBeenCalled();
  });

  it.each(['building', 'requesterOpenId', 'status'] as const)(
    'explicitly denies applicant updates containing own property %s',
    async (field) => {
      const item = itemByCode(dashboard, 'A-APPLICATION');
      const request = updateFor(item);
      Object.defineProperty(request.fields, field, {
        configurable: true,
        enumerable: true,
        value: undefined,
      });

      await expect(
        policy.prepareUpdate(applicantA, item.recordId, request),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(Object.prototype.hasOwnProperty.call(request.fields, field)).toBe(
        true,
      );
      expect(getDashboard).not.toHaveBeenCalled();
    },
  );

  it.each([
    'A-EXECUTING',
    'A-RECEIVING',
    'A-STOCKED',
    'B-PENDING',
    'A-ALIAS',
  ] as const)('denies applicant update for %s', async (code) => {
    const item = itemByCode(dashboard, code);

    await expect(
      policy.prepareUpdate(applicantA, item.recordId, updateFor(item)),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('denies completed history even when its mapped stage is approval', async () => {
    const item = itemByCode(dashboard, 'A-APPROVAL');
    item.purchaseCompleted = true;

    await expect(
      policy.prepareUpdate(applicantA, item.recordId, updateFor(item)),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('denies unknown routes and mixed submission/execution identifiers uniformly', async () => {
    const application = itemByCode(dashboard, 'A-APPLICATION');
    const approval = itemByCode(dashboard, 'A-APPROVAL');

    await expect(
      policy.prepareUpdate(applicantA, 'rec_unknown', updateFor(application)),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      policy.prepareUpdate(applicantA, approval.recordId, {
        submissionRecordId: application.submissionRecordId,
        executionRecordId: approval.executionRecordId,
        fields: { notes: 'mixed identifiers' },
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('requires at least one typed payload identifier for applicant updates', async () => {
    const item = itemByCode(dashboard, 'A-APPLICATION');

    await expect(
      policy.prepareUpdate(applicantA, item.recordId, {
        submissionRecordId: null,
        executionRecordId: null,
        fields: { notes: 'missing typed identifier' },
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(getDashboard).toHaveBeenCalledTimes(1);
  });

  it('rejects an ambiguous route even when a typed payload identifier narrows the match', async () => {
    const item = itemByCode(dashboard, 'A-APPROVAL');
    dashboard.requests.push(
      requestItem('A-DUPLICATE-ROUTE', {
        building: 'A楼',
        stage: 'application',
        recordId: item.recordId,
        submissionRecordId: 'rec_sub_duplicate_route',
        executionRecordId: null,
      }),
    );

    await expect(
      policy.prepareUpdate(applicantA, item.recordId, updateFor(item)),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(getDashboard).toHaveBeenCalledTimes(1);
  });

  it.each(['submissionRecordId', 'executionRecordId'] as const)(
    'rejects duplicate typed %s even when the other ID narrows the match',
    async (field) => {
      const item = itemByCode(dashboard, 'A-APPROVAL');
      dashboard.requests.push(
        field === 'submissionRecordId'
          ? requestItem('A-DUPLICATE-SUBMISSION', {
              building: 'A楼',
              stage: 'approval',
              recordId: 'rec_route_duplicate_submission',
              submissionRecordId: item.submissionRecordId,
              executionRecordId: 'rec_exec_duplicate_submission_other',
            })
          : requestItem('A-DUPLICATE-EXECUTION', {
              building: 'A楼',
              stage: 'approval',
              recordId: 'rec_route_duplicate_execution',
              submissionRecordId: 'rec_sub_duplicate_execution_other',
              executionRecordId: item.executionRecordId,
            }),
      );

      await expect(
        policy.prepareUpdate(applicantA, item.recordId, updateFor(item)),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(getDashboard).toHaveBeenCalledTimes(1);
    },
  );

  it('rejects swapped submission and execution identifiers on update', async () => {
    const item = itemByCode(dashboard, 'A-APPROVAL');

    await expect(
      policy.prepareUpdate(applicantA, item.recordId, {
        submissionRecordId: item.executionRecordId,
        executionRecordId: item.submissionRecordId,
        fields: { notes: 'swapped typed identifiers' },
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(getDashboard).toHaveBeenCalledTimes(1);
  });

  it.each(['A-APPLICATION', 'A-APPROVAL'] as const)(
    'returns an authorized applicant %s update unchanged',
    async (code) => {
      const item = itemByCode(dashboard, code);
      const request = updateFor(item);

      await expect(
        policy.prepareUpdate(applicantA, ` ${item.recordId} `, request),
      ).resolves.toBe(request);
      expect(getDashboard).toHaveBeenCalledTimes(1);
      expect(getDashboard).toHaveBeenCalledWith(true);
    },
  );

  it.each(['admin', 'purchase_admin', 'supply_chain_admin'] as const)(
    'returns a delete request unchanged for %s without reading the dashboard',
    async (role) => {
      const target = deleteTarget(itemByCode(dashboard, 'B-PENDING'));
      const request: PurchaseRecordBatchDeleteRequest = {
        records: Array.from({ length: 200 }, (_, index) => ({
          ...target,
          key: `${target.key}-${index}`,
        })),
      };

      await expect(
        policy.authorizeDelete(principal(role), request),
      ).resolves.toBe(request);
      expect(getDashboard).not.toHaveBeenCalled();
    },
  );

  it.each(['guest'] as const)(
    'denies delete for %s without reading the dashboard',
    async (role) => {
      const request: PurchaseRecordBatchDeleteRequest = {
        records: [deleteTarget(itemByCode(dashboard, 'A-APPLICATION'))],
      };

      await expect(
        policy.authorizeDelete(principal(role), request),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(getDashboard).not.toHaveBeenCalled();
    },
  );

  it('allows an editor to delete completed records after a fresh dashboard check', async () => {
    const request: PurchaseRecordBatchDeleteRequest = {
      records: [deleteTarget(itemByCode(dashboard, 'A-STOCKED'))],
    };

    await expect(
      policy.authorizeDelete(principal('editor'), request),
    ).resolves.toBe(request);
    expect(getDashboard).toHaveBeenCalledTimes(1);
    expect(getDashboard).toHaveBeenCalledWith(true);
  });

  it('atomically denies an editor batch containing a non-completed record', async () => {
    const request: PurchaseRecordBatchDeleteRequest = {
      records: [
        deleteTarget(itemByCode(dashboard, 'A-STOCKED')),
        deleteTarget(itemByCode(dashboard, 'A-RECEIVING')),
      ],
    };

    await expect(
      policy.authorizeDelete(principal('editor'), request),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(getDashboard).toHaveBeenCalledTimes(1);
  });

  it('rejects an empty delete request before role-specific authorization', async () => {
    for (const accessPrincipal of [
      principal('admin'),
      principal('purchase_admin'),
      principal('supply_chain_admin'),
      applicantA,
    ]) {
      await expect(
        policy.authorizeDelete(accessPrincipal, { records: [] }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    }
    expect(getDashboard).not.toHaveBeenCalled();
  });

  it.each([
    'admin',
    'editor',
    'purchase_admin',
    'supply_chain_admin',
    'purchase_applicant',
    'guest',
  ] as const)(
    'rejects 201 delete targets for %s before reading',
    async (role) => {
      const target = deleteTarget(itemByCode(dashboard, 'A-APPLICATION'));
      const accessPrincipal =
        role === 'purchase_applicant' ? applicantA : principal(role);

      await expect(
        policy.authorizeDelete(accessPrincipal, {
          records: Array.from({ length: 201 }, (_, index) => ({
            ...target,
            key: `${target.key}-${index}`,
          })),
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(getDashboard).not.toHaveBeenCalled();
    },
  );

  it.each(['admin', 'purchase_admin', 'supply_chain_admin'] as const)(
    'rejects malformed delete bodies for %s before role-specific authorization',
    async (role) => {
      const malformedRequests: unknown[] = [
        undefined,
        null,
        {},
        'invalid',
        [],
        { records: undefined },
        { records: null },
        { records: {} },
        { records: 'invalid' },
      ];

      for (const malformedRequest of malformedRequests) {
        await expect(
          policy.authorizeDelete(principal(role), malformedRequest as never),
        ).rejects.toBeInstanceOf(ForbiddenException);
      }
      expect(getDashboard).not.toHaveBeenCalled();
    },
  );

  it('authorizes an all-local pending batch with one dashboard read', async () => {
    const filterSpy = jest.spyOn(dashboard.requests, 'filter');
    const request: PurchaseRecordBatchDeleteRequest = {
      records: [
        deleteTarget(itemByCode(dashboard, 'A-APPLICATION')),
        deleteTarget(itemByCode(dashboard, 'A-APPROVAL')),
      ],
    };

    await expect(policy.authorizeDelete(applicantA, request)).resolves.toBe(
      request,
    );
    expect(getDashboard).toHaveBeenCalledTimes(1);
    expect(filterSpy).not.toHaveBeenCalled();
    expect(getDashboard).toHaveBeenCalledWith(true);
  });

  it('rejects a mixed-building batch atomically with one dashboard read', async () => {
    const request: PurchaseRecordBatchDeleteRequest = {
      records: [
        deleteTarget(itemByCode(dashboard, 'A-APPLICATION')),
        deleteTarget(itemByCode(dashboard, 'B-PENDING')),
      ],
    };

    await expect(
      policy.authorizeDelete(applicantA, request),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(getDashboard).toHaveBeenCalledTimes(1);
  });

  it('rejects mixed identifiers, locked stages, and completed records', async () => {
    const application = itemByCode(dashboard, 'A-APPLICATION');
    const approval = itemByCode(dashboard, 'A-APPROVAL');
    const executing = itemByCode(dashboard, 'A-EXECUTING');

    await expect(
      policy.authorizeDelete(applicantA, {
        records: [
          {
            key: 'mixed',
            submissionRecordId: application.submissionRecordId,
            executionRecordId: approval.executionRecordId,
          },
        ],
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      policy.authorizeDelete(applicantA, {
        records: [deleteTarget(executing)],
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    approval.purchaseCompleted = true;
    await expect(
      policy.authorizeDelete(applicantA, {
        records: [deleteTarget(approval)],
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it.each(['submissionRecordId', 'executionRecordId'] as const)(
    'rejects duplicate delete %s even when the other ID narrows the match',
    async (field) => {
      const item = itemByCode(dashboard, 'A-APPROVAL');
      dashboard.requests.push(
        field === 'submissionRecordId'
          ? requestItem('A-DELETE-DUPLICATE-SUBMISSION', {
              building: 'A楼',
              stage: 'approval',
              recordId: 'rec_route_delete_duplicate_submission',
              submissionRecordId: item.submissionRecordId,
              executionRecordId: 'rec_exec_delete_duplicate_submission_other',
            })
          : requestItem('A-DELETE-DUPLICATE-EXECUTION', {
              building: 'A楼',
              stage: 'approval',
              recordId: 'rec_route_delete_duplicate_execution',
              submissionRecordId: 'rec_sub_delete_duplicate_execution_other',
              executionRecordId: item.executionRecordId,
            }),
      );

      await expect(
        policy.authorizeDelete(applicantA, {
          records: [deleteTarget(item)],
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(getDashboard).toHaveBeenCalledTimes(1);
    },
  );

  it('rejects swapped submission and execution identifiers on delete', async () => {
    const item = itemByCode(dashboard, 'A-APPROVAL');

    await expect(
      policy.authorizeDelete(applicantA, {
        records: [
          {
            key: 'swapped',
            submissionRecordId: item.executionRecordId,
            executionRecordId: item.submissionRecordId,
          },
        ],
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(getDashboard).toHaveBeenCalledTimes(1);
  });
});

describe('PurchaseInventoryModule', () => {
  it('registers PurchaseAccessPolicyService as a provider', () => {
    const moduleSource = readFileSync(
      join(
        process.cwd(),
        'server/modules/purchase-inventory/purchase-inventory.module.ts',
      ),
      'utf8',
    );

    expect(moduleSource).toContain(
      "import { PurchaseAccessPolicyService } from './purchase-access-policy.service';",
    );
    expect(moduleSource).toMatch(
      /providers:\s*\[[\s\S]*PurchaseAccessPolicyService[\s\S]*\]/,
    );
  });
});

function principal(role: AccessRole): AccessPrincipal {
  return { role, purchaseBuilding: null };
}

function createDashboard(): PurchaseInventoryResponse {
  const requests: PurchaseInventoryRequestItem[] = [
    requestItem('A-APPLICATION', {
      building: ' A楼 ',
      stage: 'application',
      estimatedAmount: 100.125,
      actualAmount: null,
      executionRecordId: null,
    }),
    requestItem('A-APPROVAL', {
      building: 'A楼',
      stage: 'approval',
      estimatedAmount: 200.125,
      actualAmount: 150.126,
    }),
    requestItem('A-EXECUTING', {
      building: 'A楼',
      stage: 'executing',
      estimatedAmount: 300,
      actualAmount: 250.125,
    }),
    requestItem('A-RECEIVING', {
      building: 'A楼',
      stage: 'receiving',
      estimatedAmount: 400,
      actualAmount: null,
    }),
    requestItem('A-STOCKED', {
      building: 'A楼',
      stage: 'stocked',
      estimatedAmount: 500,
      actualAmount: 450.129,
      purchaseCompleted: true,
    }),
    requestItem('B-PENDING', {
      building: 'B楼',
      stage: 'application',
      estimatedAmount: 10_000,
      actualAmount: 9_000,
      executionRecordId: null,
    }),
    requestItem('A-ALIAS', {
      building: 'A栋',
      stage: 'application',
      estimatedAmount: 20_000,
      actualAmount: 20_000,
      executionRecordId: null,
    }),
    requestItem('NO-BUILDING', {
      building: '',
      stage: 'application',
      estimatedAmount: 30_000,
      actualAmount: 30_000,
      executionRecordId: null,
    }),
  ];
  const alerts: PurchaseInventoryAlertItem[] = [
    alertItem('rec_alert_a_1', ' A楼 ', 'SKU-A', 1, 10),
    alertItem('rec_alert_a_2', 'A楼', 'SKU-A', 2, 20),
    alertItem('rec_alert_b', 'B楼', 'SKU-B', 999, 999_999),
    alertItem('rec_alert_alias', 'A栋', 'SKU-ALIAS', 999, 999_999),
  ];
  const recentInbound: PurchaseInventoryMovementItem[] = [
    movementItem('rec_inbound_a_pending', 'inbound', ' A楼 ', '待入库'),
    movementItem('rec_inbound_a_done', 'inbound', 'A楼', '已入库'),
    movementItem('rec_inbound_b', 'inbound', 'B楼', '待入库'),
    movementItem('rec_inbound_alias', 'inbound', 'A栋', '待入库'),
  ];
  const recentOutbound: PurchaseInventoryMovementItem[] = [
    movementItem('rec_outbound_a', 'outbound', 'A楼', '已出库'),
    movementItem('rec_outbound_b', 'outbound', 'B楼', '已出库'),
  ];

  return {
    generatedAt: '2026-07-15T00:00:00.000Z',
    summary: {
      totalRequests: 88,
      pendingApprovals: 77,
      executingOrders: 66,
      awaitingReceipt: 55,
      stockedRequests: 44,
      estimatedAmount: 888_888,
      actualAmount: 777_777,
      catalogItems: 666,
      inventorySkus: 555,
      availableQuantity: 444,
      inventoryValue: 333_333,
      lowStockSkus: 222,
      pendingInbound: 111,
      stageCounts: {
        application: 88,
        approval: 77,
        rejected: 0,
        executing: 66,
        receiving: 55,
        inbound: 0,
        stocked: 44,
      },
    },
    requests,
    inventory: {
      categoryBreakdown: [
        { category: 'B楼机密物品', skuCount: 999, quantity: 999_999 },
      ],
      alerts,
    },
    movements: { recentInbound, recentOutbound },
    sectionStatus: {
      submissions: sectionStatus(888, 'submission-health'),
      executions: sectionStatus(777, 'execution-health'),
      catalog: sectionStatus(666, 'catalog-health'),
      inventory: sectionStatus(555, 'inventory-health'),
      inbound: sectionStatus(444, 'inbound-health'),
      outbound: sectionStatus(333, 'outbound-health'),
    },
  };
}

function requestItem(
  requestCode: string,
  overrides: Partial<PurchaseInventoryRequestItem>,
): PurchaseInventoryRequestItem {
  const slug = requestCode.toLowerCase().replace(/[^a-z0-9]+/g, '_');
  const submissionRecordId = `rec_sub_${slug}`;
  const executionRecordId = `rec_exec_${slug}`;
  const merged = {
    recordId: executionRecordId,
    submissionRecordId,
    executionRecordId,
    requestCode,
    title: `${requestCode} item`,
    requester: '测试申请人',
    purchaser: '测试采购员',
    building: 'A楼',
    specialty: '暖通',
    primaryCategory: '备件',
    secondaryCategory: '传感器',
    stage: 'application',
    statusLabel: '待提交',
    supplier: '测试供应商',
    estimatedAmount: 0,
    actualAmount: null,
    quantity: 1,
    actualQuantity: null,
    unit: '个',
    priority: 'P2',
    createdAt: '2026-07-15T00:00:00.000Z',
    expectedArrival: null,
    orderedAt: null,
    receivedAt: null,
    warehouseRequired: false,
    warehouseConfirmed: false,
    purchaseCompleted: false,
    inventorySku: `SKU-${slug}`,
    notes: '',
    ...overrides,
  } satisfies PurchaseInventoryRequestItem;
  return {
    ...merged,
    recordId:
      overrides.recordId ??
      merged.executionRecordId ??
      merged.submissionRecordId ??
      requestCode,
  };
}

function alertItem(
  recordId: string,
  building: string,
  sku: string,
  availableQuantity: number,
  value: number,
): PurchaseInventoryAlertItem {
  return {
    recordId,
    sku,
    name: `${recordId} item`,
    building,
    category: '备件',
    location: '仓库',
    availableQuantity,
    reorderPoint: 10,
    difference: availableQuantity - 10,
    unit: '个',
    value,
    owners: ['测试负责人'],
    riskTone: 'warning',
  };
}

function movementItem(
  recordId: string,
  type: 'inbound' | 'outbound',
  building: string,
  status: string,
): PurchaseInventoryMovementItem {
  return {
    recordId,
    type,
    sku: `${recordId}-sku`,
    name: `${recordId} item`,
    quantity: 1,
    status,
    building,
    location: '仓库',
    sourceOrReason: '测试',
    operator: '示例人员016',
    createdAt: '2026-07-15T00:00:00.000Z',
  };
}

function sectionStatus(count: number, message: string) {
  return { configured: true, count, message };
}

function itemByCode(
  dashboard: PurchaseInventoryResponse,
  requestCode: string,
): PurchaseInventoryRequestItem {
  const item = dashboard.requests.find(
    (candidate) => candidate.requestCode === requestCode,
  );
  if (!item) throw new Error(`Missing fixture item: ${requestCode}`);
  return item;
}

function updateFor(
  item: PurchaseInventoryRequestItem,
): PurchaseRecordUpdateRequest {
  return {
    submissionRecordId: item.submissionRecordId,
    executionRecordId: item.executionRecordId,
    fields: { notes: 'authorized update' },
  };
}

function deleteTarget(item: PurchaseInventoryRequestItem) {
  return {
    key: item.requestCode,
    submissionRecordId: item.submissionRecordId,
    executionRecordId: item.executionRecordId,
  };
}
