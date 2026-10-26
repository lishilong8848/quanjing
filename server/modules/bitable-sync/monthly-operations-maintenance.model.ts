import type {
  MaintenanceRow,
  MaintenanceType,
} from '../../../shared/monthly-operations-maintenance.interface';
import {
  extractDisplayText,
  getRecordId,
  type BitableRecordItem,
} from '../../common/feishu/bitable-direct-read';
import { assessmentDate } from './monthly-operations-assessment.model';
const text = (v: unknown) => extractDisplayText(v).trim();
const day = (v: string | null) =>
  v ? new Date(Date.parse(v) + 8 * 3600000).toISOString().slice(0, 10) : null;
export function mapMaintenance(
  kind: MaintenanceType,
  input: BitableRecordItem[],
) {
  const records: MaintenanceRow[] = [];
  let invalid = 0;
  const seen = new Set<string>();
  for (const item of input) {
    const f = item.fields ?? {},
      t = (n: string) => text(f[n]),
      id = getRecordId(item);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const plannedStart = assessmentDate(f['计划开始维护时间']),
      plannedEnd = assessmentDate(f['计划结束维护时间']),
      actualStart = assessmentDate(f['实际开始时间']),
      actualEnd = assessmentDate(f['实际结束时间']);
    const execution = t(kind === 'planned' ? '维护实施状态' : '维护状态'),
      status = t('维护实施状态（新）') || execution || '状态待核对';
    const tags: string[] = [];
    if (/延期未开始|延迟结束|超时结束|异常/.test(execution))
      tags.push(execution);
    if (
      actualStart &&
      actualEnd &&
      Date.parse(actualEnd) <= Date.parse(actualStart) &&
      !tags.includes('结束时间异常')
    )
      tags.push('结束时间异常');
    if (/记录单/.test(status)) tags.push('记录待补充');
    if (/确认中/.test(status)) tags.push(status);
    const abnormal = tags.some((t) => /延期|延迟|超时|异常/.test(t));
    const date = day(
      plannedStart ?? (kind === 'unplanned' ? actualStart : null),
    );
    if (!date || !execution) invalid++;
    const done =
      !tags.includes('结束时间异常') &&
      (['正常结束', '延迟结束', '超时结束'].includes(execution) ||
        !!(actualStart && actualEnd));
    const detail = [
      ['维护编号', t('维护编号')],
      ['维护项目', t('维护项目')],
      ['专业类别', t('专业类别')],
      ['执行状态', execution],
      ['流转状态', status],
      ['计划开始', plannedStart],
      ['计划结束', plannedEnd],
      ['实际开始', actualStart],
      ['实际结束', actualEnd],
      ['维护周期', t('维护周期')],
      ['类别', t('类别')],
      ['备注', t('备注')],
    ]
      .filter((d): d is [string, string] => !!d[1])
      .map(([label, value]) => ({ label, value }));
    records.push({
      id,
      code: t('维护编号') || '',
      title: t('维护总项') || t('维护项目') || '未填写维护名称',
      building: t('楼栋') || '未标注',
      date,
      status,
      tags,
      done,
      planned: null,
      checked: null,
      approved: null,
      detail,
      planType: kind,
      specialty: t('专业类别') || '未标注',
      abnormal,
      running: !done && (execution === '进行中' || !!actualStart),
    });
  }
  return { records, invalid };
}
