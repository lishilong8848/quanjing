// Business isolation tests run after release activation. Release gating is tested separately.
jest.mock('../../server/common/hotfix-runtime-activation', () => ({
  currentHotfixActivation: () => ({ isAcceptingNewWork: () => true }),
  runHotfixInitialization: (_owner: object, initialize: () => unknown) => initialize(),
  cancelHotfixInitialization: async () => {},
}));
import { PurchaseLifecycleRuntime } from '../../server/modules/purchase-inventory/purchase-lifecycle-runtime';

describe('purchase lifecycle runtime', () => {
  it('does nothing when disabled and rejects missing prerequisites', async () => {
    const run = jest.fn();
    const verify = jest.fn().mockResolvedValue(false);
    const runtime = new PurchaseLifecycleRuntime({ run }, { verify }, jest.fn());
    await runtime.start(false);
    expect(verify).not.toHaveBeenCalled();
    await expect(runtime.start(true)).rejects.toThrow('采购卡片运行条件未就绪');
    expect(runtime.isReady()).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it('serializes worker passes and waits for an in-flight pass to stop', async () => {
    let finish!: () => void;
    const run = jest.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const runtime = new PurchaseLifecycleRuntime({ run }, { verify: async () => true }, jest.fn(), 60_000);
    await runtime.start(true);
    expect(runtime.isReady()).toBe(true);
    const first = runtime.tick();
    await Promise.resolve();
    await runtime.tick();
    expect(run).toHaveBeenCalledTimes(1);
    const stop = runtime.stop();
    expect(runtime.isReady()).toBe(false);
    finish();
    await Promise.all([first, stop]);
    await runtime.tick();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('withdraws readiness on a dependency failure and recovers on a later pass', async () => {
    const verify = jest.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const run = jest.fn().mockResolvedValue(undefined);
    const report = jest.fn();
    const runtime = new PurchaseLifecycleRuntime({ run }, { verify }, report, 60_000);
    await runtime.start(true);
    await runtime.tick();
    expect(runtime.isReady()).toBe(false);
    expect(run).not.toHaveBeenCalled();
    expect(report).toHaveBeenCalledWith('PURCHASE_LIFECYCLE_NOT_READY');
    await runtime.tick();
    expect(runtime.isReady()).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
    await runtime.stop();
  });

  it('does not start after it has been stopped during a slow initial check', async () => {
    let finish!: (value: boolean) => void;
    const verify = jest.fn(() => new Promise<boolean>(resolve => { finish = resolve; }));
    const run = jest.fn();
    const runtime = new PurchaseLifecycleRuntime({ run }, { verify }, jest.fn(), 60_000);
    const start = runtime.start(true);
    await runtime.stop();
    finish(true);
    await start;
    expect(runtime.isReady()).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });
});
