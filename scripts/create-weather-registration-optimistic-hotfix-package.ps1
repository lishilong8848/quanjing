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
$packageName = "nantong-weather-registration-optimistic-hotfix-$timestamp"
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
    Write-Host 'Building client with the hash-verified pre-optimization purchase snapshot...'
    & node $clientBuilder --output $builtClientRoot
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

  $javaScriptFiles = @($clientFiles | Where-Object { $_.Extension -eq '.js' })
  $combinedClientJavaScript = ($javaScriptFiles | ForEach-Object {
    [System.IO.File]::ReadAllText($_.FullName)
  }) -join "`n"
  foreach ($marker in @(
    '戒备登记已受理，正在后台同步'
    '按同一操作号重试'
    '提交戒备登记'
    'application/pdf'
  )) {
    if (-not $combinedClientJavaScript.Contains($marker)) {
      throw "Frozen-purchase client is missing weather registration marker: $marker"
    }
  }
  foreach ($marker in @('采购形式', '单一采购', '单一原因', '预警卡片测试')) {
    if ($combinedClientJavaScript.Contains($marker)) {
      throw "Frozen-purchase client contains excluded marker: $marker"
    }
  }

  [void](New-Item -ItemType Directory -Path $stageRoot)
  $stagedClientRoot = Join-Path $stageRoot 'dist\client'
  [void](New-Item -ItemType Directory -Path (Split-Path -Parent $stagedClientRoot) -Force)
  Copy-Item -LiteralPath $clientRootPath -Destination $stagedClientRoot -Recurse

  foreach ($relativePath in @(
    'dist/server/modules/weather-warning/weather-warning-registration.service.js'
    'dist/shared/api.interface.js'
  )) {
    Copy-ProjectFile -RelativePath $relativePath
  }

  $compiledServicePath = Join-Path $stageRoot 'dist\server\modules\weather-warning\weather-warning-registration.service.js'
  $compiledService = [System.IO.File]::ReadAllText($compiledServicePath)
  foreach ($marker in @('clientMutationId: payload.clientMutationId', "syncStatus: 'confirmed'", 'forceRefresh: true')) {
    if (-not $compiledService.Contains($marker)) {
      throw "Compiled registration service is missing marker: $marker"
    }
  }

  if (Test-Path -LiteralPath (Join-Path $stageRoot 'dist\server\modules\purchase-inventory')) {
    throw 'Weather registration hotfix must not contain purchase server modules'
  }

  $readme = @(
    '# 南通天气戒备登记秒响应专项热包'
    ''
    '适用场景：覆盖到已部署且已包含天气预警与戒备功能的南通排班程序目录。'
    ''
    '改动：提交后立即关闭弹窗并后台同步；失败自动恢复原草稿与附件；成功响应严格确认操作号、楼栋和多维表记录。'
    ''
    '部署：停止程序，将压缩包内容覆盖到程序根目录，重新执行 start.cmd。'
    ''
    '边界：前端采购页面来自 2026-07-30 的哈希锁定快照；本包不含采购服务端模块，也不包含采购页面优化。'
  ) -join [Environment]::NewLine
  [System.IO.File]::WriteAllText((Join-Path $stageRoot 'README.md'), $readme, [System.Text.UTF8Encoding]::new($false))

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
    type = 'existing-deployment-overlay'
    scope = @('weather-warning-registration', 'client')
    excluded = @('purchase-page-optimization', 'purchase-server-modules')
    purchaseSnapshotSha256 = '32b9015d7e84c5214638337afc3e88fd9279337d83661661437bcdc472a12acd'
    files = $manifestFiles
  }
  [System.IO.File]::WriteAllText(
    (Join-Path $stageRoot 'hotfix-manifest.json'),
    ($manifest | ConvertTo-Json -Depth 8),
    [System.Text.UTF8Encoding]::new($false)
  )

  [System.IO.Compression.ZipFile]::CreateFromDirectory(
    $stageRoot,
    $archivePath,
    [System.IO.Compression.CompressionLevel]::Optimal,
    $false
  )

  $archive = [System.IO.Compression.ZipFile]::OpenRead($archivePath)
  try {
    $entries = @($archive.Entries | ForEach-Object { $_.FullName.Replace('\', '/') })
  } finally {
    $archive.Dispose()
  }
  foreach ($requiredEntry in @(
    'hotfix-manifest.json'
    'README.md'
    'dist/server/modules/weather-warning/weather-warning-registration.service.js'
    'dist/shared/api.interface.js'
    'dist/client/index.html'
  )) {
    if ($entries -notcontains $requiredEntry) {
      throw "Hotfix archive is missing required entry: $requiredEntry"
    }
  }
  if (@($entries | Where-Object { $_ -like 'dist/server/modules/purchase-inventory/*' }).Count -gt 0) {
    throw 'Hotfix archive contains purchase server modules'
  }

  $archiveHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
  [System.IO.File]::WriteAllText(
    $hashPath,
    "$archiveHash  $([System.IO.Path]::GetFileName($archivePath))$([Environment]::NewLine)",
    [System.Text.UTF8Encoding]::new($false)
  )

  Write-Host "Weather registration hotfix created: $archivePath"
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
