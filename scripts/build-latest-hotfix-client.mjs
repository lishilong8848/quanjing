import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const requiredWeatherMarker = '预警与戒备信息';
const removedWeatherTestMarker = '预警卡片测试';
const requiredPurchaseMarkers = [
  '采购形式',
  '单一采购',
  '单一原因',
  '确认到货签收',
];
const requiredPurchaseActiveSyncMarkers = [
  '采购基础数据正在同步，本次申请已先显示。',
  '正在同步采购数据',
  '正在使用原申请编号自动找回受理任务',
];
const requiredInventoryStorageLocationRootMarkers = [
  '/api/inventory-management/storage-locations',
  'clientMutationId',
];
const requiredInventoryStorageLocationUiMarkers = [
  '新增位置',
  '存放位置分类',
  '库内',
  '库外',
  'locationRecordId',
  '保存并选中',
  '当前内容已保留，请重试',
];
const requiredInventoryStorageLocationMarkers = [
  ...requiredInventoryStorageLocationRootMarkers,
  ...requiredInventoryStorageLocationUiMarkers,
];
const requiredInventoryOutboundRootMarkers = [
  '/api/inventory-management/outbounds/',
  'clientMutationId',
];
const requiredInventoryOutboundUiMarkers = [
  '待库房确认',
  '查看并确认',
  '库房确认出库',
  '确认出库',
  '恢复草稿已锁定，请使用原出库编号重试',
  '结果暂不确定；请使用原编号安全重试',
  '任务均已取得服务端编号，可继续办理下一笔；系统会在后台逐笔核对。',
];
const requiredInventoryOutboundMarkers = [
  ...requiredInventoryOutboundRootMarkers,
  ...requiredInventoryOutboundUiMarkers,
];
const requiredInventoryMovementDeletionRootMarkers = [
  '/api/inventory-management/movements/deletions',
  '/api/inventory-management/movements/deletions/tasks/',
];
const requiredInventoryMovementDeletionUiMarkers = [
  '记录已从当前清单隐藏，正在后台同步删除',
  '后台尚未确认的记录不能删除',
];
const requiredInventoryMovementDeletionMarkers = [
  ...requiredInventoryMovementDeletionRootMarkers,
  ...requiredInventoryMovementDeletionUiMarkers,
];

function fail(message) {
  throw new Error(message);
}

function parseArguments(argv) {
  const result = { output: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--output') {
      result.output = argv[index + 1] || '';
      index += 1;
      continue;
    }
    fail(`Unknown argument: ${argument}`);
  }
  if (!result.output) fail('--output is required');
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

function isJavaScriptReachableFromMainBundle(
  path,
  outputPath,
  mainBundleContent,
) {
  const normalizedRelativePath = relative(outputPath, path)
    .split(sep)
    .join('/');
  if (normalizedRelativePath === 'main.js') return true;

  const chunkMatch = /^chunks\/(?<id>\d+)\.(?<hash>[a-f0-9]+)\.js$/iu.exec(
    normalizedRelativePath,
  );
  if (!chunkMatch) return false;
  const { id, hash } = chunkMatch.groups;
  const hasLoadCall =
    mainBundleContent.includes(`.e("${id}")`) ||
    mainBundleContent.includes(`.e('${id}')`);
  const hasHashMapping =
    mainBundleContent.includes(`${id}:"${hash}"`) ||
    mainBundleContent.includes(`"${id}":"${hash}"`);
  return hasLoadCall && hasHashMapping;
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

function buildClient(outputPath) {
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
        HOTFIX_PURCHASE_SNAPSHOT_ROOT: '',
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
  if (javaScriptFiles.length === 0)
    fail('Isolated client build produced no JavaScript');
  const javaScriptContents = javaScriptFiles.map((path) => ({
    path,
    content: readFileSync(path, 'utf8'),
  }));
  const mainBundleContent = readFileSync(join(outputPath, 'main.js'), 'utf8');
  const reachableJavaScriptContents = javaScriptContents.filter(({ path }) =>
    isJavaScriptReachableFromMainBundle(path, outputPath, mainBundleContent),
  );
  const combinedJavaScript = javaScriptContents
    .map(({ content }) => content)
    .join('\n');
  const reachableJavaScript = reachableJavaScriptContents
    .map(({ content }) => content)
    .join('\n');

  if (!combinedJavaScript.includes(requiredWeatherMarker)) {
    fail(`Built client is missing weather marker: ${requiredWeatherMarker}`);
  }
  if (combinedJavaScript.includes(removedWeatherTestMarker)) {
    fail(
      `Built client still contains removed control: ${removedWeatherTestMarker}`,
    );
  }
  for (const marker of requiredPurchaseMarkers) {
    if (!combinedJavaScript.includes(marker)) {
      fail(`Built client is missing current purchase marker: ${marker}`);
    }
  }
  for (const marker of requiredPurchaseActiveSyncMarkers) {
    if (!reachableJavaScript.includes(marker)) {
      fail(`Built client is missing purchase active-sync marker: ${marker}`);
    }
  }
  for (const marker of requiredInventoryStorageLocationRootMarkers) {
    if (!mainBundleContent.includes(marker)) {
      fail(
        `Built client main bundle is missing inventory storage-location marker: ${marker}`,
      );
    }
  }
  for (const marker of requiredInventoryOutboundRootMarkers) {
    if (!mainBundleContent.includes(marker)) {
      fail(
        `Built client main bundle is missing inventory outbound marker: ${marker}`,
      );
    }
  }
  for (const marker of requiredInventoryMovementDeletionRootMarkers) {
    if (!mainBundleContent.includes(marker)) {
      fail(
        `Built client main bundle is missing inventory movement-deletion marker: ${marker}`,
      );
    }
  }
  for (const marker of requiredInventoryStorageLocationMarkers) {
    if (!reachableJavaScript.includes(marker)) {
      fail(
        `Built client main bundle and reachable chunks are missing inventory storage-location marker: ${marker}`,
      );
    }
  }
  const inventoryStorageLocationUiBundles = reachableJavaScriptContents.filter(
    ({ content }) =>
      requiredInventoryStorageLocationUiMarkers.every((marker) =>
        content.includes(marker),
      ),
  );
  if (inventoryStorageLocationUiBundles.length !== 1) {
    fail(
      `Built client must contain exactly one reachable inventory storage-location UI bundle; found ${inventoryStorageLocationUiBundles.length}`,
    );
  }
  for (const marker of requiredInventoryOutboundMarkers) {
    if (!reachableJavaScript.includes(marker)) {
      fail(
        `Built client is missing reachable inventory outbound marker: ${marker}`,
      );
    }
  }
  const inventoryOutboundUiBundles = reachableJavaScriptContents.filter(
    ({ content }) =>
      requiredInventoryOutboundUiMarkers.every((marker) =>
        content.includes(marker),
      ),
  );
  if (inventoryOutboundUiBundles.length !== 1) {
    fail(
      `Built client must contain exactly one reachable inventory outbound UI bundle; found ${inventoryOutboundUiBundles.length}`,
    );
  }
  for (const marker of requiredInventoryMovementDeletionMarkers) {
    if (!reachableJavaScript.includes(marker)) {
      fail(
        `Built client is missing reachable inventory movement-deletion marker: ${marker}`,
      );
    }
  }
  const inventoryMovementDeletionUiBundles = reachableJavaScriptContents.filter(
    ({ content }) =>
      requiredInventoryMovementDeletionUiMarkers.every((marker) =>
        content.includes(marker),
      ),
  );
  if (inventoryMovementDeletionUiBundles.length !== 1) {
    fail(
      `Built client must contain exactly one reachable inventory movement-deletion UI bundle; found ${inventoryMovementDeletionUiBundles.length}`,
    );
  }
  if (reachableJavaScript.includes('跨楼栋待确认')) {
    fail(
      'Built client still contains the removed outbound status: 跨楼栋待确认',
    );
  }

  const receiptBundle = javaScriptContents.find(
    ({ content }) =>
      content.includes('确认到货签收') && content.includes('receiptPhotos'),
  );
  if (!receiptBundle)
    fail('Built client is missing the purchase receipt bundle');
  for (const marker of [
    ...requiredPurchaseMarkers,
    'showSpinner',
    'aria-busy',
    '提交中',
  ]) {
    if (!receiptBundle.content.includes(marker)) {
      fail(`Purchase receipt bundle is missing action-state marker: ${marker}`);
    }
  }
  if (
    !/return\{disabled:(?<disabled>[\w$]+)\|\|(?<loading>[\w$]+),showSpinner:\k<loading>\}/u.test(
      receiptBundle.content,
    )
  ) {
    fail(
      'Purchase receipt action-state does not separate disabled and loading',
    );
  }
  if (
    !/receiptPhotos:[\w$]+,invoices:[\w$]+,disabled:[\w$]+,loading:!1/u.test(
      receiptBundle.content,
    )
  ) {
    fail(
      'Purchase receipt form does not release loading before background sync',
    );
  }

  return javaScriptFiles.length;
}

const arguments_ = parseArguments(process.argv.slice(2));
const outputPath = assertIsolatedOutputPath(arguments_.output);

try {
  buildClient(outputPath);
  const javaScriptFileCount = verifyBuiltClient(outputPath);
  process.stdout.write(
    `${JSON.stringify({
      outputPath,
      purchaseSource: 'current-workspace',
      javaScriptFileCount,
    })}\n`,
  );
} catch (error) {
  if (existsSync(outputPath))
    rmSync(outputPath, { recursive: true, force: true });
  throw error;
}
