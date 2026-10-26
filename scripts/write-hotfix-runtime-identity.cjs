const fs = require('node:fs'), path = require('node:path'), { createHash } = require('node:crypto');
const identityPath = 'dist/server/hotfix-runtime-identity.json';
const canonical = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
function check(condition, reason) { if (!condition) throw Error(reason); }
function stat(file) { try { return fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; } }
function writeRuntimeIdentity(buildRoot, deploymentId) {
  check(typeof deploymentId === 'string' && /^nantong-safe-full-runtime-hotfix-\d{8}-\d{6,9}$/.test(deploymentId) && !/[\r\n]/.test(deploymentId), 'HOTFIX_IDENTITY_INVALID_DEPLOYMENT');
  check(typeof buildRoot === 'string' && path.isAbsolute(buildRoot) && !buildRoot.startsWith('\\\\'), 'HOTFIX_IDENTITY_INVALID_ROOT');
  const root = path.resolve(buildRoot), rootStat = stat(root);
  check(rootStat?.isDirectory() && !rootStat.isSymbolicLink() && canonical(fs.realpathSync(root)) === canonical(root), 'HOTFIX_IDENTITY_INVALID_ROOT');
  for (const marker of ['.hotfix-installed-release.json', '.hotfix-transaction.json', '.maintenance.lock']) {
    check(!stat(path.join(root, marker)), 'HOTFIX_IDENTITY_MANAGED_ROOT');
  }
  for (const directory of [path.join(root, 'dist'), path.join(root, 'dist/server')]) {
    const entry = stat(directory); check(entry, 'HOTFIX_IDENTITY_MISSING_MAIN');
    check(entry.isDirectory() && !entry.isSymbolicLink() && canonical(fs.realpathSync(directory)) === canonical(directory), 'HOTFIX_IDENTITY_UNSAFE_PATH');
  }
  const main = path.join(root, 'dist/server/main.js'), mainStat = stat(main);
  check(mainStat, 'HOTFIX_IDENTITY_MISSING_MAIN');
  check(mainStat.isFile() && !mainStat.isSymbolicLink() && mainStat.nlink === 1 && canonical(fs.realpathSync(main)) === canonical(main), 'HOTFIX_IDENTITY_UNSAFE_PATH');
  const target = path.join(root, identityPath);
  check(!stat(target), 'HOTFIX_IDENTITY_ALREADY_EXISTS');
  const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, activationProtocol: 'maintenance-commit-v1', deploymentId }) + '\n');
  fs.writeFileSync(target, bytes, { flag: 'wx', mode: 0o600 });
  check(fs.readFileSync(target).equals(bytes), 'HOTFIX_IDENTITY_WRITE_MISMATCH');
  return { deploymentId, path: identityPath, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}
module.exports = { writeRuntimeIdentity };
if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    check(args.length === 4 && args[0] === '--build-root' && args[2] === '--deployment-id', 'HOTFIX_IDENTITY_INVALID_ARGUMENTS');
    console.log(JSON.stringify(writeRuntimeIdentity(args[1], args[3])));
  } catch (error) {
    console.error(error instanceof Error && /^HOTFIX_[A-Z_]+$/.test(error.message) ? error.message : 'HOTFIX_IDENTITY_GENERATION_FAILED');
    process.exitCode = 1;
  }
}
