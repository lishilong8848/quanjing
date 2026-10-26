import type { ThresholdRecord } from '@shared/threshold-management.interface';
import { normalizeThresholdEquipment } from '@shared/threshold-equipment';

export interface ThresholdComparisonGroup {
  key: string;
  label: string;
  buildings: string[];
  records: ThresholdRecord[];
}

export function buildThresholdComparisonGroups(records: ThresholdRecord[]) {
  const entities = new Map<string, ThresholdRecord[]>();
  for (const raw of records) {
    const record = normalizeThresholdEquipment(raw);
    const key = JSON.stringify([
      record.profession,
      record.device,
      record.building,
      record.location,
      record.model || '',
      record.brand || '',
    ]);
    const entity = entities.get(key) || [];
    entity.push(record);
    entities.set(key, entity);
  }
  const groups = new Map<string, ThresholdComparisonGroup>();
  for (const entity of entities.values()) {
    const first = entity[0];
    const type = ['水泵', '加药装置', '空调软件版本'].includes(first.device)
      ? first.location.split(' · ')[0]
      : '';
    const structure = entity
      .map((r) => JSON.stringify([r.section, r.parameter, r.unit]))
      .sort();
    const key = JSON.stringify([
      first.profession,
      first.device,
      first.brand || '',
      first.model || '',
      type,
      structure,
    ]);
    const group = groups.get(key) || {
      key,
      label: !first.building
        ? '未标明楼栋'
        : [
            first.model?.startsWith(`${first.brand} `) ? '' : first.brand,
            type,
            first.model,
          ]
            .filter(Boolean)
            .join(' · ') || first.device,
      buildings: [],
      records: [],
    };
    group.records.push(...entity);
    if (!group.buildings.includes(first.building || '待核对'))
      group.buildings.push(first.building || '待核对');
    groups.set(key, group);
  }
  const result = [...groups.values()];
  if (result.length > 1) {
    for (const group of result) {
      if (group.label === group.records[0].device) {
        const sections = [
          ...new Set(
            group.records.map((record) => record.section).filter(Boolean),
          ),
        ];
        const locations = [
          ...new Set(group.records.map((record) => record.location)),
        ];
        group.label =
          sections.length === 1 && group.records[0].device === '中压逻辑时间'
            ? sections[0]
            : locations.length === 1 && locations[0]
              ? locations[0]
              : group.buildings.join(' · ');
      }
    }
  }
  const labelCounts = new Map<string, number>();
  result.forEach((group) =>
    labelCounts.set(group.label, (labelCounts.get(group.label) || 0) + 1),
  );
  for (const group of result) {
    if ((labelCounts.get(group.label) || 0) > 1) {
      const locations = [
        ...new Set(group.records.map((r) => r.location).filter(Boolean)),
      ].join('、');
      group.label = [
        ...new Set([group.label, locations, group.buildings.join('、')]),
      ]
        .filter(Boolean)
        .join(' · ');
    }
  }
  return result.sort(
    (a, b) =>
      Number(a.records.every((r) => !r.building)) -
      Number(b.records.every((r) => !r.building)),
  );
}
