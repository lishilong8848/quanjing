import type {
  AssessmentKind,
  AssessmentRow,
} from '../../../shared/monthly-operations-assessment.interface';
import {
  extractDisplayText,
  extractNumberValue,
  getRecordId,
  type BitableRecordItem,
} from '../../common/feishu/bitable-direct-read';

const text = (v: unknown) => extractDisplayText(v).trim();
export function assessmentDate(v: unknown): string | null {
  if (v && typeof v === 'object' && !Array.isArray(v) && 'value' in v)
    return assessmentDate(v.value);
  if (Array.isArray(v)) return v.map(assessmentDate).find(Boolean) ?? null;
  if (typeof v === 'number') {
    const date = new Date(v < 1e11 ? v * 1000 : v);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }
  const s = text(v);
  if (/^\d{10}$|^\d{13}$/.test(s)) return assessmentDate(Number(s));
  const m = s.match(
    /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/,
  );
  if (!m) return null;
  const d = `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  if (
    !Number.isFinite(Date.parse(d)) ||
    new Date(d).toISOString().slice(0, 10) !== d
  )
    return null;
  const stamp = Date.parse(
    `${d}T${(m[4] ?? '00').padStart(2, '0')}:${m[5] ?? '00'}:${m[6] ?? '00'}+08:00`,
  );
  return Number.isFinite(stamp) ? new Date(stamp).toISOString() : null;
}
const day = (iso: string | null) =>
  iso
    ? new Date(Date.parse(iso) + 8 * 3600000).toISOString().slice(0, 10)
    : null;
const number = (v: unknown) => {
  const n = extractNumberValue(v);
  return n !== null && Number.isFinite(n) && n >= 0 ? n : null;
};
function building(value: string) {
  return (
    value.match(/[A-H]楼/)?.[0] ??
    value.match(/(?:数据中心|\/)([A-H])(?:\/|$|-)/)?.[1]?.concat('楼') ??
    (value.includes('110') ? '110站' : '未标注')
  );
}
export function eventTimingAnomalies(
  fields: Record<string, unknown>,
  done: boolean,
  now = Date.now(),
) {
  const notified = assessmentDate(fields['通知时间']);
  const responded = assessmentDate(fields['响应时间']);
  const confirmed = assessmentDate(fields['确认时间']);
  const detail: Array<{ label: string; value: string }> = [];
  const time = (value: number) =>
    new Date(value + 8 * 3600000).toISOString().replace('T', ' ').slice(0, 19);
  const measure = (
    label: string,
    start: string | null,
    finish: string | null,
    limit: number,
  ) => {
    if (!start || (!finish && done)) return;
    const from = Date.parse(start);
    const to = finish ? Date.parse(finish) : now;
    const seconds = Math.floor((to - from) / 1000);
    if (!Number.isFinite(seconds) || seconds <= limit || seconds < 0) return;
    const duration =
      seconds >= 3600
        ? `${Math.floor(seconds / 3600)}小时${Math.floor((seconds % 3600) / 60)}分`
        : `${Math.floor(seconds / 60)}分${seconds % 60}秒`;
    detail.push({
      label,
      value: `${time(from)} → ${finish ? time(to) : `截至 ${time(to)}`} · ${duration}`,
    });
  };
  measure('响应超时', notified, responded, 2 * 60);
  measure('确认超时', notified, confirmed, 7 * 60);
  return detail;
}
export function mapAssessment(
  kind: AssessmentKind,
  input: BitableRecordItem[],
  now = Date.now(),
) {
  const records: AssessmentRow[] = [];
  let invalid = 0;
  const unique = new Map<string, BitableRecordItem>();
  for (const item of input) {
    const f = item.fields ?? {};
    const key =
      text(
        f[
          kind === 'drill'
            ? '计划ID'
            : kind === 'event'
              ? '事件ID'
              : kind === 'risk'
                ? '风险排查编码'
                : '自动编码'
        ],
      ) || getRecordId(item);
    if (!key) continue;
    const prev = unique.get(key),
      updated = (r: BitableRecordItem) =>
        Date.parse(
          assessmentDate(
            r.fields?.['最后更新'] ??
              r.fields?.['记录更新时间'] ??
              r.fields?.['创建时间'],
          ) ?? '',
        ) || 0;
    if (!prev || updated(item) > updated(prev)) unique.set(key, item);
  }
  for (const [key, item] of unique) {
    const f = item.fields ?? {},
      t = (n: string) => text(f[n]);
    const r: AssessmentRow = {
      id: getRecordId(item) || key,
      code: '',
      title: '',
      building: '未标注',
      date: null,
      status: '未标注',
      tags: [],
      planned: null,
      checked: null,
      approved: null,
      done: false,
      detail: [],
    };
    let names: string[] = [];
    if (kind === 'risk') {
      r.code = t('风险排查编码');
      r.building = building(t('楼栋'));
      r.title = r.building + '风险排查';
      r.date = day(
        assessmentDate(f['审核截止时间']) ??
          assessmentDate(f['审核截止时间-文本']),
      );
      r.planned = number(f['应完成条目']);
      r.checked = number(f['排查完成数量']);
      r.approved = number(f['审核完成数量']);
      if (
        r.planned === null ||
        r.checked === null ||
        r.approved === null ||
        (r.checked ?? 0) > (r.planned ?? 0) ||
        (r.approved ?? 0) > (r.checked ?? 0)
      ) {
        invalid++;
        r.tags.push('数据待核对');
      }
      r.done = r.planned !== null && r.planned > 0 && r.approved === r.planned;
      r.status = r.done
        ? '审核完成'
        : r.checked === r.planned
          ? '待审核'
          : '排查中';
      names = [
        '应完成条目',
        '排查完成数量',
        '审核完成数量',
        '排查率',
        '完成率',
        '审核截止时间-文本',
      ];
    } else if (kind === 'drill') {
      r.code = t('编码') || t('计划编号');
      r.title = t('演练场景') || '未填写演练场景';
      r.building = building(t('实施区域'));
      r.date = day(assessmentDate(f['计划演练时间']));
      r.status = t('演练状态') || t('执行状态') || '未标注';
      r.done = ['完成', '已完成'].includes(t('演练状态'));
      if (t('是否逾期') === '是') r.tags.push('逾期');
      if (r.status === '待评估') r.tags.push('待评估');
      names = [
        '专业',
        '实施区域',
        '演练类别',
        '演练类型',
        '计划演练时间',
        '计划结束时间',
        '实际演练时间',
        '审批状态',
        '执行状态',
        '演练状态',
        '是否逾期',
        '演练评分',
      ];
    } else if (kind === 'event') {
      r.code = t('事件编号');
      r.title = t('事件标题') || '未填写事件标题';
      r.building = building(t('位置'));
      r.date = day(
        assessmentDate(f['发生时间']) ?? assessmentDate(f['创建时间']),
      );
      r.status = t('处理状态') || t('事件状态') || '未标注';
      r.done = /完成|已关闭|已解决/.test(r.status);
      if (t('真实事件') === '否') r.tags.push('非真实事件');
      if ((t('最高等级') || t('当前等级')).toUpperCase() === 'I2')
        r.tags.push('I2事件');
      if (t('告警状态') === '已恢复' && r.status === '待解决')
        r.tags.push('已恢复待解决');
      const timing = eventTimingAnomalies(f, r.done, now);
      if (timing.length) {
        r.tags.push('处理异常', ...timing.map(({ label }) => label));
        r.detail.push(...timing);
      }
      names = [
        '最高等级',
        '当前等级',
        '真实事件',
        '告警状态',
        '处理状态',
        '事件类型',
        '位置',
        '发生时间',
        '通知时间',
        '响应时间',
        '确认时间',
        '恢复时间',
        '解决时间',
        '事件描述',
      ];
    } else {
      r.code = t('自动编码');
      r.title = t('工单名称') || '未填写巡检名称';
      r.building = building(t('楼栋'));
      r.status = t('工单状态') || '未标注';
      const stamps =
        t('计划区间').match(
          /\d{4}[-/]\d{1,2}[-/]\d{1,2}\s+\d{1,2}:\d{2}(?::\d{2})?/g,
        ) ?? [];
      const start = assessmentDate(stamps[0]),
        end = assessmentDate(stamps[1]),
        submitted = assessmentDate(f['提交时间']);
      r.date = day(start);
      const anomalies = Number(
        t('巡检结果').match(/异常\s*[:：]\s*(\d+)/)?.[1] ?? 0,
      );
      const abnormal = t('异常标') === '异常' || anomalies > 0;
      if (abnormal) r.tags.push('巡检异常');
      const shift =
        t('班次') ||
        t('巡检班次') ||
        t('计划班次') ||
        t('班别') ||
        r.title.match(/(?:长白班|白班|夜班|中班|早班|晚班)/)?.[0] ||
        '';
      const abnormalDetails = Object.entries(f)
        .filter(([name]) =>
          /^(?:(?:异常|问题|故障|隐患).*(?:原因|描述|内容|明细|详情|事项|备注|情况|记录|点位)|(?:原因|描述|内容|备注).*(?:异常|巡检|故障|问题))$/.test(
            name,
          ),
        )
        .map(([name, value]) => ({ name, value: text(value) }))
        .filter(({ value }) => value)
        .slice(0, 5);
      const cancelled = /取消|驳回|退回/.test(r.status);
      if (
        !cancelled &&
        end &&
        submitted &&
        Date.parse(submitted) > Date.parse(end)
      )
        r.tags.push('延迟提交');
      if (
        !cancelled &&
        end &&
        !submitted &&
        Date.parse(end) < now &&
        !/完成|已提交/.test(r.status)
      )
        r.tags.push('超期待提交');
      r.done = !!submitted || /完成|已提交/.test(r.status);
      names = [
        '巡检类型',
        '工单状态',
        '计划区间',
        '提交时间',
        '接单时间',
        '巡检结果',
        '异常标',
        '逾期原因',
        '位置信息',
      ];
      r.detail = [
        ...(shift ? [{ label: '班次', value: shift }] : []),
        ...(end ? [{ label: '计划截止', value: end }] : []),
        ...(abnormal
          ? [
              {
                label: '异常原因',
                value: abnormalDetails.length
                  ? abnormalDetails
                      .map(({ name, value }) => `${name}：${value}`)
                      .join('\n')
                  : anomalies > 0
                    ? `巡检结果记录 ${anomalies} 项异常；源表未填写具体异常原因`
                    : '源表标记异常，但巡检结果记录 0 项异常；源表未填写具体异常原因',
              },
            ]
          : []),
        ...(r.tags.includes('超期待提交')
          ? [{ label: '提交情况', value: '计划截止后仍未提交' }]
          : []),
      ];
    }
    if (!r.date) invalid++;
    r.detail.push(
      ...names
        .map((label) => ({
          label,
          value:
            /^(计划结束时间|实际演练时间|发生时间|通知时间|响应时间|确认时间|解决时间)$/.test(
              label,
            )
              ? (assessmentDate(f[label]) ?? '')
              : t(label),
        }))
        .filter((d) => d.value),
    );
    records.push(r);
  }
  return { records, invalid };
}
