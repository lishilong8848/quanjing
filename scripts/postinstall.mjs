import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export function patchFeishuCardCallbackFrames({
  rootDir = process.cwd(),
  logger = console,
} = {}) {
  const sdkRoot = join(rootDir, 'node_modules', '@larksuiteoapi', 'node-sdk');
  const packagePath = join(sdkRoot, 'package.json');
  if (!existsSync(packagePath)) return { status: 'not-installed' };

  const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));
  if (packageJson.version !== '1.73.0') {
    throw new Error(
      `[postinstall] unsupported @larksuiteoapi/node-sdk version: ${packageJson.version}`,
    );
  }

  const original = 'if (type !== MessageType.event) {';
  const patched =
    'if (type !== MessageType.event && type !== MessageType.card) {';
  let changed = false;
  for (const relativePath of ['lib/index.js', 'es/index.js']) {
    const filePath = join(sdkRoot, relativePath);
    const source = readFileSync(filePath, 'utf8');
    const originalCount = source.split(original).length - 1;
    const patchedCount = source.split(patched).length - 1;

    if (patchedCount === 1 && originalCount === 0) continue;
    if (originalCount !== 1 || patchedCount !== 0) {
      throw new Error(
        `[postinstall] Feishu card callback patch contract changed: ${relativePath}`,
      );
    }
    writeFileSync(filePath, source.replace(original, patched), 'utf8');
    changed = true;
  }
  logger.log(
    '[postinstall] Feishu card callback WebSocket compatibility: READY',
  );
  return { status: changed ? 'patched' : 'ready' };
}

export function runPostinstall({ rootDir = process.cwd() } = {}) {
  patchFeishuCardCallbackFrames({ rootDir });

  const command =
    process.platform === 'win32' ? 'fullstack-cli.cmd' : 'fullstack-cli';
  const localBin = join(rootDir, 'node_modules', '.bin', command);
  if (!existsSync(localBin)) {
    console.warn(
      '[postinstall] fullstack-cli not found, skipped action plugin init.',
    );
    return 0;
  }

  const result = spawnSync(localBin, ['action-plugin', 'init'], {
    cwd: rootDir,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.error) {
    console.warn(
      `[postinstall] action plugin init skipped: ${result.error.message}`,
    );
    return 0;
  }
  if (result.status !== 0) {
    console.warn(
      `[postinstall] action plugin init exited with ${result.status}, skipped.`,
    );
  }
  return 0;
}

function isMainModule() {
  if (!process.argv[1]) return false;
  return resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
}

if (isMainModule()) {
  process.exitCode = runPostinstall();
}
