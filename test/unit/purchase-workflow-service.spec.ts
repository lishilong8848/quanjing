jest.mock(
  '@server/common/config/external-services.config',
  () => ({
    readEnv: jest.fn((name: string) => process.env[name] || ''),
    parseFeishuBitableLink: jest.fn((url: string) => ({
      appToken: new URL(url).pathname.split('/').filter(Boolean).at(-1) || '',
      wikiToken: '',
      tableId: '',
      viewId: '',
    })),
  }),
  { virtual: true },
);

import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  buildTimeline,
  PurchaseWorkflowService,
} from '../../server/modules/purchase-inventory/purchase-workflow.service';
import { InboundResponsibleUsersNotConfiguredException } from '../../server/modules/purchase-inventory/purchase-workflow.gateway';
import { resolvePurchaseStage } from '../../server/modules/purchase-inventory/purchase-workflow.rules';
import { PurchaseWorkflowStore } from '../../server/modules/purchase-inventory/purchase-workflow.store';
import type { InventoryMovementCreateResponse } from '../../shared/inventory-management.interface';
import type { PurchaseWorkflowRecord } from '../../shared/purchase-workflow.interface';

const originalEnv = { ...process.env };

const session = {
  accessToken: 'tenant-token',
  openId: 'ou_manager',
  userName: '测试经理',
  accessRole: 'admin' as const,
  authenticationMode: 'delegated-app' as const,
};

function record(
  overrides: Partial<PurchaseWorkflowRecord> = {},
): PurchaseWorkflowRecord {
  return {
    recordId: 'rec_execution_1',
    requestCode: 'CG-001',
    status: '未开始（待审批）',
    itemName: '接触器',
    building: 'H楼',
    requesterOpenId: 'ou_requester',
    requesterName: '需求人',
    purchaserOpenId: '',
    purchaserName: '',
    purchaseMethod: '',
    requestedQuantity: 2,
    actualQuantity: null,
    actualAmount: null,
    paymentAttachmentTokens: [],
    approvalCompleted: false,
    warehouseConfirmed: false,
    purchaseCompleted: false,
    receiptConfirmed: false,
    signer: '',
    signerOpenId: '',
    receiptTime: null,
    receiptPhotoTokens: [],
    invoiceTokens: [],
    ...overrides,
  };
}

function completedApprovalNotifications(openIds: string[]) {
  return openIds.map((openId) => ({
    recordId: 'rec_execution_1',
    recipientOpenId: openId,
    kind: 'approval_requested',
    status: 'completed',
    messageId: `om_${openId}`,
  }));
}

function manualMovementResult(): InventoryMovementCreateResponse {
  return {
    success: true,
    recordId: 'manual-inbound-record-001',
    type: 'inbound',
    message: '入库记录已完成',
    movement: {
      recordId: 'manual-inbound-record-001',
      clientMutationId: 'manual-inbound-mutation-001',
      type: 'inbound',
      sku: 'B1056',
      name: '地磅秤',
      specification: '0.6*0.8米 1吨',
      quantity: 1,
      unit: '台',
      building: 'H楼',
      destinationBuilding: '',
      location: 'H-2F-226储存间01-0F',
      reason: '入库登记',
      operator: '管理员',
      applicant: '',
      status: '新增',
      occurredAt: '2026-08-26T01:30:00.000Z',
      expectedReturnAt: null,
      overdue: false,
    },
  };
}

function manualCompletionContext(): string {
  const movement = manualMovementResult().movement!;
  return JSON.stringify({
    version: 1,
    movement: {
      recordId: movement.recordId,
      sku: movement.sku,
      name: movement.name,
      specification: movement.specification,
      quantity: movement.quantity,
      unit: movement.unit,
      building: movement.building,
      location: movement.location,
      occurredAt: movement.occurredAt,
    },
  });
}

describe('PurchaseWorkflowService', () => {
  beforeEach(() => {
    process.env = { ...originalEnv, PURCHASE_WORKFLOW_PROGRAM_ENABLED: 'true' };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('reminds only post-cutover records that are still waiting for an order', async () => {
    const gateway = {
      listExecutionRecordsAsApp: jest.fn().mockResolvedValue([
        record({
          recordId: 'rec_historical_april',
          requestCode: 'CG260407-601',
          status: '审批通过（待下单）',
          purchaserOpenId: 'ou_purchaser',
          createdAt: new Date('2026-04-07T09:00:00+08:00').getTime(),
        }),
        record({
          recordId: 'rec_post_cutover_completed',
          requestCode: 'CG260929-600',
          status: '采购完成（已入库）',
          purchaserOpenId: 'ou_purchaser',
          createdAt: new Date('2026-09-29T09:00:00+08:00').getTime(),
        }),
        record({
          recordId: 'rec_post_cutover_ordering',
          requestCode: 'CG260929-601',
          status: '审批通过（待下单）',
          purchaserOpenId: 'ou_purchaser',
          createdAt: new Date('2026-09-29T09:00:00+08:00').getTime(),
        }),
      ]),
      sendTextNotification: jest.fn().mockResolvedValue(undefined),
    };
    const store = {
      listPendingOrderNoticeCommands: jest.fn().mockResolvedValue([]),
      hasReminder: jest.fn().mockResolvedValue(false),
      recordReminder: jest.fn().mockResolvedValue(undefined),
    };
    const service = new PurchaseWorkflowService(
      gateway as never,
      store as never,
    );

    await expect(
      service.runReminders('order', new Date('2026-09-30T10:00:00+08:00')),
    ).resolves.toMatchObject({ processed: 1, failed: 0 });
    expect(gateway.sendTextNotification).toHaveBeenCalledTimes(1);
    expect(gateway.sendTextNotification).toHaveBeenCalledWith(
      ['ou_purchaser'],
      '采购任务 CG260929-601 尚未完成下单，请跟进采购进度',
    );
    expect(store.recordReminder).toHaveBeenCalledWith(
      'order:rec_post_cutover_ordering:2026-09-30',
    );
  });

  it('shows awaiting inbound after receipt and before completion', () => {
    const timeline = buildTimeline(
      resolvePurchaseStage('到货已签收（待入库）'),
    );

    expect(timeline.map((node) => node.key)).toEqual([
      'application',
      'approval',
      'ordering',
      'receipt',
      'inbound',
      'completed',
    ]);
    expect(timeline).toEqual(
      expect.arrayContaining([
        { key: 'receipt', label: '收货签收', state: 'completed' },
        { key: 'inbound', label: '等待入库', state: 'current' },
        { key: 'completed', label: '采购完成', state: 'pending' },
      ]),
    );
  });

  it('keeps workflow reads available but hides actions when program writes are disabled', async () => {
    process.env.PURCHASE_WORKFLOW_PROGRAM_ENABLED = 'false';
    const gateway = {
      getExecutionRecord: jest.fn().mockResolvedValue(record()),
      resolveUser: jest.fn().mockResolvedValue({
        openId: 'ou_manager',
        name: '测试经理',
        positions: ['设施运维经理'],
        buildings: [],
      }),
    };
    const service = new PurchaseWorkflowService(gateway as never, {} as never);

    const nonAdminSession = {
      ...session,
      accessRole: 'purchase_admin' as const,
    };

    await expect(
      service.getDetail('rec_execution_1', nonAdminSession),
    ).resolves.toMatchObject({
      programEnabled: false,
      allowedActions: [],
      disabledReason: expect.stringContaining('原飞书工作流'),
    });
    await expect(
      service.approve('rec_execution_1', nonAdminSession, {
        decision: 'approved',
        purchaseMethod: '综合采购',
        comment: '',
      }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('keeps order writeback available without sending program notifications', async () => {
    process.env.PURCHASE_WORKFLOW_PROGRAM_ENABLED = 'false';
    const before = record({
      status: '审批通过（待下单）',
      purchaseMethod: '综合采购',
      purchaserOpenId: 'ou_buyer',
      purchaserName: '采购员',
    });
    const after = record({
      ...before,
      status: '下单完成（待签收）',
      purchaseCompleted: true,
      actualQuantity: 2,
      actualAmount: 300,
    });
    const gateway = {
      getExecutionRecord: jest
        .fn()
        .mockResolvedValueOnce(before)
        .mockResolvedValueOnce(before)
        .mockResolvedValue(after),
      resolveUser: jest.fn().mockResolvedValue({
        openId: 'ou_buyer',
        name: '采购员',
        positions: ['综合管理'],
        buildings: [],
      }),
      updateExecutionRecord: jest.fn().mockResolvedValue(undefined),
      sendTextNotification: jest.fn().mockResolvedValue(['om_message']),
    };
    const store = {
      listPendingOrderNoticeCommands: jest.fn().mockResolvedValue([]),
      findCommand: jest.fn().mockResolvedValue(null),
      claimCommand: jest.fn(claimedCommand),
      releaseCommandClaim: jest.fn().mockResolvedValue(true),
      recordCommand: jest.fn().mockResolvedValue(undefined),
    };
    const service = new PurchaseWorkflowService(
      gateway as never,
      store as never,
    );
    const buyerSession = {
      ...session,
      openId: 'ou_buyer',
      userName: '采购员',
      accessRole: 'purchase_admin' as const,
    };

    await expect(
      service.getDetail('rec_execution_1', buyerSession),
    ).resolves.toMatchObject({
      programEnabled: true,
      allowedActions: ['order'],
      disabledReason: '',
    });
    await expect(
      service.order('rec_execution_1', buyerSession, {
        actualQuantity: 2,
        actualAmount: 300,
        paymentAttachmentTokens: [],
        note: '',
      }),
    ).resolves.toMatchObject({
      idempotent: false,
      notificationWarnings: [],
    });
    expect(gateway.updateExecutionRecord).toHaveBeenCalledWith(
      'rec_execution_1',
      expect.objectContaining({
        实际采购数量: 2,
        实际付款金额: 300,
        采购流程: '下单完成（待签收）',
      }),
      'tenant-token',
    );
    expect(gateway.sendTextNotification).not.toHaveBeenCalled();
  });

  it('gives an administrator the legal stage action even without a matching organization position', async () => {
    process.env.PURCHASE_WORKFLOW_PROGRAM_ENABLED = 'false';
    const gateway = {
      getExecutionRecord: jest.fn().mockResolvedValue(
        record({
          status: '下单完成（待签收）',
          purchaseMethod: '综合采购',
          purchaseCompleted: true,
        }),
      ),
      resolveUser: jest.fn().mockResolvedValue({
        openId: 'ou_manager',
        name: '系统管理员',
        positions: [],
        buildings: [],
      }),
    };
    const service = new PurchaseWorkflowService(gateway as never, {} as never);

    await expect(
      service.getDetail('rec_execution_1', session),
    ).resolves.toMatchObject({
      stage: 'receipt',
      allowedActions: ['receive'],
      programEnabled: true,
      disabledReason: '',
    });
  });

  it('keeps workflow detail readable without a delegated operator and hides actions', async () => {
    const gateway = {
      getExecutionRecord: jest.fn().mockResolvedValue(record()),
      resolveUser: jest.fn(),
    };
    const service = new PurchaseWorkflowService(gateway as never, {} as never);

    await expect(
      service.getDetail('rec_execution_1', {
        accessToken: 'tenant-token',
        openId: '',
        userName: '',
        accessRole: 'purchase_admin',
        authenticationMode: 'delegated-app',
      }),
    ).resolves.toMatchObject({
      record: { recordId: 'rec_execution_1' },
      stage: 'application',
      allowedActions: [],
      programEnabled: true,
    });
    expect(gateway.resolveUser).not.toHaveBeenCalled();
  });

  it('reuses a short-lived workflow detail instead of refetching the same Base row', async () => {
    const gateway = {
      getExecutionRecord: jest.fn().mockResolvedValue(record()),
      resolveUser: jest.fn().mockResolvedValue({
        openId: 'ou_manager',
        name: '测试经理',
        positions: ['设施运维经理'],
        buildings: [],
      }),
    };
    const service = new PurchaseWorkflowService(gateway as never, {} as never);

    const first = await service.getDetail('rec_execution_1', session);
    const second = await service.getDetail('rec_execution_1', session);

    expect(second).toEqual(first);
    expect(second).not.toBe(first);
    expect(gateway.getExecutionRecord).toHaveBeenCalledTimes(1);
    expect(gateway.resolveUser).toHaveBeenCalledTimes(1);
  });

  it('rejects a delegated operator that is absent from the live organization table', async () => {
    const gateway = {
      getExecutionRecord: jest.fn().mockResolvedValue(record()),
      resolveUser: jest.fn().mockResolvedValue({
        openId: 'ou_missing_operator',
        name: '',
        positions: [],
        buildings: [],
      }),
    };
    const service = new PurchaseWorkflowService(gateway as never, {} as never);

    const error = await service
      .getDetail('rec_execution_1', {
        accessToken: 'tenant-token',
        openId: 'ou_missing_operator',
        userName: '',
        accessRole: 'editor',
        authenticationMode: 'delegated-app',
      })
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect((error as ServiceUnavailableException).getStatus()).toBe(503);
    expect((error as Error).message).toContain(
      '配置的采购工作流操作人未在组织架构表中找到',
    );
  });

  it('approves once, records idempotency, and reports notification failure without rollback', async () => {
    const before = record();
    const after = record({
      status: '审批通过（待库房确认）',
      purchaseMethod: '综合采购',
      approvalCompleted: true,
    });
    const gateway = {
      getExecutionRecord: jest
        .fn()
        .mockResolvedValueOnce(before)
        .mockResolvedValue(after),
      resolveUser: jest.fn().mockResolvedValue({
        openId: 'ou_manager',
        name: '测试经理',
        positions: ['设施运维经理'],
        buildings: [],
      }),
      updateExecutionRecord: jest.fn().mockResolvedValue(undefined),
      sendTextNotification: jest
        .fn()
        .mockRejectedValue(new Error('消息服务不可用')),
    };
    const store = {
      listPendingOrderNoticeCommands: jest.fn().mockResolvedValue([]),
      findCommand: jest.fn().mockResolvedValue(null),
      claimCommand: jest.fn(claimedCommand),
      releaseCommandClaim: jest.fn().mockResolvedValue(true),
      recordCommand: jest.fn().mockResolvedValue(undefined),
    };
    const service = new PurchaseWorkflowService(
      gateway as never,
      store as never,
    );

    const result = await service.approve('rec_execution_1', session, {
      decision: 'approved',
      purchaseMethod: '综合采购',
      comment: '预算合理',
    });

    expect(gateway.updateExecutionRecord).toHaveBeenCalledTimes(1);
    expect(gateway.updateExecutionRecord).toHaveBeenCalledWith(
      'rec_execution_1',
      expect.objectContaining({ 采购流程: '审批通过（待下单）' }),
      'tenant-token',
    );
    expect(store.recordCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'approve:rec_execution_1',
        actorOpenId: 'ou_manager',
        accessRole: 'admin',
        authenticationMode: 'delegated-app',
      }),
    );
    expect(result.notificationWarnings).toEqual(['消息服务不可用']);
    expect(result.detail.stage).toBe('approval');
  });

  it('assigns the live comprehensive purchaser when starting procurement', async () => {
    const before = record({
      status: '审批通过（待库房确认）',
      purchaseMethod: '综合采购',
      approvalCompleted: true,
    });
    const after = record({
      ...before,
      status: '库房确认（待下单）',
      purchaserOpenId: 'ou_buyer',
      purchaserName: '采购员',
      warehouseConfirmed: true,
    });
    const gateway = {
      getExecutionRecord: jest
        .fn()
        .mockResolvedValueOnce(before)
        .mockResolvedValue(after),
      resolveUser: jest.fn().mockResolvedValue({
        openId: 'ou_manager',
        name: '测试经理',
        positions: ['设施运维经理'],
        buildings: [],
      }),
      findComprehensivePurchaser: jest.fn().mockResolvedValue({
        openId: 'ou_buyer',
        name: '采购员',
        positions: ['综合管理'],
        buildings: [],
      }),
      updateExecutionRecord: jest.fn().mockResolvedValue(undefined),
      sendTextNotification: jest.fn().mockResolvedValue(['om_message']),
    };
    const store = {
      listPendingOrderNoticeCommands: jest.fn().mockResolvedValue([]),
      findCommand: jest.fn().mockResolvedValue(null),
      claimCommand: jest.fn(claimedCommand),
      releaseCommandClaim: jest.fn().mockResolvedValue(true),
      recordCommand: jest.fn().mockResolvedValue(undefined),
    };
    const service = new PurchaseWorkflowService(
      gateway as never,
      store as never,
    );

    await service.start('rec_execution_1', session);

    expect(gateway.findComprehensivePurchaser).toHaveBeenCalledWith(
      'tenant-token',
      { building: 'H楼', specialty: undefined },
    );
    expect(gateway.updateExecutionRecord).toHaveBeenCalledWith(
      'rec_execution_1',
      expect.objectContaining({ 采购人: [{ id: 'ou_buyer' }] }),
      'tenant-token',
    );
  });

  it('returns an idempotent result without repeating the Base write or message', async () => {
    const completed = record({
      status: '下单完成（待签收）',
      purchaseMethod: '综合采购',
      purchaserOpenId: 'ou_manager',
      purchaseCompleted: true,
      actualQuantity: 2,
      actualAmount: 300,
    });
    const gateway = {
      getExecutionRecord: jest.fn().mockResolvedValue(completed),
      resolveUser: jest.fn().mockResolvedValue({
        openId: 'ou_manager',
        name: '测试经理',
        positions: ['设施运维经理'],
        buildings: [],
      }),
      updateExecutionRecord: jest.fn(),
      sendTextNotification: jest.fn(),
    };
    const store = {
      listPendingOrderNoticeCommands: jest.fn().mockResolvedValue([]),
      findCommand: jest.fn().mockResolvedValue({
        key: 'order:rec_execution_1',
        fingerprint: '',
        startedAt: '2026-07-31T00:00:00.000Z',
        completedAt: '2026-07-31T00:00:01.000Z',
        notificationWarnings: [],
      }),
      recordCommand: jest.fn(),
    };
    const service = new PurchaseWorkflowService(
      gateway as never,
      store as never,
    );

    const result = await service.order('rec_execution_1', session, {
      actualQuantity: 2,
      actualAmount: 300,
      paymentAttachmentTokens: [],
      note: '',
    });

    expect(result.idempotent).toBe(true);
    expect(gateway.updateExecutionRecord).not.toHaveBeenCalled();
    expect(gateway.sendTextNotification).not.toHaveBeenCalled();
  });

  it('coalesces identical concurrent orders and rejects a conflicting payload', async () => {
    const ordering = record({
      status: '审批通过（待下单）',
      purchaseMethod: '综合采购',
      purchaserOpenId: 'ou_manager',
    });
    const ordered = record({
      ...ordering,
      status: '下单完成（待签收）',
      purchaseCompleted: true,
      actualQuantity: 2,
      actualAmount: 300,
    });
    let signalWriteStarted!: () => void;
    const writeStarted = new Promise<void>((resolve) => {
      signalWriteStarted = resolve;
    });
    let releaseWrite!: () => void;
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const gateway = {
      getExecutionRecord: jest
        .fn()
        .mockResolvedValueOnce(ordering)
        .mockResolvedValue(ordered),
      resolveUser: jest.fn().mockResolvedValue({
        openId: 'ou_manager',
        name: '测试经理',
        positions: ['设施运维经理'],
        buildings: [],
      }),
      updateExecutionRecord: jest.fn().mockImplementation(async () => {
        signalWriteStarted();
        await writeGate;
      }),
      sendTextNotification: jest.fn(),
    };
    const store = {
      listPendingOrderNoticeCommands: jest.fn().mockResolvedValue([]),
      findCommand: jest.fn().mockResolvedValue(null),
      claimCommand: jest.fn(claimedCommand),
      releaseCommandClaim: jest.fn().mockResolvedValue(true),
      recordCommand: jest.fn().mockResolvedValue(undefined),
    };
    const service = new PurchaseWorkflowService(
      gateway as never,
      store as never,
    );
    const input = {
      actualQuantity: 2,
      actualAmount: 300,
      paymentAttachmentTokens: [],
      note: '',
    };

    const first = service.order('rec_execution_1', session, input);
    await writeStarted;
    const duplicate = service.order('rec_execution_1', session, { ...input });
    const duplicateOutcome = duplicate.then(
      (result) => ({ result, error: null }),
      (error: unknown) => ({ result: null, error }),
    );
    const conflicting = service.order('rec_execution_1', session, {
      ...input,
      actualAmount: 301,
    });
    const conflictingOutcome = conflicting.then(
      (result) => ({ result, error: null }),
      (error: unknown) => ({ result: null, error }),
    );
    releaseWrite();

    const [firstResult, duplicateResult, conflictingResult] = await Promise.all(
      [first, duplicateOutcome, conflictingOutcome],
    );
    expect(conflictingResult.error).toBeInstanceOf(ConflictException);
    expect(firstResult.idempotent).toBe(false);
    expect(duplicateResult.error).toBeNull();
    expect(duplicateResult.result?.idempotent).toBe(true);
    expect(gateway.updateExecutionRecord).toHaveBeenCalledTimes(1);
    expect(store.recordCommand).toHaveBeenCalledTimes(1);
  });

  it('uses one durable claim across service instances before writing Base', async () => {
    const ordering = record({
      status: '审批通过（待下单）',
      purchaseMethod: '综合采购',
      purchaserOpenId: 'ou_manager',
    });
    const ordered = record({
      ...ordering,
      status: '下单完成（待签收）',
      purchaseCompleted: true,
      actualQuantity: 2,
      actualAmount: 300,
    });
    let releaseWrite!: () => void;
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    let signalFirstWrite!: () => void;
    const firstWriteStarted = new Promise<void>((resolve) => {
      signalFirstWrite = resolve;
    });
    const durable = createDurableCommandStore();
    let findCount = 0;
    let signalSecondFind!: () => void;
    const secondFindStarted = new Promise<void>((resolve) => {
      signalSecondFind = resolve;
    });
    durable.store.findCommand.mockImplementation(async () => {
      findCount += 1;
      if (findCount === 2) signalSecondFind();
      return durable.current();
    });
    const gateway = {
      getExecutionRecord: jest
        .fn()
        .mockResolvedValueOnce(ordering)
        .mockResolvedValueOnce(ordering)
        .mockResolvedValue(ordered),
      resolveUser: jest.fn().mockResolvedValue({
        openId: 'ou_manager',
        name: '测试经理',
        positions: ['设施运维经理'],
        buildings: [],
      }),
      updateExecutionRecord: jest.fn().mockImplementation(async () => {
        signalFirstWrite();
        await writeGate;
      }),
      sendTextNotification: jest.fn(),
    };
    const firstService = new PurchaseWorkflowService(
      gateway as never,
      durable.store as never,
    );
    const secondService = new PurchaseWorkflowService(
      gateway as never,
      durable.store as never,
    );
    const input = {
      actualQuantity: 2,
      actualAmount: 300,
      paymentAttachmentTokens: [],
      note: '',
    };

    const first = firstService.order('rec_execution_1', session, input);
    await firstWriteStarted;
    const secondOutcome = secondService
      .order('rec_execution_1', session, input)
      .then(
        (result) => ({ result, error: null }),
        (error: unknown) => ({ result: null, error }),
      );
    await secondFindStarted;
    releaseWrite();

    const [firstResult, secondResult] = await Promise.all([
      first,
      secondOutcome,
    ]);
    expect(firstResult.idempotent).toBe(false);
    expect(secondResult.error).toBeInstanceOf(ConflictException);
    expect(gateway.updateExecutionRecord).toHaveBeenCalledTimes(1);
  });

  it('reconciles a post-PUT ledger failure without repeating the Base write', async () => {
    const ordering = record({
      status: '审批通过（待下单）',
      purchaseMethod: '综合采购',
      purchaserOpenId: 'ou_manager',
    });
    const ordered = record({
      ...ordering,
      status: '下单完成（待签收）',
      purchaseCompleted: true,
      actualQuantity: 2,
      actualAmount: 300,
    });
    const durable = createDurableCommandStore({
      failFirstRecord: new Error('ledger write failed'),
    });
    const gateway = {
      getExecutionRecord: jest
        .fn()
        .mockResolvedValueOnce(ordering)
        .mockResolvedValueOnce(ordering)
        .mockResolvedValue(ordered),
      resolveUser: jest.fn().mockResolvedValue({
        openId: 'ou_manager',
        name: '测试经理',
        positions: ['设施运维经理'],
        buildings: [],
      }),
      updateExecutionRecord: jest.fn().mockResolvedValue(undefined),
      sendTextNotification: jest.fn(),
    };
    const service = new PurchaseWorkflowService(
      gateway as never,
      durable.store as never,
    );
    const input = {
      actualQuantity: 2,
      actualAmount: 300,
      paymentAttachmentTokens: [],
      note: '',
    };

    await expect(
      service.order('rec_execution_1', session, input),
    ).rejects.toThrow('ledger write failed');
    await expect(
      service.order('rec_execution_1', session, input),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      service.order('rec_execution_1', session, input),
    ).resolves.toMatchObject({ idempotent: true });

    expect(gateway.updateExecutionRecord).toHaveBeenCalledTimes(1);
  });

  it('keeps the durable claim when a Base write has an unknown network outcome', async () => {
    const ordering = record({
      status: '审批通过（待下单）',
      purchaseMethod: '综合采购',
      purchaserOpenId: 'ou_manager',
    });
    const ordered = record({
      ...ordering,
      status: '下单完成（待签收）',
      purchaseCompleted: true,
      actualQuantity: 2,
      actualAmount: 300,
    });
    const durable = createDurableCommandStore();
    const gateway = {
      getExecutionRecord: jest
        .fn()
        .mockResolvedValueOnce(ordering)
        .mockResolvedValueOnce(ordering)
        .mockResolvedValue(ordered),
      resolveUser: jest.fn().mockResolvedValue({
        openId: 'ou_manager',
        name: '测试经理',
        positions: ['设施运维经理'],
        buildings: [],
      }),
      updateExecutionRecord: jest
        .fn()
        .mockRejectedValueOnce(
          Object.assign(new Error('write timed out'), { code: 'ETIMEDOUT' }),
        )
        .mockResolvedValue(undefined),
      sendTextNotification: jest.fn(),
    };
    const service = new PurchaseWorkflowService(
      gateway as never,
      durable.store as never,
    );
    const input = {
      actualQuantity: 2,
      actualAmount: 300,
      paymentAttachmentTokens: [],
      note: '',
    };

    await expect(
      service.order('rec_execution_1', session, input),
    ).rejects.toThrow();
    await expect(
      service.order('rec_execution_1', session, input),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      service.order('rec_execution_1', session, input),
    ).resolves.toMatchObject({ idempotent: true });

    expect(durable.store.releaseCommandClaim).not.toHaveBeenCalled();
    expect(gateway.updateExecutionRecord).toHaveBeenCalledTimes(1);
  });

  it('does not reconcile a pending order claim against different live values', async () => {
    const ordering = record({
      status: '审批通过（待下单）',
      purchaseMethod: '综合采购',
      purchaserOpenId: 'ou_manager',
    });
    const differentOrder = record({
      ...ordering,
      status: '下单完成（待签收）',
      purchaseCompleted: true,
      actualQuantity: 2,
      actualAmount: 999,
    });
    const durable = createDurableCommandStore();
    const gateway = {
      getExecutionRecord: jest
        .fn()
        .mockResolvedValueOnce(ordering)
        .mockResolvedValue(differentOrder),
      resolveUser: jest.fn().mockResolvedValue({
        openId: 'ou_manager',
        name: '测试经理',
        positions: ['设施运维经理'],
        buildings: [],
      }),
      updateExecutionRecord: jest
        .fn()
        .mockRejectedValueOnce(
          Object.assign(new Error('write timed out'), { code: 'ETIMEDOUT' }),
        ),
      sendTextNotification: jest.fn(),
    };
    const service = new PurchaseWorkflowService(
      gateway as never,
      durable.store as never,
    );
    const input = {
      actualQuantity: 2,
      actualAmount: 300,
      paymentAttachmentTokens: [],
      note: '',
    };

    await expect(
      service.order('rec_execution_1', session, input),
    ).rejects.toThrow();
    await expect(
      service.order('rec_execution_1', session, input),
    ).rejects.toThrow('已推进，但结果与本次提交不一致');

    expect(durable.store.recordCommand).not.toHaveBeenCalled();
    expect(gateway.updateExecutionRecord).toHaveBeenCalledTimes(1);
  });

  it('does not reconcile a status-only order when the completion flag is missing', async () => {
    const ordering = record({
      status: '审批通过（待下单）',
      purchaseMethod: '综合采购',
      purchaserOpenId: 'ou_manager',
    });
    const incompleteOrder = record({
      ...ordering,
      status: '下单完成（待签收）',
      purchaseCompleted: false,
      actualQuantity: 2,
      actualAmount: 300,
      paymentAttachmentTokens: [],
      note: '',
    });
    const durable = createDurableCommandStore();
    const gateway = {
      getExecutionRecord: jest
        .fn()
        .mockResolvedValueOnce(ordering)
        .mockResolvedValue(incompleteOrder),
      resolveUser: jest.fn().mockResolvedValue({
        openId: 'ou_manager',
        name: '测试经理',
        positions: ['设施运维经理'],
        buildings: [],
      }),
      updateExecutionRecord: jest
        .fn()
        .mockRejectedValueOnce(
          Object.assign(new Error('write timed out'), { code: 'ETIMEDOUT' }),
        ),
      sendTextNotification: jest.fn(),
    };
    const service = new PurchaseWorkflowService(
      gateway as never,
      durable.store as never,
    );
    const input = {
      actualQuantity: 2,
      actualAmount: 300,
      paymentAttachmentTokens: [],
      note: '',
    };

    await expect(
      service.order('rec_execution_1', session, input),
    ).rejects.toThrow();
    await expect(
      service.order('rec_execution_1', session, input),
    ).rejects.toThrow('已推进，但结果与本次提交不一致');

    expect(durable.store.recordCommand).not.toHaveBeenCalled();
    expect(gateway.updateExecutionRecord).toHaveBeenCalledTimes(1);
  });

  it('does not reconcile a pending order claim against different payment attachments', async () => {
    const ordering = record({
      status: '审批通过（待下单）',
      purchaseMethod: '综合采购',
      purchaserOpenId: 'ou_manager',
    });
    const differentOrder = record({
      ...ordering,
      status: '下单完成（待签收）',
      purchaseCompleted: true,
      actualQuantity: 2,
      actualAmount: 300,
      paymentAttachmentTokens: ['file_other'],
    });
    const durable = createDurableCommandStore();
    const gateway = {
      getExecutionRecord: jest
        .fn()
        .mockResolvedValueOnce(ordering)
        .mockResolvedValue(differentOrder),
      resolveUser: jest.fn().mockResolvedValue({
        openId: 'ou_manager',
        name: '测试经理',
        positions: ['设施运维经理'],
        buildings: [],
      }),
      updateExecutionRecord: jest
        .fn()
        .mockRejectedValueOnce(
          Object.assign(new Error('write timed out'), { code: 'ETIMEDOUT' }),
        ),
      sendTextNotification: jest.fn(),
    };
    const service = new PurchaseWorkflowService(
      gateway as never,
      durable.store as never,
    );
    const input = {
      actualQuantity: 2,
      actualAmount: 300,
      paymentAttachmentTokens: ['file_expected'],
      note: '',
    };

    await expect(
      service.order('rec_execution_1', session, input),
    ).rejects.toThrow();
    await expect(
      service.order('rec_execution_1', session, input),
    ).rejects.toThrow('已推进，但结果与本次提交不一致');

    expect(durable.store.recordCommand).not.toHaveBeenCalled();
    expect(gateway.updateExecutionRecord).toHaveBeenCalledTimes(1);
  });

  it('does not reconcile a pending order claim against a different order note', async () => {
    const ordering = record({
      status: '审批通过（待下单）',
      purchaseMethod: '综合采购',
      purchaserOpenId: 'ou_manager',
    });
    const differentOrder = record({
      ...ordering,
      status: '下单完成（待签收）',
      purchaseCompleted: true,
      actualQuantity: 2,
      actualAmount: 300,
      paymentAttachmentTokens: ['file_same'],
      note: '另一份备注',
    });
    const durable = createDurableCommandStore();
    const gateway = {
      getExecutionRecord: jest
        .fn()
        .mockResolvedValueOnce(ordering)
        .mockResolvedValue(differentOrder),
      resolveUser: jest.fn().mockResolvedValue({
        openId: 'ou_manager',
        name: '测试经理',
        positions: ['设施运维经理'],
        buildings: [],
      }),
      updateExecutionRecord: jest
        .fn()
        .mockRejectedValueOnce(
          Object.assign(new Error('write timed out'), { code: 'ETIMEDOUT' }),
        ),
      sendTextNotification: jest.fn(),
    };
    const service = new PurchaseWorkflowService(
      gateway as never,
      durable.store as never,
    );
    const input = {
      actualQuantity: 2,
      actualAmount: 300,
      paymentAttachmentTokens: ['file_same'],
      note: '本次备注',
    };

    await expect(
      service.order('rec_execution_1', session, input),
    ).rejects.toThrow();
    await expect(
      service.order('rec_execution_1', session, input),
    ).rejects.toThrow('已推进，但结果与本次提交不一致');

    expect(durable.store.recordCommand).not.toHaveBeenCalled();
    expect(gateway.updateExecutionRecord).toHaveBeenCalledTimes(1);
  });

  it('fails closed when a legacy pending claim has no expected-result fingerprint', async () => {
    const ordering = record({
      status: '审批通过（待下单）',
      purchaseMethod: '综合采购',
      purchaserOpenId: 'ou_manager',
    });
    const ordered = record({
      ...ordering,
      status: '下单完成（待签收）',
      purchaseCompleted: true,
      actualQuantity: 2,
      actualAmount: 300,
      paymentAttachmentTokens: [],
      note: '',
    });
    const durable = createDurableCommandStore();
    const gateway = {
      getExecutionRecord: jest
        .fn()
        .mockResolvedValueOnce(ordering)
        .mockResolvedValue(ordered),
      resolveUser: jest.fn().mockResolvedValue({
        openId: 'ou_manager',
        name: '测试经理',
        positions: ['设施运维经理'],
        buildings: [],
      }),
      updateExecutionRecord: jest
        .fn()
        .mockRejectedValueOnce(
          Object.assign(new Error('write timed out'), { code: 'ETIMEDOUT' }),
        ),
      sendTextNotification: jest.fn(),
    };
    const service = new PurchaseWorkflowService(
      gateway as never,
      durable.store as never,
    );
    const input = {
      actualQuantity: 2,
      actualAmount: 300,
      paymentAttachmentTokens: [],
      note: '',
    };

    await expect(
      service.order('rec_execution_1', session, input),
    ).rejects.toThrow();
    const pending = durable.current();
    if (pending) pending.expectedResultFingerprint = '';

    await expect(
      service.order('rec_execution_1', session, input),
    ).rejects.toThrow('已推进，但结果与本次提交不一致');
    expect(durable.store.recordCommand).not.toHaveBeenCalled();
    expect(gateway.updateExecutionRecord).toHaveBeenCalledTimes(1);
  });

  it('does not reconcile a pending start claim against a different purchaser', async () => {
    const approved = record({
      status: '审批通过（待库房确认）',
      purchaseMethod: '综合采购',
      warehouseConfirmed: false,
    });
    const wronglyAssigned = record({
      ...approved,
      status: '审批通过（待下单）',
      warehouseConfirmed: true,
      purchaserOpenId: 'ou_other_buyer',
    });
    const durable = createDurableCommandStore();
    const gateway = {
      getExecutionRecord: jest
        .fn()
        .mockResolvedValueOnce(approved)
        .mockResolvedValue(wronglyAssigned),
      resolveUser: jest.fn().mockResolvedValue({
        openId: 'ou_manager',
        name: '测试经理',
        positions: ['设施运维经理'],
        buildings: [],
      }),
      findComprehensivePurchaser: jest.fn().mockResolvedValue({
        openId: 'ou_expected_buyer',
        name: '综合采购人',
        positions: [],
        buildings: [],
      }),
      updateExecutionRecord: jest
        .fn()
        .mockRejectedValueOnce(
          Object.assign(new Error('write timed out'), { code: 'ETIMEDOUT' }),
        ),
      sendTextNotification: jest.fn(),
    };
    const service = new PurchaseWorkflowService(
      gateway as never,
      durable.store as never,
    );

    await expect(service.start('rec_execution_1', session)).rejects.toThrow();
    await expect(service.start('rec_execution_1', session)).rejects.toThrow(
      '已推进，但结果与本次提交不一致',
    );

    expect(durable.store.recordCommand).not.toHaveBeenCalled();
    expect(gateway.updateExecutionRecord).toHaveBeenCalledTimes(1);
  });

  it('does not reconcile a pending receipt claim against a different signer account', async () => {
    const awaitingReceipt = record({
      status: '下单完成（待签收）',
      purchaseMethod: '综合采购',
      purchaserOpenId: 'ou_manager',
      actualQuantity: 2,
      actualAmount: 300,
    });
    const signedByAnotherUser = record({
      ...awaitingReceipt,
      status: '到货已签收（待入库）',
      receiptConfirmed: true,
      signer: '另一签收人',
      signerOpenId: 'ou_other_signer',
      receiptTime: 1785456000000,
      receiptPhotoTokens: ['file_receipt'],
      invoiceTokens: [],
      note: '完好',
    });
    const durable = createDurableCommandStore();
    const gateway = {
      getExecutionRecord: jest
        .fn()
        .mockResolvedValueOnce(awaitingReceipt)
        .mockResolvedValue(signedByAnotherUser),
      resolveUser: jest.fn().mockResolvedValue({
        openId: 'ou_manager',
        name: '测试经理',
        positions: ['设施运维经理'],
        buildings: [],
      }),
      updateExecutionRecord: jest
        .fn()
        .mockRejectedValueOnce(
          Object.assign(new Error('write timed out'), { code: 'ETIMEDOUT' }),
        ),
      sendTextNotification: jest.fn(),
    };
    const service = new PurchaseWorkflowService(
      gateway as never,
      durable.store as never,
    );
    const input = {
      signer: '签收人',
      signerOpenId: 'ou_expected_signer',
      receiptTime: 1785456000000,
      receiptPhotoTokens: ['file_receipt'],
      invoiceTokens: [],
      note: '完好',
    };

    await expect(
      service.receive('rec_execution_1', session, input),
    ).rejects.toThrow();
    await expect(
      service.receive('rec_execution_1', session, input),
    ).rejects.toThrow('已推进，但结果与本次提交不一致');

    expect(durable.store.recordCommand).not.toHaveBeenCalled();
    expect(gateway.updateExecutionRecord).toHaveBeenCalledTimes(1);
  });

  it('reconciles an approved payload whose patch actually rejects the purchase', async () => {
    const application = record({
      status: '未开始（待审批）',
    });
    const rejected = record({
      ...application,
      status: '驳回申请',
      purchaseMethod: '驳回',
    });
    const durable = createDurableCommandStore();
    const gateway = {
      getExecutionRecord: jest
        .fn()
        .mockResolvedValueOnce(application)
        .mockResolvedValue(rejected),
      resolveUser: jest.fn().mockResolvedValue({
        openId: 'ou_manager',
        name: '测试经理',
        positions: ['设施运维经理'],
        buildings: [],
      }),
      updateExecutionRecord: jest
        .fn()
        .mockRejectedValueOnce(
          Object.assign(new Error('write timed out'), { code: 'ETIMEDOUT' }),
        ),
      sendTextNotification: jest.fn(),
    };
    const service = new PurchaseWorkflowService(
      gateway as never,
      durable.store as never,
    );
    const input = {
      decision: 'approved' as const,
      purchaseMethod: '驳回' as const,
      comment: '',
    };

    await expect(
      service.approve('rec_execution_1', session, input),
    ).rejects.toThrow();
    await expect(
      service.approve('rec_execution_1', session, input),
    ).resolves.toMatchObject({ idempotent: true });

    expect(gateway.updateExecutionRecord).toHaveBeenCalledTimes(1);
  });

  it('does not reconcile an approved purchase against a terminated live record', async () => {
    const application = record({
      status: '未开始（待审批）',
    });
    const terminated = record({
      ...application,
      status: '已终止',
      purchaseMethod: '综合采购',
    });
    const durable = createDurableCommandStore();
    const gateway = {
      getExecutionRecord: jest
        .fn()
        .mockResolvedValueOnce(application)
        .mockResolvedValue(terminated),
      resolveUser: jest.fn().mockResolvedValue({
        openId: 'ou_manager',
        name: '测试经理',
        positions: ['设施运维经理'],
        buildings: [],
      }),
      updateExecutionRecord: jest
        .fn()
        .mockRejectedValueOnce(
          Object.assign(new Error('write timed out'), { code: 'ETIMEDOUT' }),
        ),
      sendTextNotification: jest.fn(),
    };
    const service = new PurchaseWorkflowService(
      gateway as never,
      durable.store as never,
    );
    const input = {
      decision: 'approved' as const,
      purchaseMethod: '综合采购' as const,
      comment: '',
    };

    await expect(
      service.approve('rec_execution_1', session, input),
    ).rejects.toThrow();
    await expect(
      service.approve('rec_execution_1', session, input),
    ).rejects.toThrow('已推进，但结果与本次提交不一致');

    expect(durable.store.recordCommand).not.toHaveBeenCalled();
    expect(gateway.updateExecutionRecord).toHaveBeenCalledTimes(1);
  });

  it('rejects a different payload after a durable command completes', async () => {
    const ordering = record({
      status: '审批通过（待下单）',
      purchaseMethod: '综合采购',
      purchaserOpenId: 'ou_manager',
    });
    const ordered = record({
      ...ordering,
      status: '下单完成（待签收）',
      purchaseCompleted: true,
      actualQuantity: 2,
      actualAmount: 300,
    });
    const durable = createDurableCommandStore();
    const gateway = {
      getExecutionRecord: jest
        .fn()
        .mockResolvedValueOnce(ordering)
        .mockResolvedValue(ordered),
      resolveUser: jest.fn().mockResolvedValue({
        openId: 'ou_manager',
        name: '测试经理',
        positions: ['设施运维经理'],
        buildings: [],
      }),
      updateExecutionRecord: jest.fn().mockResolvedValue(undefined),
      sendTextNotification: jest.fn(),
    };
    const service = new PurchaseWorkflowService(
      gateway as never,
      durable.store as never,
    );

    await service.order('rec_execution_1', session, {
      actualQuantity: 2,
      actualAmount: 300,
      paymentAttachmentTokens: [],
      note: '',
    });
    await expect(
      service.order('rec_execution_1', session, {
        actualQuantity: 2,
        actualAmount: 301,
        paymentAttachmentTokens: [],
        note: '',
      }),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(gateway.updateExecutionRecord).toHaveBeenCalledTimes(1);
  });

  it('releases an expired pre-PUT claim before accepting a new payload', async () => {
    const ordering = record({
      status: '审批通过（待下单）',
      purchaseMethod: '综合采购',
      purchaserOpenId: 'ou_manager',
    });
    const ordered = record({
      ...ordering,
      status: '下单完成（待签收）',
      purchaseCompleted: true,
      actualQuantity: 2,
      actualAmount: 301,
    });
    const durable = createDurableCommandStore();
    await durable.store.claimCommand({
      key: 'order:rec_execution_1',
      recordId: 'rec_execution_1',
      action: 'order',
      fingerprint: 'expired-fingerprint',
      expectedResultFingerprint: 'legacy-expected-result',
      actorOpenId: 'ou_manager',
      accessRole: 'admin',
      authenticationMode: 'delegated-app',
      startedAt: '2026-07-31T00:00:00.000Z',
    });
    const gateway = {
      getExecutionRecord: jest
        .fn()
        .mockResolvedValueOnce(ordering)
        .mockResolvedValueOnce(ordering)
        .mockResolvedValue(ordered),
      resolveUser: jest.fn().mockResolvedValue({
        openId: 'ou_manager',
        name: '测试经理',
        positions: ['设施运维经理'],
        buildings: [],
      }),
      updateExecutionRecord: jest.fn().mockResolvedValue(undefined),
      sendTextNotification: jest.fn(),
    };
    const service = new PurchaseWorkflowService(
      gateway as never,
      durable.store as never,
    );

    await expect(
      service.order('rec_execution_1', session, {
        actualQuantity: 2,
        actualAmount: 301,
        paymentAttachmentTokens: [],
        note: '',
      }),
    ).resolves.toMatchObject({ idempotent: false });

    expect(durable.store.releaseCommandClaim).toHaveBeenCalledWith(
      'order:rec_execution_1',
      'expired-fingerprint',
    );
    expect(gateway.updateExecutionRecord).toHaveBeenCalledTimes(1);
  });

  it('enqueues one idempotent approval request for every configured approver', async () => {
    const gateway = {
      getExecutionRecordAsApp: jest.fn().mockResolvedValue(record()),
      resolveConfiguredApproversAsApp: jest.fn().mockResolvedValue([
        {
          openId: 'ou_manager_1',
          name: '经理甲',
          positions: [],
          buildings: [],
        },
        {
          openId: 'ou_manager_2',
          name: '经理乙',
          positions: [],
          buildings: [],
        },
      ]),
    };
    const store = {
      listPendingOrderNoticeCommands: jest.fn().mockResolvedValue([]),
      enqueueNotifications: jest.fn().mockResolvedValue([]),
    };
    const service = new PurchaseWorkflowService(
      gateway as never,
      store as never,
    );

    await service.enqueueApprovalRequests('rec_execution_1');
    await service.enqueueApprovalRequests('rec_execution_1');

    expect(store.enqueueNotifications).toHaveBeenCalledTimes(2);
    expect(store.enqueueNotifications).toHaveBeenNthCalledWith(1, [
      {
        businessEventId: 'approval-requested:rec_execution_1',
        recordId: 'rec_execution_1',
        recipientOpenId: 'ou_manager_1',
        kind: 'approval_requested',
      },
      {
        businessEventId: 'approval-requested:rec_execution_1',
        recordId: 'rec_execution_1',
        recipientOpenId: 'ou_manager_2',
        kind: 'approval_requested',
      },
    ]);
  });

  it('does not enqueue or recover legacy per-record approvals when manager batch cards are enabled', async () => {
    process.env.PURCHASE_MANAGER_APPROVAL_CARD_ENABLED = 'true';
    const gateway = {
      resolveConfiguredApproversAsApp: jest.fn(),
      listExecutionRecordsAsApp: jest
        .fn()
        .mockResolvedValue([record({ recordId: 'rec_execution_batch_1' })]),
    };
    const store = {
      listPendingOrderNoticeCommands: jest.fn().mockResolvedValue([]),
      enqueueNotifications: jest.fn(),
      takeNextNotification: jest.fn().mockResolvedValue(null),
      takeNextCardAction: jest.fn().mockResolvedValue(null),
    };
    const service = new PurchaseWorkflowService(
      gateway as never,
      store as never,
    );

    await service.enqueueApprovalRequests('rec_execution_batch_1');
    await expect(service.runPendingTasks(1)).resolves.toMatchObject({
      recoveredApprovalRequests: 0,
    });

    expect(gateway.resolveConfiguredApproversAsApp).not.toHaveBeenCalled();
    expect(store.enqueueNotifications).not.toHaveBeenCalled();
  });

  it('keeps optional workflow notifications disabled but still persists accepted inbound completion work', async () => {
    process.env.PURCHASE_WORKFLOW_PROGRAM_ENABLED = 'false';
    const gateway = {
      resolveConfiguredApproversAsApp: jest.fn(),
      getExecutionRecordAsApp: jest
        .fn()
        .mockResolvedValue(record({ status: '物品签收已入库' })),
      resolveInboundResponsibleUsersAsApp: jest.fn(),
      resolvePurchaseAdminAsApp: jest.fn(),
    };
    const store = {
      listPendingOrderNoticeCommands: jest.fn().mockResolvedValue([]),
      enqueueNotifications: jest.fn().mockResolvedValue([{ enqueued: true }]),
    };
    const service = new PurchaseWorkflowService(
      gateway as never,
      store as never,
    );

    await expect(
      service.enqueueApprovalRequests('rec_execution_1'),
    ).resolves.toBeUndefined();
    await expect(
      service.enqueueWarehouseInboundNotifications('rec_execution_1'),
    ).resolves.toBe(0);
    await expect(
      service.enqueueCompletionNotifications('rec_execution_1'),
    ).resolves.toBe(1);

    expect(gateway.resolveConfiguredApproversAsApp).not.toHaveBeenCalled();
    expect(gateway.getExecutionRecordAsApp).not.toHaveBeenCalled();
    expect(gateway.resolveInboundResponsibleUsersAsApp).not.toHaveBeenCalled();
    expect(gateway.resolvePurchaseAdminAsApp).not.toHaveBeenCalled();
    expect(store.enqueueNotifications).toHaveBeenCalledWith([
      {
        businessEventId:
          'inventory-inbound-completed-resolution:rec_execution_1',
        recordId: 'rec_execution_1',
        recipientOpenId: 'system',
        kind: 'inventory_inbound_completed_resolution',
      },
    ]);
  });

  it('enqueues an inbound card notification for every warehouse responsible user after the receipt Base write succeeds', async () => {
    const before = record({
      status: '下单完成（待签收）',
      purchaseMethod: '综合采购',
      purchaserOpenId: 'ou_purchaser',
      purchaserName: '采购员',
      actualQuantity: 8,
      purchaseCompleted: true,
    });
    const after = record({
      ...before,
      status: '到货已签收（待入库）',
      receiptConfirmed: true,
      signer: '签收人',
      receiptTime: 1784246400000,
      unit: '件',
    });
    const gateway = {
      getExecutionRecord: jest
        .fn()
        .mockResolvedValueOnce(before)
        .mockResolvedValue(after),
      getExecutionRecordAsApp: jest.fn().mockResolvedValue(after),
      resolveUser: jest.fn().mockResolvedValue({
        openId: 'ou_manager',
        name: '测试经理',
        positions: ['设施运维经理'],
        buildings: [],
      }),
      updateExecutionRecord: jest.fn().mockResolvedValue(undefined),
      sendTextNotification: jest.fn().mockResolvedValue(['om_receipt']),
      resolveInboundResponsibleUsersAsApp: jest.fn().mockResolvedValue([
        {
          openId: 'ou_warehouse_1',
          name: '库存管理员甲',
          positions: [],
          buildings: ['H楼'],
        },
        {
          openId: 'ou_warehouse_2',
          name: '库存管理员乙',
          positions: [],
          buildings: ['H楼'],
        },
      ]),
      resolveInboundManagerNotificationUsersAsApp: jest.fn(),
    };
    const store = {
      listPendingOrderNoticeCommands: jest.fn().mockResolvedValue([]),
      findCommand: jest.fn().mockResolvedValue(null),
      claimCommand: jest.fn(claimedCommand),
      releaseCommandClaim: jest.fn().mockResolvedValue(true),
      recordCommand: jest.fn().mockResolvedValue(undefined),
      enqueueNotifications: jest
        .fn()
        .mockResolvedValue([{ enqueued: true }, { enqueued: true }]),
    };
    const service = new PurchaseWorkflowService(
      gateway as never,
      store as never,
    );

    const result = await service.receive('rec_execution_1', session, {
      signer: '签收人',
      signerOpenId: 'ou_signer',
      receiptTime: 1784246400000,
      receiptPhotoTokens: ['file_receipt'],
      invoiceTokens: [],
      note: '',
    });

    expect(gateway.updateExecutionRecord).toHaveBeenCalledTimes(1);
    expect(gateway.resolveInboundResponsibleUsersAsApp).toHaveBeenCalledWith(
      'H楼',
    );
    expect(
      gateway.resolveInboundManagerNotificationUsersAsApp,
    ).not.toHaveBeenCalled();
    expect(store.enqueueNotifications).toHaveBeenCalledWith([
      {
        businessEventId: 'warehouse-inbound:rec_execution_1',
        recordId: 'rec_execution_1',
        recipientOpenId: 'ou_warehouse_1',
        kind: 'warehouse_inbound',
      },
      {
        businessEventId: 'warehouse-inbound:rec_execution_1',
        recordId: 'rec_execution_1',
        recipientOpenId: 'ou_warehouse_2',
        kind: 'warehouse_inbound',
      },
    ]);
    expect(result.notificationWarnings).toEqual([]);
  });

  it('keeps a successful receipt command when inbound enqueue fails and lets an idempotent retry repair it', async () => {
    const before = record({
      status: '下单完成（待签收）',
      purchaseMethod: '综合采购',
      purchaserOpenId: 'ou_purchaser',
      actualQuantity: 2,
      purchaseCompleted: true,
    });
    const after = record({
      ...before,
      status: '到货已签收（待入库）',
      receiptConfirmed: true,
      signer: '签收人',
      receiptTime: 1784246400000,
    });
    let savedCommand: Record<string, unknown> | null = null;
    const gateway = {
      getExecutionRecord: jest
        .fn()
        .mockResolvedValueOnce(before)
        .mockResolvedValue(after),
      getExecutionRecordAsApp: jest.fn().mockResolvedValue(after),
      resolveUser: jest.fn().mockResolvedValue({
        openId: 'ou_manager',
        name: '测试经理',
        positions: ['设施运维经理'],
        buildings: [],
      }),
      updateExecutionRecord: jest.fn().mockResolvedValue(undefined),
      sendTextNotification: jest.fn().mockResolvedValue(['om_receipt']),
      resolveInboundResponsibleUsersAsApp: jest.fn().mockResolvedValue([
        {
          openId: 'ou_warehouse',
          name: '库存管理员',
          positions: [],
          buildings: ['H楼'],
        },
      ]),
    };
    const store = {
      listPendingOrderNoticeCommands: jest.fn().mockResolvedValue([]),
      findCommand: jest.fn().mockImplementation(async () => savedCommand),
      claimCommand: jest.fn(async (input: Record<string, unknown>) => ({
        claimed: true,
        entry: {
          ...input,
          completedAt: '',
          notificationWarnings: [],
        },
      })),
      releaseCommandClaim: jest.fn().mockResolvedValue(true),
      recordCommand: jest
        .fn()
        .mockImplementation(async (command: Record<string, unknown>) => {
          savedCommand = command;
        }),
      enqueueNotifications: jest
        .fn()
        .mockRejectedValueOnce(new Error('入库通知队列不可用'))
        .mockResolvedValueOnce([{ enqueued: true }]),
    };
    const service = new PurchaseWorkflowService(
      gateway as never,
      store as never,
    );
    const input = {
      signer: '签收人',
      signerOpenId: 'ou_signer',
      receiptTime: 1784246400000,
      receiptPhotoTokens: ['file_receipt'],
      invoiceTokens: [],
      note: '',
    };

    const first = await service.receive('rec_execution_1', session, input);
    const second = await service.receive('rec_execution_1', session, input);

    expect(first.idempotent).toBe(false);
    expect(first.notificationWarnings).toEqual(['入库通知队列不可用']);
    expect(second.idempotent).toBe(true);
    expect(second.notificationWarnings).toEqual([]);
    expect(gateway.updateExecutionRecord).toHaveBeenCalledTimes(1);
    expect(store.recordCommand).toHaveBeenCalledTimes(1);
    expect(store.enqueueNotifications).toHaveBeenCalledTimes(2);
  });

  it('resolves warehouse responsible users only for the receipt record building', async () => {
    const gateway = {
      getExecutionRecordAsApp: jest.fn().mockResolvedValue(
        record({
          status: '到货已签收（待入库）',
          building: 'D楼',
          receiptConfirmed: true,
        }),
      ),
      resolveInboundResponsibleUsersAsApp: jest.fn().mockResolvedValue([
        {
          openId: 'ou_d_warehouse',
          name: 'D楼库存管理员',
          positions: [],
          buildings: ['D楼'],
        },
      ]),
    };
    const store = {
      listPendingOrderNoticeCommands: jest.fn().mockResolvedValue([]),
      enqueueNotifications: jest
        .fn()
        .mockImplementation(async (inputs: unknown[]) =>
          inputs.map(() => ({ enqueued: true })),
        ),
    };
    const service = new PurchaseWorkflowService(
      gateway as never,
      store as never,
    );

    await service.enqueueWarehouseInboundNotifications('rec_execution_1');

    expect(gateway.resolveInboundResponsibleUsersAsApp).toHaveBeenCalledTimes(
      1,
    );
    expect(gateway.resolveInboundResponsibleUsersAsApp).toHaveBeenCalledWith(
      'D楼',
    );
    expect(store.enqueueNotifications).toHaveBeenCalledWith([
      expect.objectContaining({
        recipientOpenId: 'ou_d_warehouse',
        kind: 'warehouse_inbound',
      }),
    ]);
  });

  it('delivers a ready card notification before a slow recovery scan settles', async () => {
    process.env.PURCHASE_MANAGER_APPROVAL_CARD_ENABLED = 'true';
    const now = new Date('2026-09-15T01:00:00.000Z');
    const notification = {
      key: 'approval-requested:rec_execution_1:rec_execution_1:ou_manager_1',
      businessEventId: 'approval-requested:rec_execution_1',
      recordId: 'rec_execution_1',
      recipientOpenId: 'ou_manager_1',
      kind: 'approval_requested',
      status: 'processing',
      attempts: 1,
      claimToken: 'claim-ready-notification',
    };
    const inboundRecords = [1, 2].map((index) =>
      record({
        recordId: `rec_pending_inbound_${index}`,
        status: '到货已签收（待入库）',
        receiptConfirmed: true,
      }),
    );
    let finishRecoveryScan!: (records: PurchaseWorkflowRecord[]) => void;
    const pendingRecoveryScan = new Promise<PurchaseWorkflowRecord[]>(
      (resolve) => {
        finishRecoveryScan = resolve;
      },
    );
    const gateway = {
      listExecutionRecordsAsApp: jest
        .fn()
        .mockImplementation(() => pendingRecoveryScan),
      resolveConfiguredApproversAsApp: jest.fn().mockResolvedValue([]),
      resolveInboundResponsibleUsersAsApp: jest.fn().mockResolvedValue([
        {
          openId: 'ou_warehouse',
          name: '库房责任人',
          positions: [],
          buildings: ['H楼'],
        },
      ]),
      getExecutionRecordAsApp: jest.fn().mockResolvedValue(record()),
      sendInteractiveCard: jest.fn().mockResolvedValue('om_ready_card'),
    };
    const store = {
      listPendingOrderNoticeCommands: jest.fn().mockResolvedValue([]),
      takeNextNotification: jest
        .fn()
        .mockResolvedValueOnce(notification)
        .mockResolvedValue(null),
      takeNextCardAction: jest.fn().mockResolvedValue(null),
      listNotifications: jest.fn().mockResolvedValue([]),
      enqueueNotifications: jest
        .fn()
        .mockImplementation(async (inputs: unknown[]) =>
          inputs.map(() => ({ enqueued: true })),
        ),
      completeNotification: jest.fn().mockResolvedValue(undefined),
      rescheduleNotification: jest.fn(),
      failNotification: jest.fn(),
    };
    const service = new PurchaseWorkflowService(
      gateway as never,
      store as never,
    );

    const run = service.runPendingTasks(2, now);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const cardsSentWhileRecoveryWasPending =
      gateway.sendInteractiveCard.mock.calls.length;
    expect(gateway.listExecutionRecordsAsApp).toHaveBeenCalledTimes(1);

    finishRecoveryScan(inboundRecords);
    await expect(run).resolves.toMatchObject({
      processed: 1,
      failed: 0,
      recoveredWarehouseInboundNotifications: 1,
    });

    expect(cardsSentWhileRecoveryWasPending).toBe(1);
    expect(store.enqueueNotifications).toHaveBeenCalledTimes(1);
    expect(store.completeNotification).toHaveBeenCalledWith(
      notification.key,
      notification.claimToken,
      { messageId: 'om_ready_card' },
      now,
    );
  });

  it('does not rescan pending inbound records inside the recovery interval', async () => {
    process.env.PURCHASE_MANAGER_APPROVAL_CARD_ENABLED = 'true';
    const now = new Date('2026-09-15T01:00:00.000Z');
    const gateway = {
      listExecutionRecordsAsApp: jest.fn().mockResolvedValue([]),
    };
    const store = {
      listPendingOrderNoticeCommands: jest.fn().mockResolvedValue([]),
      takeNextNotification: jest.fn().mockResolvedValue(null),
      takeNextCardAction: jest.fn().mockResolvedValue(null),
    };
    const service = new PurchaseWorkflowService(
      gateway as never,
      store as never,
    );

    await service.runPendingTasks(20, now);
    await service.runPendingTasks(20, new Date(now.getTime() + 5_000));

    expect(gateway.listExecutionRecordsAsApp).toHaveBeenCalledTimes(1);

    await service.runPendingTasks(20, new Date(now.getTime() + 60_000));
    expect(gateway.listExecutionRecordsAsApp).toHaveBeenCalledTimes(2);
  });

  it('scans past complete records to recover a missing approval request beyond the first twenty', async () => {
    const approvers = [
      {
        openId: 'ou_manager_1',
        name: '经理甲',
        positions: [],
        buildings: [],
      },
      {
        openId: 'ou_manager_2',
        name: '经理乙',
        positions: [],
        buildings: [],
      },
    ];
    const records = Array.from({ length: 21 }, (_, index) =>
      record({
        recordId: `rec_execution_${index + 1}`,
        requestCode: `CG-${index + 1}`,
      }),
    );
    const notifications = new Map<string, Array<Record<string, unknown>>>();
    for (const item of records.slice(0, 20)) {
      notifications.set(
        item.recordId,
        approvers.map((approver) => ({
          recordId: item.recordId,
          recipientOpenId: approver.openId,
          kind: 'approval_requested',
          status: 'completed',
          messageId: `om_${item.recordId}_${approver.openId}`,
        })),
      );
    }
    notifications.set('rec_execution_21', [
      {
        recordId: 'rec_execution_21',
        recipientOpenId: 'ou_manager_1',
        kind: 'approval_requested',
        status: 'completed',
        messageId: 'om_21_1',
      },
    ]);
    const gateway = {
      listExecutionRecordsAsApp: jest.fn().mockResolvedValue(records),
      resolveConfiguredApproversAsApp: jest.fn().mockResolvedValue(approvers),
    };
    const store = {
      listPendingOrderNoticeCommands: jest.fn().mockResolvedValue([]),
      listNotifications: jest
        .fn()
        .mockImplementation(async ({ recordId }: { recordId: string }) => [
          ...(notifications.get(recordId) || []),
        ]),
      enqueueNotifications: jest
        .fn()
        .mockImplementation(async (inputs: Array<Record<string, unknown>>) => {
          const results: Array<{
            enqueued: boolean;
            entry: Record<string, unknown>;
          }> = [];
          for (const input of inputs) {
            const recordId = String(input.recordId);
            const current = notifications.get(recordId) || [];
            const exists = !current.some(
              (entry) => entry.recipientOpenId === input.recipientOpenId,
            );
            if (exists) {
              current.push({ ...input, status: 'pending', messageId: '' });
              notifications.set(recordId, current);
            }
            results.push({
              enqueued: exists,
              entry: input,
            });
          }
          return results;
        }),
      takeNextNotification: jest.fn().mockResolvedValue(null),
      takeNextCardAction: jest.fn().mockResolvedValue(null),
    };
    const service = new PurchaseWorkflowService(
      gateway as never,
      store as never,
    );

    await expect(service.runPendingTasks(20)).resolves.toMatchObject({
      recoveredApprovalRequests: 1,
    });
    expect(store.enqueueNotifications).toHaveBeenCalledWith([
      {
        businessEventId: 'approval-requested:rec_execution_21',
        recordId: 'rec_execution_21',
        recipientOpenId: 'ou_manager_2',
        kind: 'approval_requested',
      },
    ]);
  });

  it('scans past complete inbound records and recovers a missing warehouse notification beyond the limit-sized prefix', async () => {
    const records = Array.from({ length: 21 }, (_, index) =>
      record({
        recordId: `rec_inbound_${index + 1}`,
        requestCode: `CG-IN-${index + 1}`,
        status: '到货已签收（待入库）',
        building: 'D楼',
        receiptConfirmed: true,
      }),
    );
    const gateway = {
      listExecutionRecordsAsApp: jest.fn().mockResolvedValue(records),
      resolveConfiguredApproversAsApp: jest.fn().mockResolvedValue([]),
      resolveInboundResponsibleUsersAsApp: jest.fn().mockResolvedValue([
        {
          openId: 'ou_warehouse_1',
          name: '库存管理员甲',
          positions: [],
          buildings: ['D楼'],
        },
        {
          openId: 'ou_warehouse_2',
          name: '库存管理员乙',
          positions: [],
          buildings: ['D楼'],
        },
      ]),
    };
    const store = {
      listPendingOrderNoticeCommands: jest.fn().mockResolvedValue([]),
      listNotifications: jest
        .fn()
        .mockImplementation(
          async ({ recordId, kind }: { recordId: string; kind: string }) => {
            if (kind !== 'warehouse_inbound') return [];
            if (recordId === 'rec_inbound_21') {
              return [
                {
                  recordId,
                  recipientOpenId: 'ou_warehouse_1',
                  kind,
                  status: 'completed',
                  messageId: 'om_existing',
                },
              ];
            }
            return ['ou_warehouse_1', 'ou_warehouse_2'].map((openId) => ({
              recordId,
              recipientOpenId: openId,
              kind,
              status: 'completed',
              messageId: `om_${recordId}_${openId}`,
            }));
          },
        ),
      enqueueNotifications: jest.fn().mockResolvedValue([{ enqueued: true }]),
      takeNextNotification: jest.fn().mockResolvedValue(null),
      takeNextCardAction: jest.fn().mockResolvedValue(null),
    };
    const service = new PurchaseWorkflowService(
      gateway as never,
      store as never,
    );

    await expect(service.runPendingTasks(20)).resolves.toMatchObject({
      recoveredWarehouseInboundNotifications: 1,
      failed: 0,
    });
    expect(store.enqueueNotifications).toHaveBeenCalledWith([
      {
        businessEventId: 'warehouse-inbound:rec_inbound_21',
        recordId: 'rec_inbound_21',
        recipientOpenId: 'ou_warehouse_2',
        kind: 'warehouse_inbound',
      },
    ]);
  });

  it('continues inbound recovery after a record-specific resolution error', async () => {
    const records = [
      record({
        recordId: 'rec_inbound_bad',
        status: '到货已签收（待入库）',
        building: 'A楼',
      }),
      record({
        recordId: 'rec_inbound_good',
        status: '到货已签收（待入库）',
        building: 'B楼',
      }),
    ];
    const gateway = {
      listExecutionRecordsAsApp: jest.fn().mockResolvedValue(records),
      resolveConfiguredApproversAsApp: jest.fn().mockResolvedValue([]),
      resolveInboundResponsibleUsersAsApp: jest
        .fn()
        .mockRejectedValueOnce(new Error('A楼管理员配置错误'))
        .mockResolvedValueOnce([
          {
            openId: 'ou_b_warehouse',
            name: 'B楼库存管理员',
            positions: [],
            buildings: ['B楼'],
          },
        ]),
    };
    const store = {
      listPendingOrderNoticeCommands: jest.fn().mockResolvedValue([]),
      listNotifications: jest.fn().mockResolvedValue([]),
      enqueueNotifications: jest.fn().mockResolvedValue([{ enqueued: true }]),
      takeNextNotification: jest.fn().mockResolvedValue(null),
      takeNextCardAction: jest.fn().mockResolvedValue(null),
    };
    const service = new PurchaseWorkflowService(
      gateway as never,
      store as never,
    );

    await expect(service.runPendingTasks(20)).resolves.toMatchObject({
      recoveredWarehouseInboundNotifications: 1,
      failed: 1,
      errors: [expect.stringContaining('rec_inbound_bad')],
    });
    expect(store.enqueueNotifications).toHaveBeenCalledWith([
      expect.objectContaining({
        recordId: 'rec_inbound_good',
        recipientOpenId: 'ou_b_warehouse',
      }),
    ]);
  });

  it('processes one approved card action and routes procurement to the configured admin', async () => {
    const before = record({
      purchaseMethod: '综合采购',
      unit: '件',
      unitPrice: 20,
      createdAt: 1784246400000,
    });
    const action = {
      key: 'approval:rec_execution_1',
      eventId: 'evt_1',
      recordId: 'rec_execution_1',
      action: 'approve',
      actorOpenId: 'ou_manager_1',
      status: 'processing',
      attempts: 1,
      claimToken: 'claim-token-1',
    };
    const gateway = {
      listExecutionRecordsAsApp: jest.fn().mockResolvedValue([]),
      getExecutionRecordAsApp: jest.fn().mockResolvedValue(before),
      resolveConfiguredApproversAsApp: jest.fn().mockResolvedValue([
        {
          openId: 'ou_manager_1',
          name: '经理甲',
          positions: [],
          buildings: [],
        },
        {
          openId: 'ou_manager_2',
          name: '经理乙',
          positions: [],
          buildings: [],
        },
      ]),
      resolvePurchaseAdminAsApp: jest.fn().mockResolvedValue({
        openId: 'ou_purchase_admin',
        name: '采购管理员',
        positions: [],
        buildings: [],
      }),
      updateExecutionRecordAsApp: jest.fn().mockResolvedValue(undefined),
    };
    const store = {
      listPendingOrderNoticeCommands: jest.fn().mockResolvedValue([]),
      takeNextCardAction: jest
        .fn()
        .mockResolvedValueOnce(action)
        .mockResolvedValue(null),
      takeNextNotification: jest.fn().mockResolvedValue(null),
      listNotifications: jest
        .fn()
        .mockResolvedValue(
          completedApprovalNotifications(['ou_manager_1', 'ou_manager_2']),
        ),
      enqueueNotifications: jest.fn().mockResolvedValue([]),
      completeCardAction: jest.fn().mockResolvedValue(undefined),
      rescheduleCardAction: jest.fn(),
      failCardAction: jest.fn(),
    };
    const service = new PurchaseWorkflowService(
      gateway as never,
      store as never,
    );

    await expect(service.runPendingTasks(1)).resolves.toMatchObject({
      processed: 1,
      failed: 0,
    });
    expect(gateway.updateExecutionRecordAsApp).toHaveBeenCalledWith(
      'rec_execution_1',
      {
        '1️⃣物品采购方式': '综合采购',
        采购人: [{ id: 'ou_purchase_admin' }],
        库房确认: true,
        采购流程: '审批通过（待下单）',
      },
    );
    expect(store.enqueueNotifications).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'approval_resolved',
          recipientOpenId: 'ou_manager_1',
        }),
        expect.objectContaining({
          kind: 'approval_resolved',
          recipientOpenId: 'ou_manager_2',
        }),
        expect.objectContaining({
          kind: 'purchase_assigned',
          recipientOpenId: 'ou_purchase_admin',
        }),
      ]),
    );
    expect(store.completeCardAction).toHaveBeenCalledWith(
      action.key,
      action.claimToken,
      expect.any(Date),
    );
  });

  it('routes a building self-purchase to the building supervisor instead of the requester', async () => {
    const action = {
      key: 'approval:rec_execution_1',
      eventId: 'evt_self',
      recordId: 'rec_execution_1',
      action: 'approve',
      actorOpenId: 'ou_manager_1',
      status: 'processing',
      attempts: 1,
      claimToken: 'claim-self',
    };
    const gateway = {
      listExecutionRecordsAsApp: jest.fn().mockResolvedValue([]),
      resolveConfiguredApproversAsApp: jest.fn().mockResolvedValue([]),
      getExecutionRecordAsApp: jest.fn().mockResolvedValue(
        record({
          building: 'A楼',
          purchaseMethod: '需求自采',
        }),
      ),
      resolveConfiguredApproversAsApp: jest.fn().mockResolvedValue([
        {
          openId: 'ou_manager_1',
          name: '经理甲',
          positions: [],
          buildings: [],
        },
      ]),
      resolveBuildingSupervisorAsApp: jest.fn().mockResolvedValue({
        openId: 'ou_supervisor_a',
        name: 'A楼主管',
        positions: ['楼栋主管'],
        buildings: ['A楼'],
      }),
      resolvePurchaseAdminAsApp: jest.fn(),
      updateExecutionRecordAsApp: jest.fn().mockResolvedValue(undefined),
    };
    const store = {
      listPendingOrderNoticeCommands: jest.fn().mockResolvedValue([]),
      takeNextCardAction: jest.fn().mockResolvedValue(action),
      takeNextNotification: jest.fn().mockResolvedValue(null),
      listNotifications: jest
        .fn()
        .mockResolvedValue(completedApprovalNotifications(['ou_manager_1'])),
      enqueueNotifications: jest.fn().mockResolvedValue([]),
      completeCardAction: jest.fn().mockResolvedValue(undefined),
      rescheduleCardAction: jest.fn(),
      failCardAction: jest.fn(),
    };
    const service = new PurchaseWorkflowService(
      gateway as never,
      store as never,
    );

    await service.runPendingTasks(1);

    expect(gateway.resolveBuildingSupervisorAsApp).toHaveBeenCalledWith('A楼', undefined);
    expect(gateway.resolvePurchaseAdminAsApp).not.toHaveBeenCalled();
    expect(gateway.updateExecutionRecordAsApp).toHaveBeenCalledWith(
      'rec_execution_1',
      expect.objectContaining({
        采购人: [{ id: 'ou_supervisor_a' }],
      }),
    );
    expect(gateway.updateExecutionRecordAsApp).not.toHaveBeenCalledWith(
      'rec_execution_1',
      expect.objectContaining({
        采购人: [{ id: 'ou_requester' }],
      }),
    );
  });

  it('does not repeat the Base write when a retry only needs to repair the outbox', async () => {
    const firstAction = {
      key: 'approval:rec_execution_1',
      eventId: 'evt_retry',
      recordId: 'rec_execution_1',
      action: 'approve',
      actorOpenId: 'ou_manager_1',
      status: 'processing',
      attempts: 1,
      claimToken: 'claim-first',
    };
    const retryAction = {
      ...firstAction,
      attempts: 2,
      claimToken: 'claim-retry',
    };
    const before = record({ purchaseMethod: '综合采购' });
    const alreadyApplied = record({
      purchaseMethod: '综合采购',
      status: '库房确认（待下单）',
      approvalCompleted: false,
      warehouseConfirmed: true,
      purchaserOpenId: 'ou_purchase_admin',
      purchaserName: '采购管理员',
    });
    const gateway = {
      listExecutionRecordsAsApp: jest.fn().mockResolvedValue([]),
      resolveConfiguredApproversAsApp: jest.fn().mockResolvedValue([]),
      getExecutionRecordAsApp: jest
        .fn()
        .mockResolvedValueOnce(before)
        .mockResolvedValueOnce(alreadyApplied),
      resolveConfiguredApproversAsApp: jest.fn().mockResolvedValue([
        {
          openId: 'ou_manager_1',
          name: '经理甲',
          positions: [],
          buildings: [],
        },
      ]),
      resolvePurchaseAdminAsApp: jest.fn().mockResolvedValue({
        openId: 'ou_purchase_admin',
        name: '采购管理员',
        positions: [],
        buildings: [],
      }),
      updateExecutionRecordAsApp: jest.fn().mockResolvedValue(undefined),
    };
    const store = {
      listPendingOrderNoticeCommands: jest.fn().mockResolvedValue([]),
      takeNextCardAction: jest
        .fn()
        .mockResolvedValueOnce(firstAction)
        .mockResolvedValueOnce(retryAction),
      takeNextNotification: jest.fn().mockResolvedValue(null),
      listNotifications: jest
        .fn()
        .mockResolvedValue(completedApprovalNotifications(['ou_manager_1'])),
      enqueueNotifications: jest
        .fn()
        .mockRejectedValueOnce(new Error('ledger unavailable'))
        .mockResolvedValueOnce([]),
      completeCardAction: jest.fn().mockResolvedValue(undefined),
      rescheduleCardAction: jest.fn().mockResolvedValue(undefined),
      failCardAction: jest.fn(),
    };
    const service = new PurchaseWorkflowService(
      gateway as never,
      store as never,
    );

    await expect(service.runPendingTasks(1)).resolves.toMatchObject({
      processed: 0,
      failed: 1,
    });
    await expect(service.runPendingTasks(1)).resolves.toMatchObject({
      processed: 1,
    });

    expect(gateway.updateExecutionRecordAsApp).toHaveBeenCalledTimes(1);
    expect(store.rescheduleCardAction).toHaveBeenCalledWith(
      firstAction.key,
      firstAction.claimToken,
      expect.any(Error),
      expect.any(Date),
      expect.any(Date),
    );
    expect(store.completeCardAction).toHaveBeenCalledWith(
      retryAction.key,
      retryAction.claimToken,
      expect.any(Date),
    );
  });

  it('fails closed when an already-advanced comprehensive purchase is assigned to the wrong purchaser', async () => {
    const action = {
      key: 'approval:rec_execution_1',
      eventId: 'evt_wrong_assignee',
      recordId: 'rec_execution_1',
      action: 'approve',
      actorOpenId: 'ou_manager_1',
      status: 'processing',
      attempts: 5,
      claimToken: 'claim-wrong-assignee',
    };
    const approvers = [
      {
        openId: 'ou_manager_1',
        name: '经理甲',
        positions: [],
        buildings: [],
      },
    ];
    const gateway = {
      listExecutionRecordsAsApp: jest.fn().mockResolvedValue([]),
      getExecutionRecordAsApp: jest.fn().mockResolvedValue(
        record({
          purchaseMethod: '综合采购',
          status: '库房确认（待下单）',
          approvalCompleted: true,
          warehouseConfirmed: true,
          purchaserOpenId: 'ou_wrong_purchaser',
          purchaserName: '错误采购人',
        }),
      ),
      resolveConfiguredApproversAsApp: jest.fn().mockResolvedValue(approvers),
      resolvePurchaseAdminAsApp: jest.fn().mockResolvedValue({
        openId: 'ou_purchase_admin',
        name: '采购管理员',
        positions: [],
        buildings: [],
      }),
      updateExecutionRecordAsApp: jest.fn(),
    };
    const store = {
      listPendingOrderNoticeCommands: jest.fn().mockResolvedValue([]),
      takeNextNotification: jest.fn().mockResolvedValue(null),
      takeNextCardAction: jest.fn().mockResolvedValue(action),
      listNotifications: jest.fn().mockResolvedValue([
        {
          recordId: action.recordId,
          recipientOpenId: 'ou_manager_1',
          kind: 'approval_requested',
          status: 'completed',
          messageId: 'om_manager_1',
        },
      ]),
      enqueueNotifications: jest.fn().mockResolvedValue([]),
      completeCardAction: jest.fn(),
      rescheduleCardAction: jest.fn(),
      failCardAction: jest.fn().mockResolvedValue(undefined),
    };
    const service = new PurchaseWorkflowService(
      gateway as never,
      store as never,
    );

    await expect(service.runPendingTasks(1)).resolves.toMatchObject({
      processed: 0,
      failed: 1,
    });
    expect(gateway.updateExecutionRecordAsApp).not.toHaveBeenCalled();
    expect(store.enqueueNotifications).not.toHaveBeenCalled();
    expect(store.completeCardAction).not.toHaveBeenCalled();
    expect(store.failCardAction).toHaveBeenCalledWith(
      action.key,
      action.claimToken,
      expect.any(Error),
      expect.any(Date),
    );
  });

  it('rejects once, resolves both manager cards, and notifies only the requester', async () => {
    const action = {
      key: 'approval:rec_execution_1',
      eventId: 'evt_reject',
      recordId: 'rec_execution_1',
      action: 'reject',
      actorOpenId: 'ou_manager_1',
      status: 'processing',
      attempts: 1,
      claimToken: 'claim-reject',
    };
    const approvers = [
      {
        openId: 'ou_manager_1',
        name: '经理甲',
        positions: [],
        buildings: [],
      },
      {
        openId: 'ou_manager_2',
        name: '经理乙',
        positions: [],
        buildings: [],
      },
    ];
    const gateway = {
      listExecutionRecordsAsApp: jest.fn().mockResolvedValue([]),
      getExecutionRecordAsApp: jest
        .fn()
        .mockResolvedValue(record({ purchaseMethod: '综合采购' })),
      resolveConfiguredApproversAsApp: jest.fn().mockResolvedValue(approvers),
      resolvePurchaseAdminAsApp: jest.fn(),
      resolveBuildingSupervisorAsApp: jest.fn(),
      updateExecutionRecordAsApp: jest.fn().mockResolvedValue(undefined),
    };
    const store = {
      listPendingOrderNoticeCommands: jest.fn().mockResolvedValue([]),
      takeNextNotification: jest.fn().mockResolvedValue(null),
      takeNextCardAction: jest.fn().mockResolvedValue(action),
      listNotifications: jest
        .fn()
        .mockResolvedValue(
          completedApprovalNotifications(['ou_manager_1', 'ou_manager_2']),
        ),
      enqueueNotifications: jest.fn().mockResolvedValue([]),
      completeCardAction: jest.fn().mockResolvedValue(undefined),
      rescheduleCardAction: jest.fn(),
      failCardAction: jest.fn(),
    };
    const service = new PurchaseWorkflowService(
      gateway as never,
      store as never,
    );

    await expect(service.runPendingTasks(1)).resolves.toMatchObject({
      processed: 1,
      failed: 0,
    });
    expect(gateway.updateExecutionRecordAsApp).toHaveBeenCalledWith(
      action.recordId,
      {
        '1️⃣物品采购方式': '驳回',
        采购流程: '驳回申请',
      },
    );
    expect(gateway.resolvePurchaseAdminAsApp).not.toHaveBeenCalled();
    expect(gateway.resolveBuildingSupervisorAsApp).not.toHaveBeenCalled();
    expect(store.enqueueNotifications).toHaveBeenCalledWith([
      {
        businessEventId: 'approval-resolved:rec_execution_1',
        recordId: 'rec_execution_1',
        recipientOpenId: 'ou_manager_1',
        kind: 'approval_resolved',
      },
      {
        businessEventId: 'approval-resolved:rec_execution_1',
        recordId: 'rec_execution_1',
        recipientOpenId: 'ou_manager_2',
        kind: 'approval_resolved',
      },
      {
        businessEventId: 'purchase-rejected:rec_execution_1',
        recordId: 'rec_execution_1',
        recipientOpenId: 'ou_requester',
        kind: 'purchase_rejected',
      },
    ]);
  });

  it.each([1, 2, 3, 4])(
    'reschedules a card action with an undelivered approval card on attempt %i',
    async (attempts) => {
      const action = {
        key: 'approval:rec_execution_1',
        eventId: `evt_retry_${attempts}`,
        recordId: 'rec_execution_1',
        action: 'approve',
        actorOpenId: 'ou_manager_1',
        status: 'processing',
        attempts,
        claimToken: `claim-retry-${attempts}`,
      };
      const gateway = {
        listExecutionRecordsAsApp: jest.fn().mockResolvedValue([]),
        resolveConfiguredApproversAsApp: jest.fn().mockResolvedValue([
          {
            openId: 'ou_manager_1',
            name: '经理甲',
            positions: [],
            buildings: [],
          },
          {
            openId: 'ou_manager_2',
            name: '经理乙',
            positions: [],
            buildings: [],
          },
        ]),
        getExecutionRecordAsApp: jest.fn(),
      };
      const store = {
        listPendingOrderNoticeCommands: jest.fn().mockResolvedValue([]),
        takeNextNotification: jest.fn().mockResolvedValue(null),
        takeNextCardAction: jest.fn().mockResolvedValue(action),
        listNotifications: jest.fn().mockResolvedValue([
          ...completedApprovalNotifications(['ou_manager_1']),
          {
            recordId: action.recordId,
            recipientOpenId: 'ou_manager_2',
            kind: 'approval_requested',
            status: 'pending',
            messageId: '',
          },
        ]),
        enqueueNotifications: jest.fn(),
        completeCardAction: jest.fn(),
        rescheduleCardAction: jest.fn().mockResolvedValue(undefined),
        failCardAction: jest.fn(),
      };
      const service = new PurchaseWorkflowService(
        gateway as never,
        store as never,
      );

      await expect(service.runPendingTasks(1)).resolves.toMatchObject({
        processed: 0,
        failed: 1,
      });
      expect(store.rescheduleCardAction).toHaveBeenCalledWith(
        action.key,
        action.claimToken,
        expect.objectContaining({ message: '审批卡未全部送达' }),
        expect.any(Date),
        expect.any(Date),
      );
      expect(store.failCardAction).not.toHaveBeenCalled();
      expect(gateway.getExecutionRecordAsApp).not.toHaveBeenCalled();
    },
  );

  it('fails a fifth-attempt action when an approval card is still pending without updating Base', async () => {
    const action = {
      key: 'approval:rec_execution_1',
      eventId: 'evt_barrier_fifth',
      recordId: 'rec_execution_1',
      action: 'approve',
      actorOpenId: 'ou_manager_1',
      status: 'processing',
      attempts: 5,
      claimToken: 'claim-barrier-fifth',
    };
    const gateway = {
      listExecutionRecordsAsApp: jest.fn().mockResolvedValue([]),
      resolveConfiguredApproversAsApp: jest.fn().mockResolvedValue([
        {
          openId: 'ou_manager_1',
          name: '经理甲',
          positions: [],
          buildings: [],
        },
        {
          openId: 'ou_manager_2',
          name: '经理乙',
          positions: [],
          buildings: [],
        },
      ]),
      getExecutionRecordAsApp: jest.fn(),
      updateExecutionRecordAsApp: jest.fn(),
    };
    const store = {
      listPendingOrderNoticeCommands: jest.fn().mockResolvedValue([]),
      takeNextNotification: jest.fn().mockResolvedValue(null),
      takeNextCardAction: jest.fn().mockResolvedValue(action),
      listNotifications: jest.fn().mockResolvedValue([
        ...completedApprovalNotifications(['ou_manager_1']),
        {
          recordId: action.recordId,
          recipientOpenId: 'ou_manager_2',
          kind: 'approval_requested',
          status: 'pending',
          messageId: '',
        },
      ]),
      enqueueNotifications: jest.fn(),
      completeCardAction: jest.fn(),
      rescheduleCardAction: jest.fn().mockResolvedValue(undefined),
      failCardAction: jest.fn(),
    };
    const service = new PurchaseWorkflowService(
      gateway as never,
      store as never,
    );

    await expect(service.runPendingTasks(1)).resolves.toMatchObject({
      processed: 0,
      failed: 1,
    });
    expect(store.failCardAction).toHaveBeenCalledWith(
      action.key,
      action.claimToken,
      expect.any(Error),
      expect.any(Date),
    );
    expect(store.rescheduleCardAction).not.toHaveBeenCalled();
    expect(gateway.getExecutionRecordAsApp).not.toHaveBeenCalled();
    expect(gateway.updateExecutionRecordAsApp).not.toHaveBeenCalled();
  });

  it('sends an approval card with calculated amount and stores its message id', async () => {
    const notification = {
      key: 'approval-requested:rec_execution_1:rec_execution_1:ou_manager_1',
      businessEventId: 'approval-requested:rec_execution_1',
      recordId: 'rec_execution_1',
      recipientOpenId: 'ou_manager_1',
      kind: 'approval_requested',
      status: 'processing',
      attempts: 1,
      claimToken: 'claim-notification',
    };
    const gateway = {
      listExecutionRecordsAsApp: jest.fn().mockResolvedValue([]),
      resolveConfiguredApproversAsApp: jest.fn().mockResolvedValue([]),
      getExecutionRecordAsApp: jest.fn().mockResolvedValue(
        record({
          purchaseMethod: '综合采购',
          unit: '件',
          unitPrice: 25,
          createdAt: 1784246400000,
          expectedDeliveryDate: 1784851200000,
        }),
      ),
      sendInteractiveCard: jest.fn().mockResolvedValue('om_approval_card'),
    };
    const store = {
      listPendingOrderNoticeCommands: jest.fn().mockResolvedValue([]),
      takeNextCardAction: jest.fn().mockResolvedValue(null),
      takeNextNotification: jest.fn().mockResolvedValue(notification),
      completeNotification: jest.fn().mockResolvedValue(undefined),
      rescheduleNotification: jest.fn(),
      failNotification: jest.fn(),
    };
    const service = new PurchaseWorkflowService(
      gateway as never,
      store as never,
    );

    await service.runPendingTasks(1);

    expect(gateway.sendInteractiveCard).toHaveBeenCalledWith(
      'ou_manager_1',
      expect.objectContaining({ schema: '2.0' }),
    );
    expect(
      JSON.stringify(gateway.sendInteractiveCard.mock.calls[0][1]),
    ).toContain('50');
    expect(store.completeNotification).toHaveBeenCalledWith(
      notification.key,
      notification.claimToken,
      { messageId: 'om_approval_card' },
      expect.any(Date),
    );
  });

  it('sends a warehouse inbound card and stores its Feishu message id', async () => {
    process.env.PUBLIC_BASE_URL = 'https://ops.example.com/';
    const notification = {
      key: 'warehouse-inbound:rec_execution_1:rec_execution_1:ou_warehouse',
      businessEventId: 'warehouse-inbound:rec_execution_1',
      recordId: 'rec_execution_1',
      recipientOpenId: 'ou_warehouse',
      kind: 'warehouse_inbound',
      status: 'processing',
      attempts: 1,
      claimToken: 'claim-warehouse',
      deliveryUuid: 'b640ddc0-b9d2-4f45-8a5d-24865ed92727',
    };
    const gateway = {
      listExecutionRecordsAsApp: jest.fn().mockResolvedValue([]),
      resolveConfiguredApproversAsApp: jest.fn().mockResolvedValue([]),
      getExecutionRecordAsApp: jest.fn().mockResolvedValue(
        record({
          status: '到货已签收（待入库）',
          receiptConfirmed: true,
          signer: '签收人',
          receiptTime: 1784246400000,
          actualQuantity: 2,
          unit: '件',
        }),
      ),
      sendInteractiveCard: jest.fn().mockResolvedValue('om_warehouse_card'),
    };
    const store = {
      listPendingOrderNoticeCommands: jest.fn().mockResolvedValue([]),
      listNotifications: jest.fn().mockResolvedValue([]),
      takeNextCardAction: jest.fn().mockResolvedValue(null),
      takeNextNotification: jest.fn().mockResolvedValue(notification),
      markInboundCompletedSendStarted: jest.fn().mockResolvedValue(notification),
      completeNotification: jest.fn().mockResolvedValue(undefined),
      rescheduleNotification: jest.fn(),
      failNotification: jest.fn(),
    };
    const service = new PurchaseWorkflowService(
      gateway as never,
      store as never,
    );

    await service.runPendingTasks(1);

    expect(gateway.sendInteractiveCard).toHaveBeenCalledWith(
      'ou_warehouse',
      expect.objectContaining({ schema: '2.0' }),
      notification.deliveryUuid,
    );
    expect(
      JSON.stringify(gateway.sendInteractiveCard.mock.calls[0][1]),
    ).toContain(
      'https://ops.example.com/inventory-management?view=inbound&purchase=rec_execution_1',
    );
    expect(store.completeNotification).toHaveBeenCalledWith(
      notification.key,
      notification.claimToken,
      { messageId: 'om_warehouse_card' },
      expect.any(Date),
    );
  });

  it('completes a stale warehouse inbound notification without sending after the item is already inbounded', async () => {
    process.env.PUBLIC_BASE_URL = 'https://ops.example.com';
    const notification = {
      key: 'warehouse-inbound:rec_execution_1:rec_execution_1:ou_warehouse',
      businessEventId: 'warehouse-inbound:rec_execution_1',
      recordId: 'rec_execution_1',
      recipientOpenId: 'ou_warehouse',
      kind: 'warehouse_inbound',
      status: 'processing',
      attempts: 1,
      claimToken: 'claim-stale-warehouse',
    };
    const gateway = {
      listExecutionRecordsAsApp: jest.fn().mockResolvedValue([]),
      resolveConfiguredApproversAsApp: jest.fn().mockResolvedValue([]),
      getExecutionRecordAsApp: jest.fn().mockResolvedValue(
        record({
          status: '物品签收已入库',
          receiptConfirmed: true,
          purchaseCompleted: true,
        }),
      ),
      sendInteractiveCard: jest.fn(),
    };
    const store = {
      listPendingOrderNoticeCommands: jest.fn().mockResolvedValue([]),
      listNotifications: jest.fn().mockResolvedValue([]),
      takeNextCardAction: jest.fn().mockResolvedValue(null),
      takeNextNotification: jest.fn().mockResolvedValue(notification),
      completeNotification: jest.fn().mockResolvedValue(undefined),
      rescheduleNotification: jest.fn(),
      failNotification: jest.fn(),
    };
    const service = new PurchaseWorkflowService(
      gateway as never,
      store as never,
    );

    await service.runPendingTasks(1);

    expect(gateway.sendInteractiveCard).not.toHaveBeenCalled();
    expect(store.completeNotification).toHaveBeenCalledWith(
      notification.key,
      notification.claimToken,
      { businessStage: 'completed' },
      expect.any(Date),
    );
  });

  it('completes a warehouse inbound notification without sending after the purchase is terminated', async () => {
    const notification = {
      key: 'warehouse-inbound:rec_execution_1:rec_execution_1:ou_warehouse',
      businessEventId: 'warehouse-inbound:rec_execution_1',
      recordId: 'rec_execution_1',
      recipientOpenId: 'ou_warehouse',
      kind: 'warehouse_inbound',
      status: 'processing',
      attempts: 1,
      claimToken: 'claim-terminated-warehouse',
    };
    const gateway = {
      listExecutionRecordsAsApp: jest.fn().mockResolvedValue([]),
      resolveConfiguredApproversAsApp: jest.fn().mockResolvedValue([]),
      getExecutionRecordAsApp: jest.fn().mockResolvedValue(
        record({
          status: '已终止',
          receiptConfirmed: false,
          purchaseCompleted: false,
        }),
      ),
      sendInteractiveCard: jest.fn(),
    };
    const store = {
      listPendingOrderNoticeCommands: jest.fn().mockResolvedValue([]),
      listNotifications: jest.fn().mockResolvedValue([]),
      takeNextCardAction: jest.fn().mockResolvedValue(null),
      takeNextNotification: jest.fn().mockResolvedValue(notification),
      completeNotification: jest.fn().mockResolvedValue(undefined),
      rescheduleNotification: jest.fn(),
      failNotification: jest.fn(),
    };
    const service = new PurchaseWorkflowService(
      gateway as never,
      store as never,
    );

    await service.runPendingTasks(1);

    expect(gateway.sendInteractiveCard).not.toHaveBeenCalled();
    expect(store.completeNotification).toHaveBeenCalledWith(
      notification.key,
      notification.claimToken,
      { businessStage: 'terminated' },
      expect.any(Date),
    );
  });

  it('persists one idempotent completion-resolution task without reading any Base table', async () => {
    const gateway = {
      getExecutionRecordAsApp: jest.fn().mockResolvedValue(
        record({
          status: '物品签收已入库',
          requesterOpenId: 'ou_same_person',
        }),
      ),
      resolvePurchaseAdminAsApp: jest.fn(() => {
        throw new Error('completion submit must not read purchase admin Base');
      }),
      resolveConfiguredApproversAsApp: jest.fn(() => {
        throw new Error('completion submit must not read approver Base');
      }),
      resolveInboundResponsibleUsersAsApp: jest.fn(() => {
        throw new Error(
          'completion submit must not read inbound responsibility Base',
        );
      }),
    };
    const store = {
      listPendingOrderNoticeCommands: jest.fn().mockResolvedValue([]),
      enqueueNotifications: jest
        .fn()
        .mockResolvedValueOnce([{ enqueued: true }])
        .mockResolvedValueOnce([{ enqueued: false }]),
    };
    const service = new PurchaseWorkflowService(
      gateway as never,
      store as never,
    );

    await expect(
      service.enqueueCompletionNotifications('rec_execution_1'),
    ).resolves.toBe(1);
    await expect(
      service.enqueueCompletionNotifications('rec_execution_1'),
    ).resolves.toBe(0);
    expect(store.enqueueNotifications).toHaveBeenCalledWith([
      {
        businessEventId:
          'inventory-inbound-completed-resolution:rec_execution_1',
        recordId: 'rec_execution_1',
        recipientOpenId: 'system',
        kind: 'inventory_inbound_completed_resolution',
      },
    ]);
    expect(gateway.getExecutionRecordAsApp).not.toHaveBeenCalled();
    expect(gateway.resolvePurchaseAdminAsApp).not.toHaveBeenCalled();
    expect(gateway.resolveConfiguredApproversAsApp).not.toHaveBeenCalled();
    expect(gateway.resolveInboundResponsibleUsersAsApp).not.toHaveBeenCalled();
  });

  it('queues one enriched durable resolution before resolving the complete recipient snapshot', async () => {
    const gateway = {
      getCachedInboundCompletionRecipients: jest
        .fn()
        .mockResolvedValue(['ou_responsible', 'ou_manager']),
      getExecutionRecordAsApp: jest.fn(),
    };
    const store = {
      listPendingOrderNoticeCommands: jest.fn().mockResolvedValue([]),
      enqueueNotifications: jest
        .fn()
        .mockResolvedValueOnce([{ enqueued: true }])
        .mockResolvedValueOnce([{ enqueued: true }, { enqueued: true }]),
    };
    const service = new PurchaseWorkflowService(
      gateway as never,
      store as never,
    );

    await expect(
      service.enqueueCompletionNotifications(
        'rec_execution_1',
        manualMovementResult().movement,
      ),
    ).resolves.toBe(1);
    expect(gateway.getCachedInboundCompletionRecipients).not.toHaveBeenCalled();
    expect(store.enqueueNotifications).toHaveBeenCalledTimes(1);
    expect(store.enqueueNotifications).toHaveBeenCalledWith([
      expect.objectContaining({
        recordId: 'rec_execution_1',
        recipientOpenId: 'system',
        kind: 'inventory_inbound_completed_resolution',
        cardContext: expect.stringContaining('H-2F-226储存间01-0F'),
      }),
    ]);
    expect(gateway.getExecutionRecordAsApp).not.toHaveBeenCalled();
  });

  it('does not duplicate the durable recipient resolution when completion is enqueued again', async () => {
    const ledgerPath = join(
      tmpdir(),
      `purchase-completion-cache-${randomUUID()}.json`,
    );
    const store = new PurchaseWorkflowStore(ledgerPath);
    const gateway = {
      getCachedInboundCompletionRecipients: jest
        .fn()
        .mockResolvedValue(['ou_responsible', 'ou_manager']),
    };
    const service = new PurchaseWorkflowService(gateway as never, store);
    await store.onModuleInit();
    try {
      await service.enqueueCompletionNotifications(
        'rec_execution_1',
        manualMovementResult().movement,
      );
      await service.enqueueCompletionNotifications(
        'rec_execution_1',
        manualMovementResult().movement,
      );
      const cards = await store.listNotifications({
        recordId: 'rec_execution_1',
        kind: 'inventory_inbound_completed',
      });
      expect(cards).toEqual([]);
      expect(await store.listNotifications({ kind: 'inventory_inbound_completed_resolution' })).toHaveLength(1);
      expect(gateway.getCachedInboundCompletionRecipients).not.toHaveBeenCalled();
    } finally {
      await store.onModuleDestroy();
      rmSync(ledgerPath, { force: true });
      rmSync(`${ledgerPath}.lock`, { force: true });
    }
  });

  it('persists a versioned manual inbound snapshot before resolving recipients', async () => {
    const gateway = {
      resolveInboundResponsibleUsersAsApp: jest.fn(),
    };
    const store = {
      listPendingOrderNoticeCommands: jest.fn().mockResolvedValue([]),
      enqueueNotifications: jest.fn().mockResolvedValue([{ enqueued: true }]),
    };
    const service = new PurchaseWorkflowService(
      gateway as never,
      store as never,
    );

    await expect(
      service.ensureManualInboundCompletionNotification(manualMovementResult()),
    ).resolves.toBeUndefined();

    expect(store.enqueueNotifications).toHaveBeenCalledWith([
      {
        businessEventId:
          'manual-inventory-inbound-completed-resolution:manual-inbound-record-001',
        recordId: 'manual-inbound-record-001',
        recipientOpenId: 'system',
        kind: 'manual_inventory_inbound_completed_resolution',
        cardContext: manualCompletionContext(),
      },
    ]);
    expect(gateway.resolveInboundResponsibleUsersAsApp).not.toHaveBeenCalled();
  });

  it.each([
    ['null', null],
    ['empty', ''],
    ['invalid', 'not-a-date'],
  ] as const)(
    'persists a manual inbound notification with a null occurredAt when it is %s',
    async (_case, occurredAt) => {
      const result = manualMovementResult();
      result.movement = { ...result.movement!, occurredAt };
      const store = {
        listPendingOrderNoticeCommands: jest.fn().mockResolvedValue([]),
        enqueueNotifications: jest.fn().mockResolvedValue([{ enqueued: true }]),
      };
      const service = new PurchaseWorkflowService({} as never, store as never);

      await expect(
        service.ensureManualInboundCompletionNotification(result),
      ).resolves.toBeUndefined();
      expect(store.enqueueNotifications).toHaveBeenCalledTimes(1);
      const input = store.enqueueNotifications.mock.calls[0]?.[0]?.[0];
      const context = JSON.parse(String(input?.cardContext)) as {
        movement: { occurredAt: string | null };
      };
      expect(context.movement.occurredAt).toBeNull();
    },
  );

  it('accepts an empty unit in a manual inbound completion snapshot', async () => {
    const result = manualMovementResult();
    result.movement = { ...result.movement!, unit: '' };
    const expectedContext = JSON.parse(manualCompletionContext()) as Record<
      string,
      unknown
    > & {
      movement: Record<string, unknown>;
    };
    expectedContext.movement.unit = '';
    const store = {
      listPendingOrderNoticeCommands: jest.fn().mockResolvedValue([]),
      enqueueNotifications: jest.fn().mockResolvedValue([{ enqueued: true }]),
    };
    const service = new PurchaseWorkflowService({} as never, store as never);

    await expect(
      service.ensureManualInboundCompletionNotification(result),
    ).resolves.toBeUndefined();
    expect(store.enqueueNotifications).toHaveBeenCalledWith([
      expect.objectContaining({
        cardContext: JSON.stringify(expectedContext),
      }),
    ]);
  });

  it('accepts empty non-key display fields in a manual inbound completion snapshot', async () => {
    const result = manualMovementResult();
    result.movement = {
      ...result.movement!,
      sku: '',
      name: '',
      specification: '',
      unit: '',
      location: '',
    };
    const store = {
      listPendingOrderNoticeCommands: jest.fn().mockResolvedValue([]),
      enqueueNotifications: jest.fn().mockResolvedValue([{ enqueued: true }]),
    };
    const service = new PurchaseWorkflowService({} as never, store as never);

    await expect(
      service.ensureManualInboundCompletionNotification(result),
    ).resolves.toBeUndefined();
    const input = store.enqueueNotifications.mock.calls[0]?.[0]?.[0];
    const context = JSON.parse(String(input?.cardContext)) as {
      movement: Record<string, unknown>;
    };
    expect(context.movement).toMatchObject({
      sku: '',
      name: '',
      specification: '',
      unit: '',
      location: '',
    });
  });

  it('safely truncates long manual inbound display fields before persisting the notification snapshot', async () => {
    const result = manualMovementResult();
    result.movement = {
      ...result.movement!,
      name: '物'.repeat(201),
      location: '位'.repeat(501),
    };
    const store = {
      listPendingOrderNoticeCommands: jest.fn().mockResolvedValue([]),
      enqueueNotifications: jest.fn().mockResolvedValue([{ enqueued: true }]),
    };
    const service = new PurchaseWorkflowService({} as never, store as never);

    await expect(
      service.ensureManualInboundCompletionNotification(result),
    ).resolves.toBeUndefined();
    const input = store.enqueueNotifications.mock.calls[0]?.[0]?.[0];
    const context = JSON.parse(String(input?.cardContext)) as {
      movement: { name: string; location: string };
    };
    expect(context.movement.name).toBe('物'.repeat(200));
    expect(context.movement.location).toBe('位'.repeat(500));
  });

  it('resolves manual inbound recipients by valid Open ID, deduplicates them, and atomically closes the resolution', async () => {
    const resolution = {
      key: 'manual-inventory-inbound-completed-resolution:manual-inbound-record-001:manual-inbound-record-001:system',
      businessEventId:
        'manual-inventory-inbound-completed-resolution:manual-inbound-record-001',
      recordId: 'manual-inbound-record-001',
      recipientOpenId: 'system',
      kind: 'manual_inventory_inbound_completed_resolution',
      status: 'processing',
      attempts: 1,
      claimToken: 'manual-resolution-claim',
      cardContext: manualCompletionContext(),
    };
    const gateway = {
      listExecutionRecordsAsApp: jest.fn().mockResolvedValue([]),
      resolveConfiguredApproversAsApp: jest.fn().mockResolvedValue([]),
      resolveInboundResponsibleUsersAsApp: jest.fn().mockResolvedValue([
        { openId: 'ou_responsible_1', name: '责任人甲' },
        { openId: 'invalid-name-value', name: '错误姓名值' },
        { openId: 'ou_responsible_1', name: '责任人甲重复' },
        { openId: 'ou_responsible_2', name: '责任人乙' },
      ]),
      resolveInboundManagerNotificationUsersAsApp: jest.fn().mockResolvedValue([
        { openId: 'ou_responsible_2', name: '责任人乙兼管理人' },
        { openId: 'ou_manager_notify', name: '管理人' },
        { openId: 'invalid-manager-value', name: '错误管理人值' },
      ]),
    };
    const completeResolution = jest.fn().mockResolvedValue({
      resolution: { ...resolution, status: 'completed' },
      notifications: [],
    });
    const store = {
      listNotifications: jest.fn().mockResolvedValue([]),
      listPendingOrderNoticeCommands: jest.fn().mockResolvedValue([]),
      takeNextNotification: jest.fn().mockResolvedValue(resolution),
      takeNextCardAction: jest.fn().mockResolvedValue(null),
      completeInboundCompletedResolutionAndEnqueueNotifications:
        completeResolution,
      rescheduleNotification: jest.fn(),
      failNotification: jest.fn(),
    };
    const service = new PurchaseWorkflowService(
      gateway as never,
      store as never,
    );

    await expect(service.runPendingTasks(1)).resolves.toMatchObject({
      processed: 1,
      failed: 0,
    });

    expect(gateway.resolveInboundResponsibleUsersAsApp).toHaveBeenCalledWith(
      'H楼',
    );
    expect(
      gateway.resolveInboundManagerNotificationUsersAsApp,
    ).toHaveBeenCalledWith('H楼');
    expect(completeResolution).toHaveBeenCalledWith(
      resolution.key,
      resolution.claimToken,
      [
        {
          businessEventId:
            'manual-inventory-inbound-completed:manual-inbound-record-001',
          recordId: 'manual-inbound-record-001',
          recipientOpenId: 'ou_responsible_1',
          kind: 'manual_inventory_inbound_completed',
          cardContext: manualCompletionContext(),
        },
        {
          businessEventId:
            'manual-inventory-inbound-completed:manual-inbound-record-001',
          recordId: 'manual-inbound-record-001',
          recipientOpenId: 'ou_responsible_2',
          kind: 'manual_inventory_inbound_completed',
          cardContext: manualCompletionContext(),
        },
        {
          businessEventId:
            'manual-inventory-inbound-completed:manual-inbound-record-001',
          recordId: 'manual-inbound-record-001',
          recipientOpenId: 'ou_manager_notify',
          kind: 'manual_inventory_inbound_completed',
          cardContext: manualCompletionContext(),
        },
      ],
      expect.any(Date),
    );
  });

  it('keeps retrying a manual resolution when recipient lookup returns no valid Open ID', async () => {
    const resolution = {
      key: 'manual-inventory-inbound-completed-resolution:manual-inbound-record-001:manual-inbound-record-001:system',
      recordId: 'manual-inbound-record-001',
      kind: 'manual_inventory_inbound_completed_resolution',
      status: 'processing',
      attempts: 1,
      claimToken: 'manual-resolution-empty-claim',
      cardContext: manualCompletionContext(),
    };
    const gateway = {
      listExecutionRecordsAsApp: jest.fn().mockResolvedValue([]),
      resolveConfiguredApproversAsApp: jest.fn().mockResolvedValue([]),
      resolveInboundResponsibleUsersAsApp: jest.fn().mockResolvedValue([
        { openId: '张三', name: '张三' },
        { openId: '', name: '未维护' },
      ]),
      resolveInboundManagerNotificationUsersAsApp: jest
        .fn()
        .mockResolvedValue([]),
    };
    const completeResolution = jest.fn();
    const store = {
      listNotifications: jest.fn().mockResolvedValue([]),
      listPendingOrderNoticeCommands: jest.fn().mockResolvedValue([]),
      takeNextNotification: jest.fn().mockResolvedValue(resolution),
      takeNextCardAction: jest.fn().mockResolvedValue(null),
      completeInboundCompletedResolutionAndEnqueueNotifications:
        completeResolution,
      rescheduleNotification: jest.fn().mockResolvedValue(undefined),
      failNotification: jest.fn(),
    };
    const service = new PurchaseWorkflowService(
      gateway as never,
      store as never,
    );

    await expect(service.runPendingTasks(1)).resolves.toMatchObject({
      processed: 0,
      failed: 1,
    });
    expect(completeResolution).not.toHaveBeenCalled();
    expect(store.rescheduleNotification).toHaveBeenCalledWith(
      resolution.key,
      resolution.claimToken,
      expect.any(ServiceUnavailableException),
      expect.any(Date),
      expect.any(Date),
    );
  });

  it('keeps retrying a manual resolution when the gateway reports no configured responsible user', async () => {
    const resolution = {
      key: 'manual-inventory-inbound-completed-resolution:manual-inbound-record-001:manual-inbound-record-001:system',
      recordId: 'manual-inbound-record-001',
      kind: 'manual_inventory_inbound_completed_resolution',
      status: 'processing',
      attempts: 1,
      claimToken: 'manual-resolution-not-configured-claim',
      cardContext: manualCompletionContext(),
    };
    const lookupError = new InboundResponsibleUsersNotConfiguredException(
      'H楼',
    );
    const gateway = {
      listExecutionRecordsAsApp: jest.fn().mockResolvedValue([]),
      resolveConfiguredApproversAsApp: jest.fn().mockResolvedValue([]),
      resolveInboundResponsibleUsersAsApp: jest
        .fn()
        .mockRejectedValue(lookupError),
      resolveInboundManagerNotificationUsersAsApp: jest
        .fn()
        .mockResolvedValue([]),
    };
    const completeResolution = jest.fn();
    const store = {
      listNotifications: jest.fn().mockResolvedValue([]),
      listPendingOrderNoticeCommands: jest.fn().mockResolvedValue([]),
      takeNextNotification: jest.fn().mockResolvedValue(resolution),
      takeNextCardAction: jest.fn().mockResolvedValue(null),
      completeInboundCompletedResolutionAndEnqueueNotifications:
        completeResolution,
      rescheduleNotification: jest.fn().mockResolvedValue(undefined),
      failNotification: jest.fn(),
    };
    const service = new PurchaseWorkflowService(
      gateway as never,
      store as never,
    );

    await expect(service.runPendingTasks(1)).resolves.toMatchObject({
      processed: 0,
      failed: 1,
    });
    expect(completeResolution).not.toHaveBeenCalled();
    expect(store.rescheduleNotification).toHaveBeenCalledWith(
      resolution.key,
      resolution.claimToken,
      lookupError,
      expect.any(Date),
      expect.any(Date),
    );
  });

  it('keeps retrying a manual resolution when manager notification lookup fails', async () => {
    const resolution = {
      key: 'manual-inventory-inbound-completed-resolution:manual-inbound-record-001:manual-inbound-record-001:system',
      recordId: 'manual-inbound-record-001',
      kind: 'manual_inventory_inbound_completed_resolution',
      status: 'processing',
      attempts: 1,
      claimToken: 'manual-resolution-network-error-claim',
      cardContext: manualCompletionContext(),
    };
    const lookupError = new ServiceUnavailableException('飞书连接超时');
    const gateway = {
      listExecutionRecordsAsApp: jest.fn().mockResolvedValue([]),
      resolveConfiguredApproversAsApp: jest.fn().mockResolvedValue([]),
      resolveInboundResponsibleUsersAsApp: jest
        .fn()
        .mockResolvedValue([
          { openId: 'ou_responsible', name: '库房责任人员' },
        ]),
      resolveInboundManagerNotificationUsersAsApp: jest
        .fn()
        .mockRejectedValue(lookupError),
    };
    const completeResolution = jest.fn();
    const store = {
      listNotifications: jest.fn().mockResolvedValue([]),
      listPendingOrderNoticeCommands: jest.fn().mockResolvedValue([]),
      takeNextNotification: jest.fn().mockResolvedValue(resolution),
      takeNextCardAction: jest.fn().mockResolvedValue(null),
      completeInboundCompletedResolutionAndEnqueueNotifications:
        completeResolution,
      rescheduleNotification: jest.fn().mockResolvedValue(undefined),
      failNotification: jest.fn(),
    };
    const service = new PurchaseWorkflowService(
      gateway as never,
      store as never,
    );

    await expect(service.runPendingTasks(1)).resolves.toMatchObject({
      processed: 0,
      failed: 1,
    });
    expect(completeResolution).not.toHaveBeenCalled();
    expect(store.rescheduleNotification).toHaveBeenCalledWith(
      resolution.key,
      resolution.claimToken,
      lookupError,
      expect.any(Date),
      expect.any(Date),
    );
  });

  it('uses the successful caller commit as the completion boundary without a Base preflight', async () => {
    const gateway = {
      getExecutionRecordAsApp: jest
        .fn()
        .mockResolvedValue(record({ status: '到货已签收（待入库）' })),
      resolvePurchaseAdminAsApp: jest.fn(),
      resolveConfiguredApproversAsApp: jest.fn(),
      resolveInboundResponsibleUsersAsApp: jest.fn(),
    };
    const store = {
      listPendingOrderNoticeCommands: jest.fn().mockResolvedValue([]),
      enqueueNotifications: jest.fn().mockResolvedValue([{ enqueued: true }]),
    };
    const service = new PurchaseWorkflowService(
      gateway as never,
      store as never,
    );

    await expect(
      service.enqueueCompletionNotifications('rec_execution_1'),
    ).resolves.toBe(1);
    expect(gateway.getExecutionRecordAsApp).not.toHaveBeenCalled();
    expect(gateway.resolvePurchaseAdminAsApp).not.toHaveBeenCalled();
    expect(gateway.resolveInboundResponsibleUsersAsApp).not.toHaveBeenCalled();
    expect(store.enqueueNotifications).toHaveBeenCalledWith([
      {
        businessEventId:
          'inventory-inbound-completed-resolution:rec_execution_1',
        recordId: 'rec_execution_1',
        recipientOpenId: 'system',
        kind: 'inventory_inbound_completed_resolution',
      },
    ]);
  });

  it('keeps retrying completion-recipient resolution after the fifth attempt', async () => {
    const notification = {
      key: 'inventory-inbound-completed-resolution:rec_execution_1:rec_execution_1:system',
      businessEventId: 'inventory-inbound-completed-resolution:rec_execution_1',
      recordId: 'rec_execution_1',
      recipientOpenId: 'system',
      kind: 'inventory_inbound_completed_resolution',
      status: 'processing',
      attempts: 5,
      claimToken: 'claim-resolution-5',
    };
    const gateway = {
      listExecutionRecordsAsApp: jest.fn().mockResolvedValue([]),
      resolveConfiguredApproversAsApp: jest.fn().mockResolvedValue([]),
      getExecutionRecordAsApp: jest
        .fn()
        .mockRejectedValue(
          new Error('recipient Base is temporarily unavailable'),
        ),
    };
    const store = {
      listPendingOrderNoticeCommands: jest.fn().mockResolvedValue([]),
      takeNextNotification: jest.fn().mockResolvedValue(notification),
      takeNextCardAction: jest.fn().mockResolvedValue(null),
      rescheduleNotification: jest.fn().mockResolvedValue(undefined),
      failNotification: jest.fn().mockResolvedValue(undefined),
    };
    const service = new PurchaseWorkflowService(
      gateway as never,
      store as never,
    );

    await expect(service.runPendingTasks(1)).resolves.toMatchObject({
      processed: 0,
      failed: 1,
    });
    expect(store.rescheduleNotification).toHaveBeenCalledWith(
      notification.key,
      notification.claimToken,
      expect.any(Error),
      expect.any(Date),
      expect.any(Date),
    );
    expect(store.failNotification).not.toHaveBeenCalled();
  });

  it('processes accepted mandatory work without scanning historical completions while disabled', async () => {
    process.env.PURCHASE_WORKFLOW_PROGRAM_ENABLED = 'false';
    const now = new Date('2026-08-25T01:00:00.000Z');
    const mandatoryKinds = [
      'inventory_inbound_completed_resolution',
      'inventory_inbound_completed',
      'manual_inventory_inbound_completed_resolution',
      'manual_inventory_inbound_completed',
      'purchase_completed',
      'purchase_order_completed',
    ];
    const completedRecord = record({
      recordId: 'rec_completed_missing_responsibility_card',
      status: '物品签收已入库',
      building: 'H楼',
    });
    const notification = {
      key: 'purchase-completed:rec_ready_completed:rec_ready_completed:ou_requester',
      businessEventId: 'purchase-completed:rec_ready_completed',
      recordId: 'rec_ready_completed',
      recipientOpenId: 'ou_requester',
      kind: 'purchase_completed',
      status: 'processing',
      attempts: 1,
      claimToken: 'claim-ready-completed',
    };
    const store = {
      listPendingOrderNoticeCommands: jest.fn().mockResolvedValue([]),
      takeNextNotification: jest
        .fn()
        .mockResolvedValueOnce(notification)
        .mockResolvedValue(null),
      takeNextCardAction: jest.fn().mockResolvedValue({
        key: 'approval:must-not-run',
      }),
      completeNotification: jest.fn().mockResolvedValue(undefined),
      rescheduleNotification: jest.fn(),
      failNotification: jest.fn(),
      findCommand: jest.fn(),
      listNotifications: jest
        .fn()
        .mockImplementation(
          async ({ kind }: { recordId: string; kind?: string }) => {
            if (kind === 'warehouse_inbound') {
              return [{ recipientOpenId: 'ou_warehouse', status: 'completed' }];
            }
            if (kind === 'inventory_inbound_completed') return [];
            if (kind === 'purchase_completed') return [];
            throw new Error(`unexpected notification kind: ${kind}`);
          },
        ),
      enqueueNotifications: jest
        .fn()
        .mockImplementation(async (inputs: unknown[]) =>
          inputs.map(() => ({ enqueued: true })),
        ),
    };
    const gateway = {
      listExecutionRecordsAsApp: jest.fn().mockResolvedValue([completedRecord]),
      getExecutionRecordAsApp: jest.fn().mockResolvedValue(completedRecord),
      sendTextNotification: jest.fn().mockResolvedValue(['om_completed']),
      resolveInboundResponsibleUsersAsApp: jest.fn().mockResolvedValue([
        {
          openId: 'ou_inbound_responsible_1',
          name: '责任人甲',
          positions: [],
          buildings: ['H楼'],
        },
        {
          openId: 'ou_inbound_responsible_2',
          name: '责任人乙',
          positions: [],
          buildings: ['H楼'],
        },
      ]),
      resolveInboundManagerNotificationUsersAsApp: jest
        .fn()
        .mockResolvedValue([]),
      resolvePurchaseAdminAsApp: jest.fn(),
      resolveConfiguredApproversAsApp: jest.fn(),
    };
    const service = new PurchaseWorkflowService(
      gateway as never,
      store as never,
    );

    await expect(service.runPendingTasks(2, now)).resolves.toMatchObject({
      processed: 1,
      failed: 0,
      recoveredCompletionNotifications: 0,
    });
    await expect(
      service.runPendingTasks(2, new Date(now.getTime() + 5_000)),
    ).resolves.toMatchObject({
      processed: 0,
      failed: 0,
      recoveredCompletionNotifications: 0,
    });
    expect(store.takeNextNotification).toHaveBeenCalledWith(
      now,
      undefined,
      mandatoryKinds,
    );
    expect(store.takeNextCardAction).not.toHaveBeenCalled();
    expect(gateway.listExecutionRecordsAsApp).not.toHaveBeenCalled();
    expect(gateway.resolvePurchaseAdminAsApp).not.toHaveBeenCalled();
    expect(gateway.resolveConfiguredApproversAsApp).not.toHaveBeenCalled();
    expect(gateway.resolveInboundResponsibleUsersAsApp).not.toHaveBeenCalled();
    expect(store.enqueueNotifications).not.toHaveBeenCalled();
  });

  it('does not create current-recipient completion notifications from historical completed rows', async () => {
    const now = new Date('2026-08-25T01:00:00.000Z');
    const completedRecord = record({
      recordId: 'rec_completed_enabled_recovery',
      status: '物品签收已入库',
      requesterOpenId: 'ou_requester',
      building: 'H楼',
    });
    const gateway = {
      listExecutionRecordsAsApp: jest.fn().mockResolvedValue([completedRecord]),
      resolvePurchaseAdminAsApp: jest.fn().mockResolvedValue({
        openId: 'ou_purchase_admin',
        name: '采购管理员',
        positions: [],
        buildings: [],
      }),
      resolveConfiguredApproversAsApp: jest.fn().mockResolvedValue([]),
      resolveInboundResponsibleUsersAsApp: jest.fn().mockResolvedValue([
        {
          openId: 'ou_inbound_responsible',
          name: '入库责任人',
          positions: [],
          buildings: ['H楼'],
        },
      ]),
      resolveInboundManagerNotificationUsersAsApp: jest
        .fn()
        .mockResolvedValue([]),
    };
    const store = {
      listPendingOrderNoticeCommands: jest.fn().mockResolvedValue([]),
      findCommand: jest.fn(),
      listNotifications: jest
        .fn()
        .mockImplementation(
          async ({ kind }: { recordId: string; kind?: string }) => {
            if (kind === 'warehouse_inbound') {
              return [{ recipientOpenId: 'ou_warehouse', status: 'completed' }];
            }
            if (
              kind === 'purchase_completed' ||
              kind === 'inventory_inbound_completed'
            ) {
              return [];
            }
            return [];
          },
        ),
      enqueueNotifications: jest
        .fn()
        .mockImplementation(async (inputs: unknown[]) =>
          inputs.map(() => ({ enqueued: true })),
        ),
      takeNextNotification: jest.fn().mockResolvedValue(null),
      takeNextCardAction: jest.fn().mockResolvedValue(null),
    };
    const service = new PurchaseWorkflowService(
      gateway as never,
      store as never,
    );

    await expect(service.runPendingTasks(20)).resolves.toMatchObject({
      recoveredCompletionNotifications: 0,
      failed: 0,
    });
    expect(store.enqueueNotifications).not.toHaveBeenCalled();
    expect(gateway.resolveInboundResponsibleUsersAsApp).not.toHaveBeenCalled();
    expect(gateway.resolveInboundManagerNotificationUsersAsApp).not.toHaveBeenCalled();
    expect(gateway.resolvePurchaseAdminAsApp).not.toHaveBeenCalled();
  });

  it('resolves completion recipients in the worker and atomically derives one notification per openId', async () => {
    const resolution = {
      key: 'inventory-inbound-completed-resolution:rec_execution_1:rec_execution_1:system',
      businessEventId: 'inventory-inbound-completed-resolution:rec_execution_1',
      recordId: 'rec_execution_1',
      recipientOpenId: 'system',
      kind: 'inventory_inbound_completed_resolution',
      status: 'processing',
      attempts: 1,
      claimToken: '8c1581b0-4b2a-4c6e-b5f2-82174219ea13',
    };
    const gateway = {
      listExecutionRecordsAsApp: jest.fn().mockResolvedValue([]),
      getExecutionRecordAsApp: jest.fn().mockResolvedValue(
        record({
          status: '物品签收已入库',
          requesterOpenId: 'ou_shared',
          building: 'H楼',
        }),
      ),
      resolveInboundResponsibleUsersAsApp: jest.fn().mockResolvedValue([
        {
          openId: 'ou_shared',
          name: '兼任责任人',
          positions: [],
          buildings: ['H楼'],
        },
        {
          openId: 'ou_responsible_only',
          name: '责任人乙',
          positions: [],
          buildings: ['H楼'],
        },
        {
          openId: 'ou_shared',
          name: '重复责任人',
          positions: [],
          buildings: ['H楼'],
        },
      ]),
      resolveInboundManagerNotificationUsersAsApp: jest.fn().mockResolvedValue([
        {
          openId: 'ou_shared',
          name: '申请人兼库房管理人',
          positions: [],
          buildings: ['H楼'],
        },
        {
          openId: 'ou_warehouse_manager',
          name: '库房管理人',
          positions: [],
          buildings: ['H楼'],
        },
      ]),
      resolvePurchaseAdminAsApp: jest.fn().mockResolvedValue({
        openId: 'ou_admin',
        name: '采购管理员',
        positions: [],
        buildings: [],
      }),
      resolveConfiguredApproversAsApp: jest.fn().mockResolvedValue([
        {
          openId: 'ou_shared',
          name: '兼任审批人',
          positions: [],
          buildings: [],
        },
        {
          openId: 'ou_manager',
          name: '审批人',
          positions: [],
          buildings: [],
        },
        {
          openId: 'invalid-open-id',
          name: '无效配置',
          positions: [],
          buildings: [],
        },
      ]),
    };
    const completeResolution = jest.fn().mockResolvedValue({
      resolution: { ...resolution, status: 'completed' },
      notifications: [],
    });
    const store = {
      listPendingOrderNoticeCommands: jest.fn().mockResolvedValue([]),
      enqueueNotifications: jest.fn(),
      listNotifications: jest.fn().mockResolvedValue([]),
      takeNextCardAction: jest.fn().mockResolvedValue(null),
      takeNextNotification: jest.fn().mockResolvedValue(resolution),
      completeInboundCompletedResolutionAndEnqueueNotifications:
        completeResolution,
      completeNotification: jest.fn(),
      rescheduleNotification: jest.fn().mockResolvedValue(undefined),
      failNotification: jest.fn(),
    };
    const service = new PurchaseWorkflowService(
      gateway as never,
      store as never,
    );

    await expect(service.runPendingTasks(1)).resolves.toMatchObject({
      processed: 1,
      failed: 0,
    });
    expect(gateway.resolveInboundResponsibleUsersAsApp).toHaveBeenCalledWith(
      'H楼',
    );
    expect(
      gateway.resolveInboundManagerNotificationUsersAsApp,
    ).toHaveBeenCalledWith('H楼');
    expect(completeResolution).toHaveBeenCalledWith(
      resolution.key,
      resolution.claimToken,
      [
        {
          businessEventId: 'inventory-inbound-completed:rec_execution_1',
          recordId: 'rec_execution_1',
          recipientOpenId: 'ou_shared',
          kind: 'inventory_inbound_completed',
        },
        {
          businessEventId: 'inventory-inbound-completed:rec_execution_1',
          recordId: 'rec_execution_1',
          recipientOpenId: 'ou_responsible_only',
          kind: 'inventory_inbound_completed',
        },
        {
          businessEventId: 'inventory-inbound-completed:rec_execution_1',
          recordId: 'rec_execution_1',
          recipientOpenId: 'ou_warehouse_manager',
          kind: 'inventory_inbound_completed',
        },
        {
          businessEventId: 'inventory-inbound-completed:rec_execution_1',
          recordId: 'rec_execution_1',
          recipientOpenId: 'ou_admin',
          kind: 'inventory_inbound_completed',
        },
        {
          businessEventId: 'inventory-inbound-completed:rec_execution_1',
          recordId: 'rec_execution_1',
          recipientOpenId: 'ou_manager',
          kind: 'inventory_inbound_completed',
        },
      ],
      expect.any(Date),
    );
    expect(store.enqueueNotifications).not.toHaveBeenCalled();
    expect(store.completeNotification).not.toHaveBeenCalled();
  });

  it.each([
    ['workflow disabled', 'false', false],
    ['purchase recipient config unavailable', 'true', true],
  ] as const)(
    'freezes only a complete enabled recipient set when %s',
    async (_scenario, workflowEnabled, shouldResolvePurchaseRecipients) => {
      process.env.PURCHASE_WORKFLOW_PROGRAM_ENABLED = workflowEnabled;
      const resolution = {
        key: 'inventory-inbound-completed-resolution:rec_execution_1:rec_execution_1:system',
        businessEventId:
          'inventory-inbound-completed-resolution:rec_execution_1',
        recordId: 'rec_execution_1',
        recipientOpenId: 'system',
        kind: 'inventory_inbound_completed_resolution',
        status: 'processing',
        attempts: 1,
        claimToken: 'claim-inbound-resolution',
      };
      const gateway = {
        listExecutionRecordsAsApp: jest.fn().mockResolvedValue([]),
        getExecutionRecordAsApp: jest.fn().mockResolvedValue(
          record({
            status: '物品签收已入库',
            requesterOpenId: 'ou_requester',
            building: 'H楼',
          }),
        ),
        resolveInboundResponsibleUsersAsApp: jest.fn().mockResolvedValue([
          {
            openId: 'ou_inbound_responsible',
            name: 'H楼入库责任人',
            positions: [],
            buildings: ['H楼'],
          },
        ]),
        resolveInboundManagerNotificationUsersAsApp: jest
          .fn()
          .mockResolvedValue([
            {
              openId: 'ou_inbound_manager',
              name: 'H楼库房管理人',
              positions: [],
              buildings: ['H楼'],
            },
          ]),
        resolvePurchaseAdminAsApp: jest
          .fn()
          .mockRejectedValue(
            new ServiceUnavailableException('采购管理员尚未配置'),
          ),
        resolveConfiguredApproversAsApp: jest.fn().mockResolvedValue([]),
      };
      const completeResolution = jest.fn().mockResolvedValue({
        resolution: { ...resolution, status: 'completed' },
        notifications: [],
      });
      const store = {
        listPendingOrderNoticeCommands: jest.fn().mockResolvedValue([]),
        takeNextCardAction: jest.fn().mockResolvedValue(null),
        takeNextNotification: jest.fn().mockResolvedValue(resolution),
        listNotifications: jest.fn().mockResolvedValue([]),
        completeInboundCompletedResolutionAndEnqueueNotifications:
          completeResolution,
        rescheduleNotification: jest.fn(),
        failNotification: jest.fn(),
      };
      const service = new PurchaseWorkflowService(
        gateway as never,
        store as never,
      );

      if (shouldResolvePurchaseRecipients) {
        await expect(service.runPendingTasks(1)).resolves.toMatchObject({ processed: 0, failed: 1 });
        expect(completeResolution).not.toHaveBeenCalled();
        expect(store.rescheduleNotification).toHaveBeenCalledWith(resolution.key, resolution.claimToken,
          expect.any(ServiceUnavailableException), expect.any(Date), expect.any(Date));
        expect(store.failNotification).not.toHaveBeenCalled();
        return;
      }
      await expect(service.runPendingTasks(1)).resolves.toMatchObject({
        processed: 1,
        failed: 0,
      });
      expect(completeResolution).toHaveBeenCalledWith(
        resolution.key,
        resolution.claimToken,
        [
          {
            businessEventId: 'inventory-inbound-completed:rec_execution_1',
            recordId: 'rec_execution_1',
            recipientOpenId: 'ou_inbound_responsible',
            kind: 'inventory_inbound_completed',
          },
          {
            businessEventId: 'inventory-inbound-completed:rec_execution_1',
            recordId: 'rec_execution_1',
            recipientOpenId: 'ou_inbound_manager',
            kind: 'inventory_inbound_completed',
          },
        ],
        expect.any(Date),
      );
      if (shouldResolvePurchaseRecipients) {
        expect(gateway.resolvePurchaseAdminAsApp).toHaveBeenCalledTimes(1);
        expect(gateway.resolveConfiguredApproversAsApp).toHaveBeenCalled();
      } else {
        expect(gateway.resolvePurchaseAdminAsApp).not.toHaveBeenCalled();
        expect(gateway.resolveConfiguredApproversAsApp).not.toHaveBeenCalled();
      }
      expect(store.rescheduleNotification).not.toHaveBeenCalled();
      expect(store.failNotification).not.toHaveBeenCalled();
    },
  );

  it('delivers an inbound success card with the persisted stable Feishu UUID', async () => {
    const deliveryUuid = 'b640ddc0-b9d2-4f45-8a5d-24865ed92727';
    const notification = {
      key: 'inventory-inbound-completed:rec_execution_1:rec_execution_1:ou_inbound_responsible',
      businessEventId: 'inventory-inbound-completed:rec_execution_1',
      recordId: 'rec_execution_1',
      recipientOpenId: 'ou_inbound_responsible',
      kind: 'inventory_inbound_completed',
      status: 'processing',
      attempts: 2,
      claimToken: 'claim-inbound-completed',
      deliveryUuid,
      cardContext: JSON.stringify({
        version: 1,
        sku: 'D1373',
        specification: '称重范围 5 吨',
        location: 'H-2F-226储存间01-OF',
      }),
    };
    const gateway = {
      listExecutionRecordsAsApp: jest.fn().mockResolvedValue([]),
      resolveConfiguredApproversAsApp: jest.fn().mockResolvedValue([]),
      getExecutionRecordAsApp: jest.fn().mockResolvedValue(
        record({
          status: '物品签收已入库',
          requestCode: 'CG-202608-024',
          itemName: '地磅秤',
          actualQuantity: 1,
          unit: '台',
          building: 'H楼',
        }),
      ),
      sendInteractiveCard: jest.fn().mockResolvedValue('om_inbound_completed'),
    };
    const store = {
      listPendingOrderNoticeCommands: jest.fn().mockResolvedValue([]),
      takeNextCardAction: jest.fn().mockResolvedValue(null),
      takeNextNotification: jest.fn().mockResolvedValueOnce(notification),
      listNotifications: jest.fn().mockResolvedValue([]),
      markInboundCompletedSendStarted: jest.fn().mockResolvedValue({
        ...notification,
        firstSendAttemptAt: '2026-08-25T01:00:00.000Z',
        sendOutcome: 'unknown',
      }),
      completeNotification: jest.fn().mockResolvedValue(undefined),
      rescheduleNotification: jest.fn(),
      failNotification: jest.fn(),
    };
    const service = new PurchaseWorkflowService(
      gateway as never,
      store as never,
    );

    await expect(service.runPendingTasks(1)).resolves.toMatchObject({
      processed: 1,
      failed: 0,
    });
    expect(gateway.sendInteractiveCard).toHaveBeenCalledWith(
      'ou_inbound_responsible',
      expect.objectContaining({ schema: '2.0' }),
      deliveryUuid,
    );
    expect(
      JSON.stringify(gateway.sendInteractiveCard.mock.calls[0]?.[1]),
    ).toContain('H-2F-226储存间01-OF');
    expect(store.markInboundCompletedSendStarted).toHaveBeenCalledWith(
      notification.key,
      notification.claimToken,
      expect.any(Date),
    );
    expect(store.completeNotification).toHaveBeenCalledWith(
      notification.key,
      notification.claimToken,
      { messageId: 'om_inbound_completed' },
      expect.any(Date),
    );
  });

  it('routes batch inbound completion through the shared card outbox', async () => {
    const batchId = 'b'.repeat(32);
    const notification = {
      key: 'batch-inbound:rec_execution_1:ou_responsible',
      businessEventId: 'inventory-inbound-completed:rec_execution_1',
      recordId: 'rec_execution_1', recipientOpenId: 'ou_responsible',
      kind: 'inventory_inbound_completed', status: 'processing', attempts: 1,
      claimToken: 'claim-batch', deliveryUuid: 'b640ddc0-b9d2-4f45-8a5d-24865ed92727',
      cardContext: JSON.stringify({ version: 1, sku: 'D1373', specification: '型号 X', location: 'H-1F-01', batchId }),
    };
    const gateway = {
      listExecutionRecordsAsApp: jest.fn().mockResolvedValue([]),
      resolveConfiguredApproversAsApp: jest.fn().mockResolvedValue([]),
      getExecutionRecordAsApp: jest.fn().mockResolvedValue(record({ status: '物品签收已入库', itemName: '测试物品' })),
      sendInteractiveCard: jest.fn(),
    };
    const store = {
      listPendingOrderNoticeCommands: jest.fn().mockResolvedValue([]),
      takeNextCardAction: jest.fn().mockResolvedValue(null),
      takeNextNotification: jest.fn().mockResolvedValueOnce(notification),
      markInboundCompletedSendStarted: jest.fn().mockResolvedValue(notification),
      completeNotification: jest.fn().mockResolvedValue(undefined),
      rescheduleNotification: jest.fn(), failNotification: jest.fn(),
    };
    const batchCards = { upsert: jest.fn().mockResolvedValue('om_batch_inbound') };
    const service = new PurchaseWorkflowService(gateway as never, store as never, batchCards as never);
    await expect(service.runPendingTasks(1)).resolves.toMatchObject({ processed: 1, failed: 0 });
    expect(batchCards.upsert).toHaveBeenCalledWith('inbound', batchId, 'ou_responsible',
      expect.objectContaining({ id: 'rec_execution_1', name: '测试物品', status: '已入库' }));
    expect(gateway.sendInteractiveCard).not.toHaveBeenCalled();
    expect(store.completeNotification).toHaveBeenCalledWith(notification.key, notification.claimToken,
      { messageId: 'om_batch_inbound' }, expect.any(Date));
  });

  it('sends a new success card even when an earlier inbound reminder card exists', async () => {
    const notification = {
      key: 'inventory-inbound-completed:rec_execution_1:rec_execution_1:ou_responsible',
      businessEventId: 'inventory-inbound-completed:rec_execution_1',
      recordId: 'rec_execution_1',
      recipientOpenId: 'ou_responsible',
      kind: 'inventory_inbound_completed',
      status: 'processing',
      attempts: 1,
      claimToken: 'claim-existing-inbound-card',
      deliveryUuid: 'b640ddc0-b9d2-4f45-8a5d-24865ed92727',
    };
    const gateway = {
      listExecutionRecordsAsApp: jest.fn().mockResolvedValue([]),
      getExecutionRecordAsApp: jest
        .fn()
        .mockResolvedValue(
          record({ status: '物品签收已入库', building: 'H楼' }),
        ),
      updateInteractiveCard: jest.fn().mockResolvedValue(undefined),
      sendInteractiveCard: jest
        .fn()
        .mockResolvedValue('om_duplicate_success_card'),
    };
    const store = {
      listPendingOrderNoticeCommands: jest.fn().mockResolvedValue([]),
      takeNextCardAction: jest.fn().mockResolvedValue(null),
      takeNextNotification: jest.fn().mockResolvedValueOnce(notification),
      listNotifications: jest.fn().mockResolvedValue([
        {
          recordId: notification.recordId,
          recipientOpenId: notification.recipientOpenId,
          kind: 'warehouse_inbound',
          status: 'completed',
          messageId: 'om_original_inbound_card',
        },
      ]),
      markInboundCompletedSendStarted: jest
        .fn()
        .mockResolvedValue(notification),
      completeNotification: jest.fn().mockResolvedValue(undefined),
      rescheduleNotification: jest.fn(),
      failNotification: jest.fn(),
    };
    const service = new PurchaseWorkflowService(
      gateway as never,
      store as never,
    );

    await expect(service.runPendingTasks(1)).resolves.toMatchObject({
      processed: 1,
      failed: 0,
    });
    expect(gateway.sendInteractiveCard).toHaveBeenCalledWith(
      'ou_responsible',
      expect.objectContaining({ schema: '2.0' }),
      notification.deliveryUuid,
    );
    expect(store.markInboundCompletedSendStarted).toHaveBeenCalled();
    expect(store.completeNotification).toHaveBeenCalledWith(
      notification.key,
      notification.claimToken,
      { messageId: 'om_duplicate_success_card' },
      expect.any(Date),
    );
  });

  it('delivers a manual inbound success card from the snapshot with the persisted stable UUID', async () => {
    const deliveryUuid = '7d88bbd7-2cf9-4d1c-aeca-d831e4b3875a';
    const notification = {
      key: 'manual-inventory-inbound-completed:manual-inbound-record-001:manual-inbound-record-001:ou_responsible_1',
      businessEventId:
        'manual-inventory-inbound-completed:manual-inbound-record-001',
      recordId: 'manual-inbound-record-001',
      recipientOpenId: 'ou_responsible_1',
      kind: 'manual_inventory_inbound_completed',
      status: 'processing',
      attempts: 2,
      claimToken: 'manual-delivery-claim',
      deliveryUuid,
      cardContext: manualCompletionContext(),
    };
    const gateway = {
      listExecutionRecordsAsApp: jest.fn().mockResolvedValue([]),
      resolveConfiguredApproversAsApp: jest.fn().mockResolvedValue([]),
      getExecutionRecordAsApp: jest.fn(),
      sendInteractiveCard: jest.fn().mockResolvedValue('om_manual_completed'),
    };
    const store = {
      listPendingOrderNoticeCommands: jest.fn().mockResolvedValue([]),
      takeNextCardAction: jest.fn().mockResolvedValue(null),
      takeNextNotification: jest.fn().mockResolvedValue(notification),
      markInboundCompletedSendStarted: jest.fn().mockResolvedValue({
        ...notification,
        firstSendAttemptAt: '2026-08-26T01:31:00.000Z',
        sendOutcome: 'unknown',
      }),
      completeNotification: jest.fn().mockResolvedValue(undefined),
      rescheduleNotification: jest.fn(),
      failNotification: jest.fn(),
    };
    const service = new PurchaseWorkflowService(
      gateway as never,
      store as never,
    );

    await expect(service.runPendingTasks(1)).resolves.toMatchObject({
      processed: 1,
      failed: 0,
    });

    expect(gateway.getExecutionRecordAsApp).not.toHaveBeenCalled();
    expect(gateway.sendInteractiveCard).toHaveBeenCalledWith(
      'ou_responsible_1',
      expect.objectContaining({ schema: '2.0' }),
      deliveryUuid,
    );
    expect(store.completeNotification).toHaveBeenCalledWith(
      notification.key,
      notification.claimToken,
      { messageId: 'om_manual_completed' },
      expect.any(Date),
    );
  });

  it('completes legacy purchase text tasks without sending a second inbound message', async () => {
    const notification = {
      key: 'purchase-completed:rec_execution_1:rec_execution_1:ou_requester',
      businessEventId: 'purchase-completed:rec_execution_1',
      recordId: 'rec_execution_1',
      recipientOpenId: 'ou_requester',
      kind: 'purchase_completed',
      status: 'processing',
      attempts: 1,
      claimToken: 'claim-completed',
    };
    const gateway = {
      listExecutionRecordsAsApp: jest.fn().mockResolvedValue([]),
      resolveConfiguredApproversAsApp: jest.fn().mockResolvedValue([]),
      getExecutionRecordAsApp: jest.fn().mockResolvedValue(
        record({
          status: '物品签收已入库',
          requestCode: 'CG-001',
          itemName: '接触器',
        }),
      ),
      sendTextNotification: jest.fn().mockResolvedValue(['om_completed']),
    };
    const store = {
      listPendingOrderNoticeCommands: jest.fn().mockResolvedValue([]),
      takeNextCardAction: jest.fn().mockResolvedValue(null),
      takeNextNotification: jest.fn().mockResolvedValueOnce(notification),
      completeNotification: jest.fn().mockResolvedValue(undefined),
      listNotifications: jest.fn().mockResolvedValue([]),
      rescheduleNotification: jest.fn(),
      failNotification: jest.fn(),
    };
    const service = new PurchaseWorkflowService(
      gateway as never,
      store as never,
    );

    await expect(service.runPendingTasks(1)).resolves.toMatchObject({
      processed: 1,
      failed: 0,
    });
    expect(gateway.sendTextNotification).not.toHaveBeenCalled();
    expect(store.completeNotification).toHaveBeenCalledWith(
      notification.key,
      notification.claimToken,
      {},
      expect.any(Date),
    );
  });

  it('does not send the legacy completion text when the same user already has an inbound card task', async () => {
    const notification = {
      key: 'purchase-completed:rec_execution_1:rec_execution_1:ou_requester',
      businessEventId: 'purchase-completed:rec_execution_1',
      recordId: 'rec_execution_1',
      recipientOpenId: 'ou_requester',
      kind: 'purchase_completed',
      status: 'processing',
      attempts: 1,
      claimToken: 'claim-completed-duplicate',
    };
    const gateway = {
      getExecutionRecordAsApp: jest
        .fn()
        .mockResolvedValue(record({ status: '物品签收已入库' })),
      sendTextNotification: jest.fn(),
    };
    const store = {
      listPendingOrderNoticeCommands: jest.fn().mockResolvedValue([]),
      takeNextNotification: jest
        .fn()
        .mockResolvedValueOnce(notification)
        .mockResolvedValue(null),
      takeNextCardAction: jest.fn().mockResolvedValue(null),
      listNotifications: jest
        .fn()
        .mockResolvedValue([{ recipientOpenId: 'ou_requester' }]),
      completeNotification: jest.fn(),
    };
    const service = new PurchaseWorkflowService(
      gateway as never,
      store as never,
    );

    await expect(service.runPendingTasks(1)).resolves.toMatchObject({
      processed: 1,
      failed: 0,
    });
    expect(gateway.sendTextNotification).not.toHaveBeenCalled();
    expect(store.completeNotification).toHaveBeenCalledWith(
      notification.key,
      notification.claimToken,
      {},
      expect.any(Date),
    );
  });

  it('queues an inbound card for a responsible user even when a legacy completion text exists', async () => {
    process.env.PURCHASE_WORKFLOW_PROGRAM_ENABLED = 'false';
    const resolution = {
      key: 'inventory-inbound-completed-resolution:rec_execution_1:rec_execution_1:system',
      recordId: 'rec_execution_1',
      kind: 'inventory_inbound_completed_resolution',
      recipientOpenId: 'system',
      claimToken: 'claim-legacy-resolution',
    };
    const gateway = {
      getExecutionRecordAsApp: jest
        .fn()
        .mockResolvedValue(record({ status: '物品签收已入库' })),
      resolveInboundResponsibleUsersAsApp: jest.fn().mockResolvedValue([
        {
          openId: 'ou_requester',
          name: '入库责任人',
          positions: [],
          buildings: ['H楼'],
        },
      ]),
      resolveInboundManagerNotificationUsersAsApp: jest
        .fn()
        .mockResolvedValue([]),
    };
    const store = {
      listPendingOrderNoticeCommands: jest.fn().mockResolvedValue([]),
      takeNextNotification: jest
        .fn()
        .mockResolvedValueOnce(resolution)
        .mockResolvedValue(null),
      listNotifications: jest
        .fn()
        .mockImplementation(async ({ kind }: { kind?: string }) =>
          kind === 'purchase_completed'
            ? [{ recipientOpenId: 'ou_requester' }]
            : [],
        ),
      completeInboundCompletedResolutionAndEnqueueNotifications: jest
        .fn()
        .mockResolvedValue({
          resolution,
          notifications: [],
        }),
    };
    const service = new PurchaseWorkflowService(
      gateway as never,
      store as never,
    );

    await expect(service.runPendingTasks(1)).resolves.toMatchObject({
      processed: 1,
      failed: 0,
    });
    expect(
      store.completeInboundCompletedResolutionAndEnqueueNotifications,
    ).toHaveBeenCalledWith(
      resolution.key,
      resolution.claimToken,
      [
        {
          businessEventId: 'inventory-inbound-completed:rec_execution_1',
          recordId: 'rec_execution_1',
          recipientOpenId: 'ou_requester',
          kind: 'inventory_inbound_completed',
        },
      ],
      expect.any(Date),
    );
  });

  it.each([
    ['已终止', true],
    ['到货已签收（待入库）', false],
  ])(
    'handles a completion notification safely while the record status is %s',
    async (status, shouldCompleteWithoutSending) => {
      const notification = {
        key: `purchase-completed:rec_execution_1:rec_execution_1:ou_requester:${status}`,
        businessEventId: 'purchase-completed:rec_execution_1',
        recordId: 'rec_execution_1',
        recipientOpenId: 'ou_requester',
        kind: 'purchase_completed',
        status: 'processing',
        attempts: 1,
        claimToken: `claim-completed-${status}`,
      };
      const gateway = {
        listExecutionRecordsAsApp: jest.fn().mockResolvedValue([]),
        resolveConfiguredApproversAsApp: jest.fn().mockResolvedValue([]),
        getExecutionRecordAsApp: jest
          .fn()
          .mockResolvedValue(record({ status })),
        sendTextNotification: jest.fn(),
      };
      const store = {
        listPendingOrderNoticeCommands: jest.fn().mockResolvedValue([]),
        takeNextCardAction: jest.fn().mockResolvedValue(null),
        takeNextNotification: jest.fn().mockResolvedValueOnce(notification),
        completeNotification: jest.fn().mockResolvedValue(undefined),
        rescheduleNotification: jest.fn().mockResolvedValue(undefined),
        failNotification: jest.fn(),
      };
      const service = new PurchaseWorkflowService(
        gateway as never,
        store as never,
      );

      await expect(service.runPendingTasks(1)).resolves.toMatchObject({
        processed: shouldCompleteWithoutSending ? 1 : 0,
        failed: shouldCompleteWithoutSending ? 0 : 1,
      });
      expect(gateway.sendTextNotification).not.toHaveBeenCalled();
      if (shouldCompleteWithoutSending) {
        expect(store.completeNotification).toHaveBeenCalledWith(
          notification.key,
          notification.claimToken,
          {},
          expect.any(Date),
        );
        expect(store.rescheduleNotification).not.toHaveBeenCalled();
      } else {
        expect(store.completeNotification).not.toHaveBeenCalled();
        expect(store.rescheduleNotification).toHaveBeenCalled();
      }
    },
  );

  it('does not backfill new completion recipients merely because a historic receive command or warehouse notice exists', async () => {
    const records = [
      record({
        recordId: 'rec_complete_recipients',
        status: '物品签收已入库',
        requesterOpenId: 'ou_requester',
      }),
      record({
        recordId: 'rec_historical_unproven',
        status: '物品签收已入库',
        requesterOpenId: 'ou_requester',
      }),
      record({
        recordId: 'rec_missing_completion',
        status: '物品签收已入库',
        requesterOpenId: 'ou_requester',
      }),
    ];
    const recipients = [
      'ou_requester',
      'ou_purchase_admin',
      'ou_manager_1',
      'ou_manager_2',
    ];
    const gateway = {
      listExecutionRecordsAsApp: jest.fn().mockResolvedValue(records),
      resolvePurchaseAdminAsApp: jest.fn().mockResolvedValue({
        openId: 'ou_purchase_admin',
        name: '采购管理员',
        positions: [],
        buildings: [],
      }),
      resolveConfiguredApproversAsApp: jest.fn().mockResolvedValue([
        {
          openId: 'ou_manager_1',
          name: '经理甲',
          positions: [],
          buildings: [],
        },
        {
          openId: 'ou_manager_2',
          name: '经理乙',
          positions: [],
          buildings: [],
        },
      ]),
      resolveInboundResponsibleUsersAsApp: jest.fn().mockResolvedValue([]),
      resolveInboundManagerNotificationUsersAsApp: jest
        .fn()
        .mockResolvedValue([]),
    };
    const store = {
      listPendingOrderNoticeCommands: jest.fn().mockResolvedValue([]),
      findCommand: jest
        .fn()
        .mockImplementation(async (key: string) =>
          key === 'receive:rec_complete_recipients' ? { key } : null,
        ),
      listNotifications: jest
        .fn()
        .mockImplementation(
          async ({ recordId, kind }: { recordId: string; kind?: string }) => {
            if (
              recordId === 'rec_complete_recipients' &&
              kind === 'purchase_completed'
            ) {
              return recipients.map((recipientOpenId) => ({
                recordId,
                recipientOpenId,
                kind,
                status: 'completed',
              }));
            }
            if (
              recordId === 'rec_missing_completion' &&
              kind === 'warehouse_inbound'
            ) {
              return [
                {
                  recordId,
                  recipientOpenId: 'ou_warehouse',
                  kind,
                  status: 'completed',
                },
              ];
            }
            return [];
          },
        ),
      enqueueNotifications: jest.fn().mockResolvedValue([{ enqueued: true }]),
      takeNextNotification: jest.fn().mockResolvedValue(null),
      takeNextCardAction: jest.fn().mockResolvedValue(null),
    };
    const service = new PurchaseWorkflowService(
      gateway as never,
      store as never,
    );

    await expect(service.runPendingTasks(20)).resolves.toMatchObject({
      recoveredCompletionNotifications: 0,
      failed: 0,
    });
    expect(store.enqueueNotifications).not.toHaveBeenCalled();
    expect(gateway.resolveInboundResponsibleUsersAsApp).not.toHaveBeenCalled();
    expect(gateway.resolveInboundManagerNotificationUsersAsApp).not.toHaveBeenCalled();
    expect(gateway.resolvePurchaseAdminAsApp).not.toHaveBeenCalled();
  });

  it('does not expand historical completion recipients to current warehouse responsibility and manager assignments', async () => {
    const completedRecord = record({
      recordId: 'rec_missing_inbound_responsible_card',
      status: '物品签收已入库',
      building: 'H楼',
      requesterOpenId: 'ou_requester',
    });
    const gateway = {
      listExecutionRecordsAsApp: jest.fn().mockResolvedValue([completedRecord]),
      resolvePurchaseAdminAsApp: jest.fn().mockResolvedValue({
        openId: 'ou_requester',
        name: '申请人兼采购管理员',
        positions: [],
        buildings: [],
      }),
      resolveConfiguredApproversAsApp: jest.fn().mockResolvedValue([]),
      resolveInboundResponsibleUsersAsApp: jest.fn().mockResolvedValue([
        {
          openId: 'ou_inbound_responsible_1',
          name: '责任人甲',
          positions: [],
          buildings: ['H楼'],
        },
        {
          openId: 'ou_inbound_responsible_2',
          name: '责任人乙',
          positions: [],
          buildings: ['H楼'],
        },
      ]),
      resolveInboundManagerNotificationUsersAsApp: jest.fn().mockResolvedValue([
        {
          openId: 'ou_inbound_responsible_1',
          name: '责任人甲兼管理人',
          positions: [],
          buildings: ['H楼'],
        },
        {
          openId: 'ou_inbound_manager',
          name: '库房管理人',
          positions: [],
          buildings: ['H楼'],
        },
        {
          openId: 'ou_requester',
          name: '申请人兼库房管理人',
          positions: [],
          buildings: ['H楼'],
        },
      ]),
    };
    const store = {
      listPendingOrderNoticeCommands: jest.fn().mockResolvedValue([]),
      findCommand: jest.fn(),
      listNotifications: jest
        .fn()
        .mockImplementation(
          async ({ kind }: { recordId: string; kind?: string }) => {
            if (kind === 'warehouse_inbound') {
              return [
                {
                  recordId: completedRecord.recordId,
                  recipientOpenId: 'ou_warehouse',
                  kind,
                  status: 'completed',
                },
              ];
            }
            if (kind === 'purchase_completed') {
              return [
                {
                  recordId: completedRecord.recordId,
                  recipientOpenId: 'ou_requester',
                  kind,
                  status: 'completed',
                },
              ];
            }
            if (kind === 'inventory_inbound_completed') {
              return [
                {
                  recordId: completedRecord.recordId,
                  recipientOpenId: 'ou_inbound_responsible_1',
                  kind,
                  status: 'completed',
                },
              ];
            }
            return [];
          },
        ),
      enqueueNotifications: jest
        .fn()
        .mockImplementation(async (inputs: unknown[]) =>
          inputs.map(() => ({ enqueued: true })),
        ),
      takeNextNotification: jest.fn().mockResolvedValue(null),
      takeNextCardAction: jest.fn().mockResolvedValue(null),
    };
    const service = new PurchaseWorkflowService(
      gateway as never,
      store as never,
    );

    await expect(service.runPendingTasks(20)).resolves.toMatchObject({
      recoveredCompletionNotifications: 0,
      failed: 0,
    });
    expect(store.enqueueNotifications).not.toHaveBeenCalled();
    expect(gateway.resolveInboundResponsibleUsersAsApp).not.toHaveBeenCalled();
    expect(gateway.resolveInboundManagerNotificationUsersAsApp).not.toHaveBeenCalled();
    expect(gateway.resolvePurchaseAdminAsApp).not.toHaveBeenCalled();
  });

  it('does not resolve current completion recipients for historical completed rows even after configuration changes', async () => {
    const records = [
      record({
        recordId: 'rec_completion_bad',
        status: '物品签收已入库',
      }),
      record({
        recordId: 'rec_completion_good',
        status: '物品签收已入库',
      }),
    ];
    const gateway = {
      listExecutionRecordsAsApp: jest.fn().mockResolvedValue(records),
      resolvePurchaseAdminAsApp: jest
        .fn()
        .mockRejectedValueOnce(new Error('采购管理员配置错误'))
        .mockResolvedValueOnce({
          openId: 'ou_purchase_admin',
          name: '采购管理员',
          positions: [],
          buildings: [],
        }),
      resolveConfiguredApproversAsApp: jest.fn().mockResolvedValue([]),
      resolveInboundResponsibleUsersAsApp: jest.fn().mockResolvedValue([
        {
          openId: 'ou_inbound_responsible',
          name: '入库责任人',
          positions: [],
          buildings: ['H楼'],
        },
      ]),
      resolveInboundManagerNotificationUsersAsApp: jest
        .fn()
        .mockResolvedValue([]),
    };
    const store = {
      listPendingOrderNoticeCommands: jest.fn().mockResolvedValue([]),
      findCommand: jest.fn(),
      listNotifications: jest
        .fn()
        .mockImplementation(
          async ({ kind }: { recordId: string; kind?: string }) =>
            kind === 'warehouse_inbound'
              ? [{ recipientOpenId: 'ou_warehouse' }]
              : [],
        ),
      enqueueNotifications: jest
        .fn()
        .mockImplementation(async (inputs: unknown[]) =>
          inputs.map(() => ({ enqueued: true })),
        ),
      takeNextNotification: jest.fn().mockResolvedValue(null),
      takeNextCardAction: jest.fn().mockResolvedValue(null),
    };
    const service = new PurchaseWorkflowService(
      gateway as never,
      store as never,
    );

    await expect(service.runPendingTasks(20)).resolves.toMatchObject({
      recoveredCompletionNotifications: 0,
      failed: 0,
    });
    expect(store.enqueueNotifications).not.toHaveBeenCalled();
    expect(gateway.resolveInboundResponsibleUsersAsApp).not.toHaveBeenCalled();
    expect(gateway.resolveInboundManagerNotificationUsersAsApp).not.toHaveBeenCalled();
    expect(gateway.resolvePurchaseAdminAsApp).not.toHaveBeenCalled();
  });

  it.each([
    ['下单完成（待签收）', 'receipt'],
    ['飞书异常状态', 'unknown'],
  ])(
    'reschedules a warehouse inbound notification while the record stage is %s',
    async (status, caseName) => {
      const notification = {
        key: `warehouse-inbound:rec_execution_1:rec_execution_1:ou_warehouse_${caseName}`,
        businessEventId: 'warehouse-inbound:rec_execution_1',
        recordId: 'rec_execution_1',
        recipientOpenId: 'ou_warehouse',
        kind: 'warehouse_inbound',
        status: 'processing',
        attempts: 1,
        claimToken: `claim-${caseName}-warehouse`,
      };
      const gateway = {
        listExecutionRecordsAsApp: jest.fn().mockResolvedValue([]),
        resolveConfiguredApproversAsApp: jest.fn().mockResolvedValue([]),
        getExecutionRecordAsApp: jest.fn().mockResolvedValue(
          record({
            status,
            receiptConfirmed: false,
          }),
        ),
        sendInteractiveCard: jest.fn(),
      };
      const store = {
        listPendingOrderNoticeCommands: jest.fn().mockResolvedValue([]),
        listNotifications: jest.fn().mockResolvedValue([]),
        takeNextCardAction: jest.fn().mockResolvedValue(null),
        takeNextNotification: jest.fn().mockResolvedValue(notification),
        completeNotification: jest.fn(),
        rescheduleNotification: jest.fn().mockResolvedValue(undefined),
        failNotification: jest.fn(),
      };
      const service = new PurchaseWorkflowService(
        gateway as never,
        store as never,
      );

      await expect(service.runPendingTasks(1)).resolves.toMatchObject({
        processed: 0,
        failed: 1,
      });
      expect(gateway.sendInteractiveCard).not.toHaveBeenCalled();
      expect(store.completeNotification).not.toHaveBeenCalled();
      expect(store.rescheduleNotification).toHaveBeenCalledWith(
        notification.key,
        notification.claimToken,
        expect.any(Error),
        expect.any(Date),
        expect.any(Date),
      );
    },
  );

  it.each([
    [1, 'rescheduleNotification'],
    [5, 'failNotification'],
  ] as const)(
    'retries warehouse card delivery safely at attempt %i',
    async (attempts, expectedMethod) => {
      process.env.PUBLIC_BASE_URL = 'https://ops.example.com';
      const notification = {
        key: `warehouse-inbound:rec_execution_1:rec_execution_1:ou_warehouse_${attempts}`,
        businessEventId: 'warehouse-inbound:rec_execution_1',
        recordId: 'rec_execution_1',
        recipientOpenId: 'ou_warehouse',
        kind: 'warehouse_inbound',
        status: 'processing',
        attempts,
        claimToken: `claim-warehouse-${attempts}`,
      };
      const gateway = {
        listExecutionRecordsAsApp: jest.fn().mockResolvedValue([]),
        resolveConfiguredApproversAsApp: jest.fn().mockResolvedValue([]),
        getExecutionRecordAsApp: jest.fn().mockResolvedValue(
          record({
            status: '到货已签收（待入库）',
            receiptConfirmed: true,
            actualQuantity: 2,
          }),
        ),
        sendInteractiveCard: jest
          .fn()
          .mockRejectedValue(new Error('飞书卡发送失败')),
      };
      const store = {
        listPendingOrderNoticeCommands: jest.fn().mockResolvedValue([]),
        listNotifications: jest.fn().mockResolvedValue([]),
        takeNextCardAction: jest.fn().mockResolvedValue(null),
        takeNextNotification: jest.fn().mockResolvedValue(notification),
        completeNotification: jest.fn(),
        rescheduleNotification: jest.fn().mockResolvedValue(undefined),
        failNotification: jest.fn().mockResolvedValue(undefined),
      };
      const service = new PurchaseWorkflowService(
        gateway as never,
        store as never,
      );

      await expect(service.runPendingTasks(1)).resolves.toMatchObject({
        processed: 0,
        failed: 1,
      });
      expect(store[expectedMethod]).toHaveBeenCalled();
      expect(store.completeNotification).not.toHaveBeenCalled();
    },
  );

  it('keeps retrying an unknown inbound-completed card with the same UUID after the fifth attempt', async () => {
    const notification = {
      key: 'inventory-inbound-completed:rec_execution_1:rec_execution_1:ou_inbound_responsible',
      businessEventId: 'inventory-inbound-completed:rec_execution_1',
      recordId: 'rec_execution_1',
      recipientOpenId: 'ou_inbound_responsible',
      kind: 'inventory_inbound_completed',
      status: 'processing',
      attempts: 5,
      claimToken: 'claim-inbound-completed-5',
      deliveryUuid: 'e9936cd0-42e4-4b8a-85b7-cd3b56767890',
      firstSendAttemptAt: '2026-08-24T01:00:01.000Z',
      sendOutcome: 'unknown',
    };
    const gateway = {
      listExecutionRecordsAsApp: jest.fn().mockResolvedValue([]),
      resolveConfiguredApproversAsApp: jest.fn().mockResolvedValue([]),
      getExecutionRecordAsApp: jest.fn().mockResolvedValue(
        record({
          status: '物品签收已入库',
          receiptConfirmed: true,
          actualQuantity: 2,
        }),
      ),
      sendInteractiveCard: jest
        .fn()
        .mockRejectedValue(new Error('飞书卡发送结果未知')),
    };
    const store = {
      listPendingOrderNoticeCommands: jest.fn().mockResolvedValue([]),
      listNotifications: jest.fn().mockResolvedValue([]),
      takeNextCardAction: jest.fn().mockResolvedValue(null),
      takeNextNotification: jest.fn().mockResolvedValue(notification),
      markInboundCompletedSendStarted: jest
        .fn()
        .mockResolvedValue(notification),
      completeNotification: jest.fn(),
      rescheduleNotification: jest.fn().mockResolvedValue(undefined),
      failNotification: jest.fn().mockResolvedValue(undefined),
    };
    const service = new PurchaseWorkflowService(
      gateway as never,
      store as never,
    );

    await expect(service.runPendingTasks(1)).resolves.toMatchObject({
      processed: 0,
      failed: 1,
    });
    expect(gateway.sendInteractiveCard).toHaveBeenCalledWith(
      notification.recipientOpenId,
      expect.any(Object),
      notification.deliveryUuid,
    );
    expect(store.rescheduleNotification).toHaveBeenCalledWith(
      notification.key,
      notification.claimToken,
      expect.any(Error),
      expect.any(Date),
      expect.any(Date),
    );
    expect(store.failNotification).not.toHaveBeenCalled();
  });

  it('keeps retrying an inbound-completed notification that fails before send after the fifth attempt', async () => {
    const notification = {
      key: 'inventory-inbound-completed:rec_execution_1:rec_execution_1:ou_inbound_responsible',
      businessEventId: 'inventory-inbound-completed:rec_execution_1',
      recordId: 'rec_execution_1',
      recipientOpenId: 'ou_inbound_responsible',
      kind: 'inventory_inbound_completed',
      status: 'processing',
      attempts: 5,
      claimToken: 'claim-inbound-completed-pre-send-5',
      deliveryUuid: 'c1eb3bd4-99cc-4f9b-964e-0a082f5d6a58',
      firstSendAttemptAt: '',
      sendOutcome: 'unattempted',
    };
    const gateway = {
      listExecutionRecordsAsApp: jest.fn().mockResolvedValue([]),
      resolveConfiguredApproversAsApp: jest.fn().mockResolvedValue([]),
      getExecutionRecordAsApp: jest
        .fn()
        .mockRejectedValue(new Error('采购执行表暂时不可用')),
      sendInteractiveCard: jest.fn(),
    };
    const store = {
      listPendingOrderNoticeCommands: jest.fn().mockResolvedValue([]),
      takeNextCardAction: jest.fn().mockResolvedValue(null),
      takeNextNotification: jest.fn().mockResolvedValue(notification),
      markInboundCompletedSendStarted: jest.fn(),
      completeNotification: jest.fn(),
      rescheduleNotification: jest.fn().mockResolvedValue(undefined),
      failNotification: jest.fn().mockResolvedValue(undefined),
    };
    const service = new PurchaseWorkflowService(
      gateway as never,
      store as never,
    );

    await expect(service.runPendingTasks(1)).resolves.toMatchObject({
      processed: 0,
      failed: 1,
    });
    expect(store.markInboundCompletedSendStarted).not.toHaveBeenCalled();
    expect(gateway.sendInteractiveCard).not.toHaveBeenCalled();
    expect(store.rescheduleNotification).toHaveBeenCalledWith(
      notification.key,
      notification.claimToken,
      expect.any(Error),
      expect.any(Date),
      expect.any(Date),
    );
    expect(store.failNotification).not.toHaveBeenCalled();
  });

  it('sends the second approval card before applying the first manager action and resolves both original cards', async () => {
    const ledgerPath = join(
      tmpdir(),
      `purchase-workflow-race-${randomUUID()}.json`,
    );
    const store = new PurchaseWorkflowStore(ledgerPath);
    const events: string[] = [];
    let current = record({
      purchaseMethod: '综合采购',
      unit: '件',
      unitPrice: 20,
      createdAt: 1784246400000,
    });
    const approvers = [
      {
        openId: 'ou_manager_1',
        name: '经理甲',
        positions: [],
        buildings: [],
      },
      {
        openId: 'ou_manager_2',
        name: '经理乙',
        positions: [],
        buildings: [],
      },
    ];
    const gateway = {
      listExecutionRecordsAsApp: jest
        .fn()
        .mockImplementation(async () => [current]),
      getExecutionRecordAsApp: jest
        .fn()
        .mockImplementation(async () => current),
      resolveConfiguredApproversAsApp: jest.fn().mockResolvedValue(approvers),
      resolvePurchaseAdminAsApp: jest.fn().mockResolvedValue({
        openId: 'ou_purchase_admin',
        name: '采购管理员',
        positions: [],
        buildings: [],
      }),
      sendInteractiveCard: jest
        .fn()
        .mockImplementation(async (recipientOpenId: string) => {
          events.push(`send:${recipientOpenId}`);
          return 'om_manager_2';
        }),
      updateExecutionRecordAsApp: jest.fn().mockImplementation(async () => {
        events.push('base:update');
        current = {
          ...current,
          status: '库房确认（待下单）',
          approvalCompleted: true,
          warehouseConfirmed: true,
          purchaserOpenId: 'ou_purchase_admin',
          purchaserName: '采购管理员',
        };
      }),
      updateInteractiveCard: jest
        .fn()
        .mockImplementation(async (messageId: string) => {
          events.push(`resolve:${messageId}`);
        }),
      sendTextNotification: jest.fn().mockResolvedValue(['om_text']),
    };
    const service = new PurchaseWorkflowService(gateway as never, store);
    const workerNow = new Date(Date.now() + 2_000);

    try {
      await store.enqueueNotifications([
        {
          businessEventId: 'approval-requested:rec_execution_1',
          recordId: 'rec_execution_1',
          recipientOpenId: 'ou_manager_1',
          kind: 'approval_requested',
        },
        {
          businessEventId: 'approval-requested:rec_execution_1',
          recordId: 'rec_execution_1',
          recipientOpenId: 'ou_manager_2',
          kind: 'approval_requested',
        },
      ]);
      const firstCard = await store.takeNextNotification(workerNow);
      expect(firstCard?.recipientOpenId).toBe('ou_manager_1');
      await store.completeNotification(
        firstCard?.key || '',
        firstCard?.claimToken || '',
        { messageId: 'om_manager_1' },
        workerNow,
      );
      await store.claimCardAction(
        {
          eventId: 'evt_manager_1_approve',
          recordId: 'rec_execution_1',
          action: 'approve',
          actorOpenId: 'ou_manager_1',
        },
        workerNow,
      );

      await service.runPendingTasks(2, new Date(workerNow.getTime() + 1_000));

      expect(events.slice(0, 2)).toEqual(['send:ou_manager_2', 'base:update']);
      await service.runPendingTasks(2, new Date(workerNow.getTime() + 2_000));

      expect(gateway.updateInteractiveCard).toHaveBeenCalledTimes(2);
      expect(
        gateway.updateInteractiveCard.mock.calls.map(([id]) => id),
      ).toEqual(['om_manager_1', 'om_manager_2']);
      for (const [, card] of gateway.updateInteractiveCard.mock.calls) {
        expect(JSON.stringify(card)).not.toContain('"behaviors"');
      }
    } finally {
      await store.onModuleDestroy();
      rmSync(ledgerPath, { force: true });
      rmSync(`${ledgerPath}.lock`, { force: true });
    }
  });
});

function claimedCommand(input: Record<string, unknown>) {
  return {
    claimed: true,
    entry: {
      ...input,
      completedAt: '',
      notificationWarnings: [],
    },
  };
}

function createDurableCommandStore(options: { failFirstRecord?: Error } = {}) {
  let command: Record<string, unknown> | null = null;
  let recordFailed = false;
  const store = {
    listPendingOrderNoticeCommands: jest.fn().mockResolvedValue([]),
    findCommand: jest.fn(async () => command),
    claimCommand: jest.fn(async (input: Record<string, unknown>) => {
      if (command) return { claimed: false, entry: command };
      command = {
        ...input,
        completedAt: '',
        notificationWarnings: [],
      };
      return { claimed: true, entry: command };
    }),
    releaseCommandClaim: jest.fn(async (_key: string, fingerprint: string) => {
      if (
        !command ||
        command.completedAt ||
        command.fingerprint !== fingerprint
      ) {
        return false;
      }
      command = null;
      return true;
    }),
    recordCommand: jest.fn(async (input: Record<string, unknown>) => {
      if (options.failFirstRecord && !recordFailed) {
        recordFailed = true;
        throw options.failFirstRecord;
      }
      command = {
        ...input,
        fingerprint: input.fingerprint || command?.fingerprint || '',
        startedAt: input.startedAt || command?.startedAt || '',
      };
    }),
  };
  return {
    store,
    current: () => command,
  };
}

it('keeps the page receipt action available when the retired program workflow is disabled', async () => {
  process.env.PURCHASE_WORKFLOW_PROGRAM_ENABLED = 'false';
  const awaitingReceipt = record({
    status: '下单完成（待签收）',
    purchaserOpenId: 'ou_manager',
    purchaserName: '测试经理',
    purchaseMethod: '综合采购',
    actualQuantity: 2,
    actualAmount: 20,
    purchaseCompleted: true,
  });
  const gateway = {
    getExecutionRecord: jest
      .fn()
      .mockResolvedValueOnce(awaitingReceipt)
      .mockResolvedValueOnce(awaitingReceipt)
      .mockResolvedValueOnce({
        ...awaitingReceipt,
        status: '采购完成（已入库）',
        receiptConfirmed: true,
      }),
    resolveUser: jest.fn().mockResolvedValue({
      openId: 'ou_manager',
      name: '测试经理',
      positions: ['设施运维经理'],
      buildings: [],
    }),
    updateExecutionRecord: jest.fn().mockResolvedValue(undefined),
    sendTextNotification: jest.fn().mockResolvedValue(undefined),
  };
  const store = {
    listPendingOrderNoticeCommands: jest.fn().mockResolvedValue([]),
    findCommand: jest.fn().mockResolvedValue(null),
    claimCommand: jest.fn(claimedCommand),
    releaseCommandClaim: jest.fn().mockResolvedValue(true),
    recordCommand: jest.fn().mockResolvedValue(undefined),
  };
  const service = new PurchaseWorkflowService(gateway as never, store as never);

  await expect(
    service.getDetail('rec_execution_1', session),
  ).resolves.toMatchObject({
    programEnabled: true,
    allowedActions: ['receive'],
    disabledReason: '',
  });
  await expect(
    service.receive('rec_execution_1', session, {
      signer: '测试经理',
      signerOpenId: 'ou_signer',
      receiptTime: 1784606400000,
      receiptPhotoTokens: ['file_receipt'],
      invoiceTokens: [],
      note: '签收完成',
    }),
  ).resolves.toMatchObject({ idempotent: false });
  expect(gateway.updateExecutionRecord).toHaveBeenCalledWith(
    'rec_execution_1',
    expect.objectContaining({
      签收人: [{ id: 'ou_signer' }],
      签收时间: 1784606400000,
      签收附件: [{ file_token: 'file_receipt' }],
      采购流程: '到货已签收（待入库）',
    }),
    'tenant-token',
  );
});
