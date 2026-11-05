import { createPurchaseLifecycleReadiness, PURCHASE_LIFECYCLE_REQUIRED_CHECKS, type PurchaseLifecycleReadinessChecks } from '../../server/modules/purchase-inventory/purchase-lifecycle-readiness';
let mockActive=true;
jest.mock('../../server/common/hotfix-runtime-activation',()=>({currentHotfixActivation:()=>({isAcceptingNewWork:()=>mockActive})}));

function checks(): PurchaseLifecycleReadinessChecks {
  return Object.fromEntries(PURCHASE_LIFECYCLE_REQUIRED_CHECKS.map(key => [key, jest.fn().mockResolvedValue(true)])) as PurchaseLifecycleReadinessChecks;
}
function snapshot(appId = 'cli_test', revision = 1, schemaVersion = 2) {
  return { snapshot: jest.fn(() => ({ appId, revision, schemaVersion })) } as never;
}
const app = () => 'cli_test';

describe('purchase lifecycle readiness', () => {
  let previous:string|undefined;
  beforeEach(()=>{previous=process.env.PURCHASE_LEDGER_RUNTIME_CAPABILITY;delete process.env.PURCHASE_LEDGER_RUNTIME_CAPABILITY;mockActive=true;});
  afterEach(()=>{if(previous===undefined)delete process.env.PURCHASE_LEDGER_RUNTIME_CAPABILITY;else process.env.PURCHASE_LEDGER_RUNTIME_CAPABILITY=previous;});
  it('remains disabled without a proven old-process rollback barrier even when all checks claim success', async () => {
    const state = checks();
    const access = snapshot();
    expect(await createPurchaseLifecycleReadiness(access, state, app).verify()).toBe(false);
    for (const name of PURCHASE_LIFECYCLE_REQUIRED_CHECKS) expect(state[name]).toHaveBeenCalledTimes(1);
    expect((access as { snapshot: jest.Mock }).snapshot).toHaveBeenCalledTimes(2);
  });

  it('fails closed when app IDs are missing, malformed, mismatched or a snapshot throws', async () => {
    for (const invalid of ['', 'wrong', 'cli_other', ' cli_test ']) {
      const state = checks();
      expect(await createPurchaseLifecycleReadiness(snapshot(), state, () => invalid).verify()).toBe(false);
      expect(state.newApplicationRegistration).not.toHaveBeenCalled();
    }
    expect(await createPurchaseLifecycleReadiness(snapshot(''), checks(), app).verify()).toBe(false);
    const broken = { snapshot: () => { throw new Error('corrupt'); } } as never;
    expect(await createPurchaseLifecycleReadiness(broken, checks(), app).verify()).toBe(false);
    expect(await createPurchaseLifecycleReadiness(snapshot(), checks(), () => { throw new Error('invalid profile'); }).verify()).toBe(false);
  });
  it('requires the controlled startup capability and active release in addition to every business check',async()=>{
    process.env.PURCHASE_LEDGER_RUNTIME_CAPABILITY='purchase-workflow-ledger-v1';
    expect(await createPurchaseLifecycleReadiness(snapshot(),checks(),app).verify()).toBe(true);
    mockActive=false;expect(await createPurchaseLifecycleReadiness(snapshot(),checks(),app).verify()).toBe(false);
    mockActive=true;process.env.PURCHASE_LEDGER_RUNTIME_CAPABILITY='future';expect(await createPurchaseLifecycleReadiness(snapshot(),checks(),app).verify()).toBe(false);
  });

  it('rejects every missing, failed, throwing or non-boolean required check', async () => {
    for (const name of PURCHASE_LIFECYCLE_REQUIRED_CHECKS) {
      const absent = checks(); delete (absent as Partial<PurchaseLifecycleReadinessChecks>)[name];
      expect(await createPurchaseLifecycleReadiness(snapshot(), absent, app).verify()).toBe(false);
      const failed = checks(); failed[name] = () => false;
      expect(await createPurchaseLifecycleReadiness(snapshot(), failed, app).verify()).toBe(false);
    }
    const failure = checks(); failure.rollbackProtection = async () => { throw new Error('unavailable'); };
    expect(await createPurchaseLifecycleReadiness(snapshot(), failure, app).verify()).toBe(false);
    const nonBoolean = checks(); nonBoolean.rollbackProtection = (() => 1) as never;
    expect(await createPurchaseLifecycleReadiness(snapshot(), nonBoolean, app).verify()).toBe(false);
  });

  it('rejects stale asynchronous observations and invalid snapshot metadata', async () => {
    const changing = { snapshot: jest.fn().mockReturnValueOnce({ appId: 'cli_test', revision: 1, schemaVersion: 2 }).mockReturnValueOnce({ appId: 'cli_test', revision: 2, schemaVersion: 2 }) } as never;
    expect(await createPurchaseLifecycleReadiness(changing, checks(), app).verify()).toBe(false);
    expect(await createPurchaseLifecycleReadiness(snapshot('cli_test', -1), checks(), app).verify()).toBe(false);
    expect(await createPurchaseLifecycleReadiness(snapshot('cli_test', 1, 999), checks(), app).verify()).toBe(false);
    const changingApp = jest.fn().mockReturnValueOnce('cli_test').mockReturnValueOnce('cli_other');
    expect(await createPurchaseLifecycleReadiness(snapshot(), checks(), changingApp).verify()).toBe(false);
  });
});
