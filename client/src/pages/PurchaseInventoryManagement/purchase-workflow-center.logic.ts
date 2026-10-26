import type {
  PurchaseInventoryRequestItem,
  PurchaseInventoryStage,
} from '@shared/purchase-inventory.interface';
import type {
  PurchaseWorkflowDetail,
  PurchaseWorkflowMethod,
  PurchaseWorkflowStage,
  PurchaseWorkflowTimelineItem,
} from '@shared/purchase-workflow.interface';

export type PurchaseWorkflowCenterKey =
  | 'content-review'
  | 'manager-approval'
  | 'approval-complete'
  | 'warehouse-confirm'
  | 'purchase-start'
  | 'purchase-tracking'
  | 'order-tracking'
  | 'order-push'
  | 'arrival-confirm'
  | 'receipt-push'
  | 'inventory-sync';

export type PurchaseWorkflowCenterMode = '人工处理' | '状态联动' | '定时提醒';

export interface PurchaseWorkflowCenterItem {
  key: PurchaseWorkflowCenterKey;
  sourceWorkflowId: string;
  sourceTitle: string;
  programLabel: string;
  mode: PurchaseWorkflowCenterMode;
  stages: PurchaseInventoryStage[];
}

export interface PurchaseWorkflowCenterGroup {
  key: 'application' | 'execution' | 'receipt';
  label: string;
  workflows: PurchaseWorkflowCenterItem[];
}

export const purchaseWorkflowCenterGroups: PurchaseWorkflowCenterGroup[] = [
  {
    key: 'application',
    label: '申请与审批',
    workflows: [
      {
        key: 'content-review',
        sourceWorkflowId: 'wkfzhGTdU73yIP3E',
        sourceTitle: '-内容初审',
        programLabel: '申请内容校验',
        mode: '人工处理',
        stages: ['application'],
      },
      {
        key: 'manager-approval',
        sourceWorkflowId: 'wkfEyCINcTxVogu1',
        sourceTitle: '-经理审批',
        programLabel: '经理审批待办',
        mode: '人工处理',
        stages: ['approval'],
      },
      {
        key: 'approval-complete',
        sourceWorkflowId: 'wkfEVrm2xA3E51MD',
        sourceTitle: '-审批完成',
        programLabel: '审批状态回写',
        mode: '状态联动',
        stages: ['approval'],
      },
    ],
  },
  {
    key: 'execution',
    label: '采购启动与下单',
    workflows: [
      {
        key: 'warehouse-confirm',
        sourceWorkflowId: 'wkfGFQyUPQMtENt5',
        sourceTitle: '-库房确认',
        programLabel: '库房确认待办',
        mode: '人工处理',
        stages: ['approval'],
      },
      {
        key: 'purchase-start',
        sourceWorkflowId: 'wkf3X2ULfXJ7I5dj',
        sourceTitle: '-采购启动',
        programLabel: '分配采购人',
        mode: '人工处理',
        stages: ['approval'],
      },
      {
        key: 'purchase-tracking',
        sourceWorkflowId: 'wkfBgejRK7vFZbuF',
        sourceTitle: '-采购跟踪',
        programLabel: '每日采购提醒',
        mode: '定时提醒',
        stages: ['executing'],
      },
      {
        key: 'order-tracking',
        sourceWorkflowId: 'wkfTzzr0C7sPnWyD',
        sourceTitle: '下单跟踪',
        programLabel: '周期下单提醒',
        mode: '定时提醒',
        stages: ['executing'],
      },
      {
        key: 'order-push',
        sourceWorkflowId: 'wkf8LJfoeHtD8oYP',
        sourceTitle: '-下单推送',
        programLabel: '下单结果流转',
        mode: '状态联动',
        stages: ['executing'],
      },
    ],
  },
  {
    key: 'receipt',
    label: '到货与入库',
    workflows: [
      {
        key: 'arrival-confirm',
        sourceWorkflowId: 'wkf15YZhaIdt6llc',
        sourceTitle: '-到货确认',
        programLabel: '到货签收提醒',
        mode: '定时提醒',
        stages: ['receiving'],
      },
      {
        key: 'receipt-push',
        sourceWorkflowId: 'wkfeX7fj7GgPklxh',
        sourceTitle: '-签收推送',
        programLabel: '签收校验与流转',
        mode: '人工处理',
        stages: ['receiving'],
      },
      {
        key: 'inventory-sync',
        sourceWorkflowId: 'wkfRnPnOdP10Am6n',
        sourceTitle: '入库状态自动更新',
        programLabel: '入库闭环回写',
        mode: '状态联动',
        stages: ['inbound', 'stocked'],
      },
    ],
  },
];

export const purchaseWorkflowCenterItems = purchaseWorkflowCenterGroups.flatMap(
  (group) => group.workflows,
);

export function getPurchaseWorkflowCenterItem(
  key: PurchaseWorkflowCenterKey,
): PurchaseWorkflowCenterItem {
  const workflow = purchaseWorkflowCenterItems.find((item) => item.key === key);
  if (!workflow) throw new Error(`未知采购工作流：${key}`);
  return workflow;
}

export function filterPurchaseWorkflowCenterItems(
  requests: PurchaseInventoryRequestItem[],
  workflowKey: PurchaseWorkflowCenterKey,
  keyword: string,
): PurchaseInventoryRequestItem[] {
  const workflow = getPurchaseWorkflowCenterItem(workflowKey);
  const normalizedKeyword = keyword.trim().toLowerCase();

  return requests.filter((item) => {
    if (!workflow.stages.includes(item.stage)) return false;
    if (!normalizedKeyword) return true;
    return [
      item.requestCode,
      item.title,
      item.requester,
      item.purchaser,
      item.building,
      item.supplier,
      item.statusLabel,
    ]
      .join(' ')
      .toLowerCase()
      .includes(normalizedKeyword);
  });
}

export function createPurchaseWorkflowPreviewDetail(
  item: PurchaseInventoryRequestItem,
  allowWorkflowAction = false,
): PurchaseWorkflowDetail {
  const stage = previewStage(item.stage);
  const createdAt = timestamp(item.createdAt);
  const receiptTime = timestamp(item.receivedAt);
  const previewAction =
    allowWorkflowAction && stage === 'ordering'
      ? 'order'
      : allowWorkflowAction && stage === 'receipt'
        ? 'receive'
        : null;
  return {
    record: {
      recordId: item.executionRecordId || item.recordId,
      requestCode: item.requestCode,
      status: item.statusLabel,
      itemName: item.title,
      building: item.building,
      requesterOpenId: '',
      requesterName: item.requester,
      purchaserOpenId: '',
      purchaserName: item.purchaser,
      purchaseMethod: previewPurchaseMethod(item.purchaseMethod),
      requestedQuantity: item.quantity,
      unit: item.unit,
      unitPrice: null,
      createdAt,
      actualQuantity: item.actualQuantity,
      actualAmount: item.actualAmount,
      amountDifference:
        item.actualAmount === null
          ? null
          : item.actualAmount - item.estimatedAmount,
      quantityDifference:
        item.actualQuantity === null
          ? null
          : item.actualQuantity - item.quantity,
      approvalCompleted: !['application', 'approval'].includes(item.stage),
      warehouseConfirmed: item.warehouseConfirmed,
      purchaseCompleted: item.purchaseCompleted,
      receiptConfirmed: item.stage === 'stocked' || Boolean(receiptTime),
      signer: '',
      receiptTime,
      receiptPhotoTokens: [],
      invoiceTokens: [],
      supplier: item.supplier,
      requirementSummary: item.notes,
      expectedDeliveryDate: timestamp(item.expectedArrival),
      note: item.notes,
    },
    stage,
    allowedActions: previewAction ? [previewAction] : [],
    timeline: previewTimeline(stage),
    programEnabled: Boolean(previewAction),
    disabledReason: previewAction ? '' : '正在后台校验最新流程状态',
  };
}

function previewStage(stage: PurchaseInventoryStage): PurchaseWorkflowStage {
  switch (stage) {
    case 'application':
    case 'approval':
      return 'approval';
    case 'rejected':
      return 'terminated';
    case 'executing':
      return 'ordering';
    case 'receiving':
      return 'receipt';
    case 'inbound':
      return 'inbound';
    case 'stocked':
      return 'completed';
  }
}

function previewPurchaseMethod(value: string): PurchaseWorkflowMethod {
  return ['综合采购', '需求自采', '需求自采（楼内）', '驳回'].includes(value)
    ? (value as PurchaseWorkflowMethod)
    : '';
}

function previewTimeline(
  stage: PurchaseWorkflowStage,
): PurchaseWorkflowTimelineItem[] {
  const nodes: Array<{
    key: PurchaseWorkflowTimelineItem['key'];
    label: string;
  }> = [
    { key: 'application', label: '申请审批' },
    { key: 'approval', label: '库房确认' },
    { key: 'ordering', label: '采购下单' },
    { key: 'receipt', label: '收货签收' },
    { key: 'inbound', label: '等待入库' },
    { key: 'completed', label: '采购完成' },
  ];
  const current = nodes.findIndex((node) => node.key === stage);
  return nodes.map((node, index) => ({
    ...node,
    state:
      stage === 'terminated'
        ? index === 0
          ? 'terminated'
          : 'pending'
        : current < 0
          ? 'pending'
          : index < current
            ? 'completed'
            : index === current
              ? 'current'
              : 'pending',
  }));
}

function timestamp(value: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}
