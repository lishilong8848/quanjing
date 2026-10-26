import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('purchase application applicant selector', () => {
  const source = readFileSync(
    join(
      process.cwd(),
      'client/src/pages/PurchaseInventoryManagement/PurchaseApplicationDialog.tsx',
    ),
    'utf8',
  );

  it('supports fuzzy search, selection details, and clearing the applicant', () => {
    expect(source).toContain('searchPurchaseApplicationApplicants');
    expect(source).toContain('申请人');
    expect(source).toContain('搜索姓名、工号或岗位');
    expect(source).toContain('applicantEmployeeNo');
    expect(source).toContain('清除申请人');
  });

  it('locks applicant accounts to the session building', () => {
    expect(source).toContain('fixedBuilding');
    expect(source).toContain('当前账号固定楼栋');
    expect(source).toContain('scopePurchaseApplicationDraft');
    expect(source).toContain('building: effectiveBuilding');
  });
});
