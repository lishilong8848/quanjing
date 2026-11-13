import type { AccessSessionResponse } from '@shared/access-control.interface';
import type {
  InventoryItemsResponse,
  InventoryManagementDashboard,
  InventoryMovementsResponse,
  PurchasePendingInboundResponse,
} from '@shared/inventory-management.interface';
import type { StocktakeOverview } from '@shared/inventory-stocktake.interface';

const RETAIN_MS = 5 * 60_000;
const FRESH_MS = 15_000;
const MAX_ENTRIES = 32;

export function inventoryReadScope(session: AccessSessionResponse): string | null {
  if (!session.principalFingerprint || session.requiresPasswordChange ||
      (session.expiresAt !== null && session.expiresAt <= Date.now())) return null;
  return JSON.stringify([
    session.principalFingerprint, session.authorizationVersion, session.pagePermissionsRevision,
    session.role, session.purchaseBuilding, session.buildings, session.specialties,
    session.effectiveAuthorization, session.personalRules, session.impersonation?.actorAccountId,
  ]);
}

export function isInventoryReadDenied(error: unknown): boolean {
  const status = (error as { response?: { status?: number } } | null)?.response?.status;
  return status === 401 || status === 403;
}

interface ReadEntry<T> {
  value?: T;
  savedAt: number;
  pending?: { forced: boolean; request: Promise<T> };
}

export function createInventoryReadCache<T>(isCacheable: (value: T) => boolean = () => true) {
  const entries = new Map<string, ReadEntry<T>>();

  function read(key: string | null, load: () => Promise<T>, bypass = false, forced = false) {
    if (!key) return load();
    const existing = entries.get(key);
    if (existing?.pending && (!forced || existing.pending.forced)) return existing.pending.request;
    if (!bypass && existing?.value !== undefined && Date.now() - existing.savedAt < FRESH_MS) {
      return Promise.resolve(existing.value);
    }
    const entry: ReadEntry<T> = { value: existing?.value, savedAt: existing?.savedAt ?? 0 };
    const preceding = existing?.pending?.request;
    const queued = preceding
      ? preceding.then(() => undefined, () => undefined).then(() => {
          if (entries.get(key) !== entry) throw new Error('Inventory read superseded');
          return load();
        })
      : Promise.resolve().then(load);
    const request = queued.then(
      (value) => {
        if (entries.get(key) === entry) {
          if (isCacheable(value)) {
            entry.value = value;
            entry.savedAt = Date.now();
            entry.pending = undefined;
          } else if (entry.value !== undefined) {
            entry.pending = undefined;
          } else {
            entries.delete(key);
          }
        }
        return value;
      },
      (error: unknown) => {
        if (entries.get(key) === entry) {
          if (isInventoryReadDenied(error) || entry.value === undefined) entries.delete(key);
          else entry.pending = undefined;
        }
        throw error;
      },
    );
    entry.pending = { forced, request };
    entries.delete(key);
    entries.set(key, entry);
    if (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value!);
    return request;
  }

  return {
    read,
    peek(key: string | null) {
      const entry = key ? entries.get(key) : undefined;
      return entry && Date.now() - entry.savedAt < RETAIN_MS ? entry.value : undefined;
    },
    invalidate(key?: string) {
      if (key) entries.delete(key);
      else entries.clear();
    },
  };
}

export const inventoryDashboardReads = createInventoryReadCache<InventoryManagementDashboard>(
  (dashboard) => Object.values(dashboard.sectionStatus).every((section) => !section.configured || !section.message),
);
export const inventoryItemReads = createInventoryReadCache<InventoryItemsResponse>();
export const inventoryMovementReads = createInventoryReadCache<InventoryMovementsResponse>();
export const pendingPurchaseReads = createInventoryReadCache<PurchasePendingInboundResponse>();
export const inventoryProgressReads = createInventoryReadCache<StocktakeOverview>();

export function invalidateInventoryMovementReads() {
  inventoryDashboardReads.invalidate();
  inventoryItemReads.invalidate();
  inventoryMovementReads.invalidate();
  pendingPurchaseReads.invalidate();
}
