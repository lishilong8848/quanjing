param(
  [string]$OutputDir = 'output/hotfix',
  [switch]$SkipBuild,
  [string]$Python = 'python',
  [string]$WheelhousePath = '',
  [string]$PreparedRuntimePath = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$packageName = "ali-monthly-report-server-runtime-hotfix-$timestamp"
$outputRoot = if ([IO.Path]::IsPathRooted($OutputDir)) {
  [IO.Path]::GetFullPath($OutputDir)
} else {
  [IO.Path]::GetFullPath((Join-Path $repoRoot $OutputDir))
}
$stageDir = Join-Path $outputRoot $packageName
$zipPath = Join-Path $outputRoot "$packageName.zip"
$sidecarPath = "$zipPath.sha256.txt"
$manifestRelativePath = 'hotfix-manifest.json'
$readmeRelativePath = 'README_ALI_MONTHLY_REPORT_SERVER_RUNTIME_HOTFIX.md'
$bundledPackagesRelativePath = 'python/ali-monthly-report-packages'
$bundledPackagesPath = Join-Path $stageDir $bundledPackagesRelativePath

$serverFiles = @(
  'dist/server/modules/ali-monthly-report/ali-monthly-report.controller.js',
  'dist/server/modules/ali-monthly-report/ali-monthly-report-feishu.js',
  'dist/server/modules/ali-monthly-report/ali-monthly-report.module.js',
  'dist/server/modules/ali-monthly-report/ali-monthly-report-task-coordinator.service.js',
  'dist/server/modules/ali-monthly-report/ali-monthly-report-task-state.js',
  'dist/server/modules/ali-monthly-report/ali-monthly-report.scheduler.js',
  'dist/server/modules/ali-monthly-report/ali-monthly-report.service.js'
)

$sourceOutputPairs = @(
  @(
    'server/modules/ali-monthly-report/ali-monthly-report.controller.ts',
    $serverFiles[0]
  ),
  @(
    'server/modules/ali-monthly-report/ali-monthly-report-feishu.ts',
    $serverFiles[1]
  ),
  @(
    'server/modules/ali-monthly-report/ali-monthly-report.module.ts',
    $serverFiles[2]
  ),
  @(
    'server/modules/ali-monthly-report/ali-monthly-report-task-coordinator.service.ts',
    $serverFiles[3]
  ),
  @(
    'server/modules/ali-monthly-report/ali-monthly-report-task-state.ts',
    $serverFiles[4]
  ),
  @(
    'server/modules/ali-monthly-report/ali-monthly-report.scheduler.ts',
    $serverFiles[5]
  ),
  @(
    'server/modules/ali-monthly-report/ali-monthly-report.service.ts',
    $serverFiles[6]
  )
)

$runtimeFiles = @(
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
  'tools/ali-monthly-report/resources/EA118机房2026年3月告警分析表.xlsx',
  'tools/ali-monthly-report-email/requirements.txt',
  'tools/ali-monthly-report-email/app.py',
  'tools/ali-monthly-report-email/ali_alarm_report_generator.py',
  'tools/ali-monthly-report-email/ali_over_power_report_generator.py',
  'tools/ali-monthly-report-email/templates/index.html',
  'tools/ali-monthly-report-email/resources/vnet_logo.png',
  'tools/ali-monthly-report-email/resources/EA118机房2026年3月告警分析表.xlsx'
)

function Assert-ChildPath {
  param(
    [string]$Parent,
    [string]$Child
  )

  $parentPrefix = [IO.Path]::GetFullPath($Parent).TrimEnd('\', '/') +
    [IO.Path]::DirectorySeparatorChar
  $childPath = [IO.Path]::GetFullPath($Child)
  if (!$childPath.StartsWith(
      $parentPrefix,
      [StringComparison]::OrdinalIgnoreCase
    )) {
    throw "Refusing to use a path outside the intended output directory: $Child"
  }
}

function Resolve-InputPath {
  param([string]$PathText)

  if (!$PathText.Trim()) {
    return ''
  }
  $candidate = if ([IO.Path]::IsPathRooted($PathText)) {
    $PathText
  } else {
    Join-Path $repoRoot $PathText
  }
  if (!(Test-Path -LiteralPath $candidate -PathType Container)) {
    throw "Required input directory is missing: $candidate"
  }
  return (Resolve-Path -LiteralPath $candidate).Path
}

function Copy-RequiredFile {
  param([string]$RelativePath)

  $source = Join-Path $repoRoot $RelativePath
  if (!(Test-Path -LiteralPath $source -PathType Leaf)) {
    throw "Required hotfix payload is missing: $RelativePath"
  }
  $destination = Join-Path $stageDir $RelativePath
  $parent = Split-Path -Parent $destination
  New-Item -ItemType Directory -Force -Path $parent | Out-Null
  Copy-Item -LiteralPath $source -Destination $destination -Force
}

function Assert-OutputFresh {
  param(
    [string]$SourceRelativePath,
    [string]$OutputRelativePath
  )

  $source = Get-Item -LiteralPath (Join-Path $repoRoot $SourceRelativePath)
  $output = Get-Item -LiteralPath (Join-Path $repoRoot $OutputRelativePath)
  if ($output.LastWriteTimeUtc -lt $source.LastWriteTimeUtc) {
    throw "Prebuilt production output is older than source: $OutputRelativePath"
  }
}

function Get-StageRelativePaths {
  return @(
    [IO.Directory]::EnumerateFiles(
      $stageDir,
      '*',
      [IO.SearchOption]::AllDirectories
    ) |
      ForEach-Object {
        $_.Substring($stageDir.Length).TrimStart('\', '/').Replace('\', '/')
      } |
      Sort-Object
  )
}

function Resolve-Wheelhouse {
  $explicit = Resolve-InputPath -PathText $WheelhousePath
  if ($explicit) {
    return $explicit
  }

  $bundled = Join-Path $repoRoot 'python/wheelhouse'
  if (Test-Path -LiteralPath $bundled -PathType Container) {
    return (Resolve-Path -LiteralPath $bundled).Path
  }

  $candidate = Get-ChildItem `
    -LiteralPath (Join-Path $repoRoot 'output/hotfix') `
    -Directory `
    -Filter 'wheelhouse-cp312-win_amd64-*' `
    -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTimeUtc -Descending |
    Select-Object -First 1
  if (!$candidate) {
    throw 'CPython 3.12 Windows x64 offline wheelhouse was not found.'
  }
  return $candidate.FullName
}

function Assert-PythonRuntime {
  $runtimeJson = & $Python -c @'
import json, platform, struct, sys
print(json.dumps(dict(
    major=sys.version_info.major,
    minor=sys.version_info.minor,
    bits=struct.calcsize('P') * 8,
    system=platform.system(),
)))
'@
  if ($LASTEXITCODE -ne 0) {
    throw "Unable to inspect Python runtime: $Python"
  }
  $runtime = $runtimeJson | ConvertFrom-Json
  if (
    $runtime.major -ne 3 -or
    $runtime.minor -ne 12 -or
    $runtime.bits -ne 64 -or
    $runtime.system -ne 'Windows'
  ) {
    throw 'This hotfix runtime must be built with CPython 3.12 / Windows x64.'
  }
}

function Install-Or-Copy-BundledPackages {
  $preparedRuntime = Resolve-InputPath -PathText $PreparedRuntimePath
  $parent = Split-Path -Parent $bundledPackagesPath
  New-Item -ItemType Directory -Force -Path $parent | Out-Null
  if ($preparedRuntime) {
    $copyArgs = @(
      $preparedRuntime,
      $bundledPackagesPath,
      '/E',
      '/COPY:DAT',
      '/DCOPY:DAT',
      '/R:1',
      '/W:1',
      '/NFL',
      '/NDL',
      '/NJH',
      '/NJS',
      '/NP'
    )
    & robocopy @copyArgs | Out-Null
    if ($LASTEXITCODE -gt 7) {
      throw 'Copying the prepared Python runtime failed.'
    }
    return
  }

  $wheelhouse = Resolve-Wheelhouse
  $wheelFiles = @(
    Get-ChildItem -LiteralPath $wheelhouse -File -Filter '*.whl'
  )
  if ($wheelFiles.Count -eq 0) {
    throw "Offline wheelhouse contains no wheel files: $wheelhouse"
  }
  New-Item -ItemType Directory -Path $bundledPackagesPath | Out-Null
  $pipArgs = @(
    '-m',
    'pip',
    'install',
    '--disable-pip-version-check',
    '--no-input',
    '--no-index',
    '--find-links', $wheelhouse,
    '--target', $bundledPackagesPath,
    '-r', (Join-Path $repoRoot 'tools/ali-monthly-report/requirements.txt'),
    '-r', (Join-Path $repoRoot 'tools/ali-monthly-report-email/requirements.txt')
  )
  & $Python @pipArgs
  if ($LASTEXITCODE -ne 0) {
    throw 'Preparing the bundled Python runtime failed.'
  }
}

function Assert-BundledPackagesReady {
  $probePath = Join-Path $repoRoot 'tools/ali-monthly-report/python_dependency_probe.py'
  $previousPythonPath = $env:PYTHONPATH
  try {
    $env:PYTHONPATH = if ($previousPythonPath) {
      "$bundledPackagesPath$([IO.Path]::PathSeparator)$previousPythonPath"
    } else {
      $bundledPackagesPath
    }
    & $Python $probePath 'legacy'
    if ($LASTEXITCODE -ne 0) {
      throw 'Bundled Python runtime failed the complete dependency probe.'
    }
  } finally {
    $env:PYTHONPATH = $previousPythonPath
  }
}

New-Item -ItemType Directory -Force -Path $outputRoot | Out-Null
Assert-ChildPath -Parent $outputRoot -Child $stageDir
Assert-ChildPath -Parent $outputRoot -Child $zipPath
Assert-ChildPath -Parent $outputRoot -Child $sidecarPath
if (
  (Test-Path -LiteralPath $stageDir) -or
  (Test-Path -LiteralPath $zipPath) -or
  (Test-Path -LiteralPath $sidecarPath)
) {
  throw "Hotfix output already exists: $packageName"
}

Set-Location $repoRoot
if (!$SkipBuild) {
  npm run build:server
  if ($LASTEXITCODE -ne 0) {
    throw 'Server production build failed; hotfix was not created.'
  }
} else {
  foreach ($pair in $sourceOutputPairs) {
    Assert-OutputFresh `
      -SourceRelativePath $pair[0] `
      -OutputRelativePath $pair[1]
  }
}

try {
  Assert-PythonRuntime
  New-Item -ItemType Directory -Path $stageDir | Out-Null
  foreach ($relativePath in @($serverFiles + $runtimeFiles)) {
    Copy-RequiredFile -RelativePath $relativePath
  }
  Install-Or-Copy-BundledPackages
  Assert-BundledPackagesReady

  $compiledService = Get-Content `
    -Raw `
    -Encoding UTF8 `
    -LiteralPath (Join-Path $stageDir $serverFiles[6])
  $compiledServiceMarkers = @(
    'ali-monthly-report-packages',
    'PYTHONPATH',
    'user-b54e355d@example.com',
    'user-20a3f7b8@example.com'
  )
  foreach ($marker in $compiledServiceMarkers) {
    if ($compiledService -notmatch [regex]::Escape($marker)) {
      throw "Compiled Ali service is missing required marker: $marker"
    }
  }

  $readmeLines = @(
    '# 阿里月报服务器运行依赖与默认收件人热包',
    '',
    '本包仅覆盖阿里月报服务端与其 Python 运行文件，不包含前端和其他业务模块。',
    '',
    '## 本次修复',
    '',
    '- 超功耗工作簿同时作为正文数据源和唯一 Excel 附件，避免错误附加告警分析文件。',
    '- 包内已预装并验证 CPython 3.12 / Windows x64 依赖；服务会自动加载 python/ali-monthly-report-packages，不执行在线 pip。',
    '- 默认收件人为 user-b54e355d@example.com 和 user-20a3f7b8@example.com。',
    '- user-7e80d4ec@example.com 仅显示在邮件正文抄送名单中，不加入默认收件人和实际投递地址。',
    '- 旧环境变量或配置中的自定义邮箱会保留，同时自动补齐两名默认收件人；正文专用抄送地址不会进入实际投递名单。',
    '- 自动任务仅在每月 3 日 09:00 生成上月文件；每月 5 日 09:00 仅补跑上月未完成项，服务重启和其他日期不会触发补跑。',
    '',
    '## 部署',
    '',
    '1. 用同名 .sha256.txt 校验 ZIP。',
    '2. 停止应用服务。',
    '3. 备份 dist/server/modules/ali-monthly-report、tools/ali-monthly-report、tools/ali-monthly-report-email 和 python/ali-monthly-report-packages。',
    '4. 删除旧 dist/server/modules/ali-monthly-report 和 python/ali-monthly-report-packages；保留 .env、.env.local、config.json、downloads、temp、日志与业务数据。',
    '5. 将 ZIP 解压到应用根目录并覆盖同名文件。',
    '6. 不需要运行 pip 或依赖安装脚本，直接按原方式重启服务。',
    '7. 浏览器 Ctrl+F5，确认收件人默认显示两个邮箱，再执行一次邮件发送。',
    '',
    '## 兼容范围',
    '',
    '- 仅适用于 CPython 3.12 / Windows x64。',
    '- 服务仍使用服务器原有邮箱、飞书和多维表凭据；本包不包含任何环境文件或密钥。',
    '',
    '## 回滚',
    '',
    '停止服务，恢复第 3 步备份后重新启动。'
  )
  Set-Content `
    -LiteralPath (Join-Path $stageDir $readmeRelativePath) `
    -Value $readmeLines `
    -Encoding UTF8

  $payloadPaths = @(Get-StageRelativePaths)
  $forbiddenPaths = @(
    $payloadPaths | Where-Object {
      $leaf = [IO.Path]::GetFileName($_)
      $certifiCaSuffix = 'certifi/cacert.pem'
      $isBundledCertifiCa =
        $_ -eq "$bundledPackagesRelativePath/$certifiCaSuffix"
      $hasForbiddenExtension =
        [IO.Path]::GetExtension($leaf) -in @(
          '.cer', '.crt', '.key', '.log', '.p12', '.pem', '.pfx', '.ts', '.tsx'
        )
      $_ -match '(^|/)(\.env[^/]*|node_modules|downloads|temp|logs|certs)(/|$)' -or
      $leaf -in @(
        'config.json',
        'credentials.json',
        'secrets.json'
      ) -or
      ($hasForbiddenExtension -and !$isBundledCertifiCa)
    }
  )
  if ($forbiddenPaths.Count -gt 0) {
    throw "Refusing to package forbidden path: $($forbiddenPaths[0])"
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
    packageType = 'ali-monthly-report-server-runtime-overlay'
    packageName = $packageName
    createdAt = (Get-Date).ToString('o')
    replaceDirectories = @(
      'dist/server/modules/ali-monthly-report',
      $bundledPackagesRelativePath
    )
    overwriteFiles = $runtimeFiles
    scope = @(
      'bundled-python-runtime',
          'email-complete-dependency-readiness',
          'default-email-recipients',
          'email-visible-copy-list',
          'scheduled-primary-and-catchup-only'
        )
    secretsIncluded = $false
    dependencyInstallRequired = $false
    dependencyReadinessCheckRequired = $true
    preinstalledPythonPackagesIncluded = $true
    pythonRuntimeTarget = 'cp312-win_amd64'
    files = $manifestFiles
  } | ConvertTo-Json -Depth 7 |
    Set-Content `
      -LiteralPath (Join-Path $stageDir $manifestRelativePath) `
      -Encoding UTF8

  $actualPaths = @(Get-StageRelativePaths)
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
    $pathDifferences = @(
      Compare-Object -ReferenceObject $actualPaths -DifferenceObject $archivePaths
    )
    if (
      $pathDifferences.Count -gt 0 -or
      @($archivePaths | Where-Object {
        $_.StartsWith('/') -or $_ -match '(^|/)\.\.(/|$)'
      }).Count -gt 0
    ) {
      throw 'ZIP entries do not exactly match the staged hotfix files.'
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

Write-Host '[OK] Ali monthly report server runtime hotfix created.' -ForegroundColor Green
Write-Host "[OK] Folder: $stageDir"
Write-Host "[OK] Zip: $zipPath"
Write-Host "[OK] SHA256: $archiveHash"
