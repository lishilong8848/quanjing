import * as purchaseRecordEditLogic from '../../client/src/pages/PurchaseInventoryManagement/purchase-record-edit.logic';

interface SubmissionGate {
  tryStart: () => boolean;
  finish: () => void;
}

describe('purchase record edit submission logic', () => {
  it('allows only one submission until the active request finishes', () => {
    const createSubmissionGate = (
      purchaseRecordEditLogic as unknown as {
        createPurchaseRecordSubmissionGate?: () => SubmissionGate;
      }
    ).createPurchaseRecordSubmissionGate;

    expect(createSubmissionGate).toBeDefined();
    if (!createSubmissionGate) return;

    const gate = createSubmissionGate();
    expect(gate.tryStart()).toBe(true);
    expect(gate.tryStart()).toBe(false);
    gate.finish();
    expect(gate.tryStart()).toBe(true);
  });

  it('normalizes a rejected dashboard refresh to a failed refresh result', async () => {
    const resolveRefresh = (
      purchaseRecordEditLogic as unknown as {
        resolvePurchaseRecordRefresh?: (
          refresh: () => Promise<boolean>,
        ) => Promise<boolean>;
      }
    ).resolvePurchaseRecordRefresh;

    expect(resolveRefresh).toBeDefined();
    if (!resolveRefresh) return;

    await expect(resolveRefresh(async () => true)).resolves.toBe(true);
    await expect(resolveRefresh(async () => false)).resolves.toBe(false);
    await expect(
      resolveRefresh(async () => {
        throw new Error('dashboard refresh failed');
      }),
    ).resolves.toBe(false);
  });
});
