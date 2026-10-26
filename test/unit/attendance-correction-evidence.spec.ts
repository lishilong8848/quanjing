import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getAttendanceCorrectionEvidenceErrorMessage } from '../../client/src/components/attendance/attendance-correction-evidence-error';

describe('attendance correction evidence errors', () => {
  it('distinguishes authentication and authorization failures', () => {
    expect(
      getAttendanceCorrectionEvidenceErrorMessage({
        response: { status: 401 },
      }),
    ).toBe('请先使用飞书授权登录后查看举证图片');
    expect(
      getAttendanceCorrectionEvidenceErrorMessage({
        response: { status: 403 },
      }),
    ).toBe('当前账号无权查看补卡举证');
  });

  it('keeps retryable failures concise without leaking backend details', () => {
    expect(
      getAttendanceCorrectionEvidenceErrorMessage(
        new Error('secret backend detail'),
      ),
    ).toBe('举证图片暂时无法读取');
  });

  it('keeps signed URLs and adds authenticated binary fallback with object URL cleanup', () => {
    const dialog = readFileSync(
      resolve(
        process.cwd(),
        'client/src/components/attendance/AttendanceCorrectionEvidenceDialog.tsx',
      ),
      'utf8',
    );
    const api = readFileSync(
      resolve(process.cwd(), 'client/src/api/attendance-evidence.ts'),
      'utf8',
    );

    expect(dialog).toContain('nextManifest.images');
    expect(dialog).toContain('getTodayAttendanceCorrectionEvidenceImage');
    expect(dialog).toContain('URL.revokeObjectURL');
    expect(api).toContain("url: '/api/attendance/correction-evidence/image'");
  });
});
