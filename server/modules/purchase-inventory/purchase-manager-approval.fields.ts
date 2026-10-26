export const PURCHASE_MANAGER_LEGACY_INVALID_CARD_POLICY_VERSION =
  'purchase-manager-card-v1';
export const PURCHASE_MANAGER_APPROVAL_POLICY_VERSION =
  'purchase-manager-card-v2';

export const PURCHASE_MANAGER_APPROVAL_FIELDS = {
  source: '采购审批来源',
  state: '采购工作流状态',
  currentApprover: '采购当前审批人',
  actualApprover: '采购实际审批人',
  approvalTime: '采购审批时间',
  policyVersion: '采购审批策略版本',
  batchId: '采购审批批次号',
  actionId: '采购审批动作标识',
  error: '采购工作流错误',
  deliveryState: '采购卡片投递状态',
  deliveryTime: '采购卡片投递时间',
  messageId: '采购卡片消息标识',
  deliveryUuid: '采购卡片投递标识',
  deliveryAttempts: '采购卡片投递次数',
  deliveryLastAttemptAt: '采购卡片最后投递时间',
  receiptBatchId: '采购签收卡片批次号',
  receiptDeliveryState: '采购签收卡片投递状态',
  receiptDeliveryTime: '采购签收卡片投递时间',
  receiptMessageId: '采购签收卡片消息标识',
  receiptDeliveryUuid: '采购签收卡片投递标识',
  receiptDeliveryAttempts: '采购签收卡片投递次数',
  receiptDeliveryLastAttemptAt: '采购签收卡片最后投递时间',
  receiptDeliveryError: '采购签收卡片投递错误',
} as const;

export interface PurchaseManagerApprovalFieldDefinition {
  name: string;
  type: number;
  multiple?: boolean;
  payload: Record<string, unknown>;
}

export const PURCHASE_MANAGER_APPROVAL_FIELD_DEFINITIONS: readonly PurchaseManagerApprovalFieldDefinition[] =
  [
    select(PURCHASE_MANAGER_APPROVAL_FIELDS.source, [
      '程序卡片',
      '历史飞书工作流',
    ]),
    select(PURCHASE_MANAGER_APPROVAL_FIELDS.state, [
      '待路由',
      '待经理审批',
      '已通过',
      '已驳回',
      '同步异常',
    ]),
    user(PURCHASE_MANAGER_APPROVAL_FIELDS.currentApprover, true),
    user(PURCHASE_MANAGER_APPROVAL_FIELDS.actualApprover, false),
    datetime(PURCHASE_MANAGER_APPROVAL_FIELDS.approvalTime),
    text(PURCHASE_MANAGER_APPROVAL_FIELDS.policyVersion),
    text(PURCHASE_MANAGER_APPROVAL_FIELDS.batchId),
    text(PURCHASE_MANAGER_APPROVAL_FIELDS.actionId),
    text(PURCHASE_MANAGER_APPROVAL_FIELDS.error),
    select(PURCHASE_MANAGER_APPROVAL_FIELDS.deliveryState, [
      '待投递',
      '投递中',
      '已送达',
      '投递异常',
      '送达待核对',
    ]),
    datetime(PURCHASE_MANAGER_APPROVAL_FIELDS.deliveryTime),
    text(PURCHASE_MANAGER_APPROVAL_FIELDS.messageId),
    text(PURCHASE_MANAGER_APPROVAL_FIELDS.deliveryUuid),
    number(PURCHASE_MANAGER_APPROVAL_FIELDS.deliveryAttempts),
    datetime(PURCHASE_MANAGER_APPROVAL_FIELDS.deliveryLastAttemptAt),
    text(PURCHASE_MANAGER_APPROVAL_FIELDS.receiptBatchId),
    select(PURCHASE_MANAGER_APPROVAL_FIELDS.receiptDeliveryState, [
      '待投递',
      '投递中',
      '已送达',
      '投递异常',
      '送达待核对',
    ]),
    datetime(PURCHASE_MANAGER_APPROVAL_FIELDS.receiptDeliveryTime),
    text(PURCHASE_MANAGER_APPROVAL_FIELDS.receiptMessageId),
    text(PURCHASE_MANAGER_APPROVAL_FIELDS.receiptDeliveryUuid),
    number(PURCHASE_MANAGER_APPROVAL_FIELDS.receiptDeliveryAttempts),
    datetime(PURCHASE_MANAGER_APPROVAL_FIELDS.receiptDeliveryLastAttemptAt),
    text(PURCHASE_MANAGER_APPROVAL_FIELDS.receiptDeliveryError),
  ];

export function buildPurchaseManagerRoutingFields(input: {
  approvalBatchId: string;
  managerOpenId: string;
  managerOpenIds?: string[];
  deliveryUuid?: string;
  deliveryAttempts?: number;
  deliveryLastAttemptAt?: Date | null;
}): Record<string, unknown> {
  return {
    [PURCHASE_MANAGER_APPROVAL_FIELDS.source]: '程序卡片',
    [PURCHASE_MANAGER_APPROVAL_FIELDS.state]: '待经理审批',
    [PURCHASE_MANAGER_APPROVAL_FIELDS.currentApprover]: [...new Set(input.managerOpenIds || [input.managerOpenId])].map(id => ({ id })),
    [PURCHASE_MANAGER_APPROVAL_FIELDS.actualApprover]: [],
    [PURCHASE_MANAGER_APPROVAL_FIELDS.approvalTime]: null,
    [PURCHASE_MANAGER_APPROVAL_FIELDS.policyVersion]:
      PURCHASE_MANAGER_APPROVAL_POLICY_VERSION,
    [PURCHASE_MANAGER_APPROVAL_FIELDS.batchId]: input.approvalBatchId,
    [PURCHASE_MANAGER_APPROVAL_FIELDS.actionId]: '',
    [PURCHASE_MANAGER_APPROVAL_FIELDS.error]: '',
    [PURCHASE_MANAGER_APPROVAL_FIELDS.deliveryState]: '待投递',
    [PURCHASE_MANAGER_APPROVAL_FIELDS.deliveryTime]: null,
    [PURCHASE_MANAGER_APPROVAL_FIELDS.messageId]: '',
    [PURCHASE_MANAGER_APPROVAL_FIELDS.deliveryUuid]: input.deliveryUuid || '',
    [PURCHASE_MANAGER_APPROVAL_FIELDS.deliveryAttempts]: Math.max(
      0,
      Math.floor(input.deliveryAttempts || 0),
    ),
    [PURCHASE_MANAGER_APPROVAL_FIELDS.deliveryLastAttemptAt]:
      input.deliveryLastAttemptAt?.getTime() || null,
  };
}

export function buildPurchaseManagerDeliveryStartedFields(input: {
  approvalBatchId: string;
  managerOpenId: string;
  deliveryUuid: string;
  deliveryAttempts: number;
  deliveryLastAttemptAt: Date;
}): Record<string, unknown> {
  return {
    ...buildPurchaseManagerRoutingFields(input),
    [PURCHASE_MANAGER_APPROVAL_FIELDS.deliveryState]: '投递中',
  };
}

export function buildPurchaseManagerDeliveredFields(input: {
  approvalBatchId: string;
  managerOpenId: string;
  managerOpenIds?: string[];
  deliveryUuid: string;
  deliveryAttempts: number;
  deliveredAt: Date;
  messageId: string;
}): Record<string, unknown> {
  return {
    ...buildPurchaseManagerRoutingFields({
      ...input,
      deliveryLastAttemptAt: input.deliveredAt,
    }),
    [PURCHASE_MANAGER_APPROVAL_FIELDS.deliveryState]: '已送达',
    [PURCHASE_MANAGER_APPROVAL_FIELDS.deliveryTime]:
      input.deliveredAt.getTime(),
    [PURCHASE_MANAGER_APPROVAL_FIELDS.messageId]: input.messageId,
  };
}

export function buildPurchaseManagerDeliveryErrorFields(input: {
  approvalBatchId: string;
  managerOpenId: string;
  deliveryUuid: string;
  deliveryAttempts: number;
  deliveryLastAttemptAt: Date | null;
  errorMessage: string;
}): Record<string, unknown> {
  return {
    ...buildPurchaseManagerRoutingFields(input),
    [PURCHASE_MANAGER_APPROVAL_FIELDS.state]: '同步异常',
    [PURCHASE_MANAGER_APPROVAL_FIELDS.deliveryState]: '投递异常',
    [PURCHASE_MANAGER_APPROVAL_FIELDS.error]: input.errorMessage.slice(0, 500),
  };
}

export function buildPurchaseManagerDeliveryManualReviewFields(input: {
  approvalBatchId: string;
  managerOpenId: string;
  deliveryUuid: string;
  deliveryAttempts: number;
  deliveryLastAttemptAt: Date | null;
  errorMessage: string;
}): Record<string, unknown> {
  return {
    ...buildPurchaseManagerDeliveryErrorFields(input),
    [PURCHASE_MANAGER_APPROVAL_FIELDS.deliveryState]: '送达待核对',
  };
}

export function buildPurchaseManagerResolvedFields(input: {
  choice: 'comprehensive' | 'building_self' | 'reject';
  actorOpenId: string;
  eventId: string;
  approvalTime: Date;
}): Record<string, unknown> {
  return {
    [PURCHASE_MANAGER_APPROVAL_FIELDS.source]: '程序卡片',
    [PURCHASE_MANAGER_APPROVAL_FIELDS.state]:
      input.choice === 'reject' ? '已驳回' : '已通过',
    [PURCHASE_MANAGER_APPROVAL_FIELDS.currentApprover]: [],
    [PURCHASE_MANAGER_APPROVAL_FIELDS.actualApprover]: [
      { id: input.actorOpenId },
    ],
    [PURCHASE_MANAGER_APPROVAL_FIELDS.approvalTime]:
      input.approvalTime.getTime(),
    [PURCHASE_MANAGER_APPROVAL_FIELDS.policyVersion]:
      PURCHASE_MANAGER_APPROVAL_POLICY_VERSION,
    [PURCHASE_MANAGER_APPROVAL_FIELDS.actionId]: input.eventId,
    [PURCHASE_MANAGER_APPROVAL_FIELDS.error]: '',
  };
}

export function buildPurchaseReceiptCardRoutingFields(input: {
  batchId: string;
  deliveryUuid: string;
  deliveryAttempts: number;
  deliveryLastAttemptAt: Date | null;
}): Record<string, unknown> {
  return {
    [PURCHASE_MANAGER_APPROVAL_FIELDS.receiptBatchId]: input.batchId,
    [PURCHASE_MANAGER_APPROVAL_FIELDS.receiptDeliveryState]: '待投递',
    [PURCHASE_MANAGER_APPROVAL_FIELDS.receiptDeliveryTime]: null,
    [PURCHASE_MANAGER_APPROVAL_FIELDS.receiptMessageId]: '',
    [PURCHASE_MANAGER_APPROVAL_FIELDS.receiptDeliveryUuid]: input.deliveryUuid,
    [PURCHASE_MANAGER_APPROVAL_FIELDS.receiptDeliveryAttempts]: Math.max(
      0,
      Math.floor(input.deliveryAttempts || 0),
    ),
    [PURCHASE_MANAGER_APPROVAL_FIELDS.receiptDeliveryLastAttemptAt]:
      input.deliveryLastAttemptAt?.getTime() || null,
    [PURCHASE_MANAGER_APPROVAL_FIELDS.receiptDeliveryError]: '',
  };
}

export function buildPurchaseReceiptCardDeliveredFields(input: {
  batchId: string;
  deliveryUuid: string;
  deliveryAttempts: number;
  deliveredAt: Date;
  messageId: string;
}): Record<string, unknown> {
  return {
    ...buildPurchaseReceiptCardRoutingFields({
      ...input,
      deliveryLastAttemptAt: input.deliveredAt,
    }),
    [PURCHASE_MANAGER_APPROVAL_FIELDS.receiptDeliveryState]: '已送达',
    [PURCHASE_MANAGER_APPROVAL_FIELDS.receiptDeliveryTime]:
      input.deliveredAt.getTime(),
    [PURCHASE_MANAGER_APPROVAL_FIELDS.receiptMessageId]: input.messageId,
  };
}

export function buildPurchaseReceiptCardDeliveryStartedFields(input: {
  batchId: string;
  deliveryUuid: string;
  deliveryAttempts: number;
  deliveryLastAttemptAt: Date;
}): Record<string, unknown> {
  return {
    ...buildPurchaseReceiptCardRoutingFields(input),
    [PURCHASE_MANAGER_APPROVAL_FIELDS.receiptDeliveryState]: '投递中',
  };
}

export function buildPurchaseReceiptCardDeliveryErrorFields(input: {
  batchId: string;
  deliveryUuid: string;
  deliveryAttempts: number;
  deliveryLastAttemptAt: Date | null;
  errorMessage: string;
}): Record<string, unknown> {
  return {
    ...buildPurchaseReceiptCardRoutingFields(input),
    [PURCHASE_MANAGER_APPROVAL_FIELDS.receiptDeliveryState]: '投递异常',
    [PURCHASE_MANAGER_APPROVAL_FIELDS.receiptDeliveryError]:
      input.errorMessage.slice(0, 500),
  };
}

export function buildPurchaseReceiptCardDeliveryManualReviewFields(input: {
  batchId: string;
  deliveryUuid: string;
  deliveryAttempts: number;
  deliveryLastAttemptAt: Date | null;
  errorMessage: string;
}): Record<string, unknown> {
  return {
    ...buildPurchaseReceiptCardDeliveryErrorFields(input),
    [PURCHASE_MANAGER_APPROVAL_FIELDS.receiptDeliveryState]: '送达待核对',
  };
}

function text(name: string): PurchaseManagerApprovalFieldDefinition {
  return { name, type: 1, payload: { field_name: name, type: 1 } };
}

function number(name: string): PurchaseManagerApprovalFieldDefinition {
  return { name, type: 2, payload: { field_name: name, type: 2 } };
}

function datetime(name: string): PurchaseManagerApprovalFieldDefinition {
  return {
    name,
    type: 5,
    payload: {
      field_name: name,
      type: 5,
      property: { date_formatter: 'yyyy-MM-dd HH:mm' },
    },
  };
}

function user(
  name: string,
  multiple: boolean,
): PurchaseManagerApprovalFieldDefinition {
  return {
    name,
    type: 11,
    multiple,
    payload: {
      field_name: name,
      type: 11,
      property: { multiple },
    },
  };
}

function select(
  name: string,
  options: string[],
): PurchaseManagerApprovalFieldDefinition {
  return {
    name,
    type: 3,
    payload: {
      field_name: name,
      type: 3,
      property: { options: options.map((option) => ({ name: option })) },
    },
  };
}
