import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('inventory workflow automation UI', () => {
  const root = process.cwd();

  it('keeps automation available without mounting it from the inventory page', () => {
    const page = readFileSync(
      join(root, 'client/src/pages/InventoryManagement/index.tsx'),
      'utf8',
    );
    const panel = readFileSync(
      join(
        root,
        'client/src/pages/InventoryManagement/WorkflowAutomationPanel.tsx',
      ),
      'utf8',
    );
    const dialog = readFileSync(
      join(
        root,
        'client/src/pages/InventoryManagement/InventoryWorkflowDialog.tsx',
      ),
      'utf8',
    );

    expect(page).not.toContain('secondaryActionLabel="自动化工作流"');
    expect(page).not.toContain('actionLabel="打开多维表"');
    expect(page).not.toContain('InventoryWorkflowDialog');
    expect(page).not.toContain('import { WorkflowAutomationPanel }');
    expect(dialog).toContain('<WorkflowAutomationPanel embedded />');
    expect(dialog).toContain('DialogContent');
    expect(panel).toContain('自动化运行中心');
    expect(panel).toContain('运行自测');
    expect(panel).toContain('最近执行日志');
    expect(panel).toContain('runInventoryWorkflow');
    expect(panel).toContain('runInventoryWorkflowSelfTest');
    expect(panel).toContain('getInventoryWorkflowStatus');
    expect(panel).toContain('aria-live="polite"');
    expect(panel).toContain("? '已转人工'");
    expect(panel).toContain('!workflow.enabled');
  });

  it('blocks manual API runs for the three replaced purchase inbound workflows', () => {
    const controller = readFileSync(
      join(
        root,
        'server/modules/inventory-management/inventory-management.controller.ts',
      ),
      'utf8',
    );

    expect(controller).toContain('PURCHASE_INBOUND_WORKFLOW_CODES.has(code)');
    expect(controller).toContain('采购入库已改为库房人工确认');
  });

  it('uses unified capabilities and limits the destructive Base self-test to administrators', () => {
    const page = readFileSync(
      join(root, 'client/src/pages/InventoryManagement/index.tsx'),
      'utf8',
    );
    const panel = readFileSync(
      join(
        root,
        'client/src/pages/InventoryManagement/WorkflowAutomationPanel.tsx',
      ),
      'utf8',
    );

    expect(page).toContain('useAccess');
    expect(page).toContain('canEdit');
    expect(page).toContain('canForceRefresh');
    expect(panel).toContain('useAccess');
    expect(panel).toContain('canDelete');
    expect(panel).toContain('canEdit');
    expect(panel).toContain('canForceRefresh');
    expect(panel).toContain('if (!canDelete) return');
    expect(panel).toContain('{canDelete && (');
  });
});
