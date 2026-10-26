import type {
  InventoryMovementItem,
  InventoryOutboundMovementCreateRequest,
} from '../../shared/inventory-management.interface';
import type { InventoryOutboundDraftSnapshot } from '../../client/src/pages/InventoryManagement/inventory-outbound-recovery';
import {
  INVENTORY_OUTBOUND_CREATION_TERMINAL_RECEIPT_MAX_BYTES,
  INVENTORY_OUTBOUND_CREATION_TERMINAL_RECEIPT_MAX_ENTRIES,
  INVENTORY_OUTBOUND_CREATION_TERMINAL_RECEIPT_STORAGE_MAX_BYTES,
  INVENTORY_OUTBOUND_CREATION_TERMINAL_RECEIPT_STORAGE_PREFIX,
  INVENTORY_OUTBOUND_CREATION_TERMINAL_RECEIPT_TTL_MS,
  INVENTORY_OUTBOUND_CREATION_TASK_MAX_BYTES,
  INVENTORY_OUTBOUND_CREATION_TASK_TTL_MS,
  clearInventoryOutboundCreationTask,
  finalizeInventoryOutboundCreationTask,
  getInventoryOutboundCreationTaskStorageKey,
  inspectInventoryOutboundCreationTask,
  markInventoryOutboundCreationFailedReceiptConsumed,
  migrateLegacyInventoryOutboundCreateRecovery,
  readInventoryOutboundCreationTask,
  readInventoryOutboundCreationTasks,
  readUnconsumedInventoryOutboundCreationFailedReceipt,
  resolveInventoryOutboundCreationTask,
  saveInventoryOutboundCreationTask,
  type InventoryOutboundCreationTaskInput,
  type InventoryOutboundCreationTaskJournal,
  type InventoryOutboundCreationFailedReceiptIdentity,
  type InventoryOutboundCreationTerminalExpectation,
} from '../../client/src/pages/InventoryManagement/inventory-outbound-creation-task';
import {
  INVENTORY_OUTBOUND_RECOVERY_STORAGE_KEY,
  saveInventoryOutboundRecovery,
} from '../../client/src/pages/InventoryManagement/inventory-outbound-recovery';

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

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
    this.values.set(key, value);
  }
}

interface RecoveryWindow {
  localStorage: Storage;
  sessionStorage: Storage;
  addEventListener: (
    type: string,
    listener: EventListenerOrEventListenerObject,
  ) => void;
  removeEventListener: (
    type: string,
    listener: EventListenerOrEventListenerObject,
  ) => void;
  dispatchEvent: (event: Event) => boolean;
}

interface TestLock {
  name: string;
}

class FakeLockManager {
  readonly calls: string[] = [];
  private readonly tails = new Map<string, Promise<void>>();
  private active = 0;
  maxActive = 0;
  rejectRequests = false;

  async request<T>(
    name: string,
    _options: { mode: 'exclusive'; ifAvailable?: boolean },
    callback: (lock: TestLock | null) => T | Promise<T>,
  ): Promise<T> {
    this.calls.push(name);
    if (this.rejectRequests) throw new Error('lock unavailable');
    const previous = this.tails.get(name) ?? Promise.resolve();
    let release = (): void => undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.tails.set(name, tail);
    await previous;
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      return await callback({ name });
    } finally {
      this.active -= 1;
      release();
      if (this.tails.get(name) === tail) this.tails.delete(name);
    }
  }
}

const PRINCIPAL_A = 'A'.repeat(43);
const PRINCIPAL_B = 'B'.repeat(43);
const NOW = Date.parse('2026-08-12T10:00:00.000Z');

function installWindow(
  options: {
    withLocks?: boolean;
    localStorage?: Storage;
    sessionStorage?: Storage;
  } = {},
): {
  localStorage: Storage;
  sessionStorage: Storage;
  locks: FakeLockManager | null;
} {
  const eventTarget = new EventTarget();
  const localStorage = options.localStorage ?? new MemoryStorage();
  const sessionStorage = options.sessionStorage ?? new MemoryStorage();
  const fakeWindow: RecoveryWindow = {
    localStorage,
    sessionStorage,
    addEventListener: eventTarget.addEventListener.bind(eventTarget),
    removeEventListener: eventTarget.removeEventListener.bind(eventTarget),
    dispatchEvent: eventTarget.dispatchEvent.bind(eventTarget),
  };
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: fakeWindow,
  });
  const locks = options.withLocks === false ? null : new FakeLockManager();
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: locks ? { locks } : {},
  });
  return { localStorage, sessionStorage, locks };
}

function uninstallWindow(): void {
  Reflect.deleteProperty(globalThis, 'window');
  Reflect.deleteProperty(globalThis, 'navigator');
}

function createDraft(
  clientMutationId = 'outbound-create-1',
): InventoryOutboundDraftSnapshot {
  return {
    clientMutationId,
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
  };
}

function createRequest(
  clientMutationId = 'outbound-create-1',
): InventoryOutboundMovementCreateRequest {
  return {
    type: 'outbound',
    clientMutationId,
    catalogRecordId: 'catalog-1',
    sku: 'NT-001',
    building: 'A楼',
    quantity: 2,
    occurredAt: '2026-08-12T01:30:00.000Z',
    applicantOpenId: 'ou_applicant',
    reason: '现场更换',
  };
}

function createOptimisticItem(
  clientMutationId = 'outbound-create-1',
): InventoryMovementItem {
  return {
    recordId: `pending:${clientMutationId}`,
    clientMutationId,
    pendingSync: true,
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
    operator: '待后端确认',
    applicant: '测试申请人',
    status: '待审批',
    occurredAt: '2026-08-12T01:30:00.000Z',
    expectedReturnAt: null,
    overdue: false,
  };
}

function createTaskInput(
  overrides: Partial<InventoryOutboundCreationTaskInput> = {},
): InventoryOutboundCreationTaskInput {
  return {
    clientMutationId: 'outbound-create-1',
    status: 'submitting',
    taskId: null,
    request: createRequest(),
    draft: createDraft(),
    optimisticItem: createOptimisticItem(),
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function createJournal(
  overrides: Partial<InventoryOutboundCreationTaskInput> = {},
): InventoryOutboundCreationTaskJournal {
  return { version: 1, ...createTaskInput(overrides) };
}

function createTerminalExpectation(
  journal: InventoryOutboundCreationTaskJournal,
): InventoryOutboundCreationTerminalExpectation {
  return {
    clientMutationId: journal.clientMutationId,
    journalCreatedAt: journal.createdAt,
    terminalFromUpdatedAt: journal.updatedAt,
    request: { ...journal.request },
    taskId: journal.taskId,
  };
}

function createFailedReceiptIdentity(receipt: {
  clientMutationId: string;
  journalCreatedAt: number;
  terminalFromUpdatedAt: number;
  taskId: string | null;
  terminalAt: number;
}): InventoryOutboundCreationFailedReceiptIdentity {
  return {
    clientMutationId: receipt.clientMutationId,
    journalCreatedAt: receipt.journalCreatedAt,
    terminalFromUpdatedAt: receipt.terminalFromUpdatedAt,
    taskId: receipt.taskId,
    terminalAt: receipt.terminalAt,
  };
}

function createCompletedResult(): {
  success: true;
  recordId: string;
  type: 'outbound';
  alreadyProcessed: false;
  message: string;
  movement: InventoryMovementItem;
} {
  return {
    success: true,
    recordId: 'outbound-record-1',
    type: 'outbound',
    alreadyProcessed: false,
    message: '出库处理完成',
    movement: {
      ...createOptimisticItem(),
      recordId: 'outbound-record-1',
      pendingSync: false,
      operator: '库房管理员',
      status: '待库房确认',
    },
  };
}

describe('inventory outbound creation task journal', () => {
  it.each([17, null, {}])(
    'rejects malformed specialty %p in selected and optimistic items',
    async (specialty) => {
      const { localStorage } = installWindow();
      const selected = createDraft();
      Object.assign(selected.selectedItem!, { specialty });
      expect(
        await saveInventoryOutboundCreationTask(
          PRINCIPAL_A,
          createTaskInput({ draft: selected }),
        ),
      ).toBe(false);
      const optimisticItem = createOptimisticItem();
      Object.assign(optimisticItem, { specialty });
      expect(
        await saveInventoryOutboundCreationTask(
          PRINCIPAL_A,
          createTaskInput({ optimisticItem }),
        ),
      ).toBe(false);
      expect(
        localStorage.getItem(
          getInventoryOutboundCreationTaskStorageKey(PRINCIPAL_A),
        ),
      ).toBeNull();
    },
  );

  it('retains specialty through the optimistic journal and completed receipt', async () => {
    installWindow();
    const input = createTaskInput({
      optimisticItem: { ...createOptimisticItem(), specialty: '电气' },
    });
    expect(await saveInventoryOutboundCreationTask(PRINCIPAL_A, input)).toBe(
      true,
    );
    const journal = (await readInventoryOutboundCreationTask(PRINCIPAL_A, NOW))!;
    expect(journal.optimisticItem.specialty).toBe('电气');
    const result = createCompletedResult();
    result.movement.specialty = '电气';
    const finalized = await finalizeInventoryOutboundCreationTask(
      PRINCIPAL_A,
      journal,
      { kind: 'completed', result: result as never },
      NOW + 10,
    );
    expect(finalized.kind).toBe('terminal');
    const resolved = await resolveInventoryOutboundCreationTask(
      PRINCIPAL_A,
      createTerminalExpectation(journal),
      NOW + 10,
    );
    expect(resolved.kind).toBe('terminal');
  });

  it.each(['', '电气'])(
    'persists actual API option specialty %p in a creation task',
    async (specialty) => {
      installWindow();
      const {
        buildMovementOptions,
      } = require('../../server/modules/inventory-management/inventory-movement-command.rules');
      const selectedItem = buildMovementOptions({
        type: 'outbound',
        building: 'A楼',
        catalog: [
          {
            record_id: 'catalog-1',
            fields: {
              物品类别号: 'NT-001',
              名称: '温湿度传感器',
              楼栋: 'A楼',
              专业: specialty,
            },
          },
        ],
        inventory: [
          {
            record_id: 'inventory-1',
            fields: { 物品类别号: 'NT-001', 楼栋: 'A楼', 剩余库存: 8 },
          },
        ],
      })[0];
      const input = createTaskInput({
        draft: { ...createDraft(), selectedItem },
      });
      expect(await saveInventoryOutboundCreationTask(PRINCIPAL_A, input)).toBe(
        true,
      );
      expect(
        (await readInventoryOutboundCreationTask(PRINCIPAL_A))?.draft
          .selectedItem,
      ).toEqual(selectedItem);
    },
  );
  beforeEach(() => {
    installWindow();
  });

  afterEach(() => {
    uninstallWindow();
  });

  it('requires a legal principal fingerprint and never falls back to a global key', async () => {
    expect(getInventoryOutboundCreationTaskStorageKey('')).toBeNull();
    expect(getInventoryOutboundCreationTaskStorageKey('short')).toBeNull();
    expect(await saveInventoryOutboundCreationTask('', createTaskInput())).toBe(
      false,
    );
    expect(window.localStorage.length).toBe(0);

    expect(getInventoryOutboundCreationTaskStorageKey(PRINCIPAL_A)).toBe(
      `inventory-management:outbound-creation-task:v1:${PRINCIPAL_A}`,
    );
  });

  it('persists across tab close semantics and isolates principals', async () => {
    expect(
      await saveInventoryOutboundCreationTask(PRINCIPAL_A, createTaskInput()),
    ).toBe(true);

    expect(
      await readInventoryOutboundCreationTask(PRINCIPAL_A, NOW),
    ).toMatchObject({
      version: 1,
      clientMutationId: 'outbound-create-1',
      status: 'submitting',
      taskId: null,
      request: createRequest(),
      draft: createDraft(),
      optimisticItem: createOptimisticItem(),
    });
    expect(
      await readInventoryOutboundCreationTask(PRINCIPAL_B, NOW),
    ).toBeNull();
    expect(window.sessionStorage.length).toBe(0);
  });

  it('uses compare-and-swap and rejects a different or older mutation', async () => {
    expect(
      await saveInventoryOutboundCreationTask(PRINCIPAL_A, createTaskInput()),
    ).toBe(true);
    expect(
      await saveInventoryOutboundCreationTask(
        PRINCIPAL_A,
        createTaskInput({
          clientMutationId: 'outbound-create-2',
          request: createRequest('outbound-create-2'),
          draft: createDraft('outbound-create-2'),
          optimisticItem: createOptimisticItem('outbound-create-2'),
        }),
      ),
    ).toBe(false);
    expect(
      await saveInventoryOutboundCreationTask(
        PRINCIPAL_A,
        createTaskInput({ updatedAt: NOW - 1 }),
        { clientMutationId: 'outbound-create-1', updatedAt: NOW },
      ),
    ).toBe(false);
    expect(
      await saveInventoryOutboundCreationTask(
        PRINCIPAL_A,
        createTaskInput({
          status: 'accepted',
          taskId: 'inventory-outbound-task-1',
          updatedAt: NOW + 1,
        }),
        { clientMutationId: 'outbound-create-1', updatedAt: NOW },
      ),
    ).toBe(true);
  });

  it('releases the durable create slot only after the first task has a task id', async () => {
    const secondMutation = createTaskInput({
      clientMutationId: 'outbound-create-2',
      request: createRequest('outbound-create-2'),
      draft: createDraft('outbound-create-2'),
      optimisticItem: createOptimisticItem('outbound-create-2'),
      createdAt: NOW + 2,
      updatedAt: NOW + 2,
    });

    expect(
      await saveInventoryOutboundCreationTask(PRINCIPAL_A, createTaskInput()),
    ).toBe(true);
    expect(
      await saveInventoryOutboundCreationTask(PRINCIPAL_A, secondMutation),
    ).toBe(false);

    expect(
      await saveInventoryOutboundCreationTask(
        PRINCIPAL_A,
        createTaskInput({
          status: 'accepted',
          taskId: 'outbound-task-1',
          updatedAt: NOW + 1,
        }),
        { clientMutationId: 'outbound-create-1', updatedAt: NOW },
      ),
    ).toBe(true);
    expect(
      await saveInventoryOutboundCreationTask(PRINCIPAL_A, secondMutation),
    ).toBe(true);

    expect(
      await readInventoryOutboundCreationTasks(PRINCIPAL_A, NOW + 2),
    ).toEqual([
      expect.objectContaining({
        clientMutationId: 'outbound-create-1',
        taskId: 'outbound-task-1',
      }),
      expect.objectContaining({
        clientMutationId: 'outbound-create-2',
        taskId: null,
      }),
    ]);
  });

  it('serializes concurrent initial create-if-absent writes for one principal', async () => {
    const locks = (
      globalThis.navigator as unknown as { locks: FakeLockManager }
    ).locks;
    const secondMutation = createTaskInput({
      clientMutationId: 'outbound-create-2',
      request: createRequest('outbound-create-2'),
      draft: createDraft('outbound-create-2'),
      optimisticItem: createOptimisticItem('outbound-create-2'),
    });

    const results = await Promise.all([
      saveInventoryOutboundCreationTask(PRINCIPAL_A, createTaskInput()),
      saveInventoryOutboundCreationTask(PRINCIPAL_A, secondMutation),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(
      await readInventoryOutboundCreationTask(PRINCIPAL_A, NOW),
    ).toMatchObject({
      clientMutationId: 'outbound-create-1',
    });
    expect(locks.maxActive).toBe(1);
    expect(locks.calls.slice(0, 2)).toEqual([
      `inventory-management:outbound-creation-journal-lock:v1:${PRINCIPAL_A}`,
      `inventory-management:outbound-creation-journal-lock:v1:${PRINCIPAL_A}`,
    ]);
  });

  it('allows only one concurrent transition from the same expected version', async () => {
    const locks = (
      globalThis.navigator as unknown as { locks: FakeLockManager }
    ).locks;
    expect(
      await saveInventoryOutboundCreationTask(PRINCIPAL_A, createTaskInput()),
    ).toBe(true);

    const results = await Promise.all([
      saveInventoryOutboundCreationTask(
        PRINCIPAL_A,
        createTaskInput({
          status: 'accepted',
          taskId: 'inventory-outbound-task-1',
          updatedAt: NOW + 1,
        }),
        { clientMutationId: 'outbound-create-1', updatedAt: NOW },
      ),
      saveInventoryOutboundCreationTask(
        PRINCIPAL_A,
        createTaskInput({
          status: 'uncertain',
          error: '另一个页面的迟到响应',
          updatedAt: NOW + 2,
        }),
        { clientMutationId: 'outbound-create-1', updatedAt: NOW },
      ),
    ]);

    expect(results).toEqual([true, false]);
    expect(
      await readInventoryOutboundCreationTask(PRINCIPAL_A, NOW + 2),
    ).toMatchObject({
      status: 'accepted',
      taskId: 'inventory-outbound-task-1',
      updatedAt: NOW + 1,
    });
    expect(locks.maxActive).toBe(1);
  });

  it('keeps a concurrent newer version when a stale clear waits behind it', async () => {
    expect(
      await saveInventoryOutboundCreationTask(PRINCIPAL_A, createTaskInput()),
    ).toBe(true);

    const [saved, cleared] = await Promise.all([
      saveInventoryOutboundCreationTask(
        PRINCIPAL_A,
        createTaskInput({
          status: 'accepted',
          taskId: 'inventory-outbound-task-1',
          updatedAt: NOW + 1,
        }),
        { clientMutationId: 'outbound-create-1', updatedAt: NOW },
      ),
      clearInventoryOutboundCreationTask(PRINCIPAL_A, {
        clientMutationId: 'outbound-create-1',
        updatedAt: NOW,
      }),
    ]);

    expect(saved).toBe(true);
    expect(cleared).toBe(false);
    expect(
      await readInventoryOutboundCreationTask(PRINCIPAL_A, NOW + 1),
    ).toMatchObject({
      taskId: 'inventory-outbound-task-1',
      updatedAt: NOW + 1,
    });
  });

  it('serializes a corrupt read with a writer and still fails closed', async () => {
    const locks = (
      globalThis.navigator as unknown as { locks: FakeLockManager }
    ).locks;
    const key = getInventoryOutboundCreationTaskStorageKey(PRINCIPAL_A)!;
    window.localStorage.setItem(key, '{');

    const [readResult, saveResult] = await Promise.all([
      readInventoryOutboundCreationTask(PRINCIPAL_A, NOW),
      saveInventoryOutboundCreationTask(PRINCIPAL_A, createTaskInput()),
    ]);

    expect(readResult).toBeNull();
    expect(saveResult).toBe(false);
    expect(window.localStorage.getItem(key)).toBe('{');
    expect(
      await inspectInventoryOutboundCreationTask(PRINCIPAL_A, NOW),
    ).toEqual({ kind: 'unavailable' });
    expect(locks.maxActive).toBe(1);
  });

  it('rejects a stale same-mutation writer even when it uses a larger timestamp', async () => {
    expect(
      await saveInventoryOutboundCreationTask(PRINCIPAL_A, createTaskInput()),
    ).toBe(true);
    expect(
      await saveInventoryOutboundCreationTask(
        PRINCIPAL_A,
        createTaskInput({
          status: 'accepted',
          taskId: 'inventory-outbound-task-1',
          updatedAt: NOW + 1,
        }),
        { clientMutationId: 'outbound-create-1', updatedAt: NOW },
      ),
    ).toBe(true);

    expect(
      await saveInventoryOutboundCreationTask(
        PRINCIPAL_A,
        createTaskInput({
          status: 'uncertain',
          taskId: null,
          updatedAt: NOW + 100,
          error: '旧标签页迟到响应',
        }),
        { clientMutationId: 'outbound-create-1', updatedAt: NOW },
      ),
    ).toBe(false);
    expect(
      await readInventoryOutboundCreationTask(PRINCIPAL_A, NOW + 100),
    ).toMatchObject({
      status: 'accepted',
      taskId: 'inventory-outbound-task-1',
      updatedAt: NOW + 1,
    });
  });

  it('does not clear a newer same-mutation version and treats an absent key as cleared', async () => {
    expect(
      await saveInventoryOutboundCreationTask(PRINCIPAL_A, createTaskInput()),
    ).toBe(true);
    expect(
      await saveInventoryOutboundCreationTask(
        PRINCIPAL_A,
        createTaskInput({
          status: 'accepted',
          taskId: 'inventory-outbound-task-1',
          updatedAt: NOW + 1,
        }),
        { clientMutationId: 'outbound-create-1', updatedAt: NOW },
      ),
    ).toBe(true);

    expect(
      await clearInventoryOutboundCreationTask(PRINCIPAL_A, {
        clientMutationId: 'outbound-create-1',
        updatedAt: NOW,
      }),
    ).toBe(false);
    expect(
      await readInventoryOutboundCreationTask(PRINCIPAL_A, NOW + 1),
    ).toMatchObject({
      taskId: 'inventory-outbound-task-1',
      updatedAt: NOW + 1,
    });

    window.localStorage.clear();
    expect(
      await clearInventoryOutboundCreationTask(PRINCIPAL_A, {
        clientMutationId: 'outbound-create-1',
        updatedAt: NOW + 1,
      }),
    ).toBe(true);
  });

  it('fails closed when Web Locks are unavailable', async () => {
    uninstallWindow();
    installWindow({ withLocks: false });
    expect(
      await saveInventoryOutboundCreationTask(PRINCIPAL_A, createTaskInput()),
    ).toBe(false);
    expect(
      await readInventoryOutboundCreationTask(PRINCIPAL_A, NOW),
    ).toBeNull();
    expect(
      await clearInventoryOutboundCreationTask(PRINCIPAL_A, {
        clientMutationId: 'outbound-create-1',
        updatedAt: NOW,
      }),
    ).toBe(false);
    expect(window.localStorage.length).toBe(0);
  });

  it('fails closed when lock acquisition rejects', async () => {
    const locks = (
      globalThis.navigator as unknown as { locks: FakeLockManager }
    ).locks;
    locks.rejectRequests = true;

    expect(
      await saveInventoryOutboundCreationTask(PRINCIPAL_A, createTaskInput()),
    ).toBe(false);
    expect(
      await readInventoryOutboundCreationTask(PRINCIPAL_A, NOW),
    ).toBeNull();
    expect(
      await clearInventoryOutboundCreationTask(PRINCIPAL_A, {
        clientMutationId: 'outbound-create-1',
        updatedAt: NOW,
      }),
    ).toBe(false);
    expect(window.localStorage.length).toBe(0);
  });

  it('fails closed when local storage is unavailable inside the lock', async () => {
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get(): Storage {
        throw new Error('storage unavailable');
      },
    });

    expect(
      await saveInventoryOutboundCreationTask(PRINCIPAL_A, createTaskInput()),
    ).toBe(false);
    expect(
      await readInventoryOutboundCreationTask(PRINCIPAL_A, NOW),
    ).toBeNull();
    expect(
      await clearInventoryOutboundCreationTask(PRINCIPAL_A, {
        clientMutationId: 'outbound-create-1',
        updatedAt: NOW,
      }),
    ).toBe(false);
  });

  it('rejects request, draft, optimistic item, and task status inconsistencies', async () => {
    expect(
      await saveInventoryOutboundCreationTask(
        PRINCIPAL_A,
        createTaskInput({
          request: { ...createRequest(), quantity: 3 },
        }),
      ),
    ).toBe(false);
    expect(
      await saveInventoryOutboundCreationTask(
        PRINCIPAL_A,
        createTaskInput({
          optimisticItem: {
            ...createOptimisticItem(),
            clientMutationId: 'other-id',
          },
        }),
      ),
    ).toBe(false);
    expect(
      await saveInventoryOutboundCreationTask(
        PRINCIPAL_A,
        createTaskInput({ status: 'accepted', taskId: null }),
      ),
    ).toBe(false);
  });

  it.each([
    ['invalid json', '{'],
    [
      'unknown field',
      JSON.stringify({
        version: 1,
        ...createTaskInput(),
        unexpected: true,
      }),
    ],
    [
      'oversized payload',
      JSON.stringify({
        padding: 'x'.repeat(INVENTORY_OUTBOUND_CREATION_TASK_MAX_BYTES),
      }),
    ],
  ])('preserves a corrupt %s journal and fails closed', async (_label, raw) => {
    const key = getInventoryOutboundCreationTaskStorageKey(PRINCIPAL_A)!;
    window.localStorage.setItem(key, raw);

    expect(
      await inspectInventoryOutboundCreationTask(PRINCIPAL_A, NOW),
    ).toEqual({ kind: 'unavailable' });
    expect(
      await readInventoryOutboundCreationTask(PRINCIPAL_A, NOW),
    ).toBeNull();
    expect(window.localStorage.getItem(key)).toBe(raw);
    expect(
      await saveInventoryOutboundCreationTask(PRINCIPAL_A, createTaskInput()),
    ).toBe(false);
    expect(window.localStorage.getItem(key)).toBe(raw);
  });

  it('preserves a future-dated journal and fails closed after a clock rollback', async () => {
    const key = getInventoryOutboundCreationTaskStorageKey(PRINCIPAL_A)!;
    const journal = createJournal({
      createdAt: NOW + 5 * 60 * 1000 + 1,
      updatedAt: NOW + 5 * 60 * 1000 + 1,
    });
    const raw = JSON.stringify(journal);
    window.localStorage.setItem(key, raw);

    expect(
      await inspectInventoryOutboundCreationTask(PRINCIPAL_A, NOW),
    ).toEqual({ kind: 'unavailable' });
    expect(
      await readInventoryOutboundCreationTask(PRINCIPAL_A, NOW),
    ).toBeNull();
    expect(window.localStorage.getItem(key)).toBe(raw);
    expect(
      await saveInventoryOutboundCreationTask(PRINCIPAL_A, createTaskInput()),
    ).toBe(false);
    expect(window.localStorage.getItem(key)).toBe(raw);
  });

  it('never expires an unresolved uncertain task with no task id', async () => {
    expect(
      await saveInventoryOutboundCreationTask(
        PRINCIPAL_A,
        createTaskInput({
          status: 'uncertain',
          error: '受理响应未确认',
        }),
      ),
    ).toBe(true);
    expect(
      await readInventoryOutboundCreationTask(
        PRINCIPAL_A,
        NOW + INVENTORY_OUTBOUND_CREATION_TASK_TTL_MS,
      ),
    ).toMatchObject({ status: 'uncertain', taskId: null });
    expect(
      await readInventoryOutboundCreationTask(
        PRINCIPAL_A,
        NOW + INVENTORY_OUTBOUND_CREATION_TASK_TTL_MS + 1,
      ),
    ).toMatchObject({ status: 'uncertain', taskId: null });
  });

  it('clears only the matching principal and mutation', async () => {
    expect(
      await saveInventoryOutboundCreationTask(PRINCIPAL_A, createTaskInput()),
    ).toBe(true);
    expect(
      await clearInventoryOutboundCreationTask(PRINCIPAL_A, {
        clientMutationId: 'other-id',
        updatedAt: NOW,
      }),
    ).toBe(false);
    expect(
      await clearInventoryOutboundCreationTask(PRINCIPAL_B, {
        clientMutationId: 'outbound-create-1',
        updatedAt: NOW,
      }),
    ).toBe(true);
    expect(
      await clearInventoryOutboundCreationTask(PRINCIPAL_A, {
        clientMutationId: 'outbound-create-1',
        updatedAt: NOW,
      }),
    ).toBe(true);
    expect(
      await readInventoryOutboundCreationTask(PRINCIPAL_A, NOW),
    ).toBeNull();
  });

  it('migrates only a matching legacy create recovery and leaves confirmation recovery untouched', async () => {
    expect(
      saveInventoryOutboundRecovery({
        kind: 'create',
        status: 'unknown',
        clientMutationId: 'outbound-create-1',
        draft: createDraft(),
        itemSnapshot: {
          ...createOptimisticItem(),
          status: '待库房确认',
        },
        updatedAt: NOW,
      }),
    ).toBe(true);

    expect(
      await migrateLegacyInventoryOutboundCreateRecovery(
        PRINCIPAL_A,
        createRequest(),
        NOW,
      ),
    ).toBe(true);
    expect(
      await readInventoryOutboundCreationTask(PRINCIPAL_A, NOW),
    ).toMatchObject({
      status: 'uncertain',
      taskId: null,
      clientMutationId: 'outbound-create-1',
    });
    expect(
      window.sessionStorage.getItem(INVENTORY_OUTBOUND_RECOVERY_STORAGE_KEY),
    ).toBeNull();

    await clearInventoryOutboundCreationTask(PRINCIPAL_A, {
      clientMutationId: 'outbound-create-1',
      updatedAt: NOW,
    });
    expect(
      saveInventoryOutboundRecovery({
        kind: 'confirm',
        status: 'unknown',
        clientMutationId: 'outbound-confirm-1',
        recordId: 'outbound-record-1',
        draft: { note: '库房确认' },
        itemSnapshot: {
          ...createOptimisticItem('outbound-confirm-1'),
          recordId: 'outbound-record-1',
          pendingSync: false,
          status: '待库房确认',
        },
        updatedAt: NOW + 1,
      }),
    ).toBe(true);

    expect(
      await migrateLegacyInventoryOutboundCreateRecovery(
        PRINCIPAL_A,
        createRequest(),
        NOW + 1,
      ),
    ).toBe(false);
    expect(
      window.sessionStorage.getItem(INVENTORY_OUTBOUND_RECOVERY_STORAGE_KEY),
    ).not.toBeNull();
  });
});

describe('inventory outbound creation terminal receipts', () => {
  beforeEach(() => {
    installWindow();
  });

  afterEach(() => {
    uninstallWindow();
  });

  async function persistActive(
    overrides: Partial<InventoryOutboundCreationTaskInput> = {},
  ): Promise<InventoryOutboundCreationTaskJournal> {
    const input = createTaskInput(overrides);
    expect(await saveInventoryOutboundCreationTask(PRINCIPAL_A, input)).toBe(
      true,
    );
    return createJournal(input);
  }

  it('writes and verifies a completed receipt before precisely deleting the active journal', async () => {
    const journal = await persistActive({
      status: 'accepted',
      taskId: 'outbound-task-1',
    });

    const finalized = await finalizeInventoryOutboundCreationTask(
      PRINCIPAL_A,
      journal,
      { kind: 'completed', result: createCompletedResult() },
      NOW + 10,
    );

    expect(finalized).toMatchObject({
      kind: 'terminal',
      receipt: {
        version: 1,
        principalFingerprint: PRINCIPAL_A,
        clientMutationId: 'outbound-create-1',
        journalCreatedAt: NOW,
        terminalFromUpdatedAt: NOW,
        taskId: 'outbound-task-1',
        terminalAt: NOW + 10,
        expiresAt:
          NOW + 10 + INVENTORY_OUTBOUND_CREATION_TERMINAL_RECEIPT_TTL_MS,
        outcome: { kind: 'completed' },
        recovery: null,
        recoveryConsumedAt: null,
      },
    });
    expect(
      await readInventoryOutboundCreationTask(PRINCIPAL_A, NOW + 10),
    ).toBeNull();
    expect(
      await resolveInventoryOutboundCreationTask(
        PRINCIPAL_A,
        createTerminalExpectation(journal),
        NOW + 10,
      ),
    ).toMatchObject({ kind: 'terminal' });
  });

  it.each(['待路由', '待审批', '待库房确认', '已驳回', '已出库'] as const)(
    'persists a canonical completed receipt with outbound status %s',
    async (status) => {
      const journal = await persistActive({
        status: 'accepted',
        taskId: 'outbound-task-1',
      });
      const result = createCompletedResult();
      result.movement.status = status;

      await expect(
        finalizeInventoryOutboundCreationTask(
          PRINCIPAL_A,
          journal,
          { kind: 'completed', result: result as never },
          NOW + 10,
        ),
      ).resolves.toMatchObject({
        kind: 'terminal',
        receipt: {
          outcome: { kind: 'completed', result: { movement: { status } } },
        },
      });
    },
  );

  it('finalizes one accepted task without deleting a newer task from the queue', async () => {
    const first = await persistActive({
      status: 'accepted',
      taskId: 'outbound-task-1',
    });
    const secondInput = createTaskInput({
      clientMutationId: 'outbound-create-2',
      status: 'accepted',
      taskId: 'outbound-task-2',
      request: createRequest('outbound-create-2'),
      draft: createDraft('outbound-create-2'),
      optimisticItem: createOptimisticItem('outbound-create-2'),
      createdAt: NOW + 1,
      updatedAt: NOW + 1,
    });
    expect(
      await saveInventoryOutboundCreationTask(PRINCIPAL_A, secondInput),
    ).toBe(true);

    expect(
      await finalizeInventoryOutboundCreationTask(
        PRINCIPAL_A,
        first,
        { kind: 'completed', result: createCompletedResult() },
        NOW + 10,
      ),
    ).toMatchObject({ kind: 'terminal' });
    expect(
      await readInventoryOutboundCreationTasks(PRINCIPAL_A, NOW + 10),
    ).toEqual([
      expect.objectContaining({
        clientMutationId: 'outbound-create-2',
        taskId: 'outbound-task-2',
      }),
    ]);
  });

  it('refuses to recreate an active journal when the same mutation already has a terminal receipt', async () => {
    const journal = await persistActive();
    const finalized = await finalizeInventoryOutboundCreationTask(
      PRINCIPAL_A,
      journal,
      { kind: 'completed', result: createCompletedResult() },
      NOW + 1,
    );
    expect(finalized).toMatchObject({ kind: 'terminal' });

    expect(
      await saveInventoryOutboundCreationTask(PRINCIPAL_A, createTaskInput()),
    ).toBe(false);
    expect(
      await readInventoryOutboundCreationTask(PRINCIPAL_A, NOW + 2),
    ).toBeNull();
    expect(
      await resolveInventoryOutboundCreationTask(
        PRINCIPAL_A,
        createTerminalExpectation(journal),
        NOW + 2,
      ),
    ).toMatchObject({ kind: 'terminal' });
  });

  it('persists a complete recovery snapshot only for a definitely-not-written receipt', async () => {
    const journal = await persistActive();

    const finalized = await finalizeInventoryOutboundCreationTask(
      PRINCIPAL_A,
      journal,
      {
        kind: 'failed',
        definitelyNotWritten: true,
        message: '明确未写入',
      },
      NOW + 1,
    );

    expect(finalized).toMatchObject({
      kind: 'terminal',
      receipt: {
        outcome: { kind: 'failed', definitelyNotWritten: true },
        recovery: {
          draft: journal.draft,
          optimisticItem: journal.optimisticItem,
        },
      },
    });
  });

  it('lets all tabs recover before a principal-global exact consumption mark', async () => {
    const localStorage = window.localStorage;
    const journal = await persistActive();
    const finalized = await finalizeInventoryOutboundCreationTask(
      PRINCIPAL_A,
      journal,
      {
        kind: 'failed',
        definitelyNotWritten: true,
        message: '明确未写入',
      },
      NOW + 1,
    );
    expect(finalized).toMatchObject({ kind: 'terminal' });
    if (finalized.kind !== 'terminal') throw new Error('expected terminal');

    expect(
      await readUnconsumedInventoryOutboundCreationFailedReceipt(
        PRINCIPAL_A,
        NOW + 1,
      ),
    ).toMatchObject({
      kind: 'failed-recovery',
      receipt: {
        clientMutationId: journal.clientMutationId,
        recovery: { draft: journal.draft },
      },
    });
    expect(
      await readUnconsumedInventoryOutboundCreationFailedReceipt(
        PRINCIPAL_A,
        NOW + 1,
      ),
    ).toMatchObject({ kind: 'failed-recovery' });

    uninstallWindow();
    installWindow({ localStorage, sessionStorage: new MemoryStorage() });
    expect(
      await readUnconsumedInventoryOutboundCreationFailedReceipt(
        PRINCIPAL_A,
        NOW + 1,
      ),
    ).toMatchObject({ kind: 'failed-recovery' });
    expect(
      await markInventoryOutboundCreationFailedReceiptConsumed(
        PRINCIPAL_A,
        finalized.receipt,
        NOW + 1,
      ),
    ).toBe(true);
    expect(
      await readUnconsumedInventoryOutboundCreationFailedReceipt(
        PRINCIPAL_A,
        NOW + 1,
      ),
    ).toEqual({ kind: 'none' });

    uninstallWindow();
    installWindow({ localStorage, sessionStorage: new MemoryStorage() });
    expect(
      await readUnconsumedInventoryOutboundCreationFailedReceipt(
        PRINCIPAL_A,
        NOW + 1,
      ),
    ).toEqual({ kind: 'none' });
  });

  it('fails closed when the global consumption write fails and leaves recovery available', async () => {
    class ToggleReceiptWriteFailureStorage extends MemoryStorage {
      failReceiptWrites = false;

      override setItem(key: string, value: string): void {
        if (
          this.failReceiptWrites &&
          key.startsWith(
            INVENTORY_OUTBOUND_CREATION_TERMINAL_RECEIPT_STORAGE_PREFIX,
          )
        ) {
          throw new Error('quota exceeded');
        }
        super.setItem(key, value);
      }
    }
    const storage = new ToggleReceiptWriteFailureStorage();
    uninstallWindow();
    installWindow({ localStorage: storage });
    const journal = await persistActive();
    const finalized = await finalizeInventoryOutboundCreationTask(
      PRINCIPAL_A,
      journal,
      {
        kind: 'failed',
        definitelyNotWritten: true,
        message: '明确未写入',
      },
      NOW + 1,
    );
    if (finalized.kind !== 'terminal') throw new Error('expected terminal');
    storage.failReceiptWrites = true;

    expect(
      await markInventoryOutboundCreationFailedReceiptConsumed(
        PRINCIPAL_A,
        finalized.receipt,
        NOW + 2,
      ),
    ).toBe(false);
    expect(
      await readUnconsumedInventoryOutboundCreationFailedReceipt(
        PRINCIPAL_A,
        NOW + 2,
      ),
    ).toMatchObject({ kind: 'failed-recovery' });
  });

  it('atomically saves a recovered new journal and globally consumes the old failed receipt', async () => {
    const oldJournal = await persistActive();
    const finalized = await finalizeInventoryOutboundCreationTask(
      PRINCIPAL_A,
      oldJournal,
      {
        kind: 'failed',
        definitelyNotWritten: true,
        message: '明确未写入',
      },
      NOW + 1,
    );
    if (finalized.kind !== 'terminal') throw new Error('expected terminal');
    const nextMutation = 'outbound-create-2';
    const nextInput = createTaskInput({
      clientMutationId: nextMutation,
      request: createRequest(nextMutation),
      draft: createDraft(nextMutation),
      optimisticItem: createOptimisticItem(nextMutation),
      createdAt: NOW + 2,
      updatedAt: NOW + 2,
      recoveredFromFailedReceipt: createFailedReceiptIdentity(
        finalized.receipt,
      ),
    });

    expect(
      await saveInventoryOutboundCreationTask(PRINCIPAL_A, nextInput),
    ).toBe(true);
    expect(
      await readInventoryOutboundCreationTask(PRINCIPAL_A, NOW + 2),
    ).toMatchObject({
      clientMutationId: nextMutation,
      recoveredFromFailedReceipt: createFailedReceiptIdentity(
        finalized.receipt,
      ),
    });
    expect(
      await readUnconsumedInventoryOutboundCreationFailedReceipt(
        PRINCIPAL_A,
        NOW + 2,
      ),
    ).toEqual({ kind: 'none' });
  });

  it('repairs a crash-written lineage journal before resolving it as active', async () => {
    const oldJournal = await persistActive();
    const finalized = await finalizeInventoryOutboundCreationTask(
      PRINCIPAL_A,
      oldJournal,
      {
        kind: 'failed',
        definitelyNotWritten: true,
        message: '明确未写入',
      },
      NOW + 1,
    );
    if (finalized.kind !== 'terminal') throw new Error('expected terminal');
    const nextMutation = 'outbound-create-2';
    const crashJournal = createJournal({
      clientMutationId: nextMutation,
      request: createRequest(nextMutation),
      draft: createDraft(nextMutation),
      optimisticItem: createOptimisticItem(nextMutation),
      createdAt: NOW + 2,
      updatedAt: NOW + 2,
      recoveredFromFailedReceipt: createFailedReceiptIdentity(
        finalized.receipt,
      ),
    });
    window.localStorage.setItem(
      getInventoryOutboundCreationTaskStorageKey(PRINCIPAL_A)!,
      JSON.stringify(crashJournal),
    );

    expect(
      await resolveInventoryOutboundCreationTask(
        PRINCIPAL_A,
        createTerminalExpectation(crashJournal),
        NOW + 2,
      ),
    ).toMatchObject({
      kind: 'active',
      journal: { clientMutationId: nextMutation },
    });
    expect(
      await readUnconsumedInventoryOutboundCreationFailedReceipt(
        PRINCIPAL_A,
        NOW + 2,
      ),
    ).toEqual({ kind: 'none' });
  });

  it('fails closed and retains a crash-written lineage journal when repair cannot persist', async () => {
    class ToggleReceiptWriteFailureStorage extends MemoryStorage {
      failReceiptWrites = false;

      override setItem(key: string, value: string): void {
        if (
          this.failReceiptWrites &&
          key.startsWith(
            INVENTORY_OUTBOUND_CREATION_TERMINAL_RECEIPT_STORAGE_PREFIX,
          )
        ) {
          throw new Error('quota exceeded');
        }
        super.setItem(key, value);
      }
    }
    const storage = new ToggleReceiptWriteFailureStorage();
    uninstallWindow();
    installWindow({ localStorage: storage });
    const oldJournal = await persistActive();
    const finalized = await finalizeInventoryOutboundCreationTask(
      PRINCIPAL_A,
      oldJournal,
      {
        kind: 'failed',
        definitelyNotWritten: true,
        message: '明确未写入',
      },
      NOW + 1,
    );
    if (finalized.kind !== 'terminal') throw new Error('expected terminal');
    const nextMutation = 'outbound-create-2';
    const crashJournal = createJournal({
      clientMutationId: nextMutation,
      request: createRequest(nextMutation),
      draft: createDraft(nextMutation),
      optimisticItem: createOptimisticItem(nextMutation),
      createdAt: NOW + 2,
      updatedAt: NOW + 2,
      recoveredFromFailedReceipt: createFailedReceiptIdentity(
        finalized.receipt,
      ),
    });
    storage.setItem(
      getInventoryOutboundCreationTaskStorageKey(PRINCIPAL_A)!,
      JSON.stringify(crashJournal),
    );
    storage.failReceiptWrites = true;

    expect(
      await resolveInventoryOutboundCreationTask(
        PRINCIPAL_A,
        createTerminalExpectation(crashJournal),
        NOW + 2,
      ),
    ).toEqual({ kind: 'unavailable' });
    expect(
      await readInventoryOutboundCreationTask(PRINCIPAL_A, NOW + 2),
    ).toEqual(crashJournal);
  });

  it('does not revive the old failed recovery after the recovered new task completes', async () => {
    const oldJournal = await persistActive();
    const failed = await finalizeInventoryOutboundCreationTask(
      PRINCIPAL_A,
      oldJournal,
      {
        kind: 'failed',
        definitelyNotWritten: true,
        message: '明确未写入',
      },
      NOW + 1,
    );
    if (failed.kind !== 'terminal') throw new Error('expected terminal');
    const nextMutation = 'outbound-create-2';
    const nextInput = createTaskInput({
      clientMutationId: nextMutation,
      request: createRequest(nextMutation),
      draft: createDraft(nextMutation),
      optimisticItem: createOptimisticItem(nextMutation),
      createdAt: NOW + 2,
      updatedAt: NOW + 2,
      recoveredFromFailedReceipt: createFailedReceiptIdentity(failed.receipt),
    });
    expect(
      await saveInventoryOutboundCreationTask(PRINCIPAL_A, nextInput),
    ).toBe(true);
    const nextJournal = createJournal(nextInput);
    expect(
      await finalizeInventoryOutboundCreationTask(
        PRINCIPAL_A,
        nextJournal,
        {
          kind: 'completed',
          result: createCompletedResultFor(nextMutation),
        },
        NOW + 3,
      ),
    ).toMatchObject({ kind: 'terminal' });

    expect(
      await readUnconsumedInventoryOutboundCreationFailedReceipt(
        PRINCIPAL_A,
        NOW + 3,
      ),
    ).toEqual({ kind: 'none' });
  });

  it('keeps a recovered active task resumable after its consumed source receipt expires', async () => {
    const oldJournal = await persistActive();
    const failed = await finalizeInventoryOutboundCreationTask(
      PRINCIPAL_A,
      oldJournal,
      {
        kind: 'failed',
        definitelyNotWritten: true,
        message: '明确未写入',
      },
      NOW + 1,
    );
    if (failed.kind !== 'terminal') throw new Error('expected terminal');
    const nextMutation = 'outbound-create-after-receipt-expiry';
    const nextInput = createTaskInput({
      clientMutationId: nextMutation,
      request: createRequest(nextMutation),
      draft: createDraft(nextMutation),
      optimisticItem: createOptimisticItem(nextMutation),
      createdAt: NOW + 2,
      updatedAt: NOW + 2,
      recoveredFromFailedReceipt: createFailedReceiptIdentity(failed.receipt),
    });
    expect(
      await saveInventoryOutboundCreationTask(PRINCIPAL_A, nextInput),
    ).toBe(true);
    const nextJournal = createJournal(nextInput);
    const afterReceiptExpiry = failed.receipt.expiresAt + 1;

    expect(
      await resolveInventoryOutboundCreationTask(
        PRINCIPAL_A,
        createTerminalExpectation(nextJournal),
        afterReceiptExpiry,
      ),
    ).toMatchObject({
      kind: 'active',
      journal: { clientMutationId: nextMutation },
    });
    expect(
      await readUnconsumedInventoryOutboundCreationFailedReceipt(
        PRINCIPAL_A,
        afterReceiptExpiry,
      ),
    ).toEqual({ kind: 'none' });
  });

  it('never bootstraps completed receipts or another principal failed receipt', async () => {
    const completedJournal = await persistActive();
    await finalizeInventoryOutboundCreationTask(
      PRINCIPAL_A,
      completedJournal,
      { kind: 'completed', result: createCompletedResult() },
      NOW + 1,
    );
    expect(
      await readUnconsumedInventoryOutboundCreationFailedReceipt(
        PRINCIPAL_A,
        NOW + 1,
      ),
    ).toEqual({ kind: 'none' });
    expect(
      await readUnconsumedInventoryOutboundCreationFailedReceipt(
        PRINCIPAL_B,
        NOW + 1,
      ),
    ).toEqual({ kind: 'none' });
  });

  it('keeps the active journal and emits no terminal proof when receipt persistence fails', async () => {
    class ReceiptWriteFailureStorage extends MemoryStorage {
      override setItem(key: string, value: string): void {
        if (
          key.startsWith(
            INVENTORY_OUTBOUND_CREATION_TERMINAL_RECEIPT_STORAGE_PREFIX,
          )
        ) {
          throw new Error('quota exceeded');
        }
        super.setItem(key, value);
      }
    }
    uninstallWindow();
    installWindow({ localStorage: new ReceiptWriteFailureStorage() });
    const journal = await persistActive();

    expect(
      await finalizeInventoryOutboundCreationTask(
        PRINCIPAL_A,
        journal,
        {
          kind: 'failed',
          definitelyNotWritten: true,
          message: '明确未写入',
        },
        NOW + 10,
      ),
    ).toEqual({ kind: 'unavailable' });
    expect(
      await readInventoryOutboundCreationTask(PRINCIPAL_A, NOW + 10),
    ).toEqual(journal);
  });

  it('retries exact active cleanup after a one-shot terminal delete failure and allows the next mutation', async () => {
    class OneShotActiveDeleteFailureStorage extends MemoryStorage {
      private failed = false;

      override removeItem(key: string): void {
        if (
          !this.failed &&
          key === getInventoryOutboundCreationTaskStorageKey(PRINCIPAL_A)
        ) {
          this.failed = true;
          return;
        }
        super.removeItem(key);
      }
    }
    uninstallWindow();
    installWindow({ localStorage: new OneShotActiveDeleteFailureStorage() });
    const journal = await persistActive();

    expect(
      await finalizeInventoryOutboundCreationTask(
        PRINCIPAL_A,
        journal,
        {
          kind: 'failed',
          definitelyNotWritten: true,
          message: '明确未写入',
        },
        NOW + 10,
      ),
    ).toEqual({ kind: 'unavailable' });
    expect(
      await readInventoryOutboundCreationTask(PRINCIPAL_A, NOW + 10),
    ).toEqual(journal);
    expect(
      await resolveInventoryOutboundCreationTask(
        PRINCIPAL_A,
        createTerminalExpectation(journal),
        NOW + 10,
      ),
    ).toMatchObject({
      kind: 'terminal',
      receipt: { outcome: { kind: 'failed', definitelyNotWritten: true } },
    });
    expect(
      await readInventoryOutboundCreationTask(PRINCIPAL_A, NOW + 10),
    ).toBeNull();

    const nextMutation = 'outbound-create-after-terminal-cleanup';
    expect(
      await saveInventoryOutboundCreationTask(
        PRINCIPAL_A,
        createTaskInput({
          clientMutationId: nextMutation,
          request: createRequest(nextMutation),
          draft: createDraft(nextMutation),
          optimisticItem: createOptimisticItem(nextMutation),
          createdAt: NOW + 11,
          updatedAt: NOW + 11,
        }),
      ),
    ).toBe(true);
  });

  it('stays unavailable when terminal active cleanup keeps failing and never overwrites it', async () => {
    class PersistentActiveDeleteFailureStorage extends MemoryStorage {
      override removeItem(key: string): void {
        if (key === getInventoryOutboundCreationTaskStorageKey(PRINCIPAL_A)) {
          return;
        }
        super.removeItem(key);
      }
    }
    uninstallWindow();
    installWindow({
      localStorage: new PersistentActiveDeleteFailureStorage(),
    });
    const journal = await persistActive();
    expect(
      await finalizeInventoryOutboundCreationTask(
        PRINCIPAL_A,
        journal,
        { kind: 'completed', result: createCompletedResult() },
        NOW + 10,
      ),
    ).toEqual({ kind: 'unavailable' });
    expect(
      await resolveInventoryOutboundCreationTask(
        PRINCIPAL_A,
        createTerminalExpectation(journal),
        NOW + 10,
      ),
    ).toEqual({ kind: 'unavailable' });
    expect(
      await readInventoryOutboundCreationTask(PRINCIPAL_A, NOW + 10),
    ).toEqual(journal);

    const nextMutation = 'outbound-create-must-not-overwrite-terminal-active';
    expect(
      await saveInventoryOutboundCreationTask(
        PRINCIPAL_A,
        createTaskInput({
          clientMutationId: nextMutation,
          request: createRequest(nextMutation),
          draft: createDraft(nextMutation),
          optimisticItem: createOptimisticItem(nextMutation),
          createdAt: NOW + 11,
          updatedAt: NOW + 11,
        }),
      ),
    ).toBe(false);
  });

  it('lets an older no-task follower consume a later accepted receipt with a task id', async () => {
    const follower = await persistActive();
    const accepted = createJournal({
      status: 'accepted',
      taskId: 'outbound-task-1',
      updatedAt: NOW + 1,
    });
    const { version: _acceptedVersion, ...acceptedInput } = accepted;
    expect(
      await saveInventoryOutboundCreationTask(PRINCIPAL_A, acceptedInput, {
        clientMutationId: follower.clientMutationId,
        updatedAt: NOW,
      }),
    ).toBe(true);
    expect(
      await finalizeInventoryOutboundCreationTask(
        PRINCIPAL_A,
        accepted,
        { kind: 'completed', result: createCompletedResult() },
        NOW + 2,
      ),
    ).toMatchObject({ kind: 'terminal' });

    expect(
      await resolveInventoryOutboundCreationTask(
        PRINCIPAL_A,
        createTerminalExpectation(follower),
        NOW + 2,
      ),
    ).toMatchObject({
      kind: 'terminal',
      receipt: {
        terminalFromUpdatedAt: NOW + 1,
        taskId: 'outbound-task-1',
      },
    });
  });

  it('resolves an old follower from receipt when crash-active matches the receipt terminal version', async () => {
    class OneShotActiveDeleteFailureStorage extends MemoryStorage {
      private failed = false;

      override removeItem(key: string): void {
        if (
          !this.failed &&
          key === getInventoryOutboundCreationTaskStorageKey(PRINCIPAL_A)
        ) {
          this.failed = true;
          return;
        }
        super.removeItem(key);
      }
    }
    uninstallWindow();
    installWindow({ localStorage: new OneShotActiveDeleteFailureStorage() });
    const follower = await persistActive();
    const accepted = createJournal({
      status: 'accepted',
      taskId: 'outbound-task-1',
      updatedAt: NOW + 1,
    });
    const { version: _acceptedVersion, ...acceptedInput } = accepted;
    expect(
      await saveInventoryOutboundCreationTask(PRINCIPAL_A, acceptedInput, {
        clientMutationId: follower.clientMutationId,
        updatedAt: NOW,
      }),
    ).toBe(true);
    await finalizeInventoryOutboundCreationTask(
      PRINCIPAL_A,
      accepted,
      { kind: 'completed', result: createCompletedResult() },
      NOW + 2,
    );

    expect(
      await resolveInventoryOutboundCreationTask(
        PRINCIPAL_A,
        createTerminalExpectation(follower),
        NOW + 2,
      ),
    ).toMatchObject({ kind: 'terminal' });
  });

  it('does not delete a journal changed by a non-cooperating CAS race after receipt write', async () => {
    const storage = new MemoryStorage();
    uninstallWindow();
    installWindow({ localStorage: storage });
    const journal = await persistActive();
    const receiptKey = `${INVENTORY_OUTBOUND_CREATION_TERMINAL_RECEIPT_STORAGE_PREFIX}:${PRINCIPAL_A}`;
    const activeKey = getInventoryOutboundCreationTaskStorageKey(PRINCIPAL_A)!;
    const originalSet = storage.setItem.bind(storage);
    jest.spyOn(storage, 'setItem').mockImplementation((key, value) => {
      originalSet(key, value);
      if (key === receiptKey) {
        originalSet(
          activeKey,
          JSON.stringify(
            createJournal({
              status: 'uncertain',
              updatedAt: NOW + 20,
              error: '另一标签页的新状态',
            }),
          ),
        );
      }
    });

    expect(
      await finalizeInventoryOutboundCreationTask(
        PRINCIPAL_A,
        journal,
        { kind: 'completed', result: createCompletedResult() },
        NOW + 10,
      ),
    ).toMatchObject({ kind: 'conflict' });
    expect(
      await readInventoryOutboundCreationTask(PRINCIPAL_A, NOW + 20),
    ).toMatchObject({ updatedAt: NOW + 20, error: '另一标签页的新状态' });
  });

  it('isolates principals and fails closed for stale lifecycle, request, or task bindings', async () => {
    const journal = await persistActive({
      status: 'accepted',
      taskId: 'outbound-task-1',
    });
    await finalizeInventoryOutboundCreationTask(
      PRINCIPAL_A,
      journal,
      { kind: 'completed', result: createCompletedResult() },
      NOW + 10,
    );

    expect(
      await resolveInventoryOutboundCreationTask(
        PRINCIPAL_B,
        createTerminalExpectation(journal),
        NOW + 10,
      ),
    ).toEqual({ kind: 'missing' });
    expect(
      await resolveInventoryOutboundCreationTask(
        PRINCIPAL_A,
        { ...createTerminalExpectation(journal), journalCreatedAt: NOW - 1 },
        NOW + 10,
      ),
    ).toMatchObject({ kind: 'conflict' });
    expect(
      await resolveInventoryOutboundCreationTask(
        PRINCIPAL_A,
        {
          ...createTerminalExpectation(journal),
          request: { ...journal.request, reason: '另一用途' },
        },
        NOW + 10,
      ),
    ).toMatchObject({ kind: 'conflict' });
    expect(
      await resolveInventoryOutboundCreationTask(
        PRINCIPAL_A,
        { ...createTerminalExpectation(journal), taskId: 'stale-task' },
        NOW + 10,
      ),
    ).toMatchObject({ kind: 'conflict' });
  });

  it('expires receipts after seven days without deleting an unrelated active journal', async () => {
    const journal = await persistActive();
    await finalizeInventoryOutboundCreationTask(
      PRINCIPAL_A,
      journal,
      { kind: 'completed', result: createCompletedResult() },
      NOW,
    );
    await persistActive({
      clientMutationId: 'outbound-create-2',
      request: createRequest('outbound-create-2'),
      draft: createDraft('outbound-create-2'),
      optimisticItem: createOptimisticItem('outbound-create-2'),
      createdAt: NOW + 1,
      updatedAt: NOW + 1,
    });

    expect(
      await resolveInventoryOutboundCreationTask(
        PRINCIPAL_A,
        createTerminalExpectation(journal),
        NOW + INVENTORY_OUTBOUND_CREATION_TERMINAL_RECEIPT_TTL_MS + 1,
      ),
    ).toEqual({ kind: 'missing' });
  });

  it('rejects finalization before the journal version time and future receipt reads', async () => {
    const journal = await persistActive({ updatedAt: NOW + 1 });
    expect(
      await finalizeInventoryOutboundCreationTask(
        PRINCIPAL_A,
        journal,
        { kind: 'completed', result: createCompletedResult() },
        NOW,
      ),
    ).toEqual({ kind: 'unavailable' });
    expect(
      await readInventoryOutboundCreationTask(PRINCIPAL_A, NOW + 1),
    ).toEqual(journal);

    expect(
      await finalizeInventoryOutboundCreationTask(
        PRINCIPAL_A,
        journal,
        { kind: 'completed', result: createCompletedResult() },
        NOW + 1 + 5 * 60 * 1000 + 1,
      ),
    ).toMatchObject({ kind: 'terminal' });
    expect(
      await resolveInventoryOutboundCreationTask(
        PRINCIPAL_A,
        createTerminalExpectation(journal),
        NOW + 1,
      ),
    ).toEqual({ kind: 'unavailable' });
  });

  it('caps valid receipts and keeps the serialized store within its byte budget', async () => {
    for (
      let index = 0;
      index < INVENTORY_OUTBOUND_CREATION_TERMINAL_RECEIPT_MAX_ENTRIES + 2;
      index += 1
    ) {
      const mutation = `outbound-create-${index}`;
      const journal = await persistActive({
        clientMutationId: mutation,
        request: createRequest(mutation),
        draft: createDraft(mutation),
        optimisticItem: createOptimisticItem(mutation),
        createdAt: NOW + index,
        updatedAt: NOW + index,
      });
      expect(
        await finalizeInventoryOutboundCreationTask(
          PRINCIPAL_A,
          journal,
          { kind: 'completed', result: createCompletedResultFor(mutation) },
          NOW + index + 1,
        ),
      ).toMatchObject({ kind: 'terminal' });
    }

    const receiptKey = `${INVENTORY_OUTBOUND_CREATION_TERMINAL_RECEIPT_STORAGE_PREFIX}:${PRINCIPAL_A}`;
    const raw = window.localStorage.getItem(receiptKey)!;
    const stored = JSON.parse(raw) as { receipts: unknown[] };
    expect(stored.receipts).toHaveLength(
      INVENTORY_OUTBOUND_CREATION_TERMINAL_RECEIPT_MAX_ENTRIES,
    );
    expect(new TextEncoder().encode(raw).byteLength).toBeLessThanOrEqual(
      INVENTORY_OUTBOUND_CREATION_TERMINAL_RECEIPT_STORAGE_MAX_BYTES,
    );
  });

  it('never evicts an unconsumed failed recovery receipt to make room', async () => {
    for (
      let index = 0;
      index < INVENTORY_OUTBOUND_CREATION_TERMINAL_RECEIPT_MAX_ENTRIES;
      index += 1
    ) {
      const mutation = `outbound-failed-${index}`;
      const journal = await persistActive({
        clientMutationId: mutation,
        request: createRequest(mutation),
        draft: createDraft(mutation),
        optimisticItem: createOptimisticItem(mutation),
        createdAt: NOW + index,
        updatedAt: NOW + index,
      });
      expect(
        await finalizeInventoryOutboundCreationTask(
          PRINCIPAL_A,
          journal,
          {
            kind: 'failed',
            definitelyNotWritten: true,
            message: `明确未写入 ${index}`,
          },
          NOW + index + 1,
        ),
      ).toMatchObject({ kind: 'terminal' });
    }

    const overflowMutation = 'outbound-completed-overflow';
    const overflowJournal = await persistActive({
      clientMutationId: overflowMutation,
      request: createRequest(overflowMutation),
      draft: createDraft(overflowMutation),
      optimisticItem: createOptimisticItem(overflowMutation),
      createdAt: NOW + INVENTORY_OUTBOUND_CREATION_TERMINAL_RECEIPT_MAX_ENTRIES,
      updatedAt: NOW + INVENTORY_OUTBOUND_CREATION_TERMINAL_RECEIPT_MAX_ENTRIES,
    });
    expect(
      await finalizeInventoryOutboundCreationTask(
        PRINCIPAL_A,
        overflowJournal,
        {
          kind: 'completed',
          result: createCompletedResultFor(overflowMutation),
        },
        NOW + INVENTORY_OUTBOUND_CREATION_TERMINAL_RECEIPT_MAX_ENTRIES + 1,
      ),
    ).toEqual({ kind: 'unavailable' });

    const receiptKey = `${INVENTORY_OUTBOUND_CREATION_TERMINAL_RECEIPT_STORAGE_PREFIX}:${PRINCIPAL_A}`;
    const stored = JSON.parse(window.localStorage.getItem(receiptKey)!) as {
      receipts: Array<{
        clientMutationId: string;
        outcome: { kind: string };
        recoveryConsumedAt: number | null;
      }>;
    };
    expect(stored.receipts).toHaveLength(
      INVENTORY_OUTBOUND_CREATION_TERMINAL_RECEIPT_MAX_ENTRIES,
    );
    expect(
      stored.receipts.every(
        (receipt) =>
          receipt.outcome.kind === 'failed' &&
          receipt.recoveryConsumedAt === null,
      ),
    ).toBe(true);
    expect(
      stored.receipts.some(
        (receipt) => receipt.clientMutationId === 'outbound-failed-0',
      ),
    ).toBe(true);
    expect(
      await readInventoryOutboundCreationTask(
        PRINCIPAL_A,
        NOW + INVENTORY_OUTBOUND_CREATION_TERMINAL_RECEIPT_MAX_ENTRIES + 1,
      ),
    ).toEqual(overflowJournal);
  });

  it('rejects an oversized single receipt while retaining active state', async () => {
    const journal = await persistActive();
    const oversized = createCompletedResult();
    oversized.message = 'x'.repeat(
      INVENTORY_OUTBOUND_CREATION_TERMINAL_RECEIPT_MAX_BYTES,
    );

    expect(
      await finalizeInventoryOutboundCreationTask(
        PRINCIPAL_A,
        journal,
        { kind: 'completed', result: oversized },
        NOW + 1,
      ),
    ).toEqual({ kind: 'unavailable' });
    expect(
      await readInventoryOutboundCreationTask(PRINCIPAL_A, NOW + 1),
    ).toEqual(journal);
  });

  it('fails closed on a corrupt receipt store and never deletes active', async () => {
    const journal = await persistActive();
    const receiptKey = `${INVENTORY_OUTBOUND_CREATION_TERMINAL_RECEIPT_STORAGE_PREFIX}:${PRINCIPAL_A}`;
    window.localStorage.setItem(receiptKey, '{');

    expect(
      await resolveInventoryOutboundCreationTask(
        PRINCIPAL_A,
        createTerminalExpectation(journal),
        NOW,
      ),
    ).toEqual({ kind: 'unavailable' });
    expect(
      await finalizeInventoryOutboundCreationTask(
        PRINCIPAL_A,
        journal,
        {
          kind: 'failed',
          definitelyNotWritten: true,
          message: '明确未写入',
        },
        NOW + 1,
      ),
    ).toEqual({ kind: 'unavailable' });
    expect(
      await readInventoryOutboundCreationTask(PRINCIPAL_A, NOW + 1),
    ).toEqual(journal);
  });

  it('returns unavailable rather than ambiguous null when Web Locks are absent', async () => {
    const journal = await persistActive();
    uninstallWindow();
    installWindow({ withLocks: false });

    expect(
      await resolveInventoryOutboundCreationTask(
        PRINCIPAL_A,
        createTerminalExpectation(journal),
        NOW,
      ),
    ).toEqual({ kind: 'unavailable' });
    expect(
      await finalizeInventoryOutboundCreationTask(
        PRINCIPAL_A,
        journal,
        { kind: 'completed', result: createCompletedResult() },
        NOW + 1,
      ),
    ).toEqual({ kind: 'unavailable' });
  });
});

function createCompletedResultFor(
  clientMutationId: string,
): ReturnType<typeof createCompletedResult> {
  const result = createCompletedResult();
  return {
    ...result,
    movement: {
      ...result.movement,
      clientMutationId,
    },
  };
}
