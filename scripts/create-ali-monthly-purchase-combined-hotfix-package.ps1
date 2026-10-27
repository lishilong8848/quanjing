param(
  [string]$OutputDir = 'output/hotfix',
  [switch]$SkipBuild,
  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$WheelhousePath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$packageName = "ali-monthly-purchase-combined-hotfix-$timestamp"
$outputRoot = if ([IO.Path]::IsPathRooted($OutputDir)) {
  [IO.Path]::GetFullPath($OutputDir)
} else {
  [IO.Path]::GetFullPath((Join-Path $repoRoot $OutputDir))
}
$stageDir = Join-Path $outputRoot $packageName
$zipPath = Join-Path $outputRoot "$packageName.zip"
$sidecarPath = "$zipPath.sha256.txt"
$clientRelativePath = 'dist/client'
$aliServerModuleRelativePath = 'dist/server/modules/ali-monthly-report'
$purchaseServerModuleRelativePath = 'dist/server/modules/purchase-inventory'
$wheelhouseRelativePath = 'python/wheelhouse'
$readmeRelativePath = 'README_ALI_MONTHLY_PURCHASE_COMBINED_HOTFIX.md'
$manifestRelativePath = 'hotfix-manifest.json'
$serverRelativePaths = @(
  'dist/server/modules/ali-monthly-report/ali-monthly-report.controller.js',
  'dist/server/modules/ali-monthly-report/ali-monthly-report-feishu.js',
  'dist/server/modules/ali-monthly-report/ali-monthly-report.module.js',
  'dist/server/modules/ali-monthly-report/ali-monthly-report-task-coordinator.service.js',
  'dist/server/modules/ali-monthly-report/ali-monthly-report-task-state.js',
  'dist/server/modules/ali-monthly-report/ali-monthly-report.scheduler.js',
  'dist/server/modules/ali-monthly-report/ali-monthly-report.service.js',
  'dist/server/modules/purchase-inventory/purchase-application.validation.js',
  'dist/server/modules/purchase-inventory/purchase-application.service.js',
  'dist/server/modules/purchase-inventory/purchase-inventory.mapper.js'
)
$supportRelativePaths = @(
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
$expectedWheelFileNames = @(
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
  'werkzeug-3.1.8-py3-none-any.whl'
)
$clientMarkers = @(
  '三方比价',
  '单一采购',
  '单一原因',
  '提交中',
  'loading',
  'showSpinner',
  '打开文件',
  '定位文件',
  '飞书通知已发送',
  '飞书通知失败',
  '资料管理附件配置缺失',
  '/api/ali-monthly-report/files/',
  'scrollIntoView',
  'clientMutationId',
  'ali-monthly-bundle-',
  '正在下载并打包4项文件',
  'bundleItems',
  '最近一次成功结果（本次操作失败）'
)
$aliResultClientMarkers = @(
  '生成结果',
  'scroll-mt-20',
  'scrollIntoView',
  '打开文件',
  '定位文件',
  'clientMutationId',
  'ali-monthly-bundle-',
  '正在下载并打包4项文件',
  'bundleItems',
  '最近一次成功结果（本次操作失败）'
)

$wheelhouseCandidate = if ([IO.Path]::IsPathRooted($WheelhousePath)) {
  $WheelhousePath
} else {
  Join-Path $repoRoot $WheelhousePath
}
if (!(Test-Path -LiteralPath $wheelhouseCandidate -PathType Container)) {
  throw "Python wheelhouse directory is missing: $wheelhouseCandidate"
}
$resolvedWheelhousePath = (Resolve-Path -LiteralPath $wheelhouseCandidate).Path

function Assert-CompiledClientTreeContains {
  param(
    [string]$Root,
    [string[]]$Markers
  )

  if (!(Test-Path -LiteralPath $Root -PathType Container)) {
    throw "Compiled client directory was not found: $Root"
  }
  $textFiles = @(
    Get-ChildItem -LiteralPath $Root -File -Recurse |
      Where-Object {
        [IO.Path]::GetExtension($_.Name) -in @('.html', '.js', '.css')
      }
  )
  if ($textFiles.Count -lt 2) {
    throw "Compiled client tree is unexpectedly incomplete: $Root"
  }
  foreach ($marker in $Markers) {
    $found = @(
      Select-String `
        -LiteralPath $textFiles.FullName `
        -SimpleMatch `
        -Pattern $marker `
        -List
    ).Count -gt 0
    if (!$found) {
      throw "Compiled client tree is missing required marker: $marker"
    }
  }
}

function Assert-CompiledClientFileContainsAll {
  param(
    [string]$Root,
    [string[]]$Markers
  )

  $javascriptFiles = @(
    Get-ChildItem -LiteralPath $Root -File -Filter '*.js' -Recurse
  )
  foreach ($javascriptFile in $javascriptFiles) {
    $content = Get-Content -Raw -LiteralPath $javascriptFile.FullName -Encoding UTF8
    $containsAll = $true
    foreach ($marker in $Markers) {
      if (!$content.Contains($marker)) {
        $containsAll = $false
        break
      }
    }
    if ($containsAll) {
      return
    }
  }
  throw "Compiled client has no single file containing all required markers: $($Markers -join ', ')"
}

function Assert-CompiledFileContains {
  param(
    [string]$RelativePath,
    [string[]]$Markers
  )

  $fullPath = Join-Path $repoRoot $RelativePath
  if (!(Test-Path -LiteralPath $fullPath -PathType Leaf)) {
    throw "Compiled runtime file was not found: $fullPath"
  }
  $content = Get-Content -Raw -LiteralPath $fullPath -Encoding UTF8
  foreach ($marker in $Markers) {
    if (!$content.Contains($marker)) {
      throw "Compiled runtime is missing required marker '$marker': $RelativePath"
    }
  }
}

function Assert-CompiledFileDoesNotContain {
  param(
    [string]$RelativePath,
    [string[]]$Markers
  )

  $fullPath = Join-Path $repoRoot $RelativePath
  if (!(Test-Path -LiteralPath $fullPath -PathType Leaf)) {
    throw "Compiled runtime file was not found: $fullPath"
  }
  $content = Get-Content -Raw -LiteralPath $fullPath -Encoding UTF8
  foreach ($marker in $Markers) {
    if ($content.Contains($marker)) {
      throw "Compiled runtime contains forbidden marker '$marker': $RelativePath"
    }
  }
}

function Assert-ChildPath {
  param(
    [string]$Parent,
    [string]$Child
  )

  $parentFullPath = [IO.Path]::GetFullPath($Parent).TrimEnd('\', '/')
  $childFullPath = [IO.Path]::GetFullPath($Child)
  $parentPrefix = $parentFullPath + [IO.Path]::DirectorySeparatorChar
  if (
    $childFullPath.Equals(
      $parentFullPath,
      [StringComparison]::OrdinalIgnoreCase
    ) -or
    !$childFullPath.StartsWith(
      $parentPrefix,
      [StringComparison]::OrdinalIgnoreCase
    )
  ) {
    throw "Refusing to use a path outside the intended output directory: $Child"
  }
}

function Assert-SafePayloadPaths {
  param([string[]]$Paths)

  $forbiddenPathFragments = @(
    '/node_modules/',
    '/data/',
    '/downloads/',
    '/temp/',
    '/logs/',
    '/certs/',
    '/.runtime/',
    '/sourcemaps/',
    '/test/',
    '/tests/'
  )
  $forbiddenFileNames = @(
    'config.json',
    'credentials.json',
    'secrets.json',
    'package.json',
    'package-lock.json',
    'npm-shrinkwrap.json',
    'pnpm-lock.yaml',
    'yarn.lock'
  )
  $forbiddenExtensions = @(
    '.map',
    '.ts',
    '.tsx',
    '.spec',
    '.log',
    '.pem',
    '.cer',
    '.crt',
    '.cert',
    '.key',
    '.pfx',
    '.p12',
    '.7z',
    '.rar',
    '.zip',
    '.db',
    '.sqlite',
    '.sqlite3',
    '.xls',
    '.xlsx'
  )

  foreach ($path in $Paths) {
    $normalized = $path.Replace('\', '/').TrimStart('/')
    $guardPath = "/$normalized/"
    $leafName = [IO.Path]::GetFileName($normalized)
    $extension = [IO.Path]::GetExtension($normalized)
    $regexOptions =
      [Text.RegularExpressions.RegexOptions]::IgnoreCase -bor
      [Text.RegularExpressions.RegexOptions]::CultureInvariant
    $hasForbiddenPathFragment = @(
      $forbiddenPathFragments |
        Where-Object {
          $guardPath.IndexOf(
            $_,
            [StringComparison]::OrdinalIgnoreCase
          ) -ge 0
        }
    ).Count -gt 0
    $hasForbiddenFileName = @(
      $forbiddenFileNames |
        Where-Object {
          $leafName.Equals(
            $_,
            [StringComparison]::OrdinalIgnoreCase
          )
        }
    ).Count -gt 0
    $hasForbiddenExtension = @(
      $forbiddenExtensions |
        Where-Object {
          $extension.Equals(
            $_,
            [StringComparison]::OrdinalIgnoreCase
          )
        }
    ).Count -gt 0
    $hasEnvironmentSegment = [Text.RegularExpressions.Regex]::IsMatch(
      $normalized,
      '(^|/)\.env[^/]*(/|$)',
      $regexOptions
    )
    $hasSpecFileName = [Text.RegularExpressions.Regex]::IsMatch(
      $leafName,
      '(^|[.])spec([.]|$)',
      $regexOptions
    )
    if (
      [IO.Path]::IsPathRooted($path) -or
      $normalized -match '(^|/)\.\.(/|$)' -or
      $hasEnvironmentSegment -or
      $hasForbiddenPathFragment -or
      $hasForbiddenFileName -or
      $hasSpecFileName -or
      $hasForbiddenExtension
    ) {
      throw "Refusing to package forbidden path: $path"
    }
  }
}

function Assert-NoReparsePoints {
  param([string]$Root)

  if (!(Test-Path -LiteralPath $Root)) {
    throw "Required payload path was not found: $Root"
  }
  $rootItem = Get-Item -LiteralPath $Root -Force
  $items = @($rootItem)
  if ($rootItem.PSIsContainer) {
    $items += @(Get-ChildItem -LiteralPath $Root -Force -Recurse)
  }
  $reparsePoint = @(
    $items |
      Where-Object {
        $_.Attributes -band [IO.FileAttributes]::ReparsePoint
      }
  ) | Select-Object -First 1
  if ($reparsePoint) {
    throw "Refusing to package a reparse point: $($reparsePoint.FullName)"
  }
}

function Get-RelativeFilePaths {
  param(
    [string]$Root,
    [string]$Prefix
  )

  $rootFullPath = [IO.Path]::GetFullPath($Root).TrimEnd('\', '/')
  return @(
    Get-ChildItem -LiteralPath $Root -File -Recurse |
      ForEach-Object {
        $relative = $_.FullName.Substring($rootFullPath.Length)
        $relative = $relative.TrimStart('\', '/').Replace('\', '/')
        "$Prefix/$relative"
      } |
      Sort-Object
  )
}

function Get-StageRelativePaths {
  param([string]$Stage)

  $stageFullPath = [IO.Path]::GetFullPath($Stage).TrimEnd('\', '/')
  return @(
    Get-ChildItem -LiteralPath $Stage -File -Recurse |
      ForEach-Object {
        $relative = $_.FullName.Substring($stageFullPath.Length)
        $relative.TrimStart('\', '/').Replace('\', '/')
      } |
      Sort-Object
  )
}

function Assert-ExactPathSet {
  param(
    [string[]]$Actual,
    [string[]]$Expected,
    [string]$FailureMessage
  )

  $actualPaths = @($Actual | Sort-Object)
  $expectedPaths = @($Expected | Sort-Object)
  if (
    $actualPaths.Count -ne $expectedPaths.Count -or
    @($actualPaths | Where-Object { $_ -notin $expectedPaths }).Count -gt 0 -or
    @($expectedPaths | Where-Object { $_ -notin $actualPaths }).Count -gt 0
  ) {
    throw $FailureMessage
  }
}

function Write-HotfixManifest {
  param(
    [string]$Stage,
    [string[]]$PayloadPaths
  )

  $files = @(
    $PayloadPaths | Sort-Object | ForEach-Object {
      $fullPath = Join-Path $Stage $_.Replace(
        '/',
        [IO.Path]::DirectorySeparatorChar
      )
      $item = Get-Item -LiteralPath $fullPath
      $fileHash = Get-FileHash -LiteralPath $fullPath -Algorithm SHA256
      [ordered]@{
        path = $_
        size = $item.Length
        sha256 = $fileHash.Hash.ToUpperInvariant()
      }
    }
  )
  [ordered]@{
    schemaVersion = 1
    package = $packageName
    packageType = 'ali-monthly-purchase-combined-runtime-overlay'
    createdAt = (Get-Date).ToString('o')
    distribution = 'internal-controlled-only'
    sourceBuild = if ($SkipBuild) { 'prebuilt-validated-production-output' } else { 'single-current-working-tree-production-build' }
    buildSkipped = [bool]$SkipBuild
    replaceDirectories = @(
      $clientRelativePath,
      $aliServerModuleRelativePath,
      $purchaseServerModuleRelativePath,
      $wheelhouseRelativePath
    )
    replaceFiles = @($supportRelativePaths)
    scope = @(
      'ali-monthly-report-generated-file-open-and-reveal',
      'ali-monthly-report-feishu-download-notification',
      'ali-monthly-report-feishu-bitable-record-notification',
      'ali-monthly-report-real-base-record-token-links',
      'ali-monthly-report-dual-group-interactive-cards',
      'ali-monthly-report-alarm-bitable-sync',
      'ali-monthly-report-over-power-bitable-sync',
      'ali-monthly-report-staff-change-bitable-sync',
      'ali-monthly-report-monthly-third-0900-shanghai-scheduler',
      'ali-monthly-report-hourly-failed-item-retry',
      'ali-monthly-report-durable-automation-state',
      'ali-monthly-report-top5-core-download',
      'ali-monthly-report-filtered-target-record-search',
      'ali-monthly-report-four-item-bitable-bundle-feishu-file-delivery',
      'ali-monthly-report-four-item-lightweight-concurrent-download',
      'ali-monthly-report-four-item-transient-download-retry',
      'ali-monthly-report-default-email-recipient',
      'ali-monthly-report-python-offline-dependencies',
      'purchase-procurement-form-three-way-or-single',
      'purchase-single-reason-and-attachment-selection',
      'purchase-submit-loading-and-duplicate-protection',
      'purchase-complete-compiled-server-module'
    )
    secretsIncluded = $false
    operationalIdentifiersIncluded = $true
    dependencyInstallRequired = $true
    dependencyReadinessCheckRequired = $true
    offlineWheelhouseIncluded = $true
    offlineWheelhouseTarget = 'cp312-win_amd64'
    files = $files
  } | ConvertTo-Json -Depth 7 |
    Set-Content `
      -LiteralPath (Join-Path $Stage $manifestRelativePath) `
      -Encoding UTF8
}

function Assert-HotfixManifest {
  param(
    [string]$Stage,
    [string[]]$PayloadPaths
  )

  $manifestPath = Join-Path $Stage $manifestRelativePath
  $manifest = Get-Content -Raw -LiteralPath $manifestPath -Encoding UTF8 |
    ConvertFrom-Json
  if (
    $manifest.secretsIncluded -ne $false -or
    $manifest.offlineWheelhouseIncluded -ne $true -or
    $manifest.offlineWheelhouseTarget -ne 'cp312-win_amd64'
  ) {
    throw 'Hotfix manifest safety or dependency metadata is invalid.'
  }
  $manifestFiles = @($manifest.files)
  Assert-ExactPathSet `
    -Actual @($manifestFiles | ForEach-Object { $_.path }) `
    -Expected $PayloadPaths `
    -FailureMessage 'Hotfix manifest entries do not match the payload files.'
  foreach ($entry in $manifestFiles) {
    $fullPath = Join-Path $Stage ([string]$entry.path).Replace(
      '/',
      [IO.Path]::DirectorySeparatorChar
    )
    $item = Get-Item -LiteralPath $fullPath
    if ([long]$entry.size -ne $item.Length) {
      throw "Hotfix manifest size mismatch: $($entry.path)"
    }
    $fileHash = Get-FileHash -LiteralPath $fullPath -Algorithm SHA256
    if (
      $fileHash.Hash.ToUpperInvariant() -ne
      ([string]$entry.sha256).ToUpperInvariant()
    ) {
      throw "Hotfix manifest hash mismatch: $($entry.path)"
    }
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

function Get-ValidatedWheelFiles {
  param([string]$Source)

  Assert-NoReparsePoints -Root $Source
  $unexpectedItems = @(
    Get-ChildItem -LiteralPath $Source -Force |
      Where-Object {
        $_.PSIsContainer -or
        !$_.Extension.Equals('.whl', [StringComparison]::OrdinalIgnoreCase)
      }
  )
  if ($unexpectedItems.Count -gt 0) {
    throw "Python wheelhouse contains a non-wheel item: $($unexpectedItems[0].Name)"
  }
  $wheelFiles = @(
    Get-ChildItem -LiteralPath $Source -File -Filter '*.whl' |
      Sort-Object Name
  )
  if ($wheelFiles.Count -eq 0) {
    throw "Python wheelhouse contains no .whl files: $Source"
  }
  $duplicateNames = @(
    $wheelFiles |
      Group-Object { $_.Name.ToLowerInvariant() } |
      Where-Object { $_.Count -gt 1 }
  )
  if ($duplicateNames.Count -gt 0) {
    throw "Python wheelhouse contains duplicate file names: $($duplicateNames[0].Name)"
  }
  Assert-ExactPathSet `
    -Actual @($wheelFiles | ForEach-Object { $_.Name }) `
    -Expected $expectedWheelFileNames `
    -FailureMessage 'Python wheelhouse file set is incomplete or incompatible.'
  return $wheelFiles
}

function Copy-RequiredWheelhouse {
  param(
    [System.IO.FileInfo[]]$WheelFiles,
    [string]$Destination
  )

  New-Item -ItemType Directory -Force -Path $Destination | Out-Null
  foreach ($wheelFile in $WheelFiles) {
    Copy-RequiredFile `
      -Source $wheelFile.FullName `
      -Destination (Join-Path $Destination $wheelFile.Name)
  }
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

function Assert-TypeScriptRuntimeOutputsAreFresh {
  param(
    [string]$SourceRoot,
    [string]$OutputRoot
  )

  $sourceRootFullPath = [IO.Path]::GetFullPath($SourceRoot).TrimEnd('\', '/')
  $outputRootFullPath = [IO.Path]::GetFullPath($OutputRoot).TrimEnd('\', '/')
  $sourceFiles = @(
    Get-ChildItem -LiteralPath $sourceRootFullPath -File -Filter '*.ts' -Recurse |
      Where-Object { $_.Name -notmatch '[.](spec|test)[.]ts$' }
  )
  foreach ($sourceFile in $sourceFiles) {
    $sourceRelativePath = $sourceFile.FullName.Substring(
      $sourceRootFullPath.Length
    ).TrimStart('\', '/')
    $runtimeRelativePath = [IO.Path]::ChangeExtension(
      $sourceRelativePath,
      '.js'
    )
    $runtimePath = Join-Path $outputRootFullPath $runtimeRelativePath
    if (!(Test-Path -LiteralPath $runtimePath -PathType Leaf)) {
      throw "Compiled runtime output is missing for source: $sourceRelativePath"
    }
    $runtimeFile = Get-Item -LiteralPath $runtimePath
    if ($runtimeFile.LastWriteTimeUtc -lt $sourceFile.LastWriteTimeUtc) {
      throw "Compiled runtime output is older than its source: $sourceRelativePath"
    }
  }
}

Set-Location $repoRoot
if (!$SkipBuild) {
  npm run build:prod
  if ($LASTEXITCODE -ne 0) {
    throw 'Production build failed; hotfix package was not created.'
  }
}
$purchaseServerModuleRoot = Join-Path $repoRoot $purchaseServerModuleRelativePath
if (!(Test-Path -LiteralPath $purchaseServerModuleRoot -PathType Container)) {
  throw "Compiled purchase server module was not found: $purchaseServerModuleRoot"
}
$purchaseSourceModuleRoot = Join-Path $repoRoot 'server/modules/purchase-inventory'
if (!(Test-Path -LiteralPath $purchaseSourceModuleRoot -PathType Container)) {
  throw "Purchase server source module was not found: $purchaseSourceModuleRoot"
}
$purchaseServerRelativePaths = @(
  Get-ChildItem -LiteralPath $purchaseServerModuleRoot -File -Filter '*.js' -Recurse |
    Where-Object { $_.Name -notmatch '[.](spec|test)[.]js$' } |
    ForEach-Object {
      $_.FullName.Substring($repoRoot.Length).TrimStart('\', '/').Replace('\', '/')
    } |
    Sort-Object -Unique
)
if ($purchaseServerRelativePaths.Count -eq 0) {
  throw 'Compiled purchase server module contains no JavaScript runtime files.'
}
$expectedPurchaseServerRelativePaths = @(
  Get-ChildItem -LiteralPath $purchaseSourceModuleRoot -File -Filter '*.ts' -Recurse |
    Where-Object { $_.Name -notmatch '[.](spec|test)[.]ts$' } |
    ForEach-Object {
      $sourceRelativePath = $_.FullName.Substring(
        $purchaseSourceModuleRoot.Length
      ).TrimStart('\', '/').Replace('\', '/')
      $runtimeRelativePath = [IO.Path]::ChangeExtension(
        $sourceRelativePath,
        '.js'
      ).Replace('\', '/')
      "$purchaseServerModuleRelativePath/$runtimeRelativePath"
    } |
    Sort-Object -Unique
)
Assert-ExactPathSet `
  -Actual $purchaseServerRelativePaths `
  -Expected $expectedPurchaseServerRelativePaths `
  -FailureMessage 'Compiled purchase server runtime does not match its non-test TypeScript sources.'
Assert-TypeScriptRuntimeOutputsAreFresh `
  -SourceRoot $purchaseSourceModuleRoot `
  -OutputRoot $purchaseServerModuleRoot
$allServerRelativePaths = @(
  @($serverRelativePaths) + @($purchaseServerRelativePaths) |
    Sort-Object -Unique
)
Assert-SkipBuildOutputsAreFresh `
    -SourcePaths @(
      'client/src/pages/AliMonthlyReport',
      'client/src/pages/PurchaseInventoryManagement',
      'client/src/api/index.ts',
      'shared/api.interface.ts',
      'shared/purchase-application.interface.ts',
      'shared/purchase-inventory.interface.ts'
    ) `
    -OutputPaths @(
      'dist/client/index.html',
      'dist/client/main.js'
    )
Assert-SkipBuildOutputsAreFresh `
    -SourcePaths @(
      'server/modules/ali-monthly-report/ali-monthly-report.controller.ts'
    ) `
    -OutputPaths @($serverRelativePaths[0])
Assert-SkipBuildOutputsAreFresh `
    -SourcePaths @(
      'server/modules/ali-monthly-report/ali-monthly-report-feishu.ts'
    ) `
    -OutputPaths @($serverRelativePaths[1])
Assert-SkipBuildOutputsAreFresh `
    -SourcePaths @(
      'server/modules/ali-monthly-report/ali-monthly-report.module.ts'
    ) `
    -OutputPaths @($serverRelativePaths[2])
Assert-SkipBuildOutputsAreFresh `
    -SourcePaths @(
      'server/modules/ali-monthly-report/ali-monthly-report-task-coordinator.service.ts',
      'server/modules/ali-monthly-report/ali-monthly-report-task-state.ts'
    ) `
    -OutputPaths @($serverRelativePaths[3])
Assert-SkipBuildOutputsAreFresh `
    -SourcePaths @(
      'server/modules/ali-monthly-report/ali-monthly-report-task-state.ts'
    ) `
    -OutputPaths @($serverRelativePaths[4])
Assert-SkipBuildOutputsAreFresh `
    -SourcePaths @(
      'server/modules/ali-monthly-report/ali-monthly-report.scheduler.ts',
      'server/modules/ali-monthly-report/ali-monthly-report-task-coordinator.service.ts'
    ) `
    -OutputPaths @($serverRelativePaths[5])
Assert-SkipBuildOutputsAreFresh `
    -SourcePaths @(
      'server/modules/ali-monthly-report/ali-monthly-report.service.ts',
      'server/modules/ali-monthly-report/ali-monthly-report-feishu.ts'
    ) `
    -OutputPaths @($serverRelativePaths[6])
Assert-SkipBuildOutputsAreFresh `
    -SourcePaths @(
      'server/modules/purchase-inventory/purchase-application.validation.ts'
    ) `
    -OutputPaths @(
      $serverRelativePaths[7],
      $serverRelativePaths[8]
    )
Assert-SkipBuildOutputsAreFresh `
    -SourcePaths @(
      'server/modules/purchase-inventory/purchase-application.service.ts',
      'server/modules/purchase-inventory/purchase-application.validation.ts',
      'server/modules/purchase-inventory/purchase-inventory.mapper.ts',
      'shared/purchase-application.interface.ts',
      'shared/purchase-inventory.interface.ts'
    ) `
    -OutputPaths @($serverRelativePaths[8])
Assert-SkipBuildOutputsAreFresh `
    -SourcePaths @(
      'server/modules/purchase-inventory/purchase-inventory.mapper.ts',
      'shared/purchase-inventory.interface.ts'
    ) `
    -OutputPaths @($serverRelativePaths[9])
$clientRoot = Join-Path $repoRoot $clientRelativePath
foreach ($requiredClientFile in @('index.html', 'main.js')) {
  $requiredPath = Join-Path $clientRoot $requiredClientFile
  if (!(Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
    throw "Required compiled client entry was not found: $requiredPath"
  }
}
Assert-CompiledClientTreeContains -Root $clientRoot -Markers $clientMarkers
Assert-CompiledClientFileContainsAll `
  -Root $clientRoot `
  -Markers $aliResultClientMarkers

Assert-CompiledFileContains -RelativePath $serverRelativePaths[0] -Markers @(
  'files/:fileId/open',
  'files/:fileId/reveal',
  'public-files/:fileId',
  'openapi.ApiResponse'
)
Assert-CompiledFileContains -RelativePath $serverRelativePaths[1] -Markers @(
  'ali-monthly-report-public-download-v1',
  'buildAliMonthlyReportPublicDownloadUrl',
  'verifyAliMonthlyReportDownload',
  'buildAliMonthlyReportManualSuccessCard',
  'buildAliMonthlyReportAutomationCard'
)
Assert-CompiledFileContains -RelativePath $serverRelativePaths[2] -Markers @(
  'AliMonthlyReportModule',
  'AliMonthlyReportController',
  'AliMonthlyReportService'
)
Assert-CompiledFileContains -RelativePath $serverRelativePaths[3] -Markers @(
  'ALI_MONTHLY_REPORT_AUTOMATION_TYPES',
  'Promise.allSettled',
  'sendAutomationSummary',
  'lastNotifiedFingerprint'
)
Assert-CompiledFileContains -RelativePath $serverRelativePaths[4] -Markers @(
  'ALI_MONTHLY_REPORT_AUTOMATION_STATE_PATH',
  'nantong-schedule-state',
  'ali-monthly-report-task-state.json',
  'renameSync'
)
Assert-CompiledFileContains -RelativePath $serverRelativePaths[5] -Markers @(
  'ALI_MONTHLY_REPORT_SCHEDULER_ENABLED',
  'resolveLatestDueAliMonthlyReportPeriod',
  'setInterval'
)
Assert-CompiledFileContains -RelativePath $serverRelativePaths[6] -Markers @(
  'python_dependency_probe.py',
  'Python 依赖未就绪',
  'pythonDependenciesPromises',
  'ALARM_REPORT_TABLE_ID',
  'STAFF_REPORT_TABLE_ID',
  'buildBitableUploadLogs',
  'bitableRecordUrls',
  '同步到资料管理告警分析表',
  'process.cwd(), configured',
  '../../common/config/external-services.config',
  'resolvePromise({ stdout, stderr: safeStderr })',
  'ALI_MONTHLY_REPORT_FEISHU_CHAT_IDS',
  'ALI_MONTHLY_REPORT_AUTOMATION_CHAT_ID',
  'Promise.allSettled',
  'sendAutomationSummary',
  "'interactive'",
  'performGeneratedFileAction',
  '已提交系统打开请求',
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
  'file'
)
Assert-CompiledFileDoesNotContain -RelativePath $serverRelativePaths[6] -Markers @(
  'pip install',
  '@server/'
)
Assert-CompiledFileContains -RelativePath $serverRelativePaths[7] -Markers @(
  '单一原因',
  '采购形式',
  'procurementForm'
)
Assert-CompiledFileContains -RelativePath $serverRelativePaths[8] -Markers @(
  'selectComparisonFiles',
  'procurementForm'
)
Assert-CompiledFileContains -RelativePath $serverRelativePaths[9] -Markers @(
  '单一原因',
  '三方比价',
  '单一采购'
)
Assert-CompiledFileContains -RelativePath 'tools/ali-monthly-report/requirements.txt' -Markers @(
  'openpyxl',
  'requests'
)
Assert-CompiledFileContains -RelativePath 'tools/ali-monthly-report/python_dependency_probe.py' -Markers @(
  "'core':",
  "'over_power':",
  "'legacy':",
  'missing_or_broken'
)
Assert-CompiledFileContains -RelativePath 'tools/ali-monthly-report/four_item_bundle_runner.py' -Markers @(
  'select_bundle_attachments',
  '仅下载选中的 4 个文件',
  'ThreadPoolExecutor',
  'urllib.request',
  'EXPECTED_CATEGORIES',
  'MAX_DOWNLOAD_ATTEMPTS',
  'is_retryable_download_http_error'
)
Assert-CompiledFileContains -RelativePath 'tools/ali-monthly-report/monthly_report_runner.py' -Markers @(
  'ali_monthly_reports.cli'
)
Assert-CompiledFileContains -RelativePath 'tools/ali-monthly-report/ali_monthly_reports/config.py' -Markers @(
  'DEFAULT_ALARM_REPORT_TABLE',
  'alarm_report_table_id',
  'DEFAULT_STAFF_REPORT_TABLE',
  'staff_report_table_id'
)
Assert-CompiledFileContains -RelativePath 'tools/ali-monthly-report/config.example.json' -Markers @(
  'staff_report_table_id',
  'staff_report_view_id'
)
Assert-CompiledFileContains -RelativePath 'tools/ali-monthly-report/ali_monthly_reports/feishu.py' -Markers @(
  'sync_alarm_report_attachment',
  'sync_report_attachment',
  'sync_staff_report_attachment',
  'build_bitable_record_url',
  '/records/search',
  'upload_bitable_file',
  'generated_and_uploaded'
)
Assert-CompiledFileContains -RelativePath 'tools/ali-monthly-report/ali_monthly_reports/reports.py' -Markers @(
  'alarm_attachment_syncer',
  'generate_high_power_top5_report',
  'staff_attachment_syncer'
)
Assert-CompiledFileContains -RelativePath 'tools/ali-monthly-report/ali_monthly_reports/cli.py' -Markers @(
  'high_power_top5'
)
Assert-CompiledFileContains -RelativePath 'tools/ali-monthly-report/ali_monthly_reports/staff.py' -Markers @(
  '实习生及备岗',
  '本月新增人员姓名',
  '其他人员'
)
Assert-CompiledFileContains -RelativePath 'tools/ali-monthly-report-email/app.py' -Markers @(
  '/api/local_file/open',
  '已提交系统打开请求',
  '实习生及备岗',
  'STAFF_REPORT_TABLE_NAME',
  '人员变动报告',
  'download_monthly_bundle_report_files',
  'build_monthly_bundle_zip',
  'FEISHU_MESSAGE_FILE_MAX_BYTES',
  'require_unique_latest',
  'filter_records_by_year_month',
  'record_year == target_year and record_month == month_number',
  'expected_categories',
  '每类1个'
)
Assert-CompiledFileContains -RelativePath 'tools/ali-monthly-report-email/ali_alarm_report_generator.py' -Markers @(
  'generate_alarm_report'
)
Assert-CompiledFileContains -RelativePath 'tools/ali-monthly-report-email/ali_over_power_report_generator.py' -Markers @(
  'generate_over_power_report'
)
Assert-CompiledFileContains -RelativePath 'tools/ali-monthly-report-email/templates/index.html' -Markers @(
  'generatedFileActionInFlight',
  '正在打开...',
  '定位文件'
)

Assert-NoReparsePoints -Root $clientRoot
foreach ($relativePath in @($allServerRelativePaths) + @($supportRelativePaths)) {
  Assert-NoReparsePoints -Root (Join-Path $repoRoot $relativePath)
}
$wheelFiles = @(Get-ValidatedWheelFiles -Source $resolvedWheelhousePath)

$expectedClientPaths = Get-RelativeFilePaths `
  -Root $clientRoot `
  -Prefix $clientRelativePath
$expectedWheelPaths = @(
  $wheelFiles | ForEach-Object {
    "$wheelhouseRelativePath/$($_.Name)"
  }
)
$expectedPayloadPaths = @($expectedClientPaths) +
  @($allServerRelativePaths) +
  @($supportRelativePaths) +
  @($expectedWheelPaths) +
  @($readmeRelativePath)
Assert-SafePayloadPaths -Paths $expectedPayloadPaths

$readmeLines = @(
  '# 阿里月报 + 采购页面优化联合热包',
  '',
  '> 仅限公司内部受控部署。本包把两个任务的运行文件固定在同一次生产构建中，不能与其他版本前端资源混搭。',
  '',
  '## 包含改动',
  '',
  '- 一份完整 `dist/client`：同时包含阿里月报生成结果打开/定位、飞书通知状态，以及采购申请“三方比价 / 单一采购”交互。',
  '- 阿里月报服务端：告警分析、超功率和人员变动上传资料管理多维表；手动成功向双群发送互动卡片，按钮直接打开真实 Base 记录。',
  '- Base app token 在 Python 成功结果中仅供内存解析，生成真实记录链接，不再出现 `/base/***`。',
  '- 阿里月报工具：告警分析和人员变动按年月更新或新建多维表记录、TOP5 直取、独立版文件操作入口、离线依赖安装；人员变动配置示例随包提供。',
  '- 一键打包四项：使用标准库轻量下载器并发从资料管理多维表各下载 1 份超功率、TOP5、告警分析和人员变动文件，不执行月报 Python 依赖预检；生成唯一 ZIP，并将同一 ZIP 文件发送到配置的会话群和马进宇。',
  '- 飞书附件短暂返回 `Data not ready` 时按 1/2/4 秒有限退避重试，仍受单文件 90 秒总上限保护。',
  '- “文件与邮件”默认收件人为 `ma.jinyu@vnet.com`，服务器无本地配置时仍与本地页面一致，环境变量可覆盖。',
  '- 每月 3 日 09:00（Asia/Shanghai）自动生成上月告警分析、超功率和人员变动；三项并行后只向自动任务群发送一次汇总卡片。',
  '- 失败项每小时重试；相同失败摘要不重复刷群，成功项不会重复生成；生产状态持久化到发布目录同级 `nantong-schedule-state`。',
  '- 采购申请：采购形式、单一原因、附件选择、提交中即时反馈与防重复提交。',
  '- 采购服务端：完整 `dist/server/modules/purchase-inventory` JavaScript 运行模块，避免最新采购前端与旧 controller/service 混用。',
  '- `python/wheelhouse`：CPython 3.12 / Windows x64 离线 wheel，解决服务器访问 PyPI 超时。',
  '',
  '## 部署',
  '',
  '1. 使用同名 `.sha256.txt` 校验 ZIP。',
  '2. 停止应用服务。',
  '3. 备份完整 `dist/client`、完整 `dist/server/modules/ali-monthly-report`、完整 `dist/server/modules/purchase-inventory` 和清单列出的全部工具文件；如存在，备份现有 `python/wheelhouse`。',
  '4. 删除旧 `dist/client`，避免残留内容哈希不同的前端 chunk。',
  '5. 删除旧 `dist/server/modules/ali-monthly-report` 和旧 `dist/server/modules/purchase-inventory`；删除旧 `python/wheelhouse`，再将 ZIP 解压到应用根目录并覆盖同名路径。',
  '6. 不要覆盖现有 `.env`、`.env.local`、config.json、业务数据、下载结果或日志；不要删除发布目录同级 `nantong-schedule-state`。',
  '7. 在服务器现有环境文件中确认 `ALI_MONTHLY_REPORT_PUBLIC_BASE_URL`（或 `PUBLIC_BASE_URL`）为外部可访问的 HTTPS 应用基址。',
  '8. 配置 `ALI_MONTHLY_REPORT_FEISHU_CHAT_IDS` 作为手动成功互动卡片的群 ID 列表；旧 `ALI_MONTHLY_REPORT_FEISHU_CHAT_ID` 仍兼容。',
  '9. 可选配置 `ALI_MONTHLY_REPORT_FEISHU_MA_JINYU_OPEN_ID`；设置后优先按该 open_id 将四项 ZIP 发送给马进宇。',
  '10. 可选配置 `ALI_MONTHLY_REPORT_FEISHU_MA_JINYU_EMAIL`；未配置 open_id 时按该邮箱发送，未设置则使用程序默认的马进宇企业邮箱。',
  '11. 配置 `ALI_MONTHLY_REPORT_AUTOMATION_CHAT_ID` 作为每月自动任务汇总卡片的唯一目标群，并确认 `ALI_MONTHLY_REPORT_FEISHU_APP_ID`、`ALI_MONTHLY_REPORT_FEISHU_APP_SECRET`。',
  '12. 配置 `STAFF_REPORT_TABLE_ID`、`STAFF_REPORT_VIEW_ID`；可参考 `tools/ali-monthly-report/config.example.json`，不要把环境文件或凭据放进热包。',
  '13. 确认 `ALI_ALARM_TEMPLATE_PATH` 指向服务器既有告警模板，并在启动前检查告警模板文件存在且可读；本包不包含业务 XLSX 模板，避免覆盖用户模板。',
  '14. `ALI_MONTHLY_REPORT_SCHEDULER_ENABLED` 默认启用；仅需停用自动任务时设为 `false`。`ALI_MONTHLY_REPORT_AUTOMATION_STATE_PATH` 可覆盖默认持久状态路径。',
  '15. 推荐另设至少 32 字节随机值的 `ALI_MONTHLY_REPORT_DOWNLOAD_SIGNING_SECRET`，并确认 `ALI_POWER_ALERT_CONFIG_PATH` 指向服务器现有超功耗配置文件。',
  '16. 推荐执行 `C:\Program Files\Python312\python.exe -m venv .venv-ali-report` 创建专用环境。',
  '17. 执行 `$python = (Resolve-Path ''.venv-ali-report\Scripts\python.exe'').Path`。',
  '18. 执行 `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install-ali-monthly-report-python-deps.ps1 -Python $python`；脚本会自动使用本包离线 wheelhouse，不访问 PyPI。',
  '19. 将同一个 `$python` 绝对路径写入服务器最终生效的 `.env` / `.env.local` 的 `ALI_MONTHLY_REPORT_PYTHON`。',
  '20. 使用原有方式启动应用，浏览器按 Ctrl+F5；自动任务按 Asia/Shanghai 每月 3 日 09:00 计算上个月。',
  '',
  '## 验收',
  '',
  '- 阿里月报：分别生成告警分析、超功率和人员变动，确认资料管理多维表同年月记录已覆盖或新增；双群卡片按钮均能打开真实记录，不出现 `/base/***` 或服务器 public-files 签名链接。',
  '- 一键打包4项文件：确认结果区列出超功率、TOP5、告警分析、人员变动各 1 份，ZIP 文件发送到配置的会话群和马进宇，重复点击不会重复创建或投递。',
  '- 自动任务：在受控测试时钟下验证三项并行、成功/部分失败/失败汇总、失败项每小时重试和相同失败不重复通知。',
  '- 采购页面：确认可切换“三方比价 / 单一采购”；单一采购显示必填“单一原因”且不提交隐藏的比价附件。',
  '- 采购提交：受控提交一次，确认出现“提交中”反馈且不会重复创建采购单。',
  '',
  '## 回滚',
  '',
  '停止服务，删除本次部署的完整 `dist/client`、`dist/server/modules/ali-monthly-report`、`dist/server/modules/purchase-inventory` 和 `python/wheelhouse`，恢复第 3 步备份的目录与文件，保留 `nantong-schedule-state`，重新启动服务并按 Ctrl+F5。',
  '',
  '## 边界与排除项',
  '',
  '- 完整前端来自当前工作区同一次生产构建，因此它代表当前前端基线；不要覆盖到结构明显不同的旧版本后端。',
  '- wheelhouse 仅适用于 CPython 3.12 / Windows x64。',
  '- 本包不包含 `.env`、密钥、证书、config.json、业务数据、生成月报、日志、测试、TypeScript 源码、声明文件、source map、node_modules 或启动/停止脚本。',
  '- 飞书应用密钥和下载签名密钥仍只配置在服务器既有环境文件中。'
)

Assert-ChildPath -Parent $outputRoot -Child $stageDir
Assert-ChildPath -Parent $outputRoot -Child $zipPath
Assert-ChildPath -Parent $outputRoot -Child $sidecarPath

New-Item -ItemType Directory -Force -Path $outputRoot | Out-Null
Assert-NoReparsePoints -Root $outputRoot
if (
  (Test-Path -LiteralPath $stageDir) -or
  (Test-Path -LiteralPath $zipPath) -or
  (Test-Path -LiteralPath $sidecarPath)
) {
  throw "Hotfix output already exists: $packageName"
}

$stageCreated = $false
$archiveHash = ''
try {
  New-Item -ItemType Directory -Path $stageDir | Out-Null
  $stageCreated = $true

  Copy-RequiredDirectory `
    -Source $clientRoot `
    -Destination (Join-Path $stageDir $clientRelativePath)
  foreach ($relativePath in @($allServerRelativePaths) + @($supportRelativePaths)) {
    Copy-RequiredFile `
      -Source (Join-Path $repoRoot $relativePath) `
      -Destination (Join-Path $stageDir $relativePath)
  }
  Copy-RequiredWheelhouse `
    -WheelFiles $wheelFiles `
    -Destination (Join-Path $stageDir $wheelhouseRelativePath)
  Set-Content `
    -LiteralPath (Join-Path $stageDir $readmeRelativePath) `
    -Value $readmeLines `
    -Encoding UTF8

  $stagedPayloadPaths = Get-StageRelativePaths -Stage $stageDir
  Assert-ExactPathSet `
    -Actual $stagedPayloadPaths `
    -Expected $expectedPayloadPaths `
    -FailureMessage 'Hotfix staging contains an unexpected or missing file.'
  Assert-SafePayloadPaths -Paths $stagedPayloadPaths
  Assert-NoReparsePoints -Root $stageDir

  Write-HotfixManifest `
    -Stage $stageDir `
    -PayloadPaths $stagedPayloadPaths
  Assert-HotfixManifest `
    -Stage $stageDir `
    -PayloadPaths $stagedPayloadPaths

  $actualStagePaths = Get-StageRelativePaths -Stage $stageDir
  $expectedStagePaths = @($expectedPayloadPaths) + @($manifestRelativePath)
  Assert-ExactPathSet `
    -Actual $actualStagePaths `
    -Expected $expectedStagePaths `
    -FailureMessage 'Hotfix staging contains an unexpected or missing file.'
  Assert-SafePayloadPaths -Paths $actualStagePaths

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
      @(
        $archivePaths |
          Where-Object {
            $_.StartsWith('/') -or $_ -match '(^|/)\.\.(/|$)'
          }
      ).Count -gt 0
    ) {
      throw 'ZIP contains an unsafe entry path.'
    }
    $duplicateArchivePaths = @(
      $archivePaths |
        Group-Object { $_.ToLowerInvariant() } |
        Where-Object { $_.Count -gt 1 }
    )
    if ($duplicateArchivePaths.Count -gt 0) {
      throw 'ZIP contains a duplicate entry path.'
    }
    Assert-ExactPathSet `
      -Actual $archivePaths `
      -Expected $actualStagePaths `
      -FailureMessage 'ZIP entries do not exactly match the staged hotfix files.'
  } finally {
    $archive.Dispose()
  }

  $zipHash = Get-FileHash -LiteralPath $zipPath -Algorithm SHA256
  $archiveHash = $zipHash.Hash.ToUpperInvariant()
  $sidecarValue = "$archiveHash  $([IO.Path]::GetFileName($zipPath))"
  Set-Content `
    -LiteralPath $sidecarPath `
    -Value $sidecarValue `
    -Encoding ASCII
  if (
    (Get-Content -Raw -LiteralPath $sidecarPath -Encoding ASCII).Trim() -ne
    $sidecarValue
  ) {
    throw 'ZIP SHA256 sidecar verification failed.'
  }
} catch {
  if ($stageCreated -and (Test-Path -LiteralPath $stageDir)) {
    Assert-ChildPath -Parent $outputRoot -Child $stageDir
    Remove-Item -LiteralPath $stageDir -Recurse -Force -ErrorAction SilentlyContinue
  }
  if ($stageCreated -and (Test-Path -LiteralPath $zipPath)) {
    Assert-ChildPath -Parent $outputRoot -Child $zipPath
    Remove-Item -LiteralPath $zipPath -Force -ErrorAction SilentlyContinue
  }
  if ($stageCreated -and (Test-Path -LiteralPath $sidecarPath)) {
    Assert-ChildPath -Parent $outputRoot -Child $sidecarPath
    Remove-Item -LiteralPath $sidecarPath -Force -ErrorAction SilentlyContinue
  }
  throw
}

Write-Host '[OK] Ali monthly report and purchase combined hotfix created.' -ForegroundColor Green
Write-Host "[OK] Folder: $stageDir"
Write-Host "[OK] Zip: $zipPath"
Write-Host "[OK] SHA256: $archiveHash"
