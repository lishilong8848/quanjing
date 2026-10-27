jest.mock('../../common/config/external-services.config', () => ({}));
jest.mock('../../common/feishu/bitable-direct-read', () => jest.requireActual('../../common/feishu/bitable-direct-read'));

import {
  BadGatewayException,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import type { ContractCreateRequest } from '../../../shared/contract-management.interface';
import { ContractCreateIndeterminateError } from './contract-creation.gateway';
import { ContractCreationService } from './contract-creation.service';

const frameworkRecords = [
  {
    record_id: 'rec-framework-active',
    fields: {
      合同编号: 'FRAME-001',
      合同名称: '生效框架合同',
      合同开始日期: Date.parse('2026-01-01T00:00:00+08:00'),
      合同结束日期: Date.parse('2026-12-31T00:00:00+08:00'),
      框架合同状态: '生效中',
    },
  },
  {
    record_id: 'rec-framework-expired',
    fields: {
      合同编号: 'FRAME-OLD',
      合同名称: '失效框架合同',
      合同开始日期: Date.parse('2025-01-01T00:00:00+08:00'),
      合同结束日期: Date.parse('2025-12-31T00:00:00+08:00'),
      框架合同状态: '已失效',
    },
  },
];

const supplierRecords = [
  {
    record_id: 'rec-supplier-existing',
    fields: {
      公司单位: '现有供应商',
      联系人: '李四',
      联系电话: '13800000001',
      园区对接人: [{ id: 'ou_liaison', name: '王五' }],
    },
  },
];

const executionRecords = [
  {
    record_id: 'rec-existing-contract',
    fields: { 跟进人: [{ id: 'ou_owner', name: '张三' }] },
  },
];

const organizationRecords = [
  {
    record_id: 'rec-org',
    fields: {
      职位: '机房经理',
      主管: [{ id: 'ou_manager', name: '合同经理' }],
    },
  },
];

describe('ContractCreationService', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns real writable fields, active frameworks, suppliers and people', async () => {
    const { service, gateway } = setup();

    const result = await service.getOptions(
      'execution',
      new Date('2026-07-13T04:00:00.000Z'),
    );

    expect(result.fields.map((item) => item.name)).toEqual([
      '合同编号',
      '合同名称',
      '跟进人',
      '合同类型',
      '合同金额',
      '合同开始日期',
      '合同结束日期',
      '签报号',
      '签报金额',
      '合同附件',
      '专业类别',
      '对应楼栋设备',
    ]);
    expect(result.frameworks.map((item) => item.recordId)).toEqual([
      'rec-framework-active',
    ]);
    expect(result.suppliers).toEqual([
      expect.objectContaining({
        recordId: 'rec-supplier-existing',
        name: '现有供应商',
      }),
    ]);
    expect(result.people.map((item) => item.openId).sort()).toEqual([
      'ou_liaison',
      'ou_manager',
      'ou_owner',
    ]);
    expect(result.upload).toEqual({
      accept: 'application/pdf',
      required: true,
      maxFiles: 5,
      maxFileSize: 20 * 1024 * 1024,
    });
    expect(gateway.listFields).not.toHaveBeenCalled();
  });

  it('coalesces display option reads without requesting remote field metadata', async () => {
    const { service, gateway } = setup();

    await Promise.all([
      service.getOptions('framework'),
      service.getOptions('execution'),
    ]);

    expect(gateway.listFields).not.toHaveBeenCalled();
    expect(gateway.listRecords).toHaveBeenCalledTimes(4);
  });

  it('caches the shared display snapshot for five minutes', async () => {
    const { service, gateway } = setup();
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000);

    await service.getOptions('execution');
    now.mockReturnValue(1_000 + 5 * 60 * 1_000 - 1);
    await service.getOptions('framework');
    expect(gateway.listRecords).toHaveBeenCalledTimes(4);

    now.mockReturnValue(1_000 + 5 * 60 * 1_000);
    await service.getOptions('execution');
    expect(gateway.listRecords).toHaveBeenCalledTimes(8);
    now.mockRestore();
  });

  it('does not cache failed display snapshot reads', async () => {
    const { service, gateway } = setup();
    gateway.listRecords.mockRejectedValueOnce(new Error('Feishu unavailable'));

    await expect(service.getOptions('execution')).rejects.toThrow(
      'Feishu unavailable',
    );
    await expect(service.getOptions('execution')).resolves.toBeDefined();

    expect(gateway.listRecords).toHaveBeenCalledTimes(8);
  });

  it('uses fresh records for creation and invalidates the display snapshot after success', async () => {
    const { service, gateway, storage, workflow } = setup();
    gateway.uploadPdf.mockResolvedValue('box-contract-pdf');
    gateway.createRecord.mockResolvedValue('rec-contract-new');
    gateway.getRecord.mockResolvedValue({
      record_id: 'rec-contract-new',
      fields: { 合同附件: [] },
    });
    storage.syncContractRecordAttachments.mockResolvedValue([]);
    workflow.notifyContractCreated.mockResolvedValue({
      attempted: true,
      recipients: 1,
      sent: 1,
      failed: 0,
      message: '合同通知已发送给 1 人',
    });

    await service.getOptions('execution');
    expect(gateway.listRecords).toHaveBeenCalledTimes(4);

    await service.create(
      executionRequest({ linkFramework: false, frameworkRecordId: undefined }),
      [pdfFile()],
    );
    expect(gateway.listRecords).toHaveBeenCalledTimes(8);

    await service.getOptions('framework');
    expect(gateway.listRecords).toHaveBeenCalledTimes(12);
    expect(gateway.listFields).not.toHaveBeenCalled();
  });

  it('creates a new supplier and linked execution contract before notifying', async () => {
    const { service, gateway, storage, workflow } = setup();
    gateway.createRecord.mockImplementation(async (kind: string) => {
      if (kind === 'supplier') return 'rec-supplier-new';
      if (kind === 'payment') return 'rec-payment-new';
      return 'rec-contract-new';
    });
    gateway.uploadPdf.mockResolvedValue('box-contract-pdf');
    gateway.getRecord.mockResolvedValue({
      record_id: 'rec-contract-new',
      fields: {
        合同附件: [
          {
            name: '合同.pdf',
            file_token: 'box-contract-pdf',
            tmp_url:
              'https://open.feishu.cn/open-apis/drive/v1/medias/batch_get_tmp_download_url?file_tokens=box-contract-pdf',
          },
        ],
      },
    });
    storage.syncContractRecordAttachments.mockResolvedValue([
      {
        name: '合同.pdf',
        accessId: 'secure-access',
        previewStatus: 'ready',
        pageCount: 1,
      },
    ]);
    workflow.notifyContractCreated.mockResolvedValue({
      attempted: true,
      recipients: 2,
      sent: 2,
      failed: 0,
      message: '合同通知已发送给 2 人',
    });
    const request = executionRequest({
      supplier: {
        mode: 'create',
        fields: {
          fld7wwRKhu: '新供应商',
          fld7XJlAfD: '赵六',
          fldH9YKIX8: '13800000002',
          fldSE2n6Pv: 'supplier@example.com',
          fldOSoZVHD: 'ou_liaison',
        },
      },
    });

    const result = await service.create(request, [pdfFile()]);

    expect(gateway.createRecord).toHaveBeenNthCalledWith(
      1,
      'supplier',
      expect.objectContaining({ 公司单位: '新供应商' }),
      expect.stringMatching(/^[0-9a-f-]{36}$/),
    );
    expect(gateway.createRecord).toHaveBeenNthCalledWith(
      2,
      'execution',
      expect.objectContaining({
        合同编号: 'VNET-2026-001',
        供应商: ['rec-supplier-new'],
        框架引用: ['rec-framework-active'],
        合同附件: [{ file_token: 'box-contract-pdf' }],
      }),
      request.idempotencyKey,
    );
    expect(gateway.createRecord).toHaveBeenNthCalledWith(
      3,
      'payment',
      {
        付款周期: '一期',
        合同编号: ['rec-contract-new'],
        跟进人: [{ id: 'ou_owner' }],
        计划付款金额: 128000,
        计划付款日期: Date.parse('2026-08-15T00:00:00+08:00'),
        付款状态: '未付款',
      },
      expect.stringMatching(/^[0-9a-f-]{36}$/),
    );
    expect(storage.syncContractRecordAttachments).toHaveBeenCalledWith(
      'rec-contract-new',
      expect.any(Array),
    );
    expect(workflow.notifyContractCreated).toHaveBeenCalledWith(
      expect.objectContaining({
        recordId: 'rec-contract-new',
        supplier: '新供应商',
        ownerOpenIds: ['ou_owner'],
      }),
    );
    expect(
      workflow.notifyContractCreated.mock.invocationCallOrder[0],
    ).toBeGreaterThan(
      storage.syncContractRecordAttachments.mock.invocationCallOrder[0],
    );
    expect(result).toEqual(
      expect.objectContaining({
        recordId: 'rec-contract-new',
        supplierRecordId: 'rec-supplier-new',
        supplierCreated: true,
        paymentRecordIds: ['rec-payment-new'],
        attachments: [expect.objectContaining({ previewStatus: 'ready' })],
      }),
    );
    expect(gateway.listFields).not.toHaveBeenCalled();
  });

  it('compensates the contract, new supplier and secure storage on COS failure', async () => {
    const { service, gateway, storage, workflow } = setup();
    gateway.createRecord.mockImplementation(async (kind: string) => {
      if (kind === 'supplier') return 'rec-supplier-new';
      if (kind === 'payment') return 'rec-payment-new';
      return 'rec-contract-new';
    });
    gateway.uploadPdf.mockResolvedValue('box-contract-pdf');
    gateway.getRecord.mockResolvedValue({
      record_id: 'rec-contract-new',
      fields: {
        合同附件: [
          {
            name: '合同.pdf',
            file_token: 'box-contract-pdf',
            tmp_url:
              'https://open.feishu.cn/open-apis/drive/v1/medias/batch_get_tmp_download_url?file_tokens=box-contract-pdf',
          },
        ],
      },
    });
    storage.syncContractRecordAttachments.mockRejectedValue(
      new Error('COS unavailable'),
    );

    await expect(
      service.create(
        executionRequest({
          supplier: {
            mode: 'create',
            fields: { fld7wwRKhu: '回滚供应商' },
          },
        }),
        [pdfFile()],
      ),
    ).rejects.toThrow('COS unavailable');

    expect(storage.removeContractRecordAttachments).toHaveBeenCalledWith(
      'rec-contract-new',
    );
    expect(gateway.deleteRecord).toHaveBeenCalledWith(
      'payment',
      'rec-payment-new',
    );
    expect(gateway.deleteRecord).toHaveBeenCalledWith(
      'execution',
      'rec-contract-new',
    );
    expect(gateway.deleteRecord).toHaveBeenCalledWith(
      'supplier',
      'rec-supplier-new',
    );
    expect(workflow.notifyContractCreated).not.toHaveBeenCalled();
  });

  it('validates contract and supplier fields before any external write', async () => {
    const { service, gateway } = setup();
    const request = executionRequest({
      fields: {
        ...executionRequest().fields,
        flda4ARUY9: 'invalid-amount',
      },
      supplier: {
        mode: 'create',
        fields: { fld7wwRKhu: '不应写入的供应商' },
      },
    });

    await expect(service.create(request, [pdfFile()])).rejects.toBeInstanceOf(
      BadRequestException,
    );

    expect(gateway.createRecord).not.toHaveBeenCalled();
    expect(gateway.uploadPdf).not.toHaveBeenCalled();
  });

  it('rejects people outside the current options before any external write', async () => {
    const { service, gateway } = setup();
    const unknownOwner = 'ou_unknown';
    const requests = [
      executionRequest({
        fields: {
          ...executionRequest().fields,
          fldxPuYT19: unknownOwner,
        },
      }),
      executionRequest({
        paymentPlans: [
          {
            ...executionRequest().paymentPlans![0],
            ownerOpenId: unknownOwner,
          },
        ],
      }),
      executionRequest({
        supplier: {
          mode: 'create',
          fields: {
            fld7wwRKhu: '人员校验供应商',
            fldOSoZVHD: unknownOwner,
          },
        },
      }),
    ];

    for (const request of requests) {
      await expect(service.create(request, [pdfFile()])).rejects.toThrow(
        '不在当前可选人员中',
      );
    }

    expect(gateway.createRecord).not.toHaveBeenCalled();
    expect(gateway.uploadPdf).not.toHaveBeenCalled();
  });

  it('preserves parent contract and supplier when a payment rollback fails', async () => {
    const { service, gateway, storage } = setup();
    gateway.createRecord.mockImplementation(async (kind: string) => {
      if (kind === 'supplier') return 'rec-supplier-new';
      if (kind === 'payment') return 'rec-payment-new';
      return 'rec-contract-new';
    });
    gateway.uploadPdf.mockResolvedValue('box-contract-pdf');
    gateway.getRecord.mockResolvedValue({
      record_id: 'rec-contract-new',
      fields: { 合同附件: [] },
    });
    storage.syncContractRecordAttachments.mockRejectedValue(
      new Error('COS unavailable'),
    );
    gateway.deleteRecord.mockImplementation(async (kind: string) => {
      if (kind === 'payment') throw new Error('payment delete failed');
    });

    await expect(
      service.create(
        executionRequest({
          supplier: {
            mode: 'create',
            fields: { fld7wwRKhu: '需保留的供应商' },
          },
        }),
        [pdfFile()],
      ),
    ).rejects.toThrow('自动回滚未完全完成');

    expect(gateway.deleteRecord).toHaveBeenCalledWith(
      'payment',
      'rec-payment-new',
    );
    expect(gateway.deleteRecord).not.toHaveBeenCalledWith(
      'execution',
      'rec-contract-new',
    );
    expect(gateway.deleteRecord).not.toHaveBeenCalledWith(
      'supplier',
      'rec-supplier-new',
    );
  });

  it('rolls back earlier payment plans before the contract when a later plan fails', async () => {
    const { service, gateway, storage } = setup();
    gateway.uploadPdf.mockResolvedValue('box-contract-pdf');
    gateway.createRecord
      .mockResolvedValueOnce('rec-contract-new')
      .mockResolvedValueOnce('rec-payment-one')
      .mockRejectedValueOnce(new Error('second payment failed'));

    await expect(
      service.create(
        executionRequest({
          paymentPlans: [
            {
              period: '一期',
              plannedAmount: 64000,
              plannedPaymentDate: '2026-08-15',
              ownerOpenId: 'ou_owner',
            },
            {
              period: '二期',
              plannedAmount: 64000,
              plannedPaymentDate: '2026-10-15',
              ownerOpenId: 'ou_owner',
            },
          ],
        }),
        [pdfFile()],
      ),
    ).rejects.toThrow('second payment failed');

    expect(gateway.deleteRecord.mock.calls).toEqual([
      ['payment', 'rec-payment-one'],
      ['execution', 'rec-contract-new'],
    ]);
    expect(storage.syncContractRecordAttachments).not.toHaveBeenCalled();
  });

  it('does not compensate known records when a create outcome is indeterminate', async () => {
    const { service, gateway, storage } = setup();
    const indeterminate = new ContractCreateIndeterminateError(
      'payment',
      'payment-token-2',
      new Error('response lost twice'),
    );
    gateway.uploadPdf.mockResolvedValue('box-contract-pdf');
    gateway.createRecord
      .mockResolvedValueOnce('rec-supplier-new')
      .mockResolvedValueOnce('rec-contract-new')
      .mockResolvedValueOnce('rec-payment-one')
      .mockRejectedValueOnce(indeterminate);

    const failure = await service
      .create(
        executionRequest({
          supplier: {
            mode: 'create',
            fields: { fld7wwRKhu: '状态待确认供应商' },
          },
          paymentPlans: [
            {
              period: '一期',
              plannedAmount: 64000,
              plannedPaymentDate: '2026-08-15',
              ownerOpenId: 'ou_owner',
            },
            {
              period: '二期',
              plannedAmount: 64000,
              plannedPaymentDate: '2026-10-15',
              ownerOpenId: 'ou_owner',
            },
          ],
        }),
        [pdfFile()],
      )
      .catch((error) => error);

    expect(failure).toBeInstanceOf(BadGatewayException);
    expect(failure.message).toContain('提交状态无法确认');
    expect(failure.message).toContain('payment-token-2');
    expect(failure.message).toContain('勿重复提交');
    expect(gateway.deleteRecord).not.toHaveBeenCalled();
    expect(storage.removeContractRecordAttachments).not.toHaveBeenCalled();
    expect(storage.syncContractRecordAttachments).not.toHaveBeenCalled();
  });

  it('rejects missing PDFs and inactive framework selections before writing', async () => {
    const { service, gateway } = setup();
    await expect(service.create(executionRequest(), [])).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(
      service.create(
        executionRequest({ frameworkRecordId: 'rec-framework-expired' }),
        [pdfFile()],
      ),
    ).rejects.toThrow('请选择生效的框架合同');
    expect(gateway.createRecord).not.toHaveBeenCalled();
  });

  it('rejects execution contracts without payment plans before writing', async () => {
    const { service, gateway } = setup();

    await expect(
      service.create(executionRequest({ paymentPlans: [] }), [pdfFile()]),
    ).rejects.toThrow('请至少录入一条付款计划');
    expect(gateway.createRecord).not.toHaveBeenCalled();
  });

  it('fails self-test cleanup when the temporary supplier still exists', async () => {
    const { service, gateway } = setup();
    gateway.getRecord.mockImplementation(async (kind: string) => {
      if (kind === 'supplier') {
        return { record_id: 'rec-self-test-supplier', fields: {} };
      }
      throw new NotFoundException();
    });

    await expect(
      service.cleanupSelfTestRecord(
        'rec-self-test-contract',
        [],
        [],
        'rec-self-test-supplier',
      ),
    ).rejects.toThrow('真实自测清理校验失败');
  });

  it('removes only marked self-test contracts, COS objects and temporary suppliers', async () => {
    const { service, gateway, storage } = setup();
    let executionReads = 0;
    let supplierReads = 0;
    let paymentReads = 0;
    gateway.listRecords.mockImplementation(async (kind: string) => {
      if (kind === 'execution') {
        executionReads += 1;
        return executionReads === 1
          ? [
              {
                record_id: 'rec-self-test',
                fields: { 合同编号: 'CODEX-SELFTEST-123' },
              },
              {
                record_id: 'rec-real-contract',
                fields: { 合同编号: 'REAL-123' },
              },
            ]
          : [];
      }
      if (kind === 'supplier') {
        supplierReads += 1;
        return supplierReads === 1
          ? [
              {
                record_id: 'rec-self-test-supplier',
                fields: { 公司单位: 'CODEX-SELFTEST-123 临时供应商' },
              },
              {
                record_id: 'rec-real-supplier',
                fields: { 公司单位: '正式供应商' },
              },
            ]
          : [];
      }
      if (kind === 'payment') {
        paymentReads += 1;
        return paymentReads === 1
          ? [
              {
                record_id: 'rec-self-test-payment',
                fields: {
                  合同编号: [{ record_ids: ['rec-self-test'] }],
                },
              },
              {
                record_id: 'rec-real-payment',
                fields: {
                  合同编号: [{ record_ids: ['rec-real-contract'] }],
                },
              },
            ]
          : [
              {
                record_id: 'rec-real-payment',
                fields: {
                  合同编号: [{ record_ids: ['rec-real-contract'] }],
                },
              },
            ];
      }
      return [];
    });

    await expect(service.cleanupMarkedSelfTestResidue()).resolves.toEqual({
      deletedPayments: 1,
      deletedContracts: 1,
      deletedSuppliers: 1,
      residualPayments: 0,
      residualContracts: 0,
      residualSuppliers: 0,
    });
    expect(storage.removeContractRecordAttachments).toHaveBeenCalledWith(
      'rec-self-test',
    );
    expect(gateway.deleteRecord.mock.calls).toEqual([
      ['payment', 'rec-self-test-payment'],
      ['execution', 'rec-self-test'],
      ['supplier', 'rec-self-test-supplier'],
    ]);
  });
});

function setup() {
  const gateway = {
    listFields: jest.fn(),
    listRecords: jest.fn(async (kind: string) => {
      if (kind === 'framework') return frameworkRecords;
      if (kind === 'supplier') return supplierRecords;
      if (kind === 'organization') return organizationRecords;
      return executionRecords;
    }),
    uploadPdf: jest.fn(),
    createRecord: jest.fn(),
    getRecord: jest.fn(),
    deleteRecord: jest.fn().mockResolvedValue(undefined),
  };
  const storage = {
    syncContractRecordAttachments: jest.fn(),
    removeContractRecordAttachments: jest.fn().mockResolvedValue(1),
  };
  const workflow = { notifyContractCreated: jest.fn() };
  const principal = { role: 'admin' as const, purchaseBuilding: null, accountId: 'synthetic-admin', authorizationVersion: 1 };
  const service = new ContractCreationService(gateway as never, storage as never, workflow as never, { currentPrincipal: jest.fn((id: string, version: number) => id === principal.accountId && version === 1 ? principal : undefined) } as never);
  const create = service.create.bind(service);
  service.create = (request, files, context = {}) => create(request, files, { principal, ...context });
  return {
    gateway,
    storage,
    workflow,
    service,
  };
}

function executionRequest(
  overrides: Partial<ContractCreateRequest> = {},
): ContractCreateRequest {
  return {
    kind: 'execution',
    idempotencyKey: '6b8fbc5a-1047-4e40-b083-906960893894',
    fields: {
      fldbOaLbUD: 'VNET-2026-001',
      fldl8lAeAw: 'UPS 维保合同',
      fldxPuYT19: 'ou_owner',
      fldlu37YRh: '维保合同',
      flda4ARUY9: 128000,
      fldTKcyksD: '2026-07-13',
      fldEcltbl1: '2026-12-31',
      fldGqKUOPN: '电气',
    },
    supplier: { mode: 'existing', recordId: 'rec-supplier-existing' },
    linkFramework: true,
    frameworkRecordId: 'rec-framework-active',
    paymentPlans: [
      {
        period: '一期',
        plannedAmount: 128000,
        plannedPaymentDate: '2026-08-15',
        ownerOpenId: 'ou_owner',
      },
    ],
    ...overrides,
  };
}

function pdfFile() {
  const buffer = Buffer.from('%PDF-1.4\nself-test');
  return {
    originalname: '合同.pdf',
    mimetype: 'application/pdf',
    size: buffer.length,
    buffer,
  };
}
