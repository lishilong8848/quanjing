import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

describe('MBTI production entry', () => {
  it('has a shareable guest page and production server endpoints', () => {
    expect(read('client/src/app.tsx')).toContain('path="/mbti-assessment"');
    expect(read('client/src/access/access-policy.ts')).toContain("'/mbti-assessment'");
    expect(read('client/src/navigation/page-switcher.ts')).not.toContain("key: 'mbti-assessment'");
    expect(read('client/src/pages/MonthlySchedule/index.tsx')).toContain("onSelect={() => navigate('/mbti-assessment')}");
    expect(read('server/modules/bitable-sync/bitable-sync.module.ts')).toContain('MbtiAssessmentController');
    expect(read('server/modules/bitable-sync/mbti-assessment.controller.ts')).toContain("@Post('submit')");
  });

  it('includes the supplied bank in runtime source', () => {
    expect(existsSync(resolve(root, 'shared/mbti-attached-bank.json'))).toBe(true);
    expect(existsSync(resolve(root, 'shared/mbti-attached-bank-model.ts'))).toBe(true);
    expect(read('client/src/pages/MonthlySchedule/NewEmployeeOnboardingDialog.tsx')).toContain('开始 MBTI 测试');
  });
});
