const mockRead = jest.fn();
jest.mock('@lark-apaas/client-toolkit/utils/getAxiosForBackend', () => ({ axiosForBackend: (...args: unknown[]) => mockRead(...args) }));
import { readSelfServiceSchedules } from '../../client/src/pages/MonthlySchedule/self-service-schedule-reader';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const valid = (schedules: unknown[] = []) => ({ scope: 'self', applicantName: '合成人员甲', range: { startDate: '2026-12-01', endDate: '2026-12-31' }, complete: true, schedules });
beforeEach(() => mockRead.mockReset());
it('reads only the authenticated self endpoint and accepts a genuine rest month', async () => {
  mockRead.mockResolvedValue({ data: valid() });
  expect((await readSelfServiceSchedules(2026, 12)).schedules).toEqual([]);
  const request = mockRead.mock.calls[0][0];
  expect(request).toEqual({ url: '/api/self-service-schedules/2026/12', method: 'GET', timeout: 15000 });
  expect(request.params).toBeUndefined();
});
it('does not invent an applicant when the server has not verified one', async () => {
  mockRead.mockResolvedValue({ data: { ...valid(), applicantName: '' } });
  await expect(readSelfServiceSchedules(2026, 12)).rejects.toThrow('不完整');
});
it('rejects another month or a partial source response', async () => {
  mockRead.mockResolvedValueOnce({ data: { ...valid(), range: { startDate: '2026-11-01', endDate: '2026-11-30' } } });
  await expect(readSelfServiceSchedules(2026, 12)).rejects.toThrow('不完整');
  mockRead.mockResolvedValueOnce({ data: { ...valid(), complete: false } });
  await expect(readSelfServiceSchedules(2026, 12)).rejects.toThrow('不完整');
});
it('does not convert source failure or denied identity into an empty successful month', async () => {
  for (const status of [403, 503]) {
    const error = { response: { status } };
    mockRead.mockRejectedValueOnce(error);
    await expect(readSelfServiceSchedules(2026, 12)).rejects.toBe(error);
  }
});
it('uses UTC month bounds across the year boundary', async () => {
  mockRead.mockResolvedValue({ data: { ...valid(), range: { startDate: '2027-01-01', endDate: '2027-01-31' } } });
  await expect(readSelfServiceSchedules(2027, 1)).resolves.toMatchObject({ scope: 'self', complete: true });
});

describe('the actual public work-calendar effect', () => {
  const filename = path.resolve(__dirname, '../../client/src/pages/MonthlySchedule/index.tsx');
  const source = ts.createSourceFile(filename, fs.readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const calendarEffects: ts.ArrowFunction[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'useEffect') {
      const callback = node.arguments[0];
      if (callback && ts.isArrowFunction(callback) && callback.body.getText(source).includes('void getChinaWorkCalendar()')) calendarEffects.push(callback);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  const calendarEffect = calendarEffects[0];
  if (!calendarEffect) throw new Error('Work calendar effect was not found');
  const run = new Function('canReadMonthlySchedule', 'selfServiceOnly', 'getChinaWorkCalendar', 'installChinaWorkCalendarSnapshot', 'setWorkCalendarRevision', 'logger', `return (${calendarEffect.getText(source)})();`) as (...args: unknown[]) => undefined | (() => void);

  it.each<[boolean, boolean, number]>([
    [true, false, 1],
    [false, true, 1],
    [false, false, 0],
  ])('full-read=%s self-only=%s makes %s public calendar reads', async (fullRead, selfOnly, expected) => {
    const read = jest.fn().mockResolvedValue({ snapshot: { synthetic: true } });
    const install = jest.fn().mockReturnValue(true);
    const cleanup = run(fullRead, selfOnly, read, install, jest.fn(), { warn: jest.fn() });
    await Promise.resolve();
    expect(read).toHaveBeenCalledTimes(expected);
    expect(install).toHaveBeenCalledTimes(expected);
    cleanup?.();
  });
});
