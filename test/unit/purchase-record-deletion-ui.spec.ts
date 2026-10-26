import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function read(relativePath: string): string {
  return readFileSync(resolve(relativePath), 'utf8');
}

describe('purchase record deletion UI', () => {
  it('supports row selection and current-page selection in active purchase lists', () => {
    const source = read(
      'client/src/pages/PurchaseInventoryManagement/PurchaseOverviewPage.tsx',
    );

    expect(source).toContain('<Checkbox');
    expect(source).toContain('toggleVisiblePurchaseSelection');
    expect(source).toContain('onDeleteSelected');
    expect(source).toContain('onDeleteItem');
    expect(source).toContain('aria-label={`删除');
    expect(source).toContain('<PurchaseDeleteDialog');
    expect(source).toContain('useAccess');
    expect(source).toContain('canDeletePurchaseRecord');
    expect(source).toContain('requestDeletion');
  });

  it('supports direct deletion from anomaly cards and stops row navigation', () => {
    const source = read(
      'client/src/pages/PurchaseInventoryManagement/PurchaseOverviewPage.tsx',
    );

    expect(source).toContain('onDeleteAnomaly');
    expect(source).toContain(
      'onDeleteItem={(item) => requestDeletion([item])}',
    );
    expect(source).toContain('event.stopPropagation()');
  });

  it('removes successful deletions immediately and filters stale dashboard responses', () => {
    const source = read(
      'client/src/pages/PurchaseInventoryManagement/PurchaseOverviewPage.tsx',
    );

    expect(source).toContain('deletedRequestIdsRef');
    expect(source).toContain('removeDeletedPurchaseRequests(');
    expect(source).toContain('handleRecordsDeleted');
  });

  it('supports selecting and batch deleting purchase anomalies', () => {
    const source = read(
      'client/src/pages/PurchaseInventoryManagement/PurchaseOverviewPage.tsx',
    );

    expect(source).toContain('aria-label="选择全部采购异常"');
    expect(source).toContain('aria-label={`选择异常');
    expect(source).toContain('toggleAllAnomalies');
    expect(source).toContain('删除所选（{selectedItems.length}）');
  });

  it('supports deleting selected completed purchase records', () => {
    const dialogSource = read(
      'client/src/pages/PurchaseInventoryManagement/PurchaseCompletionAnalysisDialog.tsx',
    );
    const overviewSource = read(
      'client/src/pages/PurchaseInventoryManagement/PurchaseOverviewPage.tsx',
    );

    expect(dialogSource).toContain('onDeleteSelected');
    expect(dialogSource).toContain('canDelete');
    expect(dialogSource).toContain('<Checkbox');
    expect(dialogSource).toContain('删除所选');
    expect(overviewSource).toContain('canDeleteCompletedPurchaseRecords');
    expect(overviewSource).toContain(
      'const canDeleteCompletedRecords = canDeleteCompletedPurchaseRecords(principal);',
    );
  });

  it('uses the unified administrator capability before calling the protected batch-delete API', () => {
    const source = read(
      'client/src/pages/PurchaseInventoryManagement/PurchaseDeleteDialog.tsx',
    );
    const apiSource = read('client/src/api/index.ts');

    expect(source).toContain('useAccess');
    expect(source).toContain('items.every((item) =>');
    expect(source).toContain('canDeletePurchaseRecord(principal, item)');
    expect(source).toContain('deletePurchaseInventoryRecords');
    expect(source).toContain('PurchasePrincipalRequestGate');
    expect(source).toContain('principalRequestGate.isCurrent(requestToken)');
    expect(source).toContain('此操作不可撤销');
    expect(source).not.toMatch(/\bpassword\b|删除密码|密码错误/);
    expect(apiSource).not.toContain('密码错误或飞书删除权限不足');
  });
});
