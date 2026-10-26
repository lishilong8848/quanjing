import type { OpenRiskItem } from '../../../shared/monthly-operations-assessment.interface';
import {
  extractDateTimeIso,
  extractDisplayText,
  getRecordId,
  type BitableRecordItem,
} from '../../common/feishu/bitable-direct-read';
import { shanghaiDay } from './monthly-operations-resources.model';

const text = (value: unknown) => extractDisplayText(value).trim();
const building = (value: string) => value.match(/[A-H]楼/)?.[0] ?? '未标注';
const key = (buildingName: string, code: string) => `${buildingName}:${code}`;

export function mapOpenRisks(
  openRows: BitableRecordItem[],
  inspectionRows: BitableRecordItem[],
  start: string,
  asOf: string,
): OpenRiskItem[] {
  const inspections = new Map<
    string,
    {
      date: string;
      status: string;
      current: string;
      finding: string;
      id: string;
    }
  >();
  for (const row of inspectionRows) {
    const fields = row.fields ?? {};
    const code = text(fields['风险编号']);
    const place = building(text(fields['楼栋']));
    const created = extractDateTimeIso(fields['记录创建时间']);
    const date = created ? shanghaiDay(Date.parse(created)) : '';
    if (!code || place === '未标注' || !date || date < start || date > asOf)
      continue;
    const identifier = key(place, code);
    const previous = inspections.get(identifier);
    if (previous && previous.date > date) continue;
    inspections.set(identifier, {
      date,
      status: text(fields['排查状态']) || '待确认',
      current: text(fields['当前风险状态']),
      finding: text(fields['风险现场情况']),
      id: getRecordId(row),
    });
  }
  const seen = new Set<string>();
  return openRows
    .flatMap((row) => {
      const fields = row.fields ?? {};
      const code = text(fields['风险项编号']);
      const place = building(text(fields['楼栋名称']));
      const identifier = key(place, code);
      if (!code || place === '未标注' || seen.has(identifier)) return [];
      seen.add(identifier);
      const inspection = inspections.get(identifier);
      return [
        {
          id: getRecordId(row) || identifier,
          code,
          building: place,
          level: text(fields['风险等级']) || '未标注',
          category: [
            text(fields['一级分类']),
            text(fields['二级分类']),
            text(fields['三级分类']),
          ]
            .filter(Boolean)
            .join(' / '),
          description: text(fields['检查项_描述']) || '未填写检查项',
          inspectionDate: inspection?.date ?? null,
          inspectionStatus: inspection?.status ?? '本月未排查',
          currentStatus: inspection?.current ?? '',
          finding: inspection?.finding ?? '',
          inspectionId: inspection?.id ?? null,
        },
      ];
    })
    .sort(
      (a, b) =>
        a.building.localeCompare(b.building) || a.code.localeCompare(b.code),
    );
}
