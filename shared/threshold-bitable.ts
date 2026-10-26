import schema from './threshold-bitable.schema.json';
import type { ThresholdRecord } from './threshold-management.interface';
import { normalizeThresholdEquipment } from './threshold-equipment';

export { schema as THRESHOLD_BITABLE_SCHEMA };
export function thresholdToBitableFields(
  record: ThresholdRecord,
  mutationId = '',
): Record<string, string> {
  record = normalizeThresholdEquipment(record);
  const source = record.source;
  const values: Record<string, unknown> = {
    ...record,
    range: record.range || '',
    mutationId,
    model: record.model || '',
    brand: record.brand || '',
    sheet: source?.sheet || '',
    cell: source?.cell || '',
    originalValue: source?.originalValue || '',
    parameterCell: source?.parameterCell || '',
    rangeCell: source?.rangeCell || '',
    noteCell: source?.noteCell || '',
  };
  return Object.fromEntries(
    Object.entries(schema.fields).map(([key, name]) => [
      name,
      values[key] == null ? '' : String(values[key]),
    ]),
  );
}

export function thresholdText(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string' || typeof value === 'number')
    return String(value);
  if (Array.isArray(value)) return value.map(thresholdText).join('');
  if (typeof value === 'object' && 'text' in value)
    return thresholdText(value.text);
  throw new Error('阈值字段类型不符');
}
export function thresholdContentFingerprint(record: ThresholdRecord): string {
  return JSON.stringify(thresholdToBitableFields(record));
}
export function thresholdFieldsMatch(
  expected: Record<string, string>,
  actual: Record<string, unknown>,
): boolean {
  return Object.entries(expected).every(
    ([name, value]) => thresholdText(actual[name]) === value,
  );
}
export function thresholdFromBitableFields(
  fields: Record<string, unknown>,
  profession: string,
): ThresholdRecord {
  const values = Object.fromEntries(
    Object.entries(schema.fields).map(([key, name]) => [
      key,
      thresholdText(fields[name]),
    ]),
  );
  if (
    values.profession !== profession ||
    !values.id ||
    !values.device ||
    !values.parameter ||
    !/^\d+$/.test(values.version) ||
    !Number.isSafeInteger(Number(values.version)) ||
    Number(values.version) < 1
  )
    throw new Error('多维表阈值必填字段或版本无效');
  return normalizeThresholdEquipment({
    id: values.id,
    profession,
    device: values.device,
    section: values.section,
    parameter: values.parameter,
    building: values.building,
    location: values.location,
    model: values.model,
    brand: values.brand,
    value: values.value,
    range: values.range,
    unit: values.unit,
    kind: values.kind as ThresholdRecord['kind'],
    enabled: values.enabled,
    note: values.note,
    version: Number(values.version),
    updatedAt: values.updatedAt,
    source:
      values.sheet || values.cell
        ? {
            sheet: values.sheet,
            cell: values.cell,
            originalValue: values.originalValue,
            ...(values.parameterCell
              ? { parameterCell: values.parameterCell }
              : {}),
            ...(values.rangeCell ? { rangeCell: values.rangeCell } : {}),
            ...(values.noteCell ? { noteCell: values.noteCell } : {}),
          }
        : null,
  });
}
