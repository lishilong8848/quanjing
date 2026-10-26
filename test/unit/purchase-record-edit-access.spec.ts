import type { AccessPrincipal } from '../../shared/access-control.interface';
import {
  buildPurchaseRecordChangedFields,
  type PurchaseRecordEditDraft,
} from '../../client/src/pages/PurchaseInventoryManagement/purchase-record-edit.logic';

const initial: PurchaseRecordEditDraft = {
  itemName: '原物品',
  quantity: '1',
  unit: '件',
  building: 'A楼',
  supplier: '原供应商',
  expectedArrival: '2026-07-20',
  notes: '',
  applicantQuery: '原申请人',
  status: 'application',
};

const changed: PurchaseRecordEditDraft = {
  itemName: '新物品',
  quantity: '2',
  unit: '箱',
  building: 'B楼',
  supplier: '新供应商',
  expectedArrival: '2026-07-22',
  notes: '已更新',
  applicantQuery: '新申请人',
  status: 'approval',
};

describe('purchase record edit field access', () => {
  it('strips applicant, building, and status changes for a purchase applicant', () => {
    const principal: AccessPrincipal = {
      role: 'purchase_applicant',
      purchaseBuilding: 'A楼',
    };

    expect(
      buildPurchaseRecordChangedFields(
        principal,
        changed,
        initial,
        'new-applicant-open-id',
      ),
    ).toEqual({
      itemName: '新物品',
      quantity: 2,
      unit: '箱',
      supplier: '新供应商',
      expectedArrival: '2026-07-22',
      notes: '已更新',
    });
  });

  it('preserves lifecycle status changes only for an administrator', () => {
    expect(
      buildPurchaseRecordChangedFields(
        { role: 'admin', purchaseBuilding: null },
        changed,
        initial,
        'new-applicant-open-id',
      ),
    ).toEqual(
      expect.objectContaining({
        building: 'B楼',
        requesterOpenId: 'new-applicant-open-id',
        status: 'approval',
      }),
    );
  });

  it.each(['editor', 'purchase_admin', 'supply_chain_admin'] as const)(
    'strips lifecycle status while preserving ordinary full-role edits for %s',
    (role) => {
      const fields = buildPurchaseRecordChangedFields(
        { role, purchaseBuilding: null },
        changed,
        initial,
        'new-applicant-open-id',
      );

      expect(fields).toEqual(
        expect.objectContaining({
          building: 'B楼',
          requesterOpenId: 'new-applicant-open-id',
        }),
      );
      expect(fields).not.toHaveProperty('status');
    },
  );
});
