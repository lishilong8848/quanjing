import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function read(relativePath: string): string {
  return readFileSync(resolve(relativePath), 'utf8');
}

describe('purchase record edit UI', () => {
  it('opens one shared edit dialog from anomalies and both active lists', () => {
    const overview = read(
      'client/src/pages/PurchaseInventoryManagement/PurchaseOverviewPage.tsx',
    );

    expect(overview).toContain('setEditingRecord({');
    expect(overview).toContain('onEditItem');
    expect(overview).toContain('<PurchaseRecordEditDialog');
    expect(overview).toContain('onSaved={refreshDashboardAfterMutation}');
  });

  it('submits the Feishu update before waiting for the refreshed dashboard', () => {
    const dialog = read(
      'client/src/pages/PurchaseInventoryManagement/PurchaseAnomalyEditDialog.tsx',
    );
    const overview = read(
      'client/src/pages/PurchaseInventoryManagement/PurchaseOverviewPage.tsx',
    );

    expect(dialog).toContain('onSaved: () => Promise<boolean>');
    expect(dialog).toContain('createPurchaseRecordSubmissionGate');
    expect(dialog).toContain('resolvePurchaseRecordRefresh');
    expect(dialog).toMatch(
      /if\s*\(!submissionGate\.tryStart\(\)\)\s*\{\s*return;/,
    );
    expect(dialog).toContain('submissionGate.finish();');
    expect(dialog).toContain(
      'const pageRefreshed = await resolvePurchaseRecordRefresh(onSaved);',
    );
    expect(dialog).toContain("{saving ? '提交中' : '提交'}");
    expect(dialog).toContain('提交成功，已同步飞书多维表并刷新页面');
    expect(dialog).toContain(
      '提交成功，飞书多维表已同步，但页面刷新失败，请点击“重新加载”',
    );
    expect(dialog).toContain("apiError(saveError, '提交失败，请稍后重试')");
    expect(dialog).toContain('请至少修改一项采购数据后再提交');
    expect(overview).toContain(
      'async function refreshDashboardAfterMutation(): Promise<boolean>',
    );
    expect(overview).toContain('return loadDashboard(true);');
    expect(overview).toContain('onSaved={refreshDashboardAfterMutation}');
  });

  it('allows unified editors and administrators to update fields without legacy password gates', () => {
    const dialog = read(
      'client/src/pages/PurchaseInventoryManagement/PurchaseAnomalyEditDialog.tsx',
    );

    expect(dialog).toContain('异常原因');
    expect(dialog).toContain('PurchaseInventoryRequestItem');
    expect(dialog).toContain('issues?: string[]');
    expect(dialog).toContain('searchPurchaseApplicationApplicants');
    expect(dialog).toContain('updatePurchaseInventoryRecord');
    expect(dialog).toContain('useAccess');
    expect(dialog).toContain('canEditPurchaseRecord');
    expect(dialog).toContain('buildPurchaseRecordChangedFields');
    expect(dialog).toContain('PurchasePrincipalRequestGate');
    expect(dialog).toContain('principalRequestGate.isCurrent(requestToken)');
    expect(dialog).toContain("principal.role === 'purchase_applicant'");
    expect(dialog).toContain("{principal.role === 'admin' ? (");
    expect(dialog).toMatch(/updateDraft\(\s*'status'/);
    expect(dialog).not.toContain('getPurchaseApplicationAuthStatus');
    expect(dialog).not.toContain('getPurchaseApplicationLoginUrl');
    expect(dialog).not.toContain('isPurchaseAdmin');
    expect(dialog).not.toContain('adminPassword');
    expect(dialog).not.toContain('本地管理员密码');
    expect(dialog).not.toContain('type="password"');
    expect(dialog).toContain('状态回退会清除后续节点');
    expect(dialog).toContain('同步飞书多维表');
    expect(dialog).toContain('max-h-[calc(100dvh-2rem)]');
    expect(dialog).toContain('grid-rows-[auto_minmax(0,1fr)_auto]');
    expect(dialog).toContain('max-sm:h-[calc(100dvh-2rem)]');
  });

  it('registers a PATCH route whose authorization is handled by the global access guard', () => {
    const controller = read(
      'server/modules/purchase-inventory/purchase-inventory.controller.ts',
    );

    expect(controller).toContain("@Patch('records/:recordId')");
    expect(controller).toContain('recordEditService.updateRecord');
  });

  it('constrains mobile record cards so row actions are not clipped', () => {
    const overview = read(
      'client/src/pages/PurchaseInventoryManagement/PurchaseOverviewPage.tsx',
    );

    expect(overview).toContain(
      "'min-w-0 w-full rounded-lg border bg-white p-4",
    );
    expect(overview).not.toContain('canOpenWorkflow');
    expect(overview).not.toContain("'cursor-pointer");
  });
});
