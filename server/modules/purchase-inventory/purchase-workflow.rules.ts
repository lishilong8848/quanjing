import { canPerformBusinessAction } from '../../../shared/business-permissions';
import type {
  PurchaseWorkflowAction,
  PurchaseWorkflowApprovalInput,
  PurchaseWorkflowMethod,
  PurchaseWorkflowOrderInput,
  PurchaseWorkflowReceiptInput,
  PurchaseWorkflowRecord,
  PurchaseWorkflowStage,
  PurchaseWorkflowUser,
} from '../../../shared/purchase-workflow.interface';
import {
  mergeReceiptAttachmentTokens,
  receiptMaterialRequirement,
} from './purchase-receipt-material-policy';

export type PurchaseWorkflowFieldPatch = Record<string, unknown>;
/** Supplied by the service from the current approval roster, never from the request. */
export type PurchaseWorkflowDutyActor = PurchaseWorkflowUser & {
  approvalDuty?: boolean;
  approvalDutyKind?: 'purchase_manager' | 'purchase_approver';
};

const MANAGER_POSITIONS = new Set(['设施运维经理', '设施运维副经理']);
const START_POSITIONS = new Set([...MANAGER_POSITIONS, '综合管理']);

export function resolvePurchaseStage(status: string): PurchaseWorkflowStage {
  switch (status) {
    case '未开始（待审批）':
      return 'application';
    case '审批通过（待库房确认）':
      return 'approval';
    case '审批通过（待下单）':
    case '库房确认（待下单）':
      return 'ordering';
    case '下单完成（待签收）':
      return 'receipt';
    case '到货已签收（待入库）':
      return 'inbound';
    case '物品签收（待入库）':
    case '物品签收已入库':
    case '采购完成（已入库）':
      return 'completed';
    case '驳回申请':
    case '已终止':
      return 'terminated';
    default:
      return 'unknown';
  }
}

export function resolveAllowedActions(
  record: PurchaseWorkflowRecord,
  user: PurchaseWorkflowDutyActor,
): PurchaseWorkflowAction[] {
  const stage = resolvePurchaseStage(record.status);
  const actions: PurchaseWorkflowAction[] = [];
  if (stage === 'application' && isApprover(user)) actions.push('approve');
  if (stage === 'approval' && canStart(record, user)) actions.push('start');
  if (stage === 'ordering' && canOrder(record, user)) actions.push('order');
  if (stage === 'receipt' && canReceive(record, user)) actions.push('receive');
  return user.permissionPrincipal ? actions.filter(action => canPerformBusinessAction(user.permissionPrincipal!, { module: 'purchase', action: action === 'start' ? 'create' : action, building: record.building, specialty: record.specialty })) : actions;
}

export function buildApprovalPatch(
  record: PurchaseWorkflowRecord,
  actor: PurchaseWorkflowDutyActor,
  input: PurchaseWorkflowApprovalInput,
): PurchaseWorkflowFieldPatch {
  if (actor.permissionPrincipal && !canPerformBusinessAction(actor.permissionPrincipal, { module: 'purchase', action: 'approve', building: record.building, specialty: record.specialty })) throw new Error('当前操作超出个人授权范围');
  assertStage(record, 'application', '当前状态不能审批');
  if (!isApprover(actor)) throw new Error('无权审批采购申请');

  if (input.decision === 'rejected' || input.purchaseMethod === '驳回') {
    return {
      '1️⃣物品采购方式': '驳回',
      采购流程: '驳回申请',
    };
  }
  const method = normalizeMethod(input.purchaseMethod);
  if (method !== '综合采购' && method !== '需求自采') {
    throw new Error('请选择有效的采购方式');
  }
  return {
    '1️⃣物品采购方式': method,
    采购流程: '审批通过（待下单）',
  };
}

export function buildCardApprovalRoutingPatch(
  record: PurchaseWorkflowRecord,
  decision: PurchaseWorkflowApprovalInput['decision'],
  purchaser?: PurchaseWorkflowUser,
): PurchaseWorkflowFieldPatch {
  assertStage(record, 'application', '当前状态不能审批');
  if (decision === 'rejected') {
    return {
      '1️⃣物品采购方式': '驳回',
      采购流程: '驳回申请',
    };
  }

  const method = normalizeMethod(record.purchaseMethod);
  if (method !== '综合采购' && method !== '需求自采') {
    throw new Error('采购申请未填写有效的采购方式');
  }
  if (!purchaser?.openId) throw new Error('未找到可分配的采购人');
  return {
    '1️⃣物品采购方式': method,
    采购人: [{ id: purchaser.openId }],
    库房确认: true,
    采购流程: '审批通过（待下单）',
  };
}

export function buildStartPatch(
  record: PurchaseWorkflowRecord,
  actor: PurchaseWorkflowUser,
  comprehensivePurchaser: PurchaseWorkflowUser,
  purchaseMethodOverride?: PurchaseWorkflowMethod,
): PurchaseWorkflowFieldPatch {
  if (actor.permissionPrincipal && !canPerformBusinessAction(actor.permissionPrincipal, { module: 'purchase', action: 'create', building: record.building, specialty: record.specialty })) throw new Error('当前操作超出个人授权范围');
  assertStage(record, 'approval', '当前状态不能启动采购');
  const method = normalizeMethod(
    purchaseMethodOverride || record.purchaseMethod,
  );
  if (!canStart(record, actor, method)) {
    throw new Error('无权确认库房并启动采购');
  }
  const purchaserOpenId =
    method === '需求自采'
      ? record.requesterOpenId
      : method === '综合采购'
        ? comprehensivePurchaser.openId
        : '';
  if (!purchaserOpenId) throw new Error('未找到可分配的采购人');

  return {
    采购人: [{ id: purchaserOpenId }],
    库房确认: true,
    采购流程: '审批通过（待下单）',
  };
}

export function buildOrderPatch(
  record: PurchaseWorkflowRecord,
  actor: PurchaseWorkflowUser,
  input: PurchaseWorkflowOrderInput,
): PurchaseWorkflowFieldPatch {
  if (actor.permissionPrincipal && !canPerformBusinessAction(actor.permissionPrincipal, { module: 'purchase', action: 'order', building: record.building, specialty: record.specialty })) throw new Error('当前操作超出个人授权范围');
  assertStage(record, 'ordering', '当前状态不能提交下单结果');
  if (!canOrder(record, actor)) throw new Error('无权提交下单结果');
  if (!Number.isFinite(input.actualQuantity) || input.actualQuantity <= 0) {
    throw new Error('实际采购数量必须大于 0');
  }
  if (!Number.isFinite(input.actualAmount) || input.actualAmount < 0) {
    throw new Error('实际付款金额不能小于 0');
  }

  return {
    实际采购数量: input.actualQuantity,
    实际付款金额: input.actualAmount,
    '付款截屏（显示付款金额）': attachmentValues(input.paymentAttachmentTokens),
    采购备注: clean(input.note),
    采购完成: true,
    采购流程: '下单完成（待签收）',
  };
}

export function buildReceiptPatch(
  record: PurchaseWorkflowRecord,
  actor: PurchaseWorkflowUser,
  input: PurchaseWorkflowReceiptInput,
): PurchaseWorkflowFieldPatch {
  if (actor.permissionPrincipal && !canPerformBusinessAction(actor.permissionPrincipal, { module: 'purchase', action: 'receive', building: record.building, specialty: record.specialty })) throw new Error('当前操作超出个人授权范围');
  assertStage(record, 'receipt', '当前状态不能确认签收');
  if (!canReceive(record, actor)) throw new Error('无权确认到货签收');
  if (!clean(input.signer)) throw new Error('请填写签收人');
  if (!clean(input.signerOpenId)) throw new Error('请选择签收人');
  if (!Number.isFinite(input.receiptTime) || input.receiptTime <= 0) {
    throw new Error('请选择有效的签收时间');
  }
  if (!input.receiptPhotoTokens.length) throw new Error('请上传签收照片');
  if (
    receiptMaterialRequirement(record.purchaseMethod).requiresInvoice &&
    !input.invoiceTokens.length
  ) {
    throw new Error('自采签收必须上传发票');
  }

  return {
    签收人: [{ id: clean(input.signerOpenId) }],
    签收时间: input.receiptTime,
    签收附件: attachmentValues(
      mergeReceiptAttachmentTokens(
        input.receiptPhotoTokens,
        input.invoiceTokens,
      ),
    ),
    采购备注: clean(input.note),
    '到货签收确认（签收内容填写完成后点击）': true,
    采购完成: true,
    采购流程: '到货已签收（待入库）',
  };
}

export function normalizeMethod(
  method: PurchaseWorkflowMethod,
): PurchaseWorkflowMethod {
  return method === '需求自采（楼内）' ? '需求自采' : method;
}

function canStart(
  record: PurchaseWorkflowRecord,
  user: PurchaseWorkflowUser,
  method: PurchaseWorkflowMethod = normalizeMethod(record.purchaseMethod),
): boolean {
  if (isSystemAdmin(user) || hasAnyPosition(user, START_POSITIONS)) return true;
  const sameBuilding = user.buildings.some(
    (building) =>
      normalizeBuilding(building) === normalizeBuilding(record.building),
  );
  if (user.positions.includes('楼栋主管')) {
    return (
      normalizeMethod(record.purchaseMethod) === '需求自采' &&
      method === '需求自采' &&
      sameBuilding
    );
  }
  return (
    user.positions.some((position) => position.includes('主管')) && sameBuilding
  );
}

function canOrder(
  record: PurchaseWorkflowRecord,
  user: PurchaseWorkflowUser,
): boolean {
  if (user.accessRole === 'purchase_applicant')
    return isSameBuildingSelfPurchaseApplicant(record, user);
  return isManager(user) || user.openId === record.purchaserOpenId;
}

function canReceive(
  record: PurchaseWorkflowRecord,
  user: PurchaseWorkflowUser,
): boolean {
  if (user.accessRole === 'purchase_applicant') {
    return isSameBuildingPurchaseApplicant(record, user);
  }
  return (
    isManager(user) ||
    user.openId === record.requesterOpenId ||
    user.openId === record.purchaserOpenId
  );
}

function isSameBuildingSelfPurchaseApplicant(
  record: PurchaseWorkflowRecord,
  user: PurchaseWorkflowUser,
): boolean {
  return (
    normalizeMethod(record.purchaseMethod) === '需求自采' &&
    isSameBuildingPurchaseApplicant(record, user)
  );
}

function isSameBuildingPurchaseApplicant(
  record: PurchaseWorkflowRecord,
  user: PurchaseWorkflowUser,
): boolean {
  return (
    user.accessRole === 'purchase_applicant' &&
    user.buildings.some(
      (building) =>
        normalizeBuilding(building) === normalizeBuilding(record.building),
    )
  );
}

function isManager(user: PurchaseWorkflowDutyActor): boolean {
  return isSystemAdmin(user) || hasAnyPosition(user, MANAGER_POSITIONS);
}

function isApprover(user: PurchaseWorkflowDutyActor): boolean {
  return isSystemAdmin(user) || user.approvalDuty === true;
}

function isSystemAdmin(user: PurchaseWorkflowUser): boolean {
  return user.accessRole === 'admin';
}

function hasAnyPosition(
  user: PurchaseWorkflowUser,
  expected: ReadonlySet<string>,
): boolean {
  return user.positions.some((position) => expected.has(position));
}

function assertStage(
  record: PurchaseWorkflowRecord,
  expected: PurchaseWorkflowStage,
  message: string,
): void {
  if (resolvePurchaseStage(record.status) !== expected)
    throw new Error(message);
}

function attachmentValues(tokens: string[]): Array<{ file_token: string }> {
  return tokens.filter(Boolean).map((fileToken) => ({ file_token: fileToken }));
}

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeBuilding(value: unknown): string {
  return clean(value)
    .normalize('NFKC')
    .replace(/\s+/g, '')
    .replace(/[楼栋]$/, '')
    .toUpperCase();
}
