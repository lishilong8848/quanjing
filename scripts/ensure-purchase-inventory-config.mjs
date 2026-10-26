import {
  access,
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { basename, dirname, join, resolve } from 'node:path';
import { verifyContractStartupAtRoot } from './verify-contract-storage-startup.mjs';
import { verifyFeishuAccessStartupAtRoot } from './verify-feishu-access-startup.mjs';

const DEFAULT_API_BASE_URL = 'https://open.feishu.cn/open-apis';
const MAX_REQUESTS = 500;
const MAX_PAGES = 100;
const MAX_WIKI_NODES = 2_000;
const MAX_BITABLE_CANDIDATES = 200;
const OPEN_ID_PATTERN = /^ou_[A-Za-z0-9_-]+$/;
const TABLE_ID_PATTERN = /^tbl[A-Za-z0-9_-]+$/;
const VIEW_ID_PATTERN = /^vew[A-Za-z0-9_-]+$/;
const SOURCE_TOKEN_PATTERN = /^[A-Za-z0-9_-]+$/;
const MIN_POLL_INTERVAL_MS = 1_000;
const MAX_POLL_INTERVAL_MS = 3_600_000;
const MIN_ENCRYPT_KEY_LENGTH = 8;
const MAX_CONFIGURATION_VALUE_LENGTH = 4_096;
const DEFAULT_MANAGER_APPROVER_NAME = '示例人员020';
const MANAGER_POSITIONS = new Set(['设施运维经理', '设施运维副经理']);
const DEFAULT_PURCHASE_ADMIN_NAME = '曹李培';
const PURCHASE_ADMIN_POSITIONS = new Set(['综合管理']);
const WAREHOUSE_MANAGER_TABLE_NAME = '配置楼栋负责人';
const WAREHOUSE_APPROVAL_REQUIRED_FIELDS = ['楼栋', '库房示例人员019员'];
const WAREHOUSE_NOTIFICATION_REQUIRED_FIELDS = ['库房管理人'];

const TABLE_SIGNATURE = [
  {
    name: '采购提交',
    env: 'FEISHU_PURCHASE_SUBMISSION_TABLE_ID',
  },
  {
    name: '采购进行',
    env: 'FEISHU_PURCHASE_EXECUTION_TABLE_ID',
  },
  { name: '物品类别', env: 'FEISHU_ITEM_CATEGORY_TABLE_ID' },
  { name: '库存台账', env: 'FEISHU_INVENTORY_LEDGER_TABLE_ID' },
  { name: '物品入库表', env: 'FEISHU_INBOUND_TABLE_ID' },
  { name: '物品出库表', env: 'FEISHU_OUTBOUND_TABLE_ID' },
];

const CRITICAL_KEYS = [
  'FEISHU_PURCHASE_INVENTORY_APP_TOKEN',
  ...TABLE_SIGNATURE.map((table) => table.env),
];

class PublicError extends Error {}

class FeishuClient {
  constructor({ apiBaseUrl, fetchImpl, appId, appSecret }) {
    this.apiBaseUrl = apiBaseUrl.replace(/\/+$/, '');
    this.fetchImpl = fetchImpl;
    this.appId = appId;
    this.appSecret = appSecret;
    this.requestCount = 0;
    this.tenantAccessToken = '';
  }

  async authenticate() {
    if (this.tenantAccessToken) return this.tenantAccessToken;
    const payload = await this.request(
      'authenticate with Feishu',
      '/auth/v3/tenant_access_token/internal',
      {
        method: 'POST',
        body: { app_id: this.appId, app_secret: this.appSecret },
        authenticated: false,
      },
    );
    const token = clean(payload?.tenant_access_token);
    if (!token) {
      throw new PublicError(
        'Feishu authentication did not return a tenant access token.',
      );
    }
    this.tenantAccessToken = token;
    return token;
  }

  async request(operation, path, options = {}) {
    this.requestCount += 1;
    if (this.requestCount > MAX_REQUESTS) {
      throw new PublicError('Automatic discovery request budget was exceeded.');
    }

    const headers = { 'Content-Type': 'application/json; charset=utf-8' };
    if (options.authenticated !== false) {
      headers.Authorization = `Bearer ${await this.authenticate()}`;
    }

    let response;
    try {
      response = await this.fetchImpl(`${this.apiBaseUrl}${path}`, {
        method: options.method || 'GET',
        headers,
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new PublicError(
        `Feishu request failed while trying to ${operation}.`,
      );
    }

    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new PublicError(
        `Feishu returned an invalid response while trying to ${operation}.`,
      );
    }
    if (!response.ok || (payload?.code !== undefined && payload.code !== 0)) {
      throw new PublicError(`Feishu rejected the request to ${operation}.`);
    }
    return payload;
  }

  async resolveWikiToken(wikiToken) {
    const query = new URLSearchParams({ token: wikiToken }).toString();
    const payload = await this.request(
      'resolve the configured Wiki source',
      `/wiki/v2/spaces/get_node?${query}`,
    );
    const node = payload?.data?.node;
    if (node?.obj_type !== 'bitable' || !clean(node?.obj_token)) {
      throw new PublicError('The configured Wiki source is not a Feishu Base.');
    }
    return clean(node.obj_token);
  }

  async listTables(appToken) {
    return paginate('table metadata', async (pageToken) => {
      const query = pageQuery(pageToken);
      const payload = await this.request(
        'read Base table metadata',
        `/bitable/v1/apps/${encodeURIComponent(appToken)}/tables?${query}`,
      );
      return payload?.data;
    });
  }

  async listFields(appToken, tableId) {
    return paginate('table fields', async (pageToken) => {
      const query = pageQuery(pageToken);
      const payload = await this.request(
        'read Base table fields',
        `/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/fields?${query}`,
      );
      return payload?.data;
    });
  }

  async listRecords(appToken, tableId) {
    return paginate('organization records', async (pageToken) => {
      const query = new URLSearchParams({
        page_size: '500',
        automatic_fields: 'true',
      });
      if (pageToken) query.set('page_token', pageToken);
      const payload = await this.request(
        'read organization records',
        `/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/records?${query}`,
      );
      return payload?.data;
    });
  }

  async listWikiSpaces() {
    return paginate('Wiki spaces', async (pageToken) => {
      const payload = await this.request(
        'enumerate Wiki spaces',
        `/wiki/v2/spaces?${pageQuery(pageToken, 50)}`,
      );
      return payload?.data;
    });
  }

  async listWikiNodes(spaceId, parentNodeToken) {
    return paginate('Wiki nodes', async (pageToken) => {
      const query = new URLSearchParams({ page_size: '50' });
      if (pageToken) query.set('page_token', pageToken);
      if (parentNodeToken) query.set('parent_node_token', parentNodeToken);
      const payload = await this.request(
        'enumerate Wiki nodes',
        `/wiki/v2/spaces/${encodeURIComponent(spaceId)}/nodes?${query}`,
      );
      return payload?.data;
    });
  }
}

async function ensureConfiguration({
  root,
  apiBaseUrl,
  fetchImpl = fetch,
  activateWorkflow = false,
  checkOnly = false,
}) {
  const envPath = join(root, '.env');
  const envLocalPath = join(root, '.env.local');
  const [baseFile, localFile] = await Promise.all([
    readOptionalFile(envPath),
    readOptionalFile(envLocalPath),
  ]);
  const effective = {
    ...stringEnvironment(process.env),
    ...parseDotEnv(baseFile.content),
    ...parseDotEnv(localFile.content),
  };
  if (activateWorkflow) {
    // The field checker must use Node/dotenv quote and comment semantics, not
    // the configuration repair parser's historical line-oriented subset.
    await checkOutboundStartupFields(root, {
      ...stringEnvironment(process.env),
      ...parseEnv(baseFile.content.replace(/^\uFEFF/u, '')),
      ...parseEnv(localFile.content.replace(/^\uFEFF/u, '')),
    });
  }
  let client;
  const getClient = () => {
    if (client) return client;
    const appId = clean(effective.FEISHU_APP_ID);
    const appSecret = clean(effective.FEISHU_APP_SECRET);
    if (!appId || !appSecret) {
      throw new PublicError(
        'Feishu application credentials are missing; automatic purchase inventory configuration cannot run.',
      );
    }
    client = new FeishuClient({ apiBaseUrl, fetchImpl, appId, appSecret });
    return client;
  };

  const desired = {};
  if (!CRITICAL_KEYS.every((key) => clean(effective[key]))) {
    const discoveryClient = getClient();
    await discoveryClient.authenticate();
    const match =
      (await findConfiguredMatch(discoveryClient, effective, root)) ||
      (await findUniqueWikiMatch(discoveryClient));
    if (!match) {
      throw new PublicError(
        'No Feishu Base with the required six-table purchase inventory signature was found.',
      );
    }
    Object.assign(desired, {
      FEISHU_PURCHASE_INVENTORY_APP_TOKEN: match.appToken,
      ...match.tableIds,
    });
  }

  let configured = { ...effective, ...desired };
  let activationEnvironment = activateWorkflow
    ? {
        ...configured,
        PURCHASE_WORKFLOW_PROGRAM_ENABLED: 'true',
        PURCHASE_MANAGER_APPROVAL_CARD_ENABLED: 'true',
      }
    : configured;
  if (
    isEnabled(activationEnvironment.PURCHASE_MANAGER_APPROVAL_CARD_ENABLED) &&
    !clean(activationEnvironment.PURCHASE_MANAGER_APPROVER_OPEN_ID) &&
    !resolveConfiguredManagerOpenId(activationEnvironment)
  ) {
    try {
      desired.PURCHASE_MANAGER_APPROVER_OPEN_ID =
        await resolveManagerOpenIdFromOrganizationBase(
          getClient(),
          activationEnvironment,
        );
    } catch {
      throw new PublicError(
        'PURCHASE_MANAGER_APPROVER_OPEN_ID must be a valid open_id, FEISHU_ACCESS_ADMIN_OPEN_IDS must identify exactly one configured purchase workflow approver, or the configured manager name must identify exactly one active manager in the organization Base.',
      );
    }
    configured = { ...effective, ...desired };
    activationEnvironment = activateWorkflow
      ? {
          ...configured,
          PURCHASE_WORKFLOW_PROGRAM_ENABLED: 'true',
          PURCHASE_MANAGER_APPROVAL_CARD_ENABLED: 'true',
        }
      : configured;
  }
  if (
    activateWorkflow &&
    !clean(activationEnvironment.PURCHASE_WORKFLOW_PURCHASE_ADMIN_OPEN_ID)
  ) {
    try {
      desired.PURCHASE_WORKFLOW_PURCHASE_ADMIN_OPEN_ID =
        await resolvePurchaseAdminOpenIdFromOrganizationBase(
          getClient(),
          activationEnvironment,
        );
    } catch {
      throw new PublicError(
        'PURCHASE_WORKFLOW_PURCHASE_ADMIN_OPEN_ID must be a valid open_id, or the configured purchase administrator name must identify exactly one active comprehensive-management user in the organization Base.',
      );
    }
    configured = { ...effective, ...desired };
    activationEnvironment = activateWorkflow
      ? {
          ...configured,
          PURCHASE_WORKFLOW_PROGRAM_ENABLED: 'true',
          PURCHASE_MANAGER_APPROVAL_CARD_ENABLED: 'true',
        }
      : configured;
  }

  if (activateWorkflow) {
    validateInteractiveWorkflowConfiguration(activationEnvironment, {
      validateWarehouseManager: false,
    });
    Object.assign(
      desired,
      await repairWarehouseManagerConfiguration(
        getClient(),
        activationEnvironment,
      ),
    );
    configured = { ...effective, ...desired };
    activationEnvironment = {
      ...configured,
      PURCHASE_WORKFLOW_PROGRAM_ENABLED: 'true',
      PURCHASE_MANAGER_APPROVAL_CARD_ENABLED: 'true',
    };
  }

  const warnings = validateInteractiveWorkflowConfiguration(
    activationEnvironment,
  );
  const updates = Object.fromEntries(
    Object.entries(desired).filter(
      ([key, value]) => clean(effective[key]) !== value,
    ),
  );
  if (!Object.keys(updates).length) {
    return {
      changed: false,
      warnings,
      activationReady: activateWorkflow,
      checkOnly,
    };
  }

  if (checkOnly) {
    return {
      changed: false,
      warnings,
      activationReady: activateWorkflow,
      checkOnly: true,
    };
  }

  const target = localFile.exists
    ? { path: envLocalPath, file: localFile }
    : baseFile.exists
      ? { path: envPath, file: baseFile }
      : { path: envLocalPath, file: localFile };
  await atomicPatchDotEnv(
    target.path,
    target.file.content,
    updates,
    target.file.mode,
  );
  return {
    changed: true,
    warnings,
    activationReady: activateWorkflow,
  };
}

async function checkOutboundStartupFields(root, environment) {
  const enabled =
    [
      'FEISHU_APP_ID',
      'FEISHU_APP_SECRET',
      'FEISHU_WAREHOUSE_OUTBOUND_TABLE_ID',
    ].every((key) => clean(environment[key])) &&
    Boolean(
      clean(environment.FEISHU_WAREHOUSE_APP_TOKEN) ||
      clean(environment.FEISHU_WAREHOUSE_SOURCE_URL),
    );
  if (!enabled) return;
  const script = fileURLToPath(
    new URL('./ensure-inventory-outbound-approval-fields.mjs', import.meta.url),
  );
  const startedAt = Date.now();
  process.stdout.write(
    '[INFO] Checking candidate outbound approval fields before downtime (read-only).\n',
  );
  const result = await new Promise((resolveChild, reject) => {
    // The staged candidate script uses the actual installer Node and server environment.
    const child = spawn(
      process.execPath,
      [script, '--dry-run', '--require-ready'],
      {
        cwd: root,
        env: environment,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let output = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, 75000);
    const capture = (chunk) => {
      output = (output + chunk).slice(-8192);
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    child.once('error', () => {
      clearTimeout(timer);
      reject(
        new PublicError(
          'OUTBOUND_PREFLIGHT_EXEC: candidate field checker could not start before downtime.',
        ),
      );
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolveChild({ code, output, timedOut });
    });
  });
  if (result.code !== 0 || result.timedOut) {
    let output = result.output.trim();
    for (const [key, value] of Object.entries(environment)) {
      if (
        /SECRET|TOKEN|PASSWORD|ENCRYPT|APP_ID|SOURCE_URL|TABLE_ID/u.test(key) &&
        typeof value === 'string' &&
        value.length > 0
      ) {
        output = output.split(value).join('[REDACTED]');
      }
    }
    throw new PublicError(
      `OUTBOUND_PREFLIGHT_REJECTED before downtime (exit=${result.code}, timeout=${result.timedOut}, elapsedMs=${Date.now() - startedAt}):\n${output || 'No checker output was returned.'}`,
    );
  }
  process.stdout.write(
    `[OK] Candidate outbound field schema is ready before downtime (elapsedMs=${Date.now() - startedAt}).\n`,
  );
}

function resolveConfiguredManagerOpenId(environment) {
  const dedicatedManagerOpenId = clean(
    environment.PURCHASE_MANAGER_APPROVER_OPEN_ID,
  );
  if (OPEN_ID_PATTERN.test(dedicatedManagerOpenId)) {
    return dedicatedManagerOpenId;
  }
  const approvers = readOpenIdValues(
    environment.PURCHASE_WORKFLOW_APPROVER_OPEN_IDS,
  );
  const administrators = new Set(
    readOpenIdValues(environment.FEISHU_ACCESS_ADMIN_OPEN_IDS),
  );
  const matches = approvers.filter((openId) => administrators.has(openId));
  return matches.length === 1 ? matches[0] : '';
}

async function resolveManagerOpenIdFromOrganizationBase(client, environment) {
  const appToken = clean(environment.FEISHU_PURCHASE_INVENTORY_APP_TOKEN);
  const tableId = clean(environment.FEISHU_PURCHASE_ORGANIZATION_TABLE_ID);
  if (!isValidSourceToken(appToken) || !TABLE_ID_PATTERN.test(tableId)) {
    throw new PublicError(
      'PURCHASE_MANAGER_APPROVER_OPEN_ID cannot be resolved until the purchase Base and organization table are configured.',
    );
  }
  const targetName =
    clean(environment.PURCHASE_MANAGER_APPROVER_NAME) ||
    DEFAULT_MANAGER_APPROVER_NAME;
  const records = await client.listRecords(appToken, tableId);
  const matches = new Set();
  for (const record of records) {
    const fields = record?.fields;
    if (!fields || typeof fields !== 'object' || isInactiveRecord(fields)) {
      continue;
    }
    const positions = extractDisplayValues(fields['职位']).map(normalizeText);
    if (!positions.some((position) => MANAGER_POSITIONS.has(position)))
      continue;
    const textNames = extractDisplayValues(
      fields['示例人员001（文本）'] ?? fields['姓名'],
    ).map(normalizePersonName);
    for (const user of extractUsers(
      fields['示例人员001'] ?? fields['人员'] ?? fields['姓名'],
    )) {
      const names = [...textNames, normalizePersonName(user.name)].filter(
        Boolean,
      );
      if (
        names.includes(normalizePersonName(targetName)) &&
        OPEN_ID_PATTERN.test(user.openId)
      ) {
        matches.add(user.openId);
      }
    }
  }
  if (matches.size !== 1) {
    throw new PublicError(
      'PURCHASE_MANAGER_APPROVER_OPEN_ID is missing and the configured manager name did not identify exactly one active manager in the organization Base.',
    );
  }
  return [...matches][0];
}

async function resolvePurchaseAdminOpenIdFromOrganizationBase(
  client,
  environment,
) {
  const appToken = clean(environment.FEISHU_PURCHASE_INVENTORY_APP_TOKEN);
  const tableId = clean(environment.FEISHU_PURCHASE_ORGANIZATION_TABLE_ID);
  if (!isValidSourceToken(appToken) || !TABLE_ID_PATTERN.test(tableId)) {
    throw new PublicError(
      'PURCHASE_WORKFLOW_PURCHASE_ADMIN_OPEN_ID cannot be resolved until the purchase Base and organization table are configured.',
    );
  }
  const targetName =
    clean(environment.PURCHASE_WORKFLOW_PURCHASE_ADMIN_NAME) ||
    DEFAULT_PURCHASE_ADMIN_NAME;
  const records = await client.listRecords(appToken, tableId);
  const matches = new Set();
  for (const record of records) {
    const fields = record?.fields;
    if (!fields || typeof fields !== 'object' || isInactiveRecord(fields)) {
      continue;
    }
    const positions = extractDisplayValues(fields['职位']).map(normalizeText);
    if (!positions.some((position) => PURCHASE_ADMIN_POSITIONS.has(position))) {
      continue;
    }
    const textNames = extractDisplayValues(
      fields['示例人员001（文本）'] ?? fields['姓名'],
    ).map(normalizePersonName);
    for (const user of extractUsers(
      fields['示例人员001'] ?? fields['人员'] ?? fields['姓名'],
    )) {
      const names = [...textNames, normalizePersonName(user.name)].filter(
        Boolean,
      );
      if (
        names.includes(normalizePersonName(targetName)) &&
        OPEN_ID_PATTERN.test(user.openId)
      ) {
        matches.add(user.openId);
      }
    }
  }
  if (matches.size !== 1) {
    throw new PublicError(
      'PURCHASE_WORKFLOW_PURCHASE_ADMIN_OPEN_ID is missing and the configured purchase administrator name did not identify exactly one active comprehensive-management user in the organization Base.',
    );
  }
  return [...matches][0];
}

function validateInteractiveWorkflowConfiguration(
  environment,
  { validateWarehouseManager = true } = {},
) {
  const workflowEnabled = isEnabled(
    environment.PURCHASE_WORKFLOW_PROGRAM_ENABLED,
  );
  const managerBatchEnabled = isEnabled(
    environment.PURCHASE_MANAGER_APPROVAL_CARD_ENABLED,
  );
  if (!workflowEnabled && !managerBatchEnabled) return [];

  const errors = [];
  if (managerBatchEnabled && !workflowEnabled) {
    errors.push(
      'PURCHASE_WORKFLOW_PROGRAM_ENABLED must be enabled when PURCHASE_MANAGER_APPROVAL_CARD_ENABLED is enabled.',
    );
  }
  for (const key of ['FEISHU_APP_ID', 'FEISHU_APP_SECRET']) {
    const value = clean(environment[key]);
    if (!value || value.length > MAX_CONFIGURATION_VALUE_LENGTH) {
      errors.push(`${key} must be non-empty and reasonably sized.`);
    }
  }

  if (
    !TABLE_ID_PATTERN.test(
      clean(environment.FEISHU_PURCHASE_ORGANIZATION_TABLE_ID),
    )
  ) {
    errors.push(
      'FEISHU_PURCHASE_ORGANIZATION_TABLE_ID must be a valid table identifier.',
    );
  }

  const approvers = clean(environment.PURCHASE_WORKFLOW_APPROVER_OPEN_IDS)
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (
    approvers.length !== 2 ||
    new Set(approvers).size !== 2 ||
    approvers.some((value) => !OPEN_ID_PATTERN.test(value))
  ) {
    errors.push(
      'PURCHASE_WORKFLOW_APPROVER_OPEN_IDS must contain exactly two unique valid open_id values.',
    );
  }

  if (
    !OPEN_ID_PATTERN.test(
      clean(environment.PURCHASE_WORKFLOW_PURCHASE_ADMIN_OPEN_ID),
    )
  ) {
    errors.push(
      'PURCHASE_WORKFLOW_PURCHASE_ADMIN_OPEN_ID must be a valid open_id.',
    );
  }

  if (managerBatchEnabled) {
    const dedicatedManagerOpenId = clean(
      environment.PURCHASE_MANAGER_APPROVER_OPEN_ID,
    );
    if (dedicatedManagerOpenId) {
      if (!OPEN_ID_PATTERN.test(dedicatedManagerOpenId)) {
        errors.push(
          'PURCHASE_MANAGER_APPROVER_OPEN_ID must be a valid open_id when manager batch approval cards are enabled.',
        );
      }
    } else {
      const administrators = clean(environment.FEISHU_ACCESS_ADMIN_OPEN_IDS)
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);
      const administratorSet = new Set(administrators);
      const fallbackManagers = approvers.filter((openId) =>
        administratorSet.has(openId),
      );
      if (
        administrators.some((value) => !OPEN_ID_PATTERN.test(value)) ||
        fallbackManagers.length !== 1
      ) {
        errors.push(
          'PURCHASE_MANAGER_APPROVER_OPEN_ID must be a valid open_id, or FEISHU_ACCESS_ADMIN_OPEN_IDS must identify exactly one configured purchase workflow approver.',
        );
      }
    }
  }

  const verificationToken = clean(
    environment.FEISHU_PURCHASE_CARD_VERIFICATION_TOKEN,
  );
  if (
    !verificationToken ||
    verificationToken.length > MAX_CONFIGURATION_VALUE_LENGTH
  ) {
    errors.push(
      'FEISHU_PURCHASE_CARD_VERIFICATION_TOKEN must be non-empty and reasonably sized.',
    );
  }

  const rawEncryptKey = environment.FEISHU_PURCHASE_CARD_ENCRYPT_KEY;
  if (typeof rawEncryptKey === 'string' && rawEncryptKey.length > 0) {
    const encryptKey = clean(rawEncryptKey);
    if (
      encryptKey.length < MIN_ENCRYPT_KEY_LENGTH ||
      encryptKey.length > MAX_CONFIGURATION_VALUE_LENGTH
    ) {
      errors.push(
        'FEISHU_PURCHASE_CARD_ENCRYPT_KEY must be non-empty and reasonably sized when configured.',
      );
    }
  }

  if (!isValidPublicBaseUrl(clean(environment.PUBLIC_BASE_URL))) {
    errors.push(
      'PUBLIC_BASE_URL must be HTTPS, or HTTP on localhost, without credentials, query, or hash.',
    );
  }

  const pollInterval =
    clean(environment.PURCHASE_WORKFLOW_TASK_POLL_INTERVAL_MS) || '5000';
  if (
    !/^\d+$/.test(pollInterval) ||
    Number(pollInterval) < MIN_POLL_INTERVAL_MS ||
    Number(pollInterval) > MAX_POLL_INTERVAL_MS
  ) {
    errors.push(
      `PURCHASE_WORKFLOW_TASK_POLL_INTERVAL_MS must be an integer from ${MIN_POLL_INTERVAL_MS} to ${MAX_POLL_INTERVAL_MS}.`,
    );
  }

  if (validateWarehouseManager) {
    validateWarehouseManagerConfiguration(environment, errors);
  }

  if (errors.length) {
    throw new PublicError(
      `Interactive purchase workflow configuration is invalid: ${errors.join(
        ' ',
      )}`,
    );
  }

  const ledgerPath =
    clean(environment.PURCHASE_WORKFLOW_LEDGER_PATH) ||
    '.runtime/purchase-workflow-ledger.json';
  return [
    'Confirm that replaced legacy Feishu Base automations are disabled; this cannot be verified locally.',
    `Ensure the parent directory for PURCHASE_WORKFLOW_LEDGER_PATH (${
      dirname(ledgerPath) || '.'
    }) exists, is writable, and persists across deployments.`,
  ];
}

async function repairWarehouseManagerConfiguration(client, environment) {
  const validationErrors = [];
  validateWarehouseManagerConfiguration(environment, validationErrors);
  if (!validationErrors.length) {
    try {
      const configured = await resolveWarehouseManagerLocation(
        client,
        environment,
      );
      if (
        configured &&
        (await hasWarehouseRoleFields(
          client,
          configured.appToken,
          configured.tableId,
        ))
      ) {
        return {};
      }
    } catch (error) {
      if (!(error instanceof PublicError)) throw error;
    }
  }

  const tableId = await discoverWarehouseManagerTable(client, environment);
  return {
    FEISHU_WAREHOUSE_MANAGER_SOURCE_URL: '',
    FEISHU_WAREHOUSE_MANAGER_APP_TOKEN: '',
    FEISHU_WAREHOUSE_MANAGER_WIKI_TOKEN: '',
    FEISHU_WAREHOUSE_MANAGER_TABLE_ID: tableId,
    FEISHU_WAREHOUSE_MANAGER_VIEW_ID: '',
  };
}

async function resolveWarehouseManagerLocation(client, environment) {
  const usesDedicatedSource = hasDedicatedWarehouseManagerSource(environment);
  const sourceUrl = clean(
    usesDedicatedSource
      ? environment.FEISHU_WAREHOUSE_MANAGER_SOURCE_URL
      : environment.FEISHU_WAREHOUSE_SOURCE_URL,
  );
  const explicitAppToken = clean(
    usesDedicatedSource
      ? environment.FEISHU_WAREHOUSE_MANAGER_APP_TOKEN
      : environment.FEISHU_WAREHOUSE_APP_TOKEN,
  );
  const explicitWikiToken = usesDedicatedSource
    ? clean(environment.FEISHU_WAREHOUSE_MANAGER_WIKI_TOKEN)
    : '';
  const parsedSource = parseSource(sourceUrl);
  const appToken =
    explicitAppToken ||
    (parsedSource?.type === 'app' ? parsedSource.token : '');
  const wikiToken =
    explicitWikiToken ||
    (parsedSource?.type === 'wiki' ? parsedSource.token : '');
  const resolvedAppToken =
    appToken || (await client.resolveWikiToken(wikiToken));
  const tableId = clean(environment.FEISHU_WAREHOUSE_MANAGER_TABLE_ID);
  if (
    !isValidSourceToken(resolvedAppToken) ||
    !TABLE_ID_PATTERN.test(tableId)
  ) {
    return undefined;
  }
  return { appToken: resolvedAppToken, tableId };
}

async function discoverWarehouseManagerTable(client, environment) {
  try {
    const appToken = await resolveSharedWarehouseAppToken(client, environment);
    const tables = await client.listTables(appToken);
    const candidateTableIds = [
      ...new Set(
        tables
          .filter(
            (table) =>
              normalizeBusinessTableName(table?.name) ===
              WAREHOUSE_MANAGER_TABLE_NAME,
          )
          .map((table) => clean(table?.table_id))
          .filter((tableId) => TABLE_ID_PATTERN.test(tableId)),
      ),
    ];
    const validTableIds = [];
    for (const tableId of candidateTableIds) {
      if (await hasWarehouseRoleFields(client, appToken, tableId)) {
        validTableIds.push(tableId);
      }
    }
    if (validTableIds.length === 1) return validTableIds[0];
  } catch (error) {
    if (!(error instanceof PublicError)) throw error;
  }
  throw new PublicError(
    'Automatic warehouse approval-role source discovery requires exactly one valid warehouse role table named 配置楼栋负责人 with fields 楼栋, 库房示例人员019员, and 库房管理人 in the shared warehouse Base.',
  );
}

async function resolveSharedWarehouseAppToken(client, environment) {
  const explicitAppToken = clean(environment.FEISHU_WAREHOUSE_APP_TOKEN);
  if (explicitAppToken) {
    if (!isValidSourceToken(explicitAppToken)) {
      throw new PublicError('The shared warehouse Base source is invalid.');
    }
    return explicitAppToken;
  }
  const source = parseSource(clean(environment.FEISHU_WAREHOUSE_SOURCE_URL));
  if (!source || !isValidSourceToken(source.token)) {
    throw new PublicError('The shared warehouse Base source is invalid.');
  }
  return source.type === 'wiki'
    ? client.resolveWikiToken(source.token)
    : source.token;
}

async function hasWarehouseRoleFields(client, appToken, tableId) {
  const fields = await client.listFields(appToken, tableId);
  const fieldNames = new Set(
    fields.map((field) => normalizeText(field?.field_name)).filter(Boolean),
  );
  return [
    ...WAREHOUSE_APPROVAL_REQUIRED_FIELDS,
    ...WAREHOUSE_NOTIFICATION_REQUIRED_FIELDS,
  ].every((fieldName) => fieldNames.has(fieldName));
}

function validateWarehouseManagerConfiguration(environment, errors) {
  const dedicatedSourceUrl = clean(
    environment.FEISHU_WAREHOUSE_MANAGER_SOURCE_URL,
  );
  const dedicatedAppToken = clean(
    environment.FEISHU_WAREHOUSE_MANAGER_APP_TOKEN,
  );
  const dedicatedWikiToken = clean(
    environment.FEISHU_WAREHOUSE_MANAGER_WIKI_TOKEN,
  );
  const usesDedicatedSource = hasDedicatedWarehouseManagerSource(environment);
  const sourceUrl = usesDedicatedSource
    ? dedicatedSourceUrl
    : clean(environment.FEISHU_WAREHOUSE_SOURCE_URL);
  const appToken = usesDedicatedSource
    ? dedicatedAppToken
    : clean(environment.FEISHU_WAREHOUSE_APP_TOKEN);
  const wikiToken = usesDedicatedSource ? dedicatedWikiToken : '';
  const tableId = clean(environment.FEISHU_WAREHOUSE_MANAGER_TABLE_ID);
  const viewId = clean(environment.FEISHU_WAREHOUSE_MANAGER_VIEW_ID);

  if (sourceUrl && !isValidWarehouseSourceUrl(sourceUrl)) {
    errors.push(
      'FEISHU_WAREHOUSE_MANAGER_SOURCE_URL must be a valid HTTPS Feishu Base or Wiki URL.',
    );
  }
  if (
    usesDedicatedSource &&
    sourceUrl &&
    isValidWarehouseSourceUrl(sourceUrl)
  ) {
    const source = new URL(sourceUrl);
    const sourceTableId = clean(source.searchParams.get('table'));
    const sourceViewId = clean(source.searchParams.get('view'));
    if (sourceTableId && tableId && sourceTableId !== tableId) {
      errors.push(
        'FEISHU_WAREHOUSE_MANAGER_TABLE_ID must match the table in FEISHU_WAREHOUSE_MANAGER_SOURCE_URL.',
      );
    }
    if (sourceViewId && viewId && sourceViewId !== viewId) {
      errors.push(
        'FEISHU_WAREHOUSE_MANAGER_VIEW_ID must match the view in FEISHU_WAREHOUSE_MANAGER_SOURCE_URL.',
      );
    }
  }
  if (appToken && !isValidSourceToken(appToken)) {
    errors.push(
      'FEISHU_WAREHOUSE_MANAGER_APP_TOKEN has an invalid identifier format.',
    );
  }
  if (wikiToken && !isValidSourceToken(wikiToken)) {
    errors.push(
      'FEISHU_WAREHOUSE_MANAGER_WIKI_TOKEN has an invalid identifier format.',
    );
  }
  if (!sourceUrl && !appToken && !wikiToken) {
    errors.push(
      'Configure a dedicated warehouse approval-role source, or provide FEISHU_WAREHOUSE_SOURCE_URL / FEISHU_WAREHOUSE_APP_TOKEN as the shared warehouse Base source.',
    );
  }
  if (!TABLE_ID_PATTERN.test(tableId)) {
    errors.push(
      'FEISHU_WAREHOUSE_MANAGER_TABLE_ID must be a valid table identifier.',
    );
  }
  if (viewId && !VIEW_ID_PATTERN.test(viewId)) {
    errors.push(
      'FEISHU_WAREHOUSE_MANAGER_VIEW_ID must be a valid view identifier when configured.',
    );
  }
}

function hasDedicatedWarehouseManagerSource(environment) {
  return Boolean(
    clean(environment.FEISHU_WAREHOUSE_MANAGER_SOURCE_URL) ||
    clean(environment.FEISHU_WAREHOUSE_MANAGER_APP_TOKEN) ||
    clean(environment.FEISHU_WAREHOUSE_MANAGER_WIKI_TOKEN),
  );
}

function readOpenIdValues(value) {
  return clean(value)
    .split(',')
    .map((item) => item.trim())
    .filter((item) => OPEN_ID_PATTERN.test(item));
}

function extractUsers(value) {
  const users = [];
  const stack = [value];
  const visited = new WeakSet();
  while (stack.length) {
    const current = stack.shift();
    if (!current || typeof current !== 'object') continue;
    if (visited.has(current)) continue;
    visited.add(current);
    if (Array.isArray(current)) {
      stack.unshift(...current);
      continue;
    }
    const openId = clean(
      current.open_id ?? current.openId ?? current.id ?? current.user_id,
    );
    const name = clean(current.name ?? current.text ?? current.display_name);
    if (openId) users.push({ openId, name });
    for (const nested of Object.values(current)) {
      if (nested && typeof nested === 'object') stack.push(nested);
    }
  }
  return users;
}

function extractDisplayValues(value) {
  const values = [];
  const stack = [value];
  const visited = new WeakSet();
  while (stack.length) {
    const current = stack.shift();
    if (typeof current === 'string' || typeof current === 'number') {
      const text = clean(String(current));
      if (text) values.push(text);
      continue;
    }
    if (!current || typeof current !== 'object') continue;
    if (visited.has(current)) continue;
    visited.add(current);
    if (Array.isArray(current)) {
      stack.unshift(...current);
      continue;
    }
    for (const key of ['name', 'text', 'value']) {
      if (typeof current[key] === 'string') {
        const text = clean(current[key]);
        if (text) values.push(text);
      }
    }
    for (const nested of Object.values(current)) {
      if (nested && typeof nested === 'object') stack.push(nested);
    }
  }
  return [...new Set(values)];
}

function isInactiveRecord(fields) {
  const value = fields['离职/异动情况'];
  if (value === true || value === 1) return true;
  return extractDisplayValues(value).some((item) =>
    /^(?:true|yes|1|是|离职|异动)$/i.test(normalizeText(item)),
  );
}

function normalizePersonName(value) {
  return normalizeText(value).replace(/\s+/g, '');
}

function normalizeText(value) {
  return clean(value).normalize('NFKC');
}

function isValidPublicBaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username || url.password || url.search || url.hash) return false;
  if (url.protocol === 'https:') return true;
  const hostname = url.hostname.toLowerCase();
  return (
    url.protocol === 'http:' &&
    ['localhost', '127.0.0.1', '[::1]', '::1'].includes(hostname)
  );
}

function isValidWarehouseSourceUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    return false;
  }
  const match = url.pathname.match(/^\/(?:base|wiki)\/([^/]+)\/?$/i);
  return Boolean(match && isValidSourceToken(match[1]));
}

function isValidSourceToken(value) {
  return value.length <= 512 && SOURCE_TOKEN_PATTERN.test(value);
}

function isEnabled(value) {
  return /^(1|true|yes|on)$/i.test(clean(value));
}

async function findConfiguredMatch(client, environment, root) {
  const candidates = [];
  const explicitAppToken = clean(
    environment.FEISHU_PURCHASE_INVENTORY_APP_TOKEN,
  );
  if (explicitAppToken)
    candidates.push({ type: 'app', token: explicitAppToken });

  const source = parseSource(
    clean(environment.FEISHU_PURCHASE_INVENTORY_SOURCE_URL),
  );
  if (source) candidates.push(source);
  const explicitWikiToken = clean(
    environment.FEISHU_PURCHASE_INVENTORY_WIKI_TOKEN,
  );
  if (explicitWikiToken)
    candidates.push({ type: 'wiki', token: explicitWikiToken });

  const contractAppToken = clean(environment.FEISHU_CONTRACT_APP_TOKEN);
  if (contractAppToken)
    candidates.push({ type: 'app', token: contractAppToken });
  const contractSource = parseSource(
    clean(environment.FEISHU_CONTRACT_SOURCE_URL),
  );
  if (contractSource) candidates.push(contractSource);
  const contractWikiToken = clean(environment.FEISHU_CONTRACT_WIKI_TOKEN);
  if (contractWikiToken)
    candidates.push({ type: 'wiki', token: contractWikiToken });
  candidates.push(...(await readTrustedContractCandidates(root)));

  const checkedAppTokens = new Set();
  const checkedRawCandidates = new Set();
  for (const candidate of candidates) {
    const rawCandidateKey = `${candidate.type}:${candidate.token}`;
    if (checkedRawCandidates.has(rawCandidateKey)) continue;
    checkedRawCandidates.add(rawCandidateKey);
    let appToken;
    try {
      appToken =
        candidate.type === 'wiki'
          ? await client.resolveWikiToken(candidate.token)
          : candidate.token;
    } catch (error) {
      if (!(error instanceof PublicError)) throw error;
      continue;
    }
    if (!appToken || checkedAppTokens.has(appToken)) continue;
    checkedAppTokens.add(appToken);
    const tableIds = await tryMatchTables(client, appToken);
    if (tableIds) return { appToken, tableIds };
  }
  return undefined;
}

async function readTrustedContractCandidates(root) {
  const relativePaths = [
    'dist/server/modules/contract-management/contract-management.service.js',
    'server/modules/contract-management/contract-management.service.ts',
  ];
  const candidates = [];
  for (const relativePath of relativePaths) {
    let content;
    try {
      content = await readFile(join(root, relativePath), 'utf8');
    } catch {
      continue;
    }
    if (content.length > 2_000_000) continue;
    const urls = content.match(
      /https?:\/\/[^\s'"`]+\/(?:wiki|base)\/[A-Za-z0-9_-]+[^\s'"`]*/gi,
    );
    for (const url of urls || []) {
      const candidate = parseSource(url);
      if (candidate) candidates.push(candidate);
    }
  }
  return candidates;
}

async function findUniqueWikiMatch(client) {
  const spaces = await client.listWikiSpaces();
  const appTokens = new Set();
  let nodeCount = 0;

  for (const space of spaces) {
    const spaceId = clean(space?.space_id);
    if (!spaceId) continue;
    const parents = [''];
    const visitedParents = new Set();
    while (parents.length) {
      const parent = parents.shift();
      if (visitedParents.has(parent)) continue;
      visitedParents.add(parent);
      const nodes = await client.listWikiNodes(spaceId, parent);
      for (const node of nodes) {
        nodeCount += 1;
        if (nodeCount > MAX_WIKI_NODES) {
          throw new PublicError('Wiki node discovery budget was exceeded.');
        }
        const appToken = clean(node?.obj_token);
        if (node?.obj_type === 'bitable' && appToken) {
          appTokens.add(appToken);
          if (appTokens.size > MAX_BITABLE_CANDIDATES) {
            throw new PublicError('Wiki Base candidate budget was exceeded.');
          }
        }
        const childParent = clean(node?.node_token);
        if (
          node?.has_child &&
          childParent &&
          !visitedParents.has(childParent)
        ) {
          parents.push(childParent);
        }
      }
    }
  }

  const matches = [];
  for (const appToken of appTokens) {
    const tableIds = await tryMatchTables(client, appToken);
    if (tableIds) matches.push({ appToken, tableIds });
  }
  if (matches.length > 1) {
    throw new PublicError(
      'Automatic discovery found more than one Feishu Base with the required six-table signature.',
    );
  }
  return matches[0];
}

async function tryMatchTables(client, appToken) {
  let tables;
  try {
    tables = await client.listTables(appToken);
  } catch (error) {
    if (error instanceof PublicError) return undefined;
    throw error;
  }
  const byName = new Map();
  for (const table of tables) {
    const name = normalizeBusinessTableName(table?.name);
    const tableId = clean(table?.table_id);
    if (!name || !tableId) continue;
    const ids = byName.get(name) || [];
    ids.push(tableId);
    byName.set(name, ids);
  }
  const tableIds = {};
  for (const signature of TABLE_SIGNATURE) {
    const ids = byName.get(signature.name) || [];
    if (ids.length !== 1) return undefined;
    tableIds[signature.env] = ids[0];
  }
  return tableIds;
}

function normalizeBusinessTableName(value) {
  return clean(value)
    .replace(/^\d+\s*[-－—–_.、]?\s*/, '')
    .replace(/^【[^】]{1,30}】\s*/, '')
    .trim();
}

async function paginate(label, fetchPage) {
  const items = [];
  const seenTokens = new Set();
  let pageToken = '';
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const data = await fetchPage(pageToken);
    if (Array.isArray(data?.items)) items.push(...data.items);
    if (!data?.has_more) return items;
    const nextToken = clean(data?.page_token);
    if (!nextToken || seenTokens.has(nextToken)) {
      throw new PublicError(
        `Feishu ${label} pagination returned a repeated or empty token.`,
      );
    }
    seenTokens.add(nextToken);
    pageToken = nextToken;
  }
  throw new PublicError(`Feishu ${label} pagination exceeded the page budget.`);
}

function pageQuery(pageToken, pageSize = 100) {
  const query = new URLSearchParams({ page_size: String(pageSize) });
  if (pageToken) query.set('page_token', pageToken);
  return query.toString();
}

function parseSource(value) {
  if (!value) return undefined;
  let url;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  const match = url.pathname.match(/\/(base|wiki)\/([^/?#]+)/i);
  if (!match) return undefined;
  return {
    type: match[1].toLowerCase() === 'wiki' ? 'wiki' : 'app',
    token: match[2],
  };
}

function parseDotEnv(content) {
  const values = {};
  for (const rawLine of content.replace(/^\uFEFF/, '').split(/\r?\n|\r/)) {
    const match = rawLine.match(
      /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/,
    );
    if (!match) continue;
    values[match[1]] = parseDotEnvValue(match[2]);
  }
  return values;
}

function parseDotEnvValue(rawValue) {
  const value = rawValue.trim();
  if (
    value.length >= 2 &&
    value[0] === value[value.length - 1] &&
    ['"', "'"].includes(value[0])
  ) {
    return value.slice(1, -1);
  }
  return value.replace(/\s+#.*$/, '').trim();
}

async function atomicPatchDotEnv(path, original, updates, mode) {
  const patched = patchDotEnv(original, updates);
  await mkdir(dirname(path), { recursive: true });
  const tempPath = join(
    dirname(path),
    `.${basename(path)}.purchase-config-${process.pid}-${randomUUID()}.tmp`,
  );
  try {
    await writeFile(tempPath, patched, {
      encoding: 'utf8',
      mode: mode || 0o600,
    });
    if (mode) await chmod(tempPath, mode);
    await rename(tempPath, path);
  } finally {
    await rm(tempPath, { force: true }).catch(() => undefined);
  }
}

function patchDotEnv(original, updates) {
  const hasBom = original.startsWith('\uFEFF');
  const body = hasBom ? original.slice(1) : original;
  const eol = body.match(/\r\n|\n|\r/)?.[0] || '\n';
  const trailingNewline = /(?:\r\n|\n|\r)$/.test(body);
  const lines = body.split(/\r\n|\n|\r/);
  if (trailingNewline) lines.pop();
  const found = new Set();

  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(
      /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/,
    );
    const key = match?.[1];
    if (!key || !(key in updates)) continue;
    lines[index] = `${key}=${updates[key]}`;
    found.add(key);
  }
  for (const [key, value] of Object.entries(updates)) {
    if (!found.has(key)) lines.push(`${key}=${value}`);
  }
  const output = lines.join(eol) + (trailingNewline || lines.length ? eol : '');
  return (hasBom ? '\uFEFF' : '') + output;
}

async function readOptionalFile(path) {
  try {
    await access(path, fsConstants.F_OK);
    const [content, metadata] = await Promise.all([
      readFile(path, 'utf8'),
      stat(path),
    ]);
    return { exists: true, content, mode: metadata.mode };
  } catch (error) {
    if (error?.code === 'ENOENT')
      return { exists: false, content: '', mode: undefined };
    throw new PublicError('The deployment environment file could not be read.');
  }
}

function stringEnvironment(environment) {
  return Object.fromEntries(
    Object.entries(environment).filter((entry) => typeof entry[1] === 'string'),
  );
}

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function parseArguments(argv) {
  let root = process.cwd();
  let apiBaseUrl = DEFAULT_API_BASE_URL;
  let activateWorkflow = false;
  let checkOnly = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--activate-workflow') {
      activateWorkflow = true;
      continue;
    }
    if (argument === '--check-only') {
      checkOnly = true;
      continue;
    }
    if (argument === '--root' || argument === '--api-base-url') {
      const value = argv[index + 1];
      if (!value) throw new PublicError(`${argument} requires a value.`);
      if (argument === '--root') root = resolve(value);
      else apiBaseUrl = value;
      index += 1;
      continue;
    }
    throw new PublicError('Unknown command-line argument.');
  }
  return { root, apiBaseUrl, activateWorkflow, checkOnly };
}

async function main() {
  try {
    const options = parseArguments(process.argv.slice(2));
    let contractStatus;
    let accessStatus;
    if (options.activateWorkflow) {
      try {
        const access = await verifyFeishuAccessStartupAtRoot(options.root);
        accessStatus = access.status;
      } catch {
        throw new PublicError('FEISHU_ACCESS_CONFIGURATION_INVALID: access startup preflight rejected before downtime.');
      }
      try {
        const contract = await verifyContractStartupAtRoot(options.root);
        contractStatus = contract.status;
      } catch (error) {
        const reason = /^CONTRACT_[A-Z_]+$/.test(error?.message || '')
          ? error.message
          : 'CONTRACT_PREFLIGHT_FAILED';
        throw new PublicError(
          `${reason}: contract startup preflight rejected before downtime.`,
        );
      }
    }
    const result = await ensureConfiguration(options);
    if (accessStatus) {
      process.stdout.write(`[INFO] Feishu access read-only startup preflight: ${accessStatus}.\n`);
    }
    if (contractStatus) {
      process.stdout.write(
        `[INFO] Contract storage read-only startup preflight: ${contractStatus}.\n`,
      );
    }
    for (const warning of result.warnings || []) {
      process.stdout.write(`[WARN] ${warning}\n`);
    }
    if (result.checkOnly) {
      process.stdout.write(
        '[OK] Purchase inventory configuration read-only preflight passed.\n',
      );
      return;
    }
    if (result.activationReady) {
      process.stdout.write(
        `[OK] Purchase workflow runtime activation is ready; inventory configuration was ${
          result.changed ? 'repaired automatically' : 'already complete'
        }.\n`,
      );
    } else {
      process.stdout.write(
        result.changed
          ? '[OK] Purchase inventory configuration was repaired automatically.\n'
          : '[OK] Purchase inventory configuration is already complete.\n',
      );
    }
  } catch (error) {
    const message =
      error instanceof PublicError
        ? error.message
        : 'Automatic purchase inventory configuration failed unexpectedly.';
    process.stderr.write(`[ERROR] ${message}\n`);
    process.exitCode = 1;
  }
}

await main();
