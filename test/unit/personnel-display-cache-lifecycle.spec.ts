jest.mock('../../server/common/hotfix-runtime-activation', () => ({
  runHotfixInitialization: jest.fn((_owner: unknown, start: () => Promise<void>) => start()),
  cancelHotfixInitialization: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../server/common/feishu/bitable-direct-read', () => ({
  ...jest.requireActual('../../server/common/feishu/bitable-direct-read'),
  resolveBitableAppToken: jest.fn().mockRejectedValue(new Error('synthetic source offline')),
}));
import { HttpService } from '@nestjs/axios';
import { AccessConfigurationDirectory } from '../../server/common/access/access-configuration.directory';
import { PERSONNEL_DISPLAY_REFRESH_MS } from '../../server/common/access/personnel-display-cache';

const tick = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };

describe('personnel display cache lifecycle isolation', () => {
  const original = { ...process.env };
  beforeEach(() => {
    jest.useFakeTimers();
    // Synthetic values only. The real source reader is mocked to reject, never contacted.
    process.env.FEISHU_APP_ID = 'cli_synthetic_display';
    process.env.FEISHU_APP_SECRET = 'synthetic-not-a-real-credential';
    for (const key of ['FEISHU_EMPLOYEE_ONBOARDING_SOURCE_URL', 'FEISHU_PERSONNEL_MOVEMENT_SOURCE_URL', 'FEISHU_ORG_SOURCE_URL', 'FEISHU_ORGANIZATION_SOURCE_URL']) delete process.env[key];
  });
  afterEach(() => {
    jest.clearAllTimers(); jest.useRealTimers(); jest.restoreAllMocks();
    process.env = { ...original };
  });

  it('does not reject application startup when the display source configuration is invalid', async () => {
    process.env.FEISHU_EMPLOYEE_ONBOARDING_SOURCE_URL = 'not-a-bitable-url';
    const service = new AccessConfigurationDirectory(new HttpService());
    const write = jest.spyOn((service as any).displayCache, 'write');
    await expect(service.onModuleInit()).resolves.toBeUndefined();
    await tick();
    expect(write).not.toHaveBeenCalled();
    await service.onModuleDestroy();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('refreshes in the background every fifteen minutes and stops after destruction', async () => {
    const service = new AccessConfigurationDirectory(new HttpService());
    const read = jest.spyOn(service, 'read').mockResolvedValue({
      appId: 'cli_synthetic_display', people: [], employees: [],
      snapshotAt: Date.now(), personnelComplete: true,
    });
    jest.spyOn((service as any).displayCache, 'write').mockImplementation(() => undefined);
    await service.onModuleInit(); await tick();
    expect(read).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(PERSONNEL_DISPLAY_REFRESH_MS); await tick();
    expect(read).toHaveBeenCalledTimes(2);
    await service.onModuleDestroy();
    jest.advanceTimersByTime(PERSONNEL_DISPLAY_REFRESH_MS); await tick();
    expect(read).toHaveBeenCalledTimes(2);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('never consumes a display-only snapshot when a strict directory read fails', async () => {
    const service = new AccessConfigurationDirectory(new HttpService());
    const displayRead = jest.spyOn((service as any).displayCache, 'read').mockReturnValue({
      schemaVersion: 1, sourceKey: 'synthetic', appId: 'cli_synthetic_display', snapshotAt: Date.now(),
      people: [{ openId: 'ou_previous_person', name: '旧展示人员' }],
    });
    await expect(service.read(true)).rejects.toThrow('synthetic source offline');
    expect(displayRead).not.toHaveBeenCalled();
  });
});
