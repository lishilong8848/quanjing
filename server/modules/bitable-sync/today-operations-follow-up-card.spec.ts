import {
  buildFollowUpEntryButton, buildFollowUpListCard, buildFollowUpEditCard,
  buildFollowUpProcessingCard, buildFollowUpResultCard,
} from './today-operations-follow-up-card';
import { parseFollowUpCardAction } from './today-operations-follow-up-card.callback';
import type { FollowUpCardRecord } from './today-operations-follow-up-card.types';

const batch = 'b'.repeat(32);
function row(index = 0): FollowUpCardRecord {
  return { revision: 3, record: {
    recordId: `rec${index}`, issueKey: `key${index}`, date: '2026-10-29', source: '每日巡视',
    item: `异常记录${index}`, description: `真实说明${index}`, building: 'A楼',
    acknowledged: true, completed: false, treatmentMeasure: '已检查，继续跟进', handlerName: '合成操作人', handledAt: '2026-10-29 10:00',
  } };
}
function nodes(value: unknown): Record<string, any>[] {
  if (!value || typeof value !== 'object') return [];
  return [value as Record<string, any>, ...Object.values(value).flatMap(nodes)];
}
function callbacks(card: unknown) { return nodes(card).filter(value => value.type === 'callback').map(value => value.value); }
function parseButton(button: Record<string, any>, form?: Record<string, unknown>) {
  return parseFollowUpCardAction({ operator: { open_id: 'ou_fixture' }, context: { open_message_id: 'om_fixture' },
    action: { tag: 'button', ...(form ? { name: button.name, form_value: form } : { value: button.behaviors[0].value }) } });
}

describe('daily follow-up card presentation', () => {
  it('opens the batch in the original card without an external link', () => {
    const entry = buildFollowUpEntryButton(batch);
    expect(parseButton(entry)).toMatchObject({ kind: 'view', action: 'list', batchId: batch, page: 0 });
    expect(JSON.stringify(entry)).not.toContain('open_url');
  });

  it('shows five actual records per page with stable batch indexes and a summary return', () => {
    const records = Array.from({ length: 12 }, (_, i) => row(i));
    const card = buildFollowUpListCard(batch, records, 1, true);
    expect(card).toMatchObject({ schema: '2.0', config: { update_multi: true } });
    const text = JSON.stringify(card), actions = callbacks(card);
    for (let i = 5; i <= 9; i++) expect(text).toContain(`真实说明${i}`);
    expect(text).not.toContain('异常记录4'); expect(text).not.toContain('异常记录10');
    expect(actions.filter(value => value.action === 'edit').map(value => value.index)).toEqual([5, 6, 7, 8, 9]);
    expect(actions.filter(value => value.action === 'list').map(value => value.page)).toEqual([0, 2]);
    expect(actions).toContainEqual({ workflowType: 'today_operations_followup', version: 1, batchId: batch, action: 'summary' });
    expect(text).toContain('2026-10-29'); expect(text).toContain('每日巡视'); expect(text).toContain('A楼');
  });

  it('handles empty batches and stale page requests without invalid indexes', () => {
    const empty = buildFollowUpListCard(batch, [], 1000, false);
    expect(JSON.stringify(empty)).toContain('当前范围暂无异常');
    expect(callbacks(empty).some(value => value.action === 'edit')).toBe(false);
    const last = buildFollowUpListCard(batch, [row()], 1000, false);
    expect(callbacks(last).filter(value => value.action === 'edit').map(value => value.index)).toEqual([0]);
    expect(JSON.stringify(last)).toContain('查看详情');
    expect(JSON.stringify(last)).not.toContain('填写跟进');
  });

  it('preserves existing state and treatment and encodes the exact row revision in the submit name', () => {
    const card = buildFollowUpEditCard(batch, row(), 7);
    expect(nodes(card).find(value => value.tag === 'select_static')).toMatchObject({ initial_option: 'acknowledged', required: true });
    expect(nodes(card).find(value => value.tag === 'input')).toMatchObject({ default_value: '已检查，继续跟进', input_type: 'multiline_text', max_length: 500 });
    const submit = nodes(card).find(value => value.form_action_type === 'submit')!;
    expect(submit.name).toBe(`today_followup_submit:${batch}:7:3`);
    expect(parseButton(submit, { follow_up_status: 'completed', follow_up_measure: '完成检查' }))
      .toMatchObject({ kind: 'submit', batchId: batch, index: 7, revision: 3, acknowledged: true, completed: true, treatmentMeasure: '完成检查' });
    expect(callbacks(card)).toContainEqual(expect.objectContaining({ action: 'list', page: 1 }));
  });

  it('keeps a rejected submission draft and an actionable error without marking it successful', () => {
    const card = buildFollowUpEditCard(batch, row(), 0, { draft: { acknowledged: false, completed: false, treatmentMeasure: '保留草稿' }, error: '版本已变化' });
    expect(nodes(card).find(value => value.tag === 'select_static')?.initial_option).toBe('pending');
    expect(nodes(card).find(value => value.tag === 'input')?.default_value).toBe('保留草稿');
    expect(JSON.stringify(card)).toContain('未保存'); expect(JSON.stringify(card)).toContain('版本已变化');
  });

  it.each(['completed', 'pending'])('renders %s records without another editable form or submit action', mode => {
    const record = row();
    if (mode === 'completed') record.record.completed = true;
    else record.pendingCommandId = 'pending-fixture';
    const card = buildFollowUpEditCard(batch, record, 0);
    expect(nodes(card).some(value => value.tag === 'form' || value.form_action_type === 'submit')).toBe(false);
    expect(callbacks(card).every(value => ['list', 'summary'].includes(value.action))).toBe(true);
  });

  it('locks the submitted record immediately without any callback, link or form in the raw processing card', () => {
    const card = buildFollowUpProcessingCard(row().record, { acknowledged: true, completed: true, treatmentMeasure: '完成检查' });
    expect(callbacks(card)).toEqual([]);
    expect(nodes(card).filter(value => value.tag === 'button')).toEqual([expect.objectContaining({ disabled: true })]);
    expect(nodes(card).some(value => value.tag === 'form' || value.form_action_type || value.type === 'open_url')).toBe(false);
    expect(JSON.stringify(card)).toContain('正在同步');
  });

  it('renders the true result and allows only navigation after synchronization', () => {
    const result = row(); result.record.completed = true;
    const card = buildFollowUpResultCard(batch, result, 0);
    expect(JSON.stringify(card)).toContain('已处理完成'); expect(JSON.stringify(card)).toContain('合成操作人');
    expect(callbacks(card).every(value => ['list', 'summary'].includes(value.action))).toBe(true);
    expect(nodes(card).some(value => value.form_action_type)).toBe(false);
  });

  it('escapes user markdown and mentions and bounds long multilingual cards below 28 KiB', () => {
    const record = row();
    record.record.item = '<at id=all>**全部**</at>';
    record.record.description = '&<😀中文>'.repeat(5_000);
    const variants = [buildFollowUpListCard(batch, Array.from({ length: 5 }, () => record), 0, true),
      buildFollowUpEditCard(batch, record, 0), buildFollowUpResultCard(batch, record, 0),
      buildFollowUpProcessingCard(record.record, { acknowledged: true, completed: false, treatmentMeasure: '*<at id=all>' })];
    for (const card of variants) {
      expect(Buffer.byteLength(JSON.stringify(card), 'utf8')).toBeLessThanOrEqual(28 * 1024);
      const markdown = nodes(card).filter(value => value.tag === 'markdown').map(value => value.content).join('\n');
      expect(markdown).not.toContain('<at'); expect(markdown).toContain('&lt;at');
      expect(markdown).toContain('\\*\\*全部\\*\\*'); expect(markdown).toContain('…');
    }
  });
});
