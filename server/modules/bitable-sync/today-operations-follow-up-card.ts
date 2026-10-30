import { BadRequestException } from '@nestjs/common';
import type { TodayOperationsFollowUpRecord, TodayOperationsFollowUpUpdate } from './today-operations-anomaly.types';
import type { FollowUpCardRecord } from './today-operations-follow-up-card.types';

type Card = Record<string, unknown>;
export type FollowUpCardButton = {
  tag: 'button';
  type: 'primary_filled' | 'default';
  width: 'fill';
  text: { tag: 'plain_text'; content: string };
  behaviors: [{ type: 'callback'; value: Record<string, unknown> }];
};
type Update = Pick<TodayOperationsFollowUpUpdate, 'acknowledged' | 'completed' | 'treatmentMeasure'>;
const PAGE_SIZE = 5;
const MAX_CARD_BYTES = 28 * 1024;

export function buildFollowUpEntryButton(batchId: string): FollowUpCardButton {
  return navigation('异常跟进', batchId, 'list', 0, 'primary_filled');
}

export function buildFollowUpListCard(batchId: string, records: FollowUpCardRecord[], page: number, canUpdate: boolean): Card {
  validateBatch(batchId);
  if (!Array.isArray(records) || records.length > 1_000 || !integer(page, 1_000)) throw new BadRequestException('异常跟进分页无效');
  const pages = Math.max(1, Math.ceil(records.length / PAGE_SIZE)), current = Math.min(page, pages - 1);
  const elements: Card[] = [markdown(`共 ${records.length} 条记录 · 第 ${current + 1}/${pages} 页`)];
  if (!records.length) elements.push(markdown('当前范围暂无异常'));
  records.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE).forEach((row, offset) => {
    const index = current * PAGE_SIZE + offset, record = row.record;
    elements.push({ tag: 'hr' }, ...recordDetails(record, 220, `${index + 1}. `),
      markdown(`**状态**　${status(row)}`),
      navigation(row.pendingCommandId ? '查看同步状态' : record.completed || !canUpdate ? '查看详情' : '填写跟进', batchId, 'edit', index));
  });
  const paging: Card[] = [];
  if (current > 0) paging.push(navigation('上一页', batchId, 'list', current - 1));
  if (current + 1 < pages) paging.push(navigation('下一页', batchId, 'list', current + 1));
  if (paging.length) elements.push(buttonRow(paging));
  elements.push(navigation('返回巡视摘要', batchId, 'summary'));
  return card('异常跟进', elements);
}

export function buildFollowUpEditCard(
  batchId: string, row: FollowUpCardRecord, index: number,
  options: { draft?: Update; error?: string } = {},
): Card {
  validateRow(batchId, row, index);
  if (row.pendingCommandId || row.record.completed) return buildFollowUpResultCard(batchId, row, index, options.error);
  const values = options.draft || row.record;
  const selected = values.completed ? 'completed' : values.acknowledged ? 'acknowledged' : 'pending';
  const elements: Card[] = [...recordDetails(row.record, 1_600)];
  if (options.error) elements.push(markdown(`**未保存**　${escape(options.error, 300)}`));
  elements.push({
    tag: 'form', name: 'today_followup_form', direction: 'vertical', vertical_spacing: '8px',
    elements: [
      markdown('**跟进状态**'),
      { tag: 'select_static', name: 'follow_up_status', required: true, width: 'fill', initial_option: selected,
        placeholder: { tag: 'plain_text', content: '请选择跟进状态' },
        options: [['pending', '待跟进'], ['acknowledged', '已知悉'], ['completed', '已处理完成']].map(([value, content]) => ({ value, text: { tag: 'plain_text', content } })),
      },
      markdown('**处理措施**'),
      { tag: 'input', name: 'follow_up_measure', input_type: 'multiline_text', rows: 3, max_length: 500, width: 'fill',
        default_value: clip(values.treatmentMeasure || '', 500),
        placeholder: { tag: 'plain_text', content: '标记完成时必填，2–500 字' },
      },
      { tag: 'button', name: `today_followup_submit:${batchId}:${index}:${row.revision}`, type: 'primary_filled', width: 'fill',
        form_action_type: 'submit', text: { tag: 'plain_text', content: '保存本条跟进' },
      },
    ],
  }, buttonRow([navigation('返回列表', batchId, 'list', Math.floor(index / PAGE_SIZE)), navigation('返回巡视摘要', batchId, 'summary')]));
  return card('填写异常跟进', elements, 'orange');
}

export function buildFollowUpNavigationErrorCard(batchId: string, row: FollowUpCardRecord, index: number): Card {
  validateRow(batchId, row, index);
  return card('填写页面暂未打开', [
    ...recordDetails(row.record, 220),
    markdown('填写页面暂未打开，尚未提交任何修改。请重试打开，或返回列表。'),
    navigation('重试打开', batchId, 'edit', index, 'primary_filled'),
    buttonRow([navigation('返回列表', batchId, 'list', Math.floor(index / PAGE_SIZE)), navigation('返回巡视摘要', batchId, 'summary')]),
  ], 'orange');
}

export function buildFollowUpProcessingCard(record: TodayOperationsFollowUpRecord, update: Update): Card {
  return card('异常跟进 · 正在同步', [
    ...recordDetails(record, 1_600),
    markdown(`**提交状态**　${update.completed ? '已处理完成' : update.acknowledged ? '已知悉' : '待跟进'}`),
    ...(update.treatmentMeasure ? [markdown(`**处理措施**\n${escape(update.treatmentMeasure, 500)}`)] : []),
    markdown('已受理，正在同步。'),
    { tag: 'button', type: 'primary_filled', width: 'fill', disabled: true,
      text: { tag: 'plain_text', content: '正在同步' }, disabled_tips: { tag: 'plain_text', content: '请勿重复提交' } },
  ], 'orange');
}

export function buildFollowUpResultCard(batchId: string, row: FollowUpCardRecord, index: number, error?: string): Card {
  validateRow(batchId, row, index);
  const record = row.record;
  return card('异常跟进', [
    ...recordDetails(record, 1_600), markdown(`**状态**　${status(row)}`),
    markdown(`**处理措施**\n${escape(record.treatmentMeasure || '暂无', 500)}`),
    ...(record.handlerName ? [markdown(`**处理人**　${escape(record.handlerName, 80)}`)] : []),
    ...(record.handledAt ? [markdown(`**处理时间**　${escape(record.handledAt, 80)}`)] : []),
    ...(error ? [markdown(`**同步提示**　${escape(error, 300)}`)] : []),
    buttonRow([navigation('返回列表', batchId, 'list', Math.floor(index / PAGE_SIZE)), navigation('返回巡视摘要', batchId, 'summary')]),
  ], row.pendingCommandId || error ? 'orange' : record.completed ? 'green' : 'blue');
}

function recordDetails(record: TodayOperationsFollowUpRecord, descriptionLimit: number, prefix = ''): Card[] {
  return [
    markdown(`**${prefix}${escape(record.item, 220)}**`),
    markdown([record.date, record.source, record.building].filter(Boolean).map(value => escape(value, 80)).join(' · ')),
    markdown(escape(record.description || '暂无异常说明', descriptionLimit)),
  ];
}
function status(row: FollowUpCardRecord): string {
  return row.pendingCommandId ? '正在同步' : row.record.completed ? '已处理完成' : row.record.acknowledged ? '已知悉，待处理' : '待跟进';
}
function navigation(label: string, batchId: string, action: 'list' | 'edit' | 'summary', position = 0, type: FollowUpCardButton['type'] = 'default'): FollowUpCardButton {
  validateBatch(batchId);
  const value = { workflowType: 'today_operations_followup', version: 1, batchId, action,
    ...(action === 'list' ? { page: position } : action === 'edit' ? { index: position } : {}) };
  return { tag: 'button', type, width: 'fill', text: { tag: 'plain_text', content: label }, behaviors: [{ type: 'callback', value }] };
}
function buttonRow(buttons: Card[]): Card {
  return { tag: 'column_set', horizontal_spacing: '8px', columns: buttons.map(button => ({ tag: 'column', width: 'weighted', weight: 1, elements: [button] })) };
}
function card(title: string, elements: Card[], template = 'blue'): Card {
  const value = { schema: '2.0', config: { update_multi: true, wide_screen_mode: true },
    header: { template, title: { tag: 'plain_text', content: title } },
    body: { direction: 'vertical', padding: '12px', vertical_spacing: '8px', elements } };
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_CARD_BYTES) throw new BadRequestException('异常跟进卡片内容过长');
  return value;
}
function markdown(content: string): Card { return { tag: 'markdown', content }; }
function clip(value: string, limit: number): string {
  const characters = Array.from(value.normalize('NFC').replace(/\r\n?/gu, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, ''));
  return characters.length > limit ? `${characters.slice(0, limit - 1).join('')}…` : characters.join('');
}
function escape(value: string, limit: number): string {
  return clip(value, limit).replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/[\\`*_[\]()]/gu, '\\$&');
}
function integer(value: unknown, maximum: number): value is number { return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= maximum; }
function validateBatch(batchId: string): void {
  if (typeof batchId !== 'string' || !/^[a-f0-9]{32}$/u.test(batchId)) throw new BadRequestException('异常跟进批次无效');
}
function validateRow(batchId: string, row: FollowUpCardRecord, index: number): void {
  validateBatch(batchId);
  if (!integer(index, 999) || !integer(row.revision, Number.MAX_SAFE_INTEGER)) throw new BadRequestException('异常跟进记录版本无效');
}
