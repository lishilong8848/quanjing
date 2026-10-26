import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { delimiter, dirname, join } from 'node:path';

const baseToken = firstEnv(
  'FEISHU_LEAVE_REQUEST_APP_TOKEN',
  'FEISHU_LEAVE_SUBSTITUTE_APP_TOKEN',
  'FEISHU_MAIN_APP_TOKEN',
  'FEISHU_BITABLE_APP_TOKEN',
);
const identity = firstEnv('FEISHU_LEAVE_MIGRATION_IDENTITY') || 'user';
const requestedWorkflowId = readArgument('--workflow-id');

if (!baseToken) fail('Missing configured leave Base app token.');

const result = runLark(
  requestedWorkflowId
    ? [
        'base',
        '+workflow-get',
        '--base-token',
        baseToken,
        '--workflow-id',
        requestedWorkflowId,
        '--as',
        identity,
        '--format',
        'json',
      ]
    : [
        'base',
        '+workflow-list',
        '--base-token',
        baseToken,
        '--as',
        identity,
        '--format',
        'json',
      ],
);
const workflows = collectWorkflows(result);
const rawItems = Array.isArray(result?.data?.items) ? result.data.items : [];
process.stdout.write(
  `${JSON.stringify({
    success: true,
    identity,
    workflows: workflows.map((workflow) => ({
      workflowId: String(workflow.workflow_id || workflow.id || ''),
      name: String(workflow.name || workflow.workflow_name || workflow.title || ''),
      status: String(workflow.status || ''),
    })),
    structure: describeStructure(result),
    itemSample: rawItems.slice(0, 3).map((item) => ({
      keys: item && typeof item === 'object' ? Object.keys(item).filter((key) => !/(token|secret|key)/iu.test(key)) : [],
      id: item?.workflow_id || item?.id || item?.block_id || '',
      name: item?.name || item?.workflow_name || item?.block_name || item?.title || '',
      status: item?.status || '',
      type: item?.type || item?.block_type || item?.resource_type || '',
    })),
    definition: requestedWorkflowId ? redactDefinition(result?.data ?? result) : undefined,
  })}\n`,
);

function readArgument(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return '';
  const value = process.argv[index + 1]?.trim();
  if (!value?.startsWith('wkf')) fail(`Invalid ${name}.`);
  return value;
}

function runLark(commandArgs) {
  const command = resolveLarkCommand();
  const result = spawnSync(command.executable, [...command.prefix, ...commandArgs], {
    encoding: 'utf8',
    windowsHide: true,
    shell: false,
    env: process.env,
  });
  if (result.error || result.status !== 0) {
    fail(safeMessage(result.stderr || result.stdout || result.error?.message));
  }
  try {
    return JSON.parse(String(result.stdout || '{}'));
  } catch {
    fail('lark-cli returned non-JSON output.');
  }
}

function collectWorkflows(value) {
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectWorkflows(item));
  }
  if (!value || typeof value !== 'object') return [];
  if ((value.workflow_id || value.id) && (value.name || value.workflow_name || value.title)) return [value];
  return Object.values(value).flatMap((item) => collectWorkflows(item));
}

function describeStructure(value, depth = 0) {
  if (depth >= 3 || value === null || typeof value !== 'object') {
    return Array.isArray(value) ? 'array' : typeof value;
  }
  if (Array.isArray(value)) {
    return { arrayLength: value.length, item: value.length ? describeStructure(value[0], depth + 1) : null };
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !/(token|secret|key)/iu.test(key))
      .map(([key, item]) => [key, describeStructure(item, depth + 1)]),
  );
}

function redactDefinition(value, key = '') {
  if (/(?:token|secret|password|authorization|cookie)/iu.test(key)) return '[redacted]';
  if (typeof value === 'string') {
    return value
      .replace(/\b(?:ou|on|oc)_[A-Za-z0-9_-]+\b/gu, '[user_id]')
      .replace(/\b(?:app|bascn|base)_[A-Za-z0-9_-]+\b/giu, '[resource_id]');
  }
  if (Array.isArray(value)) return value.map((item) => redactDefinition(item));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([entryKey, item]) => [entryKey, redactDefinition(item, entryKey)]));
}

function resolveLarkCommand() {
  const configured = firstEnv('LARK_CLI_BIN');
  if (configured) {
    if (/\.(?:cjs|mjs|js)$/iu.test(configured)) {
      return { executable: process.execPath, prefix: [configured] };
    }
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
