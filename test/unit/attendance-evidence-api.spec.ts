jest.mock('@lark-apaas/client-toolkit/utils/getAxiosForBackend', () => ({
  axiosForBackend: jest.fn(),
}));
import { axiosForBackend } from '@lark-apaas/client-toolkit/utils/getAxiosForBackend';
import { getTodayAttendanceCorrectionEvidenceImage } from '../../client/src/api/attendance-evidence';
describe('attendance photo proxy API', () => {
  const query = { businessDate: '2026-10-01', entryKey: 'night-off' };
  it('uses the existing authenticated route and passes cancellation', async () => {
    const blob = new Blob(['image'], { type: 'image/png' });
    jest.mocked(axiosForBackend).mockResolvedValue({ data: blob } as never);
    const signal = new AbortController().signal;
    await expect(
      getTodayAttendanceCorrectionEvidenceImage(query, 0, signal),
    ).resolves.toBe(blob);
    expect(axiosForBackend).toHaveBeenLastCalledWith(
      expect.objectContaining({
        url: '/api/attendance/correction-evidence/image',
        params: {
          date: query.businessDate,
          entryKey: query.entryKey,
          index: 0,
        },
        signal,
        responseType: 'blob',
      }),
    );
  });
  it.each([
    new Blob(['error'], { type: 'application/json' }),
    new Blob([], { type: 'image/png' }),
  ])('rejects non-images and empty images', async (blob) => {
    jest.mocked(axiosForBackend).mockResolvedValue({ data: blob } as never);
    await expect(
      getTodayAttendanceCorrectionEvidenceImage(query, 0),
    ).rejects.toThrow('图片内容无效');
  });
  it('preserves authorization failures', async () => {
    const error = { response: { status: 403 } };
    jest.mocked(axiosForBackend).mockRejectedValue(error);
    await expect(
      getTodayAttendanceCorrectionEvidenceImage(query, 0),
    ).rejects.toBe(error);
  });
});
