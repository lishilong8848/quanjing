import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawn, spawnSync, type ChildProcess } from 'child_process';

const FIXED_TABLE_ID = 'tblf1bbd02a2b049';
const REQUIRED_FIELDS = [
  {
    name: '加班工作流状态',
    type: 'select',
    multiple: false,
    options: ['待路由', '待审批', '已审批', '已驳回', '待确认', '已确认'],
  },
  { name: '加班审批人', type: 'user', multiple: false },
  { name: '加班审批时间', type: 'datetime' },
  { name: '加班确认人', type: 'user', multiple: false },
  { name: '加班确认时间', type: 'datetime' },
  {
    name: '加班确认',
    type: 'select',
    multiple: false,
    options: ['确认'],
  },
  { name: '加班经理知会时间', type: 'datetime' },
  { name: '加班确认最后提醒时间', type: 'datetime' },
  { name: '加班工作流错误', type: 'text' },
] as const;
const TEST_FEISHU_APP_ID = 'test-overtime-app-id';
const TEST_FEISHU_APP_SECRET = 'test-overtime-app-secret';
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
  'scripts/ensure-overtime-workflow-fields.mjs',
);
let fakeCliPath = '';
let fakeOpenApiProcess: ChildProcess | undefined;
let fakeOpenApiBaseUrl = '';

describe('overtime workflow Base field migration', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'overtime-workflow-fields-'));
  const fakeCli = join(tempDir, 'fake-lark-cli.mjs');
  const fakeState = join(tempDir, 'fake-fields.json');
  const fakeLog = join(tempDir, 'fake-calls.jsonl');
  const fakeMode = join(tempDir, 'fake-mode.txt');
  const fakeOpenApi = join(tempDir, 'fake-openapi.mjs');
  const fakeOpenApiLog = join(tempDir, 'fake-openapi-calls.jsonl');

  beforeAll(async () => {
    fakeCliPath = fakeCli;
    writeFileSync(fakeCli, fakeLarkCliSource(), 'utf8');
    writeFileSync(fakeOpenApi, fakeOpenApiSource(), 'utf8');
    fakeOpenApiProcess = spawn(
      process.execPath,
      [fakeOpenApi, fakeState, fakeMode, fakeOpenApiLog],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    );
    fakeOpenApiBaseUrl = await waitForOpenApiServer(fakeOpenApiProcess);
  });
  beforeEach(() => {
    writeFileSync(fakeState, '[]', 'utf8');
    writeFileSync(fakeLog, '', 'utf8');
    writeFileSync(fakeOpenApiLog, '', 'utf8');
    writeFileSync(fakeMode, 'ok', 'utf8');
  });
  afterAll(async () => {
    if (fakeOpenApiProcess && !fakeOpenApiProcess.killed) {
      fakeOpenApiProcess.kill();
      await waitForChildExit(fakeOpenApiProcess);
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('defaults to dry-run and plans only missing fields without invoking lark', () => {
    const fieldFile = join(tempDir, 'partial.json');
    writeFileSync(
      fieldFile,
      JSON.stringify({
        data: {
          fields: [
            {
              name: '加班工作流状态',
              type: 'select',
              multiple: false,
            },
            { name: '加班审批人', type: 'user', multiple: false },
          ],
        },
      }),
      'utf8',
    );

    const result = run(['--field-list-file', fieldFile]);

    expect(result.status).toBe(0);
    expect(parseOutput(result.stdout)).toEqual({
      success: true,
      dryRun: true,
      existing: ['加班工作流状态', '加班审批人'],
      created: REQUIRED_FIELDS.slice(2).map((field) => field.name),
    });
    expect(readCalls(fakeLog)).toEqual([]);
  });

  it('rejects conflicting modes and apply fixtures before invoking lark', () => {
    const fieldFile = join(tempDir, 'invalid-mode.json');
    writeFileSync(fieldFile, '[]', 'utf8');

    const conflicting = run(['--apply', '--dry-run']);
    expect(conflicting.status).not.toBe(0);
    expect(conflicting.stderr).toContain('--apply');
    expect(conflicting.stderr).toContain('--dry-run');

    const fixtureApply = run(
      ['--apply', '--field-list-file', fieldFile],
      cliEnvironment(),
    );
    expect(fixtureApply.status).not.toBe(0);
    expect(fixtureApply.stderr).toContain('--field-list-file');
    expect(readCalls(fakeLog)).toEqual([]);
  });

  it('fails closed when the primary runtime table override targets another table', () => {
    const result = run(
      ['--dry-run'],
      cliEnvironment({ FEISHU_OVERTIME_TABLE_ID: 'tbl32ce57e0b02a3d98' }),
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('FEISHU_OVERTIME_TABLE_ID');
    expect(result.stderr).toContain('固定加班表配置不一致');
    expect(readCalls(fakeLog)).toEqual([]);
  });

  it('uses the primary runtime app token and fixed table configuration', () => {
    const result = run(
      ['--dry-run'],
      cliEnvironment({
        FEISHU_OVERTIME_APP_TOKEN: 'primary-overtime-base-token',
        FEISHU_OVERTIME_TABLE_ID: FIXED_TABLE_ID,
        FEISHU_LEAVE_REQUEST_APP_TOKEN: 'fallback-leave-base-token',
      }),
    );

    expect(result.status).toBe(0);
    expect(readCalls(fakeLog)).toEqual([]);
    const calls = readOpenApiCalls(fakeOpenApiLog);
    expect(calls.map((call) => call.method)).toEqual(['POST', 'GET']);
    expect(calls[1].path).toBe(
      `/bitable/v1/apps/primary-overtime-base-token/tables/${FIXED_TABLE_ID}/fields`,
    );
  });

  it('runs the readiness gate through bundled read-only OpenAPI without lark-cli', () => {
    writeFileSync(fakeState, JSON.stringify(completeFields()), 'utf8');
    const unavailableCli = join(tempDir, 'lark-cli-does-not-exist');

    const result = run(
      ['--dry-run', '--require-ready'],
      cliEnvironment({
        LARK_CLI_BIN: unavailableCli,
        FEISHU_OVERTIME_APP_TOKEN: 'self-contained-base-token',
      }),
    );

    expect(result.status).toBe(0);
    expect(parseOutput(result.stdout)).toEqual({
      success: true,
      dryRun: true,
      existing: REQUIRED_FIELDS.map((field) => field.name),
      created: [],
    });
    expect(readCalls(fakeLog)).toEqual([]);
    const calls = readOpenApiCalls(fakeOpenApiLog);
    expect(calls).toEqual([
      expect.objectContaining({
        method: 'POST',
        path: '/auth/v3/tenant_access_token/internal',
        credentials: { appId: true, appSecret: true },
        authorized: false,
      }),
      expect.objectContaining({
        method: 'GET',
        path: `/bitable/v1/apps/self-contained-base-token/tables/${FIXED_TABLE_ID}/fields`,
        credentials: { appId: false, appSecret: false },
        authorized: true,
      }),
    ]);
    expect(calls.some((call) => call.path.includes('field-create'))).toBe(
      false,
    );
  });

  it('resolves the configured Wiki source through OpenAPI when no app token is configured', () => {
    writeFileSync(fakeState, JSON.stringify(completeFields()), 'utf8');

    const result = run(
      ['--dry-run', '--require-ready'],
      cliEnvironment({
        LARK_CLI_BIN: join(tempDir, 'lark-cli-does-not-exist'),
        FEISHU_OVERTIME_APP_TOKEN: '',
        FEISHU_LEAVE_SUBSTITUTE_APP_TOKEN: '',
        FEISHU_LEAVE_REQUEST_APP_TOKEN: '',
        FEISHU_MAIN_APP_TOKEN: '',
        FEISHU_BITABLE_APP_TOKEN: '',
      }),
    );

    expect(result.status).toBe(0);
    expect(readCalls(fakeLog)).toEqual([]);
    expect(readOpenApiCalls(fakeOpenApiLog).map((call) => call.path)).toEqual([
      '/auth/v3/tenant_access_token/internal',
      '/wiki/v2/spaces/get_node',
      `/bitable/v1/apps/resolved-test-token/tables/${FIXED_TABLE_ID}/fields`,
    ]);
  });

  it('fails closed through OpenAPI when a required field is missing without writing', () => {
    writeFileSync(
      fakeState,
      JSON.stringify(completeFields().slice(0, -1)),
      'utf8',
    );

    const result = run(
      ['--dry-run', '--require-ready'],
      cliEnvironment({
        LARK_CLI_BIN: join(tempDir, 'lark-cli-does-not-exist'),
        FEISHU_OVERTIME_APP_TOKEN: 'self-contained-base-token',
      }),
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('缺少加班工作流字段');
    expect(readCalls(fakeLog)).toEqual([]);
    const calls = readOpenApiCalls(fakeOpenApiLog);
    expect(calls.map((call) => call.method)).toEqual(['POST', 'GET']);
    expect(calls.some((call) => call.path.includes('field-create'))).toBe(
      false,
    );
  });

  it('redacts credentials from self-contained OpenAPI failures', () => {
    writeFileSync(fakeMode, 'openapi-fail-with-auth', 'utf8');

    const result = run(
      ['--dry-run', '--require-ready'],
      cliEnvironment({
        LARK_CLI_BIN: join(tempDir, 'lark-cli-does-not-exist'),
        FEISHU_OVERTIME_APP_TOKEN: 'self-contained-base-token',
      }),
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).not.toContain(TEST_FEISHU_APP_ID);
    expect(result.stderr).not.toContain(TEST_FEISHU_APP_SECRET);
    expect(readCalls(fakeLog)).toEqual([]);
    expect(readOpenApiCalls(fakeOpenApiLog)).toHaveLength(1);
  });

  it.each(['openapi-empty-page-token', 'openapi-repeat-page-token'])(
    'fails closed on unsafe field pagination: %s',
    (mode) => {
      writeFileSync(fakeState, JSON.stringify(completeFields()), 'utf8');
      writeFileSync(fakeMode, mode, 'utf8');

      const result = run(
        ['--dry-run', '--require-ready'],
        cliEnvironment({
          LARK_CLI_BIN: join(tempDir, 'lark-cli-does-not-exist'),
          FEISHU_OVERTIME_APP_TOKEN: 'self-contained-base-token',
        }),
      );

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('分页');
      expect(readCalls(fakeLog)).toEqual([]);
      expect(
        readOpenApiCalls(fakeOpenApiLog).every(
          (call) => call.method === 'POST' || call.method === 'GET',
        ),
      ).toBe(true);
    },
  );

  it('supports a non-writing readiness gate that fails while fields are missing', () => {
    const partialFieldFile = join(tempDir, 'gate-partial.json');
    const completeFieldFile = join(tempDir, 'gate-complete.json');
    writeFileSync(partialFieldFile, '[]', 'utf8');
    writeFileSync(
      completeFieldFile,
      JSON.stringify(
        REQUIRED_FIELDS.map((field) => ({
          name: field.name,
          type: field.type,
          ...(field.type === 'user' || field.type === 'select'
            ? { multiple: false }
            : {}),
        })),
      ),
      'utf8',
    );

    const missing = run([
      '--dry-run',
      '--require-ready',
      '--field-list-file',
      partialFieldFile,
    ]);
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toContain('缺少加班工作流字段');

    const ready = run([
      '--dry-run',
      '--require-ready',
      '--field-list-file',
      completeFieldFile,
    ]);
    expect(ready.status).toBe(0);
    expect(parseOutput(ready.stdout)).toEqual({
      success: true,
      dryRun: true,
      existing: REQUIRED_FIELDS.map((field) => field.name),
      created: [],
    });
    expect(readCalls(fakeLog)).toEqual([]);
  });

  it('applies all eight fields once to the fixed overtime table and is idempotent', () => {
    const env = cliEnvironment();

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
      ...REQUIRED_FIELDS.map(() => '+field-create'),
    ]);
    expect(
      firstCalls
        .filter((call) => commandName(call) === '+field-create')
        .map((call) => call.payload),
    ).toEqual(
      REQUIRED_FIELDS.map((field) =>
        field.type === 'select'
          ? {
              name: field.name,
              type: field.type,
              multiple: field.multiple,
              options: field.options.map((name) => ({ name })),
            }
          : field.type === 'user'
            ? {
                name: field.name,
                type: field.type,
                multiple: field.multiple,
              }
            : {
                name: field.name,
                type: field.type,
                ...(field.type === 'datetime'
                  ? { style: { format: 'yyyy-MM-dd HH:mm' } }
                  : {}),
              },
      ),
    );
    for (const call of firstCalls.filter((entry) =>
      ['+field-list', '+field-create'].includes(commandName(entry)),
    )) {
      expect(argumentValue(call.args, '--table-id')).toBe(FIXED_TABLE_ID);
    }

    const second = run(['--apply'], env);

    expect(second.status).toBe(0);
    expect(parseOutput(second.stdout)).toEqual({
      success: true,
      dryRun: false,
      existing: REQUIRED_FIELDS.map((field) => field.name),
      created: [],
    });
    expect(
      readCalls(fakeLog).filter(
        (call) => commandName(call) === '+field-create',
      ),
    ).toHaveLength(REQUIRED_FIELDS.length);
  });

  it.each([
    [{ name: '加班工作流状态', type: 'text' }, '加班工作流状态'],
    [
      { name: '加班工作流状态', type: 'select', multiple: true },
      '加班工作流状态',
    ],
    [{ name: '加班审批人', type: 'text' }, '加班审批人'],
    [{ name: '加班审批人', type: 'user', multiple: true }, '加班审批人'],
    [{ name: '加班审批时间', type: 'text' }, '加班审批时间'],
    [{ name: '加班工作流错误', type: 'number' }, '加班工作流错误'],
  ])(
    'refuses a wrong same-name field without creating or mutating it',
    (field, label) => {
      writeFileSync(fakeState, JSON.stringify([field]), 'utf8');

      const result = run(['--apply'], cliEnvironment());

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(label);
      expect(result.stderr).toContain('类型或配置不符');
      expect(readCalls(fakeLog).map(commandName)).toEqual([
        '+url-resolve',
        '+field-list',
      ]);
      expect(JSON.parse(readFileSync(fakeState, 'utf8'))).toEqual([field]);
    },
  );

  it('supports the existing leave/overtime configuration aliases', () => {
    const source = existsSync(script) ? readFileSync(script, 'utf8') : '';

    expect(source).toContain('FEISHU_LEAVE_SUBSTITUTE_SOURCE_URL');
    expect(source).toContain('FEISHU_LEAVE_REQUEST_SOURCE_URL');
    expect(source).toContain('FEISHU_OVERTIME_APP_TOKEN');
    expect(source).toContain('FEISHU_OVERTIME_TABLE_ID');
    expect(source).toContain('FEISHU_LEAVE_SUBSTITUTE_APP_TOKEN');
    expect(source).toContain('FEISHU_LEAVE_REQUEST_APP_TOKEN');
    expect(source).toContain('FEISHU_MAIN_APP_TOKEN');
    expect(source).toContain('FEISHU_BITABLE_APP_TOKEN');
    expect(source).toContain('FEISHU_LEAVE_SUBSTITUTE_TABLE_ID');
    expect(source).toContain('FEISHU_LEAVE_REQUEST_TABLE_ID');
    expect(source).toContain(FIXED_TABLE_ID);
    expect(source).toContain("'+url-resolve'");
  });

  it('uses an explicit app token without resolving the Wiki source', () => {
    const result = run(
      ['--apply'],
      cliEnvironment({
        FEISHU_LEAVE_SUBSTITUTE_SOURCE_URL: '',
        FEISHU_LEAVE_REQUEST_APP_TOKEN: 'configured-base-token',
      }),
    );

    expect(result.status).toBe(0);
    expect(readCalls(fakeLog).map(commandName)[0]).toBe('+field-list');
  });

  it('passes only runtime and bot OAuth environment and redacts echoed credentials', () => {
    const allowedNames = new Set(
      [
        ...CHILD_ENV_ALLOWLIST,
        ...(process.platform === 'win32'
          ? WINDOWS_INJECTED_CHILD_ENV_NAMES
          : []),
      ].map((name) => name.toLowerCase()),
    );
    writeFileSync(fakeMode, 'fail-with-auth', 'utf8');

    const result = run(
      ['--apply'],
      cliEnvironment({
        UNRELATED_SHOULD_NOT_LEAK: 'private-parent-value',
        COS_SECRET_KEY: 'private-cos-secret-value',
      }),
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('[redacted');
    expect(result.stderr).not.toContain(TEST_FEISHU_APP_ID);
    expect(result.stderr).not.toContain(TEST_FEISHU_APP_SECRET);
    const calls = readCalls(fakeLog);
    expect(calls).toHaveLength(1);
    expect(calls[0].credentials).toEqual({ appId: true, appSecret: true });
    expect(calls[0].env.UNRELATED_SHOULD_NOT_LEAK).toBeUndefined();
    expect(calls[0].env.COS_SECRET_KEY).toBeUndefined();
    expect(
      Object.keys(calls[0].env).filter(
        (name) => !allowedNames.has(name.toLowerCase()),
      ),
    ).toEqual([]);
  });
});

interface FakeLarkCall {
  args: string[];
  env: Record<string, string>;
  credentials: { appId: boolean; appSecret: boolean };
  payload?: Record<string, unknown>;
}

function run(args: string[], env: NodeJS.ProcessEnv = isolatedEnvironment()) {
  return spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    env,
  });
}

function cliEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return isolatedEnvironment({
    LARK_CLI_BIN: fakeCliPath,
    LARK_OPENAPI_BASE_URL: fakeOpenApiBaseUrl,
    FEISHU_APP_ID: TEST_FEISHU_APP_ID,
    FEISHU_APP_SECRET: TEST_FEISHU_APP_SECRET,
    FEISHU_LEAVE_SUBSTITUTE_SOURCE_URL:
      'https://example.feishu.cn/wiki/PUBLIC_EXAMPLE_SOURCE',
    FEISHU_LEAVE_SUBSTITUTE_TABLE_ID: FIXED_TABLE_ID,
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

interface FakeOpenApiCall {
  method: string;
  path: string;
  search: string;
  credentials: { appId: boolean; appSecret: boolean };
  authorized: boolean;
}

function readOpenApiCalls(path: string): FakeOpenApiCall[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as FakeOpenApiCall);
}

function completeFields() {
  return REQUIRED_FIELDS.map((field) => ({
    name: field.name,
    type: field.type,
    ...(field.type === 'user' || field.type === 'select'
      ? { multiple: false }
      : {}),
  }));
}

function waitForOpenApiServer(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('fake OpenAPI server did not start'));
    }, 10_000);
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`fake OpenAPI server exited early: ${code}`));
    });
    child.stdout?.once('data', (chunk) => {
      clearTimeout(timer);
      resolve(String(chunk).trim());
    });
  });
}

function waitForChildExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 5_000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
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
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const statePath = resolve(root, 'fake-fields.json');
const logPath = resolve(root, 'fake-calls.jsonl');
const modePath = resolve(root, 'fake-mode.txt');
const args = process.argv.slice(2);
const command = args.find((argument) => argument.startsWith('+')) || '';
let payload;

if (command === '+field-create') {
  const jsonIndex = args.indexOf('--json');
  const reference = jsonIndex >= 0 ? args[jsonIndex + 1] || '' : '';
  if (!reference.startsWith('@')) fail('missing JSON argument file', 19);
  payload = JSON.parse(
    readFileSync(resolve(process.cwd(), reference.slice(1)), 'utf8'),
  );
}

const credentials = {
  appId: Boolean(process.env.FEISHU_APP_ID?.trim()),
  appSecret: Boolean(process.env.FEISHU_APP_SECRET?.trim()),
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

if (readFileSync(modePath, 'utf8').trim() === 'fail-with-auth') {
  process.stderr.write(
    (process.env.FEISHU_APP_ID || '') + ' | ' +
      (process.env.FEISHU_APP_SECRET || ''),
  );
  process.exit(16);
}
if (command === '+url-resolve') {
  process.stdout.write('{"data":{"base_token":"resolved-test-token"}}\\n');
  process.exit(0);
}
if (!['+field-list', '+field-create'].includes(command)) {
  fail('unexpected fake command', 18);
}
if (argumentValue('--table-id') !== '${FIXED_TABLE_ID}') {
  fail('unexpected table id', 20);
}

const state = JSON.parse(readFileSync(statePath, 'utf8'));
if (command === '+field-list') {
  process.stdout.write(JSON.stringify({ data: { fields: state } }) + '\\n');
  process.exit(0);
}
state.push(payload);
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

function fakeOpenApiSource(): string {
  return `
import { appendFileSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';

const [statePath, modePath, logPath] = process.argv.slice(2);
const server = createServer(async (request, response) => {
  const url = new URL(request.url || '/', 'http://127.0.0.1');
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const rawBody = Buffer.concat(chunks).toString('utf8');
  let body = {};
  try { body = rawBody ? JSON.parse(rawBody) : {}; } catch {}
  appendFileSync(
    logPath,
    JSON.stringify({
      method: request.method || '',
      path: url.pathname,
      search: url.search,
      credentials: {
        appId: Boolean(body.app_id),
        appSecret: Boolean(body.app_secret),
      },
      authorized: request.headers.authorization === 'Bearer test-tenant-token',
    }) + '\\n',
    'utf8',
  );

  const mode = readFileSync(modePath, 'utf8').trim();
  if (
    mode === 'openapi-fail-with-auth' &&
    url.pathname === '/auth/v3/tenant_access_token/internal'
  ) {
    return send(response, 401, {
      code: 999,
      msg: String(body.app_id || '') + ' | ' + String(body.app_secret || ''),
    });
  }
  if (url.pathname === '/auth/v3/tenant_access_token/internal') {
    return send(response, 200, {
      code: 0,
      tenant_access_token: 'test-tenant-token',
      expire: 7200,
    });
  }
  if (url.pathname === '/wiki/v2/spaces/get_node') {
    return send(response, 200, {
      code: 0,
      data: { node: { obj_type: 'bitable', obj_token: 'resolved-test-token' } },
    });
  }
  if (url.pathname.endsWith('/fields') && request.method === 'GET') {
    if (mode === 'openapi-empty-page-token') {
      return send(response, 200, {
        code: 0,
        data: { items: [], has_more: true, page_token: '' },
      });
    }
    if (mode === 'openapi-repeat-page-token') {
      return send(response, 200, {
        code: 0,
        data: { items: [], has_more: true, page_token: 'repeated-token' },
      });
    }
    return send(response, 200, {
      code: 0,
      data: {
        items: JSON.parse(readFileSync(statePath, 'utf8')),
        has_more: false,
      },
    });
  }
  return send(response, 405, { code: 405, msg: 'unexpected request' });
});

server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  process.stdout.write(
    'http://127.0.0.1:' + String(address.port) + '\\n',
  );
});

function send(response, status, payload) {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(payload));
}
`;
}
