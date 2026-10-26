import {
  INVENTORY_OUTBOUND_RECOVERY_EVENT,
  INVENTORY_OUTBOUND_RECOVERY_STORAGE_KEY,
  clearInventoryOutboundRecovery,
  isInventoryOutboundConfirmationDraft,
  isInventoryOutboundDraftSnapshot,
  readInventoryOutboundRecovery,
  saveInventoryOutboundRecovery,
  subscribeInventoryOutboundRecovery,
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

function installWindow(storage: Storage = new MemoryStorage()): Storage {
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
  return storage;
}

function uninstallWindow(): void {
  Reflect.deleteProperty(globalThis, 'window');
}

function createDraft() {
  return {
    clientMutationId: 'outbound-create-1',
    building: 'A楼',
    quantity: '2',
    occurredAt: '2026-08-11T09:30',
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

function createItemSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    recordId: 'pending:outbound-create-1',
    clientMutationId: 'outbound-create-1',
    pendingSync: true,
    type: 'outbound',
    sku: 'NT-001',
    name: '温湿度传感器',
    specification: 'TH-100',
    unit: '台',
    building: 'A楼',
    quantity: 2,
    destinationBuilding: '',
    location: 'A-01',
    reason: '现场更换',
    operator: '',
    applicant: '测试申请人',
    status: '待审批',
    occurredAt: new Date('2026-08-11T09:30').toISOString(),
    expectedReturnAt: null,
    overdue: false,
    ...overrides,
  };
}

function createConfirmRecovery() {
  return {
    kind: 'confirm' as const,
    status: 'unknown' as const,
    clientMutationId: 'outbound-confirm-1',
    recordId: 'outbound-record-1',
    draft: { note: '确认结果未知，使用原编号重试' },
    itemSnapshot: createItemSnapshot({
      recordId: 'outbound-record-1',
      clientMutationId: 'outbound-create-1',
      pendingSync: false,
      status: '待库房确认',
    }),
    updatedAt: 2000,
  };
}

describe('inventory outbound recovery', () => {
  afterEach(() => {
    uninstallWindow();
  });

  it('accepts a confirmation snapshot with the mapper rejection-reason field', () => {
    installWindow();
    const recovery = createConfirmRecovery();

    expect(
      saveInventoryOutboundRecovery({
        ...recovery,
        itemSnapshot: {
          ...recovery.itemSnapshot,
          approvalRejectionReason: '',
        },
      }),
    ).toBe(true);
  });

  it('exposes discriminated draft guards for page recovery routing', () => {
    expect(isInventoryOutboundDraftSnapshot(createDraft())).toBe(true);
    expect(isInventoryOutboundConfirmationDraft({ note: '确认出库' })).toBe(
      true,
    );
    expect(isInventoryOutboundDraftSnapshot({ note: '确认出库' })).toBe(false);
    expect(isInventoryOutboundConfirmationDraft(createDraft())).toBe(false);
  });

  it('round-trips an isolated create recovery and emits a same-tab event', () => {
    const storage = installWindow();
    const listener = jest.fn();
    const unsubscribe = subscribeInventoryOutboundRecovery(listener);
    const draft = createDraft();
    const itemSnapshot = createItemSnapshot();

    expect(
      saveInventoryOutboundRecovery({
        kind: 'create',
        status: 'draft',
        clientMutationId: 'outbound-create-1',
        draft,
        itemSnapshot,
        updatedAt: 1000,
      }),
    ).toBe(true);
    expect(readInventoryOutboundRecovery()).toEqual({
      version: 1,
      kind: 'create',
      status: 'draft',
      clientMutationId: 'outbound-create-1',
      draft,
      itemSnapshot,
      updatedAt: 1000,
    });
    expect(INVENTORY_OUTBOUND_RECOVERY_STORAGE_KEY).toBe(
      'inventory-management:outbound-recovery',
    );
    expect(INVENTORY_OUTBOUND_RECOVERY_EVENT).toBe(
      'inventory-management:outbound-recovery-change',
    );
    expect(listener).toHaveBeenCalledTimes(1);
    expect(storage.getItem('inventory-management:inbound-recovery')).toBeNull();

    unsubscribe();
    expect(clearInventoryOutboundRecovery('outbound-create-1')).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('accepts a pending-approval create snapshot but rejects it for confirmation recovery', () => {
    installWindow();
    expect(
      saveInventoryOutboundRecovery({
        kind: 'create',
        status: 'draft',
        clientMutationId: 'outbound-create-1',
        draft: createDraft(),
        itemSnapshot: createItemSnapshot({ status: '待审批' }),
        updatedAt: 1000,
      }),
    ).toBe(true);
    expect(clearInventoryOutboundRecovery('outbound-create-1')).toBe(true);

    expect(
      saveInventoryOutboundRecovery({
        ...createConfirmRecovery(),
        itemSnapshot: createItemSnapshot({
          recordId: 'outbound-record-1',
          clientMutationId: 'outbound-create-1',
          pendingSync: false,
          status: '待审批',
        }),
      }),
    ).toBe(false);
  });

  it('round-trips a confirm recovery with its record id', () => {
    installWindow();

    expect(saveInventoryOutboundRecovery(createConfirmRecovery())).toBe(true);
    expect(readInventoryOutboundRecovery()).toMatchObject({
      version: 1,
      kind: 'confirm',
      status: 'unknown',
      clientMutationId: 'outbound-confirm-1',
      recordId: 'outbound-record-1',
      updatedAt: 2000,
    });
  });

  it('keeps the same mutation id for an explicit retry', () => {
    installWindow();
    const first = {
      kind: 'create' as const,
      status: 'unknown' as const,
      clientMutationId: 'outbound-create-1',
      draft: createDraft(),
      itemSnapshot: createItemSnapshot(),
      updatedAt: 1000,
    };

    expect(saveInventoryOutboundRecovery(first)).toBe(true);
    expect(
      saveInventoryOutboundRecovery({
        ...first,
        status: 'draft',
        updatedAt: 3000,
      }),
    ).toBe(true);
    expect(readInventoryOutboundRecovery()).toMatchObject({
      clientMutationId: 'outbound-create-1',
      status: 'draft',
      updatedAt: 3000,
    });
  });

  it('uses mutation ids as compare-and-swap tokens for replace and clear', () => {
    installWindow();
    const createRecovery = {
      kind: 'create' as const,
      status: 'draft' as const,
      clientMutationId: 'outbound-create-1',
      draft: createDraft(),
      itemSnapshot: createItemSnapshot(),
      updatedAt: 1000,
    };
    const confirmRecovery = createConfirmRecovery();

    expect(saveInventoryOutboundRecovery(createRecovery)).toBe(true);
    expect(
      saveInventoryOutboundRecovery({ ...createRecovery, updatedAt: 999 }),
    ).toBe(false);
    expect(saveInventoryOutboundRecovery(confirmRecovery)).toBe(false);
    expect(
      saveInventoryOutboundRecovery(confirmRecovery, 'wrong-current-id'),
    ).toBe(false);
    expect(
      saveInventoryOutboundRecovery(confirmRecovery, 'outbound-create-1'),
    ).toBe(true);
    expect(clearInventoryOutboundRecovery('outbound-create-1')).toBe(false);
    expect(readInventoryOutboundRecovery()?.clientMutationId).toBe(
      'outbound-confirm-1',
    );
    expect(clearInventoryOutboundRecovery('outbound-confirm-1')).toBe(true);
    expect(readInventoryOutboundRecovery()).toBeNull();
  });

  it('atomically rebinds an edited rejected draft from the old id to a new id', () => {
    installWindow();
    const oldRecovery = {
      kind: 'create' as const,
      status: 'draft' as const,
      clientMutationId: 'outbound-create-old',
      draft: {
        ...createDraft(),
        clientMutationId: 'outbound-create-old',
        reason: '旧原因',
      },
      itemSnapshot: createItemSnapshot({
        recordId: 'pending:outbound-create-old',
        clientMutationId: 'outbound-create-old',
        reason: '旧原因',
      }),
      updatedAt: 1000,
    };
    const editedRecovery = {
      ...oldRecovery,
      clientMutationId: 'outbound-create-new',
      draft: {
        ...oldRecovery.draft,
        clientMutationId: 'outbound-create-new',
        reason: '编辑后的原因',
      },
      itemSnapshot: createItemSnapshot({
        recordId: 'pending:outbound-create-new',
        clientMutationId: 'outbound-create-new',
        reason: '编辑后的原因',
      }),
      updatedAt: 2000,
    };

    expect(saveInventoryOutboundRecovery(oldRecovery)).toBe(true);
    expect(
      saveInventoryOutboundRecovery(editedRecovery, 'outbound-create-old'),
    ).toBe(true);
    expect(readInventoryOutboundRecovery()).toMatchObject({
      clientMutationId: 'outbound-create-new',
      draft: { reason: '编辑后的原因' },
    });
  });

  it.each([
    '{not-json',
    JSON.stringify({ version: 2 }),
    JSON.stringify({
      version: 1,
      kind: 'create',
      status: 'draft',
      clientMutationId: 'outbound-create-1',
      draft: [],
      itemSnapshot: {},
      updatedAt: 1000,
    }),
    JSON.stringify({
      version: 1,
      kind: 'confirm',
      status: 'unknown',
      clientMutationId: 'outbound-confirm-1',
      draft: {},
      itemSnapshot: {},
      updatedAt: 1000,
    }),
  ])('discards malformed recovery data safely', (storedValue) => {
    const storage = installWindow();
    storage.setItem(INVENTORY_OUTBOUND_RECOVERY_STORAGE_KEY, storedValue);

    expect(readInventoryOutboundRecovery()).toBeNull();
    expect(storage.getItem(INVENTORY_OUTBOUND_RECOVERY_STORAGE_KEY)).toBeNull();
  });

  it.each([
    [
      'a create recovery carrying a record id',
      () => ({
        kind: 'create' as const,
        status: 'draft' as const,
        clientMutationId: 'outbound-create-1',
        recordId: 'not-allowed',
        draft: createDraft(),
        itemSnapshot: createItemSnapshot(),
        updatedAt: 1000,
      }),
    ],
    [
      'an unknown top-level recovery field',
      () => ({
        kind: 'create' as const,
        status: 'draft' as const,
        clientMutationId: 'outbound-create-1',
        draft: createDraft(),
        itemSnapshot: createItemSnapshot(),
        updatedAt: 1000,
        injected: true,
      }),
    ],
    [
      'a create draft with a mismatched mutation id',
      () => ({
        kind: 'create' as const,
        status: 'draft' as const,
        clientMutationId: 'outbound-create-1',
        draft: { ...createDraft(), clientMutationId: 'different' },
        itemSnapshot: createItemSnapshot(),
        updatedAt: 1000,
      }),
    ],
    [
      'an unknown nested create-draft field',
      () => ({
        kind: 'create' as const,
        status: 'draft' as const,
        clientMutationId: 'outbound-create-1',
        draft: { ...createDraft(), injected: { enabled: true } },
        itemSnapshot: createItemSnapshot(),
        updatedAt: 1000,
      }),
    ],
    [
      'a malformed selected-item quantity',
      () => ({
        kind: 'create' as const,
        status: 'draft' as const,
        clientMutationId: 'outbound-create-1',
        draft: {
          ...createDraft(),
          selectedItem: {
            ...createDraft().selectedItem,
            availableQuantity: '8',
          },
        },
        itemSnapshot: createItemSnapshot(),
        updatedAt: 1000,
      }),
    ],
    [
      'a create snapshot for another mutation',
      () => ({
        kind: 'create' as const,
        status: 'draft' as const,
        clientMutationId: 'outbound-create-1',
        draft: createDraft(),
        itemSnapshot: createItemSnapshot({ recordId: 'pending:other' }),
        updatedAt: 1000,
      }),
    ],
    [
      'a confirm snapshot for another record',
      () => ({
        ...createConfirmRecovery(),
        itemSnapshot: createItemSnapshot({ recordId: 'outbound-record-2' }),
      }),
    ],
    [
      'an unknown nested confirm-draft field',
      () => ({
        ...createConfirmRecovery(),
        draft: { note: '确认结果未知', nested: { injected: true } },
      }),
    ],
  ])('rejects %s', (_label, createRecovery) => {
    installWindow();

    expect(saveInventoryOutboundRecovery(createRecovery())).toBe(false);
    expect(readInventoryOutboundRecovery()).toBeNull();
  });
});
