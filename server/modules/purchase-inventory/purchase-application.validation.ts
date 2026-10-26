import type {
  ProcurementForm,
  PurchaseApplicationBatchRequest,
  PurchaseApplicationItemInput,
  PurchaseApplicationValidationIssue,
  PurchaseApplicationValidationResult,
} from '../../../shared/purchase-application.interface';
import { PURCHASE_MANAGER_APPROVAL_FIELDS } from './purchase-manager-approval.fields';

const MAX_ITEMS = 20;
const BUILDINGS = new Set(['H楼', 'A楼', 'B楼', 'C楼', 'D楼', 'E楼', '110站']);
const SPECIALTIES = new Set(['电气', '暖通', '弱电', '消防', '土建', '其他']);
const PURCHASE_METHODS = new Set(['需求自采（楼内）', '综合采购']);
const PURCHASE_CHANNELS = new Set(['线上', '线下']);
const PROCUREMENT_FORMS = new Set(['三方比价', '单一采购']);

export function lineTotal(item: PurchaseApplicationItemInput): number {
  return roundMoney(
    item.quantity * item.unitPrice + item.shippingFee - item.discount,
  );
}

export function batchTotals(items: PurchaseApplicationItemInput[]) {
  return {
    itemKinds: items.length,
    quantity: items.reduce((sum, item) => sum + item.quantity, 0),
    goodsAmount: roundMoney(
      items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0),
    ),
    shippingFee: roundMoney(
      items.reduce((sum, item) => sum + item.shippingFee, 0),
    ),
    discount: roundMoney(
      items.reduce((sum, item) => sum + item.discount, 0),
    ),
    total: roundMoney(items.reduce((sum, item) => sum + lineTotal(item), 0)),
  };
}

export function validatePurchaseApplication(
  input: PurchaseApplicationBatchRequest,
  today: string,
): PurchaseApplicationValidationResult {
  const value = normalizeRequest(input);
  const issues: PurchaseApplicationValidationIssue[] = [];
  const shared = value.shared;

  if (
    !shared.applicantRecordId ||
    !shared.applicantOpenId ||
    !shared.applicantName
  ) {
    issues.push({
      code: 'MISSING_APPLICANT',
      path: 'shared.applicantName',
      message: '请从在职人员表选择申请人',
    });
  }
  requiredOption(issues, 'shared.building', shared.building, BUILDINGS, '请选择申请楼栋');
  requiredOption(issues, 'shared.specialty', shared.specialty, SPECIALTIES, '请选择专业');
  requiredOption(
    issues,
    'shared.purchaseMethod',
    shared.purchaseMethod,
    PURCHASE_METHODS,
    '请选择采购方式',
  );
  requiredOption(
    issues,
    'shared.purchaseChannel',
    shared.purchaseChannel,
    PURCHASE_CHANNELS,
    '请选择采购渠道',
  );
  requiredOption(
    issues,
    'shared.procurementForm',
    shared.procurementForm,
    PROCUREMENT_FORMS,
    '请选择采购形式',
  );
  requiredText(issues, 'shared.supplier', shared.supplier, '请填写供应商');
  if (shared.procurementForm === '单一采购') {
    requiredText(
      issues,
      'shared.singleReason',
      shared.singleReason,
      '请填写单一采购原因',
    );
  }
  requiredText(
    issues,
    'shared.requirementSummary',
    shared.requirementSummary,
    '请填写需求简述',
  );
  validateExpectedDate(issues, shared.expectedDeliveryDate, today);

  if (!value.items.length) {
    issues.push({
      code: 'EMPTY_ITEMS',
      path: 'items',
      message: '至少添加一种采购物品',
    });
  }
  if (value.items.length > MAX_ITEMS) {
    issues.push({
      code: 'TOO_MANY_ITEMS',
      path: 'items',
      message: `单批最多 ${MAX_ITEMS} 种物品`,
    });
  }

  for (const item of value.items) {
    validateItem(item, shared.purchaseChannel, issues);
  }

  return {
    value: issues.length ? null : value,
    issues,
  };
}

export function buildPurchaseApplicationFields(
  request: PurchaseApplicationBatchRequest,
  item: PurchaseApplicationItemInput,
  attachmentTokens: string[],
  requestCode: string,
): Record<string, unknown> {
  const procurementForm = requireProcurementForm(
    clean(request.shared.procurementForm),
  );
  const procurement = mapProcurementForm(procurementForm);
  const fields: Record<string, unknown> = {
    采购编码: requestCode,
    业务申请人: [{ id: request.shared.applicantOpenId }],
    '申请楼栋（多楼请选H楼，备注里填写详情）': request.shared.building,
    专业: request.shared.specialty,
    采购方式: request.shared.purchaseMethod,
    采购渠道: request.shared.purchaseChannel,
    供应商: request.shared.supplier,
    采购数量: item.quantity,
    单位: item.unit,
    单价: item.unitPrice,
    运费: item.shippingFee.toFixed(2),
    减免: item.discount.toFixed(2),
    是否满足三方比价: procurement.comparisonSatisfied,
    '需求简述（采购原因、目的等）': request.shared.requirementSummary,
    期望交付时间: toShanghaiMidnightTimestamp(
      request.shared.expectedDeliveryDate,
    ),
    '是否需要录入 库房台账': request.shared.immediateOutbound,
    其他备注: request.shared.notes,
    '提交成功（无需点击🚫）': true,
  };

  if (procurementForm === '三方比价' && attachmentTokens.length) {
    fields['三方比价依据（邮件及报价单）线下填写即可'] =
      attachmentTokens.map((fileToken) => ({ file_token: fileToken }));
  }

  assignOnlineLinkFields(fields, request.shared.purchaseChannel, item);

  // 申请表的分类、非新增物品、品牌和规格是条件级联单选，飞书 OpenAPI 不支持写入。
  // 统一用可写的物品名称文本列保留编码唯一性，已有/新增由执行表 SKU 是否匹配目录判定。
  fields['新增物品名称'] = item.itemName;
  if (item.mode === 'new') {
    if (item.specification) fields['规格型号'] = item.specification;
    if (item.brand) fields['品牌'] = item.brand;
  }

  return fields;
}

export function buildPurchaseExecutionFields(
  request: PurchaseApplicationBatchRequest,
  item: PurchaseApplicationItemInput,
  attachmentTokens: string[],
  requestCode: string,
  approvalBatchId = '',
): Record<string, unknown> {
  const procurementForm = requireProcurementForm(
    clean(request.shared.procurementForm),
  );
  const procurement = mapProcurementForm(procurementForm);
  const fields: Record<string, unknown> = {
    采购编码: requestCode,
    需求人: [{ id: request.shared.applicantOpenId }],
    申请楼栋: [request.shared.building],
    专业: request.shared.specialty,
    一级分类: item.primaryCategory,
    二级分类: item.secondaryCategory,
    '1️⃣物品采购方式':
      request.shared.purchaseMethod === '需求自采（楼内）'
        ? '需求自采'
        : request.shared.purchaseMethod,
    采购渠道: request.shared.purchaseChannel,
    供应商: request.shared.supplier,
    采购申请数量: item.quantity,
    计数单位: item.unit,
    单价: item.unitPrice,
    运费: item.shippingFee.toFixed(2),
    减免: item.discount.toFixed(2),
    物品名称: item.itemName,
    '物品规格型号、设备序列号': item.specification,
    物品品牌: item.brand,
    '是否满足三家比价（线下）': procurement.comparisonSatisfied,
    单一原因: procurement.isSingle ? clean(request.shared.singleReason) : '',
    '需求简述（采购原因、目的等）': request.shared.requirementSummary,
    期望交付时间: toShanghaiMidnightTimestamp(
      request.shared.expectedDeliveryDate,
    ),
    采购到货入库后是否需要立即领用出库:
      request.shared.immediateOutbound,
    '需求备注（提交人)': request.shared.notes,
    采购流程: '未开始（待审批）',
    库房确认: false,
    采购完成: false,
  };
  const normalizedApprovalBatchId = clean(approvalBatchId);
  if (normalizedApprovalBatchId) {
    fields[PURCHASE_MANAGER_APPROVAL_FIELDS.batchId] =
      normalizedApprovalBatchId;
  }
  if (procurementForm === '三方比价' && attachmentTokens.length) {
    fields['三方比价依据（邮件/报价单）'] =
      attachmentTokens.map((fileToken) => ({ file_token: fileToken }));
  }
  assignOnlineLinkFields(fields, request.shared.purchaseChannel, item);
  return fields;
}

const ONLINE_LINK_FIELD_NAMES = [
  '线上链接（仅线上需填写）',
  '线上链接2',
  '线上链接3',
] as const;

function assignOnlineLinkFields(
  fields: Record<string, unknown>,
  purchaseChannel: string,
  item: PurchaseApplicationItemInput,
): void {
  if (purchaseChannel !== '线上') return;
  (item.onlineUrls || []).slice(0, 3).forEach((url, index) => {
    fields[ONLINE_LINK_FIELD_NAMES[index]] = linkFieldValue(url, index);
  });
}

function linkFieldValue(
  value: string,
  index: number,
): { link: string; text: string } {
  return { link: value, text: `采购链接${index + 1}` };
}

function isProcurementForm(value: string): value is ProcurementForm {
  return PROCUREMENT_FORMS.has(value);
}

function requireProcurementForm(value: string): ProcurementForm {
  if (!isProcurementForm(value)) {
    throw new Error('采购形式无效');
  }
  return value;
}

function mapProcurementForm(procurementForm: ProcurementForm): {
  isSingle: boolean;
  comparisonSatisfied: PurchaseApplicationBatchRequest['shared']['comparisonSatisfied'];
} {
  const isSingle = procurementForm === '单一采购';
  return {
    isSingle,
    comparisonSatisfied: isSingle ? '否' : '是',
  };
}

function normalizeRequest(
  input: PurchaseApplicationBatchRequest,
): PurchaseApplicationBatchRequest {
  const shared = input?.shared ?? ({} as PurchaseApplicationBatchRequest['shared']);
  const procurementForm = clean(shared.procurementForm);
  const procurement = mapProcurementForm(
    isProcurementForm(procurementForm) ? procurementForm : '三方比价',
  );
  return {
    shared: {
      applicantRecordId: clean(shared.applicantRecordId),
      applicantOpenId: clean(shared.applicantOpenId),
      applicantName: clean(shared.applicantName),
      applicantEmployeeNo: clean(shared.applicantEmployeeNo),
      applicantPosition: clean(shared.applicantPosition),
      applicantBuilding: clean(shared.applicantBuilding),
      building: clean(shared.building) as PurchaseApplicationBatchRequest['shared']['building'],
      specialty: clean(shared.specialty) as PurchaseApplicationBatchRequest['shared']['specialty'],
      purchaseMethod: clean(shared.purchaseMethod) as PurchaseApplicationBatchRequest['shared']['purchaseMethod'],
      purchaseChannel: clean(shared.purchaseChannel) as PurchaseApplicationBatchRequest['shared']['purchaseChannel'],
      supplier: clean(shared.supplier),
      onlineUrl: clean(shared.onlineUrl),
      procurementForm:
        procurementForm as PurchaseApplicationBatchRequest['shared']['procurementForm'],
      comparisonSatisfied: procurement.comparisonSatisfied,
      singleReason: procurement.isSingle ? clean(shared.singleReason) : '',
      requirementSummary: clean(shared.requirementSummary),
      expectedDeliveryDate: clean(shared.expectedDeliveryDate),
      immediateOutbound: shared.immediateOutbound === true,
      notes: clean(shared.notes),
    },
    items: Array.isArray(input?.items)
      ? input.items.map((item) => ({
          lineId: clean(item.lineId),
          mode: item.mode === 'new' ? 'new' : 'existing',
          catalogRecordId: clean(item.catalogRecordId),
          sku: clean(item.sku),
          primaryCategory: clean(item.primaryCategory),
          secondaryCategory: clean(item.secondaryCategory),
          itemName: clean(item.itemName),
          specification: clean(item.specification),
          brand: clean(item.brand),
          quantity: finiteNumber(item.quantity),
          unit: clean(item.unit),
          unitPrice: finiteNumber(item.unitPrice),
          shippingFee: finiteNumber(item.shippingFee),
          discount: finiteNumber(item.discount),
          onlineUrls: normalizeOnlineUrls(item, shared.onlineUrl),
        }))
      : [],
  };
}

function validateItem(
  item: PurchaseApplicationItemInput,
  purchaseChannel: string,
  issues: PurchaseApplicationValidationIssue[],
) {
  const add = (code: string, path: string, message: string) =>
    issues.push({ code, path, message, lineId: item.lineId });

  if (!item.lineId) add('MISSING_LINE_ID', 'lineId', '物品行标识缺失');
  if (!item.primaryCategory) add('MISSING_PRIMARY_CATEGORY', 'primaryCategory', '请选择一级分类');
  if (!item.secondaryCategory) add('MISSING_SECONDARY_CATEGORY', 'secondaryCategory', '请选择二级分类');
  if (item.mode === 'existing' && (!item.catalogRecordId || !item.itemName)) {
    add('MISSING_CATALOG_ITEM', 'itemName', '请选择已有物品');
  }
  if (item.mode === 'new' && !item.itemName) {
    add('MISSING_NEW_ITEM_NAME', 'itemName', '请填写新增物品名称');
  }
  if (!Number.isInteger(item.quantity) || item.quantity <= 0) {
    add('INVALID_QUANTITY', 'quantity', '采购数量必须为正整数');
  }
  if (!item.unit) add('MISSING_UNIT', 'unit', '请填写单位');
  if (!isNonNegative(item.unitPrice)) add('INVALID_UNIT_PRICE', 'unitPrice', '单价不得为负数');
  if (!isNonNegative(item.shippingFee)) add('INVALID_SHIPPING_FEE', 'shippingFee', '运费不得为负数');
  if (!isNonNegative(item.discount)) add('INVALID_DISCOUNT', 'discount', '减免不得为负数');
  if (purchaseChannel === '线上') {
    const onlineUrls = item.onlineUrls || [];
    if (!onlineUrls.length) {
      add(
        'MISSING_ONLINE_URL',
        'onlineUrls',
        '线上采购每个物品至少填写一个采购链接',
      );
    } else if (onlineUrls.length > 3) {
      add(
        'TOO_MANY_ONLINE_URLS',
        'onlineUrls',
        '每个物品最多填写 3 个采购链接',
      );
    } else if (onlineUrls.some((url) => !isHttpUrl(url))) {
      add(
        'INVALID_ONLINE_URL',
        'onlineUrls',
        '采购链接必须是有效的 http 或 https 地址',
      );
    }
  }
  if (
    isNonNegative(item.discount) &&
    item.discount > item.quantity * item.unitPrice + item.shippingFee
  ) {
    add('DISCOUNT_EXCEEDS_AMOUNT', 'discount', '减免不能超过商品金额与运费之和');
  }
}

function normalizeOnlineUrls(
  item: PurchaseApplicationItemInput,
  legacySharedUrl: string,
): string[] {
  const raw = (item as Partial<PurchaseApplicationItemInput>).onlineUrls;
  const values = Array.isArray(raw) ? raw : [legacySharedUrl];
  return values.map(clean).filter(Boolean);
}

function validateExpectedDate(
  issues: PurchaseApplicationValidationIssue[],
  value: string,
  today: string,
) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00+08:00`))) {
    issues.push({ code: 'INVALID_DELIVERY_DATE', path: 'shared.expectedDeliveryDate', message: '请选择有效的期望交付日期' });
    return;
  }
  if (value < today) {
    issues.push({ code: 'PAST_DELIVERY_DATE', path: 'shared.expectedDeliveryDate', message: '期望交付日期不能早于今天' });
  }
}

function requiredText(
  issues: PurchaseApplicationValidationIssue[],
  path: string,
  value: string,
  message: string,
) {
  if (!value) issues.push({ code: 'REQUIRED', path, message });
}

function requiredOption(
  issues: PurchaseApplicationValidationIssue[],
  path: string,
  value: string,
  allowed: Set<string>,
  message: string,
) {
  if (!allowed.has(value)) issues.push({ code: 'INVALID_OPTION', path, message });
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function isNonNegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function finiteNumber(value: unknown): number {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : Number.NaN;
}

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function toShanghaiMidnightTimestamp(value: string): number {
  return new Date(`${value}T00:00:00+08:00`).getTime();
}
