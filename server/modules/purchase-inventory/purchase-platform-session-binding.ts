import { ForbiddenException, Injectable } from '@nestjs/common';
import type { AccessPrincipal } from '../../../shared/access-control.interface';
import type { PurchaseWorkflowRecord } from '../../../shared/purchase-workflow.interface';
import { businessAuthorizationIdentityKey } from '../../../shared/business-permissions';
import { AccessConfigurationService } from '../../common/access/access-configuration.service';
import { readAccessCookie } from '../../common/access/unified-access.guard';
import { UnifiedAccessService } from '../../common/access/unified-access.service';
import { createPurchasePlatformIdentityVerifier, type PurchasePlatformAction, type PurchasePlatformIdentityProof } from './purchase-platform-identity-proof';
import type { PurchaseAuthorityTarget } from './purchase-authority-target';

/** Injection token for the single module-scoped proof binding (registered as an alias). */
export const PURCHASE_PLATFORM_SESSION_BINDING = 'PURCHASE_PLATFORM_SESSION_BINDING';
export interface PurchasePlatformSessionIdentity {
  proof: PurchasePlatformIdentityProof;
  assertCurrent(action: PurchasePlatformAction, record: Pick<PurchaseWorkflowRecord, 'status' | 'building' | 'specialty'>): void;
  assertCurrentPermissionForScope(action: PurchasePlatformAction, scope: PurchaseAuthorityTarget): void;
}
/** Only the guard-populated view of the request is read; no Express request is stored. */
type AuthenticatedRequest = {
  accessPrincipal?: AccessPrincipal;
  accessPrincipalFingerprint?: string;
  headers?: { cookie?: unknown };
};

/** One module-scoped instance owns the verifier and its private proof-to-cookie mapping. */
@Injectable()
export class PurchasePlatformSessionBinding {
  private readonly verifier: ReturnType<typeof createPurchasePlatformIdentityVerifier>;
  constructor(readonly access: UnifiedAccessService, readonly configuration: AccessConfigurationService) {
    this.verifier = createPurchasePlatformIdentityVerifier({
      readSignedSession: (token, at) => access.readSessionIdentity(token, at),
      snapshot: () => configuration.snapshot(),
      currentPrincipal: (id, version) => configuration.currentPrincipal(id, version),
    });
  }

  /** Called only on a request already populated by UnifiedAccessGuard. */
  bind(request: AuthenticatedRequest): PurchasePlatformSessionIdentity | undefined {
    const principal = request.accessPrincipal;
    if (!principal?.accountId) return undefined;
    const rows = this.configuration.snapshot().accounts.filter(account => account.id === principal.accountId);
    if (rows.length !== 1) throw new ForbiddenException('采购会话身份不可用');
    // Existing nonpersonal shared entrances remain on their explicitly configured path.
    if (rows[0]!.kind === 'local' && rows[0]!.loginMethod !== 'personnel-password' && !principal.impersonation) return undefined;
    if (typeof request.headers?.cookie !== 'string') throw new ForbiddenException('采购会话身份不可用');
    const cookie = readAccessCookie(request.headers.cookie, this.access, Date.now());
    if (!cookie.value || cookie.diagnostic || !request.accessPrincipalFingerprint) throw new ForbiddenException('采购会话身份不可用');
    const proof = this.verifier.verify(cookie.value);
    const signed = this.access.readSessionIdentity(cookie.value, Date.now());
    if (proof.subjectAccountId !== principal.accountId || proof.subjectAuthorizationVersion !== principal.authorizationVersion ||
        proof.sessionFamilyFingerprint !== request.accessPrincipalFingerprint ||
        signed.principalFingerprint !== proof.sessionFamilyFingerprint || businessAuthorizationIdentityKey(signed.principal) !== businessAuthorizationIdentityKey(principal) ||
        (proof.source === 'impersonation') !== !!principal.impersonation ||
        (principal.impersonation && proof.actorAccountId !== principal.impersonation.actorAccountId)) throw new ForbiddenException('采购会话身份不可用');
    return Object.freeze({ proof,
      assertCurrent: (action: PurchasePlatformAction, record: Pick<PurchaseWorkflowRecord, 'status' | 'building' | 'specialty'>) => this.verifier.assertCurrent(proof, action, record),
      assertCurrentPermissionForScope: (action: PurchasePlatformAction, scope: PurchaseAuthorityTarget) => this.verifier.assertCurrentPermissionForScope(proof, action, scope),
    });
  }
}
