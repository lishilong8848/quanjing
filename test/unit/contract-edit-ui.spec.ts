import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('contract information iteration UI', () => {
  it('loads, validates and saves editable contract information before refreshing', () => {
    const dialogPath = resolve(
      'client/src/pages/ContractManagement/ContractEditDialog.tsx',
    );

    expect(existsSync(dialogPath)).toBe(true);
    if (!existsSync(dialogPath)) return;
    const dialogSource = readFileSync(dialogPath, 'utf8');
    const pageSource = readFileSync(
      resolve('client/src/pages/ContractManagement/index.tsx'),
      'utf8',
    );

    expect(dialogSource).toContain('getContractEditOptions');
    expect(dialogSource).toContain('updateContractInformation');
    expect(dialogSource).toContain('validateContractEditDraft');
    expect(dialogSource).toContain('合同信息迭代');
    expect(dialogSource).toContain('正在读取合同当前信息');
    expect(dialogSource).toContain('正在同步至多维表');
    expect(dialogSource).toMatch(
      /toast\.success\(response\.message\);\s*onOpenChange\(false\);\s*void Promise\.resolve\(onCompleted\(\)\)\.catch\(/,
    );
    expect(dialogSource).not.toContain('await onCompleted()');
    expect(dialogSource).toContain('buildContractEditRequest(draft, options)');
    expect(dialogSource).toContain('合同信息未发生变化');
    expect(pageSource).toContain(
      "import { useAccess } from '@/access/AccessProvider';",
    );
    expect(pageSource).toContain('canManageContracts');
    expect(pageSource).toContain('迭代合同信息');
  });
});
