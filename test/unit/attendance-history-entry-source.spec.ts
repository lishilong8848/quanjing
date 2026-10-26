import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('attendance history entry', () => {
  const source = readFileSync(
    resolve(
      process.cwd(),
      'client/src/components/attendance/TodayAttendanceAnomalyList.tsx',
    ),
    'utf8',
  );

  it('只在主页考勤卡片提供历史查询入口', () => {
    expect(source).toContain(
      "import { AttendanceHistoryDialogButton } from './AttendanceHistoryDialogButton';",
    );
    expect(source).toContain(
      '!compact && (\n              <AttendanceHistoryDialogButton\n                canViewCorrectionEvidence={canViewCorrectionEvidence}',
    );
  });

  it('弹窗提供本地分类筛选、补卡举证入口与打开前预热', () => {
    const dialog = readFileSync(
      resolve(
        process.cwd(),
        'client/src/components/attendance/AttendanceHistoryDialog.tsx',
      ),
      'utf8',
    );
    const button = readFileSync(
      resolve(
        process.cwd(),
        'client/src/components/attendance/AttendanceHistoryDialogButton.tsx',
      ),
      'utf8',
    );
    expect(dialog).toContain("['late', '迟到']");
    expect(dialog).toContain("['early', '早退']");
    expect(dialog).toContain("['missing', '未打卡']");
    expect(dialog).toContain("['corrected', '补卡后正常']");
    expect(dialog).toContain('AttendanceCorrectionEvidenceDialog');
    expect(dialog).toContain('canViewCorrectionEvidence &&');
    expect(dialog).toContain("item.category === 'corrected'");
    expect(button).toContain('canViewCorrectionEvidence');
    expect(dialog).not.toContain('举证未核验');
    expect(button).toContain('prefetchAttendanceHistory');
  });
});
