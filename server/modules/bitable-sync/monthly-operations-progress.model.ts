import type { ZhihangChangeProgress } from '../../../shared/monthly-operations-progress.interface';
import {
  extractDateTimeIso,
  extractDisplayText,
  extractDisplayValues,
  getRecordId,
  type BitableRecordItem,
} from '../../common/feishu/bitable-direct-read';

const text = (v: unknown) => extractDisplayText(v).trim();
const date = (v: unknown) => {
  const iso = extractDateTimeIso(v);
  return iso && Number.isFinite(Date.parse(iso)) ? iso : null;
};

export function mapZhihangProgress(input: BitableRecordItem[]) {
  const records: ZhihangChangeProgress[] = [];
  const seen = new Set<string>();
  let invalid = 0;
  for (const item of input) {
    const id = getRecordId(item);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const f = item.fields ?? {};
    const plannedStart = date(f['计划开始']) || date(f['计划开始时间']);
    const deferredStart =
      date(f['计划延期开始']) || date(f['计划延时开始时间']);
    if (!plannedStart && !deferredStart) invalid++;
    records.push({
      id,
      code: text(f['编码']),
      workOrder: text(f['工单号']),
      title: text(f['标题']) || '未填写变更标题',
      buildings: [
        ...new Set(
          extractDisplayValues(f['楼栋'])
            .map((v) => v.trim())
            .filter(Boolean),
        ),
      ],
      type: text(f['变更类型']),
      category: text(f['变更类别']),
      level: text(f['变更等级']),
      node: text(f['当前节点']),
      status: text(f['状态']),
      executionStatus: text(f['当前状态']),
      plannedStart,
      plannedEnd: date(f['计划结束']) || date(f['计划结束时间']),
      deferredStart,
      deferredEnd: date(f['计划延期结束']) || date(f['计划延时结束时间']),
      actualStart: date(f['实际开始']) || date(f['实际开始时间']),
      actualEnd: date(f['实际结束']) || date(f['实际结束时间']),
      updatedAt: date(f['最后更新时间']),
    });
  }
  return { records, invalid };
}
