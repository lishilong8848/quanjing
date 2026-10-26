jest.mock(
  '@/api/personnel-time-insights',
  () => ({ getPersonnelTimeInsights: jest.fn() }),
  { virtual: true },
);
import { getPersonnelTimeInsights } from '@/api/personnel-time-insights';
import { prefetchPersonnelTimeInsights } from '../../client/src/components/personnel-time-insights/use-personnel-time-insights';
import { buildPersonnelTimeInsights } from '../../server/modules/personnel-time-insights/personnel-time-insights.model';

it('首次请求合并，切换请休假和加班复用同范围台账', async () => {
  const range = { from: '2026-10-01', through: '2026-10-11' };
  const data = buildPersonnelTimeInsights({
    ...range,
    overtimeApplications: [],
    overtimeConfirmations: [],
    leaveApplications: [],
  });
  jest.mocked(getPersonnelTimeInsights).mockResolvedValue(data);
  await Promise.all([
    prefetchPersonnelTimeInsights(range),
    prefetchPersonnelTimeInsights(range),
  ]);
  expect(await prefetchPersonnelTimeInsights(range)).toBe(data);
  expect(getPersonnelTimeInsights).toHaveBeenCalledTimes(1);
});
