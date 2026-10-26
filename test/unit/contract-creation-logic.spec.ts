import type {
  ContractCreateOptionsResponse,
  ContractCreateValue,
} from '../../shared/contract-management.interface';
import {
  buildContractCreateRequest,
  createEmptyContractDraft,
  fuzzyContractOptions,
  fuzzySupplierOptions,
  validateContractDraft,
  type ContractCreateDraft,
} from '../../client/src/pages/ContractManagement/contract-creation.logic';

const options: ContractCreateOptionsResponse = {
  kind: 'execution',
  fields: [
    field('fld-code', '合同编号', true),
    field('fld-name', '合同名称', true),
    field('fld-owner', '跟进人', true, 'user'),
    field('fld-type', '合同类型', true, 'select'),
    field('fld-file', '合同附件', true, 'attachment'),
  ],
  supplierFields: [field('fld-company', '公司单位', true)],
  frameworks: [
    {
      recordId: 'rec-framework',
      name: 'UPS 年度框架',
      code: 'UPS-2026',
      startDate: '2026-01-01',
      endDate: '2026-12-31',
    },
    {
      recordId: 'rec-other',
      name: '消防框架',
      code: 'FIRE-001',
      startDate: '2026-01-01',
      endDate: '2026-12-31',
    },
  ],
  suppliers: [
    { recordId: 'rec-supplier', name: '南通 UPS 服务有限公司', contacts: [] },
    { recordId: 'rec-other-supplier', name: '消防供应商', contacts: [] },
  ],
  people: [{ openId: 'ou_owner', name: '合同负责人' }],
  upload: {
    accept: 'application/pdf',
    required: true,
    maxFiles: 5,
    maxFileSize: 20 * 1024 * 1024,
  },
};

describe('contract creation draft logic', () => {
  it('fuzzy matches active frameworks and suppliers by normalized labels', () => {
    expect(
      fuzzyContractOptions(options.frameworks, 'ups 2026').map(
        (item) => item.recordId,
      ),
    ).toEqual(['rec-framework']);
    expect(
      fuzzySupplierOptions(options.suppliers, '南通ups').map(
        (item) => item.recordId,
      ),
    ).toEqual(['rec-supplier']);
  });

  it('validates conditional framework, supplier and PDF requirements', () => {
    const draft = baseDraft({
      linkFramework: true,
      frameworkRecordId: '',
      supplierRecordId: '',
      attachments: [],
    });
    expect(validateContractDraft(draft, options)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'frameworkRecordId' }),
        expect.objectContaining({ path: 'supplierRecordId' }),
        expect.objectContaining({ path: 'attachments' }),
      ]),
    );
  });

  it('requires every execution payment plan field', () => {
    expect(
      validateContractDraft(baseDraft({ paymentPlans: [] }), options),
    ).toContainEqual(
      expect.objectContaining({ path: 'paymentPlans' }),
    );
    expect(
      validateContractDraft(
        baseDraft({
          paymentPlans: [
            {
              period: '',
              plannedAmount: '',
              plannedPaymentDate: '',
              ownerOpenId: '',
            },
          ],
        }),
        options,
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'paymentPlans.0.period' }),
        expect.objectContaining({ path: 'paymentPlans.0.plannedAmount' }),
        expect.objectContaining({
          path: 'paymentPlans.0.plannedPaymentDate',
        }),
        expect.objectContaining({ path: 'paymentPlans.0.ownerOpenId' }),
      ]),
    );
  });

  it('initializes one payment plan only for execution contracts', () => {
    expect(createEmptyContractDraft('execution').paymentPlans).toHaveLength(1);
    expect(createEmptyContractDraft('framework').paymentPlans).toEqual([]);
  });

  it('builds a typed execution request without UI-only state', () => {
    const request = buildContractCreateRequest(
      baseDraft({
        frameworkRecordId: 'rec-framework',
        supplierRecordId: 'rec-supplier',
      }),
      '6b8fbc5a-1047-4e40-b083-906960893894',
    );
    expect(request).toEqual({
      kind: 'execution',
      idempotencyKey: '6b8fbc5a-1047-4e40-b083-906960893894',
      fields: expect.objectContaining({ 'fld-code': 'VNET-001' }),
      supplier: { mode: 'existing', recordId: 'rec-supplier' },
      linkFramework: true,
      frameworkRecordId: 'rec-framework',
      paymentPlans: [
        {
          period: '一期',
          plannedAmount: 128000,
          plannedPaymentDate: '2026-08-15',
          ownerOpenId: 'ou_owner',
        },
      ],
    });
  });

  it('omits payment plans from framework contract requests', () => {
    const request = buildContractCreateRequest(
      baseDraft({
        kind: 'framework',
        linkFramework: false,
        frameworkRecordId: '',
        paymentPlans: [],
      }),
      '7f8fbc5a-1047-4e40-b083-906960893895',
    );

    expect(request).not.toHaveProperty('paymentPlans');
  });
});

function baseDraft(
  overrides: Partial<ContractCreateDraft> = {},
): ContractCreateDraft {
  return {
    kind: 'execution',
    fields: {
      'fld-code': 'VNET-001',
      'fld-name': 'UPS 维保',
      'fld-owner': 'ou_owner',
      'fld-type': '维保合同',
    },
    linkFramework: true,
    frameworkRecordId: 'rec-framework',
    supplierMode: 'existing',
    supplierRecordId: 'rec-supplier',
    supplierFields: {},
    paymentPlans: [
      {
        period: '一期',
        plannedAmount: 128000,
        plannedPaymentDate: '2026-08-15',
        ownerOpenId: 'ou_owner',
      },
    ],
    attachments: [
      {
        name: '合同.pdf',
        type: 'application/pdf',
        size: 1024,
      } as File,
    ],
    ...overrides,
  };
}

function field(
  fieldId: string,
  name: string,
  required: boolean,
  control: ContractCreateOptionsResponse['fields'][number]['control'] = 'text',
) {
  return {
    fieldId,
    name,
    required,
    control,
    multiple: false,
    group: control === 'attachment' ? ('attachment' as const) : ('basic' as const),
    inputType: 'text' as const,
    options: control === 'select' ? [{ value: '维保合同', label: '维保合同' }] : [],
  };
}

void ({} as Record<string, ContractCreateValue>);
