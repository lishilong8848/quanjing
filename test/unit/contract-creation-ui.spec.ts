import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('contract creation secondary page source contract', () => {
  const root = resolve(__dirname, '../..');
  const pageSource = readFileSync(
    resolve(root, 'client/src/pages/ContractManagement/index.tsx'),
    'utf8',
  );
  const headerSource = readFileSync(
    resolve(
      root,
      'client/src/pages/PurchaseInventoryManagement/ManagementHeader.tsx',
    ),
    'utf8',
  );
  const dialogSource = readFileSync(
    resolve(
      root,
      'client/src/pages/ContractManagement/ContractCreationDialog.tsx',
    ),
    'utf8',
  );
  const workflowPanelSource = readFileSync(
    resolve(
      root,
      'client/src/pages/ContractManagement/ContractWorkflowPanel.tsx',
    ),
    'utf8',
  );

  it('keeps the contract actions while omitting obsolete source shortcuts', () => {
    const headerStart = pageSource.indexOf('<ManagementHeader');
    const mainStart = pageSource.indexOf('<main', headerStart);

    expect(headerStart).toBeGreaterThanOrEqual(0);
    expect(mainStart).toBeGreaterThan(headerStart);
    const commandHeaderSource = pageSource.slice(headerStart, mainStart);
    const actionsStart = commandHeaderSource.indexOf('actions=');

    expect(commandHeaderSource).toContain('activePage="contract"');
    expect(commandHeaderSource).toContain('updatedAt=');
    expect(commandHeaderSource).toContain('filterLabel=');
    expect(commandHeaderSource).toContain('onFilter=');
    expect(commandHeaderSource).not.toContain('sourceLabel=');
    expect(commandHeaderSource).not.toContain(
      '飞书多维表 · 框架合同、执行合同、供应商与付款计划',
    );
    expect(actionsStart).toBeGreaterThanOrEqual(0);
    expect(commandHeaderSource).not.toContain('打开合同台账');
    expect(commandHeaderSource.indexOf('新增合同')).toBeGreaterThan(
      actionsStart,
    );
    expect(commandHeaderSource).not.toContain('window.open(sourceUrl');
    expect(commandHeaderSource).toContain('setCreationOpen(true)');
    expect(pageSource).not.toContain('aria-label="合同一览页面操作"');
    expect(pageSource).not.toContain('合同执行工作流');
    expect(pageSource).not.toContain('<ContractWorkflowPanel');
    expect(workflowPanelSource).toContain('合同执行工作流');
    expect(workflowPanelSource).toContain('手动执行');
    expect(pageSource).toContain('ContractCreationDialog');
    expect(headerSource).toContain('actions?: ReactNode;');
    expect(headerSource).toContain('sourceLabel?: string;');
    expect(headerSource).toContain('数据更新时间：{updatedAt}');
    expect(headerSource).toMatch(
      /\{sourceLabel\s*\?\s*\([\s\S]*title=\{sourceLabel\}[\s\S]*\)\s*:\s*null\}/,
    );
    expect(headerSource).not.toContain('tertiaryActionLabel');
  });

  it('contains the required conditional and secure upload interactions', () => {
    expect(dialogSource).toContain('框架合同');
    expect(dialogSource).toContain('执行合同');
    expect(dialogSource).toContain('是否关联框架合同');
    expect(dialogSource).toContain('新增供应商');
    expect(dialogSource).toContain('付款计划');
    expect(dialogSource).toContain('计划付款日期');
    expect(dialogSource).toContain('新增付款节点');
    expect(dialogSource).toContain('删除付款节点');
    expect(dialogSource).toContain('draft.paymentPlans');
    expect(dialogSource).not.toContain('付款与合同差异核验时间');
    expect(dialogSource).toContain('accept="application/pdf,.pdf"');
    expect(dialogSource).not.toContain('getContractAdminStatus');
    expect(dialogSource).not.toContain('loginContractAdmin');
    expect(dialogSource).not.toContain('合同管理员口令');
    expect(dialogSource).not.toContain('type="password"');
    expect(dialogSource).toContain('创建成功');
    expect(dialogSource).toContain('createFixedContractOptions');
    expect(dialogSource).toContain('可先填写其他字段');
    expect(dialogSource).not.toContain('正在读取对应多维表字段');
    expect(dialogSource).not.toContain('多维表字段读取失败');
    expect(dialogSource).toContain('动态选项同步失败');
    expect(dialogSource).toContain('createLatestRequestCoordinator');
    expect(dialogSource).toContain('dynamicOptionsReady');
    expect(dialogSource).toContain('submitting || !dynamicOptionsReady');
    expect(dialogSource).toContain(
      "toast.warning('合同已创建，但看板刷新失败，请手动刷新')",
    );
    expect(dialogSource).toMatch(
      /setResult\(response\);\s*void Promise\.resolve\(onCreated\(\)\)\.catch\(/,
    );
    expect(dialogSource).not.toContain('await onCreated()');
    expect(workflowPanelSource).toMatch(
      /setFeedback\(result\.message\);\s*void loadStatus\(\)\.catch\(/,
    );
    expect(workflowPanelSource).not.toContain('await loadStatus();');
    expect(workflowPanelSource).toContain(
      "from '@/components/ui/alert-dialog'",
    );
    expect(workflowPanelSource).toContain('<AlertDialog');
    expect(workflowPanelSource).not.toContain('window.confirm');
  });

  it('prefetches deduplicated dialog options after the dashboard loads', () => {
    expect(pageSource).toContain('getContractCreateOptions');
    expect(pageSource).toContain('getContractPaymentFollowUpOptions');
    expect(pageSource).toContain('Promise.allSettled');
    expect(pageSource).toContain('new Set');
    expect(pageSource).toContain('.slice(0, 12)');
  });
});
