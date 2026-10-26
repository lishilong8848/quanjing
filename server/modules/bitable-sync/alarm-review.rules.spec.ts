import { normalizeAlarmReviewRequest, reviewMatches, buildReviewFields, reviewVersion } from './alarm-review.rules';
import { createHash } from 'node:crypto';

const input = { recordIds: ['recABC'], outcome: '人工复核无问题', responsibleRecordId: 'recPerson', clientMutationId: 'alarm-review-12345678' };

describe('alarm human review rules', () => {
  it('validates and deduplicates explicit records', () => {
    expect(normalizeAlarmReviewRequest({ ...input, recordIds: ['recABC', 'recABC'] }).recordIds).toEqual(['recABC']);
  });
  it.each([
    { outcome: '好像没问题' }, { responsibleRecordId: '' }, { recordIds: [] },
    { recordIds: ['../recABC'] }, { recordIds: Array.from({ length: 51 }, (_, i) => `rec${i}`) },
    { clientMutationId: '' }, { responsibleRecordId: 'ou_not_a_record' },
  ])('rejects malformed or ambiguous inputs: %p', (patch) => {
    expect(() => normalizeAlarmReviewRequest({ ...input, ...patch })).toThrow();
  });
  it('writes only the dedicated review fields', () => {
    expect(buildReviewFields('已通知现场跟进', 'user123')).toEqual({
      人工复核结果: '已通知现场跟进', 复核示例人员019: [{ id: 'user123' }], 复核回复: '',
    });
  });
  it('compares semantics, not unrelated API metadata', () => {
    expect(reviewMatches({ 人工复核结果: '人工复核无问题', 复核示例人员019: [{ id: 'user123', name: '示例人员019', avatar_url: 'anything' }] }, '人工复核无问题', 'user123')).toBe(true);
    expect(reviewMatches({ 人工复核结果: '人工复核无问题', 复核示例人员019: [{ id: 'someoneElse' }] }, '人工复核无问题', 'user123')).toBe(false);
    expect(reviewMatches({ 人工复核结果: '人工复核无问题', 复核示例人员019: [] }, '人工复核无问题', 'user123')).toBe(false);
  });
  it('accepts a trimmed custom reply and rejects empty, nontext or excessive replies', () => {
    expect(normalizeAlarmReviewRequest({ ...input, outcome: '自定义回复', customReply: '  已核查，等待备件\n明日处理  ' }).customReply).toBe('已核查，等待备件\n明日处理');
    for (const customReply of ['', '  ', 42, '字'.repeat(501)]) {
      expect(() => normalizeAlarmReviewRequest({ ...input, outcome: '自定义回复', customReply })).toThrow('自定义回复');
    }
    expect(normalizeAlarmReviewRequest({ ...input, customReply: '旧内容' })).not.toHaveProperty('customReply');
  });
  it('verifies custom text and clears stale text when returning to a preset', () => {
    const fields = buildReviewFields('自定义回复' as never, 'user123', '等待备件');
    expect(fields.复核回复).toBe('等待备件');
    expect(reviewMatches(fields, '自定义回复' as never, 'user123', '等待备件')).toBe(true);
    expect(reviewMatches(fields, '自定义回复' as never, 'user123', '已完成')).toBe(false);
    expect(reviewMatches({ ...fields, 人工复核结果: '人工复核无问题' }, '人工复核无问题', 'user123')).toBe(false);
  });
  it('includes reply changes in versions without invalidating historic preset versions', () => {
    const legacy = { 人工复核结果: '人工复核无问题', 复核示例人员019: [{ id: 'user123', name: '示例人员019' }] };
    expect(reviewVersion(legacy)).toBe(createHash('sha256').update(JSON.stringify(['人工复核无问题', '示例人员019'])).digest('hex'));
    expect(reviewVersion({ ...legacy, 复核回复: '' })).toBe(reviewVersion(legacy));
    expect(reviewVersion({ ...legacy, 复核回复: '甲' })).not.toBe(reviewVersion({ ...legacy, 复核回复: '乙' }));
  });
  it.each(['已核对，待复查。', '甲、乙、甲', '现场正常\n现场正常', '甲,乙;甲'])('preserves review body punctuation and repeated segments: %s', (reply) => {
    const fields = { 人工复核结果: '自定义回复', 复核示例人员019: [{ id: 'user123', name: '示例人员019' }], 复核回复: reply };
    expect(reviewMatches(fields, '自定义回复', 'user123', reply)).toBe(true);
    expect(reviewVersion(fields)).toBe(createHash('sha256').update(JSON.stringify(['自定义回复', '示例人员019', reply])).digest('hex'));
  });
  it('preserves review body rich text segments without adding separators or deduplicating', () => {
    const reply = '已核对，待复查。\n重复重复';
    const fields = { 人工复核结果: '自定义回复', 复核示例人员019: [{ id: 'user123', name: '示例人员019' }], 复核回复: [{ type: 'text', text: '已核对，' }, { type: 'text', text: '待复查。\n' }, { type: 'text', text: '重复' }, { type: 'text', text: '重复' }] };
    expect(reviewMatches(fields, '自定义回复', 'user123', reply)).toBe(true);
    expect(reviewVersion(fields)).toBe(reviewVersion({ ...fields, 复核回复: reply }));
  });
  it.each([{ value: '  已核对，待复查。\n重复重复  ' }, { value: [{ text: '  已核对，' }, { value: [{ text: '待复查。\n重复' }, { text: '重复  ' }] }] }])('preserves wrapped review body and trims only outer whitespace: %p', (reply) => {
    const fields = { 人工复核结果: '自定义回复', 复核示例人员019: [{ id: 'user123', name: '示例人员019' }], 复核回复: reply };
    expect(reviewMatches(fields, '自定义回复', 'user123', '  已核对，待复查。\n重复重复  ')).toBe(true);
    expect(reviewVersion(fields)).toBe(reviewVersion({ ...fields, 复核回复: '已核对，待复查。\n重复重复' }));
  });
  it.each([undefined, null, '', [], { value: [] }])('preserves review body empty historic preset semantics: %p', (reply) => {
    const fields = { 人工复核结果: '人工复核无问题', 复核示例人员019: [{ id: 'user123', name: '示例人员019' }] };
    expect(reviewMatches({ ...fields, 复核回复: reply }, '人工复核无问题', 'user123')).toBe(true);
    expect(reviewVersion({ ...fields, 复核回复: reply })).toBe(reviewVersion(fields));
  });
});
