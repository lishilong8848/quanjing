jest.mock('../../server/common/access/access-configuration.store', () => ({
  getAccessConfigurationStore: () => ({
    read: () => ({ schemaVersion: 1, revision: 0, legacySessionsRevoked: false, accounts: {}, cardRules: {}, audit: [], mutations: {} }),
  }),
}));

jest.mock('../../server/common/config/external-services.config', () => {
  const actual = jest.requireActual(
    '../../server/common/config/external-services.config',
  );
  return {
    ...actual,
    getFeishuAuthPayload: jest.fn(() => ({
      app_id: 'test-app',
      app_secret: 'test-secret',
    })),
    parseFeishuBitableLink: jest.fn(() => ({
      appToken: '',
      wikiToken: '',
      tableId: '',
      viewId: '',
    })),
    readEnv: jest.fn((name: string) => process.env[name] || ''),
  };
});

jest.mock(
  '@server/common/config/external-services.config',
  () => ({
    assertBitableTableConfig: jest.fn(),
    getFeishuAuthPayload: jest.fn(() => ({
      app_id: 'test-app',
      app_secret: 'test-secret',
    })),
    parseFeishuBitableLink: jest.fn(() => ({
      appToken: '',
      wikiToken: '',
      tableId: '',
      viewId: '',
    })),
    readEnv: jest.fn((name: string) => process.env[name] || ''),
  }),
  { virtual: true },
);

jest.mock('../../server/common/feishu/bitable-direct-read', () => {
  const actual = jest.requireActual(
    '../../server/common/feishu/bitable-direct-read',
  );
  return {
    ...actual,
    resolveBitableAppToken: jest.fn(),
  };
});

import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseFeishuBitableLink } from '../../server/common/config/external-services.config';
import { resolveBitableAppToken } from '../../server/common/feishu/bitable-direct-read';
import {
  InboundResponsibleUsersNotConfiguredException,
  mapExecutionRecord,
  PurchaseWorkflowGateway,
} from '../../server/modules/purchase-inventory/purchase-workflow.gateway';

const originalEnv = { ...process.env };

describe('PurchaseWorkflowGateway', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(parseFeishuBitableLink).mockReturnValue({
      appToken: '',
      wikiToken: '',
      tableId: '',
      viewId: '',
    });
    jest.mocked(resolveBitableAppToken).mockResolvedValue('');
    process.env = {
      ...originalEnv,
      FEISHU_PURCHASE_INVENTORY_APP_TOKEN: 'app_purchase',
      FEISHU_PURCHASE_SUBMISSION_TABLE_ID: 'tbl_submission',
      FEISHU_PURCHASE_EXECUTION_TABLE_ID: 'tbl_execution',
      FEISHU_PURCHASE_ORGANIZATION_TABLE_ID: 'tbl_org',
      PURCHASE_WORKFLOW_APPROVER_OPEN_IDS: '',
      PURCHASE_WORKFLOW_PURCHASE_ADMIN_OPEN_ID: '',
      PURCHASE_MANAGER_APPROVER_OPEN_ID: '',
      PURCHASE_MANAGER_APPROVER_NAME: '',
      FEISHU_WAREHOUSE_MANAGER_SOURCE_URL: '',
      FEISHU_WAREHOUSE_MANAGER_APP_TOKEN: '',
      FEISHU_WAREHOUSE_MANAGER_WIKI_TOKEN: '',
      FEISHU_WAREHOUSE_MANAGER_TABLE_ID: '',
      FEISHU_WAREHOUSE_MANAGER_VIEW_ID: '',
      FEISHU_WAREHOUSE_SOURCE_URL: '',
      FEISHU_WAREHOUSE_APP_TOKEN: '',
      FEISHU_WAREHOUSE_RECIPIENT_CACHE_PATH: '',
    };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('updates execution records with the current user access token', async () => {
    const axiosRef = {
      put: jest.fn().mockResolvedValue({ data: { code: 0, data: {} } }),
    };
    const gateway = new PurchaseWorkflowGateway({ axiosRef } as never);

    await gateway.updateExecutionRecord(
      'rec_execution_1',
      { 采购流程: '审批通过（待下单）' },
      'u-user-token',
    );

    expect(axiosRef.put).toHaveBeenCalledWith(
      'https://open.feishu.cn/open-apis/bitable/v1/apps/app_purchase/tables/tbl_execution/records/rec_execution_1',
      { fields: { 采购流程: '审批通过（待下单）' } },
      expect.objectContaining({
        headers: { Authorization: 'Bearer u-user-token' },
        timeout: 30_000,
      }),
    );
  });

  it('resolves the logical receipt attachment field to the unique Base attachment column', async () => {
    const axiosRef = {
      get: jest.fn().mockResolvedValue({
        data: {
          code: 0,
          data: {
            items: [
              {
                field_id: 'fld_receipt_attachment',
                field_name:
                  '签收附件（自采必须填完！综合采购可不填发票附件！）',
                type: 17,
              },
            ],
            has_more: false,
          },
        },
      }),
      put: jest.fn().mockResolvedValue({ data: { code: 0, data: {} } }),
    };
    const gateway = new PurchaseWorkflowGateway({ axiosRef } as never);

    await gateway.updateExecutionRecord(
      'rec_execution_1',
      { 签收附件: [{ file_token: 'file_photo' }] },
      'u-user-token',
    );

    expect(axiosRef.get).toHaveBeenCalledWith(
      'https://open.feishu.cn/open-apis/bitable/v1/apps/app_purchase/tables/tbl_execution/fields',
      expect.objectContaining({
        headers: { Authorization: 'Bearer u-user-token' },
        params: expect.objectContaining({ page_size: 200 }),
      }),
    );
    expect(axiosRef.put).toHaveBeenCalledWith(
      expect.stringContaining('/records/rec_execution_1'),
      {
        fields: {
          '签收附件（自采必须填完！综合采购可不填发票附件！）': [
            { file_token: 'file_photo' },
          ],
        },
      },
      expect.any(Object),
    );
  });

  it('fails closed when receipt attachment prefix is ambiguous', async () => {
    const axiosRef = {
      get: jest.fn().mockResolvedValue({
        data: {
          code: 0,
          data: {
            items: [
              { field_name: '签收附件（旧）', type: 17 },
              { field_name: '签收附件（新）', type: 17 },
            ],
            has_more: false,
          },
        },
      }),
      put: jest.fn(),
    };
    const gateway = new PurchaseWorkflowGateway({ axiosRef } as never);

    await expect(
      gateway.updateExecutionRecord(
        'rec_execution_1',
        { 签收附件: [{ file_token: 'file_photo' }] },
        'u-user-token',
      ),
    ).rejects.toThrow('签收附件字段不唯一');
    expect(axiosRef.put).not.toHaveBeenCalled();
  });

  it('uses a bounded network budget for manager approval decision reads and writes', async () => {
    const axiosRef = {
      post: jest.fn().mockResolvedValue({
        data: { code: 0, tenant_access_token: 'tenant-token', expire: 7200 },
      }),
      get: jest.fn().mockResolvedValue({
        data: {
          code: 0,
          data: {
            record: {
              record_id: 'rec_manager_decision',
              fields: { 采购流程: '未开始（待审批）' },
            },
          },
        },
      }),
      put: jest.fn().mockResolvedValue({ data: { code: 0, data: {} } }),
    };
    const gateway = new PurchaseWorkflowGateway({
      axiosRef,
    } as never) as PurchaseWorkflowGateway & {
      getManagerApprovalDecisionRecordAsApp(recordId: string): Promise<unknown>;
      updateManagerApprovalDecisionRecordAsApp(
        recordId: string,
        fields: Record<string, unknown>,
      ): Promise<void>;
    };

    await gateway.getManagerApprovalDecisionRecordAsApp('rec_manager_decision');
    await gateway.updateManagerApprovalDecisionRecordAsApp(
      'rec_manager_decision',
      { 采购流程: '审批通过（待下单）' },
    );

    expect(axiosRef.get).toHaveBeenCalledWith(
      expect.stringContaining('/records/rec_manager_decision'),
      expect.objectContaining({ timeout: 8_000 }),
    );
    expect(axiosRef.put).toHaveBeenCalledWith(
      expect.stringContaining('/records/rec_manager_decision'),
      { fields: { 采购流程: '审批通过（待下单）' } },
      expect.objectContaining({ timeout: 8_000 }),
    );
  });

  it.each([
    ['missing code', { data: {} }],
    ['string payload', 'success'],
    ['null payload', null],
    ['array payload', []],
    ['string zero code', { code: '0' }],
  ])('rejects a malformed 2xx Feishu response: %s', async (_label, payload) => {
    const axiosRef = {
      put: jest.fn().mockResolvedValue({ data: payload }),
    };
    const gateway = new PurchaseWorkflowGateway({ axiosRef } as never);

    await expect(
      gateway.updateExecutionRecord(
        'rec_execution_1',
        { 采购流程: '审批通过（待下单）' },
        'u-user-token',
      ),
    ).rejects.toBeInstanceOf(BadGatewayException);
  });

  it('maps execution fields and organization roles without hard-coded people', async () => {
    const axiosRef = {
      get: jest
        .fn()
        .mockResolvedValueOnce({
          data: {
            code: 0,
            data: {
              record: {
                record_id: 'rec_execution_1',
                created_time: 1784246400000,
                fields: {
                  采购流程: '审批通过（待下单）',
                  采购编码: 'CG-001',
                  物品名称: '接触器',
                  申请楼栋: ['H楼'],
                  需求人: [{ id: 'ou_requester', name: '需求人' }],
                  采购人: [{ id: 'ou_buyer', name: '采购员' }],
                  '1️⃣物品采购方式': '综合采购',
                  申请数量: 3,
                  计数单位: '件',
                  单价: 12.5,
                  '付款截屏（显示付款金额）': [
                    { file_token: 'file_payment_1' },
                  ],
                  签收人: [{ id: 'ou_signer', name: '签收人' }],
                  库房确认: true,
                },
              },
            },
          },
        })
        .mockResolvedValueOnce({
          data: {
            code: 0,
            data: {
              items: [
                {
                  record_id: 'rec_org_1',
                  fields: {
                    示例人员001: [{ id: 'ou_manager', name: '经理' }],
                    职位: '设施运维经理',
                    '楼栋/专业': ['H楼'],
                  },
                },
              ],
              has_more: false,
            },
          },
        }),
    };
    const gateway = new PurchaseWorkflowGateway({ axiosRef } as never);

    await expect(
      gateway.getExecutionRecord('rec_execution_1', 'u-token'),
    ).resolves.toMatchObject({
      recordId: 'rec_execution_1',
      status: '审批通过（待下单）',
      requesterOpenId: 'ou_requester',
      purchaserOpenId: 'ou_buyer',
      requestedQuantity: 3,
      unit: '件',
      unitPrice: 12.5,
      createdAt: 1784246400000,
      paymentAttachmentTokens: ['file_payment_1'],
      signerOpenId: 'ou_signer',
      warehouseConfirmed: true,
    });
    await expect(gateway.resolveUser('ou_manager', 'u-token')).resolves.toEqual(
      {
        openId: 'ou_manager',
        name: '经理',
        positions: ['设施运维经理'],
        buildings: ['H楼'],
      },
    );
  });

  it.each([
    ['是', '三方比价', ''],
    ['否', '单一采购', '原厂授权渠道，只能单一采购'],
  ] as const)(
    'maps procurement form %s and manager-card reasons from the execution record',
    (comparisonSatisfied, procurementForm, singleReason) => {
      const mapped = mapExecutionRecord({
        record_id: 'rec_execution_procurement',
        fields: {
          采购流程: '未开始（待审批）',
          '1️⃣物品采购方式': '综合采购',
          '是否满足三家比价（线下）': comparisonSatisfied,
          单一原因:
            comparisonSatisfied === '否'
              ? [{ text: `  ${singleReason}  ` }]
              : `  ${singleReason}  `,
          驳回原因: { value: '  预算不足，信息不完整  ' },
        },
      });

      expect(mapped).toMatchObject({
        procurementForm,
        singleReason,
        rejectionReason: '  预算不足，信息不完整  ',
      });
    },
  );

  it('preserves leading and trailing spaces in a direct rejection-reason string', () => {
    const mapped = mapExecutionRecord({
      record_id: 'rec_execution_rejected',
      fields: {
        采购流程: '驳回申请',
        '1️⃣物品采购方式': '驳回',
        驳回原因: ' 预算不足 ',
      },
    });

    expect(mapped.rejectionReason).toBe(' 预算不足 ');
  });

  it('maps the unified receipt attachment field before legacy columns', () => {
    expect(
      mapExecutionRecord({
        record_id: 'rec_receipt_attachment',
        fields: {
          '签收附件（自采必须填完！综合采购可不填发票附件！）': [
            { file_token: 'file_photo' },
            { file_token: 'file_invoice' },
          ],
          签收照片: [{ file_token: 'legacy_photo' }],
          发票附件: [{ file_token: 'legacy_invoice' }],
        },
      }),
    ).toMatchObject({
      receiptPhotoTokens: ['file_photo', 'file_invoice'],
      invoiceTokens: [],
    });
  });

  it('falls back across requester person-field aliases when an earlier field is empty', () => {
    expect(
      mapExecutionRecord({
        record_id: 'rec_requester_alias',
        fields: {
          需求人: [],
          业务申请人: [],
          申请人: [{ id: 'ou_requester_alias', name: '申请人' }],
        },
      }),
    ).toMatchObject({
      requesterOpenId: 'ou_requester_alias',
      requesterName: '申请人',
    });
  });

  it('rejects conflicting requester person-field aliases', () => {
    expect(() =>
      mapExecutionRecord({
        record_id: 'rec_requester_conflict',
        fields: {
          需求人: [{ id: 'ou_requester_a', name: '申请人甲' }],
          申请人: [{ id: 'ou_requester_b', name: '申请人乙' }],
        },
      }),
    ).toThrow('采购申请人字段冲突');
  });

  it('maps and sanitizes up to three online purchase links', () => {
    const mapped = mapExecutionRecord({
      record_id: 'rec_execution_links',
      fields: {
        采购流程: '未开始（待审批）',
        '1️⃣物品采购方式': '综合采购',
        '线上链接（仅线上需填写）': {
          link: ' https://item.jd.com/100000000001.html ',
          text: '京东商品',
        },
        线上链接2: [
          { url: 'https://detail.tmall.com/item.htm?id=123456' },
          { url: 'https://item.jd.com/100000000001.html' },
        ],
        线上链接3: 'http://example.com/not-allowed',
      },
    });

    expect(mapped.purchaseLinks).toEqual([
      'https://item.jd.com/100000000001.html',
      'https://detail.tmall.com/item.htm?id=123456',
    ]);
  });

  it('falls back to program completion fields and the H-building legacy field', () => {
    const byProgramStatus = mapExecutionRecord({
      record_id: 'rec_program_status',
      fields: {
        程序采购状态: '物品签收已入库',
        '申请楼栋（多楼请选H楼，备注里填写详情）': 'H楼',
      },
    });
    const byInboundCheckbox = mapExecutionRecord({
      record_id: 'rec_inbound_checkbox',
      fields: { 采购流程: '到货已签收（待入库）', 是否已入库: true },
    });

    expect(byProgramStatus).toMatchObject({
      status: '物品签收已入库',
      building: 'H楼',
    });
    expect(byInboundCheckbox.status).toBe('采购完成（已入库）');
  });

  it('resolves manager display metadata by the configured open id', async () => {
    process.env.PURCHASE_MANAGER_APPROVER_OPEN_ID = 'ou_manager_01';
    process.env.PURCHASE_MANAGER_APPROVER_NAME = '示例人员020';
    const axiosRef = {
      post: jest.fn().mockResolvedValue({
        data: { code: 0, tenant_access_token: 'tenant-token', expire: 7200 },
      }),
      get: jest.fn().mockResolvedValue({
        data: {
          code: 0,
          data: {
            items: [
              {
                record_id: 'rec_org_manager',
                fields: {
                  示例人员001: [{ id: 'ou_manager_01', name: '马经理' }],
                  职位: '设施运维经理',
                  '楼栋/专业': ['H楼'],
                },
              },
            ],
            has_more: false,
          },
        },
      }),
    };
    const gateway = new PurchaseWorkflowGateway({ axiosRef } as never);

    await expect(
      gateway.resolvePurchaseManagerApproverAsApp(),
    ).resolves.toEqual({
      openId: 'ou_manager_01',
      name: '马经理',
      positions: ['设施运维经理'],
      buildings: ['H楼'],
    });
  });

  it('reads one execution record with the application tenant token', async () => {
    const axiosRef = {
      post: jest
        .fn()
        .mockResolvedValueOnce({
          data: { code: 0, tenant_access_token: 'tenant-token', expire: 7200 },
        })
        .mockResolvedValueOnce({
          data: {
            code: 0,
            data: {
              records: [
                {
                  record_id: 'rec_execution_app',
                  created_time: 1784246400000,
                  fields: {
                    采购流程: '未开始（待审批）',
                    采购编码: 'CG-APP-1',
                    需求人: [{ id: 'ou_requester', name: '需求人' }],
                    '1️⃣物品采购方式': '综合采购',
                  },
                },
              ],
            },
          },
        }),
    };
    const gateway = new PurchaseWorkflowGateway({ axiosRef } as never);

    await expect(
      gateway.getExecutionRecordAsApp('rec_execution_app'),
    ).resolves.toMatchObject({
      recordId: 'rec_execution_app',
      requestCode: 'CG-APP-1',
      createdAt: 1784246400000,
    });
    expect(axiosRef.post).toHaveBeenLastCalledWith(
      expect.stringContaining('/records/batch_get'),
      { record_ids: ['rec_execution_app'] },
      expect.objectContaining({
        headers: { Authorization: 'Bearer tenant-token' },
      }),
    );
  });

  it.each([
    [{ absent_record_ids: ['rec_missing'], records: [] }, /不存在/],
    [{ forbidden_record_ids: ['rec_missing'], records: [] }, /无权/],
    [{ records: [{ record_id: 'rec_other', fields: {} }] }, /唯一目标记录/],
  ] as const)(
    'rejects an absent, forbidden or mismatched application record',
    async (data, message) => {
      const axiosRef = {
        post: jest
          .fn()
          .mockResolvedValueOnce({
            data: {
              code: 0,
              tenant_access_token: 'tenant-token',
              expire: 7200,
            },
          })
          .mockResolvedValueOnce({ data: { code: 0, data } }),
      };
      const gateway = new PurchaseWorkflowGateway({ axiosRef } as never);

      await expect(
        gateway.getExecutionRecordAsApp('rec_missing'),
      ).rejects.toThrow(message);
    },
  );

  it('automatically creates missing purchase program approval fields once', async () => {
    const axiosRef = {
      get: jest.fn().mockResolvedValue({
        data: {
          code: 0,
          data: {
            items: [{ field_name: '采购审批来源', type: 3 }],
          },
        },
      }),
      post: jest
        .fn()
        .mockResolvedValueOnce({
          data: { code: 0, tenant_access_token: 'tenant-token', expire: 7200 },
        })
        .mockResolvedValue({ data: { code: 0, data: {} } }),
    };
    const gateway = new PurchaseWorkflowGateway({ axiosRef } as never);

    await Promise.all([
      gateway.ensureManagerApprovalFieldsAsApp(),
      gateway.ensureManagerApprovalFieldsAsApp(),
    ]);
    await gateway.ensureManagerApprovalFieldsAsApp();

    expect(axiosRef.get).toHaveBeenCalledTimes(1);
    const createdFieldNames = axiosRef.post.mock.calls
      .filter(([url]) => String(url).endsWith('/fields'))
      .map(([, body]) => body.field_name);
    expect(createdFieldNames).toEqual([
      '采购工作流状态',
      '采购当前审批人',
      '采购实际审批人',
      '采购审批时间',
      '采购审批策略版本',
      '采购审批批次号',
      '采购审批动作标识',
      '采购工作流错误',
      '采购卡片投递状态',
      '采购卡片投递时间',
      '采购卡片消息标识',
      '采购卡片投递标识',
      '采购卡片投递次数',
      '采购卡片最后投递时间',
      '采购签收卡片批次号',
      '采购签收卡片投递状态',
      '采购签收卡片投递时间',
      '采购签收卡片消息标识',
      '采购签收卡片投递标识',
      '采购签收卡片投递次数',
      '采购签收卡片最后投递时间',
      '采购签收卡片投递错误',
    ]);
  });

  it('maps purchase program approval routing fields', () => {
    expect(
      mapExecutionRecord({
        record_id: 'rec_program_approval',
        fields: {
          采购审批来源: '程序卡片',
          采购工作流状态: '待经理审批',
          采购审批策略版本: 'purchase-manager-card-v1',
          采购审批批次号: 'purchase-base-12345678',
          采购审批动作标识: 'evt-1',
          采购工作流错误: '',
          采购卡片投递状态: '已送达',
          采购卡片投递时间: 1789005600000,
          采购卡片消息标识: 'om_manager_batch',
          采购卡片投递标识: 'delivery-uuid-1',
          采购卡片投递次数: 2,
          采购卡片最后投递时间: 1789005590000,
          采购签收卡片批次号: 'purchase-receipt-batch-1',
          采购签收卡片投递状态: '已送达',
          采购签收卡片投递时间: 1789005700000,
          采购签收卡片消息标识: 'om_receipt_batch',
          采购签收卡片投递标识: 'receipt-delivery-uuid-1',
          采购签收卡片投递次数: 1,
          采购签收卡片最后投递时间: 1789005690000,
          采购签收卡片投递错误: '',
        },
      }),
    ).toMatchObject({
      approvalSource: '程序卡片',
      approvalWorkflowStatus: '待经理审批',
      approvalPolicyVersion: 'purchase-manager-card-v1',
      approvalBatchId: 'purchase-base-12345678',
      approvalActionId: 'evt-1',
      approvalWorkflowError: '',
      approvalCardDeliveryStatus: '已送达',
      approvalCardDeliveredAt: 1789005600000,
      approvalCardMessageId: 'om_manager_batch',
      approvalCardDeliveryUuid: 'delivery-uuid-1',
      approvalCardDeliveryAttempts: 2,
      approvalCardLastAttemptAt: 1789005590000,
      receiptCardBatchId: 'purchase-receipt-batch-1',
      receiptCardDeliveryStatus: '已送达',
      receiptCardDeliveredAt: 1789005700000,
      receiptCardMessageId: 'om_receipt_batch',
      receiptCardDeliveryUuid: 'receipt-delivery-uuid-1',
      receiptCardDeliveryAttempts: 1,
      receiptCardLastAttemptAt: 1789005690000,
      receiptCardDeliveryError: '',
    });
  });

  it('keeps valid receipt recovery rows when another row cannot be mapped', async () => {
    const axiosRef = {
      post: jest.fn().mockResolvedValue({
        data: { code: 0, tenant_access_token: 'tenant-token', expire: 7200 },
      }),
      get: jest.fn().mockResolvedValue({
        data: {
          code: 0,
          data: {
            has_more: false,
            items: [
              {
                record_id: 'rec_valid_recovery',
                fields: {
                  采购编码: 'CG-RECOVERY-1',
                  采购流程: '下单完成（待签收）',
                  需求人: [{ id: 'ou_requester', name: '申请人' }],
                },
              },
              {
                record_id: 'rec_invalid_recovery',
                fields: {
                  采购编码: 'CG-RECOVERY-2',
                  采购流程: '下单完成（待签收）',
                  需求人: [{ id: 'ou_requester_a', name: '申请人甲' }],
                  申请人: [{ id: 'ou_requester_b', name: '申请人乙' }],
                },
              },
              {
                fields: {
                  采购编码: 'CG-RECOVERY-3',
                  采购流程: '下单完成（待签收）',
                  需求人: [{ id: 'ou_requester_c', name: '申请人丙' }],
                },
              },
            ],
          },
        },
      }),
    };
    const gateway = new PurchaseWorkflowGateway({ axiosRef } as never);

    await expect(
      gateway.listExecutionRecordsForRecoveryAsApp(
        'CurrentValue.[采购流程]="下单完成（待签收）"',
      ),
    ).resolves.toEqual({
      records: [
        expect.objectContaining({
          recordId: 'rec_valid_recovery',
          requesterOpenId: 'ou_requester',
        }),
      ],
      errors: [
        expect.objectContaining({ recordId: 'rec_invalid_recovery' }),
        {
          recordId: 'unknown',
          message: '采购执行记录缺少 record_id',
        },
      ],
    });
  });

  it('retries a transient data-not-ready response when reading one execution record', async () => {
    jest.useFakeTimers();
    const axiosRef = {
      get: jest
        .fn()
        .mockResolvedValueOnce({
          data: { code: 1254607, msg: 'Fail' },
        })
        .mockResolvedValueOnce({
          data: {
            code: 0,
            data: {
              record: {
                record_id: 'rec_execution_retry',
                fields: {
                  采购流程: '审批通过（待下单）',
                  采购编码: 'CG-RETRY-1',
                  '1️⃣物品采购方式': '综合采购',
                },
              },
            },
          },
        }),
    };
    const gateway = new PurchaseWorkflowGateway({ axiosRef } as never);

    try {
      const operation = gateway.getExecutionRecord(
        'rec_execution_retry',
        'u-user-token',
      );
      const assertion = expect(operation).resolves.toMatchObject({
        recordId: 'rec_execution_retry',
        requestCode: 'CG-RETRY-1',
      });

      await jest.advanceTimersByTimeAsync(250);
      await assertion;
      expect(axiosRef.get).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('retries a rejected transient data-not-ready response', async () => {
    jest.useFakeTimers();
    const axiosRef = {
      get: jest
        .fn()
        .mockRejectedValueOnce({
          response: { data: { code: 1254607, msg: 'Fail' } },
        })
        .mockResolvedValueOnce({
          data: {
            code: 0,
            data: {
              record: {
                record_id: 'rec_execution_rejected_retry',
                fields: {
                  采购流程: '审批通过（待下单）',
                  采购编码: 'CG-RETRY-2',
                  '1️⃣物品采购方式': '综合采购',
                },
              },
            },
          },
        }),
    };
    const gateway = new PurchaseWorkflowGateway({ axiosRef } as never);

    try {
      const operation = gateway.getExecutionRecord(
        'rec_execution_rejected_retry',
        'u-user-token',
      );
      const assertion = expect(operation).resolves.toMatchObject({
        recordId: 'rec_execution_rejected_retry',
        requestCode: 'CG-RETRY-2',
      });

      await jest.advanceTimersByTimeAsync(250);
      await assertion;
      expect(axiosRef.get).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it.each([
    [
      'HTTP 503',
      {
        code: 'ERR_BAD_RESPONSE',
        response: { status: 503, data: { msg: 'service unavailable' } },
      },
    ],
    ['ECONNREFUSED', { code: 'ECONNREFUSED' }],
  ])(
    'retries a rejected transient %s execution-record read',
    async (_label, error) => {
      jest.useFakeTimers();
      const axiosRef = {
        get: jest
          .fn()
          .mockRejectedValueOnce(error)
          .mockResolvedValueOnce({
            data: {
              code: 0,
              data: {
                record: {
                  record_id: 'rec_execution_network_retry',
                  fields: {
                    采购流程: '审批通过（待下单）',
                    采购编码: 'CG-NETWORK-RETRY',
                    '1️⃣物品采购方式': '综合采购',
                  },
                },
              },
            },
          }),
      };
      const gateway = new PurchaseWorkflowGateway({ axiosRef } as never);

      try {
        const operation = gateway.getExecutionRecord(
          'rec_execution_network_retry',
          'u-user-token',
        );
        const assertion = expect(operation).resolves.toMatchObject({
          recordId: 'rec_execution_network_retry',
        });

        await jest.advanceTimersByTimeAsync(250);
        await assertion;
        expect(axiosRef.get).toHaveBeenCalledTimes(2);
      } finally {
        jest.useRealTimers();
      }
    },
  );

  it('normalizes an exhausted HTTP 503 execution-record read to 502', async () => {
    jest.useFakeTimers();
    const axiosRef = {
      get: jest.fn().mockRejectedValue({
        code: 'ERR_BAD_RESPONSE',
        response: { status: 503, data: { msg: 'service unavailable' } },
      }),
    };
    const gateway = new PurchaseWorkflowGateway({ axiosRef } as never);

    try {
      const outcome = gateway
        .getExecutionRecord('rec_execution_http_503', 'u-user-token')
        .catch((error: unknown) => error);

      await jest.advanceTimersByTimeAsync(30_000);
      const error = await outcome;

      expect(error).toBeInstanceOf(BadGatewayException);
      expect((error as Error).message).toContain('HTTP 503');
      expect(axiosRef.get.mock.calls.length).toBeGreaterThan(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('stops transient execution-record retries before the 30-second deadline', async () => {
    jest.useFakeTimers();
    const startedAt = Date.now();
    const requestTimes: number[] = [];
    const axiosRef = {
      get: jest.fn().mockImplementation(async () => {
        requestTimes.push(Date.now());
        return { data: { code: 1254607, msg: 'Fail' } };
      }),
    };
    const gateway = new PurchaseWorkflowGateway({ axiosRef } as never);

    try {
      const outcome = gateway
        .getExecutionRecord('rec_execution_timeout', 'u-user-token')
        .then(
          (value) => ({ value, error: null }),
          (error: unknown) => ({ value: null, error }),
        );

      await jest.advanceTimersByTimeAsync(30_000);
      const result = await outcome;

      expect(result.value).toBeNull();
      expect(result.error).toBeInstanceOf(BadGatewayException);
      expect((result.error as Error).message).toContain('1254607');
      expect(requestTimes.at(-1)).toBeLessThan(startedAt + 30_000);
    } finally {
      jest.useRealTimers();
    }
  });

  it('falls back to the configured manager name when organization metadata has no name', async () => {
    process.env.PURCHASE_MANAGER_APPROVER_OPEN_ID = 'ou_manager_01';
    process.env.PURCHASE_MANAGER_APPROVER_NAME = '';
    const axiosRef = {
      post: jest.fn().mockResolvedValue({
        data: { code: 0, tenant_access_token: 'tenant-token', expire: 7200 },
      }),
      get: jest.fn().mockResolvedValue({
        data: {
          code: 0,
          data: {
            items: [
              {
                record_id: 'rec_org_manager',
                fields: {
                  示例人员001: [{ id: 'ou_manager_01' }],
                  职位: '设施运维经理',
                },
              },
            ],
            has_more: false,
          },
        },
      }),
    };
    const gateway = new PurchaseWorkflowGateway({ axiosRef } as never);

    await expect(
      gateway.resolvePurchaseManagerApproverAsApp(),
    ).resolves.toEqual({
      openId: 'ou_manager_01',
      name: '示例人员020',
      positions: ['设施运维经理'],
      buildings: [],
    });
  });

  it('resolves configured approvers in config order and enriches known users', async () => {
    process.env.PURCHASE_WORKFLOW_APPROVER_OPEN_IDS =
      ' ou_approver1,ou_approver2,ou_approver1 ';
    const axiosRef = {
      post: jest.fn().mockResolvedValue({
        data: { code: 0, tenant_access_token: 'tenant-token', expire: 7200 },
      }),
      get: jest.fn().mockResolvedValue({
        data: {
          code: 0,
          data: {
            items: [
              {
                record_id: 'rec_org_1',
                fields: {
                  示例人员001: [{ id: 'ou_approver1', name: '审批人甲' }],
                  职位: ['采购审批人'],
                  '楼栋/专业': ['A楼'],
                },
              },
              {
                record_id: 'rec_org_2',
                fields: {
                  人员: [{ open_id: 'ou_approver1', name: '审批人甲' }],
                  职位: ['运营协调'],
                  '楼栋/专业': ['B栋'],
                },
              },
            ],
            has_more: false,
          },
        },
      }),
    };
    const gateway = new PurchaseWorkflowGateway({
      axiosRef,
    } as never) as PurchaseWorkflowGateway & {
      resolveConfiguredApproversAsApp(): Promise<
        Array<{
          openId: string;
          name: string;
          positions: string[];
          buildings: string[];
        }>
      >;
    };

    await expect(gateway.resolveConfiguredApproversAsApp()).resolves.toEqual([
      {
        openId: 'ou_approver1',
        name: '审批人甲',
        positions: ['采购审批人', '运营协调'],
        buildings: ['A楼', 'B栋'],
      },
      { openId: 'ou_approver2', name: '', positions: [], buildings: [] },
    ]);
    expect(axiosRef.get).toHaveBeenCalledWith(
      'https://open.feishu.cn/open-apis/bitable/v1/apps/app_purchase/tables/tbl_org/records',
      expect.objectContaining({
        headers: { Authorization: 'Bearer tenant-token' },
      }),
    );
  });

  it('rejects an empty configured approver list before reading organization data', async () => {
    const axiosRef = { post: jest.fn(), get: jest.fn() };
    const gateway = new PurchaseWorkflowGateway({ axiosRef } as never);

    await expect(
      gateway.resolveConfiguredApproversAsApp(),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(axiosRef.post).not.toHaveBeenCalled();
    expect(axiosRef.get).not.toHaveBeenCalled();
  });

  it('rejects a missing organization table before requesting an app token', async () => {
    process.env.PURCHASE_WORKFLOW_APPROVER_OPEN_IDS = 'ou_approver1';
    process.env.FEISHU_PURCHASE_ORGANIZATION_TABLE_ID = '';
    const axiosRef = {
      post: jest.fn().mockResolvedValue({
        data: { code: 0, tenant_access_token: 'tenant-token', expire: 7200 },
      }),
      get: jest.fn().mockResolvedValue({
        data: { code: 0, data: { items: [], has_more: false } },
      }),
    };
    const gateway = new PurchaseWorkflowGateway({ axiosRef } as never);

    await expect(
      gateway.resolveConfiguredApproversAsApp(),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(axiosRef.post).not.toHaveBeenCalled();
    expect(axiosRef.get).not.toHaveBeenCalled();
  });

  it('resolves the configured purchase admin and enriches organization fields', async () => {
    process.env.PURCHASE_WORKFLOW_PURCHASE_ADMIN_OPEN_ID = 'ou_admin1';
    const axiosRef = {
      post: jest.fn().mockResolvedValue({
        data: { code: 0, tenant_access_token: 'tenant-token', expire: 7200 },
      }),
      get: jest.fn().mockResolvedValue({
        data: {
          code: 0,
          data: {
            items: [
              {
                record_id: 'rec_unrelated_multi_person',
                fields: {
                  姓名: [
                    { openId: 'ou_unrelated_1', name: '刘小杏' },
                    { openId: 'ou_unrelated_2', name: '林柳' },
                  ],
                  职位: ['设施运维'],
                  '楼栋/专业': ['H楼'],
                },
              },
              {
                record_id: 'rec_org_admin',
                fields: {
                  姓名: [{ openId: 'ou_admin1', name: '曹李培' }],
                  职位: ['综合管理'],
                  '楼栋/专业': ['园区'],
                },
              },
            ],
            has_more: false,
          },
        },
      }),
    };
    const gateway = new PurchaseWorkflowGateway({
      axiosRef,
    } as never) as PurchaseWorkflowGateway & {
      resolvePurchaseAdminAsApp(): Promise<{
        openId: string;
        name: string;
        positions: string[];
        buildings: string[];
      }>;
    };

    await expect(gateway.resolvePurchaseAdminAsApp()).resolves.toEqual({
      openId: 'ou_admin1',
      name: '曹李培',
      positions: ['综合管理'],
      buildings: ['园区'],
    });
  });

  it('reuses one organization snapshot for comprehensive and building-self routing during the same day', async () => {
    process.env.PURCHASE_WORKFLOW_PURCHASE_ADMIN_OPEN_ID = 'ou_admin1';
    const axiosRef = {
      post: jest.fn().mockResolvedValue({
        data: { code: 0, tenant_access_token: 'tenant-token', expire: 7200 },
      }),
      get: jest.fn().mockResolvedValue({
        data: {
          code: 0,
          data: {
            items: [
              {
                record_id: 'rec_org_admin',
                fields: {
                  姓名: [{ openId: 'ou_admin1', name: '曹李培' }],
                  职位: ['综合管理'],
                  '楼栋/专业': ['综合'],
                },
              },
              {
                record_id: 'rec_org_supervisor',
                fields: {
                  姓名: [{ openId: 'ou_supervisor_a', name: 'A楼示例人员001' }],
                  职位: ['设施运维示例人员001'],
                  '楼栋/专业': ['A楼'],
                },
              },
            ],
            has_more: false,
          },
        },
      }),
    };
    const gateway = new PurchaseWorkflowGateway({ axiosRef } as never);

    await expect(gateway.resolvePurchaseAdminAsApp()).resolves.toMatchObject({
      openId: 'ou_admin1',
    });
    await expect(
      gateway.resolveBuildingSupervisorAsApp('A楼'),
    ).resolves.toMatchObject({ openId: 'ou_supervisor_a' });
    await expect(gateway.resolvePurchaseAdminAsApp()).resolves.toMatchObject({
      openId: 'ou_admin1',
    });

    expect(axiosRef.get).toHaveBeenCalledTimes(1);
  });

  it('refreshes the organization snapshot after the Shanghai calendar day changes', async () => {
    jest.useFakeTimers();
    try {
      process.env.PURCHASE_WORKFLOW_PURCHASE_ADMIN_OPEN_ID = 'ou_admin1';
      jest.setSystemTime(new Date('2026-09-21T15:59:00.000Z'));
      const axiosRef = {
        post: jest.fn().mockResolvedValue({
          data: { code: 0, tenant_access_token: 'tenant-token', expire: 7200 },
        }),
        get: jest.fn().mockResolvedValue({
          data: {
            code: 0,
            data: {
              items: [
                {
                  record_id: 'rec_org_admin',
                  fields: {
                    姓名: [{ openId: 'ou_admin1', name: '曹李培' }],
                    职位: ['综合管理'],
                    '楼栋/专业': ['综合'],
                  },
                },
              ],
              has_more: false,
            },
          },
        }),
      };
      const gateway = new PurchaseWorkflowGateway({ axiosRef } as never);

      await gateway.resolvePurchaseAdminAsApp();
      jest.setSystemTime(new Date('2026-09-21T16:01:00.000Z'));
      await gateway.resolvePurchaseAdminAsApp();

      expect(axiosRef.get).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it.each([
    ['missing from the organization Base', []],
    [
      'not assigned to comprehensive management',
      [
        {
          record_id: 'rec_wrong_role',
          fields: {
            姓名: [{ openId: 'ou_admin1', name: '曹李培' }],
            职位: ['采购管理'],
            '楼栋/专业': ['园区'],
          },
        },
      ],
    ],
  ])('rejects a configured purchase admin that is %s', async (_case, items) => {
    process.env.PURCHASE_WORKFLOW_PURCHASE_ADMIN_OPEN_ID = 'ou_admin1';
    const axiosRef = {
      post: jest.fn().mockResolvedValue({
        data: { code: 0, tenant_access_token: 'tenant-token', expire: 7200 },
      }),
      get: jest.fn().mockResolvedValue({
        data: { code: 0, data: { items, has_more: false } },
      }),
    };
    const gateway = new PurchaseWorkflowGateway({ axiosRef } as never);

    await expect(gateway.resolvePurchaseAdminAsApp()).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it.each(['', 'user_admin1', 'ou_bad.id'])(
    'rejects an invalid configured purchase admin open id: %j',
    async (openId) => {
      process.env.PURCHASE_WORKFLOW_PURCHASE_ADMIN_OPEN_ID = openId;
      const axiosRef = { post: jest.fn(), get: jest.fn() };
      const gateway = new PurchaseWorkflowGateway({ axiosRef } as never);

      await expect(gateway.resolvePurchaseAdminAsApp()).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      expect(axiosRef.post).not.toHaveBeenCalled();
      expect(axiosRef.get).not.toHaveBeenCalled();
    },
  );

  it('resolves the unique exact building supervisor and merges duplicate records', async () => {
    const axiosRef = {
      post: jest.fn().mockResolvedValue({
        data: { code: 0, tenant_access_token: 'tenant-token', expire: 7200 },
      }),
      get: jest.fn().mockResolvedValue({
        data: {
          code: 0,
          data: {
            items: [
              {
                record_id: 'rec_supervisor_1',
                fields: {
                  示例人员001: [{ id: 'ou_supervisor1', name: 'A楼示例人员001' }],
                  职位: ['设施运维示例人员001'],
                  '楼栋/专业': ['A栋'],
                },
              },
              {
                record_id: 'rec_supervisor_2',
                fields: {
                  人员: [{ id: 'ou_supervisor1', name: 'A楼示例人员001' }],
                  职位: ['安全协调'],
                  '楼栋/专业': ['A楼'],
                },
              },
              {
                record_id: 'rec_cross_building',
                fields: {
                  示例人员001: [{ id: 'ou_cross1', name: 'B楼示例人员001' }],
                  职位: ['楼栋示例人员001'],
                  '楼栋/专业': ['B楼'],
                },
              },
              {
                record_id: 'rec_imprecise_position',
                fields: {
                  示例人员001: [{ id: 'ou_imprecise1', name: '示例人员001助理' }],
                  职位: ['楼栋示例人员001助理'],
                  '楼栋/专业': ['A楼'],
                },
              },
              {
                record_id: 'rec_other_manager',
                fields: {
                  示例人员001: [{ id: 'ou_manager1', name: '运维示例人员001' }],
                  职位: ['设施运维示例人员001助理'],
                  '楼栋/专业': ['A楼'],
                },
              },
            ],
            has_more: false,
          },
        },
      }),
    };
    const gateway = new PurchaseWorkflowGateway({
      axiosRef,
    } as never) as PurchaseWorkflowGateway & {
      resolveBuildingSupervisorAsApp(building: string): Promise<{
        openId: string;
        name: string;
        positions: string[];
        buildings: string[];
      }>;
    };

    await expect(
      gateway.resolveBuildingSupervisorAsApp(' A '),
    ).resolves.toEqual({
      openId: 'ou_supervisor1',
      name: 'A楼示例人员001',
      positions: ['设施运维示例人员001', '安全协调'],
      buildings: ['A栋', 'A楼'],
    });
  });

  it('does not combine supervisor position and building from different organization records', async () => {
    const axiosRef = {
      post: jest.fn().mockResolvedValue({
        data: { code: 0, tenant_access_token: 'tenant-token', expire: 7200 },
      }),
      get: jest.fn().mockResolvedValue({
        data: {
          code: 0,
          data: {
            items: [
              {
                record_id: 'rec_b_supervisor',
                fields: {
                  示例人员001: [{ id: 'ou_supervisor1', name: '跨楼栋人员' }],
                  职位: ['楼栋示例人员001'],
                  '楼栋/专业': ['B楼'],
                },
              },
              {
                record_id: 'rec_a_safety',
                fields: {
                  示例人员001: [{ id: 'ou_supervisor1', name: '跨楼栋人员' }],
                  职位: ['安全协调'],
                  '楼栋/专业': ['A楼'],
                },
              },
            ],
            has_more: false,
          },
        },
      }),
    };
    const gateway = new PurchaseWorkflowGateway({ axiosRef } as never);

    await expect(
      gateway.resolveBuildingSupervisorAsApp('A楼'),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(
      gateway.resolveBuildingSupervisorAsApp('B栋'),
    ).resolves.toEqual(
      expect.objectContaining({
        openId: 'ou_supervisor1',
        name: '跨楼栋人员',
      }),
    );
  });

  it('skips an invalid outer user id and resolves a nested valid open id', async () => {
    const axiosRef = {
      post: jest.fn().mockResolvedValue({
        data: { code: 0, tenant_access_token: 'tenant-token', expire: 7200 },
      }),
      get: jest.fn().mockResolvedValue({
        data: {
          code: 0,
          data: {
            items: [
              {
                record_id: 'rec_nested_supervisor',
                fields: {
                  示例人员001: {
                    id: 'user_invalid',
                    value: {
                      open_id: 'ou_nested-user_1',
                      name: '嵌套示例人员001',
                    },
                  },
                  职位: ['楼栋示例人员001'],
                  '楼栋/专业': ['A楼'],
                },
              },
            ],
            has_more: false,
          },
        },
      }),
    };
    const gateway = new PurchaseWorkflowGateway({ axiosRef } as never);

    await expect(
      gateway.resolveBuildingSupervisorAsApp('A栋'),
    ).resolves.toEqual(
      expect.objectContaining({
        openId: 'ou_nested-user_1',
        name: '嵌套示例人员001',
      }),
    );
  });

  it('fails explicitly when a building has no exact building supervisor', async () => {
    const axiosRef = {
      post: jest.fn().mockResolvedValue({
        data: { code: 0, tenant_access_token: 'tenant-token', expire: 7200 },
      }),
      get: jest.fn().mockResolvedValue({
        data: {
          code: 0,
          data: {
            items: [
              {
                record_id: 'rec_other_building',
                fields: {
                  示例人员001: [{ id: 'ou_supervisor1', name: 'A楼示例人员001' }],
                  职位: ['楼栋示例人员001'],
                  '楼栋/专业': ['A楼'],
                },
              },
              {
                record_id: 'rec_other_position',
                fields: {
                  示例人员001: [{ id: 'ou_manager1', name: 'H楼经理' }],
                  职位: ['设施示例人员001'],
                  '楼栋/专业': ['H楼'],
                },
              },
            ],
            has_more: false,
          },
        },
      }),
    };
    const gateway = new PurchaseWorkflowGateway({ axiosRef } as never);

    await expect(
      gateway.resolveBuildingSupervisorAsApp('H栋'),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it.each(['', '   ', '楼', '栋'])(
    'rejects an empty normalized supervisor building before Feishu requests: %j',
    async (building) => {
      const axiosRef = { post: jest.fn(), get: jest.fn() };
      const gateway = new PurchaseWorkflowGateway({ axiosRef } as never);

      await expect(
        gateway.resolveBuildingSupervisorAsApp(building),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(axiosRef.post).not.toHaveBeenCalled();
      expect(axiosRef.get).not.toHaveBeenCalled();
    },
  );

  it('rejects multiple distinct exact supervisors for one building', async () => {
    const axiosRef = {
      post: jest.fn().mockResolvedValue({
        data: { code: 0, tenant_access_token: 'tenant-token', expire: 7200 },
      }),
      get: jest.fn().mockResolvedValue({
        data: {
          code: 0,
          data: {
            items: [
              {
                record_id: 'rec_supervisor_1',
                fields: {
                  示例人员001: [{ id: 'ou_supervisor1', name: 'A楼示例人员001甲' }],
                  职位: ['楼栋示例人员001'],
                  '楼栋/专业': ['A楼'],
                },
              },
              {
                record_id: 'rec_supervisor_2',
                fields: {
                  示例人员001: [{ id: 'ou_supervisor2', name: 'A楼示例人员001乙' }],
                  职位: ['楼栋示例人员001'],
                  '楼栋/专业': ['A栋'],
                },
              },
            ],
            has_more: false,
          },
        },
      }),
    };
    const gateway = new PurchaseWorkflowGateway({ axiosRef } as never);

    await expect(
      gateway.resolveBuildingSupervisorAsApp('A'),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('resolves warehouse managers from an independent wiki Base source', async () => {
    const sourceUrl =
      'https://example.feishu.cn/wiki/wik_warehouse?table=tbl_from_url&view=vew_from_url';
    process.env.FEISHU_WAREHOUSE_MANAGER_SOURCE_URL = sourceUrl;
    jest.mocked(parseFeishuBitableLink).mockImplementation((value) =>
      value === sourceUrl
        ? {
            appToken: '',
            wikiToken: 'wik_warehouse',
            tableId: 'tbl_from_url',
            viewId: 'vew_from_url',
          }
        : { appToken: '', wikiToken: '', tableId: '', viewId: '' },
    );
    jest.mocked(resolveBitableAppToken).mockResolvedValue('app_warehouse');
    const axiosRef = {
      post: jest.fn().mockResolvedValue({
        data: { code: 0, tenant_access_token: 'tenant-token', expire: 7200 },
      }),
      get: jest.fn().mockResolvedValue({
        data: {
          code: 0,
          data: {
            items: [
              {
                record_id: 'rec_warehouse_a1',
                fields: {
                  楼栋: ['A楼'],
                  库房管理人: [{ id: 'ou_warehouse1', name: '库管甲' }],
                  库房示例人员019员: {
                    value: [
                      { open_id: 'ou_warehouse2', name: '库管乙' },
                      { id: 'ou_warehouse1', name: '库管甲' },
                    ],
                  },
                  '类别号管理人员（负责人最好为1人）': [
                    { openId: 'invalid-user', name: '无效人员' },
                  ],
                },
              },
              {
                record_id: 'rec_warehouse_a2',
                fields: {
                  '楼栋/专业': ['A栋'],
                  '类别号管理人员（负责人最好为1人）': {
                    users: [
                      { openId: 'ou_warehouse1', text: '库管甲' },
                      { id: 'ou_warehouse3', text: '库管丙' },
                    ],
                  },
                },
              },
              {
                record_id: 'rec_warehouse_b',
                fields: {
                  机楼: ['B楼'],
                  库房管理人: [{ id: 'ou_warehouse4', name: '其他楼库管' }],
                },
              },
            ],
            has_more: false,
          },
        },
      }),
    };
    const gateway = new PurchaseWorkflowGateway({
      axiosRef,
    } as never) as PurchaseWorkflowGateway & {
      resolveWarehouseManagersAsApp(building: string): Promise<
        Array<{
          openId: string;
          name: string;
          positions: string[];
          buildings: string[];
        }>
      >;
    };

    await expect(gateway.resolveWarehouseManagersAsApp('A')).resolves.toEqual([
      {
        openId: 'ou_warehouse1',
        name: '库管甲',
        positions: [],
        buildings: ['A楼', 'A栋'],
      },
      {
        openId: 'ou_warehouse2',
        name: '库管乙',
        positions: [],
        buildings: ['A楼'],
      },
      {
        openId: 'ou_warehouse3',
        name: '库管丙',
        positions: [],
        buildings: ['A栋'],
      },
    ]);
    expect(parseFeishuBitableLink).toHaveBeenCalledWith(sourceUrl);
    expect(resolveBitableAppToken).toHaveBeenCalledWith(expect.anything(), {
      appToken: '',
      wikiToken: 'wik_warehouse',
      tableName: '库存楼栋管理员',
    });
    expect(axiosRef.get).toHaveBeenCalledWith(
      'https://open.feishu.cn/open-apis/bitable/v1/apps/app_warehouse/tables/tbl_from_url/records',
      expect.objectContaining({
        headers: { Authorization: 'Bearer tenant-token' },
        params: expect.objectContaining({ view_id: 'vew_from_url' }),
      }),
    );
  });

  it('falls back to the general warehouse Base when no dedicated manager source is configured', async () => {
    const sourceUrl = 'https://example.feishu.cn/base/app_warehouse';
    process.env.FEISHU_WAREHOUSE_SOURCE_URL = sourceUrl;
    process.env.FEISHU_WAREHOUSE_MANAGER_TABLE_ID = 'tbl_managers';
    jest.mocked(parseFeishuBitableLink).mockImplementation((value) =>
      value === sourceUrl
        ? {
            appToken: 'app_warehouse',
            wikiToken: '',
            tableId: '',
            viewId: '',
          }
        : { appToken: '', wikiToken: '', tableId: '', viewId: '' },
    );
    jest.mocked(resolveBitableAppToken).mockResolvedValue('app_warehouse');
    const axiosRef = {
      post: jest.fn().mockResolvedValue({
        data: { code: 0, tenant_access_token: 'tenant-token', expire: 7200 },
      }),
      get: jest.fn().mockResolvedValue({
        data: {
          code: 0,
          data: {
            items: [
              {
                record_id: 'rec_warehouse',
                fields: {
                  楼栋: ['A楼'],
                  库房管理人: [{ id: 'ou_warehouse', name: '库管' }],
                },
              },
            ],
            has_more: false,
          },
        },
      }),
    };
    const gateway = new PurchaseWorkflowGateway({ axiosRef } as never);

    await expect(gateway.resolveWarehouseManagersAsApp('A楼')).resolves.toEqual(
      [
        {
          openId: 'ou_warehouse',
          name: '库管',
          positions: [],
          buildings: ['A楼'],
        },
      ],
    );
    expect(resolveBitableAppToken).toHaveBeenCalledWith(expect.anything(), {
      appToken: 'app_warehouse',
      wikiToken: '',
      tableName: '库存楼栋管理员',
    });
  });

  it('uses the live manager-table schema and excludes non-warehouse roles', async () => {
    process.env.FEISHU_WAREHOUSE_MANAGER_APP_TOKEN = 'app_warehouse';
    process.env.FEISHU_WAREHOUSE_MANAGER_TABLE_ID = 'tbl_managers';
    jest.mocked(resolveBitableAppToken).mockResolvedValue('app_warehouse');
    const axiosRef = {
      post: jest.fn().mockResolvedValue({
        data: { code: 0, tenant_access_token: 'tenant-token', expire: 7200 },
      }),
      get: jest.fn().mockResolvedValue({
        data: {
          code: 0,
          data: {
            items: [
              {
                record_id: 'rec_d_supervisor',
                fields: {
                  楼栋: 'D楼',
                  职位: '示例人员001',
                  示例人员001: [{ id: 'ou_supervisor', name: '普通示例人员001' }],
                },
              },
              {
                record_id: 'rec_d_warehouse',
                fields: {
                  楼栋: 'D楼',
                  职位: '楼内仓管',
                  示例人员001: [{ id: 'ou_warehouse', name: '楼内仓管' }],
                },
              },
              {
                record_id: 'rec_d_shift',
                fields: {
                  楼栋: 'D楼',
                  示例人员001: [{ id: 'ou_shift', name: 'D楼值班' }],
                },
              },
              {
                record_id: 'rec_c_warehouse',
                fields: {
                  楼栋: 'C楼',
                  职位: '楼内仓管',
                  示例人员001: [{ id: 'ou_other', name: '其他楼仓管' }],
                },
              },
            ],
            has_more: false,
          },
        },
      }),
    };
    const gateway = new PurchaseWorkflowGateway({ axiosRef } as never);

    await expect(gateway.resolveWarehouseManagersAsApp('D楼')).resolves.toEqual(
      [
        {
          openId: 'ou_warehouse',
          name: '楼内仓管',
          positions: ['楼内仓管'],
          buildings: ['D楼'],
        },
      ],
    );
  });

  it('resolves nested warehouse users without revisiting cyclic objects', async () => {
    process.env.FEISHU_WAREHOUSE_MANAGER_APP_TOKEN = 'app_warehouse';
    process.env.FEISHU_WAREHOUSE_MANAGER_TABLE_ID = 'tbl_managers';
    jest.mocked(resolveBitableAppToken).mockResolvedValue('app_warehouse');
    let selfReads = 0;
    const cyclicUser: Record<string, unknown> = {
      nested: { open_id: 'ou_warehouse-cycle_1', name: '循环库管' },
    };
    Object.defineProperty(cyclicUser, 'self', {
      enumerable: true,
      get: () => {
        selfReads += 1;
        if (selfReads > 1) throw new Error('cyclic object revisited');
        return cyclicUser;
      },
    });
    const axiosRef = {
      post: jest.fn().mockResolvedValue({
        data: { code: 0, tenant_access_token: 'tenant-token', expire: 7200 },
      }),
      get: jest.fn().mockResolvedValue({
        data: {
          code: 0,
          data: {
            items: [
              {
                record_id: 'rec_cyclic_warehouse',
                fields: {
                  楼栋: ['A楼'],
                  库房管理人: cyclicUser,
                },
              },
            ],
            has_more: false,
          },
        },
      }),
    };
    const gateway = new PurchaseWorkflowGateway({ axiosRef } as never);

    await expect(gateway.resolveWarehouseManagersAsApp('A栋')).resolves.toEqual(
      [
        {
          openId: 'ou_warehouse-cycle_1',
          name: '循环库管',
          positions: [],
          buildings: ['A楼'],
        },
      ],
    );
    expect(selfReads).toBe(1);
  });

  it('rejects missing independent warehouse manager Base configuration', async () => {
    jest.mocked(resolveBitableAppToken).mockResolvedValue('');
    const axiosRef = { post: jest.fn(), get: jest.fn() };
    const gateway = new PurchaseWorkflowGateway({ axiosRef } as never);

    await expect(
      gateway.resolveWarehouseManagersAsApp('A楼'),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(axiosRef.post).not.toHaveBeenCalled();
    expect(axiosRef.get).not.toHaveBeenCalled();
  });

  it.each(['', '   ', '楼', '栋'])(
    'rejects an empty normalized warehouse building before Feishu requests: %j',
    async (building) => {
      const axiosRef = { post: jest.fn(), get: jest.fn() };
      const gateway = new PurchaseWorkflowGateway({ axiosRef } as never);

      await expect(
        gateway.resolveWarehouseManagersAsApp(building),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(resolveBitableAppToken).not.toHaveBeenCalled();
      expect(axiosRef.post).not.toHaveBeenCalled();
      expect(axiosRef.get).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['APP_TOKEN only', 'app_warehouse', ''],
    ['WIKI_TOKEN only', '', 'wik_warehouse'],
  ])(
    'rejects warehouse manager %s when table id is missing before resolving app token',
    async (_label, appToken, wikiToken) => {
      process.env.FEISHU_WAREHOUSE_MANAGER_APP_TOKEN = appToken;
      process.env.FEISHU_WAREHOUSE_MANAGER_WIKI_TOKEN = wikiToken;
      process.env.FEISHU_WAREHOUSE_MANAGER_TABLE_ID = '';
      jest.mocked(resolveBitableAppToken).mockResolvedValue('app_resolved');
      const axiosRef = { post: jest.fn(), get: jest.fn() };
      const gateway = new PurchaseWorkflowGateway({ axiosRef } as never);

      await expect(
        gateway.resolveWarehouseManagersAsApp('A楼'),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(resolveBitableAppToken).not.toHaveBeenCalled();
      expect(axiosRef.post).not.toHaveBeenCalled();
      expect(axiosRef.get).not.toHaveBeenCalled();
    },
  );

  it('fails explicitly when a building has no valid warehouse manager', async () => {
    process.env.FEISHU_WAREHOUSE_MANAGER_APP_TOKEN = 'app_warehouse';
    process.env.FEISHU_WAREHOUSE_MANAGER_TABLE_ID = 'tbl_managers';
    jest.mocked(resolveBitableAppToken).mockResolvedValue('app_warehouse');
    const axiosRef = {
      post: jest.fn().mockResolvedValue({
        data: { code: 0, tenant_access_token: 'tenant-token', expire: 7200 },
      }),
      get: jest.fn().mockResolvedValue({
        data: {
          code: 0,
          data: {
            items: [
              {
                record_id: 'rec_invalid_a',
                fields: {
                  楼栋: ['A楼'],
                  库房管理人: [{ id: 'user_invalid', name: '无效人员' }],
                },
              },
              {
                record_id: 'rec_valid_b',
                fields: {
                  楼栋: ['B楼'],
                  库房管理人: [{ id: 'ou_warehouse1', name: '其他楼库管' }],
                },
              },
            ],
            has_more: false,
          },
        },
      }),
    };
    const gateway = new PurchaseWorkflowGateway({ axiosRef } as never);

    await expect(
      gateway.resolveWarehouseManagersAsApp('A栋'),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('resolves inbound responsible users only from the matching building responsibility field', async () => {
    process.env.FEISHU_WAREHOUSE_MANAGER_APP_TOKEN = 'app_warehouse';
    process.env.FEISHU_WAREHOUSE_MANAGER_TABLE_ID = 'tbl_managers';
    jest.mocked(resolveBitableAppToken).mockResolvedValue('app_warehouse');
    const axiosRef = {
      post: jest.fn().mockResolvedValue({
        data: { code: 0, tenant_access_token: 'tenant-token', expire: 7200 },
      }),
      get: jest.fn().mockResolvedValue({
        data: {
          code: 0,
          data: {
            items: [
              {
                record_id: 'rec_a_responsible_1',
                fields: {
                  楼栋: ['A楼'],
                  示例人员001: [{ id: 'ou_supervisor', name: '示例人员001不得收到' }],
                  库房示例人员019员: {
                    value: [
                      { id: 'ou_responsible_1', name: '示例人员019甲' },
                      { open_id: 'ou_responsible_2', name: '示例人员019乙' },
                    ],
                  },
                  '类别号管理人员（负责人最好为1人）': [
                    {
                      openId: 'ou_category_admin',
                      name: '类别号管理员不得收到',
                    },
                  ],
                },
              },
              {
                record_id: 'rec_a_responsible_2',
                fields: {
                  '楼栋/专业': ['A栋'],
                  库房示例人员019员: {
                    users: [
                      { openId: 'ou_responsible_1', text: '示例人员019甲重复项' },
                      { openId: 'ou_responsible_3', text: '示例人员019丙' },
                    ],
                  },
                },
              },
              {
                record_id: 'rec_b_responsible',
                fields: {
                  楼栋: ['B楼'],
                  库房示例人员019员: [
                    { id: 'ou_other_building', name: '其他楼示例人员019' },
                  ],
                },
              },
            ],
            has_more: false,
          },
        },
      }),
    };
    const gateway = new PurchaseWorkflowGateway({
      axiosRef,
    } as never) as PurchaseWorkflowGateway & {
      resolveInboundResponsibleUsersAsApp(building: string): Promise<
        Array<{
          openId: string;
          name: string;
          positions: string[];
          buildings: string[];
        }>
      >;
    };

    await expect(
      gateway.resolveInboundResponsibleUsersAsApp('A'),
    ).resolves.toEqual([
      {
        openId: 'ou_responsible_1',
        name: '示例人员019甲',
        positions: [],
        buildings: ['A楼', 'A栋'],
      },
      {
        openId: 'ou_responsible_2',
        name: '示例人员019乙',
        positions: [],
        buildings: ['A楼'],
      },
      {
        openId: 'ou_responsible_3',
        name: '示例人员019丙',
        positions: [],
        buildings: ['A栋'],
      },
    ]);
  });

  it('persists one shared weekly warehouse recipient read across restarts', async () => {
    const cacheDirectory = await mkdtemp(
      join(tmpdir(), 'warehouse-recipients-'),
    );
    const cachePath = join(cacheDirectory, 'recipients.json');
    try {
      process.env.FEISHU_WAREHOUSE_MANAGER_APP_TOKEN = 'app_warehouse';
      process.env.FEISHU_WAREHOUSE_MANAGER_TABLE_ID = 'tbl_managers';
      process.env.FEISHU_WAREHOUSE_RECIPIENT_CACHE_PATH = cachePath;
      jest.mocked(resolveBitableAppToken).mockResolvedValue('app_warehouse');
      const axiosRef = {
        post: jest.fn().mockResolvedValue({
          data: { code: 0, tenant_access_token: 'tenant-token', expire: 7200 },
        }),
        get: jest.fn().mockResolvedValue({
          data: {
            code: 0,
            data: {
              items: [
                {
                  record_id: 'rec_h',
                  fields: {
                    楼栋: 'H楼',
                    库房示例人员019员: [{ id: 'ou_responsible', name: '示例人员019' }],
                    库房管理人: [{ id: 'ou_manager', name: '管理人' }],
                  },
                },
              ],
              has_more: false,
            },
          },
        }),
      };
      const first = new PurchaseWorkflowGateway({ axiosRef } as never);
      const [responsible, managers] = await Promise.all([
        first.resolveInboundResponsibleUsersAsApp('H楼'),
        first.resolveInboundManagerNotificationUsersAsApp('H楼'),
      ]);
      expect(responsible.map((user) => user.openId)).toEqual([
        'ou_responsible',
      ]);
      expect(managers.map((user) => user.openId)).toEqual(['ou_manager']);
      expect(axiosRef.get).toHaveBeenCalledTimes(1);
      expect(await first.getCachedInboundCompletionRecipients('H楼')).toEqual([
        'ou_responsible',
        'ou_manager',
      ]);

      const offlineAxiosRef = { post: jest.fn(), get: jest.fn() };
      const restarted = new PurchaseWorkflowGateway({
        axiosRef: offlineAxiosRef,
      } as never);
      expect(
        (await restarted.resolveInboundResponsibleUsersAsApp('H楼')).map(
          (user) => user.openId,
        ),
      ).toEqual(['ou_responsible']);
      await restarted.refreshWarehouseRecipientCacheIfDue();
      expect(offlineAxiosRef.get).not.toHaveBeenCalled();

      const saved = JSON.parse(await readFile(cachePath, 'utf8')) as Record<
        string,
        unknown
      >;
      saved.syncedAt = new Date(
        Date.now() - 8 * 24 * 60 * 60 * 1_000,
      ).toISOString();
      await writeFile(cachePath, JSON.stringify(saved), 'utf8');
      const expired = new PurchaseWorkflowGateway({ axiosRef } as never);
      await expired.refreshWarehouseRecipientCacheIfDue();
      expect(axiosRef.get).toHaveBeenCalledTimes(2);
    } finally {
      await rm(cacheDirectory, { recursive: true, force: true });
    }
  });

  it('uses the supplied warehouse manager view when that table has no configured view', async () => {
    process.env.FEISHU_WAREHOUSE_MANAGER_APP_TOKEN =
      'QmxAbhXNJaA9YKsbfZyclzhGnSd';
    process.env.FEISHU_WAREHOUSE_MANAGER_TABLE_ID = 'PUBLIC_EXAMPLE_FEISHU_WAREHOUSE_MANAGER_TABLE_ID';
    jest
      .mocked(resolveBitableAppToken)
      .mockResolvedValue('QmxAbhXNJaA9YKsbfZyclzhGnSd');
    const axiosRef = {
      post: jest.fn().mockResolvedValue({
        data: { code: 0, tenant_access_token: 'tenant-token', expire: 7200 },
      }),
      get: jest.fn().mockResolvedValue({
        data: {
          code: 0,
          data: {
            items: [
              {
                record_id: 'rec_h',
                fields: {
                  楼栋: 'H楼',
                  库房示例人员019员: [{ id: 'ou_responsible', name: '示例人员019' }],
                },
              },
            ],
            has_more: false,
          },
        },
      }),
    };
    const gateway = new PurchaseWorkflowGateway({ axiosRef } as never);

    await gateway.resolveInboundResponsibleUsersAsApp('H楼');

    expect(axiosRef.get).toHaveBeenCalledWith(
      expect.stringContaining('/tables/PUBLIC_EXAMPLE_FEISHU_WAREHOUSE_MANAGER_TABLE_ID/records'),
      expect.objectContaining({
        params: expect.objectContaining({ view_id: 'vew0gRV4Jr' }),
      }),
    );
  });

  it('resolves inbound manager notification users only from the matching building manager field', async () => {
    process.env.FEISHU_WAREHOUSE_MANAGER_APP_TOKEN = 'app_warehouse';
    process.env.FEISHU_WAREHOUSE_MANAGER_TABLE_ID = 'tbl_managers';
    jest.mocked(resolveBitableAppToken).mockResolvedValue('app_warehouse');
    const axiosRef = {
      post: jest.fn().mockResolvedValue({
        data: { code: 0, tenant_access_token: 'tenant-token', expire: 7200 },
      }),
      get: jest.fn().mockResolvedValue({
        data: {
          code: 0,
          data: {
            items: [
              {
                record_id: 'rec_a_manager_1',
                fields: {
                  楼栋: ['A楼'],
                  示例人员001: [{ id: 'ou_supervisor', name: '示例人员001不得收到' }],
                  库房管理人: {
                    value: [
                      { id: 'ou_manager_1', name: '管理人甲' },
                      { open_id: 'ou_manager_2', name: '管理人乙' },
                    ],
                  },
                  库房示例人员019员: [
                    {
                      id: 'ou_responsible',
                      name: '示例人员019员不得作为管理人返回',
                    },
                  ],
                },
              },
              {
                record_id: 'rec_a_manager_2',
                fields: {
                  '楼栋/专业': ['A栋'],
                  库房管理人: {
                    users: [
                      { openId: 'ou_manager_1', text: '管理人甲重复项' },
                      { openId: 'ou_manager_3', text: '管理人丙' },
                    ],
                  },
                  '类别号管理人员（负责人最好为1人）': [
                    { openId: 'ou_category_admin', name: '类别管理员不得收到' },
                  ],
                },
              },
              {
                record_id: 'rec_b_manager',
                fields: {
                  楼栋: ['B楼'],
                  库房管理人: [
                    { id: 'ou_other_building', name: '其他楼管理人' },
                  ],
                },
              },
            ],
            has_more: false,
          },
        },
      }),
    };
    const gateway = new PurchaseWorkflowGateway({
      axiosRef,
    } as never) as PurchaseWorkflowGateway & {
      resolveInboundManagerNotificationUsersAsApp(building: string): Promise<
        Array<{
          openId: string;
          name: string;
          positions: string[];
          buildings: string[];
        }>
      >;
    };

    await expect(
      gateway.resolveInboundManagerNotificationUsersAsApp('A'),
    ).resolves.toEqual([
      {
        openId: 'ou_manager_1',
        name: '管理人甲',
        positions: [],
        buildings: ['A楼', 'A栋'],
      },
      {
        openId: 'ou_manager_2',
        name: '管理人乙',
        positions: [],
        buildings: ['A楼'],
      },
      {
        openId: 'ou_manager_3',
        name: '管理人丙',
        positions: [],
        buildings: ['A栋'],
      },
    ]);
  });

  it('returns no notification recipients when a building has responsible users but no managers', async () => {
    process.env.FEISHU_WAREHOUSE_MANAGER_APP_TOKEN = 'app_warehouse';
    process.env.FEISHU_WAREHOUSE_MANAGER_TABLE_ID = 'tbl_managers';
    jest.mocked(resolveBitableAppToken).mockResolvedValue('app_warehouse');
    const axiosRef = {
      post: jest.fn().mockResolvedValue({
        data: { code: 0, tenant_access_token: 'tenant-token', expire: 7200 },
      }),
      get: jest.fn().mockResolvedValue({
        data: {
          code: 0,
          data: {
            items: [
              {
                record_id: 'rec_h_responsible',
                fields: {
                  楼栋: 'H楼',
                  库房示例人员019员: [{ id: 'ou_h_responsible', name: '示例人员019' }],
                  库房管理人: [],
                },
              },
            ],
            has_more: false,
          },
        },
      }),
    };
    const gateway = new PurchaseWorkflowGateway({ axiosRef } as never);

    await expect(
      gateway.resolveInboundManagerNotificationUsersAsApp('H楼'),
    ).resolves.toEqual([]);
  });

  it('fails closed when inbound responsible-user configuration is missing or has no valid matching user', async () => {
    const missingConfigGateway = new PurchaseWorkflowGateway({
      axiosRef: { post: jest.fn(), get: jest.fn() },
    } as never) as PurchaseWorkflowGateway & {
      resolveInboundResponsibleUsersAsApp(building: string): Promise<unknown>;
    };

    await expect(
      missingConfigGateway.resolveInboundResponsibleUsersAsApp('A楼'),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);

    process.env.FEISHU_WAREHOUSE_MANAGER_APP_TOKEN = 'app_warehouse';
    process.env.FEISHU_WAREHOUSE_MANAGER_TABLE_ID = 'tbl_managers';
    jest.mocked(resolveBitableAppToken).mockResolvedValue('app_warehouse');
    const axiosRef = {
      post: jest.fn().mockResolvedValue({
        data: { code: 0, tenant_access_token: 'tenant-token', expire: 7200 },
      }),
      get: jest.fn().mockResolvedValue({
        data: {
          code: 0,
          data: {
            items: [
              {
                record_id: 'rec_a_without_responsible',
                fields: {
                  楼栋: ['A楼'],
                  示例人员001: [{ id: 'ou_supervisor', name: '示例人员001' }],
                  库房示例人员019员: [
                    { id: 'invalid responsible id', name: '无效示例人员019' },
                  ],
                  '类别号管理人员（负责人最好为1人）': [
                    { openId: 'ou_category_admin', name: '类别号管理员' },
                  ],
                },
              },
            ],
            has_more: false,
          },
        },
      }),
    };
    const noResponsibleGateway = new PurchaseWorkflowGateway({
      axiosRef,
    } as never) as PurchaseWorkflowGateway & {
      resolveInboundResponsibleUsersAsApp(building: string): Promise<unknown>;
    };

    await expect(
      noResponsibleGateway.resolveInboundResponsibleUsersAsApp('A栋'),
    ).rejects.toBeInstanceOf(InboundResponsibleUsersNotConfiguredException);
  });

  it('does not send a notification while notifications are suppressed', async () => {
    const axiosRef = { post: jest.fn() };
    const gateway = new PurchaseWorkflowGateway({ axiosRef } as never);

    await expect(
      gateway.sendTextNotification(['ou_requester'], '测试消息', true),
    ).resolves.toEqual([]);
    expect(axiosRef.post).not.toHaveBeenCalled();
  });

  it('sends one interactive card to an open id and returns its message id', async () => {
    const axiosRef = {
      post: jest
        .fn()
        .mockResolvedValueOnce({
          data: { code: 0, tenant_access_token: 'tenant-token', expire: 7200 },
        })
        .mockResolvedValueOnce({
          data: { code: 0, data: { message_id: 'om_message_1' } },
        }),
    };
    const gateway = new PurchaseWorkflowGateway({
      axiosRef,
    } as never) as PurchaseWorkflowGateway & {
      sendInteractiveCard(
        recipientOpenId: string,
        card: Record<string, unknown>,
      ): Promise<string>;
    };
    const card = { schema: '2.0', body: { elements: [] } };

    await expect(
      gateway.sendInteractiveCard('ou_recipient1', card),
    ).resolves.toBe('om_message_1');
    expect(axiosRef.post).toHaveBeenLastCalledWith(
      'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id',
      {
        receive_id: 'ou_recipient1',
        msg_type: 'interactive',
        content: JSON.stringify(card),
      },
      expect.objectContaining({
        headers: { Authorization: 'Bearer tenant-token' },
        timeout: 30_000,
      }),
    );
  });

  it('preserves a definitive Feishu card rejection instead of reporting a generic Axios error', async () => {
    const rejected = Object.assign(
      new Error('Request failed with status code 400'),
      {
        response: {
          status: 400,
          data: {
            code: 230099,
            msg: 'Failed to create card content: unsupported tag note',
          },
        },
      },
    );
    const axiosRef = {
      post: jest
        .fn()
        .mockResolvedValueOnce({
          data: { code: 0, tenant_access_token: 'tenant-token', expire: 7200 },
        })
        .mockRejectedValueOnce(rejected),
    };
    const gateway = new PurchaseWorkflowGateway({ axiosRef } as never);

    let failure: unknown;
    try {
      await gateway.sendInteractiveCard('ou_recipient1', {
        schema: '2.0',
        body: { elements: [] },
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(BadGatewayException);
    expect(failure).toMatchObject({
      feishuCode: 230099,
      httpStatus: 400,
      deliveryOutcome: 'rejected',
    });
    expect((failure as Error).message).toContain('230099');
    expect((failure as Error).message).toContain('unsupported tag note');
  });

  it('marks an HTTP 200 Feishu business failure as a definitive delivery rejection', async () => {
    const axiosRef = {
      post: jest
        .fn()
        .mockResolvedValueOnce({
          data: { code: 0, tenant_access_token: 'tenant-token', expire: 7200 },
        })
        .mockResolvedValueOnce({
          status: 200,
          data: {
            code: 230099,
            msg: 'Failed to create card content: unsupported tag note',
          },
        }),
    };
    const gateway = new PurchaseWorkflowGateway({ axiosRef } as never);

    let failure: unknown;
    try {
      await gateway.sendInteractiveCard('ou_recipient1', {
        schema: '2.0',
        body: { elements: [] },
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(BadGatewayException);
    expect(failure).toMatchObject({
      feishuCode: 230099,
      httpStatus: 200,
      deliveryOutcome: 'rejected',
    });
  });

  it('sends a safe stable uuid as the Feishu message idempotency key', async () => {
    const axiosRef = {
      post: jest
        .fn()
        .mockResolvedValueOnce({
          data: { code: 0, tenant_access_token: 'tenant-token', expire: 7200 },
        })
        .mockResolvedValueOnce({
          data: { code: 0, data: { message_id: 'om_message_uuid' } },
        }),
    };
    const gateway = new PurchaseWorkflowGateway({ axiosRef } as never);
    const card = { schema: '2.0', body: { elements: [] } };

    await expect(
      gateway.sendInteractiveCard(
        'ou_recipient1',
        card,
        'pma_a8c753fa-0718-4c77-bec0-4ba6ae96',
      ),
    ).resolves.toBe('om_message_uuid');
    expect(axiosRef.post).toHaveBeenLastCalledWith(
      'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id',
      {
        receive_id: 'ou_recipient1',
        msg_type: 'interactive',
        content: JSON.stringify(card),
        uuid: 'pma_a8c753fa-0718-4c77-bec0-4ba6ae96',
      },
      expect.any(Object),
    );
  });

  it('allows a uuid at the exact 50-character Feishu limit', async () => {
    const uuid = 'u'.repeat(50);
    const axiosRef = {
      post: jest
        .fn()
        .mockResolvedValueOnce({
          data: { code: 0, tenant_access_token: 'tenant-token', expire: 7200 },
        })
        .mockResolvedValueOnce({
          data: { code: 0, data: { message_id: 'om_message_uuid_limit' } },
        }),
    };
    const gateway = new PurchaseWorkflowGateway({ axiosRef } as never);

    await expect(
      gateway.sendInteractiveCard('ou_recipient1', { schema: '2.0' }, uuid),
    ).resolves.toBe('om_message_uuid_limit');
    expect(axiosRef.post).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({ uuid }),
      expect.any(Object),
    );
  });

  it.each(['', 'contains spaces', '包含中文', 'unsafe/value', 'x'.repeat(51)])(
    'rejects an unsafe interactive card uuid without sending: %j',
    async (uuid) => {
      const axiosRef = { post: jest.fn() };
      const gateway = new PurchaseWorkflowGateway({ axiosRef } as never);

      await expect(
        gateway.sendInteractiveCard('ou_recipient1', { schema: '2.0' }, uuid),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(axiosRef.post).not.toHaveBeenCalled();
    },
  );

  it('rejects an interactive card response without a message id', async () => {
    const axiosRef = {
      post: jest
        .fn()
        .mockResolvedValueOnce({
          data: { code: 0, tenant_access_token: 'tenant-token', expire: 7200 },
        })
        .mockResolvedValueOnce({ data: { code: 0, data: {} } }),
    };
    const gateway = new PurchaseWorkflowGateway({ axiosRef } as never);

    await expect(
      gateway.sendInteractiveCard('ou_recipient1', { schema: '2.0' }),
    ).rejects.toBeInstanceOf(BadGatewayException);
  });

  it.each(['', 'user_recipient1', 'ou_bad.id'])(
    'rejects an invalid interactive card recipient open id: %j',
    async (recipientOpenId) => {
      const axiosRef = { post: jest.fn() };
      const gateway = new PurchaseWorkflowGateway({ axiosRef } as never);

      await expect(
        gateway.sendInteractiveCard(recipientOpenId, { schema: '2.0' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(axiosRef.post).not.toHaveBeenCalled();
    },
  );

  it('patches an existing interactive card by message id', async () => {
    const axiosRef = {
      post: jest.fn().mockResolvedValue({
        data: { code: 0, tenant_access_token: 'tenant-token', expire: 7200 },
      }),
      patch: jest.fn().mockResolvedValue({ data: { code: 0, data: {} } }),
    };
    const gateway = new PurchaseWorkflowGateway({
      axiosRef,
    } as never) as PurchaseWorkflowGateway & {
      updateInteractiveCard(
        messageId: string,
        card: Record<string, unknown>,
      ): Promise<void>;
    };
    const card = { schema: '2.0', body: { elements: [] } };

    await expect(
      gateway.updateInteractiveCard('om_message_1', card),
    ).resolves.toBeUndefined();
    expect(axiosRef.patch).toHaveBeenCalledWith(
      'https://open.feishu.cn/open-apis/im/v1/messages/om_message_1',
      { content: JSON.stringify(card) },
      expect.objectContaining({
        headers: { Authorization: 'Bearer tenant-token' },
        timeout: 30_000,
      }),
    );
  });

  it('uses the callback token to update a Card 2.0 view after acknowledgement', async () => {
    const axiosRef = {
      post: jest
        .fn()
        .mockResolvedValueOnce({
          data: { code: 0, tenant_access_token: 'tenant-token', expire: 7200 },
        })
        .mockResolvedValueOnce({ data: { code: 0, data: {} } }),
      patch: jest.fn(),
    };
    const gateway = new PurchaseWorkflowGateway({ axiosRef } as never);
    const card = {
      schema: '2.0',
      config: { update_multi: true },
      body: { elements: [] },
    };

    await expect(
      gateway.updateInteractiveCardAfterCallback('c-update-receipt-01', card),
    ).resolves.toBeUndefined();
    expect(axiosRef.post).toHaveBeenLastCalledWith(
      'https://open.feishu.cn/open-apis/interactive/v1/card/update',
      { token: 'c-update-receipt-01', card },
      expect.objectContaining({
        headers: { Authorization: 'Bearer tenant-token' },
        timeout: 30_000,
      }),
    );
    expect(axiosRef.patch).not.toHaveBeenCalled();
  });

  it('fails closed on an invalid delayed-update token and preserves Feishu failure codes', async () => {
    const axiosRef = {
      post: jest
        .fn()
        .mockResolvedValueOnce({
          data: { code: 0, tenant_access_token: 'tenant-token', expire: 7200 },
        })
        .mockRejectedValueOnce({
          response: { status: 400, data: { code: 11311, msg: 'invalid card' } },
        }),
    };
    const gateway = new PurchaseWorkflowGateway({ axiosRef } as never);
    const card = { schema: '2.0', config: { update_multi: true } };

    await expect(
      gateway.updateInteractiveCardAfterCallback('forged', card),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(axiosRef.post).not.toHaveBeenCalled();

    const error = await gateway
      .updateInteractiveCardAfterCallback('c-valid-01', card)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BadGatewayException);
    expect(error).toMatchObject({ feishuCode: 11311 });
  });

  it('preserves the non-sensitive Feishu application code on card update failure', async () => {
    const axiosRef = {
      post: jest.fn().mockResolvedValue({
        data: { code: 0, tenant_access_token: 'tenant-token', expire: 7200 },
      }),
      patch: jest.fn().mockResolvedValue({
        data: { code: 230110, msg: 'message has been deleted' },
      }),
    };
    const gateway = new PurchaseWorkflowGateway({ axiosRef } as never);

    const error = await gateway
      .updateInteractiveCard('om_message_1', { schema: '2.0' })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(BadGatewayException);
    expect(error).toMatchObject({ feishuCode: 230110 });
  });

  it('preserves the Feishu application code when card update is rejected with HTTP 4xx', async () => {
    const axiosRef = {
      post: jest.fn().mockResolvedValue({
        data: { code: 0, tenant_access_token: 'tenant-token', expire: 7200 },
      }),
      patch: jest.fn().mockRejectedValue({
        response: {
          status: 400,
          data: { code: 200673, msg: 'card action is not available' },
        },
      }),
    };
    const gateway = new PurchaseWorkflowGateway({ axiosRef } as never);

    const error = await gateway
      .updateInteractiveCard('om_message_1', { schema: '2.0' })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(BadGatewayException);
    expect(error).toMatchObject({ feishuCode: 200673 });
  });

  it.each(['om_', 'bm_batch_1', '../om_secret', 'om_bad?trace=1'])(
    'rejects an unsafe interactive message id: %s',
    async (messageId) => {
      const axiosRef = {
        post: jest.fn().mockResolvedValue({
          data: { code: 0, tenant_access_token: 'tenant-token', expire: 7200 },
        }),
        patch: jest.fn().mockResolvedValue({ data: { code: 0, data: {} } }),
      };
      const gateway = new PurchaseWorkflowGateway({ axiosRef } as never);

      await expect(
        gateway.updateInteractiveCard(messageId, { schema: '2.0' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(axiosRef.post).not.toHaveBeenCalled();
      expect(axiosRef.patch).not.toHaveBeenCalled();
    },
  );

  it('rejects an interactive card payload larger than 30KB', async () => {
    const axiosRef = {
      post: jest.fn().mockResolvedValue({
        data: { code: 0, tenant_access_token: 'tenant-token', expire: 7200 },
      }),
      patch: jest.fn().mockResolvedValue({ data: { code: 0, data: {} } }),
    };
    const gateway = new PurchaseWorkflowGateway({ axiosRef } as never);

    await expect(
      gateway.updateInteractiveCard('om_message_1', {
        schema: '2.0',
        content: '中'.repeat(11_000),
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(axiosRef.post).not.toHaveBeenCalled();
    expect(axiosRef.patch).not.toHaveBeenCalled();
  });

  it.each([null, [], new Date('2026-07-17T00:00:00Z')])(
    'rejects a non-plain interactive card payload: %p',
    async (card) => {
      const axiosRef = {
        post: jest.fn().mockResolvedValue({
          data: { code: 0, tenant_access_token: 'tenant-token', expire: 7200 },
        }),
        patch: jest.fn().mockResolvedValue({ data: { code: 0, data: {} } }),
      };
      const gateway = new PurchaseWorkflowGateway({ axiosRef } as never);

      await expect(
        gateway.updateInteractiveCard('om_message_1', card as never),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(axiosRef.post).not.toHaveBeenCalled();
      expect(axiosRef.patch).not.toHaveBeenCalled();
    },
  );

  it('deletes linked purchase records with one batch request per table', async () => {
    const axiosRef = {
      post: jest
        .fn()
        .mockResolvedValueOnce({
          data: { code: 0, tenant_access_token: 'tenant-token', expire: 7200 },
        })
        .mockResolvedValue({ data: { code: 0, data: {} } }),
    };
    const gateway = new PurchaseWorkflowGateway({ axiosRef } as never);

    await gateway.batchDeleteRecordsAsApp({
      submissionRecordIds: ['rec_submission_1'],
      executionRecordIds: ['rec_execution_1', 'rec_execution_2'],
    });

    expect(axiosRef.post).toHaveBeenCalledWith(
      'https://open.feishu.cn/open-apis/bitable/v1/apps/app_purchase/tables/tbl_submission/records/batch_delete',
      { records: ['rec_submission_1'] },
      expect.objectContaining({
        headers: { Authorization: 'Bearer tenant-token' },
        timeout: 30_000,
      }),
    );
    expect(axiosRef.post).toHaveBeenCalledWith(
      'https://open.feishu.cn/open-apis/bitable/v1/apps/app_purchase/tables/tbl_execution/records/batch_delete',
      { records: ['rec_execution_1', 'rec_execution_2'] },
      expect.objectContaining({
        headers: { Authorization: 'Bearer tenant-token' },
        timeout: 30_000,
      }),
    );
  });

  it('maps the execution-record specification used by the manager batch card', () => {
    expect(
      mapExecutionRecord({
        record_id: 'rec_batch_specification',
        fields: {
          物品名称: '地磅秤',
          '物品规格型号、设备序列号': '0.6×0.8米1吨',
        },
      }),
    ).toMatchObject({
      recordId: 'rec_batch_specification',
      itemName: '地磅秤',
      specification: '0.6×0.8米1吨',
    });
  });

  it('downloads an image message resource with the app tenant token', async () => {
    const axiosRef = {
      post: jest.fn().mockResolvedValue({
        data: { code: 0, tenant_access_token: 'tenant-token', expire: 7200 },
      }),
      get: jest.fn().mockResolvedValue({
        data: Buffer.from('image-bytes'),
        headers: { 'content-type': 'image/jpeg' },
      }),
    };
    const gateway = new PurchaseWorkflowGateway({ axiosRef } as never);

    await expect(
      gateway.downloadMessageImage('om_receipt_image_1', 'img_v3_receipt_1'),
    ).resolves.toMatchObject({
      originalname: 'receipt-img_v3_receipt_1.jpg',
      mimetype: 'image/jpeg',
      size: 11,
      buffer: Buffer.from('image-bytes'),
    });
    expect(axiosRef.get).toHaveBeenCalledWith(
      'https://open.feishu.cn/open-apis/im/v1/messages/om_receipt_image_1/resources/img_v3_receipt_1',
      expect.objectContaining({
        headers: { Authorization: 'Bearer tenant-token' },
        params: { type: 'image' },
        responseType: 'arraybuffer',
      }),
    );
  });
});
