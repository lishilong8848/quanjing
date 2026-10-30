import { canonicalCardJson, isReadonlyDisplayCard, READONLY_CARD_MAX_BYTES, sanitizeReadonlyCard } from '../../server/common/feishu-card-copy/readonly-card';

describe('Feishu viewing-only card projection', () => {
  it('preserves visible fields/images but removes nested capabilities without changing the original', () => {
    const raw = { config: { wide_screen_mode: true }, card_link: { url: 'https://example.test/confirm?ticket=secret-card' },
      header: { template: 'orange', title: { tag: 'plain_text', content: '请休假审批' } },
      elements: [{ tag: 'div', text: { tag: 'lark_md', content: '**合成人员**\n[查看并确认](https://example.test/confirm?ticket=secret-link)' },
        fields: [{ is_short: true, text: { tag: 'plain_text', content: 'A楼 · 年假' } }] },
        { tag: 'column_set', columns: [{ tag: 'column', elements: [{ tag: 'img', img_key: 'img_v3_synthetic-image', alt: { tag: 'plain_text', content: '流程截图' }, url: 'https://example.test/approve' },
          { tag: 'button', text: { tag: 'plain_text', content: '同意' }, value: { recordId: 'recSynthetic', operatorOpenId: 'ou_secret', token: 'hidden-secret' }, behaviors: [{ type: 'callback' }] }] }] }] };
    const original = JSON.stringify(raw), result = sanitizeReadonlyCard(raw), serialized = JSON.stringify(result.card);
    expect(JSON.stringify(raw)).toBe(original);
    expect(serialized).toContain('合成人员'); expect(serialized).toContain('A楼'); expect(serialized).toContain('img_v3_synthetic-image');
    expect(serialized).toContain('只读抄送');
    expect(serialized).not.toMatch(/secret|https?:|card_link|callback|behaviors|operatorOpenId|"button"|"value"/);
    expect(result.hasEnabledActions).toBe(true); expect(result.entityKeys).toEqual(['recordId:recSynthetic']);
    expect(isReadonlyDisplayCard(result.card)).toBe(true);
  });
  it('flattens Card 2.0 form containers while retaining only static text and table cells', () => {
    const result = sanitizeReadonlyCard({ schema: '2.0', body: { elements: [{ tag: 'form', name: 'review', elements: [
      { tag: 'markdown', content: '替班安排' }, { tag: 'input', name: 'reason', default_value: 'secret-input' },
      { tag: 'select_person', value: { request_id: 'reqSynthetic', nonce: 'secret-nonce' } },
      { tag: 'table', columns: [{ name: 'date', display_name: '日期' }, { name: 'person', display_name: '人员' }], rows: [{ date: '2026-10-30', person: '合成人员', hidden: 'secret-hidden' }] },
      { tag: 'button', disabled: true, text: { tag: 'plain_text', content: '已确认' }, form_action_type: 'submit', value: { batchId: 'batchSynthetic' } },
    ] }] } });
    const serialized = JSON.stringify(result.card);
    expect(serialized).toContain('日期：2026-10-30'); expect(serialized).toContain('人员：合成人员');
    expect(serialized).not.toMatch(/secret|form|select_person|input|submit/);
    expect(result.entityKeys).toEqual(['batchId:batchSynthetic', 'request_id:reqSynthetic']);
    expect(isReadonlyDisplayCard(result.card)).toBe(true);
  });
  it('never forwards opaque template variables or unknown widget properties', () => {
    const result = sanitizeReadonlyCard({ type: 'template', data: { template_id: 'private-template', template_variable: { password: 'do-not-copy', user: 'not-visible' } } });
    expect(JSON.stringify(result.card)).toContain('暂不支持');
    expect(JSON.stringify(result.card)).not.toMatch(/do-not-copy|private-template|not-visible/);
    expect(isReadonlyDisplayCard(result.card)).toBe(true);
  });
  it('removes signed destinations even with nested parentheses, angle tags and unclosed markdown', () => {
    const result = sanitizeReadonlyCard({ elements: [{ tag: 'markdown', content: '[确认](https://example.test/(nested)/?ticket=secret-one)\n<a href="feishu://confirm?token=secret-two">确认操作</a>\n<https://example.test?token=secret-three>\n[未闭合](https://example.test/(x)?ticket=secret-four' }] });
    const serialized = JSON.stringify(result.card);
    expect(serialized).toContain('确认操作'); expect(serialized).not.toMatch(/secret|https?|feishu:/);
    expect(isReadonlyDisplayCard(result.card)).toBe(true);
  });
  it('ignores identity-looking fields outside action values and prevents prototype/callback leakage', () => {
    const raw = JSON.parse('{"recordId":"not-an-action","elements":[{"tag":"div","text":{"tag":"plain_text","content":"安全内容"},"__proto__":{"tag":"button","value":{"recordId":"hidden"}}}]}');
    expect(sanitizeReadonlyCard(raw).entityKeys).toEqual([]);
    expect(JSON.stringify(sanitizeReadonlyCard(raw).card)).not.toContain('__proto__');
  });
  it('marks disabled terminal controls as noninteractive', () => {
    const result = sanitizeReadonlyCard({ elements: [{ tag: 'div', text: { tag: 'plain_text', content: '审批通过' } }, { tag: 'button', disabled: true, value: { recordId: 'recOne' }, behaviors: [{ type: 'callback' }] }] });
    expect(result.hasEnabledActions).toBe(false); expect(result.entityKeys).toEqual(['recordId:recOne']);
  });
  it('rejects raw image URL injection and emits safe fallback', () => {
    const result = sanitizeReadonlyCard({ elements: [{ tag: 'img', img_key: 'https://example.test?token=hidden' }] });
    expect(JSON.stringify(result.card)).toContain('图片暂不可展示'); expect(JSON.stringify(result.card)).not.toContain('hidden');
  });
  it('produces stable fingerprints regardless of property insertion order', () => {
    const one = { elements: [{ tag: 'div', text: { tag: 'plain_text', content: '同一业务' } }], header: { template: 'green', title: { tag: 'plain_text', content: '已通过' } } };
    const two = { header: { title: { content: '已通过', tag: 'plain_text' }, template: 'green' }, elements: [{ text: { content: '同一业务', tag: 'plain_text' }, tag: 'div' }] };
    expect(sanitizeReadonlyCard(one).fingerprint).toBe(sanitizeReadonlyCard(two).fingerprint);
    expect(canonicalCardJson({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
  });
  it('bounds output and handles cyclic, malformed and huge unknown input safely', () => {
    const raw: any = { elements: [] }; raw.elements.push(raw, { tag: 'markdown', content: 'x'.repeat(50_000) });
    const result = sanitizeReadonlyCard(raw);
    expect(JSON.stringify(result.card).length).toBeLessThan(14_000); expect(isReadonlyDisplayCard(result.card)).toBe(true);
    for (const input of [null, [], 'invalid-json', 'x'.repeat(1_000_001)]) expect(isReadonlyDisplayCard(sanitizeReadonlyCard(input).card)).toBe(true);
  });
  it('fails the persisted-card validator if any interactive shape or URL is inserted', () => {
    const card = sanitizeReadonlyCard({ elements: [{ tag: 'markdown', content: '正文' }] }).card;
    const changed = structuredClone(card) as any;
    changed.elements.unshift({ tag: 'button', value: { action: 'approve' } }); expect(isReadonlyDisplayCard(changed)).toBe(false);
    changed.elements.shift(); changed.elements[0].text.content = 'https://example.test?ticket=hidden'; expect(isReadonlyDisplayCard(changed)).toBe(false);
  });
  it.each([
    ['long Chinese text', [{ tag: 'markdown', content: '采购说明审批事项'.repeat(2_000) }]],
    ['repeated table labels', [{ tag: 'table', columns: Array.from({ length: 12 }, (_, index) => ({ name: 'field' + index, display_name: '本次采购物品及规格型号详细说明'.repeat(6) })), rows: Array.from({ length: 40 }, () => Object.fromEntries(Array.from({ length: 12 }, (_, index) => ['field' + index, '安全业务说明'.repeat(8)]))) }]],
    ['many images', Array.from({ length: 150 }, (_, index) => ({ tag: 'img', img_key: 'img_v3_' + String(index) + 'a'.repeat(200), alt: { tag: 'plain_text', content: '附件图片说明'.repeat(40) } }))],
  ])('fits %s into the UTF-8 transport budget and keeps the read-only notice', (_name, elements) => {
    const original = { header: { title: { tag: 'plain_text', content: '采购入库通知' } }, elements };
    const untouched = JSON.stringify(original), result = sanitizeReadonlyCard(original);
    const serialized = JSON.stringify(result.card), outputElements = result.card.elements as any[];
    expect(Buffer.byteLength(serialized, 'utf8')).toBeLessThanOrEqual(READONLY_CARD_MAX_BYTES);
    expect(serialized).toContain('采购入库通知'); expect(serialized).toContain('内容已截取');
    expect(outputElements.at(-1).text.content).toBe('只读抄送 · 审批、确认及其他办理请由原收件人操作');
    expect(isReadonlyDisplayCard(result.card)).toBe(true);
    expect(JSON.stringify(original)).toBe(untouched);
    expect(result.fingerprint).toBe(sanitizeReadonlyCard(original).fingerprint);
  });
  it('rejects an otherwise display-only persisted card above the byte budget', () => {
    const card = sanitizeReadonlyCard({ elements: [{ tag: 'markdown', content: '原正文' }] }).card as any;
    card.elements.unshift({ tag: 'div', text: { tag: 'plain_text', content: '中'.repeat(11_000) } });
    expect(Buffer.byteLength(JSON.stringify(card), 'utf8')).toBeGreaterThan(READONLY_CARD_MAX_BYTES);
    expect(isReadonlyDisplayCard(card)).toBe(false);
  });
});
