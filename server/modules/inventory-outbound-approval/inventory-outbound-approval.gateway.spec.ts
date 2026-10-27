import type { HttpService } from '@nestjs/axios';
import type {
  InventoryOutboundApprovalDecision,
  InventoryOutboundApprovalSnapshot,
} from './inventory-outbound-approval.types';
import {
  InventoryOutboundApprovalGateway,
  InventoryOutboundApprovalSyncUnconfirmedException,
} from './inventory-outbound-approval.gateway';

describe('InventoryOutboundApprovalGateway', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.FEISHU_APP_ID = 'cli_inventory_outbound';
    process.env.FEISHU_APP_SECRET = 'inventory-outbound-secret';
    process.env.FEISHU_WAREHOUSE_SOURCE_URL =
      'https://vnet.feishu.cn/base/warehouse_app_token?table=tbl_source_only';
    process.env.FEISHU_WAREHOUSE_APP_TOKEN = 'warehouse_app_token';
    process.env.FEISHU_WAREHOUSE_OUTBOUND_TABLE_ID = 'tbl_outbound_approval';
    delete process.env.FEISHU_OUTBOUND_TABLE_ID;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('sends an interactive card with the persisted RFC UUID unchanged and a finite timeout', async () => {
    const post = jest
      .fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce({
        data: { code: 0, data: { message_id: 'om_outbound_approval_1' } },
      });
    const gateway = makeGateway({ post });
    const deliveryUuid = '0f45ce5d-09d3-4c8e-a10a-a4df94fb17f7';

    await expect(
      gateway.sendInteractiveCard(
        'ou_inventory_approver',
        { schema: '2.0', body: { elements: [] } },
        deliveryUuid,
      ),
    ).resolves.toBe('om_outbound_approval_1');

    expect(post.mock.calls[1][0]).toBe(
      'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id',
    );
    expect(post.mock.calls[1][1]).toEqual({
      receive_id: 'ou_inventory_approver',
      msg_type: 'interactive',
      content: JSON.stringify({ schema: '2.0', body: { elements: [] } }),
      uuid: deliveryUuid,
    });
    expect(post.mock.calls[1][2]).toEqual(
      expect.objectContaining({ timeout: 15_000 }),
    );
  });

  it('patches only a valid Feishu message and enforces the 30 KB card limit', async () => {
    const post = jest.fn().mockResolvedValue(tokenResponse());
    const patch = jest.fn().mockResolvedValue({ data: { code: 0 } });
    const gateway = makeGateway({ post, patch });

    await gateway.patchInteractiveCard('om_outbound_approval_1', {
      schema: '2.0',
    });

    expect(patch).toHaveBeenCalledWith(
      'https://open.feishu.cn/open-apis/im/v1/messages/om_outbound_approval_1',
      { content: JSON.stringify({ schema: '2.0' }) },
      expect.objectContaining({ timeout: 15_000 }),
    );
    await expect(
      gateway.patchInteractiveCard('message-invalid', { schema: '2.0' }),
    ).rejects.toThrow('飞书卡片消息标识无效');
    await expect(
      gateway.sendInteractiveCard(
        'ou_inventory_approver',
        { text: 'x'.repeat(31 * 1_024) },
        '0f45ce5d-09d3-4c8e-a10a-a4df94fb17f7',
      ),
    ).rejects.toThrow('30 KB');
  });

  it('rejects invalid recipients and non-RFC delivery UUIDs before making a request', async () => {
    const post = jest.fn();
    const gateway = makeGateway({ post });

    await expect(
      gateway.sendInteractiveCard(
        'user-by-name',
        { schema: '2.0' },
        '0f45ce5d-09d3-4c8e-a10a-a4df94fb17f7',
      ),
    ).rejects.toThrow('open_id');
    await expect(
      gateway.sendInteractiveCard(
        'ou_inventory_approver',
        { schema: '2.0' },
        'hashed_business_key',
      ),
    ).rejects.toThrow('RFC UUID');
    expect(post).not.toHaveBeenCalled();
  });

  it('reads the dedicated warehouse outbound table with a finite timeout', async () => {
    const post = jest.fn().mockResolvedValue(tokenResponse());
    const get = jest.fn().mockResolvedValue({
      data: {
        code: 0,
        data: {
          record: {
            record_id: 'rec_outbound_1',
            fields: { 程序出库状态: '待审批' },
          },
        },
      },
    });
    const gateway = makeGateway({ post, get });

    await expect(gateway.readOutboundRecord('rec_outbound_1')).resolves.toEqual(
      {
        recordId: 'rec_outbound_1',
        fields: { 程序出库状态: '待审批' },
      },
    );
    expect(get).toHaveBeenCalledWith(
      'https://open.feishu.cn/open-apis/bitable/v1/apps/warehouse_app_token/tables/tbl_outbound_approval/records/rec_outbound_1',
      expect.objectContaining({ timeout: 15_000 }),
    );
  });

  it('lists only unfinished outbound approvals across bounded pages with exact fields', async () => {
    const post = jest
      .fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce({
        data: {
          code: 0,
          data: {
            items: [
              recoveryRecord('rec_pending', { name: '待审批' }),
              recoveryRecord('rec_completed_approved', '已通过', {
                出库审批收尾状态: '已完成',
              }),
              recoveryRecord('rec_out_of_scope', '已出库'),
            ],
            has_more: true,
            page_token: 'page-2',
          },
        },
      })
      .mockResolvedValueOnce({
        data: {
          code: 0,
          data: {
            items: [
              recoveryRecord('rec_pending', '待审批'),
              recoveryRecord('rec_decided', [{ text: '已通过' }], {
                出库审批收尾状态: { select: '待收尾' },
              }),
              recoveryRecord('rec_completed_rejected', '已驳回', {
                出库审批收尾状态: [{ text: '已完成' }],
              }),
              recoveryRecord('rec_sync_error', { select: '同步异常' }),
            ],
            has_more: false,
          },
        },
      });
    const gateway = makeGateway({ post });
    const listRecoveryRecords = (
      gateway as unknown as {
        listRecoveryRecords?: () => Promise<
          Array<{ recordId: string; fields: Record<string, unknown> }>
        >;
      }
    ).listRecoveryRecords;

    expect(listRecoveryRecords).toEqual(expect.any(Function));
    await expect(listRecoveryRecords!.call(gateway)).resolves.toEqual([
      {
        recordId: 'rec_pending',
        fields: { 出库工作流状态: { name: '待审批' } },
      },
      {
        recordId: 'rec_decided',
        fields: {
          出库工作流状态: [{ text: '已通过' }],
          出库审批收尾状态: { select: '待收尾' },
        },
      },
      {
        recordId: 'rec_sync_error',
        fields: { 出库工作流状态: { select: '同步异常' } },
      },
    ]);

    const firstSearch = post.mock.calls[1];
    expect(firstSearch[0]).toBe(
      'https://open.feishu.cn/open-apis/bitable/v1/apps/warehouse_app_token/tables/tbl_outbound_approval/records/search',
    );
    expect(firstSearch[1]).toEqual({
      field_names: OUTBOUND_RECOVERY_FIELD_NAMES,
      filter: {
        conjunction: 'or',
        conditions: [
          ...RECOVERABLE_WORKFLOW_STATUSES.map((status) => ({
            field_name: '出库工作流状态',
            operator: 'is',
            value: [status],
          })),
          {
            field_name: '出库审批收尾状态',
            operator: 'is',
            value: ['待收尾'],
          },
        ],
      },
    });
    expect(firstSearch[1].field_names).not.toContain('流程');
    expect(firstSearch[2]).toEqual(
      expect.objectContaining({
        timeout: 15_000,
        params: { page_size: 100, page_token: undefined },
      }),
    );
    expect(post.mock.calls[2][2]).toEqual(
      expect.objectContaining({
        timeout: 15_000,
        params: { page_size: 100, page_token: 'page-2' },
      }),
    );
  });

  it('fails closed when recovery pagination repeats a page token', async () => {
    const post = jest
      .fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce({
        data: {
          code: 0,
          data: { items: [], has_more: true, page_token: 'repeat' },
        },
      })
      .mockResolvedValueOnce({
        data: {
          code: 0,
          data: { items: [], has_more: true, page_token: 'repeat' },
        },
      });
    const gateway = makeGateway({ post }) as unknown as {
      listRecoveryRecords: () => Promise<unknown>;
    };

    await expect(gateway.listRecoveryRecords()).rejects.toThrow(
      /分页标识重复/u,
    );
    expect(post).toHaveBeenCalledTimes(3);
  });

  it('fails closed when recovery pagination exceeds the page budget', async () => {
    const post = jest.fn().mockResolvedValueOnce(tokenResponse());
    for (let page = 1; page <= 20; page += 1) {
      post.mockResolvedValueOnce({
        data: {
          code: 0,
          data: {
            items: [],
            has_more: true,
            page_token: `page-${page}`,
          },
        },
      });
    }
    const gateway = makeGateway({ post }) as unknown as {
      listRecoveryRecords: () => Promise<unknown>;
    };

    await expect(gateway.listRecoveryRecords()).rejects.toThrow(/超过 20 页/u);
    expect(post).toHaveBeenCalledTimes(21);
  });

  it('writes and clears only the workflow error with mandatory semantic readback', async () => {
    const post = jest.fn().mockResolvedValue(tokenResponse());
    const put = jest.fn().mockResolvedValue({ data: { code: 0 } });
    const get = jest
      .fn()
      .mockResolvedValueOnce({
        data: {
          code: 0,
          data: {
            record: {
              record_id: 'rec_outbound_1',
              fields: { 出库工作流错误: { text: '库房管理员 未配置' } },
            },
          },
        },
      })
      .mockResolvedValueOnce({
        data: {
          code: 0,
          data: {
            record: {
              record_id: 'rec_outbound_1',
              fields: { 出库工作流错误: null },
            },
          },
        },
      });
    const gateway = makeGateway({ post, put, get }) as unknown as {
      writeWorkflowError?: (recordId: string, error: unknown) => Promise<void>;
      clearWorkflowError?: (recordId: string) => Promise<void>;
    };

    expect(gateway.writeWorkflowError).toEqual(expect.any(Function));
    expect(gateway.clearWorkflowError).toEqual(expect.any(Function));
    await gateway.writeWorkflowError!(
      'rec_outbound_1',
      '  库房管理员\r\n未配置  ',
    );
    await gateway.clearWorkflowError!('rec_outbound_1');

    expect(put.mock.calls[0][1]).toEqual({
      fields: { 出库工作流错误: '库房管理员 未配置' },
    });
    expect(put.mock.calls[1][1]).toEqual({
      fields: { 出库工作流错误: '' },
    });
    expect(put.mock.calls[0][1].fields).not.toHaveProperty('流程');
    expect(put.mock.calls[1][1].fields).not.toHaveProperty('流程');
  });

  it('fails closed when the workflow error semantic readback is stale', async () => {
    const post = jest.fn().mockResolvedValue(tokenResponse());
    const put = jest.fn().mockResolvedValue({ data: { code: 0 } });
    const get = jest.fn().mockResolvedValue({
      data: {
        code: 0,
        data: {
          record: {
            record_id: 'rec_outbound_1',
            fields: { 出库工作流错误: '旧错误' },
          },
        },
      },
    });
    const gateway = makeGateway({ post, put, get }) as unknown as {
      writeWorkflowError: (recordId: string, error: unknown) => Promise<void>;
    };

    const error = await gateway
      .writeWorkflowError('rec_outbound_1', '新错误')
      .then(() => null)
      .catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(
      InventoryOutboundApprovalSyncUnconfirmedException,
    );
    expect(error).toMatchObject({ retryable: true });
    expect(String((error as Error).message)).toContain('出库工作流错误');
  });

  it('requires the dedicated warehouse outbound table id and never falls back to legacy config', async () => {
    process.env.FEISHU_WAREHOUSE_OUTBOUND_TABLE_ID = '';
    process.env.FEISHU_OUTBOUND_TABLE_ID = 'tbl_legacy_outbound';
    const gateway = makeGateway({});

    await expect(gateway.readOutboundRecord('rec_outbound_1')).rejects.toThrow(
      'FEISHU_WAREHOUSE_OUTBOUND_TABLE_ID',
    );
  });

  it('writes exact pending fields without touching the read-only Stage field and verifies wrapped values semantically', async () => {
    const post = jest.fn().mockResolvedValue(tokenResponse());
    const put = jest.fn().mockResolvedValue({ data: { code: 0 } });
    const get = jest.fn().mockResolvedValue({
      data: {
        code: 0,
        data: {
          record: {
            record_id: 'rec_outbound_1',
            fields: {
              程序出库状态: [{ text: '待审批' }],
              出库工作流状态: { select: { name: '待审批' } },
              出库当前审批人: {
                users: [
                  { open_id: 'ou_inventory_approver_2', name: '审批人二' },
                  { id: 'ou_inventory_approver_1', name: '审批人一' },
                ],
              },
              出库审批策略版本: { value: 'inventory-outbound-v1' },
              出库工作流错误: null,
              出库审批快照: JSON.stringify({
                schemaVersion: 1,
                snapshot: snapshot(),
              }),
              流程: { name: '已申请' },
            },
          },
        },
      },
    });
    const gateway = makeGateway({ post, put, get });

    await expect(gateway.writePendingApproval(snapshot())).resolves.toBe(
      undefined,
    );

    const written = put.mock.calls[0][1].fields;
    expect(written).toEqual({
      程序出库状态: '待审批',
      出库工作流状态: '待审批',
      出库当前审批人: [
        { id: 'ou_inventory_approver_1' },
        { id: 'ou_inventory_approver_2' },
      ],
      出库审批策略版本: 'inventory-outbound-v1',
      出库工作流错误: '',
      出库审批快照: JSON.stringify({
        schemaVersion: 1,
        snapshot: snapshot(),
      }),
    });
    expect(written).not.toHaveProperty('流程');
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('reroutes only the exact historical approved snapshot and clears all old decision evidence', async () => {
    const previous = snapshot();
    const decision = approvedDecision();
    const replacement: InventoryOutboundApprovalSnapshot = {
      ...previous,
      version: 2,
      policyVersion: 'inventory-outbound-responsible-v2',
      approvers: [{ openId: 'ou_current_responsible', name: '当前责任人' }],
    };
    const post = jest.fn().mockResolvedValue(tokenResponse());
    const put = jest.fn().mockResolvedValue({ data: { code: 0 } });
    const get = jest
      .fn()
      .mockResolvedValueOnce(
        recordResponse(previous.recordId, {
          程序出库状态: '待库房确认',
          出库工作流状态: '已通过',
          出库当前审批人: [],
          出库实际审批人: [{ id: decision.actorOpenId }],
          出库审批时间: Date.parse(decision.decidedAt),
          出库审批策略版本: previous.policyVersion,
          出库审批动作标识: decision.eventId,
          出库审批快照: serializedSnapshot(previous),
          出库确认标识: '',
        }),
      )
      .mockResolvedValueOnce(
        recordResponse(previous.recordId, reroutedReadbackFields(replacement)),
      );
    const gateway = makeGateway({ post, put, get });

    await expect(
      gateway.writeReroutedPendingApproval(previous, decision, replacement),
    ).resolves.toBeUndefined();

    expect(put.mock.calls[0][1].fields).toEqual({
      程序出库状态: '待审批',
      出库工作流状态: '待审批',
      出库当前审批人: [{ id: 'ou_current_responsible' }],
      出库实际审批人: [],
      出库审批时间: null,
      出库审批策略版本: replacement.policyVersion,
      出库驳回原因: '',
      出库审批动作标识: '',
      出库工作流错误: '',
      出库审批快照: serializedSnapshot(replacement),
      出库审批投递台账: '',
      出库审批收尾状态: null,
      出库审批结果投递台账: '',
      出库确认标识: '',
    });
  });

  it('treats the exact replacement pending version as an idempotent reroute retry', async () => {
    const previous = snapshot();
    const replacement: InventoryOutboundApprovalSnapshot = {
      ...previous,
      version: 2,
      policyVersion: 'inventory-outbound-responsible-v2',
      approvers: [{ openId: 'ou_current_responsible', name: '当前责任人' }],
    };
    const post = jest.fn().mockResolvedValue(tokenResponse());
    const put = jest.fn();
    const get = jest
      .fn()
      .mockResolvedValue(
        recordResponse(previous.recordId, reroutedReadbackFields(replacement)),
      );
    const gateway = makeGateway({ post, put, get });

    await expect(
      gateway.writeReroutedPendingApproval(
        previous,
        approvedDecision(),
        replacement,
      ),
    ).resolves.toBeUndefined();
    expect(put).not.toHaveBeenCalled();
  });

  it.each([
    ['completed record', { 程序出库状态: '已出库' }],
    ['changed event binding', { 出库审批动作标识: 'ws_other_event' }],
    ['existing confirmation', { 出库确认标识: 'ws_confirmed' }],
  ])(
    'refuses reroute when the old approval %s changed',
    async (_label, drift) => {
      const previous = snapshot();
      const decision = approvedDecision();
      const replacement: InventoryOutboundApprovalSnapshot = {
        ...previous,
        version: 2,
        policyVersion: 'inventory-outbound-responsible-v2',
        approvers: [{ openId: 'ou_current_responsible', name: '当前责任人' }],
      };
      const post = jest.fn().mockResolvedValue(tokenResponse());
      const put = jest.fn();
      const get = jest.fn().mockResolvedValue(
        recordResponse(previous.recordId, {
          程序出库状态: '待库房确认',
          出库工作流状态: '已通过',
          出库当前审批人: [],
          出库实际审批人: [{ id: decision.actorOpenId }],
          出库审批时间: Date.parse(decision.decidedAt),
          出库审批策略版本: previous.policyVersion,
          出库审批动作标识: decision.eventId,
          出库审批快照: serializedSnapshot(previous),
          出库确认标识: '',
          ...drift,
        }),
      );
      const gateway = makeGateway({ post, put, get });

      await expect(
        gateway.writeReroutedPendingApproval(previous, decision, replacement),
      ).rejects.toThrow('旧出库审批状态已变化');
      expect(put).not.toHaveBeenCalled();
    },
  );

  it('persists the complete approval-card delivery ledger in stable recipient order with semantic readback', async () => {
    const input = snapshot();
    const expectedLedger = JSON.stringify({
      schemaVersion: 1,
      recordId: input.recordId,
      version: input.version,
      deliveries: [
        {
          recipientOpenId: 'ou_inventory_approver_1',
          recipientName: '审批人一',
          deliveryUuid: '0f45ce5d-09d3-4c8e-a10a-a4df94fb17f7',
          messageId: 'om_outbound_approval_1',
        },
        {
          recipientOpenId: 'ou_inventory_approver_2',
          recipientName: '审批人二',
          deliveryUuid: '5a929d4b-c017-4ce9-9853-111357b9c19a',
          messageId: 'om_outbound_approval_2',
        },
      ],
    });
    const post = jest.fn().mockResolvedValue(tokenResponse());
    const put = jest.fn().mockResolvedValue({ data: { code: 0 } });
    const get = jest.fn().mockResolvedValue({
      data: {
        code: 0,
        data: {
          record: {
            record_id: input.recordId,
            fields: { 出库审批投递台账: { text: expectedLedger } },
          },
        },
      },
    });
    const gateway = makeGateway({ post, put, get }) as unknown as {
      writeApprovalCardDeliveryLedger: (
        snapshot: InventoryOutboundApprovalSnapshot,
        deliveries: Array<{
          recipientOpenId: string;
          recipientName: string;
          deliveryUuid: string;
          messageId: string;
        }>,
      ) => Promise<void>;
    };

    await expect(
      gateway.writeApprovalCardDeliveryLedger(input, [
        {
          recipientOpenId: 'ou_inventory_approver_2',
          recipientName: '审批人二',
          deliveryUuid: '5a929d4b-c017-4ce9-9853-111357b9c19a',
          messageId: 'om_outbound_approval_2',
        },
        {
          recipientOpenId: 'ou_inventory_approver_1',
          recipientName: '审批人一',
          deliveryUuid: '0f45ce5d-09d3-4c8e-a10a-a4df94fb17f7',
          messageId: 'om_outbound_approval_1',
        },
      ]),
    ).resolves.toBeUndefined();

    expect(put.mock.calls[0][1]).toEqual({
      fields: { 出库审批投递台账: expectedLedger },
    });
    expect(put.mock.calls[0][1].fields).not.toHaveProperty('流程');
  });

  it('rejects a delivery ledger entry that is not bound to the approval snapshot before external I/O', async () => {
    const post = jest.fn();
    const put = jest.fn();
    const get = jest.fn();
    const gateway = makeGateway({ post, put, get }) as unknown as {
      writeApprovalCardDeliveryLedger: (
        snapshot: InventoryOutboundApprovalSnapshot,
        deliveries: Array<{
          recipientOpenId: string;
          recipientName: string;
          deliveryUuid: string;
          messageId: string;
        }>,
      ) => Promise<void>;
    };

    await expect(
      gateway.writeApprovalCardDeliveryLedger(snapshot(), [
        {
          recipientOpenId: 'ou_not_in_snapshot',
          recipientName: '越权人员',
          deliveryUuid: '0f45ce5d-09d3-4c8e-a10a-a4df94fb17f7',
          messageId: 'om_outbound_approval_1',
        },
      ]),
    ).rejects.toThrow('审批人快照');
    expect(post).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });

  it('persists the decision-bound result delivery ledger in stable recipient order with semantic readback', async () => {
    const input = snapshot({
      managerRecipients: [
        { openId: 'ou_inventory_manager', name: '库房管理人' },
      ],
    });
    const decision = approvedDecision();
    const expectedLedger = JSON.stringify({
      schemaVersion: 1,
      recordId: input.recordId,
      version: input.version,
      decisionEventId: decision.eventId,
      decisionAction: decision.action,
      deliveries: [
        {
          recipientOpenId: 'ou_inventory_applicant',
          recipientName: '出库申请人',
          deliveryUuid: '997479e7-fa34-5e96-8fdc-102d1166052a',
          messageId: 'om_outbound_result_applicant',
        },
        {
          recipientOpenId: 'ou_inventory_approver_1',
          recipientName: '审批人一',
          deliveryUuid: 'c68676ae-8c06-5941-98f8-60d33fbb7f02',
          messageId: 'om_outbound_result_approver_1',
        },
        {
          recipientOpenId: 'ou_inventory_manager',
          recipientName: '库房管理人',
          deliveryUuid: '20aead44-839d-57b4-ade8-c75ac7519308',
          messageId: 'om_outbound_result_manager',
        },
      ],
    });
    const post = jest.fn().mockResolvedValue(tokenResponse());
    const put = jest.fn().mockResolvedValue({ data: { code: 0 } });
    const get = jest.fn().mockResolvedValue({
      data: {
        code: 0,
        data: {
          record: {
            record_id: input.recordId,
            fields: { 出库审批结果投递台账: { text: expectedLedger } },
          },
        },
      },
    });
    const gateway = makeGateway({ post, put, get }) as unknown as {
      writeApprovalResultDeliveryLedger: (
        snapshot: InventoryOutboundApprovalSnapshot,
        decision: InventoryOutboundApprovalDecision,
        deliveries: Array<{
          recipientOpenId: string;
          recipientName: string;
          deliveryUuid: string;
          messageId: string;
        }>,
      ) => Promise<void>;
    };

    await expect(
      gateway.writeApprovalResultDeliveryLedger(input, decision, [
        {
          recipientOpenId: 'ou_inventory_approver_1',
          recipientName: '审批人一',
          deliveryUuid: 'c68676ae-8c06-5941-98f8-60d33fbb7f02',
          messageId: 'om_outbound_result_approver_1',
        },
        {
          recipientOpenId: 'ou_inventory_applicant',
          recipientName: '出库申请人',
          deliveryUuid: '997479e7-fa34-5e96-8fdc-102d1166052a',
          messageId: 'om_outbound_result_applicant',
        },
        {
          recipientOpenId: 'ou_inventory_manager',
          recipientName: '库房管理人',
          deliveryUuid: '20aead44-839d-57b4-ade8-c75ac7519308',
          messageId: 'om_outbound_result_manager',
        },
      ]),
    ).resolves.toBeUndefined();

    expect(put.mock.calls[0][1]).toEqual({
      fields: { 出库审批结果投递台账: expectedLedger },
    });
  });

  it('deduplicates one Open ID shared by applicant and notification-only manager', async () => {
    const input: InventoryOutboundApprovalSnapshot = {
      ...snapshot(),
      managerRecipients: [
        { openId: 'ou_inventory_applicant', name: '管理人展示名' },
      ],
    };
    const decision = approvedDecision();
    const expectedLedger = JSON.stringify({
      schemaVersion: 1,
      recordId: input.recordId,
      version: input.version,
      decisionEventId: decision.eventId,
      decisionAction: decision.action,
      deliveries: [
        {
          recipientOpenId: 'ou_inventory_applicant',
          recipientName: '出库申请人',
          deliveryUuid: '997479e7-fa34-5e96-8fdc-102d1166052a',
          messageId: 'om_outbound_result_applicant',
        },
      ],
    });
    const post = jest.fn().mockResolvedValue(tokenResponse());
    const put = jest.fn().mockResolvedValue({ data: { code: 0 } });
    const get = jest.fn().mockResolvedValue({
      data: {
        code: 0,
        data: {
          record: {
            record_id: input.recordId,
            fields: { 出库审批结果投递台账: { text: expectedLedger } },
          },
        },
      },
    });
    const gateway = makeGateway({ post, put, get }) as unknown as {
      writeApprovalResultDeliveryLedger: (
        snapshot: InventoryOutboundApprovalSnapshot,
        decision: InventoryOutboundApprovalDecision,
        deliveries: Array<{
          recipientOpenId: string;
          recipientName: string;
          deliveryUuid: string;
          messageId: string;
        }>,
      ) => Promise<void>;
    };

    await expect(
      gateway.writeApprovalResultDeliveryLedger(input, decision, [
        {
          recipientOpenId: 'ou_inventory_applicant',
          recipientName: '出库申请人',
          deliveryUuid: '997479e7-fa34-5e96-8fdc-102d1166052a',
          messageId: 'om_outbound_result_applicant',
        },
      ]),
    ).resolves.toBeUndefined();
  });

  it('rejects an unbound result recipient or non-deterministic delivery UUID before external I/O', async () => {
    const post = jest.fn();
    const put = jest.fn();
    const get = jest.fn();
    const gateway = makeGateway({ post, put, get }) as unknown as {
      writeApprovalResultDeliveryLedger: (
        snapshot: InventoryOutboundApprovalSnapshot,
        decision: InventoryOutboundApprovalDecision,
        deliveries: Array<{
          recipientOpenId: string;
          recipientName: string;
          deliveryUuid: string;
          messageId: string;
        }>,
      ) => Promise<void>;
    };
    const validDelivery = {
      recipientOpenId: 'ou_inventory_applicant',
      recipientName: '出库申请人',
      deliveryUuid: '997479e7-fa34-5e96-8fdc-102d1166052a',
      messageId: 'om_outbound_result_applicant',
    };

    await expect(
      gateway.writeApprovalResultDeliveryLedger(
        snapshot(),
        approvedDecision(),
        [{ ...validDelivery, recipientOpenId: 'ou_not_in_snapshot' }],
      ),
    ).rejects.toThrow(/申请人或审批人快照/u);
    await expect(
      gateway.writeApprovalResultDeliveryLedger(
        snapshot(),
        approvedDecision(),
        [
          {
            ...validDelivery,
            deliveryUuid: '0f45ce5d-09d3-4c8e-a10a-a4df94fb17f7',
          },
        ],
      ),
    ).rejects.toThrow(/UUID/u);
    expect(post).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });

  it('writes an approved decision with millisecond time and verifies User/Select/date wrappers semantically', async () => {
    const input = snapshot();
    const decision = approvedDecision();
    const decidedAtMs = Date.parse(decision.decidedAt);
    const post = jest.fn().mockResolvedValue(tokenResponse());
    const put = jest.fn().mockResolvedValue({ data: { code: 0 } });
    const get = jest.fn().mockResolvedValue({
      data: {
        code: 0,
        data: {
          record: {
            record_id: input.recordId,
            fields: {
              程序出库状态: { select: { name: '待库房确认' } },
              出库工作流状态: [{ text: '已通过' }],
              出库当前审批人: null,
              出库实际审批人: {
                users: [{ openId: decision.actorOpenId, name: '审批人一' }],
              },
              出库审批时间: { timestamp: decidedAtMs },
              出库审批策略版本: [{ text: input.policyVersion }],
              出库审批动作标识: { value: decision.eventId },
              出库驳回原因: [],
              出库工作流错误: '',
              出库审批收尾状态: { select: { name: '待收尾' } },
            },
          },
        },
      },
    });
    const gateway = makeGateway({ post, put, get });

    await gateway.writeDecision(input, decision);

    const written = put.mock.calls[0][1].fields;
    expect(written).toEqual({
      程序出库状态: '待库房确认',
      出库工作流状态: '已通过',
      出库当前审批人: [],
      出库实际审批人: [{ id: decision.actorOpenId }],
      出库审批时间: decidedAtMs,
      出库审批策略版本: input.policyVersion,
      出库审批动作标识: decision.eventId,
      出库驳回原因: '',
      出库工作流错误: '',
      出库审批收尾状态: '待收尾',
    });
    expect(written).not.toHaveProperty('流程');
  });

  it('never downgrades an already completed outbound record while retrying the same approved decision', async () => {
    const input = snapshot();
    const decision = approvedDecision();
    const post = jest.fn().mockResolvedValue(tokenResponse());
    const put = jest.fn();
    const get = jest.fn().mockResolvedValue({
      data: {
        code: 0,
        data: {
          record: {
            record_id: input.recordId,
            fields: {
              程序出库状态: '已出库',
              出库工作流状态: '已通过',
              出库当前审批人: [],
              出库实际审批人: [{ id: decision.actorOpenId }],
              出库审批时间: Date.parse(decision.decidedAt),
              出库审批策略版本: input.policyVersion,
              出库审批动作标识: decision.eventId,
              出库驳回原因: '',
              出库工作流错误: '',
            },
          },
        },
      },
    });
    const gateway = makeGateway({ post, put, get });

    await expect(
      gateway.writeDecision(input, decision),
    ).resolves.toBeUndefined();
    expect(put).not.toHaveBeenCalled();
  });

  it('writes a rejected decision and preserves the required rejection reason', async () => {
    const input = snapshot();
    const decision: InventoryOutboundApprovalDecision = {
      ...approvedDecision(),
      action: 'reject',
      reason: '申请用途不符合库房领用规则',
    };
    const post = jest.fn().mockResolvedValue(tokenResponse());
    const put = jest.fn().mockResolvedValue({ data: { code: 0 } });
    const get = jest
      .fn()
      .mockResolvedValueOnce(pendingDecisionPreReadResponse(input.recordId))
      .mockResolvedValueOnce({
        data: {
          code: 0,
          data: {
            record: {
              record_id: input.recordId,
              fields: {
                程序出库状态: '已驳回',
                出库工作流状态: { name: '已驳回' },
                出库当前审批人: [],
                出库实际审批人: [{ id: decision.actorOpenId }],
                出库审批时间: new Date(decision.decidedAt).toISOString(),
                出库审批策略版本: input.policyVersion,
                出库审批动作标识: decision.eventId,
                出库驳回原因: { text: decision.reason },
                出库工作流错误: null,
                出库审批收尾状态: '待收尾',
              },
            },
          },
        },
      });
    const gateway = makeGateway({ post, put, get });

    await gateway.writeDecision(input, decision);

    expect(put.mock.calls[0][1].fields).toEqual(
      expect.objectContaining({
        程序出库状态: '已驳回',
        出库工作流状态: '已驳回',
        出库驳回原因: decision.reason,
      }),
    );
  });

  it('marks approval finalization completed with mandatory semantic readback', async () => {
    const post = jest.fn().mockResolvedValue(tokenResponse());
    const put = jest.fn().mockResolvedValue({ data: { code: 0 } });
    const get = jest.fn().mockResolvedValue({
      data: {
        code: 0,
        data: {
          record: {
            record_id: 'rec_outbound_1',
            fields: { 出库审批收尾状态: { name: '已完成' } },
          },
        },
      },
    });
    const gateway = makeGateway({ post, put, get }) as unknown as {
      writeFinalizationCompleted: (
        snapshot: InventoryOutboundApprovalSnapshot,
      ) => Promise<void>;
    };

    await expect(
      gateway.writeFinalizationCompleted(snapshot()),
    ).resolves.toBeUndefined();
    expect(put.mock.calls[0][1]).toEqual({
      fields: { 出库审批收尾状态: '已完成' },
    });
  });

  it.each([
    ['NFC and CRLF', '  e\u0301库存\r\n保留  ', 'é库存\n保留'],
    ['500 Unicode code points', '😀'.repeat(500), '😀'.repeat(500)],
  ])(
    'normalizes a rejected decision using %s semantics',
    async (_label, reason, expectedReason) => {
      const input = snapshot();
      const decision: InventoryOutboundApprovalDecision = {
        ...approvedDecision(),
        action: 'reject',
        reason,
      };
      const post = jest.fn().mockResolvedValue(tokenResponse());
      const put = jest.fn().mockResolvedValue({ data: { code: 0 } });
      const get = jest
        .fn()
        .mockResolvedValueOnce(pendingDecisionPreReadResponse(input.recordId))
        .mockResolvedValueOnce({
          data: {
            code: 0,
            data: {
              record: {
                record_id: input.recordId,
                fields: rejectedReadbackFields(input, decision, expectedReason),
              },
            },
          },
        });
      const gateway = makeGateway({ post, put, get });

      await gateway.writeDecision(input, decision);

      expect(put.mock.calls[0][1].fields.出库驳回原因).toBe(expectedReason);
    },
  );

  it.each(['库存\t不足', '库存\u000b不足', '😀'.repeat(501)])(
    'rejects a non-canonical rejection reason %# before external I/O',
    async (reason) => {
      const post = jest.fn();
      const put = jest.fn();
      const get = jest.fn();
      const gateway = makeGateway({ post, put, get });

      await expect(
        gateway.writeDecision(snapshot(), {
          ...approvedDecision(),
          action: 'reject',
          reason,
        }),
      ).rejects.toThrow('出库驳回原因需填写 2–500 字');
      expect(post).not.toHaveBeenCalled();
      expect(put).not.toHaveBeenCalled();
      expect(get).not.toHaveBeenCalled();
    },
  );

  it('accepts an unknown update outcome only when mandatory readback confirms every field', async () => {
    const post = jest.fn().mockResolvedValue(tokenResponse());
    const put = jest
      .fn()
      .mockRejectedValue(
        Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }),
      );
    const get = jest.fn().mockResolvedValue({
      data: {
        code: 0,
        data: {
          record: {
            record_id: 'rec_outbound_1',
            fields: pendingReadbackFields(),
          },
        },
      },
    });
    const gateway = makeGateway({ post, put, get });

    await expect(gateway.writePendingApproval(snapshot())).resolves.toBe(
      undefined,
    );
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('fails with a retryable typed error when semantic readback drifts', async () => {
    const post = jest.fn().mockResolvedValue(tokenResponse());
    const put = jest.fn().mockResolvedValue({ data: { code: 0 } });
    const get = jest.fn().mockResolvedValue({
      data: {
        code: 0,
        data: {
          record: {
            record_id: 'rec_outbound_1',
            fields: {
              ...pendingReadbackFields(),
              出库当前审批人: [{ id: 'ou_different_approver' }],
            },
          },
        },
      },
    });
    const gateway = makeGateway({ post, put, get });

    const error = await gateway
      .writePendingApproval(snapshot())
      .then(() => null)
      .catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(
      InventoryOutboundApprovalSyncUnconfirmedException,
    );
    expect(error).toMatchObject({ retryable: true });
    expect(String((error as Error).message)).toContain('出库当前审批人');
    expect(String((error as Error).message)).toContain('可安全重试');
  });

  it('reports Feishu business errors and HTTP timeout readback failures without pretending success', async () => {
    const businessPost = jest.fn().mockResolvedValue(tokenResponse());
    const businessPut = jest
      .fn()
      .mockResolvedValue({ data: { code: 1254607, msg: '字段类型错误' } });
    const businessGet = jest.fn().mockResolvedValue({
      data: {
        code: 0,
        data: {
          record: {
            record_id: 'rec_outbound_1',
            fields: {
              ...pendingReadbackFields(),
              出库工作流状态: '待路由',
            },
          },
        },
      },
    });
    const businessGateway = makeGateway({
      post: businessPost,
      put: businessPut,
      get: businessGet,
    });

    await expect(
      businessGateway.writePendingApproval(snapshot()),
    ).rejects.toThrow(/1254607|字段类型错误/u);

    const timeoutPost = jest.fn().mockResolvedValue(tokenResponse());
    const timeoutPut = jest
      .fn()
      .mockRejectedValue(
        Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }),
      );
    const timeoutGet = jest
      .fn()
      .mockRejectedValue(
        Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }),
      );
    const timeoutGateway = makeGateway({
      post: timeoutPost,
      put: timeoutPut,
      get: timeoutGet,
    });

    await expect(
      timeoutGateway.writePendingApproval(snapshot()),
    ).rejects.toThrow(/回读失败.*可安全重试/u);
  });

  it('surfaces Feishu message HTTP and business failures with safe diagnostic details', async () => {
    const httpError = Object.assign(new Error('Request failed'), {
      isAxiosError: true,
      response: {
        status: 400,
        data: { code: 230099, msg: 'interactive card invalid' },
      },
    });
    const post = jest
      .fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockRejectedValueOnce(httpError);
    const gateway = makeGateway({ post });

    await expect(
      gateway.sendInteractiveCard(
        'ou_inventory_approver',
        { schema: '2.0' },
        '0f45ce5d-09d3-4c8e-a10a-a4df94fb17f7',
      ),
    ).rejects.toThrow(/HTTP 400.*230099.*interactive card invalid/u);
  });
});

function makeGateway(
  axiosRef: Record<string, jest.Mock>,
): InventoryOutboundApprovalGateway {
  return new InventoryOutboundApprovalGateway({
    axiosRef,
  } as unknown as HttpService);
}

function tokenResponse() {
  return {
    data: {
      code: 0,
      tenant_access_token: 'tenant-access-token',
      expire: 7200,
    },
  };
}

function snapshot(
  overrides: Partial<InventoryOutboundApprovalSnapshot> = {},
): InventoryOutboundApprovalSnapshot {
  return {
    recordId: 'rec_outbound_1',
    outboundNumber: 'CK260826-001',
    version: 1,
    policyVersion: 'inventory-outbound-v1',
    applicantOpenId: 'ou_inventory_applicant',
    applicantName: '出库申请人',
    itemName: '地磅秤',
    sku: 'B1056',
    specification: '0.6×0.8米1吨',
    brand: '正峰',
    quantity: 1,
    unit: '台',
    availableStock: 1,
    building: 'H楼',
    location: 'H-2F-226储存间01-0F',
    reason: '项目现场领用',
    appliedAt: '2026-08-26T08:00:00.000Z',
    approvers: [
      { openId: 'ou_inventory_approver_1', name: '审批人一' },
      { openId: 'ou_inventory_approver_2', name: '审批人二' },
    ],
    ...overrides,
  };
}

function approvedDecision(): InventoryOutboundApprovalDecision {
  return {
    action: 'approve',
    actorOpenId: 'ou_inventory_approver_1',
    actorName: '审批人一',
    messageId: 'om_outbound_approval_1',
    eventId: 'ws_inventory_outbound_event_1',
    decidedAt: '2026-08-26T08:05:06.789Z',
    reason: '',
  };
}

function serializedSnapshot(value: InventoryOutboundApprovalSnapshot): string {
  return JSON.stringify({ schemaVersion: 1, snapshot: value });
}

function recordResponse(recordId: string, fields: Record<string, unknown>) {
  return {
    data: {
      code: 0,
      data: { record: { record_id: recordId, fields } },
    },
  };
}

function reroutedReadbackFields(
  replacement: InventoryOutboundApprovalSnapshot,
): Record<string, unknown> {
  return {
    程序出库状态: '待审批',
    出库工作流状态: '待审批',
    出库当前审批人: replacement.approvers.map((approver) => ({
      id: approver.openId,
    })),
    出库实际审批人: [],
    出库审批时间: null,
    出库审批策略版本: replacement.policyVersion,
    出库驳回原因: '',
    出库审批动作标识: '',
    出库工作流错误: '',
    出库审批快照: serializedSnapshot(replacement),
    出库审批投递台账: '',
    出库审批收尾状态: null,
    出库审批结果投递台账: '',
    出库确认标识: '',
  };
}

function pendingReadbackFields(): Record<string, unknown> {
  return {
    程序出库状态: '待审批',
    出库工作流状态: '待审批',
    出库当前审批人: [
      { id: 'ou_inventory_approver_2' },
      { open_id: 'ou_inventory_approver_1' },
    ],
    出库审批策略版本: 'inventory-outbound-v1',
    出库工作流错误: '',
    出库审批快照: JSON.stringify({
      schemaVersion: 1,
      snapshot: snapshot(),
    }),
  };
}

function pendingDecisionPreReadResponse(recordId: string) {
  return {
    data: {
      code: 0,
      data: {
        record: {
          record_id: recordId,
          fields: {
            程序出库状态: '待审批',
            出库工作流状态: '待审批',
          },
        },
      },
    },
  };
}

function rejectedReadbackFields(
  input: InventoryOutboundApprovalSnapshot,
  decision: InventoryOutboundApprovalDecision,
  reason: string,
): Record<string, unknown> {
  return {
    程序出库状态: '已驳回',
    出库工作流状态: '已驳回',
    出库当前审批人: [],
    出库实际审批人: [{ id: decision.actorOpenId }],
    出库审批时间: Date.parse(decision.decidedAt),
    出库审批策略版本: input.policyVersion,
    出库审批动作标识: decision.eventId,
    出库驳回原因: reason,
    出库工作流错误: '',
    出库审批收尾状态: '待收尾',
  };
}

const RECOVERABLE_WORKFLOW_STATUSES = ['待路由', '待审批', '同步异常'] as const;

const OUTBOUND_RECOVERY_FIELD_NAMES = [
  '物品类别号',
  '物品申请人',
  '楼栋',
  '出库原因/出库后使用地点',
  '程序出库状态',
  '程序出库申请数量',
  '程序出库申请时间',
  '出库数量',
  '出库时间',
  '出库创建标识',
  '出库请求指纹',
  '出库工作流状态',
  '出库当前审批人',
  '出库实际审批人',
  '出库审批时间',
  '出库审批策略版本',
  '出库驳回原因',
  '出库审批动作标识',
  '出库工作流错误',
  '出库审批快照',
  '出库审批投递台账',
  '出库审批收尾状态',
  '出库审批结果投递台账',
] as const;

function recoveryRecord(
  recordId: string,
  status: unknown,
  fields: Record<string, unknown> = {},
) {
  return {
    record_id: recordId,
    fields: { 出库工作流状态: status, ...fields },
  };
}
