import {
  buildWeatherGuardRegistrationUrl,
  buildWeatherGuardRegistrationUrlFromSnapshot,
} from '../../server/modules/weather-warning/weather-warning-registration-link';

describe('buildWeatherGuardRegistrationUrl', () => {
  it('builds an HTTPS registration deep link with the configured client base path', () => {
    expect(
      buildWeatherGuardRegistrationUrl({
        publicBaseUrl: 'https://example.com:3001/',
        clientBasePath: '/schedule',
        warningId: 'warning / 1',
        source: 'feishu-card',
      }),
    ).toBe(
      'https://example.com:3001/schedule/monthly-schedule?weatherGuardRegistration=1&warningId=warning+%2F+1&source=feishu-card',
    );
  });

  it('preserves a configured public base path and supports the test-card source', () => {
    expect(
      buildWeatherGuardRegistrationUrl({
        publicBaseUrl: 'https://app.sjhl.online/platform/',
        clientBasePath: '/nantong/',
        warningId: 'warning-2',
        source: 'test-card',
      }),
    ).toBe(
      'https://app.sjhl.online/platform/nantong/monthly-schedule?weatherGuardRegistration=1&warningId=warning-2&source=test-card',
    );
  });

  it.each([
    'http://app.sjhl.online',
    'javascript:alert(1)',
    'data:text/plain,weather',
    'not a URL',
    'https://localhost:3001',
    'https://0.0.0.0',
    'https://127.0.0.1',
    'https://10.1.2.3',
    'https://192.168.1.10',
    'https://172.16.0.1',
    'https://100.64.0.1',
    'https://169.254.1.1',
    'https://192.0.2.1',
    'https://198.51.100.1',
    'https://203.0.113.1',
    'https://198.18.0.1',
    'https://224.0.0.1',
    'https://240.0.0.1',
    'https://255.255.255.255',
    'https://[::]',
    'https://[::1]',
    'https://[::ffff:10.1.2.3]',
    'https://[::ffff:192.0.2.1]',
    'https://[fc00::1]',
    'https://[fd12:3456::1]',
    'https://[fe80::1]',
    'https://[2001:db8::1]',
    'https://[ff02::1]',
  ])('rejects a non-public HTTPS base URL %s', (publicBaseUrl) => {
    expect(() =>
      buildWeatherGuardRegistrationUrl({
        publicBaseUrl,
        clientBasePath: '/',
        warningId: 'warning-1',
        source: 'feishu-card',
      }),
    ).toThrow('HTTPS 公网基址');
  });

  it.each([
    'https://8.8.8.8',
    'https://[2606:4700:4700::1111]',
    'https://[::ffff:8.8.8.8]',
    'https://[::ffff:192.0.0.9]',
    'https://[::ffff:192.0.0.10]',
    'https://[::ffff:192.88.99.2]',
  ])('rejects every IP literal base URL %s', (publicBaseUrl) => {
    expect(() =>
      buildWeatherGuardRegistrationUrl({
        publicBaseUrl,
        clientBasePath: '/',
        warningId: 'warning-ip-literal',
        source: 'feishu-card',
      }),
    ).toThrow('HTTPS 公网基址');
  });

  it.each([
    'https://localhost',
    'https://service.localhost',
    'https://service.local',
    'https://service.internal',
    'https://service.intranet',
    'https://service.lan',
    'https://service.home',
    'https://service.home.arpa',
    'https://foo.test',
    'https://foo.invalid',
    'https://foo.example',
    'https://foo.example.com',
    'https://foo.example.net',
    'https://foo.example.org',
    'https://service.onion',
    'https://service.alt',
    'https://service.arpa',
  ])('rejects a special-use or internal hostname %s', (publicBaseUrl) => {
    expect(() =>
      buildWeatherGuardRegistrationUrl({
        publicBaseUrl,
        clientBasePath: '/',
        warningId: 'warning-special-host',
        source: 'feishu-card',
      }),
    ).toThrow('HTTPS 公网基址');
  });

  it.each([
    'https://singlelabel',
    'https://service.123',
    'https://-bad.sjhl.online',
    'https://bad-.sjhl.online',
    'https://bad_label.sjhl.online',
    `https://${'a'.repeat(64)}.sjhl.online`,
    'https://app.sjhl.online.',
  ])('rejects a non-canonical DNS hostname %s', (publicBaseUrl) => {
    expect(() =>
      buildWeatherGuardRegistrationUrl({
        publicBaseUrl,
        clientBasePath: '/',
        warningId: 'warning-invalid-host',
        source: 'feishu-card',
      }),
    ).toThrow('HTTPS 公网基址');
  });

  it.each([
    'https://user-7b06753a@example.com',
    'https://user:user-af8f5127@example.com',
    'https://app.sjhl.online?token=secret',
    'https://app.sjhl.online/#credential',
  ])('rejects a credential-bearing or non-base URL %s', (publicBaseUrl) => {
    expect(() =>
      buildWeatherGuardRegistrationUrl({
        publicBaseUrl,
        clientBasePath: '/',
        warningId: 'warning-1',
        source: 'feishu-card',
      }),
    ).toThrow('HTTPS 公网基址');
  });

  it.each(['', '   ', ' warning-1 ', 'warning\nid', 'x'.repeat(513)])(
    'rejects a blank or invalid warning id',
    (warningId) => {
      expect(() =>
        buildWeatherGuardRegistrationUrl({
          publicBaseUrl: 'https://app.sjhl.online',
          clientBasePath: '/',
          warningId,
          source: 'feishu-card',
        }),
      ).toThrow('预警 ID');
    },
  );

  it('rejects a source outside the controlled card source list', () => {
    expect(() =>
      buildWeatherGuardRegistrationUrl({
        publicBaseUrl: 'https://app.sjhl.online',
        clientBasePath: '/',
        warningId: 'warning-1',
        source: 'recipient-open-id' as never,
      }),
    ).toThrow('来源');
  });

  it.each([
    '/../admin',
    '//evil.example/path',
    'https://evil.example',
    '/%252e%252e/admin',
    '/safe/%252fadmin',
    '/safe/%255cadmin',
    '/safe/%2500admin',
  ])('rejects an unsafe client base path %s', (clientBasePath) => {
    expect(() =>
      buildWeatherGuardRegistrationUrl({
        publicBaseUrl: 'https://app.sjhl.online',
        clientBasePath,
        warningId: 'warning-1',
        source: 'feishu-card',
      }),
    ).toThrow('CLIENT_BASE_PATH');
  });

  it.each([
    'https://app.sjhl.online/%252e%252e/admin',
    'https://app.sjhl.online/safe/%252fadmin',
    'https://app.sjhl.online/safe/%255cadmin',
    'https://app.sjhl.online/safe/%2500admin',
  ])('rejects an unsafe encoded PUBLIC_BASE_URL path %s', (publicBaseUrl) => {
    expect(() =>
      buildWeatherGuardRegistrationUrl({
        publicBaseUrl,
        clientBasePath: '/',
        warningId: 'warning-unsafe-public-path',
        source: 'feishu-card',
      }),
    ).toThrow('HTTPS 公网基址');
  });
});

describe('buildWeatherGuardRegistrationUrlFromSnapshot', () => {
  const environment = {
    PUBLIC_BASE_URL: 'https://app.sjhl.online/platform',
    CLIENT_BASE_PATH: '/nantong',
  };

  it('uses only the first matched warning id from the snapshot', () => {
    expect(
      buildWeatherGuardRegistrationUrlFromSnapshot(
        environment,
        {
          matchedWarnings: [
            { id: 'primary-warning' },
            { id: 'secondary-warning' },
          ],
        },
        'feishu-card',
      ),
    ).toBe(
      'https://app.sjhl.online/platform/nantong/monthly-schedule?weatherGuardRegistration=1&warningId=primary-warning&source=feishu-card',
    );
  });

  it('does not fall back to a later warning when the first id is invalid', () => {
    expect(() =>
      buildWeatherGuardRegistrationUrlFromSnapshot(
        environment,
        {
          matchedWarnings: [{ id: '' }, { id: 'secondary-warning' }],
        },
        'test-card',
      ),
    ).toThrow('预警 ID');
  });
});
