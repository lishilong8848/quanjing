import {
  DIAGNOSTIC_RECEIPT_RECIPIENT_NAME,
  DIAGNOSTIC_RECEIPT_RECIPIENT_OPEN_ID,
  assertDiagnosticReceiptAppId,
  buildDiagnosticPurchaseReceiptCard,
  resolveDiagnosticReceiptMode,
} from '../../scripts/send-purchase-receipt-card-preview';

describe('local purchase receipt card preview', () => {
  it('is permanently restricted to Ma Jinyu', () => {
    expect(DIAGNOSTIC_RECEIPT_RECIPIENT_NAME).toBe('示例人员020');
    expect(DIAGNOSTIC_RECEIPT_RECIPIENT_OPEN_ID).toBe(
      'PUBLIC_EXAMPLE_FEISHU_TYPHOON_PATH_TEST_OPEN_ID',
    );
    expect(() =>
      resolveDiagnosticReceiptMode(['--recipient', 'ou_other']),
    ).toThrow('本机签收卡诊断不允许指定其他收件人');
  });

  it('builds a directly editable but non-submittable receipt form', () => {
    const card = buildDiagnosticPurchaseReceiptCard(1_790_000_000_000);
    const serialized = JSON.stringify(card);

    expect(serialized).toContain('采购到货待签收');
    expect(serialized).toContain('诊断测试&#45;非真实采购单');
    expect(serialized).toContain('签收人（必选）');
    expect(serialized).toContain('签收时间');
    expect(serialized).toContain('签收备注');
    expect(serialized).toContain('签收照片：0 个（必填）');
    expect(serialized).toContain('发票：0 个（必填）');
    expect(serialized).toContain('select_person');
    expect(serialized).toContain(DIAGNOSTIC_RECEIPT_RECIPIENT_OPEN_ID);
    expect(serialized).not.toContain('behaviors');
    expect(serialized).not.toContain('purchase_batch_receipt_submit:');
    expect(serialized).toContain('diagnostic_receipt_preview_submit');

    const receiptSubmit = findCardObjects(card).find(
      (entry) =>
        (entry.text as { content?: unknown } | undefined)?.content ===
        '签收照片、发票未上传',
    );
    expect(receiptSubmit).toMatchObject({
      disabled: true,
      form_action_type: 'submit',
      name: 'diagnostic_receipt_preview_submit',
    });
  });

  it('requires an explicit live-send confirmation flag', () => {
    expect(resolveDiagnosticReceiptMode([])).toBe('dry-run');
    expect(resolveDiagnosticReceiptMode(['--dry-run'])).toBe('dry-run');
    expect(resolveDiagnosticReceiptMode(['--confirm-live-send'])).toBe(
      'live-send',
    );
    expect(() =>
      resolveDiagnosticReceiptMode(['--dry-run', '--confirm-live-send']),
    ).toThrow('本机签收卡诊断参数冲突');
    expect(() => resolveDiagnosticReceiptMode(['--send'])).toThrow(
      '本机签收卡诊断参数无效',
    );
  });

  it('fails closed when the configured Feishu app is not the confirmed app', () => {
    expect(() => assertDiagnosticReceiptAppId('cli_other')).toThrow(
      '本机签收卡诊断应用不匹配',
    );
    expect(() =>
      assertDiagnosticReceiptAppId('cli_0831564613853b26'),
    ).not.toThrow();
  });
});

function findCardObjects(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => findCardObjects(entry));
  }
  if (!value || typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  return [
    record,
    ...Object.values(record).flatMap((entry) => findCardObjects(entry)),
  ];
}
