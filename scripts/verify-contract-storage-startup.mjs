import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import Module from 'node:module';
import { dirname, join, resolve, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseEnv } from 'node:util';

const credentialNames = [
  'CONTRACT_ATTACHMENT_ENCRYPTION_KEY', 'COS_SECRET_ID', 'COS_SECRET_KEY',
  'COS_SESSION_TOKEN', 'TENCENTCLOUD_SECRET_ID', 'TENCENTCLOUD_SECRET_KEY',
  'TENCENTCLOUD_SESSION_TOKEN',
];
const clean = value => String(value || '').trim();

export function loadContractStartupEnvironment(root, environment = process.env, windowsFallback = readWindowsFallback) {
  const effective = { ...environment };
  const fallback = windowsFallback(credentialNames.filter(name => !clean(effective[name])));
  for (const name of credentialNames) {
    if (!clean(effective[name]) && clean(fallback[name])) effective[name] = fallback[name];
  }
  const files = [join(dirname(root), 'nantong-schedule.private.env'), join(root, '.env'), join(root, '.env.local')];
  for (const file of files) {
    if (!existsSync(file)) continue;
    const values = parseEnv(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    for (const [name, value] of Object.entries(values)) {
      if (credentialNames.includes(name)) {
        if (clean(value)) effective[name] = value;
      } else if (file !== files[0]) {
        effective[name] = value;
      }
    }
  }
  return effective;
}

function readWindowsFallback(names) {
  if (process.platform !== 'win32' || !names.length) return {};
  const script = `$ErrorActionPreference='Stop'; $result=@{}; foreach($name in @(${names.map(name => `'${name}'`).join(',')})){foreach($target in @('User','Machine')){$value=[Environment]::GetEnvironmentVariable($name,$target);if(![string]::IsNullOrWhiteSpace($value)){$result[$name]=$value;break}}}; [Console]::Write(($result|ConvertTo-Json -Compress))`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, encoding: 'utf8', timeout: 10000 });
  if (result.status !== 0) throw new Error('CONTRACT_ENV_SOURCE_READ_FAILED');
  try { return JSON.parse(result.stdout.replace(/^\uFEFF/, '')); }
  catch { throw new Error('CONTRACT_ENV_SOURCE_READ_FAILED'); }
}

export async function verifyContractStorageStartup({ environment, createStorage }) {
  if (['false', '0', 'off', 'no'].includes(clean(environment.CONTRACT_ATTACHMENT_STORAGE_ENABLED).toLowerCase())) {
    return { status: 'disabled', readonly: true, writes: 0 };
  }
  const key = clean(environment.CONTRACT_ATTACHMENT_ENCRYPTION_KEY);
  if (!key) return { status: 'not-configured', readonly: true, writes: 0 };
  const decoded = Buffer.from(key, 'base64');
  if (decoded.length !== 32 || decoded.toString('base64') !== key) throw new Error('CONTRACT_KEY_INVALID');
  if (!(clean(environment.COS_SECRET_ID) || clean(environment.TENCENTCLOUD_SECRET_ID)) || !(clean(environment.COS_SECRET_KEY) || clean(environment.TENCENTCLOUD_SECRET_KEY))) {
    return { status: 'not-configured', readonly: true, writes: 0 };
  }
  const storage = createStorage(environment);
  if (!storage.getStatus().configured) throw new Error('CONTRACT_STORAGE_CONFIGURATION_INVALID');
  let content;
  try {
    content = await storage.readEncryptedObject(storage.indexObjectKey);
  } catch (error) {
    const status = Number(error?.statusCode);
    if (status === 404 || ['NoSuchKey', 'NoSuchObject'].includes(error?.code)) throw new Error('CONTRACT_INDEX_MISSING');
    if ([401, 403].includes(status)) throw new Error('CONTRACT_INDEX_AUTH_FAILED');
    if (error?.message === '\u5408\u540c\u9644\u4ef6\u5bc6\u6587\u6821\u9a8c\u5931\u8d25') throw new Error('CONTRACT_INDEX_DECRYPT_FAILED');
    throw new Error('CONTRACT_INDEX_READ_FAILED');
  }
  let index;
  try { index = JSON.parse(Buffer.from(content).toString('utf8')); }
  catch { throw new Error('CONTRACT_INDEX_INVALID'); }
  if (!index || typeof index !== 'object' || Array.isArray(index)) throw new Error('CONTRACT_INDEX_INVALID');
  const revision = index.__vnet_contract_storage_index_meta__?.revision ?? 0;
  if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('CONTRACT_INDEX_INVALID');
  return { status: 'verified-readonly', revision, entries: Object.keys(index).filter(name => name !== '__vnet_contract_storage_index_meta__').length, readonly: true, writes: 0 };
}

export async function verifyContractStartupAtRoot(root) {
  root = resolve(root);
  const scriptRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const staged = join(dirname(scriptRoot), 'dist/server/modules/contract-management/contract-attachment-storage.service.js');
  const runtime = scriptRoot.endsWith('release-root') ? staged : join(root, 'dist/server/modules/contract-management/contract-attachment-storage.service.js');
  // Configuration-only use of the purchase utility may precede a runtime install.
  if (!existsSync(runtime)) {
    if (scriptRoot.endsWith('release-root')) throw new Error('CONTRACT_CANDIDATE_RUNTIME_MISSING');
    return { status: 'runtime-unavailable-config-only', readonly: true, writes: 0 };
  }
  const environment = loadContractStartupEnvironment(root);
  return verifyContractStorageStartup({ environment, createStorage: effective => {
    const previous = process.env;
    const oldNodePath = process.env.NODE_PATH;
    try {
      process.env = { ...effective, NODE_PATH: [join(root, 'node_modules'), oldNodePath].filter(Boolean).join(delimiter) };
      Module._initPaths();
      const require = createRequire(join(root, 'package.json'));
      require('reflect-metadata');
      const { ContractAttachmentStorageService } = require(runtime);
      // Constructor captures configuration only; never call onModuleInit/ensureIndexLoaded.
      return new ContractAttachmentStorageService({});
    } finally {
      process.env = previous;
      Module._initPaths();
    }
  } });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 4 || process.argv[2] !== '--root') throw new Error('CONTRACT_PREFLIGHT_ARGUMENT_INVALID');
    console.log(JSON.stringify(await verifyContractStartupAtRoot(process.argv[3])));
  } catch (error) {
    console.error(`[ERROR] ${/^CONTRACT_[A-Z_]+$/.test(error?.message || '') ? error.message : 'CONTRACT_PREFLIGHT_FAILED'}; previous runtime must remain running.`);
    process.exitCode = 1;
  }
}
