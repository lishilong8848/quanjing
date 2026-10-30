jest.mock('@lark-apaas/client-toolkit/utils/getAxiosForBackend', () => ({
  axiosForBackend: jest.fn(),
}));
jest.mock('@lark-apaas/client-toolkit/logger', () => ({ logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } }));
import { axiosForBackend } from '@lark-apaas/client-toolkit/utils/getAxiosForBackend';
import { getTodayAttendanceSnapshot } from '../../client/src/api';

describe('attendance snapshot display request budget', () => {
  const http = axiosForBackend as jest.Mock;
  const snapshot = { date: '2026-10-30', sourceStatus: 'fresh', runStatus: { state: 'completed', executionId: 'synthetic-existing-run' } };

  beforeEach(() => { jest.useFakeTimers(); http.mockReset(); });
  afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

  // Emulate the transport deadline against a slow but successful source read.
  function delayedResponse(delayMs: number, data = snapshot) {
    http.mockImplementation(({ timeout }) => new Promise((resolve, reject) => {
      const deadline = setTimeout(() => { clearTimeout(source); reject(new Error('transport deadline exceeded')); }, timeout);
      const source = setTimeout(() => { clearTimeout(deadline); resolve({ data }); }, delayMs);
    }));
  }

  it.each([20_000, 45_000])('keeps a verified %i ms source read alive', async delayMs => {
    delayedResponse(delayMs);
    const result = expect(getTodayAttendanceSnapshot()).resolves.toBe(snapshot);
    await jest.advanceTimersByTimeAsync(delayMs);
    await result;
    expect(http).toHaveBeenCalledTimes(1);
    expect(http).toHaveBeenCalledWith(expect.objectContaining({ url: '/api/attendance/today', method: 'GET', params: undefined }));
  });

  it('receives the server display fallback before the transport deadline without retrying a business action', async () => {
    const stale = { ...snapshot, sourceStatus: 'stale' };
    delayedResponse(50_000, stale);
    const result = expect(getTodayAttendanceSnapshot(true)).resolves.toBe(stale);
    await jest.advanceTimersByTimeAsync(50_000);
    await result;
    expect(http).toHaveBeenCalledTimes(1);
    expect(http).toHaveBeenCalledWith(expect.objectContaining({ method: 'GET', params: { refresh: '1' } }));
  });

  it('still stops an unresponsive connection and preserves authorization errors', async () => {
    delayedResponse(61_000);
    const result = expect(getTodayAttendanceSnapshot()).rejects.toThrow('transport deadline exceeded');
    await jest.advanceTimersByTimeAsync(60_000);
    await result;
    const denied = { response: { status: 403 } };
    http.mockRejectedValueOnce(denied);
    await expect(getTodayAttendanceSnapshot()).rejects.toBe(denied);
  });
});
