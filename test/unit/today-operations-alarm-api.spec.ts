jest.mock(
  '@lark-apaas/client-toolkit/logger',
  () => ({ logger: { error: jest.fn() } }),
  { virtual: true },
);

jest.mock(
  '@lark-apaas/client-toolkit/utils/getAxiosForBackend',
  () => ({ axiosForBackend: jest.fn() }),
  { virtual: true },
);

import { AxiosHeaders, type AxiosResponse } from 'axios';
import { axiosForBackend } from '@lark-apaas/client-toolkit/utils/getAxiosForBackend';
import { getTodayOperationsAlarmDashboard } from '../../client/src/api';

const mockedAxiosForBackend = axiosForBackend as jest.MockedFunction<
  typeof axiosForBackend
>;

describe('today operations alarm dashboard api', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    const response: AxiosResponse<Record<string, unknown>> = {
      data: {},
      status: 200,
      statusText: 'OK',
      headers: new AxiosHeaders(),
      config: { headers: new AxiosHeaders() },
    };
    mockedAxiosForBackend.mockResolvedValue(response);
  });

  it('passes processing and recovery status filters to the dashboard route', async () => {
    await getTodayOperationsAlarmDashboard({
      page: 2,
      pageSize: 5,
      level: '重要',
      processingStatus: '未处理',
      recoveryStatus: '未恢复',
    });

    expect(axiosForBackend).toHaveBeenCalledWith({
      url: '/api/bitable/today-operations-alarms',
      method: 'GET',
      params: {
        page: 2,
        pageSize: 5,
        metric: undefined,
        building: undefined,
        level: '重要',
        status: undefined,
        processingStatus: '未处理',
        recoveryStatus: '未恢复',
        q: undefined,
        tagIssueCode: undefined,
        refresh: undefined,
      },
      headers: undefined,
      timeout: 20_000,
    });
  });

  it('passes a chart drilldown metric together with its building', async () => {
    await getTodayOperationsAlarmDashboard({
      metric: 'yesterdayUnexpected',
      building: 'A楼',
    });

    expect(axiosForBackend).toHaveBeenCalledWith(
      expect.objectContaining({
        url: '/api/bitable/today-operations-alarms',
        params: expect.objectContaining({
          metric: 'yesterdayUnexpected',
          building: 'A楼',
        }),
      }),
    );
  });
});
