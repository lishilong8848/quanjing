import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ChildProcess, spawn, spawnSync } from 'node:child_process';

const script = resolve(
  process.cwd(),
  'scripts/ensure-leave-workflow-fields.mjs',
);
const tableId = 'tblf1bbd02a2b049';
const requiredFields = [
  { name: '\u5ba1\u6279\u6765\u6e90', type: 'select', multiple: false },
  {
    name: '\u8bf7\u5047\u5de5\u4f5c\u6d41\u72b6\u6001',
    type: 'select',
    multiple: false,
  },
  {
    name: '\u8bf7\u5047\u5f53\u524d\u5ba1\u6279\u4eba',
    type: 'user',
    multiple: true,
  },
  {
    name: '\u8bf7\u5047\u5b9e\u9645\u5ba1\u6279\u4eba',
    type: 'user',
    multiple: true,
  },
  {
    name: '\u8bf7\u5047\u5ba1\u6279\u65f6\u95f4',
    type: 'datetime',
    multiple: false,
  },
  {
    name: '\u8bf7\u5047\u5ba1\u6279\u7b56\u7565\u7248\u672c',
    type: 'text',
    multiple: false,
  },
  {
    name: '\u8bf7\u5047\u5de5\u4f5c\u6d41\u9519\u8bef',
    type: 'text',
    multiple: false,
  },
  {
    name: '\u4f11\u5047\u4eba\u5458\u59d3\u540d\uff08\u7a0b\u5e8f\uff09',
    type: 'text',
    multiple: false,
  },
  {
    name: '\u8bf7\u5047\u9a73\u56de\u539f\u56e0',
    type: 'text',
    multiple: false,
  },
  {
    name: '\u66ff\u73ed\u8c03\u6574\u7248\u672c',
    type: 'number',
    multiple: false,
  },
  { name: '替班安排', type: 'text', multiple: false },
  { name: '\u66ff\u73ed\u8c03\u6574\u4eba', type: 'user', multiple: false },
  {
    name: '\u66ff\u73ed\u8c03\u6574\u65f6\u95f4',
    type: 'datetime',
    multiple: false,
  },
];

describe('ensure leave workflow fields', () => {
  let tempDir = '';
  let server: ChildProcess | undefined;
  let openApiBaseUrl = '';
  let openApiLog = '';
  let openApiState = '';

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'leave-fields-openapi-'));
    const serverPath = join(tempDir, 'fake-openapi.mjs');
    openApiLog = join(tempDir, 'openapi-calls.jsonl');
    openApiState = join(tempDir, 'openapi-fields.json');
    writeFileSync(openApiState, JSON.stringify(requiredFields), 'utf8');
    writeFileSync(serverPath, fakeOpenApiSource(), 'utf8');
    server = spawn(process.execPath, [serverPath, openApiLog, openApiState], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    openApiBaseUrl = await waitForServer(server);
  });

  afterAll(async () => {
    server?.kill();
    await waitForExit(server);
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  it('checks the fixed leave table through OpenAPI without a global lark CLI', () => {
    const result = spawnSync(process.execPath, [script, '--require-ready'], {
      encoding: 'utf8',
      windowsHide: true,
      env: {
        ...process.env,
        LARK_CLI_BIN: join(tempDir, 'lark-cli-does-not-exist.exe'),
        LARK_OPENAPI_BASE_URL: openApiBaseUrl,
        FEISHU_APP_ID: 'test-app-id',
        FEISHU_APP_SECRET: 'test-app-secret',
        FEISHU_LEAVE_REQUEST_APP_TOKEN: 'test-base-token',
        FEISHU_LEAVE_REQUEST_TABLE_ID: tableId,
      },
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject({
      success: true,
      dryRun: true,
      tableId,
      existing: requiredFields.map((field) => field.name),
      created: [],
      missing: [],
    });
    expect(
      readCalls(openApiLog).map(({ method, path }) => ({ method, path })),
    ).toEqual([
      { method: 'POST', path: '/auth/v3/tenant_access_token/internal' },
      {
        method: 'GET',
        path: `/bitable/v1/apps/test-base-token/tables/${tableId}/fields`,
      },
    ]);
  });

  it('creates missing fields through OpenAPI with native Bitable field payloads', () => {
    writeFileSync(openApiState, '[]', 'utf8');
    writeFileSync(openApiLog, '', 'utf8');

    const result = spawnSync(process.execPath, [script, '--apply'], {
      encoding: 'utf8',
      windowsHide: true,
      env: {
        ...process.env,
        LARK_CLI_BIN: join(tempDir, 'lark-cli-does-not-exist.exe'),
        LARK_OPENAPI_BASE_URL: openApiBaseUrl,
        FEISHU_APP_ID: 'test-app-id',
        FEISHU_APP_SECRET: 'test-app-secret',
        FEISHU_LEAVE_REQUEST_APP_TOKEN: 'test-base-token',
        FEISHU_LEAVE_REQUEST_TABLE_ID: tableId,
      },
    });

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      success: true,
      dryRun: false,
      existing: [],
      created: requiredFields.map((field) => field.name),
      missing: [],
    });
    const createCalls = readCalls(openApiLog).filter(
      (call) => call.method === 'POST' && call.path.endsWith('/fields'),
    );
    expect(createCalls.map((call) => call.body)).toEqual([
      {
        field_name: requiredFields[0].name,
        type: 3,
        property: {
          options: [
            { name: '\u98de\u4e66\u5de5\u4f5c\u6d41' },
            { name: '\u7a0b\u5e8f\u5361\u7247' },
          ],
        },
      },
      {
        field_name: requiredFields[1].name,
        type: 3,
        property: {
          options: [
            '\u5f85\u8def\u7531',
            '\u5f85\u4e3b\u7ba1\u5ba1\u6279',
            '\u5f85\u7ecf\u7406\u5ba1\u6279',
            '\u5df2\u5ba1\u6279',
            '\u5df2\u9a73\u56de',
            '\u540c\u6b65\u5f02\u5e38',
          ].map((name) => ({ name })),
        },
      },
      {
        field_name: requiredFields[2].name,
        type: 11,
        property: { multiple: true },
      },
      {
        field_name: requiredFields[3].name,
        type: 11,
        property: { multiple: true },
      },
      {
        field_name: requiredFields[4].name,
        type: 5,
        property: { date_formatter: 'yyyy-MM-dd HH:mm' },
      },
      { field_name: requiredFields[5].name, type: 1 },
      { field_name: requiredFields[6].name, type: 1 },
      { field_name: requiredFields[7].name, type: 1 },
      { field_name: requiredFields[8].name, type: 1 },
      { field_name: requiredFields[9].name, type: 2 },
      { field_name: requiredFields[10].name, type: 1 },
      {
        field_name: requiredFields[11].name,
        type: 11,
        property: { multiple: false },
      },
      {
        field_name: requiredFields[12].name,
        type: 5,
        property: { date_formatter: 'yyyy-MM-dd HH:mm' },
      },
    ]);
  });

  it('creates the shift-detail relation fields with native relation payloads', () => {
    writeFileSync(
      openApiState,
      JSON.stringify({
        mainFields: requiredFields,
        tables: [
          { table_id: 'tbl_leave_shift_detail', name: '请假替班班次明细' },
        ],
        detailFields: [],
      }),
      'utf8',
    );
    writeFileSync(openApiLog, '', 'utf8');

    const result = spawnSync(
      process.execPath,
      [script, '--with-shift-details', '--apply'],
      {
        encoding: 'utf8',
        windowsHide: true,
        env: {
          ...process.env,
          LARK_OPENAPI_BASE_URL: openApiBaseUrl,
          FEISHU_APP_ID: 'test-app-id',
          FEISHU_APP_SECRET: 'test-app-secret',
          FEISHU_LEAVE_REQUEST_APP_TOKEN: 'test-base-token',
          FEISHU_LEAVE_REQUEST_TABLE_ID: tableId,
          FEISHU_LEAVE_SHIFT_DETAIL_TABLE_ID: 'tbl_leave_shift_detail',
          FEISHU_SCHEDULE_TABLE_ID: 'tbl_duty',
          FEISHU_ACTIVE_PERSONNEL_TABLE_ID: 'tbl_personnel',
        },
      },
    );

    expect(result.status).toBe(0);
    const relationCalls = readCalls(openApiLog).filter(
      (call) =>
        call.method === 'POST' &&
        call.path.endsWith('/tbl_leave_shift_detail/fields') &&
        call.body?.type === 18,
    );
    expect(relationCalls.map((call) => call.body)).toContainEqual({
      field_name: '请假主记录',
      type: 18,
      ui_type: 'SingleLink',
      property: {
        table_id: tableId,
        multiple: false,
      },
    });
    expect(relationCalls.map((call) => call.body?.field_name)).toEqual([
      '请假主记录',
      '排班记录',
    ]);
    expect(JSON.parse(result.stdout)).toMatchObject({
      shiftDetails: {
        tableId: 'tbl_leave_shift_detail',
        tableCreated: false,
        missing: [],
      },
    });
  });

  it('creates a missing shift-detail table without an empty fields payload', () => {
    writeFileSync(
      openApiState,
      JSON.stringify({
        mainFields: requiredFields,
        tables: [],
        detailFields: [],
      }),
      'utf8',
    );
    writeFileSync(openApiLog, '', 'utf8');

    const result = spawnSync(
      process.execPath,
      [script, '--with-shift-details', '--apply'],
      {
        encoding: 'utf8',
        windowsHide: true,
        env: {
          ...process.env,
          LARK_OPENAPI_BASE_URL: openApiBaseUrl,
          FEISHU_APP_ID: 'test-app-id',
          FEISHU_APP_SECRET: 'test-app-secret',
          FEISHU_LEAVE_REQUEST_APP_TOKEN: 'test-base-token',
          FEISHU_LEAVE_REQUEST_TABLE_ID: tableId,
          FEISHU_LEAVE_SHIFT_DETAIL_TABLE_ID: '',
          FEISHU_SCHEDULE_TABLE_ID: 'tbl_duty',
          FEISHU_ACTIVE_PERSONNEL_TABLE_ID: 'tbl_personnel',
        },
      },
    );

    expect(result.status).toBe(0);
    expect(
      readCalls(openApiLog).find(
        (call) =>
          call.method === 'POST' &&
          call.path === '/bitable/v1/apps/test-base-token/tables',
      )?.body,
    ).toEqual({
      table: {
        name: '请假替班班次明细',
      },
    });
    expect(JSON.parse(result.stdout)).toMatchObject({
      shiftDetails: {
        tableId: 'tbl_leave_shift_detail',
        tableCreated: true,
        missing: [],
      },
    });
  });

  it('reports the safe OpenAPI error code and message when table creation fails', () => {
    writeFileSync(
      openApiState,
      JSON.stringify({
        mainFields: requiredFields,
        tables: [],
        detailFields: [],
        rejectTableCreate: {
          code: 1254302,
          msg: 'permission denied',
        },
      }),
      'utf8',
    );
    writeFileSync(openApiLog, '', 'utf8');

    const result = spawnSync(
      process.execPath,
      [script, '--with-shift-details', '--apply'],
      {
        encoding: 'utf8',
        windowsHide: true,
        env: {
          ...process.env,
          LARK_OPENAPI_BASE_URL: openApiBaseUrl,
          FEISHU_APP_ID: 'test-app-id',
          FEISHU_APP_SECRET: 'test-app-secret',
          FEISHU_LEAVE_REQUEST_APP_TOKEN: 'test-base-token',
          FEISHU_LEAVE_REQUEST_TABLE_ID: tableId,
          FEISHU_LEAVE_SHIFT_DETAIL_TABLE_ID: '',
          FEISHU_SCHEDULE_TABLE_ID: 'tbl_duty',
          FEISHU_ACTIVE_PERSONNEL_TABLE_ID: 'tbl_personnel',
        },
      },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      '飞书 OpenAPI 拒绝请求：创建多维表：请假替班班次明细（code=1254302，msg=permission denied）',
    );
    expect(result.stderr).not.toContain('test-tenant-token');
    expect(result.stderr).not.toContain('test-app-secret');
  });
});

function readCalls(path: string): Array<{
  method: string;
  path: string;
  body?: Record<string, unknown>;
}> {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split(/\r?\n/u)
    .filter(Boolean)
    .map(
      (line) =>
        JSON.parse(line) as {
          method: string;
          path: string;
          body?: Record<string, unknown>;
        },
    );
}

function waitForServer(child: ChildProcess): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(
      () => rejectPromise(new Error('fake OpenAPI server did not start')),
      10_000,
    );
    child.once('exit', (code) => {
      clearTimeout(timer);
      rejectPromise(new Error(`fake OpenAPI server exited early: ${code}`));
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

function fakeOpenApiSource(): string {
  return `
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';

const [logPath, statePath] = process.argv.slice(2);
const server = createServer(async (request, response) => {
  const url = new URL(request.url || '/', 'http://127.0.0.1');
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const rawBody = Buffer.concat(chunks).toString('utf8');
  let body;
  try { body = rawBody ? JSON.parse(rawBody) : undefined; } catch {}
  appendFileSync(
    logPath,
    JSON.stringify({ method: request.method || '', path: url.pathname, body }) + '\\n',
    'utf8',
  );

  if (url.pathname === '/auth/v3/tenant_access_token/internal') {
    return send(response, 200, {
      code: 0,
      tenant_access_token: 'test-tenant-token',
      expire: 7200,
    });
  }
  if (
    url.pathname === '/bitable/v1/apps/test-base-token/tables/${tableId}/fields' &&
    request.method === 'GET'
  ) {
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    return send(response, 200, {
      code: 0,
      data: { items: Array.isArray(state) ? state : state.mainFields, has_more: false },
    });
  }
  if (
    url.pathname === '/bitable/v1/apps/test-base-token/tables/${tableId}/fields' &&
    request.method === 'POST'
  ) {
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    const fields = Array.isArray(state) ? state : state.mainFields;
    fields.push(body);
    writeFileSync(statePath, JSON.stringify(Array.isArray(state) ? fields : state), 'utf8');
    return send(response, 200, { code: 0, data: { field: body } });
  }
  if (
    url.pathname === '/bitable/v1/apps/test-base-token/tables' &&
    request.method === 'GET'
  ) {
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    return send(response, 200, {
      code: 0,
      data: { items: state.tables || [], has_more: false },
    });
  }
  if (
    url.pathname === '/bitable/v1/apps/test-base-token/tables' &&
    request.method === 'POST'
  ) {
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    if (state.rejectTableCreate) {
      return send(response, 403, state.rejectTableCreate);
    }
    const table = {
      table_id: 'tbl_leave_shift_detail',
      name: body?.table?.name || '',
    };
    state.tables = [...(state.tables || []), table];
    writeFileSync(statePath, JSON.stringify(state), 'utf8');
    return send(response, 200, { code: 0, data: { table } });
  }
  if (
    url.pathname === '/bitable/v1/apps/test-base-token/tables/tbl_leave_shift_detail/fields' &&
    request.method === 'GET'
  ) {
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    return send(response, 200, {
      code: 0,
      data: { items: state.detailFields || [], has_more: false },
    });
  }
  if (
    url.pathname === '/bitable/v1/apps/test-base-token/tables/tbl_leave_shift_detail/fields' &&
    request.method === 'POST'
  ) {
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    state.detailFields = state.detailFields || [];
    state.detailFields.push(body);
    writeFileSync(statePath, JSON.stringify(state), 'utf8');
    return send(response, 200, { code: 0, data: { field: body } });
  }
  return send(response, 404, { code: 404, msg: 'unexpected request' });
});

server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  process.stdout.write('http://127.0.0.1:' + String(address.port) + '\\n');
});

function send(response, status, payload) {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(payload));
}
`;
}
