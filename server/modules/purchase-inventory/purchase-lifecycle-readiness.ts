import { readEnv } from '../../common/config/external-services.config';
import type { AccessConfigurationService } from '../../common/access/access-configuration.service';
import { currentHotfixActivation } from '../../common/hotfix-runtime-activation';
import runtimeCapabilities from '../../common/purchase-runtime-capabilities.json';
import { PURCHASE_LEDGER_CAPABILITY } from './purchase-ledger-capability';

/** Every check must inspect the currently wired dependency and its safety guards, without side effects. */
export const PURCHASE_LIFECYCLE_REQUIRED_CHECKS = [
  'authorizationConfiguration',
  'newApplicationRegistration',
  'recipientAuthorizationAndProjection',
  'durableDeliveryAndIdempotency',
  'cardRenderingAndAttachments',
  'callbackRoutingAndCurrentAuthority',
  'formCredentialAndAtomicClaims',
  'approvalOrderReceiptAndInbound',
  'readOnlyObservers',
  'existingOrderIsolation',
  'expiredCardContinuation',
  'rollbackProtection',
] as const;

export type PurchaseLifecycleReadinessCheck = typeof PURCHASE_LIFECYCLE_REQUIRED_CHECKS[number];
export type PurchaseLifecycleReadinessChecks = Record<PurchaseLifecycleReadinessCheck, () => boolean | Promise<boolean>>;

/** No worker is constructed or started; the caller must explicitly wire the returned verifier. */
export function createPurchaseLifecycleReadiness(
  access: Pick<AccessConfigurationService, 'snapshot'>,
  checks: PurchaseLifecycleReadinessChecks,
  effectiveAppId: () => string = () => readEnv('FEISHU_APP_ID'),
): { verify(): Promise<boolean> } {
  return {
    async verify(): Promise<boolean> {
      try {
        if (!access || typeof access.snapshot !== 'function' || !checks || typeof checks !== 'object' || typeof effectiveAppId !== 'function') return false;
        const appId = effectiveAppId();
        const snapshot = access.snapshot();
        if (typeof appId !== 'string' || !/^cli_[A-Za-z0-9_-]{1,124}$/u.test(appId) ||
            !snapshot || typeof snapshot.appId !== 'string' || snapshot.appId !== appId ||
            !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0 ||
            (snapshot.schemaVersion !== 1 && snapshot.schemaVersion !== 2)) return false;
        for (const name of PURCHASE_LIFECYCLE_REQUIRED_CHECKS) {
          if (!Object.hasOwn(checks, name) || typeof checks[name] !== 'function') return false;
        }
        const probes = [checks.authorizationConfiguration, checks.newApplicationRegistration,
          checks.recipientAuthorizationAndProjection, checks.durableDeliveryAndIdempotency,
          checks.cardRenderingAndAttachments, checks.callbackRoutingAndCurrentAuthority,
          checks.formCredentialAndAtomicClaims, checks.approvalOrderReceiptAndInbound,
          checks.readOnlyObservers, checks.existingOrderIsolation, checks.expiredCardContinuation, checks.rollbackProtection];
        for (const probe of probes) if (await probe.call(checks) !== true) return false;
        // The app identity and configuration can change while async checks run.
        const finalSnapshot = access.snapshot();
        if (effectiveAppId() !== appId || finalSnapshot.appId !== appId || finalSnapshot.revision !== snapshot.revision || finalSnapshot.schemaVersion !== snapshot.schemaVersion) return false;
        // Issued only after the controlled launcher/installer has checked the
        // actual ledger and candidate. The environment proof is server-side;
        // ordinary feature flags and caller-supplied check results do not suffice.
        return process.env.PURCHASE_LEDGER_RUNTIME_CAPABILITY === PURCHASE_LEDGER_CAPABILITY &&
          runtimeCapabilities.schemaVersion === 1 && runtimeCapabilities.capabilities.includes(PURCHASE_LEDGER_CAPABILITY) &&
          currentHotfixActivation().isAcceptingNewWork();
      } catch {
        return false;
      }
    },
  };
}
