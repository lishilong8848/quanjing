'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');

const TARGETS = ['蒋杰', '张宇航', '宋剑武', '葛滨'];
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function ordinaryPath(file) {
  const resolved = path.resolve(file);
  if (resolved.startsWith('\\\\') || resolved.slice(path.parse(resolved).root.length).includes(':')) throw new Error('UNSAFE_PATH');
  for (let current = resolved; ; current = path.dirname(current)) {
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error('UNSAFE_PATH');
    if (path.dirname(current) === current) break;
  }
  return resolved;
}

function collect(appRoot) {
  if (!path.isAbsolute(appRoot)) throw new Error('ABSOLUTE_ROOT_REQUIRED');
  const root = ordinaryPath(appRoot);
  const main = ordinaryPath(path.join(root, 'dist/server/main.js'));
  if (!fs.statSync(main).isFile()) throw new Error('APPLICATION_ROOT_REQUIRED');
  process.chdir(root);
  const requireApp = createRequire(path.join(root, 'package.json'));
  requireApp('reflect-metadata');
  // Load only the installed environment loader and access classes, never main/AppModule or lifecycle hooks.
  requireApp(ordinaryPath(path.join(root, 'dist/server/runtime-env.js')));
  const configFile = ordinaryPath(process.env.ACCESS_CONFIGURATION_FILE || path.join(root, '.runtime/access-configuration.json'));
  if (process.env.ACCESS_CONFIGURATION_FILE && !path.isAbsolute(process.env.ACCESS_CONFIGURATION_FILE)) throw new Error('ABSOLUTE_CONFIG_REQUIRED');
  if (fs.statSync(configFile).size > 8 * 1024 * 1024) throw new Error('CONFIG_TOO_LARGE');
  const before = digest(fs.readFileSync(configFile));
  const configModule = ordinaryPath(path.join(root, 'dist/server/common/access/access-configuration.service.js'));
  const accessModule = ordinaryPath(path.join(root, 'dist/server/common/access/unified-access.service.js'));
  const { AccessConfigurationService } = requireApp(configModule);
  const { UnifiedAccessService } = requireApp(accessModule);
  const configuration = new AccessConfigurationService();
  const access = new UnifiedAccessService(configuration);
  const snapshot = configuration.snapshot();
  const rows = TARGETS.map(name => ({ name, accounts: snapshot.accounts.filter(account => account.name === name).map(account => {
    const row = { kind: account.kind, role: account.role, enabled: account.enabled, deleted: account.deleted,
      building: account.building, buildings: account.buildings, specialties: account.specialties,
      authorizationVersion: account.version, openIdPresent: Boolean(account.openId),
      appMatches: account.kind === 'feishu' ? account.appId === process.env.FEISHU_APP_ID?.trim() : null,
      principalResolved: false, issued: false, readable: false, fingerprintMatches: false };
    try {
      const principal = account.kind === 'feishu' && account.openId
        ? configuration.feishuPrincipal(account.openId, process.env.FEISHU_APP_ID?.trim() || '')
        : configuration.currentPrincipal(account.id, account.version);
      row.principalResolved = Boolean(principal);
      if (!principal) return row;
      const signed = access.issueTrustedSession(principal);
      row.issued = true;
      const read = access.readSessionIdentity(signed.token);
      row.readable = read.expiresAt === signed.expiresAt && read.principal.accountId === principal.accountId && read.principal.role === principal.role;
      row.fingerprintMatches = read.principalFingerprint === signed.principalFingerprint;
    } catch { row.checkError = 'ACCESS_CHECK_REJECTED'; }
    return row;
  }) }));
  const after = digest(fs.readFileSync(configFile));
  return { schemaVersion: 1, collectedAt: new Date().toISOString(), nodeVersion: process.version,
    scope: 'offline-configured-identity-only-no-real-oauth-no-browser-cookie-proof',
    accessControlEnabled: access.isAccessControlEnabled(), configurationStableDuringRead: before === after,
    sourceHashes: { configurationService: digest(fs.readFileSync(configModule)), accessService: digest(fs.readFileSync(accessModule)) }, rows };
}

if (require.main === module) {
  try { process.stdout.write(JSON.stringify(collect(process.argv[2]), null, 2)); }
  catch { process.stderr.write('LOGIN_DIAGNOSTIC_REFUSED_OR_UNAVAILABLE\n'); process.exitCode = 1; }
}
module.exports = { collect, ordinaryPath };
