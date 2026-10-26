import type { PurchaseInventoryRequestItem } from '../../shared/purchase-inventory.interface';
import {
  filterPurchaseWorkflowCenterItems,
  purchaseWorkflowCenterGroups,
} from '../../client/src/pages/PurchaseInventoryManagement/purchase-workflow-center.logic';
import * as workflowCenterLogic from '../../client/src/pages/PurchaseInventoryManagement/purchase-workflow-center.logic';
import type { PurchaseWorkflowDetail } from '../../shared/purchase-workflow.interface';

function request(
  recordId: string,
  stage: PurchaseInventoryRequestItem['stage'],
  overrides: Partial<PurchaseInventoryRequestItem> = {},
): PurchaseInventoryRequestItem {
  return {
    recordId,
    submissionRecordId: `submission-${recordId}`,
    executionRecordId: `execution-${recordId}`,
    requestCode: `PR-${recordId}`,
    title: `${stage}物品`,
    requester: '申请人',
    purchaser: '采购人',
    building: 'A楼',
    specialty: '电气',
    primaryCategory: '设备',
    secondaryCategory: '备件',
    stage,
    statusLabel: stage,
    supplier: '测试供应商',
    estimatedAmount: 100,
    actualAmount: null,
    quantity: 1,
    actualQuantity: null,
    unit: '件',
    priority: '未设置',
    createdAt: '2026-07-11T00:00:00.000Z',
    expectedArrival: null,
    orderedAt: null,
    receivedAt: null,
    warehouseRequired: true,
    warehouseConfirmed: false,
    purchaseCompleted: false,
    inventorySku: '',
    notes: '',
    ...overrides,
  };
}

describe('purchase workflow center', () => {
  it('maps every currently enabled procurement Base workflow into the program catalog', () => {
    const workflows = purchaseWorkflowCenterGroups.flatMap(
      (group) => group.workflows,
    );

    expect(workflows.map((workflow) => workflow.sourceTitle)).toEqual([
      '-内容初审',
      '-经理审批',
      '-审批完成',
      '-库房确认',
      '-采购启动',
      '-采购跟踪',
      '下单跟踪',
      '-下单推送',
      '-到货确认',
      '-签收推送',
      '入库状态自动更新',
    ]);
    expect(workflows).toHaveLength(11);
  });

  it('builds each queue from live dashboard stages and supports fuzzy search', () => {
    const requests = [
      request('application', 'application'),
      request('approval', 'approval', { requester: '孙婷婷' }),
      request('executing', 'executing'),
      request('receiving', 'receiving'),
      request('stocked', 'stocked'),
    ];

    expect(
      filterPurchaseWorkflowCenterItems(requests, 'manager-approval', ''),
    ).toEqual([expect.objectContaining({ recordId: 'approval' })]);
    expect(
      filterPurchaseWorkflowCenterItems(requests, 'purchase-tracking', ''),
    ).toEqual([expect.objectContaining({ recordId: 'executing' })]);
    expect(
      filterPurchaseWorkflowCenterItems(requests, 'receipt-push', ''),
    ).toEqual([expect.objectContaining({ recordId: 'receiving' })]);
    expect(
      filterPurchaseWorkflowCenterItems(requests, 'manager-approval', '婷婷'),
    ).toHaveLength(1);
    expect(
      filterPurchaseWorkflowCenterItems(requests, 'manager-approval', '不存在'),
    ).toHaveLength(0);
  });

  it('builds an immediate read-only workflow preview from the dashboard row', () => {
    const createPreview = (
      workflowCenterLogic as unknown as {
        createPurchaseWorkflowPreviewDetail?: (
          item: PurchaseInventoryRequestItem,
          allowWorkflowAction?: boolean,
        ) => PurchaseWorkflowDetail;
      }
    ).createPurchaseWorkflowPreviewDetail;
    expect(createPreview).toBeDefined();
    if (!createPreview) return;

    const detail = createPreview(
      request('receiving', 'receiving', {
        requestCode: 'CG260408-602',
        title: '路由器',
        statusLabel: '下单完成（待签收）',
        purchaseMethod: '综合采购',
        actualQuantity: 1,
        actualAmount: 379.05,
      }),
    );

    expect(detail).toMatchObject({
      stage: 'receipt',
      allowedActions: [],
      programEnabled: false,
      record: {
        recordId: 'execution-receiving',
        requestCode: 'CG260408-602',
        itemName: '路由器',
        status: '下单完成（待签收）',
        actualQuantity: 1,
        actualAmount: 379.05,
      },
    });

    expect(
      createPreview(
        request('receiving', 'receiving', {
          requestCode: 'CG260408-602',
        }),
        true,
      ),
    ).toMatchObject({
      stage: 'receipt',
      allowedActions: ['receive'],
      programEnabled: true,
      disabledReason: '',
    });
    expect(
      createPreview(
        request('executing', 'executing', {
          requestCode: 'CG260722-601',
          statusLabel: '审批通过（待下单）',
        }),
        true,
      ),
    ).toMatchObject({
      stage: 'ordering',
      allowedActions: ['order'],
      programEnabled: true,
      disabledReason: '',
    });
    expect(detail.timeline).toHaveLength(6);
  });
});
