import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const scriptPath = resolve(
  'scripts/configure-feishu-card-callback-profile.ps1',
);
const wrapperPath = resolve(
  'scripts/configure-feishu-card-callback-profile.cmd',
);

describe('Feishu card callback profile one-click configuration', () => {
  let directory = '';

  afterEach(() => {
    if (directory) {
      rmSync(directory, { recursive: true, force: true });
      directory = '';
    }
  });

  it('sets production mode without exposing or rewriting production credentials', () => {
    const fixture = createFixture([
      '# keep this comment',
      'UNRELATED_VALUE=keep-me',
      'FEISHU_APP_ID=cli_production_fixture',
      'FEISHU_APP_SECRET=production-secret-fixture',
      'FEISHU_CARD_ACTION_CONSUMER_PROFILE=disabled',
      'FEISHU_CARD_ACTION_CONSUMER_PROFILE=stale-duplicate',
      'FEISHU_CARD_ACTION_CONSUMER_ENABLED=false',
      '',
    ]);

    const first = runInteractiveConfigurator(fixture.root, '1');
    expect(first.status).toBe(0);
    expect(first.stdout).not.toContain('production-secret-fixture');
    expect(first.stderr).not.toContain('production-secret-fixture');

    const configured = readFileSync(fixture.envLocalPath, 'utf8');
    expect(configured).toContain('# keep this comment\r\n');
    expect(configured).toContain('UNRELATED_VALUE=keep-me\r\n');
    expect(configured).toContain(
      'FEISHU_CARD_ACTION_CONSUMER_PROFILE=production\r\n',
    );
    expect(configured).toContain(
      'FEISHU_CARD_ACTION_CONSUMER_ENABLED=true\r\n',
    );
    expect(
      configured.match(/FEISHU_CARD_ACTION_CONSUMER_PROFILE=/g),
    ).toHaveLength(1);
    expect(configured).toContain(
      'FEISHU_APP_SECRET=production-secret-fixture\r\n',
    );

    const second = runConfigurator(fixture.root, 'production');
    expect(second.status).toBe(0);
    expect(readFileSync(fixture.envLocalPath, 'utf8')).toBe(configured);
  });

  it('sets disabled mode while preserving unrelated local settings', () => {
    const fixture = createFixture([
      'UNRELATED_VALUE=keep-me',
      'FEISHU_CARD_ACTION_TEST_APP_ID=cli_existing_test',
      'FEISHU_CARD_ACTION_TEST_APP_SECRET=existing-test-secret',
      '',
    ]);

    const result = runConfigurator(fixture.root, 'disabled');
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('existing-test-secret');
    const configured = readFileSync(fixture.envLocalPath, 'utf8');
    expect(configured).toContain('UNRELATED_VALUE=keep-me');
    expect(configured).toContain(
      'FEISHU_CARD_ACTION_CONSUMER_PROFILE=disabled',
    );
    expect(configured).toContain(
      'FEISHU_CARD_ACTION_CONSUMER_ENABLED=false',
    );
    expect(configured).toContain(
      'FEISHU_CARD_ACTION_TEST_APP_SECRET=existing-test-secret',
    );
  });

  it('sets local-test mode from non-interactive environment credentials', () => {
    const fixture = createFixture(['UNRELATED_VALUE=keep-me', '']);
    const result = runConfigurator(fixture.root, 'local-test', {
      FEISHU_CARD_ACTION_TEST_APP_ID: 'cli_isolated_test_fixture',
      FEISHU_CARD_ACTION_TEST_APP_SECRET: 'isolated-test-secret-fixture',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('isolated-test-secret-fixture');
    expect(result.stderr).not.toContain('isolated-test-secret-fixture');
    expect(readEnv(fixture.envLocalPath)).toMatchObject({
      FEISHU_CARD_ACTION_CONSUMER_PROFILE: 'local-test',
      FEISHU_CARD_ACTION_CONSUMER_ENABLED: 'false',
      FEISHU_CARD_ACTION_TEST_APP_ID: 'cli_isolated_test_fixture',
      FEISHU_CARD_ACTION_TEST_APP_SECRET: 'isolated-test-secret-fixture',
      UNRELATED_VALUE: 'keep-me',
    });
  });

  it.each([
    {
      name: 'the test App ID matches production',
      environment: {
        FEISHU_CARD_ACTION_TEST_APP_ID: 'cli_production_fixture',
        FEISHU_CARD_ACTION_TEST_APP_SECRET: 'isolated-test-secret-fixture',
      },
    },
    {
      name: 'test credentials are missing',
      environment: {},
    },
  ])('fails closed before writing when $name', ({ environment }) => {
    const fixture = createFixture(['ORIGINAL_BYTES=must-stay', '']);
    const before = readFileSync(fixture.envLocalPath);
    const result = runConfigurator(fixture.root, 'local-test', environment);

    expect(result.status).not.toBe(0);
    expect(readFileSync(fixture.envLocalPath)).toEqual(before);
  });

  it('ships a menu wrapper for production, disabled, and local-test modes', () => {
    const wrapperBytes = readFileSync(wrapperPath);
    const wrapper = wrapperBytes.toString('utf8');
    expect([...wrapperBytes].every((byte) => byte < 0x80)).toBe(true);
    expect(wrapper).toContain(
      '-File "%~dp0configure-feishu-card-callback-profile.ps1"',
    );
    expect(wrapper).not.toContain('-AppRoot');
    expect(wrapper).not.toContain('chcp');
    expect(wrapper.match(/\r\n/g)?.length).toBeGreaterThan(0);
    expect(wrapper).not.toMatch(/(?<!\r)\n/);
  });

  function createFixture(localLines: string[]) {
    directory = mkdtempSync(join(tmpdir(), 'feishu-callback-profile-'));
    mkdirSync(join(directory, 'deploy'), { recursive: true });
    writeFileSync(join(directory, 'package.json'), '{"private":true}\n', 'utf8');
    writeFileSync(join(directory, 'deploy', 'watchdog.ps1'), '# fixture\n');
    writeFileSync(
      join(directory, '.env'),
      [
        'FEISHU_APP_ID=cli_production_fixture',
        'FEISHU_APP_SECRET=production-secret-fixture',
        '',
      ].join('\n'),
      'utf8',
    );
    const envLocalPath = join(directory, '.env.local');
    writeFileSync(envLocalPath, localLines.join('\r\n'), 'utf8');
    return { root: directory, envLocalPath };
  }
});

function runConfigurator(
  appRoot: string,
  mode: 'production' | 'disabled' | 'local-test',
  overrides: Record<string, string> = {},
) {
  return spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      scriptPath,
      '-Mode',
      mode,
      '-AppRoot',
      appRoot,
      '-NonInteractive',
      '-SkipRuntimeControl',
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        FEISHU_APP_ID: '',
        FEISHU_APP_SECRET: '',
        FEISHU_CARD_ACTION_TEST_APP_ID: '',
        FEISHU_CARD_ACTION_TEST_APP_SECRET: '',
        ...overrides,
      },
    },
  );
}

function runInteractiveConfigurator(appRoot: string, selection: string) {
  return spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      scriptPath,
      '-AppRoot',
      appRoot,
      '-SkipRuntimeControl',
    ],
    {
      encoding: 'utf8',
      input: `${selection}\r\n`,
      env: {
        ...process.env,
        FEISHU_APP_ID: '',
        FEISHU_APP_SECRET: '',
        FEISHU_CARD_ACTION_TEST_APP_ID: '',
        FEISHU_CARD_ACTION_TEST_APP_SECRET: '',
      },
    },
  );
}

function readEnv(path: string): Record<string, string> {
  return Object.fromEntries(
    readFileSync(path, 'utf8')
      .split(/\r?\n/)
      .filter((line) => /^[A-Z][A-Z0-9_]*=/.test(line))
      .map((line) => {
        const separator = line.indexOf('=');
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}
