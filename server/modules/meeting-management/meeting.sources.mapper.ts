import type { BitableRecordItem } from '../../common/feishu/bitable-direct-read';
import type {
  MeetingDetail,
  MeetingPerson,
  MeetingResource,
} from '../../../shared/meeting-management.interface';
import { dateValue, documentUrl, text } from './meeting.mapper';

export const ADDITIONAL_MEETING_SOURCES = [
  {
    source: 'training' as const,
    label: '培训分享',
    appToken: 'MliKbC3fXa8PXrsndKscmxjdn1g',
    tableId: 'tblsWOglzcniGFwu',
    viewId: 'vew5BJWcH2',
    tableName: '培训分享会',
    automaticFields: true,
  },
  {
    source: 'ali-meeting' as const,
    label: '阿里会议',
    appToken: 'MliKbC3fXa8PXrsndKscmxjdn1g',
    tableId: 'tblssaUZfDuqW5PQ',
    viewId: 'vewae6upeP',
    tableName: '阿里会议',
    automaticFields: true,
  },
];
type Source = (typeof ADDITIONAL_MEETING_SOURCES)[number];
function people(value: unknown): MeetingPerson[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const user = item as Record<string, unknown>;
    return typeof user.id === 'string' && typeof user.name === 'string'
      ? [{ id: user.id, name: user.name }]
      : [];
  });
}
function list(value: unknown): string[] {
  return (Array.isArray(value) ? value : [value])
    .map(text)
    .map((v) => v.trim())
    .filter(Boolean);
}
function safeResourceUrl(value: unknown): string | null {
  const field =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  const raw = text(field?.link ?? value).trim();
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password || url.port)
      return null;
    if (
      !['feishu.cn', 'larksuite.com'].some(
        (d) => url.hostname === d || url.hostname.endsWith(`.${d}`),
      )
    )
      return null;
    return url.href;
  } catch {
    return null;
  }
}
export function mapAdditionalMeeting(
  record: BitableRecordItem,
  source: Source,
): MeetingDetail {
  const rawId = record.record_id || record.id;
  if (!rawId) throw new Error('会议缺少记录 ID');
  const f = record.fields || {};
  const training = source.source === 'training';
  const startAt = dateValue(f['开始时间'], false);
  const endAt = dateValue(f['结束时间'], false);
  const warnings: string[] = [];
  if (startAt && endAt && endAt < startAt)
    warnings.push('结束时间早于开始时间，请核对源记录');
  const definitions: [string, MeetingResource['kind'], string][] = training
    ? [
        ['演示文档/PPT（链接）', 'slides', '课件 / PPT'],
        ['会议回放&妙记链接', 'replay', '回放 / 妙记'],
        ['会议链接', 'meeting', '会议链接'],
      ]
    : [
        ['会议纪要', 'minutes', '会议纪要'],
        ['会议资料（链接）', 'materials', '会议资料'],
      ];
  const resources = definitions.flatMap(([field, kind, label]) => {
    const url = safeResourceUrl(f[field]);
    if (text(f[field]).trim() && !url)
      warnings.push(`${label}链接无效或不受支持`);
    return url ? [{ kind, label, url }] : [];
  });
  const rawSummary = text(f['会议重点']).trim();
  const damaged = /[?？]{3,}|\uFFFD/.test(rawSummary);
  if (damaged) warnings.push('源表会议重点含乱码，请查看原始纪要');
  const sections =
    !training && rawSummary && !damaged
      ? [
          {
            key: 'highlights',
            title: '会议重点',
            content: rawSummary,
            isAction: false,
          },
        ]
      : [];
  const scopeText = text(f['会议属性']).trim();
  const subtype =
    text(f[training ? '分享类型' : '类型']).trim() || source.label;
  return {
    id: `${source.source}:${rawId}`,
    source: source.source,
    title:
      text(f[training ? '分享主题' : '会议名称']).trim() ||
      text(f['年度&主题']).trim() ||
      '未命名会议',
    date: dateValue(f['开始时间'], true),
    weekLabel: null,
    scope:
      training || scopeText === '属地'
        ? '机房'
        : ['客户', '机房', '区域', '总部', '运维部'].includes(scopeText)
          ? (scopeText as MeetingDetail['scope'])
          : '未分类',
    nature:
      training || subtype === '培训会议'
        ? '培训类'
        : ['技术会议', 'EHS专项会议'].includes(subtype)
          ? '专业类'
          : ['阿里周例会', '南通周会'].includes(subtype)
            ? '管理类'
            : '未分类',
    subtype,
    startAt,
    endAt,
    presenters: training ? people(f['分享人']) : [],
    owners: training ? people(f['相关负责人']) : [],
    specialties: training ? list(f['楼栋&专业（多选）']) : [],
    status: training ? text(f['会议进度（勿动）']).trim() : undefined,
    participantCount:
      training &&
      typeof f['参与人数'] === 'number' &&
      Number.isFinite(f['参与人数']) &&
      f['参与人数'] >= 0
        ? f['参与人数']
        : null,
    resources,
    attachmentNames:
      !training && Array.isArray(f['会议总结'])
        ? f['会议总结'].flatMap((a) =>
            a && typeof a === 'object' && typeof a.name === 'string'
              ? [a.name]
              : [],
          )
        : [],
    sourceUrl: `https://vnet.feishu.cn/base/${source.appToken}?table=${source.tableId}&view=${source.viewId}`,
    documentUrl:
      documentUrl(f[training ? '演示文档/PPT（链接）' : '会议纪要']) ||
      resources.find((r) => r.kind !== 'meeting')?.url ||
      null,
    updatedAt: dateValue(record.last_modified_time, false),
    hasActions: false,
    sections,
    sectionTitles: sections.map((s) => s.title),
    warnings,
  };
}
