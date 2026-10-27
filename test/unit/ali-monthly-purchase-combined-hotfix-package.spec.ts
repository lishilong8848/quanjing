import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const scriptPath = join(
  process.cwd(),
  'scripts/create-ali-monthly-purchase-combined-hotfix-package.ps1',
);

describe('Ali monthly report and purchase combined hotfix package', () => {
  const readScript = () => readFileSync(scriptPath, 'utf8');

  it('packages one complete client tree and complete compiled server modules', () => {
    const script = readScript();

    expect(script).toContain("$clientRelativePath = 'dist/client'");
    expect(script).toContain(
      "$purchaseServerModuleRelativePath = 'dist/server/modules/purchase-inventory'",
    );
    expect(readSingleQuotedArray(script, 'serverRelativePaths')).toEqual([
      'dist/server/modules/ali-monthly-report/ali-monthly-report.controller.js',
      'dist/server/modules/ali-monthly-report/ali-monthly-report-feishu.js',
      'dist/server/modules/ali-monthly-report/ali-monthly-report.module.js',
      'dist/server/modules/ali-monthly-report/ali-monthly-report-task-coordinator.service.js',
      'dist/server/modules/ali-monthly-report/ali-monthly-report-task-state.js',
      'dist/server/modules/ali-monthly-report/ali-monthly-report.scheduler.js',
      'dist/server/modules/ali-monthly-report/ali-monthly-report.service.js',
      'dist/server/modules/purchase-inventory/purchase-application.validation.js',
      'dist/server/modules/purchase-inventory/purchase-application.service.js',
      'dist/server/modules/purchase-inventory/purchase-inventory.mapper.js',
    ]);
    expect(readSingleQuotedArray(script, 'supportRelativePaths')).toEqual([
      'scripts/install-ali-monthly-report-python-deps.ps1',
      'tools/ali-monthly-report/config.example.json',
      'tools/ali-monthly-report/requirements.txt',
      'tools/ali-monthly-report/python_dependency_probe.py',
      'tools/ali-monthly-report/four_item_bundle_runner.py',
      'tools/ali-monthly-report/monthly_report_runner.py',
      'tools/ali-monthly-report/ali_monthly_reports/__init__.py',
      'tools/ali-monthly-report/ali_monthly_reports/__main__.py',
      'tools/ali-monthly-report/ali_monthly_reports/alarm_report_generator.py',
      'tools/ali-monthly-report/ali_monthly_reports/cli.py',
      'tools/ali-monthly-report/ali_monthly_reports/config.py',
      'tools/ali-monthly-report/ali_monthly_reports/feishu.py',
      'tools/ali-monthly-report/ali_monthly_reports/reports.py',
      'tools/ali-monthly-report/ali_monthly_reports/staff.py',
      'tools/ali-monthly-report/ali_monthly_reports/utils.py',
      'tools/ali-monthly-report-email/requirements.txt',
      'tools/ali-monthly-report-email/app.py',
      'tools/ali-monthly-report-email/ali_alarm_report_generator.py',
      'tools/ali-monthly-report-email/ali_over_power_report_generator.py',
      'tools/ali-monthly-report-email/templates/index.html',
    ]);
    expect(script).toContain('Copy-RequiredDirectory');
    expect(script).toContain('Copy-RequiredWheelhouse');
    expect(script).toContain("-Filter '*.js'");
    expect(script).toContain("-Filter '*.js' -Recurse");
    expect(script).toContain("Where-Object { $_.Name -notmatch '[.](spec|test)[.]js$' }");
    expect(script).toContain('$expectedPurchaseServerRelativePaths');
    expect(script).toContain('function Assert-TypeScriptRuntimeOutputsAreFresh');
    expect(script).toContain(
      'Compiled runtime output is older than its source:',
    );
    expect(script).toContain(
      'Compiled purchase server runtime does not match its non-test TypeScript sources.',
    );
    expect(script).toContain('$allServerRelativePaths');
    expect(script).toContain("'purchase-complete-compiled-server-module'");
  });

  it('requires the offline CPython 3.12 Windows x64 wheelhouse', () => {
    const script = readScript();
    const parameterBlock = script.match(/^\uFEFF?param\(([\s\S]*?)\r?\n\)/);

    expect(parameterBlock).not.toBeNull();
    expect(parameterBlock?.[1]).toContain('[Parameter(Mandatory = $true)]');
    expect(
      Array.from(
        parameterBlock?.[1].matchAll(
          /\$(OutputDir|SkipBuild|WheelhousePath)\b/g,
        ) ?? [],
      ).map((entry) => entry[1]),
    ).toEqual(['OutputDir', 'SkipBuild', 'WheelhousePath']);
    expect(script).toContain("$wheelhouseRelativePath = 'python/wheelhouse'");
    expect(script).toContain('Python wheelhouse contains no .whl files');
    expect(script).toContain("'cp312-win_amd64'");
    expect(script).toContain('offlineWheelhouseIncluded = $true');
    expect(script).toContain('dependencyReadinessCheckRequired = $true');
  });

  it('pins the complete wheel set and validates SkipBuild provenance', () => {
    const script = readScript();

    expect(readSingleQuotedArray(script, 'expectedWheelFileNames')).toEqual([
      'blinker-1.9.0-py3-none-any.whl',
      'certifi-2026.7.22-py3-none-any.whl',
      'charset_normalizer-3.4.9-cp312-cp312-win_amd64.whl',
      'click-8.4.2-py3-none-any.whl',
      'colorama-0.4.6-py2.py3-none-any.whl',
      'contourpy-1.3.3-cp312-cp312-win_amd64.whl',
      'cycler-0.12.1-py3-none-any.whl',
      'et_xmlfile-2.0.0-py3-none-any.whl',
      'flask-3.0.0-py3-none-any.whl',
      'fonttools-4.63.0-cp312-cp312-win_amd64.whl',
      'idna-3.18-py3-none-any.whl',
      'itsdangerous-2.2.0-py3-none-any.whl',
      'jinja2-3.1.6-py3-none-any.whl',
      'kiwisolver-1.5.0-cp312-cp312-win_amd64.whl',
      'markupsafe-3.0.3-cp312-cp312-win_amd64.whl',
      'matplotlib-3.8.2-cp312-cp312-win_amd64.whl',
      'numpy-1.26.4-cp312-cp312-win_amd64.whl',
      'openpyxl-3.1.2-py2.py3-none-any.whl',
      'packaging-26.2-py3-none-any.whl',
      'pandas-2.1.4-cp312-cp312-win_amd64.whl',
      'Pillow-10.1.0-cp312-cp312-win_amd64.whl',
      'pyparsing-3.3.2-py3-none-any.whl',
      'python_dateutil-2.9.0.post0-py2.py3-none-any.whl',
      'pytz-2026.3.post1-py2.py3-none-any.whl',
      'pywin32-306-cp312-cp312-win_amd64.whl',
      'requests-2.31.0-py3-none-any.whl',
      'six-1.17.0-py2.py3-none-any.whl',
      'tzdata-2026.3-py2.py3-none-any.whl',
      'urllib3-2.7.0-py3-none-any.whl',
      'werkzeug-3.1.8-py3-none-any.whl',
    ]);
    expect(script).toContain(
      'Python wheelhouse file set is incomplete or incompatible.',
    );
    expect(script).toContain('function Assert-SkipBuildOutputsAreFresh');
    expect(script).toContain('if ($SkipBuild)');
    expect(script).toContain(
      'Prebuilt production output is older than relevant source',
    );
    expect(script).toContain(
      "sourceBuild = if ($SkipBuild) { 'prebuilt-validated-production-output' }",
    );
    expect(script).toContain('buildSkipped = [bool]$SkipBuild');
  });

  it('rejects compiled output without both feature sets', () => {
    const script = readScript();

    for (const marker of [
      '三方比价',
      '单一采购',
      '单一原因',
      '提交中',
      'loading',
      'showSpinner',
      '打开文件',
      '定位文件',
      '飞书通知已发送',
      '同步到资料管理告警分析表',
      '资料管理附件配置缺失',
      '/api/ali-monthly-report/files/',
      'scrollIntoView',
      'python_dependency_probe.py',
      'Python 依赖未就绪',
      "'over_power':",
      'bitableRecordUrls',
      'STAFF_REPORT_TABLE_ID',
      'ALI_POWER_ALERT_CONFIG_PATH',
      'selectComparisonFiles',
      'procurementForm',
      'ali-monthly-report-public-download-v1',
      'resolvePromise({ stdout, stderr: safeStderr })',
      'build_bitable_record_url',
      'buildAliMonthlyReportManualSuccessCard',
      'buildAliMonthlyReportAutomationCard',
      'ALI_MONTHLY_REPORT_FEISHU_CHAT_IDS',
      'ALI_MONTHLY_REPORT_AUTOMATION_CHAT_ID',
      'DEFAULT_STAFF_REPORT_TABLE',
      'staff_report_table_id',
      'sync_staff_report_attachment',
      'staff_attachment_syncer',
      'ALI_MONTHLY_REPORT_SCHEDULER_ENABLED',
      'ALI_MONTHLY_REPORT_AUTOMATION_STATE_PATH',
      'resolveLatestDueAliMonthlyReportPeriod',
      'sendAutomationSummary',
      'nantong-schedule-state',
    ]) {
      expect(script).toContain(marker);
    }
    expect(script).toContain('Assert-CompiledClientTreeContains');
    expect(script).toContain('Assert-CompiledFileContains');
    expect(script).toContain('Assert-CompiledFileDoesNotContain');
    expect(script).toContain("'pip install'");
    expect(script).toContain("'@server/'");
  });

  it('audits the exact four-item Base bundle and native Feishu ZIP delivery', () => {
    const script = readScript();
    const serviceAudit = readCompiledFileAudit(
      script,
      '$serverRelativePaths[6]',
    );
    const pythonAudit = readCompiledFileAudit(
      script,
      "'tools/ali-monthly-report-email/app.py'",
    );
    const clientMarkers = readSingleQuotedArray(script, 'clientMarkers');

    for (const marker of [
      'activeBundleFourItemRequests',
      'requestFingerprint',
      'FEISHU_FILE_UPLOAD_URL',
      'application/zip',
      'msg_type',
      'file_key',
      'feishuUserOpenId',
      'feishuUserEmail',
      'bundleItems',
      'clientMutationId',
      'four_item_bundle_runner.py',
    ]) {
      expect(serviceAudit).toContain(marker);
    }
    expect(serviceAudit).not.toContain('download_monthly_bundle_report_files');
    expect(serviceAudit).not.toContain('build_monthly_bundle_zip');
    for (const marker of [
      'clientMutationId',
      'ali-monthly-bundle-',
      '正在下载并打包4项文件',
      'bundleItems',
      '最近一次成功结果（本次操作失败）',
    ]) {
      expect(clientMarkers).toContain(marker);
    }
    for (const marker of [
      'STAFF_REPORT_TABLE_NAME',
      '人员变动报告',
      'download_monthly_bundle_report_files',
      'build_monthly_bundle_zip',
      'FEISHU_MESSAGE_FILE_MAX_BYTES',
      'require_unique_latest',
      'filter_records_by_year_month',
      'record_year == target_year and record_month == month_number',
      'expected_categories',
      '每类1个',
    ]) {
      expect(pythonAudit).toContain(marker);
    }
    for (const readmeContract of [
      'ZIP 文件发送到配置的会话群和马进宇',
      'ALI_MONTHLY_REPORT_FEISHU_MA_JINYU_OPEN_ID',
      'ALI_MONTHLY_REPORT_FEISHU_MA_JINYU_EMAIL',
    ]) {
      expect(script).toContain(readmeContract);
    }
  });

  it('hashes every payload file and rejects unsafe paths and archive entries', () => {
    const script = readScript();

    for (const contract of [
      'function Assert-ChildPath',
      'function Assert-SafePayloadPaths',
      'function Assert-NoReparsePoints',
      'function Get-StageRelativePaths',
      'function Write-HotfixManifest',
      'function Assert-HotfixManifest',
      'Get-FileHash -LiteralPath',
      "'hotfix-manifest.json'",
      '$zipPath.sha256.txt',
      'CreateFromDirectory',
      'OpenRead($zipPath)',
      'ZIP entries do not exactly match the staged hotfix files.',
      'Hotfix staging contains an unexpected or missing file.',
      'ZIP contains a duplicate entry path.',
    ]) {
      expect(script).toContain(contract);
    }
    for (const forbidden of [
      '.env',
      'node_modules',
      '/data/',
      '/downloads/',
      '/logs/',
      '/certs/',
      '.runtime',
      'sourcemaps',
      '.map',
      '.ts',
      '.tsx',
      '.spec',
      '.log',
      '.pem',
      '.key',
      'package.json',
      'package-lock.json',
      'config.json',
    ]) {
      expect(script).toContain(forbidden);
    }
    expect(script).toContain('[IO.FileAttributes]::ReparsePoint');
  });

  it.each([
    'dist/client/Node_Modules/pkg/index.js',
    'dist/client/Logs/application.txt',
    'dist/client/Data/cache.json',
    'dist/client/Downloads/report.xlsx',
    'dist/client/Certs/client.txt',
    'dist/client/.Runtime/state.json',
    'dist/client/SourceMaps/main.js',
    'dist/client/Package.JSON',
    'dist/client/main.TS',
    'dist/client/.ENV.Production',
    'dist/client/feature.SpEc.js',
  ])(
    'rejects the case-insensitive forbidden payload path %s',
    (payloadPath) => {
      const result = runPayloadPathValidation(payloadPath);

      expect(result.error).toBeUndefined();
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toContain(
        `Refusing to package forbidden path: ${payloadPath}`,
      );
    },
  );

  it('allows normal runtime and wheel paths through the isolated safety function', () => {
    for (const payloadPath of [
      'dist/client/main.js',
      'python/wheelhouse/openpyxl-3.1.5-py2.py3-none-any.whl',
    ]) {
      const result = runPayloadPathValidation(payloadPath);
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
    }
  });

  it('builds by default and documents combined deployment and rollback', () => {
    const script = readScript();

    expect(script).toContain('if (!$SkipBuild)');
    expect(script).toContain('npm run build:prod');
    expect(script).toContain('清单列出的全部工具文件');
    expect(script).not.toContain('7 个工具文件');
    expect(script).toContain(
      'Production build failed; hotfix package was not created.',
    );
    for (const readmeContract of [
      '阿里月报 + 采购页面优化联合热包',
      '同一次生产构建',
      '完整 `dist/client`',
      '停止应用服务',
      '删除旧 `dist/client`',
      '删除旧 `dist/server/modules/ali-monthly-report`',
      '备份现有 `python/wheelhouse`',
      '删除旧 `python/wheelhouse`',
      'install-ali-monthly-report-python-deps.ps1',
      'ALI_MONTHLY_REPORT_PYTHON',
      'ALI_MONTHLY_REPORT_PUBLIC_BASE_URL',
      'PUBLIC_BASE_URL',
      'ALI_MONTHLY_REPORT_FEISHU_CHAT_ID',
      'ALI_MONTHLY_REPORT_FEISHU_CHAT_IDS',
      'ALI_MONTHLY_REPORT_AUTOMATION_CHAT_ID',
      'ALI_MONTHLY_REPORT_FEISHU_APP_ID',
      'ALI_MONTHLY_REPORT_FEISHU_APP_SECRET',
      'ALI_MONTHLY_REPORT_DOWNLOAD_SIGNING_SECRET',
      'STAFF_REPORT_TABLE_ID',
      'STAFF_REPORT_VIEW_ID',
      'ALI_ALARM_TEMPLATE_PATH',
      '告警模板文件存在且可读',
      '不包含业务 XLSX 模板',
      'ALI_MONTHLY_REPORT_SCHEDULER_ENABLED',
      'ALI_MONTHLY_REPORT_AUTOMATION_STATE_PATH',
      '每月 3 日 09:00（Asia/Shanghai）',
      '失败项每小时重试',
      'nantong-schedule-state',
      'Ctrl+F5',
      '单一采购',
      '打开文件',
      '飞书通知',
      '## 回滚',
      '不包含 `.env`',
    ]) {
      expect(script).toContain(readmeContract);
    }
  });
});

function readSingleQuotedArray(script: string, variable: string): string[] {
  const match = script.match(
    new RegExp(`\\$${variable}\\s*=\\s*@\\(([\\s\\S]*?)\\r?\\n\\)`),
  );
  expect(match).not.toBeNull();
  return Array.from(match?.[1].matchAll(/'([^']+)'/g) ?? []).map(
    (entry) => entry[1],
  );
}

function readCompiledFileAudit(script: string, relativePath: string): string {
  const opening = `Assert-CompiledFileContains -RelativePath ${relativePath} -Markers @(`;
  const start = script.indexOf(opening);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = script.indexOf('\n)', start + opening.length);
  expect(end).toBeGreaterThan(start);
  return script.slice(start, end);
}

function runPayloadPathValidation(payloadPath: string) {
  const script = readFileSync(scriptPath, 'utf8');
  const functionSource = script.match(
    /function Assert-SafePayloadPaths \{[\s\S]*?\r?\n\}(?=\r?\n\r?\nfunction Assert-NoReparsePoints)/,
  )?.[0];
  if (!functionSource) {
    throw new Error('Assert-SafePayloadPaths could not be extracted safely');
  }
  const escapedPath = payloadPath.replace(/'/g, "''");
  const command = `${functionSource}\nAssert-SafePayloadPaths -Paths @('${escapedPath}')`;
  const executable = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
  const args = ['-NoLogo', '-NoProfile', '-NonInteractive'];
  if (process.platform === 'win32') {
    args.push('-ExecutionPolicy', 'Bypass');
  }
  args.push('-Command', command);
  return spawnSync(executable, args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    windowsHide: true,
  });
}
