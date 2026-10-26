import type {
  MonthlyChange,
  MonthlyChangeState,
} from '../../../shared/monthly-operations-changes.interface';
import {
  extractDateTimeIso,
  extractDisplayText,
  extractDisplayValues,
  getRecordId,
  type BitableRecordItem,
} from '../../common/feishu/bitable-direct-read';
import { shanghaiDay } from './monthly-operations-resources.model';

const text = (value: unknown) => extractDisplayText(value).trim();
const date = (value: unknown) => {
  const iso = extractDateTimeIso(value);
  return iso && Number.isFinite(Date.parse(iso)) ? iso : null;
};

function stateFor(
  result: string,
  progress: string,
  started: string | null,
  ended: string | null,
): MonthlyChangeState {
  if (['变更成功', '延期完成'].includes(result)) return 'done';
  if (result === '变更取消') return 'cancelled';
  if (result === '变更失败') return 'failed';
  if (result === '变更延期') return 'delayed';
  if (progress === '退回') return 'returned';
  // 时间公式“已结束”只说明计划时间已过，不能替代实际完成结果。
  if (ended || progress === '已结束') return 'pending';
  if (started || progress === '进行中') return 'running';
  if (progress === '未开始') return 'planned';
  return 'pending';
}

export function mapMonthlyChanges(records: BitableRecordItem[]) {
  const seen = new Set<string>();
  const rows: MonthlyChange[] = [];
  let invalid = 0;
  for (const record of records) {
    const id = getRecordId(record);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const f = record.fields ?? {};
    const originalStart = date(f['计划开始日期（阿里）']);
    const originalEnd = date(f['计划结束日期（阿里）']);
    const plannedStart = date(f['计划延迟开始日期']) || originalStart;
    if (!plannedStart) {
      invalid++;
      continue;
    }
    const progress = text(f['变更进度']);
    const result = text(f['变更情况（变更完成或取消后填写）']);
    const actualStart = date(f['实际开始时间']);
    const actualEnd = date(f['实际结束时间']);
    rows.push({
      id,
      code: text(f['自增编号']) ? `BG-${text(f['自增编号'])}` : '',
      title: text(f['变更简述']) || '未填写变更描述',
      buildings: [
        ...new Set(
          extractDisplayValues(f['变更楼栋'])
            .map((v) => v.trim())
            .filter(Boolean),
        ),
      ],
      specialty: text(f['专业']) || '未标注',
      type: text(f['变更类型']) || '未标注',
      workType: text(f['作业类型']) || '未标注',
      nature: text(f['变更性质判断']) || '未标注',
      level: text(f['变更等级（阿里）']) || '未标注',
      date: shanghaiDay(Date.parse(plannedStart)),
      plannedStart,
      plannedEnd: date(f['计划延迟结束日期']) || originalEnd,
      originalStart,
      originalEnd,
      actualStart,
      actualEnd,
      progress,
      result,
      state: stateFor(result, progress, actualStart, actualEnd),
      risk: text(f['变更重要风险点（简述）']),
      delayReason: text(f['延期理由']),
    });
  }
  rows.sort(
    (a, b) =>
      b.plannedStart.localeCompare(a.plannedStart) || a.id.localeCompare(b.id),
  );
  return { records: rows, invalid };
}
