import { buildContractManagementDashboard } from './contract-management.mapper';

function executionContract(recordId: string, endDate: string) {
  return {
    record_id: recordId,
    fields: {
      合同名称: `合同-${recordId}`,
      合同编号: recordId,
      合同金额: 10000,
      合同开始日期: '2026-01-01',
      合同结束日期: endDate,
      跟进人: [{ name: '示例人员008' }],
      专业类别: '电气',
    },
  };
}

describe('contract management mapper', () => {
  it('returns unsigned contracts separately from execution data and payment plans', () => {
    const signed = executionContract('signed-contract', '2026-12-31');
    signed.fields = {
      ...signed.fields,
      合同名称: '已签订维保合同',
      签订状态: '执行中',
    };
    const unsigned = executionContract('unsigned-contract', '2026-12-31');
    unsigned.fields = {
      ...unsigned.fields,
      合同名称: '未签订采购合同',
      签订状态: '未签订',
      框架引用: [{ record_ids: ['framework-for-unsigned'] }],
    };

    const dashboard = buildContractManagementDashboard({
      generatedAt: '2026-07-20T01:00:00.000Z',
      sourceUrl: 'https://example.test/base',
      frameworkContracts: [
        {
          record_id: 'framework-for-unsigned',
          fields: {
            合同名称: '未签订合同关联框架',
            合同编号: 'KJ-UNSIGNED',
            合同开始日期: '2026-01-01',
            合同结束日期: '2026-12-31',
          },
        },
      ],
      executionContracts: [signed, unsigned],
      suppliers: [
        {
          record_id: 'unsigned-supplier',
          fields: {
            公司单位: '未签订合同供应商',
            关联合同编号: [{ record_ids: ['unsigned-contract'] }],
          },
        },
        {
          record_id: 'string-array-unsigned-supplier',
          fields: {
            公司单位: '字符串数组未签订供应商',
            关联合同编号: ['unsigned-contract'],
          },
        },
        {
          record_id: 'mixed-link-supplier',
          fields: {
            公司单位: '混合关联供应商',
            关联合同编号: ['signed-contract', 'unsigned-contract'],
          },
        },
        {
          record_id: 'unlinked-supplier',
          fields: {
            公司单位: '无关联合同供应商',
          },
        },
      ],
      paymentPlans: [
        {
          record_id: 'signed-payment',
          fields: {
            合同编号: [{ record_ids: ['signed-contract'] }],
            付款计划: '已签订合同付款',
            计划付款日期: '2026-08-01',
            计划付款金额: 1000,
          },
        },
        {
          record_id: 'unsigned-payment',
          fields: {
            合同编号: [{ record_ids: ['unsigned-contract'] }],
            付款计划: '未签订合同付款',
            计划付款日期: '2026-08-01',
            计划付款金额: 2000,
          },
        },
      ],
      sectionStatus: {
        framework: { configured: true, count: 1 },
        contracts: { configured: true, count: 2 },
        suppliers: { configured: true, count: 4 },
        payments: { configured: true, count: 2 },
      },
      now: new Date('2026-07-20T01:00:00.000Z'),
    });

    expect(dashboard.contracts.map((item) => item.recordId)).toEqual([
      'signed-contract',
    ]);
    expect(dashboard.unsignedContracts.map((item) => item.recordId)).toEqual([
      'unsigned-contract',
    ]);
    expect(dashboard.payments.map((item) => item.recordId)).toEqual([
      'signed-payment',
    ]);
    expect(dashboard.summary.totalContracts).toBe(1);
    expect(dashboard.summary.totalValue).toBe(10000);
    expect(dashboard.summary.supplierCount).toBe(2);
    expect(dashboard.supplierDirectory.summary).toMatchObject({
      totalSuppliers: 2,
      directoryEntries: 2,
      linkedContracts: 1,
    });
    expect(
      dashboard.supplierDirectory.items.map((item) => item.name),
    ).toEqual(
      expect.arrayContaining(['混合关联供应商', '无关联合同供应商']),
    );
    expect(
      dashboard.supplierDirectory.items.map((item) => item.name),
    ).not.toEqual(
      expect.arrayContaining(['未签订合同供应商', '字符串数组未签订供应商']),
    );
    expect(
      dashboard.frameworkRelations.items.flatMap((item) =>
        item.executionContracts.map((contract) => contract.recordId),
      ),
    ).not.toContain('unsigned-contract');
    expect(dashboard.paymentDataQuality.missingContract).toBe(0);
  });

  it('sorts signed execution contracts from active through expired', () => {
    const active = executionContract('active-contract', '2026-12-31');
    const expiring = executionContract('expiring-contract', '2026-08-20');
    const pending = executionContract('pending-contract', '2026-12-31');
    pending.fields = {
      ...pending.fields,
      合同开始日期: '2026-08-01',
    };
    const unknown = executionContract('unknown-contract', '');
    unknown.fields = {
      ...unknown.fields,
      合同开始日期: '',
      合同结束日期: '',
    };
    const expired = executionContract('expired-contract', '2026-06-30');

    const dashboard = buildContractManagementDashboard({
      generatedAt: '2026-07-20T01:00:00.000Z',
      sourceUrl: 'https://example.test/base',
      frameworkContracts: [],
      executionContracts: [expired, unknown, pending, expiring, active],
      suppliers: [],
      paymentPlans: [],
      sectionStatus: {
        framework: { configured: true, count: 0 },
        contracts: { configured: true, count: 5 },
        suppliers: { configured: true, count: 0 },
        payments: { configured: true, count: 0 },
      },
      now: new Date('2026-07-20T01:00:00.000Z'),
    });

    expect(dashboard.contracts.map((item) => item.recordId)).toEqual([
      'active-contract',
      'expiring-contract',
      'pending-contract',
      'unknown-contract',
      'expired-contract',
    ]);
  });

  it('excludes unsigned draft rows when the source omits signing status', () => {
    const signed = executionContract('signed-contract', '2026-12-31');
    const unsignedDraft = {
      record_id: 'unsigned-draft',
      fields: {
        合同名称: [{ text: '园区无线对讲覆盖', type: 'text' }],
        付款计划: { link_record_ids: ['draft-payment'] },
        供应商: {},
      },
    };

    const dashboard = buildContractManagementDashboard({
      generatedAt: '2026-07-20T01:00:00.000Z',
      sourceUrl: 'https://example.test/base',
      frameworkContracts: [],
      executionContracts: [signed, unsignedDraft],
      suppliers: [],
      paymentPlans: [
        {
          record_id: 'draft-payment',
          fields: {
            合同编号: { link_record_ids: ['unsigned-draft'] },
            付款计划: '草稿合同付款',
            计划付款日期: '2026-08-01',
            计划付款金额: 2000,
          },
        },
      ],
      sectionStatus: {
        framework: { configured: true, count: 0 },
        contracts: { configured: true, count: 2 },
        suppliers: { configured: true, count: 0 },
        payments: { configured: true, count: 1 },
      },
      now: new Date('2026-07-20T01:00:00.000Z'),
    });

    expect(dashboard.contracts.map((item) => item.recordId)).toEqual([
      'signed-contract',
    ]);
    expect(dashboard.payments).toEqual([]);
    expect(dashboard.paymentFollowUps).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ contractRecordId: 'unsigned-draft' }),
      ]),
    );
  });

  it('maps payment links returned by the Feishu records search API', () => {
    const dashboard = buildContractManagementDashboard({
      generatedAt: '2026-07-20T01:00:00.000Z',
      sourceUrl: 'https://example.test/base',
      frameworkContracts: [],
      executionContracts: [
        executionContract('contract-with-real-link-shape', '2026-12-31'),
      ],
      suppliers: [],
      paymentPlans: [
        {
          record_id: 'payment-with-real-link-shape',
          fields: {
            合同编号: {
              link_record_ids: ['contract-with-real-link-shape'],
            },
            付款周期: '一次性',
            计划付款金额: 1000,
            实际付款金额: 0,
            计划付款日期: '2026-08-20',
            付款状态: '未付款',
          },
        },
      ],
      sectionStatus: {
        framework: { configured: true, count: 0 },
        contracts: { configured: true, count: 1 },
        suppliers: { configured: true, count: 0 },
        payments: { configured: true, count: 1 },
      },
      now: new Date('2026-07-20T01:00:00.000Z'),
    });

    expect(dashboard.payments[0]).toMatchObject({
      contractRecordId: 'contract-with-real-link-shape',
      contractName: '合同-contract-with-real-link-shape',
    });
    expect(dashboard.paymentFollowUps).not.toContainEqual(
      expect.objectContaining({
        contractRecordId: 'contract-with-real-link-shape',
        reason: 'missing_plan',
      }),
    );
  });

  it('uses only the planned payment date for payment risk and due date', () => {
    const dashboard = buildContractManagementDashboard({
      generatedAt: '2026-07-15T01:00:00.000Z',
      sourceUrl: 'https://example.test/base',
      frameworkContracts: [],
      executionContracts: [
        executionContract('contract-with-plan', '2026-12-31'),
      ],
      suppliers: [],
      paymentPlans: [
        {
          record_id: 'payment-with-distinct-dates',
          fields: {
            合同编号: [{ record_ids: ['contract-with-plan'] }],
            付款周期: '一期',
            计划付款金额: 1000,
            实际付款金额: 0,
            计划付款日期: '2026-07-20',
            付款日期: '2026-07-10',
            付款状态: '未付款',
          },
        },
      ],
      sectionStatus: {
        framework: { configured: true, count: 0 },
        contracts: { configured: true, count: 1 },
        suppliers: { configured: true, count: 0 },
        payments: { configured: true, count: 1 },
      },
      now: new Date('2026-07-15T01:00:00.000Z'),
    });

    expect(dashboard.payments[0]).toMatchObject({
      dueDate: '2026-07-20',
      daysUntilDue: 5,
      risk: 'dueSoon',
    });
  });

  it('keeps upcoming 60-day risks and excludes expired contracts', () => {
    const dashboard = buildContractManagementDashboard({
      generatedAt: '2026-07-11T01:00:00.000Z',
      sourceUrl: 'https://example.test/base',
      frameworkContracts: [],
      executionContracts: [
        executionContract('expired-within-30-days', '2026-06-30'),
        executionContract('expired-more-than-30-days', '2026-06-10'),
        executionContract('due-in-60-days', '2026-09-09'),
        executionContract('due-in-61-days', '2026-09-10'),
      ],
      suppliers: [],
      paymentPlans: [],
      sectionStatus: {
        framework: { configured: true, count: 0 },
        contracts: { configured: true, count: 4 },
        suppliers: { configured: true, count: 0 },
        payments: { configured: true, count: 0 },
      },
      now: new Date('2026-07-11T01:00:00.000Z'),
    });

    expect(dashboard.contractRisks.map((item) => item.recordId)).toEqual([
      'due-in-60-days',
    ]);
  });

  it('builds overview breakdowns from active and expiring contracts only', () => {
    const activeContract = executionContract(
      'active-overview-contract',
      '2026-12-31',
    );
    const expiringContract = executionContract(
      'expiring-overview-contract',
      '2026-08-20',
    );
    const expiredContract = executionContract(
      'expired-overview-contract',
      '2026-06-30',
    );
    activeContract.fields = {
      ...activeContract.fields,
      合同类型: '有效维保合同',
      专业类别: '有效专业',
    };
    expiringContract.fields = {
      ...expiringContract.fields,
      合同类型: '有效维修合同',
      专业类别: '有效专业',
    };
    expiredContract.fields = {
      ...expiredContract.fields,
      合同类型: '失效合同类型',
      专业类别: '失效专业',
    };

    const dashboard = buildContractManagementDashboard({
      generatedAt: '2026-07-20T01:00:00.000Z',
      sourceUrl: 'https://example.test/base',
      frameworkContracts: [],
      executionContracts: [
        activeContract,
        expiringContract,
        expiredContract,
      ],
      suppliers: [],
      paymentPlans: [],
      sectionStatus: {
        framework: { configured: true, count: 0 },
        contracts: { configured: true, count: 3 },
        suppliers: { configured: true, count: 0 },
        payments: { configured: true, count: 0 },
      },
      now: new Date('2026-07-20T01:00:00.000Z'),
    });

    expect(
      dashboard.typeBreakdown.map((item) => item.contractType),
    ).toEqual(expect.arrayContaining(['有效维保合同', '有效维修合同']));
    expect(
      dashboard.typeBreakdown.map((item) => item.contractType),
    ).not.toContain('失效合同类型');
    expect(dashboard.specialtyBreakdown).toEqual([
      expect.objectContaining({
        specialty: '有效专业',
        count: 2,
        percentage: 100,
      }),
    ]);
  });

  it('uses the Shanghai calendar day during Beijing early morning', () => {
    const dashboard = buildContractManagementDashboard({
      generatedAt: '2026-07-13T16:30:00.000Z',
      sourceUrl: 'https://example.test/base',
      frameworkContracts: [],
      executionContracts: [
        executionContract('expired-in-shanghai', '2026-07-13'),
      ],
      suppliers: [],
      paymentPlans: [],
      sectionStatus: {
        framework: { configured: true, count: 0 },
        contracts: { configured: true, count: 1 },
        suppliers: { configured: true, count: 0 },
        payments: { configured: true, count: 0 },
      },
      now: new Date('2026-07-13T16:30:00.000Z'),
    });

    expect(dashboard.summary.expiredContracts).toBe(1);
    expect(dashboard.contracts).toEqual([
      expect.objectContaining({
        recordId: 'expired-in-shanghai',
        status: 'expired',
      }),
    ]);
    expect(dashboard.paymentFollowUps).toEqual([
      expect.objectContaining({
        contractRecordId: 'expired-in-shanghai',
        reason: 'missing_plan',
      }),
    ]);
  });

  it('aggregates payment requirements, progress and attachments for active contracts', () => {
    const source = executionContract('active-contract', '2026-12-31');
    source.fields = {
      ...source.fields,
      付款计划: [
        {
          table_id: 'tbl-payments',
          record_ids: ['payment-1', 'payment-2'],
          text: '两期付款',
        },
      ],
      合同附件: [
        {
          name: '维保合同.pdf',
          tmp_url: 'https://example.test/contract.pdf',
          file_token: 'file-token',
        },
      ],
    };
    const dashboard = buildContractManagementDashboard({
      generatedAt: '2026-07-11T01:00:00.000Z',
      sourceUrl: 'https://example.test/base',
      frameworkContracts: [],
      executionContracts: [source],
      suppliers: [],
      paymentPlans: [
        {
          record_id: 'payment-1',
          fields: {
            合同编号: [{ record_ids: ['active-contract'] }],
            付款计划: [{ text: '首付款' }],
            付款周期: '合同签订后',
            计划付款日期: '2026-07-20',
            计划付款金额: 6000,
            实际付款金额: 6000,
            付款状态: '已付款',
          },
        },
        {
          record_id: 'payment-2',
          fields: {
            合同编号: [{ record_ids: ['active-contract'] }],
            付款计划: [{ text: '尾款' }],
            付款周期: '',
            计划付款日期: '2026-12-20',
            计划付款金额: 4000,
            实际付款金额: 0,
            付款状态: '未付款',
          },
        },
      ],
      sectionStatus: {
        framework: { configured: true, count: 0 },
        contracts: { configured: true, count: 1 },
        suppliers: { configured: true, count: 0 },
        payments: { configured: true, count: 2 },
      },
      now: new Date('2026-07-11T01:00:00.000Z'),
    });

    expect(dashboard.contracts).toHaveLength(1);
    expect(dashboard.contracts[0]).toMatchObject({
      paymentCycle: '二期',
      paymentRequirement:
        '合同签订后 · 2026-07-20；按约定日期付款 · 2026-12-20',
      paymentProgress: {
        plannedAmount: 10000,
        paidAmount: 6000,
        completionRate: 60,
      },
      attachments: [
        {
          name: '维保合同.pdf',
          accessId: '',
          previewStatus: 'processing',
          pageCount: 0,
        },
      ],
    });
  });

  it('keeps expired contracts in history but excludes them from risk overview', () => {
    const dashboard = buildContractManagementDashboard({
      generatedAt: '2026-07-11T01:00:00.000Z',
      sourceUrl: 'https://example.test/base',
      frameworkContracts: [],
      executionContracts: [executionContract('expired', '2026-07-01')],
      suppliers: [],
      paymentPlans: [],
      sectionStatus: {
        framework: { configured: true, count: 0 },
        contracts: { configured: true, count: 1 },
        suppliers: { configured: true, count: 0 },
        payments: { configured: true, count: 0 },
      },
      now: new Date('2026-07-11T01:00:00.000Z'),
    });

    expect(dashboard.contracts).toEqual([
      expect.objectContaining({ recordId: 'expired', status: 'expired' }),
    ]);
    expect(dashboard.contractRisks).toEqual([]);
  });

  it('builds framework relations only from real linked record ids', () => {
    const linked = executionContract('linked-contract', '2026-12-31');
    linked.fields = {
      ...linked.fields,
      合同名称: '配电设备执行合同',
      合同编号: 'ZX-001',
      合同公司: '南通配电有限公司',
      跟进人: [{ name: '示例人员013' }],
      框架引用: [{ record_ids: ['framework-1', 'missing-framework'] }],
    };
    const expiredLinked = executionContract('expired-linked', '2026-06-30');
    expiredLinked.fields = {
      ...expiredLinked.fields,
      合同名称: '历史配电执行合同',
      合同编号: 'ZX-002',
      合同公司: '南通历史设备有限公司',
      跟进人: [{ name: '示例人员017' }],
      框架引用: [{ record_ids: ['framework-1'] }],
    };
    const sameNameButUnlinked = executionContract(
      'same-name-but-unlinked',
      '2026-12-31',
    );
    sameNameButUnlinked.fields = {
      ...sameNameButUnlinked.fields,
      合同名称: '配电设备框架协议',
      合同编号: 'KJ-001',
    };
    const dashboard = buildContractManagementDashboard({
      generatedAt: '2026-07-11T01:00:00.000Z',
      sourceUrl: 'https://example.test/base',
      frameworkContracts: [
        {
          record_id: 'framework-1',
          fields: {
            合同名称: '配电设备框架协议',
            合同编号: 'KJ-001',
            合同开始日期: '2026-01-01',
            合同结束日期: '2026-12-31',
            '01-执行合同信息': [
              {
                record_ids: [
                  'linked-contract',
                  'missing-contract',
                  'linked-contract',
                ],
              },
            ],
          },
        },
        {
          record_id: 'framework-2',
          fields: {
            合同名称: '消防服务框架协议',
            合同编号: 'KJ-002',
            合同开始日期: '2026-01-01',
            合同结束日期: '2026-11-30',
          },
        },
        {
          record_id: 'framework-3',
          fields: {
            合同名称: '历史维保框架协议',
            合同编号: 'KJ-003',
            合同开始日期: '2026-01-01',
            合同结束日期: '2026-06-30',
          },
        },
      ],
      executionContracts: [linked, expiredLinked, sameNameButUnlinked],
      suppliers: [],
      paymentPlans: [],
      sectionStatus: {
        framework: { configured: true, count: 3 },
        contracts: { configured: true, count: 3 },
        suppliers: { configured: true, count: 0 },
        payments: { configured: true, count: 0 },
      },
      now: new Date('2026-07-11T01:00:00.000Z'),
    });

    expect(dashboard.frameworkRelations.summary).toEqual({
      totalFrameworks: 3,
      activeFrameworks: 2,
      linkedFrameworks: 1,
      unlinkedFrameworks: 2,
      linkedExecutionContracts: 2,
      linkedExecutionAmount: 20000,
    });
    expect(
      dashboard.frameworkRelations.items.map((item) => item.frameworkRecordId),
    ).toEqual(['framework-2', 'framework-1', 'framework-3']);

    const linkedFramework = dashboard.frameworkRelations.items.find(
      (item) => item.frameworkRecordId === 'framework-1',
    );
    expect(linkedFramework).toMatchObject({
      frameworkRecordId: 'framework-1',
      frameworkName: '配电设备框架协议',
      status: 'active',
      daysRemaining: 173,
      executionAmount: 20000,
      executionContracts: [
        {
          recordId: 'linked-contract',
          name: '配电设备执行合同',
          code: 'ZX-001',
          amount: 10000,
          status: 'active',
          supplier: '南通配电有限公司',
          owner: '示例人员013',
          endDate: '2026-12-31',
        },
        {
          recordId: 'expired-linked',
          name: '历史配电执行合同',
          code: 'ZX-002',
          amount: 10000,
          status: 'expired',
          supplier: '南通历史设备有限公司',
          owner: '示例人员017',
          endDate: '2026-06-30',
        },
      ],
    });
    expect(
      linkedFramework?.executionContracts.filter(
        (item) => item.recordId === 'linked-contract',
      ),
    ).toHaveLength(1);

    expect(
      dashboard.frameworkRelations.items.find(
        (item) => item.frameworkRecordId === 'framework-2',
      ),
    ).toMatchObject({
      status: 'active',
      daysRemaining: 142,
      executionAmount: 0,
      executionContracts: [],
    });
    expect(
      dashboard.frameworkRelations.items.find(
        (item) => item.frameworkRecordId === 'framework-3',
      ),
    ).toMatchObject({
      status: 'expired',
      daysRemaining: -11,
      executionAmount: 0,
      executionContracts: [],
    });
    expect(
      dashboard.frameworkRelations.items.flatMap((item) =>
        item.executionContracts.map((contract) => contract.recordId),
      ),
    ).toEqual(['linked-contract', 'expired-linked']);
  });

  it('deduplicates linked execution amount across frameworks by record id', () => {
    const sharedExecution = executionContract(
      'shared-execution-contract',
      '2026-12-31',
    );
    sharedExecution.fields = {
      ...sharedExecution.fields,
      框架引用: [{ record_ids: ['framework-a', 'framework-b'] }],
    };

    const dashboard = buildContractManagementDashboard({
      generatedAt: '2026-07-11T01:00:00.000Z',
      sourceUrl: 'https://example.test/base',
      frameworkContracts: [
        {
          record_id: 'framework-a',
          fields: {
            合同名称: '框架合同 A',
            合同编号: 'KJ-A',
            合同开始日期: '2026-01-01',
            合同结束日期: '2026-12-31',
          },
        },
        {
          record_id: 'framework-b',
          fields: {
            合同名称: '框架合同 B',
            合同编号: 'KJ-B',
            合同开始日期: '2026-01-01',
            合同结束日期: '2026-12-31',
          },
        },
      ],
      executionContracts: [sharedExecution],
      suppliers: [],
      paymentPlans: [],
      sectionStatus: {
        framework: { configured: true, count: 2 },
        contracts: { configured: true, count: 1 },
        suppliers: { configured: true, count: 0 },
        payments: { configured: true, count: 0 },
      },
      now: new Date('2026-07-11T01:00:00.000Z'),
    });

    expect(dashboard.frameworkRelations.summary).toMatchObject({
      linkedFrameworks: 2,
      linkedExecutionContracts: 1,
      linkedExecutionAmount: 10000,
    });
    expect(
      dashboard.frameworkRelations.items.map((item) => ({
        frameworkRecordId: item.frameworkRecordId,
        executionAmount: item.executionAmount,
        executionRecordIds: item.executionContracts.map(
          (contract) => contract.recordId,
        ),
      })),
    ).toEqual([
      {
        frameworkRecordId: 'framework-a',
        executionAmount: 10000,
        executionRecordIds: ['shared-execution-contract'],
      },
      {
        frameworkRecordId: 'framework-b',
        executionAmount: 10000,
        executionRecordIds: ['shared-execution-contract'],
      },
    ]);
  });

  it('aggregates supplier directory records by company and keeps real contract links', () => {
    const active = executionContract('active-contract', '2026-12-31');
    active.fields = {
      ...active.fields,
      合同名称: 'UPS 维保合同',
      合同编号: 'V-001',
      合同金额: 120000,
    };
    const expired = executionContract('expired-contract', '2026-07-01');
    expired.fields = {
      ...expired.fields,
      合同名称: '历史维修合同',
      合同编号: 'V-002',
      合同金额: 30000,
    };

    const dashboard = buildContractManagementDashboard({
      generatedAt: '2026-07-11T01:00:00.000Z',
      sourceUrl: 'https://example.test/base',
      frameworkContracts: [],
      executionContracts: [active, expired],
      suppliers: [
        {
          record_id: 'supplier-a-1',
          fields: {
            公司单位: '南通服务有限公司',
            联系人: '张经理',
            联系电话: '13800008135',
            园区对接人: [{ name: '曹李培' }],
            关联合同编号: [{ record_ids: ['active-contract'] }],
          },
        },
        {
          record_id: 'supplier-a-2',
          fields: {
            公司单位: '南通服务有限公司',
            联系人: '李经理',
            联系电话: '13800002356',
            园区对接人: [{ name: '周海洋' }],
            关联合同编号: [{ record_ids: ['expired-contract'] }],
          },
        },
        {
          record_id: 'supplier-b',
          fields: {
            公司单位: '开发区设备有限公司',
            联系人: '王经理',
            联系电话: '',
            园区对接人: [{ name: '曹李培' }],
            关联合同编号: [{ record_ids: ['active-contract'] }],
          },
        },
      ],
      paymentPlans: [],
      sectionStatus: {
        framework: { configured: true, count: 0 },
        contracts: { configured: true, count: 2 },
        suppliers: { configured: true, count: 3 },
        payments: { configured: true, count: 0 },
      },
      now: new Date('2026-07-11T01:00:00.000Z'),
    });

    expect(dashboard.summary.supplierCount).toBe(2);
    expect(dashboard.supplierDirectory.summary).toEqual({
      totalSuppliers: 2,
      directoryEntries: 3,
      linkedContracts: 2,
      contactsWithPhone: 2,
      phoneCoverageRate: 66.7,
    });
    expect(dashboard.supplierDirectory.items).toHaveLength(2);
    expect(
      dashboard.supplierDirectory.items.find(
        (item) => item.name === '南通服务有限公司',
      ),
    ).toMatchObject({
      directoryEntryCount: 2,
      contacts: [
        { name: '李经理', phone: '13800002356' },
        { name: '张经理', phone: '13800008135' },
      ],
      parkLiaisons: ['曹李培', '周海洋'],
      activeContractCount: 1,
      linkedContractAmount: 150000,
      relatedContracts: [
        {
          recordId: 'active-contract',
          code: 'V-001',
          startDate: '2026-01-01',
          endDate: '2026-12-31',
        },
        {
          recordId: 'expired-contract',
          code: 'V-002',
          startDate: '2026-01-01',
          endDate: '2026-07-01',
        },
      ],
    });
  });

  it('sums each payment node remainder without cross-node offsets', () => {
    const dashboard = buildContractManagementDashboard({
      generatedAt: '2026-07-11T01:00:00.000Z',
      sourceUrl: 'https://example.test/base',
      frameworkContracts: [],
      executionContracts: [executionContract('expired-contract', '2026-07-10')],
      suppliers: [],
      paymentPlans: [
        {
          record_id: 'overpaid-node',
          fields: {
            合同编号: [{ record_ids: ['expired-contract'] }],
            计划付款日期: '2026-07-01',
            计划付款金额: 100,
            实际付款金额: 150,
            付款状态: '已付款',
          },
        },
        {
          record_id: 'unpaid-node',
          fields: {
            合同编号: [{ record_ids: ['expired-contract'] }],
            计划付款日期: '2026-07-20',
            计划付款金额: 100,
            实际付款金额: 0,
            付款状态: '未付款',
          },
        },
      ],
      sectionStatus: {
        framework: { configured: true, count: 0 },
        contracts: { configured: true, count: 1 },
        suppliers: { configured: true, count: 0 },
        payments: { configured: true, count: 2 },
      },
      now: new Date('2026-07-11T01:00:00.000Z'),
    });

    expect(dashboard.summary).toMatchObject({
      plannedPaymentAmount: 200,
      paidAmount: 150,
      pendingPaymentAmount: 100,
    });
    expect(dashboard.paymentProgress.pendingAmount).toBe(100);
    expect(dashboard.contractPaymentSummaries).toEqual([
      expect.objectContaining({
        contractRecordId: 'expired-contract',
        pendingAmount: 100,
      }),
    ]);
    expect(dashboard.paymentFollowUps).toEqual([
      expect.objectContaining({
        contractRecordId: 'expired-contract',
        pendingAmount: 100,
      }),
    ]);
  });

  it('shows only actionable payment nodes and aggregates contract payment status', () => {
    const dashboard = buildContractManagementDashboard({
      generatedAt: '2026-07-11T01:00:00.000Z',
      sourceUrl: 'https://example.test/base',
      frameworkContracts: [],
      executionContracts: [executionContract('contract-1', '2026-12-31')],
      suppliers: [],
      paymentPlans: [
        {
          record_id: 'due-soon',
          fields: {
            合同编号: [{ record_ids: ['contract-1'] }],
            付款周期: '验收后',
            计划付款日期: '2026-07-20',
            计划付款金额: 6000,
            实际付款金额: 1000,
            付款状态: '未付款',
          },
        },
        {
          record_id: 'missing-date',
          fields: {
            合同编号: [{ record_ids: ['contract-1'] }],
            计划付款金额: 4000,
            实际付款金额: 0,
            付款状态: '未付款',
          },
        },
        {
          record_id: 'unlinked',
          fields: {
            计划付款日期: '2026-07-18',
            计划付款金额: 5000,
            实际付款金额: 0,
            付款状态: '未付款',
          },
        },
        {
          record_id: 'paid',
          fields: {
            合同编号: [{ record_ids: ['contract-1'] }],
            计划付款日期: '2026-07-19',
            计划付款金额: 3000,
            实际付款金额: 3000,
            付款状态: '已付款',
          },
        },
      ],
      sectionStatus: {
        framework: { configured: true, count: 0 },
        contracts: { configured: true, count: 1 },
        suppliers: { configured: true, count: 0 },
        payments: { configured: true, count: 4 },
      },
      now: new Date('2026-07-11T01:00:00.000Z'),
    });

    expect(dashboard.paymentRisks.map((item) => item.recordId)).toEqual([
      'due-soon',
    ]);
    expect(dashboard.paymentDataQuality).toEqual({
      missingContract: 1,
      pendingMissingDate: 1,
      zeroAmount: 0,
    });
    expect(dashboard.contractPaymentSummaries[0]).toMatchObject({
      contractRecordId: 'contract-1',
      plannedAmount: 13000,
      paidAmount: 4000,
      pendingAmount: 9000,
      completionRate: 30.8,
      totalPlans: 3,
      completedPlans: 1,
      pendingPlans: 2,
      nextDueDate: '2026-07-20',
    });
  });
});
