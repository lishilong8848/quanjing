import { isConfirmedLoginSession, type LoginSessionSnapshot } from './session-commit-coordinator';

/** Only actual input is activity. In particular, focus and session polling are not. */
export const SESSION_ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'touchstart', 'wheel'] as const;
export const SESSION_ACTIVITY_INTERVAL_MS = 60_000;
const EXPIRY_MARGIN_MS = 60_000;

export interface ActivitySessionSnapshot {
  fingerprint: string | null;
  expiresAt: number | null;
  enabled: boolean;
}

interface ActivityOptions {
  snapshot: () => ActivitySessionSnapshot;
  visible: () => boolean;
  renew: (fingerprint: string) => Promise<void>;
  now?: () => number;
}

/** The confirmed response may legitimately arrive after the previous deadline. */
export function isConfirmedActivityRenewal(
  submitted: LoginSessionSnapshot,
  confirmed: LoginSessionSnapshot & { expiresAt: number | null; impersonation?: unknown },
  now = Date.now(),
): boolean {
  return isConfirmedLoginSession(submitted, confirmed) && !confirmed.impersonation &&
    typeof confirmed.expiresAt === 'number' && confirmed.expiresAt > now;
}

/** A concurrent permission read can be newer than the renewal response. */
export function mergeActivityRenewalSnapshot<T extends LoginSessionSnapshot & {
  expiresAt: number | null; pagePermissionsRevision?: number;
}>(current: T, confirmed: T): T {
  if (!isConfirmedLoginSession(current, confirmed)) return current;
  const newer = (current.pagePermissionsRevision || 0) > (confirmed.pagePermissionsRevision || 0) ? current : confirmed;
  return { ...newer, expiresAt: Math.max(current.expiresAt || 0, confirmed.expiresAt || 0) };
}

/** One in-flight renewal and one trailing renewal for input during the throttle. */
export function createSessionActivityController(options: ActivityOptions) {
  const now = options.now || Date.now;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pendingFingerprint: string | null = null;
  let inFlight = false;
  let nextAllowedAt = 0;
  let lastAttemptAt = Number.NEGATIVE_INFINITY;

  const usable = () => {
    const snapshot = options.snapshot();
    return snapshot.enabled && snapshot.fingerprint && snapshot.expiresAt !== null && snapshot.expiresAt > now()
      ? snapshot : null;
  };
  const schedule = () => {
    if (stopped || inFlight || !pendingFingerprint) return;
    const snapshot = usable();
    if (!snapshot || snapshot.fingerprint !== pendingFingerprint) {
      pendingFingerprint = null;
      return;
    }
    const normalDue = Math.max(0, nextAllowedAt - now());
    const due = snapshot.expiresAt! - now() <= EXPIRY_MARGIN_MS
      ? Math.min(normalDue, Math.max(0, lastAttemptAt + 5_000 - now())) : normalDue;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => { timer = undefined; void run(); }, due);
  };
  const run = async () => {
    const snapshot = usable();
    if (stopped || inFlight || !snapshot || snapshot.fingerprint !== pendingFingerprint) {
      pendingFingerprint = null;
      return;
    }
    const fingerprint = pendingFingerprint!;
    pendingFingerprint = null;
    inFlight = true;
    // Throttle failures as well; recovery belongs to the next real operation.
    nextAllowedAt = now() + SESSION_ACTIVITY_INTERVAL_MS;
    lastAttemptAt = now();
    try { await options.renew(fingerprint); }
    catch { /* The provider retains the current identity and displays the failure. */ }
    finally { inFlight = false; schedule(); }
  };

  return {
    record(event: Pick<Event, 'isTrusted' | 'type'>) {
      if (stopped || !event.isTrusted || !options.visible() ||
          !(SESSION_ACTIVITY_EVENTS as readonly string[]).includes(event.type)) return;
      const snapshot = usable();
      if (!snapshot) return;
      pendingFingerprint = snapshot.fingerprint;
      schedule();
    },
    dispose() {
      stopped = true;
      pendingFingerprint = null;
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}

/** All cookie-changing actions in this provider share a same-origin browser lock. */
export async function withSessionCookieLock<T>(operation: () => Promise<T>): Promise<T> {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  return locks ? await locks.request('vnet-access-session-cookie', operation) : await operation();
}
