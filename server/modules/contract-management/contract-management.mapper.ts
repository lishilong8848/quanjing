import { businessRecordBuilding } from '../../common/access/professional-record-scope';
import type {
  ContractBreakdownItem,
  ContractManagementDashboard,
  ContractManagementItem,
  ContractPaymentItem,
  ContractPaymentRisk,
  ContractStatus,
} from '../../../shared/contract-management.interface';

interface BitableRecordItem {
  id?: string;
  record_id?: string;
  fields?: Record<string, unknown>;
}

export interface BuildContractManagementDashboardInput {
  generatedAt: string;
  sourceUrl: string;
  frameworkContracts: BitableRecordItem[];
  executionContracts: BitableRecordItem[];
  suppliers: BitableRecordItem[];
  paymentPlans: BitableRecordItem[];
  sectionStatus: ContractManagementDashboard['sectionStatus'];
  now?: Date;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const SHANGHAI_DATE_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export function buildContractManagementDashboard(
  input: BuildContractManagementDashboardInput,
): ContractManagementDashboard {
  const now = input.now ?? new Date();
  const unsignedContractRecords = input.executionContracts.filter(
    isUnsignedContractRecord,
  );
  const unsignedContractIds = new Set(
    unsignedContractRecords.map(getRecordId).filter(Boolean),
  );
  const ineligibleContractIds = new Set(
    input.executionContracts
      .filter((record) => !isEligibleExecutionContractRecord(record))
      .map(getRecordId)
      .filter(Boolean),
  );
  const executionContractRecords = input.executionContracts.filter(
    isEligibleExecutionContractRecord,
  );
  const unsignedContracts = unsignedContractRecords.map((record, index) =>
    mapContract(record, index, now),
  );
  const baseContracts = executionContractRecords
    .map((record, index) => mapContract(record, index, now))
    .sort(compareContractRisk);
  const contractIndex = new Map(
    baseContracts.map((item) => [item.recordId, item]),
  );
  const payments = input.paymentPlans
    .map((record, index) => mapPayment(record, index, contractIndex, now))
    .filter((payment) => !ineligibleContractIds.has(payment.contractRecordId))
    .sort(comparePaymentRisk);
  const contracts = baseContracts.map((contract) =>
    enrichContractPayments(contract, payments),
  );
  const overviewContracts = contracts.filter(
    (contract) =>
      contract.status === 'active' || contract.status === 'expiring',
  );
  const enrichedContractIndex = new Map(
    contracts.map((contract) => [contract.recordId, contract]),
  );
  const frameworkRelations = buildFrameworkRelations(
    input.frameworkContracts,
    executionContractRecords,
    enrichedContractIndex,
    now,
  );
  const supplierDirectory = buildSupplierDirectory(
    input.suppliers.filter(
      (record) => !isSupplierRecordLinkedOnlyTo(record, unsignedContractIds),
    ),
    enrichedContractIndex,
  );
  const contractPaymentSummaries = buildContractPaymentSummaries(
    payments,
    enrichedContractIndex,
  );
  const paymentFollowUps = buildPaymentFollowUps(contracts, payments);
  const paymentDataQuality = buildPaymentDataQuality(
    payments,
    enrichedContractIndex,
  );
  const paymentRisks = payments.filter(
    (item) =>
      enrichedContractIndex.has(item.contractRecordId) &&
      !isNoPaymentRequired(
        enrichedContractIndex.get(item.contractRecordId)
          ?.paymentFollowUpDisposition,
      ) &&
      item.plannedAmount > 0 &&
      (item.risk === 'overdue' || item.risk === 'dueSoon'),
  );
  const frameworkStatuses = input.frameworkContracts.map((record) =>
    contractStatus(
      date(record.fields || {}, ['合同开始日期']),
      date(record.fields || {}, ['合同结束日期']),
      now,
    ),
  );
  const totalValue = roundMoney(sum(contracts, (item) => item.amount));
  const plannedPaymentAmount = roundMoney(
    sum(payments, (item) => item.plannedAmount),
  );
  const paidAmount = roundMoney(sum(payments, (item) => item.actualAmount));
  const pendingPaymentAmount = calculatePendingPaymentAmount(payments);

  return {
    generatedAt: input.generatedAt,
    sourceUrl: input.sourceUrl,
    summary: {
      totalContracts: contracts.length,
      activeContracts: count(contracts, (item) => item.status === 'active'),
      expiringContracts: count(contracts, (item) => item.status === 'expiring'),
      expiredContracts: count(contracts, (item) => item.status === 'expired'),
      pendingContracts: count(contracts, (item) => item.status === 'pending'),
      totalValue,
      frameworkContracts: input.frameworkContracts.length,
      activeFrameworkContracts: frameworkStatuses.filter(
        (status) => status === 'active' || status === 'expiring',
      ).length,
      plannedPaymentAmount,
      paidAmount,
      pendingPaymentAmount,
      overduePayments: count(paymentRisks, (item) => item.risk === 'overdue'),
      supplierCount: supplierDirectory.summary.totalSuppliers,
    },
    paymentProgress: {
      plannedAmount: plannedPaymentAmount,
      paidAmount,
      pendingAmount: pendingPaymentAmount,
      completionRate: percentage(paidAmount, plannedPaymentAmount),
      paidCount: count(payments, (item) => item.risk === 'completed'),
      pendingCount: count(payments, (item) => item.risk !== 'completed'),
    },
    contracts,
    unsignedContracts,
    payments,
    contractRisks: overviewContracts.filter((item) =>
      isVisibleContractRisk(item),
    ),
    paymentRisks,
    frameworkRelations,
    supplierDirectory,
    contractPaymentSummaries,
    paymentFollowUps,
    paymentDataQuality,
    typeBreakdown: buildBreakdown(
      overviewContracts,
      (item) => item.contractType,
    ).map((item) => ({ ...item, contractType: item.label })),
    specialtyBreakdown: buildBreakdown(
      overviewContracts,
      (item) => item.specialty,
    ).map((item) => ({ ...item, specialty: item.label })),
    sectionStatus: input.sectionStatus,
  };
}

function isUnsignedContractRecord(record: BitableRecordItem): boolean {
  return (
    cleanBusinessText(text(record.fields || {}, ['签订状态'])) === '未签订'
  );
}

function isEligibleExecutionContractRecord(
  record: BitableRecordItem,
): boolean {
  if (isUnsignedContractRecord(record)) return false;
  const fields = record.fields || {};
  const hasName = Boolean(cleanBusinessText(text(fields, ['合同名称'])));
  const hasExecutionTerms =
    Boolean(cleanBusinessText(text(fields, ['合同编号']))) ||
    Boolean(date(fields, ['合同开始日期'])) ||
    Boolean(date(fields, ['合同结束日期'])) ||
    number(fields, ['合同金额']) !== null;
  return hasName && hasExecutionTerms;
}

function isSupplierRecordLinkedOnlyTo(
  record: BitableRecordItem,
  contractIds: Set<string>,
): boolean {
  const linkedContractIds = extractLinkedRecordIds(
    pickField(record.fields || {}, ['关联合同编号']),
  );
  return (
    linkedContractIds.length > 0 &&
    linkedContractIds.every((recordId) => contractIds.has(recordId))
  );
}

function buildPaymentFollowUps(
  contracts: ContractManagementItem[],
  payments: ContractPaymentItem[],
): ContractManagementDashboard['paymentFollowUps'] {
  return contracts
    .flatMap((contract) => {
      if (
        contract.status !== 'expired' ||
        !contract.endDate ||
        isNoPaymentRequired(contract.paymentFollowUpDisposition)
      ) {
        return [];
      }
      const related = payments.filter(
        (payment) => payment.contractRecordId === contract.recordId,
      );
      const unpaid = related.filter((payment) => payment.risk !== 'completed');
      if (related.length > 0 && unpaid.length === 0) return [];
      const plannedAmount = roundMoney(
        sum(related, (payment) => payment.plannedAmount),
      );
      const paidAmount = roundMoney(
        sum(related, (payment) => payment.actualAmount),
      );
      return [
        {
          contractRecordId: contract.recordId,
          contractName: contract.name,
          contractCode: contract.code,
          owner: contract.owner,
          contractAmount: contract.amount,
          contractEndDate: contract.endDate,
          reason: related.length
            ? ('unpaid_plan' as const)
            : ('missing_plan' as const),
          planCount: related.length,
          unpaidPlanCount: unpaid.length,
          plannedAmount,
          paidAmount,
          pendingAmount: calculatePendingPaymentAmount(related),
          attachments: contract.attachments,
        },
      ];
    })
    .sort(
      (left, right) =>
        Number(left.reason === 'unpaid_plan') -
          Number(right.reason === 'unpaid_plan') ||
        right.pendingAmount - left.pendingAmount ||
        left.contractEndDate.localeCompare(right.contractEndDate) ||
        left.contractCode.localeCompare(right.contractCode, 'zh-CN'),
    );
}

function isNoPaymentRequired(value: string | undefined): boolean {
  return Boolean(value?.includes('无需付款'));
}

function buildSupplierDirectory(
  supplierRecords: BitableRecordItem[],
  contractIndex: Map<string, ContractManagementItem>,
): ContractManagementDashboard['supplierDirectory'] {
  type SupplierGroup = {
    supplierId: string;
    name: string;
    directoryEntryCount: number;
    contacts: Array<{ name: string; phone: string }>;
    parkLiaisons: string[];
    linkedContractIds: string[];
  };

  const groups = new Map<string, SupplierGroup>();
  let contactsWithPhone = 0;

  supplierRecords.forEach((record, index) => {
    const fields = record.fields || {};
    const recordId = getRecordId(record) || `supplier:${index}`;
    const companyName = cleanBusinessText(text(fields, ['公司单位']));
    const displayName = companyName || '公司名称待补充';
    const groupKey = companyName || `${displayName}:${recordId}`;
    const contactName = cleanBusinessText(text(fields, ['联系人']));
    const phone = cleanBusinessText(text(fields, ['联系电话']));
    const parkLiaisons = dedupe(
      extractDisplayValues(pickField(fields, ['园区对接人'])).map(
        cleanBusinessText,
      ),
    );
    const linkedContractIds = extractLinkedRecordIds(
      pickField(fields, ['关联合同编号']),
    );
    if (phone) contactsWithPhone += 1;

    const existing = groups.get(groupKey) || {
      supplierId: recordId,
      name: displayName,
      directoryEntryCount: 0,
      contacts: [],
      parkLiaisons: [],
      linkedContractIds: [],
    };
    existing.directoryEntryCount += 1;
    if (contactName || phone) {
      const contactKey = `${contactName}\u0000${phone}`;
      const hasContact = existing.contacts.some(
        (contact) => `${contact.name}\u0000${contact.phone}` === contactKey,
      );
      if (!hasContact) {
        existing.contacts.push({ name: contactName, phone });
      }
    }
    existing.parkLiaisons = dedupe([...existing.parkLiaisons, ...parkLiaisons]);
    existing.linkedContractIds = dedupe([
      ...existing.linkedContractIds,
      ...linkedContractIds,
    ]);
    groups.set(groupKey, existing);
  });

  const linkedContracts = new Set<string>();
  const items = [...groups.values()]
    .map((group) => {
      const relatedContracts = group.linkedContractIds
        .flatMap((recordId) => {
          const contract = contractIndex.get(recordId);
          if (!contract) return [];
          linkedContracts.add(recordId);
          return [
            {
              recordId: contract.recordId,
              name: contract.name,
              code: contract.code,
              amount: contract.amount,
              status: contract.status,
              startDate: contract.startDate,
              endDate: contract.endDate,
            },
          ];
        })
        .sort(
          (left, right) =>
            supplierContractStatusRank(left.status) -
              supplierContractStatusRank(right.status) ||
            left.code.localeCompare(right.code, 'zh-CN'),
        );
      const linkedContractAmount = roundMoney(
        sum(relatedContracts, (contract) => contract.amount),
      );
      return {
        supplierId: group.supplierId,
        name: group.name,
        directoryEntryCount: group.directoryEntryCount,
        contacts: group.contacts.sort((left, right) =>
          left.name.localeCompare(right.name, 'zh-CN'),
        ),
        parkLiaisons: group.parkLiaisons.sort((left, right) =>
          left.localeCompare(right, 'zh-CN'),
        ),
        relatedContracts,
        activeContractCount: count(
          relatedContracts,
          (contract) =>
            contract.status === 'active' || contract.status === 'expiring',
        ),
        linkedContractAmount,
        cooperationDepth: supplierCooperationDepth(linkedContractAmount),
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'));

  return {
    summary: {
      totalSuppliers: items.length,
      directoryEntries: supplierRecords.length,
      linkedContracts: linkedContracts.size,
      contactsWithPhone,
      phoneCoverageRate: percentage(contactsWithPhone, supplierRecords.length),
    },
    items,
  };
}

function supplierContractStatusRank(status: ContractStatus): number {
  return {
    active: 0,
    expiring: 1,
    pending: 2,
    unknown: 3,
    expired: 4,
  }[status];
}

function supplierCooperationDepth(
  amount: number,
): ContractManagementDashboard['supplierDirectory']['items'][number]['cooperationDepth'] {
  if (amount > 100_000) return 'over_100k';
  if (amount >= 50_000) return '50k_to_100k';
  return 'under_50k';
}

function buildFrameworkRelations(
  frameworkRecords: BitableRecordItem[],
  executionRecords: BitableRecordItem[],
  contractIndex: Map<string, ContractManagementItem>,
  now: Date,
): ContractManagementDashboard['frameworkRelations'] {
  const frameworkIndex = new Map(
    frameworkRecords.map((record, index) => {
      const fields = record.fields || {};
      const recordId = getRecordId(record) || `framework:${index}`;
      const startDate = date(fields, ['合同开始日期']);
      const endDate = date(fields, ['合同结束日期']);
      return [
        recordId,
        {
          recordId,
          name: text(fields, ['合同名称']) || '未命名框架合同',
          code:
            cleanBusinessText(text(fields, ['合同编号', '框架合同编码'])) ||
            '编号待补充',
          startDate,
          endDate,
          status: contractStatus(startDate, endDate, now),
          daysRemaining: endDate ? differenceInDays(endDate, now) : null,
          executionIds: new Set(
            extractLinkedRecordIds(fields['01-执行合同信息']),
          ),
        },
      ] as const;
    }),
  );

  for (const record of executionRecords) {
    const contractId = getRecordId(record);
    if (!contractId) continue;
    for (const frameworkId of extractLinkedRecordIds(
      record.fields?.['框架引用'],
    )) {
      frameworkIndex.get(frameworkId)?.executionIds.add(contractId);
    }
  }

  const items = [...frameworkIndex.values()]
    .map((framework) => {
      const executionContracts = [...framework.executionIds]
        .map((recordId) => contractIndex.get(recordId))
        .filter((item): item is ContractManagementItem => Boolean(item))
        .map((item) => ({
          recordId: item.recordId,
          name: item.name,
          code: item.code,
          amount: item.amount,
          status: item.status,
          supplier: item.supplier,
          owner: item.owner,
          endDate: item.endDate,
        }))
        .sort(compareContractRelationship);
      return {
        frameworkRecordId: framework.recordId,
        frameworkName: framework.name,
        frameworkCode: framework.code,
        startDate: framework.startDate,
        endDate: framework.endDate,
        status: framework.status,
        daysRemaining: framework.daysRemaining,
        executionAmount: roundMoney(
          sum(executionContracts, (item) => item.amount),
        ),
        executionContracts,
      };
    })
    .sort((left, right) =>
      compareContractRelationship(
        {
          status: left.status,
          endDate: left.endDate,
          code: left.frameworkCode,
        },
        {
          status: right.status,
          endDate: right.endDate,
          code: right.frameworkCode,
        },
      ),
    );

  const linkedExecutionIndex = new Map(
    items.flatMap((item) =>
      item.executionContracts.map(
        (contract) => [contract.recordId, contract] as const,
      ),
    ),
  );

  return {
    summary: {
      totalFrameworks: items.length,
      activeFrameworks: count(
        items,
        (item) => item.status === 'active' || item.status === 'expiring',
      ),
      linkedFrameworks: count(
        items,
        (item) => item.executionContracts.length > 0,
      ),
      unlinkedFrameworks: count(
        items,
        (item) => item.executionContracts.length === 0,
      ),
      linkedExecutionContracts: linkedExecutionIndex.size,
      linkedExecutionAmount: roundMoney(
        sum([...linkedExecutionIndex.values()], (item) => item.amount),
      ),
    },
    items,
  };
}

function compareContractRelationship(
  left: Pick<ContractManagementItem, 'status' | 'endDate' | 'code'>,
  right: Pick<ContractManagementItem, 'status' | 'endDate' | 'code'>,
): number {
  const statusRank: Record<ContractStatus, number> = {
    expiring: 0,
    active: 1,
    pending: 2,
    unknown: 3,
    expired: 4,
  };
  return (
    statusRank[left.status] - statusRank[right.status] ||
    (left.endDate || '9999-12-31').localeCompare(
      right.endDate || '9999-12-31',
    ) ||
    left.code.localeCompare(right.code, 'zh-CN')
  );
}

function buildContractPaymentSummaries(
  payments: ContractPaymentItem[],
  contractIndex: Map<string, ContractManagementItem>,
): ContractManagementDashboard['contractPaymentSummaries'] {
  const groups = new Map<string, ContractPaymentItem[]>();
  for (const payment of payments) {
    if (
      !contractIndex.has(payment.contractRecordId) ||
      payment.plannedAmount <= 0
    )
      continue;
    groups.set(payment.contractRecordId, [
      ...(groups.get(payment.contractRecordId) || []),
      payment,
    ]);
  }
  return [...groups.entries()]
    .map(([contractRecordId, items]) => {
      const contract = contractIndex.get(
        contractRecordId,
      ) as ContractManagementItem;
      const plannedAmount = roundMoney(
        sum(items, (item) => item.plannedAmount),
      );
      const paidAmount = roundMoney(sum(items, (item) => item.actualAmount));
      const pending = items.filter((item) => item.risk !== 'completed');
      const nextDueDate =
        pending
          .map((item) => item.dueDate)
          .filter((value): value is string => Boolean(value))
          .sort()[0] || null;
      return {
        contractRecordId,
        contractName: contract.name,
        contractCode: contract.code,
        owner: contract.owner,
        plannedAmount,
        paidAmount,
        pendingAmount: calculatePendingPaymentAmount(items),
        completionRate: percentage(paidAmount, plannedAmount),
        totalPlans: items.length,
        completedPlans: count(items, (item) => item.risk === 'completed'),
        pendingPlans: pending.length,
        nextDueDate,
        overduePlans: count(pending, (item) => item.risk === 'overdue'),
      };
    })
    .sort(
      (left, right) =>
        right.pendingAmount - left.pendingAmount ||
        right.plannedAmount - left.plannedAmount,
    );
}

function buildPaymentDataQuality(
  payments: ContractPaymentItem[],
  contractIndex: Map<string, ContractManagementItem>,
): ContractManagementDashboard['paymentDataQuality'] {
  return {
    missingContract: count(
      payments,
      (item) => !contractIndex.has(item.contractRecordId),
    ),
    pendingMissingDate: count(
      payments,
      (item) =>
        contractIndex.has(item.contractRecordId) &&
        item.plannedAmount > 0 &&
        item.risk === 'undated',
    ),
    zeroAmount: count(payments, (item) => item.plannedAmount <= 0),
  };
}

function isVisibleContractRisk(
  item: ContractManagementItem,
): boolean {
  if (item.expiryDisposition.includes('到期作废')) return false;
  return item.status === 'expiring';
}

function mapContract(
  record: BitableRecordItem,
  index: number,
  now: Date,
): ContractManagementItem {
  const fields = record.fields || {};
  const startDate = date(fields, ['合同开始日期']);
  const endDate = date(fields, ['合同结束日期']);
  return {
    recordId: getRecordId(record) || `contract:${index}`,
    name: text(fields, ['合同名称']) || '未命名合同',
    code: cleanBusinessText(text(fields, ['合同编号'])),
    amount: number(fields, ['合同金额']) ?? 0,
    contractType: text(fields, ['合同类型']) || '未分类',
    specialty: text(fields, ['专业类别']) || '未分类',
    buildings: businessRecordBuilding(record) as string[] | undefined,
    supplier:
      cleanBusinessText(text(fields, ['合同公司'])) ||
      cleanBusinessText(text(fields, ['供应商'])) ||
      '待补充',
    owner: text(fields, ['跟进人']) || '待分配',
    startDate,
    endDate,
    status: contractStatus(startDate, endDate, now),
    daysRemaining: endDate ? differenceInDays(endDate, now) : null,
    expiryDisposition: text(fields, ['合同到期处置']),
    paymentFollowUpDisposition: text(fields, ['付款跟进处置']),
    paymentCycle: '待补充',
    paymentRequirement: text(fields, ['付款要求', '付款计划']) || '待补充',
    paymentProgress: {
      plannedAmount: 0,
      paidAmount: 0,
      completionRate: 0,
    },
    attachments: extractAttachments(pickField(fields, ['合同附件'])),
  };
}

function enrichContractPayments(
  contract: ContractManagementItem,
  payments: ContractPaymentItem[],
): ContractManagementItem {
  const related = payments
    .filter((payment) => payment.contractRecordId === contract.recordId)
    .sort(
      (left, right) =>
        (left.dueDate || '9999-12-31').localeCompare(
          right.dueDate || '9999-12-31',
        ) || left.label.localeCompare(right.label),
    );
  if (!related.length) return contract;

  const plannedAmount = roundMoney(
    sum(related, (payment) => payment.plannedAmount),
  );
  const paidAmount = roundMoney(
    sum(related, (payment) => payment.actualAmount),
  );
  const requirements = dedupe(
    related.map((payment) => {
      const step =
        payment.cycle || (payment.dueDate ? '按约定日期付款' : payment.label);
      return payment.dueDate ? `${step} · ${payment.dueDate}` : step;
    }),
  );
  return {
    ...contract,
    paymentCycle: paymentNature(related.length),
    paymentRequirement:
      requirements.join('；') || contract.paymentRequirement || '待补充',
    paymentProgress: {
      plannedAmount,
      paidAmount,
      completionRate: percentage(paidAmount, plannedAmount),
    },
  };
}

function paymentNature(planCount: number): string {
  if (planCount <= 0) return '待补充';
  if (planCount === 1) return '一次性';
  if (planCount === 2) return '二期';
  if (planCount === 3) return '三期';
  return '四期';
}

function mapPayment(
  record: BitableRecordItem,
  index: number,
  contractIndex: Map<string, ContractManagementItem>,
  now: Date,
): ContractPaymentItem {
  const fields = record.fields || {};
  const contractRecordId = extractLinkedRecordId(
    pickField(fields, ['合同编号']),
  );
  const contract = contractIndex.get(contractRecordId);
  const dueDate = date(fields, ['计划付款日期']);
  const status = text(fields, ['付款状态']) || '未付款';
  const actualAmount = number(fields, ['实际付款金额']) ?? 0;
  const plannedAmount = number(fields, ['计划付款金额']) ?? 0;
  const daysUntilDue = dueDate ? differenceInDays(dueDate, now) : null;
  return {
    recordId: getRecordId(record) || `payment:${index}`,
    contractRecordId,
    contractName: contract?.name || '关联合同待确认',
    contractCode: contract?.code || '',
    label: text(fields, ['付款计划']) || contract?.code || '付款计划',
    cycle: text(fields, ['付款周期']),
    dueDate,
    plannedAmount,
    actualAmount,
    status,
    risk: paymentRisk(status, plannedAmount, actualAmount, daysUntilDue),
    daysUntilDue,
    owner: contract?.owner || text(fields, ['跟进人']) || '待分配',
  };
}

function contractStatus(
  startDate: string | null,
  endDate: string | null,
  now: Date,
): ContractStatus {
  const today = shanghaiDayTimestamp(now);
  const start = startDate ? Date.parse(`${startDate}T00:00:00Z`) : Number.NaN;
  const end = endDate ? Date.parse(`${endDate}T00:00:00Z`) : Number.NaN;
  if (!Number.isNaN(start) && start > today) return 'pending';
  if (!Number.isNaN(end) && end < today) return 'expired';
  if (!Number.isNaN(end) && (end - today) / DAY_MS <= 60) return 'expiring';
  if (!Number.isNaN(start) || !Number.isNaN(end)) return 'active';
  return 'unknown';
}

function paymentRisk(
  status: string,
  plannedAmount: number,
  actualAmount: number,
  daysUntilDue: number | null,
): ContractPaymentRisk {
  if (
    status.includes('已付款') ||
    (plannedAmount > 0 && actualAmount >= plannedAmount)
  ) {
    return 'completed';
  }
  if (daysUntilDue === null) return 'undated';
  if (daysUntilDue < 0) return 'overdue';
  if (daysUntilDue <= 30) return 'dueSoon';
  return 'normal';
}

function buildBreakdown(
  contracts: ContractManagementItem[],
  labelOf: (item: ContractManagementItem) => string,
): ContractBreakdownItem[] {
  const groups = new Map<string, ContractManagementItem[]>();
  for (const contract of contracts) {
    const label = labelOf(contract) || '未分类';
    groups.set(label, [...(groups.get(label) || []), contract]);
  }
  return [...groups.entries()]
    .map(([label, items]) => ({
      label,
      count: items.length,
      amount: roundMoney(sum(items, (item) => item.amount)),
      percentage: percentage(items.length, contracts.length),
    }))
    .sort(
      (left, right) => right.amount - left.amount || right.count - left.count,
    );
}

function compareContractRisk(
  left: ContractManagementItem,
  right: ContractManagementItem,
): number {
  const score: Record<ContractStatus, number> = {
    active: 5,
    expiring: 4,
    pending: 3,
    unknown: 2,
    expired: 1,
  };
  return (
    score[right.status] - score[left.status] ||
    (left.daysRemaining ?? Number.MAX_SAFE_INTEGER) -
      (right.daysRemaining ?? Number.MAX_SAFE_INTEGER) ||
    right.amount - left.amount
  );
}

function comparePaymentRisk(
  left: ContractPaymentItem,
  right: ContractPaymentItem,
): number {
  const score: Record<ContractPaymentRisk, number> = {
    overdue: 5,
    dueSoon: 4,
    undated: 3,
    normal: 2,
    completed: 1,
  };
  return (
    score[right.risk] - score[left.risk] ||
    (left.daysUntilDue ?? Number.MAX_SAFE_INTEGER) -
      (right.daysUntilDue ?? Number.MAX_SAFE_INTEGER)
  );
}

function extractLinkedRecordId(value: unknown): string {
  return extractLinkedRecordIds(value)[0] || '';
}

export function extractLinkedRecordIds(value: unknown): string[] {
  if (typeof value === 'string') {
    const recordId = value.trim();
    return recordId ? [recordId] : [];
  }
  if (Array.isArray(value))
    return dedupe(value.flatMap(extractLinkedRecordIds));
  if (!value || typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  const groupedIds = ['link_record_ids', 'record_ids'].flatMap((key) =>
    extractLinkedRecordIds(record[key]),
  );
  const directIds = ['record_id', 'recordId', 'id'].flatMap((key) =>
    extractLinkedRecordIds(record[key]),
  );
  return dedupe([...groupedIds, ...directIds]);
}

function extractAttachments(
  value: unknown,
): ContractManagementItem['attachments'] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const attachment = item as Record<string, unknown>;
    const name = extractDisplayText(attachment.name) || '合同附件';
    const url =
      extractDisplayText(attachment.tmp_url) ||
      extractDisplayText(attachment.url);
    return url
      ? [
          {
            name,
            accessId: '',
            previewStatus: 'processing' as const,
            pageCount: 0,
          },
        ]
      : [];
  });
}

function text(fields: Record<string, unknown>, names: string[]): string {
  return extractDisplayText(pickField(fields, names));
}

function number(
  fields: Record<string, unknown>,
  names: string[],
): number | null {
  return extractNumberValue(pickField(fields, names));
}

function date(fields: Record<string, unknown>, names: string[]): string | null {
  return extractDateValue(pickField(fields, names));
}

function differenceInDays(value: string, now: Date): number {
  return Math.round(
    (Date.parse(`${value}T00:00:00Z`) - shanghaiDayTimestamp(now)) / DAY_MS,
  );
}

function shanghaiDayTimestamp(value: Date): number {
  const parts = SHANGHAI_DATE_FORMATTER.formatToParts(value);
  const year = Number(parts.find((part) => part.type === 'year')?.value);
  const month = Number(parts.find((part) => part.type === 'month')?.value);
  const day = Number(parts.find((part) => part.type === 'day')?.value);
  return Date.UTC(year, month - 1, day);
}

function sum<T>(items: T[], value: (item: T) => number): number {
  return items.reduce((total, item) => total + value(item), 0);
}

function calculatePendingPaymentAmount(
  payments: ContractPaymentItem[],
): number {
  return roundMoney(
    sum(payments, (payment) =>
      Math.max(0, payment.plannedAmount - payment.actualAmount),
    ),
  );
}

function count<T>(items: T[], predicate: (item: T) => boolean): number {
  return items.reduce((total, item) => total + (predicate(item) ? 1 : 0), 0);
}

function percentage(value: number, total: number): number {
  return total > 0 ? Math.round((value / total) * 1000) / 10 : 0;
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function getRecordId(record: BitableRecordItem): string {
  return record.record_id || record.id || '';
}

function pickField(fields: Record<string, unknown>, names: string[]): unknown {
  for (const name of names) {
    const value = fields[name];
    if (value !== null && value !== undefined && value !== '') return value;
  }
  return undefined;
}

function extractDisplayText(value: unknown): string {
  return dedupe(extractDisplayValues(value)).join('、');
}

function extractDisplayValues(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value.flatMap(extractDisplayValues);
  if (typeof value === 'string') return value.trim() ? [value.trim()] : [];
  if (typeof value === 'number' || typeof value === 'boolean')
    return [String(value)];
  if (typeof value === 'object') {
    const object = value as Record<string, unknown>;
    for (const key of [
      'name',
      'text',
      'label',
      'user_name',
      'value',
      'title',
    ]) {
      if (object[key] !== null && object[key] !== undefined) {
        return extractDisplayValues(object[key]);
      }
    }
  }
  return [];
}

function extractNumberValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const displayText = extractDisplayText(value).trim();
  if (!displayText) return null;
  const parsed = Number(displayText.replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function extractDateValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const dateValue = extractDateValue(item);
      if (dateValue) return dateValue;
    }
    return null;
  }
  if (typeof value === 'object') {
    const object = value as Record<string, unknown>;
    for (const key of ['timestamp', 'date', 'text', 'value']) {
      const dateValue = extractDateValue(object[key]);
      if (dateValue) return dateValue;
    }
    return null;
  }
  const dateValue =
    typeof value === 'number'
      ? new Date(value)
      : new Date(String(value).trim().replace(/\//g, '-'));
  if (Number.isNaN(dateValue.getTime())) return null;
  return `${dateValue.getFullYear()}-${String(dateValue.getMonth() + 1).padStart(2, '0')}-${String(dateValue.getDate()).padStart(2, '0')}`;
}

function dedupe(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function cleanBusinessText(value: string): string {
  return value.trim().replace(/[、,，;；\s]+$/u, '');
}
