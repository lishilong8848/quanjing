import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const dialogPath = resolve(
  'client/src/pages/PurchaseInventoryManagement/PurchaseWorkflowDialog.tsx',
);
const overviewPath = resolve(
  'client/src/pages/PurchaseInventoryManagement/PurchaseOverviewPage.tsx',
);
const apiPath = resolve('client/src/api/index.ts');

describe('purchase workflow UI contract', () => {
  it('provides a centered viewport-bound workflow dialog with six timeline nodes', () => {
    const source = readFileSync(dialogPath, 'utf8');
    expect(source).toContain('fixed inset-0');
    expect(source).toContain('items-center justify-center');
    expect(source).toContain('max-h-[calc(100dvh-2rem)]');
    expect(source).toContain('detail.timeline.map');
    expect(source).toContain('sm:grid-cols-6');
    expect(source).not.toContain('sm:grid-cols-5');
    expect(source).toContain('allowedActions.includes');
  });

  it('renders state-specific approval, start, order, and receipt actions', () => {
    const source = readFileSync(dialogPath, 'utf8');
    for (const action of ['approve', 'start', 'order', 'receive']) {
      expect(source).toContain(`'${action}'`);
    }
    expect(source).toContain('paymentAttachments');
    expect(source).toContain('receiptPhotos');
    expect(source).toContain('invoices');
    expect(source).toContain('实际采购数量');
    expect(source).toContain('数量差异');
    expect(source).toContain('实际付款金额');
    expect(source).toContain('金额差异');
    expect(source).toContain('采购完成');
    expect(source).toContain('签收人');
    expect(source).toContain('签收时间');
    expect(source).not.toContain('useAccess');
    expect(source).toContain('canOperate');
    expect(source).not.toContain('getPurchaseApplicationLoginUrl');
    expect(source).not.toContain('飞书登录');
    expect(source).not.toContain('redirectToFeishuLogin');
  });

  it('keeps receipt photos required while invoices remain optional', () => {
    const source = readFileSync(dialogPath, 'utf8');
    expect(source).toContain('label="签收照片（必填）"');
    expect(source).toContain('label="发票附件（选填）"');
    expect(source).not.toContain('required={props.selfPurchase}');
    expect(source).not.toContain(
      '(props.selfPurchase && !props.invoices.length)',
    );
  });

  it('selects the signer from active Feishu employees before receipt', () => {
    const source = readFileSync(dialogPath, 'utf8');
    expect(source).toContain('searchPurchaseApplicationApplicants');
    expect(source).toContain('signerOpenId');
    expect(source).toContain('<SignerField');
    expect(source).not.toContain('当前登录人（系统自动）');
    expect(source).not.toContain('aria-readonly="true"');
  });

  it('opens order and receipt workflows only through explicit row permissions', () => {
    const source = readFileSync(overviewPath, 'utf8');
    expect(source).toContain('PurchaseWorkflowDialog');
    expect(source).toContain('canOrderPurchaseRecord');
    expect(source).toContain('canReceivePurchaseRecord');
    expect(source).toContain('setWorkflowItem(item)');
    expect(source).toContain("item.stage !== 'executing'");
    expect(source).toContain('workflowItem?.executionRecordId');
    expect(source).toContain('item={workflowItem}');
    expect(source).toContain('canOrderItem');
    expect(source).toContain('canReceiveItem');
    expect(source).toContain('onOrderItem');
    expect(source).toContain('canOrder={itemCanOrder}');
    expect(source).toContain('onOrder={() => onOrderItem?.(item)}');
    expect(source).not.toContain(
      "item.stage !== 'receiving' || !canEditRecord(item)",
    );
    expect(source).not.toContain(
      "item.stage === 'receiving' && itemCanEdit",
    );
    expect(source).not.toContain('canEditRecord(workflowItem)');
    expect(source).not.toContain('程序流程');
  });

  it('renders the dashboard preview immediately while live detail refreshes in the background', () => {
    const source = readFileSync(dialogPath, 'utf8');
    expect(source).toContain('item: PurchaseInventoryRequestItem | null');
    expect(source).toContain(
      'createPurchaseWorkflowPreviewDetail(item, canOperate)',
    );
    expect(source).toContain('正在后台刷新最新流程');
    expect(source.indexOf('detail ? (')).toBeLessThan(
      source.indexOf('loading ? ('),
    );
  });

  it('keeps the preview visible when the live detail response is empty', () => {
    const source = readFileSync(dialogPath, 'utf8');
    expect(source).toContain('if (!loaded?.record)');
    expect(source).toContain('采购流程详情响应为空');
    expect(source).toContain('setDetail((current) => current || preview)');
  });

  it('releases the receipt interaction before the background upload starts', () => {
    const source = readFileSync(dialogPath, 'utf8');
    const receiptAction = source.slice(
      source.indexOf('function runReceiptAction'),
      source.indexOf('const allowedActions'),
    );

    expect(receiptAction).toContain('receiptSubmissionInFlight.current = true');
    expect(receiptAction).toContain('onReceiptAccepted(recordId)');
    expect(receiptAction).toContain('onOpenChange(false)');
    expect(receiptAction).toContain('window.setTimeout(() =>');
    expect(receiptAction).toContain('void submitPurchaseWorkflowReceipt');
    expect(receiptAction).not.toContain('await submitPurchaseWorkflowReceipt');
  });

  it('distinguishes ordinary disabled actions from real submission loading', () => {
    const source = readFileSync(dialogPath, 'utf8');
    const actionButtons =
      source.match(/<ActionButton[\s\S]*?\/>/g) ?? [];

    expect(actionButtons).toHaveLength(4);
    actionButtons.forEach((button) => {
      expect(button).toMatch(/\bloading=/);
    });
    expect(source).toContain('resolveActionButtonState({');
    expect(source).toContain('showSpinner');
    expect(source).not.toContain('{disabled ? (');
    expect(source).toContain("loading ? '提交中' : label");
  });

  it('coordinates order submissions by record without stale completion clearing a newer action', () => {
    const source = readFileSync(dialogPath, 'utf8');
    const orderAction = source.slice(
      source.indexOf('async function runOrderAction'),
      source.indexOf('function runReceiptAction'),
    );

    expect(source).toContain('new PurchaseWorkflowSubmissionGate()');
    expect(source).toMatch(/useState<string \| null>\(\s*null,\s*\)/);
    expect(source).toContain('submittingRecordId === recordId');
    expect(orderAction).toContain('runPurchaseOrderSubmission({');
    expect(orderAction).toContain('gate: submissionGateRef.current');
    expect(orderAction).toContain('onAccepted: () =>');
    expect(orderAction).toContain('onClose: () => onOpenChange(false)');
    expect(orderAction).toContain('onSettled: onOrderTaskSettled');
    expect(orderAction).toContain('submit: () =>');
    expect(orderAction).toContain(
      'clearFinishedSubmission(currentRecordId, submissionRecordId)',
    );
  });

  it('reports accepted, recovery-failed, and recovered order errors distinctly', () => {
    const source = readFileSync(dialogPath, 'utf8');
    const orderAction = source.slice(
      source.indexOf('async function runOrderAction'),
      source.indexOf('function runReceiptAction'),
    );

    expect(source).toContain('PurchaseOrderSubmissionStateError');
    expect(orderAction).toContain(
      'actionError instanceof PurchaseOrderSubmissionStateError',
    );
    expect(orderAction).toContain('actionError.serverAccepted');
    expect(orderAction).toContain('actionError.recoveryFailed');
    expect(orderAction).toContain(
      '下单已提交，但页面状态同步失败，请手动刷新',
    );
    expect(orderAction).toContain(
      '下单失败，页面状态恢复失败，请手动刷新',
    );
    expect(orderAction).toContain('页面状态已自动恢复');
  });

  it('provides typed detail and multipart command API calls', () => {
    const source = readFileSync(apiPath, 'utf8');
    const dialog = readFileSync(dialogPath, 'utf8');
    for (const name of [
      'getPurchaseWorkflowDetail',
      'approvePurchaseWorkflow',
      'startPurchaseWorkflow',
      'submitPurchaseWorkflowOrder',
      'submitPurchaseWorkflowReceipt',
    ]) {
      expect(source).toContain(`function ${name}`);
    }
    expect(source).toContain("form.append('receiptPhotos'");
    expect(source).toContain("form.append('invoices'");
    expect(source).toContain('getPurchaseWorkflowReceiptTaskStatus');
    expect(dialog).toContain('monitorPurchaseWorkflowReceiptTask');
    expect(dialog).toContain('onReceiptAccepted(recordId)');
    expect(dialog).toContain('onOrderAccepted(submissionRecordId');
    expect(dialog).toContain('min="1"');
    const orderAction = dialog.slice(
      dialog.indexOf('async function runOrderAction'),
      dialog.indexOf('function runReceiptAction'),
    );
    expect(
      orderAction.indexOf('onOrderAccepted(submissionRecordId'),
    ).toBeLessThan(orderAction.indexOf('submitPurchaseWorkflowOrder'));
    expect(dialog).toContain("onReceiptTaskSettled(recordId, 'failed')");
    expect(dialog.indexOf('onReceiptAccepted(recordId)')).toBeLessThan(
      dialog.indexOf('void submitPurchaseWorkflowReceipt'),
    );
  });
});
