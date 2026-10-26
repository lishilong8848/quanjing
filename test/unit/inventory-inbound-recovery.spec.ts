import {
  INVENTORY_INBOUND_RECOVERY_EVENT,
  INVENTORY_INBOUND_RECOVERY_STORAGE_KEY,
  clearInventoryInboundRecovery,
  createPurchaseInboundRecoveryDraft,
  isPurchaseInboundRecoveryDraft,
  readInventoryInboundRecovery,
  saveInventoryInboundRecovery,
  subscribeInventoryInboundRecovery,
} from '../../client/src/pages/InventoryManagement/inventory-inbound-recovery';

interface InventoryInboundAcceptedRecoveryApi {
  acceptInventoryInboundRecovery: (input: {
    clientMutationId: string;
    taskId: string;
    kind: 'manual' | 'purchase';
    request: Record<string, unknown>;
  }) => boolean;
  finalizeInventoryInboundRecovery: (
    clientMutationId: string,
    status: 'running' | 'completed' | 'failed',
  ) => boolean;
}

function loadAcceptedRecoveryApi(): InventoryInboundAcceptedRecoveryApi {
  const recoveryModule =
    require('../../client/src/pages/InventoryManagement/inventory-inbound-recovery') as Record<
      string,
      unknown
    >;
  expect(typeof recoveryModule.acceptInventoryInboundRecovery).toBe('function');
  expect(typeof recoveryModule.finalizeInventoryInboundRecovery).toBe(
    'function',
  );
  return recoveryModule as unknown as InventoryInboundAcceptedRecoveryApi;
}

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

function installWindow(storage: Storage = new MemoryStorage()): {
  storage: Storage;
  eventTarget: EventTarget;
} {
  const eventTarget = new EventTarget();
  const fakeWindow: RecoveryWindow = {
    sessionStorage: storage,
    addEventListener: eventTarget.addEventListener.bind(eventTarget),
    removeEventListener: eventTarget.removeEventListener.bind(eventTarget),
    dispatchEvent: eventTarget.dispatchEvent.bind(eventTarget),
  };
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: fakeWindow,
  });
  return { storage, eventTarget };
}

function uninstallWindow(): void {
  Reflect.deleteProperty(globalThis, 'window');
}

function createManualDraft(
  clientMutationId: string | undefined = 'manual-mutation-1',
) {
  return {
    clientMutationId,
    mode: 'new' as const,
    building: 'A楼' as const,
    quantity: '8',
    occurredAt: '2026-07-30T10:30',
    itemQuery: '',
    selectedItem: null,
    newItem: {
      primaryCategory: '安全用品',
      secondaryCategory: '绝缘用品',
      name: '绝缘手套',
      specification: '10kV',
      location: 'A-01',
      locationRecordId: 'location-record-a-01',
    },
  };
}

function createPurchaseDraft(
  executionRecordId = 'execution-18',
  clientMutationId: string | undefined = 'purchase-mutation-1',
) {
  return {
    kind: 'purchase' as const,
    executionRecordId,
    clientMutationId,
    mode: 'existing' as const,
    building: 'B楼' as const,
    quantity: '3',
    occurredAt: '2026-07-30T10:30',
    itemQuery: 'HJ001',
    selectedItem: null,
    newItem: {
      primaryCategory: '环境设备',
      secondaryCategory: '温湿度监测H1',
      name: '温湿度传感器',
      specification: 'TH-100',
      location: 'B-01',
      brand: '测试品牌',
      unit: '台',
      minimumQuantity: '0',
    },
  };
}

describe('inventory inbound recovery storage', () => {
  it.each([17, null, {}])(
    'rejects malformed specialty %p instead of weakening the draft schema',
    (specialty) => {
      const { storage } = installWindow();
      const draft = createManualDraft();
      Object.assign(draft.newItem, { specialty });
      expect(
        saveInventoryInboundRecovery({
          kind: 'manual',
          status: 'pending',
          clientMutationId: 'manual-mutation-1',
          draft,
        }),
      ).toBe(false);
      expect(
        storage.getItem(INVENTORY_INBOUND_RECOVERY_STORAGE_KEY),
      ).toBeNull();
    },
  );

  it.each(['', '电气'])(
    'persists current movement API options with specialty %p',
    (specialty) => {
      installWindow();
      const {
        buildMovementOptions,
      } = require('../../server/modules/inventory-management/inventory-movement-command.rules');
      const selectedItem = buildMovementOptions({
        type: 'inbound',
        building: 'A楼',
        catalog: [
          {
            record_id: 'catalog-specialty',
            fields: {
              物品类别号: 'A1118',
              名称: '测试直流监控主机',
              楼栋: 'A楼',
              专业: specialty,
            },
          },
        ],
        inventory: [
          {
            record_id: 'inventory-specialty',
            fields: { 物品类别号: 'A1118', 楼栋: 'A楼', 剩余库存: 1 },
          },
        ],
      })[0];
      const draft = {
        ...createManualDraft(),
        mode: 'existing' as const,
        selectedItem,
      };
      expect(
        saveInventoryInboundRecovery({
          kind: 'manual',
          status: 'pending',
          clientMutationId: 'manual-mutation-1',
          draft,
        }),
      ).toBe(true);
      expect(
        readInventoryInboundRecovery<typeof draft>()?.draft.selectedItem,
      ).toEqual(selectedItem);
    },
  );

  it.each([undefined, '', '电气'])(
    'preserves optional specialty in new manual drafts and accepted requests: %p',
    (specialty) => {
      installWindow();
      const draft = createManualDraft();
      draft.newItem = { ...draft.newItem, specialty } as typeof draft.newItem;
      expect(
        saveInventoryInboundRecovery({
          kind: 'manual',
          status: 'pending',
          clientMutationId: 'manual-mutation-1',
          draft,
        }),
      ).toBe(true);
      const { acceptInventoryInboundRecovery } = loadAcceptedRecoveryApi();
      expect(
        acceptInventoryInboundRecovery({
          kind: 'manual',
          clientMutationId: 'manual-mutation-1',
          taskId: 'task-specialty',
          request: {
            type: 'inbound',
            mode: 'new',
            building: 'A楼',
            quantity: 8,
            occurredAt: '2026-07-30T10:30:00Z',
            clientMutationId: 'manual-mutation-1',
            newItem: { ...draft.newItem, specialty },
          },
        }),
      ).toBe(true);
      expect(
        readInventoryInboundRecovery<typeof draft>()?.draft.newItem,
      ).toEqual(JSON.parse(JSON.stringify(draft.newItem)));
    },
  );
  afterEach(() => {
    uninstallWindow();
  });

  it('round-trips a pending manual draft and only persists allowed fields', () => {
    const { storage } = installWindow();
    const recovery = {
      kind: 'manual' as const,
      status: 'pending' as const,
      clientMutationId: 'manual-mutation-1',
      draft: createManualDraft(),
      request: {
        operatorToken: 'must-not-be-persisted',
      },
      optimisticMovement: {
        recordId: 'temporary-record',
      },
    };

    saveInventoryInboundRecovery(recovery);

    expect(readInventoryInboundRecovery()).toEqual({
      kind: 'manual',
      status: 'pending',
      clientMutationId: 'manual-mutation-1',
      draft: recovery.draft,
    });
    expect(
      JSON.parse(
        storage.getItem(INVENTORY_INBOUND_RECOVERY_STORAGE_KEY) ?? '{}',
      ),
    ).toEqual({
      version: 1,
      kind: 'manual',
      status: 'pending',
      clientMutationId: 'manual-mutation-1',
      draft: recovery.draft,
    });
  });

  it('round-trips a failed purchase draft with its execution record id', () => {
    installWindow();
    const draft = createPurchaseDraft();

    saveInventoryInboundRecovery({
      kind: 'purchase',
      status: 'failed',
      clientMutationId: 'purchase-mutation-1',
      purchaseExecutionRecordId: 'execution-18',
      draft,
    });

    expect(readInventoryInboundRecovery<typeof draft>()).toEqual({
      kind: 'purchase',
      status: 'failed',
      clientMutationId: 'purchase-mutation-1',
      purchaseExecutionRecordId: 'execution-18',
      draft,
    });
  });

  it('persists a bounded purchase form and pending-item snapshot inside the draft slot', () => {
    const { storage } = installWindow();
    const form = createPurchaseDraft();
    Object.assign(form.newItem, { specialty: '暖通' });
    const purchaseSnapshot = {
      specialty: '暖通',
      executionRecordId: 'execution-18',
      submissionRecordId: 'submission-18',
      requestCode: 'CG-20260730-018',
      mode: 'existing' as const,
      sku: 'H1001',
      itemName: '温湿度传感器',
      specification: 'TH-100',
      brand: '测试品牌',
      primaryCategory: '环境设备',
      secondaryCategory: '温湿度监测H1',
      building: 'B楼' as const,
      quantity: 3,
      unit: '台',
      signedAt: '2026-07-30T09:30:00.000Z',
      action: 'ready' as const,
      catalogRecordId: 'catalog-18',
      actionReason: '',
    };
    const draft = createPurchaseInboundRecoveryDraft(form, purchaseSnapshot);

    expect(isPurchaseInboundRecoveryDraft(draft)).toBe(true);
    expect(
      saveInventoryInboundRecovery({
        kind: 'purchase',
        status: 'pending',
        clientMutationId: 'purchase-mutation-1',
        purchaseExecutionRecordId: 'execution-18',
        draft,
      }),
    ).toBe(true);
    expect(readInventoryInboundRecovery<typeof draft>()?.draft).toEqual(draft);

    const persisted =
      storage.getItem(INVENTORY_INBOUND_RECOVERY_STORAGE_KEY) ?? '';
    expect(persisted).not.toContain('"request"');
    expect(persisted).not.toContain('"token"');
    expect(persisted).not.toContain('"optimisticMovement"');
  });

  it('restores an operator-selected new mode from a neutral prepared snapshot', () => {
    installWindow();
    const baseForm = createPurchaseDraft();
    const form = {
      ...baseForm,
      mode: 'new' as const,
      newItem: {
        ...baseForm.newItem,
        specialty: '暖通',
        locationRecordId: 'location-record-18',
      },
      preparedCatalogRecordId: 'catalog-prepared-18',
      generatedSku: 'H1008',
      preparedAt: '2026-07-30T09:40:00.000Z',
    };
    const purchaseSnapshot = {
      executionRecordId: 'execution-18',
      submissionRecordId: 'submission-18',
      requestCode: 'CG-20260730-018',
      mode: null,
      sku: '',
      itemName: '温湿度传感器',
      specification: 'TH-100',
      brand: '测试品牌',
      primaryCategory: '环境设备',
      secondaryCategory: '温湿度监测H1',
      building: 'B楼' as const,
      quantity: 3,
      unit: '台',
      signedAt: '2026-07-30T09:30:00.000Z',
      action: 'needs_selection' as const,
      catalogRecordId: '',
      actionReason: '请在确认入库时选择新增或已有',
      preparedCategory: {
        catalogRecordId: 'catalog-prepared-18',
        sku: 'H1008',
        preparedAt: '2026-07-30T09:40:00.000Z',
        clientMutationId: 'purchase-mutation-1',
        building: 'B楼' as const,
        quantity: 3,
        occurredAt: '2026-07-30T10:30:00.000Z',
        newItem: {
          specialty: '暖通',
          primaryCategory: '环境设备',
          secondaryCategory: '温湿度监测H1',
          name: '温湿度传感器',
          specification: 'TH-100',
          location: 'B-01',
          locationRecordId: 'location-record-18',
          brand: '测试品牌',
          unit: '台',
          minimumQuantity: 0,
        },
      },
    };

    const draft = createPurchaseInboundRecoveryDraft(form, purchaseSnapshot);

    expect(isPurchaseInboundRecoveryDraft(draft)).toBe(true);
    expect(draft.form.newItem.locationRecordId).toBe('location-record-18');
    expect(
      draft.purchaseSnapshot.preparedCategory?.newItem.locationRecordId,
    ).toBe('location-record-18');
    expect(draft.purchaseSnapshot.preparedCategory?.newItem).not.toBe(
      purchaseSnapshot.preparedCategory.newItem,
    );
    expect(
      saveInventoryInboundRecovery({
        kind: 'purchase',
        status: 'pending',
        clientMutationId: 'purchase-mutation-1',
        purchaseExecutionRecordId: 'execution-18',
        draft,
      }),
    ).toBe(true);
    const { acceptInventoryInboundRecovery } = loadAcceptedRecoveryApi();
    expect(
      acceptInventoryInboundRecovery({
        kind: 'purchase',
        clientMutationId: 'purchase-mutation-1',
        taskId: 'purchase-specialty-task',
        request: {
          executionRecordId: 'execution-18',
          clientMutationId: 'purchase-mutation-1',
          mode: 'new',
          building: 'B楼',
          quantity: 3,
          occurredAt: '2026-07-30T10:30:00.000Z',
          preparedCatalogRecordId: 'catalog-prepared-18',
          generatedSku: 'H1008',
          newItem: purchaseSnapshot.preparedCategory.newItem,
        },
      }),
    ).toBe(true);
    expect(readInventoryInboundRecovery<typeof draft>()?.draft).toEqual(draft);
  });

  it('rejects malformed prepared purchase snapshots', () => {
    const form = {
      ...createPurchaseDraft(),
      mode: 'new' as const,
      preparedCatalogRecordId: 'catalog-prepared-18',
      generatedSku: 'H1008',
    };
    const snapshot = createPurchaseInboundRecoveryDraft(form, {
      executionRecordId: 'execution-18',
      submissionRecordId: 'submission-18',
      requestCode: 'CG-20260730-018',
      mode: null,
      sku: '',
      itemName: '温湿度传感器',
      specification: 'TH-100',
      brand: '测试品牌',
      primaryCategory: '环境设备',
      secondaryCategory: '温湿度监测H1',
      building: 'B楼',
      quantity: 3,
      unit: '台',
      signedAt: '2026-07-30T09:30:00.000Z',
      action: 'needs_selection',
      catalogRecordId: '',
      actionReason: '',
    });

    (snapshot.purchaseSnapshot as Record<string, unknown>).preparedCategory = {
      catalogRecordId: 'catalog-prepared-18',
      sku: 'H1008',
      preparedAt: 'invalid-date',
    };
    expect(isPurchaseInboundRecoveryDraft(snapshot)).toBe(false);
  });

  it('rejects invalid or mismatched purchase recovery snapshots', () => {
    expect(
      isPurchaseInboundRecoveryDraft({
        form: { executionRecordId: 'execution-18' },
        purchaseSnapshot: {
          executionRecordId: 'another-execution',
          quantity: 3,
        },
      }),
    ).toBe(false);
    expect(
      isPurchaseInboundRecoveryDraft({
        form: { executionRecordId: 'execution-18' },
        purchaseSnapshot: {
          executionRecordId: 'execution-18',
          quantity: -1,
        },
      }),
    ).toBe(false);
  });

  it('uses compare-and-set so a different mutation cannot overwrite the active recovery', () => {
    installWindow();

    expect(
      saveInventoryInboundRecovery({
        kind: 'manual',
        status: 'pending',
        clientMutationId: 'manual-a',
        draft: createManualDraft('manual-a'),
      }),
    ).toBe(true);
    expect(
      saveInventoryInboundRecovery({
        kind: 'purchase',
        status: 'failed',
        clientMutationId: 'purchase-b',
        purchaseExecutionRecordId: 'execution-b',
        draft: createPurchaseDraft('execution-b', 'purchase-b'),
      }),
    ).toBe(false);
    expect(readInventoryInboundRecovery()).toMatchObject({
      kind: 'manual',
      status: 'pending',
      clientMutationId: 'manual-a',
      draft: createManualDraft('manual-a'),
    });

    expect(
      saveInventoryInboundRecovery({
        kind: 'manual',
        status: 'failed',
        clientMutationId: 'manual-a',
        draft: createManualDraft('manual-a'),
      }),
    ).toBe(true);
    expect(readInventoryInboundRecovery()).toMatchObject({
      clientMutationId: 'manual-a',
      status: 'failed',
    });
  });

  it('clears only the recovery with the matching mutation id', () => {
    const { storage } = installWindow();
    saveInventoryInboundRecovery({
      kind: 'manual',
      status: 'failed',
      clientMutationId: 'manual-to-clear',
      draft: createManualDraft('manual-to-clear'),
    });

    clearInventoryInboundRecovery('another-mutation');
    expect(readInventoryInboundRecovery()?.clientMutationId).toBe(
      'manual-to-clear',
    );

    clearInventoryInboundRecovery('manual-to-clear');
    expect(readInventoryInboundRecovery()).toBeNull();
    expect(storage.getItem(INVENTORY_INBOUND_RECOVERY_STORAGE_KEY)).toBeNull();
  });

  it('notifies same-window subscribers after every save and clear call', () => {
    installWindow();
    const listener = jest.fn();
    const unrelatedListener = jest.fn();
    window.addEventListener(
      `${INVENTORY_INBOUND_RECOVERY_EVENT}:unrelated`,
      unrelatedListener,
    );
    const unsubscribe = subscribeInventoryInboundRecovery(listener);

    saveInventoryInboundRecovery({
      kind: 'manual',
      status: 'pending',
      clientMutationId: 'event-mutation',
      draft: createManualDraft('event-mutation'),
    });
    clearInventoryInboundRecovery('not-the-current-mutation');
    clearInventoryInboundRecovery('event-mutation');
    unsubscribe();
    saveInventoryInboundRecovery({
      kind: 'manual',
      status: 'failed',
      clientMutationId: 'event-after-unsubscribe',
      draft: createManualDraft('event-after-unsubscribe'),
    });

    expect(listener).toHaveBeenCalledTimes(3);
    expect(unrelatedListener).not.toHaveBeenCalled();
  });

  it.each([
    ['malformed JSON', '{'],
    [
      'wrong version',
      JSON.stringify({
        version: 2,
        kind: 'manual',
        status: 'pending',
        clientMutationId: 'wrong-version',
        draft: {},
      }),
    ],
    [
      'unexpected persisted request',
      JSON.stringify({
        version: 1,
        kind: 'manual',
        status: 'pending',
        clientMutationId: 'has-request',
        draft: {},
        request: { secret: true },
      }),
    ],
    [
      'invalid kind',
      JSON.stringify({
        version: 1,
        kind: 'other',
        status: 'pending',
        clientMutationId: 'wrong-kind',
        draft: {},
      }),
    ],
    [
      'invalid status',
      JSON.stringify({
        version: 1,
        kind: 'manual',
        status: 'complete',
        clientMutationId: 'wrong-status',
        draft: {},
      }),
    ],
    [
      'blank mutation id',
      JSON.stringify({
        version: 1,
        kind: 'manual',
        status: 'pending',
        clientMutationId: ' ',
        draft: {},
      }),
    ],
    [
      'non-object draft',
      JSON.stringify({
        version: 1,
        kind: 'manual',
        status: 'pending',
        clientMutationId: 'wrong-draft',
        draft: [],
      }),
    ],
    [
      'blank purchase execution id',
      JSON.stringify({
        version: 1,
        kind: 'purchase',
        status: 'pending',
        clientMutationId: 'wrong-execution',
        purchaseExecutionRecordId: '',
        draft: {},
      }),
    ],
  ])('rejects %s without throwing', (_label, storedValue) => {
    const { storage } = installWindow();
    storage.setItem(INVENTORY_INBOUND_RECOVERY_STORAGE_KEY, storedValue);

    expect(readInventoryInboundRecovery()).toBeNull();
    expect(storage.getItem(INVENTORY_INBOUND_RECOVERY_STORAGE_KEY)).toBeNull();
  });

  it('reports persistence failure when session storage is unavailable or setItem fails', () => {
    installWindow();
    Object.defineProperty(window, 'sessionStorage', {
      configurable: true,
      get() {
        throw new DOMException('disabled', 'SecurityError');
      },
    });

    expect(
      saveInventoryInboundRecovery({
        kind: 'manual',
        status: 'pending',
        clientMutationId: 'storage-disabled',
        draft: createManualDraft('storage-disabled'),
      }),
    ).toBe(false);
    expect(readInventoryInboundRecovery()).toBeNull();
    expect(() =>
      clearInventoryInboundRecovery('storage-disabled'),
    ).not.toThrow();
    const unsubscribe = subscribeInventoryInboundRecovery(() => undefined);
    expect(() => unsubscribe()).not.toThrow();

    class RejectingStorage extends MemoryStorage {
      override setItem(): void {
        throw new DOMException('quota exceeded', 'QuotaExceededError');
      }
    }
    installWindow(new RejectingStorage());
    expect(
      saveInventoryInboundRecovery({
        kind: 'manual',
        status: 'pending',
        clientMutationId: 'storage-write-failed',
        draft: createManualDraft('storage-write-failed'),
      }),
    ).toBe(false);
  });

  it('atomically removes a recovery whose nested draft schema is invalid', () => {
    const { storage } = installWindow();
    storage.setItem(
      INVENTORY_INBOUND_RECOVERY_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        kind: 'manual',
        status: 'pending',
        clientMutationId: 'invalid-nested-draft',
        draft: {
          ...createManualDraft(),
          selectedItem: {
            catalogRecordId: 42,
          },
        },
      }),
    );

    expect(readInventoryInboundRecovery()).toBeNull();
    expect(storage.getItem(INVENTORY_INBOUND_RECOVERY_STORAGE_KEY)).toBeNull();
    expect(
      saveInventoryInboundRecovery({
        kind: 'manual',
        status: 'pending',
        clientMutationId: 'replacement-after-invalid',
        draft: createManualDraft('replacement-after-invalid'),
      }),
    ).toBe(true);
  });

  it('rejects and clears a nested draft when a required field is missing', () => {
    const { storage } = installWindow();
    const draft = createManualDraft();
    const incompleteNewItem = { ...draft.newItem } as Partial<
      typeof draft.newItem
    >;
    delete incompleteNewItem.location;
    storage.setItem(
      INVENTORY_INBOUND_RECOVERY_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        kind: 'manual',
        status: 'pending',
        clientMutationId: 'missing-nested-field',
        draft: {
          ...draft,
          clientMutationId: 'missing-nested-field',
          newItem: incompleteNewItem,
        },
      }),
    );

    expect(readInventoryInboundRecovery()).toBeNull();
    expect(storage.getItem(INVENTORY_INBOUND_RECOVERY_STORAGE_KEY)).toBeNull();
  });

  it('allows an editable rejected recovery to be replaced by a new mutation id', () => {
    installWindow();

    expect(
      saveInventoryInboundRecovery({
        kind: 'manual',
        status: 'failed',
        retryMode: 'editable',
        clientMutationId: 'business-rejected',
        draft: {
          ...createManualDraft(),
          clientMutationId: undefined,
        },
      }),
    ).toBe(true);
    expect(
      saveInventoryInboundRecovery({
        kind: 'manual',
        status: 'pending',
        retryMode: 'locked',
        clientMutationId: 'new-after-edit',
        draft: createManualDraft('new-after-edit'),
      }),
    ).toBe(true);
    expect(readInventoryInboundRecovery()).toMatchObject({
      retryMode: 'locked',
      clientMutationId: 'new-after-edit',
    });
  });

  it('does not throw during SSR or for an unserializable draft', () => {
    uninstallWindow();
    const circularDraft: Record<string, unknown> = {};
    circularDraft.self = circularDraft;

    expect(() =>
      saveInventoryInboundRecovery({
        kind: 'manual',
        status: 'pending',
        clientMutationId: 'server-render',
        draft: circularDraft,
      }),
    ).not.toThrow();
    expect(readInventoryInboundRecovery()).toBeNull();
    expect(() => clearInventoryInboundRecovery('server-render')).not.toThrow();
    const unsubscribe = subscribeInventoryInboundRecovery(() => undefined);
    expect(() => unsubscribe()).not.toThrow();

    installWindow();
    expect(() =>
      saveInventoryInboundRecovery({
        kind: 'manual',
        status: 'pending',
        clientMutationId: 'circular',
        draft: circularDraft,
      }),
    ).not.toThrow();
  });

  it('keeps the accepted task binding, strict request, and draft across a refresh', () => {
    const { storage } = installWindow();
    const mutationId = 'manual-accepted-1';
    const draft = createManualDraft(mutationId);
    const request = {
      type: 'inbound',
      clientMutationId: mutationId,
      mode: 'new',
      building: 'A楼',
      quantity: 8,
      occurredAt: '2026-07-30T10:30:00.000Z',
      newItem: {
        primaryCategory: '安全用品',
        secondaryCategory: '绝缘用品',
        name: '绝缘手套',
        specification: '10kV',
        location: 'A-01',
        locationRecordId: 'location-record-a-01',
      },
    };
    expect(
      saveInventoryInboundRecovery({
        kind: 'manual',
        status: 'pending',
        retryMode: 'locked',
        clientMutationId: mutationId,
        draft,
      }),
    ).toBe(true);

    const { acceptInventoryInboundRecovery } = loadAcceptedRecoveryApi();
    expect(
      acceptInventoryInboundRecovery({
        clientMutationId: mutationId,
        taskId: 'inbound-task-manual-1',
        kind: 'manual',
        request,
      }),
    ).toBe(true);

    expect(readInventoryInboundRecovery()).toEqual({
      kind: 'manual',
      status: 'accepted',
      retryMode: 'locked',
      clientMutationId: mutationId,
      taskId: 'inbound-task-manual-1',
      request,
      draft,
    });
    expect(
      JSON.parse(
        storage.getItem(INVENTORY_INBOUND_RECOVERY_STORAGE_KEY) ?? '{}',
      ),
    ).toMatchObject({
      clientMutationId: mutationId,
      status: 'accepted',
      taskId: 'inbound-task-manual-1',
      kind: 'manual',
      request,
      draft,
    });
  });

  it('retains an accepted journal until the task is explicitly completed or failed', () => {
    installWindow();
    const { acceptInventoryInboundRecovery, finalizeInventoryInboundRecovery } =
      loadAcceptedRecoveryApi();
    const requestFor = (clientMutationId: string) => ({
      type: 'inbound',
      clientMutationId,
      mode: 'new',
      building: 'A楼',
      quantity: 8,
      occurredAt: '2026-07-30T10:30:00.000Z',
      newItem: {
        primaryCategory: '安全用品',
        secondaryCategory: '绝缘用品',
        name: '绝缘手套',
        specification: '10kV',
        location: 'A-01',
        locationRecordId: 'location-record-a-01',
      },
    });
    const saveAccepted = (clientMutationId: string, taskId: string) => {
      expect(
        saveInventoryInboundRecovery({
          kind: 'manual',
          status: 'pending',
          retryMode: 'locked',
          clientMutationId,
          draft: createManualDraft(clientMutationId),
        }),
      ).toBe(true);
      expect(
        acceptInventoryInboundRecovery({
          clientMutationId,
          taskId,
          kind: 'manual',
          request: requestFor(clientMutationId),
        }),
      ).toBe(true);
    };

    saveAccepted('manual-terminal-completed', 'inbound-task-completed');
    expect(
      finalizeInventoryInboundRecovery('manual-terminal-completed', 'running'),
    ).toBe(false);
    expect(readInventoryInboundRecovery()).toMatchObject({
      clientMutationId: 'manual-terminal-completed',
      status: 'accepted',
      taskId: 'inbound-task-completed',
    });
    expect(
      finalizeInventoryInboundRecovery(
        'manual-terminal-completed',
        'completed',
      ),
    ).toBe(true);
    expect(readInventoryInboundRecovery()).toBeNull();

    saveAccepted('manual-terminal-failed', 'inbound-task-failed');
    expect(
      finalizeInventoryInboundRecovery('manual-terminal-failed', 'failed'),
    ).toBe(true);
    expect(readInventoryInboundRecovery()).toBeNull();
  });
});
