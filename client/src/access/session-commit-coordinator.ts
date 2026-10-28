export function canApplyPagePermissionSnapshot(
  current: { principalFingerprint: string | null; pagePermissionsRevision?: number },
  next: { principalFingerprint: string | null; pagePermissionsRevision?: number },
): boolean {
  return current.principalFingerprint !== next.principalFingerprint ||
    (next.pagePermissionsRevision || 0) >= (current.pagePermissionsRevision || 0);
}

export interface SessionCommitCoordinator {
  captureRefresh(): number;
  beginMutation(): number;
  commitMutation(token: number): number | null;
  canCommit(token: number): boolean;
}

export interface LoginSessionSnapshot {
  role: string;
  purchaseBuilding: string | null;
  buildings?: readonly string[];
  principalFingerprint: string | null;
  accountId?: string;
  authorizationVersion?: number;
  displayName?: string;
  specialties?: readonly string[];
}

export function isConfirmedLoginSession(
  submitted: LoginSessionSnapshot,
  confirmed: LoginSessionSnapshot,
): boolean {
  return (
    (submitted.role !== 'guest' || (typeof submitted.accountId === 'string' && /^(?:local-[A-Za-z0-9_-]{1,153}|feishu-[a-f0-9]{64})$/.test(submitted.accountId) && Number.isSafeInteger(submitted.authorizationVersion) && Number(submitted.authorizationVersion) >= 1 && !!submitted.displayName && submitted.principalFingerprint !== null)) &&
    submitted.accountId === confirmed.accountId && submitted.authorizationVersion === confirmed.authorizationVersion && submitted.displayName === confirmed.displayName && JSON.stringify(submitted.specialties) === JSON.stringify(confirmed.specialties) &&
    confirmed.role === submitted.role &&
    confirmed.purchaseBuilding === submitted.purchaseBuilding && JSON.stringify(confirmed.buildings) === JSON.stringify(submitted.buildings) &&
    confirmed.principalFingerprint === submitted.principalFingerprint
  );
}

export function createSessionCommitCoordinator(): SessionCommitCoordinator {
  let generation = 0;

  return {
    captureRefresh: () => generation,
    beginMutation: () => {
      generation += 1;
      return generation;
    },
    commitMutation: (token) => {
      if (generation !== token) return null;
      generation += 1;
      return generation;
    },
    canCommit: (token) => generation === token,
  };
}
