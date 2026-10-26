import type {
  InventoryMovementItem,
  InventoryOutboundMovementCreateResponse,
} from '../../shared/inventory-management.interface';
import type {
  InventoryOutboundCreationCoordinator,
  InventoryOutboundCreationCoordinatorEvent,
} from '../../client/src/pages/InventoryManagement/inventory-outbound-creation-coordinator';
import type {
  InventoryOutboundCreationTaskInput,
  InventoryOutboundCreationTaskJournal,
} from '../../client/src/pages/InventoryManagement/inventory-outbound-creation-task';
import { createInventoryOutboundCreationRuntime } from '../../client/src/pages/InventoryManagement/inventory-outbound-creation-runtime';

const PRINCIPAL = 'A'.repeat(43);
const NOW = Date.parse('2026-08-13T01:00:00.000Z');

function input(
  clientMutationId: string,
  overrides: Partial<InventoryOutboundCreationTaskInput> = {},
): InventoryOutboundCreationTaskInput {
  return {
    clientMutationId,
    status: 'submitting',
    taskId: null,
    request: {
      type: 'outbound',
      clientMutationId,
      catalogRecordId: `catalog-${clientMutationId}`,
      sku: `SKU-${clientMutationId}`,
      building: 'A楼',
      quantity: 1,
      occurredAt: '2026-08-13T01:00:00.000Z',
      applicantOpenId: 'ou_applicant',
      reason: '测试出库',
    },
    draft: {
      clientMutationId,
      building: 'A楼',
      quantity: '1',
      occurredAt: '2026-08-13T01:00:00.000Z',
      itemQuery: `物品 ${clientMutationId}`,
      selectedItem: {
        catalogRecordId: `catalog-${clientMutationId}`,
        inventoryRecordId: `inventory-${clientMutationId}`,
        sku: `SKU-${clientMutationId}`,
        name: `物品 ${clientMutationId}`,
        specification: '规格',
        brand: '品牌',
        primaryCategory: '一级',
        secondaryCategory: '二级',
        building: 'A楼',
        location: 'A-01',
        unit: '个',
        availableQuantity: 10,
      },
      applicant: {
        recordId: 'person-1',
        openId: 'ou_applicant',
        name: '申请人',
        employeeNo: '001',
        position: '工程师',
        building: 'A楼',
        specialty: '运维',
      },
      reason: '测试出库',
    },
    optimisticItem: movement(clientMutationId, true),
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function journal(
  clientMutationId: string,
  overrides: Partial<InventoryOutboundCreationTaskInput> = {},
): InventoryOutboundCreationTaskJournal {
  return { version: 1, ...input(clientMutationId, overrides) };
}

function movement(
  clientMutationId: string,
  pendingSync: boolean,
): InventoryMovementItem {
  return {
    recordId: pendingSync
      ? `pending:${clientMutationId}`
      : `record:${clientMutationId}`,
    clientMutationId,
    pendingSync,
    type: 'outbound',
    sku: `SKU-${clientMutationId}`,
    name: `物品 ${clientMutationId}`,
    specification: '规格',
    quantity: 1,
    unit: '个',
    building: 'A楼',
    destinationBuilding: '',
    location: 'A-01',
    reason: '测试出库',
    operator: pendingSync ? '待后端确认' : '管理员',
    applicant: '申请人',
    status: pendingSync ? '同步中' : '待库房确认',
    occurredAt: '2026-08-13T01:00:00.000Z',
    expectedReturnAt: null,
    overdue: false,
  };
}

function completedResult(
  clientMutationId: string,
): InventoryOutboundMovementCreateResponse {
  return {
    success: true,
    recordId: `record:${clientMutationId}`,
    type: 'outbound',
    alreadyProcessed: false,
    message: '出库处理完成',
    movement: movement(clientMutationId, false) as never,
  };
}

class FakeCoordinator implements InventoryOutboundCreationCoordinator {
  current: InventoryOutboundCreationTaskJournal | null = null;
  readonly start = jest.fn(
    async (taskInput: InventoryOutboundCreationTaskInput) => {
      this.current = { version: 1, ...taskInput };
      this.onEvent({ type: 'optimistic', journal: this.current });
      return true;
    },
  );
  readonly resume = jest.fn(
    async (saved: InventoryOutboundCreationTaskJournal) => {
      this.current = saved;
      this.onEvent({ type: 'optimistic', journal: saved });
      return true;
    },
  );
  readonly checkNow = jest.fn(async () => this.current !== null);
  readonly reconcileAuthoritativeMovement = jest.fn(async () => false);
  readonly stop = jest.fn(() => undefined);

  constructor(
    private readonly onEvent: (
      event: InventoryOutboundCreationCoordinatorEvent,
    ) => void,
  ) {}

  getCurrentJournal(): InventoryOutboundCreationTaskJournal | null {
    return this.current;
  }

  emit(event: InventoryOutboundCreationCoordinatorEvent): void {
    if (event.type === 'optimistic' || event.type === 'status') {
      this.current = event.journal;
    } else if (event.type === 'completed' || event.type === 'failed') {
      this.current = null;
    }
    this.onEvent(event);
  }
}

describe('inventory outbound creation runtime', () => {
  function createHarness() {
    const events: InventoryOutboundCreationCoordinatorEvent[] = [];
    const coordinators: FakeCoordinator[] = [];
    const runtime = createInventoryOutboundCreationRuntime({
      principalFingerprint: PRINCIPAL,
      submitOutbound: jest.fn(),
      getTaskStatus: jest.fn(),
      saveJournal: jest.fn(),
      finalizeJournal: jest.fn(),
      resolveJournal: jest.fn(),
      readJournals: jest.fn().mockResolvedValue([]),
      onEvent: (event) => events.push(event),
      createCoordinator: (dependencies) => {
        const coordinator = new FakeCoordinator(dependencies.onEvent);
        coordinators.push(coordinator);
        return coordinator;
      },
    });
    return { runtime, events, coordinators };
  }

  it('keeps one pre-acceptance slot, then allows the next task while the first polls', async () => {
    const { runtime, coordinators } = createHarness();

    expect(await runtime.start(input('first'))).toBe(true);
    expect(await runtime.start(input('blocked-before-task-id'))).toBe(false);
    expect(coordinators).toHaveLength(1);

    const acceptedFirst = journal('first', {
      status: 'accepted',
      taskId: 'task-first',
      updatedAt: NOW + 1,
    });
    coordinators[0].emit({
      type: 'status',
      journal: acceptedFirst,
      message: '已受理',
    });

    expect(await runtime.start(input('second'))).toBe(true);
    expect(coordinators).toHaveLength(2);
    expect(
      runtime.getCurrentJournals().map((item) => item.clientMutationId),
    ).toEqual(['first', 'second']);
  });

  it('settles only the matching task and ignores its late response', async () => {
    const { runtime, events, coordinators } = createHarness();
    await runtime.resume(
      journal('first', {
        status: 'accepted',
        taskId: 'task-first',
      }),
    );
    await runtime.resume(
      journal('second', {
        status: 'accepted',
        taskId: 'task-second',
      }),
    );
    events.length = 0;

    coordinators[0].emit({
      type: 'completed',
      journal: journal('first', {
        status: 'accepted',
        taskId: 'task-first',
      }),
      result: completedResult('first'),
    });
    coordinators[0].emit({
      type: 'status',
      journal: journal('first', {
        status: 'uncertain',
        taskId: 'task-first',
        error: '迟到响应',
        updatedAt: NOW + 2,
      }),
      message: '迟到响应',
    });

    expect(runtime.getCurrentJournals()).toEqual([
      expect.objectContaining({ clientMutationId: 'second' }),
    ]);
    expect(events.map((event) => event.type)).toEqual(['completed']);
  });

  it('resumes and checks every accepted task after refresh', async () => {
    const { runtime, coordinators } = createHarness();
    const saved = [
      journal('first', { status: 'accepted', taskId: 'task-first' }),
      journal('second', { status: 'accepted', taskId: 'task-second' }),
    ];

    expect(await runtime.resumeAll(saved)).toBe(true);
    expect(coordinators).toHaveLength(2);
    expect(
      coordinators.every((item) => item.resume.mock.calls.length === 1),
    ).toBe(true);

    expect(await runtime.checkNow()).toBe(true);
    expect(
      coordinators.every((item) => item.checkNow.mock.calls.length === 1),
    ).toBe(true);
  });
});
