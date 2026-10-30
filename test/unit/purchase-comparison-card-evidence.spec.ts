import {
  normalizePurchaseComparisonCardEvidence,
  normalizePurchaseComparisonBatchEvidence,
  renderPurchaseComparisonCardEvidence,
  type PurchaseComparisonCardEvidence,
} from '../../server/modules/purchase-inventory/purchase-comparison-card-evidence';
import {
  buildPurchaseManagerApprovalCard, buildPurchaseManagerRejectEditorCard, buildPurchaseManagerPendingCard,
  buildResolvedPurchaseManagerApprovalCard, buildPurchaseManagerManualReconciliationCard, buildPurchaseManagerTransferredCard,
  serializePurchaseManagerApprovalCardContext, parsePurchaseManagerApprovalCardContext,
  type PurchaseManagerApprovalCardInput,
} from '../../server/modules/purchase-inventory/purchase-manager-approval-card';
import {
  buildPurchaseManagerBatchApprovalCard, buildPurchaseManagerBatchRejectEditorCard, buildPurchaseManagerBatchPendingCard,
  buildResolvedPurchaseManagerBatchApprovalCard, buildPurchaseManagerBatchManualReconciliationCard, buildPurchaseManagerBatchHandoverCard,
  serializePurchaseManagerBatchApprovalCardContext, parsePurchaseManagerBatchApprovalCardContext,
  type PurchaseManagerBatchApprovalCardInput,
} from '../../server/modules/purchase-inventory/purchase-manager-batch-approval-card';

function evidence(recordId = 'rec_one', prefix = 'common'): PurchaseComparisonCardEvidence {
  return { recordId, recordUrl: `https://vnet.feishu.cn/base/appExample123?table=tblPurchase&record=${recordId}`,
    attachments: [1, 2, 3].map(index => ({ name: `比价 [供应商${index}]（报价单）.png`, disposition: 'preview', imageKey: `img_v3_${prefix}_${index}` })) };
}
const single: PurchaseManagerApprovalCardInput = {
  executionRecordId: 'rec_one', requester: '测试申请人', building: 'H楼', title: '设备', quantity: 3,
  unit: '个', amount: 100, procurementForm: '三方比价', requestCode: 'CG-TEST-001', createdAt: '2026-10-29 10:00',
};
function batch(count = 2): PurchaseManagerBatchApprovalCardInput {
  return { version: 3, approvalBatchId: 'purchase-batch-synthetic', requesterName: '测试申请人', requesterOpenId: 'ou_synthetic',
    building: 'H楼', requestCode: 'CG-TEST-001', createdAt: '2026-10-29 10:00', expectedDeliveryAt: null,
    items: Array.from({ length: count }, (_, i) => ({ executionRecordId: `rec_${i}`, title: `物品${i + 1}`, specification: '/', quantity: '1', unit: '个',
      amount: '10', procurementForm: '三方比价', singleReason: null, status: 'pending', choice: '', rejectionReason: '' })) };
}
function nodes(value: unknown, tag: string): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.flatMap(item => nodes(item, tag));
  if (!value || typeof value !== 'object') return [];
  const row = value as Record<string, unknown>;
  return [...(row.tag === tag ? [row] : []), ...Object.values(row).flatMap(item => nodes(item, tag))];
}
function withBatchEvidence(input: PurchaseManagerBatchApprovalCardInput): PurchaseManagerBatchApprovalCardInput {
  return { ...input, comparisonEvidence: input.items.map(item => evidence(item.executionRecordId)) };
}

describe('采购比价附件快照与安全原件链接', () => {
  it('只接受绑定当前记录的安全媒体Key与原采购单链接', () => {
    expect(normalizePurchaseComparisonCardEvidence(evidence(), 'rec_one')).toEqual(evidence());
    expect(() => normalizePurchaseComparisonCardEvidence(evidence(), 'rec_other')).toThrow('快照无效');
    expect(() => normalizePurchaseComparisonCardEvidence({ ...evidence(), file_token: 'sensitive' })).toThrow('快照无效');
    expect(() => normalizePurchaseComparisonCardEvidence({ ...evidence(), attachments: [{ ...evidence().attachments[0], tmpUrl: 'https://example.test/private' }] })).toThrow('快照无效');
  });
  it.each([
    'http://vnet.feishu.cn/base/appExample123?table=tblPurchase&record=rec_one',
    'https://vnet.feishu.cn.evil.test/base/appExample123?table=tblPurchase&record=rec_one',
    'https://open.feishu.cn/base/appExample123?table=tblPurchase&record=rec_one',
    'https://a.b.feishu.cn/base/appExample123?table=tblPurchase&record=rec_one',
    'https://user@vnet.feishu.cn/base/appExample123?table=tblPurchase&record=rec_one',
    'https://vnet.feishu.cn:444/base/appExample123?table=tblPurchase&record=rec_one',
    'https://vnet.feishu.cn/base/appExample123?table=tblPurchase&record=rec_other',
    'https://vnet.feishu.cn/base/appExample123?table=tblPurchase&record=rec_one&file_token=secret',
    'https://vnet.feishu.cn/base/appExample123?table=tblPurchase&record=rec_one#secret',
    'https://vnet.feishu.cn/base/appExample123?table=tblPurchase&record=rec_one&record=rec_one',
  ])('拒绝错源/错记录/媒体参数地址 %#', recordUrl => {
    expect(() => normalizePurchaseComparisonCardEvidence({ ...evidence(), recordUrl })).toThrow('快照无效');
  });
  it.each([
    { name: '报价单.png', disposition: 'preview' },
    { name: '报价单.pdf', disposition: 'original', imageKey: 'img_v3_forbidden' },
    { name: '报价单.png', disposition: 'preview', imageKey: 'https://evil.test/a.png' },
    { name: '报价\n单.png', disposition: 'preview', imageKey: 'img_v3_test' },
  ])('拒绝未核验媒体/处置组合 %#', attachment => {
    expect(() => normalizePurchaseComparisonCardEvidence({ ...evidence(), attachments: [attachment] })).toThrow('快照无效');
  });
  it('附件最多5项、批次最多20组，并拒绝重复或单一采购记录', () => {
    expect(() => normalizePurchaseComparisonCardEvidence({ ...evidence(), attachments: [] })).toThrow();
    expect(() => normalizePurchaseComparisonCardEvidence({ ...evidence(), attachments: Array(6).fill(evidence().attachments[0]) })).toThrow();
    expect(() => normalizePurchaseComparisonBatchEvidence([evidence(), evidence()], ['rec_one'])).toThrow();
    expect(() => normalizePurchaseComparisonBatchEvidence([evidence()], ['rec_other'])).toThrow();
    expect(() => normalizePurchaseComparisonBatchEvidence(Array.from({ length: 21 }, (_, i) => evidence(`rec_${i}`)), Array.from({ length: 21 }, (_, i) => `rec_${i}`))).toThrow();
  });
  it('批次证据不能跨租户、Base或执行表，即使recordId正确', () => {
    const first = evidence('rec_a'), second = evidence('rec_b');
    for (const replacement of [['vnet.feishu.cn', 'other.feishu.cn'], ['appExample123', 'appOther456'], ['tblPurchase', 'tblOther']]) {
      expect(() => normalizePurchaseComparisonBatchEvidence([first, { ...second, recordUrl: second.recordUrl.replace(replacement[0], replacement[1]) }], ['rec_a', 'rec_b'])).toThrow();
    }
  });
  it('真实中文空格括号名称可用并转义markdown，长名称仅展示省略', () => {
    const name = `供应商 [正式报价] (${('详细报价').repeat(40)}).png`;
    const current = { ...evidence(), attachments: [{ name, disposition: 'preview' as const, imageKey: 'img_v3_name' }] };
    expect(normalizePurchaseComparisonCardEvidence(current).attachments[0].name).toBe(name);
    const card = renderPurchaseComparisonCardEvidence([current]);
    const content = nodes(card, 'markdown').map(row => row.content).join('\n');
    expect(content).toContain('&#91;正式报价&#93;');
    expect(content).toContain('…');
    expect(Array.from(String((nodes(card, 'img')[0].alt as { content: string }).content)).length).toBe(120);
  });
});

describe('单条与批次审批卡保留比价依据和原交互', () => {
  const singleBuilders = [
    (value: PurchaseManagerApprovalCardInput) => buildPurchaseManagerApprovalCard(value),
    (value: PurchaseManagerApprovalCardInput) => buildPurchaseManagerRejectEditorCard(value),
    (value: PurchaseManagerApprovalCardInput) => buildPurchaseManagerPendingCard(value, 'comprehensive'),
    (value: PurchaseManagerApprovalCardInput) => buildResolvedPurchaseManagerApprovalCard(value, { choice: 'comprehensive', actorName: '审批人', processedAt: '2026-10-29 11:00' }),
    (value: PurchaseManagerApprovalCardInput) => buildPurchaseManagerManualReconciliationCard(value),
    (value: PurchaseManagerApprovalCardInput) => buildPurchaseManagerTransferredCard(value),
  ];
  it.each(singleBuilders.map((build, index) => ({ build, index })))('单条卡状态 $index 增加3张图片但不改变任何原按钮', ({ build }) => {
    const original = build(single), enhanced = build({ ...single, comparisonEvidence: evidence() });
    expect(nodes(enhanced, 'img').map(row => row.img_key)).toEqual(evidence().attachments.map(row => row.imageKey));
    expect(nodes(enhanced, 'button')).toEqual(nodes(original, 'button'));
    expect(JSON.stringify(enhanced)).toContain(evidence().recordUrl);
    expect(JSON.stringify(enhanced)).not.toMatch(/file_token|tmp_url/);
  });
  it('单条旧context序列化不增加字段，新context可安全往返且不能嫁接到单一采购', () => {
    const old = serializePurchaseManagerApprovalCardContext(single);
    expect(old).not.toContain('comparisonEvidence');
    expect(serializePurchaseManagerApprovalCardContext(parsePurchaseManagerApprovalCardContext(old))).toBe(old);
    const encoded = serializePurchaseManagerApprovalCardContext({ ...single, comparisonEvidence: evidence() });
    expect(parsePurchaseManagerApprovalCardContext(encoded).comparisonEvidence).toEqual(evidence());
    expect(() => buildPurchaseManagerApprovalCard({ ...single, procurementForm: '单一采购', comparisonEvidence: evidence() })).toThrow();
    expect(() => parsePurchaseManagerApprovalCardContext(encoded.replace('三方比价', '单一采购'))).toThrow();
  });
  it('所有批次卡视图保留相同依据，重复3图只画一次且保留两个记录入口', () => {
    const initial = batch(), enhanced = withBatchEvidence(initial);
    const resolved = { ...initial, items: initial.items.map(item => ({ ...item, status: 'approved' as const, choice: 'comprehensive' as const })) };
    const cases = [
      [buildPurchaseManagerBatchApprovalCard(initial), buildPurchaseManagerBatchApprovalCard(enhanced)],
      [buildPurchaseManagerBatchRejectEditorCard(initial, 'rec_0'), buildPurchaseManagerBatchRejectEditorCard(enhanced, 'rec_0')],
      [buildPurchaseManagerBatchPendingCard(initial), buildPurchaseManagerBatchPendingCard(enhanced)],
      [buildPurchaseManagerBatchHandoverCard(initial), buildPurchaseManagerBatchHandoverCard(enhanced)],
      [buildPurchaseManagerBatchManualReconciliationCard(initial), buildPurchaseManagerBatchManualReconciliationCard(enhanced)],
      [buildResolvedPurchaseManagerBatchApprovalCard(resolved, { actorName: '审批人', processedAt: null }), buildResolvedPurchaseManagerBatchApprovalCard(withBatchEvidence(resolved), { actorName: '审批人', processedAt: null })],
    ];
    for (const [original, actual] of cases) {
      expect(nodes(actual, 'img')).toHaveLength(3);
      expect(nodes(actual, 'button')).toEqual(nodes(original, 'button'));
      for (const row of enhanced.comparisonEvidence!) expect(JSON.stringify(actual)).toContain(row.recordUrl);
    }
  });
  it('可选原件同名不被当作同一个文件，已验证重复图片仍只展示一次', () => {
    const first = evidence('rec_a'), second = evidence('rec_b');
    first.attachments.push({ name: '补充报价.pdf', disposition: 'original' });
    second.attachments.push({ name: '补充报价.pdf', disposition: 'original' });
    const card = renderPurchaseComparisonCardEvidence([first, second]);
    expect(nodes(card, 'img')).toHaveLength(3);
    const text = JSON.stringify(card);
    expect(text.match(/补充报价.pdf/g)).toHaveLength(2);
    expect(text).toContain(first.recordUrl);
    expect(text).toContain(second.recordUrl);
    expect(text).toContain('需在原采购单打开原件');
  });
  it('不同附件集合保持各记录关联，最多12张预览，其余逐项列名和原件入口', () => {
    const input = batch(5);
    input.comparisonEvidence = input.items.map((item, index) => evidence(item.executionRecordId, `set${index}`));
    const card = buildPurchaseManagerBatchApprovalCard(input);
    expect(nodes(card, 'img')).toHaveLength(12);
    expect(JSON.stringify(card)).toContain('其余附件请打开原件查看');
    for (const row of input.comparisonEvidence) expect(JSON.stringify(card)).toContain(row.recordUrl);
  });
  it('批次旧context保持字节、新证据往返，拒绝外部记录和非三方记录', () => {
    const initial = batch(), old = serializePurchaseManagerBatchApprovalCardContext(initial);
    expect(old).not.toContain('comparisonEvidence');
    expect(serializePurchaseManagerBatchApprovalCardContext(parsePurchaseManagerBatchApprovalCardContext(old))).toBe(old);
    const enhanced = withBatchEvidence(initial), encoded = serializePurchaseManagerBatchApprovalCardContext(enhanced);
    expect(parsePurchaseManagerBatchApprovalCardContext(encoded)).toEqual(enhanced);
    expect(() => buildPurchaseManagerBatchApprovalCard({ ...initial, comparisonEvidence: [evidence('rec_other')] })).toThrow();
    expect(() => buildPurchaseManagerBatchApprovalCard({ ...enhanced, items: enhanced.items.map(item => ({ ...item, procurementForm: '单一采购' as const })) })).toThrow();
  });
  it('20项共享5份长文件名和图片Key时context只存一次，完整恢复每个原记录', () => {
    const initial = batch(20), enhanced = withBatchEvidence(initial);
    const attachments = Array.from({ length: 5 }, (_, index) => ({ name: `${'正式报价'.repeat(29)}${index}.png`, disposition: 'preview' as const, imageKey: `img_v3_${'x'.repeat(260)}_${index}` }));
    enhanced.comparisonEvidence = initial.items.map(item => ({ ...evidence(item.executionRecordId), attachments }));
    const encoded = serializePurchaseManagerBatchApprovalCardContext(enhanced);
    expect(Buffer.byteLength(encoded, 'utf8')).toBeLessThan(48_000);
    const raw = JSON.parse(encoded);
    expect(raw.comparisonEvidence[0].attachments).toEqual(attachments);
    expect(raw.comparisonEvidence.slice(1).every((entry: Record<string, unknown>) => entry.sameAttachmentsAs === 'rec_0' && !('attachments' in entry))).toBe(true);
    const restored = parsePurchaseManagerBatchApprovalCardContext(encoded);
    expect(restored.comparisonEvidence).toEqual(enhanced.comparisonEvidence);
    expect(serializePurchaseManagerBatchApprovalCardContext(restored)).toBe(encoded);
    expect(nodes(buildPurchaseManagerBatchApprovalCard(restored), 'img')).toHaveLength(5);
  });
  it('压缩引用只接受前序同源组，不接受前向、自身或串表引用', () => {
    const raw = JSON.parse(serializePurchaseManagerBatchApprovalCardContext(withBatchEvidence(batch(3))));
    for (const reference of ['rec_1', 'rec_2', 'rec_external']) {
      const mutated = structuredClone(raw); mutated.comparisonEvidence[1].sameAttachmentsAs = reference;
      expect(() => parsePurchaseManagerBatchApprovalCardContext(JSON.stringify(mutated))).toThrow();
    }
    const wrongTable = structuredClone(raw);
    wrongTable.comparisonEvidence[1].recordUrl = wrongTable.comparisonEvidence[1].recordUrl.replace('tblPurchase', 'tblOther');
    expect(() => parsePurchaseManagerBatchApprovalCardContext(JSON.stringify(wrongTable))).toThrow();
  });
  it('混合不同附件集合各自压缩并恢复，不只取首条附件', () => {
    const input = batch(4);
    input.comparisonEvidence = input.items.map((item, index) => evidence(item.executionRecordId, index < 2 ? 'groupA' : 'groupB'));
    const encoded = serializePurchaseManagerBatchApprovalCardContext(input), raw = JSON.parse(encoded);
    expect(raw.comparisonEvidence[1].sameAttachmentsAs).toBe('rec_0');
    expect(raw.comparisonEvidence[3].sameAttachmentsAs).toBe('rec_2');
    const restored = parsePurchaseManagerBatchApprovalCardContext(encoded);
    expect(restored.comparisonEvidence).toEqual(input.comparisonEvidence);
    expect(nodes(buildPurchaseManagerBatchApprovalCard(restored), 'img')).toHaveLength(6);
  });
  it('20×5独立255字附件含12张预览时持久快照和卡片都可控缩短，关联和审批按钮不变', () => {
    const initial = batch(20), enhanced = withBatchEvidence(initial);
    enhanced.comparisonEvidence = initial.items.map((item, i) => ({ ...evidence(item.executionRecordId),
      attachments: Array.from({ length: 5 }, (_, j) => {
        const prefix = `文件${i}_${j}-`, preview = i * 5 + j < 12;
        return { name: `${prefix}${'真'.repeat(255 - prefix.length - 4)}.${preview ? 'png' : 'pdf'}`,
          disposition: preview ? 'preview' as const : 'original' as const,
          ...(preview ? { imageKey: `img_v3_independent_${i}_${j}` } : {}) };
      }) }));
    const unchanged = structuredClone(enhanced);
    const encoded = serializePurchaseManagerBatchApprovalCardContext(enhanced);
    expect(Buffer.byteLength(encoded, 'utf8')).toBeLessThanOrEqual(48_000);
    const restored = parsePurchaseManagerBatchApprovalCardContext(encoded);
    expect(serializePurchaseManagerBatchApprovalCardContext(restored)).toBe(encoded);
    expect(enhanced).toEqual(unchanged);
    expect(restored.comparisonEvidence).toHaveLength(20);
    restored.comparisonEvidence!.forEach((entry, i) => {
      expect(entry.recordId).toBe(enhanced.comparisonEvidence![i].recordId);
      expect(entry.recordUrl).toBe(enhanced.comparisonEvidence![i].recordUrl);
      expect(entry.attachments).toHaveLength(5);
      entry.attachments.forEach((attachment, j) => {
        expect(attachment.name).toMatch(/…$/);
        expect(attachment.disposition).toBe(enhanced.comparisonEvidence![i].attachments[j].disposition);
        expect(attachment.imageKey).toBe(enhanced.comparisonEvidence![i].attachments[j].imageKey);
      });
    });
    const card = buildPurchaseManagerBatchApprovalCard(enhanced);
    expect(card).toEqual(buildPurchaseManagerBatchApprovalCard(restored));
    expect(Buffer.byteLength(JSON.stringify(card), 'utf8')).toBeLessThanOrEqual(30 * 1024);
    expect(nodes(card, 'button')).toEqual(nodes(buildPurchaseManagerBatchApprovalCard(initial), 'button'));
    expect(JSON.stringify(card)).toContain('三方比价附件清单');
    expect(JSON.stringify(card)).toContain('文件名有省略，请在原采购单查看完整名称');
    for (const row of enhanced.comparisonEvidence) expect(JSON.stringify(card)).toContain(row.recordUrl);
  });
  it('名称缩短后混合共享/独立附件组仍逐条映射，未超限快照不默认截短完整名称', () => {
    const input = batch(20);
    input.comparisonEvidence = input.items.map((item, i) => ({ ...evidence(item.executionRecordId),
      attachments: Array.from({ length: 5 }, (_, j) => ({ name: `${i < 5 ? '共享' : `独立${i}`}${j}${'中文报价'.repeat(61)}`,
        disposition: 'original' as const })) }));
    const encoded = serializePurchaseManagerBatchApprovalCardContext(input);
    expect(Buffer.byteLength(encoded, 'utf8')).toBeLessThanOrEqual(48_000);
    const raw = JSON.parse(encoded);
    expect(raw.comparisonEvidence[1].sameAttachmentsAs).toBe('rec_0');
    expect(raw.comparisonEvidence[4].sameAttachmentsAs).toBe('rec_0');
    expect(raw.comparisonEvidence[5].sameAttachmentsAs).toBeUndefined();
    const restored = parsePurchaseManagerBatchApprovalCardContext(encoded);
    restored.comparisonEvidence!.forEach((entry, i) => {
      expect(entry.recordId).toBe(`rec_${i}`);
      expect(entry.recordUrl).toBe(input.comparisonEvidence![i].recordUrl);
      entry.attachments.forEach((attachment, j) => expect(attachment.name).toContain(`${i < 5 ? '共享' : `独立${i}`}${j}`));
    });
    const small = batch(1);
    small.comparisonEvidence = [input.comparisonEvidence[0]];
    const smallEncoded = serializePurchaseManagerBatchApprovalCardContext(small);
    expect(parsePurchaseManagerBatchApprovalCardContext(smallEncoded).comparisonEvidence![0].attachments[0].name).toBe(input.comparisonEvidence[0].attachments[0].name);
    expect(smallEncoded).not.toContain('…');
  });
});
