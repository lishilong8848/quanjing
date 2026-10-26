import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('purchase workflow center UI', () => {
  it('keeps the create action in the command header without mounting the workflow center', () => {
    const pageSource = readFileSync(
      resolve(
        'client/src/pages/PurchaseInventoryManagement/PurchaseOverviewPage.tsx',
      ),
      'utf8',
    );
    const headerStart = pageSource.indexOf('<ManagementHeader');
    const headerEnd = pageSource.indexOf('<main', headerStart);

    expect(headerStart).toBeGreaterThanOrEqual(0);
    expect(headerEnd).toBeGreaterThan(headerStart);
    const headerSource = pageSource.slice(headerStart, headerEnd);

    expect(headerSource).toContain('actions=');
    expect(headerSource).toContain('新建采购申请');
    expect(pageSource).not.toContain('aria-label="采购总览页面操作"');
    expect(pageSource).not.toContain('secondaryActionLabel="采购工作流"');
    expect(pageSource).not.toContain('<PurchaseWorkflowCenterDialog');
    expect(pageSource).toContain('<PurchaseWorkflowDialog');
    expect(pageSource).toContain('canReceivePurchaseRecord');
    expect(pageSource).toContain('onReceiveItem={requestReceipt}');
  });

  it('renders a centered, viewport-bound center with live queues', () => {
    const centerSource = readFileSync(
      resolve(
        'client/src/pages/PurchaseInventoryManagement/PurchaseWorkflowCenterDialog.tsx',
      ),
      'utf8',
    );

    expect(centerSource).toContain('采购工作流');
    expect(centerSource).toContain('fixed inset-0');
    expect(centerSource).toContain('items-center justify-center');
    expect(centerSource).toContain('max-h-[calc(100dvh-2rem)]');
    expect(centerSource).toContain('dashboard?.requests');
    expect(centerSource).toContain('purchaseWorkflowCenterGroups');
    expect(centerSource).toContain('onOpenRecord');
    expect(centerSource).toContain('并行保护');
  });
});
