import type { BitableRecordItem } from '../../common/feishu/bitable-direct-read';

export const INVENTORY_WORKFLOW_CODES = [
  'purchase_backfill',
  'purchase_h',
  'purchase_abcde',
  'item_confirmation',
] as const;

export type InventoryWorkflowCode = (typeof INVENTORY_WORKFLOW_CODES)[number];
export type PurchaseWorkflowCode = Extract<
  InventoryWorkflowCode,
  'purchase_h' | 'purchase_abcde'
>;

type PurchaseBuilding = 'A楼' | 'B楼' | 'C楼' | 'D楼' | 'E楼' | 'H楼';

export interface PurchaseAutomationAction {
  building: PurchaseBuilding;
  inboundFields: Record<string, unknown>;
  recipients: string[];
  detailButton: boolean;
}

const PURCHASE_RECIPIENTS: Record<PurchaseBuilding, string[]> = {
  A楼: [
    'ou_6d8059fdf5a524ceaf964076187dae8f',
    'ou_32ff59c86bbadabb6c22c21f0ad249ec',
    'ou_98fd35eb79d3f290280b9ddf6eacd2f5',
  ],
  B楼: [
    'ou_6d8059fdf5a524ceaf964076187dae8f',
    'ou_0c3cee3752565ff30bc38a1ddb20a1aa',
  ],
  C楼: [
    'ou_6d8059fdf5a524ceaf964076187dae8f',
    'ou_1b45c51fec99162ce1e78bd2f06aeedf',
  ],
  D楼: [
    'ou_6d8059fdf5a524ceaf964076187dae8f',
    'ou_6e9ab06be2174a56908c289a4c4926fa',
  ],
  E楼: [
    'ou_6d8059fdf5a524ceaf964076187dae8f',
    'ou_ed5a06724bca67ebe08aa94e5505c882',
  ],
  H楼: [
    'ou_6d8059fdf5a524ceaf964076187dae8f',
    'ou_5a4c9222affb2062a1f0d4f167181121',
  ],
};

const ABCDE_BUILDINGS: PurchaseBuilding[] = ['A楼', 'B楼', 'C楼', 'D楼', 'E楼'];
const EXCLUDED_ABCDE_REQUESTERS = new Set([
  'ou_0e3ade873ee4d95533919427546c100b',
  'ou_4fa470cbe21075fb274583fdf0dee727',
]);

export function isInventoryWorkflowCode(value: string): value is InventoryWorkflowCode {
  return (INVENTORY_WORKFLOW_CODES as readonly string[]).includes(value);
}

export function isPurchaseBackfillCandidate(record: BitableRecordItem): boolean {
  const fields = record.fields || {};
  return (
    fieldText(fields['物品类别码']) !== '' &&
    isPresent(fields['签收时间']) &&
    !fieldChecked(fields['是否已入库'])
  );
}

export function buildPurchaseAutomationAction(
  code: PurchaseWorkflowCode,
  record: BitableRecordItem,
): PurchaseAutomationAction | null {
  return buildPurchaseAutomationActions(code, record)[0] || null;
}

export function buildPurchaseAutomationActions(
  code: PurchaseWorkflowCode,
  record: BitableRecordItem,
): PurchaseAutomationAction[] {
  const fields = record.fields || {};
  if (!isCommonPurchaseCandidate(fields)) return [];
  if (
    code === 'purchase_abcde' &&
    extractOpenIds(fields['需求人']).some((id) =>
      EXCLUDED_ABCDE_REQUESTERS.has(id),
    )
  ) {
    return [];
  }

  const selectedBuildings = new Set(fieldValues(fields['申请楼栋']));
  const buildings = code === 'purchase_h' ? ['H楼' as const] : ABCDE_BUILDINGS;

  return buildings
    .filter((building) => selectedBuildings.has(building))
    .map((building) => ({
      building,
      inboundFields: {
        楼栋: building,
        物品类别号: fieldText(fields['物品类别码']),
        入库数量: fieldNumber(fields['实际采购数量']),
        入库日期: fields['签收时间'],
        '采购入库后是否需要即可领用出库（勿点）':
          building === 'A楼'
            ? false
            : fieldChecked(
                fields['采购到货入库后是否需要立即领用出库'],
              ),
      },
      recipients: [...PURCHASE_RECIPIENTS[building]],
      detailButton: code === 'purchase_abcde',
    }));
}

export function buildBackfillInboundFields(
  record: BitableRecordItem,
): Record<string, unknown> {
  const fields = record.fields || {};
  const building = fieldValues(fields['申请楼栋'])[0] || '';
  return {
    物品类别号: fieldText(fields['物品类别码']),
    入库日期: fields['签收时间'],
    楼栋: building,
    入库数量: fieldNumber(fields['实际采购数量']),
  };
}

export function isItemConfirmationCandidate(record: BitableRecordItem): boolean {
  return fieldValues(record.fields?.['是否借出本楼栋']).includes('是');
}

export function extractOpenIds(value: unknown): string[] {
  const result = new Set<string>();
  const visit = (current: unknown): void => {
    if (typeof current === 'string') {
      for (const candidate of current.split(/[,，、;；\s]+/)) {
        if (/^ou_[A-Za-z0-9]+$/.test(candidate)) result.add(candidate);
      }
      return;
    }
    if (Array.isArray(current)) {
      current.forEach(visit);
      return;
    }
    if (!current || typeof current !== 'object') return;
    const object = current as Record<string, unknown>;
    visit(object.id);
    visit(object.open_id);
    visit(object.value);
  };
  visit(value);
  return [...result];
}

function isCommonPurchaseCandidate(fields: Record<string, unknown>): boolean {
  return (
    fieldText(fields['物品类别码']) !== '' &&
    !fieldChecked(fields['是否已入库']) &&
    isPresent(fields['签收时间']) &&
    fieldChecked(fields['采购完成']) &&
    !fieldValues(fields['1️⃣物品采购方式']).includes('驳回')
  );
}

function fieldChecked(value: unknown): boolean {
  if (value === true || value === 1) return true;
  if (typeof value === 'string') {
    return ['true', '1', '是', 'checked'].includes(value.trim().toLowerCase());
  }
  if (Array.isArray(value)) return value.some(fieldChecked);
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return fieldChecked(object.value ?? object.text ?? object.name);
  }
  return false;
}

function fieldNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Number(fieldText(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

function fieldText(value: unknown): string {
  return fieldValues(value).join('、');
}

function fieldValues(value: unknown): string[] {
  const values: string[] = [];
  const visit = (current: unknown): void => {
    if (current === null || current === undefined || current === false) return;
    if (typeof current === 'string' || typeof current === 'number') {
      const text = String(current).trim();
      if (text) values.push(text);
      return;
    }
    if (Array.isArray(current)) {
      current.forEach(visit);
      return;
    }
    if (typeof current === 'object') {
      const object = current as Record<string, unknown>;
      visit(object.text ?? object.name ?? object.value);
    }
  };
  visit(value);
  return [...new Set(values)];
}

function isPresent(value: unknown): boolean {
  if (value === null || value === undefined || value === '') return false;
  if (Array.isArray(value)) return value.some(isPresent);
  return true;
}
