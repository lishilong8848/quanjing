import { PurchasePrincipalRequestGate } from '../../client/src/pages/PurchaseInventoryManagement/purchase-principal-request-gate';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

describe('PurchasePrincipalRequestGate', () => {
  it('drops a delayed mutation result after the signed-in principal changes', async () => {
    const gate = new PurchasePrincipalRequestGate('purchase_applicant:A楼');
    const request = gate.capture();
    const response = deferred<string>();
    let applied = '';

    const pending = response.promise.then((value) => {
      if (gate.isCurrent(request)) applied = value;
    });

    gate.syncPrincipal('purchase_applicant:B楼');
    response.resolve('A楼旧响应');
    await pending;

    expect(applied).toBe('');
  });

  it('drops a delayed mutation result after the owning dialog unmounts', async () => {
    const gate = new PurchasePrincipalRequestGate('purchase_admin:');
    const request = gate.capture();
    const response = deferred<boolean>();
    let applied = false;

    const pending = response.promise.then((value) => {
      if (gate.isCurrent(request)) applied = value;
    });

    gate.invalidate();
    response.resolve(true);
    await pending;

    expect(applied).toBe(false);
  });
});
