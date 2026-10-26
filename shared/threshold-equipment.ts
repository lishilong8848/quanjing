import type { ThresholdRecord } from './threshold-management.interface';

const modelDevices = new Set([
  '冷水机组',
  '依米康水冷精密空调',
  '英维克风冷空调',
  '艾特网能水冷精密空调',
  '依米康风冷空调',
  '恒湿机',
  '定压补水装置',
  '变频补水机组参数表',
]);
const floorOnly = /^(?:[A-EH]、)*[A-EH]楼$|^[A-EH]$/;

// 仅拆分原表导入的旧组合字段；手工填写的独立型号、位置不作推测。
export function normalizeThresholdEquipment(
  record: ThresholdRecord,
): ThresholdRecord {
  if (!record.source) return record;
  const raw = record.location.trim();
  const parts = raw.split(' · ');
  const removeBuilding = (text: string) => {
    if (floorOnly.test(text) || /^原表[A-Z]+列$/.test(text)) return '';
    const letter = record.building.match(/^([A-EH])楼$/)?.[1];
    return letter
      ? text.replace(new RegExp(`^${letter}[-－]`), '').trim()
      : text;
  };
  let location = parts.map(removeBuilding).filter(Boolean).join(' · ');
  let model = '';
  let brand = '';
  let legacy = false;
  if (record.profession === '电气') {
    if (record.device === 'UPS' && /^\d+K UPS$/.test(parts[0])) {
      model = parts[0];
      location = parts.slice(1).map(removeBuilding).filter(Boolean).join(' · ');
      legacy = true;
    } else if (
      record.device === 'ATS' &&
      /^(?:H型控制器|L5型控制器|GE ATS|ABB ATS)$/.test(parts[0])
    ) {
      model = parts[0];
      const special = parts[1]?.match(/^[A-EH]楼[（(]([^）)]+)[）)]型$/);
      if (special) model = `${special[1]}型`;
      brand = parts[0].match(/^(GE|ABB) ATS$/)?.[1] || '';
      location = special
        ? ''
        : parts.slice(1).map(removeBuilding).filter(Boolean).join(' · ');
      legacy = true;
    }
    brand ||= record.section.match(/^(施耐德|金盘)变压器$/)?.[1] || '';
  } else if (record.profession === '暖通') {
    const combined = raw.match(/^(.+?)[（(]([^()（）]+)[）)]$/u);
    if (record.device === '空调软件版本' && parts.length > 1) {
      location = parts[0];
      brand = parts.slice(1).join(' · ');
      legacy = true;
    } else if (
      ['水泵', '加药装置'].includes(record.device) &&
      parts.length > 1
    ) {
      location = parts[0];
      model = parts.slice(1).join(' · ');
      legacy = true;
    } else if (
      modelDevices.has(record.device) &&
      raw &&
      (record.model === undefined ||
        record.model === raw ||
        record.model === combined?.[1])
    ) {
      model = floorOnly.test(raw) ? '' : combined?.[1] || raw;
      brand = combined?.[2] || '';
      location = '';
      legacy = true;
    }
    brand ||= record.device.match(/^(依米康|英维克|艾特网能)/)?.[1] || '';
  }
  const previousModel = record.model || '';
  const erroneous =
    floorOnly.test(previousModel) ||
    (record.profession === '电气' &&
      previousModel === parts.slice(1).join(' · '));
  return {
    ...record,
    location,
    model: previousModel && !erroneous ? previousModel : model,
    brand:
      record.brand === undefined || (legacy && !record.brand)
        ? brand
        : record.brand,
  };
}
