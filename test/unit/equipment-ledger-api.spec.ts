jest.mock(
  '@lark-apaas/client-toolkit/utils/getAxiosForBackend',
  () => ({ axiosForBackend: jest.fn() }),
  { virtual: true },
);
import { axiosForBackend } from '@lark-apaas/client-toolkit/utils/getAxiosForBackend';
import {
  getLedgerLifecycleDashboard,
  getEquipmentHistoryDevices,
} from '../../client/src/pages/EquipmentLedgerManagement/api';

describe('equipment workspace API failures', () => {
  beforeEach(() => jest.clearAllMocks());
  it.each([
    [{ response: { status: 403 } }, '无生命周期查看权限'],
    [{ response: { status: 401 } }, '登录已失效，请重新登录'],
    [{ code: 'ECONNABORTED' }, '生命周期读取超时，请重试'],
    [
      new Error('Request failed with status code 503'),
      '生命周期读取失败，请重试',
    ],
  ])(
    'returns actionable business errors for lifecycle failures',
    async (failure, message) => {
      (axiosForBackend as jest.Mock).mockRejectedValueOnce(failure);
      await expect(
        getLedgerLifecycleDashboard({ building: 'A楼' }),
      ).rejects.toThrow(message as string);
    },
  );
  it('rejects malformed lifecycle and repair summaries without presenting success', async () => {
    (axiosForBackend as jest.Mock).mockResolvedValue({ data: {} });
    await expect(getLedgerLifecycleDashboard()).rejects.toThrow(
      '生命周期数据返回异常',
    );
    await expect(
      getEquipmentHistoryDevices(false, new AbortController().signal),
    ).rejects.toThrow('维修设备读取失败');
  });
});
