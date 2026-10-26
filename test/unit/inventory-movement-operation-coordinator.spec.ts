import { InventoryMovementOperationCoordinator } from '../../server/modules/inventory-management/inventory-movement-operation-coordinator';

describe('InventoryMovementOperationCoordinator', () => {
  it('serializes operations that share a resource key', async () => {
    const coordinator = new InventoryMovementOperationCoordinator();
    const firstGate = deferred<void>();
    const events: string[] = [];

    const first = coordinator.run(['movement:inbound:rec-1'], async () => {
      events.push('first:start');
      await firstGate.promise;
      events.push('first:end');
    });
    const second = coordinator.run(['movement:inbound:rec-1'], async () => {
      events.push('second:start');
    });
    await flushImmediate();

    expect(events).toEqual(['first:start']);
    firstGate.resolve();
    await Promise.all([first, second]);
    expect(events).toEqual(['first:start', 'first:end', 'second:start']);
  });

  it('allows unrelated resources to run concurrently', async () => {
    const coordinator = new InventoryMovementOperationCoordinator();
    const gate = deferred<void>();
    const events: string[] = [];

    const first = coordinator.run(['movement:inbound:rec-1'], async () => {
      events.push('first:start');
      await gate.promise;
    });
    const second = coordinator.run(['movement:outbound:rec-2'], async () => {
      events.push('second:start');
      await gate.promise;
    });
    await flushImmediate();

    expect(events).toEqual(['first:start', 'second:start']);
    gate.resolve();
    await Promise.all([first, second]);
  });

  it('uses a stable key order for multi-resource operations', async () => {
    const coordinator = new InventoryMovementOperationCoordinator();
    const firstGate = deferred<void>();
    const events: string[] = [];

    const first = coordinator.run(
      ['purchase:exec-1', 'movement:inbound:rec-1'],
      async () => {
        events.push('first:start');
        await firstGate.promise;
        events.push('first:end');
      },
    );
    const second = coordinator.run(
      ['movement:inbound:rec-1', 'purchase:exec-1'],
      async () => {
        events.push('second:start');
      },
    );
    await flushImmediate();

    expect(events).toEqual(['first:start']);
    firstGate.resolve();
    await Promise.all([first, second]);
    expect(events).toEqual(['first:start', 'first:end', 'second:start']);
  });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function flushImmediate(): Promise<void> {
  return new Promise((resolveFlush) => setImmediate(resolveFlush));
}
