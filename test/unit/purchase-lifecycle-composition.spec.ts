import { PurchaseLifecycleComposition } from '../../server/modules/purchase-inventory/purchase-lifecycle-composition';
import { PURCHASE_LEDGER_CAPABILITY } from '../../server/modules/purchase-inventory/purchase-ledger-capability';
let mockActive = true;
jest.mock('../../server/common/hotfix-runtime-activation', () => ({ currentHotfixActivation: () => ({ isAcceptingNewWork: () => mockActive }), runHotfixInitialization: (_owner: unknown, work: () => unknown) => work(), cancelHotfixInitialization: async () => {} }));
jest.mock('../../server/common/config/external-services.config', () => ({ ...jest.requireActual('../../server/common/config/external-services.config'), readEnv: (key: string, aliases: string[] = []) => [key, ...aliases].map(name => process.env[name] || '').find(Boolean) || '' }));

describe('production lifecycle owner composition', () => {
  let saved: NodeJS.ProcessEnv, owner: PurchaseLifecycleComposition;
  let store: any, images: any, prepare: any, transport: any;
  function build() {
    store = { hasExistingLifecycleWork: jest.fn(async () => false), verifyLifecycleReceiptImageSource: jest.fn(async () => {}), registerManagerApprovalBatch() {}, claimPlatformLegacyApproval() {}, recoverExpiredPreparedLifecycleDelivery() {},
      listExpiredPreparedLifecycleDeliveries: jest.fn(async () => []), listExpiredLifecycleContinuations: jest.fn(async () => []), listPendingLifecycleDeliveries: jest.fn(async () => []) };
    images = { start: jest.fn(async () => {}), isReady: () => true };
    prepare = { startRecovery: jest.fn(), stopRecovery: jest.fn() };
    transport = { isReady: jest.fn(() => true) };
    owner = new PurchaseLifecycleComposition(store, { sendLifecycleCard() {}, updateLifecycleCard() {} } as never,
      { snapshot: () => ({ appId: 'cli_owner', revision: 1, schemaVersion: 2 }) } as never, { isEnabled: () => true } as never,
      transport, images, prepare, { store } as never, { ensureConnected: async () => {} } as never);
  }
  beforeEach(() => {
    saved = { ...process.env }; mockActive = true; jest.useFakeTimers();
    Object.assign(process.env, { FEISHU_APP_ID: 'cli_owner', FEISHU_APP_SECRET: 'synthetic-owner-only-secret', FEISHU_PURCHASE_INVENTORY_APP_TOKEN: 'synthetic_base', FEISHU_PURCHASE_EXECUTION_TABLE_ID: 'tbl_synthetic', PUBLIC_BASE_URL: 'https://example.test', PURCHASE_LIFECYCLE_CARD_ENABLED: 'true', PURCHASE_LEDGER_RUNTIME_CAPABILITY: PURCHASE_LEDGER_CAPABILITY });
    build();
  });
  afterEach(async () => { await owner.onModuleDestroy(); process.env = saved; jest.useRealTimers(); });
  it('does not start or mutate on construction/bootstrap; waits for activation and launcher proof', async () => {
    owner.onApplicationBootstrap(); expect(images.start).not.toHaveBeenCalled();
    mockActive = false; await jest.advanceTimersByTimeAsync(5_000); expect(images.start).not.toHaveBeenCalled();
    mockActive = true; delete process.env.PURCHASE_LEDGER_RUNTIME_CAPABILITY;
    await owner.ensureStarted(); expect(images.start).not.toHaveBeenCalled(); expect(owner.isReady()).toBe(false);
  });
  it('starts once with real factory and worker, closes admission immediately on maintenance or source change', async () => {
    await Promise.all([owner.ensureStarted(), owner.ensureStarted()]);
    expect(images.start).toHaveBeenCalledTimes(1); expect(prepare.startRecovery).toHaveBeenCalledTimes(1); expect(owner.isReady()).toBe(true);
    await jest.advanceTimersByTimeAsync(5_000); expect(store.listPendingLifecycleDeliveries).toHaveBeenCalledTimes(1);
    mockActive = false; expect(owner.isProcessing()).toBe(false); await jest.advanceTimersByTimeAsync(5_000); expect(store.listPendingLifecycleDeliveries).toHaveBeenCalledTimes(1);
    mockActive = true; process.env.FEISHU_PURCHASE_INVENTORY_APP_TOKEN = 'other_base'; expect(owner.isProcessing()).toBe(false);
    await jest.advanceTimersByTimeAsync(5_000); expect(store.listPendingLifecycleDeliveries).toHaveBeenCalledTimes(1);
  });
  it('disabled admission leaves legacy-only installation untouched but drains existing lifecycle work', async () => {
    process.env.PURCHASE_LIFECYCLE_CARD_ENABLED = 'false'; await owner.ensureStarted(); expect(images.start).not.toHaveBeenCalled();
    store.hasExistingLifecycleWork.mockResolvedValue(true); await owner.ensureStarted();
    expect(owner.isReady()).toBe(false); expect(owner.isProcessing()).toBe(true);
  });
  it('does not admit before shared connection is ready or when persisted source fails', async () => {
    transport.isReady.mockReturnValue(false); await owner.ensureStarted(); expect(images.start).not.toHaveBeenCalled();
    transport.isReady.mockReturnValue(true); store.verifyLifecycleReceiptImageSource.mockRejectedValue(new Error('source mismatch'));
    await owner.ensureStarted(); expect(owner.isReady()).toBe(false); expect(prepare.startRecovery).not.toHaveBeenCalled();
  });
});
