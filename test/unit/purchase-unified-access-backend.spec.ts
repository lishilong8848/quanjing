import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const source = (path: string) => readFileSync(resolve(path), 'utf8');

describe('purchase backend unified access migration', () => {
  it('removes legacy password fields and the hard-coded purchase admin helper', () => {
    const contract = source('shared/purchase-inventory.interface.ts');
    const deletion = source(
      'server/modules/purchase-inventory/purchase-record-deletion.service.ts',
    );
    const edit = source(
      'server/modules/purchase-inventory/purchase-record-edit.service.ts',
    );

    expect(contract).not.toMatch(/\b(?:adminPassword|password)\s*\??:/);
    expect(deletion).not.toMatch(/password|purchase-record-admin-auth/i);
    expect(edit).not.toMatch(/password|purchase-record-admin-auth/i);
    expect(
      existsSync(
        resolve(
          'server/modules/purchase-inventory/purchase-application-auth.service.ts',
        ),
      ),
    ).toBe(false);
    expect(
      existsSync(
        resolve(
          'server/modules/purchase-inventory/purchase-record-admin-auth.ts',
        ),
      ),
    ).toBe(false);
  });

  it('uses app identity for trusted edits and requires configured delegated workflow operators', () => {
    const controller = source(
      'server/modules/purchase-inventory/purchase-inventory.controller.ts',
    );
    const edit = source(
      'server/modules/purchase-inventory/purchase-record-edit.service.ts',
    );
    const gateway = source(
      'server/modules/purchase-inventory/purchase-workflow.gateway.ts',
    );
    const workflowSession = source(
      'server/modules/purchase-inventory/purchase-workflow-session.ts',
    );

    expect(edit).toContain('updateSubmissionRecordAsApp');
    expect(edit).toContain('updateExecutionRecordAsApp');
    expect(controller).toContain('resolvePurchaseWorkflowSession');
    expect(workflowSession).toContain(
      'PURCHASE_WORKFLOW_ADMIN_OPERATOR_OPEN_ID',
    );
    expect(workflowSession).toContain(
      'PURCHASE_WORKFLOW_EDITOR_OPERATOR_OPEN_ID',
    );
    expect(workflowSession).toContain('ServiceUnavailableException');
    expect(gateway).toContain('getTenantAccessTokenAsApp');
  });
});
