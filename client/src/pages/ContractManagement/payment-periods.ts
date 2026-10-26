import type { ContractPaymentItem } from '@shared/contract-management.interface';

export type ContractPaymentPeriodKey = 'year' | 'quarter' | 'month';

export interface ContractPaymentPeriodSummary {
  key: ContractPaymentPeriodKey;
  label: string;
  rangeLabel: string;
  plannedAmount: number;
  paidAmount: number;
  pendingAmount: number;
  completionRate: number;
  itemCount: number;
}

interface DateParts {
  year: number;
  month: number;
}

export function summarizeContractPaymentPeriods(
  payments: ContractPaymentItem[],
  generatedAt: string,
): ContractPaymentPeriodSummary[] {
  const reference = timestampParts(generatedAt);
  const quarter = quarterOf(reference.month);
  const definitions: Array<{
    key: ContractPaymentPeriodKey;
    label: string;
    rangeLabel: string;
    matches: (parts: DateParts) => boolean;
  }> = [
    {
      key: 'year',
      label: '本年度',
      rangeLabel: `${reference.year} 年`,
      matches: (parts) => parts.year === reference.year,
    },
    {
      key: 'quarter',
      label: '本季度',
      rangeLabel: `${reference.year} Q${quarter}`,
      matches: (parts) =>
        parts.year === reference.year && quarterOf(parts.month) === quarter,
    },
    {
      key: 'month',
      label: '本月',
      rangeLabel: `${reference.year}-${String(reference.month).padStart(2, '0')}`,
      matches: (parts) =>
        parts.year === reference.year && parts.month === reference.month,
    },
  ];

  return definitions.map((definition) => {
    const items = payments.filter((payment) => {
      const parts = dateParts(payment.dueDate);
      return parts ? definition.matches(parts) : false;
    });
    const plannedAmount = roundMoney(
      items.reduce((total, item) => total + item.plannedAmount, 0),
    );
    const paidAmount = roundMoney(
      items.reduce((total, item) => total + item.actualAmount, 0),
    );
    const pendingAmount = roundMoney(
      items.reduce(
        (total, item) =>
          total + Math.max(0, item.plannedAmount - item.actualAmount),
        0,
      ),
    );
    const fulfilledAmount = Math.max(0, plannedAmount - pendingAmount);
    return {
      key: definition.key,
      label: definition.label,
      rangeLabel: definition.rangeLabel,
      plannedAmount,
      paidAmount,
      pendingAmount,
      completionRate:
        plannedAmount > 0
          ? Math.min(
              100,
              Math.round((fulfilledAmount / plannedAmount) * 1000) / 10,
            )
          : 0,
      itemCount: items.length,
    };
  });
}

function timestampParts(value: string): DateParts {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return timestampParts(new Date().toISOString());
  }
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: 'numeric',
  }).formatToParts(date);
  return {
    year: Number(parts.find((part) => part.type === 'year')?.value),
    month: Number(parts.find((part) => part.type === 'month')?.value),
  };
}

function dateParts(value: string | null): DateParts | null {
  const matched = value?.match(/^(\d{4})-(\d{2})-\d{2}$/u);
  if (!matched) return null;
  const year = Number(matched[1]);
  const month = Number(matched[2]);
  if (month < 1 || month > 12) return null;
  return { year, month };
}

function quarterOf(month: number): number {
  return Math.floor((month - 1) / 3) + 1;
}

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}
