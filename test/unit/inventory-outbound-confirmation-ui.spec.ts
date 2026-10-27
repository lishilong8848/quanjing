import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type {
  InventoryMovementsResponse,
  InventoryOutboundMovementItem,
} from '../../shared/inventory-management.interface';
import {
  INVENTORY_OUTBOUND_APPROVAL_REFRESH_MS,
  buildInventoryOutboundConfirmationSubmission,
  canConfirmInventoryOutboundForBuilding,
  canRestoreInventoryOutboundConfirmation,
  formatInventoryOutboundStatusLabel,
  formatInventoryOutboundConfirmationTime,
  requireCanonicalOutboundMovement,
  resolveInventoryOutboundConfirmationFailure,
  shouldRefreshInventoryOutboundApprovals,
} from '../../client/src/pages/InventoryManagement/inventory-outbound-confirmation';

const root = process.cwd();
const movementPageSource = readFileSync(
  join(root, 'client/src/pages/InventoryManagement/InventoryMovementPage.tsx'),
  'utf8',
);
const confirmationDialogSource = readFileSync(
  join(
    root,
    'client/src/pages/InventoryManagement/InventoryOutboundConfirmationDialog.tsx',
  ),
  'utf8',
);
const inventoryPageSource = readFileSync(
  join(root, 'client/src/pages/InventoryManagement/index.tsx'),
  'utf8',
);

function movement(
  overrides: Partial<InventoryOutboundMovementItem> = {},
): InventoryOutboundMovementItem {
  return {
    recordId: 'outbound-record-1',
    clientMutationId: 'outbound-create-1',
    type: 'outbound',
    sku: 'A-001',
    name: '温湿度传感器',
    specification: 'TH-100',
    quantity: 2,
    unit: '台',
    building: 'A楼',
    destinationBuilding: '',
    location: 'A-01',
    reason: '机房监测补点',
    operator: '',
    applicant: '张三',
    status: '待库房确认',
    occurredAt: '2026-08-11T01:30:00.000Z',
    expectedReturnAt: null,
    overdue: false,
    ...overrides,
  };
}

function response(
  items: InventoryOutboundMovementItem[],
  statusCounts: InventoryMovementsResponse['summary']['statusCounts'] = [],
): InventoryMovementsResponse {
  return {
    items,
    total: items.length,
    page: 1,
    pageSize: 20,
    totalPages: 1,
    summary: {
      totalRecords: items.length,
      totalQuantity: items.reduce((total, item) => total + item.quantity, 0),
      overdueItems: 0,
      statusCounts,
    },
  };
}

describe('inventory outbound confirmation ui contract', () => {
  it('wires desktop and mobile pending records to the guarded confirmation detail', () => {
    expect(movementPageSource.match(/查看并确认/g)).toHaveLength(2);
    expect(movementPageSource).toContain(
      'canConfirmInventoryOutboundForBuilding(',
    );
    expect(confirmationDialogSource).toContain('canConfirm: boolean;');
    expect(confirmationDialogSource).toContain('canConfirm &&');
    expect(inventoryPageSource).toContain(
      'outboundConfirmationAccessReady={!accessLoading}',
    );
    expect(inventoryPageSource).toContain(
      "role === 'inventory_admin' || role === 'building_admin'",
    );
    expect(inventoryPageSource).toMatch(
      /outboundConfirmationBuilding=\{\s*scope\?\.length === 1 \? scope\[0\] : null\s*\}/,
    );
  });

  it('labels approval completion as the start of warehouse confirmation', () => {
    expect(formatInventoryOutboundStatusLabel('待库房确认')).toBe(
      '审批已通过 · 待库房确认',
    );
    expect(formatInventoryOutboundStatusLabel('待审批')).toBe('待审批');
    expect(movementPageSource).toContain(
      'formatInventoryOutboundStatusLabel(item.status)',
    );
  });

  it('polls only while outbound approval routing is unsettled', () => {
    expect(
      shouldRefreshInventoryOutboundApprovals(
        'outbound',
        response([movement({ status: '待审批' })]),
      ),
    ).toBe(true);
    expect(
      shouldRefreshInventoryOutboundApprovals(
        'outbound',
        response([], [{ status: '待路由', count: 1 }]),
      ),
    ).toBe(true);
    expect(
      shouldRefreshInventoryOutboundApprovals(
        'outbound',
        response([movement({ status: '待库房确认' })]),
      ),
    ).toBe(false);
    expect(
      shouldRefreshInventoryOutboundApprovals(
        'inbound',
        response([movement({ status: '待审批' })]),
      ),
    ).toBe(false);
  });

  it('uses a visible-page non-overlapping refresh loop for external approval changes', () => {
    expect(INVENTORY_OUTBOUND_APPROVAL_REFRESH_MS).toBe(5_000);
    expect(movementPageSource).toContain('window.setInterval(');
    expect(movementPageSource).toContain(
      "document.visibilityState !== 'visible'",
    );
    expect(movementPageSource).toContain(
      'outboundApprovalRefreshInFlightRef.current',
    );
    expect(movementPageSource).toContain(
      'shouldRefreshInventoryOutboundApprovals(type, response)',
    );
  });

  it('shows every warehouse review field including application time', () => {
    for (const label of [
      '来源楼栋 / 库位',
      '申请数量',
      '物品申请人',
      '出库原因 / 使用地点',
      '申请办理时间',
    ]) {
      expect(confirmationDialogSource).toContain(label);
    }
  });

  it('wires unknown-result abandon and external recovery cleanup controls', () => {
    expect(movementPageSource).toContain(
      'onAbandonRetry={abandonOutboundConfirmationRetry}',
    );
    expect(confirmationDialogSource).toContain('放弃原确认编号并刷新');
    expect(movementPageSource).toContain('restoredOutboundRecoveryRef.current');
    expect(movementPageSource).toContain('if (resolution.retainRecovery)');
    expect(movementPageSource).toContain(
      'if (resolution.refreshAuthority) void loadMovements(true);',
    );
  });

  it('detaches restored confirmation ui before clearing its recovery storage', () => {
    const confirmAbandon = movementPageSource.slice(
      movementPageSource.indexOf('const abandonOutboundConfirmationRetry'),
      movementPageSource.indexOf('const submitManualInbound'),
    );

    expect(
      confirmAbandon.indexOf('restoredOutboundRecoveryRef.current = null'),
    ).toBeGreaterThanOrEqual(0);
    expect(
      confirmAbandon.indexOf('restoredOutboundRecoveryRef.current = null'),
    ).toBeLessThan(confirmAbandon.indexOf('clearInventoryOutboundRecovery'));
    expect(movementPageSource).not.toContain('const abandonOutboundRetry');
  });

  it('clears known rejected confirmations and refreshes authoritative state', () => {
    expect(resolveInventoryOutboundConfirmationFailure('rejected')).toEqual({
      retainRecovery: false,
      retryLocked: false,
      keepDialogOpen: false,
      refreshAuthority: true,
    });
  });

  it('retains only unknown confirmation outcomes for same-id retry', () => {
    expect(resolveInventoryOutboundConfirmationFailure('unknown')).toEqual({
      retainRecovery: true,
      retryLocked: true,
      keepDialogOpen: true,
      refreshAuthority: false,
    });
  });

  it('restores confirmation details only for authorized warehouse roles', () => {
    expect(
      canRestoreInventoryOutboundConfirmation(true, 'unknown', 'A楼', null),
    ).toBe(true);
    expect(
      canRestoreInventoryOutboundConfirmation(false, 'unknown', 'A楼', null),
    ).toBe(false);
    expect(
      canRestoreInventoryOutboundConfirmation(true, 'draft', 'A楼', null),
    ).toBe(false);
  });

  it('limits inventory administrators to their current warehouse building', () => {
    expect(canConfirmInventoryOutboundForBuilding(true, 'A楼', null)).toBe(
      true,
    );
    expect(canConfirmInventoryOutboundForBuilding(true, 'A楼', 'A楼')).toBe(
      true,
    );
    expect(canConfirmInventoryOutboundForBuilding(true, 'A楼', 'B楼')).toBe(
      false,
    );
    expect(canConfirmInventoryOutboundForBuilding(false, 'A楼', 'A楼')).toBe(
      false,
    );
    expect(canConfirmInventoryOutboundForBuilding(true, '未配置', null)).toBe(
      false,
    );
  });

  it('discards hidden or cross-building confirm recovery instead of blocking create', () => {
    const applyRecovery = movementPageSource.slice(
      movementPageSource.indexOf('const applyOutboundRecovery'),
      movementPageSource.indexOf('const restoreSavedOutboundRecovery'),
    );
    expect(applyRecovery).toContain(
      '!canRestoreInventoryOutboundConfirmation(',
    );
    expect(applyRecovery).toContain(
      'clearInventoryOutboundRecovery(recovery.clientMutationId)',
    );
  });

  it('formats the application time in the deployment timezone', () => {
    expect(
      formatInventoryOutboundConfirmationTime('2026-08-11T01:30:00.000Z'),
    ).toBe('2026-08-11 09:30');
  });

  it('builds an immediate completed optimistic mutation for one pending record', () => {
    const submission = buildInventoryOutboundConfirmationSubmission(
      movement(),
      'outbound-confirm-1',
      Date.parse('2026-08-11T02:00:00.000Z'),
    );

    expect(submission).toMatchObject({
      clientMutationId: 'outbound-confirm-1',
      recordId: 'outbound-record-1',
      request: { clientMutationId: 'outbound-confirm-1' },
      draft: { note: '确认出库' },
      optimisticMovement: {
        recordId: 'outbound-record-1',
        type: 'outbound',
        status: '已出库',
        pendingSync: true,
        occurredAt: '2026-08-11T02:00:00.000Z',
      },
    });
  });

  it.each([movement({ status: '已出库' })])(
    'rejects a record that is not confirmable',
    (item) => {
      expect(() =>
        buildInventoryOutboundConfirmationSubmission(
          item,
          'outbound-confirm-1',
          100,
        ),
      ).toThrow('该出库单据当前不可确认');
    },
  );

  it('allows a server-registered pending outbound to be confirmed while its creation sync is still settling', () => {
    const submission = buildInventoryOutboundConfirmationSubmission(
      movement({ pendingSync: true }),
      'outbound-confirm-pending-sync-1',
      Date.parse('2026-08-18T08:00:00.000Z'),
    );

    expect(submission.optimisticMovement).toMatchObject({
      recordId: 'outbound-record-1',
      status: '已出库',
      pendingSync: true,
      occurredAt: '2026-08-18T08:00:00.000Z',
    });
  });

  it('accepts a complete authoritative completed response', () => {
    const canonical = movement({
      status: '已出库',
      occurredAt: '2026-08-11T02:00:00.000Z',
    });

    expect(
      requireCanonicalOutboundMovement(canonical, {
        recordId: 'outbound-record-1',
        status: '已出库',
        sku: 'A-001',
        building: 'A楼',
        quantity: 2,
      }),
    ).toBe(canonical);
  });

  it.each([
    movement({ recordId: 'other-record', status: '已出库' }),
    movement({ status: '待库房确认' }),
    movement({ sku: 'OTHER', status: '已出库' }),
    movement({ quantity: 3, status: '已出库' }),
  ])('rejects an inconsistent authoritative response', (canonical) => {
    expect(() =>
      requireCanonicalOutboundMovement(canonical, {
        recordId: 'outbound-record-1',
        status: '已出库',
        sku: 'A-001',
        building: 'A楼',
        quantity: 2,
      }),
    ).toThrow('后端返回的出库记录与本次操作不一致');
  });
});
