param(
  [string]$OutputDir = 'output/hotfix',
  [switch]$SkipBuild,
  [string]$WheelhousePath = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$packageName = "ali-monthly-report-bitable-automation-hotfix-$timestamp"
$outputRoot = if ([IO.Path]::IsPathRooted($OutputDir)) {
  [IO.Path]::GetFullPath($OutputDir)
} else {
  Join-Path $repoRoot $OutputDir
}
$stageDir = Join-Path $outputRoot $packageName
$zipPath = Join-Path $outputRoot "$packageName.zip"
$sidecarPath = "$zipPath.sha256.txt"
$clientRelativePath = 'dist/client'
$serverModuleRelativePath = 'dist/server/modules/ali-monthly-report'
$readmeRelativePath = 'README_ALI_MONTHLY_REPORT_HOTFIX.md'
$manifestRelativePath = 'hotfix-manifest.json'
$runtimeFileRelativePaths = @(
  'dist/server/modules/ali-monthly-report/ali-monthly-report.controller.js',
  'dist/server/modules/ali-monthly-report/ali-monthly-report-feishu.js',
  'dist/server/modules/ali-monthly-report/ali-monthly-report.module.js',
  'dist/server/modules/ali-monthly-report/ali-monthly-report-task-coordinator.service.js',
  'dist/server/modules/ali-monthly-report/ali-monthly-report-task-state.js',
  'dist/server/modules/ali-monthly-report/ali-monthly-report.scheduler.js',
  'dist/server/modules/ali-monthly-report/ali-monthly-report.service.js',
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
  'tools/ali-monthly-report-email/templates/index.html'
)
$wheelhouseRelativePath = 'python/wheelhouse'
$resolvedWheelhousePath = if ($WheelhousePath.Trim()) {
  $candidate = if ([IO.Path]::IsPathRooted($WheelhousePath)) {
    $WheelhousePath
  } else {
    Join-Path $repoRoot $WheelhousePath
  }
  if (!(Test-Path -LiteralPath $candidate -PathType Container)) {
    throw "Python wheelhouse directory is missing: $candidate"
  }
  (Resolve-Path -LiteralPath $candidate).Path
} else {
  ''
}

function Assert-ChildPath {
  param(
    [string]$Parent,
    [string]$Child
  )

  $parentPrefix = [IO.Path]::GetFullPath($Parent).TrimEnd('\', '/') +
    [IO.Path]::DirectorySeparatorChar
  $childFullPath = [IO.Path]::GetFullPath($Child)
  if (!$childFullPath.StartsWith(
      $parentPrefix,
      [StringComparison]::OrdinalIgnoreCase
    )) {
    throw "Refusing to use a path outside the intended output directory: $Child"
  }
}

function Copy-RequiredFile {
  param(
    [string]$Source,
    [string]$Destination
  )

  if (!(Test-Path -LiteralPath $Source -PathType Leaf)) {
    throw "Required hotfix payload is missing: $Source"
  }
  $parent = Split-Path -Parent $Destination
  if ($parent) {
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
  }
  Copy-Item -LiteralPath $Source -Destination $Destination -Force
}

function Copy-RequiredDirectory {
  param(
    [string]$Source,
    [string]$Destination
  )

  if (!(Test-Path -LiteralPath $Source -PathType Container)) {
    throw "Required hotfix payload directory is missing: $Source"
  }
  $parent = Split-Path -Parent $Destination
  if ($parent) {
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
  }
  Copy-Item -LiteralPath $Source -Destination $Destination -Recurse -Force
}

function Get-StageRelativePaths {
  param([string]$Stage)

  return @(
    Get-ChildItem -LiteralPath $Stage -File -Recurse |
      ForEach-Object {
        $_.FullName.Substring($Stage.Length).TrimStart('\', '/').Replace('\', '/')
      } |
      Sort-Object
  )
}

function Assert-FileContains {
  param(
    [string]$RelativePath,
    [string[]]$Markers
  )

  $fullPath = Join-Path $repoRoot $RelativePath
  if (!(Test-Path -LiteralPath $fullPath -PathType Leaf)) {
    throw "Required marker file is missing: $RelativePath"
  }
  $content = Get-Content -Raw -LiteralPath $fullPath -Encoding UTF8
  foreach ($marker in $Markers) {
    if ($content -notmatch [regex]::Escape($marker)) {
      throw "Required marker '$marker' is missing from $RelativePath"
    }
  }
}

function Assert-ClientContains {
  param([string[]]$Markers)

  $clientRoot = Join-Path $repoRoot $clientRelativePath
  $javascriptFiles = @(
    Get-ChildItem -LiteralPath $clientRoot -File -Filter '*.js' -Recurse
  )
  if ($javascriptFiles.Count -lt 2) {
    throw 'Compiled client tree is unexpectedly incomplete.'
  }
  foreach ($marker in $Markers) {
    $match = @(
      Select-String `
        -LiteralPath $javascriptFiles.FullName `
        -SimpleMatch `
        -Pattern $marker `
        -List
    ) | Select-Object -First 1
    if (!$match) {
      throw "Compiled client is missing required marker '$marker'."
    }
  }
}

function Assert-ClientFileContainsAll {
  param([string[]]$Markers)

  $clientRoot = Join-Path $repoRoot $clientRelativePath
  $javascriptFiles = @(
    Get-ChildItem -LiteralPath $clientRoot -File -Filter '*.js' -Recurse
  )
  foreach ($javascriptFile in $javascriptFiles) {
    $containsAllMarkers = $true
    foreach ($marker in $Markers) {
      if (!(
        Select-String `
          -LiteralPath $javascriptFile.FullName `
          -SimpleMatch `
          -Pattern $marker `
          -Quiet
      )) {
        $containsAllMarkers = $false
        break
      }
    }
    if ($containsAllMarkers) {
      return
    }
  }

  throw "Compiled client has no single file containing all required markers: $(
    $Markers -join ', '
  )"
}

function Assert-SkipBuildOutputsAreFresh {
  param(
    [string[]]$SourcePaths,
    [string[]]$OutputPaths
  )

  $sourceFiles = @(
    foreach ($sourcePath in $SourcePaths) {
      $fullPath = Join-Path $repoRoot $sourcePath
      if (Test-Path -LiteralPath $fullPath -PathType Leaf) {
        Get-Item -LiteralPath $fullPath
      } elseif (Test-Path -LiteralPath $fullPath -PathType Container) {
        Get-ChildItem -LiteralPath $fullPath -File -Recurse |
          Where-Object {
            [IO.Path]::GetExtension($_.Name) -in @(
              '.ts',
              '.tsx',
              '.js',
              '.css',
              '.html',
              '.json'
            )
          }
      } else {
        throw "Relevant source path was not found: $sourcePath"
      }
    }
  )
  if ($sourceFiles.Count -eq 0) {
    throw 'No relevant source files were found for SkipBuild validation.'
  }
  $newestSource = $sourceFiles |
    Sort-Object LastWriteTimeUtc -Descending |
    Select-Object -First 1
  foreach ($outputPath in $OutputPaths) {
    $fullPath = Join-Path $repoRoot $outputPath
    if (!(Test-Path -LiteralPath $fullPath -PathType Leaf)) {
      throw "Required prebuilt production output was not found: $outputPath"
    }
    $output = Get-Item -LiteralPath $fullPath
    if ($output.LastWriteTimeUtc -lt $newestSource.LastWriteTimeUtc) {
      throw "Prebuilt production output is older than relevant source: $outputPath"
    }
  }
}

Assert-ChildPath -Parent $outputRoot -Child $stageDir
Assert-ChildPath -Parent $outputRoot -Child $zipPath
Assert-ChildPath -Parent $outputRoot -Child $sidecarPath

Set-Location $repoRoot
if (!$SkipBuild) {
  npm run build:prod
  if ($LASTEXITCODE -ne 0) {
    throw 'Production build failed; hotfix package was not created.'
  }
}
if ($SkipBuild) {
  Assert-SkipBuildOutputsAreFresh `
    -SourcePaths @(
      'client/src/pages/AliMonthlyReport',
      'client/src/api/index.ts',
      'shared/api.interface.ts'
    ) `
    -OutputPaths @(
      'dist/client/index.html',
      'dist/client/main.js'
    )
  Assert-SkipBuildOutputsAreFresh `
    -SourcePaths @(
      'server/modules/ali-monthly-report/ali-monthly-report.controller.ts'
    ) `
    -OutputPaths @($runtimeFileRelativePaths[0])
  Assert-SkipBuildOutputsAreFresh `
    -SourcePaths @(
      'server/modules/ali-monthly-report/ali-monthly-report-feishu.ts'
    ) `
    -OutputPaths @($runtimeFileRelativePaths[1])
  Assert-SkipBuildOutputsAreFresh `
    -SourcePaths @(
      'server/modules/ali-monthly-report/ali-monthly-report.module.ts'
    ) `
    -OutputPaths @($runtimeFileRelativePaths[2])
  Assert-SkipBuildOutputsAreFresh `
    -SourcePaths @(
      'server/modules/ali-monthly-report/ali-monthly-report-task-coordinator.service.ts',
      'server/modules/ali-monthly-report/ali-monthly-report-task-state.ts'
    ) `
    -OutputPaths @($runtimeFileRelativePaths[3])
  Assert-SkipBuildOutputsAreFresh `
    -SourcePaths @(
      'server/modules/ali-monthly-report/ali-monthly-report-task-state.ts'
    ) `
    -OutputPaths @($runtimeFileRelativePaths[4])
  Assert-SkipBuildOutputsAreFresh `
    -SourcePaths @(
      'server/modules/ali-monthly-report/ali-monthly-report.scheduler.ts',
      'server/modules/ali-monthly-report/ali-monthly-report-task-coordinator.service.ts'
    ) `
    -OutputPaths @($runtimeFileRelativePaths[5])
  Assert-SkipBuildOutputsAreFresh `
    -SourcePaths @(
      'server/modules/ali-monthly-report/ali-monthly-report.service.ts',
      'server/modules/ali-monthly-report/ali-monthly-report-feishu.ts'
    ) `
    -OutputPaths @($runtimeFileRelativePaths[6])
}

$clientRoot = Join-Path $repoRoot $clientRelativePath
foreach ($requiredClientFile in @('index.html', 'main.js')) {
  $requiredPath = Join-Path $clientRoot $requiredClientFile
  if (!(Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
    throw "Required compiled client entry is missing: $requiredPath"
  }
}

Assert-ClientContains -Markers @(
  '打开文件',
  '定位文件',
  '正在打开',
  '飞书通知已发送',
  '飞书通知失败',
  '资料管理附件配置缺失',
  '/api/ali-monthly-report/files/'
)
Assert-ClientFileContainsAll -Markers @(
  '生成结果',
  'scroll-mt-20',
  'scrollIntoView',
  'prefers-reduced-motion: reduce',
  '打开文件',
  '定位文件'
)
Assert-FileContains `
  -RelativePath 'dist/server/modules/ali-monthly-report/ali-monthly-report.controller.js' `
  -Markers @(
    'files/:fileId/open',
    'files/:fileId/reveal',
      'public-files/:fileId',
      'PublicAccess',
      'AdminOnly',
      'openapi.ApiResponse'
  )
Assert-FileContains `
  -RelativePath 'dist/server/modules/ali-monthly-report/ali-monthly-report.service.js' `
  -Markers @(
    'performGeneratedFileAction',
    'readPublicGeneratedFile',
      'python_dependency_probe.py',
      'Python 依赖未就绪',
      'pythonDependenciesPromises',
      'ALARM_REPORT_TABLE_ID',
      'buildBitableUploadLogs',
      'bitableRecordUrls',
      'resolvePromise({ stdout, stderr: safeStderr })',
      'ALI_MONTHLY_REPORT_FEISHU_CHAT_IDS',
      'ALI_MONTHLY_REPORT_AUTOMATION_CHAT_ID',
      'Promise.allSettled',
      'sendAutomationSummary',
      "'interactive'",
      '资料管理多维表',
      '同步到资料管理告警分析表',
      'process.cwd(), configured',
      '../../common/config/external-services.config',
      '已提交系统打开请求',
    '仅支持打开或定位 XLSX、ZIP 文件',
    'realpath'
  )
Assert-FileContains `
  -RelativePath 'tools/ali-monthly-report/python_dependency_probe.py' `
  -Markers @(
    "'core':",
    "'over_power':",
    "'legacy':",
    'importlib.import_module',
    'missing_or_broken'
  )
Assert-FileContains `
  -RelativePath 'tools/ali-monthly-report/four_item_bundle_runner.py' `
  -Markers @(
    'select_bundle_attachments',
    '仅下载选中的 4 个文件',
    'ThreadPoolExecutor',
    'urllib.request',
    'EXPECTED_CATEGORIES',
    'MAX_DOWNLOAD_ATTEMPTS',
    'is_retryable_download_http_error'
  )
Assert-FileContains `
  -RelativePath 'dist/server/modules/ali-monthly-report/ali-monthly-report-feishu.js' `
  -Markers @(
    'ali-monthly-report-public-download-v1',
    'buildAliMonthlyReportPublicDownloadUrl',
    'verifyAliMonthlyReportDownload',
    'buildAliMonthlyReportManualSuccessCard',
    'buildAliMonthlyReportAutomationCard'
  )
Assert-FileContains `
  -RelativePath 'dist/server/modules/ali-monthly-report/ali-monthly-report-task-coordinator.service.js' `
  -Markers @(
    'ALI_MONTHLY_REPORT_AUTOMATION_TYPES',
    'Promise.allSettled',
    'sendAutomationSummary',
    'lastNotifiedFingerprint'
  )
Assert-FileContains `
  -RelativePath 'dist/server/modules/ali-monthly-report/ali-monthly-report-task-state.js' `
  -Markers @(
    'ALI_MONTHLY_REPORT_AUTOMATION_STATE_PATH',
    'nantong-schedule-state',
    'ali-monthly-report-task-state.json',
    'renameSync'
  )
Assert-FileContains `
  -RelativePath 'dist/server/modules/ali-monthly-report/ali-monthly-report.scheduler.js' `
  -Markers @(
    'ALI_MONTHLY_REPORT_SCHEDULER_ENABLED',
    'resolveLatestDueAliMonthlyReportPeriod',
    'setInterval'
  )
Assert-FileContains `
  -RelativePath 'tools/ali-monthly-report/ali_monthly_reports/config.py' `
  -Markers @(
    'DEFAULT_ALARM_REPORT_TABLE',
    'alarm_report_table_id',
    'DEFAULT_STAFF_REPORT_TABLE',
    'staff_report_table_id'
  )
Assert-FileContains `
  -RelativePath 'tools/ali-monthly-report/config.example.json' `
  -Markers @(
    'staff_report_table_id',
    'staff_report_view_id'
  )
Assert-FileContains `
  -RelativePath 'tools/ali-monthly-report/ali_monthly_reports/feishu.py' `
  -Markers @(
    'sync_alarm_report_attachment',
    'sync_report_attachment',
    'sync_staff_report_attachment',
    'build_bitable_record_url',
    '/records/search',
    'upload_bitable_file',
    'generated_and_uploaded'
  )
Assert-FileContains `
  -RelativePath 'tools/ali-monthly-report/ali_monthly_reports/reports.py' `
  -Markers @(
    'alarm_attachment_syncer',
    'generate_high_power_top5_report',
    'staff_attachment_syncer'
  )
Assert-FileContains `
  -RelativePath 'tools/ali-monthly-report/ali_monthly_reports/cli.py' `
  -Markers @(
    'high_power_top5'
  )
Assert-FileContains `
  -RelativePath 'tools/ali-monthly-report/ali_monthly_reports/staff.py' `
  -Markers @(
    '实习生及备岗',
    '本月新增人员姓名',
    '其他人员'
  )
Assert-FileContains `
  -RelativePath 'tools/ali-monthly-report-email/app.py' `
  -Markers @(
    '/api/local_file/open',
    '已提交系统打开请求',
    '仅支持打开或定位 XLSX、ZIP 文件',
    '实习生及备岗'
  )
Assert-FileContains `
  -RelativePath 'tools/ali-monthly-report-email/ali_alarm_report_generator.py' `
  -Markers @(
    'generate_alarm_report'
  )
Assert-FileContains `
  -RelativePath 'tools/ali-monthly-report-email/ali_over_power_report_generator.py' `
  -Markers @(
    'generate_over_power_report'
  )
Assert-FileContains `
  -RelativePath 'tools/ali-monthly-report-email/templates/index.html' `
  -Markers @(
    'generatedFileActionInFlight',
    'openGeneratedFile(this',
    '正在打开...',
    '定位文件'
  )

New-Item -ItemType Directory -Force -Path $outputRoot | Out-Null
if (
  (Test-Path -LiteralPath $stageDir) -or
  (Test-Path -LiteralPath $zipPath) -or
  (Test-Path -LiteralPath $sidecarPath)
) {
  throw "Hotfix output already exists: $packageName"
}

try {
  New-Item -ItemType Directory -Path $stageDir | Out-Null

  Copy-RequiredDirectory `
    -Source $clientRoot `
    -Destination (Join-Path $stageDir $clientRelativePath)
  foreach ($relativePath in $runtimeFileRelativePaths) {
    Copy-RequiredFile `
      -Source (Join-Path $repoRoot $relativePath) `
      -Destination (Join-Path $stageDir $relativePath)
  }
  if ($resolvedWheelhousePath) {
    $wheelFiles = @(
      Get-ChildItem -LiteralPath $resolvedWheelhousePath -File -Filter '*.whl'
    )
    if ($wheelFiles.Count -eq 0) {
      throw "Python wheelhouse contains no .whl files: $resolvedWheelhousePath"
    }
    Copy-RequiredDirectory `
      -Source $resolvedWheelhousePath `
      -Destination (Join-Path $stageDir $wheelhouseRelativePath)
  }

  $readmeLines = @(
    '# 阿里月报多维表上传、双群互动卡片与自动调度热包',
    '',
    '> 仅限公司内部受控部署和传递。运行文件延续现有默认运营标识，不得向外部渠道分发。',
    '',
    '## 改动范围',
    '',
    '- 告警分析生成成功后，按旧项目字段和覆盖语义同步到资料管理“告警分析报告”多维表。',
    '- 超功率和人员变动同样按年月更新或新建资料管理多维表记录；人员变动配置示例随包提供。',
    '- Base app token 在 Python 成功结果中仅供内存解析，生成真实可点击记录链接，不再出现 `/base/***`。',
    '- TOP5 从高功率目标表按年月直接获取；目标告警记录使用服务端过滤，减少全表扫描。',
    '- 在职人员基础表继续只保留正式岗。',
    '- 本月人员变动按“实习生及备岗 / 其他人员”分区，并补充新增、离职岗位。',
    '- 集成页和独立版页面增加“打开文件 / 定位文件”。',
    '- 集成页在生成或一键打包成功后自动定位到生成结果，直接展示文件操作入口。',
    '- 文件操作具备即时反馈、防重复点击、失败恢复、管理员限制、真实路径校验和扩展名限制。',
    '- 告警分析、超功率和人员变动手动生成成功后，向 ALI_MONTHLY_REPORT_FEISHU_CHAT_IDS 中的会话发送带“打开多维表记录”按钮的互动卡片。',
    '- 自动任务汇总卡片只发送到 ALI_MONTHLY_REPORT_AUTOMATION_CHAT_ID；单个群通知失败会保留逐群投递结果，不影响已生成文件。',
    '- TOP5 和四项打包继续发送 72 小时 HMAC 签名下载链接；三类多维表报表禁止回退服务器本地链接。',
    '- 一键打包四项改用标准库轻量下载器，并发读取和下载四类多维表附件；不再执行月报 Python 依赖预检，也不再因 pip/PyPI 超时阻塞。',
    '- 飞书附件短暂返回 `Data not ready` 时按 1/2/4 秒有限退避重试，仍受单文件 90 秒总上限保护。',
    '- “文件与邮件”默认收件人固定为 ma.jinyu@vnet.com，服务器未配置本地配置文件时与本地页面保持一致；环境变量仍可覆盖。',
    '- 每月 3 日 09:00（Asia/Shanghai）自动生成上月告警分析、超功率和人员变动；三项并行处理后发送一次成功、部分失败或失败汇总。',
    '- 失败项每小时重试；相同失败摘要不重复刷群，成功项不会重复生成。',
    '- 自动任务状态在生产环境写入发布目录同级 nantong-schedule-state，覆盖热包和重启后继续复用。',
    '- 生成请求只做本地 Python 导入预检，不再在请求内执行 pip 或访问 PyPI。',
    '- 在职人员等核心报表只检查 openpyxl、requests；超功耗使用专用依赖档位，不再被截图和邮件依赖阻断。',
    '',
    '## 部署',
    '',
    '1. 使用同名 .sha256.txt 校验 ZIP。',
    '2. 停止应用服务。',
    '3. 备份 dist/client、dist/server/modules/ali-monthly-report，以及 hotfix-manifest.json 中列出的覆盖文件。',
    '4. 删除旧 dist/client 和 dist/server/modules/ali-monthly-report，避免残留旧前端 chunk 或旧服务端文件。',
    '5. 将 ZIP 解压到应用根目录并覆盖同名路径。',
    '6. 不要删除或覆盖现有 .env、.env.local、config.json、downloads、temp、resources、日志、业务数据或发布目录同级 nantong-schedule-state。',
    '7. 服务启动前执行 scripts/install-ali-monthly-report-python-deps.ps1；依赖已齐时脚本会直接通过，不联网。',
    '8. 如热包包含 python/wheelhouse，安装脚本自动使用离线 wheel；也可用 -Wheelhouse 显式指定。',
    '9. 随包 wheelhouse 仅适用于 CPython 3.12 / Windows x64，与本次报错服务器一致；其他 Python/架构必须换用匹配 wheel。',
    '10. 推荐先执行 `C:\Program Files\Python312\python.exe -m venv .venv-ali-report` 创建应用专用 venv。',
    '11. 执行 `$python = (Resolve-Path ''.venv-ali-report\Scripts\python.exe'').Path` 获取 venv Python 的绝对路径。',
    '12. 执行 `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install-ali-monthly-report-python-deps.ps1 -Python $python`。',
    '13. 将 `$python` 的绝对路径写入服务器最终生效的 .env / .env.local 的 ALI_MONTHLY_REPORT_PYTHON，确保安装和服务预检使用同一个解释器。',
    '14. 确认 `ALI_POWER_ALERT_CONFIG_PATH` 指向服务器现有超功耗配置文件；配置和密钥不在热包内。',
    '15. 使用原有方式启动服务并按 Ctrl+F5；以管理员身份分别生成告警分析、超功率和人员变动，确认多维表同年月记录已覆盖或新增，双群卡片按钮均可打开真实记录。',
    '16. 确认服务器时区或系统时间正确；自动任务按 Asia/Shanghai 每月 3 日 09:00 计算上个月，失败项每小时重试。',
    '',
    '本次业务代码没有新增 Python 依赖，但服务器必须满足随包两份 requirements。部署前确认现有环境配置包含：',
    '',
    '- ALI_MONTHLY_REPORT_PUBLIC_BASE_URL（或 PUBLIC_BASE_URL）：TOP5 和四项打包下载通知使用的外部 HTTPS 应用基址。',
    '- ALI_MONTHLY_REPORT_FEISHU_MA_JINYU_EMAIL：可选；未设置时默认 ma.jinyu@vnet.com。',
    '- ALI_MONTHLY_REPORT_FEISHU_CHAT_IDS：手动成功互动卡片的群 ID 列表，使用逗号、分号或空白分隔；旧 ALI_MONTHLY_REPORT_FEISHU_CHAT_ID 仍兼容。',
    '- ALI_MONTHLY_REPORT_AUTOMATION_CHAT_ID：每月自动任务汇总卡片的唯一目标群。',
    '- ALI_MONTHLY_REPORT_FEISHU_APP_ID、ALI_MONTHLY_REPORT_FEISHU_APP_SECRET。',
    '- STAFF_REPORT_TABLE_ID、STAFF_REPORT_VIEW_ID：人员变动资料管理多维表的表格和视图 ID；可参考 tools/ali-monthly-report/config.example.json。',
    '- ALI_MONTHLY_REPORT_SCHEDULER_ENABLED：默认启用；仅在明确停用自动任务时设为 false。',
    '- ALI_MONTHLY_REPORT_AUTOMATION_STATE_PATH：可选；默认生产路径为发布目录同级 nantong-schedule-state/ali-monthly-report-task-state.json。',
    '- ALI_MONTHLY_REPORT_DOWNLOAD_SIGNING_SECRET：可选，至少 32 个随机字节；留空时从飞书应用密钥派生用途隔离的签名密钥。',
    '- ALI_POWER_ALERT_CONFIG_PATH：超功耗生成器现有配置文件的绝对路径。',
    '',
    '环境变量只在服务器现有 .env / .env.local 中配置，不要写入或回传热包。',
    '',
    '## 回滚',
    '',
    '停止服务，恢复第 3 步备份的目录和文件，保留 nantong-schedule-state 中的自动任务状态，然后重新启动服务并强制刷新浏览器。',
    '',
    '## 排除项',
    '',
    '本热包不包含环境文件、凭据、证书、config.json、生成的月报、下载结果、临时文件、日志、node_modules、测试、TypeScript 源码、声明文件或 source map。',
    '',
    '运行源码沿用现有内部运营标识，因此本热包仅限公司内部受控传递。'
  )
  Set-Content `
    -LiteralPath (Join-Path $stageDir $readmeRelativePath) `
    -Value $readmeLines `
    -Encoding UTF8

  $payloadPaths = @(Get-StageRelativePaths -Stage $stageDir)
  $forbiddenFiles = @(
    $payloadPaths | Where-Object {
      $leafName = [IO.Path]::GetFileName($_)
      $extension = [IO.Path]::GetExtension($_)
      $_ -match '(^|/)(\.env[^/]*|node_modules|downloads|temp|logs|certs|sourcemaps|test|tests)(/|$)' -or
      $leafName -in @(
        'config.json',
        'credentials.json',
        'package.json',
        'package-lock.json',
        'secrets.json'
      ) -or
      $leafName.EndsWith('.d.ts') -or
      $extension -in @(
        '.7z',
        '.cer',
        '.crt',
        '.csv',
        '.db',
        '.rar',
        '.sqlite',
        '.sqlite3',
        '.xls',
        '.xlsx',
        '.zip',
        '.map',
        '.ts',
        '.tsx',
        '.spec',
        '.log',
        '.pem',
        '.key',
        '.pfx',
        '.p12'
      )
    }
  )
  if ($forbiddenFiles.Count -gt 0) {
    throw "Refusing to package forbidden path: $($forbiddenFiles[0])"
  }

  $reparsePoints = @(
    Get-ChildItem -LiteralPath $stageDir -Force -Recurse |
      Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }
  )
  if ($reparsePoints.Count -gt 0) {
    throw "Refusing to package a reparse point: $($reparsePoints[0].FullName)"
  }

  $manifestFiles = @(
    $payloadPaths | ForEach-Object {
      $fullPath = Join-Path $stageDir $_.Replace(
        '/',
        [IO.Path]::DirectorySeparatorChar
      )
      [ordered]@{
        path = $_
        size = (Get-Item -LiteralPath $fullPath).Length
        sha256 = (
          Get-FileHash -LiteralPath $fullPath -Algorithm SHA256
        ).Hash.ToUpperInvariant()
      }
    }
  )
  [ordered]@{
    schemaVersion = 1
    packageType = 'ali-monthly-report-bitable-automation-runtime-overlay'
    packageName = $packageName
    createdAt = (Get-Date).ToString('o')
    distribution = 'internal-controlled-only'
    operationalIdentifiersIncluded = $true
    replaceDirectories = @(
      $clientRelativePath,
      $serverModuleRelativePath
    )
    overwriteFiles = @(
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
      'tools/ali-monthly-report-email/templates/index.html'
    )
    scope = @(
      'staff-roster-monthly-change-sections',
      'generated-file-open-and-reveal',
      'generated-file-result-auto-navigation',
      'generated-file-feishu-download-links',
      'generated-file-feishu-bitable-record-links',
      'real-base-record-token-links',
      'dual-group-interactive-cards',
      'alarm-analysis-bitable-sync',
      'over-power-bitable-sync',
      'staff-change-bitable-sync',
      'monthly-third-0900-shanghai-scheduler',
      'hourly-failed-item-retry',
      'durable-automation-state',
      'high-power-top5-core-download',
      'four-item-lightweight-concurrent-download',
      'four-item-transient-download-retry',
      'default-email-recipient',
      'filtered-target-record-search',
      'python-runtime-import-preflight',
      'python-offline-dependency-installer',
      'instant-feedback-and-duplicate-protection',
      'local-file-action-security'
    )
    secretsIncluded = $false
    dependencyInstallRequired = $true
    dependencyReadinessCheckRequired = $true
    offlineWheelhouseIncluded = [bool]$resolvedWheelhousePath
    offlineWheelhouseTarget = if ($resolvedWheelhousePath) {
      'cp312-win_amd64'
    } else {
      ''
    }
    files = $manifestFiles
  } | ConvertTo-Json -Depth 7 |
    Set-Content `
      -LiteralPath (Join-Path $stageDir $manifestRelativePath) `
      -Encoding UTF8

  $actualFiles = @(Get-StageRelativePaths -Stage $stageDir)
  $expectedFiles = @($payloadPaths + $manifestRelativePath | Sort-Object)
  if (
    $actualFiles.Count -ne $expectedFiles.Count -or
    @($actualFiles | Where-Object { $_ -notin $expectedFiles }).Count -gt 0 -or
    @($expectedFiles | Where-Object { $_ -notin $actualFiles }).Count -gt 0
  ) {
    throw 'Hotfix staging contains an unexpected or missing file.'
  }

  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [System.IO.Compression.ZipFile]::CreateFromDirectory(
    $stageDir,
    $zipPath,
    [System.IO.Compression.CompressionLevel]::Optimal,
    $false
  )

  $archive = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
  try {
    $archivePaths = @(
      $archive.Entries |
        Where-Object { $_.Name } |
        ForEach-Object { $_.FullName.Replace('\', '/') } |
        Sort-Object
    )
    if (
      $archivePaths.Count -ne $actualFiles.Count -or
      @($archivePaths | Where-Object { $_ -notin $actualFiles }).Count -gt 0 -or
      @($actualFiles | Where-Object { $_ -notin $archivePaths }).Count -gt 0 -or
      @($archivePaths | Where-Object {
        $_.StartsWith('/') -or $_ -match '(^|/)\.\.(/|$)'
      }).Count -gt 0
    ) {
      throw 'ZIP entries do not exactly match staged hotfix files.'
    }
  } finally {
    $archive.Dispose()
  }

  $archiveHash = (
    Get-FileHash -LiteralPath $zipPath -Algorithm SHA256
  ).Hash.ToUpperInvariant()
  Set-Content `
    -LiteralPath $sidecarPath `
    -Value "$archiveHash  $([IO.Path]::GetFileName($zipPath))" `
    -Encoding ASCII
} catch {
  foreach ($target in @($stageDir, $zipPath, $sidecarPath)) {
    if (Test-Path -LiteralPath $target) {
      Assert-ChildPath -Parent $outputRoot -Child $target
      Remove-Item `
        -LiteralPath $target `
        -Recurse `
        -Force `
        -ErrorAction SilentlyContinue
    }
  }
  throw
}

Write-Host '[OK] Ali monthly report hotfix created.' -ForegroundColor Green
Write-Host "[OK] Folder: $stageDir"
Write-Host "[OK] Zip: $zipPath"
Write-Host "[OK] SHA256: $archiveHash"
