import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('purchase and supply-chain four-hour hotfix package', () => {
  const script = readFileSync(
    resolve(
      __dirname,
      '../../scripts/create-purchase-supply-chain-hotfix-package.ps1',
    ),
    'utf8',
  );

  it('packages the complete client and only the required compiled server files', () => {
    expect(script).toContain("$clientRelativePath = 'dist/client'");
    for (const runtimeFile of [
      'dist/server/common/access/unified-access.guard.js',
      'dist/server/common/feishu/bitable-direct-read.js',
      'dist/server/modules/bitable-sync/bitable-sync.service.js',
      'dist/server/modules/purchase-inventory/purchase-application.service.js',
      'dist/server/modules/purchase-inventory/purchase-application.validation.js',
      'dist/server/modules/purchase-inventory/purchase-inventory.controller.js',
      'dist/server/modules/purchase-inventory/purchase-inventory.mapper.js',
      'dist/server/modules/purchase-inventory/purchase-inventory.service.js',
      'dist/server/modules/purchase-inventory/purchase-online-approval.service.js',
      'dist/server/modules/purchase-inventory/purchase-access-policy.service.js',
      'dist/server/modules/purchase-inventory/purchase-record-edit.service.js',
      'dist/server/modules/purchase-inventory/purchase-workflow.rules.js',
      'dist/server/modules/purchase-inventory/purchase-workflow-session.js',
      'dist/server/modules/purchase-inventory/purchase-workflow.service.js',
      'dist/server/modules/purchase-inventory/purchase-workflow.store.js',
      'dist/server/modules/contract-management/contract-management.service.js',
      'dist/server/modules/inventory-management/inventory-management.service.js',
      'dist/server/modules/inventory-management/purchase-inbound-confirmation.rules.js',
      'dist/server/modules/inventory-management/purchase-inbound-confirmation.service.js',
      'dist/shared/purchase-inventory.interface.js',
    ]) {
      expect(script).toContain(`'${runtimeFile}'`);
    }
  });

  it('guards the removed approval fields and four-hour runtime markers', () => {
    expect(script).toContain('ConvertFrom-Utf8Base64');
    expect(script).toContain(
      'Mu+4j+KDo+WuoeaJueW3suWujOaIkO+8iOaXoOmcgOeCueWHu++8iQ==',
    );
    expect(script).toContain(
      'Mu+4j+KDo+WuoeaJuemAmui/h++8iOaXoOmcgOeCueWHu++8iQ==',
    );
    expect(script).toContain(
      'Mu+4j+KDo+WuoeaJuemps+Wbnu+8iOaXoOmcgOeCueWHu++8iQ==',
    );
    expect(script).toContain('Assert-CompiledFileExcludes');
    for (const writePath of [
      'purchase-online-approval.service.js',
      'purchase-record-edit.service.js',
      'purchase-workflow.rules.js',
      'purchase-workflow.service.js',
    ]) {
      expect(script).toContain(writePath);
    }
    expect(script).toContain('FEISHU_SUPPLY_CHAIN_SYNC_INTERVAL_MS');
    expect(script).toContain('FEISHU_LOCAL_CACHE_REFRESH_MS');
    expect(script).toContain('14400000');
    expect(script).toContain('purchase-workflow-session.js');
    expect(script).toContain("@('purchase_applicant', 'purchaseBuilding')");
    expect(script).toContain('purchase-workflow.store.js');
    expect(script).toContain('PURCHASE_WORKFLOW_STALE_LOCK_CLEANUP_FAILED');
    expect(script).toContain('startup will continue');
    expect(script).toContain(
      "ConvertFrom-Utf8Base64 '5a6e6ZmF6YeH6LSt5pWw6YeP5b+F6aG75aSn5LqOIDA='",
    );
    expect(script).toContain(
      "ConvertFrom-Utf8Base64 '5LiL5Y2V5a6M5oiQ77yI5b6F562+5pS277yJ'",
    );
    expect(script).toContain(
      "ConvertFrom-Utf8Base64 '5Yiw6LSn5bey562+5pS277yI5b6F5YWl5bqT77yJ'",
    );
    expect(script).toContain('isPurchaseRecordDeleteAdminOnlyException');
  });

  it('writes a checked manifest and excludes secrets and runtime data', () => {
    expect(script).toContain('hotfix-manifest.json');
    expect(script).toContain('Get-FileHash');
    for (const forbidden of [
      '.env',
      'node_modules',
      'data',
      'logs',
      'certs',
      'sourcemaps',
      '.ts',
      '.tsx',
      '.map',
    ]) {
      expect(script).toContain(forbidden);
    }
  });
});
