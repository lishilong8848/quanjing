import type {
  InventoryRiskTone,
  PurchaseInventoryAlertItem,
  PurchaseInventoryMovementItem,
  PurchaseInventoryPriority,
  PurchaseInventoryRequestItem,
  PurchaseInventoryResponse,
  PurchaseInventoryStage,
} from '../../../shared/purchase-inventory.interface';
import { getWarehouseInventoryLocationReadFieldNames } from '../../common/config/warehouse-inventory-location.config';
import {
  extractDateTimeIso,
  extractDisplayText,
  extractDisplayValues,
  extractNumberValue,
  getRecordId,
  pickField,
  type BitableRecordItem,
} from '../../common/feishu/bitable-direct-read';
import {
  buildFeishuChatAppLink,
  extractFeishuOpenId,
} from '../bitable-sync/person-profile-contact';

type RecordFields = Record<string, unknown>;

interface BuildPurchaseInventoryViewInput {
  generatedAt: string;
  submissions: BitableRecordItem[];
  executions: BitableRecordItem[];
  employees?: BitableRecordItem[];
  catalog: BitableRecordItem[];
  inventory: BitableRecordItem[];
  inbound: BitableRecordItem[];
  outbound: BitableRecordItem[];
  sectionStatus: PurchaseInventoryResponse['sectionStatus'];
}

interface StageInput {
  hasExecution: boolean;
  submitted: boolean;
  approvalCompleted: boolean;
  orderedAt: string | null;
  receiptConfirmed: boolean;
  warehouseRequired: boolean;
  warehouseConfirmed: boolean;
  rejected?: boolean;
  workflowStatus?: string;
}

interface CatalogItem {
  sku: string;
  name: string;
  specification: string;
  building: string;
  primaryCategory: string;
  secondaryCategory: string;
  specialty: string;
  unit: string;
  unitPrice: number;
}

interface CatalogIndex {
  bySku: Map<string, CatalogItem>;
  byName: Map<string, CatalogItem[]>;
}

const STAGES: PurchaseInventoryStage[] = [
  'application',
  'approval',
  'rejected',
  'executing',
  'receiving',
  'inbound',
  'stocked',
];

export function derivePurchaseStage(input: StageInput): {
  stage: PurchaseInventoryStage;
  statusLabel: string;
} {
  if (!input.hasExecution) {
    return input.submitted
      ? { stage: 'approval', statusLabel: '待审批' }
      : { stage: 'application', statusLabel: '待提交' };
  }

  switch (input.workflowStatus) {
    case '未开始（待审批）':
      return { stage: 'approval', statusLabel: input.workflowStatus };
    case '审批通过（待下单）':
      return { stage: 'executing', statusLabel: input.workflowStatus };
    case '下单完成（待签收）':
      return { stage: 'receiving', statusLabel: input.workflowStatus };
    case '到货已签收（待入库）':
    case '物品签收（待入库）':
      return { stage: 'inbound', statusLabel: '到货已签收（待入库）' };
    case '采购完成（已入库）':
      return { stage: 'stocked', statusLabel: '采购完成（已入库）' };
    case '驳回申请':
      return { stage: 'rejected', statusLabel: input.workflowStatus };
    default:
      break;
  }

  if (input.rejected) return { stage: 'rejected', statusLabel: '已驳回' };
  return { stage: 'executing', statusLabel: '采购流程待同步' };
}

export function buildPurchaseInventoryView(
  input: BuildPurchaseInventoryViewInput,
): PurchaseInventoryResponse {
  const catalog = buildCatalogIndex(input.catalog);
  const employeeBuildingByName = buildEmployeeBuildingIndex(
    input.employees ?? [],
  );
  const requests = buildRequests(
    input.submissions,
    input.executions,
    catalog,
    employeeBuildingByName,
  );
  const inventoryView = buildInventory(input.inventory, catalog.bySku);
  const recentInbound = buildMovements(input.inbound, 'inbound', catalog.bySku);
  const recentOutbound = buildMovements(
    input.outbound,
    'outbound',
    catalog.bySku,
  );
  const stageCounts = createStageCounts(requests);

  return {
    generatedAt: input.generatedAt,
    summary: {
      totalRequests: requests.length,
      pendingApprovals: stageCounts.approval,
      executingOrders: stageCounts.executing,
      awaitingReceipt: stageCounts.receiving,
      stockedRequests: stageCounts.stocked,
      estimatedAmount: roundMoney(
        requests.reduce((sum, request) => sum + request.estimatedAmount, 0),
      ),
      actualAmount: roundMoney(
        requests.reduce((sum, request) => sum + (request.actualAmount ?? 0), 0),
      ),
      catalogItems: input.catalog.length,
      inventorySkus: inventoryView.skuCount,
      availableQuantity: inventoryView.availableQuantity,
      inventoryValue: roundMoney(inventoryView.inventoryValue),
      lowStockSkus: inventoryView.lowStockCount,
      pendingInbound: recentInbound.filter((item) =>
        item.status.includes('待入库'),
      ).length,
      stageCounts,
    },
    requests,
    inventory: {
      categoryBreakdown: inventoryView.categoryBreakdown,
      alerts: inventoryView.alerts,
    },
    movements: {
      recentInbound: recentInbound.slice(0, 50),
      recentOutbound: recentOutbound.slice(0, 50),
    },
    sectionStatus: input.sectionStatus,
  };
}

function buildRequests(
  submissions: BitableRecordItem[],
  executions: BitableRecordItem[],
  catalog: CatalogIndex,
  employeeBuildingByName: ReadonlyMap<string, string>,
): PurchaseInventoryRequestItem[] {
  const submissionByCode = indexPurchaseRecords(submissions, 'submission');
  const executionByCode = indexPurchaseRecords(executions, 'execution');
  reconcileProgramCreatedPurchaseRecords(submissionByCode, executionByCode);
  reconcileHistoricalPurchaseRecords(submissionByCode, executionByCode);
  const codes = new Set([
    ...submissionByCode.keys(),
    ...executionByCode.keys(),
  ]);

  const requests = [...codes]
    .flatMap((code) =>
      pairPurchaseRecords(
        submissionByCode.get(code) ?? [],
        executionByCode.get(code) ?? [],
      ).map(({ submission, execution }) => {
        const submissionFields = fieldsOf(submission);
        const executionFields = fieldsOf(execution);
        const inventorySku = text(executionFields, [
          '物品类别码',
          '物品类别号',
        ]);
        const catalogItem = inventorySku
          ? catalog.bySku.get(inventorySku)
          : undefined;
        const orderedAt = dateTime(executionFields, ['下单时间']);
        const warehouseRequired = submission
          ? checked(
              pickField(submissionFields, [
                '是否需要录入 库房台账',
                '是否需要录入库房台账',
              ]),
            )
          : Boolean(inventorySku);
        const warehouseConfirmed = checked(
          pickField(executionFields, ['是否已入库']),
        );
        const workflowStatus = text(executionFields, ['采购流程']);
        const purchaseMethod =
          text(executionFields, ['1️⃣物品采购方式', '采购方式']) ||
          text(submissionFields, ['采购方式', '1️⃣物品采购方式']);
        const warehouseCompleted =
          warehouseConfirmed || workflowStatus === '采购完成（已入库）';
        const stage = derivePurchaseStage({
          hasExecution: Boolean(execution),
          submitted: submission
            ? checked(
                pickField(submissionFields, [
                  '提交成功（无需点击🚫）',
                  '提交成功',
                ]),
              )
            : true,
          approvalCompleted: checked(
            pickField(executionFields, [
              '2️⃣审批已完成（无需点击）',
              '3️⃣审批已完成（无需点击）',
              '审批已完成',
            ]),
          ),
          orderedAt,
          receiptConfirmed: checked(
            pickField(executionFields, [
              '到货签收确认（签收内容填写完成后点击）',
              '到货签收确认',
            ]),
          ),
          warehouseRequired,
          warehouseConfirmed: warehouseCompleted,
          rejected: purchaseMethod === '驳回',
          workflowStatus,
        });
        const submissionRecordId = submission ? getRecordId(submission) : null;
        const executionRecordId = execution ? getRecordId(execution) : null;
        const requester =
          text(executionFields, ['需求人', '业务申请人', '申请人']) ||
          text(submissionFields, ['需求人', '业务申请人', '申请人']);
        const requesterField =
          pickField(executionFields, ['需求人', '业务申请人', '申请人']) ||
          pickField(submissionFields, ['需求人', '业务申请人', '申请人']);
        const purchaserField = pickField(executionFields, ['采购人']);
        const purchaser = text(executionFields, ['采购人']);
        const title =
          itemName(executionFields, submissionFields) ||
          catalogItem?.name ||
          '未命名物品';
        const building =
          text(submissionFields, [
            '申请楼栋（多楼请选H楼，备注里填写详情）',
            '申请楼栋（多楼请选E楼，备注里填写详情）',
            '申请楼栋',
            '楼栋',
          ]) ||
          text(executionFields, [
            '申请楼栋（多楼请选H楼，备注里填写详情）',
            '申请楼栋（多楼请选E楼，备注里填写详情）',
            '申请楼栋',
            '楼栋',
          ]) ||
          employeeBuildingByName.get(normalizePersonName(requester)) ||
          catalogItem?.building ||
          '';
        const unit = resolveRequestUnit({
          explicitUnit:
            text(executionFields, ['计数单位']) ||
            text(submissionFields, ['单位', '计数单位']),
          catalogItem,
          catalogByName: catalog.byName,
          title,
          building,
        });
        const namedApprovalTarget =
          text(executionFields, [
            '当前审批人',
            '审批人',
            '审批负责人',
            '审批主管',
          ]) ||
          text(submissionFields, [
            '当前审批人',
            '审批人',
            '审批负责人',
            '审批主管',
          ]);
        const executionComparisonField = '是否满足三家比价（线下）';
        const comparisonSatisfied = Object.prototype.hasOwnProperty.call(
          executionFields,
          executionComparisonField,
        )
          ? extractDisplayText(executionFields[executionComparisonField])
          : text(submissionFields, ['是否满足三方比价']);
        const procurementForm: PurchaseInventoryRequestItem['procurementForm'] =
          comparisonSatisfied === '否' ? '单一采购' : '三方比价';
        const rawSingleReason = pickField(executionFields, ['单一原因']);

        return {
          recordId: executionRecordId || submissionRecordId || code,
          submissionRecordId,
          executionRecordId,
          requestCode: purchaseCode(submissionFields, executionFields) || code,
          title,
          specification:
            text(executionFields, [
              '物品规格型号、设备序列号',
              '规格型号、设备序列号',
              '规格型号',
            ]) ||
            text(submissionFields, [
              '规格型号',
              '物品规格型号、设备序列号',
              '规格型号、设备序列号',
            ]) ||
            catalogItem?.specification ||
            '',
          requester,
          requesterChatUrl: buildFeishuChatAppLink(
            extractFeishuOpenId(requesterField),
          ),
          purchaser,
          purchaserChatUrl: buildFeishuChatAppLink(
            extractFeishuOpenId(purchaserField),
          ),
          building,
          specialty:
            text(executionFields, ['专业']) ||
            text(submissionFields, ['专业']) ||
            catalogItem?.specialty ||
            '',
          primaryCategory:
            text(executionFields, ['一级分类']) ||
            text(submissionFields, ['一级分类']) ||
            catalogItem?.primaryCategory ||
            '未分类',
          secondaryCategory:
            text(executionFields, ['二级分类']) ||
            text(submissionFields, ['二级分类']) ||
            catalogItem?.secondaryCategory ||
            '',
          stage: stage.stage,
          statusLabel: stage.statusLabel,
          purchaseMethod,
          procurementForm,
          singleReason:
            procurementForm === '单一采购'
              ? (typeof rawSingleReason === 'string'
                  ? rawSingleReason
                  : extractDisplayText(rawSingleReason)
                ).trim()
              : '',
          purchaseLinks: extractPurchaseLinks(
            executionFields,
            submissionFields,
          ),
          approvalTarget: resolveApprovalTarget(
            stage.stage,
            namedApprovalTarget,
          ),
          supplier:
            text(executionFields, ['供应商']) ||
            text(submissionFields, ['供应商']),
          estimatedAmount:
            number(executionFields, ['初步预估总价']) ??
            number(submissionFields, ['总价']) ??
            0,
          actualAmount: number(executionFields, ['实际付款金额']),
          quantity:
            number(executionFields, ['采购申请数量']) ??
            number(submissionFields, ['采购数量']) ??
            0,
          actualQuantity: number(executionFields, ['实际采购数量']),
          unit,
          priority: normalizePriority(pickField(executionFields, ['优先级'])),
          createdAt:
            dateTime(submissionFields, ['创建日期', '记录创建时间']) ||
            recordCreatedAt(submission) ||
            dateTime(executionFields, ['创建日期', '记录创建时间']) ||
            recordCreatedAt(execution),
          expectedArrival:
            dateTime(executionFields, ['期望交付时间']) ||
            dateTime(submissionFields, ['期望交付时间']),
          orderedAt,
          receivedAt: dateTime(executionFields, ['签收时间']),
          warehouseRequired,
          warehouseConfirmed: warehouseCompleted,
          purchaseCompleted: checked(pickField(executionFields, ['采购完成'])),
          inventorySku,
          notes:
            text(executionFields, [
              '需求备注（提交人）',
              '其他备注',
              '需求简述（采购原因、目的等）',
              '需求简述',
            ]) ||
            text(submissionFields, [
              '其他备注',
              '需求简述（采购原因、目的等）',
              '需求简述',
            ]),
        } satisfies PurchaseInventoryRequestItem;
      }),
    )
    .filter((item) => !item.requestCode.startsWith('CODEX-PURCHASE-WORKFLOW-'));

  return fillConsistentRequesterBuildings(requests).sort((left, right) =>
    compareDateDesc(left.createdAt, right.createdAt),
  );
}

function resolveApprovalTarget(
  stage: PurchaseInventoryStage,
  namedApprovalTarget: string,
): string {
  if (stage !== 'approval') return '';
  return namedApprovalTarget || '运维经理（马进宇 / 梅冰冰，任一审批）';
}

function buildEmployeeBuildingIndex(
  records: BitableRecordItem[],
): Map<string, string> {
  const index = new Map<string, string>();
  for (const record of records) {
    const fields = fieldsOf(record);
    if (checked(pickField(fields, ['离职/异动情况']))) continue;
    const name = text(fields, ['姓名', '员工姓名']);
    const specialtyValues = extractDisplayValues(
      pickField(fields, ['机楼/专业']),
    );
    const rawBuilding = text(fields, ['楼栋']);
    const building =
      specialtyValues.find((value) =>
        /^(?:[A-EH]楼|110站)$/i.test(value.trim()),
      ) || (/^opt/i.test(rawBuilding) ? '' : rawBuilding);
    const key = normalizePersonName(name);
    if (key && building && !index.has(key)) index.set(key, building);
  }
  return index;
}

function normalizePersonName(value: string): string {
  return value.trim().replace(/\s+/g, '').toLocaleLowerCase('zh-CN');
}

function fillConsistentRequesterBuildings(
  requests: PurchaseInventoryRequestItem[],
): PurchaseInventoryRequestItem[] {
  const buildingsByRequester = new Map<string, Set<string>>();
  for (const request of requests) {
    const requester = normalizePersonName(request.requester);
    if (!requester || !request.building) continue;
    const buildings = buildingsByRequester.get(requester) ?? new Set<string>();
    buildings.add(request.building);
    buildingsByRequester.set(requester, buildings);
  }

  return requests.map((request) => {
    if (request.building) return request;
    const buildings = buildingsByRequester.get(
      normalizePersonName(request.requester),
    );
    if (!buildings || buildings.size !== 1) return request;
    return { ...request, building: [...buildings][0] };
  });
}

function indexPurchaseRecords(
  records: BitableRecordItem[],
  prefix: 'submission' | 'execution',
): Map<string, BitableRecordItem[]> {
  const index = new Map<string, BitableRecordItem[]>();
  records.forEach((record, position) => {
    const fields = fieldsOf(record);
    const code = text(fields, ['采购编码']);
    const key = code || `${prefix}:${getRecordId(record) || position}`;
    const grouped = index.get(key) ?? [];
    grouped.push(record);
    index.set(key, grouped);
  });
  index.forEach((grouped) => grouped.sort(compareRecordsByCreatedAt));
  return index;
}

const PROGRAM_RECORD_RECONCILIATION_WINDOW_MS = 2 * 60 * 1000;
const HISTORICAL_RECORD_RECONCILIATION_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

function reconcileProgramCreatedPurchaseRecords(
  submissionByCode: Map<string, BitableRecordItem[]>,
  executionByCode: ReadonlyMap<string, BitableRecordItem[]>,
): void {
  const unmatchedSubmissions = [...submissionByCode.entries()]
    .filter(([code]) => !executionByCode.has(code))
    .flatMap(([code, records]) => records.map((record) => ({ code, record })));
  const unmatchedExecutions = [...executionByCode.entries()]
    .filter(([code]) => !submissionByCode.has(code))
    .flatMap(([code, records]) => records.map((record) => ({ code, record })));

  for (const {
    code: executionCode,
    record: execution,
  } of unmatchedExecutions) {
    const submissionCandidates = unmatchedSubmissions.filter(({ record }) =>
      isProgramCreatedPurchasePair(record, execution),
    );
    if (submissionCandidates.length !== 1) continue;

    const { code: submissionCode, record: submission } =
      submissionCandidates[0];
    const executionCandidates = unmatchedExecutions.filter(({ record }) =>
      isProgramCreatedPurchasePair(submission, record),
    );
    if (executionCandidates.length !== 1) continue;

    moveSubmissionRecord(
      submissionByCode,
      submissionCode,
      executionCode,
      submission,
    );
  }
}

function reconcileHistoricalPurchaseRecords(
  submissionByCode: Map<string, BitableRecordItem[]>,
  executionByCode: ReadonlyMap<string, BitableRecordItem[]>,
): void {
  const { submissions: unmatchedSubmissions, executions: unmatchedExecutions } =
    collectUnpairedPurchaseRecords(submissionByCode, executionByCode);
  const matches: Array<{
    submissionCode: string;
    executionCode: string;
    submission: BitableRecordItem;
  }> = [];
  const usedSubmissions = new Set<BitableRecordItem>();
  const usedExecutions = new Set<BitableRecordItem>();

  for (const {
    code: executionCode,
    record: execution,
  } of unmatchedExecutions) {
    if (usedExecutions.has(execution)) continue;
    const submissionCandidates = unmatchedSubmissions.filter(
      ({ record }) =>
        !usedSubmissions.has(record) &&
        isHistoricalPurchasePair(record, execution),
    );
    const submissionCodes = new Set(
      submissionCandidates.map(({ code }) => code),
    );
    if (submissionCodes.size !== 1) continue;

    const submissionCode = [...submissionCodes][0];
    const submission = closestHistoricalRecord(
      submissionCandidates.map(({ record }) => record),
      execution,
    );
    const executionCandidates = unmatchedExecutions.filter(
      ({ record }) =>
        !usedExecutions.has(record) &&
        isHistoricalPurchasePair(submission, record),
    );
    const executionCodes = new Set(executionCandidates.map(({ code }) => code));
    if (executionCodes.size !== 1 || !executionCodes.has(executionCode))
      continue;

    usedSubmissions.add(submission);
    usedExecutions.add(execution);
    matches.push({ submissionCode, executionCode, submission });
  }

  for (const match of matches) {
    moveSubmissionRecord(
      submissionByCode,
      match.submissionCode,
      match.executionCode,
      match.submission,
    );
  }
}

function collectUnpairedPurchaseRecords(
  submissionByCode: ReadonlyMap<string, BitableRecordItem[]>,
  executionByCode: ReadonlyMap<string, BitableRecordItem[]>,
): {
  submissions: Array<{ code: string; record: BitableRecordItem }>;
  executions: Array<{ code: string; record: BitableRecordItem }>;
} {
  const submissions: Array<{ code: string; record: BitableRecordItem }> = [];
  const executions: Array<{ code: string; record: BitableRecordItem }> = [];
  const codes = new Set([
    ...submissionByCode.keys(),
    ...executionByCode.keys(),
  ]);

  for (const code of codes) {
    const pairs = pairPurchaseRecords(
      submissionByCode.get(code) ?? [],
      executionByCode.get(code) ?? [],
    );
    for (const pair of pairs) {
      if (pair.submission && !pair.execution) {
        submissions.push({ code, record: pair.submission });
      }
      if (pair.execution && !pair.submission) {
        executions.push({ code, record: pair.execution });
      }
    }
  }

  return { submissions, executions };
}

function closestHistoricalRecord(
  candidates: BitableRecordItem[],
  target: BitableRecordItem,
): BitableRecordItem {
  const targetTimestamp = recordTimestamp(target) ?? 0;
  return [...candidates].sort((left, right) => {
    const leftDistance = Math.abs(
      (recordTimestamp(left) ?? 0) - targetTimestamp,
    );
    const rightDistance = Math.abs(
      (recordTimestamp(right) ?? 0) - targetTimestamp,
    );
    return leftDistance - rightDistance;
  })[0];
}

function moveSubmissionRecord(
  submissionByCode: Map<string, BitableRecordItem[]>,
  submissionCode: string,
  executionCode: string,
  submission: BitableRecordItem,
): void {
  const previous = submissionByCode.get(submissionCode) ?? [];
  const retained = previous.filter((record) => record !== submission);
  if (retained.length) submissionByCode.set(submissionCode, retained);
  else submissionByCode.delete(submissionCode);
  const target = submissionByCode.get(executionCode) ?? [];
  if (!target.includes(submission)) target.push(submission);
  target.sort(compareRecordsByCreatedAt);
  submissionByCode.set(executionCode, target);
}

function pairPurchaseRecords(
  submissions: BitableRecordItem[],
  executions: BitableRecordItem[],
): Array<{
  submission: BitableRecordItem | null;
  execution: BitableRecordItem | null;
}> {
  const remainingSubmissions = [...submissions].sort(compareRecordsByCreatedAt);
  const pairs: Array<{
    submission: BitableRecordItem | null;
    execution: BitableRecordItem | null;
  }> = [];

  for (const execution of [...executions].sort(compareRecordsByCreatedAt)) {
    const matchIndex = remainingSubmissions.findIndex((submission) =>
      recordsSharePurchaseItem(submission, execution),
    );
    const submission =
      matchIndex >= 0 ? remainingSubmissions.splice(matchIndex, 1)[0] : null;
    pairs.push({ submission, execution });
  }

  return [
    ...pairs,
    ...remainingSubmissions.map((submission) => ({
      submission,
      execution: null,
    })),
  ];
}

function recordsSharePurchaseItem(
  submission: BitableRecordItem,
  execution: BitableRecordItem,
): boolean {
  const submissionFields = fieldsOf(submission);
  const executionFields = fieldsOf(execution);
  const submissionTitle = itemName({}, submissionFields);
  const executionTitle = itemName(executionFields, {});
  if (
    !submissionTitle ||
    !executionTitle ||
    normalizeItemName(submissionTitle) !== normalizeItemName(executionTitle)
  ) {
    return false;
  }
  const submissionQuantity = number(submissionFields, ['采购数量']);
  const executionQuantity = number(executionFields, ['采购申请数量']);
  return (
    submissionQuantity === null ||
    executionQuantity === null ||
    submissionQuantity === executionQuantity ||
    isHistoricalPurchasePair(submission, execution)
  );
}

function isProgramCreatedPurchasePair(
  submission: BitableRecordItem,
  execution: BitableRecordItem,
): boolean {
  const submissionFields = fieldsOf(submission);
  const executionFields = fieldsOf(execution);
  const submittedFlag = pickField(submissionFields, [
    '提交成功（无需点击🚫）',
    '提交成功',
  ]);
  if (submittedFlag === undefined || checked(submittedFlag)) return false;
  if (!text(executionFields, ['采购流程'])) return false;

  const submissionCreatedAt = recordTimestamp(submission);
  const executionCreatedAt = recordTimestamp(execution);
  if (
    submissionCreatedAt === null ||
    executionCreatedAt === null ||
    Math.abs(submissionCreatedAt - executionCreatedAt) >
      PROGRAM_RECORD_RECONCILIATION_WINDOW_MS
  ) {
    return false;
  }

  const submissionTitle = itemName({}, submissionFields);
  const executionTitle = itemName(executionFields, {});
  if (
    !submissionTitle ||
    !executionTitle ||
    normalizeItemName(submissionTitle) !== normalizeItemName(executionTitle)
  ) {
    return false;
  }

  const submissionQuantity = number(submissionFields, ['采购数量']);
  const executionQuantity = number(executionFields, ['采购申请数量']);
  if (
    submissionQuantity === null ||
    executionQuantity === null ||
    submissionQuantity !== executionQuantity
  ) {
    return false;
  }

  const submissionBuilding = requestBuilding(submissionFields);
  const executionBuilding = requestBuilding(executionFields);
  if (
    !submissionBuilding ||
    !executionBuilding ||
    normalizeComparableText(submissionBuilding) !==
      normalizeComparableText(executionBuilding)
  ) {
    return false;
  }

  return (
    optionalTextMatches(
      text(submissionFields, ['单位', '计数单位']),
      text(executionFields, ['计数单位']),
    ) &&
    optionalTextMatches(
      text(submissionFields, ['供应商']),
      text(executionFields, ['供应商']),
    ) &&
    optionalTextMatches(
      text(submissionFields, ['需求简述（采购原因、目的等）', '需求简述']),
      text(executionFields, ['需求简述（采购原因、目的等）', '需求简述']),
    )
  );
}

function isHistoricalPurchasePair(
  submission: BitableRecordItem,
  execution: BitableRecordItem,
): boolean {
  const submissionFields = fieldsOf(submission);
  const executionFields = fieldsOf(execution);
  if (!text(executionFields, ['采购流程'])) return false;

  const submissionCreatedAt = recordTimestamp(submission);
  const executionCreatedAt = recordTimestamp(execution);
  if (
    submissionCreatedAt === null ||
    executionCreatedAt === null ||
    executionCreatedAt < submissionCreatedAt ||
    executionCreatedAt - submissionCreatedAt >
      HISTORICAL_RECORD_RECONCILIATION_WINDOW_MS
  ) {
    return false;
  }

  const submissionTitle = itemName({}, submissionFields);
  const executionTitle = itemName(executionFields, {});
  const submissionQuantity = number(submissionFields, ['采购数量']);
  const executionQuantity = number(executionFields, ['采购申请数量']);
  const submissionRequester = text(submissionFields, [
    '需求人',
    '业务申请人',
    '申请人',
  ]);
  const executionRequester = text(executionFields, [
    '需求人',
    '业务申请人',
    '申请人',
  ]);
  const submissionBuilding = requestBuilding(submissionFields);
  const executionBuilding = requestBuilding(executionFields);

  if (
    !submissionTitle ||
    !executionTitle ||
    normalizeItemName(submissionTitle) !== normalizeItemName(executionTitle) ||
    submissionQuantity === null ||
    executionQuantity === null ||
    !submissionRequester ||
    !executionRequester ||
    normalizePersonName(submissionRequester) !==
      normalizePersonName(executionRequester) ||
    !submissionBuilding ||
    !executionBuilding ||
    normalizeComparableText(submissionBuilding) !==
      normalizeComparableText(executionBuilding)
  ) {
    return false;
  }

  if (
    submissionQuantity !== executionQuantity &&
    !historicalNotesMatch(submissionFields, executionFields)
  ) {
    return false;
  }

  return (
    optionalTextMatches(
      text(submissionFields, ['单位', '计数单位']),
      text(executionFields, ['计数单位']),
    ) &&
    optionalTextMatches(
      text(submissionFields, ['供应商']),
      text(executionFields, ['供应商']),
    ) &&
    optionalTextMatches(
      text(submissionFields, ['需求简述（采购原因、目的等）', '需求简述']),
      text(executionFields, ['需求简述（采购原因、目的等）', '需求简述']),
    )
  );
}

function historicalNotesMatch(
  submissionFields: RecordFields,
  executionFields: RecordFields,
): boolean {
  const submissionNote = text(submissionFields, [
    '需求简述（采购原因、目的等）',
    '需求简述',
    '需求备注（提交人)',
  ]);
  const executionNote = text(executionFields, [
    '需求简述（采购原因、目的等）',
    '需求简述',
    '需求备注（提交人)',
  ]);
  return Boolean(
    submissionNote &&
    executionNote &&
    normalizeComparableText(submissionNote) ===
      normalizeComparableText(executionNote),
  );
}

function requestBuilding(fields: RecordFields): string {
  return text(fields, [
    '申请楼栋（多楼请选H楼，备注里填写详情）',
    '申请楼栋（多楼请选E楼，备注里填写详情）',
    '申请楼栋',
    '楼栋',
  ]);
}

function optionalTextMatches(left: string, right: string): boolean {
  return (
    !left ||
    !right ||
    normalizeComparableText(left) === normalizeComparableText(right)
  );
}

function normalizeComparableText(value: string): string {
  return value
    .trim()
    .normalize('NFKC')
    .replace(/\s+/g, '')
    .toLocaleLowerCase('zh-CN');
}

function recordTimestamp(record: BitableRecordItem): number | null {
  const value =
    dateTime(fieldsOf(record), ['创建日期', '记录创建时间']) ||
    recordCreatedAt(record);
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : timestamp;
}

function buildCatalogIndex(records: BitableRecordItem[]): CatalogIndex {
  const bySku = new Map<string, CatalogItem>();
  const byName = new Map<string, CatalogItem[]>();
  for (const record of records) {
    const fields = fieldsOf(record);
    const sku = text(fields, ['物品类别号', '物品类别码']);
    const item: CatalogItem = {
      sku,
      name: text(fields, ['名称', '物品名称']),
      specification: text(fields, [
        '规格型号、设备序列号',
        '物品规格型号、设备序列号',
        '规格型号',
      ]),
      building: text(fields, ['楼栋']),
      primaryCategory: text(fields, ['一级分类']),
      secondaryCategory: text(fields, ['二级分类']),
      specialty: text(fields, ['专业']),
      unit: text(fields, ['计数单位']),
      unitPrice: number(fields, ['物品单价']) ?? 0,
    };
    if (sku && !bySku.has(sku)) bySku.set(sku, item);

    const nameKey = normalizeItemName(item.name);
    if (!nameKey) continue;
    const matches = byName.get(nameKey) ?? [];
    matches.push(item);
    byName.set(nameKey, matches);
  }
  return { bySku, byName };
}

function resolveRequestUnit(input: {
  explicitUnit: string;
  catalogItem: CatalogItem | undefined;
  catalogByName: ReadonlyMap<string, CatalogItem[]>;
  title: string;
  building: string;
}): string {
  if (input.explicitUnit) return input.explicitUnit;
  if (input.catalogItem?.unit) return input.catalogItem.unit;

  const matches = input.catalogByName.get(normalizeItemName(input.title)) ?? [];
  const building = input.building.trim();
  const sameBuildingMatches = building
    ? matches.filter((item) => item.building.trim() === building)
    : [];

  return (
    uniqueCatalogUnit(sameBuildingMatches) || uniqueCatalogUnit(matches) || '件'
  );
}

function uniqueCatalogUnit(items: CatalogItem[]): string {
  const units = new Set(
    items.map((item) => item.unit.trim()).filter((unit) => Boolean(unit)),
  );
  return units.size === 1 ? [...units][0] : '';
}

function normalizeItemName(value: string): string {
  return value
    .trim()
    .normalize('NFKC')
    .replace(/\s+/g, '')
    .toLocaleLowerCase('zh-CN');
}

function buildInventory(
  records: BitableRecordItem[],
  catalogBySku: Map<string, CatalogItem>,
): {
  alerts: PurchaseInventoryAlertItem[];
  categoryBreakdown: Array<{
    category: string;
    skuCount: number;
    quantity: number;
  }>;
  skuCount: number;
  availableQuantity: number;
  inventoryValue: number;
  lowStockCount: number;
} {
  const alerts: PurchaseInventoryAlertItem[] = [];
  const categories = new Map<string, { skus: Set<string>; quantity: number }>();
  const skus = new Set<string>();
  let availableQuantity = 0;
  let inventoryValue = 0;

  records.forEach((record, position) => {
    const fields = fieldsOf(record);
    const recordId = getRecordId(record) || `inventory:${position}`;
    const sku = text(fields, ['物品类别号', '物品类别码']);
    const catalogItem = sku ? catalogBySku.get(sku) : undefined;
    const available = number(fields, ['剩余库存']) ?? 0;
    const reorderPoint = number(fields, ['最小库存量']) ?? 0;
    const reportedDifference = number(fields, ['剩余库存是否满足最小库存量']);
    const difference = reportedDifference ?? available - reorderPoint;
    const category =
      text(fields, ['一级分类']) || catalogItem?.primaryCategory || '未分类';
    const value =
      number(fields, ['现存物品价格']) ??
      Math.max(available, 0) * (catalogItem?.unitPrice ?? 0);
    const skuKey = sku || recordId;
    const bucket = categories.get(category) ?? {
      skus: new Set<string>(),
      quantity: 0,
    };
    bucket.skus.add(skuKey);
    bucket.quantity += available;
    categories.set(category, bucket);
    skus.add(skuKey);
    availableQuantity += available;
    inventoryValue += value;

    const riskLabel = text(fields, ['是否达到最小库存']);
    const isLowStock =
      difference < 0 || /(不足|低于|缺货|预警)/.test(riskLabel);
    if (!isLowStock) return;

    alerts.push({
      recordId,
      sku,
      name:
        text(fields, ['名称', '物品名称']) || catalogItem?.name || '未命名物品',
      building: text(fields, ['楼栋']) || catalogItem?.building || '',
      category,
      location: text(fields, getWarehouseInventoryLocationReadFieldNames()),
      availableQuantity: available,
      reorderPoint,
      difference,
      unit: text(fields, ['计数单位']) || catalogItem?.unit || '',
      value: roundMoney(value),
      owners: extractDisplayValues(pickField(fields, ['负责人'])),
      riskTone: inventoryRiskTone(available, reorderPoint, difference),
    });
  });

  return {
    alerts: alerts
      .sort((left, right) => left.difference - right.difference)
      .slice(0, 50),
    categoryBreakdown: [...categories.entries()]
      .map(([category, value]) => ({
        category,
        skuCount: value.skus.size,
        quantity: value.quantity,
      }))
      .sort((left, right) => right.quantity - left.quantity),
    skuCount: skus.size,
    availableQuantity,
    inventoryValue,
    lowStockCount: alerts.length,
  };
}

function buildMovements(
  records: BitableRecordItem[],
  type: 'inbound' | 'outbound',
  catalogBySku: Map<string, CatalogItem>,
): PurchaseInventoryMovementItem[] {
  return records
    .map((record, position) => {
      const fields = fieldsOf(record);
      const sku = text(fields, ['物品类别号', '物品类别码']);
      const catalogItem = sku ? catalogBySku.get(sku) : undefined;
      const inbound = type === 'inbound';
      return {
        recordId: getRecordId(record) || `${type}:${position}`,
        type,
        sku,
        name:
          text(fields, ['物品名称', '名称']) ||
          catalogItem?.name ||
          '物品信息待补充',
        quantity: number(fields, [inbound ? '入库数量' : '出库数量']) ?? 0,
        status: inbound ? text(fields, ['物品状态']) || '状态未填写' : '已出库',
        building:
          text(fields, [inbound ? '楼栋' : '出库楼栋']) ||
          catalogItem?.building ||
          '',
        location: text(fields, [inbound ? '存放位置' : '出库存放地点']),
        sourceOrReason: text(fields, [inbound ? '入库来源' : '领用原因']),
        operator: text(fields, [
          inbound ? '经办人' : '出库人',
          inbound ? '采购人' : '领用人账号',
          inbound ? '申请人' : '领用人',
        ]),
        createdAt:
          dateTime(fields, [
            inbound ? '入库时间' : '出库时间',
            '记录创建时间',
          ]) || recordCreatedAt(record),
      } satisfies PurchaseInventoryMovementItem;
    })
    .sort((left, right) => compareDateDesc(left.createdAt, right.createdAt));
}

function createStageCounts(
  requests: PurchaseInventoryRequestItem[],
): Record<PurchaseInventoryStage, number> {
  const counts = Object.fromEntries(
    STAGES.map((stage) => [stage, 0]),
  ) as Record<PurchaseInventoryStage, number>;
  for (const request of requests) counts[request.stage] += 1;
  return counts;
}

function fieldsOf(record: BitableRecordItem | null): RecordFields {
  return record?.fields ?? {};
}

function purchaseCode(
  submissionFields: RecordFields,
  executionFields: RecordFields,
): string {
  const submissionCode = text(submissionFields, ['采购编码']);
  const executionCode = text(executionFields, ['采购编码']);
  if (
    submissionCode &&
    executionCode &&
    submissionCode !== executionCode &&
    /^CG\d{6}-\d{3}$/.test(submissionCode) &&
    /^CG\d{6}-\d{3}$/.test(executionCode)
  ) {
    return submissionCode;
  }
  return executionCode || submissionCode;
}

function itemName(
  executionFields: RecordFields,
  submissionFields: RecordFields,
): string {
  return (
    text(executionFields, ['物品名称']) ||
    text(submissionFields, ['非新增物品名称']) ||
    text(submissionFields, ['新增物品名称'])
  );
}

const PURCHASE_LINK_FIELD_NAMES = [
  '线上链接（仅线上需填写）',
  '线上链接2',
  '线上链接3',
] as const;

function extractPurchaseLinks(...fieldSets: RecordFields[]): string[] {
  const links: string[] = [];
  const seen = new Set<string>();
  for (const fields of fieldSets) {
    for (const fieldName of PURCHASE_LINK_FIELD_NAMES) {
      for (const candidate of linkCandidates(fields[fieldName])) {
        const url = candidate.trim();
        if (!/^https?:\/\//i.test(url) || seen.has(url)) continue;
        seen.add(url);
        links.push(url);
        if (links.length === 3) return links;
      }
    }
  }
  return links;
}

function linkCandidates(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(linkCandidates);
  if (!value || typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  return ['link', 'url', 'href', 'value', 'text'].flatMap((key) =>
    linkCandidates(record[key]),
  );
}

function text(fields: RecordFields, names: string[]): string {
  return extractDisplayText(pickField(fields, names));
}

function number(fields: RecordFields, names: string[]): number | null {
  return extractNumberValue(pickField(fields, names));
}

function dateTime(fields: RecordFields, names: string[]): string | null {
  return extractDateTimeIso(pickField(fields, names));
}

function recordCreatedAt(record: BitableRecordItem | null): string | null {
  return record?.created_time ? extractDateTimeIso(record.created_time) : null;
}

function checked(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value === 'number') return value > 0;
  const label = extractDisplayText(value).trim().toLowerCase();
  return ['true', '1', '是', '已完成', '已确认', '完成', '确认', '✅'].includes(
    label,
  );
}

function normalizePriority(value: unknown): PurchaseInventoryPriority {
  const label = extractDisplayText(value).trim().toUpperCase();
  return label === 'P0' || label === 'P1' || label === 'P2' || label === 'P3'
    ? label
    : '未设置';
}

function inventoryRiskTone(
  available: number,
  reorderPoint: number,
  difference: number,
): InventoryRiskTone {
  if (available <= 0 || difference <= -Math.max(1, reorderPoint / 2)) {
    return 'critical';
  }
  return difference < 0 ? 'warning' : 'normal';
}

function compareDateDesc(left: string | null, right: string | null): number {
  return dateScore(right) - dateScore(left);
}

function compareRecordsByCreatedAt(
  left: BitableRecordItem,
  right: BitableRecordItem,
): number {
  const leftDate =
    dateTime(fieldsOf(left), ['创建日期', '记录创建时间']) ||
    recordCreatedAt(left);
  const rightDate =
    dateTime(fieldsOf(right), ['创建日期', '记录创建时间']) ||
    recordCreatedAt(right);
  return compareDateDesc(leftDate, rightDate);
}

function dateScore(value: string | null): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}
