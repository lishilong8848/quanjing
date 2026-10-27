import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(__dirname, '../..');
const SCRIPT = resolve(
  ROOT,
  'scripts/ensure-inventory-outbound-approval-fields.mjs',
);
const TABLE_ID = 'tblOutboundApprovalTest';
let tempDir = '';
let fakeState = '';
let fakeLog = '';
let fakeServerScript = '';
let fakeServer: ChildProcess | undefined;
let fakeOpenApiBaseUrl = '';
const REQUIRED_FIELDS = [
  {
    name: '出库工作流状态',
    type: 3,
    multiple: false,
    options: ['待路由', '待审批', '已通过', '已驳回', '同步异常'],
  },
  { name: '出库当前审批人', type: 11, multiple: true },
  { name: '出库实际审批人', type: 11, multiple: false },
  { name: '出库审批时间', type: 5 },
  { name: '出库审批策略版本', type: 1 },
  { name: '出库驳回原因', type: 1 },
  { name: '出库审批动作标识', type: 1 },
  { name: '出库工作流错误', type: 1 },
  { name: '出库审批快照', type: 1 },
  { name: '出库审批投递台账', type: 1 },
  {
    name: '出库审批收尾状态',
    type: 3,
    multiple: false,
    options: ['待收尾', '已完成'],
  },
  { name: '出库审批结果投递台账', type: 1 },
] as const;

describe('ensure-inventory-outbound-approval-fields', () => {
  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'inventory-outbound-fields-'));
    fakeState = join(tempDir, 'fields.json');
    fakeLog = join(tempDir, 'calls.jsonl');
    fakeServerScript = join(tempDir, 'fake-openapi.mjs');
    writeFileSync(fakeState, '[]', 'utf8');
    writeFileSync(fakeLog, '', 'utf8');
    writeFileSync(fakeServerScript, fakeOpenApiSource(), 'utf8');
    fakeServer = spawn(
      process.execPath,
      [fakeServerScript, fakeState, fakeLog],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );
    fakeOpenApiBaseUrl = await waitForServer(fakeServer);
  });

  beforeEach(() => {
    writeFileSync(fakeState, '[]', 'utf8');
    writeFileSync(fakeLog, '', 'utf8');
  });

  afterAll(async () => {
    fakeServer?.kill();
    await waitForExit(fakeServer);
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  it('passes a read-only readiness check only when all twelve fields are compatible', () => {
    const fieldFile = join(tempDir, 'ready-fields.json');
    writeFileSync(
      fieldFile,
      JSON.stringify([
        { field_name: '流程', type: 24, ui_type: 'Stage' },
        ...completeFields(),
      ]),
      'utf8',
    );

    const result = run([
      '--dry-run',
      '--require-ready',
      '--field-list-file',
      fieldFile,
    ]);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      success: true,
      dryRun: true,
      tableId: TABLE_ID,
      existing: REQUIRED_FIELDS.map((field) => field.name),
      created: [],
      missing: [],
    });
    expect(readCalls()).toEqual([]);
  });

  it('fails closed without writing when a required field is missing', () => {
    const fieldFile = join(tempDir, 'missing-fields.json');
    writeFileSync(
      fieldFile,
      JSON.stringify(completeFields().slice(0, -1)),
      'utf8',
    );

    const result = run([
      '--dry-run',
      '--require-ready',
      '--field-list-file',
      fieldFile,
    ]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('缺少出库审批工作流字段');
    expect(result.stderr).toContain('出库审批结果投递台账');
    expect(readCalls()).toEqual([]);
  });

  it('requires the dedicated outbound table id instead of trusting the generic source URL table parameter', () => {
    const fieldFile = join(tempDir, 'source-url-fields.json');
    writeFileSync(fieldFile, JSON.stringify(completeFields()), 'utf8');

    const result = run(
      ['--dry-run', '--require-ready', '--field-list-file', fieldFile],
      offlineEnvironment({
        FEISHU_WAREHOUSE_OUTBOUND_TABLE_ID: '',
        FEISHU_WAREHOUSE_SOURCE_URL:
          'https://vnet.feishu.cn/wiki/testWarehouse?table=tblGenericWrongTable',
      }),
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('FEISHU_WAREHOUSE_OUTBOUND_TABLE_ID');
    expect(readCalls()).toEqual([]);
  });

  it('rejects a status field whose options are a superset of the approved workflow states', () => {
    const fieldFile = join(tempDir, 'extra-status-option.json');
    const fields = completeFields();
    const statusField = fields[0] as unknown as {
      property: { options: Array<{ name: string }> };
    };
    statusField.property.options.push({ name: '遗留状态' });
    writeFileSync(fieldFile, JSON.stringify(fields), 'utf8');

    const result = run([
      '--dry-run',
      '--require-ready',
      '--field-list-file',
      fieldFile,
    ]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('出库工作流状态');
    expect(result.stderr).toContain('类型或配置不符');
    expect(readCalls()).toEqual([]);
  });

  it('rejects apply mode with an offline field-list snapshot before any I/O', () => {
    const fieldFile = join(tempDir, 'apply-offline-fields.json');
    writeFileSync(fieldFile, JSON.stringify(completeFields()), 'utf8');

    const result = run(['--apply', '--field-list-file', fieldFile]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      '--apply 不能与 --field-list-file 同时使用',
    );
    expect(readCalls()).toEqual([]);
  });

  it('rejects apply mode with the read-only readiness gate before any network request', () => {
    const result = run(['--apply', '--require-ready'], liveEnvironment());

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('--apply 不能与 --require-ready 同时使用');
    expect(readCalls()).toEqual([]);
  });

  it.each([
    [{ field_name: '出库工作流状态', type: 1 }, '出库工作流状态'],
    [
      {
        field_name: '出库工作流状态',
        type: 3,
        property: { multiple: true, options: [] },
      },
      '出库工作流状态',
    ],
    [
      {
        field_name: '出库当前审批人',
        type: 11,
        property: { multiple: false },
      },
      '出库当前审批人',
    ],
    [
      {
        field_name: '出库实际审批人',
        type: 11,
        property: { multiple: true },
      },
      '出库实际审批人',
    ],
    [{ field_name: '出库审批时间', type: 1 }, '出库审批时间'],
  ])('rejects an incompatible same-name field: %s', (field, name) => {
    const fieldFile = join(tempDir, 'wrong-field.json');
    writeFileSync(fieldFile, JSON.stringify([field]), 'utf8');

    const result = run([
      '--dry-run',
      '--require-ready',
      '--field-list-file',
      fieldFile,
    ]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(name);
    expect(result.stderr).toContain('类型或配置不符');
    expect(readCalls()).toEqual([]);
  });

  it('creates exactly the twelve approval fields, never the existing Stage field, and is idempotent', () => {
    writeFileSync(
      fakeState,
      JSON.stringify([{ field_name: '流程', type: 24, ui_type: 'Stage' }]),
      'utf8',
    );
    const first = run(['--apply'], liveEnvironment());

    expect(first.status).toBe(0);
    expect(JSON.parse(first.stdout)).toEqual({
      success: true,
      dryRun: false,
      tableId: TABLE_ID,
      existing: [],
      created: REQUIRED_FIELDS.map((field) => field.name),
      missing: [],
    });
    const createCalls = readCalls().filter(
      (call) => call.method === 'POST' && call.path.endsWith('/fields'),
    );
    expect(createCalls).toHaveLength(REQUIRED_FIELDS.length);
    expect(createCalls.map((call) => call.body.field_name)).toEqual(
      REQUIRED_FIELDS.map((field) => field.name),
    );
    expect(createCalls.some((call) => call.body.field_name === '流程')).toBe(
      false,
    );
    expect(createCalls.map((call) => call.body)).toEqual(
      REQUIRED_FIELDS.map(expectedOpenApiPayload),
    );

    const second = run(['--apply'], liveEnvironment());

    expect(second.status).toBe(0);
    expect(JSON.parse(second.stdout)).toEqual({
      success: true,
      dryRun: false,
      tableId: TABLE_ID,
      existing: REQUIRED_FIELDS.map((field) => field.name),
      created: [],
      missing: [],
    });
    expect(
      readCalls().filter(
        (call) => call.method === 'POST' && call.path.endsWith('/fields'),
      ),
    ).toHaveLength(REQUIRED_FIELDS.length);
  });

  it('registers explicit dry-run/check/apply commands and read-only startup gates in both launchers', () => {
    const packageJson = JSON.parse(
      readFileSync(resolve(ROOT, 'package.json'), 'utf8'),
    );
    expect(packageJson.scripts).toMatchObject({
      'migrate:inventory-outbound-approval-fields:dry-run':
        expect.stringContaining('--dry-run'),
      'migrate:inventory-outbound-approval-fields:check':
        expect.stringContaining('--dry-run --require-ready'),
      'migrate:inventory-outbound-approval-fields':
        expect.stringContaining('--apply'),
    });

    for (const launcher of ['start.ps1', 'deploy/start.ps1']) {
      const source = readFileSync(resolve(ROOT, launcher), 'utf8');
      expect(source).toContain(
        'function Assert-InventoryOutboundApprovalSchema',
      );
      expect(source).toContain(
        "@('run', 'migrate:inventory-outbound-approval-fields:check')",
      );
      expect(source).not.toContain(
        "@('run', 'migrate:inventory-outbound-approval-fields')",
      );
    }
  });
});

interface FakeOpenApiCall {
  method: string;
  path: string;
  body: Record<string, any>;
}

function run(args: string[], env: NodeJS.ProcessEnv = offlineEnvironment()) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true,
    env,
  });
}

function offlineEnvironment(overrides: NodeJS.ProcessEnv = {}) {
  return {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    FEISHU_WAREHOUSE_OUTBOUND_TABLE_ID: TABLE_ID,
    ...overrides,
  };
}

function liveEnvironment() {
  return offlineEnvironment({
    FEISHU_WAREHOUSE_APP_TOKEN: 'test-base-token',
    FEISHU_APP_ID: 'test-app-id',
    FEISHU_APP_SECRET: 'test-app-secret',
    LARK_OPENAPI_BASE_URL: fakeOpenApiBaseUrl,
  });
}

function completeFields() {
  return REQUIRED_FIELDS.map((field) => ({
    field_name: field.name,
    type: field.type,
    ...('multiple' in field
      ? {
          property: {
            multiple: field.multiple,
            ...('options' in field
              ? { options: field.options.map((name) => ({ name })) }
              : {}),
          },
        }
      : field.type === 5
        ? { property: { date_formatter: 'yyyy-MM-dd HH:mm' } }
        : {}),
  }));
}

function expectedOpenApiPayload(field: (typeof REQUIRED_FIELDS)[number]) {
  if (field.type === 3) {
    return {
      field_name: field.name,
      type: 3,
      property: {
        options: field.options.map((name) => ({ name })),
      },
    };
  }
  if (field.type === 11) {
    return {
      field_name: field.name,
      type: 11,
      property: { multiple: field.multiple },
    };
  }
  if (field.type === 5) {
    return {
      field_name: field.name,
      type: 5,
      property: { date_formatter: 'yyyy-MM-dd HH:mm' },
    };
  }
  return { field_name: field.name, type: 1 };
}

function readCalls(): FakeOpenApiCall[] {
  if (!existsSync(fakeLog)) return [];
  return readFileSync(fakeLog, 'utf8')
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as FakeOpenApiCall);
}

function waitForServer(child: ChildProcess): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(
      () => reject(new Error('fake OpenAPI server did not start')),
      10_000,
    );
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`fake OpenAPI server exited early: ${code}`));
    });
    child.stdout?.once('data', (chunk) => {
      clearTimeout(timer);
      resolvePromise(String(chunk).trim());
    });
  });
}

function waitForExit(child?: ChildProcess): Promise<void> {
  if (!child || child.exitCode !== null) return Promise.resolve();
  return new Promise((resolvePromise) => {
    const timer = setTimeout(resolvePromise, 5_000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolvePromise();
    });
  });
}

function fakeOpenApiSource() {
  return `
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';

const [statePath, logPath] = process.argv.slice(2);
const server = createServer(async (request, response) => {
  const url = new URL(request.url || '/', 'http://127.0.0.1');
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const rawBody = Buffer.concat(chunks).toString('utf8');
  let body = {};
  try { body = rawBody ? JSON.parse(rawBody) : {}; } catch {}
  appendFileSync(
    logPath,
    JSON.stringify({ method: request.method, path: url.pathname, body }) + '\\n',
    'utf8',
  );

  if (url.pathname === '/auth/v3/tenant_access_token/internal') {
    return send(response, 200, { code: 0, tenant_access_token: 'test-token' });
  }
  if (url.pathname.endsWith('/fields') && request.method === 'GET') {
    return send(response, 200, {
      code: 0,
      data: { items: JSON.parse(readFileSync(statePath, 'utf8')), has_more: false },
    });
  }
  if (url.pathname.endsWith('/fields') && request.method === 'POST') {
    if (
      Number(body.type) === 3 &&
      body.property &&
      Object.prototype.hasOwnProperty.call(body.property, 'multiple')
    ) {
      return send(response, 400, {
        code: 1254082,
        msg: 'SingleSelectFieldPropertyError',
      });
    }
    const fields = JSON.parse(readFileSync(statePath, 'utf8'));
    fields.push(body);
    writeFileSync(statePath, JSON.stringify(fields), 'utf8');
    return send(response, 200, { code: 0, data: { field: body } });
  }
  return send(response, 404, { code: 404, msg: 'unexpected request' });
});

server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  process.stdout.write('http://127.0.0.1:' + address.port + '\\n');
});

function send(response, status, payload) {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(payload));
}
`;
}
