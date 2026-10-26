import { BadRequestException, ConflictException } from '@nestjs/common';
import type { PurchaseManagerApprovalChoice } from './purchase-manager-approval-card';
import type {
  PurchaseWorkflowRecord,
  PurchaseWorkflowUser,
} from '../../../shared/purchase-workflow.interface';

const DECISION_PRE_STATE = '未开始（待审批）';
const REJECTION_REASON_MAX_LENGTH = 500;

export interface PurchaseManagerApprovalDecision {
  choice: PurchaseManagerApprovalChoice;
  rejectionReason?: string;
  purchaser?: PurchaseWorkflowUser;
}

export type PurchaseManagerApprovalPatch = {
  '1️⃣物品采购方式': '综合采购' | '需求自采' | '驳回';
  采购流程: '审批通过（待下单）' | '驳回申请';
  驳回原因: string;
  采购人?: Array<{ id: string }>;
  库房确认?: true;
};

export function buildPurchaseManagerApprovalPatch(
  record: PurchaseWorkflowRecord,
  decision: PurchaseManagerApprovalDecision,
): PurchaseManagerApprovalPatch {
  const patch = targetPatch(decision);
  if (record.status === DECISION_PRE_STATE) {
    const existingReason = clean(record.rejectionReason);
    if (existingReason && existingReason !== patch.驳回原因) {
      throw new ConflictException('采购申请已有冲突的驳回原因');
    }
    return patch;
  }

  if (isExactTarget(record, patch)) return patch;
  throw new ConflictException('采购申请已离开待审批状态');
}

export function isManagerApprovalTargetApplied(
  record: PurchaseWorkflowRecord,
  decision: PurchaseManagerApprovalDecision,
): boolean {
  return isExactTarget(record, targetPatch(decision));
}

function targetPatch(
  decision: PurchaseManagerApprovalDecision,
): PurchaseManagerApprovalPatch {
  if (decision.choice === 'reject') {
    const rejectionReason = clean(decision.rejectionReason);
    if (
      rejectionReason.length === 0 ||
      [...rejectionReason].length > REJECTION_REASON_MAX_LENGTH
    ) {
      throw new BadRequestException('请填写有效的驳回原因');
    }
    return {
      '1️⃣物品采购方式': '驳回',
      采购流程: '驳回申请',
      驳回原因: rejectionReason,
    };
  }

  if (decision.choice === 'comprehensive') {
    const purchaserOpenId = requirePurchaserOpenId(decision.purchaser);
    return {
      '1️⃣物品采购方式': '综合采购',
      采购人: [{ id: purchaserOpenId }],
      库房确认: true,
      采购流程: '审批通过（待下单）',
      驳回原因: '',
    };
  }

  if (decision.choice === 'building_self') {
    const purchaserOpenId = requirePurchaserOpenId(decision.purchaser);
    return {
      '1️⃣物品采购方式': '需求自采',
      采购人: [{ id: purchaserOpenId }],
      库房确认: true,
      采购流程: '审批通过（待下单）',
      驳回原因: '',
    };
  }

  throw new BadRequestException('采购审批选择无效');
}

function isExactTarget(
  record: PurchaseWorkflowRecord,
  patch: PurchaseManagerApprovalPatch,
): boolean {
  const coreMatches =
    record.purchaseMethod === patch['1️⃣物品采购方式'] &&
    record.status === patch.采购流程 &&
    record.rejectionReason === patch.驳回原因;
  if (!coreMatches) return false;
  if (!patch.采购人) return true;
  return (
    record.warehouseConfirmed === true &&
    record.purchaserOpenId === patch.采购人[0]?.id
  );
}

function requirePurchaserOpenId(
  purchaser: PurchaseWorkflowUser | undefined,
): string {
  const openId = clean(purchaser?.openId);
  if (!/^ou_[A-Za-z0-9_-]{1,128}$/u.test(openId)) {
    throw new BadRequestException('未找到可分配的采购人');
  }
  return openId;
}

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
