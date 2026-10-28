import { AccessConfigurationDirectory } from '../../server/common/access/access-configuration.directory';
import { fetchBitableRecords, getTenantAccessToken, resolveBitableAppToken } from '../../server/common/feishu/bitable-direct-read';
jest.mock('../../server/common/feishu/bitable-direct-read', () => ({
  ...jest.requireActual('../../server/common/feishu/bitable-direct-read'), fetchBitableRecords: jest.fn(),
  getTenantAccessToken: jest.fn(), resolveBitableAppToken: jest.fn(),
}));
jest.mock('../../server/common/access/external-employee-directory', () => ({ readExternalEmployeeCredentials: jest.fn(async () => []) }));
jest.mock('../../server/modules/bitable-sync/employee-onboarding.config', () => ({ readEmployeeOnboardingConfig: () => ({ appToken: 'syntheticBase', tableId: 'tblSynthetic', tableName: 'synthetic' }) }));

it('starts independent metadata together, coalesces callers and reuses only the complete snapshot', async () => {
  const prior = process.env.FEISHU_APP_ID;
  process.env.FEISHU_APP_ID = 'cli_directory_performance_synthetic';
  const releases = new Map<string, (value: unknown) => void>();
  const get = jest.fn((url: string) => new Promise(resolve => { releases.set(url, resolve); }));
  try {
    (resolveBitableAppToken as jest.Mock).mockResolvedValue('syntheticBase');
    (getTenantAccessToken as jest.Mock).mockResolvedValue('synthetic-token');
    (fetchBitableRecords as jest.Mock).mockResolvedValue([]);
    const directory = new AccessConfigurationDirectory({ axiosRef: { get } } as never);
    const first = directory.read(), second = directory.read();
    for (let i = 0; i < 10 && releases.size < 3; i++) await Promise.resolve();
    expect(get).toHaveBeenCalledTimes(3);
    expect(fetchBitableRecords).not.toHaveBeenCalled();
    for (const [url, release] of releases) release({ data: { code: 0, data: { has_more: false,
      items: url.endsWith('/fields') ? [{ field_name: '姓名', type: 1 }] : [] } } });
    const [left, right] = await Promise.all([first, second]);
    expect(left).toBe(right);
    expect(await directory.read()).toBe(left);
    expect(get).toHaveBeenCalledTimes(3);
    expect(fetchBitableRecords).toHaveBeenCalledTimes(2);
    for (const [, options] of (fetchBitableRecords as jest.Mock).mock.calls) expect(options).toMatchObject({ strict: true, allowStale: false, forceRefresh: false });
  } finally {
    if (prior === undefined) delete process.env.FEISHU_APP_ID; else process.env.FEISHU_APP_ID = prior;
    jest.clearAllMocks();
  }
});
