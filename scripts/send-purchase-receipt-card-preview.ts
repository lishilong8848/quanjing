import { HttpService } from '@nestjs/axios';
import { getFeishuAuthPayload } from '../server/common/config/external-services.config';
import {
  buildPurchaseBatchReceiptCard,
  type PurchaseBatchReceiptCardInput,
} from '../server/modules/purchase-inventory/purchase-batch-fulfillment-card';
import { PurchaseWorkflowGateway } from '../server/modules/purchase-inventory/purchase-workflow.gateway';

export const DIAGNOSTIC_RECEIPT_RECIPIENT_NAME = '示例人员020';
export const DIAGNOSTIC_RECEIPT_RECIPIENT_OPEN_ID =
  'PUBLIC_EXAMPLE_FEISHU_TYPHOON_PATH_TEST_OPEN_ID';
const DIAGNOSTIC_RECEIPT_APP_ID = 'cli_0831564613853b26';

type DiagnosticReceiptMode = 'dry-run' | 'live-send';

export function resolveDiagnosticReceiptMode(
  args: string[],
): DiagnosticReceiptMode {
  if (
    args.some((arg) => arg === '--recipient' || arg.startsWith('--recipient='))
  ) {
    throw new Error('本机签收卡诊断不允许指定其他收件人');
  }
  const allowed = new Set(['--dry-run', '--confirm-live-send']);
  if (args.some((arg) => !allowed.has(arg))) {
    throw new Error('本机签收卡诊断参数无效');
  }
  const dryRun = args.includes('--dry-run');
  const liveSend = args.includes('--confirm-live-send');
  if (dryRun && liveSend) {
    throw new Error('本机签收卡诊断参数冲突');
  }
  return liveSend ? 'live-send' : 'dry-run';
}

export function buildDiagnosticPurchaseReceiptCard(
  now = Date.now(),
): Record<string, unknown> {
  const input: PurchaseBatchReceiptCardInput = {
    approvalBatchId: `diagnostic-receipt-preview-${now}`,
    requesterOpenId: DIAGNOSTIC_RECEIPT_RECIPIENT_OPEN_ID,
    requesterName: `${DIAGNOSTIC_RECEIPT_RECIPIENT_NAME}（本机诊断）`,
    building: 'H楼',
    requestCode: '诊断测试-非真实采购单',
    items: [
      {
        executionRecordId: 'rec_receipt_preview',
        title: '测试签收表单结构',
        specification: '非业务数据，不写入多维表',
        requestedQuantity: '1',
        actualQuantity: 1,
        unit: '个',
        requestedAmount: '1.00',
        actualAmount: 1,
        purchaserName: '本机诊断',
        purchaseMethod: '需求自采（楼内）',
        receiptState: 'waiting',
        signerName: '',
        receiptTime: null,
        receiptPhotoCount: 0,
        invoiceCount: 0,
      },
    ],
  };
  const card = buildPurchaseBatchReceiptCard(input, {
    selectedRecordId: 'rec_receipt_preview',
  });
  removeDiagnosticCardActions(card);
  assertDiagnosticCardCannotSubmit(card);
  return card;
}

export function assertDiagnosticReceiptAppId(appId: string): void {
  if (appId.trim() !== DIAGNOSTIC_RECEIPT_APP_ID) {
    throw new Error('本机签收卡诊断应用不匹配');
  }
}

function removeDiagnosticCardActions(card: Record<string, unknown>): void {
  for (const element of findCardObjects(card)) {
    if (element.form_action_type === 'submit') {
      element.name = 'diagnostic_receipt_preview_submit';
      element.disabled = true;
    }
    if ('behaviors' in element) {
      delete element.behaviors;
      element.disabled = true;
    }
  }
}

function assertDiagnosticCardCannotSubmit(card: Record<string, unknown>): void {
  const elements = findCardObjects(card);
  if (elements.some((element) => 'behaviors' in element)) {
    throw new Error('本机签收卡诊断不得包含点击回调');
  }
  const submitButtons = elements.filter(
    (element) => element.form_action_type === 'submit',
  );
  const inertButtons = submitButtons.filter(
    (element) =>
      (element.text as { content?: unknown } | undefined)?.content ===
      '签收照片、发票未上传',
  );
  if (
    submitButtons.length !== 1 ||
    inertButtons.length !== 1 ||
    inertButtons.some(
      (element) =>
        element.disabled !== true ||
        element.name !== 'diagnostic_receipt_preview_submit',
    )
  ) {
    throw new Error('本机签收卡诊断展示按钮必须为无动作禁用按钮');
  }
}

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

async function main(): Promise<void> {
  const mode = resolveDiagnosticReceiptMode(process.argv.slice(2));
  const now = Date.now();
  const card = buildDiagnosticPurchaseReceiptCard(now);
  if (mode === 'dry-run') {
    writeResult({
      ok: true,
      mode,
      recipient: DIAGNOSTIC_RECEIPT_RECIPIENT_NAME,
      openIdLocked: true,
      businessDataWritten: false,
      callbackEnabled: false,
    });
    return;
  }

  const auth = getFeishuAuthPayload();
  assertDiagnosticReceiptAppId(auth.app_id);
  const gateway = new PurchaseWorkflowGateway(new HttpService());
  const messageId = await gateway.sendInteractiveCard(
    DIAGNOSTIC_RECEIPT_RECIPIENT_OPEN_ID,
    card,
    `receipt-preview-${now}`,
  );
  writeResult({
    ok: true,
    mode,
    recipient: DIAGNOSTIC_RECEIPT_RECIPIENT_NAME,
    openIdLocked: true,
    businessDataWritten: false,
    callbackEnabled: false,
    messageDelivered: Boolean(messageId),
  });
}

function writeResult(value: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(
      /(app_secret|tenant_access_token|authorization|token)\s*[:=]\s*[^\s,;]+/giu,
      '$1=***',
    )
    .slice(0, 300);
}

if (require.main === module) {
  main().catch((error: unknown) => {
    writeResult({ ok: false, error: safeErrorMessage(error) });
    process.exitCode = 1;
  });
}
