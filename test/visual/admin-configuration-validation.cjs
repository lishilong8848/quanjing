const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const repair = process.argv.includes('--repair');
const clientOnly = process.argv.includes('--client-types-complete');
const completeTypes = process.argv.includes('--types-complete') || clientOnly;
const typesOnly = process.argv.includes('--types-only') || completeTypes;
const output = path.join(root, `output/admin-configuration-check/${clientOnly ? 'client-types-final' : completeTypes ? 'type-validation-complete' : typesOnly ? 'type-validation' : repair ? 'repair-validation' : 'final-validation'}`);
fs.mkdirSync(output, { recursive: true });
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const selected = [
  'server/common/access/access-configuration.store.spec.ts',
  'server/common/access/access-configuration.service.spec.ts',
  'server/common/access/access-configuration.controller.spec.ts',
  'server/common/access/access-configuration.directory.spec.ts',
  'server/common/access/unified-access.service.spec.ts',
  'server/common/access/feishu-access.service.spec.ts',
  'test/unit/admin-card-configuration.spec.ts',
  'test/unit/feishu-profile-session.spec.ts',
  'test/unit/feishu-approved-permissions.spec.ts',
  'test/unit/feishu-login-navigation.spec.ts',
  'test/unit/unified-access-guard.spec.ts',
  'test/unit/unified-access-login-redaction.spec.ts',
  'test/unit/unified-access-policy.spec.ts',
  'test/unit/unified-access-route-metadata.spec.ts',
  'test/unit/unified-access-ui.spec.ts',
  'test/unit/purchase-unified-access-backend.spec.ts',
  'test/unit/purchase-manager-approval-config.spec.ts',
  'test/unit/purchase-manager-approval-service.spec.ts',
  'test/unit/purchase-manager-batch-approval-service.spec.ts',
  'test/unit/purchase-workflow-callback.spec.ts',
  'test/unit/purchase-workflow-card-callback-api.spec.ts',
  'test/unit/purchase-workflow-service.spec.ts',
  'server/modules/purchase-inventory/purchase-workflow-callback.long-connection.spec.ts',
  'server/modules/purchase-inventory/feishu-card-action.router.spec.ts',
  'server/modules/inventory-outbound-approval/inventory-warehouse-role-directory.spec.ts',
  'server/modules/contract-management/contract-workflow.service.spec.ts',
];
function fingerprint() {
  const files = new Set();
  const walk = folder => { for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
    const file = path.join(folder, entry.name);
    if (entry.isDirectory()) walk(file);
    else if (/\.(?:ts|tsx|js|cjs|mjs|css|svg|json)$/.test(file)) files.add(file);
  } };
  for (const folder of ['client/src','server','shared','test/unit','test/fixtures/admin-configuration-browser','test/fixtures/feishu-login-browser']) walk(path.join(root, folder));
  for (const folder of ['node_modules/typescript','node_modules/ts-jest/dist','node_modules/jest/bin','node_modules/jest-cli/build','node_modules/@lark-apaas/fullstack-presets/lib/simple/tsconfig']) walk(path.join(root, folder));
  for (const file of ['node_modules/typescript/bin/tsc','package.json','package-lock.json','tsconfig.app.json','tsconfig.node.json','test/jest.admin-configuration.config.cjs','test/jest.feishu-login.config.cjs','test/visual/admin-configuration-validation.cjs','test/visual/admin-configuration-dev-server.cjs']) files.add(path.join(root, file));
  const inputs = [...files].sort().map(file => ({ path: path.relative(root, file).replace(/\\/g,'/'), sha256: sha(file) }));
  return { sha256: crypto.createHash('sha256').update(JSON.stringify(inputs)).digest('hex'), inputs };
}
const before = fingerprint();
const evidence = { startedAt: new Date().toISOString(), node: { path: process.execPath, version: process.version, sha256: sha(process.execPath) }, before, selected, stages: [], boundary: 'Business validation only; no production build, package, installation or external writes. Source and primary tool closures bound; unchanged installed dependencies require publisher dependency proof.' };
fs.writeFileSync(path.join(output, 'inputs-before.json'), JSON.stringify(evidence, null, 2));
const tests = repair ? selected.filter(file => /(?:access-configuration.directory|admin-card-configuration|purchase-workflow-service|purchase-workflow-card-callback-api|feishu-card-action.router|purchase-manager-approval-service)/.test(file)) : selected;
const stages = [
  ['jest', ['node_modules/jest/bin/jest.js','--config','test/jest.admin-configuration.config.cjs','--runInBand','--runTestsByPath',...tests,'--json',`--outputFile=${path.join(output,'jest-results.json')}`]],
  ['client-types', ['node_modules/typescript/bin/tsc','--project','tsconfig.app.json','--noEmit','--incremental','false']],
  ['server-types', ['node_modules/typescript/bin/tsc','--project','tsconfig.node.json','--noEmit','--incremental','true','--tsBuildInfoFile',path.join(output,'server-types.tsbuildinfo')]],
];
for (const [name, args] of stages) {
  if ((typesOnly && name === 'jest') || (clientOnly && name === 'server-types')) continue;
  const started = Date.now();
  const result = spawnSync(process.execPath, args, { cwd: root, encoding:'utf8', maxBuffer: 12 * 1024 * 1024, env: { ...process.env, FORCE_COLOR:'0' } });
  fs.writeFileSync(path.join(output, `${name}.log`), (result.stdout || '') + (result.stderr || ''));
  evidence.stages.push({ name, args, exitCode: result.status, elapsedMs: Date.now()-started, log: `${name}.log` });
  console.log(JSON.stringify(evidence.stages.at(-1)));
  if (result.status !== 0) { process.exitCode = 1; break; }
}
const after = fingerprint();
evidence.afterSha256 = after.sha256;
evidence.inputsStable = before.sha256 === after.sha256;
evidence.completedAt = new Date().toISOString();
if (!evidence.inputsStable) process.exitCode = 1;
fs.writeFileSync(path.join(output,'validation-evidence.json'), JSON.stringify(evidence,null,2));
console.log(JSON.stringify({ inputsStable:evidence.inputsStable, evidence:path.relative(root,path.join(output,'validation-evidence.json')) }));
