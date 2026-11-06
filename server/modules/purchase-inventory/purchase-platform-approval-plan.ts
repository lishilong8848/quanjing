import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { PurchaseWorkflowRecord } from '../../../shared/purchase-workflow.interface';
import type { PurchasePlatformIdentityProof } from './purchase-platform-identity-proof';
import { purchaseAuthorityTarget } from './purchase-authority-target';
import { isBuildingSelfPurchaseAllowed } from './purchase-procurement-method-policy';
import { resolvePurchaseStage } from './purchase-workflow.rules';
import { normalizeAccessDisplayName } from '../../common/access/access-display-name';

type Decision = 'comprehensive' | 'building_self' | 'reject';
export interface PlatformApprovalRequest { requestId: string; recordId: string; choice: Decision; rejectionReason: string }
export interface PlatformApprovalBatchSnapshot {
  approvalBatchId: string; flowVersion?: 'legacy' | 'lifecycle_v1'; state: string; revision: number;
  items: readonly { executionRecordId: string; status: string; authorityTarget?: { building: string; specialty?: string } }[];
}
/** An adapter must project ALL card and platform actions, including active actions. */
export interface PlatformApprovalExistingAction {
  eventId: string; approvalBatchId: string; status: string; source: 'platform' | 'card';
  fingerprint?: string; recordIds: readonly string[];
}
export interface PlatformApprovalNewAction extends PlatformApprovalExistingAction {
  source: 'platform'; status: 'pending'; fingerprint: string;
  choice: Decision; rejectionReason: string;
  actorAccountId: string; actorAuthorizationVersion: number;
  subjectAccountId: string; subjectAuthorizationVersion: number;
  actorDisplayName: string; subjectDisplayName: string;
  identitySource: 'platform' | 'impersonation';
  authorityTarget: { building: string; specialty?: string };
  actorFeishuOpenId?: string; sessionFamilyFingerprint: string; sessionExpiresAt: number;
}
/** Added only by the durable store using a CSPRNG at first acceptance, never by
 * the client or this pure planner. Replays must preserve the same value. */
export type PlatformApprovalPersistedAction = PlatformApprovalNewAction & Readonly<{ serverActionId: string; acceptedAtMs: number }>;
export type PlatformApprovalPlan =
  | { kind: 'claim'; expectedRevision: number; batchId: string; recordId: string; action: PlatformApprovalNewAction }
  | { kind: 'replay'; action: PlatformApprovalExistingAction };

/**
 * Pure planning helper, NOT a lock, route, or authorization mechanism. The real
 * adapter must call it within the SAME durable ledger lock as card claims, then
 * atomically append the action and change only recordId to processing. The
 * synchronous authorize callback must check an unforgeable current session
 * proof and action/scope inside that lock. Remote reads/writes happen outside it.
 * Legacy and lifecycle workers must be extended to understand platform actions;
 * neither fake card message IDs nor fall back to direct Base updates.
 */
export function planPlatformApproval(input: {
  batch: PlatformApprovalBatchSnapshot; actions: readonly PlatformApprovalExistingAction[];
  record: Pick<PurchaseWorkflowRecord, 'recordId' | 'status' | 'building' | 'specialty'>;
  request: PlatformApprovalRequest; identity: PurchasePlatformIdentityProof;
  lifecycleReady: boolean;
}, authorize: (identity: PurchasePlatformIdentityProof, record: Pick<PurchaseWorkflowRecord, 'recordId' | 'status' | 'building' | 'specialty'>, mode: 'new' | 'replay') => unknown): PlatformApprovalPlan {
  const { batch, actions, record, request, identity } = input || {};
  if (!batch || !record || !request || !identity || !Array.isArray(actions) || typeof authorize !== 'function' ||
      Object.keys(request).sort().join(',') !== 'choice,recordId,rejectionReason,requestId' ||
      !/^[A-Za-z0-9_-]{16,64}$/.test(request.requestId) || !/^rec[A-Za-z0-9_-]+$/.test(request.recordId) ||
      !['comprehensive', 'building_self', 'reject'].includes(request.choice) || typeof request.rejectionReason !== 'string' ||
      (request.choice === 'reject' ? Array.from(request.rejectionReason.trim()).length > 500 : request.rejectionReason !== '') ||
      !/^[A-Za-z0-9_-]{8,160}$/.test(batch.approvalBatchId) || !Number.isSafeInteger(batch.revision) || batch.revision < 1 ||
      !Array.isArray(batch.items) || batch.items.length === 0 || record.recordId !== request.recordId ||
      !['platform', 'impersonation'].includes(identity.source) || !/^[A-Za-z0-9_-]{1,160}$/.test(identity.actorAccountId) || !/^[A-Za-z0-9_-]{1,160}$/.test(identity.subjectAccountId) ||
      !identity.actorDisplayName || normalizeAccessDisplayName(identity.actorDisplayName) !== identity.actorDisplayName || !identity.subjectDisplayName || normalizeAccessDisplayName(identity.subjectDisplayName) !== identity.subjectDisplayName ||
      (identity.source === 'platform' && (identity.actorAccountId !== identity.subjectAccountId || identity.actorAuthorizationVersion !== identity.subjectAuthorizationVersion || identity.actorDisplayName !== identity.subjectDisplayName)) ||
      !Number.isSafeInteger(identity.actorAuthorizationVersion) || identity.actorAuthorizationVersion < 1 || !Number.isSafeInteger(identity.subjectAuthorizationVersion) || identity.subjectAuthorizationVersion < 1 ||
      !Number.isSafeInteger(identity.expiresAt) || identity.expiresAt < 1 || (identity.actorFeishuOpenId !== undefined && !/^ou_[A-Za-z0-9_-]+$/.test(identity.actorFeishuOpenId)) ||
      !/^[A-Za-z0-9_-]{43}$/.test(identity.sessionFamilyFingerprint)) throw new BadRequestException('平台采购审批请求无效');
  if (batch.flowVersion && !['legacy', 'lifecycle_v1'].includes(batch.flowVersion) || batch.flowVersion === 'lifecycle_v1' && input.lifecycleReady !== true) throw new ConflictException('采购流程版本尚未准备好');
  const target = purchaseAuthorityTarget(record);
  if (!target) throw new ConflictException('采购审批记录范围不明确');
  const items = batch.items.filter(item => item.executionRecordId === record.recordId);
  if (items.length !== 1 || new Set(batch.items.map(item => item.executionRecordId)).size !== batch.items.length) throw new ConflictException('采购审批明细归属不唯一');
  const item = items[0]!;
  if (item.authorityTarget && (item.authorityTarget.building !== target.building || item.authorityTarget.specialty !== target.specialty)) throw new ConflictException('采购审批明细范围已变化');
  if (request.choice === 'building_self' && !isBuildingSelfPurchaseAllowed(target.building)) throw new ForbiddenException('当前楼栋不能选择楼内自采');
  const eventId = `platform_${request.requestId}`;
  const reason = request.rejectionReason.trim();
  const fingerprint = createHash('sha256').update(JSON.stringify(['purchase-platform-approval-v1', batch.approvalBatchId, record.recordId, request.choice, reason,
    target.building, target.specialty || '', identity.source, identity.actorAccountId, identity.actorAuthorizationVersion, identity.subjectAccountId, identity.subjectAuthorizationVersion])).digest('hex');
  const matches = actions.filter(action => action.eventId === eventId);
  if (matches.length > 1) throw new ConflictException('采购审批请求记录不唯一');
  // Replay still requires a current session and scope authorization, but not a
  // pending stage: the original operation may have already advanced the record.
  const authorized = authorize(identity, record, matches.length ? 'replay' : 'new');
  if (authorized !== true) { if (authorized instanceof Promise) void authorized.catch(() => undefined); throw new ForbiddenException('采购审批身份或权限不可用'); }
  if (matches.length === 1) {
    const existing = matches[0]!;
    if (existing.source !== 'platform' || existing.fingerprint !== fingerprint || existing.approvalBatchId !== batch.approvalBatchId || existing.recordIds.length !== 1 || existing.recordIds[0] !== record.recordId) throw new ConflictException('采购审批请求编号已用于其他操作');
    return { kind: 'replay', action: structuredClone(existing) };
  }
  if (resolvePurchaseStage(record.status) !== 'application' || batch.state !== 'active' || item.status !== 'pending') throw new ConflictException('该采购申请当前不能审批');
  if (actions.some(action => action.approvalBatchId === batch.approvalBatchId && ['pending', 'processing', 'running'].includes(action.status))) throw new ConflictException('采购审批正在处理，请稍后查看原任务');
  return { kind: 'claim', batchId: batch.approvalBatchId, expectedRevision: batch.revision, recordId: record.recordId,
    action: { source: 'platform', eventId, approvalBatchId: batch.approvalBatchId, status: 'pending', fingerprint, recordIds: [record.recordId], choice: request.choice, rejectionReason: reason,
      actorAccountId: identity.actorAccountId, actorAuthorizationVersion: identity.actorAuthorizationVersion,
      subjectAccountId: identity.subjectAccountId, subjectAuthorizationVersion: identity.subjectAuthorizationVersion,
      actorDisplayName: identity.actorDisplayName, subjectDisplayName: identity.subjectDisplayName,
      identitySource: identity.source, authorityTarget: target,
      sessionFamilyFingerprint: identity.sessionFamilyFingerprint, sessionExpiresAt: identity.expiresAt,
      ...(identity.actorFeishuOpenId ? { actorFeishuOpenId: identity.actorFeishuOpenId } : {}) } };
}
