import { BadRequestException, BadGatewayException } from '@nestjs/common';
import type { PurchaseWorkflowRecord, PurchaseWorkflowUser } from '../../../shared/purchase-workflow.interface';
import { normalizeAccessDisplayName } from '../../common/access/access-display-name';
import { purchaseAuthorityTarget } from './purchase-authority-target';
import type { PlatformApprovalWorkerGateway } from './purchase-platform-approval-coordinator';
import { PURCHASE_MANAGER_APPROVAL_FIELDS as F } from './purchase-manager-approval.fields';
import type { PurchaseWorkflowGateway } from './purchase-workflow.gateway';

type Gateway = Pick<PurchaseWorkflowGateway, 'getPlatformApprovalReadbackAsApp' | 'updateManagerApprovalDecisionRecordAsApp' | 'resolvePurchaseAdminAsApp' | 'resolveBuildingSupervisorAsApp'>;
const recordIdPattern = /^rec[A-Za-z0-9_-]{1,100}$/;
const openIdPattern = /^ou_[A-Za-z0-9_-]{1,128}$/;
function id(value: unknown): string {
  if (typeof value !== 'string' || !recordIdPattern.test(value)) throw new BadRequestException('采购审批记录标识无效');
  return value;
}
function purchaser(value: PurchaseWorkflowUser): { openId: string; name: string } {
  if (!value || !openIdPattern.test(value.openId || '') || !value.name || normalizeAccessDisplayName(value.name) !== value.name) throw new BadGatewayException('采购人路由不可核对');
  return { openId: value.openId, name: value.name };
}
function oneUser(value: unknown): boolean {
  return Array.isArray(value) && value.length === 1 && !!value[0] && typeof value[0] === 'object' &&
    Object.keys(value[0]).join(',') === 'id' && typeof value[0].id === 'string' && openIdPattern.test(value[0].id);
}
/** Validate the exact internally generated patch; never infer an actual approver. */
function approvalFields(value: Record<string, unknown>): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new BadRequestException('采购审批写入内容无效');
  const method = value['1️⃣物品采购方式'];
  const approved = method === '综合采购' || method === '需求自采';
  const rejected = method === '驳回';
  const keys = ['1️⃣物品采购方式','采购流程','驳回原因',F.state,F.currentApprover,F.approvalTime,F.actionId,
    ...(approved ? ['采购人','库房确认'] : []), ...(Object.prototype.hasOwnProperty.call(value,F.actualApprover) ? [F.actualApprover] : [])].sort();
  const reason = value.驳回原因;
  if ((!approved && !rejected) || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(keys) ||
      value.采购流程 !== (approved ? '审批通过（待下单）' : '驳回申请') || value[F.state] !== (approved ? '已通过' : '已驳回') ||
      !Array.isArray(value[F.currentApprover]) || (value[F.currentApprover] as unknown[]).length !== 0 ||
      !Number.isSafeInteger(value[F.approvalTime]) || Number(value[F.approvalTime]) <= 0 || typeof value[F.actionId] !== 'string' || !/^pa_[A-Za-z0-9_-]{43}$/.test(value[F.actionId] as string) ||
      typeof reason !== 'string' || (approved ? reason !== '' : reason !== reason.trim() || [...reason].length > 500) ||
      (approved && (value.库房确认 !== true || !oneUser(value.采购人))) ||
      (Object.prototype.hasOwnProperty.call(value,F.actualApprover) && !oneUser(value[F.actualApprover]))) throw new BadRequestException('采购审批写入内容无效');
  return structuredClone(value);
}

/** Uses the same server-side app-token reads, routing and writes as manager cards.
 * The caller must be the fenced coordinator; this adapter performs no retries. */
export function createPlatformApprovalGateway(gateway: Gateway, sourceGuard?: () => Promise<void>): PlatformApprovalWorkerGateway {
  return {
    async readRecord(recordId) {
      const expected = id(recordId);
      await sourceGuard?.();
      const record = await gateway.getPlatformApprovalReadbackAsApp(expected);
      await sourceGuard?.();
      if (!record || record.recordId !== expected) throw new BadGatewayException('采购审批记录回读不一致');
      return record;
    },
    async resolvePurchaser(record, choice) {
      id(record?.recordId);
      const scope = purchaseAuthorityTarget(record);
      if (!scope || (record.specialty?.trim() && !scope.specialty) || !['comprehensive','building_self'].includes(choice)) throw new BadRequestException('采购人路由范围无效');
      await sourceGuard?.();
      const selected = choice === 'comprehensive'
        ? await gateway.resolvePurchaseAdminAsApp({ building: record.building, specialty: record.specialty })
        : await gateway.resolveBuildingSupervisorAsApp(record.building, record.specialty);
      await sourceGuard?.(); return purchaser(selected);
    },
    async writeRecord(recordId, fields) {
      const target = id(recordId), checked = approvalFields(fields);
      await sourceGuard?.();
      if(sourceGuard) await gateway.updateManagerApprovalDecisionRecordAsApp(target, checked, sourceGuard);
      else await gateway.updateManagerApprovalDecisionRecordAsApp(target, checked);
    },
  };
}
