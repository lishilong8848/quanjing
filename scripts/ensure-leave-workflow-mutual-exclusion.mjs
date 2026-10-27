import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { delimiter, dirname, join, relative } from 'node:path';

const LEAVE_TABLE_NAME = '【勿动】员工请休假';
const SOURCE_FIELD_NAME = '审批来源';
const PROGRAM_CARD_SOURCE = '程序卡片';
const args = process.argv.slice(2);
const apply = args.includes('--apply');
const requireReady = args.includes('--require-ready');
const identity = firstEnv('FEISHU_LEAVE_MIGRATION_IDENTITY') || 'user';
const baseToken = firstEnv(
  'FEISHU_LEAVE_REQUEST_APP_TOKEN',
  'FEISHU_LEAVE_SUBSTITUTE_APP_TOKEN',
  'FEISHU_MAIN_APP_TOKEN',
  'FEISHU_BITABLE_APP_TOKEN',
);

if (!baseToken) fail('Missing configured leave Base app token.');

const sourceField = findSourceField(getField(baseToken, SOURCE_FIELD_NAME));
const programOption = findProgramCardOption(sourceField);
const workflows = listWorkflows(baseToken)
  .filter((workflow) => /请休假|员工请休假/u.test(String(workflow.title || workflow.name || '')))
  .map((workflow) => getWorkflow(baseToken, workflow.workflow_id));
const targetWorkflows = workflows.filter((workflow) => hasLeaveTableTrigger(workflow));

if (targetWorkflows.length === 0) {
  fail(`No workflows with a trigger on ${LEAVE_TABLE_NAME} were found.`);
}

const reports = targetWorkflows.map((workflow) => inspectWorkflow(workflow, programOption));
const pending = reports.filter((report) => !report.ready);
if (requireReady && pending.length > 0) {
  fail(`Legacy leave workflows are not mutually exclusive: ${pending.map((item) => item.title).join(', ')}`);
}

if (apply) {
  for (const report of pending) {
    const updated = addProgramCardExclusion(report.workflow, programOption);
    updateWorkflow(baseToken, updated);
  }
}

const verified = apply
  ? targetWorkflows
      .map((workflow) => getWorkflow(baseToken, workflow.workflow_id))
      .map((workflow) => inspectWorkflow(workflow, programOption))
  : reports;
const notReady = verified.filter((report) => !report.ready);
if ((apply || requireReady) && notReady.length > 0) {
  fail(`Legacy leave workflow verification failed: ${notReady.map((item) => item.title).join(', ')}`);
}

process.stdout.write(
  `${JSON.stringify({
    success: true,
    apply,
    identity,
    sourceField: SOURCE_FIELD_NAME,
    programSource: PROGRAM_CARD_SOURCE,
    workflows: verified.map(({ workflow, ...report }) => report),
  })}\n`,
);

function getField(token, fieldId) {
  return runLark([
    'base',
    '+field-get',
    '--base-token',
    token,
    '--table-id',
    'tblpCzmTT3EapaUY',
    '--field-id',
    fieldId,
    '--as',
    identity,
    '--format',
    'json',
  ], { retryableRead: true });
}

function listWorkflows(token) {
  const result = runLark([
    'base',
    '+workflow-list',
    '--base-token',
    token,
    '--as',
    identity,
    '--format',
    'json',
  ], { retryableRead: true });
  const items = result?.data?.items;
  if (!Array.isArray(items)) fail('Workflow list returned no items.');
  return items.filter((item) => item?.workflow_id);
}

function getWorkflow(token, workflowId) {
  const result = runLark([
    'base',
    '+workflow-get',
    '--base-token',
    token,
    '--workflow-id',
    workflowId,
    '--as',
    identity,
    '--format',
    'json',
  ], { retryableRead: true });
  if (!result?.data?.workflow_id || !Array.isArray(result.data.steps)) {
    fail(`Workflow ${workflowId} returned an invalid definition.`);
  }
  return result.data;
}

function updateWorkflow(token, workflow) {
  const directory = mkdtempSync(join(process.cwd(), '.leave-workflow-update-'));
  const file = join(directory, 'workflow.json');
  try {
    writeFileSync(
      file,
      `${JSON.stringify({ title: workflow.title, steps: workflow.steps })}\n`,
      { encoding: 'utf8', mode: 0o600, flag: 'wx' },
    );
    runLark([
      'base',
      '+workflow-update',
      '--base-token',
      token,
      '--workflow-id',
      workflow.workflow_id,
      '--as',
      identity,
      '--json',
      `@${relative(process.cwd(), file).replaceAll('\\', '/')}`,
      '--format',
      'json',
    ], { retryableRead: true });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function findSourceField(value) {
  const source = value?.data || value;
  const field = source?.field || source;
  if (!field) fail(`Missing ${SOURCE_FIELD_NAME} field. Run the leave field migration first.`);
  const type = String(field.type || '').toLowerCase();
  if (!(type === 'select' || Number(field.type) === 3)) {
    fail(
      `${SOURCE_FIELD_NAME} must be a single select field. Received type=${String(field.type)} keys=${Object.keys(field).join(', ')}.`,
    );
  }
  return field;
}

function findProgramCardOption(field) {
  const options = collectOptions(field);
  const option = options.find((item) => String(item?.name || '').trim() === PROGRAM_CARD_SOURCE);
  const optionId = option?.id || option?.option_id;
  if (!option) {
    fail(
      `Missing ${PROGRAM_CARD_SOURCE} option in ${SOURCE_FIELD_NAME}. Available options: ${options
        .map((item) => String(item?.name || '').trim())
        .filter(Boolean)
        .join(', ') || 'none'}.`,
    );
  }
  // The Base workflow API permits option-name-only filters. Field reads intentionally omit option IDs.
  return optionId ? { id: String(optionId), name: PROGRAM_CARD_SOURCE } : { name: PROGRAM_CARD_SOURCE };
}

function collectOptions(value) {
  if (Array.isArray(value)) {
    const direct = value.filter((item) => item && typeof item === 'object' && ('id' in item || 'name' in item));
    return direct.length ? direct : value.flatMap((item) => collectOptions(item));
  }
  if (!value || typeof value !== 'object') return [];
  for (const key of ['options', 'option_list', 'select_options', 'property', 'config']) {
    const options = collectOptions(value[key]);
    if (options.length) return options;
  }
  return [];
}

function hasLeaveTableTrigger(workflow) {
  return workflow.steps.some(
    (step) => isTrigger(step) && String(step?.data?.table_name || '').trim() === LEAVE_TABLE_NAME,
  );
}

function inspectWorkflow(workflow, programOption) {
  const leaveTriggers = workflow.steps.filter(
    (step) => isTrigger(step) && String(step?.data?.table_name || '').trim() === LEAVE_TABLE_NAME,
  );
  const missingTriggerIds = leaveTriggers
    .filter((step) => !hasProgramCardExclusion(step, programOption))
    .map((step) => step.id);
  return {
    workflow,
    workflowId: workflow.workflow_id,
    title: workflow.title,
    triggerCount: leaveTriggers.length,
    ready: missingTriggerIds.length === 0,
    missingTriggerIds,
  };
}

function addProgramCardExclusion(workflow, programOption) {
  const cloned = structuredClone(workflow);
  for (const step of cloned.steps) {
    if (!isTrigger(step) || String(step?.data?.table_name || '').trim() !== LEAVE_TABLE_NAME) continue;
    if (hasProgramCardExclusion(step, programOption)) continue;
    const condition = programCardExclusionCondition(programOption);
    if (!Array.isArray(step.data.condition_list) || step.data.condition_list.length === 0) {
      step.data.condition_list = [{ conjunction: 'and', conditions: [condition] }];
      continue;
    }
    step.data.condition_list = step.data.condition_list.map((group) => ({
      ...group,
      conjunction: group?.conjunction || 'and',
      conditions: [...(Array.isArray(group?.conditions) ? group.conditions : []), condition],
    }));
  }
  return cloned;
}

function hasProgramCardExclusion(step, programOption) {
  const groups = Array.isArray(step?.data?.condition_list) ? step.data.condition_list : [];
  if (groups.length === 0) return false;
  return groups.every((group) =>
    Array.isArray(group?.conditions) &&
    group.conditions.some(
      (condition) =>
        condition?.field_name === SOURCE_FIELD_NAME &&
        condition?.operator === 'doesNotContainAny' &&
        conditionContainsOption(condition, programOption),
    ),
  );
}

function programCardExclusionCondition(programOption) {
  return {
    field_name: SOURCE_FIELD_NAME,
    operator: 'doesNotContainAny',
    value: [{ value: programOption, value_type: 'option' }],
  };
}

function conditionContainsOption(condition, programOption) {
  return Array.isArray(condition?.value) && condition.value.some((item) => {
    const value = item?.value;
    return (
      (typeof programOption.id === 'string' && value?.id === programOption.id) ||
      value?.name === programOption.name
    );
  });
}

function isTrigger(step) {
  return Boolean(step?.type && /Trigger$/u.test(step.type));
}

function extractFields(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return [];
  for (const key of ['items', 'fields', 'data']) {
    const candidate = value[key];
    if (Array.isArray(candidate)) return candidate;
    const nested = extractFields(candidate);
    if (nested.length) return nested;
  }
  return [];
}

function runLark(commandArgs, { retryableRead = false } = {}) {
  const command = resolveLarkCommand();
  let lastFailure = '';
  for (let attempt = 1; attempt <= (retryableRead ? 3 : 1); attempt += 1) {
    const result = spawnSync(command.executable, [...command.prefix, ...commandArgs], {
      encoding: 'utf8',
      windowsHide: true,
      shell: false,
      env: process.env,
    });
    if (!result.error && result.status === 0) {
      try {
        return JSON.parse(String(result.stdout || '{}'));
      } catch {
        fail('lark-cli returned non-JSON output.');
      }
    }
    lastFailure = safeMessage(result.stderr || result.stdout || result.error?.message);
    if (attempt < (retryableRead ? 3 : 1) && /retryable|server_error|Internal Error/iu.test(lastFailure)) {
      sleep(attempt * 400);
      continue;
    }
    break;
  }
  fail(lastFailure);
}

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function resolveLarkCommand() {
  const configured = firstEnv('LARK_CLI_BIN');
  if (configured) {
    if (/\.(?:cjs|mjs|js)$/iu.test(configured)) return { executable: process.execPath, prefix: [configured] };
    return wrapPowerShell(configured);
  }
  if (process.platform !== 'win32') return { executable: 'lark-cli', prefix: [] };
  const scripts = [
    join(dirname(process.execPath), 'lark-cli.ps1'),
    ...String(process.env.PATH || '')
      .split(delimiter)
      .filter(Boolean)
      .map((directory) => join(directory, 'lark-cli.ps1')),
  ];
  const script = scripts.find((candidate) => existsSync(candidate));
  return script ? wrapPowerShell(script) : { executable: 'lark-cli.exe', prefix: [] };
}

function wrapPowerShell(executable) {
  return process.platform === 'win32' && executable.toLowerCase().endsWith('.ps1')
    ? { executable: 'powershell.exe', prefix: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', executable] }
    : { executable, prefix: [] };
}

function firstEnv(...names) {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return '';
}

function safeMessage(value) {
  return String(value || 'unknown error')
    .replace(/\b(Bearer|Basic)\s+[^\s,;]+/giu, '$1 [redacted]')
    .replace(/\b(secret|token|password)\s*[:=]\s*[^\s,;]+/giu, '$1=[redacted]')
    .replace(/[\r\n]+/gu, ' ')
    .slice(0, 500);
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
