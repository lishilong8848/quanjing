import type {
  InventoryMovementDeletionAcceptedResponse,
  InventoryMovementDeletionTaskStatusResponse,
  InventoryMovementItem,
} from '../../shared/inventory-management.interface';
import {
  createInventoryMovementDeletionCoordinator,
  getInventoryMovementDeletionStorageKey,
  type InventoryMovementDeletionCoordinatorEvent,
} from '../../client/src/pages/InventoryManagement/inventory-movement-deletion-coordinator';

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();
  failWrites = false;

  get length(): number {
    return this.values.size;
  }
  clear(): void {
    this.values.clear();
  }
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.values.delete(key);
  }
  setItem(key: string, value: string): void {
    if (this.failWrites) throw new Error('quota exceeded');
    this.values.set(key, value);
  }
}

const PRINCIPAL = 'P'.repeat(43);

function movement(recordId: string): InventoryMovementItem {
  return {
    recordId,
    type: 'outbound',
    sku: `SKU-${recordId}`,
    name: `物品-${recordId}`,
    specification: '标准规格',
    quantity: 2,
    unit: '箱',
    building: 'H楼',
    destinationBuilding: '',
    location: 'H-2F-226',
    reason: '办公使用',
    operator: '库房管理员',
    applicant: '申请人',
    status: '已出库',
    occurredAt: '2026-08-13T01:47:00.000Z',
    expectedReturnAt: null,
    overdue: false,
  };
}

function accepted(taskId: string): InventoryMovementDeletionAcceptedResponse {
  return {
    accepted: true,
    taskId,
    status: 'pending',
    message: '已受理',
  };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function createHarness(
  overrides: {
    storage?: MemoryStorage;
    submit?: jest.Mock<Promise<InventoryMovementDeletionAcceptedResponse>>;
    getStatus?: jest.Mock<Promise<InventoryMovementDeletionTaskStatusResponse>>;
  } = {},
) {
  const storage = overrides.storage ?? new MemoryStorage();
  const submit =
    overrides.submit ??
    jest.fn(async (request) => accepted(`task-${request.recordId}`));
  const getStatus =
    overrides.getStatus ??
    jest.fn(async (taskId) => ({
      success: true as const,
      task: {
        id: taskId,
        status: 'running' as const,
        message: '同步中',
        createdAt: '2026-08-13T02:00:00.000Z',
        updatedAt: '2026-08-13T02:00:01.000Z',
      },
    }));
  const events: InventoryMovementDeletionCoordinatorEvent[] = [];
  const timers: Array<{
    callback: () => void;
    delay: number;
    cleared: boolean;
  }> = [];
  let now = 100;
  const coordinator = createInventoryMovementDeletionCoordinator({
    principalFingerprint: PRINCIPAL,
    storage,
    submitDeletion: submit,
    getTaskStatus: getStatus,
    onEvent: (event) => events.push(event),
    now: () => now,
    setTimer: (callback, delay) => {
      const timer = { callback, delay, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (handle) => {
      (handle as (typeof timers)[number]).cleared = true;
    },
  });
  return {
    coordinator,
    storage,
    submit,
    getStatus,
    events,
    timers,
    setNow(value: number) {
      now = value;
    },
    runNextTimer() {
      const timer = timers.find((candidate) => !candidate.cleared);
      if (!timer) throw new Error('no pending timer');
      timer.cleared = true;
      timer.callback();
    },
  };
}

describe('inventory movement deletion coordinator', () => {
  it('persists before optimistic feedback and never sends when local durability fails', () => {
    const storage = new MemoryStorage();
    storage.failWrites = true;
    const harness = createHarness({ storage });

    expect(
      harness.coordinator.start({
        clientMutationId: 'delete-1',
        movement: movement('record-1'),
        originalIndex: 0,
        requestWatermark: 3,
      }),
    ).toBe(false);
    expect(harness.events).toEqual([]);
    expect(harness.submit).not.toHaveBeenCalled();
  });

  it('allows independent records to start immediately and stores both before network acceptance', async () => {
    const harness = createHarness();

    expect(
      harness.coordinator.start({
        clientMutationId: 'delete-1',
        movement: movement('record-1'),
        originalIndex: 0,
        requestWatermark: 3,
      }),
    ).toBe(true);
    expect(
      harness.coordinator.start({
        clientMutationId: 'delete-2',
        movement: movement('record-2'),
        originalIndex: 1,
        requestWatermark: 3,
      }),
    ).toBe(true);

    expect(harness.events.map((event) => event.type)).toEqual([
      'optimistic',
      'optimistic',
    ]);
    const stored = JSON.parse(
      harness.storage.getItem(
        getInventoryMovementDeletionStorageKey(PRINCIPAL),
      ) || '{}',
    );
    expect(stored.entries).toHaveLength(2);

    await flushPromises();
    expect(harness.submit).toHaveBeenCalledTimes(2);
    expect(
      harness.submit.mock.calls.map(([request]) => request.clientMutationId),
    ).toEqual(['delete-1', 'delete-2']);
  });

  it('emits completed exactly once and ignores stale work after a task reaches terminal success', async () => {
    const getStatus = jest.fn(async () => ({
      success: true as const,
      task: {
        id: 'task-record-1',
        status: 'completed' as const,
        message: '删除完成',
        createdAt: '2026-08-13T02:00:00.000Z',
        updatedAt: '2026-08-13T02:00:02.000Z',
        completedAt: '2026-08-13T02:00:02.000Z',
        result: {
          recordId: 'record-1',
          type: 'outbound' as const,
          purchaseRolledBack: false,
          message: '出库记录已删除',
        },
      },
    }));
    const harness = createHarness({ getStatus });
    harness.coordinator.start({
      clientMutationId: 'delete-1',
      movement: movement('record-1'),
      originalIndex: 0,
      requestWatermark: 3,
    });
    await flushPromises();

    harness.runNextTimer();
    await flushPromises();
    await harness.coordinator.checkNow('delete-1');

    expect(
      harness.events.filter((event) => event.type === 'completed'),
    ).toHaveLength(1);
    expect(harness.coordinator.getJournals()[0]).toMatchObject({
      status: 'completed',
      clientMutationId: 'delete-1',
    });
  });

  it('rolls back only a definitely-not-deleted task and removes its journal', async () => {
    const getStatus = jest.fn(async () => ({
      success: true as const,
      task: {
        id: 'task-record-1',
        status: 'failed' as const,
        message: '无权删除该楼栋记录',
        createdAt: '2026-08-13T02:00:00.000Z',
        updatedAt: '2026-08-13T02:00:02.000Z',
        completedAt: '2026-08-13T02:00:02.000Z',
        definitelyNotDeleted: true as const,
      },
    }));
    const harness = createHarness({ getStatus });
    harness.coordinator.start({
      clientMutationId: 'delete-1',
      movement: movement('record-1'),
      originalIndex: 0,
      requestWatermark: 3,
    });
    await flushPromises();
    harness.runNextTimer();
    await flushPromises();

    expect(harness.events.at(-1)).toMatchObject({
      type: 'failed',
      clientMutationId: 'delete-1',
      definitelyNotDeleted: true,
    });
    expect(harness.coordinator.getJournals()).toEqual([]);
  });

  it('keeps outcome-unknown work and retries only with the original mutation id', async () => {
    const submit = jest
      .fn<Promise<InventoryMovementDeletionAcceptedResponse>, [any]>()
      .mockRejectedValueOnce(new Error('network interrupted'))
      .mockResolvedValueOnce(accepted('task-original'));
    const harness = createHarness({ submit });
    harness.coordinator.start({
      clientMutationId: 'delete-original',
      movement: movement('record-1'),
      originalIndex: 0,
      requestWatermark: 3,
    });
    await flushPromises();

    expect(harness.events.at(-1)).toMatchObject({
      type: 'uncertain',
      clientMutationId: 'delete-original',
    });
    await harness.coordinator.checkNow('delete-original');
    await flushPromises();

    expect(submit).toHaveBeenCalledTimes(2);
    expect(
      submit.mock.calls.every(
        ([request]) => request.clientMutationId === 'delete-original',
      ),
    ).toBe(true);
  });

  it.each([400, 403, 409])(
    'immediately rolls back and clears the journal for a structured HTTP %s pre-acceptance rejection',
    async (status) => {
      const submit = jest.fn().mockRejectedValueOnce(
        Object.assign(new Error(`Request failed with status code ${status}`), {
          response: {
            status,
            data: {
              message: `删除未受理-${status}`,
              definitelyNotWritten: true,
              writeDisposition: 'definitely-not-written',
            },
          },
        }),
      );
      const harness = createHarness({ submit });

      expect(
        harness.coordinator.start({
          clientMutationId: `delete-rejected-${status}`,
          movement: movement(`record-rejected-${status}`),
          originalIndex: 0,
          requestWatermark: 3,
        }),
      ).toBe(true);
      await flushPromises();

      expect(harness.events.at(-1)).toMatchObject({
        type: 'failed',
        clientMutationId: `delete-rejected-${status}`,
        definitelyNotDeleted: true,
        message: `删除未受理-${status}`,
      });
      expect(harness.coordinator.getJournals()).toEqual([]);
      expect(
        JSON.parse(
          harness.storage.getItem(
            getInventoryMovementDeletionStorageKey(PRINCIPAL),
          ) || '{}',
        ).entries,
      ).toEqual([]);
      expect(harness.timers).toEqual([]);
    },
  );

  it('restores persisted tombstones and resumes accepted tasks after reload', async () => {
    const first = createHarness();
    first.coordinator.start({
      clientMutationId: 'delete-1',
      movement: movement('record-1'),
      originalIndex: 0,
      requestWatermark: 3,
    });
    await flushPromises();
    first.coordinator.stop();

    const second = createHarness({ storage: first.storage });
    expect(second.coordinator.resume()).toBe(true);

    expect(second.events[0]).toMatchObject({
      type: 'optimistic',
      restored: true,
      journal: { clientMutationId: 'delete-1', taskId: 'task-record-1' },
    });
    await flushPromises();
    expect(second.getStatus).toHaveBeenCalledWith('task-record-1');
  });
});
