import {
  buildContractWorkflowCandidates,
  isContractWorkflowCode,
  shanghaiDateKey,
  type ContractWorkflowRecord,
} from './contract-workflow.rules';

const NOW = new Date('2026-07-11T01:05:00.000Z');

function contract(
  overrides: Partial<ContractWorkflowRecord> = {},
): ContractWorkflowRecord {
  return {
    recordId: 'rec-contract-1',
    kind: 'contract',
    name: '园区配电维保合同',
    code: 'HT-2026-001',
    ownerNames: ['示例人员008'],
    ownerOpenIds: ['ou_owner'],
    specialty: '电气',
    specialtyManagerOpenIds: ['ou_specialty'],
    amount: 120000,
    startDate: '2026-01-01',
    endDate: '2026-07-12',
    attachmentCount: 1,
    paymentPlanCount: 1,
    createdAt: '2026-07-11T00:30:00.000Z',
    ...overrides,
  };
}

function payment(
  overrides: Partial<ContractWorkflowRecord> = {},
): ContractWorkflowRecord {
  return {
    recordId: 'rec-payment-1',
    kind: 'payment',
    name: '第二期付款',
    code: 'HT-2026-001',
    ownerNames: ['示例人员008'],
    ownerOpenIds: ['ou_owner'],
    specialty: '电气',
    specialtyManagerOpenIds: ['ou_specialty'],
    amount: 30000,
    startDate: null,
    endDate: '2026-07-12',
    attachmentCount: 0,
    paymentPlanCount: 0,
    createdAt: '2026-06-01T00:00:00.000Z',
    paymentStatus: '未付款',
    actualAmount: 0,
    ...overrides,
  };
}

describe('contract workflow rules', () => {
  it('accepts only the two reminder workflows', () => {
    expect(isContractWorkflowCode('payment_due_reminder')).toBe(true);
    expect(isContractWorkflowCode('contract_expiry_reminder')).toBe(true);
    expect(isContractWorkflowCode('new_contract_push')).toBe(false);
  });

  it('uses the Asia/Shanghai business date', () => {
    expect(shanghaiDateKey(new Date('2026-07-10T16:30:00.000Z'))).toBe(
      '2026-07-11',
    );
  });

  it('selects only unpaid payment plans due tomorrow', () => {
    const candidates = buildContractWorkflowCandidates({
      workflow: 'payment_due_reminder',
      records: [
        payment(),
        payment({
          recordId: 'paid',
          paymentStatus: '已付款',
          actualAmount: 30000,
        }),
        payment({ recordId: 'later', endDate: '2026-07-13' }),
      ],
      now: NOW,
      baselineAt: null,
      processedKeys: new Set(),
    });

    expect(candidates.map((item) => item.record.recordId)).toEqual([
      'rec-payment-1',
    ]);
    expect(candidates[0].dedupeKey).toBe(
      'payment_due_reminder:rec-payment-1:2026-07-12',
    );
  });

  it('requires the original contract reminder fields and skips processed records', () => {
    const valid = contract();
    const processedKey = 'contract_expiry_reminder:rec-contract-1:2026-07-12';
    const candidates = buildContractWorkflowCandidates({
      workflow: 'contract_expiry_reminder',
      records: [
        valid,
        contract({
          recordId: 'missing-owner',
          ownerNames: [],
          ownerOpenIds: [],
        }),
      ],
      now: NOW,
      baselineAt: null,
      processedKeys: new Set([processedKey]),
    });

    expect(candidates).toEqual([]);
  });
});
