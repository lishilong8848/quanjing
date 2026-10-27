import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, relative } from 'node:path';

jest.setTimeout(300_000);

interface HotfixManifestEntry {
  path: string;
  sha256: string;
  bytes: number;
}

interface HotfixManifest {
  mode?: string;
  scope: string[];
  excludedScope?: string[];
  files: HotfixManifestEntry[];
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function listFiles(root: string): string[] {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) =>
      relative(root, join(entry.parentPath, entry.name)).replace(/\\/gu, '/'),
    )
    .sort();
}

function snapshotTreeMetadata(root: string): Array<{
  path: string;
  bytes: number;
  sha256: string;
}> {
  if (!existsSync(root)) return [];
  return listFiles(root).map((path) => {
    const stats = statSync(join(root, path));
    return { path, bytes: stats.size, sha256: sha256(join(root, path)) };
  });
}

function createMinimalClientFixture(root: string): string {
  const clientRoot = join(root, 'client');
  mkdirSync(join(clientRoot, 'chunks'), { recursive: true });
  writeFileSync(
    join(clientRoot, 'index.html'),
    '<!doctype html><html><head><link rel="stylesheet" href="/main.css"><script defer src="/main.js"></script><script defer src="/polyfills.js"></script></head><body><div id="root"></div></body></html>',
    'utf8',
  );
  writeFileSync(join(clientRoot, 'favicon.svg'), '<svg></svg>', 'utf8');
  writeFileSync(join(clientRoot, 'main.css'), 'body{margin:0}', 'utf8');
  writeFileSync(join(clientRoot, 'main.legacy.css'), 'body{margin:0}', 'utf8');
  writeFileSync(join(clientRoot, 'polyfills.js'), 'void 0;', 'utf8');
  writeFileSync(join(clientRoot, 'routes.json'), '{}', 'utf8');
  writeFileSync(
    join(clientRoot, 'main.js'),
    'function actionState(d,l){return{disabled:d||l,showSpinner:l}}const receipt={receiptPhotos:p,invoices:i,disabled:d,loading:!1};console.log(actionState,receipt,"预警与戒备信息", "检查附件", "application/pdf", "PDF 扫描件", "提交戒备登记", "/api/duty-schedules/overtime-request", "加班申请", "加班工时：", "加班申请已受理，正在后台同步", "加班举证", "overtime-evidence", "长白班工作日加班仅可选择 09:00 前或 18:00 后", "所选加班与本人排班连续值守达到 24 小时，请缩短或调整时段", "/api/duty-schedules/change-request", "/api/duty-schedules/change-adjustment", "/api/duty-schedules/change-drill-report", "/api/duty-schedules/change-attachments/stage", "变更申请", "变更调整", "演练提交", "演练报告", "请从人员名单中选择提交人", "变更调整正在后台同步", "单个不超过 200 MB", "统一权限登录", "当前页面需要登录权限", "Ctrl+V", "采购形式", "单一采购", "单一原因", "确认到货签收", "采购基础数据正在同步，本次申请已先显示。", "正在同步采购数据", "正在使用原申请编号自动找回受理任务", "aria-busy", "提交中", "/api/inventory-management/storage-locations", "新增位置", "存放位置分类", "库内", "库外", "locationRecordId", "保存并选中", "当前内容已保留，请重试", "/api/inventory-management/outbounds/", "待库房确认", "查看并确认", "库房确认出库", "确认出库", "恢复草稿已锁定，请使用原出库编号重试", "结果暂不确定；请使用原编号安全重试", "任务均已取得服务端编号，可继续办理下一笔；系统会在后台逐笔核对。");',
    'utf8',
  );
  appendFileSync(
    join(clientRoot, 'main.js'),
    ';clientMutationId;console.log("/api/inventory-management/movements/deletions","/api/inventory-management/movements/deletions/tasks/","记录已从当前清单隐藏，正在后台同步删除","后台尚未确认的记录不能删除");',
    'utf8',
  );
  return clientRoot;
}

const inventoryStorageLocationRootMarkers = [
  '/api/inventory-management/storage-locations',
  'clientMutationId',
] as const;

const inventoryStorageLocationUiMarkers = [
  '\u65b0\u589e\u4f4d\u7f6e',
  '\u5b58\u653e\u4f4d\u7f6e\u5206\u7c7b',
  '\u5e93\u5185',
  '\u5e93\u5916',
  'locationRecordId',
  '\u4fdd\u5b58\u5e76\u9009\u4e2d',
  '\u5f53\u524d\u5185\u5bb9\u5df2\u4fdd\u7559\uff0c\u8bf7\u91cd\u8bd5',
] as const;

interface SplitInventoryStorageLocationFixtureOptions {
  includeDynamicLoad?: boolean;
  mappedHash?: string;
  chunkHash?: string;
  missingUiMarker?: (typeof inventoryStorageLocationUiMarkers)[number];
}

function createSplitInventoryStorageLocationFixture(
  root: string,
  options: SplitInventoryStorageLocationFixtureOptions = {},
): string {
  const clientRoot = createMinimalClientFixture(root);
  const chunkId = '8615';
  const mappedHash = options.mappedHash ?? '67d7ddcf';
  const chunkHash = options.chunkHash ?? mappedHash;
  const mainPath = join(clientRoot, 'main.js');
  let mainSource = readFileSync(mainPath, 'utf8');
  for (const marker of inventoryStorageLocationUiMarkers) {
    mainSource = mainSource.split(marker).join('removed-ui-marker');
  }
  mainSource +=
    options.includeDynamicLoad === false
      ? `;const chunkMap={${chunkId}:"${mappedHash}"};`
      : `;runtime.e("${chunkId}");const chunkMap={${chunkId}:"${mappedHash}"};`;
  writeFileSync(mainPath, mainSource, 'utf8');

  const chunkMarkers = inventoryStorageLocationUiMarkers.filter(
    (marker) => marker !== options.missingUiMarker,
  );
  writeFileSync(
    join(clientRoot, 'chunks', `${chunkId}.${chunkHash}.js`),
    `console.log(${chunkMarkers.map((marker) => JSON.stringify(marker)).join(',')});`,
    'utf8',
  );
  return clientRoot;
}

function createFrozenPurchaseClientFixture(root: string): string {
  const clientRoot = createSplitInventoryStorageLocationFixture(root);
  const mainPath = join(clientRoot, 'main.js');
  let mainSource = readFileSync(mainPath, 'utf8');
  for (const marker of [
    '采购形式',
    '单一采购',
    '单一原因',
    'aria-busy',
    '提交中',
  ]) {
    mainSource = mainSource.split(marker).join('frozen-purchase-baseline');
  }
  mainSource += [
    '/api/duty-schedules/change-drill-report',
    '演练提交',
    '演练报告',
    '统一权限登录',
    '当前页面需要登录权限',
  ]
    .map((marker) => `;console.log(${JSON.stringify(marker)})`)
    .join('');
  writeFileSync(mainPath, mainSource, 'utf8');
  return clientRoot;
}

function powershellStringLiteral(value: string): string {
  return `'${value.replace(/'/gu, "''")}'`;
}

function runValidationHarness(
  scriptPath: string,
  testRoot: string,
  command: string,
): string {
  const harnessPath = join(testRoot, 'validate-hotfix-functions.ps1');
  writeFileSync(
    harnessPath,
    `\uFEFF${[
      "$ErrorActionPreference = 'Stop'",
      `$sourceScriptPath = ${powershellStringLiteral(scriptPath)}`,
      '$scriptsDirectory = Split-Path -Parent $sourceScriptPath',
      '$source = [System.IO.File]::ReadAllText($sourceScriptPath)',
      "$executionMarker = '$isolatedClientBuildStageRoot = $null'",
      '$executionIndex = $source.IndexOf($executionMarker, [System.StringComparison]::Ordinal)',
      "if ($executionIndex -lt 0) { throw 'Hotfix function boundary is missing' }",
      '$prefix = $source.Substring(0, $executionIndex)',
      '$quotedScriptsDirectory = "\'" + $scriptsDirectory.Replace("\'", "\'\'") + "\'"',
      "$prefix = $prefix.Replace('$PSScriptRoot', $quotedScriptsDirectory)",
      '. ([scriptblock]::Create($prefix))',
      command,
    ].join('\r\n')}`,
    'utf8',
  );

  return execFileSync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', harnessPath],
    { encoding: 'utf8' },
  );
}

function runPackage(
  scriptPath: string,
  outputRoot: string,
  clientRoot: string,
): string {
  return execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      scriptPath,
      '-SkipBuild',
      '-OutputRoot',
      outputRoot,
      '-ClientRoot',
      clientRoot,
    ],
    { encoding: 'utf8' },
  );
}

function runFrozenPurchasePackage(
  scriptPath: string,
  outputRoot: string,
  clientRoot: string,
): string {
  return execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      scriptPath,
      '-SkipBuild',
      '-FrozenPurchase',
      '-OutputRoot',
      outputRoot,
      '-ClientRoot',
      clientRoot,
    ],
    { encoding: 'utf8' },
  );
}

describe('latest combined hotfix package', () => {
  const scriptPath = join(
    process.cwd(),
    'scripts',
    'create-latest-combined-hotfix-package.ps1',
  );
  const latestClientBuildScriptPath = join(
    process.cwd(),
    'scripts',
    'build-latest-hotfix-client.mjs',
  );
  const hotfixClientRspackConfigPath = join(
    process.cwd(),
    'rspack.hotfix.config.js',
  );
  const deployReadmePath = join(process.cwd(), 'deploy', 'README.md');
  let latestBuildTestRoot: string | undefined;
  let latestClientRoot: string | undefined;

  function getLatestClientRoot(): string {
    if (latestClientRoot) return latestClientRoot;
    latestBuildTestRoot = mkdtempSync(join(tmpdir(), 'nantong-latest-client-'));
    const candidateClientRoot = join(latestBuildTestRoot, 'client');
    execFileSync(
      process.execPath,
      [latestClientBuildScriptPath, '--output', candidateClientRoot],
      { encoding: 'utf8' },
    );
    latestClientRoot = candidateClientRoot;
    return latestClientRoot;
  }

  afterAll(() => {
    if (latestBuildTestRoot) {
      rmSync(latestBuildTestRoot, { recursive: true, force: true });
    }
  });

  it('builds the current purchase receipt UI without rendering a disabled action as loading', () => {
    expect(existsSync(latestClientBuildScriptPath)).toBe(true);

    const packageSource = readFileSync(scriptPath, 'utf8');
    expect(packageSource).toContain('build-latest-hotfix-client.mjs');
    expect(packageSource).toContain('[switch]$FrozenPurchase');
    expect(packageSource).toContain(
      'build-hotfix-client-with-frozen-purchase.mjs',
    );

    const clientRoot = getLatestClientRoot();
    const receiptBundle = listFiles(clientRoot)
      .filter((path) => extname(path) === '.js')
      .map((path) => readFileSync(join(clientRoot, path), 'utf8'))
      .find((content) => content.includes('确认到货签收'));
    expect(receiptBundle).toBeDefined();
    expect(receiptBundle).toContain('aria-busy');
    expect(receiptBundle).toContain('提交中');
    expect(receiptBundle).toContain('showSpinner');
    expect(receiptBundle).toMatch(
      /return\{disabled:(?<disabled>[\w$]+)\|\|(?<loading>[\w$]+),showSpinner:\k<loading>\}/u,
    );
    expect(receiptBundle).toMatch(
      /receiptPhotos:[\w$]+,invoices:[\w$]+,disabled:[\w$]+,loading:!1/u,
    );
    expect(receiptBundle).toContain('采购形式');
    expect(receiptBundle).toContain('单一采购');
    expect(receiptBundle).toContain('单一原因');
  });

  it('declares a frozen-purchase mode with explicit auth and drill-report package boundaries', () => {
    const source = readFileSync(scriptPath, 'utf8');

    for (const marker of [
      '[switch]$FrozenPurchase',
      'build-hotfix-client-with-frozen-purchase.mjs',
      "'dist/shared/change-request.js'",
      "'dist/shared/change-adjustment.js'",
      "'dist/shared/change-drill-report.js'",
      "'dist/shared/change-summary-report.js'",
      "'dist/server/common/access/unified-access.module.js'",
      "'dist/server/common/access/unified-access.controller.js'",
      "'dist/server/common/access/unified-access.service.js'",
      "'dist/server/modules/duty-schedule/change-drill-report.service.js'",
      "'dist/server/modules/duty-schedule/change-summary-report.service.js'",
      "'dist/server/modules/duty-schedule/change-summary-report-failed-self-test-cleanup.js'",
      "'dist/server/modules/duty-schedule/change-summary-report-failed-self-test-finalizer.js'",
      "'scripts/ensure-change-drill-report-fields.mjs'",
      "'scripts/ensure-change-summary-report-fields.mjs'",
      "'scripts/self-test-change-summary-report.mjs'",
      'duty-schedules/change-drill-report',
      'CHANGE_DRILL_REPORT_MUTATION_LEDGER_DIR',
      'CHANGE_DRILL_REPORT_REQUIRED_FIELDS',
      'Assert-FrozenPurchasePackageBoundary',
      'Assert-FrozenPurchaseArchiveBoundary',
      'purchase-page-current-workspace',
      'purchase-inventory-server',
    ]) {
      expect(source).toContain(marker);
    }
  });

  it('packages the change summary runtime, migration and exact-cleanup self-test', () => {
    const source = readFileSync(scriptPath, 'utf8');

    for (const marker of [
      "'dist/shared/change-summary-report.js'",
      "'dist/server/modules/duty-schedule/change-summary-report.service.js'",
      "'dist/server/modules/duty-schedule/change-summary-report-failed-self-test-cleanup.js'",
      "'dist/server/modules/duty-schedule/change-summary-report-failed-self-test-finalizer.js'",
      "'scripts/ensure-change-summary-report-fields.mjs'",
      "'scripts/self-test-change-summary-report.mjs'",
      'CHANGE_SUMMARY_REPORT_MUTATION_LEDGER_DIR',
      'CHANGE_SUMMARY_REPORT_REQUIRED_FIELDS',
      'CODEX-SELFTEST-CHANGE-SUMMARY',
      'duty-schedules/change-summary-report',
      'duty-schedules/change-summary-report/abandon',
      'change-summary-report/self-test/cleanup-bound-attachment',
      'change-summary-report/self-test/finalize-failed-cleanup',
      'change-attachments/:id/self-test-deletion-state',
      'x-change-summary-self-test-cleanup-proof',
      'x-change-summary-failed-self-test-cleanup-proof',
      'getDeletionStateForTrustedServer',
      'principalFingerprint',
      'accessPrincipalFingerprint',
      'self-test-cleaned',
      "'change-summary-report'",
      '变更总结请求唯一ID',
      '变更总结请求指纹',
      'self-test-change-summary-report.mjs cleanup-only',
    ]) {
      expect(source).toContain(marker);
    }

    for (const path of [
      'shared/change-summary-report.ts',
      'server/modules/duty-schedule/change-summary-report.service.ts',
      'server/modules/duty-schedule/change-summary-report-failed-self-test-cleanup.ts',
      'server/modules/duty-schedule/change-summary-report-failed-self-test-finalizer.ts',
      'scripts/ensure-change-summary-report-fields.mjs',
      'scripts/self-test-change-summary-report.mjs',
    ]) {
      expect(existsSync(join(process.cwd(), ...path.split('/')))).toBe(true);
    }
  });

  it('packages frozen purchase client with auth and drill report while excluding purchase-inventory server files', () => {
    const testRoot = mkdtempSync(join(tmpdir(), 'nantong-frozen-hotfix-'));
    const outputRoot = join(testRoot, 'output');
    const clientRoot = createFrozenPurchaseClientFixture(testRoot);
    mkdirSync(outputRoot);

    try {
      runFrozenPurchasePackage(scriptPath, outputRoot, clientRoot);
      const zipName = readdirSync(outputRoot).find((name) =>
        name.endsWith('.zip'),
      );
      expect(zipName).toBeDefined();

      const extractedRoot = join(testRoot, 'extracted');
      execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-Command',
          `Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::ExtractToDirectory(${powershellStringLiteral(join(outputRoot, zipName!))}, ${powershellStringLiteral(extractedRoot)})`,
        ],
        { encoding: 'utf8' },
      );

      const manifest = JSON.parse(
        readFileSync(join(extractedRoot, 'hotfix-manifest.json'), 'utf8'),
      ) as HotfixManifest;
      expect(manifest.mode).toBe('frozen-purchase');
      expect(manifest.scope).toContain('change-drill-report');
      expect(manifest.scope).toContain('unified-access-reauthentication');
      expect(manifest.scope).not.toContain('purchase-inventory');
      expect(manifest.excludedScope).toEqual([
        'purchase-page-current-workspace',
        'purchase-inventory-server',
      ]);

      const packagedPaths = new Set(manifest.files.map(({ path }) => path));
      for (const path of [
        'dist/shared/change-request.js',
        'dist/shared/change-adjustment.js',
        'dist/shared/change-drill-report.js',
        'dist/shared/change-summary-report.js',
        'dist/server/common/access/unified-access.module.js',
        'dist/server/common/access/unified-access.controller.js',
        'dist/server/common/access/unified-access.service.js',
        'dist/server/modules/duty-schedule/change-drill-report.service.js',
        'dist/server/modules/duty-schedule/change-summary-report.service.js',
        'scripts/ensure-change-drill-report-fields.mjs',
        'scripts/ensure-change-summary-report-fields.mjs',
        'scripts/self-test-change-summary-report.mjs',
      ]) {
        expect(packagedPaths.has(path)).toBe(true);
      }
      expect(
        [...packagedPaths].filter((path) =>
          path.startsWith('dist/server/modules/purchase-inventory/'),
        ),
      ).toHaveLength(0);

      const clientJavaScript = [...packagedPaths]
        .filter(
          (path) => path.startsWith('dist/client/') && path.endsWith('.js'),
        )
        .map((path) =>
          readFileSync(join(extractedRoot, ...path.split('/')), 'utf8'),
        )
        .join('\n');
      expect(clientJavaScript).toContain(
        '/api/duty-schedules/change-drill-report',
      );
      expect(clientJavaScript).toContain('统一权限登录');
      expect(clientJavaScript).toContain('当前页面需要登录权限');
      expect(clientJavaScript).not.toContain('采购形式');
      expect(clientJavaScript).not.toContain('单一采购');
      expect(clientJavaScript).not.toContain('单一原因');

      const readme = readFileSync(join(extractedRoot, 'README.md'), 'utf8');
      expect(readme).toContain('冻结采购页基线');
      expect(readme).toContain('不包含当前工作区的采购页优化');
      expect(readme).toContain('change-drill-report');
    } finally {
      rmSync(testRoot, { recursive: true, force: true });
    }
  });

  it('packages the compiled runtime required by scheduling, weather, purchase receipt and inbound workflows', () => {
    expect(existsSync(scriptPath)).toBe(true);

    const source = readFileSync(scriptPath, 'utf8');

    expect(source).toContain(
      '$packageName = "nantong-latest-combined-hotfix-$timestamp"',
    );
    expect(source).toContain("$clientRelativePath = 'dist/client'");
    expect(source).toContain('[string]$OutputRoot');
    expect(source).toContain('[string]$ClientRoot');
    expect(source).toContain(
      "$OutputRoot = Join-Path $projectRoot 'output\\hotfix'",
    );
    expect(source).not.toContain(
      '[string]$OutputRoot = (Join-Path $PSScriptRoot',
    );
    expect(source).toContain('$serverRelativePaths = @(');
    const serverRelativePathsBlock =
      source.match(/\$serverRelativePaths = @\([\s\S]*?\r?\n\)/u)?.[0] ?? '';
    expect(serverRelativePathsBlock).toContain(
      "'dist/server/common/access/unified-access.guard.js'",
    );
    expect(serverRelativePathsBlock).toContain(
      "'dist/server/common/feishu/bitable-direct-read.js'",
    );
    expect(serverRelativePathsBlock).toContain(
      "'dist/server/common/feishu/leave-approval-source.js'",
    );
    expect(serverRelativePathsBlock).toContain(
      "'dist/server/common/filters/exception.filter.js'",
    );
    expect(serverRelativePathsBlock).toContain(
      "'dist/server/common/interfaces/api_response.interface.js'",
    );
    expect(serverRelativePathsBlock).toContain(
      "'dist/server/modules/duty-schedule/duty-schedule.controller.js'",
    );
    expect(serverRelativePathsBlock).toContain(
      "'dist/server/modules/duty-schedule/change-attachment-temp-directory.js'",
    );
    expect(source).toContain("'dist/server/app.module.js'");
    expect(source).toContain(
      "'dist/server/modules/bitable-sync/bitable-sync.service.js'",
    );
    expect(serverRelativePathsBlock).toContain(
      "'dist/server/modules/bitable-sync/active-personnel-directory.js'",
    );
    expect(serverRelativePathsBlock).toContain(
      "'dist/server/modules/bitable-sync/change-request-submitter-directory.js'",
    );
    expect(serverRelativePathsBlock).toContain(
      "'dist/server/modules/bitable-sync/today-operations-kpi.service.js'",
    );
    expect(source).toContain(
      "'dist/server/modules/duty-schedule/duty-schedule.service.js'",
    );
    expect(serverRelativePathsBlock).toContain(
      "'dist/server/modules/duty-schedule/approved-leave-visibility.js'",
    );
    expect(source).toContain(
      "'dist/server/modules/duty-schedule/duty-screenshot.service.js'",
    );
    [
      'leave-workflow.callback.js',
      'leave-workflow.card.js',
      'leave-workflow.gateway.js',
      'leave-workflow.module.js',
      'leave-workflow.rules.js',
      'leave-workflow.scheduler.js',
      'leave-workflow.service.js',
      'leave-workflow.store.js',
      'leave-workflow.types.js',
    ].forEach((fileName) => {
      expect(serverRelativePathsBlock).toContain(
        `'dist/server/modules/leave-workflow/${fileName}'`,
      );
    });
    expect(source).toContain("'scripts/ensure-leave-workflow-fields.mjs'");
    expect(source).toContain('requiresSupervisorSubstitute');
    expect(source).toContain('leave_substitute_person_record_id');
    expect(source).toContain('leave_approve_submit:');
    expect(source).toContain('getCachedLeaveRequestImpactSchedules');
    expect(source).toContain('recoverApplicationsByLeaveCodes');
    expect(source).toContain('recoverConfiguredApplications');
    expect(source).toContain('findLeaveRecordsByCodes');
    expect(source).not.toContain('7×24小时排班人员请休假必须选择替班人员');
    expect(source).toContain('DUTY_STAFF_PROGRAM_MODIFIED_FIELD_CANDIDATES');
    expect(source).toContain('captureAndSendDutyOverview');
    expect(source).toContain("source === 'manual'");
    expect(source).toContain(
      "'dist/server/modules/weather-warning/weather-warning.module.js'",
    );
    expect(source).toContain(
      "'dist/server/modules/weather-warning/weather-warning.scheduler.js'",
    );
    expect(source).toContain(
      "'dist/server/modules/weather-warning/weather-warning-automation.service.js'",
    );
    expect(source).toContain(
      "'dist/server/modules/weather-warning/weather-warning-automation.config.js'",
    );
    expect(source).toContain(
      "'dist/server/modules/weather-warning/weather-warning-automation-state-store.js'",
    );
    expect(serverRelativePathsBlock).toContain(
      "'dist/server/modules/weather-warning/weather-warning-check-scope.js'",
    );
    for (const path of [
      'dist/server/modules/weather-warning/weather-warning-registration.rules.js',
      'dist/server/modules/weather-warning/weather-warning-registration-link.js',
      'dist/server/modules/weather-warning/weather-warning-registration.config.js',
      'dist/server/modules/weather-warning/weather-warning-registration.gateway.js',
      'dist/server/modules/weather-warning/weather-warning-registration.service.js',
      'dist/server/modules/weather-warning/weather-warning-test-simulation.js',
    ]) {
      expect(serverRelativePathsBlock).toContain(`'${path}'`);
    }
    for (const path of [
      'dist/server/modules/weather-warning/weather-warning.controller.js',
      'dist/server/modules/weather-warning/weather-warning.module.js',
      'dist/server/modules/weather-warning/weather-warning-card.js',
      'dist/server/modules/weather-warning/weather-warning-notification.service.js',
      'dist/server/modules/weather-warning/weather-warning-automation.service.js',
    ]) {
      expect(serverRelativePathsBlock).toContain(`'${path}'`);
    }
    expect(source).toContain("'dist/shared/api.interface.js'");
    expect(source).toContain("'dist/shared/change-request.js'");
    expect(source).toContain("'dist/shared/change-adjustment.js'");
    expect(source).toContain("'dist/shared/duty-staff-name.js'");
    expect(source).toContain("'dist/shared/leave-request-impact.js'");
    expect(source).toContain("'dist/shared/overtime-request-impact.js'");
    expect(source).toContain("'dist/shared/inventory-management.interface.js'");
    expect(source).toContain('WeatherWarningModule');
    expect(source).toContain('leave-request');
    expect(source).toContain('Get-LocalRuntimeDependencyClosure');
    expect(serverRelativePathsBlock).toContain(
      "'dist/server/modules/purchase-inventory/purchase-inventory.controller.js'",
    );
    expect(serverRelativePathsBlock).toContain(
      "'dist/server/modules/purchase-inventory/purchase-workflow-receipt-task.service.js'",
    );
    expect(serverRelativePathsBlock).toContain(
      "'dist/server/modules/inventory-management/purchase-inbound-confirmation.service.js'",
    );
    expect(source).toContain("'## 天气预警接口预检'");
    expect(source).toContain('403 表示全局访问守卫版本仍不一致');
    expect(source).toContain('规则或检查表暂不可用时也应返回 200 降级快照');
    expect(source).toContain('503 表示新降级逻辑尚未生效');
    expect(source).toContain('200 表示快照接口契约可用');
    expect(source).toContain('active、clear、degraded 或 stale');
    expect(source).toContain('Copy-RequiredFile');
    expect(source).toContain('-Source $clientRoot');
    expect(source).toContain('$serverRelativePaths');
    expect(serverRelativePathsBlock).toContain('purchase-inventory');
    const compiledMarkersBlock =
      source.match(/function Assert-CompiledMarkers[\s\S]*?\r?\n\}/u)?.[0] ??
      '';
    expect(compiledMarkersBlock).toContain(
      'dist/server/modules/weather-warning/weather-warning.scheduler.js',
    );
    expect(compiledMarkersBlock).toContain(
      'dist/server/common/feishu/leave-approval-source.js',
    );
    expect(compiledMarkersBlock).toContain(
      'dist/server/common/feishu/bitable-direct-read.js',
    );
    expect(compiledMarkersBlock).toContain(
      'Math.abs(field) < 100_000_000_000 ? field * 1000 : field',
    );
    expect(compiledMarkersBlock).toContain('automatic_fields');
    expect(compiledMarkersBlock).toContain('automaticFields');
    expect(compiledMarkersBlock).toContain(
      'SYSTEM_LEAVE_APPROVAL_VERIFIED_FIELD',
    );
    expect(compiledMarkersBlock).toContain(
      'dist/server/modules/duty-schedule/approved-leave-visibility.js',
    );
    expect(compiledMarkersBlock).toContain(
      'dist/server/modules/bitable-sync/today-operations-kpi.service.js',
    );
    expect(compiledMarkersBlock).toContain(
      'dist/server/modules/bitable-sync/active-personnel-directory.js',
    );
    expect(compiledMarkersBlock).toContain('buildActivePersonnelDirectory');
    expect(compiledMarkersBlock).toContain(
      'dist/server/modules/bitable-sync/change-request-submitter-directory.js',
    );
    expect(compiledMarkersBlock).toContain(
      'resolveChangeRequestSubmitterCandidate',
    );
    expect(compiledMarkersBlock).toContain(
      'listEligibleChangeRequestSubmitterNames',
    );
    expect(compiledMarkersBlock).toContain(
      'dist/server/modules/bitable-sync/bitable-sync.service.js',
    );
    expect(compiledMarkersBlock).toContain('getCachedActivePersonnelDirectory');
    for (const marker of [
      'dist/server/modules/purchase-inventory/purchase-inventory.module.js',
      'PurchaseWorkflowReceiptTaskService',
      "Post)('workflows/:recordId/receive')",
      "Get)('workflows/receipt-tasks/:taskId')",
      'HttpStatus.ACCEPTED',
      'setImmediate(() => void this.executeTask(task.id))',
      'canReadReceiptTask',
      'PURCHASE_APPLICANT_RECEIPT_TASK_PATH',
      'isSameBuildingPurchaseApplicant',
    ]) {
      expect(compiledMarkersBlock).toContain(marker);
    }
    expect(compiledMarkersBlock).toContain('config.pollIntervalMs');
    expect(compiledMarkersBlock).toContain(
      'dist/server/modules/weather-warning/weather-warning-automation.service.js',
    );
    expect(compiledMarkersBlock).toContain('forceRefresh: true');
    expect(compiledMarkersBlock).toContain('buildWeatherWarningReminderCard');
    expect(compiledMarkersBlock).toContain('config.reminderIntervalMs');
    expect(compiledMarkersBlock).toContain('buildingProgress.incompleteItems');
    expect(compiledMarkersBlock).toContain(
      'dist/server/modules/weather-warning/weather-warning-check-scope.js',
    );
    expect(compiledMarkersBlock).toContain('resolveWeatherWarningCheckScope');
    expect(compiledMarkersBlock).toContain(
      'dist/server/modules/weather-warning/weather-warning-automation.config.js',
    );
    expect(compiledMarkersBlock).toContain(
      'FEISHU_WEATHER_WARNING_IMPORTANT_EVENT_CHAT_IDS',
    );
    expect(compiledMarkersBlock).toContain(
      'FEISHU_WEATHER_WARNING_POLL_INTERVAL_MS',
    );
    expect(compiledMarkersBlock).toContain(
      'FEISHU_WEATHER_WARNING_REMINDER_INTERVAL_MS',
    );
    expect(compiledMarkersBlock).toContain(
      'dist/server/modules/weather-warning/weather-warning-automation-state-store.js',
    );
    expect(compiledMarkersBlock).toContain(
      'weather-warning-automation-state.json',
    );
    expect(compiledMarkersBlock).toContain(
      'acquireWeatherWarningAutomationLease',
    );
    expect(compiledMarkersBlock).toContain(
      'dist/shared/overtime-request-impact.js',
    );
    expect(compiledMarkersBlock).toContain('calculateOvertimeRequestImpact');
    expect(compiledMarkersBlock).toContain(
      'createOvertimeRequestImpactComparisonKey',
    );
    expect(compiledMarkersBlock).toContain('long_white_workday_hours');
    expect(compiledMarkersBlock).toContain('continuous_duty_24_hours');
    expect(compiledMarkersBlock).toContain(
      'dist/server/common/access/unified-access.guard.js',
    );
    expect(compiledMarkersBlock).toContain(
      'POST /api/duty-schedules/overtime-request',
    );
    expect(compiledMarkersBlock).toContain(
      'dist/server/common/filters/exception.filter.js',
    );
    expect(compiledMarkersBlock).toContain(
      'dist/server/modules/duty-schedule/duty-schedule.controller.js',
    );
    expect(compiledMarkersBlock).toContain('duty-schedules/change-request');
    expect(compiledMarkersBlock).toContain('CHANGE_ATTACHMENT_MAX_BYTES');
    expect(compiledMarkersBlock).toContain('parts: 6');
    expect(compiledMarkersBlock).toContain('duty-schedules/overtime-request');
    expect(compiledMarkersBlock).toContain(
      'overtimeRequestScreenshotFileFilter',
    );
    expect(compiledMarkersBlock).toContain(
      'dist/server/modules/duty-schedule/duty-schedule.service.js',
    );
    expect(compiledMarkersBlock).toContain('createOvertimeRequest');
    expect(compiledMarkersBlock).toContain(
      'OVERTIME_REQUEST_MUTATION_LEDGER_DIR',
    );
    expect(compiledMarkersBlock).toContain('overtime-request-client-token:');
    expect(compiledMarkersBlock).toContain(
      '长白班工作日加班仅可选择 09:00 前或 18:00 后',
    );
    expect(compiledMarkersBlock).toContain(
      '7×24 排班人员加班不得与本人排班连续值守达到 24 小时',
    );
    expect(compiledMarkersBlock).toContain('registration/options');
    expect(compiledMarkersBlock).toContain('test-full-flow-send');
    expect(compiledMarkersBlock).toContain('test-full-flow-progress-send');
    expect(compiledMarkersBlock).toContain('application/pdf');
    expect(compiledMarkersBlock).toContain('weatherGuardRegistration');
    expect(compiledMarkersBlock).toContain('WeatherWarningRegistrationService');
    expect(compiledMarkersBlock).toContain('application/pdf');
    expect(compiledMarkersBlock).toContain('listManagerCandidateRecords');
    expect(compiledMarkersBlock).toContain('PDF_SIGNATURE');
    expect(compiledMarkersBlock).toContain(
      'FEISHU_WEATHER_WARNING_MANAGER_TABLE_ID',
    );
    expect(compiledMarkersBlock).toContain(
      'FEISHU_PURCHASE_ORGANIZATION_TABLE_ID',
    );
    expect(compiledMarkersBlock).toContain('buildCachedCandidateCatalog');
    expect(compiledMarkersBlock).not.toContain('buildManagerCandidateCatalog');
    expect(compiledMarkersBlock).toContain('managerOpenIds');
    expect(compiledMarkersBlock).toContain('registrationUrl');
    expect(compiledMarkersBlock).toContain('提交戒备登记');
    expect(compiledMarkersBlock).toContain('执行进度 · 最近登记');
    expect(compiledMarkersBlock).toContain('楼栋进度');
    expect(compiledMarkersBlock).toContain('normalizeTemperatureMetric');
    expect(compiledMarkersBlock).toContain('normalizeHumidityMetric');
    expect(compiledMarkersBlock).toContain('${numeric}%');
    expect(compiledMarkersBlock).toContain('℃');
    expect(compiledMarkersBlock).toContain('sendFullFlowTest');
    expect(compiledMarkersBlock).toContain('sendFullFlowProgress');
    expect(compiledMarkersBlock).toContain('sendPersonalTestCard');
    expect(compiledMarkersBlock).toContain(
      'createWeatherWarningTestSimulationContext',
    );
    expect(compiledMarkersBlock).toContain('weather-e2e-');
    expect(compiledMarkersBlock).toContain(
      'WEATHER_WARNING_TEST_SIMULATION_SECRET',
    );
    expect(compiledMarkersBlock).toContain(
      'Forbidden compiled marker is present',
    );
    expect(compiledMarkersBlock).toContain('仅供关注');
    expect(compiledMarkersBlock).toContain('规则：重保类型对应表');
    expect(compiledMarkersBlock).toContain('状态：');
    expect(compiledMarkersBlock).toContain('FEISHU_ORG_APP_TOKEN');
    expect(compiledMarkersBlock).toContain('FEISHU_ORG_TABLE_ID');
    expect(source).toContain(
      'if ((Test-Path -LiteralPath $zipPath) -or (Test-Path -LiteralPath $checksumPath))',
    );
    expect(source).not.toContain(
      'if (Test-Path -LiteralPath $zipPath -or Test-Path -LiteralPath $checksumPath)',
    );
  });

  it('declares the emergency-duty runtime and its permission/write-result safety markers explicitly', () => {
    const source = readFileSync(scriptPath, 'utf8');
    const serverRelativePathsBlock =
      source.match(/\$serverRelativePaths = @\([\s\S]*?\r?\n\)/u)?.[0] ?? '';
    const sharedRelativePathsBlock =
      source.match(/\$sharedRelativePaths = @\([\s\S]*?\r?\n\)/u)?.[0] ?? '';
    const compiledMarkersBlock =
      source.match(/function Assert-CompiledMarkers[\s\S]*?\r?\n\}/u)?.[0] ??
      '';
    const forbiddenMarkersBlock =
      source.match(/\$forbiddenChecks = @\([\s\S]*?\r?\n  \)/u)?.[0] ?? '';

    for (const path of [
      'dist/server/modules/duty-schedule/emergency-duty.controller.js',
      'dist/server/modules/duty-schedule/emergency-duty.service.js',
    ]) {
      expect(serverRelativePathsBlock).toContain(`'${path}'`);
    }
    expect(sharedRelativePathsBlock).toContain(
      "'dist/shared/emergency-duty.interface.js'",
    );
    expect(source).toContain(
      'emergency duty schedules, weather warnings, purchase and purchase inbound',
    );
    expect(source).toContain('# 南通排班综合业务与采购签收热包');
    expect(source).toContain(
      '- 应急值班：排班页显示前一天、当天、后一天值守，并提供独立 11 天调整；读取使用服务端本地快照。',
    );
    expect(source).toContain(
      "'purchase-inventory', 'purchase-receipt', 'purchase-inbound'",
    );

    for (const marker of [
      'dist/server/modules/duty-schedule/emergency-duty.controller.js',
      'EmergencyDutyController',
      'dist/server/modules/duty-schedule/emergency-duty.service.js',
      'EmergencyDutyService',
      'unknown-result',
      'definitely-not-written',
      'dist/server/modules/duty-schedule/duty-schedule.module.js',
      'dist/server/modules/weather-warning/weather-warning.controller.js',
      'GuestSubmittable',
    ]) {
      expect(compiledMarkersBlock).toContain(marker);
    }
    expect(compiledMarkersBlock).toContain(
      'dist/server/modules/purchase-inventory/purchase-workflow.rules.js',
    );
    expect(compiledMarkersBlock).not.toContain(
      'dist/server/modules/purchase-inventory/purchase-workflow-rules.js',
    );

    expect(serverRelativePathsBlock).toContain('purchase-inventory');
    expect(sharedRelativePathsBlock).toContain(
      'inventory-management.interface.js',
    );
    expect(source).toContain(
      'Copy-RequiredDirectory -Source $clientRootPath -Destination $stagedClientRoot -RelativeRoot $clientRelativePath',
    );
    expect(source).not.toMatch(/'dist\/client\/[^']+'/u);
    expect(forbiddenMarkersBlock).not.toContain('GuestSubmittable');
  });

  it('declares the complete warehouse storage-location picker runtime and deployment markers', () => {
    const source = readFileSync(scriptPath, 'utf8');
    const clientBuildSource = readFileSync(latestClientBuildScriptPath, 'utf8');
    const serverRelativePathsBlock =
      source.match(/\$serverRelativePaths = @\([\s\S]*?\r?\n\)/u)?.[0] ?? '';
    const compiledMarkersBlock =
      source.match(/function Assert-CompiledMarkers[\s\S]*?\r?\n\}/u)?.[0] ??
      '';

    for (const path of [
      'dist/server/modules/inventory-management/inventory-storage-location.rules.js',
      'dist/server/modules/inventory-management/inventory-storage-location.service.js',
    ]) {
      expect(serverRelativePathsBlock).toContain(`'${path}'`);
      expect(compiledMarkersBlock).toContain(path);
    }
    expect(compiledMarkersBlock).toContain(
      'FEISHU_WAREHOUSE_STORAGE_LOCATION_TABLE_ID',
    );
    expect(compiledMarkersBlock).toContain('clientMutationId');
    for (const marker of [
      'InventoryStorageLocationService',
      'GET /api/inventory-management/storage-locations',
      'POST /api/inventory-management/storage-locations',
      'resolveSelectedLocation',
      'locationRecordId',
    ]) {
      expect(compiledMarkersBlock).toContain(marker);
    }
    for (const marker of [
      '/api/inventory-management/storage-locations',
      '新增位置',
      '存放位置分类',
      '库内',
      '库外',
      'locationRecordId',
      '保存并选中',
      '当前内容已保留，请重试',
    ]) {
      expect(source).toContain(marker);
      expect(clientBuildSource).toContain(marker);
    }
    expect(clientBuildSource).toContain(
      'requiredInventoryStorageLocationMarkers',
    );
    expect(source).toContain('clientMutationId');
    expect(clientBuildSource).toContain('clientMutationId');
    expect(clientBuildSource).toContain("join(outputPath, 'main.js')");
    expect(clientBuildSource).toContain('mainBundleContent');
    expect(source).toContain("'inventory-storage-location'");
    expect(source).toContain(
      '- 采购入库的存放位置从库房位置底表选择；支持新增位置、失败保留草稿并沿原请求 ID 重试。',
    );
  });

  it('declares the complete pending outbound and warehouse confirmation runtime', () => {
    const source = readFileSync(scriptPath, 'utf8');
    const clientBuildSource = readFileSync(latestClientBuildScriptPath, 'utf8');
    const serverRelativePathsBlock =
      source.match(/\$serverRelativePaths = @\([\s\S]*?\r?\n\)/u)?.[0] ?? '';
    const compiledMarkersBlock =
      source.match(/function Assert-CompiledMarkers[\s\S]*?\r?\n\}/u)?.[0] ??
      '';
    const forbiddenMarkersBlock =
      source.match(/\$forbiddenChecks = @\([\s\S]*?\r?\n  \)/u)?.[0] ?? '';

    expect(serverRelativePathsBlock).toContain(
      "'dist/server/modules/inventory-management/inventory-outbound-workflow.service.js'",
    );
    for (const marker of [
      'dist/server/modules/inventory-management/inventory-movement-command.rules.js',
      '出库数量: request.quantity',
      'InventoryOutboundWorkflowService',
      'outbounds/:recordId/confirm',
      '程序出库状态',
      '出库确认标识',
      'assertPendingApplicationFingerprint',
      'fieldPersonOpenId',
      '出库数量未持久化',
      'repairMissingPendingFormalQuantity',
      'claimUncertain',
      'abandonUncertainClaim',
      'listUncertain',
      '出库不确定任务 owner 已变更',
      'reconcileClaimedUncertainTask',
      'scheduleUncertainTask',
      'INVENTORY_ADMIN_OUTBOUND_CONFIRM_PATH',
    ]) {
      expect(compiledMarkersBlock).toContain(marker);
    }
    for (const path of [
      'dist/server/modules/inventory-management/inventory-movement-command.rules.js',
      'dist/server/modules/inventory-management/inventory-outbound-workflow.service.js',
    ]) {
      expect(forbiddenMarkersBlock).toContain(path);
    }
    expect(forbiddenMarkersBlock).toContain("Marker = '流程:'");
    for (const marker of [
      '/api/inventory-management/outbounds/',
      '待库房确认',
      '查看并确认',
      '库房确认出库',
      '确认出库',
    ]) {
      expect(source).toContain(marker);
      expect(clientBuildSource).toContain(marker);
    }
    expect(source).toContain("'inventory-outbound-confirmation'");
    expect(source).toContain(
      '平台仅写普通业务字段，不写只读的“流程（Stage）”字段',
    );
    expect(source).toContain('Stage 与库存累计由多维表原生流程及自动化维护');
    expect(source).toContain(
      '共享同一 .runtime 出库账本的多进程同时核对时，持久化租约确保正常租约有效期内只有一个进程回填；进程中断或租约过期后可由其他进程接管',
    );
  });

  it('locks purchase active sync and durable outbound retry into the hot package contract', () => {
    const source = readFileSync(scriptPath, 'utf8');
    const clientBuildSource = readFileSync(latestClientBuildScriptPath, 'utf8');
    const serverRelativePathsBlock =
      source.match(/\$serverRelativePaths = @\([\s\S]*?\r?\n\)/u)?.[0] ?? '';
    const compiledMarkersBlock =
      source.match(/function Assert-CompiledMarkers[\s\S]*?\r?\n\}/u)?.[0] ??
      '';

    for (const path of [
      'dist/server/modules/inventory-management/inventory-outbound-canonical.js',
      'dist/server/modules/inventory-management/inventory-outbound-task-ledger.store.js',
      'dist/server/modules/purchase-inventory/purchase-application-task-ledger.store.js',
    ]) {
      expect(serverRelativePathsBlock).toContain(`'${path}'`);
    }

    for (const marker of [
      'assertInventoryOutboundCanonicalRequest',
      'InventoryOutboundTaskLedgerStore',
      'PurchaseApplicationTaskLedgerStore',
      'revalidateSubmissionApplicant',
      'definitelyNotWritten',
      '出库申请请使用异步出库接口 /api/inventory-management/outbounds',
      'ACTIVE_SOURCE_CACHE_TTL_MS',
    ]) {
      expect(compiledMarkersBlock).toContain(marker);
    }

    for (const marker of [
      '采购基础数据正在同步，本次申请已先显示。',
      '正在同步采购数据',
      '正在使用原申请编号自动找回受理任务',
      '恢复草稿已锁定，请使用原出库编号重试',
      '结果暂不确定；请使用原编号安全重试',
      '任务均已取得服务端编号，可继续办理下一笔；系统会在后台逐笔核对。',
    ]) {
      expect(source).toContain(marker);
      expect(clientBuildSource).toContain(marker);
    }

    expect(source).toContain("'purchase-active-sync'");
    expect(source).toContain("'inventory-outbound-durable-retry'");
  });

  it('locks durable inventory movement deletion into the hot package contract', () => {
    const source = readFileSync(scriptPath, 'utf8');
    const clientBuildSource = readFileSync(latestClientBuildScriptPath, 'utf8');
    const serverRelativePathsBlock =
      source.match(/\$serverRelativePaths = @\([\s\S]*?\r?\n\)/u)?.[0] ?? '';
    const compiledMarkersBlock =
      source.match(/function Assert-CompiledMarkers[\s\S]*?\r?\n\}/u)?.[0] ??
      '';

    for (const path of [
      'dist/server/modules/inventory-management/inventory-movement-deletion-task-ledger.store.js',
      'dist/server/modules/inventory-management/inventory-movement-deletion.service.js',
      'dist/server/modules/inventory-management/inventory-movement-operation-coordinator.js',
      'dist/server/modules/inventory-management/purchase-inbound-category-task-ledger.store.js',
      'dist/server/modules/inventory-management/purchase-inbound-category-task.service.js',
    ]) {
      expect(serverRelativePathsBlock).toContain(`'${path}'`);
    }

    for (const marker of [
      'InventoryMovementDeletionTaskLedgerStore',
      'inventory-movement-deletion-task-ledger.json',
      'updateRecoveryState',
      'InventoryMovementDeletionService',
      'reconcileRunningTask',
      'recoveryCompensationWarning',
      'InventoryMovementOperationCoordinator',
      'movements/deletions',
      "writeDisposition: 'definitely-not-written'",
      'INVENTORY_ADMIN_MOVEMENT_DELETION_TASK_PATH',
      'data.items === undefined && data.total === 0 && data.has_more === false',
      'PurchaseInboundCategoryTaskLedgerStore',
      'purchase-inbound-category-task-ledger.json',
      'PurchaseInboundCategoryTaskService',
      'purchase-inbounds/category-tasks',
    ]) {
      expect(compiledMarkersBlock).toContain(marker);
    }

    expect(compiledMarkersBlock).toContain('InventoryMovementDeletionService');

    for (const marker of [
      '/api/inventory-management/movements/deletions',
      '/api/inventory-management/movements/deletions/tasks/',
      '记录已从当前清单隐藏，正在后台同步删除',
      '后台尚未确认的记录不能删除',
    ]) {
      expect(source).toContain(marker);
      expect(clientBuildSource).toContain(marker);
    }

    expect(source).toContain('申请中、审批中每 15 秒及窗口聚焦时刷新');
    expect(source).toContain('服务端活跃数据缓存 10 秒');
    expect(source).not.toContain('申请中、审批中每 60 秒及窗口聚焦时刷新');
    expect(source).not.toContain('服务端活跃数据缓存 45 秒');
    expect(source).toContain('管理员可删除全部楼栋记录');
    expect(source).toContain('库房管理员仅可删除本楼记录');
    expect(source).toContain('删除受理后立即从当前清单隐藏并标记后台同步');
    expect(source).toContain('后端明确未写入时精准恢复原记录');

    expect(source).toContain("'inventory-movement-deletion'");
  });

  it('declares the complete change-request and adjustment runtime/tooling overlay', () => {
    const source = readFileSync(scriptPath, 'utf8');
    const serverRelativePathsBlock =
      source.match(/\$serverRelativePaths = @\([\s\S]*?\r?\n\)/u)?.[0] ?? '';
    const sharedRelativePathsBlock =
      source.match(/\$sharedRelativePaths = @\([\s\S]*?\r?\n\)/u)?.[0] ?? '';
    const operationalScriptsBlock =
      source.match(
        /\$operationalScriptRelativePaths = @\([\s\S]*?\r?\n\)/u,
      )?.[0] ?? '';
    const compiledMarkersBlock =
      source.match(/function Assert-CompiledMarkers[\s\S]*?\r?\n\}/u)?.[0] ??
      '';

    for (const path of [
      'dist/server/runtime-env.js',
      'dist/server/modules/duty-schedule/change-request-document-validator.js',
      'dist/server/modules/duty-schedule/change-attachment-upload.js',
      'dist/server/modules/duty-schedule/change-attachment-storage.service.js',
      'dist/server/modules/duty-schedule/change-attachment-temp-directory.js',
      'dist/server/modules/duty-schedule/change-adjustment.service.js',
      'dist/server/modules/duty-schedule/change-adjustment-record.js',
      'dist/server/modules/duty-schedule/change-summary-report.service.js',
      'dist/server/modules/duty-schedule/change-summary-report-failed-self-test-cleanup.js',
      'dist/server/modules/duty-schedule/change-summary-report-failed-self-test-finalizer.js',
    ]) {
      expect(serverRelativePathsBlock).toContain(`'${path}'`);
      expect(compiledMarkersBlock).toContain(path);
      expect(
        existsSync(
          join(
            process.cwd(),
            ...path
              .replace(/^dist\//u, '')
              .replace(/\.js$/u, '.ts')
              .split('/'),
          ),
        ),
      ).toBe(true);
    }
    expect(operationalScriptsBlock).toContain("'start.ps1'");
    expect(operationalScriptsBlock).toContain("'scripts/run-with-env.mjs'");
    expect(operationalScriptsBlock).toContain(
      "'deploy/configure-change-attachment-storage.ps1'",
    );
    expect(source).toContain("'.ps1'");
    for (const path of [
      'dist/shared/api.interface.js',
      'dist/shared/change-request.js',
      'dist/shared/change-adjustment.js',
      'dist/shared/change-summary-report.js',
      'dist/shared/duty-staff-name.js',
    ]) {
      expect(sharedRelativePathsBlock).toContain(`'${path}'`);
      expect(
        existsSync(
          join(
            process.cwd(),
            ...path
              .replace(/^dist\//u, '')
              .replace(/\.js$/u, '.ts')
              .split('/'),
          ),
        ),
      ).toBe(true);
    }
    for (const path of [
      'scripts/ensure-change-adjustment-fields.mjs',
      'scripts/self-test-change-adjustment.mjs',
      'scripts/ensure-change-summary-report-fields.mjs',
      'scripts/self-test-change-summary-report.mjs',
    ]) {
      expect(operationalScriptsBlock).toContain(`'${path}'`);
      expect(existsSync(join(process.cwd(), ...path.split('/')))).toBe(true);
    }

    expect(source).toContain('$operationalScriptRelativePaths');
    expect(source).toContain(
      'foreach ($relativePath in $operationalScriptRelativePaths)',
    );
    expect(source).toContain('$duplicateExplicitPaths');
    expect(source).toContain("'.mjs'");
    expect(source).toContain('CHANGE_REQUEST_MAX_DOCUMENT_SIZE');
    expect(source).toContain('单个变更方案附件不能超过 200MB');
    expect(source).toContain('BITABLE_ATTACHMENT_MULTIPART_BLOCK_SIZE');
    expect(source).toContain('mapChangeAdjustmentRecordSnapshot');
    expect(source).toContain('CHANGE_ADJUSTMENT_MUTATION_LEDGER_DIR');
    expect(source).toContain('ChangeAttachmentUploadAdmissionInterceptor');
    expect(source).toContain('CHANGE_ATTACHMENT_ROUTE_UPLOAD_CONCURRENCY');
    expect(source).toContain('parts: 3');
    expect(source).toContain(
      '2. 备份当前 dist/client、本包内列出的 dist/server 和 dist/shared 文件，以及根目录 start.cmd、start.ps1 与 scripts/run-with-env.mjs。',
    );
    expect(source).toContain(
      '必须同步覆盖 start.cmd、start.ps1 与 scripts/run-with-env.mjs，不能只替换 dist。',
    );
    expect(source).toContain('deploy/configure-change-attachment-storage.ps1');
    expect(source).toContain(
      '覆盖完成后直接双击 start.cmd；脚本会自动读取服务器现有私密配置并启动服务。',
    );
    expect(source).toContain('正常覆盖部署无需再次输入凭据');
    expect(source).not.toContain('-ValidateOnly');
    expect(source).toContain(
      '对象存储启动修复：随包的 start.ps1 会自动读取 Windows 用户或机器环境、应用上一级的 nantong-schedule.private.env、应用根目录 .env/.env.local 中的腾讯云凭据；非空配置自动生效，启动日志仅显示 READY/NOT CONFIGURED，不输出密钥。',
    );
    expect(source).toContain(
      '服务器首次仅需在应用上一级创建一次 nantong-schedule.private.env；以后覆盖或整目录替换应用均可直接双击 start.cmd，热包不会包含或覆盖该文件。',
    );
    expect(source).toContain(
      'duty-schedules/change-adjustment/self-test/cleanup-bound-attachment',
    );
    expect(source).toContain('x-change-self-test-cleanup-proof');
    expect(source).toContain('deleteBoundForTrustedSelfTest');
    expect(source).toContain('createChangeSelfTestCleanupProof');
    expect(source).toContain(
      "scope = @('leave-request', 'overtime-request', 'change-request', 'change-adjustment', 'change-summary-report', 'leave-substitute', 'duty-screenshot', 'emergency-duty', 'weather-warning', 'purchase-inventory', 'purchase-receipt', 'purchase-inbound', 'purchase-active-sync', 'inventory-storage-location', 'inventory-outbound-confirmation', 'inventory-outbound-durable-retry', 'inventory-movement-deletion')",
    );
    expect(source).toContain('scripts/ensure-change-adjustment-fields.mjs');
    expect(source).toContain('scripts/self-test-change-adjustment.mjs');
    expect(source).toContain('单个不超过 200 MB');
    expect(source).toContain('对象存储');
    expect(source).toContain('多维表附件');
  });

  it('declares the overtime client boundary, runtime state and exact real-data cleanup contract', () => {
    const source = readFileSync(scriptPath, 'utf8');
    const serverRelativePathsBlock =
      source.match(/\$serverRelativePaths = @\([\s\S]*?\r?\n\)/u)?.[0] ?? '';
    const clientBoundaryBlock =
      source.match(
        /function Assert-ClientHotfixBoundary[\s\S]*?\r?\n\}/u,
      )?.[0] ?? '';

    for (const path of [
      'dist/server/modules/view/view.controller.js',
      'dist/server/modules/overtime-workflow/overtime-workflow.callback.js',
      'dist/server/modules/overtime-workflow/overtime-workflow.card-action.consumer.js',
      'dist/server/modules/overtime-workflow/overtime-workflow.card.js',
      'dist/server/modules/overtime-workflow/overtime-workflow.controller.js',
      'dist/server/modules/overtime-workflow/overtime-workflow.gateway.js',
      'dist/server/modules/overtime-workflow/overtime-workflow.module.js',
      'dist/server/modules/overtime-workflow/overtime-workflow.rules.js',
      'dist/server/modules/overtime-workflow/overtime-workflow.scheduler.js',
      'dist/server/modules/overtime-workflow/overtime-workflow.service.js',
      'dist/server/modules/overtime-workflow/overtime-workflow.store.js',
      'dist/server/modules/overtime-workflow/overtime-workflow.types.js',
    ]) {
      expect(serverRelativePathsBlock).toContain(`'${path}'`);
    }

    for (const marker of [
      '/api/duty-schedules/overtime-request',
      '加班工时：',
      '加班申请已受理，正在后台同步',
      '加班举证',
      'overtime-evidence',
      '长白班工作日加班仅可选择 09:00 前或 18:00 后',
      '所选加班与本人排班连续值守达到 24 小时，请缩短或调整时段',
    ]) {
      expect(clientBoundaryBlock).toContain(marker);
    }
    expect(clientBoundaryBlock).toMatch(/^\s*'加班申请'\s*$/mu);
    expect(clientBoundaryBlock).not.toContain("'Ctrl+V'");

    expect(source).toContain(
      "scope = @('leave-request', 'overtime-request', 'change-request', 'change-adjustment', 'change-summary-report', 'leave-substitute', 'duty-screenshot', 'emergency-duty', 'weather-warning', 'purchase-inventory', 'purchase-receipt', 'purchase-inbound', 'purchase-active-sync', 'inventory-storage-location', 'inventory-outbound-confirmation', 'inventory-outbound-durable-retry', 'inventory-movement-deletion')",
    );
    expect(source).toContain('POST /api/duty-schedules/overtime-request');
    expect(source).toContain('data/overtime-request-mutations');
    expect(source).toContain('OVERTIME_REQUEST_MUTATION_LEDGER_DIR');
    expect(source).toContain('立即关闭弹窗');
    expect(source).toContain('正在后台同步');
    expect(source).toContain('Ctrl+V');
    expect(source).toContain('选择开始日期后自动将结束日期同步为同一天');
    expect(source).toContain('结束日期不得早于开始日期');
    expect(source).toContain('长白班在法定工作日仅可选择 09:00 前或 18:00 后');
    expect(source).toContain(
      '7×24 排班人员加班与本人排班的连续值守必须小于 24 小时',
    );
    expect(source).toContain('允许不形成 24 小时连班的 4 小时部分加班');
    expect(source).toContain(
      '按请求唯一 ID 和返回的 record ID 精确删除测试记录',
    );
    expect(source).toContain('再次确认查询结果为 0');
  });

  it('documents automatic tiered delivery, reminders, buttons and persistent state configuration', () => {
    const source = readFileSync(scriptPath, 'utf8');
    const deployReadme = readFileSync(deployReadmePath, 'utf8');

    expect(source).toContain('首次识别新预警事件时自动首发');
    expect(source).toContain(
      '一级戒备：普通天气预警群、重要事件群和指定负责人',
    );
    expect(source).toContain('二级/三级戒备：普通天气预警群和指定负责人');
    expect(source).toContain('每 1 分钟强制刷新一次天气预警');
    expect(source).toContain(
      '预警戒备期内未完成时，每 2 小时按楼栋、按未完成检查项逐项催办',
    );
    expect(source).toContain('下载重保检查单');
    expect(source).toContain('提交戒备登记');
    expect(source).toContain(
      'https://vnet.feishu.cn/wiki/Hs4fwlplAijAgskmBnkcEDMvnKc',
    );
    for (const documentation of [source, deployReadme]) {
      expect(documentation).toContain('PUBLIC_BASE_URL');
      expect(documentation).toContain(
        'GET /api/weather-warning/registration/options',
      );
      expect(documentation).toContain('POST /api/weather-warning/registration');
      expect(documentation).toContain('multipart/form-data');
      expect(documentation).toContain('weatherGuardRegistration');
      expect(documentation).toContain('PDF 扫描件');
      expect(documentation).toContain('设施运维经理');
      expect(documentation).toContain('设施运维副经理');
      expect(documentation).toContain(
        'FEISHU_WEATHER_WARNING_MANAGER_SOURCE_URL',
      );
      expect(documentation).toContain(
        'FEISHU_WEATHER_WARNING_MANAGER_APP_TOKEN',
      );
      expect(documentation).toContain(
        'FEISHU_WEATHER_WARNING_MANAGER_TABLE_ID',
      );
      expect(documentation).toContain('2 小时');
      expect(documentation).toContain('删除测试记录后再启用自动化');
      expect(documentation).not.toContain('shrcneofD8Ahc8650YU6hIuPpTe');
    }
    expect(source).toContain('60000（1 分钟）');
    expect(deployReadme).toContain('生产轮询间隔为 1 分钟');
    for (const variable of [
      'FEISHU_WEATHER_WARNING_AUTOMATION_ENABLED',
      'FEISHU_WEATHER_WARNING_CHAT_IDS',
      'FEISHU_WEATHER_WARNING_IMPORTANT_EVENT_CHAT_IDS',
      'FEISHU_WEATHER_WARNING_OWNER_OPEN_ID',
      'FEISHU_WEATHER_WARNING_OWNER_NAME',
      'FEISHU_WEATHER_WARNING_AUTOMATION_STATE_PATH',
      'FEISHU_WEATHER_WARNING_AUTOMATION_STATE_DIR',
      'FEISHU_WEATHER_WARNING_POLL_INTERVAL_MS',
      'FEISHU_WEATHER_WARNING_REMINDER_INTERVAL_MS',
    ]) {
      expect(source).toContain(variable);
    }
    expect(source).toContain('必须指向发布目录外的固定持久目录');
    expect(source).toContain('避免版本升级后丢失去重状态并重复首发');
  });

  it('requires archive, manifest and sidecar integrity while excluding sensitive runtime content', () => {
    expect(existsSync(scriptPath)).toBe(true);

    const source = readFileSync(scriptPath, 'utf8');

    expect(source).toContain('hotfix-manifest.json');
    expect(source).toContain('CreateFromDirectory');
    expect(source).toContain('ZipFile]::OpenRead');
    expect(source).toContain("$_.FullName.Replace('\\', '/')");
    expect(source).toContain('Get-FileHash');
    expect(source).toContain('.sha256.txt');
    expect(source).toContain("'.env'");
    expect(source).toContain("'.env.local'");
    expect(source).toContain("'.map'");
    expect(source).toContain("'.pem'");
    expect(source).toContain("'.key'");
    expect(source).toContain("'.pfx'");
    expect(source).toContain("'.p12'");
    expect(source).toContain("'.jks'");
    expect(source).toContain("'.keystore'");
    expect(source).toContain("'.ppk'");
    expect(source).toContain("'.sqlite'");
    expect(source).toContain("'.log'");
    expect(source).toContain("'.ts'");
    expect(source).toContain("'.tsx'");
    expect(source).toContain("'credentials'");
    const blockedFileNamesBlock = source.slice(
      source.indexOf('$blockedFileNames = @('),
      source.indexOf('$blockedExtensions = @('),
    );
    expect(blockedFileNamesBlock).toContain("'nantong-schedule.private.env'");
    expect(source).toContain("@('data', 'logs', 'node_modules', 'state')");
    expect(source).not.toContain("'package.json'");
    expect(source).not.toContain("'package-lock.json'");
    expect(source).toContain('Assert-NoReparsePointPath');
    expect(source).toContain('Assert-ClientHotfixBoundary');
    expect(source).toContain('Assert-NoSensitiveContent');
    expect(source).toContain('$blockedSensitiveContentPatterns');
    expect(source).toContain(
      '$allowedRuntimeSensitiveIdentifierFingerprintsByPath',
    );
    const copyRequiredFileBlock =
      source.match(/function Copy-RequiredFile[\s\S]*?\r?\n\}/u)?.[0] ?? '';
    expect(copyRequiredFileBlock).toContain('Assert-NoSensitiveContent');
    expect(source).toContain('(?:ou|oc)_');
    expect(source).toContain('PRIVATE KEY');
    expect(source).toContain('[System.Text.UTF8Encoding]::new($false)');
    expect(source).not.toMatch(/\b(?:ou|oc)_[A-Za-z0-9_-]{16,}\b/u);
  });

  it('rejects a client build after the overtime-specific clipboard marker is removed', () => {
    const testRoot = mkdtempSync(
      join(tmpdir(), 'nantong-hotfix-overtime-marker-'),
    );
    const clientRoot = createMinimalClientFixture(testRoot);
    const mainPath = join(clientRoot, 'main.js');
    writeFileSync(
      mainPath,
      readFileSync(mainPath, 'utf8').replace(', "overtime-evidence"', ''),
      'utf8',
    );

    try {
      expect(readFileSync(mainPath, 'utf8')).not.toContain('overtime-evidence');
      expect(() =>
        runValidationHarness(
          scriptPath,
          testRoot,
          `Assert-ClientHotfixBoundary -Root ${powershellStringLiteral(clientRoot)}`,
        ),
      ).toThrow(/required overtime marker 'overtime-evidence'/iu);
    } finally {
      rmSync(testRoot, { recursive: true, force: true });
    }
  });

  it('rejects a client build when only the longer overtime acceptance copy contains the product name', () => {
    const testRoot = mkdtempSync(
      join(tmpdir(), 'nantong-hotfix-overtime-product-name-'),
    );
    const clientRoot = createMinimalClientFixture(testRoot);
    const mainPath = join(clientRoot, 'main.js');
    writeFileSync(
      mainPath,
      readFileSync(mainPath, 'utf8').replace(', "加班申请"', ''),
      'utf8',
    );

    try {
      expect(readFileSync(mainPath, 'utf8')).toContain(
        '加班申请已受理，正在后台同步',
      );
      expect(readFileSync(mainPath, 'utf8')).not.toMatch(/["']加班申请["']/u);
      expect(() =>
        runValidationHarness(
          scriptPath,
          testRoot,
          `Assert-ClientHotfixBoundary -Root ${powershellStringLiteral(clientRoot)}`,
        ),
      ).toThrow(/required overtime product name marker '加班申请'/iu);
    } finally {
      rmSync(testRoot, { recursive: true, force: true });
    }
  });

  it('rejects a client build after a change-adjustment instant-sync marker is removed', () => {
    const testRoot = mkdtempSync(
      join(tmpdir(), 'nantong-hotfix-change-marker-'),
    );
    const clientRoot = createMinimalClientFixture(testRoot);
    const mainPath = join(clientRoot, 'main.js');
    writeFileSync(
      mainPath,
      readFileSync(mainPath, 'utf8').replace(', "变更调整正在后台同步"', ''),
      'utf8',
    );

    try {
      expect(readFileSync(mainPath, 'utf8')).not.toContain(
        '变更调整正在后台同步',
      );
      expect(() =>
        runValidationHarness(
          scriptPath,
          testRoot,
          `Assert-ClientHotfixBoundary -Root ${powershellStringLiteral(clientRoot)}`,
        ),
      ).toThrow(/required change marker '变更调整正在后台同步'/iu);
    } finally {
      rmSync(testRoot, { recursive: true, force: true });
    }
  });

  it('rejects a client build after the optimistic movement-deletion marker is removed', () => {
    const testRoot = mkdtempSync(
      join(tmpdir(), 'nantong-hotfix-movement-deletion-marker-'),
    );
    const clientRoot = createMinimalClientFixture(testRoot);
    const mainPath = join(clientRoot, 'main.js');
    writeFileSync(
      mainPath,
      readFileSync(mainPath, 'utf8').replace(
        '记录已从当前清单隐藏，正在后台同步删除',
        'removed-movement-deletion-marker',
      ),
      'utf8',
    );

    try {
      expect(readFileSync(mainPath, 'utf8')).not.toContain(
        '记录已从当前清单隐藏，正在后台同步删除',
      );
      expect(() =>
        runValidationHarness(
          scriptPath,
          testRoot,
          `Assert-ClientHotfixBoundary -Root ${powershellStringLiteral(clientRoot)}`,
        ),
      ).toThrow(/inventory movement-deletion marker/iu);
    } finally {
      rmSync(testRoot, { recursive: true, force: true });
    }
  });

  it('rejects a purchase receipt bundle that conflates disabled and loading state', () => {
    const testRoot = mkdtempSync(
      join(tmpdir(), 'nantong-hotfix-purchase-state-'),
    );
    const clientRoot = createMinimalClientFixture(testRoot);
    const mainPath = join(clientRoot, 'main.js');
    writeFileSync(
      mainPath,
      readFileSync(mainPath, 'utf8').replace(
        'return{disabled:d||l,showSpinner:l}',
        'return{disabled:d||l,showSpinner:d}',
      ),
      'utf8',
    );

    try {
      expect(() =>
        runValidationHarness(
          scriptPath,
          testRoot,
          `Assert-ClientHotfixBoundary -Root ${powershellStringLiteral(clientRoot)}`,
        ),
      ).toThrow(/purchase receipt action-state/iu);
    } finally {
      rmSync(testRoot, { recursive: true, force: true });
    }
  });

  it('rejects an incomplete client root even when its main bundle has all markers', () => {
    const testRoot = mkdtempSync(
      join(tmpdir(), 'nantong-hotfix-client-assets-'),
    );
    const clientRoot = createMinimalClientFixture(testRoot);
    rmSync(join(clientRoot, 'routes.json'));

    try {
      expect(() =>
        runValidationHarness(
          scriptPath,
          testRoot,
          `Assert-ClientHotfixBoundary -Root ${powershellStringLiteral(clientRoot)}`,
        ),
      ).toThrow(/missing required client asset.*routes\.json/iu);
    } finally {
      rmSync(testRoot, { recursive: true, force: true });
    }
  });

  it('rejects an index page that does not load the validated main bundle', () => {
    const testRoot = mkdtempSync(
      join(tmpdir(), 'nantong-hotfix-client-index-'),
    );
    const clientRoot = createMinimalClientFixture(testRoot);
    writeFileSync(
      join(clientRoot, 'index.html'),
      '<!doctype html><div id="root"></div>',
      'utf8',
    );

    try {
      expect(() =>
        runValidationHarness(
          scriptPath,
          testRoot,
          `Assert-ClientHotfixBoundary -Root ${powershellStringLiteral(clientRoot)}`,
        ),
      ).toThrow(/index\.html.*main\.js/iu);
    } finally {
      rmSync(testRoot, { recursive: true, force: true });
    }
  });

  it.each([
    { attribute: 'src', value: '/assets/main.js' },
    { attribute: 'src', value: 'https://cdn.invalid/main.js' },
    { attribute: 'data-src', value: '/main.js' },
    { attribute: 'data-x', value: " src='/main.js'" },
  ])(
    'rejects an index page that does not use the exact root main script: $attribute=$value',
    ({ attribute, value }) => {
      const testRoot = mkdtempSync(
        join(tmpdir(), 'nantong-hotfix-client-wrong-entry-'),
      );
      const clientRoot = createMinimalClientFixture(testRoot);
      writeFileSync(
        join(clientRoot, 'index.html'),
        `<!doctype html><div id="root"></div><script defer ${attribute}="${value}"></script>`,
        'utf8',
      );

      try {
        expect(() =>
          runValidationHarness(
            scriptPath,
            testRoot,
            `Assert-ClientHotfixBoundary -Root ${powershellStringLiteral(clientRoot)}`,
          ),
        ).toThrow(/index\.html.*main\.js/iu);
      } finally {
        rmSync(testRoot, { recursive: true, force: true });
      }
    },
  );

  it.each([
    '<!doctype html><script src="/missing.js" src="/main.js"></script>',
    '<!doctype html><!-- <script src="/main.js"></script> --><script src="/missing.js"></script>',
    '<!doctype html><script>const fake = \'<script src="/main.js">\';</script><script src="/missing.js"></script>',
    '<!doctype html><div data-x="<script src=\'/main.js\'>"></div><script src="/missing.js"></script>',
    '<!doctype html>< script src="/main.js"></script><script src="/missing.js"></script>',
    '<!doctype html><template><script src="/main.js"></script></template><script src="/missing.js"></script>',
    '<!doctype html><textarea><script src="/main.js"></script></textarea><script src="/missing.js"></script>',
    '<!doctype html><noscript><script src="/main.js"></script></noscript><script src="/missing.js"></script>',
  ])('rejects a non-executable root main marker in index HTML', (html) => {
    const testRoot = mkdtempSync(
      join(tmpdir(), 'nantong-hotfix-client-fake-entry-'),
    );
    const clientRoot = createMinimalClientFixture(testRoot);
    writeFileSync(join(clientRoot, 'index.html'), html, 'utf8');

    try {
      expect(() =>
        runValidationHarness(
          scriptPath,
          testRoot,
          `Assert-ClientHotfixBoundary -Root ${powershellStringLiteral(clientRoot)}`,
        ),
      ).toThrow(/index\.html.*main\.js/iu);
    } finally {
      rmSync(testRoot, { recursive: true, force: true });
    }
  });

  it('rejects marker-bearing orphan chunks when the loaded main bundle is stale', () => {
    const testRoot = mkdtempSync(
      join(tmpdir(), 'nantong-hotfix-client-orphan-'),
    );
    const clientRoot = createMinimalClientFixture(testRoot);
    const mainPath = join(clientRoot, 'main.js');
    writeFileSync(
      join(clientRoot, 'chunks', 'orphan.js'),
      readFileSync(mainPath, 'utf8'),
      'utf8',
    );
    writeFileSync(mainPath, 'console.log("stale entry");', 'utf8');

    try {
      expect(() =>
        runValidationHarness(
          scriptPath,
          testRoot,
          `Assert-ClientHotfixBoundary -Root ${powershellStringLiteral(clientRoot)}`,
        ),
      ).toThrow(/main bundle.*marker/iu);
    } finally {
      rmSync(testRoot, { recursive: true, force: true });
    }
  });

  it('accepts inventory storage-location UI markers in one reachable lazy chunk', () => {
    const testRoot = mkdtempSync(
      join(tmpdir(), 'nantong-hotfix-client-reachable-chunk-'),
    );
    const clientRoot = createSplitInventoryStorageLocationFixture(testRoot);

    try {
      expect(() =>
        runValidationHarness(
          scriptPath,
          testRoot,
          `Assert-ClientHotfixBoundary -Root ${powershellStringLiteral(clientRoot)}`,
        ),
      ).not.toThrow();
    } finally {
      rmSync(testRoot, { recursive: true, force: true });
    }
  });

  it('rejects an inventory storage-location marker chunk without a dynamic load call', () => {
    const testRoot = mkdtempSync(
      join(tmpdir(), 'nantong-hotfix-client-unloaded-chunk-'),
    );
    const clientRoot = createSplitInventoryStorageLocationFixture(testRoot, {
      includeDynamicLoad: false,
    });

    try {
      expect(() =>
        runValidationHarness(
          scriptPath,
          testRoot,
          `Assert-ClientHotfixBoundary -Root ${powershellStringLiteral(clientRoot)}`,
        ),
      ).toThrow(/reachable.*storage-location|storage-location.*reachable/iu);
    } finally {
      rmSync(testRoot, { recursive: true, force: true });
    }
  });

  it('rejects an inventory storage-location marker chunk whose hash mapping is stale', () => {
    const testRoot = mkdtempSync(
      join(tmpdir(), 'nantong-hotfix-client-stale-chunk-hash-'),
    );
    const clientRoot = createSplitInventoryStorageLocationFixture(testRoot, {
      mappedHash: '67d7ddcf',
      chunkHash: 'deadbeef',
    });

    try {
      expect(() =>
        runValidationHarness(
          scriptPath,
          testRoot,
          `Assert-ClientHotfixBoundary -Root ${powershellStringLiteral(clientRoot)}`,
        ),
      ).toThrow(/reachable.*storage-location|storage-location.*reachable/iu);
    } finally {
      rmSync(testRoot, { recursive: true, force: true });
    }
  });

  it('rejects a reachable inventory storage-location chunk missing one UI marker', () => {
    const testRoot = mkdtempSync(
      join(tmpdir(), 'nantong-hotfix-client-incomplete-chunk-'),
    );
    const clientRoot = createSplitInventoryStorageLocationFixture(testRoot, {
      missingUiMarker: 'locationRecordId',
    });

    try {
      expect(() =>
        runValidationHarness(
          scriptPath,
          testRoot,
          `Assert-ClientHotfixBoundary -Root ${powershellStringLiteral(clientRoot)}`,
        ),
      ).toThrow(/storage-location.*locationRecordId/iu);
    } finally {
      rmSync(testRoot, { recursive: true, force: true });
    }
  });

  it('scans packaged operational mjs scripts for sensitive content', () => {
    const testRoot = mkdtempSync(
      join(tmpdir(), 'nantong-hotfix-sensitive-mjs-'),
    );
    const sourcePath = join(testRoot, 'unsafe.mjs');
    const destinationPath = join(testRoot, 'destination.mjs');
    writeFileSync(sourcePath, 'FEISHU_APP_SECRET=synthetic-secret\n', 'utf8');

    try {
      expect(() =>
        runValidationHarness(
          scriptPath,
          testRoot,
          [
            'Copy-RequiredFile `',
            `  -Source ${powershellStringLiteral(sourcePath)} \``,
            `  -Destination ${powershellStringLiteral(destinationPath)} \``,
            `  -RelativePath 'scripts/unsafe.mjs'`,
          ].join('\r\n'),
        ),
      ).toThrow(/sensitive|blocked/iu);
    } finally {
      rmSync(testRoot, { recursive: true, force: true });
    }
  });

  it('scans packaged PowerShell scripts for hard-coded COS credentials', () => {
    const testRoot = mkdtempSync(
      join(tmpdir(), 'nantong-hotfix-sensitive-ps1-'),
    );
    const sourcePath = join(testRoot, 'unsafe.ps1');
    const destinationPath = join(testRoot, 'destination.ps1');
    writeFileSync(
      sourcePath,
      "$env:TENCENTCLOUD_SECRET_KEY = 'synthetic-secret'\n",
      'utf8',
    );

    try {
      expect(() =>
        runValidationHarness(
          scriptPath,
          testRoot,
          [
            'Copy-RequiredFile `',
            `  -Source ${powershellStringLiteral(sourcePath)} \``,
            `  -Destination ${powershellStringLiteral(destinationPath)} \``,
            `  -RelativePath 'deploy/unsafe.ps1'`,
          ].join('\r\n'),
        ),
      ).toThrow(/sensitive|blocked/iu);
    } finally {
      rmSync(testRoot, { recursive: true, force: true });
    }
  });

  it('accepts the exact migration and real-self-test operational scripts', () => {
    const testRoot = mkdtempSync(
      join(tmpdir(), 'nantong-hotfix-change-tooling-scan-'),
    );
    const paths = [
      'deploy/configure-change-attachment-storage.ps1',
      'scripts/ensure-change-adjustment-fields.mjs',
      'scripts/self-test-change-adjustment.mjs',
      'scripts/ensure-change-summary-report-fields.mjs',
      'scripts/self-test-change-summary-report.mjs',
    ];
    const command = paths
      .map(
        (relativePath) =>
          `Assert-NoSensitiveContent -Path ${powershellStringLiteral(join(process.cwd(), ...relativePath.split('/')))} -RelativePath ${powershellStringLiteral(relativePath)}`,
      )
      .join('\r\n');

    try {
      expect(() =>
        runValidationHarness(scriptPath, testRoot, command),
      ).not.toThrow();
    } finally {
      rmSync(testRoot, { recursive: true, force: true });
    }
  });

  it('accepts only the audited recipient fingerprints in the current server runtime', () => {
    const testRoot = mkdtempSync(
      join(tmpdir(), 'nantong-hotfix-runtime-audit-'),
    );
    const runtimePaths = [
      'dist/server/modules/bitable-sync/certificate-dashboard-notification.service.js',
      'dist/server/modules/duty-schedule/duty-schedule.service.js',
      'dist/server/modules/duty-schedule/duty-screenshot.service.js',
      'dist/server/modules/duty-schedule/typhoon-warning-alert.js',
      'dist/server/modules/inventory-management/inventory-workflow.rules.js',
    ];
    const command = runtimePaths
      .map(
        (relativePath) =>
          `Assert-NoSensitiveContent -Path ${powershellStringLiteral(join(process.cwd(), ...relativePath.split('/')))} -RelativePath ${powershellStringLiteral(relativePath)}`,
      )
      .join('\r\n');

    try {
      expect(() =>
        runValidationHarness(scriptPath, testRoot, command),
      ).not.toThrow();
    } finally {
      rmSync(testRoot, { recursive: true, force: true });
    }
  });

  it.each([
    'dist/server/modules/example/new-sensitive-runtime.js',
    'dist/server/modules/duty-schedule/duty-schedule.service.js',
    'dist/server/modules/inventory-management/inventory-workflow.rules.js',
  ])(
    'rejects a newly injected recipient identifier while copying %s',
    (relativePath) => {
      const testRoot = mkdtempSync(
        join(tmpdir(), 'nantong-hotfix-runtime-injection-'),
      );
      const sourcePath = join(testRoot, 'source.js');
      const destinationPath = join(testRoot, 'destination.js');
      const syntheticRecipientId = `o${'c'}_${'a'.repeat(24)}`;
      writeFileSync(
        sourcePath,
        `console.log(${JSON.stringify(syntheticRecipientId)});`,
        'utf8',
      );

      try {
        expect(() =>
          runValidationHarness(
            scriptPath,
            testRoot,
            [
              'Copy-RequiredFile `',
              `  -Source ${powershellStringLiteral(sourcePath)} \``,
              `  -Destination ${powershellStringLiteral(destinationPath)} \``,
              `  -RelativePath ${powershellStringLiteral(relativePath)}`,
            ].join('\r\n'),
          ),
        ).toThrow(/sensitive|recipient/iu);
      } finally {
        rmSync(testRoot, { recursive: true, force: true });
      }
    },
  );

  it('builds the client in isolation from the current verified workspace source', () => {
    expect(existsSync(latestClientBuildScriptPath)).toBe(true);
    expect(existsSync(hotfixClientRspackConfigPath)).toBe(true);

    const source = readFileSync(latestClientBuildScriptPath, 'utf8');
    expect(source).not.toContain('3730.293a10f8.js.map');
    expect(source).toContain("purchaseSource: 'current-workspace'");
    expect(source).toContain('采购形式');
    expect(source).toContain('单一采购');
    expect(source).toContain('单一原因');
    expect(source).toContain('确认到货签收');
    expect(source).toContain('aria-busy');
    expect(source).toContain('提交中');
    expect(source).toContain('预警与戒备信息');
    expect(source).toContain("HOTFIX_PURCHASE_SNAPSHOT_ROOT: ''");
    const rspackSource = readFileSync(hotfixClientRspackConfigPath, 'utf8');
    expect(rspackSource).toContain("path.resolve(__dirname, 'node_modules')");
    expect(rspackSource).toContain('createFullstackRspackConfig');
    expect(rspackSource).toContain('devtool: false');
    expect(rspackSource).not.toContain('NormalModuleReplacementPlugin');

    const primaryBuildMetadata = {
      client: snapshotTreeMetadata(join(process.cwd(), 'dist', 'client')),
      sourceMaps: snapshotTreeMetadata(
        join(process.cwd(), 'dist', 'sourcemaps'),
      ),
      sharedStatic: snapshotTreeMetadata(
        join(process.cwd(), 'dist', 'shared', 'static'),
      ),
    };
    const builtClientRoot = getLatestClientRoot();
    expect({
      client: snapshotTreeMetadata(join(process.cwd(), 'dist', 'client')),
      sourceMaps: snapshotTreeMetadata(
        join(process.cwd(), 'dist', 'sourcemaps'),
      ),
      sharedStatic: snapshotTreeMetadata(
        join(process.cwd(), 'dist', 'shared', 'static'),
      ),
    }).toEqual(primaryBuildMetadata);
    expect(existsSync(join(builtClientRoot, 'index.html'))).toBe(true);
    expect(existsSync(join(builtClientRoot, 'polyfills.js'))).toBe(true);
    expect(existsSync(join(builtClientRoot, 'routes.json'))).toBe(true);
    expect(
      listFiles(builtClientRoot).filter((path) => extname(path) === '.map'),
    ).toHaveLength(0);
    const clientJavaScript = listFiles(builtClientRoot)
      .filter((path) => extname(path) === '.js')
      .map((path) => readFileSync(join(builtClientRoot, path), 'utf8'))
      .join('\n');
    expect(clientJavaScript).toContain('休假工时');
    expect(clientJavaScript).toContain('发送今日截图');
    expect(clientJavaScript).toContain('替班人员');
    expect(clientJavaScript).toContain('预警与戒备信息');
    expect(clientJavaScript).toContain('/api/duty-schedules/overtime-request');
    expect(clientJavaScript).toContain('加班工时：');
    expect(clientJavaScript).toContain('加班申请已受理，正在后台同步');
    expect(clientJavaScript).toContain('加班举证');
    expect(clientJavaScript).toContain('/api/duty-schedules/change-request');
    expect(clientJavaScript).toContain('/api/duty-schedules/change-adjustment');
    expect(clientJavaScript).toContain('变更调整');
    expect(clientJavaScript).toContain('请从人员名单中选择提交人');
    expect(clientJavaScript).toContain('单个不超过 200 MB');
    expect(clientJavaScript).toContain('Ctrl+V');
    expect(clientJavaScript).not.toContain('预警卡片测试');
    expect(clientJavaScript).toContain('采购形式');
    expect(clientJavaScript).toContain('单一采购');
    expect(clientJavaScript).toContain('单一原因');
    expect(clientJavaScript).toContain('确认到货签收');
    expect(clientJavaScript).toContain('aria-busy');
    expect(clientJavaScript).toContain('提交中');
  });

  it('finds the inventory storage-location UI in exactly one reachable production bundle', () => {
    const builtClientRoot = getLatestClientRoot();
    const mainJavaScript = readFileSync(
      join(builtClientRoot, 'main.js'),
      'utf8',
    );
    for (const marker of inventoryStorageLocationRootMarkers) {
      expect(mainJavaScript).toContain(marker);
    }

    const storageLocationUiBundles = listFiles(builtClientRoot).filter(
      (path) => {
        if (extname(path) !== '.js') return false;
        const content = readFileSync(join(builtClientRoot, path), 'utf8');
        return inventoryStorageLocationUiMarkers.every((marker) =>
          content.includes(marker),
        );
      },
    );
    expect(storageLocationUiBundles).toHaveLength(1);

    const storageLocationUiBundle = storageLocationUiBundles[0];
    if (storageLocationUiBundle !== 'main.js') {
      const chunkMatch = /^chunks\/(?<id>\d+)\.(?<hash>[a-f0-9]+)\.js$/iu.exec(
        storageLocationUiBundle,
      );
      expect(chunkMatch).not.toBeNull();
      expect(mainJavaScript).toContain(`.e("${chunkMatch?.groups?.id}")`);
      expect(mainJavaScript).toContain(
        `${chunkMatch?.groups?.id}:"${chunkMatch?.groups?.hash}"`,
      );
    }
  });

  it('is accepted by the Windows PowerShell parser before it is used for delivery', () => {
    expect(existsSync(scriptPath)).toBe(true);

    const escapedScriptPath = scriptPath.replace(/'/g, "''");
    const parseCommand = [
      '$errors = $null',
      "[void][System.Management.Automation.Language.Parser]::ParseFile('" +
        escapedScriptPath +
        "', [ref]$null, [ref]$errors)",
      'if ($errors.Count -gt 0) { $errors | ForEach-Object { $_.Message }; exit 1 }',
    ].join('; ');

    expect(() =>
      execFileSync('powershell.exe', ['-NoProfile', '-Command', parseCommand], {
        encoding: 'utf8',
      }),
    ).not.toThrow();
  });

  it('independently verifies ZIP entries, manifest hashes, bytes and SHA sidecar', () => {
    expect(existsSync(scriptPath)).toBe(true);
    const testRoot = mkdtempSync(join(tmpdir(), 'nantong-hotfix-package-'));
    const outputRoot = join(testRoot, 'output');
    const clientRoot = getLatestClientRoot();
    mkdirSync(outputRoot);

    try {
      runPackage(scriptPath, outputRoot, clientRoot);

      const zipName = readdirSync(outputRoot).find((name) =>
        name.endsWith('.zip'),
      );
      expect(zipName).toBeDefined();
      const zipPath = join(outputRoot, zipName!);
      const sidecarPath = `${zipPath}.sha256.txt`;
      const sidecar = readFileSync(sidecarPath, 'ascii').trim();
      expect(sidecar).toBe(`${sha256(zipPath).toUpperCase()}  ${zipName}`);

      const extractedRoot = join(testRoot, 'extracted');
      const escapedZipPath = zipPath.replace(/'/gu, "''");
      const escapedExtractedRoot = extractedRoot.replace(/'/gu, "''");
      execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-Command',
          `Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::ExtractToDirectory('${escapedZipPath}', '${escapedExtractedRoot}')`,
        ],
        { encoding: 'utf8' },
      );

      const manifest = JSON.parse(
        readFileSync(join(extractedRoot, 'hotfix-manifest.json'), 'utf8'),
      ) as HotfixManifest;
      expect(manifest.scope).toEqual([
        'leave-request',
        'overtime-request',
        'change-request',
        'change-adjustment',
        'change-summary-report',
        'leave-substitute',
        'duty-screenshot',
        'emergency-duty',
        'weather-warning',
        'purchase-inventory',
        'purchase-receipt',
        'purchase-inbound',
        'purchase-active-sync',
        'inventory-storage-location',
        'inventory-outbound-confirmation',
        'inventory-outbound-durable-retry',
        'inventory-movement-deletion',
        'change-drill-report',
        'unified-access-reauthentication',
      ]);
      const manifestPaths = manifest.files.map(({ path }) => path).sort();
      expect(listFiles(extractedRoot)).toEqual(
        [...manifestPaths, 'hotfix-manifest.json'].sort(),
      );

      for (const entry of manifest.files) {
        const extractedPath = join(extractedRoot, ...entry.path.split('/'));
        expect(statSync(extractedPath).size).toBe(entry.bytes);
        expect(sha256(extractedPath)).toBe(entry.sha256);
      }

      const packagedPaths = new Set(manifest.files.map(({ path }) => path));

      const readPackagedRuntime = (relativePath: string): string =>
        readFileSync(join(extractedRoot, ...relativePath.split('/')), 'utf8');
      const controllerRuntime = readPackagedRuntime(
        'dist/server/modules/weather-warning/weather-warning.controller.js',
      );
      const gatewayRuntime = readPackagedRuntime(
        'dist/server/modules/weather-warning/weather-warning-registration.gateway.js',
      );
      const registrationRuntime = readPackagedRuntime(
        'dist/server/modules/weather-warning/weather-warning-registration.service.js',
      );
      const checkScopeRuntime = readPackagedRuntime(
        'dist/server/modules/weather-warning/weather-warning-check-scope.js',
      );
      const activePersonnelRuntime = readPackagedRuntime(
        'dist/server/modules/bitable-sync/active-personnel-directory.js',
      );
      const bitableDirectReadRuntime = readPackagedRuntime(
        'dist/server/common/feishu/bitable-direct-read.js',
      );
      const changeRequestSubmitterDirectoryRuntime = readPackagedRuntime(
        'dist/server/modules/bitable-sync/change-request-submitter-directory.js',
      );
      const cardRuntime = readPackagedRuntime(
        'dist/server/modules/weather-warning/weather-warning-card.js',
      );
      const notificationRuntime = readPackagedRuntime(
        'dist/server/modules/weather-warning/weather-warning-notification.service.js',
      );
      const automationRuntime = readPackagedRuntime(
        'dist/server/modules/weather-warning/weather-warning-automation.service.js',
      );
      const simulationRuntime = readPackagedRuntime(
        'dist/server/modules/weather-warning/weather-warning-test-simulation.js',
      );
      const dutyScheduleControllerRuntime = readPackagedRuntime(
        'dist/server/modules/duty-schedule/duty-schedule.controller.js',
      );
      const dutyScheduleServiceRuntime = readPackagedRuntime(
        'dist/server/modules/duty-schedule/duty-schedule.service.js',
      );
      const dutyScheduleModuleRuntime = readPackagedRuntime(
        'dist/server/modules/duty-schedule/duty-schedule.module.js',
      );
      const emergencyDutyControllerRuntime = readPackagedRuntime(
        'dist/server/modules/duty-schedule/emergency-duty.controller.js',
      );
      const emergencyDutyServiceRuntime = readPackagedRuntime(
        'dist/server/modules/duty-schedule/emergency-duty.service.js',
      );
      const changeAttachmentStorageRuntime = readPackagedRuntime(
        'dist/server/modules/duty-schedule/change-attachment-storage.service.js',
      );
      const changeAttachmentTempDirectoryRuntime = readPackagedRuntime(
        'dist/server/modules/duty-schedule/change-attachment-temp-directory.js',
      );
      const dutyStaffNameRuntime = readPackagedRuntime(
        'dist/shared/duty-staff-name.js',
      );
      const changeSelfTestScript = readPackagedRuntime(
        'scripts/self-test-change-adjustment.mjs',
      );

      expect(controllerRuntime).toContain('application/pdf');
      expect(controllerRuntime).toContain('GuestSubmittable');
      expect(gatewayRuntime).toContain('PDF_SIGNATURE');
      expect(gatewayRuntime).toContain('listManagerCandidateRecords');
      expect(gatewayRuntime).toContain(
        'FEISHU_WEATHER_WARNING_MANAGER_TABLE_ID',
      );
      expect(gatewayRuntime).not.toContain('FEISHU_ORG_APP_TOKEN');
      expect(gatewayRuntime).not.toContain('FEISHU_ORG_TABLE_ID');
      expect(gatewayRuntime).toContain('deleteRecordAndConfirmAbsent');
      expect(registrationRuntime).toContain('buildCachedCandidateCatalog');
      expect(registrationRuntime).not.toContain('buildManagerCandidateCatalog');
      expect(registrationRuntime).toContain(
        'getCachedActivePersonnelDirectory',
      );
      expect(registrationRuntime).toContain('managerOpenIds');
      expect(registrationRuntime).toContain('deleteRecordAndConfirmAbsent');
      expect(checkScopeRuntime).toContain('resolveWeatherWarningCheckScope');
      expect(activePersonnelRuntime).toContain('buildActivePersonnelDirectory');
      expect(bitableDirectReadRuntime).toContain(
        'Math.abs(field) < 100_000_000_000 ? field * 1000 : field',
      );
      expect(bitableDirectReadRuntime).toContain('automatic_fields');
      expect(bitableDirectReadRuntime).toContain('automaticFields');
      expect(changeRequestSubmitterDirectoryRuntime).toContain(
        'resolveChangeRequestSubmitterCandidate',
      );
      expect(changeRequestSubmitterDirectoryRuntime).toContain(
        'listEligibleChangeRequestSubmitterNames',
      );
      expect(cardRuntime).toContain('楼栋进度');
      expect(cardRuntime).toContain('normalizeTemperatureMetric');
      expect(cardRuntime).toContain('normalizeHumidityMetric');
      expect(cardRuntime).toContain('${numeric}%');
      expect(cardRuntime).toContain('℃');
      expect(cardRuntime).not.toContain('仅供关注');
      expect(cardRuntime).not.toContain('规则：重保类型对应表');
      expect(cardRuntime).not.toContain('状态：');
      expect(notificationRuntime).toContain('sendPersonalTestCard');
      expect(notificationRuntime).toContain('runClientMutationId');
      expect(automationRuntime).toContain('首次预警继续发送，本轮催办将跳过');
      expect(simulationRuntime).toContain(
        'WEATHER_WARNING_TEST_SIMULATION_SECRET',
      );
      expect(dutyScheduleControllerRuntime).toContain(
        'ChangeAttachmentUploadAdmissionInterceptor',
      );
      expect(dutyScheduleControllerRuntime).toContain(
        'CHANGE_ATTACHMENT_ROUTE_UPLOAD_CONCURRENCY',
      );
      expect(dutyScheduleControllerRuntime).toContain('parts: 3');
      expect(dutyScheduleControllerRuntime).toContain(
        'duty-schedules/change-request',
      );
      expect(dutyScheduleControllerRuntime).toContain(
        'CHANGE_ATTACHMENT_MAX_BYTES',
      );
      expect(dutyScheduleControllerRuntime).toContain('parts: 6');
      expect(dutyScheduleControllerRuntime).toContain(
        'duty-schedules/change-adjustment/self-test/cleanup-bound-attachment',
      );
      expect(dutyScheduleControllerRuntime).toContain(
        'x-change-self-test-cleanup-proof',
      );
      expect(dutyScheduleServiceRuntime).toContain(
        'deleteBoundForTrustedSelfTest',
      );
      expect(dutyScheduleModuleRuntime).toContain('EmergencyDutyController');
      expect(dutyScheduleModuleRuntime).toContain('EmergencyDutyService');
      expect(emergencyDutyControllerRuntime).toContain(
        'EmergencyDutyController',
      );
      expect(emergencyDutyServiceRuntime).toContain('EmergencyDutyService');
      expect(emergencyDutyServiceRuntime).toContain('unknown-result');
      expect(emergencyDutyServiceRuntime).toContain('definitely-not-written');
      expect(changeAttachmentStorageRuntime).toContain(
        'deleteBoundForTrustedSelfTest',
      );
      expect(changeAttachmentTempDirectoryRuntime).toContain(
        'prepareChangeAttachmentTempDirectory',
      );
      expect(changeAttachmentTempDirectoryRuntime).toContain(
        'removeExactChangeAttachmentTempFile',
      );
      expect(dutyStaffNameRuntime).toContain('normalizeDutyStaffDisplayName');
      expect(changeSelfTestScript).toContain(
        'createChangeSelfTestCleanupProof',
      );

      expect(packagedPaths.has('dist/shared/change-request.js')).toBe(true);
      expect(packagedPaths.has('dist/shared/change-adjustment.js')).toBe(true);
      expect(packagedPaths.has('dist/shared/duty-staff-name.js')).toBe(true);
      expect(packagedPaths.has('dist/shared/emergency-duty.interface.js')).toBe(
        true,
      );
      for (const path of [
        'dist/server/common/feishu/bitable-direct-read.js',
        'dist/server/modules/bitable-sync/change-request-submitter-directory.js',
        'dist/server/modules/duty-schedule/change-request-document-validator.js',
        'dist/server/modules/duty-schedule/change-attachment-upload.js',
        'dist/server/modules/duty-schedule/change-attachment-storage.service.js',
        'dist/server/modules/duty-schedule/change-attachment-temp-directory.js',
        'dist/server/modules/duty-schedule/change-adjustment.service.js',
        'dist/server/modules/duty-schedule/change-adjustment-record.js',
        'scripts/ensure-change-adjustment-fields.mjs',
        'scripts/self-test-change-adjustment.mjs',
        'deploy/configure-change-attachment-storage.ps1',
      ]) {
        expect(packagedPaths.has(path)).toBe(true);
      }
      expect(
        packagedPaths.has(
          'dist/server/modules/weather-warning/weather-warning-test-simulation.js',
        ),
      ).toBe(true);
      expect(packagedPaths.has('dist/shared/overtime-request-impact.js')).toBe(
        true,
      );
      expect(
        packagedPaths.has('dist/server/common/access/unified-access.guard.js'),
      ).toBe(true);
      expect(
        packagedPaths.has('dist/server/common/filters/exception.filter.js'),
      ).toBe(true);
      expect(
        packagedPaths.has(
          'dist/server/common/interfaces/api_response.interface.js',
        ),
      ).toBe(true);
      expect(
        packagedPaths.has(
          'dist/server/modules/duty-schedule/duty-schedule.controller.js',
        ),
      ).toBe(true);
      expect(
        packagedPaths.has(
          'dist/server/modules/duty-schedule/duty-schedule.service.js',
        ),
      ).toBe(true);
      expect(
        packagedPaths.has(
          'dist/server/modules/duty-schedule/emergency-duty.controller.js',
        ),
      ).toBe(true);
      expect(
        packagedPaths.has(
          'dist/server/modules/duty-schedule/emergency-duty.service.js',
        ),
      ).toBe(true);
      expect(
        packagedPaths.has(
          'dist/server/common/access/unified-access.service.js',
        ),
      ).toBe(true);
      expect(
        packagedPaths.has('dist/shared/construction-manual-review-policy.js'),
      ).toBe(true);
      expect(
        packagedPaths.has(
          'dist/server/modules/duty-schedule/monthly-schedule-screenshot-access.js',
        ),
      ).toBe(true);
      expect(
        packagedPaths.has(
          'dist/server/modules/duty-schedule/duty-screenshot.service.js',
        ),
      ).toBe(true);
      for (const path of [
        'dist/server/modules/bitable-sync/active-personnel-directory.js',
        'dist/server/modules/weather-warning/weather-warning.scheduler.js',
        'dist/server/modules/weather-warning/weather-warning-automation.service.js',
        'dist/server/modules/weather-warning/weather-warning-automation.config.js',
        'dist/server/modules/weather-warning/weather-warning-automation-state-store.js',
        'dist/server/modules/weather-warning/weather-warning-check-scope.js',
        'dist/server/modules/weather-warning/weather-warning-registration.rules.js',
        'dist/server/modules/weather-warning/weather-warning-registration-link.js',
        'dist/server/modules/weather-warning/weather-warning-registration.config.js',
        'dist/server/modules/weather-warning/weather-warning-registration.gateway.js',
        'dist/server/modules/weather-warning/weather-warning-registration.service.js',
      ]) {
        expect(packagedPaths.has(path)).toBe(true);
      }
      expect(
        [...packagedPaths].filter((path) =>
          path.startsWith('dist/server/modules/purchase-inventory/'),
        ),
      ).not.toHaveLength(0);
      expect(
        packagedPaths.has(
          'dist/server/modules/purchase-inventory/purchase-workflow-receipt-task.service.js',
        ),
      ).toBe(true);
      expect(
        packagedPaths.has(
          'dist/server/modules/inventory-management/purchase-inbound-confirmation.service.js',
        ),
      ).toBe(true);
      expect(
        packagedPaths.has(
          'dist/server/modules/inventory-management/inventory-outbound-workflow.service.js',
        ),
      ).toBe(true);
      for (const path of [
        'dist/server/modules/inventory-management/inventory-movement-deletion-task-ledger.store.js',
        'dist/server/modules/inventory-management/inventory-movement-deletion.service.js',
        'dist/server/modules/inventory-management/inventory-movement-operation-coordinator.js',
        'dist/server/modules/inventory-management/purchase-inbound-category-task-ledger.store.js',
        'dist/server/modules/inventory-management/purchase-inbound-category-task.service.js',
        'dist/server/modules/inventory-management/inventory-storage-location.rules.js',
        'dist/server/modules/inventory-management/inventory-storage-location.service.js',
      ]) {
        expect(packagedPaths.has(path)).toBe(true);
      }
      expect(
        [...packagedPaths].filter(
          (path) =>
            path.startsWith('data/') ||
            path.startsWith('state/') ||
            path.includes('/state/') ||
            path.includes('overtime-request-mutations') ||
            /\.(?:ts|tsx)$/u.test(path),
        ),
      ).toHaveLength(0);

      const packagedReadme = readFileSync(
        join(extractedRoot, 'README.md'),
        'utf8',
      );
      expect(packagedReadme).toContain(
        'POST /api/duty-schedules/overtime-request',
      );
      expect(packagedReadme).toContain('OVERTIME_REQUEST_MUTATION_LEDGER_DIR');
      expect(packagedReadme).toContain('data/overtime-request-mutations');
      expect(packagedReadme).toContain('立即关闭弹窗');
      expect(packagedReadme).toContain('Ctrl+V');
      expect(packagedReadme).toContain(
        '按请求唯一 ID 和返回的 record ID 精确删除测试记录',
      );
      expect(packagedReadme).toContain('再次确认查询结果为 0');
      expect(packagedReadme).toContain('单个不超过 200 MB');
      expect(packagedReadme).toContain(
        'POST /api/duty-schedules/change-adjustment',
      );
      expect(packagedReadme).toContain('CHANGE_ADJUSTMENT_MUTATION_LEDGER_DIR');
      expect(packagedReadme).toContain('ensure-change-adjustment-fields.mjs');
      expect(packagedReadme).toContain('self-test-change-adjustment.mjs');
      expect(packagedReadme).toContain('覆盖完成后直接双击 start.cmd');
      expect(packagedReadme).toContain('正常覆盖部署无需再次输入凭据');
      expect(packagedReadme).toContain('采购入库的存放位置从库房位置底表选择');
      expect(packagedReadme).toContain('出库申请提交后进入“待库房确认”');
      expect(packagedReadme).toContain('立即把申请数量回填到多维表“出库数量”');
      expect(packagedReadme).toContain(
        '平台仅写普通业务字段，不写只读的“流程（Stage）”字段',
      );
      expect(packagedReadme).toContain(
        'Stage 与库存累计由多维表原生流程及自动化维护',
      );
      expect(packagedReadme).toContain(
        '共享同一 .runtime 出库账本的多进程同时核对时',
      );
      expect(packagedReadme).toContain(
        '多进程部署必须让各进程共享同一个 .runtime 目录',
      );
      expect(packagedReadme).not.toContain('-ValidateOnly');
      expect(packagedReadme).toContain('对象存储');
      expect(packagedReadme).toContain('多维表附件');
      expect(packagedReadme).toContain('禁用态与提交态严格分离');

      const clientJavaScript = listFiles(join(extractedRoot, 'dist', 'client'))
        .filter((path) => extname(path) === '.js')
        .map((path) =>
          readFileSync(join(extractedRoot, 'dist', 'client', path), 'utf8'),
        )
        .join('\n');
      expect(clientJavaScript).toContain('休假工时');
      expect(clientJavaScript).toContain('发送今日截图');
      expect(clientJavaScript).toContain('替班人员');
      expect(clientJavaScript).toContain('预警与戒备信息');
      expect(clientJavaScript).toContain('统一权限登录');
      expect(clientJavaScript).toContain('当前页面需要登录权限');
      expect(clientJavaScript).toContain(
        '/api/duty-schedules/overtime-request',
      );
      expect(clientJavaScript).toContain('加班工时：');
      expect(clientJavaScript).toContain('加班申请已受理，正在后台同步');
      expect(clientJavaScript).toContain('加班举证');
      expect(clientJavaScript).toContain('/api/duty-schedules/change-request');
      expect(clientJavaScript).toContain(
        '/api/duty-schedules/change-adjustment',
      );
      expect(clientJavaScript).toContain('变更调整');
      expect(clientJavaScript).toContain('请从人员名单中选择提交人');
      expect(clientJavaScript).toContain('单个不超过 200 MB');
      expect(clientJavaScript).toContain('Ctrl+V');
      expect(clientJavaScript).not.toContain('预警卡片测试');
      expect(clientJavaScript).toContain('采购形式');
      expect(clientJavaScript).toContain('单一采购');
      expect(clientJavaScript).toContain('单一原因');
      expect(clientJavaScript).toContain('确认到货签收');
      expect(clientJavaScript).toContain('aria-busy');
      expect(clientJavaScript).toContain('提交中');
      expect(clientJavaScript).toContain(
        '/api/inventory-management/storage-locations',
      );
      expect(clientJavaScript).toContain('clientMutationId');
      expect(clientJavaScript).toContain('新增位置');
      expect(clientJavaScript).toContain('存放位置分类');
      expect(clientJavaScript).toContain(
        '/api/inventory-management/outbounds/',
      );
      expect(clientJavaScript).toContain('待库房确认');
      expect(clientJavaScript).toContain('查看并确认');
      expect(clientJavaScript).toContain('库房确认出库');
    } finally {
      rmSync(testRoot, { recursive: true, force: true });
    }
  });

  it('rejects a client root reached through a junction', () => {
    const testRoot = mkdtempSync(join(tmpdir(), 'nantong-hotfix-reparse-'));
    const realClientRoot = createMinimalClientFixture(join(testRoot, 'real'));
    const junctionRoot = join(testRoot, 'client-junction');
    const outputRoot = join(testRoot, 'output');
    mkdirSync(outputRoot);
    symlinkSync(realClientRoot, junctionRoot, 'junction');

    try {
      expect(() => runPackage(scriptPath, outputRoot, junctionRoot)).toThrow(
        /reparse-point/iu,
      );
    } finally {
      if (existsSync(junctionRoot)) unlinkSync(junctionRoot);
      rmSync(testRoot, { recursive: true, force: true });
    }
  });

  it('rejects additional private-key, credential and runtime database files', () => {
    const testRoot = mkdtempSync(join(tmpdir(), 'nantong-hotfix-sensitive-'));
    const clientRoot = createMinimalClientFixture(testRoot);
    const outputRoot = join(testRoot, 'output');
    mkdirSync(outputRoot);
    writeFileSync(join(clientRoot, 'embedded-client.p12'), 'not-a-real-key');

    try {
      expect(() => runPackage(scriptPath, outputRoot, clientRoot)).toThrow(
        /Blocked source, runtime, or credential file/iu,
      );
    } finally {
      rmSync(testRoot, { recursive: true, force: true });
    }
  });

  it('rejects embedded Feishu recipient identifiers in client artifacts', () => {
    const testRoot = mkdtempSync(
      join(tmpdir(), 'nantong-hotfix-recipient-id-'),
    );
    const clientRoot = createMinimalClientFixture(testRoot);
    const outputRoot = join(testRoot, 'output');
    mkdirSync(outputRoot);
    const syntheticRecipientId = `o${'c'}_${'a'.repeat(32)}`;
    writeFileSync(
      join(clientRoot, 'main.js'),
      `console.log("预警与戒备信息", ${JSON.stringify(syntheticRecipientId)});`,
      'utf8',
    );

    try {
      expect(() => runPackage(scriptPath, outputRoot, clientRoot)).toThrow(
        /Blocked non-audited recipient identifier/iu,
      );
    } finally {
      rmSync(testRoot, { recursive: true, force: true });
    }
  });
});
