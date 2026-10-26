import type {
  PurchaseInboundCategoryAcceptedResponse,
  PurchaseInboundCategoryPrepareRequest,
  PurchaseInboundCategoryTaskStatusResponse,
  WarehouseBuilding,
} from '../../shared/inventory-management.interface';
import {
  createPurchaseInboundCategoryTaskCoordinator,
  type PurchaseInboundCategoryTaskCoordinatorEvent,
  type PurchaseInboundCategoryTaskStorage,
} from '../../client/src/pages/InventoryManagement/purchase-inbound-category-task-coordinator';

const REQUEST: PurchaseInboundCategoryPrepareRequest = {
  executionRecordId: 'execution-category-1',
  clientMutationId: 'mutation-category-1',
  building: 'A楼' as WarehouseBuilding,
  quantity: 2,
  occurredAt: '2026-09-15T01:00:00.000Z',
  newItem: {
    primaryCategory: '仪器仪表',
    secondaryCategory: '环境监测',
    name: '温湿度传感器',
    specification: 'TH-100',
    location: 'A楼一层仓库',
    locationRecordId: 'location-1',
    brand: '测试品牌',
    unit: '台',
    minimumQuantity: 1,
  },
};

const ACCEPTED: PurchaseInboundCategoryAcceptedResponse = {
  accepted: true,
  taskId: 'purchase-inbound-category-task-1',
  status: 'pending',
  message: '物品类别号生成已受理',
};

const COMPLETED: PurchaseInboundCategoryTaskStatusResponse = {
  success: true,
  task: {
    id: ACCEPTED.taskId,
    status: 'completed',
    message: '物品类别号已生成',
    createdAt: '2026-09-15T01:00:00.000Z',
    updatedAt: '2026-09-15T01:00:36.000Z',
    completedAt: '2026-09-15T01:00:36.000Z',
    result: {
      catalogRecordId: 'catalog-1',
      sku: 'A2009',
      alreadyPrepared: false,
      preparedAt: '2026-09-15T01:00:35.000Z',
    },
  },
};

function pendingStatus(
  attempt: number,
): PurchaseInboundCategoryTaskStatusResponse {
  return {
    success: true,
    task: {
      id: ACCEPTED.taskId,
      status: 'pending',
      message: `后台生成中 ${attempt}`,
      createdAt: '2026-09-15T01:00:00.000Z',
      updatedAt: '2026-09-15T01:00:00.000Z',
    },
  };
}

function createMemoryStorage(): PurchaseInboundCategoryTaskStorage & {
  values: Map<string, string>;
} {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
  };
}

describe('purchase inbound category task coordinator', () => {
  it('converges when the first 30 polls are pending and the 31st completes', async () => {
    const storage = createMemoryStorage();
    const events: PurchaseInboundCategoryTaskCoordinatorEvent[] = [];
    const scheduledDelays: number[] = [];
    let statusCalls = 0;
    const coordinator = createPurchaseInboundCategoryTaskCoordinator({
      prepareCategory: async () => ACCEPTED,
      getTaskStatus: async () => {
        statusCalls += 1;
        return statusCalls <= 30 ? pendingStatus(statusCalls) : COMPLETED;
      },
      storage,
      setTimer: (_callback, delay) => {
        scheduledDelays.push(delay);
        return scheduledDelays.length;
      },
      clearTimer: () => undefined,
      onEvent: (event) => events.push(event),
    });

    await expect(coordinator.start(REQUEST)).resolves.toBe(true);
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await coordinator.checkNow();
    }

    expect(coordinator.getPhase()).toBe('accepted');
    expect(scheduledDelays.at(-1)).toBeGreaterThan(1_000);

    await coordinator.checkNow();

    expect(coordinator.getPhase()).toBe('completed');
    const completed = events.filter((event) => event.type === 'completed');
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({
      type: 'completed',
      result: { catalogRecordId: 'catalog-1', sku: 'A2009' },
    });
  });

  it('resumes the persisted task on remount and completes on focus without another POST', async () => {
    const storage = createMemoryStorage();
    let prepareCalls = 0;
    const prepareCategory = async () => {
      prepareCalls += 1;
      return ACCEPTED;
    };
    const first = createPurchaseInboundCategoryTaskCoordinator({
      prepareCategory,
      getTaskStatus: async () => pendingStatus(1),
      storage,
      setTimer: () => 1,
      clearTimer: () => undefined,
      onEvent: () => undefined,
    });

    await expect(first.start(REQUEST)).resolves.toBe(true);
    first.stop();

    const remountedEvents: PurchaseInboundCategoryTaskCoordinatorEvent[] = [];
    const remounted = createPurchaseInboundCategoryTaskCoordinator({
      prepareCategory,
      getTaskStatus: async () => COMPLETED,
      storage,
      setTimer: () => 1,
      clearTimer: () => undefined,
      onEvent: (event) => remountedEvents.push(event),
    });

    expect(remounted.resume(REQUEST.executionRecordId)).toBe(true);
    expect(remounted.getPhase()).toBe('accepted');
    await remounted.checkNow();

    expect(prepareCalls).toBe(1);
    expect(remounted.getPhase()).toBe('completed');
    expect(
      remountedEvents.filter((event) => event.type === 'completed'),
    ).toHaveLength(1);
    expect(storage.values.size).toBe(0);
  });

  it('replays the same mutation after an unacknowledged acceptance and remount', async () => {
    const storage = createMemoryStorage();
    const firstRequests: PurchaseInboundCategoryPrepareRequest[] = [];
    const first = createPurchaseInboundCategoryTaskCoordinator({
      prepareCategory: async (request) => {
        firstRequests.push(request);
        return new Promise<PurchaseInboundCategoryAcceptedResponse>(
          () => undefined,
        );
      },
      getTaskStatus: async () => pendingStatus(1),
      storage,
      onEvent: () => undefined,
    });

    void first.start(REQUEST);
    expect(firstRequests).toHaveLength(1);
    expect(storage.values.size).toBe(1);
    first.stop();

    const resumedRequests: PurchaseInboundCategoryPrepareRequest[] = [];
    const events: PurchaseInboundCategoryTaskCoordinatorEvent[] = [];
    const resumed = createPurchaseInboundCategoryTaskCoordinator({
      prepareCategory: async (request) => {
        resumedRequests.push(request);
        return ACCEPTED;
      },
      getTaskStatus: async () => COMPLETED,
      storage,
      setTimer: () => 1,
      clearTimer: () => undefined,
      onEvent: (event) => events.push(event),
    });

    expect(resumed.resume(REQUEST.executionRecordId)).toBe(true);
    await resumed.checkNow();
    await resumed.checkNow();

    expect(resumedRequests).toEqual([REQUEST]);
    expect(events.map((event) => event.phase)).toContain('submitting');
    expect(events.filter((event) => event.type === 'completed')).toHaveLength(
      1,
    );
    expect(storage.values.size).toBe(0);
  });

  it('keeps an uncertain acceptance recoverable and blocks a different mutation', async () => {
    const storage = createMemoryStorage();
    const events: PurchaseInboundCategoryTaskCoordinatorEvent[] = [];
    const prepareCategory = jest
      .fn()
      .mockRejectedValue(new Error('network disconnected'));
    const coordinator = createPurchaseInboundCategoryTaskCoordinator({
      prepareCategory,
      getTaskStatus: async () => pendingStatus(1),
      storage,
      onEvent: (event) => events.push(event),
    });

    await expect(coordinator.start(REQUEST)).resolves.toBe(false);
    expect(storage.values.size).toBe(1);
    expect(coordinator.getPhase()).toBe('uncertain');
    await expect(
      coordinator.start({ ...REQUEST, clientMutationId: 'another-mutation-1' }),
    ).resolves.toBe(false);
    expect(prepareCategory).toHaveBeenCalledTimes(1);
    expect(events.map((event) => event.type)).toContain('uncertain');
  });

  it('does not POST when the recovery journal cannot be persisted', async () => {
    const prepareCategory = jest.fn().mockResolvedValue(ACCEPTED);
    const events: PurchaseInboundCategoryTaskCoordinatorEvent[] = [];
    const coordinator = createPurchaseInboundCategoryTaskCoordinator({
      prepareCategory,
      getTaskStatus: async () => pendingStatus(1),
      storage: {
        getItem: () => null,
        setItem: () => {
          throw new Error('storage quota exceeded');
        },
        removeItem: () => undefined,
      },
      onEvent: (event) => events.push(event),
    });

    await expect(coordinator.start(REQUEST)).resolves.toBe(false);

    expect(prepareCategory).not.toHaveBeenCalled();
    expect(coordinator.getPhase()).toBe('error');
    expect(events.at(-1)).toMatchObject({
      type: 'failed',
      phase: 'error',
      definitelyNotPrepared: true,
      message: expect.stringMatching(/无法安全保存.*未发送.*重试/u),
    });
  });

  it('keeps an accepted task recoverable when persisting its task id fails', async () => {
    const storage = createMemoryStorage();
    const originalSetItem = storage.setItem;
    let writeCount = 0;
    storage.setItem = (key, value) => {
      writeCount += 1;
      if (writeCount === 2) throw new Error('storage became unavailable');
      originalSetItem(key, value);
    };
    const events: PurchaseInboundCategoryTaskCoordinatorEvent[] = [];
    const prepareCategory = jest.fn().mockResolvedValue(ACCEPTED);
    const coordinator = createPurchaseInboundCategoryTaskCoordinator({
      prepareCategory,
      getTaskStatus: async () => pendingStatus(1),
      storage,
      onEvent: (event) => events.push(event),
    });

    await expect(coordinator.start(REQUEST)).resolves.toBe(false);

    expect(prepareCategory).toHaveBeenCalledTimes(1);
    expect(coordinator.getPhase()).toBe('uncertain');
    expect(events.at(-1)).toMatchObject({
      type: 'uncertain',
      phase: 'uncertain',
      journal: {
        taskId: ACCEPTED.taskId,
        request: { clientMutationId: REQUEST.clientMutationId },
      },
      message: expect.stringMatching(/已受理.*无法保存.*原编号.*重试/u),
    });
    expect(
      [...storage.values.values()].map((value) => JSON.parse(value)),
    ).toEqual([
      expect.objectContaining({
        taskId: '',
        request: expect.objectContaining({
          clientMutationId: REQUEST.clientMutationId,
        }),
      }),
    ]);
  });

  it('releases the saved request after a definite validation rejection', async () => {
    const storage = createMemoryStorage();
    const invalid = Object.assign(new Error('invalid category'), {
      response: { status: 400, data: { message: 'invalid category' } },
    });
    const coordinator = createPurchaseInboundCategoryTaskCoordinator({
      prepareCategory: async () => Promise.reject(invalid),
      getTaskStatus: async () => pendingStatus(1),
      storage,
      onEvent: () => undefined,
    });

    await expect(coordinator.start(REQUEST)).resolves.toBe(false);
    expect(storage.values.size).toBe(0);
    expect(coordinator.getPhase()).toBe('error');
  });

  it('queries an accepted task immediately when retrying after an uncertain status response', async () => {
    const getTaskStatus = jest
      .fn()
      .mockRejectedValueOnce(new Error('status unavailable'))
      .mockResolvedValueOnce(COMPLETED);
    const coordinator = createPurchaseInboundCategoryTaskCoordinator({
      prepareCategory: async () => ACCEPTED,
      getTaskStatus,
      storage: createMemoryStorage(),
      setTimer: () => 1,
      clearTimer: () => undefined,
      onEvent: () => undefined,
    });

    await coordinator.start(REQUEST);
    await coordinator.checkNow();
    expect(coordinator.getPhase()).toBe('uncertain');

    await coordinator.start(REQUEST);

    expect(getTaskStatus).toHaveBeenCalledTimes(2);
    expect(coordinator.getPhase()).toBe('completed');
  });

  it.each([503, 429])(
    'retries HTTP %s category-task status responses and converges',
    async (status) => {
      const getTaskStatus = jest
        .fn()
        .mockRejectedValueOnce(
          Object.assign(new Error(`Request failed with status code ${status}`), {
            response: { status },
          }),
        )
        .mockResolvedValueOnce(COMPLETED);
      const coordinator = createPurchaseInboundCategoryTaskCoordinator({
        prepareCategory: async () => ACCEPTED,
        getTaskStatus,
        storage: createMemoryStorage(),
        setTimer: () => 1,
        clearTimer: () => undefined,
        onEvent: () => undefined,
      });

      await coordinator.start(REQUEST);
      await coordinator.checkNow();

      expect(coordinator.getPhase()).toBe('syncing');
      await coordinator.checkNow();
      expect(getTaskStatus).toHaveBeenCalledTimes(2);
      expect(coordinator.getPhase()).toBe('completed');
    },
  );

  it('keeps a slow pending task accepted instead of returning it to idle', async () => {
    const phases: string[] = [];
    const coordinator = createPurchaseInboundCategoryTaskCoordinator({
      prepareCategory: async () => ACCEPTED,
      getTaskStatus: async () => pendingStatus(phases.length),
      storage: createMemoryStorage(),
      setTimer: () => 1,
      clearTimer: () => undefined,
      onEvent: (event) => phases.push(event.phase),
    });

    await coordinator.start(REQUEST);
    for (let attempt = 0; attempt < 35; attempt += 1) {
      await coordinator.checkNow();
    }

    expect(coordinator.getPhase()).toBe('accepted');
    expect(phases).not.toContain('idle');
    expect(phases.at(-1)).toBe('accepted');
  });
});
