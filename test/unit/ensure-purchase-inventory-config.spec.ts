import { spawn } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SCRIPT = resolve(
  __dirname,
  '../../scripts/ensure-purchase-inventory-config.mjs',
);

const CONFIG_KEYS = [
  'FEISHU_PURCHASE_INVENTORY_APP_TOKEN',
  'FEISHU_PURCHASE_SUBMISSION_TABLE_ID',
  'FEISHU_PURCHASE_EXECUTION_TABLE_ID',
  'FEISHU_ITEM_CATEGORY_TABLE_ID',
  'FEISHU_INVENTORY_LEDGER_TABLE_ID',
  'FEISHU_INBOUND_TABLE_ID',
  'FEISHU_OUTBOUND_TABLE_ID',
] as const;

const TABLES = [
  ['01-【物品类】采购提交', 'tbl_test_submission'],
  ['02-【物品类】采购进行', 'tbl_test_execution'],
  ['物品类别', 'tbl_test_catalog'],
  ['库存台账', 'tbl_test_inventory'],
  ['物品入库表', 'tbl_test_inbound'],
  ['物品出库表', 'tbl_test_outbound'],
] as const;

type MockHandler = (request: IncomingMessage, response: ServerResponse) => void;

describe('ensure-purchase-inventory-config.mjs', () => {
  const roots: string[] = [];

  afterEach(() => {
    while (roots.length) {
      rmSync(roots.pop()!, { recursive: true, force: true });
    }
  });

  it('exits without network access or file changes when all critical values exist', async () => {
    const root = createRoot();
    const original = [
      '# existing configuration',
      'UNRELATED_VALUE=keep-me',
      ...CONFIG_KEYS.map((key, index) => `${key}=configured_${index}`),
      '',
    ].join('\n');
    writeFileSync(join(root, '.env'), original, 'utf8');

    const result = await runScript(root);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('already complete');
    expect(result.stderr).toBe('');
    expect(readFileSync(join(root, '.env'), 'utf8')).toBe(original);
  });

  it('repairs missing and stale values in .env.local while preserving unrelated content', async () => {
    const root = createRoot();
    const secret = 'secret_must_never_be_printed';
    const staleToken = 'app_stale_must_never_be_printed';
    const sourceToken = 'app_source_must_never_be_printed';
    const envContent = [
      `FEISHU_APP_ID=cli_test_app`,
      `FEISHU_APP_SECRET=${secret}`,
      `FEISHU_PURCHASE_INVENTORY_SOURCE_URL=https://tenant.example/base/${sourceToken}?table=tbl_hint`,
      'UNRELATED_BASE=unchanged',
      '',
    ].join('\n');
    const localContent = [
      '# local overrides',
      'UNRELATED_LOCAL=keep-local',
      `FEISHU_PURCHASE_INVENTORY_APP_TOKEN=${staleToken}`,
      'FEISHU_PURCHASE_SUBMISSION_TABLE_ID=tbl_stale_submission',
      '',
    ].join('\r\n');
    writeFileSync(join(root, '.env'), envContent, 'utf8');
    writeFileSync(join(root, '.env.local'), localContent, 'utf8');

    const mock = await startMock((request, response) => {
      const url = new URL(request.url!, 'http://127.0.0.1');
      if (url.pathname.endsWith('/auth/v3/tenant_access_token/internal')) {
        return json(response, {
          code: 0,
          tenant_access_token: 'tenant_token_must_never_be_printed',
        });
      }
      if (url.pathname.includes(`/apps/${staleToken}/tables`)) {
        return json(response, tablePage([['Other table', 'tbl_other']]));
      }
      if (url.pathname.includes(`/apps/${sourceToken}/tables`)) {
        return json(response, tablePage(TABLES));
      }
      return json(response, { code: 404 }, 404);
    });

    const result = await runScript(root, mock.baseUrl);
    await mock.close();

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('repaired automatically');
    expect(result.stderr).toBe('');
    for (const sensitive of [
      secret,
      staleToken,
      sourceToken,
      ...TABLES.map(([, id]) => id),
    ]) {
      expect(result.stdout + result.stderr).not.toContain(sensitive);
    }
    expect(readFileSync(join(root, '.env'), 'utf8')).toBe(envContent);
    const updated = readFileSync(join(root, '.env.local'), 'utf8');
    expect(updated).toContain('# local overrides\r\n');
    expect(updated).toContain('UNRELATED_LOCAL=keep-local\r\n');
    expect(readValues(updated)).toMatchObject(expectedValues(sourceToken));
    expect(readdirSync(root).filter((name) => name.includes('.tmp'))).toEqual(
      [],
    );
  });

  it('checks a repairable Base read-only before smoke installation', async () => {
    const root = createRoot();
    const sourceToken = 'app_source_read_only';
    const original = [
      'FEISHU_APP_ID=cli_test_app',
      'FEISHU_APP_SECRET=secret_must_not_be_printed',
      `FEISHU_PURCHASE_INVENTORY_SOURCE_URL=https://tenant.example/base/${sourceToken}`,
      'KEEP=unchanged',
      '',
    ].join('\n');
    writeFileSync(join(root, '.env'), original, 'utf8');
    const mock = await startMock((request, response) => {
      const url = new URL(request.url!, 'http://127.0.0.1');
      if (url.pathname.endsWith('/auth/v3/tenant_access_token/internal')) {
        return json(response, {
          code: 0,
          tenant_access_token: 'tenant_token_must_not_be_printed',
        });
      }
      if (url.pathname.includes(`/apps/${sourceToken}/tables`)) {
        return json(response, tablePage(TABLES));
      }
      return json(response, { code: 404 }, 404);
    });

    const result = await runScript(root, mock.baseUrl, false, true);
    await mock.close();

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('read-only');
    expect(result.stdout + result.stderr).not.toContain(sourceToken);
    expect(result.stdout + result.stderr).not.toContain('secret_must_not_be_printed');
    expect(readFileSync(join(root, '.env'), 'utf8')).toBe(original);
    expect(readdirSync(root)).toEqual(['.env']);
  });

  it('discovers one matching Base through paginated Wiki spaces and nested nodes', async () => {
    const root = createRoot();
    writeFileSync(
      join(root, '.env'),
      'FEISHU_APP_ID=cli_test_app\nFEISHU_APP_SECRET=cli_test_secret\nKEEP=1\n',
      'utf8',
    );
    const goodToken = 'app_nested_match';
    const wrongToken = 'app_nested_wrong';
    const calls: string[] = [];
    const mock = await startMock((request, response) => {
      const url = new URL(request.url!, 'http://127.0.0.1');
      calls.push(`${url.pathname}?${url.searchParams.toString()}`);
      if (url.pathname.endsWith('/auth/v3/tenant_access_token/internal')) {
        return json(response, {
          code: 0,
          tenant_access_token: 'tenant_test_token',
        });
      }
      if (url.pathname.endsWith('/wiki/v2/spaces')) {
        if (!url.searchParams.get('page_token')) {
          return json(response, {
            code: 0,
            data: {
              items: [{ space_id: 'space_one' }],
              has_more: true,
              page_token: 'spaces_page_two',
            },
          });
        }
        return json(response, {
          code: 0,
          data: { items: [{ space_id: 'space_two' }], has_more: false },
        });
      }
      if (url.pathname.endsWith('/spaces/space_one/nodes')) {
        if (!url.searchParams.get('parent_node_token')) {
          return json(
            response,
            nodePage([
              {
                node_token: 'folder_parent',
                obj_type: 'docx',
                obj_token: 'doc_parent',
                has_child: true,
              },
            ]),
          );
        }
        return json(
          response,
          nodePage([
            {
              node_token: 'node_wrong',
              obj_type: 'bitable',
              obj_token: wrongToken,
              has_child: false,
            },
            {
              node_token: 'node_good',
              obj_type: 'bitable',
              obj_token: goodToken,
              has_child: false,
            },
          ]),
        );
      }
      if (url.pathname.endsWith('/spaces/space_two/nodes')) {
        return json(response, nodePage([]));
      }
      if (url.pathname.includes(`/apps/${wrongToken}/tables`)) {
        return json(response, tablePage([['Other table', 'tbl_other']]));
      }
      if (url.pathname.includes(`/apps/${goodToken}/tables`)) {
        return json(response, tablePage(TABLES));
      }
      return json(response, { code: 404 }, 404);
    });

    const result = await runScript(root, mock.baseUrl);
    await mock.close();

    expect(result.code).toBe(0);
    expect(readValues(readFileSync(join(root, '.env'), 'utf8'))).toMatchObject(
      expectedValues(goodToken),
    );
    expect(
      calls.some((call) => call.includes('page_token=spaces_page_two')),
    ).toBe(true);
    expect(
      calls.some((call) => call.includes('parent_node_token=folder_parent')),
    ).toBe(true);
  });

  it('resolves a configured Wiki source before falling back to global discovery', async () => {
    const root = createRoot();
    const wikiToken = 'wiki_source_token';
    const appToken = 'app_resolved_from_wiki';
    writeFileSync(
      join(root, '.env'),
      [
        'FEISHU_APP_ID=cli_test_app',
        'FEISHU_APP_SECRET=cli_test_secret',
        `FEISHU_PURCHASE_INVENTORY_SOURCE_URL=https://tenant.example/wiki/${wikiToken}`,
        '',
      ].join('\n'),
      'utf8',
    );
    let listedSpaces = false;
    const mock = await startMock((request, response) => {
      const url = new URL(request.url!, 'http://127.0.0.1');
      if (url.pathname.endsWith('/auth/v3/tenant_access_token/internal')) {
        return json(response, {
          code: 0,
          tenant_access_token: 'tenant_test_token',
        });
      }
      if (url.pathname.endsWith('/wiki/v2/spaces/get_node')) {
        return json(response, {
          code: 0,
          data: { node: { obj_type: 'bitable', obj_token: appToken } },
        });
      }
      if (url.pathname.includes(`/apps/${appToken}/tables`)) {
        return json(response, tablePage(TABLES));
      }
      if (url.pathname.endsWith('/wiki/v2/spaces')) listedSpaces = true;
      return json(response, { code: 404 }, 404);
    });

    const result = await runScript(root, mock.baseUrl);
    await mock.close();

    expect(result.code).toBe(0);
    expect(listedSpaces).toBe(false);
    expect(readValues(readFileSync(join(root, '.env'), 'utf8'))).toMatchObject(
      expectedValues(appToken),
    );
  });

  it('uses a trusted deployed contract source before attempting Wiki enumeration', async () => {
    const root = createRoot();
    const wikiToken = 'wiki_contract_file_candidate';
    const appToken = 'app_contract_file_match';
    writeFileSync(
      join(root, '.env'),
      'FEISHU_APP_ID=cli_test_app\nFEISHU_APP_SECRET=cli_test_secret\nKEEP=1\n',
      'utf8',
    );
    const contractDirectory = join(
      root,
      'dist/server/modules/contract-management',
    );
    mkdirSync(contractDirectory, { recursive: true });
    writeFileSync(
      join(contractDirectory, 'contract-management.service.js'),
      `const DEFAULT_SOURCE_URL = 'https://tenant.example/wiki/${wikiToken}?table=tbl_contract_hint';\n`,
      'utf8',
    );
    let listedSpaces = false;
    const mock = await startMock((request, response) => {
      const url = new URL(request.url!, 'http://127.0.0.1');
      if (url.pathname.endsWith('/auth/v3/tenant_access_token/internal')) {
        return json(response, {
          code: 0,
          tenant_access_token: 'tenant_test_token',
        });
      }
      if (url.pathname.endsWith('/wiki/v2/spaces/get_node')) {
        return json(response, {
          code: 0,
          data: { node: { obj_type: 'bitable', obj_token: appToken } },
        });
      }
      if (url.pathname.includes(`/apps/${appToken}/tables`)) {
        return json(response, tablePage(TABLES));
      }
      if (url.pathname.endsWith('/wiki/v2/spaces')) listedSpaces = true;
      return json(response, { code: 403 }, 403);
    });

    const result = await runScript(root, mock.baseUrl);
    await mock.close();

    expect(result.code).toBe(0);
    expect(listedSpaces).toBe(false);
    expect(readValues(readFileSync(join(root, '.env'), 'utf8'))).toMatchObject(
      expectedValues(appToken),
    );
    for (const sensitive of [
      wikiToken,
      appToken,
      ...TABLES.map(([, id]) => id),
    ]) {
      expect(result.stdout + result.stderr).not.toContain(sensitive);
    }
  });

  it('fails without changing files when more than one Wiki Base matches the signature', async () => {
    const root = createRoot();
    const original =
      'FEISHU_APP_ID=cli_test_app\nFEISHU_APP_SECRET=cli_test_secret\nKEEP=1\n';
    writeFileSync(join(root, '.env'), original, 'utf8');
    const matchingTokens = ['app_match_one', 'app_match_two'];
    const mock = await startMock((request, response) => {
      const url = new URL(request.url!, 'http://127.0.0.1');
      if (url.pathname.endsWith('/auth/v3/tenant_access_token/internal')) {
        return json(response, {
          code: 0,
          tenant_access_token: 'tenant_test_token',
        });
      }
      if (url.pathname.endsWith('/wiki/v2/spaces')) {
        return json(response, {
          code: 0,
          data: { items: [{ space_id: 'space_one' }], has_more: false },
        });
      }
      if (url.pathname.endsWith('/spaces/space_one/nodes')) {
        return json(
          response,
          nodePage(
            matchingTokens.map((obj_token, index) => ({
              node_token: `node_${index}`,
              obj_type: 'bitable',
              obj_token,
              has_child: false,
            })),
          ),
        );
      }
      if (
        matchingTokens.some((token) =>
          url.pathname.includes(`/apps/${token}/tables`),
        )
      ) {
        return json(response, tablePage(TABLES));
      }
      return json(response, { code: 404 }, 404);
    });

    const result = await runScript(root, mock.baseUrl);
    await mock.close();

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('more than one');
    expect(readFileSync(join(root, '.env'), 'utf8')).toBe(original);
  });

  it('rejects a Base when two prefixed tables normalize to the same business name', async () => {
    const root = createRoot();
    const appToken = 'app_ambiguous_tables';
    const original = [
      'FEISHU_APP_ID=cli_test_app',
      'FEISHU_APP_SECRET=cli_test_secret',
      `FEISHU_PURCHASE_INVENTORY_APP_TOKEN=${appToken}`,
      '',
    ].join('\n');
    writeFileSync(join(root, '.env'), original, 'utf8');
    const mock = await startMock((request, response) => {
      const url = new URL(request.url!, 'http://127.0.0.1');
      if (url.pathname.endsWith('/auth/v3/tenant_access_token/internal')) {
        return json(response, {
          code: 0,
          tenant_access_token: 'tenant_test_token',
        });
      }
      if (url.pathname.includes(`/apps/${appToken}/tables`)) {
        return json(
          response,
          tablePage([
            ...TABLES,
            ['99-【备用类】采购提交', 'tbl_duplicate_submission'],
          ]),
        );
      }
      if (url.pathname.endsWith('/wiki/v2/spaces')) {
        return json(response, {
          code: 0,
          data: { items: [], has_more: false },
        });
      }
      return json(response, { code: 404 }, 404);
    });

    const result = await runScript(root, mock.baseUrl);
    await mock.close();

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('six-table');
    expect(readFileSync(join(root, '.env'), 'utf8')).toBe(original);
  });

  it('stops repeated pagination tokens instead of looping forever', async () => {
    const root = createRoot();
    writeFileSync(
      join(root, '.env'),
      'FEISHU_APP_ID=cli_test_app\nFEISHU_APP_SECRET=cli_test_secret\n',
      'utf8',
    );
    let spaceCalls = 0;
    const mock = await startMock((request, response) => {
      const url = new URL(request.url!, 'http://127.0.0.1');
      if (url.pathname.endsWith('/auth/v3/tenant_access_token/internal')) {
        return json(response, {
          code: 0,
          tenant_access_token: 'tenant_test_token',
        });
      }
      if (url.pathname.endsWith('/wiki/v2/spaces')) {
        spaceCalls += 1;
        return json(response, {
          code: 0,
          data: {
            items: [],
            has_more: true,
            page_token: 'repeated_page_token',
          },
        });
      }
      return json(response, { code: 404 }, 404);
    });

    const result = await runScript(root, mock.baseUrl);
    await mock.close();

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('pagination');
    expect(spaceCalls).toBe(2);
  });

  it('keeps legacy inventory checks compatible when the program workflow is disabled', async () => {
    const root = createRoot();
    writeFileSync(
      join(root, '.env'),
      [
        'PURCHASE_WORKFLOW_PROGRAM_ENABLED=false',
        ...CONFIG_KEYS.map((key, index) => `${key}=configured_${index}`),
        '',
      ].join('\n'),
      'utf8',
    );

    const result = await runScript(root);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('already complete');
    expect(result.stdout).not.toContain('[WARN]');
    expect(result.stderr).toBe('');
  });

  it.each([
    ['PURCHASE_WORKFLOW_APPROVER_OPEN_IDS', 'ou_first'],
    ['PURCHASE_WORKFLOW_APPROVER_OPEN_IDS', 'ou_duplicate,ou_duplicate'],
    ['PURCHASE_WORKFLOW_APPROVER_OPEN_IDS', 'ou_first,user_second'],
    ['PURCHASE_WORKFLOW_PURCHASE_ADMIN_OPEN_ID', 'user_admin'],
    ['PURCHASE_MANAGER_APPROVER_OPEN_ID', 'user_manager'],
    ['FEISHU_PURCHASE_CARD_VERIFICATION_TOKEN', '   '],
    ['FEISHU_PURCHASE_CARD_ENCRYPT_KEY', 'short'],
    ['PUBLIC_BASE_URL', 'http://ops.example.com'],
    ['PUBLIC_BASE_URL', 'https://user:password@ops.example.com'],
    ['PUBLIC_BASE_URL', 'https://ops.example.com/path?token=value'],
    ['PURCHASE_WORKFLOW_TASK_POLL_INTERVAL_MS', '999'],
    ['PURCHASE_WORKFLOW_TASK_POLL_INTERVAL_MS', '1.5'],
    ['FEISHU_PURCHASE_ORGANIZATION_TABLE_ID', 'table_invalid'],
    ['FEISHU_WAREHOUSE_MANAGER_SOURCE_URL', 'not-a-url'],
    ['FEISHU_WAREHOUSE_MANAGER_TABLE_ID', 'table_invalid'],
    ['FEISHU_WAREHOUSE_MANAGER_VIEW_ID', 'view_invalid'],
  ])('rejects an invalid enabled workflow value for %s', async (key, value) => {
    const root = createRoot();
    const environment = validWorkflowEnvironment();
    environment[key] = value;
    writeFileSync(
      join(root, '.env'),
      serializeEnvironment(environment),
      'utf8',
    );

    const result = await runScript(root);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(key);
    if (value.trim()) expect(result.stderr).not.toContain(value.trim());
  });

  it.each([
    'FEISHU_APP_ID',
    'FEISHU_APP_SECRET',
    'FEISHU_PURCHASE_ORGANIZATION_TABLE_ID',
    'PURCHASE_WORKFLOW_APPROVER_OPEN_IDS',
    'PURCHASE_WORKFLOW_PURCHASE_ADMIN_OPEN_ID',
    'PURCHASE_MANAGER_APPROVER_OPEN_ID',
    'FEISHU_PURCHASE_CARD_VERIFICATION_TOKEN',
    'PUBLIC_BASE_URL',
    'FEISHU_WAREHOUSE_MANAGER_TABLE_ID',
  ])('rejects a missing enabled workflow value for %s', async (key) => {
    const root = createRoot();
    const environment = validWorkflowEnvironment();
    environment[key] = '';
    writeFileSync(
      join(root, '.env'),
      serializeEnvironment(environment),
      'utf8',
    );

    const result = await runScript(root);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(key);
  });

  it('accepts the runtime default when the workflow poll interval is omitted', async () => {
    const root = createRoot();
    const environment = validWorkflowEnvironment();
    environment.PURCHASE_WORKFLOW_TASK_POLL_INTERVAL_MS = '';
    writeFileSync(
      join(root, '.env'),
      serializeEnvironment(environment),
      'utf8',
    );

    const result = await runScript(root);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
  });

  it('uses the general warehouse Base when the dedicated manager source is omitted', async () => {
    const root = createRoot();
    const environment = validWorkflowEnvironment();
    environment.FEISHU_WAREHOUSE_MANAGER_SOURCE_URL = '';
    environment.FEISHU_WAREHOUSE_MANAGER_APP_TOKEN = '';
    environment.FEISHU_WAREHOUSE_MANAGER_WIKI_TOKEN = '';
    environment.FEISHU_WAREHOUSE_SOURCE_URL =
      'https://tenant.example/base/app_warehouse';
    writeFileSync(
      join(root, '.env'),
      serializeEnvironment(environment),
      'utf8',
    );

    const result = await runScript(root);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
  });

  it('rejects a missing dedicated and general warehouse approval-role source', async () => {
    const root = createRoot();
    const environment = validWorkflowEnvironment();
    environment.FEISHU_WAREHOUSE_MANAGER_SOURCE_URL = '';
    environment.FEISHU_WAREHOUSE_MANAGER_APP_TOKEN = '';
    environment.FEISHU_WAREHOUSE_MANAGER_WIKI_TOKEN = '';
    environment.FEISHU_WAREHOUSE_SOURCE_URL = '';
    environment.FEISHU_WAREHOUSE_APP_TOKEN = '';
    writeFileSync(
      join(root, '.env'),
      serializeEnvironment(environment),
      'utf8',
    );

    const result = await runScript(root);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('FEISHU_WAREHOUSE_SOURCE_URL');
    expect(result.stderr).toContain('FEISHU_WAREHOUSE_APP_TOKEN');
  });

  it.each([
    ['FEISHU_WAREHOUSE_MANAGER_TABLE_ID', 'tbl_other', ''],
    ['FEISHU_WAREHOUSE_MANAGER_VIEW_ID', 'tbl_placeholder', 'vew_other'],
  ])(
    'rejects %s when it conflicts with the warehouse source URL',
    async (key, tableId, viewId) => {
      const root = createRoot();
      const environment = validWorkflowEnvironment();
      environment.FEISHU_WAREHOUSE_MANAGER_SOURCE_URL =
        'https://tenant.example/wiki/wiki_placeholder?table=tbl_placeholder&view=vew_placeholder';
      environment.FEISHU_WAREHOUSE_MANAGER_TABLE_ID = tableId;
      environment.FEISHU_WAREHOUSE_MANAGER_VIEW_ID = viewId;
      writeFileSync(
        join(root, '.env'),
        serializeEnvironment(environment),
        'utf8',
      );

      const result = await runScript(root);

      expect(result.code).toBe(1);
      expect(result.stderr).toContain(key);
      expect(result.stderr).not.toContain('tbl_other');
      expect(result.stderr).not.toContain('vew_other');
    },
  );

  it.each([
    {
      missingRole: 'responsible person',
      fields: ['楼栋', '库房管理人'],
    },
    {
      missingRole: 'notification manager',
      fields: ['楼栋', '库房责任人员'],
    },
  ])('repairs an invalid dedicated warehouse role source when $missingRole is missing', async ({ fields }) => {
    const root = createRoot();
    const environment = validWorkflowEnvironment();
    environment.PURCHASE_WORKFLOW_PROGRAM_ENABLED = 'false';
    environment.PURCHASE_MANAGER_APPROVAL_CARD_ENABLED = 'false';
    environment.FEISHU_WAREHOUSE_MANAGER_SOURCE_URL =
      'https://tenant.example/wiki/wiki_wrong_manager?table=tbl_wrong_manager&view=vew_wrong_manager';
    environment.FEISHU_WAREHOUSE_MANAGER_TABLE_ID = 'tbl_wrong_manager';
    environment.FEISHU_WAREHOUSE_MANAGER_VIEW_ID = 'vew_wrong_manager';
    environment.FEISHU_WAREHOUSE_SOURCE_URL =
      'https://tenant.example/base/app_shared_warehouse';
    environment.FEISHU_WAREHOUSE_APP_TOKEN = '';
    writeFileSync(
      join(root, '.env'),
      serializeEnvironment(environment),
      'utf8',
    );

    const calls: string[] = [];
    const mock = await startMock((request, response) => {
      const url = new URL(request.url!, 'http://127.0.0.1');
      calls.push(url.pathname);
      if (url.pathname.endsWith('/auth/v3/tenant_access_token/internal')) {
        return json(response, {
          code: 0,
          tenant_access_token: 'tenant_token_must_never_be_printed',
        });
      }
      if (url.pathname.endsWith('/wiki/v2/spaces/get_node')) {
        return json(response, {
          code: 0,
          data: {
            node: { obj_type: 'bitable', obj_token: 'app_wrong_manager' },
          },
        });
      }
      if (
        url.pathname.endsWith(
          '/apps/app_wrong_manager/tables/tbl_wrong_manager/fields',
        )
      ) {
        return json(response, fieldPage(fields));
      }
      if (url.pathname.endsWith('/apps/app_shared_warehouse/tables')) {
        return json(
          response,
          tablePage([
            ['其他配置', 'tbl_other'],
            ['配置楼栋负责人', 'tbl_discovered_manager'],
          ]),
        );
      }
      if (
        url.pathname.endsWith(
          '/apps/app_shared_warehouse/tables/tbl_discovered_manager/fields',
        )
      ) {
        return json(
          response,
          fieldPage(['楼栋', '库房责任人员', '库房管理人']),
        );
      }
      return json(response, { code: 404 }, 404);
    });

    const result = await runScript(root, mock.baseUrl, true);
    await mock.close();

    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).not.toContain('app_wrong_manager');
    expect(result.stdout).not.toContain('tbl_discovered_manager');
    expect(calls).toContain(
      '/open-apis/bitable/v1/apps/app_shared_warehouse/tables',
    );
    expect(readValues(readFileSync(join(root, '.env'), 'utf8'))).toMatchObject({
      FEISHU_WAREHOUSE_MANAGER_SOURCE_URL: '',
      FEISHU_WAREHOUSE_MANAGER_APP_TOKEN: '',
      FEISHU_WAREHOUSE_MANAGER_WIKI_TOKEN: '',
      FEISHU_WAREHOUSE_MANAGER_TABLE_ID: 'tbl_discovered_manager',
      FEISHU_WAREHOUSE_MANAGER_VIEW_ID: '',
    });
  });

  it('preserves a semantically valid explicit warehouse role source with approval and notification fields', async () => {
    const root = createRoot();
    const environment = validWorkflowEnvironment();
    environment.PURCHASE_WORKFLOW_PROGRAM_ENABLED = 'false';
    environment.PURCHASE_MANAGER_APPROVAL_CARD_ENABLED = 'false';
    environment.FEISHU_WAREHOUSE_MANAGER_SOURCE_URL =
      'https://tenant.example/base/app_dedicated_manager?table=tbl_dedicated_manager&view=vew_dedicated_manager';
    environment.FEISHU_WAREHOUSE_MANAGER_TABLE_ID = 'tbl_dedicated_manager';
    environment.FEISHU_WAREHOUSE_MANAGER_VIEW_ID = 'vew_dedicated_manager';
    environment.FEISHU_WAREHOUSE_SOURCE_URL =
      'https://tenant.example/base/app_shared_warehouse';
    const original = serializeEnvironment(environment);
    writeFileSync(join(root, '.env'), original, 'utf8');

    const calls: string[] = [];
    const mock = await startMock((request, response) => {
      const url = new URL(request.url!, 'http://127.0.0.1');
      calls.push(url.pathname);
      if (url.pathname.endsWith('/auth/v3/tenant_access_token/internal')) {
        return json(response, {
          code: 0,
          tenant_access_token: 'tenant_token_must_never_be_printed',
        });
      }
      if (
        url.pathname.endsWith(
          '/apps/app_dedicated_manager/tables/tbl_dedicated_manager/fields',
        )
      ) {
        return json(
          response,
          fieldPage(['楼栋', '库房责任人员', '库房管理人']),
        );
      }
      return json(response, { code: 404 }, 404);
    });

    const result = await runScript(root, mock.baseUrl, true);
    await mock.close();

    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(readFileSync(join(root, '.env'), 'utf8')).toBe(original);
    expect(calls).toContain(
      '/open-apis/bitable/v1/apps/app_dedicated_manager/tables/tbl_dedicated_manager/fields',
    );
    expect(
      calls.some((call) =>
        call.endsWith('/apps/app_shared_warehouse/tables'),
      ),
    ).toBe(false);
  });

  it('fails safely when shared warehouse discovery has multiple valid role tables', async () => {
    const root = createRoot();
    const environment = validWorkflowEnvironment();
    environment.PURCHASE_WORKFLOW_PROGRAM_ENABLED = 'false';
    environment.PURCHASE_MANAGER_APPROVAL_CARD_ENABLED = 'false';
    environment.FEISHU_WAREHOUSE_MANAGER_SOURCE_URL =
      'https://tenant.example/base/app_wrong_manager?table=tbl_wrong_manager';
    environment.FEISHU_WAREHOUSE_MANAGER_TABLE_ID = 'tbl_wrong_manager';
    environment.FEISHU_WAREHOUSE_SOURCE_URL =
      'https://tenant.example/base/app_shared_warehouse';
    const original = serializeEnvironment(environment);
    writeFileSync(join(root, '.env'), original, 'utf8');

    const mock = await startMock((request, response) => {
      const url = new URL(request.url!, 'http://127.0.0.1');
      if (url.pathname.endsWith('/auth/v3/tenant_access_token/internal')) {
        return json(response, {
          code: 0,
          tenant_access_token: 'tenant_token_must_never_be_printed',
        });
      }
      if (
        url.pathname.endsWith(
          '/apps/app_wrong_manager/tables/tbl_wrong_manager/fields',
        )
      ) {
        return json(response, fieldPage(['楼栋']));
      }
      if (url.pathname.endsWith('/apps/app_shared_warehouse/tables')) {
        return json(
          response,
          tablePage([
            ['配置楼栋负责人', 'tbl_manager_one'],
            ['02-配置楼栋负责人', 'tbl_manager_two'],
          ]),
        );
      }
      if (
        /\/apps\/app_shared_warehouse\/tables\/tbl_manager_(?:one|two)\/fields$/u.test(
          url.pathname,
        )
      ) {
        return json(
          response,
          fieldPage(['楼栋', '库房责任人员', '库房管理人']),
        );
      }
      return json(response, { code: 404 }, 404);
    });

    const result = await runScript(root, mock.baseUrl, true);
    await mock.close();

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      'exactly one valid warehouse role table',
    );
    expect(result.stdout).toBe('');
    expect(readFileSync(join(root, '.env'), 'utf8')).toBe(original);
  });

  it('validates automatic workflow activation without changing persistent dotenv values', async () => {
    const root = createRoot();
    const environment = validWorkflowEnvironment();
    environment.PURCHASE_WORKFLOW_PROGRAM_ENABLED = 'false';
    environment.PURCHASE_MANAGER_APPROVAL_CARD_ENABLED = 'false';
    const original = serializeEnvironment(environment);
    writeFileSync(join(root, '.env'), original, 'utf8');

    const mock = await startDefaultManagerValidationMock();
    const result = await runScript(root, mock.baseUrl, true);
    await mock.close();

    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('runtime activation is ready');
    expect(readFileSync(join(root, '.env'), 'utf8')).toBe(original);
  });

  it('accepts automatic workflow activation when the manager is uniquely derived from legacy approvers and administrators', async () => {
    const root = createRoot();
    const environment = validWorkflowEnvironment();
    environment.PURCHASE_WORKFLOW_PROGRAM_ENABLED = 'false';
    environment.PURCHASE_MANAGER_APPROVAL_CARD_ENABLED = 'false';
    environment.PURCHASE_MANAGER_APPROVER_OPEN_ID = '';
    environment.FEISHU_ACCESS_ADMIN_OPEN_IDS = 'ou_admin,ou_second';
    writeFileSync(
      join(root, '.env'),
      serializeEnvironment(environment),
      'utf8',
    );

    const mock = await startDefaultManagerValidationMock();
    const result = await runScript(root, mock.baseUrl, true);
    await mock.close();

    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('runtime activation is ready');
  });

  it('rejects automatic workflow activation when a unique manager cannot be derived', async () => {
    const root = createRoot();
    const environment = validWorkflowEnvironment();
    environment.PURCHASE_WORKFLOW_PROGRAM_ENABLED = 'false';
    environment.PURCHASE_MANAGER_APPROVAL_CARD_ENABLED = 'false';
    environment.PURCHASE_MANAGER_APPROVER_OPEN_ID = '';
    environment.FEISHU_ACCESS_ADMIN_OPEN_IDS = 'ou_unrelated';
    writeFileSync(
      join(root, '.env'),
      serializeEnvironment(environment),
      'utf8',
    );

    const result = await runScript(root, undefined, true);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('PURCHASE_MANAGER_APPROVER_OPEN_ID');
    expect(result.stderr).toContain('FEISHU_ACCESS_ADMIN_OPEN_IDS');
    expect(result.stdout).toBe('');
  });

  it('automatically resolves and persists the uniquely named manager from the organization Base', async () => {
    const root = createRoot();
    const environment = validWorkflowEnvironment();
    environment.PURCHASE_WORKFLOW_PROGRAM_ENABLED = 'false';
    environment.PURCHASE_MANAGER_APPROVAL_CARD_ENABLED = 'false';
    environment.PURCHASE_MANAGER_APPROVER_OPEN_ID = '';
    environment.PURCHASE_MANAGER_APPROVER_NAME = '';
    environment.FEISHU_ACCESS_ADMIN_OPEN_IDS = 'ou_unrelated';
    writeFileSync(
      join(root, '.env'),
      serializeEnvironment(environment),
      'utf8',
    );

    const mock = await startMock((request, response) => {
      const url = new URL(request.url!, 'http://127.0.0.1');
      if (handleDefaultManagerValidation(request, response)) return;
      if (url.pathname.endsWith('/auth/v3/tenant_access_token/internal')) {
        return json(response, {
          code: 0,
          tenant_access_token: 'tenant_token_must_never_be_printed',
        });
      }
      if (
        url.pathname.endsWith(
          '/bitable/v1/apps/configured_0/tables/tbl_organization/records',
        )
      ) {
        return json(response, {
          code: 0,
          data: {
            items: [
              {
                record_id: 'rec_manager',
                fields: {
                  主管: [{ id: 'ou_discovered_manager', name: '马进宇' }],
                  '主管（文本）': '马进宇',
                  职位: ['设施运维经理'],
                },
              },
            ],
            has_more: false,
          },
        });
      }
      return json(response, { code: 404 }, 404);
    });

    const result = await runScript(root, mock.baseUrl, true);
    await mock.close();

    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).not.toContain('ou_discovered_manager');
    expect(readValues(readFileSync(join(root, '.env'), 'utf8'))).toMatchObject({
      PURCHASE_MANAGER_APPROVER_OPEN_ID: 'ou_discovered_manager',
    });
  });

  it('automatically resolves and persists the uniquely named purchase administrator from the organization Base', async () => {
    const root = createRoot();
    const environment = validWorkflowEnvironment();
    environment.PURCHASE_WORKFLOW_PROGRAM_ENABLED = 'false';
    environment.PURCHASE_MANAGER_APPROVAL_CARD_ENABLED = 'false';
    environment.PURCHASE_WORKFLOW_PURCHASE_ADMIN_OPEN_ID = '';
    writeFileSync(
      join(root, '.env'),
      serializeEnvironment(environment),
      'utf8',
    );

    const mock = await startMock((request, response) => {
      const url = new URL(request.url!, 'http://127.0.0.1');
      if (handleDefaultManagerValidation(request, response)) return;
      if (url.pathname.endsWith('/auth/v3/tenant_access_token/internal')) {
        return json(response, {
          code: 0,
          tenant_access_token: 'tenant_token_must_never_be_printed',
        });
      }
      if (
        url.pathname.endsWith(
          '/bitable/v1/apps/configured_0/tables/tbl_organization/records',
        )
      ) {
        return json(response, {
          code: 0,
          data: {
            items: [
              {
                record_id: 'rec_purchase_admin',
                fields: {
                  主管: [
                    {
                      id: 'ou_discovered_purchase_admin',
                      name: '曹李培',
                    },
                  ],
                  '主管（文本）': '曹李培',
                  职位: ['综合管理'],
                },
              },
              {
                record_id: 'rec_same_name_wrong_position',
                fields: {
                  主管: [{ id: 'ou_wrong_position', name: '曹李培' }],
                  '主管（文本）': '曹李培',
                  职位: ['采购管理'],
                },
              },
              {
                record_id: 'rec_same_position_wrong_name',
                fields: {
                  主管: [{ id: 'ou_wrong_name', name: '其他人' }],
                  '主管（文本）': '其他人',
                  职位: ['综合管理'],
                },
              },
            ],
            has_more: false,
          },
        });
      }
      return json(response, { code: 404 }, 404);
    });

    const result = await runScript(root, mock.baseUrl, true);
    await mock.close();

    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).not.toContain('ou_discovered_purchase_admin');
    expect(readValues(readFileSync(join(root, '.env'), 'utf8'))).toMatchObject({
      PURCHASE_WORKFLOW_PURCHASE_ADMIN_OPEN_ID: 'ou_discovered_purchase_admin',
    });
  });

  it('rejects automatic purchase-administrator discovery when the organization Base has multiple matching users', async () => {
    const root = createRoot();
    const environment = validWorkflowEnvironment();
    environment.PURCHASE_WORKFLOW_PROGRAM_ENABLED = 'false';
    environment.PURCHASE_MANAGER_APPROVAL_CARD_ENABLED = 'false';
    environment.PURCHASE_WORKFLOW_PURCHASE_ADMIN_OPEN_ID = '';
    const original = serializeEnvironment(environment);
    writeFileSync(join(root, '.env'), original, 'utf8');

    const mock = await startMock((request, response) => {
      const url = new URL(request.url!, 'http://127.0.0.1');
      if (url.pathname.endsWith('/auth/v3/tenant_access_token/internal')) {
        return json(response, {
          code: 0,
          tenant_access_token: 'tenant_token_must_never_be_printed',
        });
      }
      if (url.pathname.includes('/tables/tbl_organization/records')) {
        return json(response, {
          code: 0,
          data: {
            items: ['ou_purchase_admin_one', 'ou_purchase_admin_two'].map(
              (id) => ({
                fields: {
                  主管: [{ id, name: '曹李培' }],
                  职位: ['综合管理'],
                },
              }),
            ),
            has_more: false,
          },
        });
      }
      return json(response, { code: 404 }, 404);
    });

    const result = await runScript(root, mock.baseUrl, true);
    await mock.close();

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('PURCHASE_WORKFLOW_PURCHASE_ADMIN_OPEN_ID');
    expect(result.stdout).toBe('');
    expect(readFileSync(join(root, '.env'), 'utf8')).toBe(original);
  });

  it('rejects automatic manager discovery when the organization Base maps the target name to multiple open IDs', async () => {
    const root = createRoot();
    const environment = validWorkflowEnvironment();
    environment.PURCHASE_WORKFLOW_PROGRAM_ENABLED = 'false';
    environment.PURCHASE_MANAGER_APPROVAL_CARD_ENABLED = 'false';
    environment.PURCHASE_MANAGER_APPROVER_OPEN_ID = '';
    environment.PURCHASE_MANAGER_APPROVER_NAME = '同名经理';
    environment.FEISHU_ACCESS_ADMIN_OPEN_IDS = 'ou_unrelated';
    const original = serializeEnvironment(environment);
    writeFileSync(join(root, '.env'), original, 'utf8');

    const mock = await startMock((request, response) => {
      const url = new URL(request.url!, 'http://127.0.0.1');
      if (url.pathname.endsWith('/auth/v3/tenant_access_token/internal')) {
        return json(response, {
          code: 0,
          tenant_access_token: 'tenant_token_must_never_be_printed',
        });
      }
      if (url.pathname.includes('/tables/tbl_organization/records')) {
        return json(response, {
          code: 0,
          data: {
            items: ['ou_manager_one', 'ou_manager_two'].map((id) => ({
              fields: {
                主管: [{ id, name: '同名经理' }],
                职位: ['设施运维经理'],
              },
            })),
            has_more: false,
          },
        });
      }
      return json(response, { code: 404 }, 404);
    });

    const result = await runScript(root, mock.baseUrl, true);
    await mock.close();

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('PURCHASE_MANAGER_APPROVER_OPEN_ID');
    expect(result.stdout).toBe('');
    expect(readFileSync(join(root, '.env'), 'utf8')).toBe(original);
  });

  it.each([
    [
      'source URL',
      {
        FEISHU_WAREHOUSE_MANAGER_SOURCE_URL:
          'https://tenant.example/wiki/wiki_placeholder?table=tbl_placeholder',
        FEISHU_WAREHOUSE_MANAGER_APP_TOKEN: '',
        FEISHU_WAREHOUSE_MANAGER_WIKI_TOKEN: '',
      },
    ],
    [
      'app token',
      {
        FEISHU_WAREHOUSE_MANAGER_SOURCE_URL: '',
        FEISHU_WAREHOUSE_MANAGER_APP_TOKEN: 'app_placeholder',
        FEISHU_WAREHOUSE_MANAGER_WIKI_TOKEN: '',
      },
    ],
    [
      'wiki token',
      {
        FEISHU_WAREHOUSE_MANAGER_SOURCE_URL: '',
        FEISHU_WAREHOUSE_MANAGER_APP_TOKEN: '',
        FEISHU_WAREHOUSE_MANAGER_WIKI_TOKEN: 'wiki_placeholder',
      },
    ],
  ])(
    'accepts a minimal enabled workflow using a warehouse %s',
    async (_label, source) => {
      const root = createRoot();
      const environment = {
        ...validWorkflowEnvironment(),
        ...source,
      };
      writeFileSync(
        join(root, '.env'),
        serializeEnvironment(environment),
        'utf8',
      );

      const result = await runScript(root);

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('already complete');
      expect(result.stdout).toContain('[WARN]');
      expect(result.stdout).toContain('legacy Feishu Base automations');
      expect(result.stdout).toContain('PURCHASE_WORKFLOW_LEDGER_PATH');
      expect(result.stderr).toBe('');
    },
  );

  it.each([
    'https://ops.example.com/nantong',
    'http://localhost:3001',
    'http://127.0.0.1:3001/nantong',
    'http://[::1]:3001',
  ])('accepts the public base URL %s', async (publicBaseUrl) => {
    const root = createRoot();
    const environment = validWorkflowEnvironment();
    environment.PUBLIC_BASE_URL = publicBaseUrl;
    writeFileSync(
      join(root, '.env'),
      serializeEnvironment(environment),
      'utf8',
    );

    const result = await runScript(root);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
  });

  it('accepts an omitted optional Encrypt Key', async () => {
    const root = createRoot();
    const environment = validWorkflowEnvironment();
    environment.FEISHU_PURCHASE_CARD_ENCRYPT_KEY = '';
    writeFileSync(
      join(root, '.env'),
      serializeEnvironment(environment),
      'utf8',
    );

    const result = await runScript(root);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
  });

  it('keeps the interactive workflow example free of real identities and secrets', () => {
    const example = readFileSync(
      resolve(__dirname, '../../.env.example'),
      'utf8',
    );
    const section = example.match(
      /# Interactive purchase workflow[\s\S]*?# End interactive purchase workflow\./,
    )?.[0];

    expect(section).toBeDefined();
    expect(section).not.toMatch(/=ou_[A-Za-z0-9_-]+/);
    expect(section).not.toMatch(/https:\/\/vnet\.feishu\.cn\/(?:wiki|base)\//);
    expect(section).not.toMatch(
      /(?:TOKEN|SECRET|ENCRYPT_KEY|APP_TOKEN|WIKI_TOKEN)=[^\r\n]+/,
    );
  });

  function createRoot(): string {
    const root = mkdtempSync(join(tmpdir(), 'purchase-config-test-'));
    roots.push(root);
    return root;
  }
});

function validWorkflowEnvironment(): Record<string, string> {
  return {
    ...Object.fromEntries(
      CONFIG_KEYS.map((key, index) => [key, `configured_${index}`]),
    ),
    FEISHU_APP_ID: 'cli_test_app_id',
    FEISHU_APP_SECRET: 'cli_test_app_secret',
    FEISHU_PURCHASE_ORGANIZATION_TABLE_ID: 'tbl_organization',
    PURCHASE_WORKFLOW_PROGRAM_ENABLED: 'true',
    PURCHASE_MANAGER_APPROVAL_CARD_ENABLED: 'true',
    PURCHASE_MANAGER_APPROVER_OPEN_ID: 'ou_manager',
    PURCHASE_WORKFLOW_APPROVER_OPEN_IDS: 'ou_first,ou_second',
    PURCHASE_WORKFLOW_PURCHASE_ADMIN_OPEN_ID: 'ou_admin',
    FEISHU_PURCHASE_CARD_VERIFICATION_TOKEN: 'verification-placeholder',
    FEISHU_PURCHASE_CARD_ENCRYPT_KEY: 'encrypt-key-placeholder',
    PUBLIC_BASE_URL: 'https://ops.example.com/nantong',
    PURCHASE_WORKFLOW_TASK_POLL_INTERVAL_MS: '5000',
    PURCHASE_WORKFLOW_LEDGER_PATH: '.runtime/purchase-workflow-ledger.json',
    FEISHU_WAREHOUSE_MANAGER_SOURCE_URL:
      'https://tenant.example/wiki/wiki_placeholder?table=tbl_placeholder',
    FEISHU_WAREHOUSE_MANAGER_APP_TOKEN: '',
    FEISHU_WAREHOUSE_MANAGER_WIKI_TOKEN: '',
    FEISHU_WAREHOUSE_MANAGER_TABLE_ID: 'tbl_placeholder',
    FEISHU_WAREHOUSE_MANAGER_VIEW_ID: '',
  };
}

function serializeEnvironment(environment: Record<string, string>): string {
  return `${Object.entries(environment)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n')}\n`;
}

function tablePage(items: ReadonlyArray<readonly [string, string]>) {
  return {
    code: 0,
    data: {
      items: items.map(([name, table_id]) => ({ name, table_id })),
      has_more: false,
    },
  };
}

function fieldPage(fieldNames: readonly string[]) {
  return {
    code: 0,
    data: {
      items: fieldNames.map((field_name, index) => ({
        field_id: `fld_${index}`,
        field_name,
        type: 1,
        ui_type: 'Text',
        is_primary: index === 0,
      })),
      has_more: false,
    },
  };
}

function nodePage(items: Array<Record<string, unknown>>) {
  return { code: 0, data: { items, has_more: false } };
}

function expectedValues(appToken: string): Record<string, string> {
  return {
    FEISHU_PURCHASE_INVENTORY_APP_TOKEN: appToken,
    FEISHU_PURCHASE_SUBMISSION_TABLE_ID: TABLES[0][1],
    FEISHU_PURCHASE_EXECUTION_TABLE_ID: TABLES[1][1],
    FEISHU_ITEM_CATEGORY_TABLE_ID: TABLES[2][1],
    FEISHU_INVENTORY_LEDGER_TABLE_ID: TABLES[3][1],
    FEISHU_INBOUND_TABLE_ID: TABLES[4][1],
    FEISHU_OUTBOUND_TABLE_ID: TABLES[5][1],
  };
}

function readValues(content: string): Record<string, string> {
  return Object.fromEntries(
    content
      .split(/\r?\n/)
      .map((line) => line.match(/^([A-Z0-9_]+)=(.*)$/))
      .filter((match): match is RegExpMatchArray => Boolean(match))
      .map((match) => [match[1], match[2]]),
  );
}

async function runScript(
  root: string,
  apiBaseUrl?: string,
  activateWorkflow = false,
  checkOnly = false,
) {
  const args = [SCRIPT, '--root', root];
  if (apiBaseUrl) args.push('--api-base-url', apiBaseUrl);
  if (activateWorkflow) args.push('--activate-workflow');
  if (checkOnly) args.push('--check-only');
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !key.startsWith('FEISHU_') &&
        !key.startsWith('PURCHASE_WORKFLOW_') &&
        key !== 'PUBLIC_BASE_URL',
    ),
  );

  return await new Promise<{ code: number; stdout: string; stderr: string }>(
    (resolveResult, reject) => {
      const child = spawn(process.execPath, args, {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => (stdout += chunk));
      child.stderr.on('data', (chunk) => (stderr += chunk));
      child.on('error', reject);
      child.on('close', (code) =>
        resolveResult({ code: code ?? -1, stdout, stderr }),
      );
    },
  );
}

async function startMock(handler: MockHandler) {
  const server = createServer(handler);
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolveListen());
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Mock server failed');
  return {
    baseUrl: `http://127.0.0.1:${address.port}/open-apis`,
    close: () =>
      new Promise<void>((resolveClose, reject) =>
        server.close((error) => (error ? reject(error) : resolveClose())),
      ),
  };
}

async function startDefaultManagerValidationMock() {
  return startMock((request, response) => {
    if (handleDefaultManagerValidation(request, response)) return;
    return json(response, { code: 404 }, 404);
  });
}

function handleDefaultManagerValidation(
  request: IncomingMessage,
  response: ServerResponse,
): boolean {
  const url = new URL(request.url!, 'http://127.0.0.1');
  if (url.pathname.endsWith('/auth/v3/tenant_access_token/internal')) {
    json(response, {
      code: 0,
      tenant_access_token: 'tenant_token_must_never_be_printed',
    });
    return true;
  }
  if (
    url.pathname.endsWith('/wiki/v2/spaces/get_node') &&
    url.searchParams.get('token') === 'wiki_placeholder'
  ) {
    json(response, {
      code: 0,
      data: {
        node: { obj_type: 'bitable', obj_token: 'app_manager_placeholder' },
      },
    });
    return true;
  }
  if (
    url.pathname.endsWith(
      '/apps/app_manager_placeholder/tables/tbl_placeholder/fields',
    )
  ) {
    json(
      response,
      fieldPage(['楼栋', '库房责任人员', '库房管理人']),
    );
    return true;
  }
  return false;
}

function json(response: ServerResponse, value: unknown, status = 200): void {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify(value));
}
