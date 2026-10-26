import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';

const FIXED_TABLE_ID = 'tbl73b701bc3e2a1';
const REQUIRED_FIELDS = [
  { name: '变更总结请求唯一ID', type: 'text' },
  { name: '变更总结请求指纹', type: 'text' },
];
const TEST_FEISHU_APP_ID = 'bot-42';
const TEST_FEISHU_APP_SECRET = 'sec-73';
const CHILD_ENV_ALLOWLIST = [
  'PATH',
  'Path',
  'SystemRoot',
  'WINDIR',
  'TEMP',
  'TMP',
  'ComSpec',
  'PATHEXT',
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'NO_COLOR',
  'LARK_CLI_HOME',
  'LARK_CLI_CONFIG',
  'LARK_CLI_PROFILE',
  'LARK_OPENAPI_BASE_URL',
  'FEISHU_APP_ID',
  'FEISHU_APP_SECRET',
];
const WINDOWS_INJECTED_CHILD_ENV_NAMES = [
  'HOMEDRIVE',
  'HOMEPATH',
  'LOGONSERVER',
  'SYSTEMDRIVE',
  'USERDOMAIN',
  'USERNAME',
];
const script = join(
  process.cwd(),
  'scripts/ensure-change-summary-report-fields.mjs',
);

describe('change summary report Base field migration', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'change-summary-report-fields-'));
  const fakeCli = join(tempDir, 'fake-lark-cli.mjs');
  const fakeState = join(tempDir, 'fake-fields.json');
  const fakeLog = join(tempDir, 'fake-calls.jsonl');
  const fakeMode = join(tempDir, 'fake-mode.txt');
  const fakeLeaks = join(tempDir, 'fake-leaks.json');

  beforeAll(() => writeFileSync(fakeCli, fakeLarkCliSource(), 'utf8'));
  beforeEach(() => {
    writeFileSync(fakeState, '[]', 'utf8');
    writeFileSync(fakeLog, '', 'utf8');
    writeFileSync(fakeMode, 'ok', 'utf8');
    writeFileSync(fakeLeaks, '[]', 'utf8');
  });
  afterAll(() => rmSync(tempDir, { recursive: true, force: true }));

  it('plans both required fields from a fixture in dry-run mode', () => {
    const fieldFile = join(tempDir, 'partial.json');
    writeFileSync(
      fieldFile,
      JSON.stringify({
        data: {
          fields: [{ name: '关单说明', type: 'text' }],
        },
      }),
    );

    const result = run(['--dry-run', '--field-list-file', fieldFile]);
    expect(result.status).toBe(0);
    expect(parseOutput(result.stdout)).toEqual({
      success: true,
      dryRun: true,
      existing: [],
      created: REQUIRED_FIELDS.map((field) => field.name),
    });
    expect(readCalls(fakeLog)).toEqual([]);
  });

  it('rejects --field-list-file in apply mode before calling lark', () => {
    const fieldFile = join(tempDir, 'apply-fixture.json');
    writeFileSync(fieldFile, '[]', 'utf8');

    const result = run(
      ['--apply', '--field-list-file', fieldFile],
      cliEnvironment(fakeCli),
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('--apply');
    expect(result.stderr).toContain('--field-list-file');
    expect(readCalls(fakeLog)).toEqual([]);
  });

  it('applies only two text fields and is idempotent after a real field-list readback', () => {
    const env = cliEnvironment(fakeCli);

    const first = run(['--apply'], env);
    expect(first.status).toBe(0);
    expect(parseOutput(first.stdout)).toEqual({
      success: true,
      dryRun: false,
      existing: [],
      created: REQUIRED_FIELDS.map((field) => field.name),
    });
    const firstCalls = readCalls(fakeLog);
    expect(firstCalls.map(commandName)).toEqual([
      '+url-resolve',
      '+field-list',
      '+field-create',
      '+field-create',
    ]);
    expect(
      firstCalls
        .filter((call) => commandName(call) === '+field-create')
        .map((call) => call.payload),
    ).toEqual(REQUIRED_FIELDS);
    for (const call of firstCalls.filter((entry) =>
      ['+field-list', '+field-create'].includes(commandName(entry)),
    )) {
      expect(argumentValue(call.args, '--table-id')).toBe(FIXED_TABLE_ID);
    }
    expect(JSON.parse(readFileSync(fakeState, 'utf8'))).toEqual(
      REQUIRED_FIELDS,
    );

    const second = run(['--apply'], env);
    expect(second.status).toBe(0);
    expect(parseOutput(second.stdout)).toEqual({
      success: true,
      dryRun: false,
      existing: REQUIRED_FIELDS.map((field) => field.name),
      created: [],
    });
    const allCalls = readCalls(fakeLog);
    expect(allCalls.map(commandName)).toEqual([
      '+url-resolve',
      '+field-list',
      '+field-create',
      '+field-create',
      '+url-resolve',
      '+field-list',
    ]);
    expect(
      allCalls.filter((call) => commandName(call) === '+field-create'),
    ).toHaveLength(2);
  });

  it('fails on an existing same-name field with the wrong type after real field-list', () => {
    writeFileSync(
      fakeState,
      JSON.stringify([{ name: '变更总结请求唯一ID', type: 'number' }]),
      'utf8',
    );

    const result = run(['--apply'], cliEnvironment(fakeCli));

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('变更总结请求唯一ID');
    expect(result.stderr).toContain('类型或配置不符');
    expect(readCalls(fakeLog).map(commandName)).toEqual([
      '+url-resolve',
      '+field-list',
    ]);
  });

  it.each([
    'FEISHU_CHANGE_SUMMARY_REPORT_TABLE_ID',
    'FEISHU_CHANGE_DRILL_REPORT_TABLE_ID',
  ])('rejects a non-fixed closeout table from %s', (environmentName) => {
    const fieldFile = join(tempDir, `wrong-table-${environmentName}.json`);
    const wrongTableId = `tblWrong-${environmentName}`;
    writeFileSync(fieldFile, '[]');

    const result = run(
      ['--dry-run', '--field-list-file', fieldFile],
      isolatedEnvironment({ [environmentName]: wrongTableId }),
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('固定关单表配置不一致');
    expect(`${result.stdout}\n${result.stderr}`).not.toContain(wrongTableId);
  });

  it('passes only runtime, bot OAuth and explicit non-secret Lark environment to child processes', () => {
    const env = cliEnvironment(fakeCli, {
      LARK_CLI_PROFILE: 'migration-test-profile',
      LARK_CLI_HOME: join(tempDir, 'lark-home'),
      UNRELATED_SHOULD_NOT_LEAK: 'private-parent-environment-value',
      COS_SECRET_ID: 'private-parent-cos-id-value',
      TENCENTCLOUD_SECRET_KEY: 'private-parent-tencent-key-value',
      THIRD_PARTY_SESSION_TOKEN: 'private-parent-session-token-value',
      CUSTOM_ACCESS_TOKEN: 'private-parent-access-token-value',
    });

    const result = run(['--apply'], env);

    expect(result.status).toBe(0);
    const allowedNames = new Set(
      [
        ...CHILD_ENV_ALLOWLIST,
        ...(process.platform === 'win32'
          ? WINDOWS_INJECTED_CHILD_ENV_NAMES
          : []),
      ].map((name) => name.toLowerCase()),
    );
    for (const call of readCalls(fakeLog)) {
      expect(call.env.LARK_CLI_PROFILE).toBe('migration-test-profile');
      expect(call.env.LARK_CLI_HOME).toBe(join(tempDir, 'lark-home'));
      expect(call.credentials).toEqual({
        feishuAppIdConfigured: true,
        feishuAppSecretConfigured: true,
      });
      expect(call.env.FEISHU_APP_ID).toBe('[configured]');
      expect(call.env.FEISHU_APP_SECRET).toBe('[configured]');
      expect(call.env.UNRELATED_SHOULD_NOT_LEAK).toBeUndefined();
      expect(call.env.COS_SECRET_ID).toBeUndefined();
      expect(call.env.TENCENTCLOUD_SECRET_KEY).toBeUndefined();
      expect(call.env.THIRD_PARTY_SESSION_TOKEN).toBeUndefined();
      expect(call.env.CUSTOM_ACCESS_TOKEN).toBeUndefined();
      expect(
        Object.keys(call.env).filter(
          (name) => !allowedNames.has(name.toLowerCase()),
        ),
      ).toEqual([]);
    }
    const observableOutput = `${result.stdout}\n${result.stderr}\n${
      result.error?.message || ''
    }`;
    expect(observableOutput).not.toContain(TEST_FEISHU_APP_ID);
    expect(observableOutput).not.toContain(TEST_FEISHU_APP_SECRET);
    expect(readFileSync(fakeLog, 'utf8')).not.toContain(TEST_FEISHU_APP_ID);
    expect(readFileSync(fakeLog, 'utf8')).not.toContain(TEST_FEISHU_APP_SECRET);
  });

  it('redacts bot OAuth credentials echoed by a failing lark child', () => {
    writeFileSync(fakeMode, 'fail-with-feishu-auth', 'utf8');

    const result = run(['--apply'], cliEnvironment(fakeCli));

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('lark-cli 返回失败');
    expect(result.stderr).toContain('[redacted');
    const calls = readCalls(fakeLog);
    expect(calls).toHaveLength(1);
    expect(calls[0].credentials).toEqual({
      feishuAppIdConfigured: true,
      feishuAppSecretConfigured: true,
    });
    expect(calls[0].env.FEISHU_APP_ID).toBe('[configured]');
    expect(calls[0].env.FEISHU_APP_SECRET).toBe('[configured]');
    const observableOutput = `${result.stdout}\n${result.stderr}\n${
      result.error?.message || ''
    }`;
    expect(observableOutput).not.toContain(TEST_FEISHU_APP_ID);
    expect(observableOutput).not.toContain(TEST_FEISHU_APP_SECRET);
    expect(readFileSync(fakeLog, 'utf8')).not.toContain(TEST_FEISHU_APP_ID);
    expect(readFileSync(fakeLog, 'utf8')).not.toContain(TEST_FEISHU_APP_SECRET);
  });

  it('redacts source identifiers and extended cloud/token credential values from stderr', () => {
    const sourceUrl =
      'https://example.feishu.cn/wiki/PUBLIC_EXAMPLE_SOURCE';
    const secrets = {
      FEISHU_CHANGE_APP_TOKEN: 'secret-base-token-value-987',
      COS_SECRET_ID: 'secret-cos-id-value-987',
      COS_SECRET_KEY: 'secret-cos-key-value-987',
      TENCENTCLOUD_SECRET_ID: 'secret-tencent-id-value-987',
      TENCENTCLOUD_SECRET_KEY: 'secret-tencent-key-value-987',
      THIRD_PARTY_SESSION_TOKEN: 'secret-session-token-value-987',
      CUSTOM_ACCESS_TOKEN: 'secret-access-token-value-987',
      CUSTOM_APP_SECRET: 'secret-custom-app-secret-value-987',
      CUSTOM_APP_TOKEN: 'secret-custom-app-token-value-987',
    };
    const leakedValues = [
      sourceUrl,
      'wikiSourceToken987',
      'sourceUrlBaseToken987',
      ...Object.values(secrets),
    ];
    writeFileSync(fakeMode, 'fail-with-leaks', 'utf8');
    writeFileSync(fakeLeaks, JSON.stringify(leakedValues), 'utf8');

    const result = run(
      ['--apply'],
      cliEnvironment(fakeCli, {
        ...secrets,
        FEISHU_CALENDAR_CHANGE_SOURCE_URL: sourceUrl,
      }),
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('lark-cli 返回失败');
    expect(result.stderr).toContain('[redacted');
    for (const secret of leakedValues) {
      expect(result.stderr).not.toContain(secret);
    }
  });

  it('uses URL resolution, argument arrays and Windows-safe JSON files', () => {
    const source = existsSync(script) ? readFileSync(script, 'utf8') : '';

    expect(source).toContain("'+url-resolve'");
    expect(source).toContain('writeJsonArgumentFile');
    expect(source).toContain('`@${payloadPath}`');
    expect(source).toContain("replaceAll('\\\\', '/')");
    expect(source).toContain('windowsHide: true');
    expect(source).toContain('shell: false');
  });

  function run(args: string[], env: NodeJS.ProcessEnv = isolatedEnvironment()) {
    return spawnSync(process.execPath, [script, ...args], {
      encoding: 'utf8',
      windowsHide: true,
      env,
    });
  }
});

interface FakeLarkCall {
  args: string[];
  env: Record<string, string>;
  credentials: {
    feishuAppIdConfigured: boolean;
    feishuAppSecretConfigured: boolean;
  };
  payload?: { name: string; type: string };
}

function cliEnvironment(
  fakeCli: string,
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  return isolatedEnvironment({
    LARK_CLI_BIN: fakeCli,
    FEISHU_APP_ID: TEST_FEISHU_APP_ID,
    FEISHU_APP_SECRET: TEST_FEISHU_APP_SECRET,
    FEISHU_CALENDAR_CHANGE_SOURCE_URL:
      'https://example.feishu.cn/wiki/PUBLIC_EXAMPLE_SOURCE',
    FEISHU_CHANGE_SUMMARY_REPORT_TABLE_ID: FIXED_TABLE_ID,
    FEISHU_CHANGE_DRILL_REPORT_TABLE_ID: FIXED_TABLE_ID,
    ...overrides,
  });
}

function isolatedEnvironment(
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const name of CHILD_ENV_ALLOWLIST) {
    if (name === 'FEISHU_APP_ID' || name === 'FEISHU_APP_SECRET') continue;
    if (process.env[name]) result[name] = process.env[name];
  }
  return { ...result, ...overrides };
}

function parseOutput(value: string) {
  return value ? JSON.parse(value) : null;
}

function readCalls(path: string): FakeLarkCall[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as FakeLarkCall);
}

function commandName(call: FakeLarkCall): string {
  return call.args.find((argument) => argument.startsWith('+')) || '';
}

function argumentValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function fakeLarkCliSource(): string {
  return `
import {
  appendFileSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const statePath = resolve(root, 'fake-fields.json');
const logPath = resolve(root, 'fake-calls.jsonl');
const modePath = resolve(root, 'fake-mode.txt');
const leaksPath = resolve(root, 'fake-leaks.json');
const args = process.argv.slice(2);
const command = args.find((argument) => argument.startsWith('+')) || '';
let payload;

if (command === '+field-create') {
  const jsonIndex = args.indexOf('--json');
  const payloadReference = jsonIndex >= 0 ? args[jsonIndex + 1] || '' : '';
  if (!payloadReference.startsWith('@')) fail('missing JSON argument file', 19);
  payload = JSON.parse(
    readFileSync(resolve(process.cwd(), payloadReference.slice(1)), 'utf8'),
  );
}

const credentials = {
  feishuAppIdConfigured: Boolean(process.env.FEISHU_APP_ID?.trim()),
  feishuAppSecretConfigured: Boolean(process.env.FEISHU_APP_SECRET?.trim()),
};
const loggedEnvironment = Object.fromEntries(
  Object.entries(process.env).map(([name, value]) => [
    name,
    /(?:APP_ID|APP_SECRET|APP_TOKEN|SESSION_TOKEN|ACCESS_TOKEN|SECRET_ID|SECRET_KEY)$/i.test(name)
      ? '[configured]'
      : value,
  ]),
);

appendFileSync(
  logPath,
  JSON.stringify({ args, env: loggedEnvironment, credentials, payload }) + '\\n',
  'utf8',
);

const mode = readFileSync(modePath, 'utf8').trim();
if (mode === 'fail-with-feishu-auth') {
  process.stderr.write(
    [
      process.env.FEISHU_APP_ID || '[missing-FEISHU_APP_ID]',
      process.env.FEISHU_APP_SECRET || '[missing-FEISHU_APP_SECRET]',
    ].join(' | '),
  );
  process.exit(16);
}
if (mode === 'fail-with-leaks') {
  const leaked = JSON.parse(readFileSync(leaksPath, 'utf8'));
  process.stderr.write(leaked.join(' | '));
  process.exit(17);
}

if (command === '+url-resolve') {
  process.stdout.write('{"data":{"base_token":"resolved-test-base-token"}}\\n');
  process.exit(0);
}

if (!['+field-list', '+field-create'].includes(command)) {
  fail('unexpected fake lark command', 18);
}
if (argumentValue('--table-id') !== '${FIXED_TABLE_ID}') {
  fail('unexpected table id', 20);
}

const state = JSON.parse(readFileSync(statePath, 'utf8'));
if (command === '+field-list') {
  process.stdout.write(JSON.stringify({ data: { fields: state } }) + '\\n');
  process.exit(0);
}

state.push({ name: payload.name, type: payload.type });
writeFileSync(statePath, JSON.stringify(state), 'utf8');
process.stdout.write('{"success":true}\\n');

function argumentValue(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : '';
}

function fail(message, status) {
  process.stderr.write(message);
  process.exit(status);
}
`;
}
