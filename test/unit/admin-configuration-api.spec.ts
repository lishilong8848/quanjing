jest.mock('@lark-apaas/client-toolkit/utils/getAxiosForBackend', () => ({ axiosForBackend: jest.fn() }));
import { axiosForBackend } from '@lark-apaas/client-toolkit/utils/getAxiosForBackend';
import { loadConfiguration, saveAccount, saveCardRole } from '../../client/src/pages/SystemConfiguration/api';
import type { AccountMutation } from '../../shared/access-configuration.interface';

describe('configuration request recovery', () => {
  const request = axiosForBackend as jest.Mock;
  const mutation: AccountMutation = { clientMutationId: 'api-retry-mutation-001', expectedRevision: 2, kind: 'feishu', name: '合成人员', openId: 'ou_synthetic', role: 'editor', building: null, enabled: true };
  beforeEach(() => request.mockReset());
  it('keeps an ambiguous timeout visible and retries with the same mutation identity', async () => {
    request.mockRejectedValueOnce({ code: 'ECONNABORTED' });
    await expect(saveAccount(mutation)).rejects.toThrow('保存结果未确认');
    request.mockResolvedValueOnce({ status: 200, data: { revision: 3 } });
    await expect(saveAccount(mutation)).resolves.toEqual({ revision: 3 });
    expect(request.mock.calls[0][0]).toEqual(request.mock.calls[1][0]);
    expect(request.mock.calls[0][0]).toMatchObject({ method: 'POST', timeout: 15000, data: mutation });
  });
  it('does not turn an offline read into an empty successful configuration', async () => {
    request.mockRejectedValueOnce(new Error('Network Error'));
    await expect(loadConfiguration()).rejects.toThrow('请求失败，请检查网络后重试');
  });
  it.each([
    [400, '请求包含服务端不支持的字段，请确认页面与服务端版本一致后重试'],
    [409, '配置已更新，请刷新当前记录后重试，草稿已保留'],
  ])('preserves HTTP %i status/message and the caller draft for retry', async (status, message) => {
    const before = JSON.stringify(mutation);
    request.mockRejectedValueOnce({ response: { status, data: { message } } });
    await expect(saveAccount(mutation)).rejects.toMatchObject({ message, status });
    expect(JSON.stringify(mutation)).toBe(before);
    expect(mutation.expectedRevision).toBe(2);
    expect(mutation.name).toBe('合成人员');
  });
  it('does not report success when a card configuration request returns a failed HTTP status', async () => {
    request.mockResolvedValueOnce({ status: 503, data: {} });
    await expect(saveCardRole({ clientMutationId: 'api-card-mutation-001', expectedRevision: 2, code: 'contract_notify', building: null, members: [] })).rejects.toThrow();
  });
  it('reports read timeouts accurately', async () => {
    request.mockRejectedValueOnce({ code: 'ECONNABORTED' });
    await expect(loadConfiguration()).rejects.toThrow('读取超时');
    expect(request.mock.calls[0][0]).toMatchObject({ url: '/api/access/configuration', method: 'GET' });
  });
});
