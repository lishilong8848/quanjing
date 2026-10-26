import * as fs from 'node:fs';
import * as path from 'node:path';

import { summarizeContractPaymentPeriods } from '../../client/src/pages/ContractManagement/payment-periods';
import type { ContractPaymentItem } from '../../shared/contract-management.interface';

const root = path.resolve(__dirname, '../..');

function payment(
  recordId: string,
  dueDate: string | null,
  plannedAmount: number,
  actualAmount: number,
): ContractPaymentItem {
  return {
    recordId,
    contractRecordId: 'contract-1',
    contractName: '测试合同',
    contractCode: 'HT-001',
    label: recordId,
    cycle: '',
    dueDate,
    plannedAmount,
    actualAmount,
    status: actualAmount >= plannedAmount ? '已付款' : '未付款',
    risk: actualAmount >= plannedAmount ? 'completed' : 'normal',
    daysUntilDue: null,
    owner: '测试人',
  };
}

describe('contract payment period rings', () => {
  it('aggregates current year, quarter and month by payment date', () => {
    const result = summarizeContractPaymentPeriods(
      [
        payment('july', '2026-07-05', 100, 100),
        payment('august', '2026-08-05', 200, 50),
        payment('april', '2026-04-05', 300, 150),
        payment('previous-year', '2025-12-31', 400, 400),
        payment('undated', null, 500, 0),
      ],
      '2026-07-13T10:00:00+08:00',
    );

    expect(result).toEqual([
      expect.objectContaining({
        key: 'year',
        label: '本年度',
        rangeLabel: '2026 年',
        plannedAmount: 600,
        paidAmount: 300,
        pendingAmount: 300,
        completionRate: 50,
        itemCount: 3,
      }),
      expect.objectContaining({
        key: 'quarter',
        label: '本季度',
        rangeLabel: '2026 Q3',
        plannedAmount: 300,
        paidAmount: 150,
        pendingAmount: 150,
        completionRate: 50,
        itemCount: 2,
      }),
      expect.objectContaining({
        key: 'month',
        label: '本月',
        rangeLabel: '2026-07',
        plannedAmount: 100,
        paidAmount: 100,
        pendingAmount: 0,
        completionRate: 100,
        itemCount: 1,
      }),
    ]);
  });

  it('does not let an overpaid node offset another unpaid node', () => {
    const [year, quarter, month] = summarizeContractPaymentPeriods(
      [
        payment('overpaid', '2026-07-05', 100, 150),
        payment('unpaid', '2026-07-20', 100, 0),
      ],
      '2026-07-13T10:00:00+08:00',
    );

    for (const period of [year, quarter, month]) {
      expect(period).toMatchObject({
        plannedAmount: 200,
        paidAmount: 150,
        pendingAmount: 100,
        completionRate: 50,
        itemCount: 2,
      });
    }
  });

  it('renders three aligned rings without contract-level detail rows', () => {
    const pageSource = fs.readFileSync(
      path.join(root, 'client/src/pages/ContractManagement/index.tsx'),
      'utf8',
    );
    const helperSource = fs.readFileSync(
      path.join(root, 'client/src/pages/ContractManagement/payment-periods.ts'),
      'utf8',
    );

    expect(pageSource).toContain('summarizeContractPaymentPeriods');
    expect(pageSource).toContain('xl:grid-cols-2');
    expect(pageSource).toContain('grid gap-3 sm:grid-cols-3');
    expect(helperSource).toContain("label: '本年度'");
    expect(helperSource).toContain("label: '本季度'");
    expect(helperSource).toContain("label: '本月'");
    expect(pageSource).not.toContain('合同级付款进度');
    expect(pageSource).not.toContain('dashboard.contractPaymentSummaries');
  });
});
