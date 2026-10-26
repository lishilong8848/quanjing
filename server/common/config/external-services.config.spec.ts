import {
  getEffectiveFeishuAppCredentials,
  getFeishuAuthPayload,
  getFeishuCardActionConsumerProfile,
  readEnv,
} from './external-services.config';

const MANAGED_ENV_KEYS = [
  'FEISHU_APP_ID',
  'FEISHU_APP_SECRET',
  'FEISHU_CARD_ACTION_CONSUMER_PROFILE',
  'FEISHU_CARD_ACTION_TEST_APP_ID',
  'FEISHU_CARD_ACTION_TEST_APP_SECRET',
] as const;

describe('Feishu card callback runtime profile', () => {
  const originalValues = new Map<string, string | undefined>();

  beforeAll(() => {
    for (const key of MANAGED_ENV_KEYS) {
      originalValues.set(key, process.env[key]);
    }
  });

  beforeEach(() => {
    for (const key of MANAGED_ENV_KEYS) delete process.env[key];
  });

  afterAll(() => {
    for (const key of MANAGED_ENV_KEYS) {
      const value = originalValues.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it.each([
    [' production ', 'production'],
    ['LOCAL-TEST', 'local-test'],
    ['disabled', 'disabled'],
    [undefined, null],
  ])('normalizes profile %s to %s', (configured, expected) => {
    if (configured !== undefined) {
      process.env.FEISHU_CARD_ACTION_CONSUMER_PROFILE = configured;
    }

    expect(getFeishuCardActionConsumerProfile()).toBe(expected);
  });

  it('rejects an unknown profile instead of falling back to production', () => {
    process.env.FEISHU_CARD_ACTION_CONSUMER_PROFILE = 'development';

    expect(() => getFeishuCardActionConsumerProfile()).toThrow(
      /production.*local-test.*disabled/u,
    );
  });

  it('uses the existing application outside local-test mode', () => {
    process.env.FEISHU_CARD_ACTION_CONSUMER_PROFILE = 'production';
    process.env.FEISHU_APP_ID = 'cli_production_app';
    process.env.FEISHU_APP_SECRET = 'production-secret';

    expect(getEffectiveFeishuAppCredentials()).toEqual({
      appId: 'cli_production_app',
      appSecret: 'production-secret',
    });
    expect(getFeishuAuthPayload()).toEqual({
      app_id: 'cli_production_app',
      app_secret: 'production-secret',
    });
  });

  it('redirects all generic Feishu credentials to the isolated test application', () => {
    process.env.FEISHU_CARD_ACTION_CONSUMER_PROFILE = 'local-test';
    process.env.FEISHU_APP_ID = 'cli_production_app';
    process.env.FEISHU_APP_SECRET = 'production-secret';
    process.env.FEISHU_CARD_ACTION_TEST_APP_ID = 'cli_local_test_app';
    process.env.FEISHU_CARD_ACTION_TEST_APP_SECRET = 'local-test-secret';

    expect(getEffectiveFeishuAppCredentials()).toEqual({
      appId: 'cli_local_test_app',
      appSecret: 'local-test-secret',
    });
    expect(readEnv('FEISHU_APP_ID')).toBe('cli_local_test_app');
    expect(readEnv('FEISHU_APP_SECRET')).toBe('local-test-secret');
    expect(getFeishuAuthPayload()).toEqual({
      app_id: 'cli_local_test_app',
      app_secret: 'local-test-secret',
    });
  });

  it('fails closed when local-test credentials are incomplete', () => {
    process.env.FEISHU_CARD_ACTION_CONSUMER_PROFILE = 'local-test';
    process.env.FEISHU_APP_ID = 'cli_production_app';
    process.env.FEISHU_CARD_ACTION_TEST_APP_ID = 'cli_local_test_app';

    expect(() => getEffectiveFeishuAppCredentials()).toThrow(
      /FEISHU_CARD_ACTION_TEST_APP_ID.*FEISHU_CARD_ACTION_TEST_APP_SECRET/u,
    );
  });

  it('requires the production application ID as an isolation comparison', () => {
    process.env.FEISHU_CARD_ACTION_CONSUMER_PROFILE = 'local-test';
    process.env.FEISHU_CARD_ACTION_TEST_APP_ID = 'cli_local_test_app';
    process.env.FEISHU_CARD_ACTION_TEST_APP_SECRET = 'local-test-secret';

    expect(() => getEffectiveFeishuAppCredentials()).toThrow(
      /必须配置 FEISHU_APP_ID/u,
    );
  });

  it('fails closed when the local-test and production application IDs match', () => {
    process.env.FEISHU_CARD_ACTION_CONSUMER_PROFILE = 'local-test';
    process.env.FEISHU_APP_ID = 'cli_shared_app';
    process.env.FEISHU_CARD_ACTION_TEST_APP_ID = 'cli_shared_app';
    process.env.FEISHU_CARD_ACTION_TEST_APP_SECRET = 'local-test-secret';

    expect(() => getEffectiveFeishuAppCredentials()).toThrow(/必须不同/u);
  });
});
