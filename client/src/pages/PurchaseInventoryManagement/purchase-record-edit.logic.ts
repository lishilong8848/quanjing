import type { AccessPrincipal } from '@shared/access-control.interface';
import type {
  PurchaseRecordEditableStatus,
  PurchaseRecordUpdateFields,
} from '@shared/purchase-inventory.interface';

export interface PurchaseRecordEditDraft {
  itemName: string;
  quantity: string;
  unit: string;
  building: string;
  supplier: string;
  expectedArrival: string;
  notes: string;
  applicantQuery: string;
  status: PurchaseRecordEditableStatus;
}

export function createPurchaseRecordSubmissionGate() {
  let inFlight = false;

  return {
    tryStart(): boolean {
      if (inFlight) return false;
      inFlight = true;
      return true;
    },
    finish(): void {
      inFlight = false;
    },
  };
}

export async function resolvePurchaseRecordRefresh(
  refresh: () => Promise<boolean>,
): Promise<boolean> {
  try {
    return await refresh();
  } catch {
    return false;
  }
}

export function buildPurchaseRecordChangedFields(
  principal: AccessPrincipal,
  draft: PurchaseRecordEditDraft,
  initial: PurchaseRecordEditDraft,
  requesterOpenId?: string,
): PurchaseRecordUpdateFields {
  const fields: PurchaseRecordUpdateFields = {};
  if (draft.itemName.trim() !== initial.itemName.trim()) {
    fields.itemName = draft.itemName.trim();
  }
  if (draft.quantity !== initial.quantity) {
    fields.quantity = Number(draft.quantity);
  }
  if (draft.unit.trim() !== initial.unit.trim()) {
    fields.unit = draft.unit.trim();
  }
  if (draft.supplier.trim() !== initial.supplier.trim()) {
    fields.supplier = draft.supplier.trim();
  }
  if (draft.expectedArrival !== initial.expectedArrival) {
    fields.expectedArrival = draft.expectedArrival || null;
  }
  if (draft.notes.trim() !== initial.notes.trim()) {
    fields.notes = draft.notes.trim();
  }

  if (principal.role !== 'purchase_applicant') {
    if (draft.building !== initial.building) fields.building = draft.building;
    if (requesterOpenId) fields.requesterOpenId = requesterOpenId;
  }
  if (principal.role === 'admin' && draft.status !== initial.status) {
    fields.status = draft.status;
  }
  return fields;
}
