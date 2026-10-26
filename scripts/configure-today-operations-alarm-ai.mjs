import { execFile } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseDotEnv } from 'dotenv';

const KEY_NAME = 'TODAY_OPERATIONS_ALARM_AI_API_KEY';
const DEFAULT_AI_ENDPOINT = 'https://wan.vnet.com/v1/chat/completions';
const DEFAULT_AI_MODEL = 'WanWu/Deepseek-Auto';
const scriptRoot = dirname(fileURLToPath(import.meta.url));

function assertRegularFile(path, required = true) {
  if (!existsSync(path)) {
    if (required) throw new Error(`Required application file is missing: ${path}`);
    return false;
  }
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Expected a regular application file: ${path}`);
  }
  return true;
}

function readEffectiveEnv(appRoot) {
  const basePath = join(appRoot, '.env');
  const localPath = join(appRoot, '.env.local');
  assertRegularFile(basePath);
  const base = parseDotEnv(readFileSync(basePath));
  const local = assertRegularFile(localPath, false)
    ? parseDotEnv(readFileSync(localPath))
    : {};
  return { ...base, ...local };
}

function validateKey(key) {
  if (
    typeof key !== 'string' ||
    key.length < 8 ||
    key.length > 8192 ||
    /[\x00-\x1f\x7f]/u.test(key) ||
    key.trim() !== key
  ) {
    throw new Error('AI API key is empty or contains unsupported characters.');
  }
}

function keyFileContent(original, key, effectiveEnv) {
  const content = original.toString('utf8');
  if (content.includes('\ufffd')) throw new Error('.env.local is not valid UTF-8.');
  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = content ? content.split(/\r?\n/u) : [];
  if (lines.at(-1) === '') lines.pop();
  const settings = {
    [KEY_NAME]: key,
    ...(!String(effectiveEnv.TODAY_OPERATIONS_ALARM_AI_BASE_URL || '').trim()
      ? { TODAY_OPERATIONS_ALARM_AI_BASE_URL: DEFAULT_AI_ENDPOINT }
      : {}),
    ...(!String(effectiveEnv.TODAY_OPERATIONS_ALARM_AI_MODEL || '').trim()
      ? { TODAY_OPERATIONS_ALARM_AI_MODEL: DEFAULT_AI_MODEL }
      : {}),
  };
  for (const [name, value] of Object.entries(settings)) {
    const settingLine = new RegExp(`^\\s*${name}\\s*=`, 'u');
    const indexes = lines.flatMap((line, index) => settingLine.test(line) ? [index] : []);
    if (indexes.length > 1) {
      throw new Error(name === KEY_NAME
        ? 'Duplicate alarm AI key settings in .env.local.'
        : `Duplicate alarm AI ${name} settings in .env.local.`);
    }
    const encoded = `${name}=${JSON.stringify(value)}`;
    if (indexes.length === 1) lines[indexes[0]] = encoded;
    else lines.push(encoded);
  }
  return Buffer.from(`${lines.join(newline)}${newline}`, 'utf8');
}

function atomicWrite(path, bytes) {
  const temporary = `${path}.alarm-ai-tmp-${randomUUID()}`;
  try {
    writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function assertDeploymentIsIdle(root) {
  if (existsSync(join(root, '.maintenance.lock'))) {
    throw new Error('Deployment state is active (.maintenance.lock); AI configuration was not changed.');
  }
  const journalPath = join(root, '.hotfix-transaction.json');
  if (!existsSync(journalPath)) return;
  try {
    assertRegularFile(journalPath);
    const receiptPath = join(root, '.hotfix-installed-release.json');
    assertRegularFile(receiptPath);
    const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
    const { transactionChecksum, ...transactionPayload } = journal;
    const { receiptChecksum, ...receiptPayload } = receipt;
    const sameRoot = (value) => typeof value === 'string' && (
      process.platform === 'win32'
        ? resolve(value).toLowerCase() === root.toLowerCase()
        : resolve(value) === root
    );
    const validHash = (value) => typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);
    const receiptFiles = new Map(
      Array.isArray(receipt.releaseFiles)
        ? receipt.releaseFiles.map((entry) => [entry.targetPath, entry.sha256])
        : [],
    );
    if (
      Object.keys(journal).length !== 8 ||
      journal.schemaVersion !== 1 ||
      typeof journal.transactionId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(journal.transactionId) ||
      typeof journal.deploymentId !== 'string' || !journal.deploymentId.trim() ||
      journal.intent !== 'deploy' ||
      journal.phase !== 'finalized' ||
      !sameRoot(journal.appRoot) ||
      !validHash(transactionChecksum) ||
      sha256(JSON.stringify(transactionPayload)) !== transactionChecksum ||
      receipt.schemaVersion !== 2 ||
      receipt.receiptType !== 'nantong-hotfix-installed-release' ||
      receipt.deploymentId !== journal.deploymentId ||
      !sameRoot(receipt.appRoot) ||
      !validHash(receiptChecksum) ||
      sha256(JSON.stringify(receiptPayload)) !== receiptChecksum ||
      !Array.isArray(receipt.runtimeFiles) || receipt.runtimeFiles.length === 0 ||
      !Array.isArray(receipt.activeClientFiles) || receipt.activeClientFiles.length === 0 ||
      !Array.isArray(journal.releaseFiles) || journal.releaseFiles.length === 0 ||
      !Array.isArray(receipt.releaseFiles) || receiptFiles.size !== receipt.releaseFiles.length ||
      receiptFiles.size !== journal.releaseFiles.length ||
      journal.releaseFiles.some((entry) =>
        !validHash(entry.candidateSha256) ||
        receiptFiles.get(entry.targetPath) !== entry.candidateSha256)
    ) {
      throw new Error('journal and receipt are not a matching finalized release');
    }
  } catch {
    throw new Error('Deployment journal is not a verified finalized release; AI configuration was not changed.');
  }
}

function readHealthConfiguration(appRoot) {
  const env = readEffectiveEnv(appRoot);
  const configuredHost = String(env.SERVER_HOST || '127.0.0.1').trim();
  const host = configuredHost === '0.0.0.0' || !configuredHost || configuredHost === 'localhost'
    ? '127.0.0.1'
    : configuredHost === '::' ? '::1' : configuredHost.replace(/^\[|\]$/gu, '');
  const port = Number(env.SERVER_PORT || 3001);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('SERVER_PORT is invalid.');
  }
  const scheme = env.HTTPS_CERT_PATH?.trim() && env.HTTPS_KEY_PATH?.trim() ? 'https' : 'http';
  const basePath = String(env.CLIENT_BASE_PATH || '').trim().replace(/^\/+|\/+$/gu, '');
  if (scheme === 'http') {
    const address = isIP(host) === 6 ? `[${host}]` : host;
    return { root: `http://${address}:${port}${basePath ? `/${basePath}` : ''}`, requestOptions: {} };
  }
  if (!isIP(host)) {
    throw new Error('SERVER_HOST must identify a local IP for strict HTTPS health checking.');
  }
  let publicUrl;
  try {
    publicUrl = new URL(String(env.PUBLIC_BASE_URL || '').trim());
  } catch {
    throw new Error('PUBLIC_BASE_URL is required for HTTPS certificate identity checking.');
  }
  if (publicUrl.protocol !== 'https:' || !publicUrl.hostname || publicUrl.username || publicUrl.password) {
    throw new Error('PUBLIC_BASE_URL must be a credential-free HTTPS URL.');
  }
  const family = isIP(host);
  const lookup = (_name, options, callback) => {
    if (options?.all) callback(null, [{ address: host, family }]);
    else callback(null, host, family);
  };
  const caPath = String(env.HTTPS_CA_PATH || '').trim();
  const requestOptions = {
    lookup,
    ...(caPath ? { ca: readFileSync(resolve(appRoot, caPath)) } : {}),
  };
  const root = `https://${publicUrl.hostname}:${port}${basePath ? `/${basePath}` : ''}`;
  return { root, requestOptions };
}

async function requestJson(url, { method = 'GET', headers = {}, body, timeoutMs = 20000, lookup, ca } = {}) {
  const parsed = new URL(url);
  const transport = parsed.protocol === 'https:' ? https : parsed.protocol === 'http:' ? http : null;
  if (!transport) throw new Error('Unsupported request protocol.');
  return new Promise((resolveRequest, rejectRequest) => {
    const request = transport.request(parsed, {
      method,
      headers,
      timeout: timeoutMs,
      ...(lookup ? { lookup } : {}),
      ...(ca ? { ca } : {}),
    }, (response) => {
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > 1024 * 1024) {
          request.destroy(new Error('Response exceeded safe size.'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        const status = response.statusCode || 0;
        if (status < 200 || status >= 300) {
          rejectRequest(new Error(`HTTP ${status}`));
          return;
        }
        const text = Buffer.concat(chunks).toString('utf8');
        if (!text) { resolveRequest({}); return; }
        try { resolveRequest(JSON.parse(text)); }
        catch { rejectRequest(new Error('Response is not JSON.')); }
      });
    });
    request.on('timeout', () => request.destroy(new Error('Request timed out.')));
    request.on('error', rejectRequest);
    if (body) request.write(body);
    request.end();
  });
}

async function providerProbe(appRoot, key) {
  const env = readEffectiveEnv(appRoot);
  const configured = String(env.TODAY_OPERATIONS_ALARM_AI_BASE_URL || DEFAULT_AI_ENDPOINT).trim().replace(/\/+$/u, '');
  const endpoint = /\/chat\/completions$/u.test(configured)
    ? configured : `${configured}/chat/completions`;
  if (new URL(endpoint).protocol !== 'https:') {
    throw new Error('Alarm AI endpoint must use HTTPS.');
  }
  const body = JSON.stringify({
    model: String(env.TODAY_OPERATIONS_ALARM_AI_MODEL || DEFAULT_AI_MODEL).trim(),
    max_tokens: 8,
    messages: [{ role: 'user', content: 'Reply OK.' }],
  });
  try {
    await requestJson(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      body,
      timeoutMs: 20000,
    });
  } catch (error) {
    const code = /^HTTP \d{3}$/u.test(error?.message || '') ? ` (${error.message})` : '';
    throw new Error(`Alarm AI provider validation failed${code}.`);
  }
}

export async function checkServiceHealth(appRoot, phase) {
  const { root, requestOptions } = readHealthConfiguration(appRoot);
  await requestJson(`${root}/api/access/session`, requestOptions);
  if (phase !== 'after') return;
  const result = await requestJson(`${root}/api/bitable/today-operations-alarms?metric=all&pageSize=1`, {
    timeoutMs: 30000,
    ...requestOptions,
  });
  if (!result?.tagReview || result.tagReview.state === 'unconfigured') {
    throw new Error('Alarm AI remains unconfigured after restart.');
  }
  if (result.tagReview.state === 'error' || result.tagReview.connection === 'error') {
    throw new Error('Alarm AI review reports an error after restart.');
  }
  return result.tagReview;
}

function runServiceScript(appRoot, scriptName, extraArgs = []) {
  const scriptPath = join(appRoot, scriptName);
  assertRegularFile(scriptPath);
  return new Promise((resolveRun, rejectRun) => {
    execFile('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, ...extraArgs,
    ], { cwd: appRoot, timeout: 15 * 60 * 1000, maxBuffer: 2 * 1024 * 1024, windowsHide: true }, (error) => {
      if (error) {
        rejectRun(new Error(`${scriptName} failed (exit ${error.code ?? 'unknown'}).`));
      } else {
        resolveRun();
      }
    });
  });
}

export async function applyAlarmAiKey({
  appRoot,
  key,
  providerProbe: verifyProvider = providerProbe,
  healthCheck: verifyHealth = checkServiceHealth,
  stopService = (root) => runServiceScript(root, 'stop.ps1'),
  startService = (root) => runServiceScript(root, 'start.ps1', ['-NoBrowser']),
  onProgress = () => {},
}) {
  validateKey(key);
  const root = resolve(appRoot);
  const envPath = join(root, '.env.local');
  const effectiveEnv = readEffectiveEnv(root);
  assertDeploymentIsIdle(root);
  const lockPath = join(root, '.alarm-ai-key-configuration.lock');
  let lock;
  try {
    lock = openSync(lockPath, 'wx', 0o600);
  } catch {
    throw new Error('Another alarm AI configuration task is active.');
  }
  try {
    const existed = assertRegularFile(envPath, false);
    const original = existed ? readFileSync(envPath) : Buffer.alloc(0);
    const updated = keyFileContent(original, key, effectiveEnv);
    if (parseDotEnv(updated)[KEY_NAME] !== key) {
      throw new Error('AI key cannot be represented safely in .env.local.');
    }
    onProgress('[INFO] Checking current service health before changing configuration.');
    await verifyHealth(root, 'before');
    onProgress('[INFO] Validating the AI key with a minimal provider request.');
    await verifyProvider(root, key);
    assertDeploymentIsIdle(root);
    onProgress('[INFO] Provider accepted the key; updating private configuration.');
    atomicWrite(envPath, updated);
    try {
      onProgress('[INFO] Restarting service with the new configuration.');
      await stopService(root);
      await startService(root);
      return await verifyHealth(root, 'after');
    } catch (cause) {
      onProgress('[WARN] New configuration failed; restoring the previous configuration and service.');
      const current = assertRegularFile(envPath) ? readFileSync(envPath) : Buffer.alloc(0);
      if (sha256(current) !== sha256(updated)) {
        throw new Error('AI configuration changed concurrently; automatic rollback refused.');
      }
      if (existed) atomicWrite(envPath, original);
      else unlinkSync(envPath);
      try {
        await stopService(root);
        await startService(root);
        await verifyHealth(root, 'rollback');
      } catch {
        throw new Error('AI setup failed; original configuration was restored, but old service health could not be proven.');
      }
      throw cause;
    }
  } finally {
    closeSync(lock);
    unlinkSync(lockPath);
  }
}

async function readKeyFromStdin() {
  let value = '';
  for await (const chunk of process.stdin) {
    value += chunk.toString('utf8');
    if (value.length > 8194) throw new Error('AI API key input is too long.');
  }
  return value.replace(/\r?\n$/u, '');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(scriptRoot, '..');
  let key = '';
  try {
    key = await readKeyFromStdin();
    const review = await applyAlarmAiKey({
      appRoot: root,
      key,
      onProgress: (line) => process.stdout.write(`${line}\n`),
    });
    process.stdout.write('[OK] Alarm AI key configured; provider and restarted service verified.\n');
    process.stdout.write(review?.connection === 'online'
      ? '[OK] AI online: a real alarm review succeeded.\n'
      : '[PENDING] AI business review has not yet proved an online connection; check the page after its first successful review.\n');
  } catch (error) {
    const message = String(error?.message || 'Alarm AI setup failed.');
    process.stderr.write(`[FAILED] ${key ? message.replaceAll(key, '[REDACTED]') : message}\n`);
    process.exitCode = 1;
  } finally {
    key = '';
  }
}
