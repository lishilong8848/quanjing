[CmdletBinding()]
param(
  [string]$OutputRoot,
  [string]$ClientRoot,
  [switch]$SkipBuild
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.IO.Compression.FileSystem

$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
if ([string]::IsNullOrWhiteSpace($OutputRoot)) {
  $OutputRoot = Join-Path $projectRoot 'output\hotfix'
}
$outputRootPath = [System.IO.Path]::GetFullPath($OutputRoot)
[void](New-Item -ItemType Directory -Path $outputRootPath -Force)

$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$packageName = "nantong-weather-warning-lifecycle-hotfix-$timestamp"
$stageRoot = Join-Path $outputRootPath ".$packageName.stage"
$builtClientRoot = Join-Path $outputRootPath ".$packageName.client"
$archivePath = Join-Path $outputRootPath "$packageName.zip"
$hashPath = "$archivePath.sha256.txt"

foreach ($candidate in @($stageRoot, $builtClientRoot, $archivePath, $hashPath)) {
  if (Test-Path -LiteralPath $candidate) {
    throw "Refusing to overwrite existing hotfix output: $candidate"
  }
}

function Assert-ProjectFile {
  param([Parameter(Mandatory)][string]$RelativePath)

  $path = [System.IO.Path]::GetFullPath((Join-Path $projectRoot $RelativePath))
  $prefix = $projectRoot.TrimEnd([char[]]@('\', '/')) + [System.IO.Path]::DirectorySeparatorChar
  if (-not $path.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Hotfix source escapes the project root: $RelativePath"
  }
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
    throw "Required hotfix source is missing: $RelativePath"
  }
  return $path
}

function Copy-ProjectFile {
  param([Parameter(Mandatory)][string]$RelativePath)

  $source = Assert-ProjectFile -RelativePath $RelativePath
  $destination = Join-Path $stageRoot $RelativePath
  [void](New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force)
  Copy-Item -LiteralPath $source -Destination $destination
}

function Get-RelativeArchivePath {
  param(
    [Parameter(Mandatory)][string]$Root,
    [Parameter(Mandatory)][string]$Path
  )

  $rootFull = [System.IO.Path]::GetFullPath($Root).TrimEnd([char[]]@('\', '/'))
  $pathFull = [System.IO.Path]::GetFullPath($Path)
  $prefix = $rootFull + [System.IO.Path]::DirectorySeparatorChar
  if (-not $pathFull.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Hotfix file escapes its stage root: $Path"
  }
  return $pathFull.Substring($prefix.Length).Replace('\', '/')
}

function Assert-CompiledPauseBehavior {
  $markersByPath = [ordered]@{
    'dist/server/modules/weather-warning/weather-warning-feature.config.js' = @(
      'WEATHER_WARNING_REGISTRATION_ENABLED'
      'FEISHU_WEATHER_WARNING_PROGRESS_NOTIFICATIONS_ENABLED'
    )
    'dist/server/modules/weather-warning/weather-warning-registration-enabled.guard.js' = @(
      'registrationEnabled'
      'ServiceUnavailableException'
    )
    'dist/server/modules/weather-warning/weather-warning.controller.js' = @(
      'WeatherWarningRegistrationEnabledGuard'
      'registration/options'
      'features:'
    )
    'dist/server/modules/weather-warning/weather-warning-automation.service.js' = @(
      'progressNotificationsEnabled'
      'showProgress:'
      'buildWeatherWarningResolvedCard'
      'auto:resolved:'
      'pendingResolvedEvents'
    )
    'dist/server/modules/weather-warning/weather-warning-automation-state-store.js' = @(
      'pendingResolvedEvents'
      'version: 3'
    )
    'dist/server/modules/weather-warning/weather-warning-card.js' = @(
      '结束通报'
      '已结束'
    )
    'dist/server/modules/weather-warning/weather-warning-notification.service.js' = @(
      'progressNotificationsEnabled'
      'showProgress:'
      'guardCompletion'
    )
    'dist/server/modules/weather-warning/weather-warning.config.js' = @(
      'FEISHU_WEATHER_WARNING_CHECK_DEVICE_EVIDENCE_FIELD'
      'FEISHU_WEATHER_WARNING_CHECK_ENVIRONMENT_EVIDENCE_FIELD'
      'FEISHU_WEATHER_WARNING_CHECK_DISASTER_EVIDENCE_FIELD'
    )
    'dist/server/modules/weather-warning/weather-warning-bitable.service.js' = @(
      'guardCompletion'
      'completedBuildingCount'
      '缺少检查附件'
    )
    'dist/server/modules/weather-warning/weather-warning-snapshot.service.js' = @(
      'guardCompletion'
      'not_applicable'
    )
  }

  foreach ($entry in $markersByPath.GetEnumerator()) {
    $path = Assert-ProjectFile -RelativePath $entry.Key
    $source = [System.IO.File]::ReadAllText($path)
    foreach ($marker in $entry.Value) {
      if (-not $source.Contains($marker)) {
        throw "Compiled weather pause artifact is missing marker '$marker': $($entry.Key)"
      }
    }
  }
}

function Assert-WeatherRuntimeDependencyBoundary {
  param([Parameter(Mandatory)][string]$WeatherRoot)

  $allowedExistingDeploymentDependencies = @(
    'dist/server/common/access/unified-access.decorators.js'
    'dist/server/common/config/external-services.config.js'
    'dist/server/common/feishu/bitable-direct-read.js'
    'dist/server/modules/bitable-sync/bitable-sync.module.js'
    'dist/server/modules/bitable-sync/bitable-sync.service.js'
  )
  $packagedSharedDependencies = @(
    'dist/shared/api.interface.js'
  )

  foreach ($file in @(Get-ChildItem -LiteralPath $WeatherRoot -Recurse -File -Filter '*.js')) {
    $source = [System.IO.File]::ReadAllText($file.FullName)
    foreach ($match in [System.Text.RegularExpressions.Regex]::Matches(
      $source,
      'require\s*\(\s*["''](?<request>[^"'']+)["'']\s*\)'
    )) {
      $request = $match.Groups['request'].Value
      if (-not $request.StartsWith('.')) {
        continue
      }

      $candidateStem = [System.IO.Path]::GetFullPath((Join-Path $file.DirectoryName $request))
      $resolvedDependency = $null
      foreach ($candidate in @($candidateStem, "$candidateStem.js", (Join-Path $candidateStem 'index.js'))) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
          $resolvedDependency = $candidate
          break
        }
      }
      if ($null -eq $resolvedDependency) {
        throw "Missing compiled weather runtime dependency: $($file.FullName) -> $request"
      }

      $relativeDependency = Get-RelativeArchivePath -Root $projectRoot -Path $resolvedDependency
      if (
        $relativeDependency.StartsWith('dist/server/modules/weather-warning/', [System.StringComparison]::OrdinalIgnoreCase) -or
        $allowedExistingDeploymentDependencies -contains $relativeDependency -or
        $packagedSharedDependencies -contains $relativeDependency
      ) {
        continue
      }
      throw "Weather hotfix has an unexpected unshipped runtime dependency: $relativeDependency"
    }
  }
}

function Assert-PackageSafety {
  param([Parameter(Mandatory)][string]$Root)

  $files = @(Get-ChildItem -LiteralPath $Root -Recurse -File -Force)
  foreach ($file in $files) {
    $relativePath = Get-RelativeArchivePath -Root $Root -Path $file.FullName
    if ($relativePath.StartsWith('dist/server/modules/purchase-inventory/', [System.StringComparison]::OrdinalIgnoreCase)) {
      throw "Weather pause hotfix contains a purchase server module: $relativePath"
    }
    if ($file.Extension -in @('.map', '.ts', '.tsx', '.pem', '.key', '.pfx', '.p12')) {
      throw "Weather pause hotfix contains a blocked file type: $relativePath"
    }
    if ($file.Name -match '^\.env(?:\.|$)') {
      throw "Weather pause hotfix must not contain a live environment file: $relativePath"
    }
  }
}

try {
  if ($SkipBuild) {
    if ([string]::IsNullOrWhiteSpace($ClientRoot)) {
      throw '-ClientRoot is required when -SkipBuild is used'
    }
    $clientRootPath = [System.IO.Path]::GetFullPath($ClientRoot)
  } else {
    if (-not [string]::IsNullOrWhiteSpace($ClientRoot)) {
      throw '-ClientRoot cannot be combined with the default build mode'
    }

    Write-Host 'Building server production artifacts...'
    & npm.cmd run build:server
    if ($LASTEXITCODE -ne 0) {
      throw "Server build failed with exit code $LASTEXITCODE"
    }

    $clientBuilder = Assert-ProjectFile -RelativePath 'scripts/build-hotfix-client-with-frozen-purchase.mjs'
    $frozenPurchaseSourceMap = $null
    foreach ($relativeCandidate in @(
      'dist\sourcemaps\client\assets\3730.293a10f8.js.map'
      'release\nantong-schedule-20260730-073323\dist\sourcemaps\client\assets\3730.293a10f8.js.map'
      'release\nantong-schedule-20260803-084915\dist\sourcemaps\client\assets\3730.293a10f8.js.map'
    )) {
      $candidate = Join-Path $projectRoot $relativeCandidate
      if (Test-Path -LiteralPath $candidate -PathType Leaf) {
        $frozenPurchaseSourceMap = Assert-ProjectFile -RelativePath $relativeCandidate
        break
      }
    }
    if ($null -eq $frozenPurchaseSourceMap) {
      throw 'The hash-verified frozen purchase source map is missing from dist and release baselines'
    }
    Write-Host 'Building the client with the hash-verified frozen purchase snapshot...'
    & node $clientBuilder --output $builtClientRoot --source-map $frozenPurchaseSourceMap
    if ($LASTEXITCODE -ne 0) {
      throw "Frozen-purchase client build failed with exit code $LASTEXITCODE"
    }
    $clientRootPath = $builtClientRoot
  }

  if (-not (Test-Path -LiteralPath $clientRootPath -PathType Container)) {
    throw "Client build directory is missing: $clientRootPath"
  }
  $clientFiles = @(Get-ChildItem -LiteralPath $clientRootPath -Recurse -File -Force)
  if ($clientFiles.Count -eq 0) {
    throw 'Client build contains no files'
  }
  if (@($clientFiles | Where-Object { $_.Extension -eq '.map' }).Count -gt 0) {
    throw 'Client build contains source maps'
  }
  $combinedClientJavaScript = (@(
    $clientFiles |
      Where-Object { $_.Extension -eq '.js' } |
      ForEach-Object { [System.IO.File]::ReadAllText($_.FullName) }
  ) -join "`n")
  foreach ($marker in @(
    'registrationEnabled'
    'progressNotificationsEnabled'
    'guardCompletion'
    'border-blue-200 bg-blue-50 text-blue-800'
    'border-emerald-200 bg-emerald-50 text-emerald-800'
    '条戒备规则'
    '请按戒备要求执行'
  )) {
    if (-not $combinedClientJavaScript.Contains($marker)) {
      throw "Client build is missing weather pause marker: $marker"
    }
  }

  Assert-CompiledPauseBehavior

  [void](New-Item -ItemType Directory -Path $stageRoot)
  $stagedClientRoot = Join-Path $stageRoot 'dist\client'
  [void](New-Item -ItemType Directory -Path (Split-Path -Parent $stagedClientRoot) -Force)
  Copy-Item -LiteralPath $clientRootPath -Destination $stagedClientRoot -Recurse

  $weatherDistRoot = Join-Path $projectRoot 'dist\server\modules\weather-warning'
  if (-not (Test-Path -LiteralPath $weatherDistRoot -PathType Container)) {
    throw "Compiled weather warning directory is missing: $weatherDistRoot"
  }
  $compiledWeatherFiles = @(
    Get-ChildItem -LiteralPath $weatherDistRoot -Recurse -File -Force |
      Where-Object { $_.Extension -eq '.js' }
  )
  if ($compiledWeatherFiles.Count -eq 0) {
    throw 'Compiled weather warning directory contains no JavaScript files'
  }
  Assert-WeatherRuntimeDependencyBoundary -WeatherRoot $weatherDistRoot
  foreach ($file in $compiledWeatherFiles) {
    $relativeFromWeatherRoot = $file.FullName.Substring(
      $weatherDistRoot.TrimEnd([char[]]@('\', '/')).Length + 1
    )
    Copy-ProjectFile -RelativePath (Join-Path 'dist\server\modules\weather-warning' $relativeFromWeatherRoot)
  }
  Copy-ProjectFile -RelativePath 'dist/shared/api.interface.js'

  $envPatch = @(
    '# Copy these three lines into the target application .env.local before restarting.'
    'FEISHU_WEATHER_WARNING_AUTOMATION_ENABLED=true'
    'WEATHER_WARNING_REGISTRATION_ENABLED=false'
    'FEISHU_WEATHER_WARNING_PROGRESS_NOTIFICATIONS_ENABLED=false'
  ) -join [Environment]::NewLine
  [System.IO.File]::WriteAllText(
    (Join-Path $stageRoot 'weather-warning-pause.env.patch.example'),
    "$envPatch$([Environment]::NewLine)",
    [System.Text.UTF8Encoding]::new($false)
  )

  $readme = @(
    '# 南通天气预警生命周期专项热包'
    ''
    '本包仅供手工覆盖；不会自动连接、覆盖或重启公网服务。'
    ''
    '生效内容：首次戒备提醒仍保留；预警结束通报启用；戒备登记与戒备进度消息继续停用。登记源码和历史数据不会删除。'
    '页面增强：戒备标签跟随预警颜色；7 栋楼本轮必检项、必需附件和机房经理确认全部满足时，显示绿色“戒备完成”。'
    ''
    '手工操作：'
    '1. 停止目标程序，并备份 dist/client、dist/server/modules/weather-warning、dist/shared/api.interface.js 和 .env.local。'
    '2. 将压缩包内 dist 目录覆盖到目标程序根目录。'
    '3. 将 weather-warning-pause.env.patch.example 的三项配置写入目标程序 .env.local；两个暂停项必须为 false，自动化总开关必须为 true。'
    '4. 重新启动目标程序。'
    ''
    '验收：登记 options 与 registration 接口应返回 HTTP 503；快照 features 中两个暂停开关均为 false；首次提醒开关保持开启；有效预警由命中戒备到 fresh clear 时产生一次结束通报；蓝色预警的戒备标签为蓝色；全部 7 栋满足完成条件时显示“戒备完成”。'
    '首次提醒前置条件：目标环境必须已经配置普通预警群、重要事件通报群和负责人接收目标；本包不会写入或替换这些敏感标识。'
    ''
    '边界：前端采购页面使用哈希锁定的旧快照，本包不包含采购页面优化，也不包含采购服务端模块。'
  ) -join [Environment]::NewLine
  [System.IO.File]::WriteAllText(
    (Join-Path $stageRoot 'README.md'),
    $readme,
    [System.Text.UTF8Encoding]::new($false)
  )

  Assert-PackageSafety -Root $stageRoot

  $manifestFiles = @(
    Get-ChildItem -LiteralPath $stageRoot -Recurse -File -Force |
      Sort-Object FullName |
      ForEach-Object {
        [ordered]@{
          path = Get-RelativeArchivePath -Root $stageRoot -Path $_.FullName
          sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
          bytes = [Int64]$_.Length
        }
      }
  )
  $manifest = [ordered]@{
    package = $packageName
    generatedAt = (Get-Date).ToString('o')
    mode = 'manual-existing-deployment-overlay'
    scope = @(
      'weather-warning-registration-pause'
      'weather-warning-progress-notification-pause'
      'weather-warning-initial-notification-retained'
      'weather-warning-resolved-notification'
      'weather-warning-lifecycle-state-v3'
      'weather-warning-guard-completion'
      'weather-warning-color-presentation'
      'monthly-schedule-weather-ui'
    )
    excludedScope = @(
      'purchase-page-optimization'
      'purchase-server-modules'
      'runtime-data'
      'live-environment-files'
      'automatic-public-deployment'
    )
    purchaseSnapshotSha256 = '32b9015d7e84c5214638337afc3e88fd9279337d83661661437bcdc472a12acd'
    files = $manifestFiles
  }
  [System.IO.File]::WriteAllText(
    (Join-Path $stageRoot 'hotfix-manifest.json'),
    ($manifest | ConvertTo-Json -Depth 8),
    [System.Text.UTF8Encoding]::new($false)
  )

  Assert-PackageSafety -Root $stageRoot

  [System.IO.Compression.ZipFile]::CreateFromDirectory(
    $stageRoot,
    $archivePath,
    [System.IO.Compression.CompressionLevel]::Optimal,
    $false
  )

  $archiveHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
  [System.IO.File]::WriteAllText(
    $hashPath,
    "$archiveHash  $([System.IO.Path]::GetFileName($archivePath))$([Environment]::NewLine)",
    [System.Text.UTF8Encoding]::new($false)
  )

  Write-Host "Weather warning pause hotfix created: $archivePath"
  Write-Host "SHA-256: $archiveHash"
} finally {
  foreach ($temporaryPath in @($stageRoot, $builtClientRoot)) {
    $temporaryFull = [System.IO.Path]::GetFullPath($temporaryPath)
    $outputPrefix = $outputRootPath.TrimEnd([char[]]@('\', '/')) + [System.IO.Path]::DirectorySeparatorChar
    if (
      $temporaryFull.StartsWith($outputPrefix, [System.StringComparison]::OrdinalIgnoreCase) -and
      (Test-Path -LiteralPath $temporaryFull)
    ) {
      Remove-Item -LiteralPath $temporaryFull -Recurse -Force
    }
  }
}
