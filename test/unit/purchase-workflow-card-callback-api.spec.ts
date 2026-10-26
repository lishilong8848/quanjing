import {
  BadRequestException,
  ForbiddenException,
  HttpStatus,
  RequestMethod,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { existsSync, readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { resolve } from 'node:path';

jest.mock('@nestjs/common', () => {
  const actual = jest.requireActual('@nestjs/common');
  const methodMetadata =
    (metadata: Record<string, unknown>) =>
    (...decoratorArguments: unknown[]) => {
      const [value, context, descriptor] = decoratorArguments as [
        object,
        { kind?: string } | string | undefined,
        { value?: object } | undefined,
      ];
      const metadataTarget =
        typeof context === 'object' && context?.kind === 'method'
          ? value
          : descriptor?.value;
      if (metadataTarget) {
        for (const [key, metadataValue] of Object.entries(metadata)) {
          Reflect.defineMetadata(key, metadataValue, metadataTarget);
        }
      }
      return typeof context === 'object' ? value : undefined;
    };

  return {
    ...actual,
    HttpCode: (statusCode: number) =>
      methodMetadata({ __httpCode__: statusCode }),
    Post: (path: string) =>
      methodMetadata({ path, method: actual.RequestMethod.POST }),
    Req: () => () => undefined,
  };
});

type CallbackRequest = {
  headers: Record<string, string | string[] | undefined>;
  rawBody?: Buffer;
  body?: unknown;
  res?: EventEmitter & { writableFinished: boolean };
};

type CallbackController = {
  handlePurchaseCardCallback(request: CallbackRequest): unknown;
};

type CallbackStore = {
  claimCardAction: jest.Mock<
    Promise<{ claimed: boolean; entry: { key: string } }>,
    [
      {
        eventId: string;
        recordId: string;
        action: 'approve' | 'reject';
        actorOpenId: string;
      },
    ]
  >;
};

type CallbackManagerService = {
  patchManagerApprovalCardView: jest.Mock<Promise<void>, [string, string, boolean]>;
  handleManagerCardAction: jest.Mock<
    Promise<Record<string, unknown>>,
    [unknown]
  >;
  handleManagerBatchCardAction: jest.Mock<
    Promise<Record<string, unknown>>,
    [unknown]
  >;
  handlePurchaseBatchFulfillmentCardAction: jest.Mock<
    Promise<{ claimed: boolean; card: Record<string, unknown> }>,
    [unknown]
  >;
  patchPurchaseBatchFulfillmentCardView: jest.Mock<
    Promise<void>,
    [string, Record<string, unknown>]
  >;
  runPendingTasks: jest.Mock<Promise<unknown>, []>;
  runAcceptedTasks: jest.Mock<Promise<unknown>, []>;
};

type CallbackControllerModule = {
  PurchaseWorkflowCallbackController: new (
    store: CallbackStore,
    managerService?: CallbackManagerService,
    overtimeService?: unknown,
    configuration?: unknown,
    workflowService?: unknown,
  ) => CallbackController;
  readPurchaseCardCallbackConfig?: () => {
    verificationToken: string;
    encryptKey: string;
    legacyApproverOpenIds: string[];
    managerApproverOpenId: string;
  };
};

const controllerPath = resolve(
  __dirname,
  '../../server/modules/purchase-inventory/purchase-workflow-callback.controller.ts',
);
const modulePath = resolve(
  __dirname,
  '../../server/modules/purchase-inventory/purchase-inventory.module.ts',
);
const now = new Date('2026-07-16T06:00:00.000Z').getTime();
const verificationToken = 'verification-token-for-test';
const legacyApproverOpenId = 'ou_approver_beta';
const managerApproverOpenId = 'ou_manager_primary';
const managerCard = {
  schema: '2.0',
  config: { enable_forward: false, update_multi: true },
  header: {
    title: { tag: 'plain_text', content: '采购申请审批' },
  },
  body: {
    elements: [
      { tag: 'markdown', content: '**当前状态：** 审批处理中' },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '综合采购' },
            disabled: true,
          },
        ],
      },
    ],
  },
};
const managerCardResponse = {
  toast: { type: 'info', content: '审批操作已受理' },
  card: { type: 'raw', data: managerCard },
};
const originalEnv = { ...process.env };

function loadControllerModule(): CallbackControllerModule {
  const exists = existsSync(controllerPath);
  expect(exists).toBe(true);
  if (!exists) {
    throw new Error('purchase workflow callback controller is missing');
  }
  return require('../../server/modules/purchase-inventory/purchase-workflow-callback.controller') as CallbackControllerModule;
}

function createStore(
  result: { claimed: boolean; entry: { key: string } } = {
    claimed: true,
    entry: { key: 'approval:record-test-01' },
  },
): CallbackStore {
  return {
    claimCardAction: jest.fn().mockResolvedValue(result),
  };
}

function createManagerService(
  result: Record<string, unknown> = managerCard,
): CallbackManagerService {
  return {
    patchManagerApprovalCardView: jest.fn().mockResolvedValue(undefined),
    handleManagerCardAction: jest.fn().mockResolvedValue(result),
    handleManagerBatchCardAction: jest.fn().mockResolvedValue(result),
    handlePurchaseBatchFulfillmentCardAction: jest.fn().mockResolvedValue({
      claimed: false,
      card: result,
    }),
    patchPurchaseBatchFulfillmentCardView: jest
      .fn()
      .mockResolvedValue(undefined),
    runPendingTasks: jest.fn().mockResolvedValue({ processed: 1, failed: 0 }),
    runAcceptedTasks: jest.fn().mockResolvedValue({ processed: 1, failed: 0 }),
  };
}

function createController(
  store = createStore(),
  managerService = createManagerService(),
): CallbackController {
  const { PurchaseWorkflowCallbackController } = loadControllerModule();
  return new PurchaseWorkflowCallbackController(store, managerService, undefined, { canUseFeishuBusinessIdentity: () => true }, { acceptApprovalCardAction: (input: Parameters<CallbackStore['claimCardAction']>[0]) => store.claimCardAction(input) });
}

function readCallbackConfig() {
  const { readPurchaseCardCallbackConfig } = loadControllerModule();
  expect(typeof readPurchaseCardCallbackConfig).toBe('function');
  if (!readPurchaseCardCallbackConfig) {
    throw new Error('purchase card callback config reader is missing');
  }
  return readPurchaseCardCallbackConfig();
}

function requestFor(
  payload: unknown,
  headers: Record<string, string | string[] | undefined> = {},
): CallbackRequest {
  return {
    headers,
    rawBody: Buffer.from(JSON.stringify(payload), 'utf8'),
  };
}

function legacyActionPayload(operatorOpenId = legacyApproverOpenId) {
  return {
    schema: '2.0',
    header: {
      event_id: 'event-card-test-01',
      event_type: 'card.action.trigger',
      token: verificationToken,
    },
    event: {
      operator: { open_id: operatorOpenId },
      action: {
        value: {
          version: 1,
          action: 'approve',
          executionRecordId: 'record-test-01',
        },
      },
    },
  };
}

function managerActionPayload(operatorOpenId = managerApproverOpenId) {
  return {
    schema: '2.0',
    header: {
      event_id: 'event-manager-card-01',
      event_type: 'card.action.trigger',
      token: verificationToken,
    },
    event: {
      operator: { open_id: operatorOpenId },
      action: {
        tag: 'button',
        value: {
          version: 2,
          action: 'choose_comprehensive',
          executionRecordId: 'record-manager-01',
        },
      },
      context: { open_message_id: 'om_manager_card_01' },
    },
  };
}

function managerBatchActionPayload(operatorOpenId = managerApproverOpenId) {
  return {
    schema: '2.0',
    header: {
      event_id: 'event-manager-batch-card-01',
      event_type: 'card.action.trigger',
      token: verificationToken,
    },
    event: {
      operator: { open_id: operatorOpenId },
      action: {
        tag: 'button',
        value: {
          version: 3,
          action: 'approve_pending_comprehensive',
          approvalBatchId: 'purchase-application-task-1',
        },
      },
      context: { open_message_id: 'om_manager_batch_card_01' },
    },
  };
}

function purchaseBatchFulfillmentActionPayload(
  operatorOpenId = 'ou_purchase_admin',
) {
  return {
    schema: '2.0',
    header: {
      event_id: 'event-purchase-batch-order-01',
      event_type: 'card.action.trigger',
      token: verificationToken,
    },
    event: {
      operator: { open_id: operatorOpenId },
      action: {
        tag: 'button',
        value: {
          version: 4,
          workflowType: 'purchase_batch_fulfillment',
          role: 'purchaser',
          action: 'open_order',
          approvalBatchId: 'purchase-application-task-1',
          executionRecordId: 'record-manager-01',
        },
      },
      context: { open_message_id: 'om_purchase_assignment_01' },
    },
  };
}

describe('purchase workflow card callback API', () => {
  beforeEach(() => {
    process.env = {
      ...originalEnv,
      FEISHU_APP_ID: 'cli_synthetic_callback',
      FEISHU_PURCHASE_CARD_VERIFICATION_TOKEN: verificationToken,
      PURCHASE_WORKFLOW_APPROVER_OPEN_IDS: ` ou_approver_alpha, ${legacyApproverOpenId}, ou_approver_alpha `,
      PURCHASE_MANAGER_APPROVER_OPEN_ID: managerApproverOpenId,
      PURCHASE_WORKFLOW_PROGRAM_ENABLED: 'false',
      PURCHASE_MANAGER_APPROVAL_CARD_ENABLED: 'false',
    };
    delete process.env.FEISHU_PURCHASE_CARD_ENCRYPT_KEY;
    jest.spyOn(Date, 'now').mockReturnValue(now);
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('exposes only POST /callbacks/feishu/purchase-card with explicit HTTP 200', () => {
    const { PurchaseWorkflowCallbackController } = loadControllerModule();
    const handler =
      PurchaseWorkflowCallbackController.prototype.handlePurchaseCardCallback;

    expect(
      Reflect.getMetadata('path', PurchaseWorkflowCallbackController),
    ).toBe('callbacks/feishu');
    expect(Reflect.getMetadata('path', handler)).toBe('purchase-card');
    expect(Reflect.getMetadata('method', handler)).toBe(RequestMethod.POST);
    expect(Reflect.getMetadata('__httpCode__', handler)).toBe(HttpStatus.OK);
  });

  it('registers the callback controller in PurchaseInventoryModule', () => {
    const moduleSource = readFileSync(modulePath, 'utf8');

    expect(moduleSource).toContain(
      "import { PurchaseWorkflowCallbackController } from './purchase-workflow-callback.controller';",
    );
    expect(moduleSource).toMatch(
      /controllers:\s*\[[\s\S]*PurchaseWorkflowCallbackController[\s\S]*\]/,
    );
  });

  it('returns a URL verification challenge from the authenticated raw body', () => {
    process.env.PURCHASE_WORKFLOW_PROGRAM_ENABLED = 'false';
    process.env.PURCHASE_MANAGER_APPROVAL_CARD_ENABLED = 'false';
    delete process.env.PURCHASE_WORKFLOW_APPROVER_OPEN_IDS;
    delete process.env.PURCHASE_MANAGER_APPROVER_OPEN_ID;
    const store = createStore();
    const controller = createController(store);
    const request = requestFor({
      type: 'url_verification',
      token: verificationToken,
      challenge: 'challenge-test-01',
    });
    request.body = {
      type: 'url_verification',
      token: 'forged-body-token',
      challenge: 'forged-body-challenge',
    };

    expect(controller.handlePurchaseCardCallback(request)).toEqual({
      challenge: 'challenge-test-01',
    });
    expect(store.claimCardAction).not.toHaveBeenCalled();
  });

  it('accepts an enabled allowlisted action only after its claim is persisted', async () => {
    process.env.PURCHASE_WORKFLOW_PROGRAM_ENABLED = 'true';
    const store = createStore();
    const controller = createController(store);
    const timestamp = String(Math.floor(now / 1000));

    await expect(
      controller.handlePurchaseCardCallback(
        requestFor(legacyActionPayload(), {
          'X-Lark-Request-Timestamp': [timestamp],
        }),
      ),
    ).resolves.toEqual({
      toast: { type: 'info', content: '审批操作已受理' },
    });
    expect(store.claimCardAction).toHaveBeenCalledWith({
      eventId: 'event-card-test-01',
      recordId: 'record-test-01',
      action: 'approve',
      actorOpenId: legacyApproverOpenId,
    });
  });

  it('returns a warning without exposing the previous actor for a duplicate action', async () => {
    process.env.PURCHASE_WORKFLOW_PROGRAM_ENABLED = 'true';
    const store = createStore({
      claimed: false,
      entry: { key: 'approval:record-test-01' },
    });

    await expect(
      createController(store).handlePurchaseCardCallback(
        requestFor(legacyActionPayload()),
      ),
    ).resolves.toEqual({
      toast: { type: 'warning', content: '该申请已处理或正在处理' },
    });
  });

  it('handles a manager action with its independent flag while the legacy program stays disabled', async () => {
    process.env.PURCHASE_WORKFLOW_PROGRAM_ENABLED = 'false';
    process.env.PURCHASE_MANAGER_APPROVAL_CARD_ENABLED = 'true';
    delete process.env.PURCHASE_WORKFLOW_APPROVER_OPEN_IDS;
    const store = createStore();
    const managerService = createManagerService(managerCard);

    const response = await createController(
      store,
      managerService,
    ).handlePurchaseCardCallback(requestFor(managerActionPayload()));

    expect(response).toEqual(managerCardResponse);
    expect((response as { card: { data: unknown } }).card.data).toBe(
      managerCard,
    );
    expect(managerService.handleManagerCardAction).toHaveBeenCalledWith({
      kind: 'manager_action',
      eventId: 'event-manager-card-01',
      operatorOpenId: managerApproverOpenId,
      messageId: 'om_manager_card_01',
      action: 'choose_comprehensive',
      executionRecordId: 'record-manager-01',
    });
    expect(store.claimCardAction).not.toHaveBeenCalled();
  });

  it.each(['open_reject', 'open_item_reject', 'cancel_item_reject'])('patches %s after acknowledgement without returning an interactive raw card', async action => {
    process.env.PURCHASE_MANAGER_APPROVAL_CARD_ENABLED = 'true';
    const service = createManagerService();
    const batch = action !== 'open_reject';
    const source = batch ? managerBatchActionPayload() : managerActionPayload();
    const payload = { ...source, event: { ...source.event, action: { tag: 'button', value: {
      ...source.event.action.value, action, ...(action === 'open_item_reject' ? { executionRecordId: 'rec-2' } : {}),
    } } } };
    const response = Object.assign(new EventEmitter(), { writableFinished: false });
    const result = await createController(createStore(), service).handlePurchaseCardCallback({ ...requestFor(payload), res: response });
    expect(result).not.toHaveProperty('card');
    expect(service.patchManagerApprovalCardView).not.toHaveBeenCalled();
    response.emit('finish'); await Promise.resolve();
    expect(service.patchManagerApprovalCardView).toHaveBeenCalledWith(source.event.context.open_message_id, managerApproverOpenId, batch);
    expect(service.runAcceptedTasks).not.toHaveBeenCalled();
  });

  it('handles a manager batch action and starts the durable worker', async () => {
    process.env.PURCHASE_WORKFLOW_PROGRAM_ENABLED = 'false';
    process.env.PURCHASE_MANAGER_APPROVAL_CARD_ENABLED = 'true';
    const store = createStore();
    const managerService = createManagerService(managerCard);

    await expect(
      createController(store, managerService).handlePurchaseCardCallback(
        requestFor(managerBatchActionPayload()),
      ),
    ).resolves.toEqual(managerCardResponse);

    expect(managerService.handleManagerBatchCardAction).toHaveBeenCalledWith({
      kind: 'manager_batch_action',
      eventId: 'event-manager-batch-card-01',
      operatorOpenId: managerApproverOpenId,
      messageId: 'om_manager_batch_card_01',
      action: 'approve_pending_comprehensive',
      approvalBatchId: 'purchase-application-task-1',
    });
    expect(managerService.runAcceptedTasks).toHaveBeenCalledTimes(1);
    expect(managerService.handleManagerCardAction).not.toHaveBeenCalled();
    expect(store.claimCardAction).not.toHaveBeenCalled();
  });

  it('acknowledges the purchaser order editor before patching after HTTP finish', async () => {
    process.env.PURCHASE_WORKFLOW_PROGRAM_ENABLED = 'false';
    process.env.PURCHASE_MANAGER_APPROVAL_CARD_ENABLED = 'true';
    const managerService = createManagerService(managerCard);
    managerService.handlePurchaseBatchFulfillmentCardAction.mockResolvedValue({
      claimed: false,
      card: managerCard,
    });
    const response = Object.assign(new EventEmitter(), {
      writableFinished: false,
    });
    const request = requestFor(purchaseBatchFulfillmentActionPayload());
    request.res = response;

    await expect(
      createController(
        createStore(),
        managerService,
      ).handlePurchaseCardCallback(request),
    ).resolves.toEqual({
      toast: { type: 'info', content: '请填写下单结果' },
    });
    expect(
      managerService.handlePurchaseBatchFulfillmentCardAction,
    ).toHaveBeenCalledWith({
      kind: 'purchase_batch_fulfillment_action',
      eventId: 'event-purchase-batch-order-01',
      operatorOpenId: 'ou_purchase_admin',
      messageId: 'om_purchase_assignment_01',
      action: 'open_order',
      approvalBatchId: 'purchase-application-task-1',
      executionRecordId: 'record-manager-01',
    });
    expect(
      managerService.patchPurchaseBatchFulfillmentCardView,
    ).not.toHaveBeenCalled();
    response.writableFinished = true;
    response.emit('finish');
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(
      managerService.patchPurchaseBatchFulfillmentCardView,
    ).toHaveBeenCalledWith('om_purchase_assignment_01', managerCard, undefined);
    expect(managerService.runPendingTasks).not.toHaveBeenCalled();
  });

  it('acknowledges an old receipt button before patching with the callback token', async () => {
    process.env.PURCHASE_WORKFLOW_PROGRAM_ENABLED = 'false';
    process.env.PURCHASE_MANAGER_APPROVAL_CARD_ENABLED = 'true';
    const payload = purchaseBatchFulfillmentActionPayload(
      'ou_purchase_requester',
    );
    payload.header.event_id = 'event-purchase-receipt-open-01';
    payload.event.action.value.role = 'requester';
    payload.event.action.value.action = 'open_receipt';
    payload.event.context.open_message_id = 'om_purchase_receipt_01';
    payload.event.token = 'c-receipt-http-01';

    const managerService = createManagerService(managerCard);
    const response = Object.assign(new EventEmitter(), {
      writableFinished: false,
    });
    const request = requestFor(payload);
    request.res = response;

    await expect(
      createController(
        createStore(),
        managerService,
      ).handlePurchaseCardCallback(request),
    ).resolves.toEqual({
      toast: { type: 'info', content: '请填写签收信息' },
    });
    expect(
      managerService.patchPurchaseBatchFulfillmentCardView,
    ).not.toHaveBeenCalled();

    response.writableFinished = true;
    response.emit('finish');
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(
      managerService.patchPurchaseBatchFulfillmentCardView,
    ).toHaveBeenCalledWith(
      'om_purchase_receipt_01',
      managerCard,
      'c-receipt-http-01',
    );
  });

  it('rejects manager actions with HTTP 503 semantics while manager approval is disabled', () => {
    process.env.PURCHASE_WORKFLOW_PROGRAM_ENABLED = 'false';
    process.env.PURCHASE_MANAGER_APPROVAL_CARD_ENABLED = 'false';
    const store = createStore();
    const managerService = createManagerService();

    expect(() =>
      createController(store, managerService).handlePurchaseCardCallback(
        requestFor(managerActionPayload()),
      ),
    ).toThrow(ServiceUnavailableException);
    expect(managerService.handleManagerCardAction).not.toHaveBeenCalled();
    expect(store.claimCardAction).not.toHaveBeenCalled();
  });

  it('passes a wrong manager operator failure through as HTTP 403 while manager approval is enabled', () => {
    process.env.PURCHASE_WORKFLOW_PROGRAM_ENABLED = 'false';
    process.env.PURCHASE_MANAGER_APPROVAL_CARD_ENABLED = 'true';
    const managerService = createManagerService();

    expect(() =>
      createController(
        createStore(),
        managerService,
      ).handlePurchaseCardCallback(
        requestFor(managerActionPayload('ou_not_the_manager')),
      ),
    ).toThrow(ForbiddenException);
    expect(managerService.handleManagerCardAction).not.toHaveBeenCalled();
  });

  it('rejects card actions with HTTP 503 semantics while the program is disabled', () => {
    process.env.PURCHASE_WORKFLOW_PROGRAM_ENABLED = 'false';
    const store = createStore();

    expect(() =>
      createController(store).handlePurchaseCardCallback(
        requestFor(legacyActionPayload()),
      ),
    ).toThrow(ServiceUnavailableException);
    expect(store.claimCardAction).not.toHaveBeenCalled();
  });

  it('maps a card-action ledger write failure to HTTP 503 instead of accepting it', async () => {
    process.env.PURCHASE_WORKFLOW_PROGRAM_ENABLED = 'true';
    const store = createStore();
    store.claimCardAction.mockRejectedValue(
      new Error('sensitive ledger filesystem failure'),
    );

    await expect(
      createController(store).handlePurchaseCardCallback(
        requestFor(legacyActionPayload()),
      ),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('returns an uncertain processing warning when the card-action claim exceeds its deadline', async () => {
    process.env.PURCHASE_WORKFLOW_PROGRAM_ENABLED = 'true';
    jest.useFakeTimers({ doNotFake: ['Date'] });
    const store = createStore();
    store.claimCardAction.mockImplementation(
      () => new Promise(() => undefined),
    );
    const response = createController(store).handlePurchaseCardCallback(
      requestFor(legacyActionPayload()),
    );
    const processing = expect(response).resolves.toMatchObject({ toast: { type: 'warning', content: expect.stringContaining('请勿重复点击') } });

    await jest.advanceTimersByTimeAsync(2_500);
    await processing;
    expect(store.claimCardAction).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('returns an uncertain processing warning when manager card handling exceeds the deadline', async () => {
    process.env.PURCHASE_WORKFLOW_PROGRAM_ENABLED = 'false';
    process.env.PURCHASE_MANAGER_APPROVAL_CARD_ENABLED = 'true';
    jest.useFakeTimers({ doNotFake: ['Date'] });
    const managerService = createManagerService();
    managerService.handleManagerCardAction.mockImplementation(
      () => new Promise(() => undefined),
    );
    const response = createController(
      createStore(),
      managerService,
    ).handlePurchaseCardCallback(requestFor(managerActionPayload()));
    const processing = expect(response).resolves.toMatchObject({ toast: { type: 'warning', content: expect.stringContaining('请勿重复点击') } });

    await jest.advanceTimersByTimeAsync(2_500);
    await processing;
    expect(managerService.handleManagerCardAction).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('continues an authenticated HTTP batch claim after timeout without another click', async () => {
    process.env.PURCHASE_WORKFLOW_PROGRAM_ENABLED = 'false';
    process.env.PURCHASE_MANAGER_APPROVAL_CARD_ENABLED = 'true';
    jest.useFakeTimers({ doNotFake: ['Date'] });
    let finish!: (card: Record<string, unknown>) => void;
    const service = createManagerService();
    service.handleManagerBatchCardAction.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const controller = createController(createStore(), service);
    const response = controller.handlePurchaseCardCallback(requestFor(managerBatchActionPayload()));
    await jest.advanceTimersByTimeAsync(2501);
    await expect(response).resolves.toMatchObject({ toast: { type: 'warning' } });
    expect(service.runAcceptedTasks).not.toHaveBeenCalled();
    finish(managerCard);
    await jest.advanceTimersByTimeAsync(0);
    expect(service.runAcceptedTasks).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['missing', undefined],
    ['empty', Buffer.alloc(0)],
  ])('rejects a %s raw request body', (_label, rawBody) => {
    const controller = createController();

    expect(() =>
      controller.handlePurchaseCardCallback({ headers: {}, rawBody }),
    ).toThrow(BadRequestException);
  });

  it('passes a verification-token failure through unchanged', () => {
    const controller = createController();

    expect(() =>
      controller.handlePurchaseCardCallback(
        requestFor({
          type: 'url_verification',
          token: 'wrong-verification-token',
          challenge: 'challenge-test-01',
        }),
      ),
    ).toThrow(UnauthorizedException);
  });

  it('passes a non-allowlisted operator failure through unchanged', () => {
    process.env.PURCHASE_WORKFLOW_PROGRAM_ENABLED = 'true';
    const controller = createController();

    expect(() =>
      controller.handlePurchaseCardCallback(
        requestFor(legacyActionPayload('ou_not_an_approver')),
      ),
    ).toThrow(ForbiddenException);
  });

  it('reports only the missing verification-token key as a service outage', () => {
    delete process.env.FEISHU_PURCHASE_CARD_VERIFICATION_TOKEN;

    expect(readCallbackConfig).toThrow(
      new ServiceUnavailableException(
        'FEISHU_PURCHASE_CARD_VERIFICATION_TOKEN',
      ),
    );
  });

  it('requires approvers when the workflow program is enabled', () => {
    process.env.PURCHASE_WORKFLOW_PROGRAM_ENABLED = 'true';
    delete process.env.PURCHASE_WORKFLOW_APPROVER_OPEN_IDS;

    expect(readCallbackConfig).toThrow(
      new ServiceUnavailableException('PURCHASE_WORKFLOW_APPROVER_OPEN_IDS'),
    );
  });

  it('requires a manager approver only when manager approval is enabled', () => {
    process.env.PURCHASE_WORKFLOW_PROGRAM_ENABLED = 'false';
    process.env.PURCHASE_MANAGER_APPROVAL_CARD_ENABLED = 'true';
    delete process.env.PURCHASE_MANAGER_APPROVER_OPEN_ID;
    delete process.env.PURCHASE_WORKFLOW_APPROVER_OPEN_IDS;
    delete process.env.FEISHU_ACCESS_ADMIN_OPEN_IDS;

    expect(readCallbackConfig).toThrow(ServiceUnavailableException);
  });

  it('allows URL verification without either approver config while both features are disabled', () => {
    process.env.PURCHASE_WORKFLOW_PROGRAM_ENABLED = 'false';
    process.env.PURCHASE_MANAGER_APPROVAL_CARD_ENABLED = 'false';
    delete process.env.PURCHASE_WORKFLOW_APPROVER_OPEN_IDS;
    delete process.env.PURCHASE_MANAGER_APPROVER_OPEN_ID;

    expect(readCallbackConfig()).toEqual({
      verificationToken,
      encryptKey: '',
      legacyApproverOpenIds: [],
      managerApproverOpenId: '',
    });
    expect(
      createController().handlePurchaseCardCallback(
        requestFor({
          type: 'url_verification',
          token: verificationToken,
          challenge: 'challenge-disabled-workflow',
        }),
      ),
    ).toEqual({ challenge: 'challenge-disabled-workflow' });
  });

  it('loads only legacy approvers when only the legacy workflow is enabled', () => {
    process.env.PURCHASE_WORKFLOW_PROGRAM_ENABLED = 'true';
    process.env.PURCHASE_MANAGER_APPROVAL_CARD_ENABLED = 'false';
    delete process.env.PURCHASE_MANAGER_APPROVER_OPEN_ID;

    expect(readCallbackConfig()).toEqual({
      verificationToken,
      encryptKey: '',
      legacyApproverOpenIds: ['ou_approver_alpha', legacyApproverOpenId],
      managerApproverOpenId: '',
    });
  });

  it('loads only the unique manager when only manager approval is enabled', () => {
    process.env.PURCHASE_WORKFLOW_PROGRAM_ENABLED = 'false';
    process.env.PURCHASE_MANAGER_APPROVAL_CARD_ENABLED = 'true';
    delete process.env.PURCHASE_WORKFLOW_APPROVER_OPEN_IDS;

    expect(readCallbackConfig()).toEqual({
      verificationToken,
      encryptKey: '',
      legacyApproverOpenIds: [],
      managerApproverOpenId,
      managerApproverOpenIds: [managerApproverOpenId],
    });
  });

  it('keeps the callback outside API auth/CSRF conventions and never reconstructs raw bytes', () => {
    const exists = existsSync(controllerPath);
    expect(exists).toBe(true);
    if (!exists) return;
    const source = readFileSync(controllerPath, 'utf8');

    expect(source).not.toMatch(/JSON\.stringify\s*\(\s*(?:req|request)\.body/);
    expect(source).not.toContain('/api/callback');
    expect(source).not.toContain('PurchaseWorkflowGateway');
    expect(source).not.toMatch(/\bou_[A-Za-z0-9_-]+/);
    expect(source).not.toMatch(/console\.(?:log|info|warn|error)/);
  });
});
