import type {
  InventoryMovementItem,
  InventoryOutboundAcceptedResponse,
  InventoryOutboundMovementCreateRequest,
  InventoryOutboundMovementCreateResponse,
  InventoryOutboundTaskStatusResponse,
} from '../../shared/inventory-management.interface';
import type {
  InventoryOutboundCreationTaskInput,
  InventoryOutboundCreationTaskExpectedVersion,
  InventoryOutboundCreationTaskJournal,
  InventoryOutboundCreationTaskResolution,
  InventoryOutboundCreationTerminalExpectation,
  InventoryOutboundCreationTerminalOutcome,
  InventoryOutboundCreationTerminalReceipt,
} from '../../client/src/pages/InventoryManagement/inventory-outbound-creation-task';
import {
  createInventoryOutboundCreationCoordinator,
  getInventoryOutboundCreationPollDelay,
  type InventoryOutboundCreationCoordinatorEvent,
} from '../../client/src/pages/InventoryManagement/inventory-outbound-creation-coordinator';

const PRINCIPAL = 'A'.repeat(43);
const NOW = Date.parse('2026-08-12T10:00:00.000Z');

function createRequest(): InventoryOutboundMovementCreateRequest {
  return {
    type: 'outbound',
    clientMutationId: 'outbound-create-1',
    catalogRecordId: 'catalog-1',
    sku: 'NT-001',
    building: 'A楼',
    quantity: 2,
    occurredAt: '2026-08-12T01:30:00.000Z',
    applicantOpenId: 'ou_applicant',
    reason: '现场更换',
  };
}

function createMovement(
  status: '待路由' | '待审批' | '待库房确认' | '已驳回' | '已出库' = '待审批',
  overrides: Partial<InventoryMovementItem> = {},
): InventoryMovementItem {
  return {
    recordId: 'outbound-record-1',
    clientMutationId: 'outbound-create-1',
    pendingSync: false,
    type: 'outbound',
    sku: 'NT-001',
    name: '温湿度传感器',
    specification: 'TH-100',
    quantity: 2,
    unit: '台',
    building: 'A楼',
    destinationBuilding: '',
    location: 'A-01',
    reason: '现场更换',
    operator: '库房管理员',
    applicant: '测试申请人',
    status,
    occurredAt: '2026-08-12T01:30:00.000Z',
    expectedReturnAt: null,
    overdue: false,
    ...overrides,
  };
}

function createInput(
  overrides: Partial<InventoryOutboundCreationTaskInput> = {},
): InventoryOutboundCreationTaskInput {
  return {
    clientMutationId: 'outbound-create-1',
    status: 'submitting',
    taskId: null,
    request: createRequest(),
    draft: {
      clientMutationId: 'outbound-create-1',
      building: 'A楼',
      quantity: '2',
      occurredAt: '2026-08-12T01:30:00.000Z',
      itemQuery: '温湿度传感器',
      selectedItem: {
        catalogRecordId: 'catalog-1',
        inventoryRecordId: 'inventory-1',
        sku: 'NT-001',
        name: '温湿度传感器',
        specification: 'TH-100',
        brand: '测试品牌',
        primaryCategory: '仪器仪表',
        secondaryCategory: '环境监测',
        building: 'A楼',
        location: 'A-01',
        unit: '台',
        availableQuantity: 8,
      },
      applicant: {
        recordId: 'person-1',
        openId: 'ou_applicant',
        name: '测试申请人',
        employeeNo: 'NT-001',
        position: '运维工程师',
        building: 'A楼',
        specialty: '暖通',
      },
      reason: '现场更换',
    },
    optimisticItem: {
      ...createMovement(),
      recordId: 'pending:outbound-create-1',
      pendingSync: true,
      operator: '待后端确认',
      status: '同步中',
    },
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function accepted(
  overrides: Partial<InventoryOutboundAcceptedResponse> = {},
): InventoryOutboundAcceptedResponse {
  return {
    accepted: true,
    taskId: 'outbound-task-1',
    status: 'pending',
    message: '出库任务已受理',
    ...overrides,
  };
}

function taskResponse(
  task: InventoryOutboundTaskStatusResponse['task'],
): InventoryOutboundTaskStatusResponse {
  return { success: true, task };
}

function completedResult(
  status: '待路由' | '待审批' | '待库房确认' | '已驳回' | '已出库' = '待审批',
): InventoryOutboundMovementCreateResponse {
  return {
    success: true,
    recordId: 'outbound-record-1',
    type: 'outbound',
    alreadyProcessed: false,
    message: '出库处理完成',
    movement: createMovement(status) as never,
  };
}

class FakeTimers {
  private nextId = 1;
  readonly tasks: Array<{
    id: number;
    delay: number;
    callback: () => void;
    cancelled: boolean;
  }> = [];

  readonly set = (callback: () => void, delay: number): number => {
    const id = this.nextId++;
    this.tasks.push({ id, delay, callback, cancelled: false });
    return id;
  };

  readonly clear = (id: unknown): void => {
    const task = this.tasks.find((candidate) => candidate.id === id);
    if (task) task.cancelled = true;
  };

  activeDelays(): number[] {
    return this.tasks
      .filter((task) => !task.cancelled)
      .map((task) => task.delay);
  }

  runNext(): void {
    const index = this.tasks.findIndex((task) => !task.cancelled);
    if (index < 0) throw new Error('No active timer');
    const [task] = this.tasks.splice(index, 1);
    task.callback();
  }
}

interface TestBrowserLock {
  name: string;
}

class FakeBrowserLockManager {
  readonly calls: Array<{ name: string; ifAvailable: boolean }> = [];
  private readonly activeNames = new Set<string>();
  maxActive = 0;

  async request<T>(
    name: string,
    options: { mode: 'exclusive'; ifAvailable?: boolean },
    callback: (lock: TestBrowserLock | null) => T | Promise<T>,
  ): Promise<T> {
    this.calls.push({ name, ifAvailable: options.ifAvailable === true });
    if (options.ifAvailable && this.activeNames.has(name)) {
      return callback(null);
    }
    if (this.activeNames.has(name)) {
      throw new Error(`unexpected queued test lock: ${name}`);
    }
    this.activeNames.add(name);
    this.maxActive = Math.max(this.maxActive, this.activeNames.size);
    try {
      return await callback({ name });
    } finally {
      this.activeNames.delete(name);
    }
  }

  isActive(name: string): boolean {
    return this.activeNames.has(name);
  }
}

interface SharedJournalState {
  stored: InventoryOutboundCreationTaskJournal | null;
  terminal?: InventoryOutboundCreationTerminalReceipt | null;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushPromises(): Promise<void> {
  for (let index = 0; index < 40; index += 1) {
    await Promise.resolve();
  }
}

function createHarness(
  options: {
    submit?: jest.Mock;
    getTask?: jest.Mock;
    now?: () => number;
    journalState?: SharedJournalState;
  } = {},
) {
  const events: InventoryOutboundCreationCoordinatorEvent[] = [];
  const order: string[] = [];
  const timers = new FakeTimers();
  const journalState = options.journalState ?? { stored: null };
  const submit = options.submit ?? jest.fn().mockResolvedValue(accepted());
  const getTask =
    options.getTask ??
    jest.fn().mockResolvedValue(
      taskResponse({
        id: 'outbound-task-1',
        status: 'pending',
        message: '同步中',
        createdAt: '2026-08-12T10:00:00.000Z',
      }),
    );
  const save = jest.fn(
    async (
      _principal: string,
      input: InventoryOutboundCreationTaskInput,
      expectedVersion?: InventoryOutboundCreationTaskExpectedVersion,
    ) => {
      order.push('save');
      if (journalState.terminal?.clientMutationId === input.clientMutationId) {
        return false;
      }
      if (!journalState.stored) {
        if (expectedVersion) return false;
      } else {
        if (
          !expectedVersion ||
          journalState.stored.clientMutationId !==
            expectedVersion.clientMutationId ||
          journalState.stored.updatedAt !== expectedVersion.updatedAt ||
          input.updatedAt <= journalState.stored.updatedAt
        ) {
          return false;
        }
      }
      journalState.stored = { version: 1, ...input };
      return true;
    },
  );
  const clear = jest.fn(
    async (
      _principal: string,
      expectedVersion: InventoryOutboundCreationTaskExpectedVersion,
    ) => {
      if (!journalState.stored) return true;
      if (
        journalState.stored.clientMutationId !==
          expectedVersion.clientMutationId ||
        journalState.stored.updatedAt !== expectedVersion.updatedAt
      ) {
        return false;
      }
      journalState.stored = null;
      return true;
    },
  );
  const read = jest.fn(async (_principal: string) => journalState.stored);
  const resolve = jest.fn(
    async (
      principal: string,
      expectation: InventoryOutboundCreationTerminalExpectation,
    ): Promise<InventoryOutboundCreationTaskResolution> => {
      const receipt = journalState.terminal;
      if (receipt?.clientMutationId === expectation.clientMutationId) {
        const matches =
          receipt.principalFingerprint === principal &&
          receipt.journalCreatedAt === expectation.journalCreatedAt &&
          receipt.terminalFromUpdatedAt >= expectation.terminalFromUpdatedAt &&
          (expectation.taskId === null ||
            receipt.taskId === expectation.taskId) &&
          JSON.stringify(receipt.request) ===
            JSON.stringify(expectation.request);
        return matches ? { kind: 'terminal', receipt } : { kind: 'conflict' };
      }
      if (!journalState.stored) return { kind: 'missing' };
      const stored = journalState.stored;
      const matches =
        stored.clientMutationId === expectation.clientMutationId &&
        stored.createdAt === expectation.journalCreatedAt &&
        stored.updatedAt >= expectation.terminalFromUpdatedAt &&
        (stored.updatedAt > expectation.terminalFromUpdatedAt ||
          expectation.taskId === null ||
          stored.taskId === expectation.taskId) &&
        JSON.stringify(stored.request) === JSON.stringify(expectation.request);
      return matches
        ? { kind: 'active', journal: stored }
        : { kind: 'conflict' };
    },
  );
  const finalize = jest.fn(
    async (
      principal: string,
      journal: InventoryOutboundCreationTaskJournal,
      outcome: InventoryOutboundCreationTerminalOutcome,
      terminalAt = NOW + 100,
    ): Promise<InventoryOutboundCreationTaskResolution> => {
      if (journalState.terminal) {
        return {
          kind: 'terminal',
          receipt: journalState.terminal,
        };
      }
      const cleared = await clear(principal, {
        clientMutationId: journal.clientMutationId,
        updatedAt: journal.updatedAt,
      });
      if (!cleared) return { kind: 'unavailable' };
      const receipt: InventoryOutboundCreationTerminalReceipt = {
        version: 1,
        principalFingerprint: principal,
        clientMutationId: journal.clientMutationId,
        request: { ...journal.request },
        journalCreatedAt: journal.createdAt,
        terminalFromUpdatedAt: journal.updatedAt,
        taskId: journal.taskId,
        terminalAt,
        expiresAt: terminalAt + 7 * 24 * 60 * 60 * 1000,
        outcome,
        recovery:
          outcome.kind === 'failed'
            ? {
                draft: journal.draft,
                optimisticItem: journal.optimisticItem,
              }
            : null,
        recoveryConsumedAt: null,
      };
      journalState.terminal = receipt;
      return { kind: 'terminal', receipt };
    },
  );
  const dependencies = {
    principalFingerprint: PRINCIPAL,
    submitOutbound: (...args) => {
      order.push('post');
      return submit(...args);
    },
    getTaskStatus: (...args) => getTask(...args),
    saveJournal: save,
    finalizeJournal: finalize,
    resolveJournal: resolve,
    readJournal: read,
    now: options.now ?? (() => NOW + save.mock.calls.length),
    setTimer: timers.set,
    clearTimer: timers.clear,
    onEvent: (event) => {
      order.push(event.type);
      events.push(event);
    },
  };
  const coordinator = createInventoryOutboundCreationCoordinator(dependencies);
  return {
    coordinator,
    events,
    order,
    timers,
    submit,
    getTask,
    save,
    clear,
    finalize,
    resolve,
    read,
    getStored: () => journalState.stored,
    setStored: (journal: InventoryOutboundCreationTaskJournal | null) => {
      journalState.stored = journal;
    },
  };
}

describe('inventory outbound creation coordinator', () => {
  let browserLocks: FakeBrowserLockManager;

  beforeEach(() => {
    browserLocks = new FakeBrowserLockManager();
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { locks: browserLocks },
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'navigator');
  });

  it('persists and publishes the optimistic row synchronously before POST, blocking double submit', async () => {
    const pending = deferred<InventoryOutboundAcceptedResponse>();
    const harness = createHarness({
      submit: jest.fn(() => pending.promise),
    });

    expect(await harness.coordinator.start(createInput())).toBe(true);
    expect(await harness.coordinator.start(createInput())).toBe(false);
    expect(harness.order.slice(0, 3)).toEqual(['save', 'optimistic', 'post']);
    expect(harness.submit).toHaveBeenCalledTimes(1);
    expect(harness.events[0]).toMatchObject({
      type: 'optimistic',
      journal: { clientMutationId: 'outbound-create-1' },
    });

    pending.resolve(accepted());
    await flushPromises();
    expect(harness.getStored()).toMatchObject({
      status: 'accepted',
      taskId: 'outbound-task-1',
    });
  });

  it('reads the current principal and sends no network request when initial storage is unavailable', async () => {
    const harness = createHarness();
    harness.save.mockReturnValueOnce(false);
    harness.read.mockReturnValueOnce(null);

    expect(await harness.coordinator.start(createInput())).toBe(false);
    expect(harness.resolve).toHaveBeenCalledTimes(1);
    expect(harness.submit).not.toHaveBeenCalled();
    expect(harness.getTask).not.toHaveBeenCalled();
    expect(harness.events).toEqual([]);
    expect(harness.coordinator.getCurrentJournal()).toBeNull();
  });

  it('adopts an existing same-mutation no-task journal on initial save without overwriting it', async () => {
    const pendingPost = deferred<InventoryOutboundAcceptedResponse>();
    const harness = createHarness({
      submit: jest.fn(() => pendingPost.promise),
    });
    const latest: InventoryOutboundCreationTaskJournal = {
      version: 1,
      ...createInput({
        status: 'submitting',
        taskId: null,
        updatedAt: NOW + 20,
      }),
    };
    harness.setStored(latest);

    expect(await harness.coordinator.start(createInput())).toBe(true);
    await flushPromises();

    expect(harness.resolve).toHaveBeenCalledTimes(2);
    expect(harness.save).toHaveBeenCalledTimes(1);
    expect(harness.getStored()).toEqual(latest);
    expect(harness.coordinator.getCurrentJournal()).toEqual(latest);
    expect(harness.submit).toHaveBeenCalledTimes(1);
    expect(
      harness.events.some(
        (event) =>
          event.type === 'status' &&
          event.message === '检测到其他页面更新，已接续原任务。',
      ),
    ).toBe(true);
  });

  it('does not advance in memory or schedule GET when persisting acceptance fails', async () => {
    const harness = createHarness();

    expect(await harness.coordinator.start(createInput())).toBe(true);
    harness.save.mockReturnValueOnce(false);
    harness.read.mockReturnValueOnce(null);
    await flushPromises();

    expect(harness.coordinator.getCurrentJournal()).toMatchObject({
      status: 'submitting',
      taskId: null,
    });
    expect(harness.getStored()).toMatchObject({
      status: 'submitting',
      taskId: null,
    });
    expect(harness.getTask).not.toHaveBeenCalled();
    expect(harness.timers.activeDelays()).toEqual([]);
    expect(
      harness.events.some(
        (event) =>
          event.type === 'status' && event.journal.status === 'accepted',
      ),
    ).toBe(false);
  });

  it('blocks network advancement when a failed transition save reads the exact current version', async () => {
    const harness = createHarness();

    expect(await harness.coordinator.start(createInput())).toBe(true);
    const current = harness.getStored();
    harness.save.mockReturnValueOnce(false);
    await flushPromises();

    expect(harness.coordinator.getCurrentJournal()).toEqual(current);
    expect(harness.getStored()).toEqual(current);
    expect(harness.submit).toHaveBeenCalledTimes(1);
    expect(harness.getTask).not.toHaveBeenCalled();
    expect(harness.timers.activeDelays()).toEqual([]);
    expect(
      harness.events.some(
        (event) =>
          event.type === 'status' && event.message.includes('已停止网络推进'),
      ),
    ).toBe(true);
  });

  it('blocks network advancement when a failed transition save reads an older version', async () => {
    const harness = createHarness();

    expect(await harness.coordinator.start(createInput())).toBe(true);
    const current = harness.getStored();
    harness.save.mockReturnValueOnce(false);
    harness.read.mockReturnValueOnce({
      version: 1,
      ...createInput({ updatedAt: NOW - 10 }),
    });
    await flushPromises();

    expect(harness.coordinator.getCurrentJournal()).toEqual(current);
    expect(harness.getStored()).toEqual(current);
    expect(harness.submit).toHaveBeenCalledTimes(1);
    expect(harness.getTask).not.toHaveBeenCalled();
    expect(harness.timers.activeDelays()).toEqual([]);
    expect(
      harness.events.some(
        (event) =>
          event.type === 'status' && event.message.includes('已停止网络推进'),
      ),
    ).toBe(true);
  });

  it('adopts a newer task id after CAS failure and continues with GET only', async () => {
    const pendingGet = deferred<InventoryOutboundTaskStatusResponse>();
    const harness = createHarness({
      getTask: jest.fn(() => pendingGet.promise),
    });

    expect(await harness.coordinator.start(createInput())).toBe(true);
    harness.setStored({
      version: 1,
      ...createInput({
        status: 'accepted',
        taskId: 'outbound-task-from-other-tab',
        updatedAt: NOW + 20,
      }),
    });
    await flushPromises();

    expect(harness.coordinator.getCurrentJournal()).toMatchObject({
      status: 'accepted',
      taskId: 'outbound-task-from-other-tab',
      updatedAt: NOW + 20,
    });
    expect(harness.submit).toHaveBeenCalledTimes(1);
    expect(harness.getTask).toHaveBeenCalledTimes(1);
    expect(harness.getTask).toHaveBeenCalledWith(
      'outbound-task-from-other-tab',
      'A楼',
    );
    expect(harness.read).toHaveBeenCalledWith(PRINCIPAL);
    expect(
      harness.events.some(
        (event) =>
          event.type === 'status' &&
          event.message === '检测到其他页面更新，已接续原任务。',
      ),
    ).toBe(true);
  });

  it('adopts an exact newer no-task snapshot instead of keeping an old task id', async () => {
    const pendingPost = deferred<InventoryOutboundAcceptedResponse>();
    const harness = createHarness({
      submit: jest
        .fn()
        .mockResolvedValueOnce(accepted({ taskId: 'outbound-task-old' }))
        .mockImplementationOnce(() => pendingPost.promise),
    });

    await harness.coordinator.start(createInput());
    await flushPromises();
    expect(harness.coordinator.getCurrentJournal()).toMatchObject({
      status: 'accepted',
      taskId: 'outbound-task-old',
    });
    harness.setStored({
      version: 1,
      ...createInput({
        status: 'submitting',
        taskId: null,
        updatedAt: NOW + 20,
      }),
    });
    harness.timers.runNext();
    await flushPromises();

    expect(harness.coordinator.getCurrentJournal()).toMatchObject({
      status: 'submitting',
      taskId: null,
      updatedAt: NOW + 20,
    });
    expect(harness.submit).toHaveBeenCalledTimes(2);
    expect(harness.getTask).not.toHaveBeenCalled();
    expect(harness.getStored()).toMatchObject({
      status: 'submitting',
      taskId: null,
      updatedAt: NOW + 20,
    });
  });

  it('adopts the latest accepted task without retaining an older uncertain error', async () => {
    const pendingGet = deferred<InventoryOutboundTaskStatusResponse>();
    const harness = createHarness({
      submit: jest
        .fn()
        .mockRejectedValueOnce(
          Object.assign(new Error('offline-old'), { request: {} }),
        ),
      getTask: jest.fn(() => pendingGet.promise),
    });

    await harness.coordinator.start(createInput());
    await flushPromises();
    harness.setStored({
      version: 1,
      ...createInput({
        status: 'accepted',
        taskId: 'outbound-task-new',
        updatedAt: NOW + 20,
      }),
    });
    harness.timers.runNext();
    await flushPromises();

    expect(harness.coordinator.getCurrentJournal()).toMatchObject({
      status: 'accepted',
      taskId: 'outbound-task-new',
      updatedAt: NOW + 20,
    });
    expect(harness.coordinator.getCurrentJournal()?.error).toBeUndefined();
    expect(harness.getTask).toHaveBeenCalledWith('outbound-task-new', 'A楼');
  });

  it('reconnects a lost acceptance response with the original request and mutation id', async () => {
    const submit = jest
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error('network'), { request: {} }),
      )
      .mockResolvedValueOnce(accepted());
    const harness = createHarness({ submit });

    expect(await harness.coordinator.start(createInput())).toBe(true);
    await flushPromises();
    expect(harness.getStored()).toMatchObject({
      status: 'uncertain',
      taskId: null,
    });
    expect(harness.events.some((event) => event.type === 'failed')).toBe(false);

    harness.timers.runNext();
    await flushPromises();
    expect(submit).toHaveBeenCalledTimes(2);
    expect(submit.mock.calls[0][0]).toEqual(createRequest());
    expect(submit.mock.calls[1][0]).toEqual(createRequest());
  });

  it('uses only GET after a task id is known, including after GET network errors', async () => {
    const getTask = jest
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error('offline'), { request: {} }),
      )
      .mockResolvedValueOnce(
        taskResponse({
          id: 'outbound-task-1',
          status: 'running',
          message: '正在同步',
          createdAt: '2026-08-12T10:00:00.000Z',
        }),
      );
    const harness = createHarness({ getTask });

    await harness.coordinator.start(createInput());
    await flushPromises();
    harness.timers.runNext();
    await flushPromises();
    harness.timers.runNext();
    await flushPromises();

    expect(harness.submit).toHaveBeenCalledTimes(1);
    expect(getTask).toHaveBeenCalledTimes(2);
    expect(getTask).toHaveBeenNthCalledWith(1, 'outbound-task-1', 'A楼');
  });

  it('resumes a reloaded journal with task id using GET only', async () => {
    const harness = createHarness();
    const saved = {
      version: 1 as const,
      ...createInput({
        status: 'accepted',
        taskId: 'outbound-task-1',
      }),
    };
    harness.setStored(saved);

    expect(await harness.coordinator.resume(saved)).toBe(true);
    await flushPromises();

    expect(harness.submit).not.toHaveBeenCalled();
    expect(harness.getTask).toHaveBeenCalledWith('outbound-task-1', 'A楼');
  });

  it('resumes a reloaded journal without task id by reconnecting the original POST', async () => {
    const harness = createHarness();
    const saved = {
      version: 1 as const,
      ...createInput({ status: 'uncertain', taskId: null }),
    };
    harness.setStored(saved);

    expect(await harness.coordinator.resume(saved)).toBe(true);
    await flushPromises();

    expect(harness.submit).toHaveBeenCalledTimes(1);
    expect(harness.submit).toHaveBeenCalledWith(createRequest());
    expect(harness.getTask).not.toHaveBeenCalled();
  });

  it('single-flights concurrent no-task resumes and makes the follower GET after acceptance is persisted', async () => {
    const pendingPost = deferred<InventoryOutboundAcceptedResponse>();
    const pendingGet = deferred<InventoryOutboundTaskStatusResponse>();
    const sharedState: SharedJournalState = {
      stored: {
        version: 1,
        ...createInput({ status: 'uncertain', taskId: null }),
      },
    };
    const submit = jest.fn(() => pendingPost.promise);
    const getTask = jest.fn(() => pendingGet.promise);
    const first = createHarness({
      journalState: sharedState,
      submit,
      getTask,
    });
    const second = createHarness({
      journalState: sharedState,
      submit,
      getTask,
    });
    const saved = sharedState.stored!;

    expect(
      await Promise.all([
        first.coordinator.resume(saved),
        second.coordinator.resume(saved),
      ]),
    ).toEqual([true, true]);
    await flushPromises();

    expect(submit).toHaveBeenCalledTimes(1);
    expect(getTask).not.toHaveBeenCalled();
    expect(second.timers.activeDelays()).toHaveLength(1);

    pendingPost.resolve(accepted());
    await flushPromises();
    second.timers.runNext();
    await flushPromises();

    expect(submit).toHaveBeenCalledTimes(1);
    expect(getTask).toHaveBeenCalledTimes(1);
    expect(getTask).toHaveBeenCalledWith('outbound-task-1', 'A楼');
    expect(browserLocks.maxActive).toBe(1);
  });

  it('allows at most one concurrent GET for the same persisted task', async () => {
    const firstGet = deferred<InventoryOutboundTaskStatusResponse>();
    const sharedState: SharedJournalState = {
      stored: {
        version: 1,
        ...createInput({
          status: 'accepted',
          taskId: 'outbound-task-1',
        }),
      },
    };
    const getTask = jest
      .fn()
      .mockImplementationOnce(() => firstGet.promise)
      .mockResolvedValue(
        taskResponse({
          id: 'outbound-task-1',
          status: 'running',
          message: '同步中',
          createdAt: '2026-08-12T10:00:00.000Z',
        }),
      );
    const first = createHarness({ journalState: sharedState, getTask });
    const second = createHarness({ journalState: sharedState, getTask });
    const saved = sharedState.stored!;

    await Promise.all([
      first.coordinator.resume(saved),
      second.coordinator.resume(saved),
    ]);
    await flushPromises();

    expect(getTask).toHaveBeenCalledTimes(1);
    expect(second.timers.activeDelays()).toHaveLength(1);

    firstGet.resolve(
      taskResponse({
        id: 'outbound-task-1',
        status: 'running',
        message: '同步中',
        createdAt: '2026-08-12T10:00:00.000Z',
      }),
    );
    await flushPromises();
    second.timers.runNext();
    await flushPromises();

    expect(getTask).toHaveBeenCalledTimes(2);
    expect(browserLocks.maxActive).toBe(1);
  });

  it('fails closed without Web Locks and sends no network request', async () => {
    Reflect.deleteProperty(globalThis, 'navigator');
    const harness = createHarness();
    const saved = {
      version: 1 as const,
      ...createInput({ status: 'uncertain', taskId: null }),
    };
    harness.setStored(saved);

    expect(await harness.coordinator.resume(saved)).toBe(true);
    await flushPromises();

    expect(harness.submit).not.toHaveBeenCalled();
    expect(harness.getTask).not.toHaveBeenCalled();
    expect(harness.events.at(-1)).toMatchObject({
      type: 'status',
      message: expect.stringContaining('已停止网络推进'),
    });
  });

  it('lets a task-id follower converge by GET after another tab clears the journal', async () => {
    const firstGet = deferred<InventoryOutboundTaskStatusResponse>();
    const completed = taskResponse({
      id: 'outbound-task-1',
      status: 'completed',
      message: '已完成',
      createdAt: '2026-08-12T10:00:00.000Z',
      completedAt: '2026-08-12T10:01:00.000Z',
      result: completedResult(),
    });
    const sharedState: SharedJournalState = {
      stored: {
        version: 1,
        ...createInput({ status: 'accepted', taskId: 'outbound-task-1' }),
      },
    };
    const getTask = jest
      .fn()
      .mockImplementationOnce(() => firstGet.promise)
      .mockResolvedValueOnce(completed);
    const first = createHarness({ journalState: sharedState, getTask });
    const second = createHarness({ journalState: sharedState, getTask });
    const saved = sharedState.stored!;

    await Promise.all([
      first.coordinator.resume(saved),
      second.coordinator.resume(saved),
    ]);
    await flushPromises();
    expect(getTask).toHaveBeenCalledTimes(1);
    expect(second.timers.activeDelays()).toEqual([500]);

    firstGet.resolve(completed);
    await flushPromises();
    expect(sharedState.stored).toBeNull();
    expect(first.events.at(-1)).toMatchObject({ type: 'completed' });

    second.timers.runNext();
    await flushPromises();

    expect(getTask).toHaveBeenCalledTimes(1);
    expect(first.submit).not.toHaveBeenCalled();
    expect(second.submit).not.toHaveBeenCalled();
    expect(second.events.at(-1)).toMatchObject({ type: 'completed' });
    expect(second.coordinator.getCurrentJournal()).toBeNull();
  });

  it('requests an authoritative refresh instead of POST when another tab clears a no-task journal', async () => {
    const sharedState: SharedJournalState = {
      stored: {
        version: 1,
        ...createInput({ status: 'uncertain', taskId: null }),
      },
    };
    const submit = jest.fn().mockResolvedValue(
      accepted({
        status: 'failed',
        definitelyNotWritten: true,
        message: '明确未写入',
      }),
    );
    const first = createHarness({ journalState: sharedState, submit });
    const second = createHarness({ journalState: sharedState, submit });
    const saved = sharedState.stored!;

    await Promise.all([
      first.coordinator.resume(saved),
      second.coordinator.resume(saved),
    ]);
    await flushPromises();
    expect(submit).toHaveBeenCalledTimes(1);
    expect(sharedState.stored).toBeNull();
    expect(first.events.at(-1)).toMatchObject({
      type: 'failed',
      journal: { draft: createInput().draft },
      receipt: { recovery: { draft: createInput().draft } },
    });

    second.timers.runNext();
    await flushPromises();

    expect(submit).toHaveBeenCalledTimes(1);
    expect(second.getTask).not.toHaveBeenCalled();
    expect(second.events.at(-1)).toMatchObject({
      type: 'failed',
      definitelyNotWritten: true,
      message: '明确未写入',
      journal: { draft: createInput().draft },
      receipt: { recovery: { draft: createInput().draft } },
    });
    expect(second.coordinator.getCurrentJournal()).toBeNull();
  });

  it('lets a no-task follower consume a direct completed receipt with only one POST', async () => {
    const sharedState: SharedJournalState = {
      stored: {
        version: 1,
        ...createInput({ status: 'uncertain', taskId: null }),
      },
    };
    const submit = jest.fn().mockResolvedValue(
      accepted({
        status: 'completed',
        result: completedResult(),
        message: '已完成',
      }),
    );
    const first = createHarness({ journalState: sharedState, submit });
    const second = createHarness({ journalState: sharedState, submit });
    const saved = sharedState.stored!;

    await Promise.all([
      first.coordinator.resume(saved),
      second.coordinator.resume(saved),
    ]);
    await flushPromises();
    expect(submit).toHaveBeenCalledTimes(1);
    expect(first.events.at(-1)).toMatchObject({ type: 'completed' });

    second.timers.runNext();
    await flushPromises();

    expect(submit).toHaveBeenCalledTimes(1);
    expect(second.events.at(-1)).toMatchObject({ type: 'completed' });
    expect(second.coordinator.getCurrentJournal()).toBeNull();
  });

  it('allows repeated receipt consumption across followers without deleting proof', async () => {
    const sharedState: SharedJournalState = {
      stored: {
        version: 1,
        ...createInput({ status: 'uncertain', taskId: null }),
      },
    };
    const submit = jest
      .fn()
      .mockResolvedValue(
        accepted({ status: 'completed', result: completedResult() }),
      );
    const writer = createHarness({ journalState: sharedState, submit });
    const saved = sharedState.stored!;
    await writer.coordinator.resume(saved);
    await flushPromises();
    expect(sharedState.terminal).toBeTruthy();

    const firstFollower = createHarness({ journalState: sharedState, submit });
    const secondFollower = createHarness({ journalState: sharedState, submit });
    expect(
      await Promise.all([
        firstFollower.coordinator.resume(saved),
        secondFollower.coordinator.resume(saved),
      ]),
    ).toEqual([true, true]);

    expect(submit).toHaveBeenCalledTimes(1);
    expect(firstFollower.events.at(-1)).toMatchObject({ type: 'completed' });
    expect(secondFollower.events.at(-1)).toMatchObject({ type: 'completed' });
    expect(sharedState.terminal).toBeTruthy();
  });

  it('settles start from the same terminal mutation without POST and allows a new mutation', async () => {
    const sharedState: SharedJournalState = {
      stored: {
        version: 1,
        ...createInput({ status: 'uncertain', taskId: null }),
      },
    };
    const submit = jest
      .fn()
      .mockResolvedValue(
        accepted({ status: 'completed', result: completedResult() }),
      );
    const writer = createHarness({ journalState: sharedState, submit });
    const original = sharedState.stored!;
    await writer.coordinator.resume(original);
    await flushPromises();
    expect(submit).toHaveBeenCalledTimes(1);

    const sameMutation = createHarness({ journalState: sharedState, submit });
    expect(await sameMutation.coordinator.start(createInput())).toBe(true);
    expect(sameMutation.events.at(-1)).toMatchObject({ type: 'completed' });
    expect(submit).toHaveBeenCalledTimes(1);

    const nextMutation = 'outbound-create-2';
    const next = createHarness({ journalState: sharedState, submit });
    expect(
      await next.coordinator.start(
        createInput({
          clientMutationId: nextMutation,
          request: { ...createRequest(), clientMutationId: nextMutation },
          draft: { ...createInput().draft, clientMutationId: nextMutation },
          optimisticItem: {
            ...createInput().optimisticItem,
            recordId: `pending:${nextMutation}`,
            clientMutationId: nextMutation,
          },
          createdAt: NOW + 100,
          updatedAt: NOW + 100,
        }),
      ),
    ).toBe(true);
    await flushPromises();
    expect(submit).toHaveBeenCalledTimes(2);
  });

  it.each([
    [
      'network timeout',
      jest
        .fn()
        .mockRejectedValue(
          Object.assign(new Error('timeout'), { request: {} }),
        ),
    ],
    [
      'HTTP 409',
      jest.fn().mockRejectedValue(
        Object.assign(new Error('conflict'), {
          response: { status: 409, data: { message: '冲突' } },
        }),
      ),
    ],
    [
      'uncertain response',
      jest
        .fn()
        .mockResolvedValue(
          accepted({ status: 'uncertain', message: '结果待核对' }),
        ),
    ],
  ])('never persists a terminal receipt for %s', async (_label, submit) => {
    const sharedState: SharedJournalState = { stored: null };
    const harness = createHarness({ journalState: sharedState, submit });

    expect(await harness.coordinator.start(createInput())).toBe(true);
    await flushPromises();

    expect(sharedState.terminal).toBeFalsy();
    expect(harness.finalize).not.toHaveBeenCalled();
    expect(harness.coordinator.getCurrentJournal()).not.toBeNull();
  });

  it('re-reads a resumed snapshot and uses a newer task id without POST', async () => {
    const harness = createHarness();
    const stale = {
      version: 1 as const,
      ...createInput({ status: 'uncertain', taskId: null }),
    };
    harness.setStored({
      version: 1,
      ...createInput({
        status: 'accepted',
        taskId: 'outbound-task-from-other-tab',
        updatedAt: NOW + 5,
      }),
    });

    expect(await harness.coordinator.resume(stale)).toBe(true);
    await flushPromises();

    expect(harness.resolve).toHaveBeenCalledWith(
      PRINCIPAL,
      expect.objectContaining({ clientMutationId: 'outbound-create-1' }),
      expect.any(Number),
    );
    expect(harness.submit).not.toHaveBeenCalled();
    expect(harness.getTask).toHaveBeenCalledWith(
      'outbound-task-from-other-tab',
      'A楼',
    );
  });

  it('blocks a resumed snapshot when the current principal journal belongs to another mutation', async () => {
    const harness = createHarness();
    const stale = {
      version: 1 as const,
      ...createInput({ status: 'uncertain', taskId: null }),
    };
    harness.setStored({
      version: 1,
      ...createInput({
        clientMutationId: 'outbound-create-other',
        request: {
          ...createRequest(),
          clientMutationId: 'outbound-create-other',
        },
        draft: {
          ...createInput().draft,
          clientMutationId: 'outbound-create-other',
        },
        optimisticItem: {
          ...createInput().optimisticItem,
          recordId: 'pending:outbound-create-other',
          clientMutationId: 'outbound-create-other',
        },
        updatedAt: NOW + 5,
      }),
    });

    expect(await harness.coordinator.resume(stale)).toBe(true);
    expect(harness.resolve).toHaveBeenCalledWith(
      PRINCIPAL,
      expect.objectContaining({ clientMutationId: 'outbound-create-1' }),
      expect.any(Number),
    );
    expect(harness.submit).not.toHaveBeenCalled();
    expect(harness.getTask).not.toHaveBeenCalled();
    expect(harness.save).not.toHaveBeenCalled();
    expect(harness.coordinator.getCurrentJournal()).toMatchObject({
      clientMutationId: 'outbound-create-1',
      status: 'uncertain',
    });
    expect(harness.events).toEqual([
      expect.objectContaining({ type: 'optimistic' }),
      expect.objectContaining({
        type: 'status',
        message:
          '本地出库任务日志发生冲突，已停止网络推进；请保留本页面并检查浏览器存储。',
      }),
    ]);
    expect(await harness.coordinator.start(createInput())).toBe(false);
  });

  it.each(['待路由', '待审批', '待库房确认', '已驳回', '已出库'] as const)(
    'accepts a canonical completed movement with status %s',
    async (status) => {
      const harness = createHarness({
        getTask: jest.fn().mockResolvedValue(
          taskResponse({
            id: 'outbound-task-1',
            status: 'completed',
            message: '已完成',
            createdAt: '2026-08-12T10:00:00.000Z',
            completedAt: '2026-08-12T10:01:00.000Z',
            result: completedResult(status),
          }),
        ),
      });

      await harness.coordinator.start(createInput());
      await flushPromises();
      harness.timers.runNext();
      await flushPromises();

      expect(harness.events.at(-1)).toMatchObject({
        type: 'completed',
        result: { movement: { status } },
      });
      expect(harness.clear).toHaveBeenCalledWith(
        PRINCIPAL,
        expect.objectContaining({ clientMutationId: 'outbound-create-1' }),
      );
      expect(harness.getStored()).toBeNull();
    },
  );

  it('emits completed exactly once and retries terminal cleanup in the background', async () => {
    const harness = createHarness({
      getTask: jest.fn().mockResolvedValue(
        taskResponse({
          id: 'outbound-task-1',
          status: 'completed',
          message: '已完成',
          createdAt: '2026-08-12T10:00:00.000Z',
          completedAt: '2026-08-12T10:01:00.000Z',
          result: completedResult(),
        }),
      ),
    });

    await harness.coordinator.start(createInput());
    await flushPromises();
    const storedBeforeClear = harness.getStored();
    harness.clear.mockReturnValueOnce(false);
    harness.timers.runNext();
    await flushPromises();

    expect(
      harness.events.filter((event) => event.type === 'completed'),
    ).toHaveLength(1);
    expect(harness.events.at(-1)).toMatchObject({
      type: 'completed',
      result: { movement: { clientMutationId: 'outbound-create-1' } },
    });
    expect(harness.coordinator.getCurrentJournal()).toBeNull();
    expect(harness.getStored()).toEqual(storedBeforeClear);
    expect(harness.timers.activeDelays()).toEqual([10_000]);

    harness.timers.runNext();
    await flushPromises();
    expect(harness.getTask).toHaveBeenCalledTimes(1);
    expect(
      harness.events.filter((event) => event.type === 'completed'),
    ).toHaveLength(1);
    expect(harness.coordinator.getCurrentJournal()).toBeNull();
    expect(harness.getStored()).toBeNull();
  });

  it('cancels a pending terminal cleanup when stopped', async () => {
    const harness = createHarness({
      getTask: jest.fn().mockResolvedValue(
        taskResponse({
          id: 'outbound-task-1',
          status: 'completed',
          message: '已完成',
          createdAt: '2026-08-12T10:00:00.000Z',
          completedAt: '2026-08-12T10:01:00.000Z',
          result: completedResult(),
        }),
      ),
    });
    await harness.coordinator.start(createInput());
    await flushPromises();
    harness.clear.mockReturnValueOnce(false);
    harness.timers.runNext();
    await flushPromises();
    const terminalEventCount = harness.events.filter(
      (event) => event.type === 'completed' || event.type === 'failed',
    ).length;

    harness.coordinator.stop();
    expect(harness.timers.activeDelays()).toEqual([]);
    expect(
      harness.events.filter(
        (event) => event.type === 'completed' || event.type === 'failed',
      ),
    ).toHaveLength(terminalEventCount);
  });

  it('adopts a newer journal instead of clearing it with a stale completed result', async () => {
    const firstGet = deferred<InventoryOutboundTaskStatusResponse>();
    const nextGet = deferred<InventoryOutboundTaskStatusResponse>();
    const getTask = jest
      .fn()
      .mockImplementationOnce(() => firstGet.promise)
      .mockImplementationOnce(() => nextGet.promise);
    const harness = createHarness({ getTask });

    await harness.coordinator.start(createInput());
    await flushPromises();
    harness.timers.runNext();
    await flushPromises();
    expect(getTask).toHaveBeenCalledTimes(1);
    harness.setStored({
      version: 1,
      ...createInput({
        status: 'accepted',
        taskId: 'outbound-task-from-other-tab',
        updatedAt: NOW + 20,
      }),
    });
    firstGet.resolve(
      taskResponse({
        id: 'outbound-task-1',
        status: 'completed',
        message: '已完成',
        createdAt: '2026-08-12T10:00:00.000Z',
        completedAt: '2026-08-12T10:01:00.000Z',
        result: completedResult(),
      }),
    );
    await flushPromises();

    expect(harness.events.some((event) => event.type === 'completed')).toBe(
      false,
    );
    expect(harness.coordinator.getCurrentJournal()).toMatchObject({
      taskId: 'outbound-task-from-other-tab',
      updatedAt: NOW + 20,
    });
    expect(harness.getStored()).toMatchObject({
      taskId: 'outbound-task-from-other-tab',
      updatedAt: NOW + 20,
    });
    expect(harness.submit).toHaveBeenCalledTimes(1);
    expect(getTask).toHaveBeenNthCalledWith(
      2,
      'outbound-task-from-other-tab',
      'A楼',
    );
  });

  it('drops a stale terminal result and reconnects when the newer journal has no task id', async () => {
    const firstGet = deferred<InventoryOutboundTaskStatusResponse>();
    const pendingPost = deferred<InventoryOutboundAcceptedResponse>();
    const getTask = jest.fn().mockImplementationOnce(() => firstGet.promise);
    const harness = createHarness({
      getTask,
      submit: jest
        .fn()
        .mockResolvedValueOnce(accepted())
        .mockImplementationOnce(() => pendingPost.promise),
    });

    await harness.coordinator.start(createInput());
    await flushPromises();
    harness.timers.runNext();
    await flushPromises();
    expect(getTask).toHaveBeenCalledTimes(1);
    harness.setStored({
      version: 1,
      ...createInput({
        status: 'submitting',
        taskId: null,
        updatedAt: NOW + 20,
      }),
    });
    firstGet.resolve(
      taskResponse({
        id: 'outbound-task-1',
        status: 'completed',
        message: '已完成',
        createdAt: '2026-08-12T10:00:00.000Z',
        completedAt: '2026-08-12T10:01:00.000Z',
        result: completedResult(),
      }),
    );
    await flushPromises();

    expect(harness.events.some((event) => event.type === 'completed')).toBe(
      false,
    );
    expect(harness.coordinator.getCurrentJournal()).toMatchObject({
      status: 'submitting',
      taskId: null,
      updatedAt: NOW + 20,
    });
    expect(harness.getStored()).toMatchObject({
      status: 'submitting',
      taskId: null,
      updatedAt: NOW + 20,
    });
    expect(harness.submit).toHaveBeenCalledTimes(1);
    expect(harness.clear).toHaveBeenCalledWith(PRINCIPAL, {
      clientMutationId: 'outbound-create-1',
      updatedAt: NOW + 1,
    });

    harness.timers.runNext();
    await flushPromises();

    expect(harness.submit).toHaveBeenCalledTimes(2);
    expect(harness.clear).toHaveBeenCalledTimes(1);
  });

  it('keeps the original task when a completed result is inconsistent', async () => {
    const inconsistent = completedResult();
    inconsistent.movement = createMovement('待库房确认', {
      clientMutationId: 'other-mutation',
    }) as never;
    const harness = createHarness({
      getTask: jest.fn().mockResolvedValue(
        taskResponse({
          id: 'outbound-task-1',
          status: 'completed',
          message: '已完成',
          createdAt: '2026-08-12T10:00:00.000Z',
          completedAt: '2026-08-12T10:01:00.000Z',
          result: inconsistent,
        }),
      ),
    });

    await harness.coordinator.start(createInput());
    await flushPromises();
    harness.timers.runNext();
    await flushPromises();

    expect(harness.getStored()).toMatchObject({
      status: 'uncertain',
      taskId: 'outbound-task-1',
    });
    expect(harness.clear).not.toHaveBeenCalled();
    expect(harness.events.some((event) => event.type === 'completed')).toBe(
      false,
    );
  });

  it('rolls back only a definitely-not-written failed task', async () => {
    const harness = createHarness({
      getTask: jest.fn().mockResolvedValue(
        taskResponse({
          id: 'outbound-task-1',
          status: 'failed',
          message: '请求校验失败',
          createdAt: '2026-08-12T10:00:00.000Z',
          completedAt: '2026-08-12T10:01:00.000Z',
          definitelyNotWritten: true,
        }),
      ),
    });

    await harness.coordinator.start(createInput());
    await flushPromises();
    harness.timers.runNext();
    await flushPromises();

    expect(harness.events.at(-1)).toMatchObject({
      type: 'failed',
      definitelyNotWritten: true,
      journal: { draft: { clientMutationId: 'outbound-create-1' } },
    });
    expect(harness.clear).toHaveBeenCalled();
  });

  it('retains the original mutation and withholds failed when rejection clear fails', async () => {
    const harness = createHarness({
      submit: jest.fn().mockRejectedValue(
        Object.assign(new Error('invalid'), {
          response: {
            status: 422,
            data: { message: '数量不合法', definitelyNotWritten: true },
          },
        }),
      ),
    });
    harness.clear.mockReturnValueOnce(false);

    expect(await harness.coordinator.start(createInput())).toBe(true);
    await flushPromises();

    expect(harness.events.some((event) => event.type === 'failed')).toBe(false);
    expect(harness.coordinator.getCurrentJournal()).toMatchObject({
      clientMutationId: 'outbound-create-1',
      status: 'submitting',
    });
    expect(harness.getStored()).toMatchObject({
      clientMutationId: 'outbound-create-1',
    });
    expect(harness.events.at(-1)).toMatchObject({
      type: 'status',
      message: '后端已确认未写入，正在完成本地安全清理。',
    });
    expect(harness.timers.activeDelays()).toEqual([10_000]);
    expect(await harness.coordinator.start(createInput())).toBe(false);
  });

  it.each([
    [
      'uncertain task',
      () =>
        Promise.resolve(
          taskResponse({
            id: 'outbound-task-1',
            status: 'uncertain',
            message: '写入结果待核对',
            createdAt: '2026-08-12T10:00:00.000Z',
            completedAt: '2026-08-12T10:01:00.000Z',
            definitelyNotWritten: false,
          }),
        ),
    ],
    [
      'GET network error',
      () =>
        Promise.reject(Object.assign(new Error('offline'), { request: {} })),
    ],
    [
      'GET conflict',
      () =>
        Promise.reject(
          Object.assign(new Error('conflict'), {
            response: { status: 409, data: { message: '幂等冲突' } },
          }),
        ),
    ],
  ])('preserves the optimistic task for %s', async (_label, response) => {
    const harness = createHarness({
      getTask: jest.fn(response),
    });

    await harness.coordinator.start(createInput());
    await flushPromises();
    harness.timers.runNext();
    await flushPromises();

    expect(harness.getStored()).toMatchObject({
      clientMutationId: 'outbound-create-1',
      taskId: 'outbound-task-1',
    });
    expect(harness.clear).not.toHaveBeenCalled();
    expect(harness.events.some((event) => event.type === 'failed')).toBe(false);
  });

  it('treats accept 409 as a locked conflict but a proven 422 rejection as failed', async () => {
    const conflict = createHarness({
      submit: jest.fn().mockRejectedValue(
        Object.assign(new Error('conflict'), {
          response: { status: 409, data: { message: '幂等冲突' } },
        }),
      ),
    });
    await conflict.coordinator.start(createInput());
    await flushPromises();
    expect(conflict.getStored()).toMatchObject({ status: 'conflict' });
    expect(conflict.clear).not.toHaveBeenCalled();

    const rejected = createHarness({
      submit: jest.fn().mockRejectedValue(
        Object.assign(new Error('invalid'), {
          response: {
            status: 422,
            data: {
              message: '数量不合法',
              writeDisposition: 'definitely-not-written',
            },
          },
        }),
      ),
    });
    await rejected.coordinator.start(createInput());
    await flushPromises();
    expect(rejected.events.at(-1)).toMatchObject({
      type: 'failed',
      definitelyNotWritten: true,
    });
    expect(rejected.clear).toHaveBeenCalled();
  });

  it.each([400, 403, 409, 503])(
    'restores the full draft for an explicitly definitely-not-written HTTP %s acceptance failure',
    async (status) => {
      const harness = createHarness({
        submit: jest.fn().mockRejectedValue(
          Object.assign(new Error('acceptance failed before task creation'), {
            response: {
              status,
              data: {
                message: '出库申请未写入',
                definitelyNotWritten: true,
                writeDisposition: 'definitely-not-written',
              },
            },
          }),
        ),
      });

      await harness.coordinator.start(createInput());
      await flushPromises();

      expect(harness.events.at(-1)).toMatchObject({
        type: 'failed',
        definitelyNotWritten: true,
        journal: {
          taskId: null,
          draft: {
            clientMutationId: 'outbound-create-1',
            reason: '现场更换',
          },
        },
      });
      expect(harness.clear).toHaveBeenCalled();
      expect(harness.getStored()).toBeNull();
    },
  );

  it.each([401, 403])(
    'keeps the original mutation for HTTP %s without explicit write proof',
    async (status) => {
      const harness = createHarness({
        submit: jest.fn().mockRejectedValue(
          Object.assign(new Error('session expired'), {
            response: { status, data: { message: '身份已失效' } },
          }),
        ),
      });

      await harness.coordinator.start(createInput());
      await flushPromises();

      expect(harness.clear).not.toHaveBeenCalled();
      expect(harness.events.some((event) => event.type === 'failed')).toBe(
        false,
      );
      expect(harness.getStored()).toMatchObject({
        clientMutationId: 'outbound-create-1',
        status: 'uncertain',
      });
    },
  );

  it('accepts an uppercase completed task movement for a lowercase request SKU', async () => {
    const input = createInput({
      request: { ...createRequest(), sku: 'nt-001' },
      draft: {
        ...createInput().draft,
        selectedItem: { ...createInput().draft.selectedItem, sku: 'nt-001' },
      },
      optimisticItem: { ...createInput().optimisticItem, sku: 'nt-001' },
    });
    const harness = createHarness({
      getTask: jest.fn().mockResolvedValue(
        taskResponse({
          id: 'outbound-task-1',
          status: 'completed',
          message: '已完成',
          createdAt: '2026-08-12T10:00:00.000Z',
          completedAt: '2026-08-12T10:01:00.000Z',
          result: completedResult(),
        }),
      ),
    });

    await harness.coordinator.start(input);
    await flushPromises();
    harness.timers.runNext();
    await flushPromises();

    expect(harness.events.at(-1)).toMatchObject({ type: 'completed' });
  });

  it('accepts an uppercase authoritative movement for a lowercase request SKU', async () => {
    const input = createInput({
      request: { ...createRequest(), sku: 'nt-001' },
      draft: {
        ...createInput().draft,
        selectedItem: { ...createInput().draft.selectedItem, sku: 'nt-001' },
      },
      optimisticItem: { ...createInput().optimisticItem, sku: 'nt-001' },
    });
    const harness = createHarness({
      submit: jest.fn(() => new Promise(() => undefined)),
    });
    await harness.coordinator.start(input);

    expect(
      await harness.coordinator.reconcileAuthoritativeMovement(
        createMovement('已出库', { sku: 'NT-001' }),
      ),
    ).toBe(true);
    expect(harness.events.at(-1)).toMatchObject({ type: 'completed' });
  });

  it('reconciles only an authoritative movement with the same mutation id', async () => {
    const harness = createHarness({
      submit: jest.fn(() => new Promise(() => undefined)),
    });
    await harness.coordinator.start(createInput());

    expect(
      await harness.coordinator.reconcileAuthoritativeMovement(
        createMovement('已出库', { clientMutationId: 'other-mutation' }),
      ),
    ).toBe(false);
    expect(harness.clear).not.toHaveBeenCalled();
    expect(
      await harness.coordinator.reconcileAuthoritativeMovement(
        createMovement('已出库'),
      ),
    ).toBe(true);
    expect(harness.events.at(-1)).toMatchObject({
      type: 'completed',
      result: { movement: { status: '已出库' } },
    });
  });

  it('does not let a late non-terminal POST response revive a completed task', async () => {
    const pendingPost = deferred<InventoryOutboundAcceptedResponse>();
    const harness = createHarness({
      submit: jest.fn(() => pendingPost.promise),
    });

    await harness.coordinator.start(createInput());
    await flushPromises();
    expect(harness.submit).toHaveBeenCalledTimes(1);

    harness.finalize.mockRejectedValueOnce(
      new Error('localStorage terminal receipt is unavailable'),
    );
    harness.resolve.mockResolvedValueOnce({ kind: 'unavailable' });
    expect(
      await harness.coordinator.reconcileAuthoritativeMovement(
        createMovement('已出库'),
      ),
    ).toBe(true);
    expect(
      harness.events.filter((event) => event.type === 'completed'),
    ).toHaveLength(1);
    expect(harness.coordinator.getCurrentJournal()).toBeNull();
    const eventCountWhileTerminal = harness.events.length;
    const saveCountWhileTerminal = harness.save.mock.calls.length;
    expect(harness.timers.activeDelays()).toEqual([10_000]);

    pendingPost.resolve(accepted());
    await flushPromises();

    expect(harness.events).toHaveLength(eventCountWhileTerminal);
    expect(harness.save).toHaveBeenCalledTimes(saveCountWhileTerminal);
    expect(harness.getTask).not.toHaveBeenCalled();
    expect(harness.submit).toHaveBeenCalledTimes(1);
    expect(harness.timers.activeDelays()).toEqual([10_000]);

    harness.timers.runNext();
    await flushPromises();

    expect(harness.clear).toHaveBeenCalledTimes(1);
    expect(
      harness.events.filter((event) => event.type === 'completed'),
    ).toHaveLength(1);
    expect(harness.getTask).not.toHaveBeenCalled();
    expect(harness.coordinator.getCurrentJournal()).toBeNull();
  });

  it('keeps GET single-flight when focus checks repeat and cancels timers on stop', async () => {
    const pendingGet = deferred<InventoryOutboundTaskStatusResponse>();
    let concurrent = 0;
    let maximumConcurrent = 0;
    const getTask = jest.fn(() => {
      concurrent += 1;
      maximumConcurrent = Math.max(maximumConcurrent, concurrent);
      return pendingGet.promise.finally(() => {
        concurrent -= 1;
      });
    });
    const harness = createHarness({ getTask });

    await harness.coordinator.start(createInput());
    await flushPromises();
    void harness.coordinator.checkNow();
    void harness.coordinator.checkNow();
    await flushPromises();
    expect(getTask).toHaveBeenCalledTimes(1);
    expect(maximumConcurrent).toBe(1);

    pendingGet.resolve(
      taskResponse({
        id: 'outbound-task-1',
        status: 'running',
        message: '正在同步',
        createdAt: '2026-08-12T10:00:00.000Z',
      }),
    );
    await flushPromises();
    expect(maximumConcurrent).toBe(1);

    harness.coordinator.stop();
    expect(harness.timers.activeDelays()).toEqual([]);
  });

  it('ignores a late acceptance response after stop or principal replacement', async () => {
    const pending = deferred<InventoryOutboundAcceptedResponse>();
    const harness = createHarness({
      submit: jest.fn(() => pending.promise),
    });
    await harness.coordinator.start(createInput());
    const eventCount = harness.events.length;
    const saveCount = harness.save.mock.calls.length;

    harness.coordinator.stop();
    pending.resolve(accepted());
    await flushPromises();

    expect(harness.events).toHaveLength(eventCount);
    expect(harness.save).toHaveBeenCalledTimes(saveCount);
  });

  it('backs polling off to a bounded slow cadence', () => {
    expect(
      Array.from({ length: 12 }, (_, index) =>
        getInventoryOutboundCreationPollDelay(index),
      ),
    ).toEqual([
      500, 750, 1_000, 2_000, 3_000, 5_000, 7_500, 10_000, 10_000, 10_000,
      10_000, 10_000,
    ]);
  });
});
