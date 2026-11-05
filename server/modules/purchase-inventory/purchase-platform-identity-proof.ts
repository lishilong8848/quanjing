import { ForbiddenException } from '@nestjs/common';
import type { AccessPrincipal } from '../../../shared/access-control.interface';
import type { ManagedAccount } from '../../../shared/access-configuration.interface';
import { canPerformBusinessAction } from '../../../shared/business-permissions';
import type { PurchaseWorkflowRecord } from '../../../shared/purchase-workflow.interface';
import type { AccessSessionIdentityStatus } from '../../common/access/unified-access.service';
import { normalizeAccessDisplayName } from '../../common/access/access-display-name';
import { normalizePurchaseAuthorityTarget, purchaseAuthorityTarget, type PurchaseAuthorityTarget } from './purchase-authority-target';
import { resolvePurchaseStage } from './purchase-workflow.rules';

/** These ports MUST be the server's real signed-session and configuration services.
 * This helper is isolated and intentionally not registered in production. */
export interface PurchasePlatformIdentityPorts {
  readSignedSession(token: string, now: number): AccessSessionIdentityStatus;
  snapshot(): { appId: string; accounts: ManagedAccount[] };
  currentPrincipal(id: string, version: number): AccessPrincipal | undefined;
}
export type PurchasePlatformIdentityProof = Readonly<{
  source: 'platform' | 'impersonation';
  actorAccountId: string; actorAuthorizationVersion: number;
  subjectAccountId: string; subjectAuthorizationVersion: number;
  actorDisplayName: string; subjectDisplayName: string;
  sessionFamilyFingerprint: string; expiresAt: number;
  /** Only the actual actor's uniquely bound Feishu identity, never the subject's. */
  actorFeishuOpenId?: string;
}>;
export type PurchasePlatformAction = 'approve' | 'start' | 'order' | 'receive';
type TargetRecord = Pick<PurchaseWorkflowRecord, 'status' | 'building' | 'specialty'>;
const deny = (): never => { throw new ForbiddenException('采购会话或权限不可用'); };
const validId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value);
const validVersion = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
const active = (account: ManagedAccount) => account.enabled && !account.deleted && !account.permissionsRevoked && account.personnelActive !== false && !account.reactivationRequired;

/**
 * Keeps the signed session token ONLY in a private in-memory WeakMap. The returned
 * proof contains no token and cannot be asserted by another process, after a
 * restart, or after copying/serializing it. Restart-safe background execution
 * requires a separately implemented durable revocation-aware proof mechanism.
 */
export function createPurchasePlatformIdentityVerifier(ports: PurchasePlatformIdentityPorts, clock = Date.now) {
  const tokens = new WeakMap<PurchasePlatformIdentityProof, string>();
  function capture(token: string): { identity: PurchasePlatformIdentityProof; principal: AccessPrincipal } {
    const now = clock();
    if (!Number.isSafeInteger(now) || now <= 0) return deny();
    const session = ports.readSignedSession(token, now), principal = session?.principal;
    if (!session || !principal || !validId(principal.accountId) || !validVersion(principal.authorizationVersion) || principal.requiresPasswordChange ||
        typeof session.principalFingerprint !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(session.principalFingerprint) ||
        !Number.isSafeInteger(session.expiresAt) || !session.expiresAt || session.expiresAt <= now) return deny();
    const snap = ports.snapshot();
    if (!snap || !/^cli_[A-Za-z0-9_-]+$/.test(snap.appId) || !Array.isArray(snap.accounts)) return deny();
    const findAccount = (id: string) => {
      const rows = snap.accounts.filter(row => row?.id === id);
      if (rows.length !== 1 || !active(rows[0]!)) return deny();
      return rows[0]!;
    };
    const subject = findAccount(principal.accountId);
    if (subject.version !== principal.authorizationVersion || (subject.kind === 'feishu' && subject.appId !== snap.appId) ||
        (subject.kind === 'local' && subject.loginMethod !== 'personnel-password') ||
        (subject.kind === 'local' && subject.loginMethod === 'personnel-password' && (subject.personnelActive !== true || subject.personnelAppId !== snap.appId))) return deny();
    const currentSubject = ports.currentPrincipal(subject.id, subject.version);
    if (!currentSubject || currentSubject.accountId !== subject.id || currentSubject.authorizationVersion !== subject.version || currentSubject.requiresPasswordChange || currentSubject.role !== principal.role) return deny();
    const actorId = principal.impersonation?.actorAccountId ?? subject.id;
    if (!validId(actorId)) return deny();
    const actor = findAccount(actorId);
    const actorDisplayName = normalizeAccessDisplayName(actor.name), subjectDisplayName = normalizeAccessDisplayName(subject.name);
    if (!actorDisplayName || actorDisplayName !== actor.name || !subjectDisplayName || subjectDisplayName !== subject.name) return deny();
    const currentActor = ports.currentPrincipal(actor.id, actor.version);
    if (!validVersion(actor.version) || !currentActor || currentActor.accountId !== actor.id || currentActor.authorizationVersion !== actor.version || currentActor.requiresPasswordChange) return deny();
    if (principal.impersonation && (currentActor.role !== 'admin' || principal.impersonation.expiresAt !== session.expiresAt)) return deny();
    let actorFeishuOpenId: string | undefined;
    if (actor.kind === 'feishu' && actor.appId === snap.appId && /^ou_[A-Za-z0-9_-]+$/.test(actor.openId || '') &&
        snap.accounts.filter(row => row.kind === 'feishu' && row.appId === snap.appId && row.openId === actor.openId && active(row)).length === 1) actorFeishuOpenId = actor.openId;
    const identity: PurchasePlatformIdentityProof = Object.freeze({ source: principal.impersonation ? 'impersonation' : 'platform',
      actorAccountId: actor.id, actorAuthorizationVersion: actor.version, subjectAccountId: subject.id, subjectAuthorizationVersion: subject.version,
      actorDisplayName, subjectDisplayName,
      sessionFamilyFingerprint: session.principalFingerprint, expiresAt: session.expiresAt, ...(actorFeishuOpenId ? { actorFeishuOpenId } : {}) });
    // Re-read the signed session after reading the actor version. Its verification
    // checks the version inside the signed payload, preventing a snapshot race.
    const checkedAt = clock();
    if (!Number.isSafeInteger(checkedAt) || checkedAt < now || checkedAt >= identity.expiresAt) return deny();
    const again = ports.readSignedSession(token, checkedAt);
    if (!again || again.principalFingerprint !== identity.sessionFamilyFingerprint || again.expiresAt !== identity.expiresAt ||
        again.principal?.accountId !== identity.subjectAccountId || again.principal.authorizationVersion !== identity.subjectAuthorizationVersion ||
        (again.principal.impersonation?.actorAccountId ?? identity.subjectAccountId) !== identity.actorAccountId ||
        !!again.principal.impersonation !== (identity.source === 'impersonation')) return deny();
    return { identity, principal: currentSubject };
  }
  function assertCurrent(proof: PurchasePlatformIdentityProof, action: PurchasePlatformAction, record: TargetRecord, requireStage: boolean): void {
    const token = proof && tokens.get(proof);
    if (!token || !['approve', 'start', 'order', 'receive'].includes(action)) return deny();
    const current = capture(token), scope = purchaseAuthorityTarget(record);
    const stage = action === 'approve' ? 'application' : action === 'start' ? 'approval' : action === 'order' ? 'ordering' : 'receipt';
    const permissionAction = action === 'start' ? 'create' : action;
    if (JSON.stringify(current.identity) !== JSON.stringify(proof) || !scope || (requireStage && resolvePurchaseStage(record.status) !== stage) ||
        !canPerformBusinessAction(current.principal, { module: 'purchase', action: permissionAction, ...scope })) return deny();
  }
  return {
    verify(token: string): PurchasePlatformIdentityProof {
      if (typeof token !== 'string' || !token || token.length > 8192) return deny();
      const proof = capture(token).identity; tokens.set(proof, token); return proof;
    },
    /** Synchronous: call while holding the common ledger lock and before the write. */
    assertCurrent(proof: PurchasePlatformIdentityProof, action: PurchasePlatformAction, record: TargetRecord): void { assertCurrent(proof, action, record, true); },
    /** Only for reading/replaying an existing bound operation, never for a new write. */
    assertCurrentPermission(proof: PurchasePlatformIdentityProof, action: PurchasePlatformAction, record: TargetRecord): void { assertCurrent(proof, action, record, false); },
    /** Read-only status checks need an authenticated scope, never a fabricated document stage. */
    assertCurrentPermissionForScope(proof: PurchasePlatformIdentityProof, action: PurchasePlatformAction, target: PurchaseAuthorityTarget): void {
      const token = proof && tokens.get(proof);
      if (!token || !['approve', 'start', 'order', 'receive'].includes(action)) return deny();
      const current = capture(token);
      let scope: PurchaseAuthorityTarget | undefined;
      try { scope = normalizePurchaseAuthorityTarget(target); } catch { return deny(); }
      const permissionAction = action === 'start' ? 'create' : action;
      if (JSON.stringify(current.identity) !== JSON.stringify(proof) || !scope || !canPerformBusinessAction(current.principal, { module:'purchase', action:permissionAction, ...scope })) return deny();
    },
  };
}
