import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const overviewPath = resolve(
  'client/src/pages/PurchaseInventoryManagement/PurchaseOverviewPage.tsx',
);
const dialogPath = resolve(
  'client/src/pages/PurchaseInventoryManagement/PurchaseOnlineApprovalDialog.tsx',
);
const apiPath = resolve('client/src/api/index.ts');

function read(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

describe('purchase online approval UI contract', () => {
  it('opens online approval from both desktop and mobile status badges', () => {
    const overview = read(overviewPath);

    expect(overview).toContain('PurchaseOnlineApprovalDialog');
    expect(overview).toContain('canApprovePurchaseOnline');
    expect(overview).toContain('const [approvalItem, setApprovalItem]');
    expect(overview).toContain('canApproveItem');
    expect(overview).toContain('onApproveItem');
    expect(overview).toContain('setApprovalItem(item)');
    expect(overview.match(/<StageBadge/g)?.length).toBe(2);
    expect(overview).toContain('const actionLabel = canApprove');
    expect(overview).toContain("? '签收'");
    expect(overview).toContain(": '入库'");
    expect(overview).toContain(
      'aria-label={`${actionLabel} ${item.requestCode || item.title}`}',
    );
    expect(overview).toContain(
      'aria-label={`进入审批 ${item.requestCode || item.title}`}',
    );
    expect(overview).toContain('title="进入审批"');
    expect(overview.match(/>\s*审批\s*<\/button>/g)?.length).toBe(2);
  });

  it('closes the approval dialog when the signed-in principal changes', () => {
    const overview = read(overviewPath);

    expect(overview).toContain('setApprovalItem(null)');
    expect(overview).toContain('principalMatchesRenderedData');
    expect(overview).toContain('<PurchaseOnlineApprovalDialog');
    expect(overview).toMatch(
      /item=\{[\s\S]*principalMatchesRenderedData[\s\S]*approvalItem[\s\S]*\}/,
    );
  });

  it('renders a focused approval dialog with real approve and reject actions', () => {
    expect(existsSync(dialogPath)).toBe(true);
    const dialog = read(dialogPath);

    expect(dialog).toContain('采购申请审批');
    expect(dialog).toContain('采购单号');
    expect(dialog).toContain('确认通过');
    expect(dialog).toContain('驳回申请');
    expect(dialog).toContain("'approved'");
    expect(dialog).toContain("'rejected'");
    expect(dialog).toContain('item.requestCode');
    expect(dialog).toContain('item.requester');
    expect(dialog).toContain('item.building');
    expect(dialog).toContain('item.title');
    expect(dialog).toContain('item.statusLabel');
    expect(dialog).toContain('item.purchaseMethod');
    expect(dialog).toContain('item.approvalTarget');
    expect(dialog).toContain('submitPurchaseOnlineApproval');
    expect(dialog).not.toContain('已${response.resultLabel}');
  });

  it('locks duplicate decisions, closes after acceptance, and monitors Base sync', () => {
    const dialog = read(dialogPath);

    expect(dialog).toContain('createPurchaseOnlineApprovalSubmissionGate');
    expect(dialog).toContain('submissionGate.tryStart()');
    expect(dialog).toContain('submissionGate.finish()');
    expect(dialog).toContain('monitorPurchaseOnlineApprovalTask');
    expect(dialog).toContain('onOptimisticDecision(item, decision)');
    expect(dialog).toContain("onTaskSettled(item.recordId, 'failed')");
    expect(dialog).toContain("onTaskSettled(item.recordId, 'completed')");
    expect(dialog).toContain('getPurchaseOnlineApprovalTaskStatus');
    expect(dialog).toContain('onOpenChange(false)');
    expect(dialog).toContain('submitting');
    expect(dialog).toContain('toast.success');
    expect(dialog).toContain('toast.warning');
    expect(dialog).toContain('toast.error');
  });

  it('posts a typed decision to the dedicated online approval endpoint', () => {
    const api = read(apiPath);

    expect(api).toContain('function submitPurchaseOnlineApproval');
    expect(api).toContain(
      '/api/purchase-inventory/records/${encodeURIComponent(recordId)}/approval',
    );
    expect(api).toContain("method: 'POST'");
    expect(api).toContain('data: input');
    expect(api).toContain('function getPurchaseOnlineApprovalTaskStatus');
    expect(api).toContain(
      '/api/purchase-inventory/approval/tasks/${encodeURIComponent(taskId)}',
    );
  });

  it('keeps online approval detached while mounting order and receipt workflows', () => {
    const overview = read(overviewPath);
    const dialog = read(dialogPath);

    expect(overview).toContain('<PurchaseWorkflowDialog');
    expect(overview).toContain('setWorkflowItem(item)');
    expect(overview).toContain("item.stage !== 'executing'");
    expect(overview).toContain('canReceivePurchaseRecord');
    expect(overview).toContain('if (!canReceiveItem(item)) return;');
    expect(overview).not.toContain('<PurchaseWorkflowCenterDialog');
    expect(overview).toContain('workflowItem?.executionRecordId');
    expect(dialog).not.toContain('approvePurchaseWorkflow');
    expect(dialog).not.toContain('startPurchaseWorkflow');
    expect(dialog).not.toContain('submitPurchaseWorkflowOrder');
    expect(dialog).not.toContain('submitPurchaseWorkflowReceipt');
    expect(dialog).not.toContain('programEnabled');
  });

  it('renders signed purchases in a dedicated inbound list at the page bottom', () => {
    const overview = read(overviewPath);

    expect(overview).toContain('filterPurchaseInboundItems');
    expect(overview).toContain('const inboundItems = useMemo');
    expect(overview).toContain('title="签收待入库明细"');
    expect(overview).toContain('subtitle="已完成签收，等待库房入库确认"');
    expect(overview).toContain('items={inboundItems}');
    expect(overview).toContain('mode="inbound"');
    expect(overview).toContain('onOpenItem={openInbound}');
    expect(overview).toContain("nextSearchParams.set('view', 'inbound')");
    expect(overview).toContain(
      "nextSearchParams.set('purchase', item.executionRecordId)",
    );
  });
});
