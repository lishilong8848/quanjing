import { readFileSync } from 'fs';
import { resolve } from 'path';

describe('purchase dashboard server sync hotfix package', () => {
  const script = readFileSync(
    resolve(
      __dirname,
      '../../scripts/create-purchase-dashboard-sync-hotfix-package.ps1',
    ),
    'utf8',
  );

  it('packages the complete compiled purchase server module without the client', () => {
    expect(script).toContain(
      "$serverModuleRelativePath = 'dist/server/modules/purchase-inventory'",
    );
    expect(script).toContain("-Filter '*.js'");
    expect(script).toContain(
      "'dist/server/common/feishu/bitable-direct-read.js'",
    );
    for (const runtimeFile of [
      'dist/shared/access-control.interface.js',
      'dist/shared/purchase-application.interface.js',
      'dist/shared/purchase-inventory.interface.js',
      'dist/shared/purchase-workflow.interface.js',
    ]) {
      expect(script).toContain(`'${runtimeFile}'`);
    }
    expect(script).not.toContain("$clientRelativePath = 'dist/client'");
  });

  it('guards the execution-table-only dashboard contract', () => {
    expect(script).toContain('submissions: sourceSections.executions');
    expect(script).toContain('submissions: []');
    expect(script).toContain('FEISHU_PURCHASE_SUBMISSION_TABLE_ID');
    expect(script).toContain('Assert-CompiledFileExcludes');
    expect(script).toContain('createBitableBackgroundRefresh');
    expect(script).toContain('purchase-workflow-receipt-task.service.js');
  });

  it('writes a manifest and rejects secrets, source, logs, and business data', () => {
    expect(script).toContain('hotfix-manifest.json');
    expect(script).toContain('Get-FileHash');
    for (const forbidden of [
      '.env',
      'node_modules',
      'data',
      'logs',
      'certs',
      '.runtime',
      '.ts',
      '.tsx',
    ]) {
      expect(script).toContain(forbidden);
    }
  });
});
