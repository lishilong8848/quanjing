import { readFileSync } from 'fs';
import { resolve } from 'path';

describe('purchase workflow cutover hotfix package', () => {
  const script = readFileSync(
    resolve(
      __dirname,
      '../../scripts/create-purchase-workflow-hotfix-package.ps1',
    ),
    'utf8',
  );

  it('packages the complete client and only the required compiled server files', () => {
    expect(script).toContain("$clientRelativePath = 'dist/client'");
    for (const runtimeFile of [
      'dist/server/runtime-env.js',
      'dist/server/modules/purchase-inventory/purchase-application.service.js',
      'dist/server/modules/purchase-inventory/purchase-inventory.controller.js',
      'dist/server/modules/purchase-inventory/purchase-inventory.mapper.js',
      'dist/server/modules/purchase-inventory/purchase-workflow.service.js',
    ]) {
      expect(script).toContain(`'${runtimeFile}'`);
    }
    expect(script).toContain('PURCHASE_WORKFLOW_PROGRAM_ENABLED');
    expect(script).toContain('buildPurchaseExecutionFields');
    expect(script).toContain('reconcileProgramCreatedPurchaseRecords');
    expect(script).toContain('hotfix-manifest.json');
    expect(script).toContain('Get-FileHash');
    expect(script).not.toContain('enable-purchase-workflow.ps1');
    expect(script).not.toContain('enable-purchase-workflow.cmd');
    expect(script).not.toContain('ensure-purchase-inventory-config.mjs');
  });

  it('rejects secrets, runtime state, logs, and business data', () => {
    for (const forbidden of [
      '.env',
      'node_modules',
      'data',
      'logs',
      'certs',
      '.runtime',
      'purchase-workflow-ledger.json',
      '.pem',
      '.key',
    ]) {
      expect(script).toContain(forbidden);
    }
  });
});
