jest.mock('@nestjs/common', () => {
  const actual = jest.requireActual('@nestjs/common');
  const decorator = () => () => undefined;
  return {
    ...actual,
    Controller: decorator,
    HttpCode: decorator,
    Optional: decorator,
    Post: decorator,
    Req: decorator,
  };
});

jest.mock(
  '@server/modules/overtime-workflow/overtime-workflow.service',
  () => ({
    OvertimeWorkflowService: class TestOvertimeWorkflowService {},
  }),
  { virtual: true },
);

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { PurchaseWorkflowCallbackController } from './purchase-workflow-callback.controller';

const verificationToken = 'overtime-integration-verification-token';
const originalEnv = { ...process.env };

describe('PurchaseWorkflowCallbackController overtime integration', () => {
  beforeEach(() => {
    process.env = {
      ...originalEnv,
      FEISHU_APP_ID: 'cli_synthetic_overtime_integration',
      FEISHU_PURCHASE_CARD_VERIFICATION_TOKEN: verificationToken,
      PURCHASE_WORKFLOW_PROGRAM_ENABLED: 'true',
      PURCHASE_WORKFLOW_APPROVER_OPEN_IDS: 'ou_purchase_approver',
      PURCHASE_MANAGER_APPROVAL_CARD_ENABLED: 'false',
    };
    delete process.env.FEISHU_PURCHASE_CARD_ENCRYPT_KEY;
    delete process.env.FEISHU_CARD_ENCRYPT_KEY;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.restoreAllMocks();
  });

  it('imports the overtime workflow module without replacing purchase providers', () => {
    const source = readFileSync(
      join(__dirname, 'purchase-inventory.module.ts'),
      'utf8',
    );
    expect(source).toContain(
      "import { OvertimeWorkflowModule } from '../overtime-workflow/overtime-workflow.module';",
    );
    expect(source).toMatch(
      /imports:\s*\[[\s\S]*OvertimeWorkflowModule[\s\S]*\]/,
    );
    expect(source).toContain('PurchaseWorkflowStore');
    expect(source).toContain('PurchaseManagerApprovalService');
  });

  it('durably accepts an overtime action before returning the accepted toast', async () => {
    const claimCardAction = jest.fn();
    const resolvedCard = {
      schema: '2.0',
      header: { title: { tag: 'plain_text', content: '加班申请审批通过' } },
    };
    const acceptApprovalAction = jest
      .fn()
      .mockResolvedValue({ claimed: true, card: resolvedCard });
    const controller = createController(claimCardAction, acceptApprovalAction);

    const response = await controller.handlePurchaseCardCallback(
      requestFor(
        overtimeActionPayload({
          eventId: 'evt_overtime_integration_01',
          actorOpenId: 'ou_overtime_approver',
          messageId: 'om_overtime_integration_01',
          recordId: 'rec_overtime_integration_01',
          action: 'approve',
        }),
      ),
    );

    expect(response).toEqual({
      toast: { type: 'info', content: '审批操作已受理' },
      card: resolvedCard,
    });
    expect((response as { card: unknown }).card).toBe(resolvedCard);
    expect(acceptApprovalAction).toHaveBeenCalledWith({
      eventId: 'evt_overtime_integration_01',
      actorOpenId: 'ou_overtime_approver',
      messageId: 'om_overtime_integration_01',
      recordId: 'rec_overtime_integration_01',
      action: 'approve',
    });
    expect(claimCardAction).not.toHaveBeenCalled();
  });

  it('returns the resolved card for a replayed overtime action', async () => {
    const resolvedCard = {
      schema: '2.0',
      header: { title: { tag: 'plain_text', content: '加班申请审批驳回' } },
    };
    const acceptApprovalAction = jest
      .fn()
      .mockResolvedValue({ claimed: false, card: resolvedCard });
    const controller = createController(jest.fn(), acceptApprovalAction);

    const response = await controller.handlePurchaseCardCallback(
      requestFor(
        overtimeActionPayload({
          eventId: 'evt_overtime_replay_01',
          actorOpenId: 'ou_overtime_approver',
          messageId: 'om_overtime_replay_01',
          recordId: 'rec_overtime_replay_01',
          action: 'reject',
        }),
      ),
    );

    expect(response).toEqual({
      toast: { type: 'warning', content: '该申请已处理或正在处理' },
      card: resolvedCard,
    });
    expect((response as { card: unknown }).card).toBe(resolvedCard);
  });

  it('preserves the existing purchase action path when overtime parsing declines it', async () => {
    const claimCardAction = jest.fn().mockResolvedValue({
      claimed: true,
      entry: { key: 'approval:rec_purchase_integration_01' },
    });
    const acceptApprovalAction = jest.fn();
    const controller = createController(claimCardAction, acceptApprovalAction);

    await expect(
      controller.handlePurchaseCardCallback(
        requestFor(purchaseActionPayload()),
      ),
    ).resolves.toEqual({
      toast: { type: 'info', content: '审批操作已受理' },
    });
    expect(claimCardAction).toHaveBeenCalledWith({
      eventId: 'evt_purchase_integration_01',
      recordId: 'rec_purchase_integration_01',
      action: 'approve',
      actorOpenId: 'ou_purchase_approver',
    });
    expect(acceptApprovalAction).not.toHaveBeenCalled();
  });

  it('does not accept overtime card actions when the workflow is explicitly disabled', async () => {
    const acceptApprovalAction = jest.fn();
    const controller = createController(jest.fn(), acceptApprovalAction, false);

    expect(() =>
      controller.handlePurchaseCardCallback(
        requestFor(
          overtimeActionPayload({
            eventId: 'evt_overtime_disabled_01',
            actorOpenId: 'ou_overtime_approver',
            messageId: 'om_overtime_disabled_01',
            recordId: 'rec_overtime_disabled_01',
            action: 'approve',
          }),
        ),
      ),
    ).toThrow();
    expect(acceptApprovalAction).not.toHaveBeenCalled();
  });

  it('uses one token priority for overtime dispatch and purchase fallback', async () => {
    const unifiedToken = 'unified-card-token';
    process.env.FEISHU_CARD_VERIFICATION_TOKEN = unifiedToken;
    process.env.FEISHU_OVERTIME_CARD_VERIFICATION_TOKEN =
      'different-overtime-token';
    process.env.FEISHU_PURCHASE_CARD_VERIFICATION_TOKEN =
      'different-purchase-token';
    const claimCardAction = jest.fn().mockResolvedValue({
      claimed: true,
      entry: { key: 'approval:rec_purchase_integration_01' },
    });
    const controller = createController(claimCardAction, jest.fn());

    await expect(
      controller.handlePurchaseCardCallback(
        requestFor(purchaseActionPayload(unifiedToken)),
      ),
    ).resolves.toEqual({
      toast: { type: 'info', content: '审批操作已受理' },
    });
    expect(claimCardAction).toHaveBeenCalledTimes(1);
  });
});

function createController(
  claimCardAction: jest.Mock,
  acceptApprovalAction: jest.Mock,
  enabled = true,
): PurchaseWorkflowCallbackController {
  const Controller = PurchaseWorkflowCallbackController as unknown as new (
    ...dependencies: unknown[]
  ) => PurchaseWorkflowCallbackController;
  return new Controller({ claimCardAction }, undefined, {
    acceptApprovalAction,
    isEnabled: () => enabled,
  }, { canUseFeishuBusinessIdentity: () => true }, { acceptApprovalCardAction: (input: unknown) => claimCardAction(input) });
}

function requestFor(payload: unknown): RawBodyRequest<Request> {
  return {
    headers: {},
    rawBody: Buffer.from(JSON.stringify(payload), 'utf8'),
  } as RawBodyRequest<Request>;
}

function overtimeActionPayload(input: {
  eventId: string;
  actorOpenId: string;
  messageId: string;
  recordId: string;
  action: 'approve' | 'reject';
}) {
  return {
    schema: '2.0',
    header: {
      event_id: input.eventId,
      event_type: 'card.action.trigger',
      token: verificationToken,
    },
    event: {
      operator: { open_id: input.actorOpenId },
      context: { open_message_id: input.messageId },
      action: {
        tag: 'button',
        value: {
          version: 1,
          action: input.action,
          recordId: input.recordId,
        },
      },
    },
  };
}

function purchaseActionPayload(token = verificationToken) {
  return {
    schema: '2.0',
    header: {
      event_id: 'evt_purchase_integration_01',
      event_type: 'card.action.trigger',
      token,
    },
    event: {
      operator: { open_id: 'ou_purchase_approver' },
      action: {
        tag: 'button',
        value: {
          version: 1,
          action: 'approve',
          executionRecordId: 'rec_purchase_integration_01',
        },
      },
    },
  };
}
