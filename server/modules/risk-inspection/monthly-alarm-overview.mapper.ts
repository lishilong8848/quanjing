import type { MonthlyAlarmOverviewRecord } from '../../../shared/monthly-alarm-overview.interface';
import {
  extractDisplayText,
  getRecordId,
  type BitableRecordItem,
} from '../../common/feishu/bitable-direct-read';

const display = (value: unknown) => extractDisplayText(value).trim();

function displayDate(value: unknown): string {
  const raw = display(value);
  if (!/^\d{13}$/.test(raw)) return raw;
  const date = new Date(Number(raw));
  if (Number.isNaN(date.getTime())) return raw;
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
    .format(date)
    .replace(/\//g, '-');
}

function mapImages(value: unknown, recordId: string) {
  if (!Array.isArray(value) || !recordId) return [];
  return value.flatMap((item, index) => {
    if (!item || typeof item !== 'object') return [];
    const image = item as Record<string, unknown>;
    if (!display(image.file_token) || !display(image.type).startsWith('image/'))
      return [];
    return [
      {
        name: display(image.name) || `截图 ${index + 1}`,
        mimeType: display(image.type),
        url: `/api/risk-inspection/monthly-alarm-overview/evidence/${encodeURIComponent(recordId)}/${index}`,
      },
    ];
  });
}

function recordMonth(fields: Record<string, unknown>): string {
  const sequence = display(fields['序号']);
  const identity = /ALARM-(20\d{2})(0[1-9]|1[0-2])/.exec(sequence);
  if (identity) return `${identity[1]}-${identity[2]}`;
  const date = display(fields['日期']);
  const year = /^(20\d{2})[-/]/.exec(date)?.[1];
  const month = /^(\d{1,2})月$/.exec(display(fields['月度']))?.[1];
  return year && month ? `${year}-${month.padStart(2, '0')}` : '';
}

export function mapMonthlyAlarmOverview(
  input: BitableRecordItem[],
): MonthlyAlarmOverviewRecord[] {
  return input.flatMap((item) => {
    const fields = item.fields ?? {};
    const month = recordMonth(fields);
    const section = display(fields['标题']);
    if (!month || !section) return [];
    const rawQuantity = display(fields['数量']).replace(/,/g, '');
    const parsed = Number(rawQuantity.replace(/%$/, ''));
    const id = getRecordId(item) || display(fields['序号']);
    return [
      {
        id,
        month,
        section,
        building: display(fields['楼栋']) || '未标注',
        metric: display(fields['类型']),
        quantity: rawQuantity && Number.isFinite(parsed) ? parsed : null,
        period: display(fields['日期段']),
        week: display(fields['第（）周']),
        description: display(fields['告警描述']),
        confirmation: display(fields['动环确认描述']),
        analysis: display(fields['告警分析']),
        closed: display(fields['是否闭环']),
        event: display(fields['事件描述']),
        problem: display(fields['问题']),
        date: displayDate(fields['日期']),
        images: mapImages(fields['备注截图'], getRecordId(item)),
      },
    ];
  });
}
