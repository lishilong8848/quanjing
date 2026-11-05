import { createHash } from 'node:crypto';
import type { AccessConfigurationService } from '../../common/access/access-configuration.service';
import { additionalReadonlyCardTargets } from '../../common/feishu-card-copy/targets';
import { normalizePurchaseAuthorityTarget } from './purchase-authority-target';
import type { PurchaseReplicaIdentity } from './purchase-lifecycle-replica';
import type { PurchaseManagerApprovalBatchEntry } from './purchase-workflow.store';

type Access = Pick<AccessConfigurationService, 'snapshot' | 'feishuPrincipal' | 'currentDutyRoutePeople' | 'isCurrentReadonlyCardRecipient'>;
type Environment = Record<string, string | undefined> & Partial<Pick<NodeJS.ProcessEnv, 'FEISHU_CARD_READONLY_COPY_ENABLED' | 'FEISHU_CARD_READONLY_COPY_APP_ID' | 'FEISHU_CARD_READONLY_COPY_OPEN_ID' | 'FEISHU_CARD_READONLY_COPY_NAME' | 'FEISHU_CARD_READONLY_COPY_ADDITIONAL_RECIPIENTS'>>;
const deny = (): never => { throw new Error('采购卡片同步授权状态无法核对'); };
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)]));
  if (value === null || ['string', 'number', 'boolean', 'undefined'].includes(typeof value)) return value;
  return deny();
}
function synchronous<T>(value: T): T {
  if (value instanceof Promise) { void value.catch(() => undefined); return deny(); }
  return value;
}

/** Synchronous local permission fingerprint; this does not prove the remote Bitable is unchanged. */
export function purchaseLifecycleAuthorizationFingerprint(access: Access, identity: PurchaseReplicaIdentity, batch: PurchaseManagerApprovalBatchEntry,
  env: Environment, currentAppId: string): string {
  if (!/^cli_[A-Za-z0-9_-]+$/.test(identity.appId) || !/^ou_[A-Za-z0-9_-]+$/.test(identity.recipientOpenId) ||
    currentAppId !== identity.appId || batch.flowVersion !== 'lifecycle_v1' || batch.lifecycleAppId !== identity.appId || batch.approvalBatchId !== identity.batchId ||
    !Array.isArray(batch.recordIds) || !batch.recordIds.length || batch.recordIds.length > 20 || new Set(batch.recordIds).size !== batch.recordIds.length ||
    !Array.isArray(batch.items) || batch.items.length !== batch.recordIds.length || !Array.isArray(batch.lifecycleAuthorityTargets) ||
    batch.lifecycleAuthorityTargets.length !== batch.recordIds.length) return deny();
  const snapshot = synchronous(access.snapshot());
  if (!snapshot || snapshot.appId !== currentAppId || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0) return deny();
  const principal = synchronous(access.feishuPrincipal(identity.recipientOpenId, identity.appId));
  const primary = { name: env.FEISHU_CARD_READONLY_COPY_NAME?.trim() || '', openId: env.FEISHU_CARD_READONLY_COPY_OPEN_ID?.trim() || '' };
  const observers = env.FEISHU_CARD_READONLY_COPY_ENABLED === 'true' && env.FEISHU_CARD_READONLY_COPY_APP_ID?.trim() === currentAppId
    ? [primary, ...additionalReadonlyCardTargets(env.FEISHU_CARD_READONLY_COPY_ADDITIONAL_RECIPIENTS)] : [];
  const matches = observers.filter(row => row.openId === identity.recipientOpenId);
  if (matches.length > 1 || matches.some(row => !['李世龙', '刘小杏'].includes(row.name) || observers.filter(other => other.name === row.name).length !== 1)) return deny();
  const observer = matches[0]?.name || '';
  const identityHash = createHash('sha256').update(`${identity.appId}\0${identity.recipientOpenId}`).digest('hex');
  if (observer && synchronous(access.isCurrentReadonlyCardRecipient({ appId: identity.appId, identityHash, name: observer })) !== true) return deny();
  if ((!principal || principal.requiresPasswordChange) && !observer) return deny();
  const seen = new Set<string>();
  const records = batch.items.map(item => {
    if (!batch.recordIds.includes(item.executionRecordId) || seen.has(item.executionRecordId)) return deny();
    seen.add(item.executionRecordId);
    const sourceTargets = (batch.lifecycleAuthorityTargets || []).filter(row => row.recordId === item.executionRecordId);
    if (sourceTargets.length !== 1) return deny();
    const target = normalizePurchaseAuthorityTarget(sourceTargets[0]!.target);
    const currentTarget = normalizePurchaseAuthorityTarget(item.authorityTarget || sourceTargets[0]!.target);
    if (!target || !currentTarget || JSON.stringify(target) !== JSON.stringify(currentTarget)) return deny();
    const duties = (['purchase_manager', 'purchase_executor', 'building_executor', 'warehouse_approver'] as const).map(kind => {
      const list = synchronous(access.currentDutyRoutePeople(kind, target));
      if (list === null) return { kind, members: null };
      if (!Array.isArray(list)) return deny();
      return { kind, members: list.map(row => JSON.stringify(stable(row))).sort() };
    });
    return { id: item.executionRecordId, target, status: item.status, choice: item.choice, purchaserOpenId: item.purchaserOpenId, duties };
  }).sort((a, b) => a.id.localeCompare(b.id));
  const managers = (batch.managerDeliveries || []).map(row => row.recipientOpenId).sort();
  const after = synchronous(access.snapshot());
  const principalAfter = synchronous(access.feishuPrincipal(identity.recipientOpenId, identity.appId));
  if (!after || after.appId !== snapshot.appId || after.revision !== snapshot.revision ||
    JSON.stringify(stable(principalAfter)) !== JSON.stringify(stable(principal)) ||
    (observer && synchronous(access.isCurrentReadonlyCardRecipient({ appId: identity.appId, identityHash, name: observer })) !== true)) return deny();
  const payload = { identity, revision: snapshot.revision, principal, observer, batch: { state: batch.state, requesterOpenId: batch.requesterOpenId, managers, records } };
  return createHash('sha256').update(JSON.stringify(stable(payload))).digest('hex');
}
