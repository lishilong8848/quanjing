import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const defaultSourceMapPath = join(
  projectRoot,
  'dist',
  'sourcemaps',
  'client',
  'assets',
  '3730.293a10f8.js.map',
);
const expectedSourceMapSha256 =
  '32b9015d7e84c5214638337afc3e88fd9279337d83661661437bcdc472a12acd';
const purchaseSourcePrefix =
  'webpack://fullstack-nestjs-template/./client/src/pages/PurchaseInventoryManagement/';
const expectedPurchaseSources = [
  'ManagementHeader.tsx',
  'PurchaseAnomalyEditDialog.tsx',
  'PurchaseApplicationDialog.tsx',
  'PurchaseCompletionAnalysisDialog.tsx',
  'PurchaseDeleteDialog.tsx',
  'PurchaseOnlineApprovalDialog.tsx',
  'PurchaseOverviewPage.tsx',
  'PurchaseWorkflowDialog.tsx',
  'completion-analysis.logic.ts',
  'logic.ts',
  'purchase-application.logic.ts',
  'purchase-online-approval.logic.ts',
  'purchase-principal-request-gate.ts',
  'purchase-record-edit.logic.ts',
  'purchase-workflow-center.logic.ts',
].sort();
const excludedPurchaseMarkers = ['采购形式', '单一采购', '单一原因'];
const requiredWeatherMarker = '预警与戒备信息';
const removedWeatherTestMarker = '预警卡片测试';

function fail(message) {
  throw new Error(message);
}

function parseArguments(argv) {
  const result = { output: '', sourceMap: defaultSourceMapPath };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--output') {
      result.output = argv[index + 1] || '';
      index += 1;
      continue;
    }
    if (argument === '--source-map') {
      result.sourceMap = argv[index + 1] || '';
      index += 1;
      continue;
    }
    fail(`Unknown argument: ${argument}`);
  }
  if (!result.output) fail('--output is required');
  if (!result.sourceMap) fail('--source-map cannot be empty');
  return result;
}

function assertNoReparsePointInExistingChain(path) {
  let current = resolve(path);
  while (true) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) {
      fail(`Refusing reparse-point path: ${current}`);
    }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function listFiles(root) {
  const paths = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile()) paths.push(path);
    }
  }
  return paths.sort();
}

function assertIsolatedOutputPath(outputPath) {
  const resolvedOutput = resolve(outputPath);
  const relativeToProject = relative(projectRoot, resolvedOutput);
  if (
    resolvedOutput === projectRoot ||
    relativeToProject === 'dist' ||
    relativeToProject.startsWith(`dist${sep}`)
  ) {
    fail('Hotfix client output must not replace the project dist directory');
  }
  assertNoReparsePointInExistingChain(dirname(resolvedOutput));
  if (existsSync(resolvedOutput)) {
    fail(`Hotfix client output already exists: ${resolvedOutput}`);
  }
  return resolvedOutput;
}

function extractFrozenPurchaseSnapshot(sourceMapPath, snapshotRoot) {
  const sourceMapBuffer = readFileSync(sourceMapPath);
  const actualHash = sha256(sourceMapBuffer);
  if (actualHash !== expectedSourceMapSha256) {
    fail(
      `Unexpected purchase source map SHA-256: expected ${expectedSourceMapSha256}, received ${actualHash}`,
    );
  }

  const sourceMap = JSON.parse(sourceMapBuffer.toString('utf8'));
  if (
    !Array.isArray(sourceMap.sources) ||
    !Array.isArray(sourceMap.sourcesContent) ||
    sourceMap.sources.length !== sourceMap.sourcesContent.length
  ) {
    fail('Purchase source map does not contain a complete sourcesContent array');
  }

  const purchaseSources = [];
  for (let index = 0; index < sourceMap.sources.length; index += 1) {
    const source = sourceMap.sources[index];
    if (!source.startsWith(purchaseSourcePrefix)) continue;
    const relativePath = source.slice(purchaseSourcePrefix.length);
    if (
      !relativePath ||
      isAbsolute(relativePath) ||
      relativePath.includes('..') ||
      relativePath.includes('/') ||
      relativePath.includes('\\')
    ) {
      fail(`Unsafe purchase source path in source map: ${source}`);
    }
    const content = sourceMap.sourcesContent[index];
    if (typeof content !== 'string') {
      fail(`Missing sourcesContent for purchase source: ${source}`);
    }
    purchaseSources.push({ relativePath, content });
  }

  const actualSources = purchaseSources.map(({ relativePath }) => relativePath).sort();
  if (JSON.stringify(actualSources) !== JSON.stringify(expectedPurchaseSources)) {
    fail(
      `Purchase source set does not match the frozen snapshot: ${actualSources.join(', ')}`,
    );
  }

  const combinedPurchaseSource = purchaseSources
    .map(({ content }) => content)
    .join('\n');
  for (const marker of excludedPurchaseMarkers) {
    if (combinedPurchaseSource.includes(marker)) {
      fail(`Frozen purchase snapshot contains excluded marker: ${marker}`);
    }
  }

  mkdirSync(snapshotRoot, { recursive: true });
  for (const { relativePath, content } of purchaseSources) {
    writeFileSync(join(snapshotRoot, relativePath), content, 'utf8');
  }
  // The compiled snapshot tree-shook the one-line route entry and the type-only
  // page key module. Recreate only those two erased modules; every runtime
  // purchase module must come from the hash-verified sourcesContent above.
  writeFileSync(
    join(snapshotRoot, 'index.tsx'),
    "export { default } from './PurchaseOverviewPage';\n",
    'utf8',
  );
  writeFileSync(
    join(snapshotRoot, 'ManagementPageSwitcher.tsx'),
    "export type ManagementPageKey = 'purchase' | 'inventory' | 'contract';\n",
    'utf8',
  );
}

function buildClient(outputPath, snapshotRoot) {
  const rspackCliPath = join(
    projectRoot,
    'node_modules',
    '@rspack',
    'cli',
    'bin',
    'rspack.js',
  );
  if (!existsSync(rspackCliPath)) {
    fail(`Rspack CLI is missing: ${rspackCliPath}`);
  }
  const result = spawnSync(
    process.execPath,
    [
      rspackCliPath,
      'build',
      '--config',
      'rspack.hotfix.config.js',
      '--env',
      'mode=production',
    ],
    {
      cwd: projectRoot,
      env: {
        ...process.env,
        NODE_ENV: 'production',
        HOTFIX_CLIENT_OUTPUT_PATH: outputPath,
        HOTFIX_PURCHASE_SNAPSHOT_ROOT: snapshotRoot,
      },
      encoding: 'utf8',
    },
  );
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) {
    fail(`Isolated hotfix client build failed with exit code ${result.status}`);
  }
}

function verifyBuiltClient(outputPath) {
  const files = listFiles(outputPath);
  for (const requiredPath of [
    'favicon.svg',
    'index.html',
    'main.css',
    'main.js',
    'main.legacy.css',
    'polyfills.js',
    'routes.json',
  ]) {
    if (!files.includes(join(outputPath, requiredPath))) {
      fail(`Isolated client build is missing required asset: ${requiredPath}`);
    }
  }
  const sourceMaps = files.filter((path) => path.endsWith('.map'));
  if (sourceMaps.length > 0) {
    fail(`Isolated client build still contains source maps: ${sourceMaps[0]}`);
  }
  const javaScriptFiles = files.filter((path) => path.endsWith('.js'));
  if (javaScriptFiles.length === 0) fail('Isolated client build produced no JavaScript');
  const combinedJavaScript = javaScriptFiles
    .map((path) => readFileSync(path, 'utf8'))
    .join('\n');

  if (!combinedJavaScript.includes(requiredWeatherMarker)) {
    fail(`Built client is missing weather marker: ${requiredWeatherMarker}`);
  }
  if (combinedJavaScript.includes(removedWeatherTestMarker)) {
    fail(`Built client still contains removed control: ${removedWeatherTestMarker}`);
  }
  for (const marker of excludedPurchaseMarkers) {
    if (combinedJavaScript.includes(marker)) {
      fail(`Built client contains excluded purchase marker: ${marker}`);
    }
  }
  return javaScriptFiles.length;
}

const arguments_ = parseArguments(process.argv.slice(2));
const outputPath = assertIsolatedOutputPath(arguments_.output);
const sourceMapPath = resolve(arguments_.sourceMap);
assertNoReparsePointInExistingChain(sourceMapPath);
if (!existsSync(sourceMapPath)) fail(`Purchase source map is missing: ${sourceMapPath}`);

const snapshotRoot = mkdtempSync(join(tmpdir(), 'nantong-frozen-purchase-'));
try {
  extractFrozenPurchaseSnapshot(sourceMapPath, snapshotRoot);
  buildClient(outputPath, snapshotRoot);
  const javaScriptFileCount = verifyBuiltClient(outputPath);
  process.stdout.write(
    `${JSON.stringify({
      outputPath,
      purchaseSourceMapSha256: expectedSourceMapSha256,
      purchaseSnapshotAt: '2026-07-30T07:35:29+08:00',
      javaScriptFileCount,
    })}\n`,
  );
} catch (error) {
  if (existsSync(outputPath)) rmSync(outputPath, { recursive: true, force: true });
  throw error;
} finally {
  rmSync(snapshotRoot, { recursive: true, force: true });
}
