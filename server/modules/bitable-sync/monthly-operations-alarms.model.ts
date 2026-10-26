import type { MonthlyAlarm } from '../../../shared/monthly-operations-alarms.interface';
import { createHash } from 'node:crypto';
import {
  extractDisplayText,
  getRecordId,
  type BitableRecordItem,
} from '../../common/feishu/bitable-direct-read';
import { assessmentDate } from './monthly-operations-assessment.model';
import { detectAlarmTagRuleIssues } from './today-operations-alarm-tag-rules';
const text = (v: unknown) => extractDisplayText(v).trim();
export function mapMonthlyAlarms(
  input: BitableRecordItem[],
  asOf: number = Date.now(),
) {
  const records: MonthlyAlarm[] = [];
  let invalid = 0;
  const sorted = [...input].sort(
    (a, b) =>
      (Date.parse(assessmentDate(b.fields?.['更新时间']) ?? '') || 0) -
      (Date.parse(assessmentDate(a.fields?.['更新时间']) ?? '') || 0),
  );
  const seen = new Set<string>();
  for (const item of sorted) {
    const f = item.fields ?? {},
      t = (n: string) => text(f[n]),
      level = t('等级');
    if (!level) continue;
    const occurredAt = assessmentDate(f['产生时间']);
    if (!occurredAt) {
      invalid++;
      continue;
    }
    const title = t('告警内容') || '未填写告警内容',
      building = t('楼栋') || '未标注',
      object = t('监控对象'),
      location = t('具体位置');
    const repeatKey = createHash('sha256')
        .update(
          JSON.stringify([
            building,
            location,
            object,
            title,
            ...(!object || !location || !t('告警内容')
              ? [getRecordId(item)]
              : []),
          ]),
        )
        .digest('hex'),
      key = repeatKey + occurredAt;
    if (seen.has(key)) continue;
    seen.add(key);
    const recoveredAt = assessmentDate(f['恢复时间']),
      confirmedAt = assessmentDate(f['确认时间']);
    const process = t('受理状态（公式）') || t('处理状态') || '未标注',
      recovery =
        t('恢复状态（公式）') ||
        t('恢复状态') ||
        (recoveredAt ? '已恢复' : '未恢复');
    const expected = t('预期外/预期内'),
      category = t('分类') || '未分类';
    const duration = recoveredAt
        ? (Date.parse(recoveredAt) - Date.parse(occurredAt)) / 60000
        : null,
      minutes = duration !== null && duration >= 0 ? duration : null;
    const tags: string[] = [];
    if (level === '严重') tags.push('严重告警');
    if (process === '未处理') tags.push('未处理');
    if (!confirmedAt) tags.push('未确认');
    const acceptanceDescription = t('受理描述');
    const confirmationDescription = t('确认描述');
    const tagIssues = detectAlarmTagRuleIssues({
      processingStatus: process,
      acceptanceDescription,
      confirmationDescription,
    });
    if (tagIssues.length) tags.push('打标异常');
    if (recovery === '未恢复' && process === '未处理')
      tags.push('未处理且未恢复');
    if (recovery === '未恢复' && asOf - Date.parse(occurredAt) >= 48 * 3600000)
      tags.push('未恢复超过48小时');
    if (expected === '预期外' && minutes !== null && minutes <= 5)
      tags.push('预期外5分钟内恢复');
    const detail = [
      ['受理描述', t('受理描述')],
      ['确认描述', t('确认描述')],
    ]
      .filter((d): d is [string, string] => !!d[1])
      .map(([label, value]) => ({ label, value }));
    records.push({
      id: getRecordId(item) || key,
      title,
      building,
      date: new Date(Date.parse(occurredAt) + 8 * 3600000)
        .toISOString()
        .slice(0, 10),
      tags,
      tagIssues,
      acceptanceDescription,
      confirmationDescription,
      detail,
      level,
      occurredAt,
      recoveredAt,
      confirmedAt,
      process,
      recovery,
      expected,
      category,
      object,
      location,
      minutes,
      repeatKey,
    });
  }
  return { records, invalid };
}
