import { createHmac } from 'node:crypto';

import {
  createWeatherWarningTestSimulationContext,
  isWeatherWarningTestSimulationId,
  verifyWeatherWarningTestSimulationId,
} from '../../server/modules/weather-warning/weather-warning-test-simulation';

const NOW = Date.parse('2026-08-09T03:00:00.000Z');
const RUN_MUTATION_ID = `weather-e2e-${NOW}-a1b2c3d4e5f60708`;
const ROOT_SECRET = 'weather-warning-test-simulation-root-secret-32-bytes';
const TOKEN_PURPOSE = 'weather-warning-full-flow-test-v1';
const TOKEN_VERSION = 'wte2e1';

describe('weather warning full-flow test simulation', () => {
  const originalEnvironment = {
    nodeEnv: process.env.NODE_ENV,
    simulationSecret: process.env.WEATHER_WARNING_TEST_SIMULATION_SECRET,
    feishuSecret: process.env.FEISHU_APP_SECRET,
    appSecret: process.env.APP_SECRET,
  };

  beforeEach(() => {
    process.env.NODE_ENV = 'test';
    process.env.WEATHER_WARNING_TEST_SIMULATION_SECRET = ROOT_SECRET;
    delete process.env.FEISHU_APP_SECRET;
    delete process.env.APP_SECRET;
  });

  afterAll(() => {
    restoreEnvironment('NODE_ENV', originalEnvironment.nodeEnv);
    restoreEnvironment(
      'WEATHER_WARNING_TEST_SIMULATION_SECRET',
      originalEnvironment.simulationSecret,
    );
    restoreEnvironment('FEISHU_APP_SECRET', originalEnvironment.feishuSecret);
    restoreEnvironment('APP_SECRET', originalEnvironment.appSecret);
  });

  it('creates a signed tertiary-guard context with an isolated tag and seven missing buildings', () => {
    const context = createWeatherWarningTestSimulationContext(
      RUN_MUTATION_ID,
      NOW,
    );

    expect(context.runId).toMatch(/^[0-9a-f]{20}$/u);
    expect(context.tag).toBe(`全流程测试/${context.runId}`);
    expect(context.openedAt).toBe(new Date(NOW).toISOString());
    expect(context.expiresAt).toBe(
      new Date(NOW + 24 * 60 * 60 * 1000).toISOString(),
    );
    expect(context.warningId.length).toBeLessThanOrEqual(512);
    expect(context.snapshot).toMatchObject({
      status: 'active',
      sourceState: 'fresh',
      guardDecisionState: 'fresh',
      checkSyncState: 'fresh',
      guardLevel: '三级戒备',
      canSendTest: true,
      matchedWarnings: [
        {
          id: context.warningId,
          title: '【全流程测试】南通市气象台发布台风蓝色预警',
          type: '台风',
          color: 'blue',
          guardLevel: '三级戒备',
        },
      ],
      weather: {
        temperature: '32℃',
        feelsLike: '35℃',
        humidity: '72%',
        windDirection: '东风',
        windScale: '3级',
        observedAt: new Date(NOW).toISOString(),
      },
    });
    expect(
      context.snapshot.buildingProgress?.missingRegistrationBuildings,
    ).toEqual(['A楼', 'B楼', 'C楼', 'D楼', 'E楼', 'H楼', '110站']);
    expect(context.snapshot.buildingProgress?.incompleteItems).toHaveLength(7);
    expect(context.snapshot.actions).toHaveLength(5);

    expect(
      verifyWeatherWarningTestSimulationId(context.warningId, NOW),
    ).toMatchObject({
      runId: context.runId,
      warningId: context.warningId,
      tag: context.tag,
      openedAt: context.openedAt,
      expiresAt: context.expiresAt,
    });
  });

  it('keeps the context stable for the same run mutation id', () => {
    const first = createWeatherWarningTestSimulationContext(
      RUN_MUTATION_ID,
      NOW + 1_000,
    );
    const second = createWeatherWarningTestSimulationContext(
      RUN_MUTATION_ID,
      NOW + 60_000,
    );

    expect(second.runId).toBe(first.runId);
    expect(second.tag).toBe(first.tag);
    expect(second.warningId).toBe(first.warningId);
    expect(second.openedAt).toBe(first.openedAt);
  });

  it.each([
    '',
    'warning-primary',
    `weather-e2e-${NOW}-short`,
    `weather-e2e-${NOW + 60_000}-a1b2c3d4e5f60708`,
    `weather-e2e-${NOW - 24 * 60 * 60 * 1000 - 1}-a1b2c3d4e5f60708`,
    `weather-e2e-${NOW}-a1b2c3d4e5f60708/unsafe`,
  ])('rejects an invalid or unusable run mutation id: %p', (value) => {
    expect(() => createWeatherWarningTestSimulationContext(value, NOW)).toThrow(
      '天气预警全流程测试操作号无效或已过期',
    );
  });

  it('distinguishes a real warning id from an invalid simulation id', () => {
    expect(isWeatherWarningTestSimulationId('warning-primary')).toBe(false);
    expect(verifyWeatherWarningTestSimulationId('warning-primary', NOW)).toBe(
      null,
    );

    const context = createWeatherWarningTestSimulationContext(
      RUN_MUTATION_ID,
      NOW,
    );
    expect(isWeatherWarningTestSimulationId(context.warningId)).toBe(true);

    const tampered = `${context.warningId.slice(0, -1)}${
      context.warningId.endsWith('a') ? 'b' : 'a'
    }`;
    expect(isWeatherWarningTestSimulationId(tampered)).toBe(true);
    expect(verifyWeatherWarningTestSimulationId(tampered, NOW)).toBe(null);
    expect(
      verifyWeatherWarningTestSimulationId(
        context.warningId,
        NOW + 24 * 60 * 60 * 1000 + 1,
      ),
    ).toBe(null);
  });

  it('rejects a correctly signed payload with unknown fields or non-canonical base64url', () => {
    const context = createWeatherWarningTestSimulationContext(
      RUN_MUTATION_ID,
      NOW,
    );
    const [, encodedPayload] = context.warningId.split('.');
    const payload = JSON.parse(
      Buffer.from(encodedPayload, 'base64url').toString('utf8'),
    ) as Record<string, unknown>;
    const withUnknownField = signPayload({ ...payload, extra: true });

    expect(verifyWeatherWarningTestSimulationId(withUnknownField, NOW)).toBe(
      null,
    );

    const nonCanonical = context.warningId.replace(
      encodedPayload,
      `${encodedPayload}=`,
    );
    expect(verifyWeatherWarningTestSimulationId(nonCanonical, NOW)).toBe(null);
  });

  it('fails closed in production when no signing root is configured', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.WEATHER_WARNING_TEST_SIMULATION_SECRET;
    delete process.env.FEISHU_APP_SECRET;
    delete process.env.APP_SECRET;

    expect(() =>
      createWeatherWarningTestSimulationContext(RUN_MUTATION_ID, NOW),
    ).toThrow('天气预警全流程测试签名密钥未配置');
  });
});

function signPayload(payload: Record<string, unknown>): string {
  const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString(
    'base64url',
  );
  const signingKey = createHmac('sha256', ROOT_SECRET)
    .update(TOKEN_PURPOSE)
    .digest();
  const signature = createHmac('sha256', signingKey)
    .update(`${TOKEN_VERSION}.${encodedPayload}`)
    .digest('base64url');
  return `${TOKEN_VERSION}.${encodedPayload}.${signature}`;
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}
